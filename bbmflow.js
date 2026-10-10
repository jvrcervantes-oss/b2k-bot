// Flujo de conversación de BBM contra el ERP (F8 pieza 7, 7a sombra + 7c modo erp, 9-oct-2026).
//
// Qué es: el pegamento entre la conversación del bot (index.js) y el cliente de la edge (bbmerp.js). Todo entra por funciones con dependencias
// inyectadas (redis, erp, relojes, enviadores): no toca el entorno ni la red por su cuenta, así se prueba con mentiras. index.js solo lo cablea.
//
// Reglas (cada una con su porqué):
//   · EL MODELO NO MANDA NADA AL PAGAR. Cuando la herramienta cotiza en erp, la última cotización BUENA de esa conversación se guarda aquí
//     (`bbmq:<tel>`, 30 min). `[PAY:x]` es solo el disparador: la reserva se hace con lo guardado, y si lo que dijo el modelo no es EXACTAMENTE el
//     total guardado no se manda enlace (un precio alucinado no llega al cobro). Producto, fechas y direcciones nunca salen del texto del modelo.
//   · EL ENLACE LO CREA ESTE CÓDIGO CON `cobro` DE LA BASE: importe = cobro.importe (sin el 3 % ni el depósito), external_id = el de la reserva,
//     caducidad por debajo de `segundos_hasta_caducar` con margen. No pasa por createRentalPayLink (que suma comisión y elige Stripe).
//   · NO HAY ENLACE SIN NOMBRE Y PAÍS (`cliente` va antes) NI SIN RESERVA. Cualquier fallo devuelve un texto de reserva en inglés y avisa al
//     equipo: el modelo ya escribió «te mando el enlace» cuando llega el fallo, así que el texto del fallo se añade, nunca se calla.
//   · DUPLICADOS: con un `pendingRsv` vivo, un segundo `[PAY]` reenvía ese enlace; no crea otra reserva (la `clave` cambia con cada mensaje y no protege).
//   · EL AVISO DE PAGO ES POR RESERVA, NO POR TELÉFONO: el external_id `rsv:<uuid>` no lleva teléfono, así que al crear la reserva se guarda el
//     índice `rsvtel:<uuid>` → teléfono (7 días). Sin él, el cliente que paga nunca recibiría el «reserva confirmada».
//   · SOMBRA: nunca bloquea (se lanza sin esperar), nunca llama a `entrega` (gastaría el turno de 1 consulta/s de Nominatim de las reservas
//     reales y trataría una dirección sin la frase de privacidad), nunca llama a `reserva` ni `cliente`. Cuenta coincidencias y divergencias.
//   · Logs sin PII: ids, importes, motivos. Nunca teléfonos, nombres, direcciones ni mensajes.

import { telefonoVerificado } from "./bbmerp.js";

export const COTIZACION_TTL_S = 30 * 60;
export const INDICE_RSV_TTL_S = 7 * 24 * 3600;
export const MARGEN_CADUCIDAD_S = 120;       // el enlace caduca antes que la reserva: pagar a las puertas de la caducidad es lo que genera pagos tardíos
export const MIN_ENLACE_S = 300;             // con menos de 5 minutos de reserva viva no se manda un enlace

const norm = (s) => String(s ?? "").trim().toLowerCase();
const str = (x) => typeof x === "string";
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const KO = (motivo, extra = {}) => ({ ok: false, motivo, ...extra });

// ── almacenes pequeños (Redis, o memoria sin Redis: mismas reglas) ─────────────────────────────────────────────────────────────────
export function createKv({ redis = () => null, prefijo }) {
  const mem = new Map();
  const tel = (t) => String(t).replace(/\D/g, "");
  return {
    async set(id, valor, ttlS, now = Date.now()) {
      const k = prefijo + id;
      const r = redis();
      if (r) await r.setEx(k, ttlS, JSON.stringify(valor));
      else mem.set(k, { valor: JSON.parse(JSON.stringify(valor)), hasta: now + ttlS * 1000 });   // copia, como haría Redis
    },
    async get(id, now = Date.now()) {
      const k = prefijo + id;
      const r = redis();
      if (r) { const raw = await r.get(k); if (!raw) return null; try { return JSON.parse(raw); } catch { return null; } }
      const e = mem.get(k);
      if (!e || e.hasta <= now) { mem.delete(k); return null; }
      return JSON.parse(JSON.stringify(e.valor));
    },
    async del(id) { const k = prefijo + id; const r = redis(); if (r) await r.del(k); else mem.delete(k); },
    tel,
  };
}

