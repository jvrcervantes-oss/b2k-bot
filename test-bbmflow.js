// Self-check de bbmflow.js (F8 pieza 7, 7a sombra + 7c modo erp): herramienta de cotización, cierre de la reserva, aviso de pago y sombra.
// Sin red: la edge es un fetch simulado que cumple bbmerp.contract.json; bbmerp.js es el REAL. Ejecutar: node test-bbmflow.js
import assert from "node:assert";
import { createBbmErp, createBackendSwitch, createPendingRsv } from "./bbmerp.js";
import {
  createQuoteStore, createReservaIndex, createErpTools, createCierreErp, createAvisoPago, createSombra, textoPagoRecibido,
  ERP_PROMPT_BLOCK, ERP_QUOTE_TOOL, MARGEN_CADUCIDAD_S,
} from "./bbmflow.js";

const silent = { warn() {}, error() {}, log() {} };
let n = 0;
const ok = (m) => { n++; console.log("ok -", m); };

const TEL = "628123456789";
const PID = "3f0c1b1e-7b1a-4c53-9a53-2a6f0f5c1111";
const RID = "9a1e6c1a-0d52-4e0e-8a77-7f0b6f3a2222";
const FUT = "2099-11-01", FUT2 = "2099-11-04";

// ── edge de mentira ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function edge(over = {}) {
  const calls = [];
  const cotizaOk = (b) => ({ dias: 3, precio: 330000, total: 330000, moneda: "IDR", precio_alquiler: 300000, desglose: null, base: 300000, impuestos: 30000, incluye_impuesto: false,
    impuesto: { nombre: "PB1", porcentaje: 10 }, lineas: b.entrega_direccion
      ? [{ descripcion: "Honda Scoopy", concepto: "alquiler", base: 300000, cuota: 30000, bruto: 330000 }, { descripcion: "Entrega", concepto: "entrega", base: 75000, cuota: 0, bruto: 75000 }]
      : [{ descripcion: "Honda Scoopy", concepto: "alquiler", base: 300000, cuota: 30000, bruto: 330000 }],
    producto_id: b.producto_id, desde: b.desde, hasta: b.hasta, disponibles: 2 });
  const total = (b) => 330000 + (b.entrega_direccion ? 75000 : 0);
  const base = {
    catalogo: () => [200, { r: [{ id: PID, numero_producto: "P-1", nombre: "Honda Scoopy", descripcion: "x", unidad: "moto", tarifas: [{ dias: 1, precio: 100000, moneda: "IDR", etiqueta: null }], unidades: 3 }] }],
    entrega: () => [200, { r: { estado: "ok", km: 12.3 } }],
    cotiza: (b) => { const c = cotizaOk(b); c.total = total(b); return [200, { r: c }]; },
    reserva: (b) => [200, { r: { id: RID, numero_reserva: "RSV-1", estado: "bloqueo", caduca_en: "2099-01-01T00:00:00+00:00", desde: b.desde, hasta: b.hasta, dias: 3, precio_total: total(b), moneda: "IDR", desglose: null, base: 300000, impuestos: 30000, incluye_impuesto: false, lineas: [{ descripcion: "Honda Scoopy", base: 300000 }], cobro: { external_id: `rsv:${RID}`, importe: total(b), moneda: "IDR", segundos_hasta_caducar: 3540 } } }],
    cliente: () => [200, { r: { ok: true, cliente_identificado: true, creado: true, motivo: null } }],
  };
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const f = over[body.accion] || base[body.accion];
    const [status, json] = f(body);
    return { status, json: async () => json };
  };
  return { fetchImpl, calls };
}
const mkErp = (over) => { const e = edge(over); return { erp: createBbmErp({ url: "https://erp.test", secret: "s".repeat(20), fetchImpl: e.fetchImpl, log: silent }), calls: e.calls }; };

