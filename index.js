import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { google } from "googleapis";
import axios from "axios";
import fs from "fs";
import https from "https";
import { createClient } from "redis";
import Stripe from "stripe";

const app = express();
app.use(express.json({ limit: "20mb" })); // 20mb: permite subir fotos/vídeos locales (base64) desde el panel

// ─── CONFIGURACIÓN (variables de entorno — distintas por proyecto) ──
const {
  PROJECT_NAME,
  WHATSAPP_TOKEN,
  WHATSAPP_PHONE_ID,
  WHATSAPP_VERIFY_TOKEN,
  ANTHROPIC_API_KEY,
  GOOGLE_SERVICE_ACCOUNT,
  SHEET_ID,
  OWNER_PHONE,
  BOT_CONTEXT,
  BOT_MODEL,
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
} = process.env;

// La BD del CRM es Redis (lead:phone + leads_index). El Google Sheet era un espejo
// heredado y queda DESACTIVADO salvo que se ponga CRM_SHEET_SYNC=1 en Railway.
const SHEET_SYNC = CRM_SHEET_SYNC === "1" || CRM_SHEET_SYNC === "true";

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
const MODEL = BOT_MODEL || "claude-sonnet-4-6";

const CONTEXT = fs.existsSync("context.md")
  ? fs.readFileSync("context.md", "utf8")
  : BOT_CONTEXT;

// ─── REDIS ────────────────────────────────────────────────────────
const CONV_TTL = 7 * 24 * 60 * 60;
const fallbackMemory = {};
const fallbackEscQueue = [];
let redisClient = null;

try {
  redisClient = createClient({ url: REDIS_URL });
  redisClient.on("error", (e) => console.error(`[${PROJECT_NAME}] Redis error:`, e.message));
  await redisClient.connect();
  console.log(`[${PROJECT_NAME}] Redis conectado`);
} catch (e) {
  console.warn(`[${PROJECT_NAME}] Redis no disponible, usando memoria RAM:`, e.message);
  redisClient = null;
}

async function getConversation(phone) {
  if (redisClient) {
    const data = await redisClient.get(`conv:${phone}`);
    return data ? JSON.parse(data) : [];
  }
  return fallbackMemory[phone] || [];
}

async function saveConversation(phone, messages) {
  const trimmed = messages.slice(-20);
  if (redisClient) {
    await redisClient.setEx(`conv:${phone}`, CONV_TTL, JSON.stringify(trimmed));
  } else {
    fallbackMemory[phone] = trimmed;
  }
}

async function escPush(customerPhone, customerName, question) {
  const entry = JSON.stringify({ customerPhone, customerName, question });
  if (redisClient) {
    await redisClient.lPush("esc_queue", entry);
  } else {
    fallbackEscQueue.unshift(entry);
  }
}

async function escPop() {
  if (redisClient) {
    const raw = await redisClient.rPop("esc_queue");
    return raw ? JSON.parse(raw) : null;
  }
  const raw = fallbackEscQueue.pop();
  return raw ? JSON.parse(raw) : null;
}

// ─── ÍNDICE DE LEADS (para el panel web) ──────────────────────────
const fallbackLeads = {};      // phone → { phone, name, intent, lastMessage, updatedAt }
const fallbackNotified = {};   // phone → "interested" | "booking"

async function recordLead(phone, name, intent, lastMessage) {
  const prev = (await getLead(phone)) || {};
  const info = {
    ...prev,                                  // conserva email/package/travelDate/riders… ya capturados
    phone,
    name: name || prev.name || "",
    intent: intent || prev.intent || "exploring",
    lastMessage: (lastMessage || "").slice(0, 200),
    updatedAt: Date.now(),
  };
  if (!info.createdAt) {                       // primera vez que vemos este lead → fecha de alta + evento
    info.createdAt = info.updatedAt;
    info.history = (Array.isArray(prev.history) ? prev.history : []).concat([{ ts: info.createdAt, type: "created" }]);
  }
  if (redisClient) {
    await redisClient.set(`lead:${phone}`, JSON.stringify(info));
    await redisClient.zAdd("leads_index", { score: info.updatedAt, value: phone });
  } else {
    fallbackLeads[phone] = info;
  }
}

