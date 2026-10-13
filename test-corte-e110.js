// E1.10 (13-oct-2026, bbm-corte-bot): lo que cambia en el modo erp de BBM para el día del corte, contra un doble del ERP sin red ni Redis.
//   1. Reglas de reserva de Ajustes (F3-E3: días mínimo, máximo y antelación): la edge las devuelve como 409 con el hint de la base y su texto en
//      español; el bot le dice la REGLA al cliente (sin precio, sin «el equipo confirma», sin derivar a una persona).
//   2. Los textos fijos del cierre y del aviso de pago salen en el idioma del cliente (id, es; otro, inglés), y el idioma viaja con el enlace.
//   3. no_pagable (que también es «total con decimales en IDR») ya no le dice al cliente que su reserva va a caducar.
//   4. El seguro: sin instrucción propia en modo erp hasta que decida el owner (es dinero).
// Ejecutar: node --test test-corte-e110.js
import assert from "node:assert";
import { createBbmErp, createPendingRsv, valorRegla, REGLAS_FECHAS, leeTelefonosErp } from "./bbmerp.js";
import { createQuoteStore, createReservaIndex, createErpTools, createCierreErp, createAvisoPago, textoPagoRecibido, textoFallo, TEXTOS_FALLO, notaReglaFechas, ERP_PROMPT_BLOCK } from "./bbmflow.js";
import { createBackendSwitch } from "./bbmerp.js";

const silent = { warn() {}, error() {}, log() {} };
let n = 0;
const ok = (m) => { n++; console.log("ok -", m); };
const URL_ERP = "https://bbm.erp.test";
const SECRET = "bbm-reservas-secret-0123456789abcdef0123";
const TEL = "628123456789";
const PID = "3f0c1b1e-7b1a-4c53-9a53-2a6f0f5c1111";
let ahora = Date.parse("2099-10-20T09:00:00Z");
const r = (status, body) => ({ status, json: async () => body });

// Doble mínimo: la cotización contesta lo que diga `cotiza` (una función del cuerpo); reserva, cliente y enlace, el camino bueno o `enlace`.
function monta({ cotiza, enlace } = {}) {
  const llamadas = [];
  const fetchImpl = async (url, init) => {
    const edge = String(url).replace(`${URL_ERP}/functions/v1/`, "");
    const b = JSON.parse(init.body);
    llamadas.push({ edge, ...b });
    if (edge === "reservas-bot") {
      if (b.accion === "catalogo") return r(200, { r: [{ id: PID, numero_producto: "P-1", nombre: "Honda Scoopy", descripcion: null, unidad: "moto", tarifas: [{ dias: 1, precio: 110000, moneda: "IDR", etiqueta: null }], unidades: 2 }] });
      if (b.accion === "cotiza") return cotiza ? cotiza(b) : r(200, { r: { dias: 3, precio: 330000, total: 330000, moneda: "IDR", incluye_impuesto: true, impuesto: null, lineas: [{ descripcion: "Honda Scoopy", base: 330000, cuota: 0, bruto: 330000 }], producto_id: PID, desde: b.desde, hasta: b.hasta, disponibles: 2 } });
      if (b.accion === "reserva") return r(200, { r: { id: "9a1e6c1a-0d52-4e0e-8a77-000000000001", numero_reserva: "RSV-1", estado: "bloqueo", caduca_en: new Date(ahora + 3540_000).toISOString(), desde: b.desde, hasta: b.hasta, dias: 3, precio_total: 330000, moneda: "IDR", incluye_impuesto: true, lineas: [], cobro: { external_id: "rsv:9a1e6c1a-0d52-4e0e-8a77-000000000001", importe: 330000, moneda: "IDR", segundos_hasta_caducar: 3540 } } });
      if (b.accion === "cliente") return r(200, { r: { ok: true, cliente_identificado: true, creado: true, motivo: null } });
    }
    if (edge === "reservas-enlace") return enlace ? enlace(b) : r(200, { r: { url: "https://checkout.xendit.co/web/inv_1", caduca_en: new Date(ahora + 3400_000).toISOString(), external_id: `rsv:${b.reserva_id}`, repetido: false } });
    return r(404, {});
  };
  const erp = createBbmErp({ url: URL_ERP, secret: SECRET, fetchImpl, now: () => ahora, log: silent, project: "T" });
  const quotes = createQuoteStore({ now: () => ahora });
  const pendingRsv = createPendingRsv({ now: () => ahora });
  const indice = createReservaIndex({ now: () => ahora });
  const backend = createBackendSwitch({ log: silent, now: () => ahora, enlaceVivo: async (t) => !!(await pendingRsv.lee(t)) });
  const personas = [], equipo = [], alCliente = [];
  const derivaPersona = async (t, motivo) => { personas.push([t, motivo]); return true; };
  const avisaEquipo = async (x) => { equipo.push(x); };
  const tools = createErpTools({ erp, quotes, derivaPersona, log: silent, project: "T", hoy: () => "2099-10-20" });
  const cierre = createCierreErp({ erp, quotes, pendingRsv, indice, backend, avisaEquipo, derivaPersona, now: () => ahora, log: silent, project: "T" });
  const aviso = createAvisoPago({ indice, pendingRsv, backend, dedupe: async () => true, enviaCliente: async (t, x) => { alCliente.push(x); return { ok: true }; }, avisaEquipo, derivaPersona, log: silent, project: "T" });
  const cotizaBot = () => tools.runGetQuote(TEL, { bike_model: "Honda Scoopy", from: "2099-11-01", to: "2099-11-04" });
  const paga = (idioma) => cierre.cierra({ tel: TEL, mensajeId: "wamid.X", payAmount: 330000, nombre: "Ana Pérez", pais: "Spain", idioma });
  return { llamadas, quotes, pendingRsv, personas, equipo, alCliente, cotizaBot, paga, aviso };
}

