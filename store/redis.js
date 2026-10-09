// ─── ALMACÉN REDIS DEL BOT (S4a del encargo 20261009_lawang_bot_sin_redis) ──────────────
// TODO el acceso a Redis y TODA la memoria de respaldo (las variables de RAM que se usan cuando no hay
// Redis) viven aquí y SOLO aquí. Se movió desde index.js sin cambiar el comportamiento: mismas claves,
// mismas operaciones, mismos TTL. index.js importa estas funciones y no toca el cliente.
//
// Por qué un único módulo: es lo que hace imposible que un STOP o una pausa acaben guardados en RAM por
// un sitio olvidado, y lo que permitirá apagar Redis borrando este fichero (S9). Lo vigila
// test-store-aislado.js: falla si el cliente o la memoria de respaldo aparecen fuera de este módulo.
//
// Regla para el siguiente que toque esto: una función nueva que lea o escriba datos del bot va AQUÍ.
// Las funciones que además llevan lógica del bot (normalizar el teléfono, loguear, decidir) se quedan
// en index.js y llaman a estas.
import { createClient } from "redis";
import { ttlPausaHumana } from "../botcfg.js";

// 30 días: alineado con la cadencia de follow-up (30 días, ver setFollowupCount) — antes
// eran 7 y el bot podía mandar un recordatorio del día 25 sin memoria de la charla.
const CONV_TTL = 30 * 24 * 60 * 60;
const fallbackMemory = {};
const fallbackEscQueue = [];
let redisClient = null;

// BOT_STORE=postgres (S4b): tras llamar a bloqueaRedis() cualquier función de este módulo que toque Redis o la memoria de
// respaldo LANZA. Es lo que garantiza que, con Postgres como almacén, un STOP o una pausa no acaben guardados aquí por un sitio
// olvidado. Quedan fuera del bloqueo solo lo que no puede tocar Redis (apptTs, redisActivo, almacenNombre) y lo que en ese modo
// es memoria del proceso por diseño (cuenta de WhatsApp bloqueada y topes del CRM: el cliente de Redis nunca se crea).
let bloqueado = false;
export function bloqueaRedis() { bloqueado = true; }
function guardia(nombre) { if (bloqueado) throw new Error("Redis bloqueado (BOT_STORE=postgres): " + nombre); }

