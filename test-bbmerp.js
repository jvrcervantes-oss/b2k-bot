// Self-check de bbmerp.js (F8 pieza 7, parte segura): cliente de reservas-bot, interruptor de backend, registro de enlace pendiente propio.
// Sin red: fetch simulado, reloj simulado, Redis de mentira. El contrato (bbmerp.contract.json) se valida contra el mock de la edge.
// Ejecutar: node test-bbmerp.js
import assert from "node:assert";
import fs from "node:fs";
import { createBbmErp, createBackendSwitch, createPendingRsv, claveReserva, telefonoVerificado, normalizaBackend } from "./bbmerp.js";

const CONTRATO = JSON.parse(fs.readFileSync(new URL("./bbmerp.contract.json", import.meta.url), "utf8"));
const silent = { warn() {}, error() {}, log() {} };
let n = 0;
const ok = (m) => { n++; console.log("ok -", m); };

// ── validador mínimo de `forma` ────────────────────────────────────────────────────────────────────────────────────────────────
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function tipoOk(t, v) {
  switch (t) {
    case "uuid": return typeof v === "string" && UUID.test(v);
    case "string": return typeof v === "string";
    case "int": return Number.isInteger(v);
    case "number": return typeof v === "number" && Number.isFinite(v);
    case "bool": return typeof v === "boolean";
    case "date": return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
    case "timestamp": return typeof v === "string" && !Number.isNaN(Date.parse(v));
    case "any": return true;
    default: throw new Error("tipo desconocido " + t);
  }
}
function valida(forma, v, ruta = "$") {
  const errs = [];
  if (typeof forma === "string") {
    const opt = forma.endsWith("?"), t = opt ? forma.slice(0, -1) : forma;
    if (v === undefined || v === null) { if (!opt && t !== "any") errs.push(`${ruta}: falta (${forma})`); return errs; }
    if (!tipoOk(t, v)) errs.push(`${ruta}: ${JSON.stringify(v)} no es ${forma}`);
    return errs;
  }
  if (Array.isArray(forma)) {
    if (!Array.isArray(v)) return [`${ruta}: no es lista`];
    v.forEach((x, i) => errs.push(...valida(forma[0], x, `${ruta}[${i}]`)));
    return errs;
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return [`${ruta}: no es objeto`];
  for (const k of Object.keys(forma)) errs.push(...valida(forma[k], v[k], `${ruta}.${k}`));
  return errs;
}

// ── 1. el mock de la edge cumple el contrato ───────────────────────────────────────────────────────────────────────────────────
for (const [accion, def] of Object.entries(CONTRATO.acciones)) {
  for (const [nombre, ej] of Object.entries(def.ejemplos)) {
    // `impuesto` null en el ejemplo sin impuesto: la forma lo declara objeto, así que ese caso se valida sin él
    const forma = JSON.parse(JSON.stringify(def.forma));
    if (accion === "cotiza" && ej.r.impuesto === null) delete forma.r.impuesto;
    assert.deepEqual(valida(forma, ej), [], `${accion}.${nombre}`);
  }
}
assert.deepEqual(Object.keys(CONTRATO.acciones).sort(), ["catalogo", "cliente", "cotiza", "entrega", "reserva"]);
ok("los ejemplos de la edge cumplen la forma del contrato (5 acciones)");

// ── harness ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const SECRET = "bbm-reservas-secret-0123456789abcdef0123";
const URL_ERP = "https://erp.test";
const PRODUCTO = CONTRATO.acciones.catalogo.ejemplos.ok.r[0].id;
const RESERVA = CONTRATO.acciones.reserva.ejemplos.ok.r;
const clon = (x) => JSON.parse(JSON.stringify(x));

// La edge de mentira REPITE sus reglas: secreto, lista cerrada de campos (campos_admitidos del contrato) y la forma de cada acción.
function edge(respuestas, { admiteClave = false } = {}) {
  const llamadas = [];
  const fetchImpl = async (url, init) => {
    assert.equal(url, `${URL_ERP}/functions/v1/reservas-bot`);
    assert.equal(init.method, "POST");
    assert.equal(init.headers["x-bot-secret"], SECRET, "cabecera x-bot-secret = BBM_RESERVAS_SECRET");
    assert.ok(!("authorization" in init.headers), "sin Authorization: el secreto es la puerta");
    assert.ok(init.signal instanceof AbortSignal, "siempre con tiempo máximo");
    const cuerpo = JSON.parse(init.body);
    const admitidos = [...CONTRATO.peticion.campos_admitidos[cuerpo.accion], ...(admiteClave && cuerpo.accion === "reserva" ? ["clave"] : [])];
    assert.ok(admitidos, "acción conocida " + cuerpo.accion);
    const extra = Object.keys(cuerpo).filter((k) => !admitidos.includes(k));
    llamadas.push(cuerpo);
    if (extra.length) return { status: 400, json: async () => ({ error: "campo_no_admitido", campos: extra }) };
    const r = typeof respuestas === "function" ? respuestas(cuerpo, llamadas.length) : respuestas[cuerpo.accion];
    if (r instanceof Error) throw r;
    const status = r.status ?? 200;
    return { status, ok: status === 200, json: async () => { if (r.badJson) throw new Error("x"); return r.body; } };
  };
  return { fetchImpl, llamadas };
}
function mk(respuestas, extra = {}) {
  const e = edge(respuestas, { admiteClave: !!extra.enviaClave });   // la edge de HOY no admite `clave`: se simula la futura solo cuando el bot la manda
  let t = 1_000_000;
  const logs = [];
  const log = { warn: (m) => logs.push(m), error: (m) => logs.push(m), log: (m) => logs.push(m) };
  const bbm = createBbmErp({ url: URL_ERP, secret: SECRET, fetchImpl: e.fetchImpl, now: () => t, log, project: "T", ...extra });
  return { bbm, llamadas: e.llamadas, logs, adv: (ms) => { t += ms; } };
}
const E = (acc, nombre) => ({ body: clon(CONTRATO.acciones[acc].ejemplos[nombre]) });

// ── 2. sin variables ⇒ no hace nada ──────────────────────────────────────────────────────────────────────────────────────────────
{
  let llamado = false;
  const f = async () => { llamado = true; return { status: 200, json: async () => ({}) }; };
  for (const cfg of [{}, { url: URL_ERP }, { secret: SECRET }, { url: "", secret: "" }]) {
    const bbm = createBbmErp({ ...cfg, fetchImpl: f, log: silent });
    assert.equal(bbm.enabled, false);
    assert.deepEqual(await bbm.catalogo(), { ok: false, motivo: "no_configurado" });
    assert.equal((await bbm.cotiza({ producto_id: PRODUCTO, desde: "2026-11-01", hasta: "2026-11-04" })).motivo, "no_configurado");
    assert.equal((await bbm.entrega("Jl. Sunset Road 10, Kuta")).motivo, "no_configurado");
  }
  assert.equal(llamado, false);
  ok("sin BBM_ERP_URL/BBM_RESERVAS_SECRET no hay red y todo es no_configurado");
}

// ── 3. catálogo: caché con último bueno ─────────────────────────────────────────────────────────────────────────────────────────
{
  let falla = false;
  const { bbm, llamadas, adv } = mk((c) => (falla ? new Error("net") : E("catalogo", "ok")));
  const a = await bbm.catalogo();
  assert.equal(a.ok, true); assert.equal(a.stale, false);
  assert.equal(a.productos[0].nombre, "Honda Scoopy");
  assert.equal(a.productos[0].tarifas.length, 2);
  assert.ok(!("matricula" in a.productos[0]));
  await bbm.catalogo();
  assert.equal(llamadas.length, 1, "segunda lectura desde la caché");
  assert.deepEqual(llamadas[0], { accion: "catalogo" });
  adv(6 * 60 * 1000); falla = true;
  const b = await bbm.catalogo();
  assert.equal(b.ok, true); assert.equal(b.stale, true, "ERP caído: último bueno");
  adv(25 * 3600 * 1000);
  const c = await bbm.catalogo();
  assert.deepEqual([c.ok, c.motivo], [false, "no_disponible"], "pasadas 24 h: fail-closed");
  ok("catálogo: caché 5 min, último bueno ≤24 h con stale:true, después fail-closed");
}
{
  let modo = "ok";
  const { bbm, adv } = mk(() => (modo === "ok" ? E("catalogo", "ok") : modo === "404" ? { status: 404, body: { error: "modulo_no_activo" } } : modo === "500" ? { status: 500, body: { error: "base" } } : { status: 401, body: { error: "no_autorizado" } }));
  assert.equal((await bbm.catalogo()).ok, true);
  adv(6 * 60 * 1000); modo = "404";
  assert.equal((await bbm.catalogo()).motivo, "modulo_apagado", "módulo apagado NO se tapa con la caché");
  modo = "ok"; assert.equal((await bbm.catalogo()).ok, true);
  adv(6 * 60 * 1000); modo = "401";
  assert.equal((await bbm.catalogo()).motivo, "secreto_rechazado");
  modo = "500";
  assert.equal((await bbm.catalogo()).motivo, "no_disponible", "tras un secreto roto la caché se descartó");
  ok("catálogo: módulo apagado y secreto roto no se tapan con la caché");
}
{
  const malo = { body: { r: [{ id: "no-es-uuid", nombre: "x", unidades: 1, tarifas: [] }] } };
  const { bbm } = mk(() => malo);
  const r = await bbm.catalogo();
  assert.deepEqual([r.ok, r.motivo, r.detalle], [false, "no_disponible", "respuesta_invalida"]);
  const { bbm: b2 } = mk(() => ({ body: { r: "basura" } }));
  assert.equal((await b2.catalogo()).ok, false);
  const { bbm: b3 } = mk(() => ({ body: {} }));
  assert.equal((await b3.catalogo()).ok, false);
  ok("catálogo que no cumple el contrato ⇒ fail-closed, no se cachea");
}

// ── 4. entrega ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const estados = ["ok", "sin_resultado", "ambigua", "tope", "pausado", "ocupado", "error"];
  for (const s of estados) {
    const { bbm, llamadas } = mk(() => ({ body: { r: s === "ok" ? { estado: "ok", km: 12.34 } : { estado: s } } }));
    const r = await bbm.entrega("  Jl. Sunset Road 10, Kuta  ");
    assert.equal(r.ok, true); assert.equal(r.estado, s);
    assert.equal(r.km, s === "ok" ? 12.34 : null);
    assert.deepEqual(llamadas[0], { accion: "entrega", direccion: "Jl. Sunset Road 10, Kuta" });
  }
  const { bbm } = mk(() => ({ body: { r: { estado: "ok", km: 0 } } }));
  assert.equal((await bbm.entrega("Jl. Sunset Road 10")).ok, false, "ok sin km positivo no vale");
  const { bbm: b2 } = mk(() => ({ body: { r: { estado: "inventado" } } }));
  assert.equal((await b2.entrega("Jl. Sunset Road 10")).ok, false);
  const { bbm: b3, llamadas } = mk(() => ({ body: { r: { estado: "ok", km: 3 } } }));
  for (const mala of ["", "abc", "x".repeat(201), "calle\u0000con control", null, 5]) assert.equal((await b3.entrega(mala)).motivo, "peticion_invalida");
  assert.equal(llamadas.length, 0, "dirección inválida no sale a la red");
  ok("entrega: los 7 estados, km solo con ok, validación local de la dirección");
}