async function listLeads() {
  let list;
  if (redisClient) {
    const phones = await redisClient.zRange("leads_index", 0, -1, { REV: true });
    if (!phones.length) return [];
    const raws = await Promise.all(phones.map((p) => redisClient.get(`lead:${p}`)));
    list = raws.filter(Boolean).map((r) => JSON.parse(r));
  } else {
    list = Object.values(fallbackLeads).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  return Promise.all(list.map(async (l) => ({
    ...l,
    paused: await isPaused(l.phone),
    waiting: await isWaiting(l.phone),
    lastInboundAt: await getInbound(l.phone),
    notes: await getNotes(l.phone),
    status: await getStatus(l.phone),
    followups: await getFollowupCount(l.phone),
  })));
}

// Nivel de aviso ya enviado al owner para ese lead (anti-spam).
// Orden: exploring < interested < booking
const NOTIFY_RANK = { interested: 1, booking: 2 };

async function getNotifiedLevel(phone) {
  if (redisClient) return (await redisClient.get(`notified:${phone}`)) || null;
  return fallbackNotified[phone] || null;
}

async function setNotifiedLevel(phone, level) {
  if (redisClient) {
    await redisClient.setEx(`notified:${phone}`, CONV_TTL, level);
  } else {
    fallbackNotified[phone] = level;
  }
}

// ─── PAUSA DEL BOT POR LEAD (control humano / takeover desde el panel) ──
const fallbackPaused = {};
async function setPaused(phone, val) {
  if (redisClient) {
    if (val) await redisClient.set(`paused:${phone}`, "1");
    else await redisClient.del(`paused:${phone}`);
  } else {
    if (val) fallbackPaused[phone] = true;
    else delete fallbackPaused[phone];
  }
}
async function isPaused(phone) {
  if (redisClient) return (await redisClient.get(`paused:${phone}`)) === "1";
  return !!fallbackPaused[phone];
}

// ─── "POR RESPONDER" (el cliente escribió y nadie le ha contestado) ──
// Se enciende cuando llega un mensaje del cliente con el bot en pausa (control humano)
// y se apaga cuando el bot responde solo o cuando el estudio responde a mano.
const fallbackWaiting = {};
async function setWaiting(phone, val) {
  if (redisClient) {
    if (val) await redisClient.set(`waiting:${phone}`, "1");
    else await redisClient.del(`waiting:${phone}`);
  } else {
    if (val) fallbackWaiting[phone] = true;
    else delete fallbackWaiting[phone];
  }
}
async function isWaiting(phone) {
  if (redisClient) return (await redisClient.get(`waiting:${phone}`)) === "1";
  return !!fallbackWaiting[phone];
}

// ─── ÚLTIMO MENSAJE ENTRANTE (ventana de 24h de WhatsApp) ───────────
// Marca cuándo escribió el cliente por última vez; el panel calcula si la ventana sigue abierta.
const fallbackInbound = {};
async function setInbound(phone, ts) {
  if (redisClient) await redisClient.setEx(`inbound:${phone}`, CONV_TTL, String(ts));
  else fallbackInbound[phone] = ts;
}
async function getInbound(phone) {
  if (redisClient) { const v = await redisClient.get(`inbound:${phone}`); return v ? parseInt(v) : null; }
  return fallbackInbound[phone] || null;
}

// ─── SEGUIMIENTO AUTOMÁTICO TRAS 24h (re-enganche de ventas) ────────
// Cuenta cuántas plantillas de follow-up se han mandado en la racha "fría" actual.
// Se reinicia en cuanto el cliente responde (vuelve a abrir la ventana de 24h).
const fallbackFollowup = {};
async function getFollowupCount(phone) {
  if (redisClient) { const v = await redisClient.get(`followup:${phone}`); return v ? parseInt(v) : 0; }
  return fallbackFollowup[phone] || 0;
}
async function setFollowupCount(phone, n) {
  if (redisClient) await redisClient.setEx(`followup:${phone}`, 30 * 24 * 3600, String(n));
  else fallbackFollowup[phone] = n;
}
async function resetFollowup(phone) {
  if (redisClient) await redisClient.del(`followup:${phone}`);
  else delete fallbackFollowup[phone];
}

async function getLead(phone) {
  if (redisClient) {
    const d = await redisClient.get(`lead:${phone}`);
    return d ? JSON.parse(d) : null;
  }
  return fallbackLeads[phone] || null;
}

// ─── CRM MANUAL DESDE EL PANEL: notas, estado de pipeline, campos editables ──
const fallbackNotes = {}, fallbackStatus = {};
async function setNotes(phone, notes) {
  if (redisClient) await redisClient.set(`notes:${phone}`, notes || "");
  else fallbackNotes[phone] = notes || "";
}
async function getNotes(phone) {
  if (redisClient) return (await redisClient.get(`notes:${phone}`)) || "";
  return fallbackNotes[phone] || "";
}
async function setStatus(phone, status) {
  if (redisClient) await redisClient.set(`status:${phone}`, status || "");
  else fallbackStatus[phone] = status || "";
}
async function getStatus(phone) {
  if (redisClient) return (await redisClient.get(`status:${phone}`)) || "";
  return fallbackStatus[phone] || "";
}
// Fusiona campos extra (country/email/tour/travelDate/name) sobre el lead del índice.
async function updateLeadFields(phone, fields) {
  const prev = (await getLead(phone)) || { phone, intent: "interested", lastMessage: "", updatedAt: Date.now() };
  const info = { ...prev, ...fields, phone };
  if (redisClient) {
    await redisClient.set(`lead:${phone}`, JSON.stringify(info));
    await redisClient.zAdd("leads_index", { score: info.updatedAt || Date.now(), value: phone });
  } else {
    fallbackLeads[phone] = info;
  }
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
    else if (k === "tags") { out.tags = (out.tags || []).concat(v.split(",").map((s) => s.trim()).filter(Boolean)); }
    else out[k] = v.slice(0, 120);
  });
  return Object.keys(out).length ? out : null;
}

