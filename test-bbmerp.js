// Self-check de bbmerp.js (F8 pieza 7, parte segura): cliente de reservas-bot, interruptor de backend, registro de enlace pendiente propio.
// Sin red: fetch simulado, reloj simulado, Redis de mentira. El contrato (bbmerp.contract.json) se valida contra el mock de la edge.
// Ejecutar: node test-bbmerp.js
import assert from "node:assert";
import fs from "node:fs";
import { createBbmErp, createBackendSwitch, createPendingRsv, claveReserva, telefonoVerificado, normalizaBackend, leeEstado, leeFreno, ESTADO_TIMEOUT_MS, ESTADO_LECTURA_MS, BACKEND_REFRESCO_MS, BACKEND_TTL_MS, BACKEND_MAX_STALE_MS, FUENTES_BACKEND, CODIGOS_ESTADO } from "./bbmerp.js";

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
assert.deepEqual(Object.keys(CONTRATO.acciones).sort(), ["catalogo", "cliente", "cotiza", "entrega", "estado", "reserva"]);
for (const [nombre, ej] of Object.entries(CONTRATO.reservas_enlace.ejemplos)) assert.deepEqual(valida(CONTRATO.reservas_enlace.forma, ej), [], `reservas_enlace.${nombre}`);
assert.deepEqual(CONTRATO.reservas_enlace.peticion.campos_admitidos, ["reserva_id"]);
// `estado` (B10): forma EXACTA. El validador de arriba ignora claves de más, así que la exactitud la fija leeEstado, contra los ejemplos y las formas malas del contrato.
assert.deepEqual(CONTRATO.peticion.campos_admitidos.estado, ["accion"], "estado no lleva ningún campo más");
assert.equal(CONTRATO.acciones.estado.exacta, true);
assert.deepEqual(CONTRATO.acciones.estado.valores.backend, ["dion", "erp"]);
for (const [nombre, ej] of Object.entries(CONTRATO.acciones.estado.ejemplos)) assert.equal(leeEstado(ej), nombre, `estado.${nombre}`);
assert.ok(CONTRATO.acciones.estado.formas_malas.length >= 8);
for (const mala of [...CONTRATO.acciones.estado.formas_malas, null, undefined, "erp", [], { r: { backend: "erp" }, error: null }]) assert.equal(leeEstado(mala), null, `forma mala ${JSON.stringify(mala)}`);
ok("los ejemplos de la edge cumplen la forma del contrato (6 acciones de reservas-bot, `estado` con forma exacta, + reservas-enlace)");

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
  assert.ok(!JSON.stringify(x).toLowerCase().includes("comision"), "el cobro no trae la comisión como campo aparte: si la hay, ya va dentro de precio_total (una línea de la reserva)");
  assert.deepEqual(llamadas[0], { accion: "reserva", ...PEDIDO, contacto_telefono: "6281234567890" });
  ok("reserva: cobro.importe es el entero igual a precio_total (comisión, si la hay, dentro), sin depósito; teléfono = solo dígitos del from");
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

// ── 7b. sin_configurar (F3 S2, 12-oct-2026): 409 propio con su `paso`, distinto de una caída ──────────────────────────────────
{
  for (const [paso, esperado] of [["impuesto_pkp", "impuesto_pkp"], ["flota", "flota"], ["cobros", "cobros"], ["reservas-producto_sin_configurar", null], ["<b>", null], [undefined, null], [5, null]]) {
    const m = mk(() => ({ status: 409, body: { error: "sin_configurar", ...(paso !== undefined ? { paso } : {}) } }));
    const q = await m.bbm.cotiza(PEDIDO);
    assert.deepEqual([q.ok, q.motivo, q.paso], [false, "sin_configurar", esperado], `cotiza paso=${paso}`);
    const r = await m.bbm.reserva(RES);
    assert.deepEqual([r.ok, r.motivo, r.paso], [false, "sin_configurar", esperado], `reserva paso=${paso}`);
    assert.equal(m.llamadas.filter((c) => c.accion === "reserva").length, 1, "un sin_configurar no se reintenta");
  }
  // y no se confunde con una caída: una caída de verdad sigue siendo no_disponible
  const c = mk(() => ({ status: 502, body: { error: "base" } }));
  assert.equal((await c.bbm.cotiza(PEDIDO)).motivo, "no_disponible");
  // el catálogo NO tapa un sin_configurar con el último bueno (el ERP dijo que no)
  let modo = "ok";
  const k = mk(() => (modo === "ok" ? E("catalogo", "ok") : { status: 409, body: { error: "sin_configurar", paso: "flota" } }));
  assert.equal((await k.bbm.catalogo()).ok, true);
  k.adv(10 * 60 * 1000); modo = "no";
  assert.deepEqual([(await k.bbm.catalogo()).ok, (await k.bbm.catalogo()).motivo], [false, "sin_configurar"]);
  ok("sin_configurar: motivo propio con `paso` validado (^[a-z_]{1,40}$), sin reintento, distinto de una caída; el catálogo no lo tapa con la caché");
}

