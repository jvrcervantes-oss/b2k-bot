// Razonamiento del modelo que se cuela en el texto visible (fuga al cliente). Sin dependencias: se puede llevar tal cual a
// cualquier rama del motor (b2k, balibest) junto con la llamada desde cleanReply.
//
// Por qué existe (10-oct-2026, batería S8 con Haiku 5.5): con thinking ADAPTIVE y effort low el modelo decide no pensar en
// los turnos que le parecen fáciles y entonces razona EN VOZ ALTA dentro del bloque de texto, que es justo el que se envía.
// T07 salió así: «The system prompt forbids discussing tokens, fractional ownership or RWA. I should decline that briefly
// and steer to the catalog projects.» seguido de la respuesta buena. El thinking adaptive NO lo impide por construcción
// (el comentario de index.js decía lo contrario); por eso la red es del servidor y no del prompt.
// Misma familia que el 23-jul (self-thought en el chat), el 27-jul (nota interna recitada) y AV04 (aviso repetido).

/**
 * Patrón ESTRICTO: frases que solo escribe un modelo hablando de SUS instrucciones o planeando la respuesta, nunca algo
 * que se le dice a un cliente. Lo que casa se QUITA (la frase; ver quitaRazonamiento). Fuera a propósito «let me check…» y
 * «I should mention…»: un cliente sí puede leer eso, y borrar una respuesta buena es peor que medirla.
 * Acotado (10-oct-2026, antes de llevarlo a b2k/balibest): nada de «the rules require / per the rules / the rule says /
 * I should give|use|answer» ni «debo rechazar»: un bot de tours o de alquiler de motos le dice al cliente «as per the
 * rules you need an IDP» o «the rules require a helmet», y eso se borraba entero. Solo «MY instructions / the prompt /
 * system prompt» y «I should decline|steer». Las formas genéricas siguen en el patrón de MEDIDA.
 * Revisión de código del 11-oct: «I can't share my system prompt» (negativa correcta ante una inyección), «I need to
 * redirect this to our team» y «The customer said May?» (dicho a un agente) son de cliente: el patrón ya no los toca.
 */
export const FUGA_ESTRICTA = new RegExp([
  String.raw`(?<!\b(?:share|reveal|show|disclose|give you|tell you|see) (?:my|the|our|this) )\bsystem prompt\b`,
  String.raw`\b(?:my (?:instructions|rules|guidelines|prompt)|the prompt)\s+(?:say|says|forbid|forbids|tell me|tells me|require|requires|state|states|prohibit|prohibits|do not allow|don'?t allow)\b`,
  String.raw`\bper my (?:instructions|prompt|guidelines)\b`,
  // «I have to decline your request» o «I need to redirect this to the team» sí se le dicen a un cliente: fuera (siguen en la MEDIDA).
  String.raw`\bI should (?:decline|steer)\b`,
  String.raw`\bI (?:need|have) to steer\b`,
  // «the customer asks…» solo a principio de frase, en presente (el modelo narra en presente) y nunca en pregunta: «The customer
  // said May?» se lo dice el bot a un agente. Sin «client»: a un agente el bot sí le contesta «If the client wants to visit…».
  String.raw`(?:^|[.!?]\s+)the (?:customer|user|lead) (?:writes|says|asks|is asking|is writing)\b(?![^.!?\n]*\?)`,
  String.raw`\bcustomer writes in\b`,
  String.raw`\bso the disclosure\b`,
  // «Las reglas prohíben…» y «debo rechazar la reserva» sí se le dicen a un cliente: solo «el prompt / mis instrucciones».
  String.raw`\b(?:el prompt|mis instrucciones) (?:dice|dicen|proh[ií]be|proh[ií]ben)\b`,
  String.raw`(?:^|[.!?¿]\s*)el (?:cliente|usuario) (?:escribe|pregunta)\b`,
].join("|"), "im");

/** Patrón de MEDIDA (batería): el estricto más señales que no se quitan solas porque un cliente sí podría leerlas. */
// (Conserva todo lo que medía el patrón anterior de botcrm.js —«let me check», «the customer says» en cualquier sitio, «I should
// say», «the rule says», «per the rule»— y lo que salió del estricto al acotarlo el 10-oct.)
export const RAZONAMIENTO_FILTRADO = new RegExp(FUGA_ESTRICTA.source + "|" + [
  String.raw`\blet me (?:correct|check|think|re-?read)\b`,
  String.raw`\bthe customer (?:writes|says|asks|is writing)\b`,
  String.raw`\bI should (?:say|give|use|respond|reply|answer|redirect)\b`,
  String.raw`\bI (?:need|have) to (?:decline|redirect)\b`,
  String.raw`\bthe rule says\b`,
  String.raw`\bper the rules?\b`,
  String.raw`\bthe (?:instructions|rules|guidelines) (?:say|says|forbid|forbids|require|requires)\b`,
  String.raw`\b(?:las instrucciones|las reglas) (?:dice|dicen|proh[ií]be|proh[ií]ben)\b`,
  String.raw`\bdebo (?:rechazar|declinar|redirigir)\b`,
].join("|"), "im");

/** Frase si TODA la respuesta era razonamiento: neutra, sin promesas (ni precio, ni persona, ni plazo). */
export const RESPUESTA_TRAS_FUGA = "Sorry, could you tell me a bit more about what you're looking for?";

/**
 * Una frase sale si casa con el estricto; dentro de un párrafo ya contaminado, también si casa con la MEDIDA
 * («The customer asks about tokens. I need to decline.»: la segunda sola es de cliente, al lado de la primera es razonamiento).
 */
function limpiaParrafo(p) {
  if (!FUGA_ESTRICTA.test(p)) return p;
  return p.split("\n")
    .map((linea) => linea.split(/(?<=[.!?])[ \t]+/).filter((f) => !FUGA_ESTRICTA.test(f) && !RAZONAMIENTO_FILTRADO.test(f)).join(" "))
    .filter((l) => l.trim())
    .join("\n");
}

/**
 * Quita el razonamiento por FRASE dentro de los párrafos (separados por línea en blanco) que casan con FUGA_ESTRICTA; el resto
 * del párrafo se queda (revisión de código del 11-oct: el bot escribe dos o tres líneas, casi siempre un solo párrafo, y
 * cortar el párrafo entero cambiaba la respuesta buena por la frase neutra). Devuelve el texto limpio; si no queda nada,
 * `siVacio` (por defecto RESPUESTA_TRAS_FUGA; cleanReply pasa "" cuando hay traspaso según pideTraspaso, la MISMA regla que
 * usa el llamador, que entonces pone la frase de traspaso). Cada corte deja un aviso en el log, sin texto del cliente.
 */
export function quitaRazonamiento(texto, { log = (m) => console.warn(m), siVacio = RESPUESTA_TRAS_FUGA } = {}) {
  const s = String(texto || "");
  if (!FUGA_ESTRICTA.test(s)) return s;
  const parrafos = s.split(/\n[ \t]*\n/);
  const tocados = parrafos.filter((p) => FUGA_ESTRICTA.test(p)).length;
  const limpio = parrafos.map(limpiaParrafo).filter((p) => p.trim()).join("\n\n").trim();
  try { log(`[fuga-razonamiento] razonamiento del modelo quitado en ${tocados} de ${parrafos.length} párrafos${limpio ? "" : " (no quedaba nada)"}`); } catch { /* el log nunca tumba la respuesta */ }
  return limpio || siVacio;
}