// ── 1. reglas de fechas ───────────────────────────────────────────────────────────────────────
{
  assert.deepEqual([...REGLAS_FECHAS].sort(), ["reserva_dias_max", "reserva_dias_min", "reserva_horizonte"]);
  assert.equal(valorRegla("El alquiler más corto es de 3 días"), 3);
  assert.equal(valorRegla("Solo se reserva con 180 días de antelación como mucho"), 180);
  assert.equal(valorRegla("sin cifra"), null); assert.equal(valorRegla(undefined), null); assert.equal(valorRegla("0 días"), null);
  const casos = [
    ["reserva_dias_min", "El alquiler más corto es de 3 días", /minimum rental is 3 days/],
    ["reserva_dias_max", "El alquiler más largo es de 90 días", /maximum rental is 90 days/],
    ["reserva_horizonte", "Solo se reserva con 180 días de antelación como mucho", /up to 180 days in advance/],
    ["reserva_dias_min", "texto raro", /shorter than the shop's minimum/],
  ];
  for (const [hint, mensaje, re] of casos) {
    const b = monta({ cotiza: () => r(409, { error: hint, mensaje }) });
    const q = await b.cotizaBot();
    assert.equal(q.ok, false); assert.equal(q.error, "dates_not_allowed");
    assert.match(q.note, re); assert.match(q.note, /^INTERNAL INSTRUCTION/); assert.match(q.note, /Do NOT give a price/);
    assert.doesNotMatch(q.note, /días|alquiler/, "el texto en español de la base no llega al modelo");
    assert.equal(await b.quotes.lee(TEL), null, "sin cotización guardada: un [PAY] inventado no reserva");
    assert.equal(b.personas.length, 0, "no se deriva a una persona: el cliente puede elegir otras fechas");
  }
  // un 409 desconocido sigue siendo «el equipo confirma el precio» (no cambia)
  const b = monta({ cotiza: () => r(409, { error: "otra_cosa", mensaje: "x" }) });
  assert.match((await b.cotizaBot()).error, /could not price this right now/);
  assert.match(notaReglaFechas("reserva_dias_max", null), /longer than the shop's maximum/);
  ok("reglas de fechas de Ajustes: el bot dice la regla con su cifra (sacada del texto de la base), sin precio, sin derivar y sin cotización guardada");
  // las reglas cambian ENTRE cotizar y pagar: el 409 llega en la reserva, y se lee igual
  const erpReglas = createBbmErp({ url: URL_ERP, secret: SECRET, fetchImpl: async () => r(409, { error: "reserva_horizonte", mensaje: "Solo se reserva con 90 días de antelación como mucho" }), now: () => ahora, log: silent, project: "T" });
  const rk = await erpReglas.reserva({ producto_id: PID, desde: "2099-11-01", hasta: "2099-11-04", fromVerificado: TEL });
  assert.equal(rk.motivo, "regla_fechas"); assert.equal(rk.valor, 90);
  ok("una regla de fechas al reservar también se lee como regla_fechas, con su cifra");
}
{
  // cierre: el 409 de regla llega al reservar → texto «otras fechas» (es), sin persona, sin aviso, cotización borrada
  const llamadas = [];
  const fetchImpl = async (url, init) => {
    const b = JSON.parse(init.body); llamadas.push(b.accion);
    if (b.accion === "reserva") return r(409, { error: "reserva_dias_max", mensaje: "El alquiler más largo es de 30 días" });
    return r(404, {});
  };
  const erp = createBbmErp({ url: URL_ERP, secret: SECRET, fetchImpl, now: () => ahora, log: silent, project: "T" });
  const quotes = createQuoteStore({ now: () => ahora });
  await quotes.guarda(TEL, { producto_id: PID, nombre: "Honda Scoopy", desde: "2099-11-01", hasta: "2099-11-04", entrega_direccion: null, recogida_direccion: null, total: 330000, moneda: "IDR" });
  const personas = [], equipo = [];
  const cierre = createCierreErp({ erp, quotes, pendingRsv: createPendingRsv({ now: () => ahora }), indice: createReservaIndex({ now: () => ahora }), backend: createBackendSwitch({ log: silent, now: () => ahora }),
    avisaEquipo: async (x) => { equipo.push(x); }, derivaPersona: async (t, m) => { personas.push(m); return true; }, now: () => ahora, log: silent, project: "T" });
  const p = await cierre.cierra({ tel: TEL, mensajeId: "m", payAmount: 330000, nombre: "Ana Pérez", pais: "Spain", idioma: "es" });
  assert.equal(p.motivo, "regla_fechas"); assert.equal(p.texto, TEXTOS_FALLO.es.regla_fechas);
  assert.equal(personas.length + equipo.length, 0, "no promete persona: ni petición ni aviso");
  assert.equal(await quotes.lee(TEL), null, "cotización borrada: un reintento no repite la reserva con fechas prohibidas");
  ok("regla de fechas al pagar: «elige otras fechas» en su idioma, sin promesa del equipo y sin cotización guardada");
}

// ── 2. textos del cierre en el idioma del cliente ──────────────────────────────────────────────────────────
{
  const claves = Object.keys(TEXTOS_FALLO.en).sort();
  for (const l of ["id", "es"]) {
    assert.deepEqual(Object.keys(TEXTOS_FALLO[l]).sort(), claves, `${l}: los mismos textos que en inglés`);
    for (const k of claves) assert.ok(TEXTOS_FALLO[l][k] && TEXTOS_FALLO[l][k] !== TEXTOS_FALLO.en[k], `${l}.${k} traducido`);
  }
  assert.equal(textoFallo("generico", "fr"), TEXTOS_FALLO.en.generico, "otro idioma → inglés");
  assert.equal(textoFallo("generico", undefined), TEXTOS_FALLO.en.generico);
  // el ERP dice sin_configurar al pedir el enlace: el texto sale en indonesio
  const b = monta({ enlace: () => r(409, { error: "sin_configurar", paso: "cobros" }) });
  assert.equal((await b.cotizaBot()).ok, true);
  const p = await b.paga("id");
  assert.equal(p.ok, false); assert.equal(p.texto, TEXTOS_FALLO.id.sin_configurar); assert.match(p.texto, /Pembayaran online belum tersedia/);
  assert.equal(b.personas.length, 1, "promete una persona → petición en la ficha (patrón BBM-50)");
  // no_pagable: texto genérico, nunca «tu reserva va a caducar»
  const c = monta({ enlace: () => r(409, { error: "no_pagable" }) });
  await c.cotizaBot(); const pc = await c.paga("es");
  assert.equal(pc.motivo, "generico"); assert.equal(pc.texto, TEXTOS_FALLO.es.generico);
  assert.ok(c.equipo.length + c.personas.length >= 1, "el equipo se entera");
  ok("textos fijos del cierre en id/es/en; no_pagable (decimales en IDR o caducidad) ya no dice que la reserva caduca");
}

// ── 3. el idioma viaja con el enlace y el aviso de pago sale en ese idioma ─────────────────────────────────────────
{
  for (const [l, re] of [["id", /Pembayaran diterima — 330\.000 IDR\. Terima kasih! Pemesanan Anda sudah terkonfirmasi\. Nomor invoice Anda: BBM-1\./],
                         ["es", /Pago recibido — 330\.000 IDR\. ¡Gracias! Tu reserva está confirmada\. Tu número de factura es BBM-1\./],
                         [undefined, /Payment received — 330\.000 IDR\. Thank you! Your booking is confirmed\. Your invoice number is BBM-1\./]]) {
    const b = monta();
    await b.cotizaBot(); const p = await b.paga(l);
    assert.equal(p.ok, true, JSON.stringify(p));
    assert.equal((await b.pendingRsv.lee(TEL)).idioma, l || "en");
    const res = await b.aviso({ externalId: `rsv:${p.reservaId}`, invoiceId: "inv_1", cuerpo: { ok: true, factura: { numero: "BBM-1" } } });
    assert.equal(res.motivo, "ok"); assert.match(b.alCliente[0], re);
  }
  const pr = createPendingRsv({ now: () => ahora });
  await pr.guarda(TEL, { external_id: "rsv:x", importe: 1, moneda: "IDR", caduca_en_ms: ahora + 60_000, idioma: "<script>" });
  assert.equal((await pr.lee(TEL)).idioma, "en", "un idioma que no es id/es se guarda como en");
  assert.match(textoPagoRecibido({ ok: true }, { importe: 5, moneda: "IDR", idioma: "id" }), /Invoice Anda sedang kami siapkan/);
  assert.match(textoPagoRecibido({ revisar: true }, { idioma: "es" }), /El equipo está revisando tu reserva/);
  assert.match(textoPagoRecibido({ ok: true, factura: { numero: "<b>" } }, { idioma: "es" }), /Tu factura está en camino/, "un número raro no se pinta");
  ok("el idioma se guarda con el enlace (solo id/es/en) y el aviso de pago sale en ese idioma, con el número de factura validado");
}

// ── 4. el seguro en modo erp ─────────────────────────────────────────────────────────────────────
{
  // el seguro NO lleva instrucción propia en modo erp hasta que decida el owner (es dinero: no cabe como decisión por defecto; revisor 13-oct)
  assert.doesNotMatch(ERP_PROMPT_BLOCK, /paid at handover, to the team/);
  ok("seguro: sin instrucción propia en modo erp hasta la decisión del owner");
  // la frase que acompaña a [PAY] no anuncia el enlace: si falla, el cliente leería «aquí tienes el enlace» y luego «no está disponible»
  assert.doesNotMatch(ERP_PROMPT_BLOCK, /sending your secure payment link/);
  assert.match(ERP_PROMPT_BLOCK, /never say the link is here or is being sent/);
  ok("la línea del modelo con [PAY] es neutra: el resultado (enlace o fallo) lo dice el servidor");
}

// ── 5. teléfonos de prueba (BBM_ERP_TELEFONOS): el del estudio va al ERP con el interruptor en dion ──────────────────────────────────
{
  const errores = [];
  const lg = { error: (m) => errores.push(m), warn() {}, log() {} };
  const set = leeTelefonosErp(" 62800000001, +62800000002 ,0811234567, 1234, abc, ", lg, "T");
  assert.deepEqual([...set].sort(), ["62800000001", "62800000002"]);
  assert.equal(errores.length, 1); assert.match(errores[0], /3 número\(s\) no válidos descartados/);
  assert.doesNotMatch(errores[0], /0811234567|1234/, "el arranque no escribe los números enteros");
  assert.equal(leeTelefonosErp(undefined, lg).size, 0); assert.equal(leeTelefonosErp("", lg).size, 0);
  assert.equal(leeTelefonosErp("+0811234567", lg).size, 0, "formato local con + delante: descartado");
  const sw = createBackendSwitch({ envValue: "dion", telefonosErp: set, log: silent, now: () => ahora });
  assert.equal(await sw.bbmBackend("62800000001"), "erp");
  assert.equal(await sw.bbmBackend("+62 800 000 002"), "erp", "se comparan los dígitos");
  assert.equal(await sw.bbmBackend("34800000001"), "dion", "mismos últimos 9 dígitos, otro país: dion (comparación exacta)");
  assert.equal(await sw.bbmBackend("628000000011"), "dion");
  assert.equal(await sw.porDefecto(), "dion", "el interruptor general no cambia");
  await sw.fija("62800000001", 1800, "dion");
  assert.equal(await sw.bbmBackend("62800000001"), "dion", "un pin vivo manda antes que la lista: no se cambia de sistema a media reserva");
  const sinLista = createBackendSwitch({ envValue: "dion", log: silent, now: () => ahora });
  assert.equal(await sinLista.bbmBackend("62800000001"), "dion", "sin la variable, como siempre");
  ok("BBM_ERP_TELEFONOS: solo esos teléfonos (dígitos exactos) van al ERP con el interruptor en dion; un pin vivo manda; mal escritos, descartados sin enseñarlos");
}

console.log(`\n${n} bloques en verde`);
