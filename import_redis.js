// ─── IMPORTADOR REDIS → POSTGRES (S5 del encargo 20261009_lawang_bot_sin_redis, LAW-507) ──────────────
// TEMPORAL: este módulo y el endpoint /admin/api/redis-inventario (index.js) se RETIRAN en S9, junto con Redis.
//
// Lógica PURA: no importa el paquete redis ni nombra el cliente (lo vigila test-store-aislado.js). Recibe un
// `lector` que construye store/redis.js (`lectorImportacion()`) y un `transporte` que habla con Postgres
// (la ruta /importar de la edge bot-api, que añade S2). En los tests los dos son falsos.
//
// Tres cosas:
//   1. inventario(lector)  — A.1. Recorre TODAS las claves y devuelve SOLO conteos por grupo/TTL (nunca valores,
//      nunca un teléfono). Toda clave que no case con un grupo conocido sale como `desconocidas` y BLOQUEA S9.
//   2. leerTodo(lector)    — A.2. Lee Redis y construye, por teléfono, el payload que acepta bot_importar_chat.
//   3. importar(...)/cuadre — A.2. Envía por teléfono, repite el cuadre contra Postgres y devuelve un informe de
//      agregados (sin contenido ni teléfonos) con el veredicto «ninguna baja ni pausa vigente falta en Postgres».
//
// Regla de oro del importador: SOLO AÑADE RESTRICCIONES. Nunca quita una baja ni una pausa, ni siquiera si Redis
// dice otra cosa que Postgres (la parte SQL hace lo mismo). Repetible: dos pasadas no duplican nada.
import crypto from "node:crypto";

// ── Grupos de claves. El ORDEN importa: conv:sim: antes que conv:, optoutack: antes que optout:, botcfg:log antes que botcfg: ──
// accion: importar | ram (efímero, memoria del proceso) | eliminar (decisión 7: se retira para Lawang) | derivado (índice, se reconstruye)
export const GRUPOS = [
  { g: "conv_sim",   re: /^conv:sim:/,        accion: "ram",       destino: "memoria del proceso (simulador)" },
  { g: "conv",       re: /^conv:/,            accion: "importar",  destino: "bot_mensaje" },
  { g: "leads_index",re: /^leads_index$/,     accion: "derivado",  destino: "índice del zset lead:* (no se importa: se reconstruye de bot_chat)" },
  { g: "lead",       re: /^lead:/,            accion: "importar",  destino: "bot_chat" },
  { g: "paused",     re: /^paused:/,          accion: "importar",  destino: "bot_chat.pausado/pausa_hasta" },
  { g: "waiting",    re: /^waiting:/,         accion: "importar",  destino: "bot_chat.esperando" },
  { g: "inbound",    re: /^inbound:/,         accion: "importar",  destino: "bot_chat.ultimo_entrante_en" },
  { g: "optoutack",  re: /^optoutack:/,       accion: "importar",  destino: "bot_chat.baja_acuse_en" },
  { g: "optout",     re: /^optout:/,          accion: "importar",  destino: "bot_chat.baja_en" },
  { g: "followup",   re: /^followup:/,        accion: "importar",  destino: "bot_chat.seguimientos" },
  { g: "notified",   re: /^notified:/,        accion: "importar",  destino: "bot_chat.aviso_nivel" },
  { g: "testnotif",  re: /^testnotif:/,       accion: "importar",  destino: "bot_chat.aviso_testing_en" },
  { g: "wamid",      re: /^wamid:/,           accion: "ram",       destino: "bot_wamid (caduca a las 24 h; no se importa: Meta ya no reentrega lo viejo)" },
  { g: "esc_queue",  re: /^esc_queue$/,       accion: "importar",  destino: "bot_escalacion" },
  { g: "escmap",     re: /^escmap:/,          accion: "importar",  destino: "bot_escalacion.aviso_wamid (con su PTTL)" },
  { g: "botcfg_log", re: /^botcfg:log$/,      accion: "importar",  destino: "bot_config_log" },
  { g: "botcfg",     re: /^botcfg:/,          accion: "importar",  destino: "bot_config" },
  { g: "crm_tope",   re: /^crm:tope:/,        accion: "ram",       destino: "memoria del proceso (contador diario)" },
  { g: "wa_blocked", re: /^wa:blocked$/,      accion: "ram",       destino: "memoria del proceso" },
  { g: "appts_index",re: /^appts_index$/,     accion: "eliminar",  destino: "se elimina (las citas son de lead_accion)" },
  { g: "appt",       re: /^appt:/,            accion: "eliminar",  destino: "se elimina (las citas son de lead_accion)" },
  { g: "reminded",   re: /^reminded:/,        accion: "eliminar",  destino: "se elimina" },
  { g: "notes",      re: /^notes:/,           accion: "eliminar",  destino: "se elimina (decisión 7)" },
  { g: "status",     re: /^status:/,          accion: "eliminar",  destino: "se elimina (decisión 7)" },
  { g: "lastlink",   re: /^lastlink:/,        accion: "eliminar",  destino: "se elimina (Lawang no tiene Stripe)" },
  { g: "canned",     re: /^canned$/,          accion: "eliminar",  destino: "se sirve de solo lectura desde playbook-lawang.json" },
  { g: "media_lib",  re: /^media_lib$/,       accion: "eliminar",  destino: "se elimina (decisión 7)" },
  { g: "mediablob",  re: /^mediablob:/,       accion: "eliminar",  destino: "se elimina (decisión 7)" },
  { g: "unsub_emails",re: /^unsub_emails$/,   accion: "eliminar",  destino: "se elimina (sin Brevo)" },
  { g: "nl_scheduled",re: /^nl_scheduled$/,   accion: "eliminar",  destino: "se elimina (sin Brevo)" },
];

