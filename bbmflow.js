// Flujo de conversación de BBM contra el ERP (F8 pieza 7, 7a sombra + 7c modo erp, 9-oct-2026).
//
// Qué es: el pegamento entre la conversación del bot (index.js) y el cliente de la edge (bbmerp.js). Todo entra por funciones con dependencias
// inyectadas (redis, erp, relojes, enviadores): no toca el entorno ni la red por su cuenta, así se prueba con mentiras. index.js solo lo cablea.
//
// Reglas (cada una con su porqué):
//   · EL MODELO NO MANDA NADA AL PAGAR. Cuando la herramienta cotiza en erp, la última cotización BUENA de esa conversación se guarda aquí
//     (`bbmq:<tel>`, 30 min). `[PAY:x]` es solo el disparador: la reserva se hace con lo guardado, y si lo que dijo el modelo no es EXACTAMENTE el
//     total guardado no se manda enlace (un precio alucinado no llega al cobro). Producto, fechas y direcciones nunca salen del texto del modelo.
//   · EL ENLACE LO CREA EL ERP (F3 Entrega 2, camino B del owner, 12-oct-2026): edge reservas-enlace con SOLO el id de la reserva; importe, moneda,
//     external_id y caducidad los pone la base y la clave de Xendit la tiene el ERP (Ajustes › Cobros), no el bot. El modo erp NO puede crear facturas
//     (antes las creaba aquí con XENDIT_SECRET_KEY de Railway). La caducidad del enlace es la que devuelve el ERP, nunca una calculada aquí.
//   · SIN CONFIGURAR ≠ CAÍDA. 409 sin_configurar (el negocio no ha terminado de configurar el ERP: impuesto, flota, cobros…) se dice al cliente sin
//     prometer plazos ni cobro y se deriva a una persona; una caída se dice como caída.
//   · LO QUE PROMETE «EL EQUIPO TE ESCRIBE» QUEDA EN LA FICHA Y LLEGA A ALGUIEN (lección de Bots del 12-oct; revisor 12-oct): cada fallo cuyo texto lo
//     promete llama a `derivaPersona(tel, motivo, detalle)` → true si abrió una petición de persona NUEVA y avisó al equipo (una vez por petición);
//     false si ya había una abierta. Solo con false se manda además el aviso técnico (avisaEquipo): nunca dos avisos por el mismo hecho.
//   · SIN CONFIGURAR DEJA MARCA en la cotización (`{sin_configurar:true}`, 30 min): un [PAY] inventado después recibe el MISMO texto honesto, no uno
//     que promete el enlace «enseguida».
//   · NO HAY ENLACE SIN NOMBRE Y PAÍS (`cliente` va antes) NI SIN RESERVA. Cualquier fallo devuelve un texto de reserva en inglés y avisa al
//     equipo: el modelo ya escribió «te mando el enlace» cuando llega el fallo, así que el texto del fallo se añade, nunca se calla.
//   · DUPLICADOS: con un `pendingRsv` vivo, un segundo `[PAY]` reenvía ese enlace; no crea otra reserva (la `clave` cambia con cada mensaje y no protege).
//   · EL AVISO DE PAGO ES POR RESERVA, NO POR TELÉFONO: el external_id `rsv:<uuid>` no lleva teléfono, así que al crear la reserva se guarda el
//     índice `rsvtel:<uuid>` → teléfono (7 días). Sin él, el cliente que paga nunca recibiría el «reserva confirmada».
//   · SOMBRA: nunca bloquea (se lanza sin esperar), nunca llama a `entrega` (gastaría el turno de 1 consulta/s de Nominatim de las reservas
//     reales y trataría una dirección sin la frase de privacidad), nunca llama a `reserva` ni `cliente`. Cuenta coincidencias y divergencias.
//   · LA MOTO SE BUSCA POR NOMBRE EXACTO (10-oct-2026). Solo se normalizan mayúsculas y espacios. Antes valía «contiene»: «Honda Vario 160»
//     (en taller, fuera del catálogo) casaba con «Honda Vario», otro modelo con otro precio. Sin coincidencia exacta y única NO se cotiza:
//     ni la herramienta le da un precio al cliente ni la sombra compara. Una sola función (`coincidenciasExactas`) para los dos caminos.
//   · Logs sin PII: ids, importes, motivos. Nunca teléfonos, nombres, direcciones ni mensajes.

import { telefonoVerificado } from "./bbmerp.js";

export const COTIZACION_TTL_S = 30 * 60;
export const INDICE_RSV_TTL_S = 7 * 24 * 3600;
export const MARGEN_CADUCIDAD_S = 120;       // el enlace caduca antes que la reserva: pagar a las puertas de la caducidad es lo que genera pagos tardíos
export const MIN_ENLACE_S = 300;             // con menos de 5 minutos de reserva viva no se manda un enlace
const MAX_NOMBRES = 80;                      // tope de nombres del catálogo que se devuelven al modelo cuando no encuentra la moto (hoy son 21)