// ── 1) herramienta get_quote ───────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const { erp, calls } = mkErp();
  const quotes = createQuoteStore();
  const tools = createErpTools({ erp, quotes, log: silent });
  const r = await tools.runGetQuote(TEL, { bike_model: "honda scoopy", from: FUT, to: FUT2 });
  assert.equal(r.ok, true); assert.equal(r.available, true); assert.equal(r.total, 330000);
  assert.deepEqual(r.breakdown, [{ line: "Honda Scoopy", amount: 330000 }]);
  assert.ok(!calls.some((c) => c.accion === "entrega"), "sin dirección no se llama a entrega");
  const g = await quotes.lee(TEL);
  assert.equal(g.producto_id, PID); assert.equal(g.total, 330000); assert.equal(g.entrega_direccion, null);
  ok("get_quote sin entrega: total de la base, líneas, cotización guardada");
}
{
  const { erp, calls } = mkErp();
  const quotes = createQuoteStore();
  const tools = createErpTools({ erp, quotes, log: silent });
  const r = await tools.runGetQuote(TEL, { bike_model: "Honda Scoopy", from: FUT, to: FUT2, delivery_address: "Jl. Pantai Berawa 99, Canggu" });
  assert.equal(r.ok, true); assert.equal(r.total, 405000);
  const orden = calls.map((c) => c.accion);
  assert.deepEqual(orden, ["catalogo", "entrega", "cotiza"], "entrega ANTES de cotiza");
  const cz = calls.find((c) => c.accion === "cotiza");
  assert.equal(cz.entrega_direccion, "Jl. Pantai Berawa 99, Canggu"); assert.equal(cz.recogida_direccion, "Jl. Pantai Berawa 99, Canggu");
  assert.ok(!("km" in cz) && !("total" in cz) && !("importe" in cz), "el bot no manda km ni importes");
  ok("get_quote con dirección: entrega antes de cotiza, mismas direcciones, sin km ni importes");
  await tools.runGetQuote(TEL, { bike_model: "Honda Scoopy", from: FUT, to: FUT2, delivery_address: "Jl. Pantai Berawa 99, Canggu", self_return: true });
  const cz2 = calls.filter((c) => c.accion === "cotiza").pop();
  assert.ok(!("recogida_direccion" in cz2), "self_return = sin recogida");
  assert.equal((await quotes.lee(TEL)).recogida_direccion, null);
  ok("self_return omite recogida_direccion");
}
for (const [estado, etiqueta] of [["ambigua", "ambigua"], ["sin_resultado", "sin resultado"], ["tope", "tope"], ["pausado", "pausado"], ["error", "error"]]) {
  const { erp, calls } = mkErp({ entrega: () => [200, { r: { estado } }] });
  const quotes = createQuoteStore();
  const tools = createErpTools({ erp, quotes, log: silent });
  const r = await tools.runGetQuote(TEL, { bike_model: "Honda Scoopy", from: FUT, to: FUT2, delivery_address: "algun sitio raro 12" });
  assert.equal(r.ok, false, etiqueta);
  assert.ok(!calls.some((c) => c.accion === "cotiza"), `no se cotiza con entrega ${etiqueta}`);
  assert.equal(await quotes.lee(TEL), null);
  assert.ok(!/\b\d{4,}\b/.test(r.error), "el error no inventa ningún precio");
}
ok("entrega ambigua/sin resultado/tope/pausado/error: no se cotiza, no se guarda nada, no hay precio");
{
  const { erp } = mkErp({ cotiza: () => [409, { error: "entrega_a_confirmar", mensaje: "x" }] });
  const quotes = createQuoteStore();
  const r = await createErpTools({ erp, quotes, log: silent }).runGetQuote(TEL, { bike_model: "Honda Scoopy", from: FUT, to: FUT2, delivery_address: "Jl. Pantai Berawa 99, Canggu" });
  assert.equal(r.ok, false); assert.match(r.error, /confirmed by the team/); assert.equal(await quotes.lee(TEL), null);
  ok("cotiza 409 entrega_a_confirmar: sin precio y sin cotización guardada");
}
{
  const { erp } = mkErp({ cotiza: () => [409, { error: "sin_disponibilidad", mensaje: "x" }] });
  const quotes = createQuoteStore();
  await quotes.guarda(TEL, { producto_id: PID, total: 1 });
  const r = await createErpTools({ erp, quotes, log: silent }).runGetQuote(TEL, { bike_model: "Honda Scoopy", from: FUT, to: FUT2 });
  assert.equal(r.ok, true); assert.equal(r.available, false); assert.equal(r.total, undefined);
  ok("sin disponibilidad (409): available=false, sin total");
  const { erp: e2 } = mkErp({ cotiza: (b) => [200, { r: { dias: 3, precio: 1, total: 330000, moneda: "IDR", precio_alquiler: 300000, incluye_impuesto: false, impuesto: null, lineas: [{ descripcion: "x", base: 1, cuota: 0, bruto: 1 }], producto_id: b.producto_id, desde: b.desde, hasta: b.hasta, disponibles: 0 } }] });
  const q2 = createQuoteStore();
  await q2.guarda(TEL, { producto_id: PID, total: 1 });
  const r2 = await createErpTools({ erp: e2, quotes: q2, log: silent }).runGetQuote(TEL, { bike_model: "Honda Scoopy", from: FUT, to: FUT2 });
  assert.equal(r2.available, false); assert.equal(await q2.lee(TEL), null, "disponibles=0 BORRA la cotización vieja (no se puede pagar)");
  ok("disponibles=0 en un 200: available=false y se borra la cotización anterior");
}
{
  const { erp } = mkErp();
  const tools = createErpTools({ erp, quotes: createQuoteStore(), log: silent });
  assert.equal((await tools.runGetQuote(TEL, { bike_model: "Moto Fantasma", from: FUT, to: FUT2 })).ok, false);
  assert.equal((await tools.runGetQuote(TEL, { bike_model: "Honda Scoopy", from: "2020-01-01", to: "2020-01-05" })).ok, false);
  assert.equal((await tools.runGetQuote(TEL, { bike_model: "Honda Scoopy", from: FUT2, to: FUT })).ok, false);
  assert.equal((await tools.runGetQuote(TEL, { bike_model: "Honda Scoopy", from: "mañana", to: FUT2 })).ok, false);
  const caido = createBbmErp({ url: "https://erp.test", secret: "s".repeat(20), fetchImpl: async () => { throw new Error("red"); }, log: silent });
  const r = await createErpTools({ erp: caido, quotes: createQuoteStore(), log: silent }).runGetQuote(TEL, { bike_model: "Honda Scoopy", from: FUT, to: FUT2 });
  assert.equal(r.ok, false); assert.match(r.error, /Do NOT give a price/);
  ok("moto inexistente, fechas en el pasado, invertidas o mal formadas, ERP caído: error controlado, nunca precio");
}