// Guarda los campos extraídos en la BD (Redis) + Sheet, sin pisar con vacíos.
async function captureLeadData(phone, fields) {
  if (!fields || !Object.keys(fields).length) return;
  // Las etiquetas se UNEN con las existentes (no pisan las que puso el estudio a mano).
  if (Array.isArray(fields.tags)) {
    const prev = (await getLead(phone)) || {};
    const set = new Set([...(Array.isArray(prev.tags) ? prev.tags : []), ...fields.tags].map((s) => String(s).trim()).filter(Boolean));
    fields = { ...fields, tags: Array.from(set).slice(0, 20) };
    // await OBLIGATORIO: sin él, el SET de logEvent (solo history, leído pre-tags) aterriza
    // DESPUÉS del write de abajo y machaca tags/followup — los tags nunca llegaban a verse.
    if (fields.tags.length) await logEvent(phone, "tag", { to: fields.tags[fields.tags.length - 1] });
  }
  await updateLeadFields(phone, { ...fields, updatedAt: Date.now() });
  writeLeadToSheet(phone, fields); // best-effort (solo escribe las llaves con columna mapeada)
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
const KEY_FIELDS = ["email", "country", "tour", "package", "riders", "pillions", "travelDate"];
function leadMissingKeyFields(l) {
  if (!l) return true;
  return KEY_FIELDS.some((k) => l[k] == null || l[k] === "");
}

async function enrichLeadFromConversation(phone, { force = false } = {}) {
  const lead = (await getLead(phone)) || { phone };
  // No repetir si ya está completo o se enriqueció hace poco (salvo force).
  if (!force && lead.enrichedAt && Date.now() - lead.enrichedAt < 12 * 3600 * 1000) return null;
  if (!force && !leadMissingKeyFields(lead)) return null;
  const history = await getConversation(phone);
  if (!history || history.length < 2) return null;
  const transcript = history
    .map((m) => `${m.role === "user" ? "Customer" : "Daniel"}: ${m.content}`)
    .join("\n")
    .slice(-6000);
  let data = null;
  try {
    const r = await anthropic.messages.create({
      model: EXTRACT_MODEL,
      max_tokens: 300,
      thinking: { type: "disabled" }, // extractor JSON: sin thinking (en Sonnet 5 iría ON por defecto y rompería el parseo/max_tokens)
      system:
        'You extract CRM fields from a WhatsApp sales chat for a motorcycle tour company. ' +
        'Return ONLY a compact JSON object — no prose, no code fences. Keys: ' +
        'name, email, country, tour ("Bali to Komodo" or "7 Islands"), ' +
        'package ("Roundtrip" | "Extreme" | "Deluxe"), riders (integer), pillions (integer), ' +
        'travelDate (free text like "late 2027"). Use null for anything not clearly stated by the customer. Never guess.',
      messages: [{ role: "user", content: transcript }],
    });
    let txt = ((r.content[0] && r.content[0].text) || "").trim();
    txt = txt.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    data = JSON.parse(txt);
  } catch (e) {
    console.error(`[${PROJECT_NAME}] enrich ${phone}: fallo extracción — ${e.message}`);
    return null;
  }
  // Solo rellenar campos VACÍOS: nunca pisar lo que ya hay (p.ej. ediciones manuales).
  const fields = {};
  ["name", "email", "country", "tour", "package", "travelDate"].forEach((k) => {
    if (data[k] && (lead[k] == null || lead[k] === "")) fields[k] = String(data[k]).slice(0, 120);
  });
  ["riders", "pillions"].forEach((k) => {
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
let fallbackCanned = null;
const DEFAULT_CANNED = [
  { title: "Saludo", text: "Hey! Thanks for reaching out 🙌 How can I help you plan your ride?" },
  { title: "Pedir datos", text: "To give you an exact quote — which tour, how many riders, and roughly when were you thinking of traveling?" },
  { title: "Proponer videollamada", text: "Want to hop on a quick video call with the team? It's free, about 30 minutes, zero pressure — they'll walk you through everything." },
];
async function getCanned() {
  if (redisClient) { const v = await redisClient.get("canned"); return v ? JSON.parse(v) : DEFAULT_CANNED; }
  return fallbackCanned || DEFAULT_CANNED;
}
async function setCanned(list) {
  if (redisClient) await redisClient.set("canned", JSON.stringify(list));
  else fallbackCanned = list;
}

// ─── CITAS / APPOINTMENTS (calendario del panel) ──────────────────
// Fase 1: almacén propio. La sincronización con Google Calendar se engancha
// después en createAppt (crear evento vía Service Account + CALENDAR_ID).
const fallbackAppts = {};
function apptTs(when) { const t = Date.parse(when); return isNaN(t) ? Date.now() : t; }

// Suma minutos a una fecha "naive" (sin zona) y devuelve otra naive — para el fin del evento.
function addMinutesNaive(naive, mins) {
  const base = naive.length === 16 ? naive + ":00" : naive;
  const d = new Date(base + "Z"); // tratar como UTC para no arrastrar la zona del servidor
  return new Date(d.getTime() + mins * 60000).toISOString().slice(0, 19);
}

async function persistAppt(appt) {
  if (redisClient) {
    await redisClient.set(`appt:${appt.id}`, JSON.stringify(appt));
    await redisClient.zAdd("appts_index", { score: apptTs(appt.when), value: appt.id });
  } else {
    fallbackAppts[appt.id] = appt;
  }
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

async function createAppt(a) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const appt = { id, phone: a.phone || "", name: a.name || "", title: a.title || "Cita", when: a.when, closer: a.closer || "", notes: a.notes || "", createdAt: Date.now() };
  await persistAppt(appt);
  if (appt.phone) logEvent(appt.phone, "appt", { title: appt.title, when: appt.when });

  // Sincroniza con Google Calendar si está configurado (Service Account + CALENDAR_ID).
  if (CALENDAR_ID && GOOGLE_SERVICE_ACCOUNT) {
    try {
      const cal = await getCalendarClient();
      const tz = CALENDAR_TZ || "Europe/Madrid";
      const startNaive = appt.when.length === 16 ? appt.when + ":00" : appt.when;
      const ev = await cal.events.insert({
        calendarId: CALENDAR_ID,
        requestBody: {
          summary: appt.title,
          description: apptDescription(appt),
          start: { dateTime: startNaive, timeZone: tz },
          end: { dateTime: addMinutesNaive(appt.when, 30), timeZone: tz },
        },
      });
      appt.eventId = ev.data.id;
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
  if (redisClient && fields.when !== undefined) {
    await redisClient.zAdd("appts_index", { score: apptTs(appt.when), value: appt.id });
  }
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
        },
      });
    } catch (e) {
      console.error(`[${PROJECT_NAME}] Calendar patch error: ${e.message}`);
    }
  }
  return appt;
}

async function listAppts() {
  if (redisClient) {
    const ids = await redisClient.zRange("appts_index", 0, -1);
    if (!ids.length) return [];
    const raws = await Promise.all(ids.map((i) => redisClient.get(`appt:${i}`)));
    return raws.filter(Boolean).map((r) => JSON.parse(r));
  }
  return Object.values(fallbackAppts).sort((x, y) => apptTs(x.when) - apptTs(y.when));
}

async function getAppt(id) {
  if (redisClient) { const r = await redisClient.get(`appt:${id}`); return r ? JSON.parse(r) : null; }
  return fallbackAppts[id] || null;
}

async function deleteAppt(id) {
  const appt = await getAppt(id);
  if (appt && appt.eventId && CALENDAR_ID && GOOGLE_SERVICE_ACCOUNT) {
    try { const cal = await getCalendarClient(); await cal.events.delete({ calendarId: CALENDAR_ID, eventId: appt.eventId }); }
    catch (e) { console.error(`[${PROJECT_NAME}] Calendar delete error: ${e.message}`); }
  }
  if (redisClient) {
    await redisClient.del(`appt:${id}`);
    await redisClient.zRem("appts_index", id);
  } else {
    delete fallbackAppts[id];
  }
}

// ─── RECORDATORIO AUTOMÁTICO AL CLIENTE (antes de la videollamada) ──
const fallbackReminded = {};
async function isReminded(id) {
  if (redisClient) return (await redisClient.get(`reminded:${id}`)) === "1";
  return !!fallbackReminded[id];
}
async function setReminded(id) {
  if (redisClient) await redisClient.setEx(`reminded:${id}`, 7 * 24 * 3600, "1");
  else fallbackReminded[id] = true;
}
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
        await sendWhatsApp(a.phone, `Hey! Quick reminder about our call: ${a.title}. Talk soon 🙌`);
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
setInterval(reminderTick, 5 * 60000); // revisar cada 5 minutos

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
setInterval(followupTick, 30 * 60000); // revisar cada 30 minutos

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
setInterval(followUpReminderTick, 30 * 60000); // revisar cada 30 minutos

// ─── INSTRUCCIONES BASE ───────────────────────────────────────────
const BASE_INSTRUCTIONS = `
CHANNEL AWARENESS (critical):
- You are inside WhatsApp. The customer is ALREADY talking to you here.
- NEVER ask for their WhatsApp number — you already have it.
- NEVER redirect them to WhatsApp, Instagram, or any other channel.

LANGUAGE RULES (critical):
- Always respond in the EXACT language the customer writes in.
- If the customer switches language mid-conversation, switch immediately and completely.
- NEVER mix languages — not even one word or expression from another language.

FORMATTING (WhatsApp — critical):
- WhatsApp uses *single asterisk* for bold, NOT double **. Never use **double asterisks**.
- URLs must ALWAYS be plain text, never wrapped in asterisks, backticks, or brackets.
- Put URLs on their own line with no formatting around them.
- No markdown headers (#), no code blocks, no HTML.

PERSONA — how to sound human, not like a bot (critical — this is what the brand voice in your context defines; these are the hard rules underneath it):
- Keep messages SHORT. One or two short lines is the default. A wall of text or a long bulleted list is the #1 thing that makes you sound like a bot — avoid both.
- Use contractions ("we'll", "it's", "you'll"). Never write like a brochure.
- Vary your openings. Never start two consecutive messages the same way. Never use "Great!", "Of course!", "Certainly!", "Absolutely!" or similar filler.
- Vary response length. Sometimes one sentence is the right answer. Not every message needs four lines.
- Do NOT use bullet lists unless the information genuinely requires comparison. Talk naturally.
- Use emojis sparingly — at most one per message, and not in every message.
- Ask ONE thing at a time. Never stack multiple questions. Never make it feel like a form.
- React to what they actually said before moving the conversation forward.

GATHERING INFO BEFORE QUOTING OR CLOSING (guidance, NOT a rigid script):
- To give an exact price you eventually need: which tour/package, how many riders, how many bikes (so you know pillions), room preference, and a rough travel window.
- Gather these naturally as the conversation flows — ask for the next most relevant piece, one at a time. Do NOT interrogate them or ask for everything up front.
- All amounts, currency, discounts and surcharges come from your context — never improvise a number or a currency.

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

CLOSING — YOUR #1 GOAL IS TO BOOK A FREE 30-MINUTE VIDEO CALL (read carefully — this is the main objective):
- For a trip this size, nobody pays a big deposit cold off a chat. So your primary goal is NOT to send a payment link — it's to get the customer onto a free, no-pressure 30-minute video call with the team, who walk them through everything and close the sale properly.
- Once the customer shows real interest (asked about price, dates, what's included, gave group size), steer warmly toward the call as the natural next step: "Want to hop on a quick video call with the team? It's free, about 30 minutes, zero pressure — they'll walk you through everything and answer all your questions."
- Keep selling the call, not the deposit. Frame it as the easy, no-commitment way to get all their answers and see if it's right for them.
- THE PAYMENT LINK IS THE EXCEPTION, NOT THE CLOSE: only send the deposit/Stripe link if the customer EXPLICITLY insists on paying right now ("I want to pay", "send me the link", "how do I pay the deposit"). Only then use [INTENT:booking][RIDERS:N]. Otherwise NEVER push payment — push the call.
- Never stall ("I'll check availability", "confirm with the team") — just offer the call and lock a time.

SCHEDULING THE CALL — THIS IS YOUR MAIN CONVERSION PATH (appointments):
- Agree on a specific date and time, and ALWAYS ask their city/timezone (riders are international — AU, US, UK). Propose a slot or ask what suits them.
- Once you know their city/country, do the timezone math FOR them: state the difference in plain words and offer a concrete slot in THEIR local time (e.g. "you're ~12h behind Bali — does 8:30 AM your time tomorrow work? That's 8:30 PM here"). Never make the customer calculate the offset.
- Confirm the exact day + hour in the CUSTOMER'S own timezone, and put that timezone label in the APPT title (e.g. "EST", "AEST", "GMT"). If a video-call tool is mentioned, tell them you'll send the meeting link at that time.
- Only once you BOTH agree on a concrete date AND time, confirm it naturally in your message AND add at the very end, on a NEW line:
  [APPT:YYYY-MM-DDTHH:MM|Short title incl. timezone]
  Example: [APPT:2026-07-15T10:00|Call w/ John re Bali-Komodo — 10:00 AEST]
- NEVER invent a date/time. Output the APPT tag only when a precise day and hour are agreed. The tag is stripped before sending — never mention it to the customer.
- After locking the call, set [INTENT:booking] (it's a hot lead) but do NOT output [RIDERS:N] — a call must never trigger a payment link.

INTENT AND RIDERS TAGGING (critical):
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

function buildSystemPrompt() {
  return `${CONTEXT}\n\n${BASE_INSTRUCTIONS}`;
}

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
async function createStripeSession(numRiders) {
  if (!stripeClient) return null;
  try {
    const session = await stripeClient.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: {
            name: `${PROJECT_NAME || "Tour"} — Booking Deposit`,
            description: `$1,000 deposit × ${numRiders} rider${numRiders > 1 ? "s" : ""}`,
          },
          unit_amount: 100000, // $1,000 in cents
        },
        quantity: numRiders,
      }],
      mode: "payment",
      success_url: STRIPE_SUCCESS_URL || "https://balimotoadventures.com/?booking=confirmed",
      cancel_url: STRIPE_CANCEL_URL || "https://balimotoadventures.com/",
    });
    console.log(`[${PROJECT_NAME}] Stripe session: ${numRiders} riders → $${numRiders * 1000}`);
    return session.url;
  } catch (e) {
    console.error(`[${PROJECT_NAME}] Stripe session error:`, e.message);
    return null;
  }
}

// ─── WHATSAPP ─────────────────────────────────────────────────────
async function sendWhatsAppResult(to, message) {
  const toClean = normalizePhone(to);
  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_ID}/messages`,
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
    return { ok: true };
  } catch (e) {
    const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    return { ok: false, error: detail };
  }
}

