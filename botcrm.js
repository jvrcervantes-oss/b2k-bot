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

/** Cuántas etiquetas [CITA:...] de la respuesta NO se pueden leer (segundos, zona larga, fecha rara…). Cada una es una cita que el cliente cree agendada. */
export function citasIlegibles(respuesta) {
  const r = String(respuesta || "");
  const total = (r.match(/\[CITA:/gi) || []).length;
  const buenas = (r.match(/\[CITA:\s*(?:llamada|visita|call|visit)\s*\|\s*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?:\s*\|\s*[^\]|]{1,12})?\s*\]/gi) || []).length;
  return Math.max(0, total - buenas);
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

    const paso = async (accion, cuerpo, etiqueta, extra = {}) => {
      try {
        const r = await llama(accion, cuerpo);
        log(`[CRM] ${accion} tel=${me} ${etiqueta} → ${r}`);
        hechos.push({ accion, resultado: r, ...extra });
        return r;
      } catch (e) {
        log(`[CRM] ${accion} tel=${me} ${etiqueta} FALLÓ (${e && e.message ? e.message : "error"}) — la conversación sigue`);
        hechos.push({ accion, resultado: "error", ...extra });
        return "error";
      }
    };
    // Una cita que no llega a la base NO puede quedar muda: el cliente ya cree que está agendada. Cada cita pedida deja su entrada
    // (con el motivo) para que quien llama avise a una persona.
    const sinIntentar = (c, motivo) => hechos.push({ accion: "lead_cita", resultado: motivo, tipo: c.tipo, cuando: c.cuando, zona: c.zona });

    const alta = await paso("lead_upsert", { accion: "lead_upsert", tel, msg_id: `${msgId}:u`, nombre: nombreLimpio, origen: "bot-whatsapp-lawang" }, "alta");
    if (alta !== "creado" && alta !== "existente") {                 // ambiguo / tope / error: nada más se aplica
      citas.forEach((c) => sinIntentar(c, "sin_alta:" + alta));
      return hechos;
    }

    for (let i = 0; i < notas.length; i++) {
      if (topes && !(await topes.permite(tel, "nota"))) { log(`[CRM] tope diario de notas alcanzado tel=${me}`); break; }
      await paso("lead_nota", { accion: "lead_nota", tel, msg_id: `${msgId}:n${i + 1}`, texto: notas[i] }, `nota${i + 1}`);
    }
    for (let i = 0; i < citas.length; i++) {
      const iso = isoConZona(citas[i].cuando, citas[i].zona);
      if (!iso) { log(`[CRM] cita descartada: zona no entendida ("${citas[i].zona}") tel=${me}`); sinIntentar(citas[i], "zona_no_entendida"); continue; }
      if (topes && !(await topes.permite(tel, "cita"))) { log(`[CRM] tope diario de citas alcanzado tel=${me}`); citas.slice(i).forEach((c) => sinIntentar(c, "tope_local")); break; }
      await paso("lead_cita", { accion: "lead_cita", tel, msg_id: `${msgId}:c${i + 1}`, cuando: iso, tipo: citas[i].tipo }, `cita${i + 1}`,
        { tipo: citas[i].tipo, cuando: citas[i].cuando, zona: citas[i].zona });
    }
  } catch (e) {
    try { log(`[CRM] error inesperado: ${e && e.message ? e.message : e}`); } catch { /* el log no puede romper nada */ }
  }
  return hechos;
}