export function clasificarClave(k) {
  const s = String(k);
  for (const x of GRUPOS) if (x.re.test(s)) return x;
  return null;
}

// Forma enmascarada de una clave desconocida: el nombre real puede llevar un teléfono o un id. Solo se enseña la FORMA.
export function enmascarar(k) {
  // Solo sobreviven segmentos de pura palabra minúscula (p. ej. «raro:<x>:cola»); cualquier otra cosa (dígitos, @, +, -, mayúsculas) se tapa.
  return String(k).split(":").map((x) => (/^[a-z_]{1,20}$/.test(x) ? x : "<x>")).join(":").slice(0, 60);
}

// ── Teléfonos: el bot guarda dígitos (normalizePhone), pero el importador NO se fía: agrupa por los dígitos ya normalizados. ──
export function telDe(sufijo) {
  const d = String(sufijo || "").replace(/\D/g, "");
  return /^[0-9]{6,20}$/.test(d) ? d : null;
}

// ── 1. INVENTARIO (A.1) ────────────────────────────────────────────────────────────────────────
// Devuelve solo conteos. `lector.escanear()` es un async iterable de claves; el resto son lecturas por clave.
export async function inventario(lector, { maxClaves = 200000 } = {}) {
  const grupos = {};
  const desconocidas = {};     // forma enmascarada → {n, tipos}
  let total = 0, truncado = false;
  const parseoMalo = { conv: 0, lead: 0, esc_queue: 0, escmap: 0 };
  let mensajes = 0, mensajesMax = 0;
  for await (const k of lector.escanear()) {
    if (total >= maxClaves) { truncado = true; break; }
    total++;
    const c = clasificarClave(k);
    const tipo = await lector.tipo(k);
    const pttl = await lector.pttl(k);
    if (!c) {
      const f = enmascarar(k);
      const d = desconocidas[f] || (desconocidas[f] = { n: 0, tipos: {} });
      d.n++; d.tipos[tipo] = (d.tipos[tipo] || 0) + 1;
      continue;
    }
    const e = grupos[c.g] || (grupos[c.g] = { accion: c.accion, destino: c.destino, n: 0, tipos: {}, sin_ttl: 0, con_ttl: 0, ttl_min_s: null, ttl_max_s: null });
    e.n++; e.tipos[tipo] = (e.tipos[tipo] || 0) + 1;
    if (pttl === -1) e.sin_ttl++;
    else if (pttl >= 0) {
      e.con_ttl++;
      const s = Math.round(pttl / 1000);
      e.ttl_min_s = e.ttl_min_s === null ? s : Math.min(e.ttl_min_s, s);
      e.ttl_max_s = e.ttl_max_s === null ? s : Math.max(e.ttl_max_s, s);
    }
    if (c.g === "conv" && tipo === "string") {            // solo el NÚMERO de mensajes; el contenido nunca sale de aquí
      try { const a = JSON.parse(await lector.get(k)); const n = Array.isArray(a) ? a.length : 0; mensajes += n; mensajesMax = Math.max(mensajesMax, n); }
      catch (_) { parseoMalo.conv++; }
    }
  }
  const ks = await lector.keyspace();
  const sinClasificar = Object.values(desconocidas).reduce((a, d) => a + d.n, 0);
  const aEliminarConDatos = Object.entries(grupos).filter(([, e]) => e.accion === "eliminar" && e.n > 0).map(([g, e]) => ({ grupo: g, n: e.n }));
  return {
    claves_escaneadas: total, truncado,
    dbsize: await lector.dbsize(), keyspace: ks,
    cuadra_con_dbsize: !truncado && ks.dbs.length <= 1 && total === (await lector.dbsize()),
    grupos, desconocidas, sin_clasificar: sinClasificar,
    mensajes_conv: { total: mensajes, max_por_chat: mensajesMax },
    conv_ilegibles: parseoMalo.conv,
    // BLOQUEOS de S9: todo lo que no se pueda explicar. Una clave «eliminar» CON datos no es un error, pero exige que alguien
    // confirme que se descarta (decisión 7 dijo «0 datos»); una clave desconocida o una base extra sí bloquea.
    bloquea_s9: sinClasificar > 0 || truncado || ks.dbs.length > 1 || parseoMalo.conv > 0,
    a_eliminar_con_datos: aEliminarConDatos,
  };
}

