// Self-check del filtro «solo cotizaciones aún vendibles» (seguimiento-viva.js + su uso en seguimiento-tick.js). Ejecutar: node test-seguimiento-viva.js
import assert from "node:assert";
import { createCotizacionViva, SEG_TTL_MAX_S, SEG_TTL_MIN_S } from "./seguimiento-viva.js";
import { createFollowupRunner, buildPlan, VIVA_MAX_CONSULTAS_TICK, VIVA_REST_MS, FOLLOWUP_ERP_DAILY_CAP } from "./seguimiento-tick.js";
import { createErpTools, createQuoteStore } from "./bbmflow.js";

const H = 3600 * 1000;
const NOW = new Date("2026-10-10T12:00:00").getTime();
let n = 0; const ok = (m) => { n++; console.log("ok -", m); };
const silent = () => { const lines = []; return { lines, log: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) }; };
const P1 = "11111111-1111-4111-8111-111111111111";
const HOY = "2026-10-10";
const cot = (disponibles) => ({ ok: true, cotizacion: { disponibles, total: 100, moneda: "IDR" } });

function fakeErp(resp) { const calls = []; return { calls, cotiza: async (a) => { calls.push(a); return typeof resp === "function" ? resp(a, calls.length) : resp; } }; }
function fakeRedis() { const m = new Map(), ttl = new Map(); return { m, ttl, setEx: async (k, t, v) => { m.set(k, v); ttl.set(k, t); }, get: async (k) => m.get(k) ?? null, del: async (k) => { m.delete(k); } }; }

// ── módulo ──────────────────────────────────────────────────────────────────
{
  const r = fakeRedis(), erp = fakeErp(cot(1));
  const v = createCotizacionViva({ erp, redis: () => r, hoy: () => HOY, now: () => NOW, log: silent() });
  await v.guarda("+62 811 000", { producto_id: P1, desde: "2026-10-20", hasta: "2026-10-25" });
  const k = "bbmseg:62811000";
  assert.deepEqual(JSON.parse(r.m.get(k)), { producto_id: P1, desde: "2026-10-20", hasta: "2026-10-25" });
  assert.ok(r.ttl.get(k) >= SEG_TTL_MIN_S && r.ttl.get(k) <= SEG_TTL_MAX_S);
  assert.ok(Math.abs(r.ttl.get(k) - (Date.parse("2026-10-22T00:00:00Z") - NOW) / 1000) < 1); // desde + 2 días en UTC
  assert.deepEqual(await v.verifica("62811000"), { ok: true, llamo: true });
  assert.deepEqual(erp.calls[0], { producto_id: P1, desde: "2026-10-20", hasta: "2026-10-25" }); // SOLO esos tres campos, sin direcciones
  ok("guarda con EX y solo producto+fechas; verifica llama a cotiza sin direcciones");
  await v.guarda("62811000", { producto_id: P1, desde: "2030-01-01", hasta: "2030-01-02" });
  assert.equal(r.ttl.get(k), SEG_TTL_MAX_S); ok("TTL con tope de 120 días");
  await v.guarda("62811000", { producto_id: P1, desde: "2026-10-10", hasta: "2026-10-11" });
  assert.ok(r.ttl.get(k) >= SEG_TTL_MIN_S); ok("TTL con mínimo");
  for (const mal of [{ producto_id: "x", desde: "2026-10-20", hasta: "2026-10-21" }, { producto_id: P1, desde: "2026-02-31", hasta: "2026-03-01" }, { producto_id: P1, desde: "texto", hasta: "2026-10-21" }, {}]) {
    await assert.rejects(() => v.guarda("1", mal), /inválidos/);
  }
  ok("rechaza producto/fechas inválidos (la clave solo guarda lo que valida)");
  assert.equal((await v.verifica("999")).motivo, "sin_cotizacion"); assert.equal((await v.verifica("999")).llamo, undefined);
  ok("sin cotización guardada: no llama a la red");
  r.m.set("bbmseg:5", JSON.stringify({ producto_id: "no-uuid", desde: "2026-10-20", hasta: "2026-10-21" }));
  assert.equal((await v.verifica("5")).motivo, "sin_cotizacion"); r.m.set("bbmseg:6", "{no json");
  assert.equal((await v.verifica("6")).motivo, "sin_cotizacion"); ok("lo que viene de Redis tampoco se da por bueno");
}
{
  const r = fakeRedis();
  const mk = (resp, hoy = HOY) => createCotizacionViva({ erp: fakeErp(resp), redis: () => r, hoy: () => hoy, now: () => NOW, log: silent() });
  const guarda = (v, d = "2026-10-20") => v.guarda("7", { producto_id: P1, desde: d, hasta: "2026-10-30" });
  let v = mk(cot(0)); await guarda(v);
  assert.deepEqual(await v.verifica("7"), { ok: false, motivo: "sin_disponibilidad", descansa: true, llamo: true });
  v = mk({ ok: false, motivo: "sin_disponibilidad" }); await guarda(v); assert.equal((await v.verifica("7")).motivo, "sin_disponibilidad");
  for (const raro of [{ ok: false, motivo: "datos" }, { ok: false, motivo: "modulo_apagado" }, null, undefined, {}, { ok: true }, { ok: true, cotizacion: {} }, cot("1"), cot(1.5), cot(NaN), cot(undefined)]) {
    v = mk(raro); await guarda(v); const x = await v.verifica("7");
    assert.equal(x.ok, false, JSON.stringify(raro)); assert.equal(x.motivo, "erp_no_confirma"); assert.equal(x.descansa, true);
  }
  ok("fail-closed: 409/404/502/forma rara/disponibles no entero ⇒ no vivo (nunca un truthy)");
  v = mk(() => { throw new Error("boom"); }); await guarda(v); assert.equal((await v.verifica("7")).motivo, "erp_no_confirma"); ok("cotiza que lanza ⇒ no vivo");
  v = mk(cot(1), "2026-10-20"); await guarda(v); const x = await v.verifica("7");
  assert.equal(x.motivo, "vencida"); assert.equal(r.m.has("bbmseg:7"), false); ok("fecha de inicio = hoy en Bali o pasada ⇒ vencida y se borra la clave");
  v = mk(cot(1), "2026-10-19"); await guarda(v); assert.equal((await v.verifica("7")).ok, true); ok("la fecha usa el «hoy» del negocio que se le pasa, no el reloj del servidor");
}

