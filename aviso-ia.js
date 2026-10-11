// Aviso de IA en el primer mensaje del bot (BBM-50, 11-oct-2026).
//
// Por qué existe: el contrato de encargo de Bali Best (Anexo V, cláusula 6) obliga a decir en el primer mensaje que quien
// contesta es un asistente con IA. El owner decidió (11-oct, 23:40): «Que lo diga al empezar» — sigue llamándose Daniel,
// pero la primera respuesta de cada conversación dice que es un asistente virtual con IA y que se puede pedir una persona.
//
// Lo pone el SERVIDOR, no el modelo: ninguna garantía del modelo se da por hecha (lección de Bots del 10-oct: Haiku con
// effort low se salta reglas). El texto es fijo y lo aprobó el orquestador antes de publicarse.
//
// «Una vez por conversación»: la marca `aviso_ia: true` va en el propio mensaje del historial (conv:<tel>), no en una clave
// aparte. Así se borra con la conversación (borrado completo o purga de privacidad.js) y vuelve a salir si la conversación
// se vacía; y las conversaciones que ya existían antes de este cambio lo reciben en la siguiente respuesta del bot.

import { idiomaCliente } from "./razonamiento.js";

/** Texto literal del aviso por idioma. Cualquier otro idioma sale en inglés (el de la marca). */
export const AVISO_IA = {
  en: "Hi! I'm Daniel, Bali Best's virtual assistant. I'm an AI, and you can ask to talk to a person from our team at any time.",
  id: "Halo! Saya Daniel, asisten virtual Bali Best. Saya adalah AI, dan Anda bisa minta bicara dengan staf kami kapan saja.",
  es: "¡Hola! Soy Daniel, el asistente virtual de Bali Best. Soy una IA, y puedes pedir hablar con una persona del equipo cuando quieras.",
};

/** ¿Ya se dio el aviso en esta conversación? Cuenta solo los mensajes marcados por el servidor. */
export function avisoYaDado(history) {
  return Array.isArray(history) && history.some((m) => m && m.aviso_ia === true);
}

// Saludos de una sola palabra que `idiomaCliente` (pide 2 palabras) no distingue: «Hola» saldría inglés.
const SALUDO_ES = /^\s*[¡!]?\s*(?:hola|buenas|buenos d[ií]as|buenas tardes|buenas noches)(?![\p{L}])/iu;
const SALUDO_ID = /^\s*(?:halo|hai|permisi|selamat (?:pagi|siang|sore|malam)|pagi|siang|sore|malam)(?![\p{L}])/iu;

/**
 * Idioma del aviso: el del cliente, ayudado por la respuesta del modelo (que ya contesta en el idioma del cliente) para que el
 * aviso no salga en otro idioma que el resto del mensaje. "en" | "es" | "id"; ante la duda, inglés.
 */
export function idiomaAviso(textoCliente, respuesta = "") {
  const cli = String(textoCliente || "");
  const todo = `${cli}\n${String(respuesta || "")}`;
  const conjunto = idiomaCliente(todo);
  if (conjunto !== "en") return conjunto;
  if (SALUDO_ES.test(cli)) return "es";
  if (SALUDO_ID.test(cli)) return "id";
  // Palabras de las respuestas del propio bot (frase neutra, línea de pago, cotización) que la lista de idiomaCliente no tiene:
  // «Maaf, boleh ceritakan…» solo casaba «yang» y salía en inglés.
  const id = (todo.match(EXTRA_ID) || []).length, es = (todo.match(EXTRA_ES) || []).length;
  if (id >= 2 && id > es) return "id";
  if (es >= 2 && es > id) return "es";
  return "en";
}
const EXTRA_ID = /(?<![\p{L}])(?:maaf|boleh|anda|tentang|sedikit|berikut|pembayaran|sewa|minggu|bulan|terima)(?![\p{L}])/giu;
const EXTRA_ES = /(?<![\p{L}])(?:perdona|cuentas|buscas|aqu[ií]|tienes|enlace|pago|alquiler|alquilar|semana|mes)(?![\p{L}])/giu;

// Saludo con el que el modelo suele abrir («Hi!», «Hey Ana,», «Halo kak!»): sobra detrás del aviso, que ya saluda.
// Solo se quita si va cerrado por un signo, para no comerse una frase («Hi there the Vario is…» no se toca).
const SALUDO_INICIAL = /^\s*[¡!]?\s*(?:hi|hey|hello|hola|buenas|halo|hai)(?:\s+(?:there|kak|\p{Lu}\p{L}*))?\s*[!,.]+\s*/iu;

/**
 * Compone el texto del turno con el aviso delante si todavía no se dio. Devuelve { texto, dado }: `dado` = este turno lleva
 * el aviso (el llamador marca así el mensaje en el historial). Sale también cuando el turno no trae texto del modelo (frase
 * neutra, solo media o línea de pago): en ese caso el aviso va solo o delante de esa línea.
 */
export function conAviso({ texto = "", history = [], textoCliente = "" } = {}) {
  const t = String(texto || "").trim();
  if (avisoYaDado(history)) return { texto: t, dado: false };
  const lang = idiomaAviso(textoCliente, t);
  let resto = t.replace(SALUDO_INICIAL, "");
  if (resto) resto = resto.charAt(0).toLocaleUpperCase() + resto.slice(1);
  return { texto: resto ? `${AVISO_IA[lang]}\n\n${resto}` : AVISO_IA[lang], dado: true };
}
