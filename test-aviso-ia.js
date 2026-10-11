// Aviso de IA en el primer mensaje y «pedir una persona» (BBM-50, 11/12-oct-2026). node --test test-aviso-ia.js
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { AVISO_IA, avisoYaDado, idiomaAviso, conAviso, conservaMarca, configAviso, textosAviso } from "./aviso-ia.js";

const src = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8").split(String.fromCharCode(13)).join("");
const ctx = fs.readFileSync(new URL("./context-balibest.md", import.meta.url), "utf8");
const A = (lang, resto) => `${AVISO_IA[lang]}\n\n${resto}`;

test("los tres textos dicen Daniel, IA y que se puede pedir una persona (literal aprobado)", () => {
  assert.deepStrictEqual(Object.keys(AVISO_IA).sort(), ["en", "es", "id"]);
  assert.strictEqual(AVISO_IA.en, "Hi! I'm Daniel, Bali Best's virtual assistant. I'm an AI, and you can ask to talk to a person from our team at any time.");
  assert.strictEqual(AVISO_IA.id, "Halo! Saya Daniel, asisten virtual Bali Best. Saya adalah AI, dan Anda bisa minta bicara dengan staf kami kapan saja.");
  assert.strictEqual(AVISO_IA.es, "¡Hola! Soy Daniel, el asistente virtual de Bali Best. Soy una IA, y puedes pedir hablar con una persona del equipo cuando quieras.");
  for (const t of Object.values(AVISO_IA)) assert.ok(!/[—–]|--/.test(t), t); // regla del motor: nunca un guion en mitad de frase
});

test("primer mensaje: el aviso va delante de la respuesta, en el idioma del cliente", () => {
  const en = conAviso({ texto: "The Vario is 120,000 IDR a day. How many days do you need?", history: [{ role: "user", content: "Hi" }], textoCliente: "Hi, how much is a scooter?" });
  assert.deepStrictEqual(en, { texto: A("en", "The Vario is 120,000 IDR a day. How many days do you need?"), dado: true });
  assert.ok(conAviso({ texto: "La Vario sale a 120.000 IDR al día. ¿Cuántos días la quieres?", textoCliente: "Hola" }).texto.startsWith(AVISO_IA.es + "\n\n"));
  assert.ok(conAviso({ texto: "Vario harganya 120.000 per hari. Mau sewa berapa hari?", textoCliente: "Halo kak" }).texto.startsWith(AVISO_IA.id + "\n\n"));
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
  assert.strictEqual(idiomaAviso("Bonjour, combien pour un scooter ?"), "en"); // otro idioma: en inglés (lo sabe el orquestador)
});

test("no se repite: con la marca en el historial el texto sale tal cual", () => {
  const history = [{ role: "user", content: "Hi" }, { role: "assistant", content: A("en", "Which bike?"), by: "bot", aviso_ia: true }, { role: "user", content: "The Vario" }];
  assert.strictEqual(avisoYaDado(history), true);
  assert.deepStrictEqual(conAviso({ texto: "Great pick. For how many days?", history, textoCliente: "The Vario" }), { texto: "Great pick. For how many days?", dado: false });
});

test("conversaciones que ya existían (sin marca) lo reciben en la siguiente respuesta; un mensaje humano no cuenta", () => {
  const vieja = [{ role: "user", content: "Hi" }, { role: "assistant", content: "Hey! Which bike?", by: "bot" }, { role: "user", content: "Vario" }];
  assert.strictEqual(avisoYaDado(vieja), false);
  assert.strictEqual(conAviso({ texto: "Sure.", history: vieja, textoCliente: "Vario" }).dado, true);
  assert.strictEqual(avisoYaDado([{ role: "assistant", content: "I'm Daniel from BaliBest", by: "human" }]), false);
});

test("también sale si el turno no trae texto del modelo: solo media, frase neutra o línea de pago", () => {
  assert.deepStrictEqual(conAviso({ texto: "", textoCliente: "Hi" }), { texto: AVISO_IA.en, dado: true });
  assert.strictEqual(conAviso({ texto: "Perdona, ¿me cuentas un poco más sobre lo que buscas?", textoCliente: "Hola" }).texto, A("es", "Perdona, ¿me cuentas un poco más sobre lo que buscas?"));
  assert.strictEqual(conAviso({ texto: "Here is your payment link:\nhttps://checkout.xendit.co/x", textoCliente: "pay" }).texto, A("en", "Here is your payment link:\nhttps://checkout.xendit.co/x"));
});

