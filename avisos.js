// Aviso al responsable (OWNER_PHONE) que LLEGA aunque haya pasado su ventana de 24 h (bbm-bot, 15-oct-2026).
//
// Por qué: cuatro avisos le prometen algo al cliente («una persona del equipo seguirá contigo»: la escalación sin respuesta, BBM-50 «pide una persona»,
// la derivación del flujo del ERP y los avisos técnicos del flujo) y salían como TEXTO LIBRE al responsable. Meta lo rechaza si el responsable no ha
// escrito al número del bot en 24 h (131047, medido en el log de bbm-bot el 15-oct a las 11:00: «ENTREGA FALLIDA … more than 24 hours»), y el envío
// devuelve ok igual: el fallo llega después por el webhook de estados. Resultado: la promesa al cliente sin nadie detrás (familia
// `promesa-al-cliente-sin-dueno`, 3.er caso). Solo `notifyOwner` (lead nuevo) usaba ya la plantilla aprobada ALERT_TEMPLATE_NAME.
//
// Regla, en UN embudo para los cuatro (cerrar una salida no cierra las hermanas):
//   · ventana del responsable ABIERTA (escribió al bot hace < 23 h, margen de 1 h) → texto libre como antes: lleva el detalle y su id permite
//     «responder citando» (escmap).
//   · ventana CERRADA o DESCONOCIDA (no consta que haya escrito, p. ej. recién desplegado) y plantilla configurada → la plantilla aprobada
//     (bbm_owner_alert: «New lead: {{1}}. Their message: {{2}}. Open the panel to take over.»), que Meta entrega siempre. Desconocida = plantilla: ante la
//     duda, lo que llega. Su id también va a escmap, así que citar la plantilla también enruta la respuesta al cliente.
//   · sin plantilla configurada → texto libre (lo de siempre; si la ventana está cerrada no llegará, y se grita en el log).
// La ventana se marca cuando el responsable escribe al bot (marca()), en Redis con TTL de 24 h; sin Redis, en memoria.
// No toca Telegram (va aparte, mejor esfuerzo) ni ningún mensaje al CLIENTE.

export const VENTANA_SEGURA_MS = 23 * 3600 * 1000;
const CLAVE = "avisos:ventana_responsable";

const corto = (s, n) => String(s ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, n);

// Parámetros de la plantilla según cuántas variables tiene (ALERT_TEMPLATE_VARS, por defecto 2: igual que notifyOwner).
export function paramsPlantilla(vars, { etiqueta, quien, que }) {
  const n = Number.isInteger(vars) ? vars : 2;
  const q = corto(quien, 120) || "-", t = corto(que, 400) || "-", e = corto(etiqueta, 80) || "-";
  if (n === 0) return [];
  if (n === 1) return [`${e}: ${q}. ${t}`];
  if (n === 2) return [q, `${e}: ${t}`];
  return [e, q, t];
}

export function createAvisoResponsable(o = {}) {
  const {
    ownerPhone, plantilla = null,   // { nombre, idioma, vars } o null
    redis = () => null, enviaTexto, enviaPlantilla, now = () => Date.now(), log = console, project = "bot",
  } = o;
  const p = (m) => `[${project}] [avisos] ${m}`;
  let enMemoria = null;
  const hayPlantilla = !!(plantilla && plantilla.nombre);

  // El responsable acaba de escribir al bot: su ventana de 24 h está abierta desde ya.
  async function marca(t = now()) {
    enMemoria = t;
    const r = redis();
    if (r) { try { await r.setEx(CLAVE, 24 * 3600, String(t)); } catch { /* queda la memoria */ } }
  }
  async function ultima() {
    const r = redis();
    if (r) {
      try { const v = await r.get(CLAVE); const n = v ? parseInt(v, 10) : NaN; if (Number.isFinite(n)) return n; } catch { /* abajo: memoria */ }
    }
    return enMemoria;
  }
  async function ventanaAbierta() {
    const u = await ultima();
    return u !== null && u !== undefined && now() - u < VENTANA_SEGURA_MS;
  }

  // → { ok, id, via: 'texto'|'plantilla'|'texto_tras_plantilla'|'nada', error? }. Nunca lanza.
  async function avisa({ texto, etiqueta, quien, que }) {
    if (!ownerPhone) return { ok: false, via: "nada", error: "sin OWNER_PHONE" };
    let abierta = false;
    try { abierta = await ventanaAbierta(); } catch { abierta = false; }
    try {
      if (abierta || !hayPlantilla) {
        if (!abierta) log.warn(p("ventana de 24 h del responsable cerrada o desconocida y SIN plantilla (ALERT_TEMPLATE_NAME): el aviso puede no llegar"));
        const r = await enviaTexto(ownerPhone, texto);
        return { ok: !!(r && r.ok), id: (r && r.id) || null, via: "texto", error: r && !r.ok ? r.error : undefined };
      }
      const r = await enviaPlantilla(ownerPhone, plantilla.nombre, plantilla.idioma, paramsPlantilla(plantilla.vars, { etiqueta, quien, que }));
      if (r && r.ok) return { ok: true, id: r.id || null, via: "plantilla", error: undefined };
      // La plantilla falló (no aprobada, pausada, mal configurada…): se intenta el texto libre, que llega si la ventana resulta estar abierta.
      log.error(p(`la plantilla del aviso al responsable falló (${corto(r && r.error, 200)}): se intenta texto libre`));
      const t = await enviaTexto(ownerPhone, texto);
      return { ok: !!(t && t.ok), id: (t && t.id) || null, via: "texto_tras_plantilla", error: t && !t.ok ? t.error : (r && r.error) };
    } catch (e) {
      return { ok: false, via: "nada", error: e && e.message ? e.message : "error" };
    }
  }

  return { avisa, marca, ventanaAbierta };
}
