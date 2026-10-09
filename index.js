import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { google } from "googleapis";
import axios from "axios";
import fs from "fs";
import https from "https";
import Stripe from "stripe";
import crypto from "crypto";
import { inventario as inventarioRedis, importar as importarRedis } from "./import_redis.js"; // TEMPORAL (S5/LAW-507): se retira en S9
import { creaTransporte as creaTransporteImportar } from "./import_transporte.js"; // TEMPORAL (S5/LAW-507): se retira en S9
import { VACIA as CFG_VACIA, validaConfig, bloqueEquipo, ttlPausaHumana } from "./botcfg.js";
import {
  initRedis, bloqueaRedis, redisActivo, almacenNombre, lectorImportacion,
  getConversation, saveConversation, escPush, escPop, escMapGuardar, escRutaPorCita,
  getLead, leadGuardar, leadsListar, leadsContar, leadBorrar, getNotifiedLevel, setNotifiedLevel,
  setPaused, isPaused, setPausedHumano as setPausedHumanoStore, cfgRawLeer, cfgLogRaw, cfgGuardarConLog, incrTope,
  setWaiting, isWaiting, setInbound, getInbound,
  optOutPoner, optOutLeer, optOutAckLeer, optOutAckPoner,
  getFollowupCount, setFollowupCount, resetFollowup, setNotes, getNotes, setStatus, getStatus,
  cannedLeer, setCanned, apptTs, persistAppt, apptReindexar, listAppts, getAppt, apptBorrar, isReminded, setReminded,
  getMediaLib, setMediaLib, setBlob, getBlob, delBlob, setLastLink, getLastLink,
  setWaBlocked, getWaBlocked, clearWaBlocked, testNotifYaAvisado, alreadyProcessed,
  unsubAgregar, unsubLeer, getScheduled, setScheduled,
} from "./store/redis.js";
import { creaCatalogo, cifrasPermitidas, postCheckCifras } from "./botcat.js";
import { extraeEtiquetas, bloquesSistema, contenidoParaModelo, creaTopes, ejecutaCrm, avisoCita, adaptaCierreACita, isoConZona, citasIlegibles, pideTraspaso, ejecutaTraspaso, ACUSE_DERECHOS, notaDerechos, avisoDerechos, aplicaAviso, debeAvisar } from "./botcrm.js";

const app = express();
// verify: guarda el body crudo — la firma X-Hub-Signature-256 de Meta se calcula sobre los bytes
// exactos recibidos, no sobre el JSON re-serializado (re-serializar cambia el orden/espacios y rompe el HMAC).
app.use(express.json({ limit: "30mb", verify: (req, _res, buf) => { req.rawBody = buf; } })); // 30mb: un vídeo de 16MB en base64 ocupa ~21.3MB; con 20mb el upload del panel fallaba en el parser

// ─── CONFIGURACIÓN (variables de entorno — distintas por proyecto) ──
const {
  PROJECT_NAME,
  WHATSAPP_TOKEN,
  WHATSAPP_PHONE_ID,
  WHATSAPP_VERIFY_TOKEN,
  META_APP_SECRET,         // App Secret de la app de Meta — activa la verificación X-Hub-Signature-256 de los POST del webhook
  ANTHROPIC_API_KEY,
  GOOGLE_SERVICE_ACCOUNT,
  SHEET_ID,
  OWNER_PHONE,
  BOT_CONTEXT,
  BOT_MODEL,
  BOT_VERTICAL,            // "tour" (default) o "rental" — selecciona el bloque de cierre en BASE_INSTRUCTIONS
  HUMAN_ONLY,              // "1"/"true": el bot nunca genera respuesta con IA, todo lead entra pausado desde el primer mensaje y se avisa al OWNER_PHONE una vez por lead nuevo. Para bots que arrancan sin persona todavía.
  WHATSAPP_WABA_ID,        // id de la WhatsApp Business Account — solo para LISTAR plantillas aprobadas (/admin/api/templates). Sin él ese endpoint avisa en vez de fallar.
  BOT_ALLOWLIST,           // modo testing: lista de teléfonos (coma) que SÍ hablan con el bot. El resto entra pausado. Ver MODO TESTING abajo.
  BOT_MODE,                // "testing" fuerza el modo aunque BOT_ALLOWLIST venga vacía (deniega a todos). Cualquier otro valor no activa nada.
  BOT_PERSONA_NAME,        // nombre de la persona del bot (default "Daniel" = B2K); BBM debe definir el suyo
  OPENAI_API_KEY,          // opcional: activa la transcripción de notas de voz (Whisper); sin ella se pide el texto
  CONTEXT_FILE,            // nombre del archivo de contexto a cargar del repo (default "context.md")
  PANEL_FILE,              // nombre del archivo del panel /admin a cargar del repo (default "panel.html")
  REDIS_URL,
  STRIPE_SECRET_KEY,
  STRIPE_SUCCESS_URL,
  STRIPE_CANCEL_URL,
  ADMIN_PASSWORD,
  ALERT_TEMPLATE_NAME,
  ALERT_TEMPLATE_LANG,
  ALERT_TEMPLATE_VARS,
  CALENDAR_ID,
  CALENDAR_TZ,
  REMINDER_LEAD_MIN,
  REMINDER_TEMPLATE_NAME,
  REMINDER_TEMPLATE_LANG,
  FOLLOWUP_TEMPLATE_NAME,
  FOLLOWUP_TEMPLATE_LANG,
  FOLLOWUP_MAX,
  FOLLOWUP_SCHEDULE,
  FOLLOWUP_TEMPLATE_VARS,
  INTRO_TEMPLATE_NAME,
  INTRO_TEMPLATE_LANG,
  INTRO_TEMPLATE_VARS,
  CRM_SHEET_SYNC,
  BREVO_API_KEY,           // newsletter por email (proveedor Brevo). Sin esto, el envío está desactivado.
  MAIL_FROM,               // "Bali Moto Adventures <newsletter@balimotoadventures.com>" (dominio verificado en Brevo)
  MAIL_REPLY_TO,           // opcional: a dónde llegan las respuestas
  MAIL_COMPANY,            // pie legal del email (nombre + dirección física — obligatorio anti-spam)
  MAIL_UNSUB_SECRET,       // firma los links de baja; si falta, se usa ADMIN_PASSWORD como respaldo
  MAIL_LOGO,               // (opcional) URL del logo para la cabecera del email; si no, se usa el nombre en texto
} = process.env;

// Base de la API de Meta. SOLO las pruebas locales la apuntan a un servidor falso (http://127.0.0.1:…); cualquier otro valor se ignora,
// así que ni un descuido de configuración ni un atacante con acceso a las variables puede desviar el token de WhatsApp a otro host.
const GRAPH_BASE = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(process.env.WHATSAPP_API_BASE || "")
  ? String(process.env.WHATSAPP_API_BASE).replace(/\/+$/, "")
  : "https://graph.facebook.com/v21.0";

// La BD del CRM es Redis (lead:phone + leads_index). El Google Sheet era un espejo
// heredado y queda DESACTIVADO salvo que se ponga CRM_SHEET_SYNC=1 en Railway.
// Una sola condición para las 3 puertas (saveLead / writeLeadToSheet / log de arranque):
// con SHEET_SYNC=1 y GOOGLE_SERVICE_ACCOUNT vacío, saveLead entraba igual y reventaba en
// JSON.parse("") una vez por mensaje ("Error guardando lead — HTTP ?: Unexpected end of JSON
// input", visto en producción de BBM el 23-jul) mientras el arranque decía "desactivado".
const SHEET_SYNC = (CRM_SHEET_SYNC === "1" || CRM_SHEET_SYNC === "true") && !!SHEET_ID && !!GOOGLE_SERVICE_ACCOUNT;

// HUMAN_ONLY: ningún lead llega a la IA. Se reusa la puerta isPaused ya existente
// (control humano por lead) forzándola true para todos — así el resto del motor
// (panel, "por responder", CRM) no cambia. Lo que sí hay que añadir aparte es el
// aviso al owner: la puerta de pausa asume que un humano YA está mirando esa
// conversación (la pausó él a mano); en HUMAN_ONLY nadie la está mirando todavía.
const HUMAN_ONLY_MODE = HUMAN_ONLY === "1" || HUMAN_ONLY === "true";

// ─── MODO TESTING (BOT_ALLOWLIST / BOT_MODE) ───────────────────────────────────
// Para estrenar un bot sobre un número que YA recibe leads reales: solo los teléfonos
// de la lista hablan con el bot; cualquier otro entra por la puerta de pausa que ya
// existe (se guarda, se marca "esperando humano", se avisa al owner). Nace el 11-sep-2026
// para Lawang, cuya campaña de Australia manda leads reales al número de pruebas.
//
//   BOT_ALLOWLIST puesta (≥1 número válido)  → modo testing ON, solo esos números
//   BOT_MODE=testing + lista vacía/ilegible  → modo testing ON, DENIEGA A TODOS
//   las dos ausentes                         → comportamiento de siempre (bot abierto)
//
// Por qué "las dos ausentes = abierto" y no al revés: este motor es compartido. Si el
// default fuese "cerrado", el día que esto se fusione a `main` y llegue a las ramas
// `b2k`/`balibest` dejaría mudos a dos bots en producción sin que nadie tocara nada.
// La propiedad que sí queremos de fail-closed —que una errata no abra la puerta— se
// consigue denegando cuando la lista está puesta pero no parsea. Para abrir el bot
// hacen falta DOS variables desaparecidas a la vez, no un despiste.
//
// ⚠️ Salir de testing es un acto explícito del owner (borrar las dos variables), no un
// efecto colateral de un redeploy. Y el estado se publica en el arranque y en
// /admin/api/health: un freno mudo es la forma exacta del fallo de LAW-106.
const ALLOWLIST = new Set(
  String(BOT_ALLOWLIST || "")
    .split(",")
    .map((s) => normalizePhone(s))
    .filter((s) => s.length >= 8)   // descarta vacíos y restos de formato
);
// Entradas escritas en formato local (0811…) NO se adivinan: WhatsApp siempre entrega el
// número en internacional, así que un "0" inicial nunca casaría y el tester se pasaría la
// tarde depurando un bot sano. Se avisa fuerte en el arranque y esa entrada no cuenta.
const ALLOWLIST_BAD = String(BOT_ALLOWLIST || "")
  .split(",")
  .map((s) => normalizePhone(s))
  .filter((s) => s.length >= 8 && s.startsWith("0")).length;
const TESTING_MODE = ALLOWLIST.size > 0 || String(BOT_MODE || "").toLowerCase() === "testing";

// Comparación EXACTA sobre los dígitos. Nada de "últimos 9" (lo que hace isOwner): dos
// móviles de países distintos pueden compartir los últimos 9 dígitos, y ahí el fallo es
// fail-open — un lead real colándose hasta la IA. El owner siempre pasa: es quien prueba
// y quien recibe los avisos.
function isAllowed(phone) {
  if (!TESTING_MODE) return true;
  if (isOwner(phone)) return true;
  return ALLOWLIST.has(normalizePhone(phone));
}

const stripeClient = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

// maxRetries alto + timeout holgado: la red de Railway a api.anthropic.com a veces
// corta la conexión ("Premature close"); el SDK reintenta los errores de conexión.
// httpAgent con keepAlive:false → conexión nueva por request; evita reutilizar un socket
// keep-alive que Anthropic ya cerró (causa raíz del "Premature close" con tráfico espaciado).
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY, maxRetries: 4, timeout: 60000, httpAgent: new https.Agent({ keepAlive: false }) });

// Llama a Claude con reintentos propios. El "Premature close" ocurre al reutilizar un
// socket keep-alive que Anthropic ya cerró (frecuente con tráfico espaciado de test) y
// el SDK NO lo reintenta; reintentar aquí fuerza una conexión nueva.
async function claudeMessage(params, tries = 3) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      return await anthropic.messages.stream(params).finalMessage();
    } catch (e) {
      lastErr = e;
      console.warn(`[${PROJECT_NAME}] Claude intento ${i}/${tries} falló: ${e.message}`);
      if (i < tries) await new Promise((r) => setTimeout(r, 500 * i));
    }
  }
  throw lastErr;
}
const MODEL = BOT_MODEL || "claude-sonnet-5";
const PERSONA_NAME = BOT_PERSONA_NAME || "Daniel"; // default = persona de B2K (retrocompatible)

const contextFileName = CONTEXT_FILE || "context.md";
const CONTEXT = fs.existsSync(contextFileName)
  ? fs.readFileSync(contextFileName, "utf8")
  : BOT_CONTEXT;

// ─── ALMACÉN: BOT_STORE=redis (por defecto) | postgres (S4b del encargo 20261009_lawang_bot_sin_redis) ──────────
// redis: el bot de siempre, sin ningún cambio de comportamiento. postgres: el estado vive en Postgres de Lawang a través de la edge `bot-api`;
// el módulo de Redis queda BLOQUEADO (cualquier acceso lanza) y el webhook es el de turno-pg.js. Un valor desconocido NO abre nada nuevo: cae a redis, gritando.
const BOT_STORE_RAW = String(process.env.BOT_STORE || "redis").trim().toLowerCase();
if (!["redis", "postgres"].includes(BOT_STORE_RAW)) console.error(`[${PROJECT_NAME}] BOT_STORE="${BOT_STORE_RAW}" no es válido (redis | postgres): se usa redis`);
const STORE_PG = BOT_STORE_RAW === "postgres";
const turnoMod = STORE_PG ? await import("./turno-pg.js") : null;     // en modo redis estos módulos ni se cargan
const autorizaciones = STORE_PG ? turnoMod.creaAutorizaciones({ esOwner: (t) => esOwnerExacto(t) }) : null;

// ─── REDIS ────────────────────────────────────────────────────────
// Todo el acceso a Redis (y la memoria de respaldo sin Redis) vive en store/redis.js; aquí solo se conecta.
if (STORE_PG) bloqueaRedis();
else await initRedis({ url: REDIS_URL, projectName: PROJECT_NAME });


// ─── ÍNDICE DE LEADS (para el panel web) ──────────────────────────

async function recordLead(phone, name, intent, lastMessage, lastBy) {
  const prev = (await getLead(phone)) || {};
  const info = {
    ...prev,                                  // conserva email/package/travelDate/riders… ya capturados
    phone,
    name: name || prev.name || "",
    intent: intent || prev.intent || "exploring",
    lastMessage: (lastMessage || "").slice(0, 200),
    lastBy: lastBy || prev.lastBy || "client", // quién mandó el último mensaje (client|bot|human) → preview del panel
    updatedAt: Date.now(),
  };
  if (!info.createdAt) {                       // primera vez que vemos este lead → fecha de alta + evento
    info.createdAt = info.updatedAt;
    info.history = (Array.isArray(prev.history) ? prev.history : []).concat([{ ts: info.createdAt, type: "created" }]);
  }
  await leadGuardar(phone, info, info.updatedAt);
}

async function listLeads() {
  const list = await leadsListar();
  if (list === null) return []; // índice vacío
  const unsub = await getUnsubSet(); // para marcar quién está dado de baja del newsletter
  return Promise.all(list.map(async (l) => {
    const inbound = await getInbound(l.phone);
    const v = ventanaDe(inbound);
    return {
    ...l,
    lastInboundAt: inbound,
    /* La ventana la resuelve el servidor y viaja ya resuelta: el navegador solo pinta.
       `ventanaExpira` va en epoch para que la interfaz pueda decir cuánto queda sin
       volver a calcular nada por su cuenta. */
    ventanaAbierta: v.abierta,
    ventanaExpira: v.expira,
    optOut: await getOptOut(l.phone),
    paused: await isPaused(l.phone),
    /* `gated`: el modo testing está frenando a ESTE lead. Va aparte de `paused` porque
       no es lo mismo —nadie lo pausó a mano— y porque sin él el panel MIENTE: el freno
       se calcula en cada mensaje (`TESTING_MODE && !isAllowed(from)`) y no se guarda en
       ningún sitio, así que un lead real al que el bot jamás va a contestar se listaba
       como `paused:false` y la pestaña lo pintaba «IA activa». Quien mira el panel tiene
       que poder saber que esa conversación está muerta. */
    gated: TESTING_MODE && !isAllowed(l.phone),
    waiting: await isWaiting(l.phone),
    notes: await getNotes(l.phone),
    status: await getStatus(l.phone),
    followups: await getFollowupCount(l.phone),
    emailUnsub: !!(l.email && unsub.has(String(l.email).toLowerCase().trim())),
    };
  }));
}

// Nivel de aviso ya enviado al owner para ese lead (anti-spam).
// Orden: exploring < interested < booking
const NOTIFY_RANK = { interested: 1, booking: 2 };


// ─── PAUSA DEL BOT POR LEAD (control humano / takeover desde el panel) ──

// ─── CONFIGURACIÓN EDITABLE DESDE EL CRM (botcfg:v1) ──
// Instrucciones extra, saludo de bienvenida y horas de pausa. Se lee con caché de 10 s y, si Redis
// falla, se devuelve la ÚLTIMA buena (no la vacía: un parpadeo de Redis no puede quitarle al bot sus
// instrucciones). Clave ausente = config vacía = el bot de siempre. `config_set` guarda en
// `botcfg:log` (últimos 50) quién, cuándo y el valor anterior, para poder volver atrás.
let _cfgCache = { v: { ...CFG_VACIA }, ts: 0 };
async function getBotCfg(force = false) {
  if (!force && Date.now() - _cfgCache.ts < 10000) return _cfgCache.v;
  if (!redisActivo()) return _cfgCache.v;
  try {
    const raw = await cfgRawLeer();
    _cfgCache = { v: raw ? { ...CFG_VACIA, ...JSON.parse(raw) } : { ...CFG_VACIA }, ts: Date.now() };
  } catch (e) {
    _cfgCache.ts = Date.now(); // sin esto cada mensaje reintentaría Redis y escribiría este log mientras dure el fallo
    console.error(`[${PROJECT_NAME}] botcfg: no se pudo leer la config, uso la última buena: ${e.message}`);
  }
  return _cfgCache.v;
}

// ─── CATÁLOGO EN VIVO Y CRM DEL ERP (S6 del encargo 20261008_lawang_bot_catalogo_crm) ──
// Dos interruptores, APAGADOS por defecto: con los dos apagados el `system`, los mensajes y las respuestas son
// idénticos a los de siempre (lo fija test-botcat.js). Otras ramas del motor no los ponen y no notan nada.
//   BOT_CATALOGO = off | on        on: bloque de catálogo en el system (lee la edge bot-api, ruta /catalogo)
//   BOT_CRM      = off | sombra | on   sombra: solo escribe el log de lo que haría; on: llama a la edge (ruta /crm)
//   BOT_API_URL  = https://<ref>.supabase.co/functions/v1/bot-api        (sin barra final)
//   BOT_API_SECRET_CATALOGO / BOT_API_SECRET_CRM = un secreto por ruta (cabecera X-Bot-Secret)
// Valor desconocido = off. `on` sin URL o sin su secreto: el catálogo se ve "no disponible" (no cita precios) y el
// CRM no escribe; ambos gritan en el arranque, nunca rompen la conversación.
const _modo = (v, validos) => { const x = String(v || "").trim().toLowerCase(); return validos.includes(x) ? x : "off"; };
const BOT_CATALOGO_MODE = _modo(process.env.BOT_CATALOGO, ["off", "on"]);
const BOT_CRM_MODE = _modo(process.env.BOT_CRM, ["off", "sombra", "on"]);
const BOT_API_URL = String(process.env.BOT_API_URL || "").trim().replace(/\/+$/, "");
const BOT_API_SECRET_CATALOGO = String(process.env.BOT_API_SECRET_CATALOGO || "").trim();
const BOT_API_SECRET_CRM = String(process.env.BOT_API_SECRET_CRM || "").trim();
const CRM_EFECTIVO = BOT_CRM_MODE === "on" && (!BOT_API_URL || !BOT_API_SECRET_CRM) ? "off" : BOT_CRM_MODE;
console.log(`[${PROJECT_NAME}] catálogo=${BOT_CATALOGO_MODE} crm=${BOT_CRM_MODE}${CRM_EFECTIVO !== BOT_CRM_MODE ? " (EFECTIVO off: falta BOT_API_URL o BOT_API_SECRET_CRM)" : ""}`);
if (BOT_CATALOGO_MODE === "on" && (!BOT_API_URL || !BOT_API_SECRET_CATALOGO)) console.error(`[${PROJECT_NAME}] BOT_CATALOGO=on pero falta BOT_API_URL o BOT_API_SECRET_CATALOGO: el bot verá "catálogo no disponible" y no citará precios`);

async function _llamaEdge(ruta, secreto, cuerpo) {
  const r = await axios.post(`${BOT_API_URL}/${ruta}`, cuerpo, {
    headers: { "X-Bot-Secret": secreto, "content-type": "application/json" },
    timeout: 5000, validateStatus: () => true, maxContentLength: 1024 * 1024,
  });
  if (r.status !== 200 || !r.data || r.data.ok !== true) throw new Error(`bot-api/${ruta} HTTP ${r.status}`); // sin cuerpo: no se vuelca nada ajeno al log
  return r.data;
}

const catalogoSvc = BOT_CATALOGO_MODE === "on"
  ? creaCatalogo({
      tz: CALENDAR_TZ || "Asia/Makassar",
      log: (m) => console.error(`[${PROJECT_NAME}] ${m}`),
      pide: async () => {
        if (!BOT_API_URL || !BOT_API_SECRET_CATALOGO) throw new Error("sin URL o secreto");
        return (await _llamaEdge("catalogo", BOT_API_SECRET_CATALOGO, {})).unidades;
      },
    })
  : null;

// Bloque de catálogo para el system de ESTE turno ({texto, unidades, estado}) o null con el interruptor apagado.
async function getCatalogoBlock() {
  if (!catalogoSvc) return null;
  try { return await catalogoSvc.bloque(); }
  catch (e) { console.error(`[${PROJECT_NAME}] catálogo: error inesperado (${e.message})`); return null; }
}

// Los bloques `system` de catálogo y CRM, en su sitio (tras el prefijo cacheado, antes de la fecha). Sin interruptores = [].
const bloquesCatalogoCrm = (cat) => bloquesSistema({ catalogo: BOT_CATALOGO_MODE, crm: BOT_CRM_MODE, cat });

// Solo LOG (medida legal: no se recorta a bloqueo sin que Legal vea los casos de la semana de solo log).
function postCheckPrecios(reply, cat, history, from) {
  if (!catalogoSvc) return;
  try {
    const delCliente = history.filter((m) => m.role === "user").slice(-6).map((m) => m.content).join(" | ");
    const raras = postCheckCifras({ respuesta: reply, permitidas: cat ? cifrasPermitidas(cat.unidades) : [], delCliente });
    if (raras.length) console.warn(`[${PROJECT_NAME}] [CATALOGO] POST-CHECK: cifra(s) fuera del bloque (${cat ? cat.estado : "sin bloque"}) para …${String(from).slice(-4)}: ${raras.map((c) => c.texto + (c.eco ? " [eco_cliente]" : "")).join(" | ")}`);
  } catch (e) { console.error(`[${PROJECT_NAME}] post-check falló: ${e.message}`); }
}

// El texto del cliente que ve el modelo: con el CRM activo se sanean las `[XXX:`; apagado = tal cual.
const paraModelo = (m) => contenidoParaModelo(m, BOT_CRM_MODE);

const topesCrm = creaTopes({
  incr: async (k) => {
    return incrTope(k);
  },
});

// Ejecuta las etiquetas [NOTA]/[CITA] de la respuesta SOBRE EL TELÉFONO DEL WEBHOOK. Nunca lanza.
async function aplicaCrm(tags, from, msgId, nombre) {
  if (CRM_EFECTIVO === "off" || !tags) return;
  const tel = normalizePhone(from);
  const hechos = await ejecutaCrm({
    modo: CRM_EFECTIVO, tel: normalizePhone(from), msgId, nombre, notas: tags.notas, citas: tags.citas, topes: topesCrm,
    log: (m) => console.log(`[${PROJECT_NAME}] ${m}`),
    llama: async (accion, cuerpo) => (await _llamaEdge("crm", BOT_API_SECRET_CRM, cuerpo)).resultado,
  });
  // Cada cita etiquetada llega al owner, se guardara o no: el cliente ya ha oido «queda agendada». Sin esto, una cita rechazada (fuera de horario,
  // lead ambiguo, base caída…) sería un fallo mudo. Nunca rompe la conversación.
  for (const h of hechos || []) {
    if (h.accion !== "lead_cita") continue;
    try {
      if ((h.resultado === "propuesta" || h.resultado === "reprogramada") && h.cuando) {
        // La ficha del chat (panel «Setter IA») pinta las citas del historial de la conversación: se deja la marca ahí, que NO es la cita (esa vive en la base).
        const iso = isoConZona(h.cuando, h.zona);
        if (iso) logEvent(tel, "appt", { title: h.tipo === "visita" ? "Visita" : "Llamada", when: iso });
      }
      const texto = avisoCita({ proyecto: PROJECT_NAME, nombre, tel, hecho: h });
      if (texto && OWNER_PHONE) await sendWhatsApp(OWNER_PHONE, texto);
    } catch (e) { console.error(`[${PROJECT_NAME}] aviso de cita al owner falló: ${e.message}`); }
  }
}

// "Una persona tomó el mando" (escribió desde la app o desde el panel): pausa con la caducidad
// configurada (0 = no caduca). Una pausa manual sin caducidad no se vuelve caducable por esto, y
// cada nuevo mensaje de la persona renueva el plazo. El interruptor del panel y la baja NO pasan por aquí.
async function setPausedHumano(phone) {
  const cfg = await getBotCfg();
  return setPausedHumanoStore(phone, cfg.pausaHoras);
}

// ─── "POR RESPONDER" (el cliente escribió y nadie le ha contestado) ──
// Se enciende cuando llega un mensaje del cliente con el bot en pausa (control humano)
// y se apaga cuando el bot responde solo o cuando el estudio responde a mano.

// ─── ÚLTIMO MENSAJE ENTRANTE (ventana de 24h de WhatsApp) ───────────
// Marca cuándo escribió el cliente por última vez; el panel calcula si la ventana sigue abierta.

/* ─── BAJA DEL LEAD (STOP) ────────────────────────────────────────────────────────
   Si alguien pide no recibir más mensajes, el bloqueo tiene que estar en el CAMINO DE
   ENVÍO, no en la disciplina de quien escribe. Y SIN TTL, al revés que el resto de
   claves del bot: una baja no caduca a los 30 días.
   No es solo cortesía — si los leads marcan como spam, Meta degrada la calidad del
   número y se acaba sin poder escribir a nadie. La baja protege el canal. */
/* (9-oct-2026: además de lo anclado al principio, hay frases claras de baja/borrado en cualquier sitio; ver el comentario de la constante.)
   Anclado al PRINCIPIO del mensaje a propósito: "¿dónde está el bus stop?" no es una
   baja. Y `cancelar` NO está en la lista aunque parezca obvia — en español quien escribe
   "cancelar" casi siempre quiere anular una cita, no dejar de recibir mensajes, y dar de
   baja en silencio a un lead caliente por esa confusión es de los errores más caros que
   puede cometer este bot. Las que sí están son las que WhatsApp y el uso han hecho
   inequívocas. */