// ── 2) cierre ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function montaCierre(over = {}, opts = {}) {
  const { erp, calls } = mkErp(over);
  const quotes = createQuoteStore();
  const pendingRsv = createPendingRsv();
  const indice = createReservaIndex();
  const backend = createBackendSwitch({ log: silent });
  const facturas = [];
  const avisos = [];
  const crearFactura = opts.crearFactura || (async (f) => { facturas.push(f); return { url: "https://checkout.xendit.co/web/abc", id: "inv_1" }; });
  const cierre = createCierreErp({ erp, quotes, pendingRsv, indice, backend, crearFactura, avisaEquipo: async (t) => { avisos.push(t); }, log: silent, project: "T" });
  return { cierre, calls, quotes, pendingRsv, indice, backend, facturas, avisos, erp };
}
const COT = { producto_id: PID, nombre: "Honda Scoopy", desde: FUT, hasta: FUT2, entrega_direccion: null, recogida_direccion: null, total: 330000, moneda: "IDR" };

{
  const m = montaCierre();
  await m.quotes.guarda(TEL, { ...COT, entrega_direccion: "Jl. Pantai Berawa 99, Canggu", recogida_direccion: "Jl. Pantai Berawa 99, Canggu", total: 405000 });
  const r = await m.cierre.cierra({ tel: TEL, mensajeId: "wamid.AAA=", payAmount: 405000, nombre: "Ana Pérez", pais: "Spain" });
  assert.equal(r.ok, true); assert.equal(r.url, "https://checkout.xendit.co/web/abc"); assert.equal(r.importe, 405000);
  const rsv = m.calls.find((c) => c.accion === "reserva");
  assert.equal(rsv.contacto_telefono, TEL); assert.equal(rsv.producto_id, PID); assert.equal(rsv.entrega_direccion, "Jl. Pantai Berawa 99, Canggu");
  assert.ok(!("precio_total" in rsv) && !("importe" in rsv) && !("total" in rsv) && !("km" in rsv), "la reserva no lleva importes");
  const orden = m.calls.map((c) => c.accion);
  assert.ok(orden.indexOf("reserva") < orden.indexOf("cliente"), "reserva → cliente");
  assert.equal(m.facturas.length, 1);
  assert.equal(m.facturas[0].external_id, `rsv:${RID}`); assert.equal(m.facturas[0].importe, 405000);
  assert.equal(m.facturas[0].duracionS, 3540 - MARGEN_CADUCIDAD_S, "el enlace caduca antes que la reserva");
  const pend = await m.pendingRsv.lee(TEL);
  assert.equal(pend.url, "https://checkout.xendit.co/web/abc"); assert.equal(pend.reserva_id, RID);
  assert.equal(await m.indice.teleDeExternalId(`rsv:${RID}`), TEL, "índice reserva→teléfono");
  assert.equal(await m.quotes.lee(TEL), null, "la cotización se gasta al reservar");
  assert.equal(await m.backend.bbmBackend(TEL), "erp", "la conversación queda fijada a erp");
  ok("cierre: reserva con lo guardado → cliente → enlace con el cobro de la base (sin comisión), pendiente + índice + pin erp");
  // segundo [PAY] con enlace vivo: mismo enlace, ninguna reserva nueva
  const antes = m.calls.length;
  const r2 = await m.cierre.cierra({ tel: TEL, mensajeId: "wamid.BBB=", payAmount: 405000, nombre: "Ana Pérez", pais: "Spain" });
  assert.equal(r2.ok, true); assert.equal(r2.reutilizado, true); assert.equal(r2.url, r.url);
  assert.equal(m.calls.length, antes, "no hay llamadas nuevas al ERP"); assert.equal(m.facturas.length, 1);
  ok("segundo [PAY] con un enlace vivo: reenvía el mismo, sin segunda reserva ni segunda factura");
}
{
  const m = montaCierre();
  await m.quotes.guarda(TEL, COT);
  for (const [monto, tag] of [[329999, "menos"], [330001, "más"], [null, "nulo"], [363000, "con comisión"], [3300000, "alucinado"]]) {
    const r = await m.cierre.cierra({ tel: TEL, mensajeId: "m", payAmount: monto, nombre: "Ana", pais: "Spain" });
    assert.equal(r.ok, false, tag); assert.equal(r.motivo, "importe_no_cuadra");
  }
  assert.ok(!m.calls.some((c) => c.accion === "reserva"), "importe que no cuadra: no se reserva");
  assert.equal(m.facturas.length, 0);
  ok("[PAY:x] distinto del total guardado (±1, con comisión, alucinado, nulo): no se reserva ni se cobra");
}
{
  const m = montaCierre();
  assert.equal((await m.cierre.cierra({ tel: TEL, mensajeId: "m", payAmount: 330000, nombre: "Ana", pais: "Spain" })).motivo, "sin_cotizacion");
  m.avisos.length = 0;
  await m.quotes.guarda(TEL, COT);
  for (const [nombre, pais] of [[undefined, "Spain"], ["Ana", undefined], ["", "Spain"], ["A", "Spain"], ["Ana", " "]]) {
    const r = await m.cierre.cierra({ tel: TEL, mensajeId: "m", payAmount: 330000, nombre, pais });
    assert.equal(r.motivo, "faltan_datos"); assert.match(r.texto, /name and your country/);
  }
  assert.ok(!m.calls.some((c) => c.accion === "reserva")); assert.equal(m.avisos.length, 0, "pedir el nombre no avisa al equipo");
  ok("sin cotización guardada, o sin nombre y país: no hay reserva ni enlace (y pedir el nombre no molesta al equipo)");
}
{
  // cada fallo deja un texto y avisa al equipo
  for (const [over, motivo, re] of [
    [{ reserva: () => [409, { error: "sin_disponibilidad" }] }, "sin_disponibilidad", /just taken/],
    [{ reserva: () => [429, { error: "tope_global" }] }, "tope_global", /lot of bookings/],
    [{ reserva: () => [502, { error: "base" }] }, "no_disponible", /flagged it to the team/],
    [{ reserva: () => [409, { error: "entrega_a_confirmar" }] }, "entrega_a_confirmar", /flagged it to the team/],
  ]) {
    const m = montaCierre(over);
    await m.quotes.guarda(TEL, COT);
    const r = await m.cierre.cierra({ tel: TEL, mensajeId: "m", payAmount: 330000, nombre: "Ana", pais: "Spain" });
    assert.equal(r.ok, false, motivo); assert.match(r.texto, re, motivo);
    assert.equal(m.facturas.length, 0, "sin reserva no hay enlace"); assert.ok(m.avisos.length >= 1, "avisa al equipo");
    assert.equal(await m.pendingRsv.lee(TEL), null);
  }
  ok("reserva rechazada (sin disponibilidad, tope, base caída, entrega a confirmar): texto de reserva, aviso al equipo, ningún enlace");
}
{
  const m = montaCierre({ reserva: (b) => [200, { r: { id: RID, numero_reserva: "R", estado: "bloqueo", caduca_en: "2099-01-01T00:00:00+00:00", desde: b.desde, hasta: b.hasta, dias: 3, precio_total: 350000, moneda: "IDR", lineas: [], cobro: { external_id: `rsv:${RID}`, importe: 350000, moneda: "IDR", segundos_hasta_caducar: 3540 } } }] });
  await m.quotes.guarda(TEL, COT);
  const r = await m.cierre.cierra({ tel: TEL, mensajeId: "m", payAmount: 330000, nombre: "Ana", pais: "Spain" });
  assert.equal(r.motivo, "precio_cambio"); assert.equal(m.facturas.length, 0); assert.ok(!m.calls.some((c) => c.accion === "cliente"));
  assert.equal(await m.quotes.lee(TEL), null, "la cotización vieja se borra: hay que recotizar");
  ok("la reserva sale a otro precio que lo cotizado: no se cobra, se avisa y se obliga a recotizar");
}
{
  const m = montaCierre({ cliente: () => [409, { error: "no_aplica" }] });
  await m.quotes.guarda(TEL, COT);
  const r = await m.cierre.cierra({ tel: TEL, mensajeId: "m", payAmount: 330000, nombre: "Ana", pais: "Spain" });
  assert.equal(r.ok, false); assert.equal(m.facturas.length, 0, "sin cliente no hay enlace");
  ok("cliente falla: sin enlace");
  const m2 = montaCierre({ cliente: () => [200, { r: { ok: true, cliente_identificado: false, creado: false, motivo: "telefono_ambiguo" } }] });
  await m2.quotes.guarda(TEL, COT);
  assert.equal((await m2.cierre.cierra({ tel: TEL, mensajeId: "m", payAmount: 330000, nombre: "Ana", pais: "Spain" })).ok, true);
  ok("cliente ambiguo (lo decide una persona): el cobro sigue");
}
{
  const m = montaCierre({}, { crearFactura: async () => null });
  await m.quotes.guarda(TEL, COT);
  const r = await m.cierre.cierra({ tel: TEL, mensajeId: "m", payAmount: 330000, nombre: "Ana", pais: "Spain" });
  assert.equal(r.ok, false); assert.match(r.texto, /flagged it to the team/); assert.equal(await m.pendingRsv.lee(TEL), null);
  ok("Xendit falla tras reservar: texto de reserva, nada pendiente (la reserva caduca sola)");
  const m2 = montaCierre({ reserva: (b) => [200, { r: { id: RID, numero_reserva: "R", estado: "bloqueo", caduca_en: "x", desde: b.desde, hasta: b.hasta, dias: 3, precio_total: 330000, moneda: "IDR", lineas: [], cobro: { external_id: `rsv:${RID}`, importe: 330000, moneda: "IDR", segundos_hasta_caducar: 400 } } }] });
  await m2.quotes.guarda(TEL, COT);
  const r2 = await m2.cierre.cierra({ tel: TEL, mensajeId: "m", payAmount: 330000, nombre: "Ana", pais: "Spain" });
  assert.equal(r2.motivo, "sin_tiempo"); assert.equal(m2.facturas.length, 0);
  ok("a la reserva le quedan menos de 7 min: no se manda un enlace que caduca a mitad de pagar");
}
{
  // teléfono: siempre el verificado, nunca otro
  const m = montaCierre();
  await m.quotes.guarda("628111222333", COT);
  await m.cierre.cierra({ tel: "+62 811-1222-333", mensajeId: "m", payAmount: 330000, nombre: "Ana", pais: "Spain" });
  assert.equal(m.calls.find((c) => c.accion === "reserva").contacto_telefono, "628111222333");
  ok("el teléfono de la reserva es el del webhook normalizado");
}