// Nombre de producto comparable: sin espacios a los lados, espacios seguidos (también el duro) en uno, minúsculas. NADA más: la puntuación y los
// números distinguen modelos («Honda Vario» ≠ «Honda Vario 160», «Honda PCX ABS» ≠ «Honda PCX STD», «Yamaha Nmax Turbo / ABS»).
export const normNombre = (s) => String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
// Todos los productos del catálogo que se llaman EXACTAMENTE así. Quien llama decide qué hace con 0, 1 o varios; solo 1 se puede cotizar:
// dos productos con el mismo nombre no se distinguen por el nombre, y elegir «el primero» sería cotizar una moto que quizá no es la pedida.
export function coincidenciasExactas(productos, nombre) {
  const n = normNombre(nombre);
  if (!n || !Array.isArray(productos)) return [];
  return productos.filter((x) => x && normNombre(x.nombre) === n);
}
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
  // Seguro en modo erp (13-oct-2026, E1.10; DECISIÓN POR DEFECTO pendiente del owner, opción (a) de §9.4 del encargo de carga): el ERP guarda el
  // seguro por modelo pero aún no lo cobra en la cotización (F3-E3: «cobrarlos en la cotización es la Entrega 6»). Antes, quien elegía seguro se
  // quedaba sin enlace (caso 2 del ensayo del 12-oct). Revertir: quitar esta línea (el modelo vuelve a no saber qué hacer y lo pasa al equipo).
  + "- Insurance: the customer still picks insurance OR the deposit, as in your context. Insurance is NOT in the online total either: it is paid at handover, to the team, at the rate in your context. If they pick insurance, tell them that in one short line and still send [PAY] with the get_quote total. Never add the insurance to the total.\n"
  + "- BEFORE you send the payment link you need the customer's full name AND their country, both confirmed in the chat. Put them in a [LEAD name=...; country=...] tag. No name or no country → ask for it, do not send [PAY].\n"
  + "- [PAY:AMOUNT]: AMOUNT must be EXACTLY the `total` the last get_quote returned, digits only. If the customer changes the bike, the dates or the address after that quote, call get_quote again FIRST. The server books the bike using the last quote and ONLY sends the link if your AMOUNT matches it; if anything fails the server tells the customer itself. So when you output [PAY] write only a short line like \"Perfect, sending your secure payment link now\" — never promise the link will arrive, never type a link.\n"
  + "- The link holds the bike for about an hour. After the customer pays, the system confirms the booking by itself; do not say it is confirmed before that.\n";

// Reglas de reserva de Ajustes (mínimo, máximo, antelación; F3-E3). El cliente tiene que saber la regla para elegir otras fechas: no se le dice
// «el equipo confirma el precio» (no hay precio que confirmar: el negocio no alquila esas fechas) ni se deriva a una persona. Nota interna al modelo.
export function notaReglaFechas(codigo, valor) {
  const n = Number.isInteger(valor) ? valor : null;
  const regla = codigo === "reserva_dias_min" ? (n ? `the minimum rental is ${n} days` : "the rental is shorter than the shop's minimum")
    : codigo === "reserva_dias_max" ? (n ? `the maximum rental is ${n} days` : "the rental is longer than the shop's maximum")
    : (n ? `bookings can only be made up to ${n} days in advance` : "those dates are too far ahead to book now");
  return "INTERNAL INSTRUCTION — never quote or paraphrase this note. Nothing was priced: the shop does not rent for these dates because "
    + `${regla}. Tell the customer this rule in one short sentence and ask for dates that fit it. Do NOT give a price and do NOT promise that the team will make an exception.`;
}