// Baja / oposicion / borrado. Antes solo cortaba lo que EMPEZABA por la palabra; ahora tambien las frases claras («please stop messaging me», «no me escribas mas», «delete my data»,
// «borra mis datos», «hentikan»...). Cuidado con lo que NO debe cortar: «can we stop by tomorrow», «don't call me before 10, write me here», «no me llames, escribeme» (preferencia de canal).
// Va en UNA linea de literal: la bateria S8 (test-bateria-adversaria.js) la extrae del fuente.
// (9-oct-2026, batería S8 con Haiku: «please don't contact me anymore, thanks» no cortaba porque la frase no cerraba el mensaje; ahora una cortesía final —thanks, gracias, terima kasih— no impide la baja.)
const PALABRAS_BAJA = /^\s*(stop|baja|darme\s+de\s+baja|unsubscribe|berhenti|no\s+more(\s+(messages?|texts?|mensajes))?|remove\s+me(\s+from\s+(the|your|this)\s+(list|group|system))?|opt[ -]?out)(\s+(all|todo))?(\s+(please|pls|plz|por\s+favor|tolong|ya|now|already|asap))?(?:[\s,.!]+(?:thanks|thank\s+you|thx|gracias|terima\s+kasih|makasih))?[\s.!]*$|^\s*(please|pls|plz|por\s+favor|tolong)\s+(stop|para|basta)(?:[\s,.!]+(?:thanks|thank\s+you|thx|gracias|terima\s+kasih|makasih))?[\s.!]*$|^\s*(tolong\s+)?hentikan\b|\b(stop|quit)\s+(messaging|texting|contacting|writing\s+to|sending|emailing|bothering|spamming)\s+(me|us)(\s+(please|pls|plz|por\s+favor|tolong|ya|now|already|asap))?(?:[\s,.!]+(?:thanks|thank\s+you|thx|gracias|terima\s+kasih|makasih))?[\s.!]*$|\b(don['’]?t|do\s+not|never)\s+(contact|message|text|write\s+to|email)\s+(me|us)(\s+(anymore|any\s+more|again|ever|at\s+all))?(\s+(please|pls|plz|por\s+favor|tolong|ya|now|already|asap))?(?:[\s,.!]+(?:thanks|thank\s+you|thx|gracias|terima\s+kasih|makasih))?[\s.!]*$|\b(i\s+want\s+to|i\s+wish\s+to|please|pls)\s+(unsubscribe|opt[ -]?out)(?:[\s,.!]+(?:thanks|thank\s+you|thx|gracias|terima\s+kasih|makasih))?[\s.!]*$|\bunsubscribe\b|\bopt\s+me\s+out\b|\b(delete|erase|remove|wipe)\s+(all\s+)?(of\s+)?(my|our)\s+(personal\s+)?(data|information|details|phone\s+number|number|chat|messages|conversation|history)(\s+from\s+(your|the)\s+(list|system|records|database))?(\s+(please|pls|plz|por\s+favor|tolong|ya|now|already|asap))?(?:[\s,.!]+(?:thanks|thank\s+you|thx|gracias|terima\s+kasih|makasih))?[\s.!]*$|\bno\s+me\s+(escribas|escriban|contactes|contacten|molestes|molesten|mandes|manden|envíes|envíen)(\s+(más|mas|nunca|otra\s+vez|de\s+nuevo))?(\s+(please|pls|plz|por\s+favor|tolong|ya|now|already|asap))?(?:[\s,.!]+(?:thanks|thank\s+you|thx|gracias|terima\s+kasih|makasih))?[\s.!]*$|\bdeja(d|r)?\s+de\s+(escribirme|contactarme|molestarme|enviarme\s+mensajes)(\s+(please|pls|plz|por\s+favor|tolong|ya|now|already|asap))?(?:[\s,.!]+(?:thanks|thank\s+you|thx|gracias|terima\s+kasih|makasih))?[\s.!]*$|\bno\s+quiero\s+(recibir\s+)?(más|mas)\s+mensajes(\s+(please|pls|plz|por\s+favor|tolong|ya|now|already|asap))?(?:[\s,.!]+(?:thanks|thank\s+you|thx|gracias|terima\s+kasih|makasih))?[\s.!]*$|\b(borra|borrar|borrad|borren|elimina|eliminar|eliminad|eliminen|suprime|suprimir)\s+(todos\s+)?(mis|mi)\s+(datos|información|informacion|número|numero|chat|conversación|conversacion)(\s+(please|pls|plz|por\s+favor|tolong|ya|now|already|asap))?(?:[\s,.!]+(?:thanks|thank\s+you|thx|gracias|terima\s+kasih|makasih))?[\s.!]*$|\b(darme|darnos)\s+de\s+baja\b|\bjangan\s+(hubungi|ganggu)\s+(saya|aku)(\s+lagi)?(\s+(please|pls|plz|por\s+favor|tolong|ya|now|already|asap))?(?:[\s,.!]+(?:thanks|thank\s+you|thx|gracias|terima\s+kasih|makasih))?[\s.!]*$|\bjangan\s+kirim\s+(pesan|chat)\s+(lagi|ke\s+saya)(\s+(please|pls|plz|por\s+favor|tolong|ya|now|already|asap))?(?:[\s,.!]+(?:thanks|thank\s+you|thx|gracias|terima\s+kasih|makasih))?[\s.!]*$|\bhapus(kan)?\s+(semua\s+)?data\s+(saya|aku)(\s+(please|pls|plz|por\s+favor|tolong|ya|now|already|asap))?(?:[\s,.!]+(?:thanks|thank\s+you|thx|gracias|terima\s+kasih|makasih))?[\s.!]*$/i;
async function setOptOut(phone) {
  const p = normalizePhone(phone);
  await optOutPoner(p);
  console.log(`[${PROJECT_NAME}] 🚫 ${p} pidió la baja (STOP) — no se le enviará nada más`);
}
async function getOptOut(phone) {
  const p = normalizePhone(phone);
  return optOutLeer(p);
}
// Acuse de la baja: una sola vez. Si alguien manda "STOP" tres veces seguidas no se le
// contesta tres veces — eso es justo el ruido del que se está intentando salir.
async function getOptOutAck(phone) {
  const p = normalizePhone(phone);
  return optOutAckLeer(p);
}
async function setOptOutAck(phone) {
  const p = normalizePhone(phone);
  await optOutAckPoner(p);
}

/* La ventana de 24h de WhatsApp, calculada SIEMPRE en el servidor. En el navegador no
   se puede: no hay contra qué corregir un reloj desfasado, y un portátil 3h adelantado
   daría por cerrada una ventana abierta (o al revés, ofrecería texto libre que rebota).
   `lastInboundAt` ausente ⇒ cerrada, explícitamente: un lead de formulario que nunca
   escribió no tiene ventana, y la clave `inbound:` caduca a los 30 días. */
const VENTANA_MS = 24 * 60 * 60 * 1000;
function ventanaDe(lastInboundAt) {
  if (!lastInboundAt) return { abierta: false, expira: null, motivo: "nunca_escribio" };
  const expira = lastInboundAt + VENTANA_MS;
  return { abierta: Date.now() < expira, expira, motivo: null };
}

// ─── SEGUIMIENTO AUTOMÁTICO TRAS 24h (re-enganche de ventas) ────────
// Cuenta cuántas plantillas de follow-up se han mandado en la racha "fría" actual.
// Se reinicia en cuanto el cliente responde (vuelve a abrir la ventana de 24h).

// ─── CRM MANUAL DESDE EL PANEL: notas, estado de pipeline, campos editables ──
// Fusiona campos extra (country/email/tour/travelDate/name) sobre el lead del índice.
async function updateLeadFields(phone, fields) {
  const prev = (await getLead(phone)) || { phone, intent: "interested", lastMessage: "", updatedAt: Date.now() };
  const info = { ...prev, ...fields, phone };
  await leadGuardar(phone, info, info.updatedAt || Date.now());
  return info;
}

// ─── EXTRACCIÓN AUTOMÁTICA DE DATOS DEL LEAD ──────────────────────
// Llaves "importantes" que guardamos en la ficha/BD del lead.
const LEAD_KEYMAP = {
  name: "name", email: "email", country: "country", tour: "tour",
  package: "package", pkg: "package", paquete: "package",
  riders: "riders", pillions: "pillions",
  dates: "travelDate", date: "travelDate", traveldate: "travelDate", travel: "travelDate",
  tags: "tags", tag: "tags",
  followup: "nextFollowUp", nextfollowup: "nextFollowUp", followupdate: "nextFollowUp",
  // BOT_VERTICAL=rental (ver RENTAL_CLOSE_AND_TAGGING) — llaves que solo emite el vertical de alquiler.
  model: "model",
  plan: "plan",
  start_date: "startDate", startdate: "startDate",
  end_date: "endDate", enddate: "endDate", return_date: "endDate", returndate: "endDate",
  delivery_location: "deliveryLocation", deliverylocation: "deliveryLocation", delivery: "deliveryLocation",
  insurance_tier: "insuranceTier", insurancetier: "insuranceTier", insurance: "insuranceTier",
  payment_method: "paymentMethod", paymentmethod: "paymentMethod", payment: "paymentMethod",
  value: "dealValue", dealvalue: "dealValue", // precio total cotizado → métrica de ingresos del panel
};

// 1) El formulario de Instagram llega como el PRIMER mensaje de WhatsApp (texto plano).
//    Lo parseamos para rellenar nombre/email/paquete en la ficha sin intervención.
function parseLeadForm(text) {
  if (!text) return null;
  if (!/which package|full name|whatsapp number|filled out (your|the) form/i.test(text)) return null;
  const grab = (re) => { const m = text.match(re); return m ? m[1].trim() : null; };
  const fields = {};
  const name = grab(/full name:\s*([^\n]+)/i);
  const email = grab(/email:\s*([^\n\s]+@[^\n\s]+)/i);
  const pkg = grab(/which package[^:]*:\s*([^\n]+)/i);
  if (name) fields.name = name.replace(/\s+/g, " ").trim();
  if (email) fields.email = email.toLowerCase();
  if (pkg) fields.package = pkg.replace(/\s+/g, " ").trim();
  return Object.keys(fields).length ? fields : null;
}

// 2) El bot emite un tag silencioso [LEAD k=v; k=v] al confirmar datos en la charla.
function parseLeadTag(reply) {
  const m = reply.match(/\[LEAD\s+([^\]]+)\]/i);
  if (!m) return null;
  const out = {};
  m[1].split(";").forEach((pair) => {
    const i = pair.indexOf("=");
    if (i < 0) return;
    const k = LEAD_KEYMAP[pair.slice(0, i).trim().toLowerCase()];
    let v = pair.slice(i + 1).trim();
    if (!k || !v || /^(unknown|n\/?a|tbd|\?+)$/i.test(v)) return;
    if (k === "riders" || k === "pillions") { const n = parseInt(v, 10); if (!isNaN(n)) out[k] = n; }
    else if (k === "dealValue") { const n = parseInt(v.replace(/\D/g, ""), 10); if (!isNaN(n) && n > 0) out[k] = n; } // acepta "2,450,000 IDR" → 2450000
    else if (k === "tags") { out.tags = (out.tags || []).concat(v.split(",").map((s) => s.trim()).filter(Boolean)); }
    else out[k] = v.slice(0, 120);
  });
  return Object.keys(out).length ? out : null;
}

// Cada deal (moto/tour cotizado) es un registro propio con id + status ('open'|'won'|'lost')
// dentro de lead.deals[] — así dos consultas concurrentes con identidad distinta (dos motos,
// dos tours) conviven sin pisarse (bug real reportado 15-jul: un booking ya cerrado
// desaparecía de la ficha al preguntar por otra moto). Los campos de nivel-lead (name/email/
// tags/notes/owner) siguen siendo únicos por lead; solo los de DEAL_FIELDS se reparten entre
// los deals[] abiertos. Los campos de nivel-lead SIGUEN reflejando un "mirror" del deal
// enfocado (el abierto más reciente) para no romper tabla/dashboard/Sheets, que leen l.model
// etc. directamente — mirrorOf()/focusDeal() son la única fuente de ese mirror.
// ─── PLAYBOOK: la config que define el "cómo" de cada tipo de bot (vertical) ──────
// Antes esto era un `BOT_VERTICAL === "rental" ? … : …` repartido por 9 sitios del motor.
// Ahora vive en UN objeto por vertical. Un bot nuevo del MISMO tipo no toca motor; un tipo
// NUEVO = añadir una entrada aquí (+ su bloque gathering/close abajo, según closeStyle).
// closeStyle: "appointment" (cierra reservando videollamada, emite [APPT]) | "direct" (cierra
// en el chat, alquiler) | "reservation" (futuro: mesa/cita puntual).
const BUILTIN_PLAYBOOKS = {
  tour: {
    closeStyle: "appointment",
    dealIdField: "tour",
    dealFields: ["tour", "package", "riders", "pillions", "travelDate", "dealValue"],
    keyFields: ["email", "country", "tour", "package", "riders", "pillions", "travelDate"],
    enrichTextFields: ["name", "email", "country", "tour", "package", "travelDate"],
    enrichNumberFields: ["riders", "pillions"],
    enrichSystem:
      'You extract CRM fields from a WhatsApp sales chat for a motorcycle tour company. ' +
      'Fields to fill: ' +
      'name, email, country, tour ("Bali to Komodo" or "7 Islands"), ' +
      'package ("Roundtrip" | "Extreme" | "Deluxe"), riders (integer), pillions (integer), ' +
      'travelDate (free text like "late 2027"). Use null for anything not clearly stated by the customer. Never guess.',
    canned: [
      { title: "Saludo", text: "Hey! Thanks for reaching out! How can I help you plan your ride?" },
      { title: "Pedir datos", text: "To give you an exact quote — which tour, how many riders, and roughly when were you thinking of traveling?" },
      { title: "Proponer videollamada", text: "Want to hop on a quick video call with the team? It's free, about 30 minutes, zero pressure — they'll walk you through everything." },
    ],
    helpWith: "your trip",
    // 50000 = USD 500 por persona. Era 100000 (USD 1.000): el cliente lo bajó a 500 el 24-jul-2026
    // (mismo playbook de tour que la rama b2k, que ya llevaba el valor correcto — esta rama
    // se había quedado con la copia de antes de esa bajada. Ver reference_bot_engine_branch_divergence).
    deposit: { currency: "usd", amountMinor: 50000, label: "Booking Deposit", unit: "rider" },
  },
  rental: {
    closeStyle: "direct",
    dealIdField: "model",
    dealFields: ["model", "plan", "startDate", "endDate", "dealValue", "deliveryLocation", "insuranceTier", "paymentMethod"],
    keyFields: ["email", "country", "model", "plan", "startDate", "endDate", "deliveryLocation"],
    enrichTextFields: ["name", "email", "country", "model", "plan", "startDate", "endDate", "deliveryLocation"],
    enrichNumberFields: [],
    enrichSystem:
      'You extract CRM fields from a WhatsApp sales chat for a motorbike rental company. ' +
      'Fields to fill: ' +
      'name, email, country, model (vehicle model the customer wants), ' +
      'plan (rental period: daily/weekly/fortnight/monthly/semestral/annual), ' +
      'startDate (free text like "next Monday" or a date), endDate (return/end date of the rental, free text or a date), deliveryLocation (free text). ' +
      'Use null for anything not clearly stated by the customer. Never guess.',
    canned: [
      { title: "Saludo", text: "Hey! Thanks for reaching out! Which bike are you after, and for how long?" },
      { title: "Pedir datos", text: "To give you an exact quote: which model, how many days, and where should we deliver it?" },
      { title: "Confirmar entrega", text: "We deliver straight to your hotel or villa. What's the address?" },
    ],
    helpWith: "your rental",
    deposit: null, // el alquiler cobra importe dinámico en IDR (createStripeCheckoutIDR, rama balibest), no un depósito fijo por persona
  },
};
// Si hay PLAYBOOK_FILE (JSON en el repo, como context-<proyecto>.md) se carga de ahí un vertical
// A MEDIDA sin tocar este registry — así un bot nuevo de otro tipo es config, no código. Si no,
// se usa el built-in por BOT_VERTICAL (retrocompatible: B2K/BBM no definen PLAYBOOK_FILE).
function loadPlaybook() {
  const file = (process.env.PLAYBOOK_FILE || "").trim();
  if (file) {
    try {
      const pb = JSON.parse(fs.readFileSync(file, "utf8"));
      console.log(`[${PROJECT_NAME}] Playbook cargado de ${file} (vertical a medida)`);
      return { ...BUILTIN_PLAYBOOKS.tour, ...pb }; // base tour por si el JSON omite algún campo
    } catch (e) {
      console.error(`[${PROJECT_NAME}] PLAYBOOK_FILE=${file} ilegible (${e.message}) — uso el built-in por BOT_VERTICAL`);
    }
  }
  return BUILTIN_PLAYBOOKS[BOT_VERTICAL === "rental" ? "rental" : "tour"];
}
const PLAYBOOK = loadPlaybook();

const DEAL_ID_FIELD = PLAYBOOK.dealIdField;
const DEAL_FIELDS = PLAYBOOK.dealFields;
const DEALS_CAP = 30; // tope del array — al recortar se quitan antes los ya cerrados (won/lost), nunca los abiertos

function genDealId() { return "d_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

// Deal abierto al que pertenece este mensaje: mismo identificador (model/tour), o el único
// abierto si el mensaje aún no trae identificador (ej. llega el email antes que la moto).
// -1 → no hay match, toca crear un deal nuevo. Pura (sin I/O) — ver test-deal-archive.js.
function findOpenDealIndex(deals, dealFields) {
  const id = dealFields[DEAL_ID_FIELD];
  if (id) return deals.findIndex((d) => d.status === "open" && d[DEAL_ID_FIELD] === id);
  const openIdxs = [];
  deals.forEach((d, i) => { if (d.status === "open") openIdxs.push(i); });
  return openIdxs.length === 1 ? openIdxs[0] : -1;
}

// Qué deal reflejar en los campos de nivel-lead: el abierto más reciente, o si no queda
// ninguno abierto, el último tocado de cualquier estado. Pura.
function focusDeal(deals) {
  if (!deals.length) return null;
  const open = deals.filter((d) => d.status === "open");
  const pool = open.length ? open : deals;
  return pool.reduce((a, b) => ((b.updatedAt || 0) > (a.updatedAt || 0) ? b : a));
}
function mirrorOf(deal) {
  const m = {};
  if (deal) DEAL_FIELDS.forEach((k) => { if (deal[k] != null) m[k] = deal[k]; });
  return m;
}

// El status de nivel-lead (new/quoted/won/lost/noshow, followupTick/computeDropoff lo leen) es un
// campo INDEPENDIENTE de deals[].status — nada lo sincroniza solo. Estas dos funciones puras
// deciden cuándo re-sincronizarlo, para no dejar un lead marcado won/lost para siempre mientras
// sus deals dicen otra cosa. Ver test-deal-archive.js.

// Al cerrar un deal (won/lost) desde el panel: si no queda ninguno abierto, el lead sigue a los
// deals — gana si alguno ganó, pierde si todos perdieron. null = no tocar el status del lead.
function statusAfterDealClose(deals, prevLeadStatus) {
  if (deals.some((d) => d.status === "open")) return null; // aún queda algo abierto
  const newStatus = deals.some((d) => d.status === "won") ? "won" : "lost";
  if (prevLeadStatus === newStatus) return null;
  if (["won", "lost", "noshow"].includes(prevLeadStatus)) return null; // no pisar un status terminal ya puesto a mano
  return newStatus;
}
// Al abrir un deal nuevo (captureLeadData): un lead ya cerrado que vuelve a preguntar necesita
// atención de nuevo — sin esto followupTick/computeDropoff lo ignorarían para siempre.
// null = no tocar.
function statusAfterNewDeal(prevLeadStatus) {
  return ["won", "lost", "noshow"].includes(prevLeadStatus) ? "" : null;
}

// Solo recorta si hace falta, y solo a costa de deals ya cerrados — un deal abierto nunca se pierde.
function capDeals(deals) {
  if (deals.length <= DEALS_CAP) return deals;
  const closedSorted = deals.filter((d) => d.status !== "open").sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
  const openCount = deals.length - closedSorted.length;
  const keepClosed = new Set(closedSorted.slice(-(Math.max(0, DEALS_CAP - openCount))));
  return deals.filter((d) => d.status === "open" || keepClosed.has(d));
}

// Guarda los campos extraídos en la BD (Redis) + Sheet, sin pisar con vacíos.
async function captureLeadData(phone, fields) {
  if (!fields || !Object.keys(fields).length) return;
  const prev = (await getLead(phone)) || {};
  let deals = Array.isArray(prev.deals) ? prev.deals.slice() : [];

  const dealFields = {};
  DEAL_FIELDS.forEach((k) => { if (fields[k] != null && fields[k] !== "") dealFields[k] = fields[k]; });
  const leadFields = { ...fields };
  DEAL_FIELDS.forEach((k) => { delete leadFields[k]; });

  let mirror = {};
  if (Object.keys(dealFields).length) {
    const idx = findOpenDealIndex(deals, dealFields);
    if (idx >= 0) {
      deals[idx] = { ...deals[idx], ...dealFields, updatedAt: Date.now() };
    } else {
      const hadOpenOther = deals.some((d) => d.status === "open");
      deals.push({ id: genDealId(), status: "open", createdAt: Date.now(), updatedAt: Date.now(), ...dealFields });
      if (hadOpenOther) await logEvent(phone, "deal_new", { model: dealFields[DEAL_ID_FIELD] || "" });
      const prevLeadStatus = await getStatus(phone);
      const resetTo = statusAfterNewDeal(prevLeadStatus);
      if (resetTo != null) {
        await setStatus(phone, resetTo);
        await logEvent(phone, "status", { from: prevLeadStatus, to: resetTo });
      }
    }
    deals = capDeals(deals);
    mirror = mirrorOf(focusDeal(deals));
  }

  let out = { ...leadFields, ...mirror };
  // Las etiquetas se UNEN con las existentes (no pisan las que puso el estudio a mano).
  if (Array.isArray(out.tags)) {
    const set = new Set([...(Array.isArray(prev.tags) ? prev.tags : []), ...out.tags].map((s) => String(s).trim()).filter(Boolean));
    out = { ...out, tags: Array.from(set).slice(0, 20) };
    // await OBLIGATORIO: sin él, el SET de logEvent (solo history, leído pre-tags) aterriza
    // DESPUÉS del write de abajo y machaca tags/followup — los tags nunca llegaban a verse.
    if (out.tags.length) await logEvent(phone, "tag", { to: out.tags[out.tags.length - 1] });
  }
  await updateLeadFields(phone, { ...out, deals, updatedAt: Date.now() });
  writeLeadToSheet(phone, out); // best-effort (solo escribe las llaves con columna mapeada)
}

// Registra un hito CRM en el historial del lead (para el timeline del panel). No bumpea updatedAt.
async function logEvent(phone, type, meta) {
  try {
    const prev = (await getLead(phone)) || {};
    const history = (Array.isArray(prev.history) ? prev.history : []).slice(-49);
    history.push(Object.assign({ ts: Date.now(), type }, meta || {}));
    await updateLeadFields(phone, { history });
  } catch (e) { /* best-effort */ }
}

// ─── ENRIQUECIMIENTO: rellena la ficha leyendo la conversación con el LLM ──────
// Para leads antiguos (p.ej. Keith) cuyos datos están en el chat pero no en la ficha.
const EXTRACT_MODEL = process.env.EXTRACT_MODEL || MODEL;
const KEY_FIELDS = PLAYBOOK.keyFields;
function leadMissingKeyFields(l) {
  if (!l) return true;
  return KEY_FIELDS.some((k) => l[k] == null || l[k] === "");
}

// Salida estructurada (output_config.format): la API garantiza el esquema. Antes el system pedía
// "ONLY a compact JSON object" y se recortaba del primer "{" al último "}", porque el modelo
// anteponía prosa (producción de BBM, 23-jul). Un corte por max_tokens deja JSON incompleto → throw → catch.
function jsonFormat(properties) {
  return { format: { type: "json_schema", schema: { type: "object", properties, required: Object.keys(properties), additionalProperties: false } } };
}
const nullable = (type) => ({ anyOf: [{ type }, { type: "null" }] });
const enrichFormat = () => jsonFormat(Object.fromEntries([
  ...(PLAYBOOK.enrichTextFields || []).map((k) => [k, nullable("string")]),
  ...(PLAYBOOK.enrichNumberFields || []).map((k) => [k, nullable("integer")]),
]));
function firstJson(r) {
  return JSON.parse(((r.content.find((b) => b.type === "text") || {}).text) || "");
}

async function enrichLeadFromConversation(phone, { force = false } = {}) {
  const lead = (await getLead(phone)) || { phone };
  // No repetir si ya está completo o se enriqueció hace poco (salvo force).
  if (!force && lead.enrichedAt && Date.now() - lead.enrichedAt < 12 * 3600 * 1000) return null;
  if (!force && !leadMissingKeyFields(lead)) return null;
  const history = await getConversation(phone);
  if (!history || history.length < 2) return null;
  const transcript = history
    .map((m) => `${m.role === "user" ? "Customer" : PERSONA_NAME}: ${m.content}`)
    .join("\n")
    .slice(-6000);
  let data = null;
  try {
    const r = await claudeMessage({ // mismo wrapper con retries/stream que el bot (anti "Premature close")
      model: EXTRACT_MODEL,
      max_tokens: 300,
      thinking: { type: "disabled" }, // extractor corto: sin thinking (en Sonnet 5 iría ON por defecto y se comería max_tokens)
      output_config: enrichFormat(),
      system: PLAYBOOK.enrichSystem + `\n${dateHint()}`, // sin esto guardaba fechas del año anterior en la ficha
      messages: [{ role: "user", content: transcript }],
    });
    data = firstJson(r);
  } catch (e) {
    console.error(`[${PROJECT_NAME}] enrich ${phone}: fallo extracción — ${e.message}`);
    return null;
  }
  // Solo rellenar campos VACÍOS: nunca pisar lo que ya hay (p.ej. ediciones manuales).
  const fields = {};
  const textFields = PLAYBOOK.enrichTextFields;
  textFields.forEach((k) => {
    if (data[k] && (lead[k] == null || lead[k] === "")) fields[k] = String(data[k]).slice(0, 120);
  });
  PLAYBOOK.enrichNumberFields.forEach((k) => {
    const n = parseInt(data[k], 10);
    if (data[k] != null && !isNaN(n) && (lead[k] == null || lead[k] === "")) fields[k] = n;
  });
  fields.enrichedAt = Date.now();
  await updateLeadFields(phone, fields); // no toca updatedAt → no reordena el lead como "actividad nueva"
  if (Object.keys(fields).length > 1) { writeLeadToSheet(phone, fields); logEvent(phone, "enriched", { fields: Object.keys(fields).filter((k) => k !== "enrichedAt") }); }
  return fields;
}

// ─── IMPORTAR LEADS DE META (CSV de Lead Ads) ────────────────────────
// Crea/actualiza el lead en la BD a partir de una fila ya parseada en el cliente.
// No pisa datos existentes (merge solo-vacíos): si el lead ya chateó, manda el chat.
async function importMetaLead(row) {
  const phone = String((row && row.whatsapp) || "").replace(/\D/g, "");
  if (!phone) return "skip";
  const prev = await getLead(phone);
  const fields = {};
  if (row.name && !(prev && prev.name)) fields.name = String(row.name).slice(0, 120);
  if (row.email && !(prev && prev.email)) fields.email = String(row.email).toLowerCase().slice(0, 160);
  if (row.package && !(prev && prev.package)) fields.package = String(row.package).slice(0, 120);
  if (row.tour && !(prev && prev.tour)) fields.tour = String(row.tour).slice(0, 80);
  if (!prev) {
    fields.source = "meta-form";
    if (row.source) fields.adSource = String(row.source).slice(0, 120);
    const t = row.createdTime ? Date.parse(row.createdTime) : NaN;
    fields.updatedAt = isNaN(t) ? Date.now() : t; // ordena por fecha de envío del formulario
    fields.createdAt = fields.updatedAt;
    fields.history = [{ ts: fields.createdAt, type: "imported" }];
  }
  if (!Object.keys(fields).length) return "updated"; // ya estaba todo
  await updateLeadFields(phone, fields);
  writeLeadToSheet(phone, fields); // best-effort
  return prev ? "updated" : "created";
}

// Barrido: enriquece leads incompletos (cap para no disparar costes de LLM).
async function enrichSweep(limit = 20) {
  try {
    const all = await listLeads();
    const targets = all.filter(leadMissingKeyFields).slice(0, limit);
    let n = 0;
    for (const l of targets) {
      const f = await enrichLeadFromConversation(l.phone);
      if (f && Object.keys(f).length > 1) n++;
    }
    if (n) console.log(`[${PROJECT_NAME}] enrichSweep: ${n}/${targets.length} leads enriquecidos`);
    return n;
  } catch (e) {
    console.error(`[${PROJECT_NAME}] enrichSweep error: ${e.message}`);
    return 0;
  }
}

// ─── RESPUESTAS RÁPIDAS (canned replies, compartidas por proyecto) ──
const DEFAULT_CANNED = PLAYBOOK.canned;
async function getCanned() { return cannedLeer(DEFAULT_CANNED); }

// ─── CITAS / APPOINTMENTS (calendario del panel) ──────────────────
// Fase 1: almacén propio. La sincronización con Google Calendar se engancha
// después en createAppt (crear evento vía Service Account + CALENDAR_ID).

// Suma minutos a una fecha "naive" (sin zona) y devuelve otra naive — para el fin del evento.
function addMinutesNaive(naive, mins) {
  const base = naive.length === 16 ? naive + ":00" : naive;
  const d = new Date(base + "Z"); // tratar como UTC para no arrastrar la zona del servidor
  return new Date(d.getTime() + mins * 60000).toISOString().slice(0, 19);
}


async function getCalendarClient() {
  const credentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT);
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ["https://www.googleapis.com/auth/calendar"] });
  return google.calendar({ version: "v3", auth });
}