// Conexión: se llama UNA vez desde el arranque de index.js, en el mismo punto donde antes vivía este bloque.
export async function initRedis({ url, projectName, crear = createClient }) { guardia("initRedis");  // `crear`: solo lo cambian los tests (cliente falso)
  try {
    if (!url) throw new Error("REDIS_URL no configurado");
    // reconnectStrategy acotado (máx. 10 intentos, hasta 3s entre ellos): tras una caída
    // transitoria YA conectado, sigue reconectando solo — un reconnectStrategy:false a secas
    // mataría esa resiliencia entera, no solo el cuelgue del arranque.
    redisClient = crear({ url, socket: { reconnectStrategy: (retries) => (retries > 10 ? false : Math.min(retries * 200, 3000)) } });
    redisClient.on("error", (e) => console.error(`[${projectName}] Redis error:`, e.message));
    // node-redis reintenta la conexión inicial con el mismo backoff antes de rechazar la
    // promesa — sin este timeout, un Redis inalcanzable cuelga el arranque entero (nunca cae
    // a RAM ni levanta el servidor) en vez de degradar con gracia como se pretendía.
    await Promise.race([
      redisClient.connect(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout conectando a Redis")), 5000)),
    ]);
    console.log(`[${projectName}] Redis conectado`);
  } catch (e) {
    console.warn(`[${projectName}] Redis no disponible, usando memoria RAM:`, e.message);
    try { redisClient?.destroy(); } catch (_) { /* best-effort: para los reintentos de fondo si el connect() perdió la carrera contra el timeout */ }
    redisClient = null;
  }
}

// ¿Hay Redis conectado? y su nombre para /health y el log de arranque.
export function redisActivo() { return !!redisClient; }
export function almacenNombre() { return redisClient ? "redis" : "ram"; }

// ─── CONVERSACIÓN ──────────────────────────────────────────────────
export async function getConversation(phone) { guardia("getConversation");
  if (redisClient) {
    const data = await redisClient.get(`conv:${phone}`);
    return data ? JSON.parse(data) : [];
  }
  return fallbackMemory[phone] || [];
}

// Se guardan hasta 100 mensajes (historial que ve el panel/CRM en un takeover humano);
// el prompt del bot usa solo los últimos 20 (slice al construir los messages de Claude).
export async function saveConversation(phone, messages) { guardia("saveConversation");
  const trimmed = messages.slice(-100);
  if (redisClient) {
    await redisClient.setEx(`conv:${phone}`, CONV_TTL, JSON.stringify(trimmed));
  } else {
    fallbackMemory[phone] = trimmed;
  }
}

// ─── ESCALACIONES AL OWNER ─────────────────────────────────────────
export async function escPush(customerPhone, customerName, question) { guardia("escPush");
  const entry = JSON.stringify({ customerPhone, customerName, question });
  if (redisClient) {
    await redisClient.lPush("esc_queue", entry);
  } else {
    fallbackEscQueue.unshift(entry);
  }
  return entry; // string exacto encolado → permite lRem selectivo si el owner responde citando
}

export async function escPop() { guardia("escPop");
  if (redisClient) {
    const raw = await redisClient.rPop("esc_queue");
    return raw ? JSON.parse(raw) : null;
  }
  const raw = fallbackEscQueue.pop();
  return raw ? JSON.parse(raw) : null;
}

// Mapa wamid del aviso → escalación: si el owner responde citando, se enruta a este cliente exacto.
export async function escMapGuardar(wamid, entry) { guardia("escMapGuardar");
  if (redisClient) await redisClient.setEx(`escmap:${wamid}`, 7 * 86400, entry);
}

// El owner respondió citando el aviso `ctxId`: devuelve esa escalación (y la saca de la cola y del mapa) o null.
export async function escRutaPorCita(ctxId) { guardia("escRutaPorCita");
  if (!(ctxId && redisClient)) return null;
  const raw = await redisClient.get(`escmap:${ctxId}`);
  if (!raw) return null;
  const pending = JSON.parse(raw);
  await redisClient.lRem("esc_queue", 1, raw); // quitarla de la cola para no reenviarla doble
  await redisClient.del(`escmap:${ctxId}`);
  return pending;
}

// ─── LEADS ─────────────────────────────────────────────────────────
const fallbackLeads = {};      // phone → { phone, name, intent, lastMessage, updatedAt }
const fallbackNotified = {};   // phone → "interested" | "booking"

export async function getLead(phone) { guardia("getLead");
  if (redisClient) {
    const d = await redisClient.get(`lead:${phone}`);
    return d ? JSON.parse(d) : null;
  }
  return fallbackLeads[phone] || null;
}

// Guarda la ficha del lead en el almacén y en el índice (ordenado por `score`).
export async function leadGuardar(phone, info, score) { guardia("leadGuardar");
  if (redisClient) {
    await redisClient.set(`lead:${phone}`, JSON.stringify(info));
    await redisClient.zAdd("leads_index", { score, value: phone });
  } else {
    fallbackLeads[phone] = info;
  }
}

// Todas las fichas, la más reciente primero. `null` = el índice de Redis está vacío (el llamador devuelve [] sin más).
export async function leadsListar() { guardia("leadsListar");
  if (redisClient) {
    const phones = await redisClient.zRange("leads_index", 0, -1, { REV: true });
    if (!phones.length) return null;
    const raws = await Promise.all(phones.map((p) => redisClient.get(`lead:${p}`)));
    return raws.filter(Boolean).map((r) => JSON.parse(r));
  }
  return Object.values(fallbackLeads).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function leadsContar() { guardia("leadsContar");
  if (redisClient) return await redisClient.zCard("leads_index");
  return Object.keys(fallbackLeads).length;
}

// Borrado definitivo de TODO lo que el bot guarda de un teléfono.
export async function leadBorrar(phone) { guardia("leadBorrar");
  if (redisClient) {
    await redisClient.del(`lead:${phone}`, `notes:${phone}`, `status:${phone}`, `conv:${phone}`, `paused:${phone}`, `waiting:${phone}`, `inbound:${phone}`, `followup:${phone}`, `notified:${phone}`, `lastlink:${phone}`);
    await redisClient.zRem("leads_index", phone);
  } else {
    delete fallbackLeads[phone]; delete fallbackNotes[phone]; delete fallbackStatus[phone];
    delete fallbackPaused[phone]; delete fallbackWaiting[phone]; delete fallbackInbound[phone];
    delete fallbackFollowup[phone]; delete fallbackNotified[phone];
    delete fallbackMemory[phone];
  }
}

export async function getNotifiedLevel(phone) { guardia("getNotifiedLevel");
  if (redisClient) return (await redisClient.get(`notified:${phone}`)) || null;
  return fallbackNotified[phone] || null;
}

export async function setNotifiedLevel(phone, level) { guardia("setNotifiedLevel");
  if (redisClient) {
    await redisClient.setEx(`notified:${phone}`, CONV_TTL, level);
  } else {
    fallbackNotified[phone] = level;
  }
}

// ─── PAUSA DEL BOT POR LEAD ────────────────────────────────────────
const fallbackPaused = {};
export async function setPaused(phone, val) { guardia("setPaused");
  if (redisClient) {
    if (val) await redisClient.set(`paused:${phone}`, "1");
    else await redisClient.del(`paused:${phone}`);
  } else {
    if (val) fallbackPaused[phone] = true;
    else delete fallbackPaused[phone];
  }
}
export async function isPaused(phone) { guardia("isPaused");
  if (redisClient) return (await redisClient.get(`paused:${phone}`)) === "1";
  return !!fallbackPaused[phone];
}

// "Una persona tomó el mando": pausa con la caducidad configurada (0 = no caduca). Una pausa manual sin
// caducidad no se vuelve caducable por esto, y cada nuevo mensaje de la persona renueva el plazo.
export async function setPausedHumano(phone, pausaHoras) { guardia("setPausedHumano");
  if (!redisClient) return setPaused(phone, true);
  const t = ttlPausaHumana(pausaHoras, await redisClient.ttl(`paused:${phone}`));
  if (!t.poner) return;
  if (t.segundos) await redisClient.set(`paused:${phone}`, "1", { EX: t.segundos });
  else await redisClient.set(`paused:${phone}`, "1");
}

// ─── CONFIGURACIÓN EDITABLE DESDE EL CRM (botcfg:v1 y su registro) ──
// Texto crudo de la config guardada (o null). Lanza si Redis falla: el llamador decide qué hacer.
export async function cfgRawLeer() { guardia("cfgRawLeer"); return await redisClient.get("botcfg:v1"); }
export async function cfgLogRaw(n) { guardia("cfgLogRaw"); return await redisClient.lRange("botcfg:log", 0, n - 1); }
// Una sola transacción: la config nueva y su entrada de registro entran juntas o no entra ninguna.
export async function cfgGuardarConLog(nextJson, entryJson) { guardia("cfgGuardarConLog");
  await redisClient.multi()
    .set("botcfg:v1", nextJson)
    .lPush("botcfg:log", entryJson)
    .lTrim("botcfg:log", 0, 49)
    .exec();
}

// ─── TOPES DEL CRM (contadores por día) ────────────────────────────
const _topesMem = new Map();
export async function incrTope(k) {
  if (redisClient) { const n = await redisClient.incr(k); if (n === 1) await redisClient.expire(k, 86400); return n; }
  const n = (_topesMem.get(k) || 0) + 1; _topesMem.set(k, n); return n;
}

// ─── "POR RESPONDER" ───────────────────────────────────────────────
const fallbackWaiting = {};
export async function setWaiting(phone, val) { guardia("setWaiting");
  if (redisClient) {
    if (val) await redisClient.set(`waiting:${phone}`, "1");
    else await redisClient.del(`waiting:${phone}`);
  } else {
    if (val) fallbackWaiting[phone] = true;
    else delete fallbackWaiting[phone];
  }
}
export async function isWaiting(phone) { guardia("isWaiting");
  if (redisClient) return (await redisClient.get(`waiting:${phone}`)) === "1";
  return !!fallbackWaiting[phone];
}

// ─── ÚLTIMO MENSAJE ENTRANTE (ventana de 24h de WhatsApp) ──────────
const fallbackInbound = {};
export async function setInbound(phone, ts) { guardia("setInbound");
  if (redisClient) await redisClient.setEx(`inbound:${phone}`, CONV_TTL, String(ts));
  else fallbackInbound[phone] = ts;
}
export async function getInbound(phone) { guardia("getInbound");
  if (redisClient) { const v = await redisClient.get(`inbound:${phone}`); return v ? parseInt(v) : null; }
  return fallbackInbound[phone] || null;
}

// ─── BAJA DEL LEAD (STOP) ──────────────────────────────────────────
// SIN TTL, al revés que el resto de claves del bot: una baja no caduca a los 30 días.
// Reciben el teléfono YA normalizado (la normalización es del bot, no del almacén).
const fallbackOptOut = new Set();
export async function optOutPoner(p) { guardia("optOutPoner");
  if (redisClient) await redisClient.set(`optout:${p}`, String(Date.now()));
  else fallbackOptOut.add(p);
}
export async function optOutLeer(p) { guardia("optOutLeer");
  if (redisClient) return !!(await redisClient.get(`optout:${p}`));
  return fallbackOptOut.has(p);
}
// Acuse de la baja: una sola vez.
const fallbackOptOutAck = new Set();
export async function optOutAckLeer(p) { guardia("optOutAckLeer");
  if (redisClient) return !!(await redisClient.get(`optoutack:${p}`));
  return fallbackOptOutAck.has(p);
}
export async function optOutAckPoner(p) { guardia("optOutAckPoner");
  if (redisClient) await redisClient.set(`optoutack:${p}`, "1");
  else fallbackOptOutAck.add(p);
}

// ─── SEGUIMIENTO AUTOMÁTICO TRAS 24h ───────────────────────────────
const fallbackFollowup = {};
export async function getFollowupCount(phone) { guardia("getFollowupCount");
  if (redisClient) { const v = await redisClient.get(`followup:${phone}`); return v ? parseInt(v) : 0; }
  return fallbackFollowup[phone] || 0;
}
export async function setFollowupCount(phone, n) { guardia("setFollowupCount");
  if (redisClient) await redisClient.setEx(`followup:${phone}`, 30 * 24 * 3600, String(n));
  else fallbackFollowup[phone] = n;
}
export async function resetFollowup(phone) { guardia("resetFollowup");
  if (redisClient) await redisClient.del(`followup:${phone}`);
  else delete fallbackFollowup[phone];
}

// ─── CRM MANUAL DESDE EL PANEL: notas y estado de pipeline ─────────
const fallbackNotes = {}, fallbackStatus = {};
export async function setNotes(phone, notes) { guardia("setNotes");
  if (redisClient) await redisClient.set(`notes:${phone}`, notes || "");
  else fallbackNotes[phone] = notes || "";
}
export async function getNotes(phone) { guardia("getNotes");
  if (redisClient) return (await redisClient.get(`notes:${phone}`)) || "";
  return fallbackNotes[phone] || "";
}
export async function setStatus(phone, status) { guardia("setStatus");
  if (redisClient) await redisClient.set(`status:${phone}`, status || "");
  else fallbackStatus[phone] = status || "";
}
export async function getStatus(phone) { guardia("getStatus");
  if (redisClient) return (await redisClient.get(`status:${phone}`)) || "";
  return fallbackStatus[phone] || "";
}

// ─── RESPUESTAS RÁPIDAS (canned replies, compartidas por proyecto) ──
let fallbackCanned = null;
export async function cannedLeer(porDefecto) { guardia("cannedLeer");
  if (redisClient) { const v = await redisClient.get("canned"); return v ? JSON.parse(v) : porDefecto; }
  return fallbackCanned || porDefecto;
}
export async function setCanned(list) { guardia("setCanned");
  if (redisClient) await redisClient.set("canned", JSON.stringify(list));
  else fallbackCanned = list;
}

// ─── CITAS / APPOINTMENTS (calendario del panel) ───────────────────
const fallbackAppts = {};
export function apptTs(when) { const t = Date.parse(when); return isNaN(t) ? Date.now() : t; }

export async function persistAppt(appt) { guardia("persistAppt");
  if (redisClient) {
    await redisClient.set(`appt:${appt.id}`, JSON.stringify(appt));
    await redisClient.zAdd("appts_index", { score: apptTs(appt.when), value: appt.id });
  } else {
    fallbackAppts[appt.id] = appt;
  }
}
// Reindexa la cita por su fecha (solo hay índice con Redis).
export async function apptReindexar(appt) { guardia("apptReindexar");
  if (redisClient) {
    await redisClient.zAdd("appts_index", { score: apptTs(appt.when), value: appt.id });
  }
}
export async function listAppts() { guardia("listAppts");
  if (redisClient) {
    const ids = await redisClient.zRange("appts_index", 0, -1);
    if (!ids.length) return [];
    const raws = await Promise.all(ids.map((i) => redisClient.get(`appt:${i}`)));
    return raws.filter(Boolean).map((r) => JSON.parse(r));
  }
  return Object.values(fallbackAppts).sort((x, y) => apptTs(x.when) - apptTs(y.when));
}
export async function getAppt(id) { guardia("getAppt");
  if (redisClient) { const r = await redisClient.get(`appt:${id}`); return r ? JSON.parse(r) : null; }
  return fallbackAppts[id] || null;
}
export async function apptBorrar(id) { guardia("apptBorrar");
  if (redisClient) {
    await redisClient.del(`appt:${id}`);
    await redisClient.zRem("appts_index", id);
  } else {
    delete fallbackAppts[id];
  }
}

// ─── RECORDATORIO AUTOMÁTICO AL CLIENTE (antes de la videollamada) ──
const fallbackReminded = {};
export async function isReminded(id) { guardia("isReminded");
  if (redisClient) return (await redisClient.get(`reminded:${id}`)) === "1";
  return !!fallbackReminded[id];
}
export async function setReminded(id) { guardia("setReminded");
  if (redisClient) await redisClient.setEx(`reminded:${id}`, 7 * 24 * 3600, "1");
  else fallbackReminded[id] = true;
}

// ─── BIBLIOTECA DE MEDIA (fotos/vídeos que el bot puede enviar; se gestiona desde el panel) ──
let fallbackMediaLib = [];
export async function getMediaLib() { guardia("getMediaLib");
  if (redisClient) { const r = await redisClient.get("media_lib"); return r ? JSON.parse(r) : []; }
  return fallbackMediaLib;
}
export async function setMediaLib(list) { guardia("setMediaLib");
  const arr = Array.isArray(list) ? list.slice(0, 50) : [];
  if (redisClient) await redisClient.set("media_lib", JSON.stringify(arr));
  else fallbackMediaLib = arr;
  return arr;
}

// Archivos subidos desde el panel (foto/vídeo local) → se guardan como blob y se sirven por /media/:id,
// para que el bot los envíe por link sin hosting externo.
const fallbackBlobs = {};
export async function setBlob(id, mime, b64) { guardia("setBlob");
  const payload = JSON.stringify({ mime, data: b64 });
  if (redisClient) await redisClient.set(`mediablob:${id}`, payload);
  else fallbackBlobs[id] = payload;
}
export async function getBlob(id) { guardia("getBlob");
  const raw = redisClient ? await redisClient.get(`mediablob:${id}`) : fallbackBlobs[id];
  return raw ? JSON.parse(raw) : null;
}
export async function delBlob(id) { guardia("delBlob");
  if (redisClient) await redisClient.del(`mediablob:${id}`);
  else delete fallbackBlobs[id];
}

// Último link de pago generado por lead (para reenviarlo sin crear un cobro nuevo).
const fallbackLastLink = {};
export async function setLastLink(phone, url) { guardia("setLastLink");
  if (redisClient) await redisClient.setEx(`lastlink:${phone}`, 24 * 3600, url);
  else fallbackLastLink[phone] = url;
}
export async function getLastLink(phone) { guardia("getLastLink");
  if (redisClient) return (await redisClient.get(`lastlink:${phone}`)) || "";
  return fallbackLastLink[phone] || "";
}

// ─── CUENTA DE WHATSAPP BLOQUEADA (wa:blocked; la copia en RAM cubre un Redis caído) ──
let waBlockedRam = null;
export async function setWaBlocked(code, detail) {
  waBlockedRam = { code, detail: String(detail || "").slice(0, 300), ts: Date.now() };
  if (redisClient) { try { await redisClient.setEx("wa:blocked", 6 * 3600, JSON.stringify(waBlockedRam)); } catch (e) { /* best-effort */ } }
}
export async function getWaBlocked() {
  if (redisClient) { try { const v = await redisClient.get("wa:blocked"); return v ? JSON.parse(v) : null; } catch (e) { /* cae al de RAM */ } }
  return waBlockedRam;
}
export async function clearWaBlocked() {
  if (!waBlockedRam && !redisClient) return;
  waBlockedRam = null;
  if (redisClient) { try { await redisClient.del("wa:blocked"); } catch (e) { /* best-effort */ } }
}

// ─── AVISO "LEAD FRENADO POR EL MODO TESTING" (una vez por teléfono) ──
// Clave propia (`testnotif:`) para no pisar el nivel de NOTIFY_RANK de notifyOwner.
// Devuelve true si ya se había avisado; si no, lo deja marcado y devuelve false.
const fallbackTestNotified = new Set();
export async function testNotifYaAvisado(clean) { guardia("testNotifYaAvisado");
  if (redisClient) {
    if (await redisClient.get(`testnotif:${clean}`)) return true;
    await redisClient.setEx(`testnotif:${clean}`, CONV_TTL, "1");
    return false;
  }
  if (fallbackTestNotified.has(clean)) return true;
  fallbackTestNotified.add(clean);
  return false;
}

// ─── DEDUP POR WAMID ───────────────────────────────────────────────
// Meta reintenta la entrega si no confirma rápido → el mismo mensaje puede llegar 2+ veces y el bot
// respondería doble. TTL 24h (los reintentos son de minutos).
const fallbackSeenWamids = new Set();
export async function alreadyProcessed(wamid) { guardia("alreadyProcessed");
  if (!wamid) return false;
  if (redisClient) {
    const first = await redisClient.set(`wamid:${wamid}`, "1", { NX: true, EX: 86400 });
    return first === null; // null = la clave ya existía → duplicado
  }
  if (fallbackSeenWamids.has(wamid)) return true;
  fallbackSeenWamids.add(wamid);
  if (fallbackSeenWamids.size > 5000) fallbackSeenWamids.clear(); // ponytail: cap burdo; Redis es el camino real
  return false;
}

// ─── NEWSLETTER: bajas de email y campañas programadas ─────────────
const fallbackUnsub = new Set();
export async function unsubAgregar(e) { guardia("unsubAgregar");
  if (redisClient) await redisClient.sAdd("unsub_emails", e); else fallbackUnsub.add(e);
}
export async function unsubLeer() { guardia("unsubLeer");
  if (redisClient) return new Set((await redisClient.sMembers("unsub_emails")).map((s) => s.toLowerCase()));
  return new Set(fallbackUnsub);
}

let fallbackScheduled = [];
export async function getScheduled() { guardia("getScheduled");
  if (redisClient) { const r = await redisClient.get("nl_scheduled"); return r ? JSON.parse(r) : []; }
  return fallbackScheduled;
}
export async function setScheduled(list) { guardia("setScheduled");
  if (redisClient) await redisClient.set("nl_scheduled", JSON.stringify(list)); else fallbackScheduled = list;
}

// ─── LECTOR PARA EL IMPORTADOR (S5, TEMPORAL: se borra en S9 junto con Redis) ──────────────────────
// SOLO LECTURA. import_redis.js no puede nombrar el cliente (test-store-aislado.js), así que recibe esto.
// null si no hay Redis conectado. Nada de aquí escribe ni borra una clave.
export function lectorImportacion() { guardia("lectorImportacion");
  if (!redisClient) return null;
  const c = redisClient;
  const aplana = (k) => (Array.isArray(k) ? k : [k]);
  return {
    async *escanear() { for await (const k of c.scanIterator({ MATCH: "*", COUNT: 500 })) for (const x of aplana(k)) yield String(x); },
    tipo: (k) => c.type(k),
    pttl: (k) => c.pTTL(k),
    get: (k) => c.get(k),
    lista: (k) => c.lRange(k, 0, -1),
    dbsize: () => c.dbSize(),
    async keyspace() {                       // solo números: «db0:keys=12,expires=3,...» → [{db, keys}]
      const txt = String(await c.info("keyspace"));
      const dbs = [...txt.matchAll(/^db(\d+):keys=(\d+)/gm)].map((m) => ({ db: Number(m[1]), keys: Number(m[2]) }));
      return { dbs };
    },
  };
}
