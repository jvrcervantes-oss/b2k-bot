// Prueba de punta a punta del modo erp de BBM contra un DOBLE del ERP con estado (F3 Entrega 2, camino B del owner, 12-oct-2026).
// Lo que se prueba es el bot REAL (bbmerp.js + bbmflow.js + xendit-rsv.js); lo único de mentira es la red: las tres edges del ERP (reservas-bot,
// reservas-enlace, reservas-pago) las contesta un doble que guarda reservas, enlaces y pagos como lo haría la base. Sin red, sin Redis.
//   Camino bueno: cotiza → [PAY] → reserva → cliente → enlace (lo crea el ERP) → Xendit avisa del pago (con el token de Ajustes, no el de Railway)
//                 → reservas-pago confirma y emite la factura → el cliente recibe «confirmada» con su número de factura.
//   Caminos de error: sin configurar (en cotiza, en reserva y en el enlace), tope, sin disponibilidad, caída del ERP, Xendit caído.
// Contrato que imita el doble: bbmerp.contract.json (copias sin aterrizar de p21 y p23 del 12-oct). Ejecutar: node test-corte-erp.js
import assert from "node:assert";
import { createBbmErp, createBackendSwitch, createPendingRsv } from "./bbmerp.js";
import { createQuoteStore, createReservaIndex, createErpTools, createCierreErp, createAvisoPago } from "./bbmflow.js";
import { createRsvForwarder, createXenditGate } from "./xendit-rsv.js";

const silent = { warn() {}, error() {}, log() {} };
let n = 0;
const ok = (m) => { n++; console.log("ok -", m); };

const URL_ERP = "https://bbm.erp.test";
const SECRET = "bbm-reservas-secret-0123456789abcdef0123";
const TOKEN_AJUSTES = "tok_de_Ajustes_Cobros_0123456789";   // el que el cliente pegó en Ajustes › Cobros (Vault)
const TOKEN_RAILWAY = "tok-railway-viejo-9876543210";        // el XENDIT_CALLBACK_TOKEN de Railway (flujo de Dion): NO hace falta para rsv:
const TEL = "628123456789";
const PID = "3f0c1b1e-7b1a-4c53-9a53-2a6f0f5c1111";
let ahora = Date.parse("2099-10-20T09:00:00Z");