async function sendWhatsApp(to, message) {
  const r = await sendWhatsAppResult(to, message);
  if (!r.ok) console.error(`[${PROJECT_NAME}] Error enviando WhatsApp a ${normalizePhone(to)}:`, r.error);
}

// ─── BIBLIOTECA DE MEDIA (fotos/vídeos que el bot puede enviar; se gestiona desde el panel) ──
let fallbackMediaLib = [];
async function getMediaLib() {
  if (redisClient) { const r = await redisClient.get("media_lib"); return r ? JSON.parse(r) : []; }
  return fallbackMediaLib;
}
async function setMediaLib(list) {
  const arr = Array.isArray(list) ? list.slice(0, 50) : [];
  if (redisClient) await redisClient.set("media_lib", JSON.stringify(arr));
  else fallbackMediaLib = arr;
  return arr;
}

// Archivos subidos desde el panel (foto/vídeo local) → se guardan como blob en Redis
// y se sirven por /media/:id, para que el bot los envíe por link sin hosting externo.
const fallbackBlobs = {};
async function setBlob(id, mime, b64) {
  const payload = JSON.stringify({ mime, data: b64 });
  if (redisClient) await redisClient.set(`mediablob:${id}`, payload);
  else fallbackBlobs[id] = payload;
}
async function getBlob(id) {
  const raw = redisClient ? await redisClient.get(`mediablob:${id}`) : fallbackBlobs[id];
  return raw ? JSON.parse(raw) : null;
}