// ── 2. LECTURA Y TRADUCCIÓN (A.2) ──────────────────────────────────────────────────────────────
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
// MISMA forma canónica que public._bot_limpia: quita controles, recorta SOLO ESPACIOS (btrim de Postgres) y corta a n CARACTERES.
export function limpia(t, n) {
  const s = String(t ?? "").replace(CONTROL, "").replace(/^ +| +$/g, "");
  return Array.from(s).slice(0, n).join("").replace(/ +$/, "");   // el corte puede dejar un espacio al final: así el resultado es un punto fijo
}

const POR_DE = { client: "cliente", bot: "bot", human: "humano" };
const NIVEL = { interested: 1, booking: 2 };

function acc(tels, tel) {
  let a = tels.get(tel);
  if (!a) { a = { tel, lead: null, mensajes: null, pausa: null, esperando: false, inbound: null, baja: null, acuse: false, seguimientos: 0, aviso: 0, avisoTesting: false, escalaciones: [] }; tels.set(tel, a); }
  return a;
}

// Combina dos pausas: manda la más restrictiva (sin caducidad > la que caduca más tarde).
function pausaMas(a, b) {
  if (!a) return b; if (!b) return a;
  if (a.hasta === null || b.hasta === null) return { hasta: null };
  return { hasta: Math.max(a.hasta, b.hasta) };
}

// Traduce un mensaje de conv: a la forma que acepta la función SQL. `fallaTs` rellena un ts ausente de forma determinista.
function mensajeAPayload(m, fallaTs) {
  if (!m || typeof m !== "object") return null;
  const rol = m.role === "user" ? "user" : "assistant";
  const por = rol === "user" ? "cliente" : (m.by === "human" ? "humano" : "bot");
  const contenido = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
  const ts = Number.isFinite(Number(m.ts)) && Number(m.ts) > 1e11 ? Math.floor(Number(m.ts)) : fallaTs;
  let media = null;
  if (m.media && typeof m.media === "object" && typeof m.media.id === "string" && m.media.id) {
    media = { tipo: String(m.media.type || m.media.tipo || "otro").slice(0, 20), id: m.media.id.slice(0, 200) };
  }
  return {
    rol, por, ts_ms: ts,
    por_usuario: typeof m.byUser === "string" && m.byUser ? m.byUser.slice(0, 120) : null,
    contenido: limpia(contenido, 4096),
    media,
    wamid: typeof m.wamid === "string" && m.wamid ? m.wamid.slice(0, 120) : null,
    _media_descartada: !!(m.media && !media),
  };
}

