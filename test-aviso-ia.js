// Aviso de IA en el primer mensaje (BBM-50, 11-oct-2026). node --test test-aviso-ia.js
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { AVISO_IA, avisoYaDado, idiomaAviso, conAviso } from "./aviso-ia.js";

const src = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8").split(String.fromCharCode(13)).join("");
const ctx = fs.readFileSync(new URL("./context-balibest.md", import.meta.url), "utf8");

test("los tres textos dicen Daniel, IA y que se puede pedir una persona", () => {
  assert.deepStrictEqual(Object.keys(AVISO_IA).sort(), ["en", "es", "id"]);
  assert.match(AVISO_IA.en, /Daniel/); assert.match(AVISO_IA.en, /\bAI\b/); assert.match(AVISO_IA.en, /talk to a person/);
  assert.match(AVISO_IA.es, /Daniel/); assert.match(AVISO_IA.es, /\bIA\b/); assert.match(AVISO_IA.es, /hablar con una persona/);
  assert.match(AVISO_IA.id, /Daniel/); assert.match(AVISO_IA.id, /\bAI\b/); assert.match(AVISO_IA.id, /bicara dengan staf/);
  // Regla del motor: nunca un guion en mitad de frase.
  for (const t of Object.values(AVISO_IA)) assert.ok(!/[—–]|--/.test(t), t);
});

test("primer mensaje: el aviso va delante de la respuesta, en el idioma del cliente", () => {
  const en = conAviso({ texto: "The Vario is 120,000 IDR a day. How many days do you need?", history: [{ role: "user", content: "Hi, how much is a scooter?" }], textoCliente: "Hi, how much is a scooter?" });
  assert.strictEqual(en.dado, true);
  assert.strictEqual(en.texto, `${AVISO_IA.en}\n\nThe Vario is 120,000 IDR a day. How many days do you need?`);
  const es = conAviso({ texto: "La Vario sale a 120.000 IDR al día. ¿Cuántos días la quieres?", history: [], textoCliente: "Hola" });
  assert.ok(es.texto.startsWith(AVISO_IA.es + "\n\n"), es.texto);
  const id = conAviso({ texto: "Vario harganya 120.000 per hari. Mau sewa berapa hari?", history: [], textoCliente: "Halo kak" });
  assert.ok(id.texto.startsWith(AVISO_IA.id + "\n\n"), id.texto);
});

test("idioma: saludos de una palabra y respuesta del modelo como apoyo; inglés ante la duda", () => {
  assert.strictEqual(idiomaAviso("Hola"), "es");
  assert.strictEqual(idiomaAviso("¡Buenas!"), "es");
  assert.strictEqual(idiomaAviso("Halo"), "id");
  assert.strictEqual(idiomaAviso("Selamat pagi"), "id");
  assert.strictEqual(idiomaAviso("Hi"), "en");
  assert.strictEqual(idiomaAviso("Hello there"), "en");
  assert.strictEqual(idiomaAviso("?", "Perdona, ¿me cuentas un poco más sobre lo que buscas?"), "es");
  assert.strictEqual(idiomaAviso("ok", "Maaf, boleh ceritakan sedikit lebih banyak tentang apa yang Anda cari?"), "id");
  assert.strictEqual(idiomaAviso("Bonjour, combien pour un scooter ?"), "en"); // otro idioma: en inglés (dicho al orquestador)
});

test("no se repite: con la marca en el historial el texto sale tal cual", () => {
  const history = [
    { role: "user", content: "Hi" },
    { role: "assistant", content: `${AVISO_IA.en}\n\nWhich bike?`, by: "bot", aviso_ia: true },
    { role: "user", content: "The Vario" },
  ];
  assert.strictEqual(avisoYaDado(history), true);
  const r = conAviso({ texto: "Great pick. For how many days?", history, textoCliente: "The Vario" });
  assert.deepStrictEqual(r, { texto: "Great pick. For how many days?", dado: false });
});

test("conversaciones que ya existían (sin marca) lo reciben en la siguiente respuesta, una sola vez", () => {
  const vieja = [{ role: "user", content: "Hi" }, { role: "assistant", content: "Hey! Which bike?", by: "bot" }, { role: "user", content: "Vario" }];
  assert.strictEqual(avisoYaDado(vieja), false);
  assert.strictEqual(conAviso({ texto: "Sure.", history: vieja, textoCliente: "Vario" }).dado, true);
  // Un mensaje humano o una plantilla anterior no cuentan como aviso.
  assert.strictEqual(avisoYaDado([{ role: "assistant", content: "I'm Daniel from BaliBest", by: "human" }]), false);
});

