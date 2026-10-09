// Piezas falsas para probar el bot de punta a punta SIN secretos ni red (S4b): una edge `bot-api` con una base en memoria que imita las
// funciones SQL de S1, el API de Meta (Graph) y el API de Anthropic (SSE). `lanzaBot` arranca `node index.js` de verdad como proceso hijo
// y se detiene SOLO por el PID que lanzó (nunca por el texto de su línea de comandos).
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { accionesConsentimiento } from "./fakes-consent.js";

const RAIZ = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
export { esperar };

async function leeCuerpo(req) { const trozos = []; for await (const t of req) trozos.push(t); return Buffer.concat(trozos).toString("utf8"); }
function escucha(handler) {
  return new Promise((ok) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => ok({ server, puerto: server.address().port, cierra: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) }));
  });
}

// ═══ ESQUEMA CERRADO de la edge real ═══
// Copia de las claves permitidas de LISTA_CERRADA (proyectos/Lawang/supabase/functions/bot-api/index.ts). La edge real responde 400
// `campo_no_permitido` a cualquier clave que no esté aquí; la edge FALSA hace lo mismo, así que las pruebas de punta a punta demuestran que
// los cuerpos del bot encajan. test-pg-contrato.js compara esta copia con el index.ts real: si la edge cambia, esa prueba falla.
export const ESQUEMA = {
  estado: {
    mensaje_recibir: { claves: ["accion", "tel", "wamid", "nombre_perfil", "mensaje"], tel: true },
    turno_estado: { claves: ["accion", "tel", "testing"], tel: true },
    turno_cerrar: { claves: ["accion", "tel", "wamid", "salida", "intent", "aviso", "esperando", "cambio_tema"], tel: true },
    eco_operadora: { claves: ["accion", "tel", "wamid", "texto", "horas"], tel: true },
    pausar: { claves: ["accion", "tel", "modo", "horas"], tel: true },
    baja: { claves: ["accion", "tel", "wamid"], tel: true },
    entrega_fallida: { claves: ["accion", "tel", "codigo", "detalle"], tel: true },
    escalar: { claves: ["accion", "tel", "nombre", "pregunta", "aviso_wamid"], tel: true },
    escalacion_tomar: { claves: ["accion", "wamid"], tel: false },
    consentimiento_preguntar: { claves: ["accion", "tel", "version", "idioma", "texto", "repregunta"], tel: true },
    consentimiento_enviada: { claves: ["accion", "tel", "wamid", "repregunta"], tel: true },
    consentimiento_responder: { claves: ["accion", "tel", "wamid", "texto", "cita"], tel: true },
    lead_resumen: { claves: ["accion", "tel", "texto", "hasta_id"], tel: true },
  },
  recordatorio: {
    citas_recordar: { claves: ["accion"], tel: false },
    seguimiento_candidatos: { claves: ["accion"], tel: false },
    seguimiento_reservar: { claves: ["accion", "tel", "plantilla"], tel: true },
    seguimiento_registrar: { claves: ["accion", "tel", "plantilla", "wamid", "resultado", "texto"], tel: true },
    cita_recordatorio_res: { claves: ["accion", "accion_id", "resultado"], tel: false },
  },
  // Ruta `importar` (S5/LAW-507, Redis→Postgres): la usa el importador, no el runtime de BOT_STORE=supabase. Se copia aquí solo para que
  // la comparación con LISTA_CERRADA de la edge real siga siendo exacta tras integrar S5 (rebase S4b, 9-oct-2026).
  importar: {
    chat: { claves: ["accion", "tel", "chat", "mensajes", "escalaciones"], tel: true },
    config: { claves: ["accion", "config", "log"], tel: false },
    cuadre: { claves: ["accion", "tel"], tel: true },
  },
  humano: {
    pausar: { claves: ["accion", "tel", "modo"], tel: true },
    enviar: { claves: ["accion", "tel", "texto", "wamid", "media"], tel: true },
  },
};
export const ESQUEMA_INTERNO = { mensaje: ["rol", "texto", "media", "ts"], salida: ["texto", "media", "wamid"], media: ["tipo", "id"] };
const RE_TEL = /^\+?[0-9]{8,15}$/;
const RE_MSG = /^[A-Za-z0-9._:=@+/-]{1,120}$/;
const cerrado = (o, claves) => o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).every((k) => claves.includes(k));
/** Devuelve el código de error 400 de la edge real, o null si el cuerpo encaja. */
export function validaContrato(ruta, b) {
  const def = ESQUEMA[ruta] && ESQUEMA[ruta][b.accion];
  if (!def) return "accion";
  if (!cerrado(b, def.claves)) return "campo_no_permitido";
  if (def.tel && (typeof b.tel !== "string" || !RE_TEL.test(b.tel))) return "tel";
  for (const k of ["wamid", "aviso_wamid"]) if (b[k] !== undefined && b[k] !== null && (typeof b[k] !== "string" || !RE_MSG.test(b[k]))) return k;
  if (b.accion === "mensaje_recibir") {
    if (typeof b.wamid !== "string") return "wamid";
    const m = b.mensaje;
    if (!cerrado(m, ESQUEMA_INTERNO.mensaje) || (m.rol !== undefined && m.rol !== "user")) return "mensaje";
    if (m.media !== undefined && m.media !== null && !cerrado(m.media, ESQUEMA_INTERNO.media)) return "media";
  }
  if (b.accion === "turno_cerrar") {
    if (typeof b.wamid !== "string") return "wamid";
    if (b.salida !== undefined && b.salida !== null) {
      if (!Array.isArray(b.salida) || b.salida.length > 10) return "salida";
      for (const m of b.salida) {
        if (!cerrado(m, ESQUEMA_INTERNO.salida)) return "salida";
        if (m.media !== undefined && m.media !== null && !cerrado(m.media, ESQUEMA_INTERNO.media)) return "salida";
        if (m.wamid !== undefined && m.wamid !== null && (typeof m.wamid !== "string" || !RE_MSG.test(m.wamid))) return "salida";
      }
    }
    if (b.aviso !== undefined && b.aviso !== null && !["interested", "booking"].includes(b.aviso)) return "aviso";
    for (const k of ["esperando", "cambio_tema"]) if (b[k] !== undefined && typeof b[k] !== "boolean") return k;
  }
  if (b.accion === "turno_estado" && b.testing !== undefined && typeof b.testing !== "boolean") return "testing";
  if (b.accion === "baja" && typeof b.wamid !== "string") return "wamid";
  if (ruta === "humano" && b.usuario !== undefined) return "campo_no_permitido";
  return null;
}

