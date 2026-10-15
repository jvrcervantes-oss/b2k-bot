// Cliente del bot de BBM contra el ERP (F8 pieza 7, parte segura, 9-oct-2026). Habla con la edge `reservas-bot` del ERP: catálogo, entrega
// (km), cotización, reserva y cliente; y con la edge `reservas-enlace` (F3 Entrega 2, 12-oct): el enlace de pago de la reserva, que crea el ERP.
// Desde B10 (14-oct-2026) también el interruptor «quién atiende las reservas» (acción `estado`), que vive en el ERP: ver createBackendSwitch.
// Con BBM_ERP_URL/BBM_RESERVAS_SECRET ausentes el módulo no hace nada y el bot se comporta EXACTAMENTE como antes.
//
// Todo entra por createBbmErp(opciones): no toca el entorno ni la red por su cuenta, así se prueba con un fetch de mentira. Patrón de
// botcat.js de la rama lawang (caché con último bueno, fail-closed), pero hablando con reservas-bot, NO con la edge bot-api de Lawang.
//
// Reglas (cada una con su porqué):
//   · FAIL-CLOSED. Error, tiempo agotado, secreto rechazado, módulo apagado o una respuesta que no cumple el contrato
//     (bbmerp.contract.json) ⇒ {ok:false, motivo}. El bot nunca inventa un precio ni manda un enlace de pago con lo que no entiende.
//   · EL BOT NO MANDA IMPORTES NI KM. Cada acción construye su cuerpo con una lista cerrada de campos; el precio, la moto, el km y el
//     cliente los pone la base. La edge rechaza cualquier campo de más, y aquí ni siquiera se puede escribir.
//   · `contacto_telefono` es SIEMPRE el `from` verificado del webhook de Meta (parámetro `fromVerificado`), nunca texto del chat ni un
//     argumento del modelo. Este módulo NO se expone al modelo como herramienta: lo llama código del bot.
//   · El secreto es BBM_RESERVAS_SECRET, propio de esta edge (NO BOT_ERP_SECRET, que hoy comparten crm-bot y reservas-bot: separarlo es una
//     decisión pendiente del owner). Nunca se loguea.
//   · `cobro.importe` es el entero que cobra Xendit = `precio_total`: CON la comisión de pago en línea cuando el ERP la cobra (es una línea más
//     de la reserva, 20261014010000; nunca la suma el bot) y SIN el depósito (el depósito se paga en la entrega; el bot lo muestra aparte). Si no es un entero positivo igual a `precio_total`, la reserva se trata como respuesta inválida.
//   · Idempotencia de `reserva`: los webhooks de Meta se reentregan. La clave sale del id del mensaje de WhatsApp (hash corto, porque el
//     wamid lleva `=` y `/` y la base solo admite [A-Za-z0-9@:._+-]). Si la respuesta se pierde se reintenta UNA vez con la misma clave.
//     La edge reservas-bot admite `clave` desde c241a65f (9-oct-2026; comprobado contra main el 13-oct). Se manda solo con enviaClave=true, que index.js
//     lee de BBM_ERP_CLAVE=1 (el guion del corte lo comprueba). Sin ella la base deduplica por teléfono + moto + fechas (md5) mientras la reserva siga en bloqueo.
//   · Logs sin PII: acción, resultado, ids, importes. Nunca teléfonos, nombres, direcciones, mensajes de la base ni el secreto.

import crypto from "crypto";

export const TIMEOUT_MS = 5000;
export const CATALOGO_TTL_MS = 5 * 60 * 1000;
export const CATALOGO_MAX_STALE_MS = 24 * 3600 * 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const ESTADOS_ENTREGA = new Set(["ok", "sin_resultado", "ambigua", "tope", "pausado", "ocupado", "error"]);
// 409/429 con significado propio; cualquier otro 409 se devuelve como motivo 'datos'
// sin_configurar (F3, 12-oct-2026): el negocio aún no ha terminado de configurar el ERP (moneda, impuesto, flota, cobros…). Lo dan `cotiza` y `reserva`
// de reservas-bot y la edge reservas-enlace. NO es una caída: el ERP dice que no, y el bot deriva a una persona sin prometer nada.
const MOTIVOS_409 = new Set(["entrega_a_confirmar", "entrega_no_configurada", "sin_disponibilidad", "sin_configurar"]);
const PASO = /^[a-z_]{1,40}$/;   // `paso` de un sin_configurar (moneda, impuesto_pkp, precio_con_impuesto, flota, cobros…); otro valor = null (sin configurar genérico)
// Reglas de reserva de Ajustes (F3-E3, 20261012210000, `_reserva_producto_valida_fechas`): días mínimo, máximo y antelación máxima. La edge las
// devuelve como 409 con el hint de la base y su texto en español («El alquiler más corto es de 3 días»); el número no viaja aparte (el `detail`
// de la base se queda en la edge), así que se saca el PRIMER entero del texto. Sin número creíble → null y el bot dice la regla sin cifra.
// No es una caída ni «precio a confirmar»: el negocio no alquila esas fechas, y el cliente tiene que saberlo para elegir otras (13-oct-2026, E1.10).
export const REGLAS_FECHAS = new Set(["reserva_dias_min", "reserva_dias_max", "reserva_horizonte"]);
export function valorRegla(mensaje) {
  const m = str(mensaje) ? mensaje.match(/\d{1,4}/) : null;
  const n = m ? Number(m[0]) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 3660 ? n : null;
}
export const ENLACE_TIMEOUT_MS = 20000;   // reservas-enlace espera a Xendit hasta 15 s
export const ENLACE_REINTENTO_MS = 4000;  // tras un 409 en_curso (otra petición está creando el enlace; la marca dura 30 s)
export const ESTADO_TIMEOUT_MS = 1500;    // `estado` (B10): como mucho esto espera un TURNO a la lectura: sin ningún valor válido, o con erp en memoria y la caché caducada (ver createBackendSwitch)
// Tope de la LECTURA de `estado`, aparte del de arriba (bbm-bot, 15-oct-2026). Con un solo tope de 1,5 s la lectura no llegaba nunca: bbm-bot salía siempre
// `defecto_por_fallo` / `tiempo` mientras la edge contesta en 0,35-0,7 s desde Bali. Causa: el bot corre en Railway EE. UU. y la base de bbm en ap-southeast-1
// (erp/instancias.json); la edge se lanza junto a quien llama y cada consulta cruza el océano (~1,9 s por llamada medidos en Lawang, LAW-507; Deploy, 5-oct:
// «en EE. UU. contra una base en Singapur el motor daba timeout a la edge todas las veces»). Ahora el turno sigue esperando como mucho 1,5 s, pero la lectura
// continúa hasta 8 s y deja su valor en la caché, y un temporizador la refresca cada 20 s (BACKEND_REFRESCO_MS) para que ningún turno tenga que esperar.
export const ESTADO_LECTURA_MS = 8000;