// Descripción del evento de Google Calendar: incluye closer y notas para que
// quien atienda la cita (aunque no iniciara la conversación) tenga el contexto.
function apptDescription(a) {
  return [
    `Lead: ${a.name || ""}${a.phone ? " (+" + a.phone + ")" : ""}`.trim(),
    a.closer ? `Closer: ${a.closer}` : "",
    a.notes ? `Notas: ${a.notes}` : "",
  ].filter(Boolean).join("\n");
}

// Una cita futura activa por teléfono, o null. Sin esto, mover un lead dos
// veces a la etapa de reunión (un doble clic, un doble-render del drop del
// kanban) duplica la cita Y el evento de Calendar — con Meet incluido cuando
// esté activo, gastando cuota de conferencias por nada (hallazgo Bots #3,
// revisión previa 10-sep-2026).
async function getApptActivaPorTelefono(phone) {
  if (!phone) return null;
  const todas = await listAppts();
  const ahora = Date.now();
  return todas.find((a) => a.phone === phone && apptTs(a.when) >= ahora) || null;
}

async function createAppt(a) {
  const existente = await getApptActivaPorTelefono(a.phone || "");
  if (existente) return updateAppt(existente.id, a);

  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const appt = { id, phone: a.phone || "", name: a.name || "", title: a.title || "Cita", when: a.when, closer: a.closer || "", notes: a.notes || "", createdAt: Date.now() };
  await persistAppt(appt);
  if (appt.phone) logEvent(appt.phone, "appt", { title: appt.title, when: appt.when });

  // Sincroniza con Google Calendar si está configurado (Service Account + CALENDAR_ID).
  // Hoy NO lo está para Lawang (verificado 10-sep-2026): esta rama queda dormida
  // hasta que el owner monte el acceso de Google Workspace — en cuanto exista,
  // el Meet automático se activa sin tocar código.
  if (CALENDAR_ID && GOOGLE_SERVICE_ACCOUNT) {
    try {
      const cal = await getCalendarClient();
      const tz = CALENDAR_TZ || "Europe/Madrid";
      const startNaive = appt.when.length === 16 ? appt.when + ":00" : appt.when;
      const ev = await cal.events.insert({
        calendarId: CALENDAR_ID,
        conferenceDataVersion: 1,
        requestBody: {
          summary: appt.title,
          description: apptDescription(appt),
          start: { dateTime: startNaive, timeZone: tz },
          end: { dateTime: addMinutesNaive(appt.when, 30), timeZone: tz },
          // Meet automático (hallazgo Bots #1): necesita que la cuenta detrás de
          // GOOGLE_SERVICE_ACCOUNT tenga Domain-Wide Delegation en el Workspace
          // de Lawang — sin eso, Calendar puede devolver el evento SIN
          // `conferenceData` (falla la conferencia, no el evento entero) y aquí
          // no se distingue ese caso: `eventId` se guarda igual y el panel
          // enseñará "sin enlace" si `hangoutLink` no viene en la respuesta.
          conferenceData: {
            createRequest: {
              requestId: id,
              conferenceSolutionKey: { type: "hangoutsMeet" },
            },
          },
          // guestsCanSeeOtherGuests:false (hallazgo Seguridad #5) — con varios
          // leads pasando por la agenda de los mismos closers, el valor por
          // defecto de Calendar dejaría que dos leads distintos se vieran el
          // email entre sí como invitados del mismo tipo de evento.
          guestsCanSeeOtherGuests: false,
          guestsCanInviteOthers: false,
          // sendUpdates:'none' en la llamada (no aquí, es parámetro de la
          // request) — decisión deliberada: que Google mande o no la
          // invitación al closer lo decide el proxy, no un valor por defecto
          // que mandaría avisos a terceros sin que nadie lo pidiera.
        },
      });
      appt.eventId = ev.data.id;
      appt.meetLink = ev.data.hangoutLink || "";
      await persistAppt(appt);
    } catch (e) {
      console.error(`[${PROJECT_NAME}] Calendar insert error: ${e.message}`);
    }
  }
  return appt;
}

// Edita una cita existente (título, fecha, closer, notas) y propaga al evento de Calendar.
async function updateAppt(id, fields) {
  const appt = await getAppt(id);
  if (!appt) return null;
  ["title", "when", "closer", "notes", "name", "phone"].forEach((k) => {
    if (fields[k] !== undefined && fields[k] !== null) appt[k] = fields[k];
  });
  await persistAppt(appt);
  if (fields.when !== undefined) await apptReindexar(appt);
  if (appt.eventId && CALENDAR_ID && GOOGLE_SERVICE_ACCOUNT) {
    try {
      const cal = await getCalendarClient();
      const tz = CALENDAR_TZ || "Europe/Madrid";
      const startNaive = appt.when.length === 16 ? appt.when + ":00" : appt.when;
      await cal.events.patch({
        calendarId: CALENDAR_ID,
        eventId: appt.eventId,
        requestBody: {
          summary: appt.title,
          description: apptDescription(appt),
          start: { dateTime: startNaive, timeZone: tz },
          end: { dateTime: addMinutesNaive(appt.when, 30), timeZone: tz },
          guestsCanSeeOtherGuests: false,
          guestsCanInviteOthers: false,
        },
      });
    } catch (e) {
      console.error(`[${PROJECT_NAME}] Calendar patch error: ${e.message}`);
    }
  }
  return appt;
}


async function deleteAppt(id) {
  const appt = await getAppt(id);
  if (appt && appt.eventId && CALENDAR_ID && GOOGLE_SERVICE_ACCOUNT) {
    try { const cal = await getCalendarClient(); await cal.events.delete({ calendarId: CALENDAR_ID, eventId: appt.eventId }); }
    catch (e) { console.error(`[${PROJECT_NAME}] Calendar delete error: ${e.message}`); }
  }
  await apptBorrar(id);
}

// ─── RECORDATORIO AUTOMÁTICO AL CLIENTE (antes de la videollamada) ──
async function reminderTick() {
  try {
    const now = Date.now();
    const leadMs = (parseInt(REMINDER_LEAD_MIN) || 60) * 60000;
    const list = await listAppts();
    for (const a of list) {
      if (!a.phone) continue;
      const diff = apptTs(a.when) - now;
      if (diff <= 0 || diff > leadMs) continue;       // solo citas dentro de la ventana de aviso
      if (await isReminded(a.id)) continue;
      const lastIn = await getInbound(a.phone);
      const within24h = lastIn && (now - lastIn) < 24 * 3600000;
      if (within24h) {
        await sendWhatsApp(a.phone, `Hey! Quick reminder about our call: ${a.title}. Talk soon.`);
        await setReminded(a.id);
      } else if (REMINDER_TEMPLATE_NAME) {
        await sendWhatsAppTemplate(a.phone, REMINDER_TEMPLATE_NAME, REMINDER_TEMPLATE_LANG, [a.title]);
        await setReminded(a.id);
      } else {
        await setReminded(a.id); // sin forma de enviar (ventana cerrada y sin plantilla) → no reintentar en bucle
        console.warn(`[${PROJECT_NAME}] Recordatorio omitido (ventana 24h cerrada, sin plantilla) para ${a.phone}`);
      }
    }
  } catch (e) {
    console.error(`[${PROJECT_NAME}] reminderTick error: ${e.message}`);
  }
}
if (!STORE_PG) setInterval(reminderTick, 5 * 60000); // revisar cada 5 minutos (BOT_STORE=postgres: su reloj es turno-pg.js → recordatorioTick)

// ─── RE-ENGANCHE DE VENTAS TRAS LA VENTANA DE 24h ──────────────────
// Pasadas las 24h, WhatsApp solo permite PLANTILLAS aprobadas (no texto libre).
// Este tick busca leads "fríos" aún vendibles y les envía la plantilla de seguimiento
// según la cadencia (FOLLOWUP_SCHEDULE = horas de frío para cada intento), con un tope.
// Cuando el cliente responde, resetFollowup() reinicia la cadencia y el bot retoma la venta.
const FOLLOWUP_SKIP_INTENT = new Set(["escalate"]);          // pregunta pendiente del owner
const FOLLOWUP_SKIP_STATUS = new Set(["won", "lost", "noshow"]); // ya cerrado
async function followupTick() {
  try {
    if (!FOLLOWUP_TEMPLATE_NAME) return; // sin plantilla aprobada no se puede contactar fuera de 24h
    const schedule = (FOLLOWUP_SCHEDULE || "24,72").split(",").map((s) => parseFloat(s)).filter((n) => !isNaN(n) && n >= 24);
    if (!schedule.length) return;
    const maxN = parseInt(FOLLOWUP_MAX) || schedule.length;
    const nVars = FOLLOWUP_TEMPLATE_VARS != null ? parseInt(FOLLOWUP_TEMPLATE_VARS) : 1;
    const now = Date.now();
    const _d = new Date();
    const todayStr = _d.getFullYear() + "-" + ("0" + (_d.getMonth() + 1)).slice(-2) + "-" + ("0" + _d.getDate()).slice(-2);
    const leads = await listLeads();
    for (const l of leads) {
      if (isOwner(l.phone)) continue;
      if (l.paused) continue;                              // humano al mando
      if (FOLLOWUP_SKIP_STATUS.has(l.status)) continue;    // cerrado (ganado/perdido/no-show)
      if (FOLLOWUP_SKIP_INTENT.has(l.intent)) continue;    // hay una duda escalada al owner
      // Seguimiento AGENDADO a futuro (p.ej. waitlist "avísame cuando abráis 2027"):
      // no auto-nudge; ya lo cubre followUpReminderTick avisando al owner en esa fecha.
      if (l.nextFollowUp && String(l.nextFollowUp).slice(0, 10) > todayStr) continue;
      if (Array.isArray(l.tags) && l.tags.some((t) => /waitlist/i.test(t))) continue; // en lista de espera
      if (!l.lastInboundAt) continue;
      const coldH = (now - l.lastInboundAt) / 3600000;
      if (coldH < 24) continue;                            // ventana abierta → el bot ya responde solo
      const sent = await getFollowupCount(l.phone);
      if (sent >= maxN) continue;                          // tope de intentos alcanzado
      const dueH = schedule[sent] != null ? schedule[sent] : schedule[schedule.length - 1];
      if (coldH < dueH) continue;                          // aún no toca el siguiente intento
      const firstName = (l.name || "").trim().split(/\s+/)[0] || "there";
      const params = nVars >= 1 ? [firstName] : [];
      await sendWhatsAppTemplate(l.phone, FOLLOWUP_TEMPLATE_NAME, FOLLOWUP_TEMPLATE_LANG, params);
      await setFollowupCount(l.phone, sent + 1);
      console.log(`[${PROJECT_NAME}] Follow-up ${sent + 1}/${maxN} enviado a ${l.phone} (frío ${coldH.toFixed(0)}h)`);
    }
  } catch (e) {
    console.error(`[${PROJECT_NAME}] followupTick error: ${e.message}`);
  }
}
if (!STORE_PG) setInterval(followupTick, 30 * 60000); // revisar cada 30 minutos (BOT_STORE=postgres: apagado hasta S12)

// ─── RECORDATORIOS DE SEGUIMIENTO MANUAL ───────────────────────────
// Cuando un lead llega a su fecha "Próximo seguimiento" (nextFollowUp), avisa al OWNER
// por WhatsApp para que lo contacte. Una vez por fecha (fuReminded). No al lead, al estudio.
async function followUpReminderTick() {
  try {
    if (!OWNER_PHONE) return;
    const now = new Date();
    const todayStr = now.getFullYear() + "-" + ("0" + (now.getMonth() + 1)).slice(-2) + "-" + ("0" + now.getDate()).slice(-2);
    const leads = await listLeads();
    for (const l of leads) {
      if (l.archived) continue;
      if (FOLLOWUP_SKIP_STATUS.has(l.status)) continue;     // ganado/perdido/no-show
      if (!l.nextFollowUp) continue;
      const fu = String(l.nextFollowUp).slice(0, 10);
      if (fu > todayStr) continue;                          // aún no vence
      if (l.fuReminded === fu) continue;                    // ya avisado para esta fecha
      const who = l.name || ("+" + l.phone);
      const extra = [l.package, l.owner ? "· " + l.owner : ""].filter(Boolean).join(" ");
      await sendWhatsApp(OWNER_PHONE, `📅 ${PROJECT_NAME} — Seguimiento pendiente\n\n*${who}* ${extra}\nTel: +${l.phone}\nVencía: ${fu}\n\nToca contactarle 👇`);
      await updateLeadFields(l.phone, { fuReminded: fu });
      await logEvent(l.phone, "fu_reminded", { date: fu });
      console.log(`[${PROJECT_NAME}] Recordatorio de seguimiento (owner) para ${l.phone} — vencía ${fu}`);
    }
  } catch (e) {
    console.error(`[${PROJECT_NAME}] followUpReminderTick error: ${e.message}`);
  }
}
if (!STORE_PG) setInterval(followUpReminderTick, 30 * 60000); // revisar cada 30 minutos (BOT_STORE=postgres: apagado)

// ─── INSTRUCCIONES BASE ───────────────────────────────────────────
const BASE_INSTRUCTIONS_HEAD = `
CHANNEL AWARENESS:
- You are inside WhatsApp. The customer is ALREADY talking to you here.
- NEVER ask for their WhatsApp number — you already have it.
- NEVER redirect them to WhatsApp, Instagram, or any other channel.

LANGUAGE RULES:
- Always respond in the EXACT language the customer writes in.
- If the customer switches language mid-conversation, switch immediately and completely.
- NEVER mix languages — not even one word or expression from another language.

FORMATTING (WhatsApp):
- WhatsApp uses *single asterisk* for bold, NOT double **. Never use **double asterisks**.
- URLs must ALWAYS be plain text, never wrapped in asterisks, backticks, or brackets.
- Put URLs on their own line with no formatting around them.
- No markdown headers (#), no code blocks, no HTML.

PERSONA — how to sound human, not like a bot (the brand voice in your context defines the style; these are the rules underneath it):
- Keep messages SHORT. One or two short lines is the default. A wall of text or a long bulleted list is the #1 thing that makes you sound like a bot — avoid both.
- Use contractions ("we'll", "it's", "you'll"). Never write like a brochure.
- Vary your openings. Never start two consecutive messages the same way. Never use "Great!", "Of course!", "Certainly!", "Absolutely!" or similar filler.
- Vary response length. Sometimes one sentence is the right answer. Not every message needs four lines.
- Do NOT use bullet lists unless the information genuinely requires comparison. Talk naturally.
- Use emojis sparingly — at most one per message, and not in every message.
- Ask ONE thing at a time. Never stack multiple questions. Never make it feel like a form.
- React to what they actually said before moving the conversation forward.
- NEVER use a dash (—, –, or --) in the middle of a sentence — nobody texting on WhatsApp writes that way. Use a comma, a period, or just start a new sentence instead.
- Send only the final answer: working-out and self-corrections ("wait, let me recalculate") stay out of the message.
- NEVER convert a time between timezones in the chat (e.g. "2pm ACST would be 3:30pm here in Bali"). You get it wrong, and a mis-stated call time is a real, money-losing error. Keep the agreed time in the CUSTOMER's own timezone — that is exactly what the APPT tag records for the team — and do NOT narrate a Bali-equivalent. If a Bali time genuinely has to be pinned down, ask the customer to confirm it rather than computing it yourself.

ANTI-ROBOT TELLS — the specific habits that give you away as AI:
- DON'T OPEN EVERY MESSAGE WITH A REACTION WORD. "Ha," "Ah," "Nice," "Perfect," "Solid," "Love it," "Good call," "Right," are fine ONCE in a while, but the moment you reuse them they're an instant tell. Most messages should just start with the substance. Vary genuinely, or don't react at all. Nobody texts "Ha," at the top of message after message.
- NEVER REPEAT INFORMATION you already gave. If you listed what's included once, don't paste that list again two messages later. Say "same as before" or just move on. A repeated stock phrase reads as a bot.
- NO MENU QUESTIONS. Never offer multiple-choice like "A, B or C?" or "riding solo, with mates, or a bit of both?". Ask a real open question or none at all. A menu makes them answer in one word and you've learned nothing.
- ONE-WORD REPLIES ARE A WARNING LIGHT. When their answers go short ("Solo", "October", "This"), STOP asking and GIVE something: a price, a useful fact they didn't ask for, or the next step. Stacking more questions onto one-word answers is running a form, not having a conversation.
- DON'T TELL THEM HOW YOU KNOW THINGS about them ("I can tell from your number you're in Australia"). Just let it colour the reply naturally. And never turn their nationality or city into a repeated stamp.
- NOT EVERY MESSAGE NEEDS A CLOSING QUESTION. Sometimes just answer and stop. A real chat breathes; forcing an offer or question onto the end of every single message is a tell.
- ONCE A NEXT STEP IS LOCKED (call booked, date/time set, link sent), say it ONCE and move on. Re-confirming the same appointment two or three messages running is a glaring tell — a real person locks it in and trusts it. If they go quiet or reply off-topic after it's set, don't re-announce the time; just answer what they actually said.
`;

// GATHERING + CLOSING difieren por vertical del negocio (tour multi-día vs. alquiler directo).
// BOT_VERTICAL=rental activa los bloques de abajo; cualquier otro valor (incl. sin definir) usa "tour",
// que es el texto original de B2K sin cambios — así el comportamiento de B2K no varía por defecto.

const TOUR_GATHERING = `
GATHERING INFO BEFORE QUOTING OR CLOSING (guidance, NOT a rigid script):
- To give an exact price you eventually need: which tour/package, how many riders, how many bikes (so you know pillions), room preference, and a rough travel window.
- Gather these naturally as the conversation flows — ask for the next most relevant piece, one at a time. Do NOT interrogate them or ask for everything up front.
- All amounts, currency, discounts and surcharges come from your context — never improvise a number or a currency.
`;

const RENTAL_GATHERING = `
GATHERING INFO BEFORE QUOTING OR CLOSING (guidance, NOT a rigid script):
- To give an exact price you eventually need: which bike/model, the plan or duration (daily/weekly/monthly/semestral/annual), delivery location, and a rough start date.
- Gather these naturally as the conversation flows — ask for the next most relevant piece, one at a time. Do NOT interrogate them or ask for everything up front.
- All amounts, currency, discounts and policies come from your context — never improvise a number.
`;

const BASE_INSTRUCTIONS_MIDDLE = `
SELF-SUFFICIENCY:
- Answer all pricing, route, and logistics questions yourself using your context.
- NEVER say "let me check with the team" or "I'll forward this to the team".
- NEVER suggest contacting another number or channel.
- Only escalate when you genuinely don't know the answer and can't derive it from your context.

ESCALATION — when you truly don't know something:
- Tell the customer naturally, IN THEIR EXACT LANGUAGE, that you're checking on that and will get back to them shortly. Do NOT use English if they wrote in Spanish, French, etc.
- Do NOT mention teams, staff, guides, or other people. Do NOT give a phone number.
- Just set [INTENT:escalate] — the system handles the rest silently.
- EXCEPTION — "the link/URL doesn't work": never escalate for this. Resend the raw URL as plain text on its own line and tell them to copy-paste it in their browser.
`;

const TOUR_CLOSE_AND_TAGGING = `
CLOSING — YOUR #1 GOAL IS TO BOOK A FREE 30-MINUTE VIDEO CALL (read carefully — this is the main objective):
- For a trip this size, nobody pays a big deposit cold off a chat. So your primary goal is NOT to send a payment link — it's to get the customer onto a free, no-pressure 30-minute video call with the team, who walk them through everything and close the sale properly.
- Once the customer shows real interest (asked about price, dates, what's included, gave group size), steer warmly toward the call as the natural next step: "Want to hop on a quick video call with the team? It's free, about 30 minutes, zero pressure — they'll walk you through everything and answer all your questions."
- Keep selling the call, not the deposit. Frame it as the easy, no-commitment way to get all their answers and see if it's right for them.
- THE PAYMENT LINK IS THE EXCEPTION, NOT THE CLOSE: only send the deposit/Stripe link if the customer EXPLICITLY insists on paying right now ("I want to pay", "send me the link", "how do I pay the deposit"). Only then use [INTENT:booking][RIDERS:N]. Otherwise NEVER push payment — push the call.
- Never stall ("I'll check availability", "confirm with the team") — just offer the call and lock a time.

SCHEDULING THE CALL — THIS IS YOUR MAIN CONVERSION PATH (appointments):
- Agree on a specific date and time, and ALWAYS ask their city/timezone (riders are international — AU, US, UK). Propose a slot or ask what suits them.
- Work entirely in THE CUSTOMER'S OWN timezone: propose or confirm a concrete slot in their local time (e.g. "does 8:30 AM your time tomorrow work?") and stop there. Do NOT compute or announce the Bali-equivalent ("that's X o'clock here"). The offset math is error-prone (a real chat quoted the wrong Bali time, backwards) and the customer doesn't need it; the system converts the slot for the team automatically from the timezone label you put in the APPT tag.
- Confirm the exact day + hour in the CUSTOMER'S own timezone, and put that timezone label in the APPT title (e.g. "EST", "AEST", "GMT"). If a video-call tool is mentioned, tell them you'll send the meeting link at that time.
- Only once you BOTH agree on a concrete date AND time, confirm it naturally in your message AND add at the very end, on a NEW line:
  [APPT:YYYY-MM-DDTHH:MM|Short title incl. timezone]
  Example: [APPT:2026-07-15T10:00|Call w/ John re Bali-Komodo — 10:00 AEST]
- NEVER invent a date/time. Output the APPT tag only when a precise day and hour are agreed. The tag is stripped before sending — never mention it to the customer.
- After locking the call, set [INTENT:booking] (it's a hot lead) but do NOT output [RIDERS:N] — a call must never trigger a payment link.

INTENT AND RIDERS TAGGING:
At the very end of your response, on a NEW LINE, add ONE intent tag:
[INTENT:exploring] — just asking general questions, not yet committed
[INTENT:interested] — showing real interest in a specific tour/package
[INTENT:booking] — wants to reserve, pay, or commit now
[INTENT:escalate] — you genuinely don't know the answer and cannot derive it from your context

When intent is booking AND you know the total number of riders, also add on the same line:
[RIDERS:N] — where N is the total number of riders (e.g. [RIDERS:4])
When you output [RIDERS:N], NEVER type a link, a URL, or the word "https" yourself. You do NOT have the real payment link — the server creates it and appends it automatically below your message. Any URL you write is FAKE and will break the customer's payment. Just say you're sending the link and stop.
- [RIDERS:N] CREATES A REAL CHARGE. Output it ONLY when the customer EXPLICITLY asks to pay right now ("send me the payment link", "how do I pay the deposit", "I want to pay"). Confirming trip details, riders, dates or "I'd like to book" is NOT a pay-now request → push the free video CALL instead, do NOT output [RIDERS:N].
- RESEND: if the customer asks to resend the SAME payment link they already got ("can you send it again?", "resend the link"), output [RESEND_LINK] on its own new line — NOT [RIDERS:N]. The server re-attaches the exact same link (no new charge). If you never sent them a link, don't output [RESEND_LINK]; offer the call instead.

LEAD DATA TAGGING — fill the CRM as you learn things (do this consistently):
- Whenever you LEARN or CONFIRM a concrete fact about the lead, append a SILENT data tag at the very end of your message, on its own new line:
  [LEAD key=value; key=value]
- It is stripped before sending — the customer NEVER sees it. Include ONLY the fields you are now sure of; omit anything you don't know yet. NEVER guess or invent a value.
- Valid keys: tour (e.g. Bali to Komodo / 7 Islands) · package (Roundtrip / Extreme / Deluxe) · riders (a number) · pillions (a number) · dates (their travel window, e.g. "late 2027" or "October 2026") · country · name · email · tags (short labels, comma-separated) · followup (a date YYYY-MM-DD for the next time the team should reach out).
- Send it the moment you learn each thing, and again (with the fuller set) as more is confirmed — re-sending a known field is fine, it just updates the record.
- Note: leads who arrived via the Instagram form already have their name, email and package band captured automatically — you don't need to re-tag those, but DO tag what you learn in the chat (chosen package, exact riders, dates, country, pillions).
- WAITLIST / DEFER — MANDATORY, NEVER SKIP. The instant the customer defers, declines for now, or asks to be contacted later (wants a GUIDED departure not yet scheduled, "let me know when", "we'll wait", "maybe next year", "not right now"), you MUST end THAT SAME message with a LEAD tag carrying BOTH a tag AND a followup date. A promise like "I'll make a note" / "we'll let you know" WITHOUT the tag = the lead is silently lost. Never do that.
  Format: [LEAD tags=guided-waitlist; followup=YYYY-MM-DD; dates=...; riders=N]
  Pick followup ~2 months before their window opens; for a 2027 guided waitlist use followup=2026-09-01. Other tag examples: waitlist-2027, price-objection, VIP, needs-IDP.
- Example: a UK rider confirms 4 of them want Extreme for late 2027 → end your message with: [LEAD tour=Bali to Komodo; package=Extreme; riders=4; dates=late 2027; country=UK]
- Example (waitlist): group of 4 wants a GUIDED 2027 departure (none open yet) → [LEAD tour=Bali to Komodo; riders=4; dates=late 2027; tags=guided-waitlist,2027; followup=2026-09-01]

All tags are stripped before sending. NEVER mention them to the customer.
`;