// ═══ EDGE FALSA (imita bot-api + las funciones SQL de S1, simplificadas) ═══
export async function creaEdgeFalsa({ secretos }) {
  const llamadas = [];
  const chats = new Map();               // tel → { baja, bajaWamid, pausado, esperando, avisoNivel, avisoTestingEn, msgs[] }
  const wamids = new Map();              // wamid → { tel, vistoEn, procesado, reprocesos }
  const escalaciones = [];
  const fallos = [];                     // { accion, status, veces }
  const retrasos = [];                   // { accion, ms, veces }
  const resumenes = [];
  const citas = { lista: [], resultados: [] };
  let idMsg = 0;
  const S12 = accionesConsentimiento({ chats, chat: (t) => chat(t) });
  const { estadoConsentimiento: _e, revocaPorBaja: _r, envejece: _v, cs: _c, ...S12acciones } = S12;
  const cfg = { extra: "", bienvenida: "", pausa_horas: 0, resumen_cada_n: 30, fallos_alarma: 3, version: 1, actualizado_en: null };
  const estado = { reprocesar: new Set(), tope: new Set(), resumirSiempre: false };
  const chat = (tel) => { if (!chats.has(tel)) chats.set(tel, { baja: false, bajaWamid: null, pausado: false, esperando: false, avisoNivel: 0, avisoTestingEn: null, msgs: [] }); return chats.get(tel); };
  const hist = (c) => c.msgs.slice(-20).map((m) => ({ rol: m.rol, texto: m.texto, por: m.por, media: m.media || null, ts: m.ts }));

  const acciones = {
    mensaje_recibir(b) {
      const c = chat(b.tel);
      const w = wamids.get(b.wamid);
      if (estado.tope.has(b.tel)) return { duplicado: true, procesado: true, tope: true };
      if (w) {
        if (w.procesado) return { duplicado: true, procesado: true };
        if (estado.reprocesar.has(b.wamid) && w.reprocesos === 0) { w.reprocesos = 1; return { duplicado: false, procesado: false, reproceso: true }; }
        return { duplicado: true, procesado: false };
      }
      wamids.set(b.wamid, { tel: b.tel, vistoEn: Date.now(), procesado: false, reprocesos: 0 });
      c.esperando = true;
      if (b.nombre_perfil) c.nombre = String(b.nombre_perfil).split(" ")[0];
      c.msgs.push({ id: ++idMsg, rol: "user", por: "cliente", texto: b.mensaje.texto || "", media: b.mensaje.media || null, ts: Date.now(), wamid: b.wamid });
      return { duplicado: false, procesado: false };
    },
    turno_estado(b) {
      const c = chats.get(b.tel);
      if (!c) return { error: "sin_chat" };
      let avisar = false;
      if (b.testing && !c.avisoTestingEn) { c.avisoTestingEn = Date.now(); avisar = true; }
      return {
        baja: c.baja, pausado: c.pausado, esperando: c.esperando, avisar_testing: avisar,
        primer_turno: !c.msgs.some((m) => m.rol === "assistant"), historial: hist(c), config: cfg,
        consentimiento: S12.estadoConsentimiento(c),
      };
    },
    turno_cerrar(b) {
      const c = chats.get(b.tel);
      const w = wamids.get(b.wamid);
      if (!c || !w || w.tel !== b.tel) return { error: "wamid_desconocido" };
      if (w.procesado) return { avisar: null, resumir: null, repetido: true };
      for (const m of b.salida || []) c.msgs.push({ id: ++idMsg, rol: "assistant", por: "bot", texto: m.texto || "", media: m.media || null, ts: Date.now(), wamid: m.wamid || null });
      const nivel = b.aviso === "interested" ? 1 : b.aviso === "booking" ? 2 : 0;
      const avisar = nivel > c.avisoNivel ? b.aviso : null;
      c.avisoNivel = Math.max(c.avisoNivel, nivel);
      c.esperando = b.esperando === true;
      w.procesado = true;
      const resumir = estado.resumirSiempre ? { hasta_id: c.msgs[c.msgs.length - 1].id, mensajes: c.msgs.slice(-6).map((m) => ({ rol: m.rol, por: m.por, texto: m.texto })) } : null;
      return { avisar, resumir, repetido: false };
    },
    eco_operadora(b) {
      const c = chat(b.tel);
      const antes = c.pausado;
      c.pausado = true;
      if (wamids.has(b.wamid)) return { duplicado: true, estaba_pausado: antes };
      wamids.set(b.wamid, { tel: b.tel, vistoEn: Date.now(), procesado: true, reprocesos: 0 });
      c.msgs.push({ id: ++idMsg, rol: "assistant", por: "humano", texto: b.texto, ts: Date.now(), wamid: b.wamid });
      c.esperando = false;
      return { duplicado: false, estaba_pausado: antes };
    },
    pausar(b) { const c = chats.get(b.tel); if (!c) return { error: "sin_chat" }; c.pausado = b.modo === "humano"; return { pausado: c.pausado, hasta: null }; },
    baja(b) {
      const c = chat(b.tel);
      let r;
      if (!c.baja) { c.baja = true; c.bajaWamid = b.wamid; c.pausado = true; S12.revocaPorBaja(c); r = "nueva"; }
      else if (c.bajaWamid === b.wamid) r = "nueva";
      else r = "ya_dada";
      return { baja: r, pausado: true };
    },
    entrega_fallida(b) { return chats.has(b.tel) ? "ok" : "sin_chat"; },
    escalar(b) { if (!chats.has(b.tel)) return { error: "sin_chat" }; const e = { id: escalaciones.length + 1, tel: b.tel, nombre: b.nombre || null, pregunta: b.pregunta, aviso_wamid: b.aviso_wamid || null, resuelta: false }; escalaciones.push(e); return { id: e.id }; },
    escalacion_tomar(b) {
      const e = escalaciones.find((x) => !x.resuelta && (!b.wamid || x.aviso_wamid === b.wamid)) || escalaciones.find((x) => !x.resuelta);
      if (!e) return { encontrada: false };          // la edge real da esta forma fija (forma de escalacion_tomar)
      e.resuelta = true;
      return { encontrada: true, tel: e.tel, nombre: e.nombre, pregunta: e.pregunta };
    },
    // ruta /crm (catálogo y CRM del ERP, S4/S6): el cuerpo ya llega validado; aquí solo se anota
    lead_upsert(b) { const c = chats.get(b.tel); if (c) c.lead = true; return "existente"; },
    lead_nota() { return "ok"; },
    lead_cita() { return "propuesta"; },
    lead_resumen(b) { resumenes.push({ tel: b.tel, texto: b.texto, hasta_id: b.hasta_id }); return "ok"; },
    citas_recordar() { const l = citas.lista.splice(0); return { citas: l }; },
    cita_recordatorio_res(b) { citas.resultados.push({ id: b.accion_id, res: b.resultado }); return "ok"; },
    pausar_humano(b, jwt) { if (!jwt) return { error: "sin_usuario" }; const c = chats.get(b.tel); if (!c) return { error: "sin_chat" }; c.pausado = b.modo === "pausar"; return { pausado: c.pausado, hasta: null }; },
    enviar_humano(b, jwt) {
      if (!jwt) return { error: "sin_usuario" };
      const c = chats.get(b.tel); if (!c) return { error: "sin_chat" };
      c.msgs.push({ id: ++idMsg, rol: "assistant", por: "humano", texto: b.texto, ts: Date.now(), wamid: b.wamid });
      return { ok: true };
    },
  };
  Object.assign(acciones, S12acciones);
  const TEXTO = new Set(["entrega_fallida", "lead_resumen", "cita_recordatorio_res", "lead_upsert", "lead_nota", "lead_cita", "seguimiento_registrar"]);
  const RUTA = { estado: "estado", recordatorio: "recordatorio", humano: "humano", crm: "crm" };

  const srv = await escucha(async (req, res) => {
    const partes = new URL(req.url, "http://x").pathname.split("/").filter(Boolean);       // /edge/<ruta>
    const ruta = partes[1];
    const crudo = await leeCuerpo(req);
    let b = {}; try { b = JSON.parse(crudo || "{}"); } catch { /* cuerpo inválido */ }
    const dado = String(req.headers["x-bot-secret"] || "");
    const salida = (st, o) => { res.writeHead(st, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (!RUTA[ruta] || !dado || dado !== secretos[ruta]) { llamadas.push({ ruta, accion: b.accion, rechazada: 401 }); return salida(401, { error: "no_autorizado" }); }
    // La edge real valida el cuerpo contra su esquema cerrado ANTES de tocar la base: una clave de más es un 400 (y el bot, en recibir, lo vería como error de programación).
    if (ruta !== "crm") { const err = validaContrato(ruta, b); if (err) { llamadas.push({ ruta, accion: b.accion, cuerpo: b, rechazada: 400, error: err }); return salida(400, { error: err }); } }
    let accion = b.accion;
    if (ruta === "humano") accion = b.accion === "pausar" ? "pausar_humano" : b.accion === "enviar" ? "enviar_humano" : accion;
    const jwt = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "") || null;
    llamadas.push({ ruta, accion, cuerpo: b, jwt, t: Date.now() });
    const rt = retrasos.find((x) => x.accion === accion && x.veces > 0);
    if (rt) { rt.veces -= 1; await esperar(rt.ms); }
    const f = fallos.find((x) => x.accion === accion && x.veces > 0);
    if (f) { f.veces -= 1; return salida(f.status, { error: "falla_inyectada" }); }
    const fn = acciones[accion];
    if (!fn) return salida(400, { error: "accion" });
    const r = fn(b, jwt);
    if (r && r.error) return salida(200, { ok: false, accion, error: r.error });
    if (TEXTO.has(accion)) return salida(200, { ok: true, accion, resultado: r });
    return salida(200, { ok: true, accion, ...(typeof r === "object" ? r : {}) });
  });
  return {
    url: `http://127.0.0.1:${srv.puerto}/edge`, llamadas, chats, wamids, escalaciones, resumenes, citas, cfg, estado, cierra: srv.cierra,
    falla(accion, status = 502, veces = Infinity) { fallos.push({ accion, status, veces }); },
    retrasa(accion, ms, veces = 1) { retrasos.push({ accion, ms, veces }); },
    quitaFallos() { fallos.length = 0; },
    de(accion) { return llamadas.filter((l) => l.accion === accion); },
    acciones() { return llamadas.map((l) => l.accion); },
    chat,
    consent: S12,            // S12: .envejece(tel, ms), .cs(chat)
  };
}

// ═══ GRAPH FALSO (API de WhatsApp) ═══
export async function creaGraphFalso() {
  const enviados = [], lecturas = [];
  let n = 0;
  const falla = { destinos: new Set(), tras: new Map() };   // tras: destino → nº de envíos que SÍ salen antes de empezar a fallar (S12)
  const salidos = new Map();
  const srv = await escucha(async (req, res) => {
    const crudo = await leeCuerpo(req);
    let b = {}; try { b = JSON.parse(crudo || "{}"); } catch { /* */ }
    res.setHeader("content-type", "application/json");
    if (b.status === "read") { lecturas.push(b); return res.end(JSON.stringify({ success: true })); }
    if (b.messaging_product === "whatsapp" && b.to) {
      const yaSalidos = salidos.get(String(b.to)) || 0;
      if (falla.tras.has(String(b.to)) && yaSalidos >= falla.tras.get(String(b.to))) { res.statusCode = 400; return res.end(JSON.stringify({ error: { message: "fallo inyectado", code: 100 } })); }
      salidos.set(String(b.to), yaSalidos + 1);
      if (falla.destinos.has(String(b.to))) { res.statusCode = 400; return res.end(JSON.stringify({ error: { message: "fallo inyectado", code: 100 } })); }
      const e = { to: String(b.to), type: b.type, texto: b.text && b.text.body, plantilla: b.template && b.template.name, params: b.template && b.template.components, id: `wamid.OUT${++n}`, t: Date.now() };
      enviados.push(e);
      return res.end(JSON.stringify({ messages: [{ id: e.id }] }));
    }
    res.statusCode = 404; res.end("{}");
  });
  return { base: `http://127.0.0.1:${srv.puerto}/graph`, enviados, lecturas, falla, cierra: srv.cierra, a(tel) { return enviados.filter((e) => e.to === String(tel)); } };
}

// ═══ ANTHROPIC FALSO (SSE) ═══
export async function creaAnthropicFalso() {
  const peticiones = [];
  const guion = [];                      // textos a devolver, en orden; si se acaba, el por defecto
  const estado = { retrasoMs: 0, falla: false, porDefecto: "Thanks for your message, happy to help. [INTENT:exploring]" };
  const srv = await escucha(async (req, res) => {
    const crudo = await leeCuerpo(req);
    let b = {}; try { b = JSON.parse(crudo || "{}"); } catch { /* */ }
    peticiones.push(b);
    if (estado.retrasoMs) await esperar(estado.retrasoMs);
    if (estado.falla) { res.writeHead(400, { "content-type": "application/json" }); return res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "fallo inyectado" } })); }
    const texto = guion.length ? guion.shift() : estado.porDefecto;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const ev = (t, d) => res.write(`event: ${t}\ndata: ${JSON.stringify(d)}\n\n`);
    ev("message_start", { type: "message_start", message: { id: "msg_f", type: "message", role: "assistant", model: b.model || "m", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: texto } });
    ev("content_block_stop", { type: "content_block_stop", index: 0 });
    ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
    ev("message_stop", { type: "message_stop" });
    res.end();
  });
  return { base: `http://127.0.0.1:${srv.puerto}`, peticiones, guion, estado, cierra: srv.cierra };
}

