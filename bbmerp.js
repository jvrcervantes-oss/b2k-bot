// Cliente del bot de BBM contra el ERP (F8 pieza 7, parte segura, 9-oct-2026). Habla con la edge `reservas-bot` del ERP: catálogo, entrega
// (km), cotización, reserva y cliente. NADA de esto se usa todavía en la conversación: el modo erp (texto, desglose, sombra, corte) viene
// después. Con BBM_ERP_URL/BBM_RESERVAS_SECRET ausentes el módulo no hace nada y el bot se comporta EXACTAMENTE como antes.
//
// Todo entra por createBbmErp(opciones): no toca el entorno ni la red por su cuenta, así se prueba con un fetch de mentira. Patrón de
// botcat.js de la rama lawang (caché con último bueno, fail-closed), pero hablando con reservas-bot, NO con la edge bot-api de Lawang.
//
// Reglas (cada una con su porqué):
//   · FAIL-CLOSED. Error, tiempo agotado, secreto rechazado, módulo apagado o una respuesta que no cumple el contrato
//     (bbmerp.contract.json) ⇒ {ok:false, motivo}. El bot nunca inventa un precio ni manda un enlace de pago con lo que no entiende.
//   · EL BOT NO MANDA IMPORTES NI KM. Cada acción construye su cuerpo con una lista cerrada de campos; el precio, la moto, el km y el
//     cliente los pone la base. La edge rechaza cualquier campo de más, y aquí ni siquiera se puede escribir.
//   · `contacto_telefono` es SIEMPRE el `from` verificado del webhook de Meta (parámetro `fromVerificado`), nunca texto del chat ni un
//     argumento del modelo. Este módulo NO se expone al modelo como herramienta: lo llama código del bot.
//   · El secreto es BBM_RESERVAS_SECRET, propio de esta edge (NO BOT_ERP_SECRET, que hoy comparten crm-bot y reservas-bot: separarlo es una
//     decisión pendiente del owner). Nunca se loguea.
//   · `cobro.importe` es el entero que cobra Xendit: SIN la comisión del 3 % de la pasarela y SIN el depósito (el depósito se paga en la
//     entrega; el bot lo mostrará aparte). Si no es un entero positivo igual a `precio_total`, la reserva se trata como respuesta inválida.
//   · Idempotencia de `reserva`: los webhooks de Meta se reentregan. La clave sale del id del mensaje de WhatsApp (hash corto, porque el
//     wamid lleva `=` y `/` y la base solo admite [A-Za-z0-9@:._+-]). Si la respuesta se pierde se reintenta UNA vez con la misma clave.
//     ⚠ La edge reservas-bot de hoy NO admite el campo `clave` (lo rechazaría con campo_no_admitido): se manda solo con enviaClave=true (opción del constructor; ninguna variable la lee aún: createBbmErp no se instancia en index.js hasta la pieza del flujo),
//     cuando la edge lo acepte. Mientras tanto la base deduplica por teléfono + moto + fechas (md5) mientras la reserva siga en bloqueo.
//   · Logs sin PII: acción, resultado, ids, importes. Nunca teléfonos, nombres, direcciones, mensajes de la base ni el secreto.

import crypto from "crypto";

export const TIMEOUT_MS = 5000;
export const CATALOGO_TTL_MS = 5 * 60 * 1000;
export const CATALOGO_MAX_STALE_MS = 24 * 3600 * 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const ESTADOS_ENTREGA = new Set(["ok", "sin_resultado", "ambigua", "tope", "pausado", "ocupado", "error"]);
// 409/429 con significado propio; cualquier otro 409 se devuelve como motivo 'datos'
const MOTIVOS_409 = new Set(["entrega_a_confirmar", "entrega_no_configurada", "sin_disponibilidad"]);

const KO = (motivo, extra = {}) => ({ ok: false, motivo, ...extra });
const esObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const num = (x) => typeof x === "number" && Number.isFinite(x);
const entero = (x) => Number.isInteger(x);
const str = (x) => typeof x === "string";
const sinControl = (s) => !/[\u0000-\u001f\u007f]/.test(s);

