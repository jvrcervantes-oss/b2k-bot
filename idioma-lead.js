// Idioma del lead y nombre de pila para las plantillas de WhatsApp. Puro (sin red, sin Redis, sin Postgres): lo comparten turno-pg.js (recordatorio, S6a)
// y avisos-plantilla.js (S13), que se carga también con BOT_STORE=redis y por eso no puede colgar de turno-pg.js.
const SIN_NOMBRE = { en: "there", es: "cliente", id: "Bapak/Ibu" };
const PALABRAS_EN = new Set(["hello", "hi", "thanks", "thank", "you", "want", "would", "like", "the", "and", "price", "how", "much", "when", "can", "please", "land", "visit", "call", "info", "interested", "what", "where", "is", "are"]);
const PALABRAS_ES = new Set(["hola", "gracias", "quiero", "quisiera", "para", "una", "por", "favor", "cuando", "puedo", "tengo", "buenas", "buenos", "dias", "días", "tardes", "informacion", "información", "precio", "cuanto", "cuánto", "terreno", "villa", "llamada", "visita", "si", "sí", "estoy", "como", "cómo", "que", "qué", "donde", "dónde", "mañana"]);
const PALABRAS_ID = new Set(["halo", "terima", "kasih", "saya", "mau", "ingin", "untuk", "bisa", "berapa", "harga", "tanah", "vila", "apakah", "tolong", "selamat", "pagi", "siang", "sore", "malam", "dan", "yang", "dengan", "ada", "besok", "boleh", "informasi", "kapan", "dimana", "tidak", "iya", "ya"]);
/** Idioma del lead (en/es/id; en por defecto) a partir de lo que ESCRIBIÓ él en el historial. Sin mensajes o sin señal clara → en. */
export function idiomaDe(historial) {
  const textos = (Array.isArray(historial) ? historial : []).filter((h) => h && h.rol === "user" && h.texto).slice(-6).map((h) => String(h.texto));
  let es = 0, id = 0, en = 0;
  for (const t of textos) for (const w of t.toLowerCase().split(/[^\p{L}]+/u)) {
    if (!w) continue;
    if (PALABRAS_ES.has(w)) es++;
    if (PALABRAS_ID.has(w)) id++;
    if (PALABRAS_EN.has(w)) en++;
  }
  if (es >= 2 && es > id && es > en) return "es";
  if (id >= 2 && id > es && id > en) return "id";
  return "en";
}
/** Primer nombre limpio para {{1}} (Meta rechaza vacíos, saltos y tabuladores). Sin nombre usable → fórmula neutra del idioma. */
export function nombrePila(nombre, idioma = "en") {
  const t = String(nombre || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().split(/\s+/)[0] || "";
  const limpio = t.replace(/[^\p{L}\p{M}'’.-]/gu, "").slice(0, 30);
  return limpio.length >= 1 ? limpio : (SIN_NOMBRE[idioma] || SIN_NOMBRE.en);
}