// ── el doble del ERP ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
function dobleErp(cfg = {}) {
  const st = {
    falta: cfg.falta ?? null,               // paso de reservas-producto sin hacer (impuesto_pkp, flota…) → cotiza y reserva dan 409
    cobros: cfg.cobros ?? true,             // Ajustes › Cobros configurado (clave de creación en Vault)
    cobrosSeBorra: false,                   // la clave desaparece DESPUÉS de reservar
    unidades: cfg.unidades ?? 2,
    tope: cfg.tope ?? null,                 // 'tope_telefono' | 'tope_global'
    caido: cfg.caido ?? false,
    xenditCaido: cfg.xenditCaido ?? false,
    reservas: new Map(), facturas: [], invoices: new Map(), llamadas: [],
  };
  let seq = 0;
  const precio = 330000;
  const r = (status, body) => ({ status, json: async () => body });
  const uuid = () => `9a1e6c1a-0d52-4e0e-8a77-${String(++seq).padStart(12, "0")}`;
  const vivas = () => [...st.reservas.values()].filter((x) => x.estado === "bloqueo" && x.caduca > ahora);

  function reservasBot(b) {
    if (b.accion === "catalogo") return r(200, { r: [{ id: PID, numero_producto: "P-1", nombre: "Honda Scoopy", descripcion: "x", unidad: "moto", tarifas: [{ dias: 1, precio: 110000, moneda: "IDR", etiqueta: null }], unidades: 3 }] });
    if (b.accion === "cotiza") {
      if (st.falta) return r(409, { error: "sin_configurar", paso: st.falta });
      return r(200, { r: { dias: 3, precio, total: precio, moneda: "IDR", precio_alquiler: 300000, desglose: null, base: 300000, impuestos: 30000, incluye_impuesto: false, impuesto: { nombre: "PB1", porcentaje: 10 }, lineas: [{ descripcion: "Honda Scoopy", concepto: "alquiler", base: 300000, cuota: 30000, bruto: precio }], producto_id: b.producto_id, desde: b.desde, hasta: b.hasta, disponibles: st.unidades - vivas().length } });
    }
    if (b.accion === "reserva") {
      if (st.falta) return r(409, { error: "sin_configurar", paso: st.falta });
      if (!st.cobros) return r(409, { error: "sin_configurar", paso: "cobros" });   // la base aborta ENTERA: no deja bloqueo
      if (st.tope) return r(429, { error: st.tope });
      if (st.unidades - vivas().length < 1) return r(409, { error: "sin_disponibilidad" });
      const id = uuid();
      st.reservas.set(id, { id, tel: b.contacto_telefono, estado: "bloqueo", caduca: ahora + 3540_000, cliente: null, enlace: null, importe: precio });
      return r(200, { r: { id, numero_reserva: `RSV-${seq}`, estado: "bloqueo", caduca_en: new Date(ahora + 3540_000).toISOString(), desde: b.desde, hasta: b.hasta, dias: 3, precio_total: precio, moneda: "IDR", desglose: null, base: 300000, impuestos: 30000, incluye_impuesto: false, lineas: [{ descripcion: "Honda Scoopy", base: 300000 }], cobro: { external_id: `rsv:${id}`, importe: precio, moneda: "IDR", segundos_hasta_caducar: 3540 } } });
    }
    if (b.accion === "cliente") {
      const x = st.reservas.get(b.reserva_id);
      if (!x || x.estado !== "bloqueo" || x.cliente) return r(409, { error: "no_aplica" });
      x.cliente = { nombre: b.nombre, pais: b.pais };
      return r(200, { r: { ok: true, cliente_identificado: true, creado: true, motivo: null } });
    }
    return r(400, { error: "accion" });
  }

  function reservasEnlace(b) {
    const extra = Object.keys(b).filter((k) => k !== "reserva_id");
    if (extra.length) return r(400, { error: "campo_no_admitido", campos: extra });
    const x = st.reservas.get(b.reserva_id);
    if (!x || x.estado !== "bloqueo" || x.caduca - ahora < 300_000) return r(409, { error: "no_pagable" });
    if (x.enlace && x.enlace.caduca > ahora) return r(200, { r: { url: x.enlace.url, caduca_en: new Date(x.enlace.caduca).toISOString(), external_id: `rsv:${x.id}`, repetido: true } });
    if (!st.cobros || st.cobrosSeBorra) return r(409, { error: "sin_configurar", paso: "cobros" });
    if (st.xenditCaido) return r(502, { error: "proveedor" });
    const inv = `inv_${x.id.slice(-6)}`;
    x.enlace = { inv, url: `https://checkout.xendit.co/web/${inv}`, caduca: x.caduca - 120_000 };
    st.invoices.set(inv, { reserva: x.id, importe: x.importe, estado: "PENDING" });
    return r(200, { r: { url: x.enlace.url, caduca_en: new Date(x.enlace.caduca).toISOString(), external_id: `rsv:${x.id}`, repetido: false } });
  }

  // reservas-pago: valida el token contra el de Ajustes (Vault), NO se fía del cuerpo (vuelve a mirar el invoice) y emite la factura una vez
  function reservasPago(raw, token) {
    if (token !== TOKEN_AJUSTES) return r(401, { error: "token" });
    let b; try { b = JSON.parse(raw); } catch { return r(400, { error: "json" }); }
    const inv = st.invoices.get(b.id);
    if (!inv || `rsv:${inv.reserva}` !== b.external_id) return r(200, { ignorado: true });
    inv.estado = "PAID";   // «Xendit dice que está pagado» (en la real: GET /v2/invoices/{id})
    const x = st.reservas.get(inv.reserva);
    if (x.estado === "confirmada") return r(200, { ok: true, factura: { numero: x.factura, total: x.importe, moneda: "IDR" } });
    if (x.estado !== "bloqueo") return r(200, { revisar: true });
    x.estado = "confirmada"; x.factura = `BBM-2099-${String(st.facturas.length + 1).padStart(4, "0")}`;
    st.facturas.push({ numero: x.factura, reserva: x.id, total: x.importe, cliente: x.cliente });
    return r(200, { ok: true, factura: { numero: x.factura, total: x.importe, moneda: "IDR" } });
  }

  const fetchImpl = async (url, init) => {
    if (st.caido) throw new TypeError("fetch failed");
    const edge = String(url).replace(`${URL_ERP}/functions/v1/`, "");
    if (edge === "reservas-pago") { st.llamadas.push({ edge }); return reservasPago(String(init.body), init.headers["x-callback-token"]); }
    assert.equal(init.headers["x-bot-secret"], SECRET);
    const b = JSON.parse(init.body);
    st.llamadas.push({ edge, ...b });
    if (edge === "reservas-bot") return reservasBot(b);
    if (edge === "reservas-enlace") return reservasEnlace(b);
    return r(404, { code: "NOT_FOUND" });
  };
  return { st, fetchImpl };
}