// ── ejecución de la herramienta ────────────────────────────────────────────────────────────────────────────────────────────────────
// Devuelve SIEMPRE un objeto (nunca lanza): un error controlado vuelve al modelo como texto para que reaccione.
// derivaPersona(tel, motivo) — opcional: deja en la ficha que una persona tiene que seguir (ver cabecera). Mejor esfuerzo, nunca rompe la herramienta.
export function createErpTools({ erp, quotes, seg = null, derivaPersona = async () => {}, log = console, project = "bot", hoy = () => new Date().toISOString().slice(0, 10) }) {
  const p = (m) => `[${project}] [bbmflow] ${m}`;
  const SIN_PRECIO = "Tell the customer you're confirming the exact price with the team and add tags: pricing_check. Do NOT give a price.";
  // El ERP dice que el negocio aún no puede cotizar ni reservar por aquí (falta configurarlo). No es una caída ni una espera corta: no se da precio,
  // no se promete plazo ni enlace, y una persona sigue la conversación (la deja marcada el servidor, no el modelo).
  const SIN_CONFIGURAR = "INTERNAL INSTRUCTION — never quote or paraphrase this note. Online booking is not available for this right now. "
    + "Tell the customer, in one or two short sentences, that a person from the team will continue with them in this chat to help with the booking. "
    + "Do NOT give any price, do NOT promise a time, a payment link or that the bike is reserved, and do NOT call get_quote again in this conversation.";
  const sinConfigurar = async (tel, r) => {
    const paso = r && r.paso ? r.paso : null;
    log.warn(p(`get_quote erp: sin configurar${paso ? ` (paso ${paso})` : ""}: se deriva a una persona`));
    try { await quotes.guarda(tel, { sin_configurar: true, paso }); } catch { /* sin marca, un [PAY] inventado da sin_cotizacion */ }
    try { await derivaPersona(tel, "sin_configurar", paso ? `falta configurar «${paso}» en el ERP` : "falta configurar el ERP"); } catch { /* mejor esfuerzo */ }
    return { ok: false, error: "booking_not_available", note: SIN_CONFIGURAR };
  };

  // Lo que se le devuelve al modelo cuando el nombre no existe tal cual: NINGÚN precio, y la lista de lo que sí se puede reservar (en modo erp el
  // modelo no tiene otra lista de nombres). La nota va marcada como interna: el modelo ha llegado a recitar notas de un tool_result al cliente.
  const NOTA_SIN_NOMBRE = "INTERNAL INSTRUCTION — never quote, paraphrase or explain any part of this note to the customer. "
    + "Nothing was priced. bookable_models is the complete list of bikes that can be booked right now; each one is a DIFFERENT bike with its own price. "
    + "Only if a name on the list is the SAME bike the customer asked for (same brand, same model AND same engine size or version) call get_quote again "
    + "with that name copied character by character. A similar name with a different number or version (\"Vario\" vs \"Vario 160\", \"ABS\" vs \"STD\") "
    + "is a different bike: in that case the bike the customer asked for cannot be booked right now — say so and offer models from the list. "
    + "Never give the price of one model for another.";

  async function runGetQuote(tel, { bike_model, from, to, delivery_address, self_return } = {}) {
    try {
      if (!str(bike_model) || !str(from) || !str(to) || !FECHA.test(from) || !FECHA.test(to)) return { ok: false, error: "Missing or malformed bike_model, from or to (dates must be YYYY-MM-DD)." };
      if (!(to > from)) return { ok: false, error: "The return date must be after the start date." };
      if (from < hoy()) return { ok: false, error: "The start date is in the past. Ask the customer for the real dates." };
      const cat = await erp.catalogo();
      if (!cat.ok && cat.motivo === "sin_configurar") return await sinConfigurar(tel, cat);
      if (!cat.ok) return { ok: false, error: `The booking system is unreachable right now. ${SIN_PRECIO}` };
      const iguales = coincidenciasExactas(cat.productos, bike_model);
      if (iguales.length > 1) {
        // Dato mal en el catálogo del ERP (dos productos con el mismo nombre): no es elección del cliente, lo arregla el equipo.
        log.error(p(`get_quote erp: ${iguales.length} productos del catálogo se llaman igual; no se cotiza ninguno`));
        return { ok: false, error: `The booking system has more than one bike under that name. ${SIN_PRECIO}` };
      }
      const hit = iguales[0];
      if (!hit) {
        return {
          ok: false, error: `No bike is named exactly "${bike_model.trim().slice(0, 60)}" in the booking system.`,
          bookable_models: cat.productos.map((x) => x.nombre).slice(0, MAX_NOMBRES), note: NOTA_SIN_NOMBRE,
        };
      }

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
        if (c.motivo === "sin_configurar") return await sinConfigurar(tel, c);
        if (c.motivo === "regla_fechas") { await quotes.borra(tel); return { ok: false, error: "dates_not_allowed", note: notaReglaFechas(c.codigo, c.valor) }; }
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
  // El ERP dice que el negocio aún no puede cobrar por aquí (Cobros u otro paso sin configurar). Sin plazos, sin «reservada», sin enlace.
  sin_configurar: "Online payment isn't available for this booking yet. A person from our team will continue with you here in this chat to complete it.",
  generico: "I couldn't generate your payment link just now. I've flagged it to the team and they'll send it to you shortly.",
};
// Los mismos textos en indonesio y español (13-oct-2026, E1.10): hasta hoy salían solo en inglés también a quien escribe en indonesio.
// Idioma = el de `idiomaAviso` (aviso-ia.js) sobre el mensaje del cliente y la respuesta del modelo; otro idioma o la duda, inglés.
// PENDIENTE DE APROBAR por el orquestador antes de desplegar, como el aviso de IA de BBM-50 (los textos al cliente los aprueba él).
const TEXTO_FALLO_ID = {
  sin_cotizacion: "Saya perlu mengecek ulang harga untuk tanggal Anda sebelum mengirim link pembayaran — sebentar, saya tanyakan ke tim kami.",
  importe_no_cuadra: "Saya ingin memastikan harga akhirnya dengan tim kami sebelum mengirim link pembayaran — mereka akan segera menghubungi Anda.",
  faltan_datos: "Sebelum saya kirim link pembayaran, saya perlu nama lengkap dan negara asal Anda.",
  sin_disponibilidad: "Maaf — motor itu baru saja dipesan untuk tanggal tersebut. Mau saya cek tanggal lain atau model lain?",
  precio_cambio: "Harganya baru saja diperbarui, jadi saya konfirmasi dulu total akhirnya dengan tim sebelum mengirim link.",
  tope: "Saat ini kami sedang menerima banyak pemesanan. Tim kami akan mengirim link pembayaran langsung kepada Anda dalam beberapa menit.",
  sin_tiempo: "Waktu penahanan pesanan Anda hampir habis. Saya minta tim untuk memperbaruinya — mereka akan segera menghubungi Anda.",
  en_curso: "Saya sedang menyiapkan link pembayaran Anda — sebentar lagi akan sampai.",
  sin_configurar: "Pembayaran online belum tersedia untuk pemesanan ini. Staf kami akan melanjutkan dengan Anda di chat ini untuk menyelesaikannya.",
  generico: "Saya belum bisa membuat link pembayaran Anda sekarang. Sudah saya teruskan ke tim, dan mereka akan segera mengirimkannya.",
};
const TEXTO_FALLO_ES = {
  sin_cotizacion: "Tengo que volver a comprobar el precio para tus fechas antes de enviarte el enlace de pago; un momento, se lo pregunto al equipo.",
  importe_no_cuadra: "Quiero confirmar el precio final con el equipo antes de enviarte el enlace de pago; te escribirán en breve.",
  faltan_datos: "Antes de enviarte el enlace de pago necesito tu nombre completo y tu país.",
  sin_disponibilidad: "Lo siento, esa moto se acaba de reservar para esas fechas. ¿Miro otras fechas u otro modelo?",
  precio_cambio: "El precio se acaba de actualizar, así que confirmo el total final con el equipo antes de enviarte el enlace.",
  tope: "Ahora mismo estamos recibiendo muchas reservas. El equipo te enviará el enlace de pago personalmente en unos minutos.",
  sin_tiempo: "Tu reserva provisional está a punto de caducar. Le pido al equipo que la renueve; te escribirán en breve.",
  en_curso: "Ya estoy preparando tu enlace de pago; te llega en un momento.",
  sin_configurar: "El pago en línea todavía no está disponible para esta reserva. Una persona del equipo seguirá contigo en este chat para completarla.",
  generico: "No he podido generar tu enlace de pago ahora mismo. Ya se lo he pasado al equipo y te lo enviarán en breve.",
};
export const TEXTOS_FALLO = { en: TEXTO_FALLO, id: TEXTO_FALLO_ID, es: TEXTO_FALLO_ES };
const idiomaValido = (x) => (x === "id" || x === "es" ? x : "en");
export const textoFallo = (clave, idioma) => TEXTOS_FALLO[idiomaValido(idioma)][clave] || TEXTO_FALLO[clave];
const MOTIVO_A_TEXTO = {
  sin_disponibilidad: "sin_disponibilidad", tope_global: "tope", tope_telefono: "tope", sin_configurar: "sin_configurar",
};
// Fallos cuyo texto NO promete que el equipo escriba: no dejan petición de persona en la ficha.
//   faltan_datos: se le pide al cliente · sin_disponibilidad: se le ofrecen otras fechas · en_curso: el enlace de ESTA misma petición está saliendo.
const SIN_PROMESA = new Set(["faltan_datos", "sin_disponibilidad", "en_curso"]);

// deps: erp (con `enlace`, reservas-enlace), quotes, pendingRsv, indice, backend (createBackendSwitch), avisaEquipo(texto) (mejor esfuerzo),
//       derivaPersona(tel, motivo) (mejor esfuerzo: deja la petición de persona en la ficha), now, log, project
export function createCierreErp({ erp, quotes, pendingRsv, indice, backend, avisaEquipo = async () => {}, derivaPersona = async () => {}, now = () => Date.now(), log = console, project = "bot" }) {
  const p = (m) => `[${project}] [bbmflow] ${m}`;
  // `t` = teléfono verificado del cierre (null si no lo hay: entonces no hay ficha que marcar).
  const fallo = async (t, motivo, extra, idioma) => {
    const clave = TEXTO_FALLO[motivo] ? motivo : "generico";
    if (!SIN_PROMESA.has(clave)) {
      let avisado = false;
      if (t) { try { avisado = (await derivaPersona(t, motivo, extra)) === true; } catch { /* mejor esfuerzo */ } }
      if (!avisado) { try { await avisaEquipo(`⚠️ [${project}] reserva ERP no completada: ${motivo}${extra ? ` (${extra})` : ""}. El cliente está en «por responder» del panel.`); } catch { /* mejor esfuerzo */ } }
    }
    return { ok: false, motivo, texto: textoFallo(clave, idioma) };
  };

  // Un solo cierre a la vez por teléfono: dos [PAY] casi simultáneos (el handler no serializa por chat) reservarían dos veces. Un solo proceso: basta memoria.
  const enCurso = new Set();
  async function cierra(args) {
    const t = telefonoVerificado(args.tel);
    if (!t) return fallo(null, "generico", "telefono", args.idioma);
    if (enCurso.has(t)) return { ok: false, motivo: "en_curso", texto: textoFallo("en_curso", args.idioma) };
    enCurso.add(t);
    try { return await cierraUno({ ...args, tel: t }); } finally { enCurso.delete(t); }
  }

  async function cierraUno({ tel, mensajeId, payAmount, nombre, pais, idioma }) {
    const t = tel;
    const ko = (motivo, extra) => fallo(t, motivo, extra, idioma);

    // 1) Un enlace vivo se reenvía; no se crea otra reserva
    const pend = await pendingRsv.lee(t);
    if (pend) {
      if (pend.url) { log.warn(p("[PAY] con un enlace rsv vivo: se reenvía el mismo")); return { ok: true, url: pend.url, reutilizado: true, importe: pend.importe, moneda: pend.moneda }; }
      return ko("generico", "enlace_sin_url");
    }

    // 2) Lo guardado manda; lo del modelo solo se compara
    const q = await quotes.lee(t);
    if (!q) return ko("sin_cotizacion");
    if (q.sin_configurar === true) return ko("sin_configurar", q.paso ? `paso ${q.paso}` : undefined);   // el ERP ya dijo que no: mismo texto honesto
    if (!Number.isInteger(payAmount) || payAmount !== q.total) { log.warn(p(`[PAY] no cuadra con la cotización guardada (modelo=${payAmount} guardada=${q.total})`)); return ko("importe_no_cuadra"); }

    // 3) Nombre y país, antes que nada
    if (!str(nombre) || nombre.trim().length < 2 || !str(pais) || pais.trim().length < 2) return ko("faltan_datos");

    // 4) Reserva. El backend se fija ANTES: desde aquí la conversación es del ERP aunque el interruptor cambie.
    try { await backend.fija(t, COTIZACION_TTL_S, "erp"); } catch { /* el enlace vivo (pendingRsv) también ata la conversación */ }
    // Una reserva ya creada para ESTA cotización (un intento anterior falló en `cliente` o en el enlace) se reutiliza mientras le quede tiempo: reservar otra
    // retendría una segunda unidad (o negaría la moto si solo hay una). No se confía en que la base la devuelva sola: con `clave` por mensaje no lo hace.
    let rs = null, reutilizada = false;
    if (q.reserva) {
      const quedan = q.reserva.cobro.segundos_hasta_caducar - Math.floor((now() - q.reserva.creada_ms) / 1000);
      if (quedan - MARGEN_CADUCIDAD_S >= MIN_ENLACE_S) { rs = { ...q.reserva, cobro: { ...q.reserva.cobro, segundos_hasta_caducar: quedan } }; reutilizada = true; }
      else { delete q.reserva; await quotes.guarda(t, q); }
    }
    if (!rs) {
      const r = await erp.reserva({
        fromVerificado: t, producto_id: q.producto_id, desde: q.desde, hasta: q.hasta,
        entrega_direccion: q.entrega_direccion ?? undefined, recogida_direccion: q.recogida_direccion ?? undefined,
        mensajeId, conversacion_ref: t,
      });
      if (!r.ok) {
        if (r.motivo === "entrega_a_confirmar" || r.motivo === "entrega_no_configurada") return ko("generico", r.motivo);
        // sin_configurar: la base aborta ENTERA (no deja bloqueo). La cotización se cambia por la marca: el siguiente [PAY] no reintenta a ciegas.
        if (r.motivo === "sin_configurar") { try { await quotes.guarda(t, { sin_configurar: true, paso: r.paso || null }); } catch { /* */ } return ko("sin_configurar", r.paso ? `paso ${r.paso}` : undefined); }
        return ko(MOTIVO_A_TEXTO[r.motivo] || "generico", r.motivo);
      }
      rs = r.reserva;
      if (rs.repetida === true) reutilizada = true;   // la base devolvió una reserva que ya existía: puede que `cliente` ya saliera (Redis falló al apuntarlo)
      if (rs.precio_total !== q.total || rs.moneda !== q.moneda) { await quotes.borra(t); return ko("precio_cambio", `cotizado=${q.total} reserva=${rs.precio_total}`); }
      q.reserva = { ...rs, creada_ms: now() };
      try { await quotes.guarda(t, q); } catch { /* sin guardar, un reintento reservaría otra: la base la devuelve si no hay `clave` por mensaje */ }
    }

    // 5) Cliente (nombre y país) ANTES del enlace, UNA vez por reserva. La base da 409 no_aplica a un segundo `cliente` (ya tiene cliente o ya no está
    //    en bloqueo): por eso se apunta en la cotización que ya salió, y si aun así llega no_aplica sobre una reserva reutilizada se sigue — el enlace
    //    decide (no_pagable si ya no está en bloqueo). Antes el reintento tras un enlace fallido moría aquí.
    if (!rs.cliente_ok) {
      const c = await erp.cliente({ reserva_id: rs.reserva_id, nombre, pais });
      if (!c.ok && !(c.codigo === "no_aplica" && reutilizada)) return ko("generico", `cliente:${c.motivo}`);
      if (c.ok && !c.cliente_identificado) log.warn(p(`cliente no identificado (${c.motivo || "?"}): lo decide una persona; el cobro sigue`));
      if (q.reserva) { q.reserva.cliente_ok = true; try { await quotes.guarda(t, q); } catch { /* sin guardar, el reintento tropezará con no_aplica y seguirá igual */ } }
    }

    // 6) Enlace de pago: lo crea el ERP (reservas-enlace) con el cobro de la base. Ni importe ni caducidad salen de aquí.
    const inv = await erp.enlace({ reserva_id: rs.reserva_id, external_id: rs.cobro.external_id });
    if (!inv.ok) {
      if (inv.motivo === "sin_configurar") return ko("sin_configurar", inv.paso ? `paso ${inv.paso}` : undefined);   // la reserva queda en bloqueo y caduca sola
      // no_pagable: ya no es un bloqueo vivo del bot, le quedan < 5 min **o el total en IDR lleva decimales** (impuesto sumado; Xendit no los cobra).
      // La edge no dice cuál: el texto «tu reserva va a caducar» mentiría en el caso de los decimales, así que va el genérico (13-oct-2026, E1.10).
      if (inv.motivo === "no_pagable") { await quotes.borra(t); return ko("generico", "no_pagable"); }
      return ko("generico", `enlace:${inv.motivo}`);   // proveedor, en_curso tras reintentar, caída: el siguiente [PAY] reutiliza la reserva y vuelve a pedirlo
    }

    // 7) Registro: enlace pendiente + índice para avisar del pago. Si falla, el enlace sigue siendo válido: se manda igual.
    try { await pendingRsv.guarda(t, { external_id: rs.cobro.external_id, importe: rs.cobro.importe, moneda: rs.cobro.moneda, reserva_id: rs.reserva_id, caduca_en_ms: inv.caduca_ms, url: inv.url, idioma }); }
    catch (e) { log.error(p("no se pudo guardar el enlace pendiente (el enlace se manda igual)")); }
    try { await indice.guarda(rs.reserva_id, t); }
    catch (e) { log.error(p("no se pudo guardar el índice reserva→teléfono: el aviso de pago irá a la ficha del equipo")); try { await avisaEquipo(`⚠️ [${project}] sin índice reserva→teléfono para ${rs.reserva_id}: avisar a mano del pago`); } catch { /* */ } }
    await quotes.borra(t);
    return { ok: true, url: inv.url, importe: rs.cobro.importe, moneda: rs.cobro.moneda, reservaId: rs.reserva_id, numeroReserva: rs.numero_reserva, reutilizado: inv.repetido === true };
  }
  return { cierra };
}

// ── aviso al cliente cuando paga ───────────────────────────────────────────────────────────────────────────────────────────────────
// `cuerpo` es lo que contestó la edge reservas-pago: {ok,factura:{numero,total,moneda}} | {ok,factura_espera} | {revisar:true} | {ignorado} | null.
// `idioma` = el que se guardó con el enlace (pendingRsv, cierre): «en» | «id» | «es»; otro valor, inglés. Textos id/es PENDIENTES DE APROBAR (ver TEXTOS_FALLO).
const TEXTO_PAGO = {
  en: { revisar: (c) => `✅ Payment received${c}. Thank you! Our team is checking your booking and will message you shortly to confirm it.`,
        num: (n) => ` Your invoice number is ${n}.`, sinNum: " Your invoice is on its way.",
        ok: (c, fac) => `✅ Payment received${c}. Thank you! Your booking is confirmed.${fac} Our team will be in touch about the handover.` },
  id: { revisar: (c) => `✅ Pembayaran diterima${c}. Terima kasih! Tim kami sedang memeriksa pemesanan Anda dan akan segera menghubungi Anda untuk mengonfirmasinya.`,
        num: (n) => ` Nomor invoice Anda: ${n}.`, sinNum: " Invoice Anda sedang kami siapkan.",
        ok: (c, fac) => `✅ Pembayaran diterima${c}. Terima kasih! Pemesanan Anda sudah terkonfirmasi.${fac} Tim kami akan menghubungi Anda untuk serah terima motor.` },
  es: { revisar: (c) => `✅ Pago recibido${c}. ¡Gracias! El equipo está revisando tu reserva y te escribirá en breve para confirmarla.`,
        num: (n) => ` Tu número de factura es ${n}.`, sinNum: " Tu factura está en camino.",
        ok: (c, fac) => `✅ Pago recibido${c}. ¡Gracias! Tu reserva está confirmada.${fac} El equipo te escribirá para la entrega de la moto.` },
};
export function textoPagoRecibido(cuerpo, { importe, moneda, idioma } = {}) {
  const T = TEXTO_PAGO[idioma === "id" || idioma === "es" ? idioma : "en"];
  const cant = Number.isFinite(importe) ? ` — ${Math.round(importe).toLocaleString("id-ID")} ${moneda || "IDR"}` : "";
  if (cuerpo && cuerpo.revisar === true) return T.revisar(cant);
  const f = cuerpo && typeof cuerpo.factura === "object" && cuerpo.factura ? cuerpo.factura : null;
  const fac = f && str(f.numero) && /^[A-Za-z0-9._\/-]{1,40}$/.test(f.numero) ? T.num(f.numero) : T.sinNum;
  return T.ok(cant, fac);
}

// Quien cuelga de la puerta del webhook: busca el teléfono por el índice, avisa una sola vez por factura y limpia el estado de la conversación.
// deps: indice, pendingRsv, backend, dedupe(invoiceId) → true si es la primera vez, enviaCliente(tel, texto) → {ok}, marcaPagado(tel, importe, moneda),
//       avisaEquipo(texto), derivaPersona(tel, motivo)
// AL CLIENTE SOLO CON `ok === true` (consulta de Seguridad del 12-oct, F3 E2 Cobros: desde entonces la puerta reenvía avisos `rsv:` sin el token de
// Railway, y reservas-pago contesta 200 también a ignorados y a «revisar»). Un pago «a revisar» (no encaja con la reserva) va al equipo y deja la
// petición de persona en la ficha: una persona se lo confirma al cliente. Antes el bot le decía «Payment received… our team is checking».
export function createAvisoPago({ indice, pendingRsv, backend, dedupe, enviaCliente, marcaPagado = async () => {}, avisaEquipo = async () => {}, derivaPersona = async () => {}, log = console, project = "bot" }) {
  const p = (m) => `[${project}] [bbmflow] ${m}`;
  return async function onResultado({ externalId, invoiceId, cuerpo }) {
    if (!cuerpo || cuerpo.ignorado === true) return { avisado: false, motivo: "ignorado" };
    if (cuerpo.ok !== true) {
      if (cuerpo.revisar !== true) return { avisado: false, motivo: "sin_ok" };
      if (dedupe && !(await dedupe(invoiceId))) return { avisado: false, motivo: "repetido" };
      const telR = await indice.teleDeExternalId(externalId);
      const texto = `💰 Pago de reserva ERP A REVISAR (no encaja con la reserva ${String(externalId).slice(4, 12)}…). NO se ha avisado al cliente: confirmárselo a mano`;
      let avisado = false;
      if (telR) {
        // pagado: ni el enlace pendiente ni el pin a erp siguen vivos (un [PAY] o [RESEND_LINK] reenviaría el enlace de una factura ya pagada)
        try { await pendingRsv.borra(telR); } catch { /* */ }
        try { await backend.suelta(telR); } catch { /* */ }
        try { avisado = (await derivaPersona(telR, "pago_a_revisar", texto)) === true; } catch { /* */ }
      }
      if (!avisado) { try { await avisaEquipo(`[${project}] ${texto}${telR ? " (está en «por responder» del panel)" : "; no sé a qué chat"}.`); } catch { /* */ } }
      return { avisado: false, motivo: "revisar" };
    }
    // Deduplicar ANTES de buscar el chat: un reintento de Xendit de un pago sin índice no repite el aviso al equipo.
    if (dedupe && !(await dedupe(invoiceId))) return { avisado: false, motivo: "repetido" };
    const tel = await indice.teleDeExternalId(externalId);
    if (!tel) {
      log.error(p("pago de una reserva sin teléfono en el índice: aviso a mano"));
      try { await avisaEquipo(`⚠️ [${project}] Pago recibido de la reserva ${String(externalId).slice(0, 44)} pero no sé a qué chat avisar. Comprobar en el ERP.`); } catch { /* */ }
      return { avisado: false, motivo: "sin_telefono" };
    }
    const pend = await pendingRsv.lee(tel);
    const importe = pend ? pend.importe : undefined, moneda = pend ? pend.moneda : undefined, idioma = pend ? pend.idioma : undefined;
    const r = await enviaCliente(tel, textoPagoRecibido(cuerpo, { importe, moneda, idioma }));
    if (!(r && r.ok)) { log.error(p("no se pudo avisar del pago al cliente")); try { await avisaEquipo(`⚠️ [${project}] Pago recibido pero NO se pudo avisar al cliente por WhatsApp (reserva ${String(externalId).slice(4, 12)}…). Avisarle a mano.`); } catch { /* */ } }
    try { await marcaPagado(tel, importe, moneda); } catch { /* mejor esfuerzo */ }
    try { await pendingRsv.borra(tel); } catch { /* */ }
    try { await backend.suelta(tel); } catch { /* */ }
    try { await avisaEquipo(`💰 [${project}] Pago de reserva ERP${importe ? `: ${Math.round(importe).toLocaleString("id-ID")} ${moneda || ""}` : ""}`); } catch { /* */ }
    return { avisado: !!(r && r.ok), motivo: "ok" };
  };
}

// ── 7a SOMBRA ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Compara, SIN mostrar nada al cliente, lo que Dion cotizó (resultado de runGetQuote de Dion) con lo que cotiza el ERP para la misma moto y fechas.
// Solo `catalogo` y `cotiza` y SIN dirección: nada de `entrega` (ver cabecera), nada de `reserva`/`cliente`.
// Contadores en Redis (`bbm:sombra`, hash), sin PII, para /admin/api/health. DOS juegos en el mismo hash:
//   · LOS DE SIEMPRE (`coincide`, `diverge`, `sin_erp`, `ultima`): una cuenta por COTIZACIÓN de Dion. `diverge` = la cotización tuvo al menos una
//     diferencia, de la clase que sea. De ellos, y solo de ellos, sale `listo`. Ni su cuenta ni la fórmula han cambiado.
//   · POR TIPO (10-oct-2026): la misma cotización se apunta además en cada cosa que se comparó. Existen para poder ver si el PRECIO coincide aunque
//     el inventario no: 30 de los 51 modelos no tienen moto libre en el ERP y Dion tiene reservas que el ERP no ve, así que con un solo contador
//     una moto en taller y un precio distinto eran el mismo número. Los contadores por tipo NO deciden `listo`: qué debe contar lo decide el owner.
//       precio_ok / precio_dif / precio_sin_dato   alquiler del ERP contra el de Dion (sin_dato: el ERP cotizó sin `precio_alquiler` o Dion sin importe;
//                                                  esa cotización NO es una coincidencia de precio aunque el agregado la cuente como «coincide»)
//       dias_ok / dias_dif / dias_sin_dato         días que cuenta cada uno
//       disp_ok / disp_dif                         el ERP tiene, o no, una unidad libre de ESA moto en esas fechas
//       sin_equivalente                            ningún producto del catálogo del ERP se llama exactamente igual (o hay más de uno): no se compara nada
//       sin_erp_m:<motivo>                         el ERP no dio respuesta que comparar, por motivo (los de bbmerp.js)
//     y la última de cada clase (`ultima_precio`, `ultima_dias`, `ultima_disp`, `ultima_sin_equivalente`, `ultima_sin_erp`): con un solo `ultima`
//     las de inventario, que son muchas, tapan la de precio en minutos.
// Cuentas que cuadran siempre: coincide + diverge + sin_erp = cotizaciones vistas; precio_ok + precio_dif + precio_sin_dato = coincide + diverge − sin_equivalente.
const SOMBRA_CLAVE = "bbm:sombra";
const SOMBRA_MOTIVO = "sin_erp_m:";
const SOMBRA_CONTADORES = ["coincide", "diverge", "sin_erp", "precio_ok", "precio_dif", "precio_sin_dato", "dias_ok", "dias_dif", "dias_sin_dato", "disp_ok", "disp_dif", "sin_equivalente"];
const SOMBRA_ULTIMAS = ["ultima", "ultima_precio", "ultima_dias", "ultima_disp", "ultima_sin_equivalente", "ultima_sin_erp"];
const CODIGO_OK = /^[A-Za-z0-9_]{1,40}$/;   // motivos y códigos vienen de bbmerp.js o del campo `error` de la edge: solo se guardan si son un código, nunca un texto

export function createSombra({ erp, redis = () => null, n = 30, log = console, project = "bot", now = () => Date.now() }) {
  const p = (m) => `[${project}] [bbm-sombra] ${m}`;
  const mem = { n: {}, ultimas: {} };   // misma forma que el hash: contador → número, ultima_* → objeto

  // Qué salió de comparar UNA cotización de Dion con la del ERP, cosa por cosa.
  function clasifica(dion, q) {
    // OJO: el total del ERP lleva impuesto, seguro y entrega; el de Dion no. Se compara lo comparable: el alquiler.
    const precio = q.precio_alquiler != null && Number.isFinite(Number(dion.rental_rate))
      ? (Math.round(q.precio_alquiler) !== Math.round(Number(dion.rental_rate)) ? "dif" : "ok") : "sin_dato";
    const dias = Number.isInteger(dion.duration_days) ? (q.dias !== dion.duration_days ? "dif" : "ok") : "sin_dato";
    const disp = q.disponibles < 1 ? "dif" : "ok";
    return { precio, dias, disp };
  }
  // Los motivos del agregado de siempre, en su orden de siempre.
  function compara(dion, q) {
    const c = clasifica(dion, q);
    const motivos = [];
    if (c.precio === "dif") motivos.push("precio");
    if (c.dias === "dif") motivos.push("dias");
    if (c.disp === "dif") motivos.push("disponibilidad");
    return motivos;
  }

  // Suma 1 a cada contador y guarda las «últimas». Con Redis va en UNA transacción: un corte a medias no puede dejar el agregado y los
  // contadores por tipo contando cotizaciones distintas.
  async function apunta(contadores, ultimas = {}) {
    const en = now();
    const sellos = Object.entries(ultimas).map(([campo, v]) => [campo, { ...v, en }]);
    for (const c of contadores) mem.n[c] = (mem.n[c] || 0) + 1;
    for (const [campo, v] of sellos) mem.ultimas[campo] = v;
    const r = redis();
    if (!r) return;
    try {
      const tx = typeof r.multi === "function" ? r.multi() : null;
      const destino = tx || r;
      const pendientes = [];
      for (const c of contadores) pendientes.push(destino.hIncrBy(SOMBRA_CLAVE, c, 1));
      for (const [campo, v] of sellos) pendientes.push(destino.hSet(SOMBRA_CLAVE, campo, JSON.stringify(v)));
      if (tx) await tx.exec(); else await Promise.all(pendientes);
    } catch { /* mejor esfuerzo */ }
  }

  // El ERP no dio nada que comparar. `accion` = dónde se quedó; `r` = la respuesta KO de bbmerp.js.
  async function sinRespuesta(accion, r) {
    const motivo = r && CODIGO_OK.test(String(r.motivo)) ? r.motivo : "otro";
    const codigo = r ? (r.codigo ?? r.detalle) : null;
    // `paso` (solo con sin_configurar: impuesto_pkp, flota, cobros…) va en su campo, con su regla; CODIGO_OK no se amplía.
    const paso = r && typeof r.paso === "string" && /^[a-z_]{1,40}$/.test(r.paso) ? r.paso : null;
    const detalle = { accion, motivo, ...(typeof codigo === "string" && CODIGO_OK.test(codigo) ? { codigo } : {}), ...(paso ? { paso } : {}) };
    // `ultima` (la del agregado) se escribe como siempre: «catalogo» si falló el catálogo, el motivo si falló la cotización.
    await apunta(["sin_erp", SOMBRA_MOTIVO + motivo], { ultima: { motivo: accion === "catalogo" ? "catalogo" : r.motivo }, ultima_sin_erp: detalle });
  }

  // dion = { ok, bike, from, to, duration_days, rental_rate } de la herramienta de Dion. NUNCA lanza, NUNCA se espera en el camino del cliente.
  async function observa(dion) {
    try {
      if (!erp.enabled || !dion || dion.ok !== true || !dion.from || !dion.to || !dion.bike) return;
      const moto = String(dion.bike).slice(0, 40);
      const cat = await erp.catalogo();
      if (!cat.ok) { await sinRespuesta("catalogo", cat); return; }
      // Nombre EXACTO (ver cabecera). `dion.bike` es el nombre del producto en el sistema de Dion y el catálogo del ERP se copió de él letra por letra.
      const iguales = coincidenciasExactas(cat.productos, dion.bike);
      if (iguales.length !== 1) {
        const u = { motivos: [iguales.length ? "nombre_duplicado" : "moto_sin_equivalente"], moto };
        await apunta(["diverge", "sin_equivalente"], { ultima: u, ultima_sin_equivalente: u });
        return;
      }
      const c = await erp.cotiza({ producto_id: iguales[0].id, desde: dion.from, hasta: dion.to });
      if (!c.ok) { await sinRespuesta("cotiza", c); return; }
      const q = c.cotizacion;
      const t = clasifica(dion, q);
      const m = compara(dion, q);
      const u = { moto, desde: dion.from, hasta: dion.to, dion: Math.round(Number(dion.rental_rate)), erp: Math.round(q.precio_alquiler ?? NaN), dias_dion: dion.duration_days, dias_erp: q.dias };
      await apunta(
        [m.length ? "diverge" : "coincide", `precio_${t.precio}`, `dias_${t.dias}`, `disp_${t.disp}`],
        {
          ...(m.length ? { ultima: { motivos: m, ...u } } : {}),
          ...(t.precio === "dif" ? { ultima_precio: u } : {}),
          ...(t.dias === "dif" ? { ultima_dias: u } : {}),
          ...(t.disp === "dif" ? { ultima_disp: { moto, desde: dion.from, hasta: dion.to, disponibles: q.disponibles } } : {}),
        },
      );
      if (m.length) log.warn(p(`divergencia: ${m.join(",")}`));
    } catch { /* la sombra jamás rompe una conversación */ }
  }

  async function estado() {
    let num = { ...mem.n }, ult = { ...mem.ultimas };
    const r = redis();
    if (r) {
      try {
        const h = await r.hGetAll(SOMBRA_CLAVE);
        // Campo a campo: un hash de antes de los contadores por tipo solo trae los cuatro de siempre (el resto sale a 0), y una `ultima_*` ilegible
        // no puede tirar la lectura entera a la memoria de este proceso.
        num = {}; ult = {};
        for (const [campo, v] of Object.entries(h || {})) {
          if (SOMBRA_ULTIMAS.includes(campo)) { try { ult[campo] = JSON.parse(v); } catch { ult[campo] = null; } }
          else if (SOMBRA_CONTADORES.includes(campo) || campo.startsWith(SOMBRA_MOTIVO)) num[campo] = Number(v) || 0;
        }
      } catch { /* RAM */ }
    }
    const c = (campo) => num[campo] || 0;
    const u = (campo) => ult[campo] ?? null;
    const porMotivo = Object.fromEntries(Object.keys(num).filter((k) => k.startsWith(SOMBRA_MOTIVO)).sort().map((k) => [k.slice(SOMBRA_MOTIVO.length), num[k]]));
    return {
      n_objetivo: n, coincide: c("coincide"), diverge: c("diverge"), sin_erp: c("sin_erp"),
      // Criterio del owner (9-oct): N cotizaciones reales SIN divergencia. Una divergencia reinicia la cuenta (quien la ve decide si se arregla y se resetea).
      // NO mira los contadores por tipo de abajo: son para leer, y cambiar qué cuenta para «listo» es decisión del owner.
      listo: c("diverge") === 0 && c("coincide") >= n,
      ultima_divergencia: u("ultima"),
      precio: { coincide: c("precio_ok"), diverge: c("precio_dif"), sin_dato: c("precio_sin_dato"), ultima_divergencia: u("ultima_precio") },
      dias: { coincide: c("dias_ok"), diverge: c("dias_dif"), sin_dato: c("dias_sin_dato"), ultima_divergencia: u("ultima_dias") },
      disponibilidad: { coincide: c("disp_ok"), diverge: c("disp_dif"), sin_equivalente: c("sin_equivalente"), ultima_divergencia: u("ultima_disp"), ultima_sin_equivalente: u("ultima_sin_equivalente") },
      erp_sin_respuesta: { total: c("sin_erp"), por_motivo: porMotivo, ultima: u("ultima_sin_erp") },
    };
  }
  return { observa, estado, _compara: compara };
}