// ── 5. cotiza ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const PEDIDO = { producto_id: PRODUCTO, desde: "2026-11-01", hasta: "2026-11-04" };
{
  const { bbm, llamadas } = mk(() => E("cotiza", "ok"));
  const r = await bbm.cotiza(PEDIDO);
  assert.equal(r.ok, true);
  const q = r.cotizacion;
  assert.equal(q.total, 330000); assert.equal(q.moneda, "IDR"); assert.equal(q.disponibles, 2); assert.equal(q.dias, 3);
  assert.deepEqual(q.impuesto, { nombre: "PB1", porcentaje: 10 });
  assert.equal(q.lineas[0].bruto, 330000);
  assert.deepEqual(Object.keys(llamadas[0]).sort(), ["accion", "desde", "hasta", "producto_id"], "sin dirección no se manda dirección");
  ok("cotiza: total, impuesto, líneas y disponibles");
}
{
  const { bbm, llamadas } = mk(() => E("cotiza", "sin_impuesto_con_entrega"));
  const r = await bbm.cotiza({ ...PEDIDO, hasta: "2026-11-03", entrega_direccion: " Villa Mawar, Seminyak ", recogida_direccion: "" });
  assert.equal(r.ok, true);
  assert.equal(r.cotizacion.impuesto, null);
  assert.equal(r.cotizacion.disponibles, 0, "0 disponibles es ok:true; decide quien llama");
  assert.equal(r.cotizacion.lineas.length, 2);
  assert.deepEqual(llamadas[0], { accion: "cotiza", ...PEDIDO, hasta: "2026-11-03", entrega_direccion: "Villa Mawar, Seminyak" });
  ok("cotiza con entrega: la dirección viaja, sin km ni importes; sin impuesto = null");
}
{
  for (const [status, error, motivo] of [[409, "entrega_a_confirmar", "entrega_a_confirmar"], [409, "entrega_no_configurada", "entrega_no_configurada"], [409, "sin_disponibilidad", "sin_disponibilidad"], [409, "algo_raro", "datos"], [429, "tope_telefono", "tope_telefono"], [429, "tope_global", "tope_global"], [404, "modulo_no_activo", "modulo_apagado"], [401, "no_autorizado", "secreto_rechazado"], [400, "campo_no_admitido", "peticion_invalida"], [502, "base", "no_disponible"], [500, "x", "no_disponible"]]) {
    const { bbm } = mk(() => ({ status, body: { error, mensaje: "texto de la base" } }));
    const r = await bbm.cotiza({ ...PEDIDO, entrega_direccion: "Villa Mawar, Seminyak" });
    assert.equal(r.ok, false, `${status} ${error}`);
    assert.equal(r.motivo, motivo, `${status} ${error}`);
    assert.ok(!("total" in r) && !("cotizacion" in r), "nunca un precio en un fallo");
  }
  ok("cotiza: entrega_a_confirmar / entrega_no_configurada / sin_disponibilidad / topes / apagado ⇒ sin precio");
}
{
  // ambigua es un estado de `entrega`, y la cotización NO la salta: el bot pide más datos antes de cotizar
  const { bbm } = mk(() => ({ body: { r: { estado: "ambigua" } } }));
  const r = await bbm.entrega("Seminyak");
  assert.deepEqual([r.ok, r.estado, r.km], [true, "ambigua", null]);
  ok("entrega ambigua llega como estado (el bot pide más datos), sin km");
}
{
  const incoherentes = [
    (r) => { r.producto_id = "00000000-0000-4000-8000-000000000000"; },
    (r) => { r.desde = "2026-12-01"; },
    (r) => { r.total = "330000"; },
    (r) => { r.moneda = "idr"; },
    (r) => { delete r.lineas; },
    (r) => { r.disponibles = -1; },
    (r) => { r.dias = 0; },
  ];
  for (const f of incoherentes) {
    const body = clon(CONTRATO.acciones.cotiza.ejemplos.ok); f(body.r);
    const { bbm } = mk(() => ({ body }));
    assert.equal((await bbm.cotiza(PEDIDO)).ok, false);
  }
  const { bbm, llamadas } = mk(() => E("cotiza", "ok"));
  for (const malo of [{ ...PEDIDO, producto_id: "x" }, { ...PEDIDO, desde: "01/11/2026" }, { ...PEDIDO, entrega_direccion: 5 }, { ...PEDIDO, entrega_direccion: "a\u0001b" }]) assert.equal((await bbm.cotiza(malo)).motivo, "peticion_invalida");
  assert.equal(llamadas.length, 0);
  ok("cotiza: respuesta incoherente o petición inválida ⇒ fail-closed");
}
{
  // el bot no puede mandar importes, km ni precio: ni siquiera pasando campos de más
  const { bbm, llamadas } = mk(() => E("cotiza", "ok"));
  await bbm.cotiza({ ...PEDIDO, precio: 1, importe: 1, km: 99, total: 1 });
  assert.deepEqual(Object.keys(llamadas[0]).sort(), ["accion", "desde", "hasta", "producto_id"]);
  ok("campos de más (precio, importe, km) se descartan antes de salir");
}

