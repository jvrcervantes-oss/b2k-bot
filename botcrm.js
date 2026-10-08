// CRM del bot de Lawang (S6 del encargo encargos/20261008_lawang_bot_catalogo_crm.md).
// Funciones puras con la red inyectada (`llama`), probadas con node --test.
//
// Reglas que no se negocian (Seguridad, 8-oct-2026):
//  - El teléfono sobre el que se actúa es SIEMPRE el del webhook de Meta. Las etiquetas del modelo no llevan teléfono
//    y, si lo llevaran, no se leería: el parser no tiene ningún campo de teléfono.
//  - El texto que escribe el cliente se sanea (`[XXX:` → `(XXX:`) antes de llegar al modelo: un lead no puede
//    "hablarle" al parser fabricando etiquetas.
//  - Topes por lead y día, y por respuesta. Detrás están los de la base; estos frenan antes de gastar llamadas.
//  - Ningún error de la edge sale de aquí: se registra y la conversación sigue.
//  - Modo sombra: solo log, nada de llamadas de escritura.

export const MAX_NOTAS_RESPUESTA = 2;
export const MAX_CITAS_RESPUESTA = 1;
export const MAX_NOTAS_DIA = 15;
export const MAX_CITAS_DIA = 3;
export const MAX_NOTA_CHARS = 500;

/** Texto del cliente → texto para el modelo: ninguna cadena `[PALABRA:` sobrevive. */
export function saneaEntrante(texto) {
  if (typeof texto !== "string") return texto;
  return texto.replace(/\[(\s*[A-Za-z_]{2,20}\s*:)/g, "($1");
}

// Zonas que el modelo puede escribir como etiqueta. Las ambiguas (CST, IST, BST…) no están: mejor no crear la cita
// que crearla a una hora equivocada.
const ZONAS = {
  WITA: "+08:00", SGT: "+08:00", AWST: "+08:00", WIB: "+07:00", WIT: "+09:00", JST: "+09:00",
  ACST: "+09:30", ACDT: "+10:30", AEST: "+10:00", AEDT: "+11:00", NZST: "+12:00", NZDT: "+13:00",
  UTC: "+00:00", GMT: "+00:00", CET: "+01:00", CEST: "+02:00",
  EST: "-05:00", EDT: "-04:00", PST: "-08:00", PDT: "-07:00",
};

/** "2026-10-12T10:00" + zona opcional → ISO con desplazamiento, o null si la zona no se entiende. Sin zona = hora de Bali. */
export function isoConZona(cuando, zona) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(cuando || "")) return null;
  const z = (zona || "").trim().toUpperCase().replace(/^UTC(?=[+-])/, "");
  let off;
  if (!z) off = "+08:00";
  else if (/^[+-]\d{2}:\d{2}$/.test(z)) off = z;
  else if (/^[+-]\d{1,2}$/.test(z)) off = z[0] + z.slice(1).padStart(2, "0") + ":00";
  else off = ZONAS[z];
  if (!off) return null;
  return `${cuando}:00${off}`;
}

const limpiaNota = (s) => String(s || "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/[\[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_NOTA_CHARS);

/**
 * Etiquetas que el modelo escribió en SU respuesta: [NOTA:texto] y [CITA:llamada|2026-10-12T10:00|AEST].
 * No hay campo de teléfono: no existe forma de apuntar a otro lead. Devuelve los datos, con topes por respuesta.
 */
export function extraeEtiquetas(respuesta) {
  const r = String(respuesta || "");
  const notas = [];
  for (const m of r.matchAll(/\[NOTA:([^\]]*)\]/gi)) {
    const t = limpiaNota(m[1]);
    if (t) notas.push(t);
  }
  const citas = [];
  for (const m of r.matchAll(/\[CITA:\s*(llamada|visita|call|visit)\s*\|\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?:\s*\|\s*([^\]|]{1,12}))?\s*\]/gi)) {
    const tipo = /^(call|llamada)$/i.test(m[1]) ? "llamada" : "visita";
    citas.push({ tipo, cuando: m[2], zona: (m[3] || "").trim() });
  }
  return { notas: notas.slice(0, MAX_NOTAS_RESPUESTA), citas: citas.slice(0, MAX_CITAS_RESPUESTA) };
}

/** Quita de la respuesta TODA etiqueta [NOTA:..] / [CITA:..], bien formada o no (el cliente nunca las ve). */
export const quitaEtiquetasCrm = (s) => String(s || "").replace(/\[(?:NOTA|CITA):[^\]]*\]/gi, "");

/** Lo que se le dice al modelo sobre las etiquetas (solo si BOT_CRM no está apagado). */
export const INSTRUCCIONES_CRM = [
  "CRM TAGS (silent: the system strips them before sending, the customer never sees them; never mention them):",
  "- When you learn something the team needs to follow up (what they want, budget range they gave, where they stay, deadlines, a nominee-structure mention, a deletion request), end your message with [NOTA:short factual note, max 300 characters].",
  "- Only when a precise day and hour are agreed for a call or a visit, end your message with [CITA:llamada|YYYY-MM-DDTHH:MM] or [CITA:visita|YYYY-MM-DDTHH:MM]. The time is the customer's own time; add their zone label as a third field if it is not Bali time, e.g. [CITA:llamada|2026-10-12T10:00|AEST]. Never invent a day or hour. Never convert time zones yourself.",
  "- The booking is only a proposal until a person on the team confirms it. Tags never change who the lead is; you never put a phone number, email or name inside a tag.",
].join("\n");

