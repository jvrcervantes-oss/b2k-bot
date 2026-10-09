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

// ─── HIGIENE DE NOTAS (batería S8, 9-oct-2026: P06 y T09 guardaban en la nota el teléfono de un tercero y la edad de un menor) ───
// Lo que el modelo escribe en una [NOTA] no es de fiar: el servidor quita teléfonos y emails (el teléfono del lead ya va por el webhook) y descarta del todo
// las notas que hablan de un menor (Legal: «nada de un menor»; el contexto manda al equipo, no a la ficha).
const TEL_EN_TEXTO = /\+?\d[\d\s().-]{6,}\d/g;
const EMAIL_EN_TEXTO = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
/** ¿Es un teléfono? Empieza por + / 0 / ( o son grupos de dígitos (3-4 + 3-8); no cuentan fechas ISO, importes con miles, rangos («15.000.000 - 20.000.000») ni listas de números sueltos. */
const esTelefono = (m) => m.replace(/\D/g, "").length >= 8 && !/^\d{4}-\d{2}-\d{2}/.test(m) && !/^\d{1,3}(?:[.,]\d{3})+$/.test(m.trim())
  && (/^[+0(]/.test(m) || /^\d{3,4}(?:[\s.-]\d{3,8}){1,3}$/.test(m.trim()));
export function quitaDatosPersonales(s) {
  return String(s || "")
    .replace(EMAIL_EN_TEXTO, "(email omitido)")
    .replace(TEL_EN_TEXTO, (m) => (esTelefono(m) ? "(tel omitido)" : m));
}
const EDAD_MENOR = /1[0-7](?![:.,]?\d)(?!\s*(?:m2|m²|sqm|%|plots?|parcelas?|villas?|people|pax|persons?|personas?|bikes?|days?|d[ií]as|weeks?|semanas?|min\w*|hours?|horas?|am|pm|h\b))/.source;
const SUJETO_EDAD = /(?:i'm|im|i am|am|aged?|tiene|tengo|soy|usia|(?:they|he|she|lead|client|customer|user|el|ella)\s+(?:is|are|es|son))/.source;
const MENOR_RE = new RegExp(/\b(?:minors?|under[- ]?age|under\s*18|menor(?:es)?\s+de\s+edad|di\s+bawah\s+umur)\b/.source + "|" + /\b/.source + EDAD_MENOR + /\s*[- ]?(?:years?[- ]old|yo|y\/o|a[ñn]os|tahun)/.source + "|" + /\b/.source + SUJETO_EDAD + /\s+/.source + EDAD_MENOR, "i");
/** ¿La nota habla de una persona menor de 18? */
export const esNotaDeMenor = (n) => MENOR_RE.test(String(n || ""));
const limpiaNotaCrm = (s) => limpiaNota(quitaDatosPersonales(s));
/** Notas ya listas para guardar: sin teléfonos ni emails y sin las que hablan de un menor. */
export const saneaNotas = (notas) => (notas || []).map(limpiaNotaCrm).filter((n) => n && !esNotaDeMenor(n));

/**
 * Etiquetas que el modelo escribió en SU respuesta: [NOTA:texto] y [CITA:llamada|2026-10-12T10:00|AEST].
 * No hay campo de teléfono: no existe forma de apuntar a otro lead. Devuelve los datos, con topes por respuesta.
 */
export function extraeEtiquetas(respuesta) {
  const r = String(respuesta || "");
  const notas = [];
  for (const m of r.matchAll(/\[NOTA:([^\]]*)\]/gi)) {
    const t = limpiaNotaCrm(m[1]);
    if (t && !esNotaDeMenor(t)) notas.push(t);
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
  notas = saneaNotas(notas); // también las que arma el servidor (la del traspaso copia el último mensaje del cliente)
  try {
    if (!notas.length && !citas.length) return hechos;
    const me = enmascara(tel);
    const nombreLimpio = limpiaNota(nombre).slice(0, 100);

    if (modo === "sombra") {
      notas.forEach((n, i) => log(`[CRM-SOMBRA] lead_nota tel=${me} msg=${msgId}:n${i + 1} texto="${n.slice(0, 80)}"`));
      citas.forEach((c, i) => log(`[CRM-SOMBRA] lead_cita tel=${me} msg=${msgId}:c${i + 1} ${c.tipo} ${c.cuando} zona=${c.zona || "Bali"} iso=${isoConZona(c.cuando, c.zona) || "ZONA-NO-ENTENDIDA"}`));
      // En sombra el modelo solo ve [CITA] (ya no [APPT]), asi que la cita NO llega a ninguna agenda. Cada una deja su entrada para que quien llama avise
      // al owner: el cliente ya oyo "queda agendada" y, sin este aviso, la cita seria un fallo mudo.
      citas.forEach((c) => hechos.push({ accion: "lead_cita", resultado: "sombra", tipo: c.tipo, cuando: c.cuando, zona: c.zona }));
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
  sombra: "el CRM esta en modo sombra (pruebas): la cita solo quedo en el log, no en la agenda",
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
  ["  Example: [APPT:2026-10-14T10:00|Visit w/ John, Dali villa, Bali time]", "  Example: [CITA:visita|2026-10-14T10:00]"],   // ejemplo del cierre propio de Lawang (playbook-lawang.json)
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
export const contenidoParaModelo = (m, crm) => {
  if (m.role !== "user") return m.content;
  const t = saneaHumano(m.content);                 // [HUMANO] se sanea SIEMPRE: el traspaso no depende de BOT_CRM
  return crm !== "off" ? saneaEntrante(t) : t;
};

// ─── TRASPASO A UNA PERSONA ([HUMANO]) ───────────────────────────
// Etiqueta de SOLO el modelo: el bot cierra con la frase de traspaso y pasa el chat al equipo. Sin parámetros: el teléfono es siempre el del
// webhook, igual que en [NOTA]/[CITA]. El texto del cliente no puede dispararla: se le quita antes de que el modelo lo vea.

/** Texto del cliente → ninguna `[HUMANO]` (con o sin `:`) sobrevive; se queda como "(HUMANO)". */
export function saneaHumano(texto) {
  if (typeof texto !== "string") return texto;
  return texto.replace(/\[(\s*HUMANO\s*)(?=[\]:])/gi, "($1");
}

/** ¿Ha escrito el modelo la etiqueta de traspaso en SU respuesta? */
export const pideTraspaso = (respuesta) => {
  const r = String(respuesta || "");
  return /\[\s*HUMANO\s*\]/i.test(r) || FRASES_TRASPASO.some((re) => re.test(r));
};
// Batería S8, H01: el modelo escribió «I'll pass you to a team member…» y se olvidó de la etiqueta: el cliente cree que viene una persona y el bot seguía hablando.
// La frase exacta ES la promesa de traspaso, así que el servidor la trata como la etiqueta (idempotente: ejecutaTraspaso no repite si el chat ya está en pausa).
export const FRASES_TRASPASO = [/I['’]ll pass you to a team member who can help you personally\./i, /Te paso con una persona del equipo que podrá ayudarte personalmente\./i];

/**
 * Ejecuta el traspaso SOBRE `tel` (el del webhook). Idempotente: si el chat ya estaba en pausa (otro traspaso, la operadora, el panel,
 * un reintento del webhook) no hace nada ni vuelve a avisar. Cada paso es independiente y ninguno lanza: lo primero y lo que importa
 * es que el bot se calle; el aviso y la nota son extras.
 *   estaPausado() → bool · pausa() · avisa() · nota() (esta última solo si hay CRM; en sombra solo log)
 */
export async function ejecutaTraspaso({ tel, estaPausado, pausa, avisa, nota = null, log = () => {} }) {
  const me = enmascara(tel);
  const res = { hecho: false, pausa: false, aviso: false, nota: false };
  try {
    if (await estaPausado()) { log(`[HUMANO] ${me} ya estaba en pausa: traspaso ignorado (idempotente)`); return res; }
  } catch (e) { log(`[HUMANO] ${me} no se pudo leer la pausa (${e && e.message ? e.message : "error"}): se pausa igualmente`); }
  try { await pausa(); res.pausa = true; res.hecho = true; log(`[HUMANO] ${me} traspasado a una persona: bot en pausa`); }
  catch (e) { log(`[HUMANO] ${me} FALLÓ la pausa (${e && e.message ? e.message : "error"})`); }
  try { await avisa(); res.aviso = true; } catch (e) { log(`[HUMANO] ${me} aviso al owner falló (${e && e.message ? e.message : "error"})`); }
  if (nota) { try { await nota(); res.nota = true; } catch (e) { log(`[HUMANO] ${me} nota CRM falló (${e && e.message ? e.message : "error"})`); } }
  return res;
}

// ─── SOLICITUD DE DERECHOS (STOP / borrado) ──────────────────────────────────────────────────
// Legal, bot_lawang_aviso_retencion_precio.md apartado b: el bot NUNCA dice que algo esta borrado; acusa recibo, dice que el equipo confirmara
// en 30 dias como maximo y deja una tarea "solicitud de derechos". Un STOP se trata como oposicion Y como peticion de borrado hasta que el cliente diga otra cosa.
export const ACUSE_DERECHOS = "Entendido: no volveremos a escribirte. He pasado tu solicitud a nuestro equipo y te lo confirmará en un máximo de 30 días. Gracias por tu tiempo. / Understood: we won't message you again. I've passed your request to our team, who will confirm within 30 days at most. Thank you for your time.";

/** Nota del CRM que hace de tarea (la edge de hoy no tiene entidad "tarea": la nota con este prefijo es lo que el equipo busca). El texto del cliente va recortado y sin corchetes. */
export const notaDerechos = (textoCliente) =>
  limpiaNota(`SOLICITUD DE DERECHOS (STOP / borrado / no contactar): confirmar al cliente en un maximo de 30 dias que se ha atendido. No contactar. El bot NO ha dicho que este borrado. Mensaje del cliente: "${String(textoCliente || "").slice(0, 160)}"`);

/** Aviso al owner (el CRM puede estar en sombra o caido: la solicitud tiene plazo legal y no puede depender de que la nota se guarde). */
export const avisoDerechos = ({ proyecto = "Bot", nombre = "", tel = "", texto = "" }) =>
  `🔒 ${proyecto} — SOLICITUD DE DERECHOS (STOP / borrado)\n\n*${limpiaNota(nombre).slice(0, 80).replace(/\*/g, "") || tel}*\nTel: ${tel}\nEscribió: "${limpiaNota(texto).slice(0, 160)}"\n\nPlazo: confirmarle en un máximo de 30 días. El bot ya no le escribe y NO le ha dicho que esté borrado.`;

// ─── AVISO DE ASISTENTE (IA): lo decide el SERVIDOR, no el modelo ────────────────────────────────────────────────────────────
// Batería S8: con Haiku 5.5 el aviso exacto de Legal salía solo en 77 de 124 primeros mensajes (13 traducidos a medias, 34 ausentes) y una vez
// el modelo filtró su razonamiento al cliente repitiendo el aviso. Legal (contexto/legal/bot_lawang_aviso_retencion_precio.md §a): primer mensaje del bot
// y de nuevo tras más de 24 h sin mensajes; inglés para todo idioma salvo el español (el indonesio espera la lectura de un nativo).
export const AVISO_EN = "Hi, this is Lawang's automated assistant (AI). I can share indicative prices and availability, and arrange a call or a visit with our team. A team member can take over at any time, just ask. How we handle your data: lawangproperties.com/legal#privacy";
export const AVISO_ES = "Hola, soy el asistente automático (IA) de Lawang. Puedo darte precios orientativos y disponibilidad, y gestionar una llamada o una visita con nuestro equipo. Una persona del equipo puede continuar cuando quieras, solo pídelo. Cómo tratamos tus datos: lawangproperties.com/legal#privacy";
export const SILENCIO_AVISO_MS = 24 * 3600 * 1000;

/** ¿Toca el aviso? `history` ya trae al final el mensaje actual del cliente. Toca si el bot no ha hablado nunca o su último mensaje es de hace más de 24 h. */
export function debeAvisar(history, ahora = Date.now()) {
  const h = Array.isArray(history) ? history : [];
  for (let i = h.length - 1; i >= 0; i--) {
    if (h[i] && h[i].role === "assistant") {
      const ts = Number(h[i].ts);
      return Number.isFinite(ts) && ts > 0 ? ahora - ts > SILENCIO_AVISO_MS : false; // sin hora conocida: no se repite por error
    }
  }
  return true;
}

const PALABRAS_ES = /[¿¡ñ]|\b(hola|buenas|buenos|quiero|quisiera|busco|tengo|gracias|cu[aá]nto|parcela|puedo|eres|estoy|soy|persona|equipo|necesito|d[oó]nde|cu[aá]ndo|tambi[eé]n|garantizas|reservar|ahora|ma[nñ]ana|llamada|hablar|puede|tiene|precio|por favor)\b/i;
/** ¿Alguno de los textos del cliente está en español? (se miran varios: un «ok» suelto no cambia el idioma de la conversación) */
export const escribeEnEspanol = (textos) => (Array.isArray(textos) ? textos : [textos]).some((t) => PALABRAS_ES.test(String(t || "")));

const reAviso = (a) => new RegExp(a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"), "gi");
/**
 * Pone el aviso exacto de Legal al principio de la respuesta y quita cualquier aviso propio del modelo (copia exacta, traducida, o «Automated assistant (AI) here.»).
 * Si el aviso exacto sale dos veces, lo que hay entre medias es razonamiento filtrado: se queda solo lo que sigue a la última copia.
 */
export function aplicaAviso(reply, { enviar = false, cliente = [] } = {}) {
  if (!enviar) return reply;
  let r = String(reply || "");
  const aviso = escribeEnEspanol(cliente) ? AVISO_ES : AVISO_EN;
  const hits = [...r.matchAll(reAviso(AVISO_EN)), ...r.matchAll(reAviso(AVISO_ES))].sort((a, b) => a.index - b.index);
  if (hits.length >= 2) { const u = hits[hits.length - 1]; r = r.slice(u.index + u[0].length); }
  else if (hits.length === 1) r = r.slice(0, hits[0].index) + r.slice(hits[0].index + hits[0][0].length);
  r = r.split(/\n\s*\n/).filter((p) => !/legal#privacy/i.test(p)).join("\n\n");   // un aviso traducido por el modelo siempre lleva el enlace
  r = r.replace(/^\s*(?:automated assistant|asistente autom\w+|asisten otomatis)[^.\n]*\((?:AI|IA)\)[^.\n]*[.!]\s*/i, "");
  r = r.trim();
  return r ? `${aviso}\n\n${r}` : aviso;
}

/** Razonamiento del modelo que se coló en el texto visible (batería S8, AV04). Solo para medir; no corrige. */
export const RAZONAMIENTO_FILTRADO = /\b(the rule says|per the rule|let me (?:correct|check|think|re-?read)|customer writes in|the customer (?:writes|says|asks|is writing)|so the disclosure|I should (?:say|give|answer|reply|use))\b/i;