// ═══ webhook de Meta ═══
export const firma = (secreto, crudo) => "sha256=" + crypto.createHmac("sha256", secreto).update(crudo).digest("hex");
export const payloadTexto = (from, texto, id, extra = {}) => ({
  object: "whatsapp_business_account",
  entry: [{ changes: [{ field: "messages", value: { contacts: [{ profile: { name: extra.nombre || "Test Client" } }], messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: texto }, ...(extra.context ? { context: extra.context } : {}) }] } }] }],
});
export const payloadMedia = (from, tipo, id) => ({
  object: "whatsapp_business_account",
  entry: [{ changes: [{ field: "messages", value: { contacts: [{ profile: { name: "Test Client" } }], messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: tipo, [tipo]: { id: "9999" + id.length } }] } }] }],
});
export const payloadEco = (to, texto, id) => ({
  object: "whatsapp_business_account",
  entry: [{ changes: [{ field: "smb_message_echoes", value: { message_echoes: [{ to, id, type: "text", text: { body: texto } }] } }] }],
});
export const payloadEstado = (recipient, status, id, errores) => ({
  object: "whatsapp_business_account",
  entry: [{ changes: [{ field: "messages", value: { statuses: [{ recipient_id: recipient, id, status, ...(errores ? { errors: errores } : {}) }] } }] }],
});

