// ─── CONSENTIMIENTO DE SEGUIMIENTO (S12 del encargo 20261009_lawang_bot_sin_redis, LAW-507) ─────────────────────────────────────
// Lo que este módulo SABE: los textos de Legal (contexto/legal/bot_lawang_consentimiento_seguimiento.md, versión CONSENT-SEGUIMIENTO-2026-10-09-v1),
// CUÁNDO se pregunta (Legal §4) y el nombre de las dos plantillas. Lo que NO hace: decidir si el lead dijo que sí. Eso lo decide la base
// (bot_consentimiento_responder), con las listas cerradas de Legal §2; aquí ni existe la palabra «estado» como entrada.
// El texto de la pregunta es de CÓDIGO: lo escribe Legal, no el modelo, y viaja idéntico a la base como prueba de lo que vio el lead.
// Sin dependencias: se prueba con piezas falsas (test-consentimiento.js). Con BOT_STORE=redis nada de esto se carga.

export const VERSION = "CONSENT-SEGUIMIENTO-2026-10-09-v1";

// Legal §1 (inglés = idioma base). Español idéntico al de Legal. El indonesio NO se activa hasta la lectura de un hablante nativo: quien escribe
// en indonesio recibe el inglés.
export const PREGUNTA = {
  en: "Would you like us to follow up here on WhatsApp if we don't hear from you? If you say yes, Lawang's automated assistant (AI) will send you up to 2 short messages, about 2 days and 7 days after our last message. It's optional, and you can stop it any time by replying STOP. Please reply YES or NO. How we handle your data: lawangproperties.com/legal#privacy",
  es: "¿Quieres que te escribamos por aquí, por WhatsApp, si no volvemos a hablar? Si dices que sí, el asistente automático (IA) de Lawang te enviará hasta 2 mensajes cortos, a los 2 días y a los 7 días de nuestro último mensaje. Es opcional y puedes pararlo cuando quieras respondiendo STOP. Responde SÍ o NO. Cómo tratamos tus datos: lawangproperties.com/legal#privacy",
};
// Legal §2.5: la repregunta única.
export const REPREGUNTA = {
  en: "Just to be sure: may we write to you up to 2 times on WhatsApp after this chat? Please reply YES or NO.",
  es: "Para confirmar: ¿podemos escribirte hasta 2 veces por WhatsApp después de este chat? Responde SÍ o NO.",
};
/** Idioma de la pregunta: español si el lead escribe en español; en cualquier otro caso (incluido indonesio, sin activar) inglés. */
export const idiomaPregunta = (idiomaDetectado) => (idiomaDetectado === "es" ? "es" : "en");

// Plantillas de Meta (MARKETING, APPROVED, en/es; 1 variable = nombre de pila). Se pueden renombrar por variable, pero NUNCA son
// FOLLOWUP_TEMPLATE_NAME (decisión del owner, 9-oct-2026).
export const PLANTILLAS = { "48h": "lawang_reenganche_48h", "7d": "lawang_reenganche_7d" };

const norm = (t) => String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();

// El lead se despide o lo deja para luego (Legal §4.1.2.i). Mensaje corto y sin pregunta: «thanks, what about the price?» NO es una despedida.
const DESPEDIDA = /\b(thanks|thank you|thx|gracias|muchas gracias|terima kasih|makasih|bye|goodbye|chao|adios|hasta luego|talk later|speak later|get back to you|i'?ll think|i will think|let me think|let me check|let me talk|i'?ll check|i'?ll talk|lo pienso|lo pensare|lo voy a pensar|voy a mirar|lo miro|lo consulto|lo hablo con|te aviso|luego te escribo|ya te digo|will let you know|i'?ll let you know)\b/;
export function esDespedida(texto) {
  const t = norm(texto);
  return t.length > 0 && t.length <= 90 && !t.includes("?") && DESPEDIDA.test(t);
}
// Hay una pregunta del lead sin contestar (aproximación conservadora: ante la duda, hay pregunta).
const INTERROGATIVA = /(\?|^\s*(what|how|when|where|which|who|why|can|could|do|does|is|are|will|would|que|como|cuando|donde|cual|quien|cuanto|puedo|puedes|hay|es|son|apa|berapa|bagaimana)\b)/;
export const tienePreguntaSinResolver = (texto) => INTERROGATIVA.test(norm(texto));