// ── el bot montado como en index.js, sin Express ni Redis ────────────────────────────────────────────────────────────────────────
function monta(cfg) {
  const d = dobleErp(cfg);
  const erp = createBbmErp({ url: URL_ERP, secret: SECRET, fetchImpl: d.fetchImpl, now: () => ahora, log: silent, project: "T" });
  const quotes = createQuoteStore({ now: () => ahora });
  const pendingRsv = createPendingRsv({ now: () => ahora });
  const indice = createReservaIndex({ now: () => ahora });
  const backend = createBackendSwitch({ log: silent, now: () => ahora, enlaceVivo: async (t) => !!(await pendingRsv.lee(t)) });
  const ficha = new Map();                 // lead:<tel> → { pidePersona, intent }, como updateLeadFields
  const equipo = [], alCliente = [], pagados = [];
  const derivaPersona = async (t, motivo) => { const l = ficha.get(t) || {}; if (!l.pidePersona) ficha.set(t, { ...l, pidePersona: ahora, intent: "human", motivo }); };
  const avisaEquipo = async (x) => { equipo.push(x); };
  const tools = createErpTools({ erp, quotes, derivaPersona, log: silent, project: "T", hoy: () => "2099-10-20" });
  const cierre = createCierreErp({ erp, quotes, pendingRsv, indice, backend, avisaEquipo, derivaPersona, now: () => ahora, log: silent, project: "T" });
  const vistos = new Set();
  const aviso = createAvisoPago({
    indice, pendingRsv, backend, dedupe: async (id) => { if (vistos.has(id)) return false; vistos.add(id); return true; },
    enviaCliente: async (t, x) => { alCliente.push([t, x]); return { ok: true }; }, marcaPagado: async (t, i, m) => { pagados.push([t, i, m]); },
    avisaEquipo, derivaPersona, log: silent, project: "T",
  });
  const gate = createXenditGate({ token: TOKEN_RAILWAY, forwarder: createRsvForwarder({ erpUrl: URL_ERP, fetchImpl: d.fetchImpl, log: silent, project: "T" }), onResultado: aviso, ipDe: () => "203.0.113.7", log: silent, project: "T" });
  // un aviso de Xendit tal como llega al bot
  const xendit = async (body, token = TOKEN_AJUSTES) => {
    const raw = JSON.stringify(body);
    const req = { get: (h) => (h.toLowerCase() === "x-callback-token" ? token : undefined), body, rawBody: Buffer.from(raw), ip: "203.0.113.7" };
    const res = { code: null, sendStatus(c) { res.code = c; return res; } };
    let siguio = false;
    await gate(req, res, () => { siguio = true; });
    return { code: res.code, siguio };
  };
  const cotiza = (extra = {}) => tools.runGetQuote(TEL, { bike_model: "Honda Scoopy", from: "2099-11-01", to: "2099-11-04", ...extra });
  const paga = (monto = 330000, extra = {}) => cierre.cierra({ tel: TEL, mensajeId: "wamid.X", payAmount: monto, nombre: "Ana Pérez", pais: "Spain", ...extra });
  return { d, st: d.st, ficha, equipo, alCliente, pagados, cotiza, paga, xendit, pendingRsv, backend, quotes };
}