// ═══ el bot de verdad, como proceso hijo ═══
export async function lanzaBot({ env = {}, graph, anthropic, edge, secretos, appSecret = "app-secret-de-prueba", modo = "supabase" }) {
  const puerto = await new Promise((ok) => { const s = http.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
  const e = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
    PORT: String(puerto), PROJECT_NAME: "LawangTest", WHATSAPP_TOKEN: "tok", WHATSAPP_PHONE_ID: "999", WHATSAPP_VERIFY_TOKEN: "verif",
    WHATSAPP_API_BASE: graph.base, ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_BASE_URL: anthropic.base,
    OWNER_PHONE: "6281100000000", CONTEXT_FILE: "context-lawang.md", PLAYBOOK_FILE: "playbook-lawang.json",
    HUMANIZE_CHUNKS: "off", ADMIN_PASSWORD: "admin-test", BOT_MODEL: "claude-test",
    BOT_STORE: modo, ...(modo === "supabase" || modo === "postgres" ? {
      BOT_API_URL: edge.url, BOT_API_SECRET_ESTADO: secretos.estado, BOT_API_SECRET_RECORDATORIO: secretos.recordatorio,
      BOT_TURNO_REINTENTOS_MS: "30,30", BOT_CIERRE_REINTENTOS_MS: "30,30,30", BOT_API_PAUSA_REINTENTO_MS: "20",
    } : {}),
    ...(appSecret ? { META_APP_SECRET: appSecret } : {}),
    ...env,
  };
  const hijo = spawn(process.execPath, ["index.js"], { cwd: RAIZ, env: e, stdio: ["ignore", "pipe", "pipe"] });
  const logs = [];
  hijo.stdout.on("data", (d) => logs.push(String(d)));
  hijo.stderr.on("data", (d) => logs.push(String(d)));
  let salio = null;
  hijo.on("exit", (c) => { salio = c === null ? "señal" : c; });      // terminado por una señal → c es null
  const base = `http://127.0.0.1:${puerto}`;
  const t0 = Date.now();
  for (;;) {
    if (salio !== null) throw new Error("el bot salió al arrancar (código " + salio + "):\n" + logs.join("").slice(-2000));
    try { const r = await fetch(base + "/health"); if (r.ok) break; } catch { /* aún no escucha */ }
    if (Date.now() - t0 > 20000) { hijo.kill(); throw new Error("el bot no arrancó en 20 s:\n" + logs.join("").slice(-2000)); }
    await esperar(100);
  }
  return {
    base, logs, hijo,
    texto: () => logs.join(""),
    async post(payload, { secreto = appSecret, cabecera, cuerpoCrudo } = {}) {
      const crudo = cuerpoCrudo ?? JSON.stringify(payload);
      const headers = { "content-type": "application/json" };
      if (cabecera !== null) headers["x-hub-signature-256"] = cabecera ?? firma(secreto || "x", crudo);
      const r = await fetch(base + "/webhook", { method: "POST", headers, body: crudo });
      return r.status;
    },
    async get(ruta, headers = {}) { const r = await fetch(base + ruta, { headers }); let j = null; try { j = await r.json(); } catch { /* */ } return { status: r.status, json: j }; },
    async enviaJson(ruta, cuerpo, headers = {}) {
      const r = await fetch(base + ruta, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(cuerpo) });
      let j = null; try { j = await r.json(); } catch { /* */ }
      return { status: r.status, json: j };
    },
    async para() {
      if (salio !== null) return;
      hijo.kill();
      for (let i = 0; i < 50 && salio === null; i++) await esperar(100);
      if (salio === null) hijo.kill("SIGKILL");
    },
  };
}

// Espera hasta que se cumpla la condición (o falla con el mensaje). Cada prueba usa esto en vez de dormir a ojo.
export async function hasta(cond, msg, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await cond()) return; await esperar(25); }
  throw new Error("no se cumplió a tiempo: " + msg);
}