// ── 6. reserva ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const FROM = "+62 812-3456-7890";
const RES = { fromVerificado: FROM, ...PEDIDO, mensajeId: "wamid.HBgLNjI4MTIzNDU2Nzg5MBUCABIYFjNFQjBDMEE5MkQ0MUQ2OEE3QTcA==" };
{
  const { bbm, llamadas } = mk(() => E("reserva", "ok"));
  const r = await bbm.reserva(RES);
  assert.equal(r.ok, true);
  const x = r.reserva;
  assert.equal(x.reserva_id, RESERVA.id);
  assert.equal(x.cobro.external_id, `rsv:${RESERVA.id}`);
  assert.equal(x.cobro.importe, 330000); assert.ok(Number.isInteger(x.cobro.importe));
  assert.equal(x.cobro.importe, x.precio_total, "lo que cobra el enlace = lo cotizado y congelado");
  assert.equal(x.cobro.segundos_hasta_caducar, 3540);
  assert.ok(!JSON.stringify(x).toLowerCase().includes("deposito"), "el depósito no está en el cobro");
  assert.ok(!JSON.stringify(x).toLowerCase().includes("comision"), "ni la comisión del 3 % de la pasarela");
  assert.deepEqual(llamadas[0], { accion: "reserva", ...PEDIDO, contacto_telefono: "6281234567890" });
  ok("reserva: cobro.importe es el entero igual a precio_total, sin comisión ni depósito; teléfono = solo dígitos del from");
}
{
  const { bbm } = mk(() => E("reserva", "repetida"));
  const r = await bbm.reserva(RES);
  assert.equal(r.ok, true); assert.equal(r.reserva.repetida, true);
  assert.equal(r.reserva.precio_total, 330000, "330000.00 llega como entero");
  assert.equal(r.reserva.cobro.importe, 330000);
  ok("reserva repetida (la base devuelve la viva) con repetida:true");
}
{
  // el teléfono SOLO sale del from verificado: sin él (o con basura) no se llama
  const { bbm, llamadas } = mk(() => E("reserva", "ok"));
  for (const from of [undefined, null, "", "abc", "123", "1".repeat(16)]) assert.equal((await bbm.reserva({ ...RES, fromVerificado: from })).motivo, "peticion_invalida");
  // un teléfono "escrito en el chat" no es argumento: el campo que existe es fromVerificado, y contacto_telefono/telefono se ignoran
  await bbm.reserva({ ...RES, telefono: "+6200000000000", contacto_telefono: "+6211111111111" });
  assert.equal(llamadas.length, 1);
  assert.equal(llamadas[0].contacto_telefono, "6281234567890");
  assert.equal(telefonoVerificado("+62 812-3456-7890"), "6281234567890");
  ok("contacto_telefono sale solo de fromVerificado; sin él no hay llamada");
}
{
  // lista cerrada de campos de la reserva: nada de precio, unidad, cliente, importe, km
  const { bbm, llamadas } = mk(() => E("reserva", "ok"));
  await bbm.reserva({ ...RES, entrega_direccion: "Villa Mawar, Seminyak", precio_total: 1, importe: 1, km: 40, unidad_id: "x", client_id: "y", estado: "confirmada", contacto_nombre: "inyectado", conversacion_ref: "628123456789", notas: "hola" });
  const permitidos = CONTRATO.peticion.campos_admitidos.reserva;
  for (const k of Object.keys(llamadas[0])) assert.ok(permitidos.includes(k) || k === "clave", `campo ${k}`);
  for (const k of ["precio_total", "importe", "km", "unidad_id", "client_id", "estado", "contacto_nombre", "notas"]) assert.ok(!(k in llamadas[0]), k);
  assert.equal(llamadas[0].conversacion_ref, "628123456789", "id del chat, nunca texto");
  const { bbm: b2, llamadas: l2 } = mk(() => E("reserva", "ok"));
  await b2.reserva({ ...RES, conversacion_ref: "hola, quiero una moto" });
  assert.ok(!("conversacion_ref" in l2[0]), "un texto no es un id");
  ok("reserva: lista cerrada de campos; conversacion_ref solo si parece un id");
}
{
  // idempotencia: clave derivada del id del mensaje, estable ante reentregas y válida para la base
  const k1 = claveReserva({ mensajeId: RES.mensajeId, ...PEDIDO }), k2 = claveReserva({ mensajeId: RES.mensajeId, ...PEDIDO });
  const k3 = claveReserva({ mensajeId: RES.mensajeId + "x", ...PEDIDO });
  assert.equal(k1, k2); assert.notEqual(k1, k3);
  assert.match(k1, /^[A-Za-z0-9@:._+-]{1,120}$/, "cumple el CHECK de la base aunque el wamid lleve = y /");
  assert.equal(claveReserva({ ...PEDIDO }), undefined);
  assert.ok(!k1.includes("wamid"), "no se filtra el id del mensaje");
  const a = mk(() => E("reserva", "ok"), { enviaClave: true });
  await a.bbm.reserva(RES); await a.bbm.reserva(RES);
  assert.equal(a.llamadas[0].clave, k1); assert.equal(a.llamadas[1].clave, k1, "reentrega de Meta = misma clave");
  const b = mk(() => E("reserva", "ok"));
  await b.bbm.reserva(RES);
  assert.ok(!("clave" in b.llamadas[0]), "con la edge de hoy (sin `clave` admitido) no se manda");
  ok("clave de idempotencia por id de mensaje: estable, válida para la base, solo con enviaClave");
}
{
  // respuesta perdida ⇒ UN reintento con el MISMO cuerpo (misma clave)
  const intentos = [];
  const { bbm, llamadas } = mk((c, i) => { intentos.push(i); return i === 1 ? new TypeError("fetch failed") : E("reserva", "repetida"); }, { enviaClave: true });
  const r = await bbm.reserva(RES);
  assert.equal(r.ok, true); assert.equal(r.reserva.repetida, true);
  assert.equal(llamadas.length, 2);
  assert.deepEqual(llamadas[0], llamadas[1], "mismo cuerpo, misma clave");
  const dos = mk(() => new TypeError("fetch failed"));
  const f = await dos.bbm.reserva(RES);
  assert.deepEqual([f.ok, f.motivo], [false, "no_disponible"]);
  assert.equal(dos.llamadas.length, 2, "un solo reintento");
  const c5 = mk(() => ({ status: 502, body: { error: "base" } }));
  assert.equal((await c5.bbm.reserva(RES)).ok, false); assert.equal(c5.llamadas.length, 2, "5xx también se reintenta una vez");
  for (const st of [409, 429, 400, 404, 401]) {
    const x = mk(() => ({ status: st, body: { error: st === 429 ? "tope_telefono" : "sin_disponibilidad" } }));
    assert.equal((await x.bbm.reserva(RES)).ok, false); assert.equal(x.llamadas.length, 1, `${st} no se reintenta`);
  }
  ok("reserva: un reintento con la misma clave si la respuesta se pierde; 4xx no se reintenta");
}
{
  // topes: 429 y {rechazada}
  const t = mk(() => ({ status: 429, body: { error: "tope_global", mensaje: "x" } }));
  assert.equal((await t.bbm.reserva(RES)).motivo, "tope_global");
  const t2 = mk(() => ({ body: { r: { rechazada: "tope_global", mensaje: "x" } } }));
  assert.equal((await t2.bbm.reserva(RES)).motivo, "tope_global");
  ok("reserva: topes (429 y {rechazada}) ⇒ sin enlace");
}
{
  // cobro incoherente ⇒ NO hay enlace de pago
  const roturas = [
    (r) => { r.cobro.importe = 330000.5; },
    (r) => { r.cobro.importe = 0; },
    (r) => { r.cobro.importe = 340000; },                              // ≠ precio_total
    (r) => { r.cobro.importe = 339900.4; r.precio_total = r.cobro.importe; },   // con una comisión del 3 % mal redondeada: no es entero
    (r) => { r.cobro.external_id = "rsv:00000000-0000-4000-8000-000000000000"; },
    (r) => { r.cobro.external_id = "paylink_6281_1"; },
    (r) => { delete r.cobro; },
    (r) => { r.cobro.segundos_hasta_caducar = -5; },
    (r) => { r.cobro.moneda = "USD"; },                                // ≠ moneda de la reserva
    (r) => { r.id = "no-uuid"; },
  ];
  for (const f of roturas) {
    const body = clon(CONTRATO.acciones.reserva.ejemplos.ok); f(body.r);
    const { bbm } = mk(() => ({ body }));
    const r = await bbm.reserva(RES);
    assert.equal(r.ok, false); assert.ok(!("reserva" in r));
  }
  ok("reserva: cobro no entero / distinto del total / external_id ajeno ⇒ fail-closed, nunca enlace");
}

