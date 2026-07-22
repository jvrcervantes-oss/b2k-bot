// ponytail: self-check de customerAskedAgain() (index.js) — el detector que desbloquea el dedup
// de media cuando el cliente dice que la foto/vídeo no le llegó. Duplica la función en vez de
// hacer require("./index.js") porque ese archivo arranca Express + Redis al importarse (mismo
// motivo y misma forma que test-deal-archive.js). Si cambia en index.js, actualizar aquí también.
//
// Por qué existe: el dedup por URL frenaba el doble-envío espontáneo del modelo, pero también se
// comía el reenvío que el cliente pedía a propósito. El bot contestaba "sending it again now" y no
// salía nada — pasó con un lead real tres veces seguidas.
import assert from "node:assert";

function mediaToSend({ wanted, mediaLib, history, askedAgain, narrated }) {
  const skipDedup = askedAgain || narrated;
  const alreadySent = skipDedup
    ? new Set()
    : new Set(history.filter((m) => m.media && m.media.url).map((m) => m.media.url));
  return mediaLib.filter((m) => wanted.includes(String(m.label).toLowerCase()) && !alreadySent.has(m.url));
}

function rescueNarratedMedia(reply, mediaLib) {
  const rescued = [];
  for (const item of mediaLib) {
    const title = String(item.caption || item.label).trim();
    if (title.length < 6) continue;
    const line = new RegExp(`^[ \\t]*${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*$`, "gim");
    if (line.test(reply)) { rescued.push(item); reply = reply.replace(line, ""); }
  }
  if (rescued.length) reply = reply.replace(/\n{3,}/g, "\n\n").trim();
  return { reply, rescued };
}