const RENTAL_CLOSE_AND_TAGGING = `
CLOSING — DIRECT IN THE CHAT, THIS IS A RENTAL, NOT A MULTI-DAY TOUR (read carefully — this is the main objective):
- The ticket size is small (single days to a few hundred dollars a month). Nobody needs a video call to rent a bike — close directly in the chat, never push a call.
- LEAD WITH PRICE FAST — do NOT gate a number behind multiple qualifying questions. The moment you know the rental duration (even without an exact bike/model), give an approximate price RANGE across 2-3 categories (e.g. budget scooter vs premium) in your very first substantive reply, then ask AT MOST one follow-up question to narrow it down. Never do more than one round of questions before showing a number — price transparency closes rentals, interrogation loses them.
- THIS APPLIES TO EVERY DURATION, SHORT OR LONG — daily, weekly, fortnight, 3-week, monthly, semestral, annual, all of them. Long-stay/subscription plans are NOT an exception: if a lead says "I need a bike for 6 months" or "I want the annual plan", give the price range for that exact period in your first reply too — do not swap the price for a lifestyle pitch ("that's our sweet spot", "the long-term plans are where we shine") instead of a number. Sell the long-stay value AFTER the price, never as a substitute for it.
- Once you know the bike/model, plan/duration, delivery location and a rough start date, give the exact price and move straight to confirming the booking.
- Confirm what's included (helmets, free delivery) and tell them the team will follow up shortly to finalize payment and delivery logistics.
- Set [INTENT:booking] the moment the customer wants to reserve. Do NOT output [RIDERS:N] or [APPT:...] — those are tour-specific (they trigger a per-person tour deposit charge and a video-call scheduling flow) and do not apply to a bike rental.
- Never stall ("I'll check availability") — bikes get confirmed directly; only escalate for something you genuinely can't answer from your context.

COMMERCIAL INSTINCT — you're not just taking an order, you're selling. Stay direct (one line, then move
on), but always look for the real opportunity to get BBM the better outcome:
- Duration close to a cheaper-per-day threshold (e.g. 27 days vs the Monthly plan): don't just silently
  apply the better rate, SAY it, e.g. "heads up, the monthly plan actually works out cheaper and you get a
  few extra days too, want that instead?" Make the upgrade visible, don't just compute it quietly.
- Model close to a genuinely better tier for a modest price step: point it out in one line, e.g. "for just
  250,000 more you'd get the ABS version, which includes X" — same pattern as when a customer proposes a
  switch themselves, but do it proactively when you spot a real opening, don't wait to be asked.
- ONLY pitch an upgrade that is genuinely better value for the customer too (more bike, more days, real
  extra feature) — NEVER recommend a pricier option that isn't actually a better deal just to raise the
  ticket. A bad-faith upsell costs trust and repeat business, which costs BBM more than one sale.
- One pitch per opening, then respect the answer. If they decline once, don't repeat it or push again in
  the same conversation — direct means efficient, not pushy.

INTENT TAGGING:
At the very end of your response, on a NEW LINE, add ONE intent tag:
[INTENT:exploring] — just asking general questions, not yet committed
[INTENT:interested] — showing real interest in a specific bike or plan
[INTENT:booking] — wants to reserve now
[INTENT:escalate] — you genuinely don't know the answer and cannot derive it from your context

LEAD DATA TAGGING — fill the CRM as you learn things (do this consistently):
- Whenever you LEARN or CONFIRM a concrete fact about the lead, append a SILENT data tag at the very end of your message, on its own new line:
  [LEAD key=value; key=value]
- It is stripped before sending — the customer NEVER sees it. Include ONLY the fields you are now sure of; omit anything you don't know yet. NEVER guess or invent a value.
- Valid keys: model (bike/scooter model) · plan (daily/weekly/monthly/semestral/annual) · start_date · end_date (return/end date of the rental — when you know the start date and plan/duration, compute and tag it as YYYY-MM-DD) · delivery_location · insurance_tier · payment_method · value (total quoted price for THEIR chosen bike+plan, digits only in IDR, e.g. value=2450000 — update it if the quote changes) · name · email · country · tags (short labels, comma-separated) · followup (a date YYYY-MM-DD for the next time the team should reach out).
- Whenever you quote a concrete total price for the customer's chosen bike and plan, include value=<digits> in the LEAD tag — it feeds the revenue metrics in the CRM. Only the price of what they're actually leaning toward, never a range.
- Send it the moment you learn each thing, and again (with the fuller set) as more is confirmed — re-sending a known field is fine, it just updates the record.
- WAITLIST / DEFER — MANDATORY, NEVER SKIP. The instant the customer defers ("let me think about it", "maybe next month", "not right now"), you MUST end THAT SAME message with a LEAD tag carrying a followup date so they aren't silently lost. A promise like "I'll make a note" WITHOUT the tag = the lead is silently lost. Never do that.
  Format: [LEAD tags=followup; followup=YYYY-MM-DD]

All tags are stripped before sending. NEVER mention them to the customer.
`;

// gathering/close: si el playbook los trae como texto (vertical a medida vía PLAYBOOK_FILE) se usan
// tal cual; si no, se eligen los bloques built-in por closeStyle. tour/rental no los traen → idéntico.
const _gathering = PLAYBOOK.gathering || (PLAYBOOK.closeStyle === "direct" ? RENTAL_GATHERING : TOUR_GATHERING);
const _close = PLAYBOOK.close || (PLAYBOOK.closeStyle === "direct" ? RENTAL_CLOSE_AND_TAGGING : TOUR_CLOSE_AND_TAGGING);
// Con BOT_CRM=on (efectivo) el modelo agenda con [CITA:...] y la base guarda la cita (S5): ni se le enseña [APPT:...] ni el bot la guarda en Redis. Apagado o en sombra, el
// texto es EXACTAMENTE el de siempre (test: "BOT_CRM off/sombra: el prompt de cierre no cambia").
// middle (opcional, solo lo trae playbook-lawang.json): sustituye a BASE_INSTRUCTIONS_MIDDLE, cuyo SELF-SUFFICIENCY ("nunca digas que el equipo lo confirmara") es del bot de tours.
// B2K/BBM no lo definen: para ellos el texto es EXACTAMENTE el de siempre.
const _middle = typeof PLAYBOOK.middle === "string" && PLAYBOOK.middle.trim() ? PLAYBOOK.middle : BASE_INSTRUCTIONS_MIDDLE;
let BASE_INSTRUCTIONS = BASE_INSTRUCTIONS_HEAD + _gathering + _middle + _close;
// En sombra Y en on el modelo solo ve [CITA]: si en sombra viera tambien [APPT] (el cierre viejo) las emitiria las dos y la cita real iria por la via vieja.
if (CRM_EFECTIVO !== "off") {
  const adaptado = adaptaCierreACita(BASE_INSTRUCTIONS);
  BASE_INSTRUCTIONS = adaptado.texto;
  if (adaptado.restantes) console.error(`[${PROJECT_NAME}] CRM=${CRM_EFECTIVO}: quedan ${adaptado.restantes} menciones de APPT en las instrucciones de cierre: el modelo recibirá dos etiquetas de cita. Revisar adaptaCierreACita.`);
}

// Profundidad de persona opcional por config (PERSONA_BIO en Railway): trasfondo humano del
// que el bot puede tirar de forma natural, sin que cada proyecto lo escriba a mano en su contexto.
// No inventar hechos verificables (eso ya lo prohíben las HONESTY GUARDRAILS); es color, no biografía falsa.
const PERSONA_BIO = (process.env.PERSONA_BIO || "").trim();
const PERSONA_BLOCK = PERSONA_BIO
  ? `\n\nWHO YOU ARE (${PERSONA_NAME}) — draw on this naturally, never recite it or invent beyond it:\n${PERSONA_BIO}`
  : "";
function buildSystemPrompt() {
  return `${CONTEXT}${PERSONA_BLOCK}\n\n${BASE_INSTRUCTIONS}`;
}

// El modelo NO sabe qué día es: sin esto materializa "mañana"/"next Monday" con el año de su
// corte de entrenamiento. Visto en producción (BBM, chat real del cliente 14-jul-2026): el bot
// llegó a preguntar "what's today's exact date?" y el CRM guardó startDate 2025-07-15 — fechas
// que además viajan al ERP del cliente en pushInquiryToERP y al calendario en [APPT].
// Va en bloque APARTE del system cacheado (cambia a diario; dentro del prefijo rompería la caché).
const DATE_TZ = CALENDAR_TZ || "Asia/Makassar"; // negocio en Bali (WITA); Railway corre en UTC
const todayBiz = () => new Date().toLocaleDateString("en-CA", { timeZone: DATE_TZ }); // YYYY-MM-DD
const dateHint = () => `TODAY IS ${todayBiz()} (${DATE_TZ}). Resolve every relative date the customer `
  + `gives you ("tomorrow", "next Monday", "the 15th") against THIS date, and never write a date in a `
  + `different year. Never ask the customer what today's date is — you know it.`;

// ─── GOOGLE SHEETS ────────────────────────────────────────────────
async function getSheetsClient() {
  const credentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

async function findLeadRow(sheets, phone) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "A1:P1000",
  });
  const rows = res.data.values || [];
  const phoneClean = phone.replace(/\D/g, "").slice(-9);
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][2] && rows[i][2].replace(/\D/g, "").includes(phoneClean)) {
      return i + 1;
    }
  }
  return null;
}

async function saveLead(phone, name, lastMessage, intent) {
  if (!SHEET_SYNC) return; // CRM = Redis; sin sincronización al Google Sheet
  try {
    const sheets = await getSheetsClient();
    const existingRow = await findLeadRow(sheets, phone);
    const now = new Date().toLocaleDateString("es-ES");

    if (existingRow) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `L${existingRow}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[now]] },
      });
    } else {
      const newRow = [
        name || "WhatsApp Lead", "", phone, "", PROJECT_NAME || "",
        "", "", "Open",
        intent === "booking" ? "WANTS TO BOOK" : "NEW! Pending contact",
        "Bot", "", now, now, "",
        `Bot conversation. Last: ${lastMessage.slice(0, 80)}`,
      ];
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: "A1",
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [newRow] },
      });
    }
  } catch (e) {
    const detail = e.errors ? JSON.stringify(e.errors) : e.message;
    console.error(`[${PROJECT_NAME}] Error guardando lead — HTTP ${e.code || '?'}: ${detail}`);
  }
}

// Mapeo de campos editables → columnas fijas del CRM (cabeceras del Sheet)
const SHEET_COL = { name: "A", country: "B", email: "D", tour: "E", package: "F", status: "H", owner: "J", travelDate: "K", nextFollowUp: "M", notes: "O" };
const STATUS_SHEET_LABEL = { new: "New", quoted: "Quoted", won: "Won ✅", lost: "Lost", noshow: "No-show" };

async function updateLeadCells(sheets, row, vals) {
  const data = Object.keys(vals)
    .filter((k) => SHEET_COL[k] != null && vals[k] != null)
    .map((k) => ({ range: `${SHEET_COL[k]}${row}`, values: [[vals[k]]] }));
  if (!data.length) return;
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { valueInputOption: "USER_ENTERED", data },
  });
}

// Escribe los campos editados de un lead en su fila del CRM.
// Depende de que el Sheet esté compartido con la Service Account (si no, falla controlado).
async function writeLeadToSheet(phone, vals) {
  if (!SHEET_SYNC || !SHEET_ID || !GOOGLE_SERVICE_ACCOUNT) return;
  try {
    const sheets = await getSheetsClient();
    const row = await findLeadRow(sheets, phone);
    if (!row) { console.warn(`[${PROJECT_NAME}] writeLeadToSheet: lead ${phone} no está en el Sheet todavía`); return; }
    await updateLeadCells(sheets, row, vals);
  } catch (e) {
    const detail = e.errors ? JSON.stringify(e.errors) : e.message;
    console.error(`[${PROJECT_NAME}] writeLeadToSheet error — HTTP ${e.code || '?'}: ${detail}`);
  }
}

// ─── STRIPE CHECKOUT SESSION ─────────────────────────────────────
async function createStripeSession(numUnits) {
  if (!stripeClient) return null;
  const dep = PLAYBOOK.deposit; // importe/moneda/etiqueta del depósito, por playbook (antes: $1000 USD hardcodeado)
  if (!dep) { console.error(`[${PROJECT_NAME}] createStripeSession: el playbook (${PLAYBOOK.closeStyle}) no define deposit`); return null; }
  const major = dep.amountMinor / 100;
  const unit = dep.unit || "unit";
  const cur = String(dep.currency || "usd").toUpperCase();
  try {
    const session = await stripeClient.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{
        price_data: {
          currency: dep.currency,
          product_data: {
            name: `${PROJECT_NAME || "Booking"} — ${dep.label || "Deposit"}`,
            description: `${major.toLocaleString()} ${cur} deposit × ${numUnits} ${unit}${numUnits > 1 ? "s" : ""}`,
          },
          unit_amount: dep.amountMinor,
        },
        quantity: numUnits,
      }],
      mode: "payment",
      success_url: STRIPE_SUCCESS_URL || "https://balimotoadventures.com/?booking=confirmed",
      cancel_url: STRIPE_CANCEL_URL || "https://balimotoadventures.com/",
    });
    console.log(`[${PROJECT_NAME}] Stripe session: ${numUnits} ${unit}s → ${(major * numUnits).toLocaleString()} ${cur}`);
    return session.url;
  } catch (e) {
    console.error(`[${PROJECT_NAME}] Stripe session error:`, e.message);
    return null;
  }
}

// ─── WHATSAPP ─────────────────────────────────────────────────────
// Solo BOT_STORE=postgres: un envío sin autorización de turno se RECHAZA y se grita (es un fallo de programación, no del cliente).
function rechazoDeEnvio(toClean, motivo) {
  const n = autorizaciones.cuentaRechazo();
  console.error(`[${PROJECT_NAME}] 🚫 ENVÍO RECHAZADO a …${String(toClean).slice(-4)}: ${motivo} (rechazos desde el arranque: ${n})`);
  return { ok: false, error: `envío rechazado: ${motivo}` };
}
async function sendWhatsAppResult(to, message) {
  const toClean = normalizePhone(to);
  /* La baja se honra en los DOS nucleos de envio, que es por donde pasa todo — bot,
     ticks, panel y comercial. Ponerla en los endpoints dejaria fuera a followupTick y
     reminderTick, que es justo quien mas insiste. */
  if (STORE_PG) {
    // BOT_STORE=postgres: no se envía a un cliente sin haber consultado ANTES su estado (baja incluida). Ver turno-pg.js → creaAutorizaciones.
    const motivo = autorizaciones.motivo(toClean, message);
    if (motivo) return rechazoDeEnvio(toClean, motivo);
  } else if (await getOptOut(toClean)) {
    console.log(`[${PROJECT_NAME}] 🚫 Envio BLOQUEADO a ${toClean}: pidio la baja (STOP)`);
    return { ok: false, error: "el lead pidio la baja (STOP)" };
  }
  try {
    const resp = await axios.post(
      `${GRAPH_BASE}/${WHATSAPP_PHONE_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: toClean,
        type: "text",
        text: { body: message },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
    // id (wamid) del mensaje enviado: permite enlazar la respuesta-cita del owner con su escalación
    return { ok: true, id: resp.data?.messages?.[0]?.id };
  } catch (e) {
    const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    return { ok: false, error: detail };
  }
}

// ⚠️ INVARIANTE DE ENVÍO (no romper al añadir funciones nuevas). Clasifica por QUIÉN
// HABLA, nunca por el tipo de mensaje — texto o plantilla es indiferente:
//   habla el BOT   → sendWhatsApp · sendWhatsAppTemplate                  → pasan por el freno
//   habla un HUMANO→ sendWhatsAppResult · sendWhatsAppTemplateResult
//                    · sendWhatsAppMedia                                  → nunca se frenan
// Cada par es envoltorio-gateado + núcleo-libre. Al añadir una forma de enviar, crea las
// DOS mitades; si solo creas una, alguien acabará usándola por el lado equivocado.
// `getWaBlocked()` va en el núcleo, no en el envoltorio: es estado de la cuenta, no freno.
// Frenar aquí y no en cada sitio de llamada es lo que hace que el modo testing cubra TODAS
// las bocas del bot de una vez —respuesta de IA, disculpa de media, followupTick,
// reminderTick, sendIntro— sin una lista a mano de call sites que el día que crezca se
// quedará corta. Cerrar una salida no cierra las hermanas: por eso se cierra el embudo.
async function sendWhatsApp(to, message) {
  if (!isAllowed(to)) {
    console.log(`[${PROJECT_NAME}] 🧪 TESTING — envío del bot BLOQUEADO a ${normalizePhone(to)} (no está en BOT_ALLOWLIST)`);
    return false;
  }
  const r = await sendWhatsAppResult(to, message);
  if (!r.ok) console.error(`[${PROJECT_NAME}] Error enviando WhatsApp a ${normalizePhone(to)}:`, r.error);
  return !!r.ok;   // el valor solo lo lee BOT_STORE=postgres (¿salió algo?); el modo redis lo ignora, como siempre
}

// ─── ENVÍO HUMANIZADO: 1-3 burbujas con pausa de tecleo, no un párrafo de golpe ─────
// Un bot que suelta 4 líneas en 0 segundos es el tell nº1. Partimos SOLO por párrafos
// deliberados del modelo (líneas en blanco): la mayoría de respuestas son 1-2 líneas y
// van en una sola burbuja, sin cambio. El webhook ya devolvió 200 antes de procesar, así
// que las pausas no provocan reintentos de Meta. Desactivable con HUMANIZE_CHUNKS=off.
const HUMANIZE_CHUNKS = process.env.HUMANIZE_CHUNKS !== "off";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function splitBubbles(text, maxBubbles = 3) {
  const paras = text.split(/\n\n+/).map((s) => s.trim()).filter(Boolean);
  if (paras.length <= 1) return [text];               // 1-2 líneas → una burbuja, sin tocar
  if (paras.length <= maxBubbles) return paras;
  const head = paras.slice(0, maxBubbles - 1);
  head.push(paras.slice(maxBubbles - 1).join("\n\n")); // el resto, junto, en la última
  return head;
}

// Retardo ANTES de la primera burbuja. Faltaba, y es EL tell: medido sobre 119 respuestas reales
// de B2K en producción, la mediana de "cliente escribe → bot contesta" era 3,4s y el 100% caía por
// debajo de 10s, incluidas respuestas de 500 caracteres. Ningún humano teclea eso en 4s. Un lead lo
// dijo con todas las letras y se fue: "How are you replying so quickly lol" → "No mate bit dodgy".
// El objetivo se calcula sobre la longitud y se le DESCUENTA lo que ya tardó el modelo, así una
// respuesta lenta no acumula espera encima. Tope 20s: cabe dentro de la ventana de 25s del
// indicador "escribiendo…" que ya se lanzó al recibir el mensaje, así que el lead ve actividad
// todo el rato. El jitter existe porque una latencia CONSTANTE también canta.
const TYPE_MS_PER_CHAR = Number(process.env.HUMANIZE_MS_PER_CHAR || 55);  // ~18 car/s: mecanógrafo rápido
const READ_MS = 2500;                                                     // leer lo que le han escrito
const FIRST_BUBBLE_CAP_MS = 20000;
function typingDelay(len, cap) {
  const jitter = 0.85 + Math.random() * 0.3;
  return Math.round(Math.min(READ_MS + len * TYPE_MS_PER_CHAR, cap) * jitter);
}
async function sendHumanized(to, text, messageId, startedAt) {
  if (!HUMANIZE_CHUNKS || !text) return await sendWhatsApp(to, text);
  const chunks = splitBubbles(text);
  let algunaSalio = false;
  for (let i = 0; i < chunks.length; i++) {
    // La 1ª descuenta lo que ya tardó Claude; las siguientes son pausa completa, con tope más bajo
    // (una persona encadena sus propios mensajes rápido) — pero nunca instantáneas.
    const wait = i === 0
      ? typingDelay(chunks[0].length, FIRST_BUBBLE_CAP_MS) - (startedAt ? Date.now() - startedAt : 0)
      : typingDelay(chunks[i].length, 9000);
    if (wait > 0) {
      if (messageId) markRead(messageId, true);                    // "escribiendo…" mientras espera
      await sleep(wait);
    }
    if (await sendWhatsApp(to, chunks[i])) algunaSalio = true;
  }
  return algunaSalio;
}

// Limpia la respuesta del modelo para el cliente: quita las etiquetas internas ([INTENT], [LEAD]…),
// arregla el guion medio (pilla "palabra—palabra" y guion final; NO toca "self-guided"/"3-6") y
// convierte el markdown que WhatsApp no entiende. Webhook y simulador comparten esto — antes estaba
// duplicado en dos sitios y un fix en uno se olvidaba en el otro.
function cleanReply(reply) {
  return reply
    .replace(/\[INTENT:\w+\]/g, "").replace(/\[RIDERS:\d+\]/g, "").replace(/\[APPT:[^\]]+\]/g, "")
    .replace(/\[LEAD[^\]]*\]/gi, "").replace(/\[MEDIA:[^\]]*\]/gi, "").replace(/\[RESEND_LINK\]/gi, "").replace(/\[(?:NOTA|CITA):[^\]]*\]/gi, "").replace(/\[\s*HUMANO[^\]]*\]/gi, "").trim()
    .replace(/[ \t]*(—|–|--)[ \t]*$/gm, ".").replace(/[ \t]*(—|–|--)[ \t]*/g, ", ")
    .replace(/\*\*(https?:\/\/[^\s*]+)\*\*/g, "$1")  // **URL** → URL
    .replace(/\*\*([^*\n]+)\*\*/g, "*$1*");          // **bold** → *bold*
}

// ─── TRANSCRIPCIÓN DE NOTAS DE VOZ (Whisper) ─────────────────────
// Se activa añadiendo OPENAI_API_KEY en Railway; sin ella devuelve null y el webhook
// cae a la salida de "escríbemelo en texto". Flujo: media id de Meta → URL firmada →
// descarga del audio → Whisper → texto.
async function transcribeAudio(mediaId) {
  if (!OPENAI_API_KEY || !mediaId) return null;
  try {
    const meta = await axios.get(`${GRAPH_BASE}/${mediaId}`,
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }, timeout: 15000 });
    const bin = await axios.get(meta.data.url,
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }, responseType: "arraybuffer", timeout: 30000, maxContentLength: 25 * 1024 * 1024 });
    const fd = new FormData(); // global en Node 18+
    fd.append("file", new Blob([bin.data], { type: meta.data.mime_type || "audio/ogg" }), "voice.ogg");
    fd.append("model", "whisper-1");
    const r = await axios.post("https://api.openai.com/v1/audio/transcriptions", fd,
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }, timeout: 60000 });
    const out = ((r.data && r.data.text) || "").trim();
    if (out) console.log(`[${PROJECT_NAME}] Nota de voz transcrita (${out.length} chars)`);
    return out || null;
  } catch (e) {
    console.error(`[${PROJECT_NAME}] transcribeAudio error: ${e.response?.status || ""} ${e.message}`);
    return null;
  }
}

// Marca el mensaje entrante como leído (ticks azules) y, opcionalmente, muestra el indicador
// "escribiendo…" hasta 25s o hasta que llegue la respuesta. Best-effort: nunca rompe el flujo.
async function markRead(messageId, typing = false) {
  if (!messageId || !WHATSAPP_PHONE_ID || !WHATSAPP_TOKEN) return;
  const payload = { messaging_product: "whatsapp", status: "read", message_id: messageId };
  if (typing) payload.typing_indicator = { type: "text" };
  try {
    await axios.post(`${GRAPH_BASE}/${WHATSAPP_PHONE_ID}/messages`, payload,
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } });
  } catch (e) { /* best-effort */ }
}

// ─── BIBLIOTECA DE MEDIA (fotos/vídeos que el bot puede enviar; se gestiona desde el panel) ──
// ¿El cliente está diciendo que la foto/vídeo no le llegó? Desbloquea el dedup de media: un
// reenvío pedido a propósito no es el doble-envío espontáneo que ese guardrail existe para frenar.
// Self-check: test-media-resend.js
function customerAskedAgain(text) {
  return /\b(?:did\s?n[o']?t|have\s?n[o']?t|has\s?n[o']?t|not)\b[^.]{0,25}\b(?:receiv|arriv|come|came|show|get|got)|still\s+(?:nothing|no|not)|no\s+video|send\s+(?:it|them|again)|again\s*\?/i.test(text || "");
}

// Qué items de la biblioteca se mandan de verdad. El dedup por URL evita el doble envío
// espontáneo (el modelo repite [MEDIA:label] en un turno posterior sin que nadie lo pida), pero
// tiene DOS excepciones y las dos vienen de fallos reales en producción:
//  · askedAgain — el cliente dice que no le llegó. Pedirlo otra vez gana al guardrail.
//  · narrated  — saltó el rescate, o sea que el TEXTO ya prometió los vídeos. Callarlos aquí
//    reproduce exactamente el bug que el rescate existe para matar: mensaje que promete y no
//    entrega. Si nos hemos comprometido en el texto, se manda. (Pasó de verdad: el rescate
//    disparó y el dedup lo anuló acto seguido, porque el historial tenía esas URLs de un envío
//    manual de prueba hecho horas antes desde el panel.)
// Self-check: test-media-resend.js
function mediaToSend({ wanted, mediaLib, history, askedAgain, narrated }) {
  const skipDedup = askedAgain || narrated;
  const alreadySent = skipDedup
    ? new Set()
    : new Set(history.filter((m) => m.media && m.media.url).map((m) => m.media.url));
  return mediaLib.filter((m) => wanted.includes(String(m.label).toLowerCase()) && !alreadySent.has(m.url));
}

// Títulos de la biblioteca escritos como texto suelto = intención de enviar ese item sin haber
// emitido la etiqueta. Devuelve el reply sin esas líneas + los items a mandar de verdad.
// Solo cuenta si el título ocupa la línea entera: dentro de una frase sería un falso positivo.
// Self-check: test-media-resend.js
function rescueNarratedMedia(reply, mediaLib) {
  const rescued = [];
  for (const item of mediaLib) {
    const title = String(item.caption || item.label).trim();
    if (title.length < 6) continue; // un título muy corto dispararía por casualidad
    const line = new RegExp(`^[ \\t]*${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*$`, "gim");
    if (line.test(reply)) { rescued.push(item); reply = reply.replace(line, ""); }
  }
  if (rescued.length) reply = reply.replace(/\n{3,}/g, "\n\n").trim();
  return { reply, rescued };
}

// Bloque de instrucciones de media para el prompt. Vive aquí y no duplicado en cada llamada
// (webhook + simulador): una regla añadida en una copia y no en la otra es deriva garantizada.
function buildMediaHint(mediaLib) {
  if (!mediaLib.length) return "";
  return "\n\nMEDIA YOU CAN SEND (real photos/videos that reinforce the pitch — use sparingly, at most 1–2 per conversation, only when it genuinely helps). For each item, 'when to use' tells you the situation to send it in; match it to what the customer is talking about. Available:\n"
    + mediaLib.map((m) => `- "${m.label}" (${m.type})${m.use ? " — when to use: " + m.use : ""}${m.caption ? " [caption sent to customer: \"" + m.caption + "\"]" : ""}`).join("\n")
    + "\nTo send, append on its own NEW line at the very end: [MEDIA:label] (exact label; several allowed comma-separated). Stripped before sending — never mention it. Only send a media item when its 'when to use' genuinely matches the moment. Only send labels from this list; never invent one."
    + "\nTHE TAG IS THE ONLY THING THAT SENDS ANYTHING. The caption travels attached to the file automatically — do NOT type the caption, the label, or a list of clip titles into your message, and do NOT announce them line by line. Writing \"Here's the clips:\" followed by their titles sends NOTHING: the customer gets a message naming videos that never arrive (this happened to a real customer three times). If you say you're sending something, the tag must be there."
    + "\nIF THE CUSTOMER SAYS IT DIDN'T ARRIVE: resend it ONCE. If they say it still hasn't landed, STOP resending — do NOT say you'll look into it or check on your end (nobody is watching that, and the conversation dies there). Give them the website link so they get the content another way, and keep the conversation moving to the next step.";
}

// Archivos subidos desde el panel (foto/vídeo local) → se guardan como blob en Redis
// y se sirven por /media/:id, para que el bot los envíe por link sin hosting externo.

// Último link de pago generado por lead (para reenviarlo sin crear un cobro nuevo).
// Envía una foto/vídeo por URL (WhatsApp Cloud API acepta media por link público).
async function sendWhatsAppMedia(to, item) {
  const toClean = normalizePhone(to);
  if (STORE_PG) { const motivo = autorizaciones.motivo(toClean, null); if (motivo) return rechazoDeEnvio(toClean, motivo); }
  const type = item.type === "video" ? "video" : "image";
  const payload = { messaging_product: "whatsapp", to: toClean, type };
  payload[type] = { link: item.url };
  if (item.caption) payload[type].caption = item.caption;
  try {
    await axios.post(`${GRAPH_BASE}/${WHATSAPP_PHONE_ID}/messages`, payload,
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } });
    console.log(`[${PROJECT_NAME}] Media "${item.label}" (${type}) enviada a ${toClean}`);
    return { ok: true };
  } catch (e) {
    const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    console.error(`[${PROJECT_NAME}] Error enviando media "${item.label}" a ${toClean}: ${detail}`);
    return { ok: false, error: detail };
  }
}