// ── tick ────────────────────────────────────────────────────────────────────
const ON = { mode: "on", reason: null, source: "erp", version: 7, cfg: { horas: 48, max: 2, plantilla: "bbm_seg", idioma: "en", vars: ["nombre"], version: 7 } };
const lead = (phone, h = 60) => ({ phone, name: "Maria", lastInboundAt: NOW - h * H, status: "quoted" });
function setup({ leads, viva, requerida = true, dayStart = 0, sendImpl }) {
  const out = silent(), sends = [], cnt = {}, lastAt = {}; let day = dayStart;
  const r = createFollowupRunner({
    project: "T", log: out, now: () => NOW, isBotEnabled: async () => true, resolveView: async () => ON,
    env: {}, listLeads: async () => leads, isOwner: () => false, getCount: async (p) => cnt[p] || 0, setCount: async (p, c) => { cnt[p] = c; },
    send: async (phone) => { sends.push(phone); return sendImpl ? sendImpl(phone) : { ok: true }; },
    skipStatus: new Set(["won", "lost", "noshow"]), skipIntent: new Set(["escalate"]),
    dayCount: async () => day, dayBump: async () => { day++; }, getLastSent: async (p) => lastAt[p] || 0, setLastSent: async (p, ms) => { lastAt[p] = ms; },
    viva: () => viva, vivaRequerida: () => requerida,
  });
  return { r, out, sends, day: () => day };
}
const vivaDe = (mapa, calls = []) => ({ verifica: async (tel) => { const v = mapa[tel] ?? { ok: false, motivo: "sin_cotizacion" }; if (v.llamo) calls.push(tel); return v; } });
const VIVO = { ok: true, llamo: true };
const SIN_DISP = { ok: false, motivo: "sin_disponibilidad", descansa: true, llamo: true };