// Teléfono → solo dígitos (6-15). Si no hay un teléfono creíble no se llama a nada.
export function telefonoVerificado(from) {
  const d = String(from ?? "").replace(/\D/g, "");
  return d.length >= 6 && d.length <= 15 ? d : null;
}

// Clave de idempotencia de `reserva` derivada del id del mensaje de WhatsApp. Misma entrada ⇒ misma clave (una reentrega de Meta no duplica).
export function claveReserva({ mensajeId, producto_id, desde, hasta }) {
  if (!str(mensajeId) || !mensajeId) return undefined;
  const h = crypto.createHash("sha256").update([mensajeId, producto_id, desde, hasta].join("|")).digest("hex").slice(0, 48);
  return `wa:${h}`;
}

// ── validadores de respuesta (el contrato está en bbmerp.contract.json y lo fija test-bbmerp.js) ──────────────────────────────────
function leeCatalogo(r) {
  if (!Array.isArray(r)) return null;
  const out = [];
  for (const x of r) {
    if (!esObj(x) || !str(x.id) || !UUID.test(x.id) || !str(x.nombre) || !entero(x.unidades) || x.unidades < 0 || !Array.isArray(x.tarifas)) return null;
    const tarifas = [];
    for (const t of x.tarifas) {
      if (!esObj(t) || !entero(t.dias) || t.dias < 1 || !num(t.precio) || t.precio < 0 || !str(t.moneda)) return null;
      tarifas.push({ dias: t.dias, precio: t.precio, moneda: t.moneda, etiqueta: str(t.etiqueta) ? t.etiqueta : null });
    }
    out.push({
      id: x.id, numero_producto: x.numero_producto ?? null, nombre: x.nombre, descripcion: str(x.descripcion) ? x.descripcion : null,
      unidad: str(x.unidad) ? x.unidad : null, tarifas, unidades: x.unidades,
    });
  }
  return out;
}

function leeEntrega(r) {
  if (!esObj(r) || !ESTADOS_ENTREGA.has(r.estado)) return null;
  if (r.estado === "ok") {
    if (!num(r.km) || r.km <= 0) return null;
    return { estado: "ok", km: r.km };
  }
  return { estado: r.estado, km: null };
}

function leeLineasCotiza(l) {
  if (!Array.isArray(l)) return null;
  const out = [];
  for (const x of l) {
    if (!esObj(x) || !str(x.descripcion) || !num(Number(x.base)) || !num(Number(x.cuota)) || !num(Number(x.bruto))) return null;
    out.push({ descripcion: x.descripcion, concepto: str(x.concepto) ? x.concepto : null, base: Number(x.base), cuota: Number(x.cuota), bruto: Number(x.bruto) });
  }
  return out;
}

function leeCotizacion(r) {
  if (!esObj(r) || !num(r.total) || r.total < 0 || !str(r.moneda) || !/^[A-Z]{3}$/.test(r.moneda) || !entero(r.dias) || r.dias < 1) return null;
  if (!entero(r.disponibles) || r.disponibles < 0) return null;
  if (!str(r.producto_id) || !UUID.test(r.producto_id) || !str(r.desde) || !FECHA.test(r.desde) || !str(r.hasta) || !FECHA.test(r.hasta)) return null;
  const lineas = leeLineasCotiza(r.lineas);
  if (!lineas) return null;
  let impuesto = null;
  if (r.impuesto !== null && r.impuesto !== undefined) {
    if (!esObj(r.impuesto) || !str(r.impuesto.nombre) || !num(Number(r.impuesto.porcentaje))) return null;
    impuesto = { nombre: r.impuesto.nombre, porcentaje: Number(r.impuesto.porcentaje) };
  }
  return {
    producto_id: r.producto_id, desde: r.desde, hasta: r.hasta, dias: r.dias, disponibles: r.disponibles,
    total: r.total, moneda: r.moneda, base: num(r.base) ? r.base : null, impuestos: num(r.impuestos) ? r.impuestos : null,
    incluye_impuesto: r.incluye_impuesto === true, impuesto, precio_alquiler: num(r.precio_alquiler) ? r.precio_alquiler : null,
    desglose: r.desglose ?? null, lineas,
  };
}