// ── 7. cliente ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const { bbm, llamadas } = mk(() => E("cliente", "nuevo"));
  const r = await bbm.cliente({ reserva_id: RESERVA.id, nombre: "  Ana   García\n", pais: "España", telefono: "+620000", client_id: "x" });
  assert.deepEqual(r, { ok: true, cliente_identificado: true, creado: true, motivo: null });
  assert.deepEqual(llamadas[0], { accion: "cliente", reserva_id: RESERVA.id, nombre: "Ana García", pais: "España" }, "solo tres campos, el teléfono no viaja");
  const a = mk(() => E("cliente", "ambiguo"));
  const ra = await a.bbm.cliente({ reserva_id: RESERVA.id, nombre: "Ana", pais: "España" });
  assert.deepEqual([ra.ok, ra.cliente_identificado, ra.motivo], [true, false, "telefono_ambiguo"]);
  const m = mk(() => ({ status: 409, body: { error: "no_aplica" } }));
  assert.equal((await m.bbm.cliente({ reserva_id: RESERVA.id, nombre: "Ana", pais: "España" })).ok, false);
  const v = mk(() => E("cliente", "nuevo"));
  for (const mal of [{ reserva_id: "x", nombre: "Ana", pais: "ES" }, { reserva_id: RESERVA.id, nombre: "A", pais: "España" }, { reserva_id: RESERVA.id, nombre: "Ana", pais: "" }, { reserva_id: RESERVA.id, nombre: 5, pais: "España" }]) assert.equal((await v.bbm.cliente(mal)).motivo, "peticion_invalida");
  assert.equal(v.llamadas.length, 0);
  ok("cliente: solo reserva_id, nombre y país; nombre saneado; ambiguo y no_aplica");
}

