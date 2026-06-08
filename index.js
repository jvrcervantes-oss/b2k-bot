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
  PROJECT_NAME,               // "B2K" o "Sumba Rental" — solo para logs
  WHATSAPP_TOKEN,             // Access token permanente de Meta
  WHATSAPP_PHONE_ID,          // ID del número de teléfono
  WHATSAPP_VERIFY_TOKEN,      // texto secreto que tú inventas
  ANTHROPIC_API_KEY,          // sk-ant-...
  GOOGLE_SERVICE_ACCOUNT,     // JSON de service account (string)
  SHEET_ID,                   // ID del Google Sheet del CRM
  OWNER_PHONE,                // tu número para avisos de reserva
  BOT_CONTEXT,                // fallback si no existe context.md
  BOT_MODEL,                  // modelo de Claude (opcional)
  REDIS_URL,                  // URL de Redis (Railway lo inyecta automáticamente)
} = process.env;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const MODEL = BOT_MODEL || "claude-sonnet-4-6";

// Lee el contexto desde context.md si existe; si no, usa la variable de entorno
const CONTEXT = fs.existsSync("context.md")
  ? fs.readFileSync("context.md", "utf8")
  : BOT_CONTEXT;

// ─── REDIS (memoria persistente de conversaciones) ────────────────
const CONV_TTL = 7 * 24 * 60 * 60; // 7 días en segundos
const fallbackMemory = {}; // RAM fallback si Redis no está disponible
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

// ─── INSTRUCCIONES BASE (iguales para todos los bots) ─────────────
const BASE_INSTRUCTIONS = `
CHANNEL AWARENESS (critical):
- You are inside WhatsApp. The customer is ALREADY talking to you here.
- NEVER ask for their WhatsApp number — you already have it.
- NEVER redirect them to WhatsApp, Instagram, or any other channel.
- If you need to mention contact, say "reply here" or "let me know here".

LANGUAGE RULES (critical):
- Always respond in the EXACT language the customer writes in.
- If the customer switches language mid-conversation, switch immediately and completely.
- NEVER mix languages — not even one word or expression from another language.

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
- NEVER say "let me check with the team" for information you already have.
- Only involve a human for: confirming specific date availability, or exceptional requests outside your context.

CLOSING A BOOKING:
- When the lead is ready to book, send the Stripe deposit link directly. Do not wait for a human.
- Confirm the EUR 1,000 deposit amount and the tour + package they chose before sending the link.

INTENT TAGGING (critical):
At the very end of your response, on a NEW LINE, add a hidden tag:
[INTENT:exploring] — just asking general questions
[INTENT:interested] — showing real interest in a specific product/tour
[INTENT:booking] — wants to reserve, pay, or commit now
This tag is removed before sending. NEVER mention it or explain it to the customer.
`;

function buildSystemPrompt() {
  return `${CONTEXT}\n\n${BASE_INSTRUCTIONS}`;
}

// ─── GOOGLE SHEETS (CRM) — Service Account ────────────────────────
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

// ─── ENVIAR MENSAJE WHATSAPP ──────────────────────────────────────
async function sendWhatsApp(to, message) {
  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
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
    console.error(`[${PROJECT_NAME}] Error enviando WhatsApp:`, e.response?.data || e.message);
  }
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

    history.push({ role: "assistant", content: reply });
    await saveConversation(from, history);

    await sendWhatsApp(from, reply);
    await saveLead(from, profileName, text, intent);

    if (intent === "booking" && OWNER_PHONE) {
      await sendWhatsApp(
        OWNER_PHONE,
        `🔔 LEAD CALIENTE — ${PROJECT_NAME}\n\n${profileName || from} quiere reservar.\nÚltimo mensaje: "${text}"\n\nEntra a responderle personalmente.`
      );
    }
  } catch (e) {
    console.error(`[${PROJECT_NAME}] Error procesando mensaje:`, e.message);
  }
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────
app.get("/", (req, res) => res.send(`${PROJECT_NAME || "Bot"} activo ✅`));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[${PROJECT_NAME}] Bot escuchando en puerto ${PORT}`));
