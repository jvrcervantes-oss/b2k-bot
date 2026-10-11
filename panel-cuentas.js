// Cuentas personales del panel y registro de accesos (BBM-40, 11-oct-2026). Nace APAGADO: sin PANEL_CUENTAS=1 este
// módulo no registra ninguna ruta y adminAuth hace exactamente lo de antes (lo fija test-privacidad.js).
//
//   PANEL_CUENTAS=1        el panel pide usuario + clave personal; la sesión va en una cookie HttpOnly. La clave
//                          compartida (ADMIN_PASSWORD) sigue valiendo SOLO por cabecera X-Admin-Key, para las
//                          herramientas del estudio (tools/briefing.py, erp/nueva_instancia.py): el login del panel ya
//                          no la acepta, así que el registro dice quién fue (revisión previa de Seguridad, 11-oct).
//   PANEL_CLAVE_URL=0      deja de aceptar la clave en la URL (?key=). Antes de apagarla hay que migrar los llamadores
//                          que la usan (infraestructura/voz-app/server.mjs; receta de contexto/datos_clientes.md).
//   PANEL_SESION_HORAS     caducidad absoluta de una sesión (1-72, por defecto 12).
//
// Límite por IP: vale para TODO (cuentas, clave compartida por cabecera y clave maestra); si no, el bloqueo no frenaría
// a quien adivina la compartida. Por eso, ANTES de encender PANEL_CUENTAS hay que mirar en el log cuántos saltos de
// X-Forwarded-For llegan (se mide siempre): si el proxy juntara a todos en una IP, 20 fallos bloquearían a todo el equipo.
// Seguridad: claves con scrypt (N=2^15, r=8, p=1; maxmem explícito o Node rechaza los parámetros) y comparación en tiempo
// constante; el token de sesión se guarda solo como sha256; límite de intentos ANTES de calcular el hash (cada hash son
// ~32 MB, como mucho 2 a la vez); un usuario inexistente cuesta lo mismo que uno real; el bloqueo es por usuario+IP (por
// usuario solo, cualquiera podría bloquear la cuenta del dueño) y por IP; nada de claves ni tokens en logs.
import crypto from "node:crypto";

const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 64;
export const MAX_FALLOS_USUARIO_IP = 5;
export const MAX_FALLOS_IP = 20;
export const VENTANA_FALLOS_S = 15 * 60;
export const ACCESOS_MAX = 5000;
export const ACCESOS_DIAS = 730; // Legal A.2 fila 6: registro de accesos, 24 meses
export const COOKIE = "panel_sesion";

export function leeConfigPanel(env = {}) {
  const h = parseInt(String(env.PANEL_SESION_HORAS ?? ""), 10);
  return {
    cuentas: env.PANEL_CUENTAS === "1",
    claveUrl: env.PANEL_CLAVE_URL !== "0",
    sesionHoras: Number.isFinite(h) && h >= 1 && h <= 72 ? h : 12,
  };
}

// Comparación en tiempo constante de dos cadenas de cualquier longitud (se comparan sus sha256).
export function igualSeguro(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !b) return false;
  const ha = crypto.createHash("sha256").update(a, "utf8").digest();
  const hb = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(ha, hb);
}

export const nombreValido = (u) => typeof u === "string" && /^[a-z0-9._-]{3,32}$/.test(u);
export const claveValida = (c) => typeof c === "string" && c.length >= 12 && c.length <= 200;
const sha = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");

// IP del cliente tras el proxy de Railway: el PENÚLTIMO salto de X-Forwarded-For. Medido en bbm-bot el 11-oct-2026 (despliegue
// 7162e576): llegan 2 saltos, [cliente, proxy]; el penúltimo (= el primero) coincide con X-Real-IP y el último no; y una
// X-Forwarded-For inventada por el cliente no cambia el número (Railway la sustituye). El penúltimo es el cliente tanto si
// Railway sustituye como si añade. Con un solo salto (sin proxy) se toma ese. Antes era el último, que es el del proxy.
// Si Railway cambia su proxy, el log del arranque lo enseña (saltos y qué entrada coincide con X-Real-IP).
export function ipCliente(req) {
  const xff = String((req.get && req.get("x-forwarded-for")) || "").split(",").map((s) => s.trim()).filter(Boolean);
  const ip = xff.length >= 2 ? xff[xff.length - 2] : xff.length === 1 ? xff[0] : String(req.socket?.remoteAddress || "");
  return { ip, saltos: xff.length };
}

export function leeCookie(req, nombre = COOKIE) {
  const raw = String((req.get && req.get("cookie")) || "");
  for (const parte of raw.split(";")) {
    const i = parte.indexOf("=");
    if (i > 0 && parte.slice(0, i).trim() === nombre) { try { return decodeURIComponent(parte.slice(i + 1).trim()); } catch { return ""; } } // `%` suelto: sin sesión, sin excepción
  }
  return "";
}