// Última cotización buena de ESTA conversación. Lo único que `[PAY]` usa para reservar.
export function createQuoteStore(o = {}) {
  const kv = createKv({ redis: o.redis, prefijo: "bbmq:" });
  const now = o.now ?? (() => Date.now());
  return {
    guarda: (tel, q) => kv.set(kv.tel(tel), q, COTIZACION_TTL_S, now()),
    lee: (tel) => kv.get(kv.tel(tel), now()),
    borra: (tel) => kv.del(kv.tel(tel)),
  };
}

// reserva_id → teléfono (para avisar del pago). Solo el id de la reserva y el teléfono del propio chat.
export function createReservaIndex(o = {}) {
  const kv = createKv({ redis: o.redis, prefijo: "rsvtel:" });
  const now = o.now ?? (() => Date.now());
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return {
    async guarda(reservaId, tel) {
      if (!str(reservaId) || !UUID.test(reservaId)) throw new Error("rsvtel: reserva_id inválido");
      const t = telefonoVerificado(tel);
      if (!t) throw new Error("rsvtel: teléfono inválido");
      await kv.set(reservaId.toLowerCase(), { tel: t }, INDICE_RSV_TTL_S, now());
    },
    async lee(reservaId) {
      if (!str(reservaId) || !UUID.test(reservaId)) return null;
      const v = await kv.get(reservaId.toLowerCase(), now());
      return v && str(v.tel) ? v.tel : null;
    },
    // «rsv:<uuid>» → teléfono
    async teleDeExternalId(externalId) {
      return str(externalId) && externalId.startsWith("rsv:") ? this.lee(externalId.slice(4)) : null;
    },
  };
}

// ── la herramienta get_quote en modo erp ───────────────────────────────────────────────────────────────────────────────────────────
// Mismo nombre que la de Dion (el prompt estático la nombra), distinta descripción: la del ERP NO deja que el modelo ponga nombres de
// alojamiento (Legal, pieza 4b: la dirección es dato personal; se pide «calle y zona» y número o referencia).
export const ERP_QUOTE_TOOL = {
  name: "get_quote",
  description:
    "Get the AUTHORITATIVE total price for one bike over an exact date range from the booking system. You MUST call this to quote any total; "
    + "NEVER add up or derive a price yourself. The total already includes delivery/pickup (when you pass delivery_address) and any tax, and the "
    + "response lists each line of the breakdown. It does NOT include the refundable deposit (cash at handover). `available` tells you whether a "
    + "unit is free for those dates — if it is false, do not offer to book it. "
    + "For delivery_address ask the customer for the STREET and AREA plus a house number or a landmark (e.g. \"Jl. Pantai Berawa 99, Canggu\"). "
    + "Do NOT use the name of a hotel, villa or guesthouse as the address, and do not ask for one. Pass it as soon as you have it.",
  input_schema: {
    type: "object",
    properties: {
      bike_model: { type: "string", description: "Bike name EXACTLY as the customer chose it from the models you have offered." },
      from: { type: "string", description: "Rental start date, YYYY-MM-DD." },
      to: { type: "string", description: "Rental end date (return date), YYYY-MM-DD." },
      delivery_address: { type: "string", description: "Street and area plus number or landmark. Omit if the customer collects the bike or hasn't said yet." },
      self_return: { type: "boolean", description: "true ONLY if the customer said they will bring the bike back themselves (then pickup is not charged). Omit otherwise." },
    },
    required: ["bike_model", "from", "to"],
  },
};