// Lee TODO Redis (solo lectura) y devuelve { chats: [payload por teléfono], config, descartes, anomalias }.
// `ahora` se fija una vez: el PTTL restante se convierte en un instante absoluto en el momento de leer.
export async function leerTodo(lector, { ahora = Date.now() } = {}) {
  const tels = new Map();
  const anom = { tel_invalido: 0, json_roto: 0, optoutack_sin_optout: 0, baja_sin_tel: 0, pausa_sin_tel: 0, rol_raro: 0, escmap_sin_cola: 0, cola_sin_escmap: 0, clave_caducada_al_leer: 0, tel_normalizado_distinto: 0 };
  const desc = { lead_ficha_enriquecida: 0, lead_history_eventos: 0, lead_nextFollowUp: 0, mensajes_media_sin_id: 0, claves_ram_o_eliminadas: 0 };
  const escmap = [];                      // {entry, pttl}
  let cola = [];
  let cfg = null, cfgLog = [];
  const sufijo = (k, g) => k.slice(g.length + 1);
  const veTel = (k, pref) => {
    const crudo = k.slice(pref.length);
    const t = telDe(crudo);
    if (!t) anom.tel_invalido++;
    else if (t !== crudo) anom.tel_normalizado_distinto++;
    return t;
  };

  for await (const k of lector.escanear()) {
    const c = clasificarClave(k);
    if (!c || c.accion !== "importar") { desc.claves_ram_o_eliminadas++; continue; }
    const tipo = await lector.tipo(k);
    const pttl = await lector.pttl(k);
    if (pttl === -2) { anom.clave_caducada_al_leer++; continue; }       // caducó entre el SCAN y la lectura: se cuenta aparte
    switch (c.g) {
      case "conv": {
        const t = veTel(k, "conv:"); if (!t) break;
        let a; try { a = JSON.parse(await lector.get(k)); } catch (_) { anom.json_roto++; break; }
        if (!Array.isArray(a)) { anom.json_roto++; break; }
        const x = acc(tels, t);
        x.mensajes = (x.mensajes || []).concat(a);
        break;
      }
      case "lead": {
        const t = veTel(k, "lead:"); if (!t) break;
        let l; try { l = JSON.parse(await lector.get(k)); } catch (_) { anom.json_roto++; break; }
        if (!l || typeof l !== "object") { anom.json_roto++; break; }
        const x = acc(tels, t);
        x.lead = l;
        const conocidas = new Set(["phone", "name", "intent", "lastMessage", "lastBy", "createdAt", "updatedAt", "archived", "history", "nextFollowUp", "fuReminded"]);
        if (Object.keys(l).some((q) => !conocidas.has(q))) desc.lead_ficha_enriquecida++;
        if (Array.isArray(l.history)) desc.lead_history_eventos += l.history.length;
        if (l.nextFollowUp) desc.lead_nextFollowUp++;
        break;
      }
      case "paused": {
        const t = veTel(k, "paused:");
        const v = await lector.get(k); if (v !== "1") break;
        if (!t) { anom.pausa_sin_tel++; break; }
        // PTTL -1 = pausa que no caduca; > 0 = instante absoluto en que caduca
        acc(tels, t).pausa = pausaMas(acc(tels, t).pausa, pttl > 0 ? { hasta: ahora + pttl } : { hasta: null });
        break;
      }
      case "waiting": { const t = veTel(k, "waiting:"); if (t && (await lector.get(k)) === "1") acc(tels, t).esperando = true; break; }
      case "inbound": {
        const t = veTel(k, "inbound:"); if (!t) break;
        const n = parseInt(await lector.get(k), 10);
        if (Number.isFinite(n) && n > 1e11) { const x = acc(tels, t); x.inbound = Math.max(x.inbound || 0, n); }
        break;
      }
      case "optout": {
        const t = veTel(k, "optout:"); if (!t) { anom.baja_sin_tel++; break; }
        const n = parseInt(await lector.get(k), 10);
        const x = acc(tels, t);
        const ms = Number.isFinite(n) && n > 1e11 ? n : ahora;           // una baja sin fecha válida SIGUE siendo una baja
        x.baja = x.baja === null ? ms : Math.min(x.baja, ms);
        break;
      }
      case "optoutack": { const t = veTel(k, "optoutack:"); if (t) acc(tels, t).acuse = true; break; }
      case "followup": { const t = veTel(k, "followup:"); if (t) { const x = acc(tels, t); x.seguimientos = Math.max(x.seguimientos, parseInt(await lector.get(k), 10) || 0); } break; }
      case "notified": { const t = veTel(k, "notified:"); if (t) { const x = acc(tels, t); x.aviso = Math.max(x.aviso, NIVEL[await lector.get(k)] || 0); } break; }
      case "testnotif": { const t = veTel(k, "testnotif:"); if (t) acc(tels, t).avisoTesting = true; break; }
      case "esc_queue": cola = await lector.lista(k); break;
      case "escmap": {
        const raw = await lector.get(k);
        escmap.push({ wamid: sufijo(k, "escmap"), entry: raw, pttl });
        break;
      }
      case "botcfg": try { cfg = JSON.parse(await lector.get(k)); } catch (_) { anom.json_roto++; } break;
      case "botcfg_log": cfgLog = await lector.lista(k); break;
      default: break;
    }
  }

  // Escalaciones: la cola trae el string exacto; escmap:<wamid> guarda ese mismo string → de ahí sale el aviso_wamid.
  const porEntry = new Map(escmap.map((e) => [e.entry, e]));
  const usadas = new Set();
  const colaViejoPrimero = cola.slice().reverse();                        // lPush: el [0] es el más nuevo
  for (const raw of colaViejoPrimero) {
    let e; try { e = JSON.parse(raw); } catch (_) { anom.json_roto++; continue; }
    const t = telDe(e && e.customerPhone);
    if (!t) { anom.tel_invalido++; continue; }
    const m = porEntry.get(raw);
    if (m) usadas.add(m.wamid); else anom.cola_sin_escmap++;
    // escmap vive 7 d: lo que le queda dice cuándo nació (creada ≈ ahora + pttl − 7 d); sin mapa no hay fecha: «ahora»
    const creada = m && m.pttl > 0 ? Math.min(ahora, ahora + m.pttl - 7 * 86400000) : ahora;
    acc(tels, t).escalaciones.push({ nombre: e.customerName ? String(e.customerName).slice(0, 80) : null, pregunta: limpia(e.question, 500), aviso_wamid: m ? m.wamid.slice(0, 120) : null, creada_ms: creada });
  }
  anom.escmap_sin_cola = escmap.filter((e) => !usadas.has(e.wamid)).length;

  // payload por teléfono
  const chats = [];
  for (const x of [...tels.values()].sort((a, b) => (a.tel < b.tel ? -1 : 1))) {
    const l = x.lead || {};
    const base = Number(l.createdAt) > 1e11 ? Number(l.createdAt) : ahora;
    let ordinal = 0;
    const msgs = (x.mensajes || []).map((m) => { const p = mensajeAPayload(m, base + (ordinal++)); if (p && p._media_descartada) desc.mensajes_media_sin_id++; return p; }).filter(Boolean).slice(-100);
    // orden estable por ts (el bot los guarda ya en orden; esto cubre un ts ausente que cayó fuera de sitio)
    msgs.forEach((m, i) => { m._i = i; });
    msgs.sort((a, b) => a.ts_ms - b.ts_ms || a._i - b._i);
    msgs.forEach((m) => { delete m._i; delete m._media_descartada; });
    const baja = x.baja;
    if (x.acuse && baja === null) anom.optoutack_sin_optout++;
    chats.push({
      tel: x.tel,
      chat: {
        nombre_perfil: l.name ? limpia(l.name, 80) : null,
        intent: l.intent ? limpia(l.intent, 40) : null,
        ultimo_mensaje: l.lastMessage ? limpia(l.lastMessage, 200) : null,
        ultimo_por: POR_DE[l.lastBy] || null,
        creado_ms: Number(l.createdAt) > 1e11 ? Number(l.createdAt) : null,
        actualizado_ms: Number(l.updatedAt) > 1e11 ? Number(l.updatedAt) : null,
        archivado: !!l.archived,
        ultimo_entrante_ms: x.inbound,
        esperando: x.esperando,
        pausado: !!x.pausa || baja !== null,
        pausa_hasta_ms: baja !== null ? null : (x.pausa ? x.pausa.hasta : null),
        baja_ms: baja,
        baja_acuse: x.acuse && baja !== null,
        seguimientos: Math.min(x.seguimientos, 1000),
        aviso_nivel: x.aviso,
        aviso_testing: x.avisoTesting,
      },
      mensajes: msgs,
      escalaciones: x.escalaciones.slice(0, 20),
    });
  }

  // Configuración y su registro (el registro de Redis va camelCase; la función SQL lo pasa a snake_case)
  const config = cfg && typeof cfg === "object" ? {
    extra: String(cfg.extra ?? ""), bienvenida: String(cfg.bienvenida ?? ""), pausa_horas: Math.max(0, Math.min(720, parseInt(cfg.pausaHoras, 10) || 0)),
    updated_ms: Number(cfg.updatedAt) || null, updated_by: String(cfg.updatedBy ?? "").slice(0, 120),
  } : null;
  const aCfg = (c) => c && typeof c === "object" ? { extra: String(c.extra ?? ""), bienvenida: String(c.bienvenida ?? ""), pausa_horas: Math.max(0, Math.min(720, parseInt(c.pausaHoras, 10) || 0)) } : null;
  const log = [];
  for (const raw of cfgLog.slice().reverse()) {                          // más viejo primero: los id de Postgres crecen con el tiempo
    try { const e = JSON.parse(raw); const prev = aCfg(e.prev), next = aCfg(e.next); if (prev && next) log.push({ ts_ms: Number(e.ts) || ahora, by: String(e.by ?? "").slice(0, 120), prev, next }); else anom.json_roto++; }
    catch (_) { anom.json_roto++; }
  }
  return { ahora, chats, config, config_log: log.slice(-50), descartes: desc, anomalias: anom };
}