/** Topes por lead y día. `incr(clave)` → nuevo contador (Redis o memoria); si falla, se deniega (fail-closed). */
export function creaTopes({ incr, maxNotas = MAX_NOTAS_DIA, maxCitas = MAX_CITAS_DIA, hoy = () => new Date().toISOString().slice(0, 10) }) {
  return {
    async permite(tel, que) {
      const max = que === "cita" ? maxCitas : maxNotas;
      try { return (await incr(`crm:tope:${que}:${tel}:${hoy()}`)) <= max; }
      catch { return false; }
    },
  };
}

const enmascara = (tel) => "…" + String(tel).slice(-4);

/**
 * Ejecuta lo que el modelo etiquetó, SIEMPRE sobre `tel` (el del webhook).
 *   modo: "sombra" (solo log) | "on" (llama a la edge)
 *   llama(accion, cuerpo) → resultado (string) | lanza
 * Nunca lanza.
 */
export async function ejecutaCrm({ modo, tel, msgId, nombre = "", notas = [], citas = [], llama, topes, log = () => {} }) {
  const hechos = [];
  try {
    if (!notas.length && !citas.length) return hechos;
    const me = enmascara(tel);
    const nombreLimpio = limpiaNota(nombre).slice(0, 100);

    if (modo === "sombra") {
      notas.forEach((n, i) => log(`[CRM-SOMBRA] lead_nota tel=${me} msg=${msgId}:n${i + 1} texto="${n.slice(0, 80)}"`));
      citas.forEach((c, i) => log(`[CRM-SOMBRA] lead_cita tel=${me} msg=${msgId}:c${i + 1} ${c.tipo} ${c.cuando} zona=${c.zona || "Bali"} iso=${isoConZona(c.cuando, c.zona) || "ZONA-NO-ENTENDIDA"}`));
      return hechos;
    }
    if (modo !== "on" || typeof llama !== "function") return hechos;

    const paso = async (accion, cuerpo, etiqueta) => {
      try {
        const r = await llama(accion, cuerpo);
        log(`[CRM] ${accion} tel=${me} ${etiqueta} → ${r}`);
        hechos.push({ accion, resultado: r });
        return r;
      } catch (e) {
        log(`[CRM] ${accion} tel=${me} ${etiqueta} FALLÓ (${e && e.message ? e.message : "error"}) — la conversación sigue`);
        hechos.push({ accion, resultado: "error" });
        return "error";
      }
    };

    const alta = await paso("lead_upsert", { accion: "lead_upsert", tel, msg_id: `${msgId}:u`, nombre: nombreLimpio, origen: "bot-whatsapp-lawang" }, "alta");
    if (alta !== "creado" && alta !== "existente") return hechos;   // ambiguo / tope / error: nada más se aplica

    for (let i = 0; i < notas.length; i++) {
      if (topes && !(await topes.permite(tel, "nota"))) { log(`[CRM] tope diario de notas alcanzado tel=${me}`); break; }
      await paso("lead_nota", { accion: "lead_nota", tel, msg_id: `${msgId}:n${i + 1}`, texto: notas[i] }, `nota${i + 1}`);
    }
    for (let i = 0; i < citas.length; i++) {
      const iso = isoConZona(citas[i].cuando, citas[i].zona);
      if (!iso) { log(`[CRM] cita descartada: zona no entendida ("${citas[i].zona}") tel=${me}`); continue; }
      if (topes && !(await topes.permite(tel, "cita"))) { log(`[CRM] tope diario de citas alcanzado tel=${me}`); break; }
      await paso("lead_cita", { accion: "lead_cita", tel, msg_id: `${msgId}:c${i + 1}`, cuando: iso, tipo: citas[i].tipo }, `cita${i + 1}`);
    }
  } catch (e) {
    try { log(`[CRM] error inesperado: ${e && e.message ? e.message : e}`); } catch { /* el log no puede romper nada */ }
  }
  return hechos;
}

/** Bloques `system` de catálogo y CRM. Con los dos interruptores apagados devuelve [] (el system es el de siempre). */
export function bloquesSistema({ catalogo = "off", crm = "off", cat = null }) {
  const out = [];
  if (crm !== "off") out.push({ type: "text", text: INSTRUCCIONES_CRM });
  // Con el catálogo encendido nunca se calla: si el servicio falló (cat null), se avisa "no disponible" y no se cita nada.
  if (catalogo === "on") {
    out.push({
      type: "text",
      text: cat ? cat.texto : "CATALOG NOT AVAILABLE right now. Do not quote any price, size or availability. Say the team will confirm the exact figures.",
      cache_control: { type: "ephemeral" },
    });
  }
  return out;
}

/** Contenido de un mensaje del historial tal como lo ve el modelo: el del cliente se sanea si el CRM está activo; si no, idéntico. */
export const contenidoParaModelo = (m, crm) => (crm !== "off" && m.role === "user" ? saneaEntrante(m.content) : m.content);
