import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { google } from "googleapis";
import axios from "axios";

const app = express();
app.use(express.json());

// ─── CONFIGURACIÓN (variables de entorno — distintas por proyecto) ──
const {
  PROJECT_NAME,             // "B2K" o "Sumba Rental" — solo para logs
  WHATSAPP_TOKEN,           // Access token permanente de Meta
  WHATSAPP_PHONE_ID,        // ID del número de teléfono
  WHATSAPP_VERIFY_TOKEN,    // texto secreto que tú inventas
  ANTHROPIC_API_KEY,        // sk-ant-...
  GOOGLE_CREDENTIALS,       // JSON de credenciales (string)
  GOOGLE_TOKEN,             // JSON del token (string)
  SHEET_ID,                 // ID del Google Sheet del CRM
  OWNER_PHONE,              // tu número para avisos de reserva
  BOT_CONTEXT,              // EL CONTEXTO DEL NEGOCIO (system prompt)
  BOT_MODEL,                // modelo de Claude (opcional)
} = process.env;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const MODEL = BOT_MODEL || "claude-sonnet-4-6";

// ─── INSTRUCCIONES BASE (iguales para todos los bots) ─────────────
// El contexto específico del negocio viene de BOT_CONTEXT.
// Estas instrucciones de comportamiento son universales.
const BASE_INSTRUCTIONS = `
CHANNEL AWARENESS (critical):
- You are operating inside WhatsApp. The customer is ALREADY talking to you here.
- NEVER ask for their WhatsApp number — you already have it.
- NEVER redirect them to WhatsApp, Instagram, or any other channel. You ARE the channel.
- If you need to mention contact, say "reply here" or "let me know here".

LANGUAGE RULES (critical):
- Always respond in the EXACT language the customer writes in.
- If the customer switches language mid-conversation, switch immediately and completely.
- NEVER mix languages in a single response — not even one word, expression, or phrase.
- If the customer writes in Spanish, respond 100% in Spanish. Same for any other language.

GENERAL BEHAVIOR:
- Be concise — this is WhatsApp, not email. Usually 2-4 sentences.
- Be warm, professional, and build genuine excitement.
- Be self-sufficient: answer pricing, routes, inclusions, and logistics yourself using the information you have. Do NOT say "let me check with the team" for information that is in your context.
- Only defer to a human for: confirming specific available dates, processing payments, or closing a real booking.
- If the customer wants to book, reserve, pay, or commit, tell them the team will reach out to finalize the details.

INTENT TAGGING (critical):
At the very end of your response, on a NEW LINE, add a hidden tag:
[INTENT:exploring] — just asking general questions
[INTENT:interested] — showing real interest in a specific product/tour
[INTENT:booking] — wants to reserve, pay, or commit now
This tag is removed before sending. NEVER mention it or explain it to the customer.
`;

function buildSystemPrompt() {
  return `${BOT_CONTEXT}\n\n${BASE_INSTRUCTIONS}`;
}

// ─── MEMORIA DE CONVERSACIONES (en RAM, por número) ───────────────
const conversations = {};

// ─── GOOGLE SHEETS (CRM) ──────────────────────────────────────────
async function getSheetsClient() {
  const credentials = JSON.parse(GOOGLE_CREDENTIALS);
  const token = JSON.parse(GOOGLE_TOKEN);
  const { client_secret, client_id } = credentials.installed;
  const auth = new google.auth.OAuth2(client_id, client_secret, "http://localhost:3000");
  auth.setCredentials(token);
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

    if (!conversations[from]) conversations[from] = [];
    conversations[from].push({ role: "user", content: text });
    if (conversations[from].length > 10) {
      conversations[from] = conversations[from].slice(-10);
    }

    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 500,
      system: buildSystemPrompt(),
      messages: conversations[from],
    });

    let reply = response.content[0].text;
    const intentMatch = reply.match(/\[INTENT:(\w+)\]/);
    const intent = intentMatch ? intentMatch[1] : "exploring";
    reply = reply.replace(/\[INTENT:\w+\]/g, "").trim();

    conversations[from].push({ role: "assistant", content: reply });

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