// Bloque del system prompt en modo erp. Va DESPUÉS del prompt estático (pensado para Dion) y lo corrige en lo que cambia.
export const ERP_PROMPT_BLOCK =
  "BOOKING SYSTEM — THIS CONVERSATION RUNS ON THE NEW BOOKING SYSTEM. Where this block disagrees with anything earlier, this block wins.\n"
  + "- Prices and availability come ONLY from the get_quote tool. There is no price list, stock list or offers list in this conversation: never quote, estimate or recall a price, a discount or a free-unit count from memory.\n"
  + "- Show the customer the breakdown the tool returns (each line) and the total, and only then ask if they want to book. The total already includes any tax and the delivery/pickup lines.\n"
  + "- Delivery: ask for street + area and a house number or landmark. Never ask for or use a hotel/villa name. The first time you ask, add one short line: \"We only use your address to calculate the delivery and bring you the bike.\" If the tool says it cannot price that address, ask for a more precise street + area, once; if it still cannot, say the team will confirm the delivery price and add `tags: pricing_check` — do not give a price.\n"
  + "- ONLINE PAYMENT FEE: there is NO extra payment fee in this system. Do not mention a 3% or 4% fee and do not add one.\n"
  + "- The refundable deposit is NOT in the total: it is collected in cash at handover (amount as stated in your context) and never goes through the link.\n"
  + "- BEFORE you send the payment link you need the customer's full name AND their country, both confirmed in the chat. Put them in a [LEAD name=...; country=...] tag. No name or no country → ask for it, do not send [PAY].\n"
  + "- [PAY:AMOUNT]: AMOUNT must be EXACTLY the `total` the last get_quote returned, digits only. If the customer changes the bike, the dates or the address after that quote, call get_quote again FIRST. The server books the bike using the last quote and ONLY sends the link if your AMOUNT matches it; if anything fails the server tells the customer itself. So when you output [PAY] write only a short line like \"Perfect, sending your secure payment link now\" — never promise the link will arrive, never type a link.\n"
  + "- The link holds the bike for about an hour. After the customer pays, the system confirms the booking by itself; do not say it is confirmed before that.\n";