// ── 1. el camino completo ─────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const b = monta();
  const q = await b.cotiza();
  assert.equal(q.ok, true); assert.equal(q.total, 330000); assert.equal(q.available, true);
  const p = await b.paga();
  assert.equal(p.ok, true, JSON.stringify(p)); assert.match(p.url, /^https:\/\/checkout\.xendit\.co\/web\/inv_/);
  const enl = b.st.llamadas.filter((c) => c.edge === "reservas-enlace");
  assert.equal(enl.length, 1); assert.deepEqual(Object.keys(enl[0]).sort(), ["edge", "reserva_id"], "al ERP solo va el id de la reserva");
  const [rid] = [...b.st.reservas.keys()];
  assert.equal(b.st.reservas.get(rid).cliente.nombre, "Ana Pérez", "cliente antes del enlace");
  assert.equal(await b.backend.bbmBackend(TEL), "erp", "con el enlace vivo la conversación es del ERP");
  // el cliente pierde el enlace y vuelve a pagar: el mismo, sin otra reserva
  const p2 = await b.paga();
  assert.equal(p2.url, p.url); assert.equal(b.st.reservas.size, 1);
  // Xendit avisa del pago con el token de AJUSTES (el de Railway es otro): el bot lo reenvía y decide la edge
  const inv = b.st.reservas.get(rid).enlace.inv;
  const aviso = { id: inv, external_id: `rsv:${rid}`, status: "PAID", amount: 330000 };
  const x = await b.xendit(aviso);
  assert.deepEqual(x, { code: 200, siguio: false });
  assert.equal(b.st.reservas.get(rid).estado, "confirmada"); assert.equal(b.st.facturas.length, 1, "la base emite UNA factura");
  assert.equal(b.alCliente.length, 1); assert.equal(b.alCliente[0][0], TEL);
  assert.match(b.alCliente[0][1], /Payment received — 330\.000 IDR\. Thank you! Your booking is confirmed\. Your invoice number is BBM-2099-0001\./);
  assert.deepEqual(b.pagados, [[TEL, 330000, "IDR"]]);
  assert.equal(await b.pendingRsv.lee(TEL), null); assert.equal(await b.backend.bbmBackend(TEL), "dion", "pagado: la conversación se suelta");
  // Xendit reintenta el mismo aviso: ni otra factura ni otro mensaje
  assert.equal((await b.xendit(aviso)).code, 200);
  assert.equal(b.st.facturas.length, 1); assert.equal(b.alCliente.length, 1);
  assert.equal(b.ficha.size, 0, "todo bien: nadie queda «por responder»");
  ok("camino completo: cotiza → reserva → cliente → enlace del ERP → pago (token de Ajustes) → factura → «confirmada, factura BBM-2099-0001»; reintentos sin duplicar");
}

// ── 2. un aviso con un token que no es el de Ajustes no confirma nada ─────────────────────────────────────────────────────────────
{
  const b = monta();
  await b.cotiza(); const p = await b.paga(); assert.equal(p.ok, true);
  const [rid] = [...b.st.reservas.keys()];
  const falso = { id: b.st.reservas.get(rid).enlace.inv, external_id: `rsv:${rid}`, status: "PAID", amount: 330000 };
  assert.equal((await b.xendit(falso, "un_token_inventado_0123456789")).code, 502, "la edge lo rechaza (401) → 502");
  assert.equal((await b.xendit(falso, TOKEN_RAILWAY)).code, 502, "el token de Railway tampoco sirve para rsv: (el de verdad es el de Ajustes)");
  assert.equal(b.st.reservas.get(rid).estado, "bloqueo"); assert.equal(b.alCliente.length, 0);
  ok("aviso rsv: con un token que no es el de Ajustes: la edge lo rechaza, nada se confirma, el cliente no recibe nada");
}