const MOTIVOS_CITA = {
  fuera_horario: "esa hora está fuera del horario (lunes a sábado, 9:00 a 17:30 hora de Bali)",
  pasada: "esa hora ya pasó",
  lejana: "está a más de 60 días",
  ya_hay_cita: "el lead ya tiene otra cita viva (confirmada por el equipo)",
  ambiguo: "hay más de un lead con ese teléfono y el bot no elige",
  sin_lead: "no hay lead con ese teléfono",
  tope: "se alcanzó el tope de citas del lead",
  tope_local: "se alcanzó el tope de citas del día",
  zona_no_entendida: "la zona horaria no se entendió",
  fecha_invalida: "la fecha no era válida",
  tipo_invalido: "el tipo de cita no era válido",
  telefono_invalido: "el teléfono no era válido",
  etiqueta_antigua: "el bot usó una etiqueta antigua ([APPT]) y no se guardó",
  etiqueta_ilegible: "la etiqueta de cita salió mal escrita y no se pudo leer",
  error: "la base no respondió",
};

/**
 * Texto del aviso al owner por UNA cita etiquetada. Las que la base acepta ("propuesta", "reprogramada") avisan de que hay que
 * confirmarla; todas las demás avisan de que NO quedó registrada aunque el cliente crea que sí. Devuelve null si no hay nada que decir.
 */
export function avisoCita({ proyecto = "Bot", nombre = "", tel = "", hecho }) {
  if (!hecho || hecho.accion !== "lead_cita") return null;
  const quien = `*${limpiaNota(nombre).slice(0, 80).replace(/\*/g, "") || tel}*\nTel: ${tel}`;
  const tipo = hecho.tipo === "visita" ? "Visita" : "Llamada";
  const cuando = `${limpiaNota(hecho.cuando || "?").slice(0, 60)} ${hecho.zona ? limpiaNota(hecho.zona).slice(0, 20) : "(hora de Bali)"}`;
  if (hecho.resultado === "propuesta" || hecho.resultado === "reprogramada") {
    return `📞 ${proyecto} — ${tipo.toUpperCase()} PROPUESTA (pendiente de confirmar)\n\n${quien}\nCuándo: ${cuando}\n\nConfírmala o cancélala en la intranet, Agenda de cierre.`;
  }
  const motivo = hecho.resultado.startsWith("sin_alta:") ? "no se pudo dar de alta o localizar al lead (" + hecho.resultado.slice(9) + ")" : (MOTIVOS_CITA[hecho.resultado] || "motivo desconocido: " + hecho.resultado);
  return `⚠️ ${proyecto} — CITA NO REGISTRADA\n\n${quien}\n${tipo} pedida para: ${cuando}\nEl cliente cree que está agendada, pero no se guardó: ${motivo}.\n\nAgéndala a mano o escríbele.`;
}

/**
 * Con BOT_CRM=on el modelo agenda con [CITA:...] y la base guarda la cita: el bloque de cierre del playbook (que enseña [APPT:...]) se reescribe para
 * que no le lleguen las dos instrucciones. Reemplazo LITERAL de frases conocidas; devuelve cuántos "APPT" quedan (debe ser 0) para que quien llama lo grite.
 */
const CAMBIOS_CITA = [
  ["that is exactly what the APPT tag records for the team", "that is exactly what the CITA tag records for the team"],
  ["from the timezone label you put in the APPT tag", "from the timezone label you put in the CITA tag"],
  ["put that timezone label in the APPT title", "put that timezone label as the third field of the CITA tag (no label means Bali time)"],
  ["  [APPT:YYYY-MM-DDTHH:MM|Short title incl. timezone]", "  [CITA:llamada|YYYY-MM-DDTHH:MM|TZ]   (use [CITA:visita|...] for an in-person visit; TZ is optional and means Bali time when omitted)"],
  ["  Example: [APPT:2026-07-15T10:00|Call w/ John re Bali-Komodo — 10:00 AEST]", "  Example: [CITA:llamada|2026-07-15T10:00|AEST]"],
  ["Output the APPT tag only when", "Output the CITA tag only when"],
];
export function adaptaCierreACita(texto) {
  let t = String(texto);
  for (const [de, a] of CAMBIOS_CITA) t = t.split(de).join(a);
  return { texto: t, restantes: (t.match(/APPT/g) || []).length };
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
