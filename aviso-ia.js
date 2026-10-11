// Aviso de IA en el primer mensaje del bot (BBM-50, 11-oct-2026).
//
// Por qué existe: el contrato de encargo de Bali Best (Anexo V, cláusula 6) obliga a decir en el primer mensaje que quien
// contesta es un asistente con IA. El owner decidió (11-oct, 23:40): «Que lo diga al empezar» — sigue llamándose Daniel,
// pero la primera respuesta de cada conversación dice que es un asistente virtual con IA y que se puede pedir una persona.
//
// Lo pone el SERVIDOR, no el modelo: ninguna garantía del modelo se da por hecha (lección de Bots del 10-oct: Haiku con
// effort low se salta reglas). El texto es fijo y lo aprobó el orquestador (12-oct) antes de publicarse.
//
// «Una vez por conversación»: la marca `aviso_ia: true` va en el propio mensaje del historial (conv:<tel>), no en una clave
// aparte. Así se borra con la conversación (borrado completo o purga de privacidad.js) y vuelve a salir si la conversación
// se vacía; `conservaMarca` la mantiene cuando saveConversation recorta a 100 mensajes. Las conversaciones que ya existían
// antes de este cambio lo reciben en la siguiente respuesta del bot.
//
// Motor compartido: nombre y marca son parámetros. Activo por defecto solo en Bali Best (PROJECT_NAME=BaliBest); en
// cualquier otro bot queda inerte salvo AVISO_IA=on (con AVISO_IA_MARCA). AVISO_IA=off lo apaga también en Bali Best.

import { idiomaCliente } from "./razonamiento.js";

/** Texto del aviso por idioma (literal aprobado con nombre=Daniel y marca=Bali Best). Otro idioma sale en inglés. */
export function textosAviso(nombre = "Daniel", marca = "Bali Best") {
  return {
    en: `Hi! I'm ${nombre}, ${marca}'s virtual assistant. I'm an AI, and you can ask to talk to a person from our team at any time.`,
    id: `Halo! Saya ${nombre}, asisten virtual ${marca}. Saya adalah AI, dan Anda bisa minta bicara dengan staf kami kapan saja.`,
    es: `¡Hola! Soy ${nombre}, el asistente virtual de ${marca}. Soy una IA, y puedes pedir hablar con una persona del equipo cuando quieras.`,
  };
}
export const AVISO_IA = textosAviso();

/** Configuración desde el entorno: { activo, textos }. */
export function configAviso(env = {}, personaName = "Daniel") {
  const v = String(env.AVISO_IA || "").trim().toLowerCase();
  const activo = v === "on" ? true : v === "off" ? false : String(env.PROJECT_NAME || "").trim() === "BaliBest";
  return { activo, textos: textosAviso(personaName, String(env.AVISO_IA_MARCA || "").trim() || "Bali Best") };
}

/** ¿Ya se dio el aviso en esta conversación? Cuenta solo los mensajes marcados por el servidor. */
export function avisoYaDado(history) {
  return Array.isArray(history) && history.some((m) => m && m.aviso_ia === true);
}

/** Recorte del historial que no pierde la marca: si el mensaje marcado se cae del recorte, la marca pasa al primero que queda. */
export function conservaMarca(completo, recortado) {
  if (!avisoYaDado(completo) || avisoYaDado(recortado) || !recortado.length) return recortado;
  return [{ ...recortado[0], aviso_ia: true }, ...recortado.slice(1)];
}

// Saludos de una sola palabra que `idiomaCliente` (pide 2 palabras) no distingue: «Hola» saldría inglés.
const SALUDO_ES = /^\s*[¡!]?\s*(?:hola|buenas|buenos d[ií]as|buenas tardes|buenas noches)(?![\p{L}])/iu;
const SALUDO_ID = /^\s*(?:halo|hai|permisi|selamat (?:pagi|siang|sore|malam)|pagi|siang|sore|malam)(?![\p{L}])/iu;
const EXTRA_ID = /(?<![\p{L}])(?:maaf|boleh|anda|tentang|sedikit|berikut|pembayaran|sewa|minggu|bulan|terima)(?![\p{L}])/giu;
const EXTRA_ES = /(?<![\p{L}])(?:perdona|cuentas|buscas|aqu[ií]|tienes|enlace|pago|alquiler|alquilar|semana|mes)(?![\p{L}])/giu;

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

// Saludo con el que el modelo suele abrir («Hi!», «Hey Ana,», «Halo kak!»): sobra detrás del aviso, que ya saluda.
// Solo se quita si va cerrado por un signo. Sin flag `i` a propósito: con `iu`, \p{Lu} casa minúsculas y se comía
// «sí», «yes» o «no» («Hola sí, tenemos la Vario» → «Tenemos la Vario»; revisor, 12-oct). El nombre exige mayúscula inicial.
const SALUDO_INICIAL = /^\s*[¡!]?\s*(?:[Hh]i|[Hh]ey|[Hh]ello|[Hh]ola|[Bb]uenas|[Hh]alo|[Hh]ai)(?:\s+(?:there|kak|\p{Lu}\p{Ll}+))?\s*[!,.]+\s*/u;

/**
 * Compone el texto del turno con el aviso delante si todavía no se dio. Devuelve { texto, dado }: `dado` = este turno lleva
 * el aviso (el llamador marca así el mensaje en el historial). Sale también cuando el turno no trae texto del modelo (frase
 * neutra, solo media o línea de pago): en ese caso el aviso va solo o delante de esa línea.
 */
export function conAviso({ texto = "", history = [], textoCliente = "", textos = AVISO_IA, activo = true } = {}) {
  const t = String(texto || "").trim();
  if (!activo || avisoYaDado(history)) return { texto: t, dado: false };
  const lang = idiomaAviso(textoCliente, t);
  let resto = t.replace(SALUDO_INICIAL, "");
  if (!resto && t) resto = t; // si todo era el saludo («Hi there!»), mejor repetir saludo que perder la respuesta
  if (resto) resto = resto.charAt(0).toLocaleUpperCase() + resto.slice(1);
  return { texto: resto ? `${textos[lang]}\n\n${resto}` : textos[lang], dado: true };
}