// «cifra» (Legal §4.2): cualquier importe, moneda o número de 3 cifras o más en lo que acaba de decir el bot. Conservador a propósito.
const CIFRA = /(?:[$€£]|\b(?:usd|idr|aud|eur|rp|rupiah)\b)\s*\d|\d[\d.,]*\s*(?:usd|idr|aud|eur|rp|juta|million|millones|miliar|billion|k\b|m\b|m2|m²|sqm|ha\b)|\d{3,}/i;
export const tieneCifra = (texto) => CIFRA.test(String(texto || ""));

const QUEJA = /\b(wrong|incorrect|mistake|you are wrong|not what i|that'?s not|unacceptable|ridiculous|scam|complain|complaint|angry|upset|error|equivocad|incorrecto|no es lo que|queja|inaceptable|estafa|fraude)\b/;
const DERECHOS = /\b(my data|my personal data|gdpr|uu pdp|data protection|privacy|delete|erase|rectif|mis datos|proteccion de datos|privacidad|borra|elimina|derechos|hapus data)\b/;
const MENOR = /\b(i am|i'?m|im|tengo|soy|umur|usia)\s*(1[0-7]|[1-9])\b|\b(minor|underage|menor de edad|under 18|menor)\b/;

/**
 * ¿Hay que preguntar AHORA por el seguimiento? (Legal §4). Pura: recibe lo ya decidido y devuelve { pregunta, motivo }.
 * Nunca pregunta: sin la bandera, con el estado distinto de `sin_preguntar`, en el primer mensaje del bot o junto al aviso de asistente, junto a una
 * cifra, una cita o un traspaso, con la operadora o el chat en pausa, tras una queja, con una petición de derechos o con sospecha de menor.
 */
export function decidePregunta({ habilitado, consent, esPrimerTurno, nivelAviso, textoCliente, respuestaBot, intent, traspaso, hayCita, pausado, mensajesCliente = 0 }) {
  const no = (motivo) => ({ pregunta: false, motivo });
  if (!habilitado) return no("apagado");
  if (!consent || consent.estado !== "sin_preguntar" || consent.puede_preguntar !== true) return no("estado");
  if (esPrimerTurno) return no("primer_mensaje");
  if (nivelAviso === "completo") return no("aviso_de_asistente");
  if (pausado) return no("pausa");
  if (traspaso || hayCita || intent === "escalate" || intent === "booking" || intent === "lost") return no("traspaso_o_cita");
  if (tieneCifra(respuestaBot)) return no("cifra");
  const c = norm(textoCliente);
  if (QUEJA.test(c)) return no("queja");
  if (DERECHOS.test(c)) return no("derechos");
  if (MENOR.test(c)) return no("menor");
  if (esDespedida(textoCliente)) return { pregunta: true, motivo: "despedida" };
  // (ii) el bot acaba de contestar todo: ni el lead ni el bot dejan una pregunta abierta, y la conversación ya tiene cuerpo
  if (mensajesCliente >= 3 && !tienePreguntaSinResolver(textoCliente) && !String(respuestaBot || "").includes("?")) return { pregunta: true, motivo: "sin_pendientes" };
  return no("sin_cierre");
}

/** Bloque para el modelo cuando el lead acaba de contestar a la pregunta (solo tono: el estado ya lo fijó la base). */
export function bloqueRespuesta(resultado) {
  if (resultado === "si") return "FOLLOW-UP CONSENT: the customer just agreed to receive up to 2 follow-up messages. Acknowledge it in one short sentence (do not repeat the details) and continue with whatever else they asked.";
  if (resultado === "no") return "FOLLOW-UP CONSENT: the customer just declined follow-up messages. Acknowledge it in one short sentence, do not ask again, and continue with whatever else they asked.";
  return null;
}