// ── ejecución de la herramienta ────────────────────────────────────────────────────────────────────────────────────────────────────
// Devuelve SIEMPRE un objeto (nunca lanza): un error controlado vuelve al modelo como texto para que reaccione.
export function createErpTools({ erp, quotes, seg = null, log = console, project = "bot", hoy = () => new Date().toISOString().slice(0, 10) }) {
  const p = (m) => `[${project}] [bbmflow] ${m}`;
  const SIN_PRECIO = "Tell the customer you're confirming the exact price with the team and add tags: pricing_check. Do NOT give a price.";

  function buscaProducto(productos, nombre) {
    const n = norm(nombre);
    if (!n) return null;
    return productos.find((x) => norm(x.nombre) === n)
      || productos.find((x) => norm(x.nombre).includes(n) || n.includes(norm(x.nombre)))
      || null;
  }

  async function runGetQuote(tel, { bike_model, from, to, delivery_address, self_return } = {}) {
    try {
      if (!str(bike_model) || !str(from) || !str(to) || !FECHA.test(from) || !FECHA.test(to)) return { ok: false, error: "Missing or malformed bike_model, from or to (dates must be YYYY-MM-DD)." };
      if (!(to > from)) return { ok: false, error: "The return date must be after the start date." };
      if (from < hoy()) return { ok: false, error: "The start date is in the past. Ask the customer for the real dates." };
      const cat = await erp.catalogo();
      if (!cat.ok) return { ok: false, error: `The booking system is unreachable right now. ${SIN_PRECIO}` };
      const hit = buscaProducto(cat.productos, bike_model);
      if (!hit) return { ok: false, error: `No bike named "${bike_model}" is available to book. Offer the models you do have and let the customer pick one, then call get_quote again.` };

      const direccion = str(delivery_address) && delivery_address.trim() ? delivery_address.trim() : null;
      if (direccion) {
        const e = await erp.entrega(direccion);
        if (!e.ok) {
          if (e.motivo === "peticion_invalida") return { ok: false, error: "That address is too short or has odd characters. Ask for street + area and a house number or landmark." };
          return { ok: false, error: `The delivery price can't be worked out right now. ${SIN_PRECIO}` };
        }
        if (e.estado === "ambigua" || e.estado === "sin_resultado") {
          return { ok: false, error: "The system could not pin down that address. Ask the customer for the street and area plus a house number or landmark (not a hotel or villa name), then call get_quote again. Do NOT guess a delivery price." };
        }
        if (e.estado !== "ok") return { ok: false, error: `The delivery price can't be worked out right now. ${SIN_PRECIO}` };
      }

      const c = await erp.cotiza({
        producto_id: hit.id, desde: from, hasta: to,
        ...(direccion ? { entrega_direccion: direccion } : {}),
        ...(direccion && self_return !== true ? { recogida_direccion: direccion } : {}),
      });
      if (!c.ok) {
        if (c.motivo === "entrega_a_confirmar" || c.motivo === "entrega_no_configurada") return { ok: false, error: `The delivery price must be confirmed by the team. ${SIN_PRECIO}` };
        if (c.motivo === "sin_disponibilidad") { if (seg) { try { await seg.borra(tel); } catch { /* best-effort */ } } return { ok: true, bike: hit.nombre, from, to, available: false, note: "No unit of this bike is free for those dates. Do not offer to book it: offer other dates or another model." }; }
        return { ok: false, error: `The booking system could not price this right now. ${SIN_PRECIO}` };
      }
      const q = c.cotizacion;
      if (q.disponibles < 1) {
        await quotes.borra(tel);
        if (seg) { try { await seg.borra(tel); } catch { /* best-effort */ } }
        return { ok: true, bike: hit.nombre, from, to, available: false, note: "No unit of this bike is free for those dates. Do not offer to book it: offer other dates or another model." };
      }
      await quotes.guarda(tel, {
        producto_id: q.producto_id, nombre: hit.nombre, desde: q.desde, hasta: q.hasta,
        entrega_direccion: direccion, recogida_direccion: direccion && self_return !== true ? direccion : null,
        total: q.total, moneda: q.moneda,
      });
      // Para el seguimiento (F8 pieza 6): solo producto y fechas que devolvió la base, nunca texto del chat. Un fallo aquí no rompe la cotización.
      if (seg) { try { await seg.guarda(tel, { producto_id: q.producto_id, desde: q.desde, hasta: q.hasta }); } catch (e) { log.error(p(`bbmseg no guardado: ${e && e.message ? e.message.slice(0, 80) : "?"}`)); } }
      log.log(p(`get_quote erp ok: total=${q.total} ${q.moneda}`));
      return {
        ok: true, bike: hit.nombre, from, to, available: true, days: q.dias, total: q.total, currency: q.moneda,
        tax_included_in_total: !!q.impuesto, tax: q.impuesto ? `${q.impuesto.nombre} ${q.impuesto.porcentaje}%` : null,
        breakdown: q.lineas.map((l) => ({ line: l.descripcion, amount: l.bruto })),
        note: "total is what the customer pays online. The refundable deposit is NOT included (cash at handover).",
      };
    } catch (e) {
      log.error(p(`get_quote erp fallo: ${e && e.message ? e.message.slice(0, 120) : "?"}`));
      return { ok: false, error: `The booking system failed. ${SIN_PRECIO}` };
    }
  }
  return { runGetQuote };
}