// ── 8. fail-closed por tiempo ───────────────────────────────────────────────────────────────────────────────────────────────────
{
  const colgado = (url, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(init.signal.reason)));
  const bbm = createBbmErp({ url: URL_ERP, secret: SECRET, fetchImpl: colgado, timeoutMs: 40, log: silent });
  const keep = setTimeout(() => {}, 10000);   // AbortSignal.timeout no mantiene vivo el proceso: en el bot lo mantiene Express
  const t0 = Date.now();
  const q = await bbm.cotiza(PEDIDO);
  assert.deepEqual([q.ok, q.motivo], [false, "no_disponible"]);
  assert.ok(!("cotizacion" in q));
  assert.ok(Date.now() - t0 < 1000);
  const r = await bbm.reserva(RES);
  assert.deepEqual([r.ok, r.motivo], [false, "no_disponible"]);
  assert.ok(!("reserva" in r), "sin enlace de pago");
  assert.equal((await bbm.catalogo()).ok, false);
  clearTimeout(keep);
  const def = createBbmErp({ url: URL_ERP, secret: SECRET, fetchImpl: async () => ({ status: 200, json: async () => ({ r: [] }) }), log: silent });
  assert.equal((await def.catalogo()).ok, true);
  ok("timeout (5 s por defecto, aquí 40 ms) ⇒ no_disponible, sin precio ni enlace");
}