{
  const t = setup({ leads: [lead("1"), lead("2"), lead("3"), lead("4")], viva: vivaDe({ 1: VIVO, 2: SIN_DISP, 4: VIVO }) });
  const res = await t.r.pass(buildPlan(ON, {}), true);
  assert.deepEqual(t.sends, ["1", "4"]); assert.equal(res.skipped.sin_disponibilidad, 1); assert.equal(res.skipped.sin_cotizacion, 1);
  ok("solo se envía a quien tiene cotización vendible; el resto se omite con su motivo en el resumen");
}
{
  const calls = [], mapa = {}; const leads = [];
  for (let i = 1; i <= 200; i++) { leads.push(lead(String(i))); mapa[i] = SIN_DISP; }
  const t = setup({ leads, viva: vivaDe(mapa, calls) });
  await t.r.tick(); const last = t.r.last();
  assert.equal(calls.length, VIVA_MAX_CONSULTAS_TICK); assert.equal(last.consultas, VIVA_MAX_CONSULTAS_TICK); assert.equal(t.sends.length, 0);
  assert.equal(last.skipped.tope_consultas, 200 - VIVA_MAX_CONSULTAS_TICK); assert.equal(t.day(), 0);
  ok("200 leads: nunca más de 10 consultas por pasada, y las consultas no gastan el tope diario de envíos");
}
{
  const leads = []; for (let i = 1; i <= 50; i++) leads.push(lead("d" + i)); leads.push(lead("vivo"));
  const t = setup({ leads, viva: vivaDe({ vivo: VIVO }) });
  await t.r.tick(); assert.deepEqual(t.sends, ["vivo"]); ok("los leads sin cotización guardada no gastan el presupuesto de consultas");
}
{
  const calls = [], mapa = {}; const leads = [];
  for (let i = 1; i <= 6; i++) { leads.push(lead(String(i))); mapa[i] = { ok: false, motivo: "erp_no_confirma", descansa: true, llamo: true }; }
  const t = setup({ leads, viva: vivaDe(mapa, calls) });
  await t.r.tick(); assert.equal(calls.length, 2); assert.equal(t.r.last().skipped.erp_caido, 4); assert.equal(t.sends.length, 0);
  ok("dos «el ERP no contesta» seguidos cortan las consultas de la pasada (y no se envía nada)");
}
{
  const calls = [];
  const t = setup({ leads: [lead("1")], viva: vivaDe({ 1: SIN_DISP }, calls) });
  await t.r.tick(); await t.r.tick(); assert.equal(calls.length, 1); assert.equal(t.r.last().skipped.descanso_vendible, 1);
  assert.ok(VIVA_REST_MS >= 6 * H);
  ok("un veredicto negativo descansa: el siguiente tick no vuelve a preguntar por ese lead");
}
{
  const t = setup({ leads: [lead("1")], viva: null, requerida: true });
  await t.r.tick(); assert.equal(t.sends.length, 0); assert.equal(t.r.last().skipped.sin_verificador, 1);
  ok("filtro exigido y sin verificador (bot sin BBM_ERP_URL): no se envía a nadie");
  const u = setup({ leads: [lead("1")], viva: null, requerida: false });
  await u.r.tick(); assert.deepEqual(u.sends, ["1"]); ok("ERP_SEGUIMIENTO_VIVA=0: sin filtro, como antes");
}
{
  const t = setup({ leads: [lead("1"), lead("2")], viva: vivaDe({ 1: VIVO, 2: VIVO }), dayStart: FOLLOWUP_ERP_DAILY_CAP });
  await t.r.tick();
  assert.equal(t.sends.length, 0); assert.equal(t.r.last().capHit, true); ok("tope diario alcanzado: ni envía ni consulta");
}
{
  // el modo variables (bot en Dion) no pasa por el filtro aunque esté «exigido»
  const sends = [];
  const r = createFollowupRunner({ project: "T", log: silent(), now: () => NOW, isBotEnabled: async () => true, resolveView: async () => ({ mode: "env", cfg: null }),
    env: { templateName: "tpl", lang: "es", schedule: "24,72", max: "2", vars: "1" }, listLeads: async () => [lead("1", 30)], isOwner: () => false,
    getCount: async () => 0, setCount: async () => {}, send: async (p) => { sends.push(p); return { ok: true }; },
    skipStatus: new Set(), skipIntent: new Set(), dayCount: async () => 0, dayBump: async () => {}, viva: () => null, vivaRequerida: () => true });
  await r.tick(); assert.deepEqual(sends, ["1"]); ok("modo variables FOLLOWUP_* (bot en Dion): el filtro no se aplica");
}

// ── guardado al cotizar (bbmflow) ───────────────────────────────────────────
{
  const guardado = [];
  const erp = {
    catalogo: async () => ({ ok: true, productos: [{ id: P1, nombre: "Honda Vario" }] }),
    cotiza: async () => ({ ok: true, cotizacion: { producto_id: P1, desde: "2026-10-20", hasta: "2026-10-22", dias: 2, total: 200, moneda: "IDR", lineas: [], disponibles: 1 } }),
    entrega: async () => ({ ok: true, estado: "ok" }),
  };
  const quotes = createQuoteStore({});
  const tools = createErpTools({ erp, quotes, seg: { guarda: async (t, d) => guardado.push([t, d]) }, log: silent(), hoy: () => HOY });
  const r = await tools.runGetQuote("62811", { bike_model: "honda vario", from: "2026-10-20", to: "2026-10-22" });
  assert.equal(r.available, true); assert.deepEqual(guardado, [["62811", { producto_id: P1, desde: "2026-10-20", hasta: "2026-10-22" }]]);
  const sinDisp = createErpTools({ erp: { ...erp, cotiza: async () => ({ ok: false, motivo: "sin_disponibilidad" }) }, quotes, seg: { guarda: async () => { throw new Error("no debe"); } }, log: silent(), hoy: () => HOY });
  assert.equal((await sinDisp.runGetQuote("62811", { bike_model: "honda vario", from: "2026-10-20", to: "2026-10-22" })).available, false);
  const rota = createErpTools({ erp, quotes, seg: { guarda: async () => { throw new Error("redis caído"); } }, log: silent(), hoy: () => HOY });
  assert.equal((await rota.runGetQuote("62811", { bike_model: "honda vario", from: "2026-10-20", to: "2026-10-22" })).available, true);
  ok("al cotizar guarda solo producto+fechas devueltos por la base; sin disponibilidad no guarda; un fallo al guardar no rompe la cotización");
}
console.log(`\n${n} comprobaciones OK`);