const KO = (motivo, extra = {}) => ({ ok: false, motivo, ...extra });
const esObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const num = (x) => typeof x === "number" && Number.isFinite(x);
const entero = (x) => Number.isInteger(x);
const str = (x) => typeof x === "string";
const sinControl = (s) => !/[\u0000-\u001f\u007f]/.test(s);

// Teléfono → solo dígitos (6-15). Si no hay un teléfono creíble no se llama a nada.
export function telefonoVerificado(from) {
  const d = String(from ?? "").replace(/\D/g, "");
  return d.length >= 6 && d.length <= 15 ? d : null;
}

// Clave de idempotencia de `reserva` derivada del id del mensaje de WhatsApp. Misma entrada ⇒ misma clave (una reentrega de Meta no duplica).
export function claveReserva({ mensajeId, producto_id, desde, hasta }) {
  if (!str(mensajeId) || !mensajeId) return undefined;
  const h = crypto.createHash("sha256").update([mensajeId, producto_id, desde, hasta].join("|")).digest("hex").slice(0, 48);
  return `wa:${h}`;
}

// ── validadores de respuesta (el contrato está en bbmerp.contract.json y lo fija test-bbmerp.js) ──────────────────────────────────
function leeCatalogo(r) {
  if (!Array.isArray(r)) return null;
  const out = [];
  for (const x of r) {
    if (!esObj(x) || !str(x.id) || !UUID.test(x.id) || !str(x.nombre) || !entero(x.unidades) || x.unidades < 0 || !Array.isArray(x.tarifas)) return null;
    const tarifas = [];
    for (const t of x.tarifas) {
      if (!esObj(t) || !entero(t.dias) || t.dias < 1 || !num(t.precio) || t.precio < 0 || !str(t.moneda)) return null;
      tarifas.push({ dias: t.dias, precio: t.precio, moneda: t.moneda, etiqueta: str(t.etiqueta) ? t.etiqueta : null });
    }
    out.push({
      id: x.id, numero_producto: x.numero_producto ?? null, nombre: x.nombre, descripcion: str(x.descripcion) ? x.descripcion : null,
      unidad: str(x.unidad) ? x.unidad : null, tarifas, unidades: x.unidades,
    });
  }
  return out;
}

function leeEntrega(r) {
  if (!esObj(r) || !ESTADOS_ENTREGA.has(r.estado)) return null;
  if (r.estado === "ok") {
    if (!num(r.km) || r.km <= 0) return null;
    return { estado: "ok", km: r.km };
  }
  return { estado: r.estado, km: null };
}

function leeLineasCotiza(l) {
  if (!Array.isArray(l)) return null;
  const out = [];
  for (const x of l) {
    if (!esObj(x) || !str(x.descripcion) || !num(Number(x.base)) || !num(Number(x.cuota)) || !num(Number(x.bruto))) return null;
    out.push({ descripcion: x.descripcion, concepto: str(x.concepto) ? x.concepto : null, base: Number(x.base), cuota: Number(x.cuota), bruto: Number(x.bruto) });
  }
  return out;
}

function leeCotizacion(r) {
  if (!esObj(r) || !num(r.total) || r.total < 0 || !str(r.moneda) || !/^[A-Z]{3}$/.test(r.moneda) || !entero(r.dias) || r.dias < 1) return null;
  if (!entero(r.disponibles) || r.disponibles < 0) return null;
  if (!str(r.producto_id) || !UUID.test(r.producto_id) || !str(r.desde) || !FECHA.test(r.desde) || !str(r.hasta) || !FECHA.test(r.hasta)) return null;
  const lineas = leeLineasCotiza(r.lineas);
  if (!lineas) return null;
  let impuesto = null;
  if (r.impuesto !== null && r.impuesto !== undefined) {
    if (!esObj(r.impuesto) || !str(r.impuesto.nombre) || !num(Number(r.impuesto.porcentaje))) return null;
    impuesto = { nombre: r.impuesto.nombre, porcentaje: Number(r.impuesto.porcentaje) };
  }
  // Comisión de pago en línea (requisito I del corte, ERP 20261014010000): YA va dentro de `total` y es una de las `lineas` (concepto comision_pago);
  // aquí solo se lee para decírsela al cliente. Si el desglose no cuadra con su línea, la cotización no se usa (el bot no inventa una cifra).
  let comision = null;
  if (r.comision !== null && r.comision !== undefined) {
    if (!esObj(r.comision) || !num(Number(r.comision.porcentaje)) || !num(Number(r.comision.importe)) || Number(r.comision.importe) <= 0) return null;
    const lc = lineas.filter((x) => x.concepto === "comision_pago");
    if (lc.length !== 1 || lc[0].bruto !== Number(r.comision.importe)) return null;
    comision = { porcentaje: Number(r.comision.porcentaje), importe: Number(r.comision.importe) };
  } else if (lineas.some((x) => x.concepto === "comision_pago")) return null;
  // Seguro y fianza del modelo (requisito J): informativos, FUERA del total (owner 13-oct: el seguro se paga en la entrega). importe null = no hay
  // tarifa exacta para esos días: el bot da las tarifas por periodo y el equipo confirma la cifra al entregar. Si viene mal formado se ignora (no es dinero del enlace).
  let seguro = null;
  if (esObj(r.seguro) && Array.isArray(r.seguro.tramos)) {
    const tramos = r.seguro.tramos.filter((t) => esObj(t) && entero(t.dias) && num(Number(t.precio))).map((t) => ({ dias: t.dias, precio: Number(t.precio) }));
    seguro = {
      importe: num(Number(r.seguro.importe)) && r.seguro.importe !== null ? Number(r.seguro.importe) : null,
      tramos, obligatorio: r.seguro.obligatorio === true,
      fianza: num(Number(r.seguro.fianza)) && r.seguro.fianza !== null ? Number(r.seguro.fianza) : null,
      fianza_con_seguro: r.seguro.fianza_con_seguro === true,
    };
  }
  return {
    producto_id: r.producto_id, desde: r.desde, hasta: r.hasta, dias: r.dias, disponibles: r.disponibles,
    total: r.total, moneda: r.moneda, base: num(r.base) ? r.base : null, impuestos: num(r.impuestos) ? r.impuestos : null,
    incluye_impuesto: r.incluye_impuesto === true, impuesto, precio_alquiler: num(r.precio_alquiler) ? r.precio_alquiler : null,
    desglose: r.desglose ?? null, lineas, comision, seguro,
  };
}