function leeReserva(r) {
  if (!esObj(r) || !str(r.id) || !UUID.test(r.id) || !esObj(r.cobro)) return null;
  const c = r.cobro;
  // el enlace de Xendit cobra EXACTAMENTE esto: entero, igual al total congelado, con el external_id de ESTA reserva
  if (c.external_id !== `rsv:${r.id}` || !entero(c.importe) || c.importe <= 0 || !str(c.moneda) || !/^[A-Z]{3}$/.test(c.moneda)) return null;
  if (!entero(c.segundos_hasta_caducar) || c.segundos_hasta_caducar < 0) return null;
  if (!num(r.precio_total) || r.precio_total !== c.importe || r.moneda !== c.moneda) return null;
  return {
    reserva_id: r.id, numero_reserva: r.numero_reserva ?? null, estado: r.estado ?? null, caduca_en: r.caduca_en ?? null,
    desde: r.desde ?? null, hasta: r.hasta ?? null, dias: entero(r.dias) ? r.dias : null,
    precio_total: r.precio_total, moneda: r.moneda, incluye_impuesto: r.incluye_impuesto === true,
    lineas: Array.isArray(r.lineas) ? r.lineas.filter((l) => esObj(l) && str(l.descripcion)).map((l) => ({ descripcion: l.descripcion, base: Number(l.base) })) : [],
    repetida: r.repetida === true,
    cobro: { external_id: c.external_id, importe: c.importe, moneda: c.moneda, segundos_hasta_caducar: c.segundos_hasta_caducar },
  };
}

function leeCliente(r) {
  if (!esObj(r) || r.ok !== true || typeof r.cliente_identificado !== "boolean") return null;
  return { cliente_identificado: r.cliente_identificado, creado: r.creado === true, motivo: str(r.motivo) ? r.motivo : null };
}