// ── 9. logs sin PII ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const { bbm, logs } = mk((c) => {
    if (c.accion === "reserva") return E("reserva", "ok");
    if (c.accion === "cliente") return { status: 409, body: { error: "no_aplica", mensaje: "Ana García +6281234567890" } };
    if (c.accion === "entrega") return { body: { r: { estado: "ok", km: 5.5 } } };
    return { status: 409, body: { error: "entrega_a_confirmar", mensaje: "Villa Mawar 6281234567890" } };
  });
  await bbm.entrega("Villa Mawar, Seminyak");
  await bbm.cotiza({ ...PEDIDO, entrega_direccion: "Villa Mawar, Seminyak" });
  await bbm.reserva({ ...RES, entrega_direccion: "Villa Mawar, Seminyak" });
  await bbm.cliente({ reserva_id: RESERVA.id, nombre: "Ana García", pais: "España" });
  const todo = logs.join("\n");
  assert.ok(logs.length >= 3);
  for (const s of ["6281234567890", "812-3456", "Villa Mawar", "Ana", "García", SECRET, "wamid", "HBgL"]) assert.ok(!todo.includes(s), `el log no debe contener ${s}`);
  assert.ok(todo.includes(RESERVA.id) && todo.includes("330000"), "ids e importes sí");
  ok("logs: ids e importes, nunca teléfono, nombre, dirección, mensaje de la base, wamid ni secreto");
}