// Último link de pago generado por lead (para reenviarlo sin crear un cobro nuevo).
const fallbackLastLink = {};
async function setLastLink(phone, url) {
  if (redisClient) await redisClient.setEx(`lastlink:${phone}`, 24 * 3600, url);
  else fallbackLastLink[phone] = url;
}
async function getLastLink(phone) {
  if (redisClient) return (await redisClient.get(`lastlink:${phone}`)) || "";
  return fallbackLastLink[phone] || "";
}
// Envía una foto/vídeo por URL (WhatsApp Cloud API acepta media por link público).
async function sendWhatsAppMedia(to, item) {
  const toClean = normalizePhone(to);
  const type = item.type === "video" ? "video" : "image";
  const payload = { messaging_product: "whatsapp", to: toClean, type };
  payload[type] = { link: item.url };
  if (item.caption) payload[type].caption = item.caption;
  try {
    await axios.post(`https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_ID}/messages`, payload,
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } });
    console.log(`[${PROJECT_NAME}] Media "${item.label}" (${type}) enviada a ${toClean}`);
    return { ok: true };
  } catch (e) {
    const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    console.error(`[${PROJECT_NAME}] Error enviando media "${item.label}" a ${toClean}: ${detail}`);
    return { ok: false, error: detail };
  }
}