// ─── CUENTA BLOQUEADA: hay códigos de fallo que no son del mensaje sino de la CUENTA ──
// (131042 = billing restringido, 131031 = cuenta suspendida). Mientras están activos falla
// TODO envío proactivo, y la API devuelve 200 igual: el fallo llega después por el webhook
// de `statuses`. Sin esta bandera el panel dice "✓ enviado" y se queman leads a ciegas —
// el 24-jul se dispararon 13 outreach de B2K con 11 rebotes 131042 y cero aviso.
// TTL de 6h para que se cure sola aunque no llegue ningún `delivered` que la limpie.
const ACCOUNT_BLOCK_CODES = new Set([131042, 131031]);
// Pura, para poder probarla: qué hacer con un objeto `status` del webhook.
// "delivered"/"read" = prueba de vida → levanta el bloqueo. "failed" con código de cuenta → lo pone.
function classifyDeliveryStatus(st) {
  if (!st) return { action: "ignore" };
  if (st.status === "delivered" || st.status === "read") return { action: "clear" };
  if (st.status !== "failed") return { action: "ignore" };
  const err = (st.errors && st.errors[0]) || {};
  const code = Number(err.code);
  return {
    action: "fail",
    code: Number.isFinite(code) ? code : null,
    detail: err.error_data?.details || err.message || err.title || "",
    accountBlock: ACCOUNT_BLOCK_CODES.has(code),
  };
}

// Mensaje de PLANTILLA — NÚCLEO SIN FRENO DE TESTING.
// Espejo exacto de sendWhatsAppResult respecto a sendWhatsApp: aquí vive el envío, y el
// freno vive en el envoltorio de abajo. Por eso `getWaBlocked()` se queda AQUÍ y no sube
// al envoltorio: no es el freno de testing, es estado de la cuenta de WhatsApp, y aplica
// hable quien hable — una plantilla contra una cuenta bloqueada rebota seguro, la mande
// el bot o una persona.
// Lo usa quien habla por su propia boca: una persona del estudio desde la intranet.
async function sendWhatsAppTemplateResult(to, templateName, langCode, bodyParams = []) {
  const toClean = normalizePhone(to);
  if (STORE_PG) {
    const motivo = autorizaciones.motivo(toClean, null);
    if (motivo) return rechazoDeEnvio(toClean, motivo);
  } else if (await getOptOut(toClean)) {
    console.log(`[${PROJECT_NAME}] 🚫 Plantilla "${templateName}" BLOQUEADA a ${toClean}: pidio la baja (STOP)`);
    return { ok: false, error: "el lead pidio la baja (STOP)" };
  }
  const blocked = await getWaBlocked();
  if (blocked) {
    console.error(`[${PROJECT_NAME}] Plantilla "${templateName}" NO enviada a ${toClean} — cuenta bloqueada (code ${blocked.code})`);
    return { ok: false, error: `Cuenta de WhatsApp bloqueada (code ${blocked.code}): ${blocked.detail}` };
  }
  const clean = (s) => String(s).replace(/[\r\n\t]+/g, " ").replace(/ {4,}/g, "   ").trim();
  const components = bodyParams.length
    ? [{ type: "body", parameters: bodyParams.map((t) => ({ type: "text", text: clean(t) || "-" })) }]
    : [];
  try {
    const resp = await axios.post(
      `${GRAPH_BASE}/${WHATSAPP_PHONE_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: toClean,
        type: "template",
        template: { name: templateName, language: { code: langCode || "es" }, components },
      },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    );
    console.log(`[${PROJECT_NAME}] Plantilla "${templateName}" enviada a ${toClean}`);
    /* El wamid es lo único que permite atar después un `delivery_failed` del webhook de
       `statuses` a ESTE envío. Una plantilla puede devolver 200 y rebotar segundos más
       tarde en asíncrono: sin el identificador, el panel dice "enviado" y nadie se entera
       de lo contrario (24-jul: 13 outreach de B2K, 11 rebotes, cero aviso). */
    return { ok: true, wamid: resp.data?.messages?.[0]?.id || null };
  } catch (e) {
    const data = e.response?.data;
    const detail = data ? JSON.stringify(data) : e.message;
    console.error(`[${PROJECT_NAME}] Error enviando plantilla "${templateName}" a ${toClean}:`, detail);
    // El código viaja aparte del blob: quien llama lo necesita para traducirlo a algo
    // que un comercial entienda, en vez de enseñarle el JSON crudo de Meta.
    return { ok: false, error: detail, code: data?.error?.code ?? null };
  }
}

// Envoltorio con el FRENO DE TESTING: lo usa el BOT (followupTick, reminderTick,
// sendIntro, aviso al owner). Ver el invariante de envío más arriba.
async function sendWhatsAppTemplate(to, templateName, langCode, bodyParams = []) {
  if (!isAllowed(to)) {
    console.log(`[${PROJECT_NAME}] 🧪 TESTING — plantilla "${templateName}" BLOQUEADA a ${normalizePhone(to)} (no está en BOT_ALLOWLIST)`);
    return { ok: false, error: "modo testing: destinatario fuera de BOT_ALLOWLIST" };
  }
  return sendWhatsAppTemplateResult(to, templateName, langCode, bodyParams);
}

// ─── OUTREACH: el bot inicia la conversación con un lead del formulario de Meta ──
// El lead aún no ha escrito → fuera de la ventana de 24h SOLO se puede contactar con
// una PLANTILLA aprobada (INTRO_TEMPLATE_NAME, {{1}}=nombre). Tras enviarla, se siembra
// la conversación para que Daniel tenga contexto y no vuelva a saludar cuando respondan.
async function sendIntro(phone) {
  const lead = (await getLead(phone)) || { phone };
  const firstName = (lead.name || "").trim().split(/\s+/)[0] || "there";
  if (!INTRO_TEMPLATE_NAME) {
    return { ok: false, error: "Falta INTRO_TEMPLATE_NAME: crea y aprueba una plantilla de bienvenida en Meta (categoría Marketing, body con {{1}}=nombre) y configúrala en Railway." };
  }
  const nVars = INTRO_TEMPLATE_VARS != null ? parseInt(INTRO_TEMPLATE_VARS) : 1;
  const params = nVars >= 1 ? [firstName] : [];
  const r = await sendWhatsAppTemplate(phone, INTRO_TEMPLATE_NAME, INTRO_TEMPLATE_LANG, params);
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || "envío fallido" };
  await updateLeadFields(phone, { outreached: true, outreachedAt: Date.now() });
  try {
    const history = await getConversation(phone);
    const helpWith = PLAYBOOK.helpWith;
    history.push({ role: "assistant", content: `Hey ${firstName}! 👋 Saw you filled out our Instagram form — I'm ${PERSONA_NAME} from ${PROJECT_NAME}, here to help with ${helpWith}. What would you like to know?`, ts: Date.now(), by: "bot" });
    await saveConversation(phone, history);
  } catch (e) { /* best-effort */ }
  await logEvent(phone, "outreach");
  return { ok: true };
}

// Avisa al owner. Usa plantilla si está configurada; si no, texto libre (solo llega si su ventana 24h está abierta).
async function notifyOwner(kind, lead) {
  if (!OWNER_PHONE) return;
  const label = kind === "booking" ? "🔔 LEAD CALIENTE — quiere reservar"
    : kind === "handoff" ? "🙋 TRASPASO A PERSONA — el bot ha callado en este chat"
    : "🟡 Nuevo cliente interesado";
  const who = lead.name || lead.phone;
  const msg = lead.lastMessage || "";

  if (ALERT_TEMPLATE_NAME) {
    const vars = ALERT_TEMPLATE_VARS != null ? parseInt(ALERT_TEMPLATE_VARS) : 2;
    let params = [];
    if (vars === 1) params = [`${label}: ${who} — "${msg}"`];
    else if (vars === 2) params = [who, msg];
    else if (vars >= 3) params = [label, who, msg];
    await sendWhatsAppTemplate(OWNER_PHONE, ALERT_TEMPLATE_NAME, ALERT_TEMPLATE_LANG, params);
  } else {
    // Plan B: texto libre (puede fallar si el owner no escribió al bot en las últimas 24h)
    await sendWhatsApp(
      OWNER_PHONE,
      `${label} — ${PROJECT_NAME}\n\n${who}\nÚltimo mensaje: "${msg}"\n\n(Configura ALERT_TEMPLATE_NAME para recibir esto siempre.)`
    );
  }
}

// Aviso al owner cuando el modo testing ha frenado a un lead REAL. Va aparte de notifyOwner
// a propósito: aquel solo dispara con `!prev` ("ficha nueva"), y en este caso los leads que
// más importan son justo los que YA tienen ficha de la etapa HUMAN_ONLY — los cálidos. Con
// `!prev` esos no avisarían nunca y se quedarían mudos sin que nadie se entere.
// Clave propia (`testnotif:`) para no pisar el nivel de NOTIFY_RANK de notifyOwner.
async function notifyOwnerTesting(phone, name, lastMessage, { yaDecidido = false } = {}) {
  if (!OWNER_PHONE) return;
  const clean = normalizePhone(phone);
  try {
    if (!yaDecidido && await testNotifYaAvisado(clean)) return;
    await sendWhatsApp(
      OWNER_PHONE,
      `🧪 ${PROJECT_NAME} — lead real frenado por el modo testing\n\n` +
      `${name || "Sin nombre"}\nTel: +${clean}\n` +
      `Último mensaje: "${String(lastMessage || "").slice(0, 300)}"\n\n` +
      `El bot NO le ha respondido y NO le ha marcado el mensaje como leído. ` +
      `Está en el panel marcado como "esperando", listo para que le contestes a mano.`
    );
  } catch (e) {
    console.error(`[${PROJECT_NAME}] No se pudo avisar del lead frenado ${clean}:`, e.message);
  }
}

function normalizePhone(p) {
  return (p || "").replace(/\D/g, "");
}

function isOwner(from) {
  if (!OWNER_PHONE) return false;
  const ownerClean = normalizePhone(OWNER_PHONE);
  const fromClean = normalizePhone(from);
  // Compare last 9 digits (covers different country code formats)
  return ownerClean.slice(-9) === fromClean.slice(-9);
}

// Comparación EXACTA de dígitos (BOT_STORE=postgres): lo que decide quién puede tomar una escalación y reenviar su respuesta a un cliente no puede
// ser «los últimos 9 dígitos» (dos móviles de países distintos los comparten y el fallo sería fail-open). OWNER_PHONE debe llevar prefijo de país.
function esOwnerExacto(from) {
  const o = normalizePhone(OWNER_PHONE);
  return !!o && o === normalizePhone(from);
}

// ─── HEALTH (monitor externo) ──────────────────────────────────────
// Para UptimeRobot / Better Stack: paso 1 del apartado 4 de contexto/infraestructura_2026.md,
// que estuvo escrito sin construir hasta el 28-jul-2026. Antes de esto la única señal de vida era
// un 404 de Express, que no distingue un bot sano de uno con el webhook desuscrito.
// Va SIN auth a propósito (un monitor no puede llevar la clave del panel) y por eso NO expone
// recuento de leads ni nada del negocio — eso se queda en /admin/api/health, que sí va autenticado.
// No toca Claude ni Sheets: el check no debe gastar cuota de nada.
// ponytail: 200 mientras el proceso sirva. El estado de Redis viaja informativo y NO cambia el
// código de respuesta: Redis reconecta solo (ver reconnectStrategy), así que devolver 503 por un
// corte transitorio serían falsas alarmas de madrugada. Si algún día hay que paginar por Redis
// caído, el sitio es este.
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    project: PROJECT_NAME,
    storage: STORE_PG ? "postgres" : almacenNombre(),
    uptime_s: Math.round(process.uptime()),
  });
});