test("el saludo del modelo no se duplica detrás del aviso, sin comerse la frase ni un «sí/yes/no»", () => {
  assert.strictEqual(conAviso({ texto: "Hey Ana! Which dates?", textoCliente: "Hi" }).texto, A("en", "Which dates?"));
  assert.strictEqual(conAviso({ texto: "¡Hola! ¿Qué fechas?", textoCliente: "Hola" }).texto, A("es", "¿Qué fechas?"));
  assert.strictEqual(conAviso({ texto: "Halo kak, mau sewa berapa hari?", textoCliente: "Halo" }).texto, A("id", "Mau sewa berapa hari?"));
  assert.strictEqual(conAviso({ texto: "Hi there the Vario is free", textoCliente: "Hi" }).texto, A("en", "Hi there the Vario is free"));
  // Revisor 12-oct: con el flag i, \p{Lu} casaba minúsculas y se comía «sí», «yes» o «no».
  assert.strictEqual(conAviso({ texto: "Hola sí, tenemos la Vario.", textoCliente: "Hola" }).texto, A("es", "Hola sí, tenemos la Vario."));
  assert.strictEqual(conAviso({ texto: "Hi yes, we deliver to Canggu.", textoCliente: "Hi" }).texto, A("en", "Hi yes, we deliver to Canggu."));
  assert.strictEqual(conAviso({ texto: "Hi no, we only rent scooters.", textoCliente: "Hi" }).texto, A("en", "Hi no, we only rent scooters."));
  assert.strictEqual(conAviso({ texto: "Hi yes!", textoCliente: "Hi" }).texto, A("en", "Hi yes!"));
  assert.strictEqual(conAviso({ texto: "Hey there!", textoCliente: "Hi" }).texto, A("en", "Hey there!")); // todo saludo: no se pierde
});

test("la marca sobrevive al recorte de 100 mensajes (revisor 12-oct)", () => {
  const largo = [{ role: "assistant", content: "aviso", aviso_ia: true }, ...Array.from({ length: 120 }, (_, k) => ({ role: k % 2 ? "assistant" : "user", content: `m${k}` }))];
  const rec = conservaMarca(largo, largo.slice(-100));
  assert.strictEqual(rec.length, 100);
  assert.strictEqual(avisoYaDado(rec), true);
  assert.strictEqual(rec[0].content, largo[largo.length - 100].content, "solo cambia la marca, no el mensaje");
  const sin = largo.slice(1);
  assert.strictEqual(avisoYaDado(conservaMarca(sin, sin.slice(-100))), false, "sin marca previa no se inventa");
  const corto = largo.slice(0, 10);
  assert.strictEqual(conservaMarca(corto, corto), corto);
  assert.match(src, /const trimmed = conservaMarca\(messages, messages\.slice\(-100\)\);/);
});

test("motor compartido: activo solo en Bali Best por defecto, nombre y marca por parámetro", () => {
  assert.strictEqual(configAviso({ PROJECT_NAME: "BaliBest" }).activo, true);
  assert.strictEqual(configAviso({ PROJECT_NAME: "Bali Moto Adventures" }).activo, false);
  assert.strictEqual(configAviso({}).activo, false);
  assert.strictEqual(configAviso({ PROJECT_NAME: "BaliBest", AVISO_IA: "off" }).activo, false);
  const otro = configAviso({ PROJECT_NAME: "Lawang", AVISO_IA: "on", AVISO_IA_MARCA: "Lawang" }, "Maya");
  assert.strictEqual(otro.activo, true);
  assert.ok(otro.textos.en.startsWith("Hi! I'm Maya, Lawang's virtual assistant."));
  assert.deepStrictEqual(configAviso({ PROJECT_NAME: "BaliBest" }).textos, AVISO_IA, "en Bali Best, el texto aprobado tal cual");
  assert.deepStrictEqual(textosAviso(), AVISO_IA);
  assert.deepStrictEqual(conAviso({ texto: "Hola", activo: false }), { texto: "Hola", dado: false });
});