// ── Digest canónico de los mensajes: el MISMO texto que calcula bot_importar_cuadre en Postgres (md5 de las dos formas) ──
export function digestMensajes(msgs) {
  const s = msgs.map((m) => `${m.rol}\u0001${m.por}\u0001${m.ts_ms}\u0001${m.contenido}`).join("\u0002");
  return crypto.createHash("md5").update(s, "utf8").digest("hex");
}

// Lo que se espera encontrar en Postgres para un teléfono (para el cuadre)
function esperado(p) {
  return {
    n_mensajes: p.mensajes.length,
    hash_mensajes: digestMensajes(p.mensajes),
    ultimo_entrante_ms: p.chat.ultimo_entrante_ms,
    pausado: p.chat.pausado,
    pausa_indefinida: p.chat.pausado && p.chat.pausa_hasta_ms === null,
    pausa_hasta_ms: p.chat.pausa_hasta_ms,
    baja: p.chat.baja_ms !== null,
    aviso_nivel: p.chat.aviso_nivel,
    escalaciones_abiertas: p.escalaciones.length,
  };
}

// ── 3. IMPORTAR + CUADRE ───────────────────────────────────────────────────────────────────────
// transporte = { chat(payload) → {ok,...}, config(payload) → {...}, cuadre(tel) → {existe, n_mensajes, hash_mensajes, ultimo_entrante_ms,
//                pausado, pausa_hasta_ms, baja, aviso_nivel, escalaciones_abiertas} }
// dryRun=true → no envía nada; el informe sale con lo que SE ENVIARÍA (conteos).
export async function importar(lector, transporte, { ahora = Date.now(), dryRun = false } = {}) {
  const lectura = await leerTodo(lector, { ahora });
  const informe = {
    dryRun, telefonos: lectura.chats.length, descartes: lectura.descartes, anomalias: lectura.anomalias,
    enviados: 0, fallos_envio: 0, omitidos: { mensajes_posteriores: 0 },
    config: { en_redis: !!lectura.config, log_entradas: lectura.config_log.length, resultado: null },
    cuadre: null,
  };
  if (dryRun) {
    informe.mensajes = lectura.chats.reduce((a, c) => a + c.mensajes.length, 0);
    informe.bajas = lectura.chats.filter((c) => c.chat.baja_ms !== null).length;
    informe.pausas_vigentes = lectura.chats.filter((c) => c.chat.pausado && c.chat.baja_ms === null).length;
    return informe;
  }
  for (const p of lectura.chats) {
    try {
      const r = await transporte.chat(p);
      if (r && r.ok) { informe.enviados++; if (r.mensajes && r.mensajes.omitidos_posteriores) informe.omitidos.mensajes_posteriores++; }
      else informe.fallos_envio++;
    } catch (_) { informe.fallos_envio++; }
  }
  if (lectura.config) {
    try { const r = await transporte.config({ config: lectura.config, log: lectura.config_log }); informe.config.resultado = (r && (r.resultado || (r.ok ? "importada" : "fallo"))) || "fallo"; }
    catch (_) { informe.config.resultado = "fallo"; }
  }
  informe.cuadre = await cuadre(lectura, transporte);
  return informe;
}