// ── 10. interruptor de backend ──────────────────────────────────────────────────────────────────────────────────────────────────
function fakeRedis(reloj) {
  const m = new Map(); let rompe = false;
  const vivo = (k) => { const e = m.get(k); if (!e) return null; if (e.hasta && e.hasta <= reloj()) { m.delete(k); return null; } return e; };
  const c = {
    keys: () => [...m.keys()],
    async get(k) { if (rompe) throw new Error("redis caído"); const e = vivo(k); return e ? e.v : null; },
    async set(k, v) { if (rompe) throw new Error("redis caído"); m.set(k, { v }); },
    async setEx(k, ttl, v) { if (rompe) throw new Error("redis caído"); m.set(k, { v, hasta: reloj() + ttl * 1000 }); },
    async del(k) { m.delete(k); },
    caer(b) { rompe = b; },
  };
  return c;
}
{
  let t = 5_000_000; const now = () => t;
  const redis = fakeRedis(now);
  const mkSw = (envValue, r = redis) => createBackendSwitch({ redis: () => r, envValue, now, log: silent, project: "T" });

  assert.equal(await mkSw(undefined).bbmBackend("1"), "dion", "sin nada ⇒ dion");
  assert.equal(await mkSw("erp").bbmBackend("1"), "erp");
  assert.equal(await mkSw(" ERP ").bbmBackend("1"), "erp");
  assert.equal(await mkSw("dion").bbmBackend("1"), "dion");
  for (const raro of ["", "ERP2", "true", "1", "erp;dion", "null"]) assert.equal(await mkSw(raro).bbmBackend("1"), "dion", `env ${raro}`);
  assert.equal(normalizaBackend(undefined), "dion"); assert.equal(normalizaBackend(7), "dion");

  // Redis manda sobre la variable, SIN redeploy
  await redis.set("bbm:backend", "dion");
  assert.equal(await mkSw("erp").bbmBackend("1"), "dion", "Redis dion gana a env erp (vuelta atrás sin redeploy)");
  await redis.set("bbm:backend", "erp");
  assert.equal(await mkSw("dion").bbmBackend("1"), "erp", "Redis erp gana a env dion");
  await redis.set("bbm:backend", "quiensabe");
  assert.equal(await mkSw("erp").bbmBackend("1"), "dion", "valor desconocido en Redis ⇒ dion (no cae a env)");
  await redis.del("bbm:backend");
  assert.equal(await mkSw("erp").bbmBackend("1"), "erp", "sin clave en Redis ⇒ env");
  redis.caer(true);
  assert.equal(await mkSw("erp").bbmBackend("1"), "dion", "Redis caído ⇒ dion");
  redis.caer(false);
  ok("backend por defecto: Redis bbm:backend > BBM_BACKEND > dion; desconocido o Redis caído ⇒ dion");

  // fijado por conversación
  const sw = mkSw("erp");
  assert.equal(await sw.bbmBackend("111"), "erp");
  assert.equal(await sw.fija("111", 3600), "erp", "fija el valor por defecto de ese momento");
  await redis.set("bbm:backend", "dion");                       // el owner vuelve atrás mientras hay una cotización viva
  assert.equal(await sw.bbmBackend("111"), "erp", "la conversación con cotización viva SIGUE en erp");
  assert.equal(await sw.bbmBackend("222"), "dion", "una conversación nueva ya va a dion");
  assert.equal(await sw.fija("111", 3600), "erp", "fija no pisa un backend vivo");
  assert.equal(await sw.fija("111", 3600, "dion"), "erp", "ni siquiera pidiéndolo");
  t += 3601 * 1000;                                              // la cotización muere
  assert.equal(await sw.bbmBackend("111"), "dion", "sin cotización viva, cambia");
  assert.equal(await sw.fija("111", 3600), "dion");
  await sw.suelta("111");
  await redis.del("bbm:backend");
  assert.equal(await sw.bbmBackend("111"), "erp");
  assert.ok(redis.keys().every((k) => k === "bbm:backend" || k.startsWith("bbm:pin:")), "claves propias");
  // pin ilegible = sin pin
  await redis.set("bbm:pin:333", "{no json");
  assert.equal(await sw.bbmBackend("333"), "erp");
  await redis.set("bbm:pin:333", JSON.stringify({ backend: "raro", hasta: t + 99999 }));
  assert.equal(await sw.bbmBackend("333"), "erp", "pin con backend desconocido = sin pin");
  // Redis cae al leer el pin: no se sabe si había cotización viva ⇒ dion
  redis.caer(true);
  assert.equal(await sw.bbmBackend("111"), "dion");
  assert.equal(await sw.bbmBackend(null), "dion");
  redis.caer(false);
  ok("backend fijado por conversación: no cambia con cotización viva, sí en conversaciones nuevas o al caducar");

  // un enlace de pago rsv: vivo ata la conversación a erp aunque el pin haya caducado y el interruptor diga dion
  {
    const reg = createPendingRsv({ redis: () => redis, now });
    const sw2 = createBackendSwitch({ redis: () => redis, envValue: "dion", enlaceVivo: (tel) => reg.lee(tel).then(Boolean), now, log: silent });
    await redis.set("bbm:backend", "dion");
    await sw2.fija("777", 600, "erp");
    await reg.guarda("777000", { external_id: `rsv:${RESERVA.id}`, importe: 330000, caduca_en_ms: t + 3000 * 1000 });
    t += 601 * 1000;                                                   // el pin caducó; el enlace sigue pagable
    assert.equal(await sw2.bbmBackend("777000"), "erp", "pin caducado + enlace vivo ⇒ erp");
    assert.equal(await sw2.bbmBackend("888000"), "dion", "otra conversación ⇒ dion");
    t += 3000 * 1000;                                                  // el enlace caducó
    assert.equal(await sw2.bbmBackend("777000"), "dion");
    const roto = createBackendSwitch({ redis: () => redis, envValue: "dion", enlaceVivo: async () => { throw new Error("x"); }, now, log: silent });
    assert.equal(await roto.bbmBackend("777000"), "dion");
    await redis.del("bbm:backend");
    ok("backend: un enlace rsv: pagable ata la conversación a erp aunque el pin haya caducado");
  }

  // modo RAM (sin Redis): mismas reglas
  const ram = createBackendSwitch({ redis: () => null, envValue: "erp", now, log: silent });
  assert.equal(await ram.bbmBackend("9"), "erp");
  assert.equal(await ram.fija("9", 600), "erp");
  ram._ponPorDefectoEnMemoria("dion");
  assert.equal(await ram.bbmBackend("9"), "erp"); assert.equal(await ram.bbmBackend("10"), "dion");
  ok("backend sin Redis (RAM): mismas reglas");
}