{
  // dos [PAY] simultáneos: una sola reserva
  const m = montaCierre();
  await m.quotes.guarda(TEL, COT);
  const [a, b] = await Promise.all([1, 2].map((i) => m.cierre.cierra({ tel: TEL, mensajeId: "m" + i, payAmount: 330000, nombre: "Ana", pais: "Spain" })));
  assert.equal(m.calls.filter((c) => c.accion === "reserva").length, 1, "una sola reserva");
  assert.equal(m.facturas.length, 1);
  assert.deepEqual([a.ok, b.ok].sort(), [false, true]); assert.ok([a, b].some((x) => x.motivo === "en_curso"));
  ok("dos [PAY] a la vez del mismo chat: una reserva, un enlace");
  // fallo de cliente o de Xendit tras reservar: el segundo [PAY] reutiliza la reserva (una sola llamada a reserva)
  let falla = true;
  const x = montaCierre({ cliente: () => (falla ? [409, { error: "no_aplica" }] : [200, { r: { ok: true, cliente_identificado: true, creado: true, motivo: null } }]) }, {});
  await x.quotes.guarda(TEL, COT);
  assert.equal((await x.cierre.cierra({ tel: TEL, mensajeId: "a", payAmount: 330000, nombre: "Ana", pais: "Spain" })).ok, false);
  falla = false;
  const r2 = await x.cierre.cierra({ tel: TEL, mensajeId: "b", payAmount: 330000, nombre: "Ana", pais: "Spain" });
  assert.equal(r2.ok, true); assert.equal(x.calls.filter((c) => c.accion === "reserva").length, 1, "una sola reserva");
  assert.equal(x.calls.filter((c) => c.accion === "cliente").length, 2);
  let xf = 0;
  const y = montaCierre({}, { crearFactura: async () => (xf++ ? { url: "https://checkout.xendit.co/web/z", id: "i" } : null) });
  await y.quotes.guarda(TEL, COT);
  assert.equal((await y.cierre.cierra({ tel: TEL, mensajeId: "a", payAmount: 330000, nombre: "Ana", pais: "Spain" })).ok, false);
  assert.equal((await y.cierre.cierra({ tel: TEL, mensajeId: "b", payAmount: 330000, nombre: "Ana", pais: "Spain" })).ok, true);
  assert.equal(y.calls.filter((c) => c.accion === "reserva").length, 1);
  ok("fallo de cliente o de Xendit tras reservar: el siguiente [PAY] reutiliza la reserva (una sola llamada a reserva)");
}