// ── 7c. reservas-enlace (F3 Entrega 2): el enlace lo crea el ERP ──────────────────────────────────────────────────────────────
{
  const RID = RESERVA.id, EXT = `rsv:${RESERVA.id}`;
  const ENL = CONTRATO.reservas_enlace;
  function mkEnlace(respuestas) {
    const llamadas = [];
    const esperas = [];
    const fetchImpl = async (url, init) => {
      assert.equal(url, `${URL_ERP}/functions/v1/reservas-enlace`);
      assert.equal(init.headers["x-bot-secret"], SECRET); assert.ok(init.signal instanceof AbortSignal);
      const cuerpo = JSON.parse(init.body);
      llamadas.push(cuerpo);
      const extra = Object.keys(cuerpo).filter((x) => !ENL.peticion.campos_admitidos.includes(x));
      if (extra.length) return { status: 400, json: async () => ({ error: "campo_no_admitido", campos: extra }) };
      const r = respuestas(cuerpo, llamadas.length);
      if (r instanceof Error) throw r;
      return { status: r.status ?? 200, json: async () => r.body };
    };
    const bbm = createBbmErp({ url: URL_ERP, secret: SECRET, fetchImpl, now: () => Date.parse("2026-10-20T09:00:00Z"), log: silent, project: "T" });
    return { bbm, llamadas, esperas, opts: { reintentoMs: 7, espera: async (ms) => { esperas.push(ms); } } };
  }
  const nuevo = () => ({ body: clon(ENL.ejemplos.nuevo) });
  const m = mkEnlace(nuevo);
  const r = await m.bbm.enlace({ reserva_id: RID.toUpperCase(), external_id: EXT }, m.opts);
  assert.deepEqual(r, { ok: true, url: ENL.ejemplos.nuevo.r.url, caduca_ms: Date.parse(ENL.ejemplos.nuevo.r.caduca_en), external_id: EXT, repetido: false });
  assert.deepEqual(m.llamadas, [{ reserva_id: RID }], "solo el id de la reserva (en minúsculas): ni importe, ni moneda, ni caducidad, ni `accion`");
  const rep = mkEnlace(() => ({ body: clon(ENL.ejemplos.repetido) }));
  assert.equal((await rep.bbm.enlace({ reserva_id: RID }, rep.opts)).repetido, true);
  ok("enlace: POST a reservas-enlace con SOLO reserva_id; devuelve url, la caducidad REAL del ERP y repetido");

  // respuestas que no cumplen: fail-closed
  for (const [que, f] of [
    ["url http", (x) => { x.r.url = "http://checkout.xendit.co/web/a"; }],
    ["url con espacio", (x) => { x.r.url = "https://a b"; }],
    ["otro external_id", (x) => { x.r.external_id = "rsv:00000000-0000-0000-0000-000000000000"; }],
    ["caducada", (x) => { x.r.caduca_en = "2026-10-20T08:59:00Z"; }],
    ["caduca_en ilegible", (x) => { x.r.caduca_en = "pronto"; }],
    ["sin r", (x) => { delete x.r; }],
  ]) {
    const b = clon(ENL.ejemplos.nuevo); f(b);
    const k = mkEnlace(() => ({ body: b }));
    const rr = await k.bbm.enlace({ reserva_id: RID, external_id: EXT }, k.opts);
    assert.deepEqual([rr.ok, rr.motivo], [false, "no_disponible"], que); assert.ok(!("url" in rr), que);
  }
  const otro = mkEnlace(nuevo);
  assert.equal((await otro.bbm.enlace({ reserva_id: RID, external_id: "rsv:otro" }, otro.opts)).ok, false, "el external_id de la reserva que se cobra manda");
  const mal = mkEnlace(nuevo);
  assert.equal((await mal.bbm.enlace({ reserva_id: "x" }, mal.opts)).motivo, "peticion_invalida"); assert.equal(mal.llamadas.length, 0);
  ok("enlace: url no https, otro external_id, caducidad pasada o ilegible ⇒ no_disponible (nunca se manda un enlace que no se entiende)");

  // errores con significado
  for (const [status, body, motivo, llamadas] of [
    [409, { error: "sin_configurar", paso: "cobros" }, "sin_configurar", 1],
    [409, { error: "no_pagable" }, "no_pagable", 1],
    [502, { error: "proveedor" }, "proveedor", 1],
    [502, { error: "base" }, "no_disponible", 1],
    [404, { error: "modulo_no_activo" }, "modulo_apagado", 1],
    [401, { error: "no_autorizado" }, "secreto_rechazado", 1],
    [409, { error: "en_curso" }, "en_curso", 2],
  ]) {
    const k = mkEnlace(() => ({ status, body }));
    const rr = await k.bbm.enlace({ reserva_id: RID }, k.opts);
    assert.deepEqual([rr.ok, rr.motivo], [false, motivo], `${status} ${body.error}`);
    assert.equal(k.llamadas.length, llamadas, `${status} ${body.error}: llamadas`);
    if (motivo === "sin_configurar") assert.equal(rr.paso, "cobros");
  }
  // en_curso: espera y reintenta UNA vez; la segunda sale bien
  const ec = mkEnlace((c, i) => (i === 1 ? { status: 409, body: { error: "en_curso" } } : nuevo()));
  const rec = await ec.bbm.enlace({ reserva_id: RID }, ec.opts);
  assert.equal(rec.ok, true); assert.deepEqual(ec.esperas, [7], "espera antes del reintento"); assert.equal(ec.llamadas.length, 2);
  // caída de red: no_disponible, sin reintento (la edge deja su marca 30 s si no sabe si Xendit creó la factura)
  const cr = mkEnlace(() => new TypeError("fetch failed"));
  assert.equal((await cr.bbm.enlace({ reserva_id: RID }, cr.opts)).motivo, "no_disponible"); assert.equal(cr.llamadas.length, 1);
  ok("enlace: sin_configurar (con paso), no_pagable, proveedor, base, 404, 401; en_curso → espera y UN reintento; caída sin reintento");
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

// ── 10. interruptor de backend (B10, 14-oct-2026: el valor por defecto lo da el ERP) ─────────────────────────────────────────────────────
function fakeRedis(reloj) {
  const m = new Map(); let rompe = false; let exists = 0;
  const vivo = (k) => { const e = m.get(k); if (!e) return null; if (e.hasta && e.hasta <= reloj()) { m.delete(k); return null; } return e; };
  const c = {
    keys: () => [...m.keys()],
    get existsLlamadas() { return exists; },
    async get(k) { if (rompe) throw new Error("redis caído"); const e = vivo(k); return e ? e.v : null; },
    async exists(k) { exists++; if (rompe) throw new Error("redis caído"); return vivo(k) ? 1 : 0; },
    async set(k, v) { if (rompe) throw new Error("redis caído"); m.set(k, { v }); },
    async setEx(k, ttl, v) { if (rompe) throw new Error("redis caído"); m.set(k, { v, hasta: reloj() + ttl * 1000 }); },
    async del(k) { m.delete(k); },
    caer(b) { rompe = b; },
  };
  return c;
}

// Doble de reservas-bot para `estado`, con el bbmerp.js REAL delante. `d.modo` lo cambia el test:
//   "dion" | "erp" (200 buena) · número (ese HTTP con el cuerpo de error del contrato) · "tiempo" · "red" · {body} (200 con ese cuerpo) · "cuelga" (hasta d.suelta)
function erpDoble() {
  const d = { modo: "dion", llamadas: 0, pendientes: [] };
  const cuerpoError = { 400: { error: "accion" }, 401: { error: "no_autorizado" }, 403: { error: "no_autorizado" }, 404: { error: "modulo_no_activo" } };
  const fetchImpl = async (url, init) => {
    assert.equal(url, `${URL_ERP}/functions/v1/reservas-bot`);
    assert.equal(init.method, "POST");
    assert.equal(init.headers["x-bot-secret"], SECRET);
    assert.ok(init.signal instanceof AbortSignal, "siempre con tiempo máximo");
    assert.deepEqual(JSON.parse(init.body), { accion: "estado" }, "cuerpo EXACTO {accion:'estado'}");
    d.llamadas++;
    const m = d.modo;
    if (m === "cuelga") return new Promise((ok) => d.pendientes.push(ok));
    if (m === "tiempo") { const e = new Error("tiempo"); e.name = "TimeoutError"; throw e; }
    if (m === "red") throw new TypeError("fetch failed");
    if (typeof m === "number") return { status: m, json: async () => cuerpoError[m] || { error: "base" } };
    if (m === "dion" || m === "erp") return { status: 200, json: async () => ({ r: { backend: m } }) };
    return { status: 200, json: async () => m.body };
  };
  const logsErp = [];
  d.erp = createBbmErp({ url: URL_ERP, secret: SECRET, fetchImpl, log: { warn: (x) => logsErp.push(x), error: (x) => logsErp.push(x), log: (x) => logsErp.push(x) }, project: "T" });
  d.logsErp = logsErp;
  d.suelta = (b) => { for (const ok of d.pendientes.splice(0)) ok({ status: 200, json: async () => ({ r: { backend: b } }) }); };
  return d;
}

// ── 10a. estado(): forma exacta, códigos de una lista cerrada, sin log, timeout propio ───────────────────────────────────────────────
{
  assert.equal(ESTADO_TIMEOUT_MS, 1500, "timeout de `estado` ≤ 1,5 s");
  assert.equal(BACKEND_TTL_MS, 30000); assert.equal(BACKEND_MAX_STALE_MS, 300000);
  const d = erpDoble();
  const tabla = [
    ["erp", { ok: true, backend: "erp" }], ["dion", { ok: true, backend: "dion" }],
    [400, { ok: false, clase: "definitivo", codigo: "400" }], [401, { ok: false, clase: "definitivo", codigo: "401" }],
    [403, { ok: false, clase: "definitivo", codigo: "403" }], [404, { ok: false, clase: "definitivo", codigo: "404" }],
    [409, { ok: false, clase: "definitivo", codigo: "otro_4xx" }], [413, { ok: false, clase: "definitivo", codigo: "otro_4xx" }],
    [429, { ok: false, clase: "transitorio", codigo: "429" }], [500, { ok: false, clase: "transitorio", codigo: "5xx" }],
    [502, { ok: false, clase: "transitorio", codigo: "5xx" }], [503, { ok: false, clase: "transitorio", codigo: "5xx" }],
    ["tiempo", { ok: false, clase: "transitorio", codigo: "tiempo" }], ["red", { ok: false, clase: "transitorio", codigo: "red" }],
    [{ body: { r: { backend: "ERP" } } }, { ok: false, clase: "definitivo", codigo: "forma" }],
    [{ body: { r: { backend: "erp", x: 1 } } }, { ok: false, clase: "definitivo", codigo: "forma" }],
    [{ body: { r: { backend: "erp" }, x: 1 } }, { ok: false, clase: "definitivo", codigo: "forma" }],
    [{ body: undefined }, { ok: false, clase: "definitivo", codigo: "forma" }],
  ];
  for (const [modo, esperado] of tabla) { d.modo = modo; assert.deepEqual(await d.erp.estado(), esperado, `estado con ${JSON.stringify(modo)}`); }
  for (const [, r] of tabla) if (!r.ok) assert.ok(CODIGOS_ESTADO.includes(r.codigo), `código de lista cerrada: ${r.codigo}`);
  assert.equal(d.llamadas, tabla.length);
  assert.deepEqual(d.logsErp, [], "estado() no escribe NADA en el log (el log de cambios es del interruptor)");
  // sin variables: no llama
  let llamado = false;
  const sinCfg = createBbmErp({ fetchImpl: async () => { llamado = true; }, log: silent });
  assert.deepEqual(await sinCfg.estado(), { ok: false, clase: "definitivo", codigo: "no_configurado" }); assert.equal(llamado, false);
  // timeout propio (aquí 40 ms) con una edge colgada que respeta la señal
  const colgado = (url, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(init.signal.reason)));
  const lento = createBbmErp({ url: URL_ERP, secret: SECRET, fetchImpl: colgado, estadoTimeoutMs: 40, log: silent });
  const keep = setTimeout(() => {}, 10000);
  const t0 = Date.now();
  assert.deepEqual(await lento.estado(), { ok: false, clase: "transitorio", codigo: "tiempo" });
  assert.ok(Date.now() - t0 < 1000);
  clearTimeout(keep);
  // un 2xx que no es 200 es una forma inesperada (no un 4xx), y el cuerpo de una respuesta no-200 se cancela (no retiene la conexión)
  for (const [st, cod, clase] of [[204, "forma", "definitivo"], [201, "forma", "definitivo"], [401, "401", "definitivo"], [503, "5xx", "transitorio"]]) {
    let cancelado = false;
    const r = createBbmErp({ url: URL_ERP, secret: SECRET, log: silent, fetchImpl: async () => ({ status: st, body: { cancel: async () => { cancelado = true; } }, json: async () => ({ r: { backend: "erp" } }) }) });
    assert.deepEqual(await r.estado(), { ok: false, clase, codigo: cod }, `estado con ${st}`);
    assert.equal(cancelado, true, `${st}: cuerpo cancelado`);
  }
  ok("estado(): cuerpo {accion:'estado'}, solo {r:{backend}} exacto es bueno, 400/401/403/404/forma definitivos, tiempo/red/5xx/429 transitorios, sin log");
}