export function createPanelCuentas({ redis, now = () => Date.now(), log = console, proyecto = "bot", sesionHoras = 12 }) {
  const p = (m) => `[${proyecto}] panel: ${m}`;
  // Semáforo: como mucho 2 scrypt a la vez (cada uno reserva ~32 MB); más de 20 esperando = 503, no se encola sin fin.
  let activos = 0;
  const cola = [];
  async function conHueco(fn) {
    while (activos >= 2) { // `while`: si otro entra justo al liberarse el hueco, se vuelve a esperar (nunca 3 a la vez)
      if (cola.length >= 20) throw Object.assign(new Error("ocupado"), { status: 503 });
      await new Promise((r) => cola.push(r));
    }
    activos++;
    try { return await fn(); } finally { activos--; const sig = cola.shift(); if (sig) sig(); }
  }
  const scrypt = (clave, sal) => new Promise((res, rej) => crypto.scrypt(clave, sal, KEYLEN, SCRYPT, (e, k) => (e ? rej(e) : res(k))));
  async function hashClave(clave) {
    const sal = crypto.randomBytes(16);
    const k = await conHueco(() => scrypt(clave, sal));
    return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${sal.toString("base64")}$${k.toString("base64")}`;
  }
  async function verificaClave(clave, guardado) {
    const partes = String(guardado || "").split("$");
    if (partes.length !== 6 || partes[0] !== "scrypt") return false;
    const sal = Buffer.from(partes[4], "base64");
    const esperado = Buffer.from(partes[5], "base64");
    if (esperado.length !== KEYLEN) return false;
    const k = await conHueco(() => scrypt(String(clave), sal));
    return crypto.timingSafeEqual(k, esperado);
  }
  // Hash ficticio para que un usuario que no existe cueste lo mismo que uno que sí (no se adivinan nombres por tiempo).
  let ficticio = null;
  const hashFicticio = async () => (ficticio ||= await hashClave(crypto.randomBytes(24).toString("hex")));

  const kUsuario = (u) => `panel:usuario:${u}`;
  const kSesion = (h) => `panel:sesion:${h}`;
  const kSesiones = (u) => `panel:sesiones:${u}`;
  const kFalloUI = (u, ip) => `panel:fallos:ui:${sha(`${u}|${ip}`).slice(0, 32)}`;
  const kFalloIP = (ip) => `panel:fallos:ip:${sha(ip).slice(0, 32)}`;

  async function leeUsuario(u) {
    if (!nombreValido(u)) return null;
    const raw = await redis().get(kUsuario(u));
    try { return raw ? JSON.parse(raw) : null; } catch { return null; }
  }
  async function revocaSesiones(u) {
    const r = redis();
    const hs = await r.sMembers(kSesiones(u));
    for (const h of hs) await r.del(kSesion(h));
    await r.del(kSesiones(u));
    return hs.length;
  }

  // Registro de accesos: quién (usuario o «clave compartida»), qué, si salió bien, desde qué IP. Sin claves ni tokens.
  // Tope de 5000 entradas y nada de más de 24 meses (se recorta por la cola, que es lo más viejo).
  async function registra(quien, accion, ok, ip, extra) {
    try {
      const r = redis();
      if (!r) return;
      const e = { ts: now(), quien: String(quien || "?").slice(0, 40), accion: String(accion).slice(0, 40), ok: !!ok, ip: String(ip || "").slice(0, 64) };
      if (extra) e.extra = String(extra).slice(0, 80);
      await r.lPush("panel:accesos", JSON.stringify(e));
      await r.lTrim("panel:accesos", 0, ACCESOS_MAX - 1);
      const limite = now() - ACCESOS_DIAS * 24 * 3600 * 1000;
      for (let i = 0; i < 50; i++) {
        const ult = await r.lIndex("panel:accesos", -1);
        let ts = null; try { ts = JSON.parse(ult).ts; } catch { /* */ }
        if (!ult || !(Number(ts) < limite)) break;
        await r.rPop("panel:accesos");
      }
    } catch (e) { log.error(p(`no se pudo anotar un acceso: ${e.message}`)); }
  }
  async function accesos(n = 200) {
    const raws = await redis().lRange("panel:accesos", 0, Math.max(0, Math.min(n, ACCESOS_MAX) - 1));
    return raws.map((x) => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean);
  }

  async function ipBloqueada(ip) { return Number(await redis().get(kFalloIP(ip))) >= MAX_FALLOS_IP; }
  async function cuentaFalloIP(ip) {
    const r = redis();
    const k = kFalloIP(ip);
    const n = await r.incr(k);
    if (n === 1) await r.expire(k, VENTANA_FALLOS_S);
    return n;
  }

  async function login(usuario, clave, ip) {
    const r = redis();
    if (!r) return { ok: false, status: 503 };
    const u = String(usuario || "").trim().toLowerCase();
    // Límite ANTES del hash: un ataque no puede hacernos calcular scrypt sin parar.
    if ((await ipBloqueada(ip)) || Number(await r.get(kFalloUI(u, ip))) >= MAX_FALLOS_USUARIO_IP) {
      await registra(nombreValido(u) ? u : "?", "login_bloqueado", false, ip);
      return { ok: false, status: 429 };
    }
    const cuenta = await leeUsuario(u);
    const valido = cuenta && cuenta.activo !== false && typeof clave === "string" && clave.length <= 200 // tope: una clave de 30 MB no llega a scrypt
      ? await verificaClave(clave, cuenta.hash)
      : (await verificaClave(String(clave || "").slice(0, 200), await hashFicticio()), false);
    if (!valido) {
      const k = kFalloUI(u, ip);
      const n = await r.incr(k);
      if (n === 1) await r.expire(k, VENTANA_FALLOS_S);
      await cuentaFalloIP(ip);
      await registra(nombreValido(u) ? u : "?", "login", false, ip);
      return { ok: false, status: 401 };
    }
    await r.del(kFalloUI(u, ip));
    const token = crypto.randomBytes(32).toString("base64url");
    const h = sha(token);
    await r.set(kSesion(h), JSON.stringify({ usuario: u, creado: now() }), { EX: sesionHoras * 3600 });
    await r.sAdd(kSesiones(u), h);
    await r.expire(kSesiones(u), sesionHoras * 3600);
    await registra(u, "login", true, ip);
    return { ok: true, token, usuario: u, maxAgeS: sesionHoras * 3600 };
  }

  // Usuario de una sesión viva, o null. Una cuenta desactivada deja de valer aunque su cookie no haya caducado.
  async function sesion(token) {
    if (!token || typeof token !== "string" || token.length > 100) return null;
    const r = redis();
    if (!r) return null;
    const raw = await r.get(kSesion(sha(token)));
    let s = null; try { s = raw ? JSON.parse(raw) : null; } catch { s = null; }
    if (!s || !s.usuario) return null;
    const cuenta = await leeUsuario(s.usuario);
    if (!cuenta || cuenta.activo === false) return null;
    return s.usuario;
  }
  async function logout(token, ip) {
    const r = redis();
    if (!r || !token) return;
    const h = sha(token);
    const raw = await r.get(kSesion(h));
    let s = null; try { s = raw ? JSON.parse(raw) : null; } catch { /* */ }
    await r.del(kSesion(h));
    if (s && s.usuario) { await r.sRem(kSesiones(s.usuario), h); await registra(s.usuario, "logout", true, ip); }
  }

  // Gestión de cuentas (las rutas exigen sesión o cabecera Y la clave maestra).
  async function crea(usuario, clave) {
    const u = String(usuario || "").trim().toLowerCase();
    if (!nombreValido(u)) return { ok: false, error: "usuario: 3-32 caracteres a-z 0-9 . _ -" };
    if (!claveValida(clave)) return { ok: false, error: "la clave tiene que tener al menos 12 caracteres" };
    const cuenta = { hash: await hashClave(clave), activo: true, creado: now() };
    const hecho = await redis().set(kUsuario(u), JSON.stringify(cuenta), { NX: true });
    if (!hecho) return { ok: false, error: "ese usuario ya existe" };
    await redis().sAdd("panel:usuarios", u);
    return { ok: true, usuario: u };
  }
  async function cambiaClave(usuario, clave) {
    const u = String(usuario || "").trim().toLowerCase();
    const cuenta = await leeUsuario(u);
    if (!cuenta) return { ok: false, error: "no existe" };
    if (!claveValida(clave)) return { ok: false, error: "la clave tiene que tener al menos 12 caracteres" };
    cuenta.hash = await hashClave(clave);
    await redis().set(kUsuario(u), JSON.stringify(cuenta));
    return { ok: true, sesiones_cerradas: await revocaSesiones(u) };
  }
  async function activa(usuario, si) {
    const u = String(usuario || "").trim().toLowerCase();
    const cuenta = await leeUsuario(u);
    if (!cuenta) return { ok: false, error: "no existe" };
    cuenta.activo = !!si;
    await redis().set(kUsuario(u), JSON.stringify(cuenta));
    return { ok: true, sesiones_cerradas: si ? 0 : await revocaSesiones(u) };
  }
  async function lista() {
    const us = (await redis().sMembers("panel:usuarios")).sort();
    const out = [];
    for (const u of us) { const c = await leeUsuario(u); if (c) out.push({ usuario: u, activo: c.activo !== false, creado: c.creado || null }); }
    return out;
  }

  return { hashClave, verificaClave, login, sesion, logout, crea, cambiaClave, activa, lista, registra, accesos, ipBloqueada, cuentaFalloIP, revocaSesiones };
}