// ── 3) aviso al cliente cuando paga ───────────────────────────────────────────────────────────────────────────────────────────────────
{
  assert.match(textoPagoRecibido({ ok: true, factura: { numero: "INV-2026-0042", total: 330000, moneda: "IDR" } }, { importe: 330000, moneda: "IDR" }), /confirmed\. Your invoice number is INV-2026-0042/);
  assert.match(textoPagoRecibido({ ok: true, factura_espera: "sin_datos_fiscales" }, {}), /invoice is on its way/);
  assert.match(textoPagoRecibido({ ok: true }, {}), /invoice is on its way/);
  assert.match(textoPagoRecibido(null, {}), /Your booking is confirmed/);
  const rev = textoPagoRecibido({ revisar: true }, { importe: 330000, moneda: "IDR" });
  assert.match(rev, /checking your booking/); assert.ok(!/is confirmed/.test(rev), "pago a revisar: NO se dice confirmada");
  assert.ok(!/<|script|http/i.test(textoPagoRecibido({ ok: true, factura: { numero: "<script>http://x", total: 1 } }, {})), "un número de factura raro no se repite");
  ok("texto de pago recibido: número de factura solo si es válido; «a revisar» no dice confirmada; sin factura = «en camino»");
}
{
  const m = montaCierre();
  await m.quotes.guarda(TEL, COT);
  await m.cierre.cierra({ tel: TEL, mensajeId: "m", payAmount: 330000, nombre: "Ana", pais: "Spain" });
  const enviados = [], pagados = [], visto = new Set(), equipo = [];
  const aviso = createAvisoPago({
    indice: m.indice, pendingRsv: m.pendingRsv, backend: m.backend,
    dedupe: async (id) => { if (visto.has(id)) return false; visto.add(id); return true; },
    enviaCliente: async (t, txt) => { enviados.push([t, txt]); return { ok: true }; },
    marcaPagado: async (t, i, mo) => { pagados.push([t, i, mo]); }, avisaEquipo: async (t) => { equipo.push(t); }, log: silent, project: "T",
  });
  const cuerpo = { ok: true, factura: { numero: "INV-1", total: 330000, moneda: "IDR" } };
  const r = await aviso({ externalId: `rsv:${RID}`, invoiceId: "inv_1", cuerpo });
  assert.equal(r.avisado, true); assert.equal(enviados.length, 1); assert.equal(enviados[0][0], TEL); assert.match(enviados[0][1], /INV-1/);
  assert.deepEqual(pagados, [[TEL, 330000, "IDR"]]);
  assert.equal(await m.pendingRsv.lee(TEL), null, "pagado: el enlace pendiente se limpia");
  assert.equal(await m.backend.bbmBackend(TEL), "dion", "pagado: se suelta el pin");
  const r2 = await aviso({ externalId: `rsv:${RID}`, invoiceId: "inv_1", cuerpo });
  assert.equal(r2.motivo, "repetido"); assert.equal(enviados.length, 1, "el reintento de Xendit no duplica el aviso");
  ok("aviso de pago: llega al chat de la reserva, marca pagado, limpia estado, no se duplica en el reintento");
  const r3 = await aviso({ externalId: `rsv:9a1e6c1a-0d52-4e0e-8a77-7f0b6f3a9999`, invoiceId: "inv_2", cuerpo });
  assert.equal(r3.motivo, "sin_telefono"); assert.ok(equipo.some((e) => /no sé a qué chat/.test(e)), "reserva sin índice: avisa al equipo, no se calla");
  const r4 = await aviso({ externalId: `rsv:${RID}`, invoiceId: "inv_3", cuerpo: { ignorado: true } });
  assert.equal(r4.motivo, "ignorado");
  ok("pago sin índice → aviso al equipo; cuerpo «ignorado» → nada");
}
{
  const m = montaCierre();
  await m.indice.guarda(RID, TEL);
  const enviados = [], pagados = [];
  const aviso = createAvisoPago({ indice: m.indice, pendingRsv: m.pendingRsv, backend: m.backend, enviaCliente: async (t, x) => { enviados.push(x); return { ok: true }; }, marcaPagado: async () => { pagados.push(1); }, log: silent });
  await aviso({ externalId: `rsv:${RID}`, invoiceId: "i", cuerpo: { revisar: true } });
  assert.equal(pagados.length, 0, "pago a revisar: el lead NO pasa a ganado"); assert.match(enviados[0], /checking your booking/);
  ok("pago a revisar: se avisa al cliente con prudencia y el lead no se marca ganado");
}

