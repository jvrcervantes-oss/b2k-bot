// ponytail: self-check de customerAskedAgain() (index.js) — el detector que desbloquea el dedup
// de media cuando el cliente dice que la foto/vídeo no le llegó. Duplica la función en vez de
// hacer require("./index.js") porque ese archivo arranca Express + Redis al importarse (mismo
// motivo y misma forma que test-deal-archive.js). Si cambia en index.js, actualizar aquí también.
//
// Por qué existe: el dedup por URL frenaba el doble-envío espontáneo del modelo, pero también se
// comía el reenvío que el cliente pedía a propósito. El bot contestaba "sending it again now" y no
// salía nada — pasó con un lead real tres veces seguidas.
import assert from "node:assert";

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

console.log(`OK — ${DEBE_REENVIAR.length} frases de "no me ha llegado" y ${NO_DEBE_REENVIAR.length} de conversación normal`);
