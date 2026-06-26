import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { google } from "googleapis";
import axios from "axios";
import fs from "fs";
import { createClient } from "redis";
import Stripe from "stripe";

const app = express();
app.use(express.json());

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
} = process.env;

const stripeClient = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
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
  const info = {
    phone,
    name: name || "",
    intent: intent || "exploring",
    lastMessage: (lastMessage || "").slice(0, 200),
    updatedAt: Date.now(),
  };
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
  return Promise.all(list.map(async (l) => ({ ...l, paused: await isPaused(l.phone) })));
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
async function getLead(phone) {
  if (redisClient) {
    const d = await redisClient.get(`lead:${phone}`);
    return d ? JSON.parse(d) : null;
  }
  return fallbackLeads[phone] || null;
}

// ─── CITAS / APPOINTMENTS (calendario del panel) ──────────────────
// Fase 1: almacén propio. La sincronización con Google Calendar se engancha
// después en createAppt (crear evento vía Service Account + CALENDAR_ID).
const fallbackAppts = {};
function apptTs(when) { const t = Date.parse(when); return isNaN(t) ? Date.now() : t; }

async function createAppt(a) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const appt = { id, phone: a.phone || "", name: a.name || "", title: a.title || "Cita", when: a.when, createdAt: Date.now() };
  if (redisClient) {
    await redisClient.set(`appt:${id}`, JSON.stringify(appt));
    await redisClient.zAdd("appts_index", { score: apptTs(a.when), value: id });
  } else {
    fallbackAppts[id] = appt;
  }
  // TODO Google Calendar: si CALENDAR_ID está, crear evento con getCalendarClient()
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

async function deleteAppt(id) {
  if (redisClient) {
    await redisClient.del(`appt:${id}`);
    await redisClient.zRem("appts_index", id);
  } else {
    delete fallbackAppts[id];
  }
}

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
- Agree on a specific date and time, and ALWAYS ask their timezone (riders are international — AU, US, UK). Propose a slot or ask what suits them.
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
    console.log(`[${PROJECT_NAME}] Aviso (plantilla "${templateName}") enviado al owner`);
  } catch (e) {
    const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    console.error(`[${PROJECT_NAME}] Error enviando plantilla al owner:`, detail);
  }
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
    history.push({ role: "user", content: text });

    // ── Control humano: si el bot está en pausa para este lead, guarda y calla ──
    if (await isPaused(from)) {
      await saveConversation(from, history);
      const prev = await getLead(from);
      await recordLead(from, profileName || (prev && prev.name), (prev && prev.intent) || "interested", text);
      console.log(`[${PROJECT_NAME}] Lead ${from} en pausa (control humano) — mensaje guardado, bot NO responde`);
      return;
    }

    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 500,
      system: buildSystemPrompt(),
      messages: history,
    });

    let reply = response.content[0].text;
    const intentMatch = reply.match(/\[INTENT:(\w+)\]/);
    const intent = intentMatch ? intentMatch[1] : "exploring";
    const ridersMatch = reply.match(/\[RIDERS:(\d+)\]/);
    const numRiders = ridersMatch ? parseInt(ridersMatch[1]) : null;
    const apptMatch = reply.match(/\[APPT:([^\]|]+)\|([^\]]+)\]/);
    reply = reply.replace(/\[INTENT:\w+\]/g, "").replace(/\[RIDERS:\d+\]/g, "").replace(/\[APPT:[^\]]+\]/g, "").trim();
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
      if (sessionUrl) reply = reply + "\n\n" + sessionUrl;
      else console.error(`[${PROJECT_NAME}] booking detectado pero no se pudo crear la sesión Stripe`);
    } else if (numRiders && intent === "booking" && !stripeClient) {
      console.error(`[${PROJECT_NAME}] booking detectado pero stripeClient es null — falta STRIPE_SECRET_KEY en el entorno`);
    }

    history.push({ role: "assistant", content: reply });
    await saveConversation(from, history);

    await sendWhatsApp(from, reply);
    await saveLead(from, profileName, text, intent);
    await recordLead(from, profileName, intent, text);  // índice para el panel web

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
  if (req.query.key !== ADMIN_PASSWORD) { res.status(403).json({ error: "forbidden" }); return false; }
  return true;
}

app.get("/admin", (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(503).send("Panel no configurado: define ADMIN_PASSWORD en Railway.");
  res.type("html").send(ADMIN_HTML.replace(/__PROJECT__/g, PROJECT_NAME || "Bot"));
});

app.get("/admin/api/leads", async (req, res) => {
  if (!adminAuth(req, res)) return;
  try { res.json(await listLeads()); } catch (e) { res.status(500).json({ error: e.message }); }
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
  history.push({ role: "assistant", content: text });
  await saveConversation(phone, history);
  await setPaused(phone, true); // al responder a mano, el bot deja de contestar a ese lead
  const prev = await getLead(phone);
  await recordLead(phone, prev && prev.name, (prev && prev.intent) || "interested", text);
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

// ── Citas / calendario ──
app.get("/admin/api/appts", async (req, res) => {
  if (!adminAuth(req, res)) return;
  try { res.json(await listAppts()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/admin/api/appts", async (req, res) => {
  if (!adminAuth(req, res)) return;
  const { phone, name, title, when } = req.body || {};
  if (!when) return res.status(400).json({ error: "when (fecha/hora) requerido" });
  try { res.json(await createAppt({ phone, name, title, when })); } catch (e) { res.status(500).json({ error: e.message }); }
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
  console.log(`[${PROJECT_NAME}] SHEET_ID: ${SHEET_ID ? SHEET_ID.slice(0, 10) + "..." : "⚠️  NO CONFIGURADO"}`);
  console.log(`[${PROJECT_NAME}] Redis: ${redisClient ? "conectado" : "RAM fallback"}`);

  // Test Google Sheets connection at startup
  if (SHEET_ID && GOOGLE_SERVICE_ACCOUNT) {
    try {
      const sheets = await getSheetsClient();
      await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
      console.log(`[${PROJECT_NAME}] Google Sheets: ✅ conectado`);
    } catch (e) {
      console.error(`[${PROJECT_NAME}] Google Sheets: ❌ HTTP ${e.code || '?'} — ${e.message}`);
    }
  } else {
    console.warn(`[${PROJECT_NAME}] Google Sheets: ⚠️  SHEET_ID o GOOGLE_SERVICE_ACCOUNT no configurados`);
  }
});