// Mensaje de PLANTILLA (única forma de escribir al owner fuera de su ventana de 24h)
async function sendWhatsAppTemplate(to, templateName, langCode, bodyParams = []) {
  const toClean = normalizePhone(to);
  const clean = (s) => String(s).replace(/[\r\n\t]+/g, " ").replace(/ {4,}/g, "   ").trim();
  const components = bodyParams.length
    ? [{ type: "body", parameters: bodyParams.map((t) => ({ type: "text", text: clean(t) || "-" })) }]
    : [];
  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: toClean,
        type: "template",
        template: { name: templateName, language: { code: langCode || "es" }, components },
      },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    );
    console.log(`[${PROJECT_NAME}] Plantilla "${templateName}" enviada a ${toClean}`);
    return { ok: true };
  } catch (e) {
    const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    console.error(`[${PROJECT_NAME}] Error enviando plantilla "${templateName}" a ${toClean}:`, detail);
    return { ok: false, error: detail };
  }
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
    history.push({ role: "assistant", content: `Hey ${firstName}! 👋 Saw you filled out our Instagram form — I'm Daniel from ${PROJECT_NAME}, here to help with your trip. What would you like to know?`, ts: Date.now(), by: "bot" });
    await saveConversation(phone, history);
  } catch (e) { /* best-effort */ }
  await logEvent(phone, "outreach");
  return { ok: true };
}