function leeReserva(r) {
  if (!esObj(r) || !str(r.id) || !UUID.test(r.id) || !esObj(r.cobro)) return null;
  const c = r.cobro;
  // el enlace de Xendit cobra EXACTAMENTE esto: entero, igual al total congelado, con el external_id de ESTA reserva
  if (c.external_id !== `rsv:${r.id}` || !entero(c.importe) || c.importe <= 0 || !str(c.moneda) || !/^[A-Z]{3}$/.test(c.moneda)) return null;
  if (!entero(c.segundos_hasta_caducar) || c.segundos_hasta_caducar < 0) return null;
  if (!num(r.precio_total) || r.precio_total !== c.importe || r.moneda !== c.moneda) return null;
  return {
    reserva_id: r.id, numero_reserva: r.numero_reserva ?? null, estado: r.estado ?? null, caduca_en: r.caduca_en ?? null,
    desde: r.desde ?? null, hasta: r.hasta ?? null, dias: entero(r.dias) ? r.dias : null,
    precio_total: r.precio_total, moneda: r.moneda, incluye_impuesto: r.incluye_impuesto === true,
    lineas: Array.isArray(r.lineas) ? r.lineas.filter((l) => esObj(l) && str(l.descripcion)).map((l) => ({ descripcion: l.descripcion, base: Number(l.base) })) : [],
    repetida: r.repetida === true,
    cobro: { external_id: c.external_id, importe: c.importe, moneda: c.moneda, segundos_hasta_caducar: c.segundos_hasta_caducar },
  };
}

function leeCliente(r) {
  if (!esObj(r) || r.ok !== true || typeof r.cliente_identificado !== "boolean") return null;
  return { cliente_identificado: r.cliente_identificado, creado: r.creado === true, motivo: str(r.motivo) ? r.motivo : null };
}