// ── cierre: [PAY] en modo erp ──────────────────────────────────────────────────────────────────────────────────────────────────────
const TEXTO_FALLO = {
  sin_cotizacion: "I need to re-check the price for your dates before I can send the payment link — one moment, I'm asking the team.",
  importe_no_cuadra: "I want to double-check the final price with the team before sending you the payment link — they'll message you shortly.",
  faltan_datos: "Before I send the payment link I just need your full name and your country.",
  sin_disponibilidad: "Sorry — that bike was just taken for those dates. Want me to check other dates or another model?",
  precio_cambio: "The price has just been updated, so I'm confirming the final total with the team before sending you the link.",
  tope: "We're getting a lot of bookings right now. The team will send you the payment link personally in a few minutes.",
  sin_tiempo: "Your hold is about to run out. I'm asking the team to refresh it — they'll message you shortly.",
  en_curso: "I'm already preparing your payment link — it will arrive in a moment.",
  generico: "I couldn't generate your payment link just now. I've flagged it to the team and they'll send it to you shortly.",
};
const MOTIVO_A_TEXTO = {
  sin_disponibilidad: "sin_disponibilidad", tope_global: "tope", tope_telefono: "tope",
};

// deps: erp, quotes, pendingRsv, indice, backend (createBackendSwitch), crearFactura({external_id, importe, moneda, descripcion, duracionS}) → {url,id}|null,
//       avisaEquipo(texto) (mejor esfuerzo), now, log, project
export function createCierreErp({ erp, quotes, pendingRsv, indice, backend, crearFactura, avisaEquipo = async () => {}, now = () => Date.now(), log = console, project = "bot" }) {
  const p = (m) => `[${project}] [bbmflow] ${m}`;
  const fallo = async (motivo, extra) => {
    const clave = TEXTO_FALLO[motivo] ? motivo : "generico";
    // faltan_datos lo pide el cliente, no es una avería: no se avisa al equipo
    if (motivo !== "faltan_datos") { try { await avisaEquipo(`⚠️ [${project}] reserva ERP no completada: ${motivo}${extra ? ` (${extra})` : ""}`); } catch { /* mejor esfuerzo */ } }
    return { ok: false, motivo, texto: TEXTO_FALLO[clave] };
  };

  // Un solo cierre a la vez por teléfono: dos [PAY] casi simultáneos (el handler no serializa por chat) reservarían dos veces. Un solo proceso: basta memoria.
  const enCurso = new Set();
  async function cierra(args) {
    const t = telefonoVerificado(args.tel);
    if (!t) return fallo("generico", "telefono");
    if (enCurso.has(t)) return { ok: false, motivo: "en_curso", texto: TEXTO_FALLO.en_curso };
    enCurso.add(t);
    try { return await cierraUno({ ...args, tel: t }); } finally { enCurso.delete(t); }
  }

  async function cierraUno({ tel, mensajeId, payAmount, nombre, pais }) {
    const t = tel;

    // 1) Un enlace vivo se reenvía; no se crea otra reserva
    const pend = await pendingRsv.lee(t);
    if (pend) {
      if (pend.url) { log.warn(p("[PAY] con un enlace rsv vivo: se reenvía el mismo")); return { ok: true, url: pend.url, reutilizado: true, importe: pend.importe, moneda: pend.moneda }; }
      return fallo("generico", "enlace_sin_url");
    }

    // 2) Lo guardado manda; lo del modelo solo se compara
    const q = await quotes.lee(t);
    if (!q) return fallo("sin_cotizacion");
    if (!Number.isInteger(payAmount) || payAmount !== q.total) { log.warn(p(`[PAY] no cuadra con la cotización guardada (modelo=${payAmount} guardada=${q.total})`)); return fallo("importe_no_cuadra"); }

    // 3) Nombre y país, antes que nada
    if (!str(nombre) || nombre.trim().length < 2 || !str(pais) || pais.trim().length < 2) return fallo("faltan_datos");

    // 4) Reserva. El backend se fija ANTES: desde aquí la conversación es del ERP aunque el interruptor cambie.
    try { await backend.fija(t, COTIZACION_TTL_S, "erp"); } catch { /* el enlace vivo (pendingRsv) también ata la conversación */ }
    // Una reserva ya creada para ESTA cotización (un intento anterior falló en `cliente` o en Xendit) se reutiliza mientras le quede tiempo: reservar otra
    // retendría una segunda unidad (o negaría la moto si solo hay una). No se confía en que la base la devuelva sola: con `clave` por mensaje no lo hace.
    let rs = null;
    if (q.reserva) {
      const quedan = q.reserva.cobro.segundos_hasta_caducar - Math.floor((now() - q.reserva.creada_ms) / 1000);
      if (quedan - MARGEN_CADUCIDAD_S >= MIN_ENLACE_S) rs = { ...q.reserva, cobro: { ...q.reserva.cobro, segundos_hasta_caducar: quedan } };
      else { delete q.reserva; await quotes.guarda(t, q); }
    }
    if (!rs) {
      const r = await erp.reserva({
        fromVerificado: t, producto_id: q.producto_id, desde: q.desde, hasta: q.hasta,
        entrega_direccion: q.entrega_direccion ?? undefined, recogida_direccion: q.recogida_direccion ?? undefined,
        mensajeId, conversacion_ref: t,
      });
      if (!r.ok) {
        if (r.motivo === "entrega_a_confirmar" || r.motivo === "entrega_no_configurada") return fallo("generico", r.motivo);
        return fallo(MOTIVO_A_TEXTO[r.motivo] || "generico", r.motivo);
      }
      rs = r.reserva;
      if (rs.precio_total !== q.total || rs.moneda !== q.moneda) { await quotes.borra(t); return fallo("precio_cambio", `cotizado=${q.total} reserva=${rs.precio_total}`); }
      q.reserva = { ...rs, creada_ms: now() };
      try { await quotes.guarda(t, q); } catch { /* sin guardar, un reintento reservaría otra: la base la devuelve si no hay `clave` por mensaje */ }
    }

    // 5) Cliente (nombre y país) ANTES del enlace
    const c = await erp.cliente({ reserva_id: rs.reserva_id, nombre, pais });
    if (!c.ok) return fallo("generico", `cliente:${c.motivo}`);   // la reserva queda guardada en la cotización: el siguiente [PAY] reintenta SOLO cliente y enlace
    if (!c.cliente_identificado) log.warn(p(`cliente no identificado (${c.motivo || "?"}): lo decide una persona; el cobro sigue`));

    // 6) Enlace de pago con EL cobro de la base
    const duracionS = rs.cobro.segundos_hasta_caducar - MARGEN_CADUCIDAD_S;
    if (duracionS < MIN_ENLACE_S) { await quotes.borra(t); return fallo("sin_tiempo", `quedan=${rs.cobro.segundos_hasta_caducar}s`); }
    const inv = await crearFactura({ external_id: rs.cobro.external_id, importe: rs.cobro.importe, moneda: rs.cobro.moneda, descripcion: `${project} — ${q.nombre} ${q.desde}→${q.hasta}`, duracionS });
    if (!inv || !str(inv.url)) return fallo("generico", "xendit"); // igual: se reintenta el enlace sobre la misma reserva; si no, caduca sola (no hay acción `libera`)

    // 7) Registro: enlace pendiente + índice para avisar del pago. Si falla, el enlace sigue siendo válido: se manda igual.
    try { await pendingRsv.guarda(t, { external_id: rs.cobro.external_id, importe: rs.cobro.importe, moneda: rs.cobro.moneda, reserva_id: rs.reserva_id, caduca_en_ms: now() + duracionS * 1000, url: inv.url }); }
    catch (e) { log.error(p("no se pudo guardar el enlace pendiente (el enlace se manda igual)")); }
    try { await indice.guarda(rs.reserva_id, t); }
    catch (e) { log.error(p("no se pudo guardar el índice reserva→teléfono: el aviso de pago irá a la ficha del equipo")); try { await avisaEquipo(`⚠️ [${project}] sin índice reserva→teléfono para ${rs.reserva_id}: avisar a mano del pago`); } catch { /* */ } }
    await quotes.borra(t);
    return { ok: true, url: inv.url, importe: rs.cobro.importe, moneda: rs.cobro.moneda, reservaId: rs.reserva_id, numeroReserva: rs.numero_reserva, reutilizado: false };
  }
  return { cierra };
}