{
  let t = 5_000_000; const now = () => t;
  const mkSw = (o = {}) => {
    const logs = [];
    const lg = { warn: (m) => logs.push(m), error: (m) => logs.push(m), log: (m) => logs.push(m) };
    const sw = createBackendSwitch({ redis: () => o.redis ?? null, erp: o.erp, freno: o.freno, bbmBackendObsoleta: o.obsoleta, enlaceVivo: o.enlaceVivo, telefonosErp: o.telefonosErp, now, reloj: now, log: lg, project: "T", ...(o.esperaMs ? { esperaMs: o.esperaMs } : {}), ...(o.refrescoMs ? { refrescoMs: o.refrescoMs } : {}) });
    return { sw, logs, cambios: () => logs.filter((x) => x.includes("quién atiende por defecto")) };
  };
  const CLAVES_SALUD = ["backend", "backend_error", "backend_fuente", "backend_lectura_ms", "backend_leido_hace_s", "erp_dice", "freno", "obsoletas"];

  // 10b. Sin ERP configurado (o fuera de rental): dion sin leer nada. Ni BBM_BACKEND ni `bbm:backend` cambian nada.
  {
    const redis = fakeRedis(now);
    await redis.set("bbm:backend", "erp-valor-viejo-7");
    const d = erpDoble(); d.modo = "erp";
    for (const erp of [undefined, null, createBbmErp({ log: silent }), () => null]) {
      const { sw } = mkSw({ erp, redis, obsoleta: "erp" });
      assert.equal(await sw.bbmBackend("1"), "dion");
      const s = await sw.salud();
      assert.deepEqual(s, { backend: "dion", backend_fuente: "sin_erp", erp_dice: null, freno: false, backend_error: null, backend_leido_hace_s: null, backend_lectura_ms: null, obsoletas: { BBM_BACKEND: true, redis_bbm_backend: true } });
      assert.ok(!JSON.stringify(s).includes("erp-valor-viejo-7"), "health dice SI existe bbm:backend, nunca su valor");
    }
    assert.equal(d.llamadas, 0);
    ok("sin ERP configurado: dion (sin_erp), sin leer; BBM_BACKEND=erp y bbm:backend=erp NO mandan, solo salen como obsoletas");
  }

  // 10c. LA EVIDENCIA DEL CRITERIO: el ERP dice erp y no hay NINGUNA variable ⇒ health backend erp, fuente erp. Arranque en frío: 1 petición, el turno la espera.
  {
    const d = erpDoble(); d.modo = "erp";
    const { sw, logs } = mkSw({ erp: () => d.erp });
    assert.equal(await sw.bbmBackend("62811111111"), "erp", "primer turno en frío: espera la lectura (≤ 1,5 s) y va al ERP");
    assert.equal(d.llamadas, 1);
    const s = await sw.salud();
    assert.deepEqual(Object.keys(s).sort(), CLAVES_SALUD, "health: solo estas claves");
    assert.deepEqual(s, { backend: "erp", backend_fuente: "erp", erp_dice: "erp", freno: false, backend_error: null, backend_leido_hace_s: 0, backend_lectura_ms: 0, obsoletas: { BBM_BACKEND: false, redis_bbm_backend: false } });
    assert.equal(d.llamadas, 1, "health NO se salta la caché de 30 s");
    t += 12_000;
    assert.equal((await sw.salud()).backend_leido_hace_s, 12);
    assert.ok(FUENTES_BACKEND.includes(s.backend_fuente));
    assert.ok(!logs.some((x) => x.includes(SECRET) || x.includes(URL_ERP)), "el log no lleva secreto ni URL");
    // y con el ERP diciendo dion: dion, fuente erp
    const d2 = erpDoble(); d2.modo = "dion";
    const { sw: sw2 } = mkSw({ erp: d2.erp });
    assert.deepEqual(await sw2.salud(), { backend: "dion", backend_fuente: "erp", erp_dice: "dion", freno: false, backend_error: null, backend_leido_hace_s: 0, backend_lectura_ms: 0, obsoletas: { BBM_BACKEND: false, redis_bbm_backend: false } });
    ok("CRITERIO: ERP dice erp y ninguna variable ⇒ health {backend:'erp', backend_fuente:'erp'}; con dion ⇒ dion/erp; health respeta la caché");
  }

  // 10d. ORDEN FIJO: pin › enlace vivo › teléfono de prueba › freno › ERP › dion. Un test por cada lado.
  {
    const d = erpDoble();
    const redis = fakeRedis(now);
    const vivos = new Set(["62820000002"]);
    const tels = new Set(["62830000003"]);
    const base = { erp: d.erp, redis, enlaceVivo: async (x) => vivos.has(x), telefonosErp: tels };
    // ERP › dion por defecto
    d.modo = "erp"; assert.equal(await mkSw(base).sw.bbmBackend("62899999999"), "erp", "ERP erp gana al dion por defecto");
    d.modo = "dion"; assert.equal(await mkSw(base).sw.bbmBackend("62899999999"), "dion", "ERP dion ⇒ dion");
    // freno › ERP (y con el freno no se lee nada)
    d.modo = "erp"; const antes = d.llamadas;
    const fr = mkSw({ ...base, freno: "1" });
    assert.equal(await fr.sw.bbmBackend("62899999999"), "dion", "freno gana al ERP");
    assert.equal((await fr.sw.salud()).backend_fuente, "freno_variable");
    assert.equal(d.llamadas, antes, "con el freno puesto NO hay petición");
    // teléfono de prueba › freno
    assert.equal(await fr.sw.bbmBackend("62830000003"), "erp", "teléfono de prueba gana al freno");
    // enlace vivo › freno, y › ERP dion
    assert.equal(await fr.sw.bbmBackend("62820000002"), "erp", "enlace vivo gana al freno");
    d.modo = "dion"; assert.equal(await mkSw(base).sw.bbmBackend("62820000002"), "erp", "enlace vivo gana al ERP dion");
    // pin › enlace vivo, › teléfono de prueba, › ERP, y un pin erp › freno
    const sp = mkSw(base);
    d.modo = "erp";
    await sp.sw.fija("62820000002", 1800, "dion"); assert.equal(await sp.sw.bbmBackend("62820000002"), "dion", "pin dion gana al enlace vivo");
    await sp.sw.fija("62830000003", 1800, "dion"); assert.equal(await sp.sw.bbmBackend("62830000003"), "dion", "pin dion gana al teléfono de prueba");
    await sp.sw.fija("62840000004", 1800, "dion"); assert.equal(await sp.sw.bbmBackend("62840000004"), "dion", "pin dion gana al ERP erp");
    await sp.sw.fija("62850000005", 1800, "erp");
    assert.equal(await mkSw({ ...base, freno: "1" }).sw.bbmBackend("62850000005"), "erp", "pin erp gana al freno (no se cambia de sistema a media reserva)");
    assert.equal(await mkSw({ ...base, freno: "1" }).sw.bbmBackend("62860000006"), "dion");
    ok("orden fijo: pin › enlace vivo › teléfono de prueba › freno › ERP › dion (un test por cada lado; el freno no lee el ERP)");
  }

  // 10e. ERP caído desde el arranque ⇒ dion; caído DESPUÉS de leer erp ⇒ erp (erp_cache) hasta 5 min y luego dion.
  {
    for (const caida of ["tiempo", "red", 500, 503]) {
      const d = erpDoble(); d.modo = caida;
      const { sw } = mkSw({ erp: d.erp });
      assert.equal(await sw.bbmBackend("1"), "dion", `caído desde el arranque (${caida}) ⇒ dion`);
      const s = await sw.salud();
      assert.equal(s.backend_fuente, "defecto_por_fallo"); assert.equal(s.erp_dice, null);
      assert.equal(s.backend_error, typeof caida === "number" ? "5xx" : caida);
    }
    const d = erpDoble(); d.modo = "erp";
    const { sw } = mkSw({ erp: d.erp });
    const t0 = t;
    assert.equal(await sw.bbmBackend("1"), "erp");
    d.modo = "tiempo";
    t = t0 + 2 * 60_000;
    assert.equal(await sw.bbmBackend("1"), "erp", "con un erp bueno de 2 min y el ERP sin contestar: lee, falla (transitorio) y vale el último bueno");
    await sw.refresca();
    assert.equal(await sw.bbmBackend("1"), "erp");
    let s = await sw.salud();
    assert.deepEqual([s.backend, s.backend_fuente, s.erp_dice, s.backend_error, s.backend_leido_hace_s], ["erp", "erp_cache", "erp", "tiempo", 120], "erp_cache: edad del valor bueno");
    t = t0 + 4 * 60_000 + 59_000;
    assert.equal(await sw.bbmBackend("1"), "erp", "a los 4:59 sigue el último bueno");
    await sw.refresca();
    t = t0 + 5 * 60_000 + 1000;
    assert.equal(await sw.bbmBackend("1"), "dion", "pasados 5 min del último bueno ⇒ dion");
    s = await sw.salud();
    assert.deepEqual([s.backend, s.backend_fuente, s.erp_dice, s.backend_error], ["dion", "defecto_por_fallo", null, "tiempo"]);
    // el ERP vuelve: en cuanto se refresca, erp otra vez
    d.modo = "erp"; t += 31_000;
    await sw.bbmBackend("1"); await sw.refresca();
    assert.equal(await sw.bbmBackend("1"), "erp");
    ok("ERP caído desde el arranque ⇒ dion; caído tras leer erp ⇒ erp_cache hasta 5 min y luego dion; al volver, erp");
  }

  // 10f. > 5 min sin tráfico: el turno ESPERA una lectura (no contesta dion por no haber leído) y, si el ERP está caído, dion.
  {
    const d = erpDoble(); d.modo = "erp";
    const { sw } = mkSw({ erp: d.erp });
    assert.equal(await sw.bbmBackend("1"), "erp");
    t += 6 * 60_000;
    const n = d.llamadas;
    assert.equal(await sw.bbmBackend("1"), "erp", "6 min sin tráfico y el ERP dice erp ⇒ espera y lee: erp (no el primer cliente de la mañana a Dion)");
    assert.equal(d.llamadas, n + 1);
    t += 6 * 60_000; d.modo = 503;
    assert.equal(await sw.bbmBackend("1"), "dion", "6 min sin tráfico y el ERP caído ⇒ dion");
    ok("tras > 5 min sin tráfico el turno lee el ERP antes de contestar; con el ERP caído, dion");
  }

  // 10g. 401 y 400 (y 403/404) ⇒ dion AL MOMENTO, caché negativa 30 s, y se olvida el último bueno (un timeout de después no resucita erp).
  {
    for (const cod of [400, 401, 403, 404]) {
      const d = erpDoble(); d.modo = "erp";
      const { sw } = mkSw({ erp: d.erp });
      assert.equal(await sw.bbmBackend("1"), "erp");
      d.modo = cod; t += 31_000;
      await sw.bbmBackend("1"); await sw.refresca();
      assert.equal(await sw.bbmBackend("1"), "dion", `${cod} con un erp de hace 31 s ⇒ dion al momento`);
      const s = await sw.salud();
      assert.deepEqual([s.backend, s.backend_fuente, s.backend_error, s.erp_dice], ["dion", "defecto_por_fallo", String(cod), null]);
      const n = d.llamadas;
      for (let i = 0; i < 10; i++) { t += 2_000; assert.equal(await sw.bbmBackend("1"), "dion"); }
      assert.equal(d.llamadas, n, `${cod}: caché negativa de 30 s, ninguna petición más`);
      d.modo = "tiempo"; t += 11_000;   // un minuto después del último erp bueno, el ERP pasa a no contestar
      assert.equal(await sw.bbmBackend("1"), "dion", `${cod} y luego tiempo agotado: NO resucita el erp viejo`);
      await sw.refresca();
      assert.equal(await sw.bbmBackend("1"), "dion", `${cod} y luego tiempo agotado (ya leído): NO resucita el erp viejo`);
      const s2 = await sw.salud();
      assert.deepEqual([s2.backend, s2.backend_fuente, s2.erp_dice, s2.backend_error], ["dion", "defecto_por_fallo", null, "tiempo"]);
    }
    ok("400/401/403/404 ⇒ dion al momento con caché negativa de 30 s; el último bueno se olvida");
  }

  // 10h. forma mala ⇒ dion
  {
    for (const mala of CONTRATO.acciones.estado.formas_malas) {
      const d = erpDoble(); d.modo = { body: mala };
      const { sw } = mkSw({ erp: d.erp });
      assert.equal(await sw.bbmBackend("1"), "dion", `forma mala ${JSON.stringify(mala)} ⇒ dion`);
      assert.equal((await sw.salud()).backend_error, "forma");
    }
    ok("una respuesta 200 con otra forma que {r:{backend}} exacto ⇒ dion (backend_error forma)");
  }

  // 10i. inflight: N turnos a la vez = 1 petición. Caché caducada: con erp en memoria el turno ESPERA la lectura (volver a dion en Ajustes se nota
  //      en ≤ 30 s, revisor 14-oct); con dion NO espera (devuelve dion y refresca detrás).
  {
    const d = erpDoble(); d.modo = "cuelga";
    const { sw } = mkSw({ erp: d.erp });
    const turnos = Array.from({ length: 12 }, (_, i) => sw.bbmBackend(`6281000000${String(i).padStart(2, "0")}`));
    turnos.push(sw.salud().then((s) => s.backend));
    await new Promise((r) => setImmediate(r));
    assert.equal(d.llamadas, 1, "13 lecturas simultáneas en frío = 1 petición");
    d.suelta("erp");
    assert.deepEqual(await Promise.all(turnos), Array(13).fill("erp"));
    // caducada a los 30 s con erp en memoria: el turno ESPERA la lectura, y la vuelta a dion de Ajustes llega a ESE turno
    t += 31_000; d.modo = "cuelga";
    let resuelto = false;
    const p = sw.bbmBackend("1").then((b) => { resuelto = true; return b; });
    await new Promise((r) => setImmediate(r));
    assert.equal(resuelto, false, "con erp en memoria y la caché caducada el turno espera la lectura");
    assert.equal(d.llamadas, 2);
    const otros = Promise.all([sw.bbmBackend("2"), sw.bbmBackend("3")]);
    await new Promise((r) => setImmediate(r));
    assert.equal(d.llamadas, 2, "mientras hay una en vuelo no sale otra");
    d.suelta("dion");
    assert.equal(await p, "dion", "Ajustes pasó a dion: el primer turno pasados 30 s ya contesta dion (nunca un erp de hasta 5 min)");
    assert.deepEqual(await otros, ["dion", "dion"]);
    // caducada con dion en memoria: el turno contesta YA (lado seguro) y la petición nueva queda en vuelo
    t += 31_000; d.modo = "cuelga";
    resuelto = false;
    const q = sw.bbmBackend("1").then((b) => { resuelto = true; return b; });
    await new Promise((r) => setImmediate(r));
    assert.equal(resuelto, true, "con dion en memoria y la caché caducada el turno no espera a la red");
    assert.equal(await q, "dion");
    assert.equal(d.llamadas, 3);
    d.suelta("erp"); await sw.refresca();
    assert.equal(await sw.bbmBackend("1"), "erp", "el refresco de fondo trae el valor nuevo");
    ok("inflight: N turnos simultáneos = 1 petición; caché caducada ⇒ con erp espera la lectura (vuelta a dion ≤ 30 s), con dion refresca detrás");
  }

  // 10i-bis (bbm-bot, 15-oct). LECTURA LENTA (la de Railway EE. UU. contra la base en Singapur, ~1,9 s): el turno deja de esperar a los `esperaMs` y
  //   contesta dion, pero la lectura NO se corta y el turno siguiente ya la ve. Antes el mismo tope cortaba la lectura y el bot salía SIEMPRE defecto_por_fallo.
  {
    assert.equal(ESTADO_LECTURA_MS, 8000, "la lectura tiene su propio tope, más largo que la espera del turno");
    assert.ok(BACKEND_REFRESCO_MS < BACKEND_TTL_MS, "el temporizador refresca antes de que caduque la caché");
    const d = erpDoble(); d.modo = "cuelga";
    const { sw, cambios } = mkSw({ erp: d.erp, esperaMs: 30 });
    const t0 = Date.now();
    assert.equal(await sw.bbmBackend("1"), "dion", "lectura lenta en frío: el turno no espera más de esperaMs y contesta dion");
    assert.ok(Date.now() - t0 < 1000, "el turno sale al tope de espera, no al de la lectura");
    const s = await sw.salud();
    assert.deepEqual([s.backend, s.backend_fuente, s.backend_error, s.backend_lectura_ms], ["dion", "defecto_por_fallo", "en_curso", null], "health: primera lectura aún en vuelo");
    assert.equal(d.llamadas, 1, "la espera del health no lanza otra lectura: sigue la misma");
    d.suelta("erp"); await sw.refresca();
    assert.equal(await sw.bbmBackend("1"), "erp", "la lectura terminó tarde y el turno siguiente ya va al ERP");
    assert.equal((await sw.salud()).backend_fuente, "erp");
    assert.ok(cambios().some((x) => /fuente erp, lectura \d+ ms/.test(x)), "el log de cambio lleva la duración de la lectura (así se mide en Railway)");
    ok("lectura lenta: el turno espera ≤ esperaMs y sigue con dion; la lectura no se corta y el turno siguiente ve erp; health en_curso y lectura_ms");
  }

  // 10i-ter. TEMPORIZADOR (arranca): con erp y 6 min sin tráfico el turno NO espera (la caché sigue fresca); con el freno no lee nada; para() lo quita.
  {
    const espera = (ms) => new Promise((r) => setTimeout(r, ms));
    const d = erpDoble(); d.modo = "erp";
    const { sw } = mkSw({ erp: d.erp, refrescoMs: 5 });
    await sw.arranca();
    const n0 = d.llamadas;
    t += 6 * 60_000; await espera(40);
    assert.ok(d.llamadas > n0, "el temporizador ha leído solo, sin ningún turno");
    sw.para();
    d.modo = "cuelga";
    let resuelto = false;
    const p = sw.bbmBackend("1").then((b) => { resuelto = true; return b; });
    await new Promise((r) => setImmediate(r));
    assert.equal(resuelto, true, "con el temporizador la caché está fresca: el turno no espera a la red");
    assert.equal(await p, "erp", "6 min sin tráfico y el ERP dice erp ⇒ erp sin esperar");
    const n1 = d.llamadas; await espera(30);
    assert.equal(d.llamadas, n1, "para() quita el temporizador");
    d.suelta("erp");
    const f = erpDoble(); f.modo = "erp";
    const fr = mkSw({ erp: f.erp, freno: "1", refrescoMs: 5 });
    await fr.sw.arranca(); await espera(40); fr.sw.para();
    assert.equal(f.llamadas, 0, "con el freno puesto el temporizador no lee el ERP");
    ok("temporizador: lee solo cada refrescoMs (6 min sin tráfico siguen en erp sin esperar); con el freno no lee; para() lo quita");
  }

  // 10j. un pin vivo NO cambia aunque el ERP cambie; fija() sin backend usa el valor por defecto nuevo
  {
    const d = erpDoble(); d.modo = "erp";
    const redis = fakeRedis(now);
    const { sw } = mkSw({ erp: d.erp, redis });
    assert.equal(await sw.fija("111", 1800), "erp", "fija() sin backend toma el valor del ERP");
    d.modo = "dion"; t += 31_000; await sw.bbmBackend("x"); await sw.refresca();
    assert.equal(await sw.bbmBackend("222"), "dion", "conversación nueva: lo que dice el ERP ahora");
    assert.equal(await sw.bbmBackend("111"), "erp", "la conversación con cotización viva SIGUE en erp");
    assert.equal(await sw.fija("111", 1800, "dion"), "erp", "fija no pisa un backend vivo");
    assert.equal(await sw.fija("333", 1800), "dion", "fija() sin backend: dion, lo que dice ahora el ERP");
    d.modo = "erp"; t += 31_000; await sw.bbmBackend("x"); await sw.refresca();
    assert.equal(await sw.bbmBackend("333"), "dion", "y el pin dion no se mueve a erp");
    t += 1801 * 1000;                                              // las cotizaciones mueren
    assert.equal(await sw.bbmBackend("333"), "erp", "sin cotización viva, cambia");
    await sw.suelta("111");
    assert.ok(redis.keys().every((k) => k.startsWith("bbm:pin:")), "solo claves propias bbm:pin: (ya no se lee ni escribe bbm:backend)");
    // pin ilegible o con backend desconocido = sin pin
    await redis.set("bbm:pin:444", "{no json");
    assert.equal(await sw.bbmBackend("444"), "erp");
    await redis.set("bbm:pin:444", JSON.stringify({ backend: "raro", hasta: t + 99999 }));
    assert.equal(await sw.bbmBackend("444"), "erp", "pin con backend desconocido = sin pin");
    // Redis cae al leer el pin: no se sabe si había cotización viva ⇒ dion
    redis.caer(true);
    assert.equal(await sw.bbmBackend("444"), "dion");
    redis.caer(false);
    assert.equal(await sw.bbmBackend(null), "erp", "sin teléfono: el valor por defecto");
    ok("pin vivo: no cambia aunque cambie el ERP; fija() sin backend usa el valor del ERP; pin ilegible = sin pin; Redis caído al leer el pin ⇒ dion");
  }

  // 10k. un enlace de pago rsv: vivo ata la conversación a erp aunque el pin haya caducado y el ERP diga dion
  {
    const d = erpDoble(); d.modo = "dion";
    const redis = fakeRedis(now);
    const reg = createPendingRsv({ redis: () => redis, now });
    const { sw } = mkSw({ erp: d.erp, redis, enlaceVivo: (tel) => reg.lee(tel).then(Boolean) });
    await sw.fija("777000", 600, "erp");
    await reg.guarda("777000", { external_id: `rsv:${RESERVA.id}`, importe: 330000, caduca_en_ms: t + 3000 * 1000 });
    t += 601 * 1000;
    assert.equal(await sw.bbmBackend("777000"), "erp", "pin caducado + enlace vivo ⇒ erp");
    assert.equal(await sw.bbmBackend("888000"), "dion", "otra conversación ⇒ dion");
    t += 3000 * 1000;
    assert.equal(await sw.bbmBackend("777000"), "dion");
    const roto = mkSw({ erp: d.erp, redis, enlaceVivo: async () => { throw new Error("x"); } });
    assert.equal(await roto.sw.bbmBackend("777000"), "dion");
    ok("backend: un enlace rsv: pagable ata la conversación a erp aunque el pin haya caducado");
  }

  // 10l. ORDEN DE DESPLIEGUE. (1) bot nuevo contra edge vieja: 400 ⇒ dion, caché negativa, una línea de log y no una por turno.
  //      (2) llega la edge nueva: a los 30 s el bot la lee sola. (3) edge nueva desde el principio = 10c.
  {
    const d = erpDoble(); d.modo = 400;
    const m = mkSw({ erp: d.erp });
    for (let i = 0; i < 50; i++) { assert.equal(await m.sw.bbmBackend(`62870000${String(i).padStart(3, "0")}`), "dion"); t += 500; }   // 25 s de tráfico
    assert.equal(d.llamadas, 1, "edge vieja: 1 petición en 25 s de tráfico");
    assert.equal(m.cambios().length, 1, "edge vieja: UNA línea de log, no una por turno");
    assert.match(m.cambios()[0], /dion \(fuente defecto_por_fallo, error 400, lectura \d+ ms\)/);
    for (let i = 0; i < 40; i++) { await m.sw.bbmBackend("1"); t += 1_500; }                                                             // 60 s más
    assert.ok(d.llamadas <= 4, `una petición cada 30 s como mucho (${d.llamadas})`);
    assert.equal(m.cambios().length, 1, "mismo resultado ⇒ sin línea nueva");
    assert.equal((await m.sw.salud()).backend_error, "400");
    d.modo = "erp"; t += 31_000;                                                                                                        // (2) la edge nueva
    assert.equal(await m.sw.bbmBackend("1"), "erp", "con la edge nueva el bot pasa a leerla sin redeploy");
    assert.equal(m.cambios().length, 2, "y lo dice UNA vez");
    assert.match(m.cambios()[1], /erp \(fuente erp, lectura \d+ ms\)/);
    ok("despliegue bot→edge: 400 de la edge vieja ⇒ dion, 1 petición/30 s y una sola línea de log; al llegar la edge, erp solo");
  }

  // 10m. obsoletas: BBM_BACKEND con cualquier valor se avisa y NO manda; bbm:backend en Redis: solo si existe, exists cacheado 30 s, nunca en el turno.
  {
    const d = erpDoble(); d.modo = "dion";
    for (const v of ["erp", "dion", "", "quiensabe"]) {
      const m = mkSw({ erp: d.erp, obsoleta: v });
      assert.ok(m.logs.some((x) => /BBM_BACKEND está puesta y YA NO SE USA/.test(x)), `aviso al arrancar con BBM_BACKEND=«${v}»`);
      assert.equal(await m.sw.bbmBackend("1"), "dion", "BBM_BACKEND=erp no gana al ERP");
      assert.equal((await m.sw.salud()).obsoletas.BBM_BACKEND, true);
    }
    d.modo = "erp";
    assert.equal(await mkSw({ erp: d.erp, obsoleta: "dion" }).sw.bbmBackend("1"), "erp", "BBM_BACKEND=dion (lo que hay hoy en Railway) NO frena el gesto del ERP");
    assert.equal(mkSw({ erp: d.erp }).logs.length, 0, "sin la variable, ningún aviso");
    // la clave Redis vieja
    const redis = fakeRedis(now);
    await redis.set("bbm:backend", "dion");
    const m = mkSw({ erp: d.erp, redis });
    for (let i = 0; i < 5; i++) assert.equal(await m.sw.bbmBackend(`1${i}`), "erp", "bbm:backend=dion ya no manda");
    assert.equal(redis.existsLlamadas, 0, "el turno no mira la clave vieja");
    assert.equal((await m.sw.salud()).obsoletas.redis_bbm_backend, true);
    await m.sw.salud(); await m.sw.salud();
    assert.equal(redis.existsLlamadas, 1, "exists cacheado 30 s con el resto");
    await redis.del("bbm:backend"); t += 31_000;
    assert.equal((await m.sw.salud()).obsoletas.redis_bbm_backend, false);
    redis.caer(true); t += 31_000;
    assert.equal((await m.sw.salud()).obsoletas.redis_bbm_backend, false, "Redis caído: no rompe el health");
    redis.caer(false);
    // arranca(): primera lectura + aviso de la clave vieja
    await redis.set("bbm:backend", "erp");
    const a = mkSw({ erp: d.erp, redis });
    const n = d.llamadas;
    await a.sw.arranca();
    assert.equal(d.llamadas, n + 1, "arranca() hace la primera lectura");
    assert.ok(a.logs.some((x) => /bbm:backend existe y YA NO SE USA/.test(x)));
    assert.equal(await a.sw.bbmBackend("1"), "erp"); assert.equal(d.llamadas, n + 1, "el primer turno la encuentra hecha");
    const af = mkSw({ erp: d.erp, freno: "1" }); await af.sw.arranca();
    assert.equal(d.llamadas, n + 1, "arranca() con el freno puesto no lee nada");
    ok("BBM_BACKEND y bbm:backend: avisadas como obsoletas, no mandan; health solo dice si la clave existe (exists cacheado, fuera del turno)");
  }

  // 10n. el freno: 1 = puesto; ausente, vacío o 0 = sin freno; cualquier otro valor = puesto y se grita
  {
    const errs = [];
    const lg = { error: (m) => errs.push(m), warn() {}, log() {} };
    assert.equal(leeFreno("1", lg), true); assert.equal(leeFreno(" 1 ", lg), true); assert.equal(errs.length, 0);
    for (const no of [undefined, null, "", "0", " 0 "]) assert.equal(leeFreno(no, lg), false, `sin freno con «${no}»`);
    assert.equal(errs.length, 0);
    for (const raro of ["true", "si", "yes", "2", "dion"]) assert.equal(leeFreno(raro, lg), true, `«${raro}» ⇒ freno puesto`);
    assert.equal(errs.length, 5);
    const d = erpDoble(); d.modo = "erp";
    const m = mkSw({ erp: d.erp, freno: "true" });
    assert.equal(await m.sw.bbmBackend("1"), "dion"); assert.equal(d.llamadas, 0);
    assert.deepEqual(await m.sw.salud(), { backend: "dion", backend_fuente: "freno_variable", erp_dice: null, freno: true, backend_error: null, backend_leido_hace_s: null, backend_lectura_ms: null, obsoletas: { BBM_BACKEND: false, redis_bbm_backend: false } });
    assert.ok(m.logs.some((x) => /FRENO PUESTO/.test(x)), "el freno se dice al arrancar");
    ok("BBM_FRENO_DION: 1 = freno; vacío/0 = sin freno; otro valor = freno puesto y aviso (una errata no deja sin freno)");
  }

  // 10o. modo RAM (sin Redis): mismas reglas
  {
    const d = erpDoble(); d.modo = "erp";
    const ram = mkSw({ erp: d.erp });
    assert.equal(await ram.sw.bbmBackend("9"), "erp");
    assert.equal(await ram.sw.fija("9", 600), "erp");
    d.modo = "dion"; t += 31_000; await ram.sw.bbmBackend("x"); await ram.sw.refresca();
    assert.equal(await ram.sw.bbmBackend("9"), "erp"); assert.equal(await ram.sw.bbmBackend("10"), "dion");
    assert.equal(normalizaBackend(undefined), "dion"); assert.equal(normalizaBackend(7), "dion");
    ok("backend sin Redis (RAM): mismas reglas");
  }
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