// ── 3. sin configurar ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  // (a) falta un paso del ERP (impuesto): no se cotiza, se dice sin plazos y queda «por responder»
  const a = monta({ falta: "impuesto_pkp" });
  const q = await a.cotiza();
  assert.equal(q.ok, false); assert.equal(q.error, "booking_not_available"); assert.ok(!("total" in q), "ningún precio");
  assert.match(q.note, /person from the team will continue/); assert.match(q.note, /do NOT promise a time, a payment link/);
  assert.equal(a.ficha.get(TEL).pidePersona, ahora); assert.equal(a.ficha.get(TEL).intent, "human");
  // el turno siguiente: el cliente insiste en pagar con un [PAY] alucinado → nada, y la petición de persona sigue ahí
  const p = await a.paga();
  assert.equal(p.ok, false); assert.equal(p.motivo, "sin_cotizacion"); assert.equal(a.st.reservas.size, 0);
  assert.ok(a.ficha.get(TEL).pidePersona, "la petición de persona no se pierde en el turno siguiente");
  // (b) Cobros sin configurar: la reserva se aborta ENTERA (no queda bloqueo) y el texto no promete cobro
  const b = monta({ cobros: false });
  assert.equal((await b.cotiza()).ok, true);
  const pb = await b.paga();
  assert.deepEqual([pb.ok, pb.motivo], [false, "sin_configurar"]); assert.equal(b.st.reservas.size, 0, "sin bloqueo");
  assert.equal(pb.texto, "Online payment isn't available for this booking yet. A person from our team will continue with you here in this chat to complete it.");
  assert.ok(!/minute|shortly|link|reserved|held/i.test(pb.texto), "sin plazos, sin enlace, sin «reservada»");
  assert.ok(b.equipo.some((e) => /sin_configurar \(paso cobros\)/.test(e))); assert.equal(b.ficha.get(TEL).motivo, "sin_configurar");
  // (c) la clave de Cobros desaparece DESPUÉS de reservar: sin enlace, la reserva caduca sola, «por responder»
  const c = monta();
  await c.cotiza(); c.st.cobrosSeBorra = true;
  const pc = await c.paga();
  assert.deepEqual([pc.ok, pc.motivo], [false, "sin_configurar"]); assert.equal(await c.pendingRsv.lee(TEL), null);
  assert.ok(c.ficha.get(TEL));
  ok("sin configurar (impuesto en cotiza, cobros en reserva, cobros en el enlace): sin precio ni enlace ni plazos, «por responder», y sigue así el turno siguiente");
}

// ── 4. tope, sin disponibilidad ───────────────────────────────────────────────────────────────────────────────────────────────────
{
  const t = monta({ tope: "tope_telefono" });
  await t.cotiza(); const pt = await t.paga();
  assert.deepEqual([pt.ok, pt.motivo], [false, "tope"]); assert.match(pt.texto, /lot of bookings/); assert.ok(t.ficha.get(TEL), "el texto promete al equipo: «por responder»");
  const s = monta({ unidades: 1 });
  await s.cotiza();
  // otro cliente se lleva la única moto entre la cotización y el pago
  s.st.reservas.set("otro", { id: "otro", estado: "bloqueo", caduca: ahora + 3_000_000 });
  const ps = await s.paga();
  assert.deepEqual([ps.ok, ps.motivo], [false, "sin_disponibilidad"]); assert.match(ps.texto, /just taken/);
  assert.equal(s.ficha.size, 0, "sin disponibilidad se ofrecen otras fechas: no queda «por responder»"); assert.equal(s.equipo.length, 0);
  const qs = await s.cotiza();
  assert.deepEqual([qs.ok, qs.available], [true, false], "la siguiente cotización ya dice que no hay");
  ok("tope → texto de espera, al equipo y «por responder»; sin disponibilidad → otras fechas, sin molestar al equipo");
}