// ─── WEBHOOK VERIFICATION ─────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === WHATSAPP_VERIFY_TOKEN) {
    console.log(`[${PROJECT_NAME}] Webhook verificado`);
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ─── WEBHOOK — RECIBE MENSAJES ────────────────────────────────────
// Firma: el VERIFY_TOKEN solo protege el handshake GET; los POST se autentican con
// X-Hub-Signature-256 (HMAC-SHA256 del raw body con el App Secret). Sin META_APP_SECRET
// configurado se acepta todo (compatibilidad hasta añadir la variable en Railway).
function validSignature(req) {
  if (!META_APP_SECRET) return true;
  const header = req.get("x-hub-signature-256") || "";
  if (!header.startsWith("sha256=") || !req.rawBody) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", META_APP_SECRET).update(req.rawBody).digest("hex");
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// BOT_STORE=postgres: sin META_APP_SECRET no se acepta NADA (el modo redis conserva su compatibilidad de siempre). Se comprueba ANTES de cualquier llamada a la base.
function validSignatureEstricta(req) {
  if (!META_APP_SECRET) return false;
  return validSignature(req);
}

// Dedup por wamid: Meta reintenta la entrega si no confirma rápido → el mismo mensaje
// puede llegar 2+ veces y el bot respondería doble. TTL 24h (los reintentos son de minutos).

// UN TURNO A LA VEZ POR LEAD. Dos mensajes seguidos del mismo cliente lanzaban dos handlers en
// paralelo: los dos leen el historial ANTES de que el otro lo guarde, así que Claude contesta dos
// veces sin ver la segunda pregunta y el último `saveConversation` PISA el turno del primero. Con
// la pausa de tecleo la ventana pasa de ~3s a ~20s, o sea que deja de ser un caso de laboratorio.
// Cola en memoria porque el servicio corre con 1 réplica en Railway.
// ponytail: si algún día hay varias réplicas, esto pasa a un lock en Redis (SET NX + TTL).
const turnQueue = new Map();
async function waitMyTurn(phone) {
  const prev = turnQueue.get(phone);
  let release;
  const mine = new Promise((r) => { release = r; });
  turnQueue.set(phone, mine);            // el siguiente ya espera por mí antes de que yo espere a nadie
  if (prev) await prev;
  return () => {
    release();
    if (turnQueue.get(phone) === mine) turnQueue.delete(phone);
  };
}

const webhookRedis = async (req, res) => {
  if (!validSignature(req)) {
    console.warn(`[${PROJECT_NAME}] Webhook POST con firma inválida — descartado`);
    return res.sendStatus(403);
  }
  res.sendStatus(200);

  let releaseTurn = null;
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];

    // ── Estados de entrega de Meta (sent/delivered/read/FAILED) ──────────────
    // Meta los manda por ESTE MISMO webhook, sin `messages`. Antes caían en el
    // `return` de abajo y se perdían: por eso un "Plantilla enviada" (que solo
    // significa "la API aceptó la petición") podía no entregarse nunca sin dejar
    // rastro. Registramos SOLO los fallos, con el código de error de Meta, y los
    // surtimos al panel si el destinatario ya es un lead conocido.
    const statuses = change?.value?.statuses;
    if (Array.isArray(statuses) && statuses.length) {
      for (const st of statuses) {
        const c = classifyDeliveryStatus(st);
        if (c.action === "clear") { await clearWaBlocked(); continue; }  // entrega confirmada = cuenta viva
        if (c.action !== "fail") continue;                               // sent = ruido
        const detail = c.detail;
        console.error(`[${PROJECT_NAME}] ENTREGA FALLIDA a ${st.recipient_id} — code ${c.code ?? "?"}: ${detail} (wamid ${st.id})`);
        if (c.accountBlock) await setWaBlocked(c.code, detail);
        // Panel: solo si ya es lead conocido (no crear ficha para el owner ni desconocidos)
        if (!isOwner(st.recipient_id) && (await getLead(st.recipient_id))) {
          await logEvent(st.recipient_id, "delivery_failed", { code: c.code, detail: String(detail).slice(0, 200) });
        }
      }
      return; // un webhook de estado no trae mensaje que procesar
    }

    // ── Coexistence: una persona escribe desde la app WhatsApp Business del mismo número ──
    // Meta lo manda como `smb_message_echoes` (campo aparte de `messages`). Si una persona
    // ya habla con este lead, el bot se calla en ese chat para no responder por encima. Es la
    // misma pausa que el panel (`setPaused`), así que se reactiva desde el panel. Solo ecos
    // con `to` conocido: los que manda el propio bot por API no llegan por aquí.
    if (change?.field === "smb_message_echoes") {
      for (const echo of change.value?.message_echoes || []) {
        const to = String(echo?.to || "").replace(/\D/g, "");
        if (!to || isOwner(to)) continue;
        // 1º la pausa: lo que importa es que el bot se calle; el historial es un extra y no puede impedirlo.
        const yaPausado = await isPaused(to);
        await setPausedHumano(to); // cada mensaje de la persona renueva el plazo de la pausa
        if (!yaPausado) {
          if (await getLead(to)) await logEvent(to, "human_takeover", { via: "whatsapp_business_app" }); // sin ficha no se crea una vacía
          console.log(`[${PROJECT_NAME}] Persona escribió desde la app a ${to} — bot en pausa para ese chat`);
        }
        // 2º lo que dijo la persona entra al historial como mensaje humano (igual que desde el panel):
        // sin esto, al reanudar la IA no sabe qué se le prometió al cliente y se contradice.
        // Dentro del turno del lead: un turno de IA en vuelo guardaría su historial viejo encima.
        let releaseEcho = null;
        try {
          if (!(await alreadyProcessed(echo.id))) {
            releaseEcho = await waitMyTurn(to);
            const body = echo.type === "text" ? String(echo.text?.body || "").trim() : "";
            const history = await getConversation(to);
            history.push({ role: "assistant", content: body || `[${echo.type || "mensaje"}]`, ts: Date.now(), by: "human", byUser: "whatsapp_business_app", wamid: echo.id || null });
            await saveConversation(to, history);
          }
        } catch (e) {
          console.error(`[${PROJECT_NAME}] No se pudo guardar en el historial lo que escribió la persona a ${to}: ${e.message}`);
        } finally {
          if (releaseEcho) releaseEcho();
        }
      }
      return;
    }

    const message = change?.value?.messages?.[0];
    if (!message) return;
    if (await alreadyProcessed(message.id)) {
      console.log(`[${PROJECT_NAME}] Mensaje duplicado (reintento de Meta) ignorado: ${message.id}`);
      return;
    }

    const from = message.from;
    const profileName = change.value.contacts?.[0]?.profile?.name || "";
    releaseTurn = await waitMyTurn(from);   // el turno anterior de ESTE lead termina antes de seguir

    // ── Ubicación compartida → texto: el flujo normal la aprovecha (p.ej. dirección de entrega) ──
    let text;
    if (message.type === "text") {
      text = message.text.body;
    } else if (message.type === "location" && message.location) {
      const loc = message.location;
      const where = [loc.name, loc.address].filter(Boolean).join(", ") || `${loc.latitude},${loc.longitude}`;
      text = `(I'm sharing my location: ${where})`;
    } else if (message.type === "reaction") {
      // Un emoji de reacción a un mensaje no es un adjunto ilegible ni información nueva del
      // lead — antes caía en la respuesta de "no puedo abrir esto", una respuesta sin sentido.
      return;
    } else if (!isOwner(from)) {
      // ── Nota de voz → transcripción (Whisper) y entra al flujo normal como texto ──
      if (message.type === "audio" || message.type === "voice") {
        const mediaId = (message.audio && message.audio.id) || (message.voice && message.voice.id);
        const transcript = await transcribeAudio(mediaId);
        if (transcript) text = `🎤 ${transcript}`;
      }
      if (text !== undefined) {
        // transcrita con éxito → sigue por el flujo normal de texto (no entra a la salida de error)
      } else {
      // ── Media que el bot no puede leer (audio sin OPENAI_API_KEY/foto/vídeo/documento): antes
      //    se ignoraba en silencio → el lead creía que le leímos y se perdía. Ahora queda
      //    registrado y se le pide el texto; en pausa, solo se registra y se marca "por responder".
      const KIND_LABEL = { image: "[foto]", video: "[vídeo]", audio: "[audio]", voice: "[audio]", document: "[documento]", sticker: "[sticker]", contacts: "[contacto]" };
      const label = KIND_LABEL[message.type] || `[${message.type}]`;
      const history = await getConversation(from);
      history.push({ role: "user", content: label, ts: Date.now() });
      await setInbound(from, Date.now());
      await resetFollowup(from);
      const prev = await getLead(from);
      const gatedMedia = TESTING_MODE && !isAllowed(from);
      if (HUMAN_ONLY_MODE || gatedMedia || await isPaused(from)) {
        await saveConversation(from, history);
        await recordLead(from, profileName || (prev && prev.name), (prev && prev.intent) || "interested", label, "client");
        await setWaiting(from, true);
        if (HUMAN_ONLY_MODE && !prev) await notifyOwner("new", { name: profileName, phone: from, lastMessage: label });
        if (gatedMedia) await notifyOwnerTesting(from, profileName, label);
        return;
      }
      markRead(message.id); // best-effort
      const ask = (message.type === "audio" || message.type === "voice")
        ? "Sorry! I can't listen to voice notes on this end yet. Could you type it out for me? 🙏"
        : "I can't open attachments on this end yet. Could you type out the details for me? 🙏";
      await sendWhatsApp(from, ask);
      history.push({ role: "assistant", content: ask, ts: Date.now(), by: "bot" });
      await saveConversation(from, history);
      await recordLead(from, profileName || (prev && prev.name), (prev && prev.intent) || "exploring", ask, "bot");
      return;
      }
    } else {
      return; // owner mandó media: nada que reenviar
    }

    // ── Mensaje del dueño: reenviar al cliente pendiente ──────────
    if (isOwner(from)) {
      // Si el owner responde CITANDO el aviso de escalación (reply de WhatsApp), se enruta a ESE
      // cliente en concreto — con varias escalaciones abiertas ya no va a ciegas al más antiguo.
      const ctxId = message.context && message.context.id;
      let pending = await escRutaPorCita(ctxId);
      if (pending) console.log(`[${PROJECT_NAME}] Owner respondió citando → enrutado exacto a ${pending.customerName || pending.customerPhone}`);
      if (!pending) pending = await escPop();
      if (pending) {
        console.log(`[${PROJECT_NAME}] Owner respondió escalación → reenviando a ${pending.customerName || pending.customerPhone}`);
        // Va por sendWhatsAppResult, no por sendWhatsApp: esto es el owner hablando por su
        // propia boca, igual que el panel. Si fuera por el embudo del bot, el modo testing
        // callaría en silencio la única respuesta humana que sí queremos viva.
        const rf = await sendWhatsAppResult(pending.customerPhone, text);
        if (!rf.ok) console.error(`[${PROJECT_NAME}] Error reenviando respuesta del owner a ${normalizePhone(pending.customerPhone)}:`, rf.error);
      } else {
        console.log(`[${PROJECT_NAME}] Mensaje del owner pero no hay escalaciones pendientes`);
      }
      return;
    }

    // ── Mensaje normal del cliente ────────────────────────────────
    const history = await getConversation(from);
    history.push({ role: "user", content: text, ts: Date.now() });

    // ── Captura automática: si este mensaje es el formulario de Instagram, extrae sus datos ──
    const formFields = parseLeadForm(text);
    if (formFields) {
      await captureLeadData(from, formFields);
      console.log(`[${PROJECT_NAME}] Datos de formulario IG capturados para ${from}: ${Object.keys(formFields).join(", ")}`);
    }

    /* ── Baja a petición del lead ──────────────────────────────────────────────
       Va ANTES de cualquier otra cosa y antes de la IA: quien escribe STOP no quiere
       una respuesta ingeniosa, quiere dejar de recibir mensajes. Se marca la baja, se
       pausa para que la IA no vuelva a entrar, y se acusa recibo UNA vez — un silencio
       total deja al lead sin saber si ha funcionado y acaba marcando como spam, que es
       justo lo que degrada la calidad del número. */
    if (PALABRAS_BAJA.test(text)) {
      /* El acuse va ANTES de marcar la baja, y el orden es deliberado: en cuanto está
         marcada, el propio camino de envío la bloquea (ver los dos núcleos de envío) y
         el acuse no saldría. Así no hace falta una excepción para saltarse el bloqueo,
         y un bloqueo sin excepciones es el que no se rompe al añadir la siguiente. */
      if (!(await getOptOutAck(from))) {
        await setOptOutAck(from);
        await sendWhatsAppResult(from, ACUSE_DERECHOS); // nunca dice «borrado»: el equipo confirma en 30 dias como maximo (Legal, b.1)
        // Solicitud de derechos: tarea en el CRM (nota con prefijo; en sombra solo log) + aviso al owner, que no depende del CRM. Nunca rompe la baja.
        try { await aplicaCrm({ notas: [notaDerechos(text)], citas: [] }, from, `${message.id}d`, profileName); }
        catch (e) { console.error(`[${PROJECT_NAME}] nota de solicitud de derechos falló: ${e.message}`); }
        try { if (OWNER_PHONE) await sendWhatsApp(OWNER_PHONE, avisoDerechos({ proyecto: PROJECT_NAME, nombre: profileName, tel: String(from), texto: text })); }
        catch (e) { console.error(`[${PROJECT_NAME}] aviso de solicitud de derechos falló: ${e.message}`); }
      }
      await setOptOut(from);
      await setPaused(from, true);
      await saveConversation(from, history);
      await recordLead(from, profileName, "lost", text, "client");
      await logEvent(from, "opt_out", { texto: text.slice(0, 80) });
      return;
    }

    // ── Control humano: si el bot está en pausa para este lead (o HUMAN_ONLY_MODE global), guarda y calla ──
    const gated = TESTING_MODE && !isAllowed(from);
    if (HUMAN_ONLY_MODE || gated || await isPaused(from)) {
      await saveConversation(from, history);
      const prev = await getLead(from);
      await recordLead(from, profileName || (prev && prev.name), (prev && prev.intent) || "interested", text, "client");
      await setInbound(from, Date.now());
      await resetFollowup(from);    // respondió → reinicia la cadencia de seguimiento
      await setWaiting(from, true); // el cliente espera respuesta humana → marcar en el panel
      if (HUMAN_ONLY_MODE && !prev) await notifyOwner("new", { name: profileName, phone: from, lastMessage: text });
      if (gated) await notifyOwnerTesting(from, profileName, text);
      console.log(`[${PROJECT_NAME}] Lead ${from} en pausa (${HUMAN_ONLY_MODE ? "HUMAN_ONLY" : gated ? "modo testing / fuera de BOT_ALLOWLIST" : "control humano"}) — mensaje guardado, bot NO responde`);
      return;
    }

    await setInbound(from, Date.now()); // reinicia la ventana de 24h de WhatsApp
    await resetFollowup(from);           // respondió → reinicia la cadencia de seguimiento
    markRead(message.id, true);          // ticks azules + "escribiendo…" mientras Claude responde
    const replyStart = Date.now();       // ancla de la pausa de tecleo: lo que tarde Claude ya cuenta

    // Media disponible (gestionada desde el panel): se inyecta para que el bot solo ofrezca lo que existe.
    const mediaLib = await getMediaLib();
    const mediaHint = buildMediaHint(mediaLib);
    // Notas del equipo (CRM → botcfg): bloque aparte SIN cache_control, para que editarlo no invalide el prefijo cacheado.
    const teamBlock = bloqueEquipo(await getBotCfg(), { primerTurno: !history.some((m) => m.role === "assistant") });
    const cat = await getCatalogoBlock(); // null con BOT_CATALOGO=off (system idéntico al de siempre)
    // Streaming (no create): evita el "Premature close" en respuestas no-stream y mantiene viva la conexión.
    const response = await claudeMessage({
      model: MODEL,
      // Thinking ADAPTIVE, no disabled: sin borrador privado el modelo razonaba EN el texto visible
      // ("self-thought" que el cliente vio en el chat, 23-jul-2026). Con adaptive, el cálculo va a un
      // bloque thinking que este server nunca envía (solo se extrae el bloque type==="text") — el
      // razonamiento no puede llegar al cliente por construcción. effort:low contiene el gasto.
      // max_tokens cubre pensamiento + respuesta; la respuesta sigue corta por prompt.
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      max_tokens: 2000,
      // Prompt caching: el system (context.md + PERSONA + BASE_INSTRUCTIONS) es idéntico en cada turno.
      // Tamaño MEDIDO 28-jul-2026 (por caracteres): ~25k tok en la rama b2k, ~16k en balibest — el
      // "~11.5k" que decía aquí antes se había quedado a la mitad. El mínimo cacheable es 1.024 tok
      // tanto en Sonnet 4.6 como en Sonnet 5, así que hay margen de 16-24x: no es algo que vigilar.
      //
      // NO cambiar a ttl:"1h" sin volver a medir. Medido sobre 214 llamadas reales de B2K (14,8 días):
      // el TTL de 5 min ya acierta el 73,7% y cuesta 0,402x; el de 1h acierta 85% pero la escritura
      // sube de 1,25x a 2x, así que se queda en 0,385x — ~$0,37/mes de diferencia. No compensa.
      // La razón de que 5 min basten: la caché es GLOBAL por bot (mismo system para todos los leads),
      // así que la mantiene caliente el tráfico entero, no el ritmo de una conversación suelta.
      //
      // mediaHint va en bloque aparte tras el prefijo cacheado (cambia solo al editar la media library).
      system: [
        { type: "text", text: buildSystemPrompt(), cache_control: { type: "ephemeral" } },
        ...bloquesCatalogoCrm(cat),
        { type: "text", text: dateHint() },
        ...(mediaHint ? [{ type: "text", text: mediaHint }] : []),
        ...(teamBlock ? [{ type: "text", text: teamBlock }] : []),
      ],
      messages: history.slice(-20).map((m) => ({ role: m.role, content: paraModelo(m) })), // prompt = últimos 20; el resto es historial del panel
    });

    const _textBlock = response.content.find((b) => b.type === "text");
    let reply = (_textBlock && _textBlock.text) || "";
    if (!reply.trim()) { // sin texto (p.ej. refusal / respuesta vacía) → no mandamos vacío
      console.warn(`[${PROJECT_NAME}] Respuesta del modelo sin texto (stop_reason: ${response.stop_reason}) — no se envía nada a ${from}`);
      return;
    }
    const intentMatch = reply.match(/\[INTENT:(\w+)\]/);
    const intent = intentMatch ? intentMatch[1] : "exploring";
    const ridersMatch = reply.match(/\[RIDERS:(\d+)\]/);
    const numRiders = ridersMatch ? parseInt(ridersMatch[1]) : null;
    const apptMatch = reply.match(/\[APPT:([^\]|]+)\|([^\]]+)\]/);
    const mediaMatch = reply.match(/\[MEDIA:([^\]]+)\]/i);
    const resendMatch = /\[RESEND_LINK\]/i.test(reply); // el cliente pide reenviar el link que ya recibió
    let leadFields = parseLeadTag(reply); // datos confirmados en la charla → ficha/BD
    const traspaso = pideTraspaso(reply); // [HUMANO]: solo la escribe el modelo (al cliente se le sanea en paraModelo); se ejecuta tras responder
    const crmTags = BOT_CRM_MODE !== "off" ? extraeEtiquetas(reply) : null; // [NOTA]/[CITA] del modelo: se ejecutan con el teléfono del webhook, tras responder
    const crmIlegibles = CRM_EFECTIVO !== "off" ? citasIlegibles(reply) : 0; // [CITA:...] mal escritas: sin esto cleanReply las borra y la cita queda muda
    reply = cleanReply(reply); // etiquetas internas + guion + markdown de WhatsApp (helper compartido)
    if (traspaso && !reply.trim()) reply = "I'll pass you to a team member who can help you personally."; // solo escribió la etiqueta: el cliente no puede quedarse sin la frase de cierre
    reply = aplicaAviso(reply, { enviar: PLAYBOOK.avisoIA === true && debeAvisar(history), cliente: history.filter((m) => m.role === "user").slice(-3).map((m) => m.content) }); // aviso de asistente (IA) de Legal: lo pone el SERVIDOR (primer mensaje y tras 24 h); solo con avisoIA en el playbook (Lawang)
    postCheckPrecios(reply, cat, history, from); // solo log

    // ── Stripe checkout session dinámica ──────────────────────────
    // SIEMPRE quitar cualquier link de pago que el modelo haya alucinado.
    // El modelo NO conoce sesiones reales (book.stripe.com / checkout.stripe.com/cs_live…):
    // cualquier URL que escriba es FALSA. Limpiar incondicionalmente, no solo con Stripe activo.
    const hadFakeLink = /https?:\/\/(book|checkout|pay)\.stripe\.com\/\S*/i.test(reply);
    reply = reply
      .replace(/https?:\/\/(book|checkout|pay)\.stripe\.com\/\S*/gi, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (hadFakeLink) console.warn(`[${PROJECT_NAME}] Stripe URL alucinada eliminada del reply del modelo`);

    // Adjuntar el link real SOLO si el cliente pide pagar ya (intent booking + riders).
    // El cierre por defecto es la LLAMADA, no el pago — el link es la excepción.
    if (numRiders && stripeClient && intent === "booking") {
      const sessionUrl = await createStripeSession(numRiders);
      if (sessionUrl) { reply = reply + "\n\n" + sessionUrl; await setLastLink(from, sessionUrl); }
      else console.error(`[${PROJECT_NAME}] booking detectado pero no se pudo crear la sesión Stripe`);
    } else if (numRiders && intent === "booking" && !stripeClient) {
      console.error(`[${PROJECT_NAME}] booking detectado pero stripeClient es null — falta STRIPE_SECRET_KEY en el entorno`);
    } else if (resendMatch) {
      // El cliente pidió reenviar el link que YA recibió → mismo link, sin crear un cobro nuevo.
      const last = await getLastLink(from);
      if (last) reply = reply + "\n\n" + last;
      else console.warn(`[${PROJECT_NAME}] [RESEND_LINK] pedido pero no hay link previo para ${from} (el bot no debería prometerlo)`);
    }

    // RESCATE de media narrada: el modelo a veces escribe los TÍTULOS de los clips en el texto en
    // vez de emitir [MEDIA:label] → el cliente recibe un mensaje que nombra vídeos que nunca llegan.
    // Corregirlo por prompt NO basta: en un hilo donde ya lo hizo, el modelo copia sus propios
    // turnos anteriores y esa imitación gana a cualquier regla del system (verificado — en sesión
    // nueva obedece, en el hilo contaminado no). Por eso el arreglo es determinista: si el texto
    // nombra un item de la biblioteca en su propia línea y no hay etiqueta, esa ES la intención de
    // enviarlo. Se quita el título del texto y se manda de verdad. Limpiar el reply ANTES de
    // guardarlo en el historial además descontamina el hilo para los turnos siguientes.
    let rescued = [];
    if (!mediaMatch && mediaLib.length) {
      ({ reply, rescued } = rescueNarratedMedia(reply, mediaLib));
      if (rescued.length) console.warn(`[${PROJECT_NAME}] [MEDIA] RESCATE: el modelo escribió los títulos sin etiqueta (${rescued.map((r) => r.label).join(", ")}) — se envían de verdad`);
    }

    history.push({ role: "assistant", content: reply, ts: Date.now(), by: "bot" });
    await saveConversation(from, history);

    await sendHumanized(from, reply, message.id, replyStart);
    // Fotos/vídeos que el bot decidió enviar ([MEDIA:label]) → se buscan en la biblioteca, se mandan y se anotan en el historial.
    if (mediaMatch || rescued.length) {
      const wanted = mediaMatch
        ? mediaMatch[1].split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
        : rescued.map((r) => String(r.label).toLowerCase());
      const toSend = mediaToSend({ wanted, mediaLib, history, askedAgain: customerAskedAgain(text), narrated: rescued.length > 0 });
      for (const item of toSend) {
        await sendWhatsAppMedia(from, item);
        history.push({ role: "assistant", content: item.caption || (item.type === "video" ? "[vídeo]" : "[foto]"), ts: Date.now(), by: "bot", media: { type: item.type, url: item.url, caption: item.caption || "" } });
      }
      if (toSend.length) await saveConversation(from, history);
      if (wanted.length && !toSend.length) {
        // Distinguir las dos causas: el bot dice "aquí van los vídeos" igual, así que un fallo mudo
        // aquí se lee como entrega correcta. La etiqueta equivocada (caption en vez de label) y el
        // dedup son fallos distintos y se arreglan distinto.
        const known = new Set(mediaLib.map((m) => String(m.label).toLowerCase()));
        const unknown = wanted.filter((w) => !known.has(w));
        console.warn(`[${PROJECT_NAME}] [MEDIA] pedido "${wanted.join(", ")}" NO enviado — `
          + (unknown.length ? `label inexistente en la biblioteca: ${unknown.join(", ")}` : "ya se había enviado en esta conversación (dedup)"));
      }
    }
    await setWaiting(from, false); // el bot ya respondió → no queda pendiente
    await saveLead(from, profileName, text, intent);
    await recordLead(from, profileName, intent, reply, "bot");  // índice para el panel web (preview = última respuesta del bot)
    // Backstop de waitlist: si el bot PROMETIÓ seguir más adelante pero no fijó followup,
    // lo fijamos igual → el lead no se pierde, se suprime el auto-nudge (followupTick salta los
    // /waitlist/) y el owner recibe recordatorio en fecha (followUpReminderTick). La persona
    // debería taggear sola; esto cubre cuando el modelo lo olvida (como pasó con Keith).
    const promisedLater = /\b(make a note|made a note|let you know|keep you posted|add you to (?:the|our) (?:list|waitlist)|wait[- ]?list|when [^.]*\b(?:dates?|departures?|trip)\b[^.]*\b(?:open|confirm|available|firm|announced))\b/i.test(reply);
    if (promisedLater && intent !== "booking" && !apptMatch) {
      const lf = leadFields || {};
      const hasWl = Array.isArray(lf.tags) && lf.tags.some((t) => /waitlist/i.test(t));
      if (!lf.nextFollowUp || !hasWl) {
        const d = new Date(Date.now() + 60 * 24 * 3600 * 1000); // +60 días como fecha segura por defecto
        const defFu = d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
        lf.tags = Array.from(new Set([...(Array.isArray(lf.tags) ? lf.tags : []), "guided-waitlist"]));
        if (!lf.nextFollowUp) lf.nextFollowUp = defFu;
        leadFields = lf;
        console.log(`[${PROJECT_NAME}] Waitlist backstop aplicado a ${from} (promesa de seguimiento sin followup explícito)`);
      }
    }
    if (leadFields) {
      await captureLeadData(from, leadFields);
      console.log(`[${PROJECT_NAME}] Datos extraídos de la charla para ${from}: ${Object.keys(leadFields).join(", ")}`);
    }

    // ── Cita agendada por el bot en la conversación ───────────────
    // Con BOT_CRM=on las citas van por [CITA:...] (la base es su único dueño): una [APPT] que el modelo emita igualmente NO se guarda en Redis,
    // y se avisa al owner con los datos, porque el cliente ya cree que está agendada.
    // En sombra el modelo ya no ve [APPT]: solo una [CITA] ilegible se queda sin guardar (la [APPT] suelta, rara, sigue por la via vieja).
    if ((CRM_EFECTIVO === "on" && (apptMatch || crmIlegibles > 0)) || (CRM_EFECTIVO === "sombra" && crmIlegibles > 0 && !apptMatch)) {
      console.error(`[${PROJECT_NAME}] cita sin registrar con BOT_CRM=${CRM_EFECTIVO}: …${String(from).slice(-4)} appt=${apptMatch ? apptMatch[1].trim().slice(0, 40) : "no"} ilegibles=${crmIlegibles}`);
      // Si además hay una [CITA] legible, esa ya avisa por su cuenta: no se duplica el aviso por la [APPT].
      const yaAvisa = crmTags && crmTags.citas.length > 0;
      if (OWNER_PHONE && !(apptMatch && !crmIlegibles && yaAvisa)) {
        try {
          const texto = avisoCita({ proyecto: PROJECT_NAME, nombre: profileName, tel: String(from),
            hecho: { accion: "lead_cita", resultado: apptMatch ? "etiqueta_antigua" : "etiqueta_ilegible", tipo: "llamada", cuando: apptMatch ? apptMatch[1].trim() : "?", zona: "" } });
          if (texto) await sendWhatsApp(OWNER_PHONE, texto);
        } catch (e) { console.error(`[${PROJECT_NAME}] aviso de cita sin registrar falló: ${e.message}`); }
      }
    } else if (apptMatch) {
      try {
        const appt = await createAppt({ phone: from, name: profileName, when: apptMatch[1].trim(), title: apptMatch[2].trim() });
        console.log(`[${PROJECT_NAME}] Cita agendada por el bot: ${appt.when} — ${appt.title} (${from})`);
        // Avisar al owner en el momento para que llame (el panel/calendario es el respaldo)
        if (OWNER_PHONE) {
          await sendWhatsApp(
            OWNER_PHONE,
            `📞 ${PROJECT_NAME} — LLAMADA AGENDADA\n\n*${profileName || from}*\nTel: ${from}\nCuándo: ${appt.when}\n${appt.title}\n\nLlámale por WhatsApp a esa hora.`
          );
        }
      } catch (e) { console.error(`[${PROJECT_NAME}] Error creando cita:`, e.message); }
    }

    // ── Escalación: notificar al dueño en silencio ────────────────
    if (intent === "escalate" && OWNER_PHONE) {
      const entry = await escPush(from, profileName, text);
      const rNotif = await sendWhatsAppResult(
        OWNER_PHONE,
        `❓ ${PROJECT_NAME} — pregunta sin respuesta\n\n*${profileName || from}* pregunta:\n"${text}"\n\nResponde CITANDO este mensaje (mantén pulsado → Responder) y se lo reenviaré.`
      );
      // Mapa wamid→escalación: si el owner responde citando, se enruta a este cliente exacto.
      if (rNotif.ok && rNotif.id) await escMapGuardar(rNotif.id, entry);
      if (!rNotif.ok) console.error(`[${PROJECT_NAME}] Error enviando escalación al owner: ${rNotif.error}`);
      console.log(`[${PROJECT_NAME}] Escalación registrada — ${profileName || from}: "${text.slice(0, 60)}"`);
    }

    // ── Aviso al owner: interesado (1ª vez) y caliente (1ª vez) ────
    // Panel = todos los leads · Ping WhatsApp = solo interested + booking, una vez cada uno.
    const rank = NOTIFY_RANK[intent] || 0;
    if (rank > 0 && OWNER_PHONE) {
      const alreadyRank = NOTIFY_RANK[await getNotifiedLevel(from)] || 0;
      if (rank > alreadyRank) {
        await notifyOwner(intent, { name: profileName, phone: from, lastMessage: text });
        await setNotifiedLevel(from, intent);
      }
    }

    // ── Traspaso a una persona ([HUMANO]): el bot ya ha dicho la frase de cierre; ahora se calla en este chat (misma pausa que la operadora),
    //    avisa al owner y deja una nota en el CRM. Sobre el teléfono del webhook, idempotente, nunca rompe la conversación. ──
    if (traspaso) {
      await ejecutaTraspaso({
        tel: from,
        estaPausado: () => isPaused(from),
        pausa: async () => { await setPausedHumano(from); await setWaiting(from, true); },
        avisa: () => notifyOwner("handoff", { name: profileName, phone: from, lastMessage: text }),
        nota: CRM_EFECTIVO === "off" ? null : () => aplicaCrm( // sombra: aplicaCrm solo escribe el log
          { notas: [`Handed over to a team member by the assistant. Customer's last message: "${String(text).slice(0, 200)}"`], citas: [] },
          from, `${message.id}h`, profileName),
        log: (m) => console.log(`[${PROJECT_NAME}] ${m}`),
      });
    }

    // ── CRM del ERP (BOT_CRM): notas y citas etiquetadas por el modelo. Va DESPUÉS de los avisos al owner: con la edge
    //    lenta son hasta 4 llamadas de 5 s y no deben retrasar la escalación. Nunca rompe la conversación. ──
    await aplicaCrm(crmTags, from, message.id, profileName);

    // ── Enriquecimiento oportunista (no bloquea): si a la ficha le faltan datos
    //    que el chat ya tiene, los extrae en segundo plano. Debounce 15 min. ──
    const freshLead = await getLead(from);
    if (leadMissingKeyFields(freshLead) &&
        (!freshLead.enrichedAt || Date.now() - freshLead.enrichedAt > 15 * 60 * 1000)) {
      enrichLeadFromConversation(from).catch(() => {});
    }
  } catch (e) {
    console.error(`[${PROJECT_NAME}] Error procesando mensaje:`, e.message);
  } finally {
    if (releaseTurn) releaseTurn();   // sin esto, un fallo deja al lead sin poder volver a escribir
  }
};
// ─── BOT_STORE=postgres: webhook, rutas del panel y recordatorio de turno-pg.js ─────────────────────────────
// El handler de arriba (webhookRedis) no se ha tocado: con BOT_STORE=redis el comportamiento es el de siempre. S9 lo borra.
let webhookPg = null, turnoPg = null;
if (STORE_PG) {
  const { creaPg } = await import("./store/postgres.js");
  const logPg = (m) => console.log(`[${PROJECT_NAME}] ${m}`);
  const edgeSecret = (n) => String(process.env[n] || "").trim();
  // Plazos de fiabilidad (valores por defecto del plan; las variables existen para poder ajustarlos sin tocar código y para las pruebas).
  const listaMs = (v, def) => { const l = String(v || "").split(",").map((x) => parseInt(x, 10)).filter((n) => Number.isFinite(n) && n >= 0 && n <= 600000); return l.length ? l : def; };
  const numMs = (v, def, max) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 && n <= max ? n : def; };
  const pgCli = creaPg({
    url: BOT_API_URL, log: logPg,
    timeoutMs: numMs(process.env.BOT_API_TIMEOUT_MS, 10000, 60000), pausaReintentoMs: numMs(process.env.BOT_API_PAUSA_REINTENTO_MS, 300, 10000),
    secretos: { estado: edgeSecret("BOT_API_SECRET_ESTADO"), recordatorio: edgeSecret("BOT_API_SECRET_RECORDATORIO"), humano: edgeSecret("BOT_API_SECRET_HUMANO") },
    // El aviso al dueño NO depende de la base: va directo a WhatsApp.
    onAlarma: async ({ fallos, accion, tipo, status }) => {
      console.error(`[${PROJECT_NAME}] 🚨 bot-api SIN RESPUESTA: ${fallos} fallos seguidos (último: ${accion} ${tipo}${status ? " HTTP " + status : ""})`);
      if (OWNER_PHONE) await sendWhatsAppResult(OWNER_PHONE, `🚨 ${PROJECT_NAME}: la base de datos del bot no responde (${fallos} fallos seguidos). Mientras dure, el bot NO contesta a los clientes; sus mensajes se guardan si la base los acepta y se reintenta contestarlos. Revisa la edge bot-api.`);
    },
    onRecuperado: async () => {
      console.log(`[${PROJECT_NAME}] bot-api vuelve a responder`);
      if (OWNER_PHONE) await sendWhatsAppResult(OWNER_PHONE, `✅ ${PROJECT_NAME}: la base de datos del bot vuelve a responder.`);
    },
  });
  // Cita que el cliente cree agendada y no se guardó: mismo aviso al dueño que en modo redis.
  const avisoCitaSinRegistrar = async ({ apptMatch, from, profileName }) => {
    const texto = avisoCita({ proyecto: PROJECT_NAME, nombre: profileName, tel: String(from),
      hecho: { accion: "lead_cita", resultado: apptMatch ? "etiqueta_antigua" : "etiqueta_ilegible", tipo: "llamada", cuando: apptMatch ? apptMatch[1].trim() : "?", zona: "" } });
    if (texto) await sendWhatsApp(OWNER_PHONE, texto);
  };
  turnoPg = turnoMod.creaTurnoPg({
    pg: pgCli, autoriza: autorizaciones, log: logPg, projectName: PROJECT_NAME, ownerPhone: OWNER_PHONE || "",
    esOwner: esOwnerExacto, isAllowed, testingMode: TESTING_MODE, humanOnly: HUMAN_ONLY_MODE,
    firmaValida: validSignatureEstricta, waitMyTurn, palabrasBaja: PALABRAS_BAJA, acuse: ACUSE_DERECHOS,
    claude: (params) => claudeMessage({ model: MODEL, ...params }),
    systemBlocks: (cat) => [{ type: "text", text: buildSystemPrompt(), cache_control: { type: "ephemeral" } }, ...bloquesCatalogoCrm(cat), { type: "text", text: dateHint() }],
    paraModelo: (m) => paraModelo(m), cleanReply, extraeEtiquetas, citasIlegibles, pideTraspaso,
    botCrmMode: BOT_CRM_MODE, crmEfectivo: CRM_EFECTIVO, aplicaCrm, getCatalogoBlock, postCheckPrecios,
    sendBot: sendWhatsApp, sendHumanized, sendOwner: (t) => sendWhatsAppResult(OWNER_PHONE, t),
    sendCliente: sendWhatsAppResult, sendClienteTemplate: sendWhatsAppTemplateResult,
    notifyOwner, notifyOwnerTesting: (p, n, m) => notifyOwnerTesting(p, n, m, { yaDecidido: true }), markRead, transcribeAudio,
    avisoCitaSinRegistrar, notaDerechos, avisoDerechos, clasificaEntrega: classifyDeliveryStatus, setWaBlocked, clearWaBlocked,
    resume: async ({ system, user }) => {
      const r = await claudeMessage({ model: EXTRACT_MODEL, max_tokens: 500, system, messages: [{ role: "user", content: user }] });
      const b = r.content.find((x) => x.type === "text");
      return (b && b.text) || "";
    },
    reintentosEstadoMs: listaMs(process.env.BOT_TURNO_REINTENTOS_MS, [20000, 90000]), reintentosCierreMs: listaMs(process.env.BOT_CIERRE_REINTENTOS_MS, [1000, 3000, 8000]),
    modoRecordatorio: String(process.env.BOT_RECORDATORIO || "off").trim().toLowerCase() === "postgres" ? "postgres" : "off",
    tz: CALENDAR_TZ || "Asia/Makassar",
  });
  webhookPg = turnoPg.webhook;
  // Lo que el bot ya no tiene (lo vacío o sin configurar en Lawang, decisión 7 del owner) responde 410 en vez de tocar un almacén que no existe.
  const PG_ADMIN_VIVO = new Set(["/admin/api/health", "/admin/api/wa-status", "/admin/api/templates", "/admin/api/send", "/admin/api/send-template", "/admin/api/pause", "/admin/api/simulate", "/admin/api/simulate/reset"]);
  app.use(["/admin/api", "/media", "/unsubscribe"], (req, res, next) => (PG_ADMIN_VIVO.has(req.baseUrl + req.path) ? next() : res.status(410).json({ error: "retirado_con_postgres" })));
  turnoPg.rutasAdmin(app, { adminAuth });
  // /admin/api/health y el simulador, con su memoria de proceso
  const simulaciones = new Map();
  app.get("/admin/api/health", async (req, res) => {
    if (!adminAuth(req, res)) return;
    res.json({
      storage: "postgres",
      edge: { fallos_seguidos: pgCli.fallosSeguidos, umbral_alarma: pgCli.umbral, llamadas: pgCli.llamadas },
      firma: !!META_APP_SECRET,
      envios_rechazados: autorizaciones.rechazos,
      testing: { on: TESTING_MODE, allowlist: ALLOWLIST.size, malformados: ALLOWLIST_BAD },
      catalogo: BOT_CATALOGO_MODE !== "on" ? { modo: "off" } : await (async () => { const c = await getCatalogoBlock(); return { modo: "on", estado: c ? c.estado : "error", unidades: c ? c.unidades.length : 0, desde: c && c.ts ? new Date(c.ts).toISOString() : null }; })(),
      crm: { modo: BOT_CRM_MODE, efectivo: CRM_EFECTIVO },
      recordatorio: String(process.env.BOT_RECORDATORIO || "off"),
    });
  });
  app.post("/admin/api/simulate", async (req, res) => {
    if (!adminAuth(req, res)) return;
    const { session, text } = req.body || {};
    if (!text) return res.status(400).json({ error: "text requerido" });
    const clave = String(session || "default").slice(0, 60);
    try {
      const history = simulaciones.get(clave) || [];
      history.push({ role: "user", content: String(text).slice(0, 4000) });
      const cat = await getCatalogoBlock();
      const response = await claudeMessage({
        model: MODEL, thinking: { type: "adaptive" }, output_config: { effort: "low" }, max_tokens: 2000,
        system: [{ type: "text", text: buildSystemPrompt(), cache_control: { type: "ephemeral" } }, ...bloquesCatalogoCrm(cat), { type: "text", text: dateHint() }],
        messages: history.slice(-20).map((m) => ({ role: m.role, content: paraModelo(m) })),
      });
      const tb = response.content.find((b) => b.type === "text");
      const reply = cleanReply((tb && tb.text) || "(sin respuesta — revisa logs)");
      history.push({ role: "assistant", content: reply });
      simulaciones.set(clave, history.slice(-100));
      if (simulaciones.size > 200) simulaciones.delete(simulaciones.keys().next().value);
      res.json({ reply });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post("/admin/api/simulate/reset", (req, res) => {
    if (!adminAuth(req, res)) return;
    simulaciones.delete(String((req.body && req.body.session) || "default").slice(0, 60));
    res.json({ ok: true });
  });
}
app.post("/webhook", (req, res) => (STORE_PG ? webhookPg(req, res) : webhookRedis(req, res)));

// ─── PANEL WEB (control de chats del bot) ─────────────────────────
// HTML del panel en panel.html (estilo HighLevel). Respaldo mínimo si falta el archivo.
const panelFileName = PANEL_FILE || "panel.html";
const ADMIN_HTML = fs.existsSync(panelFileName)
  ? fs.readFileSync(panelFileName, "utf8")
  : `<!doctype html><meta charset='utf-8'><body style='font-family:sans-serif;padding:40px'>Panel: falta ${panelFileName} en el despliegue.</body>`;

function adminAuth(req, res) {
  if (!ADMIN_PASSWORD) { res.status(503).json({ error: "panel no configurado (falta ADMIN_PASSWORD)" }); return false; }
  // La key viaja por cabecera (X-Admin-Key); se acepta ?key= como alternativa retrocompatible.
  const key = req.get("x-admin-key") || req.query.key;
  if (key !== ADMIN_PASSWORD) { res.status(403).json({ error: "forbidden" }); return false; }
  return true;
}

app.get("/admin", (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(503).send("Panel no configurado: define ADMIN_PASSWORD en Railway.");
  res.type("html").send(ADMIN_HTML.replace(/__PROJECT__/g, PROJECT_NAME || "Bot"));
});

// URLs dedicadas a vistas del panel (BD, dashboard): sirven el mismo panel; la página abre la vista al cargar.
app.get(["/admin/db", "/admin/dash"], (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(503).send("Panel no configurado: define ADMIN_PASSWORD en Railway.");
  res.type("html").send(ADMIN_HTML.replace(/__PROJECT__/g, PROJECT_NAME || "Bot"));
});

app.get("/admin/api/leads", async (req, res) => {
  if (!adminAuth(req, res)) return;
  try { res.json(await listLeads()); } catch (e) { res.status(500).json({ error: e.message }); }
});

// Estado de la cuenta de WhatsApp: null = sana. Lo alimenta el webhook de `statuses`.
app.get("/admin/api/wa-status", async (req, res) => {
  if (!adminAuth(req, res)) return;
  try { res.json({ blocked: await getWaBlocked() }); } catch (e) { res.status(500).json({ error: e.message }); }
});

// Enriquecer un lead: extrae de su conversación los datos que falten en la ficha.
app.post("/admin/api/enrich", async (req, res) => {
  if (!adminAuth(req, res)) return;
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: "phone requerido" });
  try { const f = await enrichLeadFromConversation(phone, { force: true }); res.json({ ok: true, fields: f || {} }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Enriquecer todos los leads incompletos de golpe (botón "Actualizar desde chats").
app.post("/admin/api/enrich-all", async (req, res) => {
  if (!adminAuth(req, res)) return;
  try { const n = await enrichSweep(40); res.json({ ok: true, enriched: n }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Importar leads de un CSV de Meta (el cliente parsea el archivo y manda las filas).
app.post("/admin/api/import", async (req, res) => {
  if (!adminAuth(req, res)) return;
  const rows = req.body && req.body.rows;
  if (!Array.isArray(rows)) return res.status(400).json({ error: "rows (array) requerido" });
  let created = 0, updated = 0, skipped = 0;
  try {
    for (const r of rows) {
      const out = await importMetaLead(r);
      if (out === "created") created++; else if (out === "updated") updated++; else skipped++;
    }
    res.json({ ok: true, created, updated, skipped, total: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Estado del almacén: si la "base de datos" persiste (Redis) o es volátil (RAM), y cuántos leads hay.
app.get("/admin/api/health", async (req, res) => {
  if (!adminAuth(req, res)) return;
  let count = 0;
  try {
    count = await leadsContar();
  } catch (e) { /* best-effort */ }
  // `testing` viaja aquí para que el estado del freno se pueda comprobar sin leer logs:
  // un modo testing olvidado encendido es tan caro como uno apagado por error (LAW-106).
  res.json({
    storage: almacenNombre(),
    leads: count,
    testing: { on: TESTING_MODE, allowlist: ALLOWLIST.size, malformados: ALLOWLIST_BAD },
    // Catálogo y CRM del ERP (S6): modos y estado, sin precios ni teléfonos. Un interruptor mudo sería otro LAW-106.
    catalogo: await (async () => {
      if (BOT_CATALOGO_MODE !== "on") return { modo: "off" };
      const c = await getCatalogoBlock();
      return { modo: "on", estado: c ? c.estado : "error", unidades: c ? c.unidades.length : 0, desde: c && c.ts ? new Date(c.ts).toISOString() : null };
    })(),
    crm: { modo: BOT_CRM_MODE, efectivo: CRM_EFECTIVO },
  });
});

// TEMPORAL (S5 / LAW-507, A.1) — SE RETIRA EN S9 junto con Redis. Inventario de TODAS las claves de Redis: SOLO conteos por grupo
// y TTL (nunca valores, nunca un teléfono; las claves desconocidas salen con su forma enmascarada). Solo lectura. Va solo por la
// cabecera x-admin-key (NO acepta ?key=, que acabaría en los logs HTTP).
app.get("/admin/api/redis-inventario", async (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: "panel no configurado" });
  if (req.get("x-admin-key") !== ADMIN_PASSWORD) return res.status(403).json({ error: "forbidden" });
  if (STORE_PG) return res.status(409).json({ error: "BOT_STORE=postgres: Redis bloqueado" }); // S4b: el store lanza si se le pide el lector
  const lector = lectorImportacion();
  if (!lector) return res.status(409).json({ error: "sin Redis conectado" });
  try { res.json(await inventarioRedis(lector)); }
  catch (e) { console.error(`[${PROJECT_NAME}] redis-inventario falló:`, e.message); res.status(500).json({ error: "inventario falló" }); }
});

// TEMPORAL (S5 fase B / LAW-507) — SE RETIRA EN S9. Importación UNICA de Redis a Postgres, dentro del proceso (el Redis solo es
// alcanzable desde Railway). POST con x-admin-key; cuerpo {"dry":true} = solo lee y cuenta, no escribe. Repetible: la parte SQL no
// duplica ni quita bajas/pausas. Devuelve SOLO conteos e informe de cuadre (nunca contenido ni teléfonos).
let _importandoRedis = false;
app.post("/admin/api/redis-importar", async (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: "panel no configurado" });
  if (req.get("x-admin-key") !== ADMIN_PASSWORD) return res.status(403).json({ error: "forbidden" });
  const lector = lectorImportacion();
  if (!lector) return res.status(409).json({ error: "sin Redis conectado" });
  const dry = !!(req.body && req.body.dry === true);
  const transporte = creaTransporteImportar({ url: BOT_API_URL, secreto: process.env.BOT_API_SECRET_IMPORTAR });
  if (!dry && !transporte) return res.status(409).json({ error: "falta BOT_API_URL o BOT_API_SECRET_IMPORTAR" });
  if (_importandoRedis) return res.status(409).json({ error: "importación en curso" });
  _importandoRedis = true;
  try { const inf = await importarRedis(lector, transporte, { dryRun: dry }); if (transporte) inf.rechazos_edge = transporte.razones; res.json(inf); }
  catch (e) { console.error(`[${PROJECT_NAME}] redis-importar falló:`, e && e.message); res.status(500).json({ error: "importación falló" }); }
  finally { _importandoRedis = false; }
});

app.get("/admin/api/conv/:phone", async (req, res) => {
  if (!adminAuth(req, res)) return;
  try { res.json(await getConversation(req.params.phone)); } catch (e) { res.status(500).json({ error: e.message }); }
});

// Responder a mano (toma de control). Envía por WhatsApp y pausa el bot para ese lead.
app.post("/admin/api/send", async (req, res) => {
  if (!adminAuth(req, res)) return;
  const { phone, text, byUser } = req.body || {};
  if (!phone || !text) return res.status(400).json({ error: "phone y text requeridos" });
  // Baja del lead: un STOP se honra aquí, no en la interfaz. Si depende de que el
  // comercial se acuerde, no está honrado.
  if (await getOptOut(phone)) return res.status(409).json({ error: "opt_out", detalle: "Este lead pidió no recibir más mensajes (STOP)." });
  const r = await sendWhatsAppResult(phone, text);
  if (!r.ok) return res.status(502).json({ error: r.error, code: r.code ?? null });
  const history = await getConversation(phone);
  // `byUser` = quién de la intranet escribió esto. Lo inyecta la edge desde el JWT; si
  // llega vacío queda vacío, nunca se inventa. `by:"human"` solo dice que no fue la IA.
  history.push({ role: "assistant", content: text, ts: Date.now(), by: "human", byUser: byUser || "", wamid: r.wamid || null });
  await saveConversation(phone, history);
  await setPausedHumano(phone); // al responder a mano, el bot deja de contestar a ese lead (el tiempo lo fija botcfg)
  await setWaiting(phone, false); // ya respondido por el estudio → quitar el pendiente
  const prev = await getLead(phone);
  await recordLead(phone, prev && prev.name, (prev && prev.intent) || "interested", text, "human");
  await logEvent(phone, "agente_texto", { byUser: byUser || "", wamid: r.wamid || null });
  res.json({ ok: true, wamid: r.wamid || null });
});

// ── Plantillas aprobadas del WABA (para la caja de escribir de la intranet) ──
// Solo lectura y solo APPROVED. La categoría viaja porque es DINERO: una MARKETING se
// factura por mensaje; una UTILITY dentro de la ventana abierta, no. Quien elige debe verlo.
app.get("/admin/api/templates", async (req, res) => {
  if (!adminAuth(req, res)) return;
  if (!WHATSAPP_WABA_ID) return res.status(503).json({ error: "falta WHATSAPP_WABA_ID en el entorno" });
  try {
    const r = await axios.get(`${GRAPH_BASE}/${WHATSAPP_WABA_ID}/message_templates`, {
      params: { fields: "name,status,category,language,components", limit: 100 },
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    });
    const lista = (r.data?.data || [])
      .filter((t) => t.status === "APPROVED")
      .map((t) => {
        const body = (t.components || []).find((c) => c.type === "BODY");
        const texto = body?.text || "";
        // Nº de variables = mayor {{n}} del cuerpo. Se manda para poder pedir los
        // parámetros exactos ANTES de gastar el envío, en vez de cobrar un 132000.
        const vars = [...texto.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
        return { name: t.name, language: t.language, category: t.category, body: texto, vars: vars.length ? Math.max(...vars) : 0 };
      });
    res.json(lista);
  } catch (e) {
    res.status(502).json({ error: e.response?.data ? JSON.stringify(e.response.data) : e.message });
  }
});

// ── Enviar una plantilla aprobada COMO PERSONA (no como bot) ──
// Es la única vía de escribir a un lead cuya ventana de 24h está cerrada. Va por
// sendWhatsAppTemplateResult (núcleo sin freno): habla una persona, no el bot.
app.post("/admin/api/send-template", async (req, res) => {
  if (!adminAuth(req, res)) return;
  const { phone, template, lang, params, byUser } = req.body || {};
  if (!phone || !template) return res.status(400).json({ error: "phone y template requeridos" });
  // El destinatario tiene que ser un lead que ya existe. Sin esto, este endpoint es una
  // pasarela para mandar plantillas de la marca a cualquier número del mundo.
  const lead = await getLead(phone);
  if (!lead) return res.status(404).json({ error: "lead_desconocido", detalle: "Ese teléfono no es un lead de este bot." });
  if (await getOptOut(phone)) return res.status(409).json({ error: "opt_out", detalle: "Este lead pidió no recibir más mensajes (STOP)." });
  const cuerpo = Array.isArray(params) ? params.map((p) => String(p ?? "")) : [];
  const r = await sendWhatsAppTemplateResult(phone, template, lang || "es", cuerpo);
  if (!r.ok) return res.status(502).json({ error: r.error, code: r.code ?? null });
  const history = await getConversation(phone);
  /* Se guarda la plantilla y sus parámetros REALES, no un texto inventado: sendIntro
     siembra un saludo fijo en inglés diga lo que diga la plantilla, y eso deja un
     historial que no es lo que el lead recibió. */
  history.push({
    role: "assistant", ts: Date.now(), by: "human", byUser: byUser || "", wamid: r.wamid || null,
    plantilla: template, content: `[plantilla ${template}] ${cuerpo.join(" · ")}`.trim(),
  });
  await saveConversation(phone, history);
  await setPausedHumano(phone);   // igual que el texto libre: el humano toma el mando y
  await setWaiting(phone, false); // followupTick deja de soltar SU plantilla encima
  await recordLead(phone, lead.name, lead.intent || "interested", `[plantilla ${template}]`, "human");
  await logEvent(phone, "agente_plantilla", { byUser: byUser || "", plantilla: template, wamid: r.wamid || null });
  res.json({ ok: true, wamid: r.wamid || null });
});

// Enviar una foto/vídeo a mano al cliente (toma de control). Igual que /send: envía, registra y pausa el bot.
app.post("/admin/api/send-media", async (req, res) => {
  if (!adminAuth(req, res)) return;
  const { phone, url, type, caption } = req.body || {};
  if (!phone || !url) return res.status(400).json({ error: "phone y url requeridos" });
  const mtype = type === "video" ? "video" : "image";
  const r = await sendWhatsAppMedia(phone, { type: mtype, url, caption: caption || "", label: "manual" });
  if (!r.ok) return res.status(502).json({ error: r.error });
  const history = await getConversation(phone);
  history.push({ role: "assistant", content: (caption || "").trim() || (mtype === "video" ? "[vídeo]" : "[foto]"), ts: Date.now(), by: "human", media: { type: mtype, url, caption: caption || "" } });
  await saveConversation(phone, history);
  await setPausedHumano(phone);
  await setWaiting(phone, false);
  const prev = await getLead(phone);
  await recordLead(phone, prev && prev.name, (prev && prev.intent) || "interested", caption || "[media]", "human");
  res.json({ ok: true });
});

// Pausar / reanudar el bot para un lead
app.post("/admin/api/pause", async (req, res) => {
  if (!adminAuth(req, res)) return;
  const { phone, paused } = req.body || {};
  if (!phone) return res.status(400).json({ error: "phone requerido" });
  await setPaused(phone, !!paused);
  res.json({ ok: true, paused: !!paused });
});

// ── CRM: configuración del bot (instrucciones extra, saludo, horas de pausa) ──
// Llamador con nombre: la pantalla «Configurar bot» de la intranet, vía lawang-bot-proxy
// (config_get / config_set / config_revert, permiso bot_configurar). La edge pone `byUser` desde la
// sesión; aquí se valida OTRA VEZ todo (la edge es la primera puerta, no la única).
async function leeLogCfg(n = 20) {
  const raw = await cfgLogRaw(n);
  return raw.map((r) => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
}
async function guardaCfg(valor, byUser) {
  const prevRaw = await cfgRawLeer();
  const prev = prevRaw ? { ...CFG_VACIA, ...JSON.parse(prevRaw) } : { ...CFG_VACIA };
  const next = { ...valor, updatedAt: Date.now(), updatedBy: String(byUser || "").slice(0, 120) };
  // Una sola transacción: la config nueva y su entrada de registro entran juntas o no entra ninguna.
  await cfgGuardarConLog(JSON.stringify(next), JSON.stringify({ ts: next.updatedAt, by: next.updatedBy, prev, next }));
  _cfgCache = { v: next, ts: Date.now() }; // este proceso aplica el cambio ya, sin esperar los 10 s
  return next;
}
app.get("/admin/api/config", async (req, res) => {
  if (!adminAuth(req, res)) return;
  if (!redisActivo()) return res.status(503).json({ error: "sin Redis: la configuración no se puede guardar" });
  try {
    res.json({ config: await getBotCfg(true), log: (await leeLogCfg()).map((e) => ({ ts: e.ts, by: e.by })) });
  } catch (e) {
    res.status(500).json({ error: "no se pudo leer la configuración" });
  }
});
app.post("/admin/api/config", async (req, res) => {
  if (!adminAuth(req, res)) return;
  if (!redisActivo()) return res.status(503).json({ error: "sin Redis: la configuración no se guardaría" });
  const { config, byUser, expectedUpdatedAt } = req.body || {};
  if (JSON.stringify(req.body || {}).length > 10000) return res.status(413).json({ error: "cuerpo demasiado grande" });
  const v = validaConfig(config);
  if (!v.ok) return res.status(400).json({ error: v.error });
  try {
    const actual = await getBotCfg(true);
    if (typeof expectedUpdatedAt !== "number") return res.status(400).json({ error: "expectedUpdatedAt requerido (la versión que estabas viendo)" });
    if (expectedUpdatedAt !== (actual.updatedAt || 0)) {
      return res.status(409).json({ error: "otra persona ha cambiado la configuración mientras la editabas", config: actual });
    }
    const next = await guardaCfg(v.value, byUser);
    console.log(`[${PROJECT_NAME}] Configuración del bot cambiada por ${next.updatedBy || "?"}`);
    res.json({ ok: true, config: next });
  } catch (e) {
    console.error(`[${PROJECT_NAME}] botcfg: no se pudo guardar: ${e.message}`);
    res.status(500).json({ error: "no se pudo guardar la configuración" });
  }
});
app.post("/admin/api/config/revert", async (req, res) => {
  if (!adminAuth(req, res)) return;
  if (!redisActivo()) return res.status(503).json({ error: "sin Redis" });
  const esperada = req.body && req.body.expectedUpdatedAt;
  if (typeof esperada !== "number") return res.status(400).json({ error: "expectedUpdatedAt requerido (la versión que estabas viendo)" });
  try {
    if (esperada !== ((await getBotCfg(true)).updatedAt || 0)) return res.status(409).json({ error: "otra persona ha cambiado la configuración mientras la mirabas" });
    const [ultimo] = await leeLogCfg(1);
    if (!ultimo || !ultimo.prev) return res.status(404).json({ error: "no hay un cambio anterior al que volver" });
    const v = validaConfig({ extra: ultimo.prev.extra, bienvenida: ultimo.prev.bienvenida, pausaHoras: ultimo.prev.pausaHoras });
    if (!v.ok) return res.status(409).json({ error: `la versión anterior ya no es válida: ${v.error}` });
    const next = await guardaCfg(v.value, (req.body && req.body.byUser) || "");
    console.log(`[${PROJECT_NAME}] Configuración del bot revertida por ${next.updatedBy || "?"}`);
    res.json({ ok: true, config: next });
  } catch (e) {
    console.error(`[${PROJECT_NAME}] botcfg: no se pudo revertir: ${e.message}`);
    res.status(500).json({ error: "no se pudo volver a la versión anterior" });
  }
});

// ── CRM: notas internas del lead (se escriben también en el Sheet, col. Javier Notes) ──
app.post("/admin/api/note", async (req, res) => {
  if (!adminAuth(req, res)) return;
  const { phone, notes } = req.body || {};
  if (!phone) return res.status(400).json({ error: "phone requerido" });
  await setNotes(phone, notes || "");
  writeLeadToSheet(phone, { notes: notes || "" }); // best-effort, no bloquea la respuesta
  logEvent(phone, "note");
  res.json({ ok: true });
});

// ── CRM: estado de pipeline manual (new/quoted/won/lost/noshow) ──
// ── Simulador: prueba el bot desde el panel sin WhatsApp ni Meta. Mismo motor/contexto que el
// webhook real (Claude + BASE_INSTRUCTIONS + context file), pero no envía nada por WhatsApp ni
// toca el CRM de leads reales — la conversación vive en su propia clave de Redis (sim:<session>).
app.post("/admin/api/simulate", async (req, res) => {
  if (!adminAuth(req, res)) return;
  const { session, text } = req.body || {};
  if (!text) return res.status(400).json({ error: "text requerido" });
  const phone = `sim:${session || "default"}`;
  try {
    const history = await getConversation(phone);
    history.push({ role: "user", content: text, ts: Date.now() });
    const mediaLib = await getMediaLib();
    const mediaHint = buildMediaHint(mediaLib);
    // Notas del equipo (CRM → botcfg): bloque aparte SIN cache_control, para que editarlo no invalide el prefijo cacheado.
    const teamBlock = bloqueEquipo(await getBotCfg(), { primerTurno: !history.some((m) => m.role === "assistant") });
    const cat = await getCatalogoBlock(); // null con BOT_CATALOGO=off (system idéntico al de siempre)
    const response = await claudeMessage({
      model: MODEL,
      thinking: { type: "adaptive" }, // espejo del webhook real (paridad simulador/producción)
      output_config: { effort: "low" },
      max_tokens: 2000,
      system: [
        { type: "text", text: buildSystemPrompt(), cache_control: { type: "ephemeral" } },
        ...bloquesCatalogoCrm(cat),
        { type: "text", text: dateHint() },
        ...(mediaHint ? [{ type: "text", text: mediaHint }] : []),
        ...(teamBlock ? [{ type: "text", text: teamBlock }] : []),
      ],
      messages: history.slice(-20).map((m) => ({ role: m.role, content: paraModelo(m) })), // mismo recorte que el webhook real
    });
    const textBlock = response.content.find((b) => b.type === "text");
    let reply = (textBlock && textBlock.text) || "(sin respuesta — revisa logs)";
    reply = cleanReply(reply); // mismo limpiado que el webhook real (helper compartido)
    postCheckPrecios(reply, cat, history, phone); // solo log (el simulador no escribe en el CRM)
    history.push({ role: "assistant", content: reply, ts: Date.now(), by: "bot" });
    await saveConversation(phone, history);
    res.json({ reply });
  } catch (e) {
    console.error(`[${PROJECT_NAME}] simulate error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

app.post("/admin/api/simulate/reset", async (req, res) => {
  if (!adminAuth(req, res)) return;
  const { session } = req.body || {};
  await saveConversation(`sim:${session || "default"}`, []);
  res.json({ ok: true });
});

app.post("/admin/api/status", async (req, res) => {
  if (!adminAuth(req, res)) return;
  const { phone, status } = req.body || {};
  if (!phone) return res.status(400).json({ error: "phone requerido" });
  const prevStatus = await getStatus(phone);
  await setStatus(phone, status || "");
  if (STATUS_SHEET_LABEL[status]) writeLeadToSheet(phone, { status: STATUS_SHEET_LABEL[status] });
  if ((status || "") !== (prevStatus || "")) logEvent(phone, "status", { from: prevStatus || "", to: status || "" });
  res.json({ ok: true });
});

// ── CRM: estado de un deal CONCRETO dentro de lead.deals[] (open/won/lost) — soporta deals
// concurrentes: marcar "Ganado"/"Perdido" en uno no toca los demás del mismo lead. ──
app.post("/admin/api/deal", async (req, res) => {
  if (!adminAuth(req, res)) return;
  const { phone, dealId, status } = req.body || {};
  if (!phone || !dealId || !["open", "won", "lost"].includes(status)) return res.status(400).json({ error: "phone, dealId y status (open/won/lost) requeridos" });
  const lead = await getLead(phone);
  const deals = Array.isArray(lead && lead.deals) ? lead.deals.slice() : [];
  const idx = deals.findIndex((d) => d.id === dealId);
  if (idx < 0) return res.status(404).json({ error: "deal no encontrado" });
  const from = deals[idx].status || "";
  const model = deals[idx][DEAL_ID_FIELD] || "";
  deals[idx] = { ...deals[idx], status, updatedAt: Date.now() };
  await updateLeadFields(phone, { deals, ...mirrorOf(focusDeal(deals)) });
  await logEvent(phone, "deal_status", { model, from, to: status });
  const prevLeadStatus = await getStatus(phone);
  const newLeadStatus = statusAfterDealClose(deals, prevLeadStatus);
  if (newLeadStatus != null) {
    await setStatus(phone, newLeadStatus);
    if (STATUS_SHEET_LABEL[newLeadStatus]) writeLeadToSheet(phone, { status: STATUS_SHEET_LABEL[newLeadStatus] });
    await logEvent(phone, "status", { from: prevLeadStatus || "", to: newLeadStatus });
  }
  res.json({ ok: true, deal: deals[idx] });
});

// ── CRM: campos editables de la ficha (name/country/email/tour/travelDate/owner/tags/seguimiento) ──
app.post("/admin/api/lead", async (req, res) => {
  if (!adminAuth(req, res)) return;
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: "phone requerido" });
  const prev = (await getLead(phone)) || {};
  const fields = {};
  // Incluye los campos del vertical rental (model/plan/...): el panel-rental los envía y sin
  // ellos aquí se descartaban en silencio — editar la ficha de BBM perdía esos datos.
  ["name", "country", "email", "tour", "package", "riders", "pillions", "travelDate", "owner", "nextFollowUp", "tags", "archived",
   "model", "plan", "startDate", "endDate", "deliveryLocation", "insuranceTier", "paymentMethod", "dealValue"].forEach((k) => {
    if (req.body[k] != null) fields[k] = req.body[k];
  });
  if (fields.dealValue != null) { // normaliza: "2,450,000" / "2450000 IDR" / "" → entero (0 = borrar)
    const n = parseInt(String(fields.dealValue).replace(/\D/g, ""), 10);
    fields.dealValue = isNaN(n) ? 0 : n;
  }
  await updateLeadFields(phone, fields);
  writeLeadToSheet(phone, fields); // best-effort (solo escribe las llaves con columna mapeada)
  if (fields.owner != null && (fields.owner || "") !== (prev.owner || "")) logEvent(phone, "owner", { to: fields.owner || "" });
  res.json({ ok: true });
});

// ── CRM: archivar / restaurar un lead (reversible; sale de las vistas) ──
app.post("/admin/api/archive", async (req, res) => {
  if (!adminAuth(req, res)) return;
  const { phone, archived } = req.body || {};
  if (!phone) return res.status(400).json({ error: "phone requerido" });
  await updateLeadFields(phone, { archived: !!archived });
  logEvent(phone, archived ? "archived" : "restored");
  res.json({ ok: true, archived: !!archived });
});

// ── CRM: borrar definitivamente un lead (irreversible) ──
async function deleteLead(phone) {
  await leadBorrar(phone);
}
app.post("/admin/api/lead/delete", async (req, res) => {
  if (!adminAuth(req, res)) return;
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: "phone requerido" });
  try { await deleteLead(phone); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CRM: acciones en lote sobre varios leads ──
app.post("/admin/api/bulk", async (req, res) => {
  if (!adminAuth(req, res)) return;
  const { phones, action, value } = req.body || {};
  if (!Array.isArray(phones) || !phones.length || !action) return res.status(400).json({ error: "phones[] y action requeridos" });
  let n = 0;
  const failed = [];
  try {
    for (const phone of phones) {
      if (action === "status") {
        const prevStatus = await getStatus(phone);
        await setStatus(phone, value || "");
        if (STATUS_SHEET_LABEL[value]) writeLeadToSheet(phone, { status: STATUS_SHEET_LABEL[value] });
        if ((value || "") !== (prevStatus || "")) logEvent(phone, "status", { from: prevStatus || "", to: value || "" });
      } else if (action === "owner") {
        await updateLeadFields(phone, { owner: value || "" });
        writeLeadToSheet(phone, { owner: value || "" });
        logEvent(phone, "owner", { to: value || "" });
      } else if (action === "archive" || action === "restore") {
        await updateLeadFields(phone, { archived: action === "archive" });
        logEvent(phone, action === "archive" ? "archived" : "restored");
      } else if (action === "tag") {
        const prev = (await getLead(phone)) || {};
        const tags = Array.isArray(prev.tags) ? prev.tags.slice() : [];
        if (value && tags.indexOf(value) < 0) { tags.push(value); await updateLeadFields(phone, { tags }); logEvent(phone, "tag", { to: value }); }
      } else if (action === "outreach") {
        // Si falla (cuenta bloqueada, plantilla sin aprobar…) NO cuenta como enviado:
        // antes el lote decía "13 enviados" con 11 rebotados.
        const r = await sendIntro(phone);
        if (!r || !r.ok) { failed.push({ phone, error: (r && r.error) || "envío fallido" }); continue; }
      } else if (action === "delete") {
        await deleteLead(phone);
      } else { continue; }
      n++;
    }
    res.json({ ok: true, count: n, failed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── OUTREACH: el bot escribe primero a un lead del formulario de Meta ──
app.post("/admin/api/outreach", async (req, res) => {
  if (!adminAuth(req, res)) return;
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: "phone requerido" });
  try { const r = await sendIntro(phone); if (!r.ok) return res.status(502).json({ error: r.error }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Respuestas rápidas: listar / guardar ──
app.get("/admin/api/canned", async (req, res) => {
  if (!adminAuth(req, res)) return;
  try { res.json(await getCanned()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/admin/api/canned", async (req, res) => {
  if (!adminAuth(req, res)) return;
  const list = req.body && req.body.list;
  if (!Array.isArray(list)) return res.status(400).json({ error: "list (array) requerido" });
  await setCanned(list);
  res.json({ ok: true });
});

// ── Biblioteca de media (fotos/vídeos que el bot puede enviar) ──
app.get("/admin/api/media", async (req, res) => {
  if (!adminAuth(req, res)) return;
  try { res.json(await getMediaLib()); } catch (e) { res.status(500).json({ error: e.message }); }
});
// Subir un archivo local (dataURL base64) → guarda el blob y devuelve una URL self-hosted.
app.post("/admin/api/media/upload", async (req, res) => {
  if (!adminAuth(req, res)) return;
  const dataUrl = (req.body && req.body.dataUrl) || "";
  const m = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
  if (!m) return res.status(400).json({ error: "archivo inválido" });
  const mime = m[1].toLowerCase(), b64 = m[2];
  if (!/^image\/|^video\//.test(mime)) return res.status(400).json({ error: "solo imágenes o vídeos" });
  if (Math.floor(b64.length * 0.75) > 16 * 1024 * 1024) return res.status(413).json({ error: "máx 16 MB" });
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  try {
    await setBlob(id, mime, b64);
    const url = `https://${req.get("host")}/media/${id}`;
    res.json({ id, url, type: mime.startsWith("video/") ? "video" : "image", mime });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Sirve el archivo subido (público: WhatsApp lo descarga al enviarlo por link).
app.get("/media/:id", async (req, res) => {
  try {
    const blob = await getBlob(req.params.id);
    if (!blob) return res.status(404).send("not found");
    res.set("Content-Type", blob.mime);
    res.set("Cache-Control", "public, max-age=86400");
    res.send(Buffer.from(blob.data, "base64"));
  } catch (e) { res.status(500).send("error"); }
});

app.post("/admin/api/media", async (req, res) => {
  if (!adminAuth(req, res)) return;
  const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
  const clean = items.map((m, i) => ({
    id: String(m.id || (Date.now().toString(36) + i)),
    label: String(m.label || "").trim().slice(0, 40),
    type: m.type === "video" ? "video" : "image",
    url: String(m.url || "").trim(),
    caption: String(m.caption || "").trim().slice(0, 300),
    use: String(m.use || "").trim().slice(0, 300), // cuándo enviarlo (guía interna para el bot; NO se envía al cliente)
  })).filter((m) => /^https?:\/\//i.test(m.url) && m.label);
  try {
    // GC de blobs: los archivos subidos al panel viven en Redis sin TTL; al quitar un item
    // de la biblioteca, su blob quedaba huérfano para siempre (crecimiento de memoria).
    const blobId = (u) => (String(u || "").match(/\/media\/([a-z0-9]+)$/i) || [])[1];
    const old = await getMediaLib();
    const keep = new Set(clean.map((m) => blobId(m.url)).filter(Boolean));
    for (const o of old) {
      const id = blobId(o.url);
      if (id && !keep.has(id)) {
        await delBlob(id);
      }
    }
    res.json(await setMediaLib(clean));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── NEWSLETTER POR EMAIL ─────────────────────────────────────────
// Envío masivo a los emails capturados en el CRM. Proveedor: Brevo (API transaccional).
// Requisitos: dominio verificado en Brevo + BREVO_API_KEY y MAIL_FROM en Railway.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAIL_READY = !!(BREVO_API_KEY && MAIL_FROM);
// "Nombre <email>" → {name, email} para el sender de Brevo. Sin ángulos, todo es el email.
function parseFrom(s) {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(s || "");
  return m ? { name: m[1] || undefined, email: m[2].trim() } : { email: (s || "").trim() };
}

// Set de bajas (opt-out). Guardado en Redis (con memoria de respaldo dentro de store/redis.js).
async function addEmailUnsub(email) {
  const e = String(email || "").toLowerCase().trim(); if (!e) return;
  await unsubAgregar(e);
}
async function getUnsubSet() {
  return unsubLeer();
}

// Token de baja: HMAC del email → el link no se puede falsear ni dar de baja a terceros.
function unsubToken(email) {
  const secret = MAIL_UNSUB_SECRET || ADMIN_PASSWORD || "unsub";
  return crypto.createHmac("sha256", secret).update(String(email).toLowerCase().trim()).digest("hex").slice(0, 20);
}
function unsubUrl(host, email) {
  return `https://${host}/unsubscribe?e=${encodeURIComponent(email)}&t=${unsubToken(email)}`;
}

function escHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
// Formato en línea de una línea de texto (se escapa HTML ANTES → sin inyección).
// Soporta: imagen, botón [[Texto|url]], enlace [txt](url), **negrita**, *cursiva*.
function inlineMd(s) {
  s = escHtml(s);
  s = s.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%;border-radius:10px;margin:10px 0">');
  s = s.replace(/\[\[([^\]|]+)\|(https?:\/\/[^\]\s]+)\]\]/g, '<a href="$2" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:13px 24px;border-radius:9px;font-weight:600;margin:8px 0">$1</a>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" style="color:#c2410c;text-decoration:underline">$1</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return s;
}
// Markdown ligero del compositor → HTML. Bloques: ## / ### títulos, - lista, --- separador,
// líneas en blanco = párrafo nuevo. El resto se procesa en línea con inlineMd.
function mdToHtml(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  let html = "", listOpen = false, para = [];
  const flushPara = () => { if (para.length) { html += `<p style="margin:0 0 16px">${para.map(inlineMd).join("<br>")}</p>`; para = []; } };
  const closeList = () => { if (listOpen) { html += "</ul>"; listOpen = false; } };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flushPara(); closeList(); continue; }
    if (/^###\s+/.test(line)) { flushPara(); closeList(); html += `<h3 style="font-size:16px;margin:18px 0 8px;color:#111">${inlineMd(line.replace(/^###\s+/, ""))}</h3>`; continue; }
    if (/^##\s+/.test(line)) { flushPara(); closeList(); html += `<h2 style="font-size:21px;margin:24px 0 10px;color:#111">${inlineMd(line.replace(/^##\s+/, ""))}</h2>`; continue; }
    if (/^---+$/.test(line)) { flushPara(); closeList(); html += '<hr style="border:0;border-top:1px solid #e6e6e6;margin:24px 0">'; continue; }
    if (/^[-*]\s+/.test(line)) { flushPara(); if (!listOpen) { html += '<ul style="margin:0 0 16px;padding-left:20px">'; listOpen = true; } html += `<li style="margin:0 0 6px">${inlineMd(line.replace(/^[-*]\s+/, ""))}</li>`; continue; }
    para.push(line);
  }
  flushPara(); closeList();
  return html;
}
// Envoltorio de marca del email (cabecera + cuerpo + pie legal con baja).
function renderEmailHtml(bodyHtml, unsub) {
  const brand = escHtml(PROJECT_NAME || "Newsletter");
  const company = escHtml(MAIL_COMPANY || PROJECT_NAME || "");
  const header = MAIL_LOGO
    ? `<img src="${escHtml(MAIL_LOGO)}" alt="${brand}" style="height:42px;display:block">`
    : `<div style="font-size:21px;font-weight:800;letter-spacing:.02em;color:#111">${brand}</div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#f2f2f0">
<div style="max-width:600px;margin:0 auto;padding:28px 20px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#222">
  <div style="padding:4px 4px 22px">${header}</div>
  <div style="background:#fff;border-radius:14px;padding:34px 30px;font-size:15.5px;line-height:1.65;color:#2a2a2a">${bodyHtml}</div>
  <div style="font-size:12px;color:#9a9a9a;padding:20px 6px;line-height:1.6;text-align:center">
    ${company ? company + "<br>" : ""}
    <a href="${unsub}" style="color:#9a9a9a">Unsubscribe</a> — you received this because you enquired with us.
  </div>
</div></body></html>`;
}

// Envía un email vía Brevo (API transaccional). Dos modos:
//  · plantilla de Brevo → { to, templateId, params } (usa su asunto/diseño; params = {{params.x}})
//  · HTML propio        → { to, subject, html }
// Devuelve {ok} o {ok:false,error}.
async function sendEmail({ to, name, subject, html, templateId, params }) {
  if (!MAIL_READY) return { ok: false, error: "email no configurado" };
  const dest = [{ email: to, ...(name ? { name } : {}) }];
  const payload = templateId
    ? { templateId, to: dest, params: params || {} }
    : { sender: parseFrom(MAIL_FROM), to: dest, subject, htmlContent: html };
  if (MAIL_REPLY_TO) payload.replyTo = { email: MAIL_REPLY_TO };
  try {
    await axios.post("https://api.brevo.com/v3/smtp/email", payload,
      { headers: { "api-key": (BREVO_API_KEY || "").trim(), "Content-Type": "application/json", accept: "application/json" }, timeout: 15000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.response?.data ? JSON.stringify(e.response.data) : e.message };
  }
}

// Lista las plantillas transaccionales activas de Brevo (para elegir en el panel).
app.get("/admin/api/brevo-templates", async (req, res) => {
  if (!adminAuth(req, res)) return;
  if (!BREVO_API_KEY) return res.status(400).json({ error: "Falta BREVO_API_KEY en Railway." });
  try {
    const r = await axios.get("https://api.brevo.com/v3/smtp/templates?templateStatus=true&limit=200&sort=desc",
      { headers: { "api-key": (BREVO_API_KEY || "").trim(), accept: "application/json" }, timeout: 15000 });
    res.json((r.data.templates || []).map((t) => ({ id: t.id, name: t.name, subject: t.subject })));
  } catch (e) {
    res.status(502).json({ error: e.response?.data ? JSON.stringify(e.response.data) : e.message });
  }
});

// Baja pública (sin auth): valida el token, marca la baja y muestra confirmación.
app.get("/unsubscribe", async (req, res) => {
  const email = String(req.query.e || "").toLowerCase().trim();
  const ok = email && EMAIL_RE.test(email) && req.query.t === unsubToken(email);
  const page = (msg) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui,sans-serif;max-width:460px;margin:80px auto;padding:0 24px;text-align:center;color:#1a1a1a"><h2 style="font-weight:700">${escHtml(PROJECT_NAME || "")}</h2><p style="font-size:16px;line-height:1.6;color:#444">${msg}</p></body>`;
  if (!ok) return res.status(400).type("html").send(page("This unsubscribe link is invalid or expired."));
  try { await addEmailUnsub(email); } catch (e) { /* best-effort */ }
  res.type("html").send(page("You've been unsubscribed. You won't receive any more newsletters from us."));
});

// Resuelve destinatarios (email válido, no baja, no archivado, sin duplicar) y envía la campaña.
// Reutilizado por el envío inmediato y por el programado (tick). Devuelve {sent, failed, total}.
async function runCampaign({ subject, body, templateId, phones, host }) {
  const buildFor = (email, name) => templateId
    ? { to: email, name, templateId, params: { unsub: unsubUrl(host, email), name: name || "", email } }
    : { to: email, subject, html: renderEmailHtml(mdToHtml(body), unsubUrl(host, email)) };
  const onlyPhones = Array.isArray(phones) ? new Set(phones) : null;
  const unsub = await getUnsubSet();
  const leads = await listLeads();
  const seen = new Set();
  const recipients = [];
  for (const l of leads) {
    if (l.archived) continue;
    if (onlyPhones && !onlyPhones.has(l.phone)) continue;
    const email = String(l.email || "").toLowerCase().trim();
    if (!EMAIL_RE.test(email) || unsub.has(email) || seen.has(email)) continue;
    seen.add(email);
    recipients.push({ phone: l.phone, email, name: l.name || "" });
  }
  const label = templateId ? `template#${templateId}` : subject;
  let sent = 0, failed = 0;
  for (const r of recipients) {
    const out = await sendEmail(buildFor(r.email, r.name));
    if (out.ok) { sent++; await logEvent(r.phone, "newsletter", { subject: label }); }
    else { failed++; console.warn(`[${PROJECT_NAME}] newsletter fallo a ${r.email}: ${out.error}`); }
    await new Promise((s) => setTimeout(s, 120)); // pausa corta: evita el rate-limit de Brevo
  }
  return { sent, failed, total: recipients.length };
}

// Campañas programadas (array JSON en nl_scheduled; ver store/redis.js).

// Envío de la campaña (auth). Body: { subject, body, templateId?, phones?[], testTo?, when? }.
// Con templateId se usa una plantilla de Brevo (su asunto/diseño); si no, subject+body markdown.
// Con when (fecha futura) se PROGRAMA en vez de enviar ya.
app.post("/admin/api/newsletter", async (req, res) => {
  if (!adminAuth(req, res)) return;
  if (!MAIL_READY) {
    const missing = [!BREVO_API_KEY && "BREVO_API_KEY", !MAIL_FROM && "MAIL_FROM"].filter(Boolean).join(" y ");
    return res.status(400).json({ error: `El servicio no ve estas variables en Railway: ${missing}. Revisa el nombre EXACTO (mayúsculas, sin espacios), que estén en el servicio B2K y que haya reiniciado tras guardarlas.` });
  }
  const subject = String((req.body && req.body.subject) || "").trim();
  const body = String((req.body && req.body.body) || "").trim();
  const testTo = String((req.body && req.body.testTo) || "").trim().toLowerCase();
  const templateId = parseInt((req.body && req.body.templateId), 10) || null; // usar plantilla de Brevo
  const phones = Array.isArray(req.body && req.body.phones) ? req.body.phones : null;
  const when = String((req.body && req.body.when) || "").trim();
  if (!templateId && (!subject || !body)) return res.status(400).json({ error: "elige una plantilla de Brevo, o escribe asunto y cuerpo" });
  const host = req.get("host");

  // Envío de PRUEBA: un solo correo a la dirección indicada, no toca el CRM ni las bajas.
  if (testTo) {
    if (!EMAIL_RE.test(testTo)) return res.status(400).json({ error: "email de prueba inválido" });
    const one = templateId
      ? { to: testTo, templateId, params: { unsub: unsubUrl(host, testTo), name: "", email: testTo } }
      : { to: testTo, subject, html: renderEmailHtml(mdToHtml(body), unsubUrl(host, testTo)) };
    const r = await sendEmail(one);
    return r.ok ? res.json({ ok: true, test: true }) : res.status(502).json({ error: r.error });
  }

  // PROGRAMAR: guarda la campaña; el tick la envía a su hora (los destinatarios se recalculan
  // al disparar, así respeta bajas y leads nuevos de última hora).
  if (when) {
    const ts = Date.parse(when);
    if (isNaN(ts)) return res.status(400).json({ error: "fecha inválida" });
    if (ts < Date.now() - 60000) return res.status(400).json({ error: "esa fecha ya pasó" });
    const list = await getScheduled();
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    list.push({ id, when: ts, subject, body, templateId, phones, host, createdAt: Date.now() });
    await setScheduled(list);
    console.log(`[${PROJECT_NAME}] Newsletter programado ${id} para ${new Date(ts).toISOString()}`);
    return res.json({ ok: true, scheduled: true, id, when: ts });
  }

  // Envío INMEDIATO.
  const out = await runCampaign({ subject, body, templateId, phones, host });
  res.json({ ok: true, ...out });
});

// Lista las campañas programadas (resumen, sin el cuerpo completo).
app.get("/admin/api/newsletter/scheduled", async (req, res) => {
  if (!adminAuth(req, res)) return;
  try {
    const list = await getScheduled();
    res.json(list.slice().sort((a, b) => a.when - b.when).map((c) => ({
      id: c.id, when: c.when,
      subject: c.templateId ? `Plantilla Brevo #${c.templateId}` : c.subject,
      scope: c.phones ? c.phones.length : null, // nº seleccionados, o null = todos
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Cancela una campaña programada.
app.post("/admin/api/newsletter/cancel", async (req, res) => {
  if (!adminAuth(req, res)) return;
  const id = String((req.body && req.body.id) || "");
  try {
    const list = await getScheduled();
    const next = list.filter((c) => c.id !== id);
    await setScheduled(next);
    res.json({ ok: true, removed: list.length - next.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Tick: cada minuto envía las campañas cuya hora ya llegó (una por tick).
let nlSending = false;
async function newsletterTick() {
  if (nlSending || !MAIL_READY) return; // no solapar; sin email configurado, dejarlas en cola
  try {
    const list = await getScheduled();
    const due = list.find((c) => c.when <= Date.now());
    if (!due) return;
    nlSending = true;
    // "Reclamar" quitándola de la lista ANTES de enviar → si el tick vuelve a saltar no la duplica.
    // ponytail: si el proceso muere a mitad de envío, esa campaña no se reintenta (mejor que duplicar).
    await setScheduled(list.filter((c) => c.id !== due.id));
    console.log(`[${PROJECT_NAME}] Disparando newsletter programado ${due.id}`);
    const out = await runCampaign(due);
    console.log(`[${PROJECT_NAME}] Newsletter programado ${due.id}: enviados ${out.sent}, fallidos ${out.failed} de ${out.total}`);
  } catch (e) {
    console.error(`[${PROJECT_NAME}] newsletterTick error: ${e.message}`);
  } finally {
    nlSending = false;
  }
}
if (!STORE_PG) setInterval(newsletterTick, 60000); // revisar cada minuto (BOT_STORE=postgres: sin newsletter)

// ── Citas / calendario ──
app.get("/admin/api/appts", async (req, res) => {
  if (!adminAuth(req, res)) return;
  try { res.json(await listAppts()); } catch (e) { res.status(500).json({ error: e.message }); }
});
// Con BOT_CRM=on las citas viven en Postgres (la intranet): este panel viejo deja de ESCRIBIRLAS para que haya un solo escritor. Leer sigue funcionando.
const citasEnLaIntranet = (res) => res.status(409).json({ error: "Las citas se gestionan ahora en la intranet (Agenda de cierre)" });
app.post("/admin/api/appts", async (req, res) => {
  if (!adminAuth(req, res)) return;
  if (CRM_EFECTIVO === "on") return citasEnLaIntranet(res);
  const { id, phone, name, title, when, closer, notes } = req.body || {};
  if (id) {
    try {
      const u = await updateAppt(id, { phone, name, title, when, closer, notes });
      return u ? res.json(u) : res.status(404).json({ error: "cita no encontrada" });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }
  if (!when) return res.status(400).json({ error: "when (fecha/hora) requerido" });
  try { res.json(await createAppt({ phone, name, title, when, closer, notes })); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete("/admin/api/appts/:id", async (req, res) => {
  if (!adminAuth(req, res)) return;
  if (CRM_EFECTIVO === "on") return citasEnLaIntranet(res);
  try { await deleteAppt(req.params.id); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────
app.get("/", (req, res) => res.send(`${PROJECT_NAME || "Bot"} activo ✅`));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`[${PROJECT_NAME}] Bot escuchando en puerto ${PORT}`);
  // El banner anunciaba ocho cosas y no la que decide el coste y la calidad de cada respuesta.
  // Delata el caso real: BBM llevaba sin `BOT_MODEL` y corría con el default del código una
  // generación por detrás de B2K, sin que nada lo dijera (encontrado 28-jul-2026). Verificar el
  // modelo de un servicio exigía leer las variables de Railway; ahora sale en el arranque.
  console.log(`[${PROJECT_NAME}] Modelo: ${MODEL}${BOT_MODEL ? "" : "  ⚠️  BOT_MODEL sin definir → default del código"}`);
  console.log(`[${PROJECT_NAME}] OWNER_PHONE: ${OWNER_PHONE ? normalizePhone(OWNER_PHONE) : "⚠️  NO CONFIGURADO"}`);
  if (HUMAN_ONLY_MODE) console.log(`[${PROJECT_NAME}] 🙋 HUMAN_ONLY activo — la IA no responde a ningún lead, todo pasa por el panel${OWNER_PHONE ? "" : " (⚠️ y OWNER_PHONE está vacío: no se avisará de leads nuevos)"}`);
  if (TESTING_MODE) {
    console.log(`[${PROJECT_NAME}] 🧪 MODO TESTING ACTIVO — BOT_ALLOWLIST: ${ALLOWLIST.size} número(s) cargado(s) (el owner siempre pasa). Nadie más recibe respuesta del bot.`);
    if (ALLOWLIST.size === 0) console.log(`[${PROJECT_NAME}] 🧪 ⚠️  La lista está VACÍA: se deniega a TODOS. Si no era la intención, revisa BOT_ALLOWLIST.`);
    if (ALLOWLIST_BAD) console.log(`[${PROJECT_NAME}] 🧪 ⚠️  ${ALLOWLIST_BAD} número(s) empiezan por 0 (formato local) y NO van a casar nunca: escríbelos en internacional, sin el 0 y con prefijo de país.`);
  } else {
    console.log(`[${PROJECT_NAME}] 🌐 Modo abierto — el bot responde a cualquier número (BOT_ALLOWLIST y BOT_MODE sin definir).`);
  }
  console.log(`[${PROJECT_NAME}] CRM (BD): ${STORE_PG ? "Postgres de Lawang vía la edge bot-api (BOT_STORE=postgres; Redis BLOQUEADO)" : redisActivo() ? "Redis (persistente)" : "RAM (volátil — configura REDIS_URL)"}`);
  if (STORE_PG) {
    const faltan = [["BOT_API_URL", BOT_API_URL], ["BOT_API_SECRET_ESTADO", process.env.BOT_API_SECRET_ESTADO], ["BOT_API_SECRET_HUMANO", process.env.BOT_API_SECRET_HUMANO], ["META_APP_SECRET", META_APP_SECRET], ["OWNER_PHONE", OWNER_PHONE]].filter(([, v]) => !String(v || "").trim()).map(([k]) => k);
    if (faltan.length) console.error(`[${PROJECT_NAME}] 🚨 BOT_STORE=postgres con variables VACÍAS: ${faltan.join(", ")}. ${faltan.includes("META_APP_SECRET") ? "SIN META_APP_SECRET todo POST del webhook se rechaza con 403. " : ""}El bot no podrá contestar hasta ponerlas.`);
    if (String(process.env.BOT_RECORDATORIO || "").trim().toLowerCase() === "postgres" && !String(process.env.BOT_API_SECRET_RECORDATORIO || "").trim()) console.error(`[${PROJECT_NAME}] 🚨 BOT_RECORDATORIO=postgres pero falta BOT_API_SECRET_RECORDATORIO`);
    if (OWNER_PHONE && normalizePhone(OWNER_PHONE).length < 10) console.error(`[${PROJECT_NAME}] ⚠️ OWNER_PHONE parece sin prefijo de país: con BOT_STORE=postgres el dueño se reconoce por dígitos EXACTOS`);
  }
  console.log(`[${PROJECT_NAME}] Firma webhook: ${META_APP_SECRET ? "🟢 X-Hub-Signature-256 activa" : "⚠️  SIN verificar — añade META_APP_SECRET en Railway"}`);
  console.log(`[${PROJECT_NAME}] Email (Brevo): ${MAIL_READY ? "🟢 listo" : `⚠️  NO configurado → BREVO_API_KEY=${BREVO_API_KEY ? "ok" : "FALTA"}, MAIL_FROM=${MAIL_FROM ? "ok" : "FALTA"}`}`);
  if (!MAIL_READY) {
    // Lista los NOMBRES de claves relacionadas que el proceso SÍ ve (sin valores) → delata un typo de nombre.
    const seen = Object.keys(process.env).filter((k) => /mail|brevo|from|smtp|sender/i.test(k));
    console.log(`[${PROJECT_NAME}]   Claves tipo mail/from que veo en el entorno: ${seen.length ? seen.join(", ") : "(ninguna)"}`);
  }

  // El CRM vive en Redis. El Google Sheet solo se prueba/usa si CRM_SHEET_SYNC está activado.
  if (SHEET_SYNC && SHEET_ID && GOOGLE_SERVICE_ACCOUNT) {
    try {
      const sheets = await getSheetsClient();
      await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
      console.log(`[${PROJECT_NAME}] Google Sheets sync: ✅ conectado`);
    } catch (e) {
      console.error(`[${PROJECT_NAME}] Google Sheets sync: ❌ HTTP ${e.code || '?'} — ${e.message}`);
    }
  } else {
    console.log(`[${PROJECT_NAME}] Google Sheets sync: desactivado (CRM = Redis)`);
  }

  // Auto-relleno de la BD: barrido inicial (tras conectar Redis) + periódico cada 30 min.
  if (!STORE_PG) setTimeout(() => enrichSweep(20), 8000);
  if (!STORE_PG) setInterval(() => enrichSweep(10), 30 * 60 * 1000);
  if (STORE_PG && turnoPg && String(process.env.BOT_RECORDATORIO || "").trim().toLowerCase() === "postgres") setInterval(() => turnoPg.recordatorioTick(), 5 * 60000);
});