test("también sale si el turno no trae texto del modelo: solo media, frase neutra o línea de pago", () => {
  assert.deepStrictEqual(conAviso({ texto: "", history: [], textoCliente: "Hi" }), { texto: AVISO_IA.en, dado: true });
  assert.strictEqual(conAviso({ texto: "Perdona, ¿me cuentas un poco más sobre lo que buscas?", history: [], textoCliente: "Hola" }).texto,
    `${AVISO_IA.es}\n\nPerdona, ¿me cuentas un poco más sobre lo que buscas?`);
  assert.strictEqual(conAviso({ texto: "Here is your payment link:\nhttps://checkout.xendit.co/x", history: [], textoCliente: "pay" }).texto,
    `${AVISO_IA.en}\n\nHere is your payment link:\nhttps://checkout.xendit.co/x`);
});

test("el saludo del modelo no se duplica detrás del aviso, sin comerse la frase", () => {
  assert.strictEqual(conAviso({ texto: "Hey Ana! Which dates?", history: [], textoCliente: "Hi" }).texto, `${AVISO_IA.en}\n\nWhich dates?`);
  assert.strictEqual(conAviso({ texto: "¡Hola! ¿Qué fechas?", history: [], textoCliente: "Hola" }).texto, `${AVISO_IA.es}\n\n¿Qué fechas?`);
  assert.strictEqual(conAviso({ texto: "Halo kak, mau sewa berapa hari?", history: [], textoCliente: "Halo" }).texto, `${AVISO_IA.id}\n\nMau sewa berapa hari?`);
  assert.strictEqual(conAviso({ texto: "Hi there the Vario is free", history: [], textoCliente: "Hi" }).texto, `${AVISO_IA.en}\n\nHi there the Vario is free`);
});

test("webhook: el aviso se compone tras textoDelTurno, se marca en el historial y va antes del envío", () => {
  assert.match(src, /^import \{ conAviso \} from "\.\/aviso-ia\.js";$/m);
  const iTurno = src.indexOf("reply = textoDelTurno({ texto: reply, enlace, idioma, hayMedia: toSend.length > 0, hayEmail: false });");
  const iAviso = src.indexOf("const aviso = conAviso({ texto: reply, history, textoCliente: text });");
  const iPush = src.indexOf('if (reply.trim()) history.push({ role: "assistant", content: reply, ts: Date.now(), by: "bot", ...(aviso.dado ? { aviso_ia: true } : {}) });');
  const iEnvio = src.indexOf("if (reply.trim()) await sendHumanized(from, reply, message.id, replyStart);");
  assert.ok(iTurno > 0 && iAviso > iTurno && iPush > iAviso && iEnvio > iPush, "orden: textoDelTurno → aviso → historial → envío");
  assert.strictEqual((src.match(/conAviso\(/g) || []).length, 1, "un solo sitio compone el aviso");
});

test("prompt: honestidad en vez de «sonar humano», y pedir una persona funciona", () => {
  assert.ok(!/how to sound human/i.test(src), "fuera la regla de sonar humano");
  assert.ok(!/give you away as AI/i.test(src), "fuera el objetivo de ocultar que es IA");
  assert.match(src, /HONESTY — YOU ARE AN AI ASSISTANT, AND YOU NEVER PRETEND OTHERWISE/);
  assert.match(src, /asks whether they're talking to a bot, an AI or a real person, answer the truth/);
  assert.match(src, /don't repeat the AI notice in later messages/);
  assert.match(src, /\[INTENT:human\] — the customer asked to talk to a person/);
  // El intent tiene efecto real: Telegram + owner + «por responder», y no dispara seguimiento automático.
  const i = src.indexOf('if (intent === "human") {');
  assert.ok(i > 0, "existe el manejo de [INTENT:human]");
  const bloque = src.slice(i, src.indexOf("// ── Avería/roadside", i));
  assert.match(bloque, /setWaiting\(from, true\)/);
  assert.match(bloque, /notifyTelegram\(/);
  assert.match(bloque, /escPush\(from, profileName, text\)/);
  assert.match(src, /FOLLOWUP_SKIP_INTENT = new Set\(\[[^\]]*"human"/);
  // Va después del setWaiting(false) de «el bot ya respondió», si no lo apagaría.
  assert.ok(i > src.indexOf("await setWaiting(from, false); // el bot ya respondió"));
});

test("contexto de Bali Best: Daniel es una IA, sin biografía humana; el pasaporte se enseña, no se pide por WhatsApp", () => {
  assert.ok(!/years-in-Bali story beyond what B2K/.test(ctx));
  assert.match(ctx, /openly Bali Best Motorcycle's AI virtual assistant/);
  assert.ok(!/passport photo is standard/i.test(ctx));
  assert.ok(!/A photo of it is standard/i.test(ctx));
  assert.ok(!/only being tested, not yet live/i.test(ctx));
});