export function createBbmErp(o = {}) {
  const {
    url, secret, timeoutMs = TIMEOUT_MS, catalogoTtlMs = CATALOGO_TTL_MS, catalogoMaxStaleMs = CATALOGO_MAX_STALE_MS,
    enviaClave = false, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console, project = "bot",
  } = o;
  const base = typeof url === "string" ? url.trim().replace(/\/+$/, "") : "";
  const enabled = !!(base && secret);
  const p = (m) => `[${project}] [bbmerp] ${m}`;

  let catalogo = null;      // { at, datos } último catálogo BUENO
  let inflight = null;

  // POST a reservas-bot. → {ok:true, status, r} | {ok:false, motivo, ...}. NUNCA lanza.
  async function llamaErp(accion, cuerpo) {
    if (!enabled) return KO("no_configurado");
    let resp;
    try {
      resp = await fetchImpl(`${base}/functions/v1/reservas-bot`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", "x-bot-secret": secret },
        body: JSON.stringify({ accion, ...cuerpo }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      log.warn(p(`${accion}: sin respuesta (${e && e.name === "TimeoutError" ? "tiempo" : "red"})`));
      return KO("no_disponible", { reintentable: true });
    }
    const st = resp.status;
    let json = null;
    try { json = await resp.json(); } catch { /* sin cuerpo legible */ }
    if (st === 200) {
      if (!esObj(json) || !("r" in json)) { log.error(p(`${accion}: 200 sin forma {r}`)); return KO("no_disponible", { detalle: "respuesta_invalida" }); }
      return { ok: true, status: 200, r: json.r };
    }
    const codigo = esObj(json) && str(json.error) ? json.error : null;
    if (st === 401 || st === 403) { log.error(p(`${accion}: SECRETO RECHAZADO (HTTP ${st}). Revisa BBM_RESERVAS_SECRET.`)); return KO("secreto_rechazado"); }
    if (st === 404) { log.warn(p(`${accion}: módulo de reservas apagado en el ERP`)); return KO("modulo_apagado"); }
    if (st === 429) { log.warn(p(`${accion}: tope ${codigo || ""}`)); return KO(codigo === "tope_global" ? "tope_global" : "tope_telefono"); }
    if (st === 409) {
      log.log(p(`${accion}: 409 ${codigo || ""}`));
      return KO(MOTIVOS_409.has(codigo) ? codigo : "datos", { codigo });
    }
    if (st === 400 || st === 413) { log.error(p(`${accion}: la edge rechaza la petición (${st} ${codigo || ""})`)); return KO("peticion_invalida", { codigo }); }
    log.warn(p(`${accion}: HTTP ${st}`));
    return KO("no_disponible", { reintentable: st >= 500 });
  }

  // ── acciones (cuerpos con lista cerrada de campos) ───────────────────────────────────────────────────────────────────────
  async function leeCatalogoErp() {
    const r = await llamaErp("catalogo", {});
    if (!r.ok) return r;
    const datos = leeCatalogo(r.r);
    if (!datos) { log.error(p("catalogo: respuesta que no cumple el contrato")); return KO("no_disponible", { detalle: "respuesta_invalida" }); }
    return { ok: true, datos };
  }

  // Catálogo con caché: fresco ≤ catalogoTtlMs; si el ERP falla se sirve el último bueno hasta catalogoMaxStaleMs (stale:true); pasado eso, fail-closed.
  async function getCatalogo() {
    const t = now();
    if (catalogo && t - catalogo.at < catalogoTtlMs) return { ok: true, productos: catalogo.datos, stale: false };
    if (!inflight) inflight = leeCatalogoErp().finally(() => { inflight = null; });
    const r = await inflight;
    if (r.ok) { catalogo = { at: now(), datos: r.datos }; return { ok: true, productos: r.datos, stale: false }; }
    // un apagado explícito (módulo apagado, secreto roto) NO se tapa con la caché: el ERP dijo que no
    if (r.motivo === "modulo_apagado" || r.motivo === "secreto_rechazado") { catalogo = null; return r; }
    if (catalogo && now() - catalogo.at < catalogoMaxStaleMs) { log.warn(p("catalogo: ERP caído, se sirve el último bueno")); return { ok: true, productos: catalogo.datos, stale: true }; }
    return r;
  }

  async function entrega(direccion) {
    if (!str(direccion)) return KO("peticion_invalida", { codigo: "direccion" });
    const d = direccion.trim();
    if (d.length < 5 || d.length > 200 || !sinControl(d)) return KO("peticion_invalida", { codigo: "direccion" });
    const r = await llamaErp("entrega", { direccion: d });
    if (!r.ok) return r;
    const e = leeEntrega(r.r);
    if (!e) { log.error(p("entrega: respuesta que no cumple el contrato")); return KO("no_disponible", { detalle: "respuesta_invalida" }); }
    return { ok: true, ...e };
  }

  function cuerpoProducto({ producto_id, desde, hasta }) {
    if (!str(producto_id) || !UUID.test(producto_id)) return null;
    if (!str(desde) || !FECHA.test(desde) || !str(hasta) || !FECHA.test(hasta)) return null;
    return { producto_id, desde, hasta };
  }
  function dirOpcional(v) {
    if (v === undefined || v === null || v === "") return { ok: true, v: undefined };
    if (!str(v) || v.length > 2000 || !sinControl(v)) return { ok: false };
    return { ok: true, v: v.trim() };
  }

  async function cotiza({ producto_id, desde, hasta, entrega_direccion, recogida_direccion }) {
    const c = cuerpoProducto({ producto_id, desde, hasta });
    if (!c) return KO("peticion_invalida", { codigo: "producto_o_fechas" });
    const e = dirOpcional(entrega_direccion), g = dirOpcional(recogida_direccion);
    if (!e.ok || !g.ok) return KO("peticion_invalida", { codigo: "direccion" });
    if (e.v) c.entrega_direccion = e.v;
    if (g.v) c.recogida_direccion = g.v;
    const r = await llamaErp("cotiza", c);
    if (!r.ok) return r;
    const q = leeCotizacion(r.r);
    if (!q) { log.error(p("cotiza: respuesta que no cumple el contrato")); return KO("no_disponible", { detalle: "respuesta_invalida" }); }
    // la base devuelve lo que se cotizó: si no es lo pedido, algo va mal y no se enseña
    if (q.producto_id !== producto_id || q.desde !== desde || q.hasta !== hasta) { log.error(p("cotiza: la respuesta no es de lo pedido")); return KO("no_disponible", { detalle: "respuesta_incoherente" }); }
    log.log(p(`cotiza: ok total=${q.total} ${q.moneda} disponibles=${q.disponibles}`));
    return { ok: true, cotizacion: q };
  }

  // `fromVerificado` = el `from` del webhook de Meta (ya verificado por la firma). NUNCA un número escrito en el chat ni un argumento del modelo.
  async function reserva({ fromVerificado, producto_id, desde, hasta, entrega_direccion, recogida_direccion, mensajeId, conversacion_ref }) {
    const tel = telefonoVerificado(fromVerificado);
    if (!tel) return KO("peticion_invalida", { codigo: "telefono" });
    const c = cuerpoProducto({ producto_id, desde, hasta });
    if (!c) return KO("peticion_invalida", { codigo: "producto_o_fechas" });
    const e = dirOpcional(entrega_direccion), g = dirOpcional(recogida_direccion);
    if (!e.ok || !g.ok) return KO("peticion_invalida", { codigo: "direccion" });
    c.contacto_telefono = tel;
    if (e.v) c.entrega_direccion = e.v;
    if (g.v) c.recogida_direccion = g.v;
    // id del chat o del lead, nunca texto (Legal); aquí el teléfono del lead ya es la clave de la conversación
    if (str(conversacion_ref) && conversacion_ref.length <= 120 && /^[A-Za-z0-9@:._+-]+$/.test(conversacion_ref)) c.conversacion_ref = conversacion_ref;
    const clave = enviaClave ? claveReserva({ mensajeId, producto_id, desde, hasta }) : undefined;
    if (clave) c.clave = clave;
    // un reintento con LA MISMA clave si la respuesta se perdió (red, tiempo, 5xx): la base devuelve la reserva que ya había ({repetida:true})
    let r = await llamaErp("reserva", c);
    if (!r.ok && r.reintentable) { log.warn(p("reserva: reintento con la misma clave")); r = await llamaErp("reserva", c); }
    if (!r.ok) return r;
    // tope global: la base no lanza y devuelve {rechazada}; la edge lo pasa como 429, pero por si llega en un 200 se trata igual
    if (esObj(r.r) && r.r.rechazada) return KO("tope_global");
    const res = leeReserva(r.r);
    if (!res) { log.error(p("reserva: respuesta que no cumple el contrato")); return KO("no_disponible", { detalle: "respuesta_invalida" }); }
    log.log(p(`reserva: ok id=${res.reserva_id} importe=${res.cobro.importe} ${res.cobro.moneda}${res.repetida ? " (repetida)" : ""}`));
    return { ok: true, reserva: res };
  }

  // El teléfono NO viaja: la base lo lee de la reserva. Solo estos tres campos.
  async function cliente({ reserva_id, nombre, pais }) {
    if (!str(reserva_id) || !UUID.test(reserva_id)) return KO("peticion_invalida", { codigo: "reserva_id" });
    if (!str(nombre) || !str(pais)) return KO("peticion_invalida", { codigo: "nombre_o_pais" });
    const n = nombre.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
    const pa = pais.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
    if (n.length < 2 || pa.length < 2) return KO("peticion_invalida", { codigo: "nombre_o_pais" });
    const r = await llamaErp("cliente", { reserva_id, nombre: n, pais: pa });
    if (!r.ok) return r;
    const c = leeCliente(r.r);
    if (!c) { log.error(p("cliente: respuesta que no cumple el contrato")); return KO("no_disponible", { detalle: "respuesta_invalida" }); }
    return { ok: true, ...c };
  }

  return { enabled, catalogo: getCatalogo, entrega, cotiza, reserva, cliente, _llamaErp: llamaErp };
}

// ── Interruptor de backend (F8 pieza 7c, parte segura) ─────────────────────────────────────────────────────────────────────────────
// `dion` (el sistema de hoy) o `erp`. Valor por defecto: Redis `bbm:backend` (lo edita el panel/CRM del bot, SIN redeploy) y, si no existe,
// la variable BBM_BACKEND; si falta todo, `dion`. Valor desconocido ⇒ `dion` (la parte segura). Redis configurado pero caído ⇒ `dion`: el
// interruptor existe para poder volver atrás, y sin poder leerlo no se arriesga a quedarse en erp.
//
// FIJADO POR CONVERSACIÓN: al iniciar un flujo de reserva se fija el backend (clave `bbm:pin:<tel>` con caducidad) y no cambia hasta que la
// cotización muera: nada de cotizar en Dion y pagar en el ERP. Un cambio del interruptor solo afecta a conversaciones nuevas o sin cotización viva.
export const BACKENDS = ["dion", "erp"];
export const normalizaBackend = (v) => {
  const x = typeof v === "string" ? v.trim().toLowerCase() : "";
  return BACKENDS.includes(x) ? x : "dion";
};

export function createBackendSwitch(o = {}) {
  // enlaceVivo(tel) → true si esa conversación tiene un enlace de pago `rsv:` aún pagable (createPendingRsv.lee). Ese enlace ATA la conversación
  // a erp aunque el pin haya caducado: si no, el interruptor la pasaría a dion con un pago en vuelo.
  const { redis = () => null, envValue, enlaceVivo = async () => false, now = () => Date.now(), log = console, project = "bot" } = o;
  const p = (m) => `[${project}] [bbm-backend] ${m}`;
  const mem = new Map();   // sin Redis (modo RAM): mismas reglas en memoria
  const memConf = { valor: undefined };

  async function porDefecto() {
    const r = redis();
    if (r) {
      try {
        const v = await r.get("bbm:backend");
        if (v !== null && v !== undefined) {
          const n = normalizaBackend(v);
          if (n === "dion" && String(v).trim().toLowerCase() !== "dion") log.warn(p("bbm:backend con un valor desconocido: se usa dion"));
          return n;
        }
      } catch (e) {
        log.error(p("no se pudo leer bbm:backend de Redis: se usa dion"));
        return "dion";
      }
    } else if (memConf.valor !== undefined) return normalizaBackend(memConf.valor);
    const e = envValue === undefined ? undefined : String(envValue);
    if (e && !BACKENDS.includes(e.trim().toLowerCase())) log.warn(p("BBM_BACKEND con un valor desconocido: se usa dion"));
    return normalizaBackend(e);
  }

  async function leePin(tel) {
    const r = redis();
    let raw = null;
    if (r) { try { raw = await r.get(`bbm:pin:${tel}`); } catch { return { error: true }; } }
    else raw = mem.get(tel) ?? null;
    if (!raw) return null;
    try {
      const pin = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (pin && BACKENDS.includes(pin.backend) && Number.isFinite(pin.hasta) && pin.hasta > now()) return pin;
    } catch { /* pin ilegible = sin pin */ }
    return null;
  }

  // El backend de ESTA conversación: el fijado si sigue vivo; si no, el valor por defecto.
  async function bbmBackend(tel) {
    if (tel) {
      const pin = await leePin(String(tel));
      if (pin && pin.error) return "dion";           // no se sabe si había una cotización viva en erp: lo seguro es no tocar nada
      if (pin) return pin.backend;
      let vivo = false;
      try { vivo = await enlaceVivo(String(tel)); } catch { /* sin poder saberlo, manda el valor por defecto */ }
      if (vivo) return "erp";
    }
    return porDefecto();
  }

  // Al iniciar un flujo de reserva. Si ya hay un backend fijado y vivo, NO se cambia (devuelve ese). ttlSec = lo que vive la cotización.
  async function fija(tel, ttlSec, backend) {
    const t = String(tel);
    const vivo = await leePin(t);
    if (vivo && !vivo.error) return vivo.backend;
    const b = backend === undefined ? await porDefecto() : normalizaBackend(backend);
    const ttl = Math.max(60, Math.floor(Number(ttlSec) || 0));
    const pin = { backend: b, hasta: now() + ttl * 1000 };
    const r = redis();
    if (r) { try { await r.setEx(`bbm:pin:${t}`, ttl, JSON.stringify(pin)); } catch { log.error(p("no se pudo fijar el backend de la conversación")); } }
    else mem.set(t, JSON.stringify(pin));
    return b;
  }

  async function suelta(tel) {
    const r = redis();
    if (r) { try { await r.del(`bbm:pin:${String(tel)}`); } catch { /* best-effort */ } }
    else mem.delete(String(tel));
  }

  // Para el panel/CRM y para los tests sin Redis.
  function ponPorDefectoEnMemoria(v) { memConf.valor = v; }

  return { bbmBackend, fija, suelta, porDefecto, _ponPorDefectoEnMemoria: ponPorDefectoEnMemoria };
}

// ── Registro de enlace pendiente PROPIO de las reservas del ERP ───────────────────────────────────────────────────────────────────
// `lastXenditInvoice` (index.js) lee los eventos `paylink` del lead y es del flujo viejo (`paylink_<tel>_…`): mezclar ahí un `rsv:` lo
// pisaría o lo daría por cancelado. Este registro vive en su propia clave `pendingrsv:<tel>` y nunca toca `lead:`.
export function createPendingRsv(o = {}) {
  const { redis = () => null, now = () => Date.now() } = o;
  const mem = new Map();
  const key = (tel) => `pendingrsv:${String(tel).replace(/\D/g, "")}`;

  async function guarda(tel, { external_id, importe, moneda, reserva_id, caduca_en_ms, url }) {
    if (!telefonoVerificado(tel)) throw new Error("pendingRsv: teléfono inválido");
    if (!str(external_id) || !external_id.startsWith("rsv:")) throw new Error("pendingRsv: external_id debe empezar por rsv:");
    if (!entero(importe) || importe <= 0) throw new Error("pendingRsv: importe entero positivo");
    if (!Number.isFinite(caduca_en_ms) || caduca_en_ms <= now()) throw new Error("pendingRsv: caducidad en el futuro");
    const reg = { external_id, importe, moneda: str(moneda) ? moneda : null, reserva_id: str(reserva_id) ? reserva_id : null, url: str(url) && /^https:\/\//.test(url) && url.length <= 500 ? url : null, creado_en: now(), caduca_en: caduca_en_ms };
    const ttl = Math.max(1, Math.ceil((caduca_en_ms - now()) / 1000));
    const r = redis();
    if (r) await r.setEx(key(tel), ttl, JSON.stringify(reg));
    else mem.set(key(tel), reg);
    return reg;
  }

  async function lee(tel) {
    const r = redis();
    let reg = null;
    if (r) { const raw = await r.get(key(tel)); if (raw) { try { reg = JSON.parse(raw); } catch { reg = null; } } }
    else reg = mem.get(key(tel)) ?? null;
    if (!reg || !(reg.caduca_en > now())) return null;
    return reg;
  }

  async function borra(tel) {
    const r = redis();
    if (r) await r.del(key(tel)); else mem.delete(key(tel));
  }

  return { guarda, lee, borra, key };
}