// Avisa al owner. Usa plantilla si está configurada; si no, texto libre (solo llega si su ventana 24h está abierta).
async function notifyOwner(kind, lead) {
  if (!OWNER_PHONE) return;
  const label = kind === "booking" ? "🔔 LEAD CALIENTE — quiere reservar" : "🟡 Nuevo cliente interesado";
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
    // Fallback: texto libre (puede fallar si el owner no escribió al bot en las últimas 24h)
    await sendWhatsApp(
      OWNER_PHONE,
      `${label} — ${PROJECT_NAME}\n\n${who}\nÚltimo mensaje: "${msg}"\n\n(Configura ALERT_TEMPLATE_NAME para recibir esto siempre.)`
    );
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
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];
    if (!message || message.type !== "text") return;

    const from = message.from;
    const text = message.text.body;
    const profileName = change.value.contacts?.[0]?.profile?.name || "";

    // ── Mensaje del dueño: reenviar al cliente pendiente ──────────
    if (isOwner(from)) {
      const pending = await escPop();
      if (pending) {
        console.log(`[${PROJECT_NAME}] Owner respondió escalación → reenviando a ${pending.customerName || pending.customerPhone}`);
        await sendWhatsApp(
          pending.customerPhone,
          text
        );
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

    // ── Control humano: si el bot está en pausa para este lead, guarda y calla ──
    if (await isPaused(from)) {
      await saveConversation(from, history);
      const prev = await getLead(from);
      await recordLead(from, profileName || (prev && prev.name), (prev && prev.intent) || "interested", text);
      await setInbound(from, Date.now());
      await resetFollowup(from);    // respondió → reinicia la cadencia de seguimiento
      await setWaiting(from, true); // el cliente espera respuesta humana → marcar en el panel
      console.log(`[${PROJECT_NAME}] Lead ${from} en pausa (control humano) — mensaje guardado, bot NO responde`);
      return;
    }

    await setInbound(from, Date.now()); // reinicia la ventana de 24h de WhatsApp
    await resetFollowup(from);           // respondió → reinicia la cadencia de seguimiento

    // Media disponible (gestionada desde el panel): se inyecta para que el bot solo ofrezca lo que existe.
    const mediaLib = await getMediaLib();
    const mediaHint = mediaLib.length
      ? "\n\nMEDIA YOU CAN SEND (real photos/videos that reinforce the pitch — use sparingly, at most 1–2 per conversation, only when it genuinely helps: the customer asks to see the trip/route/bikes, or as a warm intro). Available:\n"
        + mediaLib.map((m) => `- "${m.label}" (${m.type})${m.caption ? " — " + m.caption : ""}`).join("\n")
        + "\nTo send, append on its own NEW line at the very end: [MEDIA:label] (exact label; several allowed comma-separated). Stripped before sending — never mention it. Only send labels from this list; never invent one."
      : "";
    // Streaming (no create): evita el "Premature close" en respuestas no-stream y mantiene viva la conexión.
    const response = await claudeMessage({
      model: MODEL,
      max_tokens: 500,
      thinking: { type: "disabled" }, // respuestas cortas y baratas; en Sonnet 5 el thinking va ON por defecto y se comería el max_tokens
      system: buildSystemPrompt() + mediaHint,
      messages: history.map((m) => ({ role: m.role, content: m.content })), // solo role+content (ts/by/media son internos)
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
    reply = reply.replace(/\[INTENT:\w+\]/g, "").replace(/\[RIDERS:\d+\]/g, "").replace(/\[APPT:[^\]]+\]/g, "").replace(/\[LEAD[^\]]*\]/gi, "").replace(/\[MEDIA:[^\]]*\]/gi, "").replace(/\[RESEND_LINK\]/gi, "").trim();
    // Strip markdown that WhatsApp sends literally (breaks URLs)
    reply = reply.replace(/\*\*(https?:\/\/[^\s*]+)\*\*/g, "$1"); // **URL** → URL
    reply = reply.replace(/\*\*([^*\n]+)\*\*/g, "*$1*");          // **bold** → *bold*

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

    history.push({ role: "assistant", content: reply, ts: Date.now(), by: "bot" });
    await saveConversation(from, history);

    await sendWhatsApp(from, reply);
    // Fotos/vídeos que el bot decidió enviar ([MEDIA:label]) → se buscan en la biblioteca, se mandan y se anotan en el historial.
    if (mediaMatch) {
      const wanted = mediaMatch[1].split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      const toSend = mediaLib.filter((m) => wanted.includes(String(m.label).toLowerCase()));
      for (const item of toSend) {
        await sendWhatsAppMedia(from, item);
        history.push({ role: "assistant", content: item.caption || (item.type === "video" ? "[vídeo]" : "[foto]"), ts: Date.now(), by: "bot", media: { type: item.type, url: item.url, caption: item.caption || "" } });
      }
      if (toSend.length) await saveConversation(from, history);
      if (wanted.length && !toSend.length) console.warn(`[${PROJECT_NAME}] [MEDIA] pedido sin match en biblioteca: ${wanted.join(", ")}`);
    }
    await setWaiting(from, false); // el bot ya respondió → no queda pendiente
    await saveLead(from, profileName, text, intent);
    await recordLead(from, profileName, intent, text);  // índice para el panel web
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
    if (apptMatch) {
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
      await escPush(from, profileName, text);
      await sendWhatsApp(
        OWNER_PHONE,
        `❓ ${PROJECT_NAME} — pregunta sin respuesta\n\n*${profileName || from}* pregunta:\n"${text}"\n\nResponde a este mensaje y se lo reenviaré.`
      );
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

    // ── Enriquecimiento oportunista (no bloquea): si a la ficha le faltan datos
    //    que el chat ya tiene, los extrae en segundo plano. Debounce 15 min. ──
    const freshLead = await getLead(from);
    if (leadMissingKeyFields(freshLead) &&
        (!freshLead.enrichedAt || Date.now() - freshLead.enrichedAt > 15 * 60 * 1000)) {
      enrichLeadFromConversation(from).catch(() => {});
    }
  } catch (e) {
    console.error(`[${PROJECT_NAME}] Error procesando mensaje:`, e.message);
  }
});

// ─── PANEL WEB (control de chats del bot) ─────────────────────────
// HTML del panel en panel.html (estilo HighLevel). Fallback mínimo si falta el archivo.
const ADMIN_HTML = fs.existsSync("panel.html")
  ? fs.readFileSync("panel.html", "utf8")
  : "<!doctype html><meta charset='utf-8'><body style='font-family:sans-serif;padding:40px'>Panel: falta panel.html en el despliegue.</body>";

function adminAuth(req, res) {
  if (!ADMIN_PASSWORD) { res.status(503).json({ error: "panel no configurado (falta ADMIN_PASSWORD)" }); return false; }
  // La key viaja por cabecera (X-Admin-Key); se acepta ?key= como fallback retrocompatible.
  const key = req.get("x-admin-key") || req.query.key;
  if (key !== ADMIN_PASSWORD) { res.status(403).json({ error: "forbidden" }); return false; }
  return true;
}