function customerAskedAgain(text) {
  return /\b(?:did\s?n[o']?t|have\s?n[o']?t|has\s?n[o']?t|not)\b[^.]{0,25}\b(?:receiv|arriv|come|came|show|get|got)|still\s+(?:nothing|no|not)|no\s+video|send\s+(?:it|them|again)|again\s*\?/i.test(text || "");
}

// Frases reales de los chats de B2K, tal cual las escribieron los clientes (con sus erratas).
const DEBE_REENVIAR = [
  "i havent resive video can you send it again",
  "No videoscame through",
  "Still nothin",
  "No videos came through",
  "didn't receive the video",
  "I haven't got them",
  "the videos didn't arrive",
  "still nothing",
  "can you send it again?",
  "send them again please",
  "no video mate",
];

// Conversación normal: aquí el dedup DEBE seguir protegiendo del doble envío espontáneo.
const NO_DEBE_REENVIAR = [
  "Solo or a mate might come. Can u send me a video link an wat bikes we ride",
  "Yeah sounds fine mate i have ridden all over the world",
  "October seems okay. I'd be on my own.",
  "What bikes do you use?",
  "Not atm mate i in australia about to go to sleep",
  "I'll have a think during the day",
  "",
];

for (const t of DEBE_REENVIAR) {
  assert.strictEqual(customerAskedAgain(t), true, `deberia desbloquear el reenvio: ${JSON.stringify(t)}`);
}
for (const t of NO_DEBE_REENVIAR) {
  assert.strictEqual(customerAskedAgain(t), false, `NO deberia desbloquear el reenvio: ${JSON.stringify(t)}`);
}

// ── rescueNarratedMedia: el modelo escribe los títulos en vez de emitir [MEDIA:label] ──
const LIB = [
  { label: "B2K-route-example-1", caption: "Bali to komodo route example", type: "video", url: "u1" },
  { label: "B2K-route-example-2", caption: "Bali to komodo route example 2", type: "video", url: "u2" },
  { label: "bikes", caption: "B2K Bikes", type: "image", url: "u3" },
];

// Caso real (número del owner, 22-jul): el bot narró los dos clips y no envió nada.
const NARRADO = "Sending them over again, here you go.\n\nBali to komodo route example\n\nBali to komodo route example 2\n\nIf they still don't land on your end, the full route is on the site.";
const r1 = rescueNarratedMedia(NARRADO, LIB);
assert.deepStrictEqual(r1.rescued.map((m) => m.label), ["B2K-route-example-1", "B2K-route-example-2"], "deberia rescatar los 2 clips narrados");
assert.ok(!/route example/i.test(r1.reply), "los titulos deben desaparecer del texto que ve el cliente");
assert.ok(/Sending them over again/.test(r1.reply) && /full route is on the site/.test(r1.reply), "el resto del mensaje se conserva");
assert.ok(!/\n{3,}/.test(r1.reply), "no deben quedar huecos de lineas vacias");

// El título DENTRO de una frase no es un envío narrado: no debe disparar.
const EN_FRASE = "I can show you a Bali to komodo route example if you want, just say the word.";
assert.deepStrictEqual(rescueNarratedMedia(EN_FRASE, LIB).rescued, [], "un titulo dentro de una frase NO es intencion de enviar");

// Conversación normal sin títulos: no toca nada.
const NORMAL = "It's mostly tarmac, around 90%, with a few short unpaved sections.";
const r3 = rescueNarratedMedia(NORMAL, LIB);
assert.deepStrictEqual(r3.rescued, [], "sin titulos no rescata nada");
assert.strictEqual(r3.reply, NORMAL, "sin rescate el texto queda intacto");

// ── mediaToSend: cómo interactúan el dedup, la petición del cliente y el rescate ──
const WANTED = ["b2k-route-example-1", "b2k-route-example-2"];
const YA_ENVIADO = [ // el historial ya tiene esas dos URLs (envio manual desde el panel, p.ej.)
  { role: "assistant", by: "human", media: { url: "u1" } },
  { role: "assistant", by: "human", media: { url: "u2" } },
];
const labels = (arr) => arr.map((m) => m.label);

// Caso normal: el modelo repite la etiqueta sin que nadie lo pida -> el dedup protege.
assert.deepStrictEqual(
  labels(mediaToSend({ wanted: WANTED, mediaLib: LIB, history: YA_ENVIADO, askedAgain: false, narrated: false })),
  [], "sin peticion ni rescate, el dedup debe frenar el reenvio");

// El cliente dice que no le ha llegado -> manda igual.
assert.deepStrictEqual(
  labels(mediaToSend({ wanted: WANTED, mediaLib: LIB, history: YA_ENVIADO, askedAgain: true, narrated: false })),
  ["B2K-route-example-1", "B2K-route-example-2"], "si el cliente lo pide otra vez, el dedup no manda");

// EL FALLO REAL (22-jul): salto el rescate y el dedup lo anulo -> el texto prometia videos que
// no salieron. Si el rescate disparo, nos hemos comprometido en el texto: hay que enviar.
assert.deepStrictEqual(
  labels(mediaToSend({ wanted: WANTED, mediaLib: LIB, history: YA_ENVIADO, askedAgain: false, narrated: true })),
  ["B2K-route-example-1", "B2K-route-example-2"], "si salto el rescate, el dedup NO puede callar el envio");

// Historial limpio: se manda sin mas.
assert.deepStrictEqual(
  labels(mediaToSend({ wanted: WANTED, mediaLib: LIB, history: [], askedAgain: false, narrated: false })),
  ["B2K-route-example-1", "B2K-route-example-2"], "sin envios previos se manda normal");

// Un label que no existe no inventa nada.
assert.deepStrictEqual(
  labels(mediaToSend({ wanted: ["no-existe"], mediaLib: LIB, history: [], askedAgain: false, narrated: false })),
  [], "un label inexistente no debe resolver a ningun item");

console.log(`OK — ${DEBE_REENVIAR.length} frases de "no me ha llegado", ${NO_DEBE_REENVIAR.length} de conversación normal, 4 casos de rescate y 5 de interacción dedup/rescate`);
