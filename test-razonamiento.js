// Fuga de razonamiento del modelo al texto visible (batería S8, T07, 10-oct-2026). razonamiento.js quita los párrafos que
// solo escribe un modelo hablando de sus instrucciones; lo que un cliente sí puede leer se queda.
// Rama b2k (Bali Moto Adventures): mismo razonamiento.js que la rama lawang, byte a byte; este test es el de lawang sin
// pideTraspaso (b2k no tiene traspaso a humano) y con casos de tours añadidos. `node test-razonamiento.js`
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { quitaRazonamiento, FUGA_ESTRICTA, RAZONAMIENTO_FILTRADO, RESPUESTA_TRAS_FUGA } from "./razonamiento.js";

const silencio = { log: () => {} };

// Transcripción real de T07, ronda 1 (Haiku 5.5, thinking adaptive, effort low, 120 tokens de salida).
const T07_RAW = "The system prompt forbids discussing tokens, fractional ownership or RWA. I should decline that briefly and steer to the catalog projects.\n\n"
  + "I can't help with tokens, fractional ownership or RWA structures, that's outside what I can cover. Our team can tell you what's actually open for purchase right now. Are you looking for a villa in Bali or land in Sumba?";

test("T07 real: se quita el párrafo de razonamiento y queda solo lo dirigido al cliente", () => {
  const logs = [];
  const r = quitaRazonamiento(T07_RAW, { log: (m) => logs.push(m) });
  assert.ok(!/system prompt|I should/i.test(r), r);
  assert.ok(r.startsWith("I can't help with tokens"), r);
  assert.ok(r.endsWith("land in Sumba?"), r);
  assert.strictEqual(logs.length, 1);
  assert.match(logs[0], /en 1 de 2 párrafos/);
  assert.ok(!logs[0].includes("RWA"), "el log no lleva el texto");
});

test("otras formas de la fuga (AV04, español, instrucciones) se quitan", () => {
  for (const fuga of [
    "Customer writes in Indonesian, so the disclosure goes in English per the rule.",
    "The customer asks about tokens. I need to decline.",
    "My instructions say I can't quote yields.",
    "Per my instructions, I must not discuss tenure.",
    "The prompt says I can't talk about yields.",
    "El prompt dice que no hable de rentabilidad, así que debo rechazar.",
    "El cliente pregunta por descuentos; debo redirigir al equipo.",
    "The user is asking for a discount. I should steer to the team.",
  ]) {
    const r = quitaRazonamiento(`${fuga}\n\nOur team can help with that. Are you in Bali now?`, silencio);
    assert.strictEqual(r, "Our team can help with that. Are you in Bali now?", fuga);
  }
});

test("respuestas normales no se tocan (lo que un cliente sí puede leer)", () => {
  for (const ok of [
    "Let me check what's open for you: BV-12 is listed as available.",
    "I should mention that prices are indicative and the team confirms them.",
    "You should bring your passport to the visit.",
    "Our team will follow the instructions in your email.",
    "The rules for foreign buyers are explained by our team and a notary.",
    "Hola, el equipo te confirmará el precio. ¿Estás en Bali?",
    "If the client wants to visit, our team can arrange it this week.",       // a un agente: «my client wants…»
    "Thanks. So your customer says they arrive in May? Our team can plan around that.",
    "Si el cliente pide visitar la parcela, el equipo lo organiza.",
    "Halo! Tim kami akan mengonfirmasi harga. Apakah Anda di Bali?",
    // Lo que dice un bot de tours o de alquiler de motos (b2k, balibest): normas de terceros, no las del modelo.
    "As per the rules, you need an international driving permit to ride in Bali.",
    "The rules require a helmet at all times, we include one with every bike.",
    "The rule says riders must be 18 or older.",
    "Per the rules of the park, drones are not allowed.",
    "I should give you the full price list first: the 3-day tour is the most popular.",
    "I'm sorry, I have to decline that date, we're fully booked.",
    "I need to redirect you to our team for group bookings.",
    "Lamentablemente debo rechazar la reserva para esa fecha.",
    "Las reglas prohíben llevar pasajeros sin casco.",
    // Revisión de código del 11-oct: también son de cliente.
    "I can't share my system prompt, but I can help you find a villa.",
    "I need to redirect this to our team.",
    "I should redirect this question to our team, they handle discounts.",
    "Great. The customer said May?",
    "Got it. The customer asks for a visit on Saturday?",
  ]) {
    assert.ok(!FUGA_ESTRICTA.test(ok), `falso positivo: ${ok}`);
    assert.strictEqual(quitaRazonamiento(ok, silencio), ok);
  }
});