app.get("/admin", (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(503).send("Panel no configurado: define ADMIN_PASSWORD en Railway.");
  res.type("html").send(ADMIN_HTML.replace(/__PROJECT__/g, PROJECT_NAME || "Bot"));
});

// URL dedicada a la base de datos: sirve el mismo panel; la página abre la vista BD al cargar.
app.get("/admin/db", (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(503).send("Panel no configurado: define ADMIN_PASSWORD en Railway.");
  res.type("html").send(ADMIN_HTML.replace(/__PROJECT__/g, PROJECT_NAME || "Bot"));
});

app.get("/admin/api/leads", async (req, res) => {
  if (!adminAuth(req, res)) return;
  try { res.json(await listLeads()); } catch (e) { res.status(500).json({ error: e.message }); }
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
    if (redisClient) count = await redisClient.zCard("leads_index");
    else count = Object.keys(fallbackLeads).length;
  } catch (e) { /* best-effort */ }
  res.json({ storage: redisClient ? "redis" : "ram", leads: count });
});

app.get("/admin/api/conv/:phone", async (req, res) => {
  if (!adminAuth(req, res)) return;
  try { res.json(await getConversation(req.params.phone)); } catch (e) { res.status(500).json({ error: e.message }); }
});

// Responder a mano (toma de control). Envía por WhatsApp y pausa el bot para ese lead.
app.post("/admin/api/send", async (req, res) => {
  if (!adminAuth(req, res)) return;
  const { phone, text } = req.body || {};
  if (!phone || !text) return res.status(400).json({ error: "phone y text requeridos" });
  const r = await sendWhatsAppResult(phone, text);
  if (!r.ok) return res.status(502).json({ error: r.error });
  const history = await getConversation(phone);
  history.push({ role: "assistant", content: text, ts: Date.now(), by: "human" });
  await saveConversation(phone, history);
  await setPaused(phone, true); // al responder a mano, el bot deja de contestar a ese lead
  await setWaiting(phone, false); // ya respondido por el estudio → quitar el pendiente
  const prev = await getLead(phone);
  await recordLead(phone, prev && prev.name, (prev && prev.intent) || "interested", text);
  res.json({ ok: true });
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
  await setPaused(phone, true);
  await setWaiting(phone, false);
  const prev = await getLead(phone);
  await recordLead(phone, prev && prev.name, (prev && prev.intent) || "interested", caption || "[media]");
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

// ── CRM: campos editables de la ficha (name/country/email/tour/travelDate/owner/tags/seguimiento) ──
app.post("/admin/api/lead", async (req, res) => {
  if (!adminAuth(req, res)) return;
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: "phone requerido" });
  const prev = (await getLead(phone)) || {};
  const fields = {};
  ["name", "country", "email", "tour", "package", "riders", "pillions", "travelDate", "owner", "nextFollowUp", "tags", "archived"].forEach((k) => {
    if (req.body[k] != null) fields[k] = req.body[k];
  });
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
  if (redisClient) {
    await redisClient.del(`lead:${phone}`, `notes:${phone}`, `status:${phone}`, `conv:${phone}`, `paused:${phone}`, `waiting:${phone}`, `inbound:${phone}`, `followup:${phone}`, `notified:${phone}`);
    await redisClient.zRem("leads_index", phone);
  } else {
    delete fallbackLeads[phone]; delete fallbackNotes[phone]; delete fallbackStatus[phone];
    delete fallbackPaused[phone]; delete fallbackWaiting[phone]; delete fallbackInbound[phone];
    delete fallbackFollowup[phone]; delete fallbackNotified[phone];
    delete fallbackMemory[phone];
  }
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
        await sendIntro(phone);
      } else if (action === "delete") {
        await deleteLead(phone);
      } else { continue; }
      n++;
    }
    res.json({ ok: true, count: n });
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
  })).filter((m) => /^https?:\/\//i.test(m.url) && m.label);
  try { res.json(await setMediaLib(clean)); } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Citas / calendario ──
app.get("/admin/api/appts", async (req, res) => {
  if (!adminAuth(req, res)) return;
  try { res.json(await listAppts()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/admin/api/appts", async (req, res) => {
  if (!adminAuth(req, res)) return;
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
  try { await deleteAppt(req.params.id); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────
app.get("/", (req, res) => res.send(`${PROJECT_NAME || "Bot"} activo ✅`));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`[${PROJECT_NAME}] Bot escuchando en puerto ${PORT}`);
  console.log(`[${PROJECT_NAME}] OWNER_PHONE: ${OWNER_PHONE ? normalizePhone(OWNER_PHONE) : "⚠️  NO CONFIGURADO"}`);
  console.log(`[${PROJECT_NAME}] CRM (BD): ${redisClient ? "Redis (persistente)" : "RAM (volátil — configura REDIS_URL)"}`);

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
  setTimeout(() => enrichSweep(20), 8000);
  setInterval(() => enrichSweep(10), 30 * 60 * 1000);
});