test("webhook: el aviso se compone tras textoDelTurno, se marca en el historial y va antes del envío; también en la respuesta a media", () => {
  assert.match(src, /^import \{ conAviso, configAviso, conservaMarca \} from "\.\/aviso-ia\.js";$/m);
  assert.match(src, /const AVISO = configAviso\(process\.env, PERSONA_NAME\);/);
  const iTurno = src.indexOf("reply = textoDelTurno({ texto: reply, enlace, idioma, hayMedia: toSend.length > 0, hayEmail: false });");
  const iAviso = src.indexOf("const aviso = conAviso({ texto: reply, history, textoCliente: text, textos: AVISO.textos, activo: AVISO.activo });");
  const iPush = src.indexOf('if (reply.trim()) history.push({ role: "assistant", content: reply, ts: Date.now(), by: "bot", ...(aviso.dado ? { aviso_ia: true } : {}) });');
  const iEnvio = src.indexOf("if (reply.trim()) await sendHumanized(from, reply, message.id, replyStart);");
  assert.ok(iTurno > 0 && iAviso > iTurno && iPush > iAviso && iEnvio > iPush, "orden: textoDelTurno → aviso → historial → envío");
  assert.strictEqual((src.match(/conAviso\(\{/g) || []).length, 2, "respuesta normal + respuesta a media que el bot no puede leer");
  const iMedia = src.indexOf("const avisoMedia = conAviso({ texto: ask, history,");
  const iEnvioMedia = src.indexOf("await sendWhatsApp(from, avisoMedia.texto);");
  assert.ok(iMedia > 0 && iEnvioMedia > iMedia);
  assert.ok(src.includes('history.push({ role: "assistant", content: avisoMedia.texto, ts: Date.now(), by: "bot", ...(avisoMedia.dado ? { aviso_ia: true } : {}) });'));
});

test("prompt: honestidad en vez de «sonar humano»", () => {
  assert.ok(!/how to sound human/i.test(src), "fuera la regla de sonar humano");
  assert.ok(!/give you away as AI/i.test(src), "fuera el objetivo de ocultar que es IA");
  assert.match(src, /HONESTY — YOU ARE AN AI ASSISTANT, AND YOU NEVER PRETEND OTHERWISE/);
  assert.match(src, /asks whether they're talking to a bot, an AI or a real person, answer the truth/);
  assert.match(src, /\$\{AVISO\.activo \? ` The first message of every conversation already says so/, "la frase del aviso solo si está activo");
  assert.match(src, /don't repeat the AI notice in later messages/);
  assert.match(src, /\[INTENT:human\] — the customer asked to talk to a person/);
});

test("pedir una persona: un aviso por petición, y no se pierde en el turno siguiente (revisor 12-oct)", () => {
  const i = src.indexOf("const leadPersona = await getLead(from);");
  assert.ok(i > 0, "existe el manejo de [INTENT:human]");
  const bloque = src.slice(i, src.indexOf("// ── Avería/roadside", i));
  assert.ok(bloque.includes('if (intent === "human" && !(leadPersona && leadPersona.pidePersona)) {'), "se avisa una vez por petición");
  assert.ok(bloque.includes('await updateLeadFields(from, { pidePersona: Date.now(), intent: "human" });'));
  assert.match(bloque, /notifyTelegram\(/);
  assert.match(bloque, /escPush\(from, profileName, text\)/);
  assert.ok(bloque.includes('if (intent === "human" || (leadPersona && leadPersona.pidePersona)) await setWaiting(from, true);'), "sigue «por responder» aunque el bot conteste");
  assert.ok(i > src.indexOf("await setWaiting(from, false); // el bot ya respondió"), "va después del setWaiting(false)");
  assert.ok(src.includes('intent: prev.pidePersona ? "human" : (intent || prev.intent || "exploring"),'), "recordLead no le quita el «human»");
  assert.match(src, /FOLLOWUP_SKIP_INTENT = new Set\(\[[^\]]*"human"/, "fuera del seguimiento automático");
});

test("la petición la cierra una persona de verdad: panel, media del panel, eco de la app y el owner citando", () => {
  const fn = src.slice(src.indexOf("async function atendidoPorPersona(phone) {"), src.indexOf("async function isPaused(phone) {"));
  assert.match(fn, /pidePersona: null/);
  assert.match(fn, /lRem\("esc_queue", 0, raw\)/, "saca de la cola las entradas de ese teléfono");
  assert.strictEqual((src.match(/await atendidoPorPersona\(/g) || []).length, 4);
  const trozo = (k) => src.slice(src.indexOf(k), src.indexOf(k) + 1200);
  assert.match(trozo('app.post("/admin/api/send",'), /await atendidoPorPersona\(phone\)/);
  assert.match(trozo('app.post("/admin/api/send-media",'), /await atendidoPorPersona\(phone\)/);
  assert.match(src, /await atendidoPorPersona\(cust\);/);
  assert.match(src, /await atendidoPorPersona\(pending\.customerPhone\);/);
});

test("cleanReply: un rango con guion largo entre cifras queda con guion corto, no con coma", () => {
  const fn = src.match(/function cleanReply\(reply[^)]*\) \{[\s\S]*?\n\}\n/);
  const cleanReply = new Function("quitaRazonamiento", fn[0] + "; return cleanReply;")((t) => t);
  assert.strictEqual(cleanReply("The Scoopy is free for 20–23 October."), "The Scoopy is free for 20-23 October.");
  assert.strictEqual(cleanReply("Price: 600.000 — 650.000 IDR"), "Price: 600.000-650.000 IDR");
  assert.strictEqual(cleanReply("Great pick — it's light."), "Great pick, it's light.");
});

test("contexto de Bali Best: Daniel es una IA, sin biografía humana; el pasaporte se enseña, no se pide por WhatsApp", () => {
  assert.ok(!/years-in-Bali story beyond what B2K/.test(ctx));
  assert.match(ctx, /openly Bali Best Motorcycle's AI virtual assistant/);
  assert.ok(!/passport photo is standard/i.test(ctx));
  assert.ok(!/A photo of it is standard/i.test(ctx));
  assert.ok(!/only being tested, not yet live/i.test(ctx));
});
