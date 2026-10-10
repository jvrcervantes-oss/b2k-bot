// «Solo seguir cotizaciones que aún se pueden vender» (F8 pieza 6, lado motor, 10-oct-2026; decisión del owner y revisión previa #258).
//
// Por qué no basta mirar reservas: la reserva en bloqueo caduca sola en minutos si no se paga, así que a las 24 h de frío ya no existe y el
// seguimiento no saltaría nunca. «Viva» = la cotización sigue vendible: su fecha de inicio no ha pasado y la base dice que queda una unidad libre.
//
// Cómo: al cotizar en modo erp el bot guarda por teléfono producto y fechas (`bbmseg:<tel>`, lo que devolvió la base, nunca texto del chat) y, antes de
// cada envío de seguimiento, vuelve a llamar a la acción YA EXISTENTE `cotiza` de reservas-bot (sin direcciones: no toca Nominatim ni su caché).
// Ninguna acción ni migración nueva (reducir exposición). `cotiza` no tiene tope propio en la edge: el único freno es el del tick (seguimiento-tick.js).
//
// Fail-closed: cualquier cosa que no sea una respuesta clara «hay ≥ 1 unidad» ⇒ no se envía. Nunca «por si acaso».
// Límite conocido: «disponibles» cuenta también la reserva en bloqueo del propio lead (si está pagando, no hace falta seguirle) y no hay reserva atómica:
// dos leads pueden recibir el mismo aviso para la misma unidad. El mensaje es una plantilla sin precio ni promesa de guardar la moto.
import { createKv } from "./bbmflow.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
export const SEG_TTL_MAX_S = 120 * 24 * 3600;   // tope de vida de la clave aunque la fecha sea lejana
export const SEG_TTL_MIN_S = 3600;

const fechaValida = (f) => typeof f === "string" && FECHA.test(f) && !Number.isNaN(Date.parse(f + "T00:00:00Z")) && new Date(f + "T00:00:00Z").toISOString().slice(0, 10) === f;

export function createCotizacionViva(o = {}) {
  const kv = createKv({ redis: o.redis, prefijo: "bbmseg:" });
  const now = o.now ?? (() => Date.now());
  const hoy = o.hoy;                                  // () => YYYY-MM-DD en la zona del negocio (Asia/Makassar), NO el reloj UTC del servidor
  const erp = o.erp;
  const log = o.log || console;
  const p = (m) => `[${o.project || "bot"}] [seguimiento-viva] ${m}`;

  // La clave caduca el día siguiente al inicio de la cotización: pasada esa fecha no hay nada que seguir. Un único SET con EX (kv.set → setEx).
  async function guarda(tel, { producto_id, desde, hasta }) {
    if (typeof producto_id !== "string" || !UUID.test(producto_id) || !fechaValida(desde) || !fechaValida(hasta)) throw new Error("bbmseg: datos inválidos");
    const finMs = Date.parse(desde + "T00:00:00Z") + 2 * 24 * 3600 * 1000;
    const ttl = Math.max(SEG_TTL_MIN_S, Math.min(SEG_TTL_MAX_S, Math.ceil((finMs - now()) / 1000)));
    await kv.set(kv.tel(tel), { producto_id, desde, hasta }, ttl, now());
  }
  const borra = (tel) => kv.del(kv.tel(tel));

  // → { ok: true, llamo } | { ok: false, motivo, descansa, llamo }  (`llamo` = salió una petición a la edge; el tick solo cuenta esas contra su máximo)
  //   motivos: sin_cotizacion · vencida · sin_disponibilidad (descansa) · erp_no_confirma (descansa)
  // `descansa` = el tick no vuelve a preguntar por este lead durante un rato (si no, cada tick de 30 min martillea la edge hasta la fecha de inicio).
  async function verifica(tel) {
    const s = await kv.get(kv.tel(tel), now());
    if (!s || typeof s.producto_id !== "string" || !UUID.test(s.producto_id) || !fechaValida(s.desde) || !fechaValida(s.hasta)) return { ok: false, motivo: "sin_cotizacion" };
    if (!(s.desde > hoy())) { await borra(tel); return { ok: false, motivo: "vencida" }; }
    let c;
    try { c = await erp.cotiza({ producto_id: s.producto_id, desde: s.desde, hasta: s.hasta }); }
    catch (e) { log.error(p(`cotiza lanzó: ${e && e.message ? e.message.slice(0, 80) : "?"}`)); return { ok: false, motivo: "erp_no_confirma", descansa: true, llamo: true }; }
    if (c && c.ok === true && c.cotizacion && Number.isInteger(c.cotizacion.disponibles)) {
      return c.cotizacion.disponibles >= 1 ? { ok: true, llamo: true } : { ok: false, motivo: "sin_disponibilidad", descansa: true, llamo: true };
    }
    if (c && c.ok === false && c.motivo === "sin_disponibilidad") return { ok: false, motivo: "sin_disponibilidad", descansa: true, llamo: true };
    return { ok: false, motivo: "erp_no_confirma", descansa: true, llamo: true };   // 409, 404, 502, tiempo agotado o forma rara
  }

  return { guarda, borra, verifica };
}