// ── 5. caídas ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  // ERP caído al cotizar: no se da precio
  const a = monta({ caido: true });
  const q = await a.cotiza();
  assert.equal(q.ok, false); assert.match(q.error, /unreachable/); assert.match(q.error, /Do NOT give a price/);
  assert.equal(a.ficha.size, 0, "una caída no es «sin configurar»");
  // Xendit caído al crear el enlace: sin enlace, la reserva queda; al volver, el siguiente [PAY] la reutiliza y no repite `cliente`
  const b = monta({ xenditCaido: true });
  await b.cotiza();
  const p1 = await b.paga();
  assert.deepEqual([p1.ok, p1.motivo], [false, "generico"]); assert.match(p1.texto, /flagged it to the team/);
  assert.equal(b.st.reservas.size, 1); assert.ok(b.ficha.get(TEL));
  b.st.xenditCaido = false;
  const p2 = await b.paga();
  assert.equal(p2.ok, true, JSON.stringify(p2)); assert.equal(b.st.reservas.size, 1, "la misma reserva");
  assert.equal(b.st.llamadas.filter((c) => c.accion === "cliente").length, 1, "`cliente` una sola vez (la base daría no_aplica al segundo)");
  // ERP caído al pagar después de cotizar: genérico, sin enlace
  const c = monta();
  await c.cotiza(); c.st.caido = true;
  const pc = await c.paga();
  assert.deepEqual([pc.ok, pc.motivo], [false, "generico"]); assert.equal(await c.pendingRsv.lee(TEL), null);
  // ERP caído cuando llega el aviso de pago: 502 para que Xendit reintente; al volver, se confirma
  const e = monta();
  await e.cotiza(); await e.paga();
  const [rid] = [...e.st.reservas.keys()];
  const av = { id: e.st.reservas.get(rid).enlace.inv, external_id: `rsv:${rid}`, status: "PAID", amount: 330000 };
  e.st.caido = true;
  assert.equal((await e.xendit(av)).code, 502); assert.equal(e.alCliente.length, 0);
  e.st.caido = false;
  assert.equal((await e.xendit(av)).code, 200); assert.equal(e.st.facturas.length, 1); assert.equal(e.alCliente.length, 1);
  ok("caídas: sin precio al cotizar; Xendit caído → reintento sobre la misma reserva sin repetir `cliente`; aviso con el ERP caído → 502 y se confirma al reintentar");
}

// ── 6. la reserva deja de ser pagable entre dos [PAY]: lo dice el ERP (no_pagable), no un cálculo del bot ─────────────────────────
{
  const b = monta({ xenditCaido: true });
  await b.cotiza();
  assert.equal((await b.paga()).ok, false);                     // reserva hecha, enlace fallido: la reserva queda guardada
  const [rid] = [...b.st.reservas.keys()];
  b.st.reservas.get(rid).estado = "cancelada";                  // el equipo la anula desde el ERP
  b.st.xenditCaido = false;
  const p = await b.paga();
  assert.deepEqual([p.ok, p.motivo], [false, "sin_tiempo"]); assert.match(p.texto, /hold is about to run out/);
  assert.equal(await b.quotes.lee(TEL), null, "no_pagable: cotización y reserva guardada se borran (hay que recotizar)");
  assert.equal(await b.pendingRsv.lee(TEL), null);
  // y recotizar abre una reserva nueva con su enlace
  await b.cotiza();
  const p2 = await b.paga();
  assert.equal(p2.ok, true); assert.equal(b.st.reservas.size, 2);
  ok("la reserva deja de ser pagable (anulada en el ERP): no_pagable → sin enlace, se recotiza y la nueva reserva sí cobra");
}

console.log(`\n${n} bloques OK`);