// ── aviso al cliente cuando paga ───────────────────────────────────────────────────────────────────────────────────────────────────
// `cuerpo` es lo que contestó la edge reservas-pago: {ok,factura:{numero,total,moneda}} | {ok,factura_espera} | {revisar:true} | {ignorado} | null.
export function textoPagoRecibido(cuerpo, { importe, moneda } = {}) {
  const cant = Number.isFinite(importe) ? ` — ${Math.round(importe).toLocaleString("id-ID")} ${moneda || "IDR"}` : "";
  if (cuerpo && cuerpo.revisar === true) {
    return `✅ Payment received${cant}. Thank you! Our team is checking your booking and will message you shortly to confirm it.`;
  }
  const f = cuerpo && typeof cuerpo.factura === "object" && cuerpo.factura ? cuerpo.factura : null;
  const fac = f && str(f.numero) && /^[A-Za-z0-9._\/-]{1,40}$/.test(f.numero)
    ? ` Your invoice number is ${f.numero}.`
    : " Your invoice is on its way.";
  return `✅ Payment received${cant}. Thank you! Your booking is confirmed.${fac} Our team will be in touch to arrange delivery.`;
}

// Quien cuelga de la puerta del webhook: busca el teléfono por el índice, avisa una sola vez por factura y limpia el estado de la conversación.
// deps: indice, pendingRsv, backend, dedupe(invoiceId) → true si es la primera vez, enviaCliente(tel, texto) → {ok}, marcaPagado(tel, importe, moneda),
//       avisaEquipo(texto)
export function createAvisoPago({ indice, pendingRsv, backend, dedupe, enviaCliente, marcaPagado = async () => {}, avisaEquipo = async () => {}, log = console, project = "bot" }) {
  const p = (m) => `[${project}] [bbmflow] ${m}`;
  return async function onResultado({ externalId, invoiceId, cuerpo }) {
    if (!cuerpo || cuerpo.ignorado === true) return { avisado: false, motivo: "ignorado" };
    const tel = await indice.teleDeExternalId(externalId);
    if (!tel) {
      log.error(p("pago de una reserva sin teléfono en el índice: aviso a mano"));
      try { await avisaEquipo(`⚠️ [${project}] Pago recibido de la reserva ${String(externalId).slice(0, 44)} pero no sé a qué chat avisar. Comprobar en el ERP.`); } catch { /* */ }
      return { avisado: false, motivo: "sin_telefono" };
    }
    if (dedupe && !(await dedupe(invoiceId))) return { avisado: false, motivo: "repetido" };
    const pend = await pendingRsv.lee(tel);
    const importe = pend ? pend.importe : undefined, moneda = pend ? pend.moneda : undefined;
    const r = await enviaCliente(tel, textoPagoRecibido(cuerpo, { importe, moneda }));
    if (!(r && r.ok)) { log.error(p("no se pudo avisar del pago al cliente")); try { await avisaEquipo(`⚠️ [${project}] Pago recibido pero NO se pudo avisar al cliente por WhatsApp (reserva ${String(externalId).slice(4, 12)}…). Avisarle a mano.`); } catch { /* */ } }
    if (cuerpo.revisar !== true) { try { await marcaPagado(tel, importe, moneda); } catch { /* mejor esfuerzo */ } }
    try { await pendingRsv.borra(tel); } catch { /* */ }
    try { await backend.suelta(tel); } catch { /* */ }
    try { await avisaEquipo(`💰 [${project}] Pago de reserva ERP${cuerpo.revisar === true ? " — A REVISAR (no encaja con la reserva)" : ""}${importe ? `: ${Math.round(importe).toLocaleString("id-ID")} ${moneda || ""}` : ""}`); } catch { /* */ }
    return { avisado: !!(r && r.ok), motivo: cuerpo.revisar === true ? "revisar" : "ok" };
  };
}