export function createBbmErp(o = {}) {
  const {
    url, secret, timeoutMs = TIMEOUT_MS, catalogoTtlMs = CATALOGO_TTL_MS, catalogoMaxStaleMs = CATALOGO_MAX_STALE_MS,
    enviaClave = false, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console, project = "bot", enlaceTimeoutMs = ENLACE_TIMEOUT_MS,
    estadoTimeoutMs = ESTADO_LECTURA_MS,
  } = o;
  const base = typeof url === "string" ? url.trim().replace(/\/+$/, "") : "";
  const enabled = !!(base && secret);
  const p = (m) => `[${project}] [bbmerp] ${m}`;

  let catalogo = null;      // { at, datos } último catálogo BUENO
  let inflight = null;

  // POST a reservas-bot. → {ok:true, status, r} | {ok:false, motivo, ...}. NUNCA lanza.
  const llamaErp = (accion, cuerpo) => llamaEdge("reservas-bot", accion, { accion, ...cuerpo }, timeoutMs);

  // POST a una edge del ERP con el secreto del bot. `accion` solo sirve para el log; el cuerpo va tal cual.
  async function llamaEdge(edge, accion, cuerpo, ms) {
    if (!enabled) return KO("no_configurado");
    let resp;
    try {
      resp = await fetchImpl(`${base}/functions/v1/${edge}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", "x-bot-secret": secret },
        body: JSON.stringify(cuerpo),
        signal: AbortSignal.timeout(ms),
      });
    } catch (e) {
      log.warn(p(`${accion}: sin respuesta (${e && e.name === "TimeoutError" ? "tiempo" : "red"})`));
      return KO("no_disponible", { reintentable: true });
    }
    const st = resp.status;
    let json = null;
    try { json = await resp.json(); } catch { /* sin cuerpo legible */ }
    if (st === 200) {
      if (!esObj(json) || !("r" in json)) { log.error(p(`${accion}: 200 sin forma {r}`)); return KO("no_disponible", { detalle: "respuesta_invalida" }); }
      return { ok: true, status: 200, r: json.r };
    }
    const codigo = esObj(json) && str(json.error) ? json.error : null;
    if (st === 401 || st === 403) { log.error(p(`${accion}: SECRETO RECHAZADO (HTTP ${st}). Revisa BBM_RESERVAS_SECRET.`)); return KO("secreto_rechazado"); }
    if (st === 404) { log.warn(p(`${accion}: módulo de reservas apagado en el ERP`)); return KO("modulo_apagado"); }
    if (st === 429) { log.warn(p(`${accion}: tope ${codigo || ""}`)); return KO(codigo === "tope_global" ? "tope_global" : "tope_telefono"); }
    if (st === 409) {
      log.log(p(`${accion}: 409 ${codigo || ""}`));
      if (codigo === "sin_configurar") return KO("sin_configurar", { codigo, paso: str(json.paso) && PASO.test(json.paso) ? json.paso : null });
      if (REGLAS_FECHAS.has(codigo)) return KO("regla_fechas", { codigo, valor: valorRegla(json.mensaje) });
      return KO(MOTIVOS_409.has(codigo) ? codigo : "datos", { codigo });
    }
    if (st === 400 || st === 413) { log.error(p(`${accion}: la edge rechaza la petición (${st} ${codigo || ""})`)); return KO("peticion_invalida", { codigo }); }
    log.warn(p(`${accion}: HTTP ${st}${codigo === "proveedor" ? " proveedor" : ""}`));
    // 502 {error:'proveedor'} de reservas-enlace: Xendit no creó la factura (o no se sabe). NO es reintentable aquí: la edge deja la marca 30 s.
    if (codigo === "proveedor") return KO("proveedor");
    return KO("no_disponible", { reintentable: st >= 500 });
  }

  // ── acciones (cuerpos con lista cerrada de campos) ───────────────────────────────────────────────────────────────────────
  async function leeCatalogoErp() {
    const r = await llamaErp("catalogo", {});
    if (!r.ok) return r;
    const datos = leeCatalogo(r.r);
    if (!datos) { log.error(p("catalogo: respuesta que no cumple el contrato")); return KO("no_disponible", { detalle: "respuesta_invalida" }); }
    return { ok: true, datos };
  }

  // Catálogo con caché: fresco ≤ catalogoTtlMs; si el ERP falla se sirve el último bueno hasta catalogoMaxStaleMs (stale:true); pasado eso, fail-closed.
  async function getCatalogo() {
    const t = now();
    if (catalogo && t - catalogo.at < catalogoTtlMs) return { ok: true, productos: catalogo.datos, stale: false };
    if (!inflight) inflight = leeCatalogoErp().finally(() => { inflight = null; });
    const r = await inflight;
    if (r.ok) { catalogo = { at: now(), datos: r.datos }; return { ok: true, productos: r.datos, stale: false }; }
    // un apagado explícito (módulo apagado, secreto roto, sin configurar) NO se tapa con la caché: el ERP dijo que no
    if (r.motivo === "modulo_apagado" || r.motivo === "secreto_rechazado" || r.motivo === "sin_configurar") { catalogo = null; return r; }
    if (catalogo && now() - catalogo.at < catalogoMaxStaleMs) { log.warn(p("catalogo: ERP caído, se sirve el último bueno")); return { ok: true, productos: catalogo.datos, stale: true }; }
    return r;
  }

  async function entrega(direccion) {
    if (!str(direccion)) return KO("peticion_invalida", { codigo: "direccion" });
    const d = direccion.trim();
    if (d.length < 5 || d.length > 200 || !sinControl(d)) return KO("peticion_invalida", { codigo: "direccion" });
    const r = await llamaErp("entrega", { direccion: d });
    if (!r.ok) return r;
    const e = leeEntrega(r.r);
    if (!e) { log.error(p("entrega: respuesta que no cumple el contrato")); return KO("no_disponible", { detalle: "respuesta_invalida" }); }
    return { ok: true, ...e };
  }

  function cuerpoProducto({ producto_id, desde, hasta }) {
    if (!str(producto_id) || !UUID.test(producto_id)) return null;
    if (!str(desde) || !FECHA.test(desde) || !str(hasta) || !FECHA.test(hasta)) return null;
    return { producto_id, desde, hasta };
  }
  function dirOpcional(v) {
    if (v === undefined || v === null || v === "") return { ok: true, v: undefined };
    if (!str(v) || v.length > 2000 || !sinControl(v)) return { ok: false };
    return { ok: true, v: v.trim() };
  }

  async function cotiza({ producto_id, desde, hasta, entrega_direccion, recogida_direccion }) {
    const c = cuerpoProducto({ producto_id, desde, hasta });
    if (!c) return KO("peticion_invalida", { codigo: "producto_o_fechas" });
    const e = dirOpcional(entrega_direccion), g = dirOpcional(recogida_direccion);
    if (!e.ok || !g.ok) return KO("peticion_invalida", { codigo: "direccion" });
    if (e.v) c.entrega_direccion = e.v;
    if (g.v) c.recogida_direccion = g.v;
    const r = await llamaErp("cotiza", c);
    if (!r.ok) return r;
    const q = leeCotizacion(r.r);
    if (!q) { log.error(p("cotiza: respuesta que no cumple el contrato")); return KO("no_disponible", { detalle: "respuesta_invalida" }); }
    // la base devuelve lo que se cotizó: si no es lo pedido, algo va mal y no se enseña
    if (q.producto_id !== producto_id || q.desde !== desde || q.hasta !== hasta) { log.error(p("cotiza: la respuesta no es de lo pedido")); return KO("no_disponible", { detalle: "respuesta_incoherente" }); }
    log.log(p(`cotiza: ok total=${q.total} ${q.moneda} disponibles=${q.disponibles}`));
    return { ok: true, cotizacion: q };
  }

  // `fromVerificado` = el `from` del webhook de Meta (ya verificado por la firma). NUNCA un número escrito en el chat ni un argumento del modelo.
  async function reserva({ fromVerificado, producto_id, desde, hasta, entrega_direccion, recogida_direccion, mensajeId, conversacion_ref }) {
    const tel = telefonoVerificado(fromVerificado);
    if (!tel) return KO("peticion_invalida", { codigo: "telefono" });
    const c = cuerpoProducto({ producto_id, desde, hasta });
    if (!c) return KO("peticion_invalida", { codigo: "producto_o_fechas" });
    const e = dirOpcional(entrega_direccion), g = dirOpcional(recogida_direccion);
    if (!e.ok || !g.ok) return KO("peticion_invalida", { codigo: "direccion" });
    c.contacto_telefono = tel;
    if (e.v) c.entrega_direccion = e.v;
    if (g.v) c.recogida_direccion = g.v;
    // id del chat o del lead, nunca texto (Legal); aquí el teléfono del lead ya es la clave de la conversación
    if (str(conversacion_ref) && conversacion_ref.length <= 120 && /^[A-Za-z0-9@:._+-]+$/.test(conversacion_ref)) c.conversacion_ref = conversacion_ref;
    const clave = enviaClave ? claveReserva({ mensajeId, producto_id, desde, hasta }) : undefined;
    if (clave) c.clave = clave;
    // un reintento con LA MISMA clave si la respuesta se perdió (red, tiempo, 5xx): la base devuelve la reserva que ya había ({repetida:true})
    let r = await llamaErp("reserva", c);
    if (!r.ok && r.reintentable) { log.warn(p("reserva: reintento con la misma clave")); r = await llamaErp("reserva", c); }
    if (!r.ok) return r;
    // tope global: la base no lanza y devuelve {rechazada}; la edge lo pasa como 429, pero por si llega en un 200 se trata igual
    if (esObj(r.r) && r.r.rechazada) return KO("tope_global");
    const res = leeReserva(r.r);
    if (!res) { log.error(p("reserva: respuesta que no cumple el contrato")); return KO("no_disponible", { detalle: "respuesta_invalida" }); }
    log.log(p(`reserva: ok id=${res.reserva_id} importe=${res.cobro.importe} ${res.cobro.moneda}${res.repetida ? " (repetida)" : ""}`));
    return { ok: true, reserva: res };
  }

  // El teléfono NO viaja: la base lo lee de la reserva. Solo estos tres campos.
  async function cliente({ reserva_id, nombre, pais }) {
    if (!str(reserva_id) || !UUID.test(reserva_id)) return KO("peticion_invalida", { codigo: "reserva_id" });
    if (!str(nombre) || !str(pais)) return KO("peticion_invalida", { codigo: "nombre_o_pais" });
    const n = nombre.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
    const pa = pais.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
    if (n.length < 2 || pa.length < 2) return KO("peticion_invalida", { codigo: "nombre_o_pais" });
    const r = await llamaErp("cliente", { reserva_id, nombre: n, pais: pa });
    if (!r.ok) return r;
    const c = leeCliente(r.r);
    if (!c) { log.error(p("cliente: respuesta que no cumple el contrato")); return KO("no_disponible", { detalle: "respuesta_invalida" }); }
    return { ok: true, ...c };
  }

  // El enlace de pago de UNA reserva lo crea el ERP (F3 Entrega 2, camino B del owner, 12-oct-2026): edge reservas-enlace, cuerpo SOLO {reserva_id}.
  // Importe, moneda, external_id y caducidad los pone la base; el bot ya no crea facturas en el modo erp. Idempotente: con un enlace vigente la edge
  // devuelve el MISMO (repetido:true) sin ir a Xendit, así que también sirve para volver a pedirlo.
  // → {ok:true, url, caduca_ms, external_id, repetido} | KO: sin_configurar{paso} · en_curso · no_pagable · proveedor · modulo_apagado · no_disponible…
  // Con 409 en_curso (otra petición lo está creando) se espera `reintentoMs` y se reintenta UNA vez. Nunca se reintenta un 502: la edge no suelta la
  // marca cuando no sabe si Xendit creó la factura, y un reintento inmediato solo daría en_curso.
  async function enlace({ reserva_id, external_id }, { reintentoMs = ENLACE_REINTENTO_MS, espera = (ms) => new Promise((ok) => setTimeout(ok, ms)) } = {}) {
    if (!str(reserva_id) || !UUID.test(reserva_id)) return KO("peticion_invalida", { codigo: "reserva_id" });
    const id = reserva_id.toLowerCase();
    const pide = () => llamaEdge("reservas-enlace", "enlace", { reserva_id: id }, enlaceTimeoutMs);
    let r = await pide();
    if (!r.ok && r.codigo === "en_curso") { log.warn(p("enlace: en curso en otra petición, reintento")); await espera(reintentoMs); r = await pide(); }
    if (!r.ok) {
      if (r.codigo === "en_curso" || r.codigo === "no_pagable") return KO(r.codigo);
      return r;
    }
    const e = leeEnlace(r.r, `rsv:${id}`, now());
    if (!e || (external_id !== undefined && e.external_id !== external_id)) { log.error(p("enlace: respuesta que no cumple el contrato")); return KO("no_disponible", { detalle: "respuesta_invalida" }); }
    log.log(p(`enlace: ok reserva=${id}${e.repetido ? " (repetido)" : ""}`));
    return { ok: true, ...e };
  }

  // Interruptor del ERP (B10, 14-oct-2026): quién atiende las reservas del bot lo decide Ajustes › Cobros del ERP, y la edge lo da con la acción
  // `estado` de reservas-bot. Cuerpo EXACTO {accion:"estado"}; respuesta buena SOLO {r:{backend:"dion"|"erp"}}, sin ninguna clave más (cualquier
  // otra forma es un fallo, nunca se interpreta). Sin caché y SIN LOG: la caché, el último valor bueno y el log de cambios son de createBackendSwitch,
  // que lo llama como mucho una vez cada 20-30 s (con llamaEdge, una edge vieja escribiría un error cada 30 s para siempre). Timeout propio (ESTADO_LECTURA_MS);
  // lo que espera un turno lo acota createBackendSwitch (ESTADO_TIMEOUT_MS), no este timeout.
  // → {ok:true, backend} | {ok:false, clase:"definitivo"|"transitorio", codigo} con `codigo` de una lista cerrada (CODIGOS_ESTADO). Nunca lanza.
  //   definitivo (el ERP dijo que no o no se entiende; dion al momento): 400 (edge vieja sin `estado`), 401/403 (secreto), 404 (módulo apagado),
  //   forma (200 con otra forma), otro_4xx. transitorio (puede valer el último bueno < 5 min): tiempo, red, 5xx, 429.
  async function estado() {
    if (!enabled) return { ok: false, clase: "definitivo", codigo: "no_configurado" };
    const transitorio = (e) => ({ ok: false, clase: "transitorio", codigo: e && (e.name === "TimeoutError" || e.name === "AbortError") ? "tiempo" : "red" });
    let resp;
    try {
      resp = await fetchImpl(`${base}/functions/v1/reservas-bot`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", "x-bot-secret": secret },
        body: JSON.stringify({ accion: "estado" }),
        signal: AbortSignal.timeout(estadoTimeoutMs),
      });
    } catch (e) { return transitorio(e); }
    const st = resp.status;
    // sin leer el cuerpo de un error, la conexión queda retenida hasta el GC: se cancela (best-effort)
    if (st !== 200) { try { await resp.body?.cancel?.(); } catch { /* best-effort */ } }
    if (st >= 200 && st < 300 && st !== 200) return { ok: false, clase: "definitivo", codigo: "forma" };   // 2xx inesperado: no es un 4xx
    if (st === 200) {
      let json;
      try { json = await resp.json(); } catch (e) { if (e && (e.name === "TimeoutError" || e.name === "AbortError")) return transitorio(e); json = undefined; }
      const b = leeEstado(json);
      return b ? { ok: true, backend: b } : { ok: false, clase: "definitivo", codigo: "forma" };
    }
    if (st === 400 || st === 401 || st === 403 || st === 404) return { ok: false, clase: "definitivo", codigo: String(st) };
    if (st === 429) return { ok: false, clase: "transitorio", codigo: "429" };
    if (st >= 500) return { ok: false, clase: "transitorio", codigo: "5xx" };
    return { ok: false, clase: "definitivo", codigo: "otro_4xx" };
  }

  return { enabled, catalogo: getCatalogo, entrega, cotiza, reserva, cliente, enlace, estado, _llamaErp: llamaErp };
}

// Forma EXACTA de la respuesta de `estado`: {r:{backend:"dion"|"erp"}} y nada más (ni arriba ni dentro de r). Otro valor, mayúsculas o espacios = null.
// `en_curso` no lo devuelve estado(): es el backend_error del health cuando el turno dejó de esperar y la PRIMERA lectura sigue en vuelo.
export const CODIGOS_ESTADO = ["400", "401", "403", "404", "forma", "otro_4xx", "tiempo", "red", "5xx", "429", "no_configurado", "en_curso"];
export function leeEstado(json) {
  if (!esObj(json) || Object.keys(json).length !== 1 || !esObj(json.r)) return null;
  const k = Object.keys(json.r);
  if (k.length !== 1 || k[0] !== "backend") return null;
  return json.r.backend === "dion" || json.r.backend === "erp" ? json.r.backend : null;
}

// Respuesta de reservas-enlace: {url, caduca_en, external_id, repetido}. La URL es la del invoice de Xendit (https, sin espacios ni comillas); caduca_en es
// la caducidad REAL de ese invoice (con repetido:true no casa con un cálculo local) y tiene que estar en el futuro.
export function leeEnlace(r, externalEsperado, ahora = Date.now()) {
  if (!esObj(r) || !str(r.url) || r.url.length > 500 || !/^https:\/\/[^\s"'<>]+$/.test(r.url)) return null;
  if (r.external_id !== externalEsperado || !str(r.caduca_en)) return null;
  const ms = Date.parse(r.caduca_en);
  if (!Number.isFinite(ms) || ms <= ahora) return null;
  return { url: r.url, caduca_ms: ms, external_id: r.external_id, repetido: r.repetido === true };
}

// ── Interruptor de backend (F8 pieza 7c; desde B10, 14-oct-2026, vive en el ERP) ─────────────────────────────────────────────────────────
// `dion` (el sistema de siempre) o `erp`. Quién atiende las reservas del bot lo cambian el owner o Dion en el ERP (Ajustes › Cobros); el bot lo lee con
// la acción `estado` de reservas-bot (createBbmErp().estado). ORDEN FIJO de decisión para una conversación (bbmBackend):
//   1. pin `bbm:pin:<tel>` vivo › 2. enlace `rsv:` pagable › 3. teléfono de prueba (BBM_ERP_TELEFONOS)   ← los tres, como antes de B10
//   4. freno BBM_FRENO_DION=1 ⇒ dion › 5. lo que dice el ERP › 6. dion                                   ← el VALOR POR DEFECTO
// El freno y el ERP solo sustituyen al valor por defecto: con el freno puesto, una conversación con pin, enlace vivo o teléfono de prueba en erp SIGUE
// en erp (no se cambia de sistema a media reserva); todas las demás van a dion sin leer nada del ERP.
// DEJAN DE MANDAR (B10): la variable BBM_BACKEND (hoy `dion` en Railway: como freno anularía el gesto del ERP el día del despliegue) y la clave Redis
// `bbm:backend` (dos fuentes del mismo dato = la del 12-oct que nadie veía). Si existen, el arranque y /admin/api/health lo dicen como obsoletas.
// LECTURA DEL ERP, con el coste en el turno acotado a ESTADO_TIMEOUT_MS y solo en los dos casos de abajo (revisión previa de Bots #332 y de Seguridad, 14-oct).
// Desde el 15-oct el turno deja de esperar a los 1,5 s pero la lectura NO se corta (dura hasta ESTADO_LECTURA_MS) y su valor queda para el turno siguiente;
// y `arranca()` pone un temporizador que refresca cada BACKEND_REFRESCO_MS (< los 30 s de la caché): con tráfico o sin él, el valor está siempre fresco y
// ningún turno espera (ni el primer cliente de la mañana va a Dion por una caché vieja). Con el freno o sin ERP el temporizador no lee nada.
//   · Caché de 30 s y UNA petición en vuelo. Con valor válido el turno contesta al momento; si la lectura tiene ≥ 30 s refresca en segundo plano
//     cuando lo que hay es dion, y ESPERA la lectura cuando es erp (volver a dion en Ajustes se nota en ≤ 30 s). Sin ningún valor válido (recién arrancado, o > 5 min sin tráfico) el turno ESPERA la lectura, como mucho ESTADO_TIMEOUT_MS (1,5 s): contestar dion
//     sin leer mandaría a Dion el primer cliente de cada mañana y, si cotiza, lo ataría a dion 30 min.
//   · Fallo definitivo (400 de una edge vieja, 401/403, 404, forma mala, otro 4xx) ⇒ dion al momento y se OLVIDA el último bueno (el ERP dijo que no).
//     Fallo transitorio (tiempo, red, 5xx, 429) ⇒ el último valor bueno si tiene < 5 min; si no, dion. Nunca erp sin una lectura buena de < 5 min.
//   · Los fallos también se guardan 30 s (caché negativa): una edge vieja no recibe una petición por turno. El log, solo cuando cambia el resultado.
//   · Con el freno puesto, o sin ERP configurado, no se lee nada.
//
// FIJADO POR CONVERSACIÓN: al iniciar un flujo de reserva se fija el backend (clave `bbm:pin:<tel>` con caducidad) y no cambia hasta que la
// cotización muera: nada de cotizar en Dion y pagar en el ERP. Un cambio del interruptor solo afecta a conversaciones nuevas o sin cotización viva.
export const BACKENDS = ["dion", "erp"];
export const normalizaBackend = (v) => {
  const x = typeof v === "string" ? v.trim().toLowerCase() : "";
  return BACKENDS.includes(x) ? x : "dion";
};

// TELÉFONOS DE PRUEBA (13-oct-2026, E1.10): `BBM_ERP_TELEFONOS` = teléfonos (solo dígitos, separados por comas) cuyas conversaciones van al ERP aunque
// el valor por defecto siga en `dion`. Para el cobro de prueba de punta a punta con el teléfono del estudio (E1.6) ANTES del corte, sin que cambie ningún
// cliente real. Antes la lista de corte decía «fijar bbm:pin:<tel> en Redis» y no había forma de hacerlo sin escribir en Redis a mano.
//   · Comparación EXACTA de dígitos (nunca «últimos 9», lección de BOT_ALLOWLIST: dos móviles de países distintos los comparten). Un número escrito en
//     formato local o con menos de 8 dígitos no se adivina: se descarta y se grita en el arranque. Descartar es lo seguro (esa persona sigue en dion).
//   · Ausente o vacía = como siempre. Un pin vivo o un enlace pendiente siguen mandando antes que la lista (no se cambia de sistema a media reserva).
export function leeTelefonosErp(valor, log = console, project = "bot") {
  const set = new Set(), malos = [];
  for (const x of String(valor ?? "").split(",").map((t) => t.trim()).filter(Boolean)) {
    const d = x.replace(/^\+/, "");
    if (/^\d{8,15}$/.test(d) && !d.startsWith("0")) set.add(d);
    else malos.push(x.length > 4 ? `…${x.slice(-2)}` : "?");
  }
  if (malos.length) log.error(`[${project}] [bbm-backend] BBM_ERP_TELEFONOS: ${malos.length} número(s) no válidos descartados (${malos.join(", ")}): van en formato internacional, solo dígitos`);
  return set;
}

export const BACKEND_TTL_MS = 30 * 1000;            // caché de la lectura del ERP (buena o mala)
export const BACKEND_MAX_STALE_MS = 5 * 60 * 1000;   // vida del último valor bueno ante un fallo TRANSITORIO
export const BACKEND_REFRESCO_MS = 20 * 1000;        // temporizador de lectura (arranca): menos que BACKEND_TTL_MS, para que la caché no caduque nunca
export const FUENTES_BACKEND = ["erp", "erp_cache", "freno_variable", "defecto_por_fallo", "sin_erp"];

// BBM_FRENO_DION: "1" = freno puesto; ausente, vacía o "0" = sin freno. Cualquier otro valor ("true", "si", "2") se trata como freno PUESTO y se grita:
// quien la escribe quiere frenar, y una errata no puede dejarle sin freno (la misma idea que BOT_MODE=testing con lista ilegible).
export function leeFreno(valor, log = console, project = "bot") {
  if (valor === true) return true;
  const v = valor === undefined || valor === null || valor === false ? "" : String(valor).trim();
  if (v === "" || v === "0") return false;
  if (v !== "1") log.error(`[${project}] [bbm-backend] BBM_FRENO_DION no vale 1 ni 0: se trata como freno PUESTO (todo lo nuevo a dion). Ponla a 1 o quítala.`);
  return true;
}

export function createBackendSwitch(o = {}) {
  // enlaceVivo(tel) → true si esa conversación tiene un enlace de pago `rsv:` aún pagable (createPendingRsv.lee). Ese enlace ATA la conversación
  // a erp aunque el pin haya caducado: si no, el interruptor la pasaría a dion con un pago en vuelo.
  // erp: el cliente de createBbmErp (o una función que lo devuelve: en index.js se crea DESPUÉS del interruptor). Sin él, o con enabled=false: dion.
  // freno: el valor de BBM_FRENO_DION (ver leeFreno). bbmBackendObsoleta: el valor de BBM_BACKEND, solo para decir que ya no se usa.
  const {
    redis = () => null, erp = null, freno, bbmBackendObsoleta, enlaceVivo = async () => false, telefonosErp = new Set(),
    now = () => Date.now(), log = console, project = "bot", ttlMs = BACKEND_TTL_MS, maxStaleMs = BACKEND_MAX_STALE_MS,
    esperaMs = ESTADO_TIMEOUT_MS, refrescoMs = BACKEND_REFRESCO_MS, reloj = () => Date.now(),
  } = o;
  const p = (m) => `[${project}] [bbm-backend] ${m}`;
  const mem = new Map();   // sin Redis (modo RAM): mismas reglas en memoria
  const frenoPuesto = leeFreno(freno, log, project);
  const obsoletaEnv = bbmBackendObsoleta !== undefined && bbmBackendObsoleta !== null;
  const erpDe = () => { const e = typeof erp === "function" ? erp() : erp; return e && e.enabled && typeof e.estado === "function" ? e : null; };
  if (obsoletaEnv) log.warn(p("BBM_BACKEND está puesta y YA NO SE USA (B10): quién atiende lo decide el ERP (Ajustes › Cobros); el freno de emergencia es BBM_FRENO_DION=1. Quítala."));
  if (frenoPuesto) log.warn(p("FRENO PUESTO (BBM_FRENO_DION): toda conversación nueva va a dion y no se lee el ERP; las que tienen pin, enlace vivo o teléfono de prueba en erp siguen en erp."));

  let lectura = null;   // última lectura del ERP, buena o mala: { at, ok, backend } | { at, ok:false, clase, codigo }
  let bueno = null;     // último valor BUENO { at, backend }; un fallo definitivo lo borra
  let inflight = null;
  let lecturaMs = null;   // lo que tardó la última lectura terminada (buena o mala), en ms de reloj real: sale en el health y en el log de cambios
  let temporizador = null;
  let ultimoLog = null;
  let claveVieja = { at: null, existe: false };   // ¿existe todavía `bbm:backend` en Redis? Solo lo mira el health/arranque, nunca el turno
  const CODIGOS = new Set(CODIGOS_ESTADO);

  // Lo que se contesta AHORA con lo que hay en memoria (sin red).
  function resuelve(t) {
    if (frenoPuesto) return { backend: "dion", fuente: "freno_variable", erp_dice: null, error: null };
    if (!erpDe()) return { backend: "dion", fuente: "sin_erp", erp_dice: null, error: null };
    if (lectura && lectura.ok) {
      if (t - lectura.at < maxStaleMs) return { backend: lectura.backend, fuente: "erp", erp_dice: lectura.backend, error: null };
      return { backend: "dion", fuente: "defecto_por_fallo", erp_dice: null, error: null };   // no pasa si se respeta hayRespuesta; por si acaso
    }
    if (lectura && lectura.clase === "transitorio" && bueno && t - bueno.at < maxStaleMs) return { backend: bueno.backend, fuente: "erp_cache", erp_dice: bueno.backend, error: lectura.codigo };
    return { backend: "dion", fuente: "defecto_por_fallo", erp_dice: null, error: lectura ? lectura.codigo : inflight ? "en_curso" : null };
  }
  // ¿Hay un valor que se pueda usar sin esperar? Una lectura de < 30 s (buena o mala: la mala es la caché negativa), o un último bueno de < 5 min.
  function hayRespuesta(t) {
    if (lectura && t - lectura.at < ttlMs) return true;
    return !!(bueno && t - bueno.at < maxStaleMs);
  }
  function anota(res) {
    const k = `${res.backend}|${res.fuente}|${res.error}`;
    if (k === ultimoLog) return;
    ultimoLog = k;
    const m = p(`quién atiende por defecto: ${res.backend} (fuente ${res.fuente}${res.error ? `, error ${res.error}` : ""}${lecturaMs !== null ? `, lectura ${lecturaMs} ms` : ""})`);
    if (res.fuente === "defecto_por_fallo" || res.fuente === "erp_cache") log.warn(m); else log.log(m);
  }

  // Lee el ERP. Una sola petición en vuelo; NUNCA rechaza (se lanza en segundo plano y un rechazo sin catch tumba Node).
  function refresca() {
    if (inflight) return inflight;
    const e = frenoPuesto ? null : erpDe();
    if (!e) return Promise.resolve();
    inflight = (async () => {
      let r;
      const t0 = reloj();
      try { r = await e.estado(); } catch { r = { ok: false, clase: "transitorio", codigo: "red" }; }
      lecturaMs = Math.max(0, Math.round(reloj() - t0));
      const t = now();
      if (r && r.ok === true && BACKENDS.includes(r.backend)) {
        lectura = { at: t, ok: true, backend: r.backend };
        bueno = { at: t, backend: r.backend };
      } else {
        const clase = r && r.clase === "transitorio" ? "transitorio" : "definitivo";
        lectura = { at: t, ok: false, clase, codigo: r && CODIGOS.has(r.codigo) ? r.codigo : "otro_4xx" };
        if (clase === "definitivo") bueno = null;   // el ERP dijo que no: un timeout de después no puede resucitar un erp viejo
      }
      anota(resuelve(t));
    })().catch(() => {}).finally(() => { inflight = null; });
    return inflight;
  }

  // Espera la lectura como mucho `esperaMs` (1,5 s). Si no ha llegado, el turno sigue con lo que hay y la lectura continúa: su valor es para el siguiente.
  async function esperaLectura() {
    let tope;
    const corte = new Promise((ok) => { tope = setTimeout(ok, esperaMs); });
    try { await Promise.race([refresca(), corte]); } finally { clearTimeout(tope); }
  }

  // El valor por defecto con su fuente. Espera la lectura (como mucho `esperaMs`) si no hay ningún valor válido, o si
  // hay erp en memoria y la caché caducó; con dion caducado refresca en segundo plano.
  async function decide() {
    let t = now();
    if (!frenoPuesto && erpDe()) {
      if (!hayRespuesta(t)) { await esperaLectura(); t = now(); }
      else if (!lectura || t - lectura.at >= ttlMs) {
        // Caché caducada. Con erp en memoria se ESPERA la lectura (≤ ESTADO_TIMEOUT_MS): volver a dion desde Ajustes tiene que notarse en ≤ 30 s, no
        // cotizar con un erp de hace 5 min y fijar la conversación 30 min en él (revisor 14-oct). Con dion, el lado seguro, en segundo plano.
        // Con el temporizador de arranca() la caché no llega a caducar mientras las lecturas tarden < 10 s; esto queda para cuando una falla.
        if (resuelve(t).backend === "erp") { await esperaLectura(); t = now(); }
        else refresca();   // segundo plano: refresca() nunca rechaza
      }
    }
    const res = resuelve(t);
    anota(res);
    return res;
  }
  async function porDefecto() { return (await decide()).backend; }

  async function existeClaveVieja() {
    const t = now();
    if (claveVieja.at !== null && t - claveVieja.at < ttlMs) return claveVieja.existe;
    const r = redis();
    let existe = false;
    if (r) { try { existe = Number(await r.exists("bbm:backend")) > 0; } catch { existe = claveVieja.existe; } }
    claveVieja = { at: t, existe };
    return existe;
  }

  // Bloque `bbm` de /admin/api/health (lo esparce index.js). Solo valores de lista cerrada, booleanos y segundos: nunca el cuerpo de un error,
  // la URL, el secreto ni el VALOR de `bbm:backend` (solo si existe). Usa la misma caché de 30 s que el turno.
  // backend_leido_hace_s = edad de la lectura que respalda la respuesta: la del valor usado (erp, erp_cache) o la del último intento (defecto_por_fallo).
  async function salud() {
    const d = await decide();
    const t = now();
    const ref = d.fuente === "erp" ? lectura : d.fuente === "erp_cache" ? bueno : d.fuente === "defecto_por_fallo" ? lectura : null;
    return {
      backend: d.backend,
      backend_fuente: d.fuente,
      erp_dice: d.erp_dice,
      freno: frenoPuesto,
      backend_error: d.error,
      backend_leido_hace_s: ref ? Math.max(0, Math.floor((t - ref.at) / 1000)) : null,
      backend_lectura_ms: lecturaMs,
      obsoletas: { BBM_BACKEND: obsoletaEnv, redis_bbm_backend: await existeClaveVieja() },
    };
  }

  // Temporizador de lectura: refresca() cada refrescoMs. No retiene el proceso (unref), refresca() nunca rechaza y, con el freno o sin ERP, no lee nada.
  function inicia() {
    if (temporizador || !(refrescoMs > 0)) return;
    temporizador = setInterval(() => { refresca(); }, refrescoMs);
    if (typeof temporizador.unref === "function") temporizador.unref();
  }
  function para() { if (temporizador) { clearInterval(temporizador); temporizador = null; } }

  // Al arrancar: el temporizador, la primera lectura (el primer turno la encuentra hecha o en vuelo) y aviso si la clave vieja sigue en Redis.
  async function arranca() {
    inicia();
    await refresca();
    if (!lectura && !frenoPuesto) anota(resuelve(now()));
    if (await existeClaveVieja()) log.warn(p("la clave Redis bbm:backend existe y YA NO SE USA (B10): borrarla (Deploy, con el OK del orquestador)."));
  }

  async function leePin(tel) {
    const r = redis();
    let raw = null;
    if (r) { try { raw = await r.get(`bbm:pin:${tel}`); } catch { return { error: true }; } }
    else raw = mem.get(tel) ?? null;
    if (!raw) return null;
    try {
      const pin = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (pin && BACKENDS.includes(pin.backend) && Number.isFinite(pin.hasta) && pin.hasta > now()) return pin;
    } catch { /* pin ilegible = sin pin */ }
    return null;
  }

  // El backend de ESTA conversación: el fijado si sigue vivo; si no, el valor por defecto.
  async function bbmBackend(tel) {
    if (tel) {
      const pin = await leePin(String(tel));
      if (pin && pin.error) return "dion";           // no se sabe si había una cotización viva en erp: lo seguro es no tocar nada
      if (pin) return pin.backend;
      let vivo = false;
      try { vivo = await enlaceVivo(String(tel)); } catch { /* sin poder saberlo, manda el valor por defecto */ }
      if (vivo) return "erp";
      if (telefonosErp.has(String(tel).replace(/\D/g, ""))) return "erp";   // teléfono de prueba (ver leeTelefonosErp)
    }
    return porDefecto();
  }

  // Al iniciar un flujo de reserva. Si ya hay un backend fijado y vivo, NO se cambia (devuelve ese). ttlSec = lo que vive la cotización.
  async function fija(tel, ttlSec, backend) {
    const t = String(tel);
    const vivo = await leePin(t);
    if (vivo && !vivo.error) return vivo.backend;
    const b = backend === undefined ? await porDefecto() : normalizaBackend(backend);
    const ttl = Math.max(60, Math.floor(Number(ttlSec) || 0));
    const pin = { backend: b, hasta: now() + ttl * 1000 };
    const r = redis();
    if (r) { try { await r.setEx(`bbm:pin:${t}`, ttl, JSON.stringify(pin)); } catch { log.error(p("no se pudo fijar el backend de la conversación")); } }
    else mem.set(t, JSON.stringify(pin));
    return b;
  }

  async function suelta(tel) {
    const r = redis();
    if (r) { try { await r.del(`bbm:pin:${String(tel)}`); } catch { /* best-effort */ } }
    else mem.delete(String(tel));
  }

  return { bbmBackend, fija, suelta, porDefecto, salud, arranca, refresca, para };
}

// ── Registro de enlace pendiente PROPIO de las reservas del ERP ───────────────────────────────────────────────────────────────────
// `lastXenditInvoice` (index.js) lee los eventos `paylink` del lead y es del flujo viejo (`paylink_<tel>_…`): mezclar ahí un `rsv:` lo
// pisaría o lo daría por cancelado. Este registro vive en su propia clave `pendingrsv:<tel>` y nunca toca `lead:`.
export function createPendingRsv(o = {}) {
  const { redis = () => null, now = () => Date.now() } = o;
  const mem = new Map();
  const key = (tel) => `pendingrsv:${String(tel).replace(/\D/g, "")}`;

  async function guarda(tel, { external_id, importe, moneda, reserva_id, caduca_en_ms, url, idioma }) {
    if (!telefonoVerificado(tel)) throw new Error("pendingRsv: teléfono inválido");
    if (!str(external_id) || !external_id.startsWith("rsv:")) throw new Error("pendingRsv: external_id debe empezar por rsv:");
    if (!entero(importe) || importe <= 0) throw new Error("pendingRsv: importe entero positivo");
    if (!Number.isFinite(caduca_en_ms) || caduca_en_ms <= now()) throw new Error("pendingRsv: caducidad en el futuro");
    const reg = { external_id, importe, moneda: str(moneda) ? moneda : null, reserva_id: str(reserva_id) ? reserva_id : null, url: str(url) && /^https:\/\//.test(url) && url.length <= 500 ? url : null, idioma: idioma === "id" || idioma === "es" ? idioma : "en", creado_en: now(), caduca_en: caduca_en_ms };
    const ttl = Math.max(1, Math.ceil((caduca_en_ms - now()) / 1000));
    const r = redis();
    if (r) await r.setEx(key(tel), ttl, JSON.stringify(reg));
    else mem.set(key(tel), reg);
    return reg;
  }

  async function lee(tel) {
    const r = redis();
    let reg = null;
    if (r) { const raw = await r.get(key(tel)); if (raw) { try { reg = JSON.parse(raw); } catch { reg = null; } } }
    else reg = mem.get(key(tel)) ?? null;
    if (!reg || !(reg.caduca_en > now())) return null;
    return reg;
  }

  async function borra(tel) {
    const r = redis();
    if (r) await r.del(key(tel)); else mem.delete(key(tel));
  }

  return { guarda, lee, borra, key };
}