{
  const m = montaCierre();
  await m.indice.guarda(RID, TEL);
  const equipo = [];
  const aviso = createAvisoPago({ indice: m.indice, pendingRsv: m.pendingRsv, backend: m.backend, enviaCliente: async () => ({ ok: false }), avisaEquipo: async (x) => { equipo.push(x); }, log: silent });
  const r = await aviso({ externalId: `rsv:${RID}`, invoiceId: "i", cuerpo: { ok: true } });
  assert.equal(r.avisado, false); assert.ok(equipo.some((x) => /NO se pudo avisar al cliente/.test(x)), "si WhatsApp falla, el equipo lo sabe");
  ok("si el aviso por WhatsApp falla, se avisa al equipo (no se calla)");
}

// ── 4) sombra ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const { erp, calls } = mkErp();
  const s = createSombra({ erp, n: 3, log: silent, project: "T" });
  const dion = { ok: true, bike: "Honda Scoopy", from: FUT, to: FUT2, duration_days: 3, rental_rate: 300000 };
  await s.observa(dion); await s.observa(dion);
  let e = await s.estado();
  assert.equal(e.coincide, 2); assert.equal(e.diverge, 0); assert.equal(e.listo, false);
  await s.observa(dion);
  e = await s.estado(); assert.equal(e.listo, true);
  assert.deepEqual([...new Set(calls.map((c) => c.accion))].sort(), ["catalogo", "cotiza"], "la sombra solo usa catalogo y cotiza");
  assert.ok(calls.filter((c) => c.accion === "cotiza").every((c) => !("entrega_direccion" in c) && !("recogida_direccion" in c)), "ni dirección ni entrega en la sombra");
  ok("sombra: coincidencias cuentan hasta N y marcan «listo»; solo catalogo+cotiza y sin direcciones");
  await s.observa({ ...dion, rental_rate: 310000 });
  e = await s.estado(); assert.equal(e.diverge, 1); assert.equal(e.listo, false, "una divergencia quita el «listo»"); assert.deepEqual(e.ultima_divergencia.motivos, ["precio"]);
  await s.observa({ ...dion, duration_days: 4 });
  assert.deepEqual((await s.estado()).ultima_divergencia.motivos, ["dias"]);
  await s.observa({ ...dion, bike: "Moto Fantasma" });
  assert.deepEqual((await s.estado()).ultima_divergencia.motivos, ["moto_sin_equivalente"]);
  ok("sombra: precio, días y moto sin equivalente se registran como divergencia (sin teléfonos ni textos)");
  assert.ok(!JSON.stringify(await s.estado()).match(/\b62\d{8,}\b/));
}
{
  const { erp } = mkErp({ cotiza: (b) => [200, { r: { dias: 3, precio: 1, total: 330000, moneda: "IDR", precio_alquiler: 300000, incluye_impuesto: false, impuesto: null, lineas: [{ descripcion: "x", base: 1, cuota: 0, bruto: 1 }], producto_id: b.producto_id, desde: b.desde, hasta: b.hasta, disponibles: 0 } }] });
  const s = createSombra({ erp, log: silent });
  await s.observa({ ok: true, bike: "Honda Scoopy", from: FUT, to: FUT2, duration_days: 3, rental_rate: 300000 });
  assert.deepEqual((await s.estado()).ultima_divergencia.motivos, ["disponibilidad"]);
  ok("sombra: el ERP sin unidades libres es divergencia de disponibilidad");
  const caido = createBbmErp({ url: "https://erp.test", secret: "s".repeat(20), fetchImpl: async () => { throw new Error("red"); }, log: silent });
  const s2 = createSombra({ erp: caido, log: silent });
  await s2.observa({ ok: true, bike: "Honda Scoopy", from: FUT, to: FUT2, duration_days: 3, rental_rate: 300000 });
  const e = await s2.estado(); assert.equal(e.sin_erp, 1); assert.equal(e.diverge, 0);
  await s2.observa(null); await s2.observa({ ok: false }); await createSombra({ erp: createBbmErp({ log: silent }), log: silent }).observa({ ok: true, bike: "x", from: FUT, to: FUT2 });
  ok("sombra: ERP caído/no configurado no cuenta como divergencia y nunca lanza");
}
{
  // Redis de mentira: los contadores persisten
  const h = {};
  const redis = { hIncrBy: async (k, f, v) => { h[f] = (h[f] || 0) + v; }, hSet: async (k, f, v) => { h[f] = v; }, hGetAll: async () => Object.fromEntries(Object.entries(h).map(([k, v]) => [k, String(v)])) };
  const { erp } = mkErp();
  const s = createSombra({ erp, redis: () => redis, n: 1, log: silent });
  await s.observa({ ok: true, bike: "Honda Scoopy", from: FUT, to: FUT2, duration_days: 3, rental_rate: 300000 });
  const s2 = createSombra({ erp, redis: () => redis, n: 1, log: silent });
  assert.equal((await s2.estado()).coincide, 1); assert.equal((await s2.estado()).listo, true);
  ok("sombra: los contadores viven en Redis (sobreviven a un reinicio)");
}

// ── 5) prompt y herramienta ──────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  assert.equal(ERP_QUOTE_TOOL.name, "get_quote");
  assert.ok(!/hotel name/i.test(ERP_QUOTE_TOOL.description.replace(/Do NOT use the name of a hotel[^.]*\./i, "")), "la herramienta no sugiere nombres de alojamiento");
  assert.match(ERP_PROMPT_BLOCK, /NO extra payment fee/); assert.match(ERP_PROMPT_BLOCK, /EXACTLY the `total`/); assert.match(ERP_PROMPT_BLOCK, /name AND their country/);
  assert.match(ERP_PROMPT_BLOCK, /only use your address|only use your address to calculate/i);
  assert.ok(!/https?:\/\//.test(ERP_PROMPT_BLOCK));
  ok("prompt/herramienta erp: sin comisión, [PAY] = total exacto, nombre y país, frase de privacidad, sin nombres de alojamiento");
}

console.log(`\n${n} bloques OK`);