// ── 7a SOMBRA ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Compara, SIN mostrar nada al cliente, lo que Dion cotizó (resultado de runGetQuote de Dion) con lo que cotiza el ERP para la misma moto y fechas.
// Solo `catalogo` y `cotiza` y SIN dirección: nada de `entrega` (ver cabecera), nada de `reserva`/`cliente`.
// Contadores en Redis (`bbm:sombra`, hash) y última divergencia (sin PII) para /admin/api/health.
export function createSombra({ erp, redis = () => null, n = 30, log = console, project = "bot", now = () => Date.now() }) {
  const p = (m) => `[${project}] [bbm-sombra] ${m}`;
  const mem = { coincide: 0, diverge: 0, sin_erp: 0, ultima: null };
  const norma = (s) => norm(s);

  function compara(dion, q) {
    const motivos = [];
    // OJO: el total del ERP lleva impuesto, seguro y entrega; el de Dion no. Se compara lo comparable: el alquiler.
    if (q.precio_alquiler != null && Number.isFinite(Number(dion.rental_rate)) && Math.round(q.precio_alquiler) !== Math.round(Number(dion.rental_rate))) motivos.push("precio");
    if (Number.isInteger(dion.duration_days) && q.dias !== dion.duration_days) motivos.push("dias");
    if (q.disponibles < 1) motivos.push("disponibilidad");
    return motivos;
  }

  async function cuenta(campo, extra) {
    mem[campo] += 1;
    if (extra) mem.ultima = { ...extra, en: now() };
    const r = redis();
    if (r) { try { await r.hIncrBy("bbm:sombra", campo, 1); if (extra) await r.hSet("bbm:sombra", "ultima", JSON.stringify({ ...extra, en: now() })); } catch { /* mejor esfuerzo */ } }
  }

  // dion = { ok, bike, from, to, duration_days, rental_rate } de la herramienta de Dion. NUNCA lanza, NUNCA se espera en el camino del cliente.
  async function observa(dion) {
    try {
      if (!erp.enabled || !dion || dion.ok !== true || !dion.from || !dion.to || !dion.bike) return;
      const cat = await erp.catalogo();
      if (!cat.ok) { await cuenta("sin_erp", { motivo: "catalogo" }); return; }
      const hit = cat.productos.find((x) => norma(x.nombre) === norma(dion.bike)) || cat.productos.find((x) => norma(x.nombre).includes(norma(dion.bike)) || norma(dion.bike).includes(norma(x.nombre)));
      if (!hit) { await cuenta("diverge", { motivos: ["moto_sin_equivalente"], moto: String(dion.bike).slice(0, 40) }); return; }
      const c = await erp.cotiza({ producto_id: hit.id, desde: dion.from, hasta: dion.to });
      if (!c.ok) { await cuenta("sin_erp", { motivo: c.motivo }); return; }
      const m = compara(dion, c.cotizacion);
      if (m.length) { await cuenta("diverge", { motivos: m, moto: String(dion.bike).slice(0, 40), desde: dion.from, hasta: dion.to, dion: Math.round(Number(dion.rental_rate)), erp: Math.round(c.cotizacion.precio_alquiler ?? NaN), dias_dion: dion.duration_days, dias_erp: c.cotizacion.dias }); log.warn(p(`divergencia: ${m.join(",")}`)); }
      else await cuenta("coincide");
    } catch { /* la sombra jamás rompe una conversación */ }
  }

  async function estado() {
    let c = { ...mem };
    const r = redis();
    if (r) {
      try {
        const h = await r.hGetAll("bbm:sombra");
        c = { coincide: Number(h.coincide || 0), diverge: Number(h.diverge || 0), sin_erp: Number(h.sin_erp || 0), ultima: h.ultima ? JSON.parse(h.ultima) : null };
      } catch { /* RAM */ }
    }
    // Criterio del owner (9-oct): N cotizaciones reales SIN divergencia. Una divergencia reinicia la cuenta (quien la ve decide si se arregla y se resetea).
    return { n_objetivo: n, coincide: c.coincide, diverge: c.diverge, sin_erp: c.sin_erp, listo: c.diverge === 0 && c.coincide >= n, ultima_divergencia: c.ultima };
  }
  return { observa, estado, _compara: compara };
}