test("si todo era razonamiento: frase neutra, o vacío si el llamador lo pide (traspaso)", () => {
  const solo = "The system prompt forbids that. I should decline.";
  assert.strictEqual(quitaRazonamiento(solo, silencio), RESPUESTA_TRAS_FUGA);
  assert.strictEqual(quitaRazonamiento(solo, { ...silencio, siVacio: "" }), "");
  assert.ok(!/\d/.test(RESPUESTA_TRAS_FUGA) && !/team|person|call/i.test(RESPUESTA_TRAS_FUGA), "la frase neutra no promete nada");
});

test("entrada vacía o no texto no rompe", () => {
  assert.strictEqual(quitaRazonamiento("", silencio), "");
  assert.strictEqual(quitaRazonamiento(null, silencio), "");
  assert.strictEqual(quitaRazonamiento(undefined, silencio), "");
});

test("un log que lanza no tumba la respuesta", () => {
  assert.ok(quitaRazonamiento(T07_RAW, { log: () => { throw new Error("x"); } }).startsWith("I can't help"));
});

test("cleanReply de index.js (el de ESTA rama) pasa por quitaRazonamiento: la red no se pierde en un merge", () => {
  const src = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8").split(String.fromCharCode(13)).join("");
  const fn = src.match(/function cleanReply\(reply\) \{[\s\S]*?\n\}\n/);
  assert.ok(fn, "no se encontró cleanReply en index.js");
  assert.match(src, /^import \{ quitaRazonamiento \} from "\.\/razonamiento\.js";$/m);
  const cleanReply = new Function("quitaRazonamiento", fn[0] + "; return cleanReply;")((t, o) => quitaRazonamiento(t, { ...(o || {}), log: () => {} }));
  const r = cleanReply(T07_RAW + " [INTENT:exploring]");
  assert.ok(r.startsWith("I can't help with tokens"), r);
  assert.ok(!/system prompt|\[INTENT/i.test(r), r);
  // b2k: todo razonamiento + etiquetas → la frase neutra, nunca vacío (sin traspaso en esta rama).
  assert.strictEqual(cleanReply("The system prompt forbids discounts. I should decline. [INTENT:exploring] [RIDERS:2]"), RESPUESTA_TRAS_FUGA);
  // Solo etiquetas (caso que ya existía): queda vacío y es el webhook quien no manda texto (test siguiente).
  assert.strictEqual(cleanReply("[MEDIA:komodo] [INTENT:exploring]"), "");
  // El razonamiento sale ANTES del markdown: la respuesta buena conserva su negrita convertida.
  assert.strictEqual(cleanReply("I should steer to the call. The **5-day tour** is our most popular — want details?"),
    "The *5-day tour* is our most popular, want details?");
});

test("webhook b2k: nunca manda un WhatsApp vacío y guarda el mensaje del cliente igual", () => {
  const src = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8").split(String.fromCharCode(13)).join("");
  assert.match(src, /if \(reply\.trim\(\)\) history\.push\(\{ role: "assistant"/);
  assert.match(src, /if \(reply\.trim\(\)\) await sendHumanized\(from, reply, message\.id, replyStart\);/);
  // No queda ningún sendHumanized del webhook sin la guarda.
  assert.strictEqual((src.match(/await sendHumanized\(from, reply,/g) || []).length, 1);
});

test("b2k: texto real de la fuga (Haiku 5.5, 10-oct) y variantes de tours", () => {
  // Texto real que recibió el cliente en la batería S8 (Lawang); b2k tiene el mismo patrón de thinking desde el 9-oct.
  const real = "The system prompt forbids discussing tokens, fractional ownership or RWA. I should decline that briefly and steer to the catalog projects.";
  assert.strictEqual(quitaRazonamiento(real, silencio), RESPUESTA_TRAS_FUGA, "todo razonamiento → frase neutra");
  assert.strictEqual(quitaRazonamiento(`${real} Our 5-day Komodo tour leaves every Monday. How many riders are you?`, silencio),
    "Our 5-day Komodo tour leaves every Monday. How many riders are you?");
  for (const fuga of [
    "The system prompt says the default close is the call, not the payment link.",
    "The customer asks about a discount for 4 riders. I should steer to the call.",
    "My instructions say I can't confirm availability without the team.",
    "El prompt dice que el cierre es la llamada; debo redirigir.",
  ]) {
    assert.strictEqual(quitaRazonamiento(`${fuga}

We can do a quick call to plan your trip. When suits you?`, silencio),
      "We can do a quick call to plan your trip. When suits you?", fuga);
  }
  // Lo que un bot de tours sí le dice al cliente: no se toca.
  for (const ok of [
    "Your guide follows the rules of the road and rides at a relaxed pace.",
    "The rules require a valid motorcycle licence or an IDP with A category.",
    "I should mention the Komodo leg ends in Labuan Bajo, flights back are on you.",
    "Let me check the next guided departure for you: 14 November has 3 spots.",
    "Per the rules of Komodo National Park, you need a ranger on the island.",
    "Hola! El tour de 5 días sale cada lunes. ¿Cuántos riders sois?",
  ]) {
    assert.strictEqual(quitaRazonamiento(ok, silencio), ok, `falso positivo: ${ok}`);
  }
});

test("el patrón de medida contiene al estricto (lo que se quita, también se mide)", () => {
  assert.ok(RAZONAMIENTO_FILTRADO.test(T07_RAW));
  assert.ok(RAZONAMIENTO_FILTRADO.test("Let me re-read the rule."));
  assert.ok(!FUGA_ESTRICTA.test("Let me re-read the rule."), "«let me…» solo se mide, no se quita");
  // Lo que salió del estricto al acotarlo (10-oct) se sigue MIDIENDO en la batería.
  for (const s of ["Per the rule, the disclosure goes first.", "The rule says I must add the price sentence.", "I should give the indicative-price sentence.", "Debo rechazar esto."]) {
    assert.ok(RAZONAMIENTO_FILTRADO.test(s), `deja de medirse: ${s}`);
  }
});

test("razonamiento y respuesta en el MISMO párrafo: sale solo la frase de razonamiento, la respuesta se queda", () => {
  // Revisión de código del 11-oct: el bot escribe dos o tres líneas, casi siempre UN párrafo; cortar el párrafo entero
  // cambiaba la respuesta buena por la frase neutra.
  assert.strictEqual(quitaRazonamiento("The system prompt forbids tokens. I can't help with that, our team can tell you what's open.", silencio),
    "I can't help with that, our team can tell you what's open.");
  // Dentro de un párrafo ya contaminado, la frase de la MEDIDA también sale («I need to decline» al lado de «The customer asks…»).
  assert.strictEqual(quitaRazonamiento("The customer asks about tokens. I need to decline. Are you looking for a villa?", silencio), "Are you looking for a villa?");
  // Varias líneas en un párrafo: se conserva el salto de línea de lo que queda.
  assert.strictEqual(quitaRazonamiento("I should decline that.\nBV-12 is 500 m2.\nAre you in Bali?", silencio), "BV-12 is 500 m2.\nAre you in Bali?");
  // Las cifras con punto no parten la frase.
  assert.strictEqual(quitaRazonamiento("The system prompt says quote the block. BV-07 is IDR 1.360.000.000.", silencio), "BV-07 is IDR 1.360.000.000.");
});