// Compara, por teléfono, lo esperado con lo que hay en Postgres. El informe lleva AGREGADOS por campo; las discrepancias se
// identifican por ORDINAL (posición en la lista ordenada por teléfono), nunca por teléfono ni por contenido ni por hash.
export async function cuadre(lectura, transporte, { holguraMs = 5000 } = {}) {
  const campos = ["n_mensajes", "hash_mensajes", "ultimo_entrante", "pausado", "baja", "aviso_nivel", "escalaciones_abiertas"];
  const r = Object.fromEntries(campos.map((c) => [c, { coinciden: 0, difieren: 0, ordinales: [] }]));
  const marca = (campo, ok, i) => { if (ok) r[campo].coinciden++; else { r[campo].difieren++; r[campo].ordinales.push(i); } };
  const bajas = { en_redis: 0, en_postgres: 0, faltan: 0 };
  const pausas = { vigentes_en_redis: 0, en_postgres: 0, faltan: 0 };
  let sinFila = 0;
  for (let i = 0; i < lectura.chats.length; i++) {
    const p = lectura.chats[i];
    const e = esperado(p);
    let g; try { g = await transporte.cuadre(p.tel); } catch (_) { g = null; }
    if (!g || !g.existe) {
      sinFila++;
      campos.forEach((c) => marca(c, false, i));
      if (e.baja) { bajas.en_redis++; bajas.faltan++; }
      if (e.pausado && !e.baja) { pausas.vigentes_en_redis++; pausas.faltan++; }
      continue;
    }
    marca("n_mensajes", g.n_mensajes === e.n_mensajes, i);
    marca("hash_mensajes", g.hash_mensajes === e.hash_mensajes, i);
    // Postgres puede tener un entrante MÁS NUEVO (sombra); lo que no puede es tener uno más viejo o ninguno
    marca("ultimo_entrante", e.ultimo_entrante_ms === null ? true : (g.ultimo_entrante_ms !== null && g.ultimo_entrante_ms >= e.ultimo_entrante_ms), i);
    marca("pausado", e.pausado ? !!g.pausado : true, i);
    marca("baja", e.baja ? !!g.baja : true, i);
    marca("aviso_nivel", g.aviso_nivel >= e.aviso_nivel, i);
    marca("escalaciones_abiertas", g.escalaciones_abiertas >= e.escalaciones_abiertas, i);
    if (e.baja) { bajas.en_redis++; if (g.baja) bajas.en_postgres++; else bajas.faltan++; }
    if (e.pausado && !e.baja) {                                          // pausa vigente de Redis (las bajas ya se cuentan arriba)
      pausas.vigentes_en_redis++;
      const ok = e.pausa_indefinida
        ? !!g.pausado && g.pausa_hasta_ms === null
        : !!g.pausado && (g.pausa_hasta_ms === null || g.pausa_hasta_ms >= e.pausa_hasta_ms - holguraMs);
      if (ok) pausas.en_postgres++; else pausas.faltan++;
    }
  }
  return {
    campos: r, bajas, pausas, telefonos_sin_fila_en_postgres: sinFila,
    // una baja o pausa de Redis cuyo teléfono no se pudo leer NO se importó: cuenta como falta
    bajas_sin_telefono: lectura.anomalias.baja_sin_tel, pausas_sin_telefono: lectura.anomalias.pausa_sin_tel,
    ninguna_baja_ni_pausa_vigente_falta: bajas.faltan === 0 && pausas.faltan === 0 && sinFila === 0
      && lectura.anomalias.baja_sin_tel === 0 && lectura.anomalias.pausa_sin_tel === 0,
  };
}