// ── 11. registro de enlace pendiente propio ────────────────────────────────────────────────────────────────────────────────────
{
  let t = 9_000_000; const now = () => t;
  const redis = fakeRedis(now);
  const reg = createPendingRsv({ redis: () => redis, now });
  assert.equal(reg.key("+62 812-3456-7890"), "pendingrsv:6281234567890");
  assert.equal(await reg.lee("6281234567890"), null);
  const g = await reg.guarda("6281234567890", { external_id: `rsv:${RESERVA.id}`, importe: 330000, moneda: "IDR", reserva_id: RESERVA.id, caduca_en_ms: t + 3540 * 1000 });
  assert.equal(g.importe, 330000);
  assert.deepEqual(redis.keys(), ["pendingrsv:6281234567890"], "clave propia: no toca lead:<tel> ni los eventos paylink");
  const l = await reg.lee("+62 812-3456-7890");
  assert.equal(l.external_id, `rsv:${RESERVA.id}`); assert.equal(l.importe, 330000);
  t += 3541 * 1000;
  assert.equal(await reg.lee("6281234567890"), null, "caducado = sin enlace pendiente");
  await reg.guarda("6281234567890", { external_id: `rsv:${RESERVA.id}`, importe: 1000, caduca_en_ms: t + 60000 });
  await reg.borra("6281234567890");
  assert.equal(await reg.lee("6281234567890"), null);
  for (const mal of [{ external_id: "paylink_6281_1", importe: 1000 }, { external_id: `rsv:${RESERVA.id}`, importe: 1000.5 }, { external_id: `rsv:${RESERVA.id}`, importe: 0 }, { external_id: `rsv:${RESERVA.id}`, importe: 1000, caduca_en_ms: t - 1 }]) {
    await assert.rejects(() => reg.guarda("6281234567890", { caduca_en_ms: t + 60000, ...mal, ...(mal.caduca_en_ms ? { caduca_en_ms: mal.caduca_en_ms } : {}) }));
  }
  await assert.rejects(() => reg.guarda("abc", { external_id: `rsv:${RESERVA.id}`, importe: 1000, caduca_en_ms: t + 60000 }));
  const ram = createPendingRsv({ redis: () => null, now });
  await ram.guarda("6281234567890", { external_id: `rsv:${RESERVA.id}`, importe: 5000, caduca_en_ms: t + 60000 });
  assert.equal((await ram.lee("6281234567890")).importe, 5000);
  ok("pendingRsv: clave propia pendingrsv:<tel>, caducidad, validación; no usa lead:/paylink");
}

console.log(`\n${n} bloques OK`);
