import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { google } from "googleapis";
import axios from "axios";
import fs from "fs";
import { createClient } from "redis";

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
} = process.env;

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

PERSONA — how to sound human, not like a bot:
- Tone: warm but professional. Like a knowledgeable guide who works for a premium agency — not a best friend, not a corporate robot.
- Vary your openings. Never start two consecutive messages the same way. Never use "Great!", "Of course!", "Certainly!" or similar filler phrases.
- Vary response length. Sometimes one sentence is the right answer. Not every message needs 4 lines.
- Do NOT use bullet lists unless the information genuinely requires comparison. Talk naturally.
- Use emojis sparingly — at most one per message, and not in every message. Overusing them signals bot.
- Ask ONE question at a time. Never stack multiple questions in one message.
- When you need information to calculate a price, ask for it conversationally, not like a form.

SALES FLOW — always follow this order before quoting a final price:
1. Understand which tour interests them (or guide them if unsure)
2. Ask how many riders total
3. Ask if any rider is pillion (co-rider on the same bike) — if yes, apply -EUR 350 per pillion
4. For Bali to Komodo: ask which package fits their style (Roundtrip / Extreme / Deluxe)
5. Ask about solo room preference — if yes, apply +EUR 500
6. Ask preferred dates or travel window — this is required before closing
7. Once all info is collected, give the exact final price and send the booking link

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

CLOSING A BOOKING:
- When you have: tour, package, number of riders, and approximate dates → send the Stripe link. Full stop.
- The booking deposit is EUR 1,000 PER PERSON. Always calculate and state the total deposit (e.g. 4 people = EUR 4,000 deposit now).
- Do NOT ask for date confirmation from any team, staff, or human. Dates close to the current date are fine — just close the sale.
- Do NOT say "I'll check availability", "confirm with the team", or anything similar before sending the link.
- If you have a concern about very short-notice dates, use [INTENT:escalate] silently — never say "contact the team".

INTENT TAGGING (critical):
At the very end of your response, on a NEW LINE, add ONE of these tags:
[INTENT:exploring] — just asking general questions, not yet committed
[INTENT:interested] — showing real interest in a specific tour/package
[INTENT:booking] — wants to reserve, pay, or commit now
[INTENT:escalate] — you genuinely don't know the answer and cannot derive it from your context
This tag is stripped before sending. NEVER mention it or explain it to the customer.
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
    console.error(`[${PROJECT_NAME}] Error guardando lead:`, e.message);
  }
}

// ─── WHATSAPP ─────────────────────────────────────────────────────
async function sendWhatsApp(to, message) {
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
  } catch (e) {
    const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    console.error(`[${PROJECT_NAME}] Error enviando WhatsApp a ${toClean}:`, detail);
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

    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 500,
      system: buildSystemPrompt(),
      messages: history,
    });

    let reply = response.content[0].text;
    const intentMatch = reply.match(/\[INTENT:(\w+)\]/);
    const intent = intentMatch ? intentMatch[1] : "exploring";
    reply = reply.replace(/\[INTENT:\w+\]/g, "").trim();
    // Strip markdown that WhatsApp sends literally (breaks URLs)
    reply = reply.replace(/\*\*(https?:\/\/[^\s*]+)\*\*/g, "$1"); // **URL** → URL
    reply = reply.replace(/\*\*([^*\n]+)\*\*/g, "*$1*");          // **bold** → *bold*

    history.push({ role: "assistant", content: reply });
    await saveConversation(from, history);

    await sendWhatsApp(from, reply);
    await saveLead(from, profileName, text, intent);

    // ── Escalación: notificar al dueño en silencio ────────────────
    if (intent === "escalate" && OWNER_PHONE) {
      await escPush(from, profileName, text);
      await sendWhatsApp(
        OWNER_PHONE,
        `❓ ${PROJECT_NAME} — pregunta sin respuesta\n\n*${profileName || from}* pregunta:\n"${text}"\n\nResponde a este mensaje y se lo reenviaré.`
      );
      console.log(`[${PROJECT_NAME}] Escalación registrada — ${profileName || from}: "${text.slice(0, 60)}"`);
    }

    // ── Lead caliente: avisar al dueño ───────────────────────────
    if (intent === "booking" && OWNER_PHONE) {
      await sendWhatsApp(
        OWNER_PHONE,
        `🔔 LEAD CALIENTE — ${PROJECT_NAME}\n\n${profileName || from} quiere reservar.\nÚltimo mensaje: "${text}"`
      );
    }
  } catch (e) {
    console.error(`[${PROJECT_NAME}] Error procesando mensaje:`, e.message);
  }
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────
app.get("/", (req, res) => res.send(`${PROJECT_NAME || "Bot"} activo ✅`));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[${PROJECT_NAME}] Bot escuchando en puerto ${PORT}`);
  console.log(`[${PROJECT_NAME}] OWNER_PHONE: ${OWNER_PHONE ? normalizePhone(OWNER_PHONE) : "⚠️  NO CONFIGURADO"}`);
  console.log(`[${PROJECT_NAME}] SHEET_ID: ${SHEET_ID ? SHEET_ID.slice(0, 10) + "..." : "⚠️  NO CONFIGURADO"}`);
  console.log(`[${PROJECT_NAME}] Redis: ${redisClient ? "conectado" : "RAM fallback"}`);
});
