// Self-check del tick del seguimiento (seguimiento-tick.js) con dependencias de mentira. Ejecutar: node test-seguimiento-tick.js
import assert from "node:assert";
import { buildPlan, createFollowupRunner, FOLLOWUP_ERP_DAILY_CAP, FOLLOWUP_FAIL_REST_MS } from "./seguimiento-tick.js";

const H = 3600 * 1000;
const NOW = new Date("2026-10-10T12:00:00").getTime();
const silent = () => { const lines = []; return { lines, log: (m) => lines.push(["log", m]), warn: (m) => lines.push(["warn", m]), error: (m) => lines.push(["error", m]) }; };
let n = 0;
const ok = (name) => { n++; console.log("ok -", name); };

const ON = (o = {}) => ({ mode: "on", reason: null, source: "erp", version: 7, cfg: { horas: 48, max: 2, plantilla: "bbm_seg", idioma: "en", vars: ["nombre"], version: 7, ...o } });
const OFF = (reason = "apagado") => ({ mode: "off", reason, source: "erp", version: null, cfg: null });
const ENVV = { mode: "env", reason: null, source: null, version: null, cfg: null };

// leads fríos: lastInboundAt hace `h` horas
const lead = (phone, h, o = {}) => ({ phone, name: "Maria Lopez", lastInboundAt: NOW - h * H, status: "quoted", ...o });

function setup({ view, leads = [], counts = {}, env = {}, sendImpl, botEnabled = true, owner = "0", dayStart = 0 }) {
  const out = silent();
  const sends = [];
  const cnt = { ...counts };
  let day = dayStart, listCalls = 0;
  const r = createFollowupRunner({
    project: "T", log: out, now: () => NOW,
    isBotEnabled: async () => botEnabled,
    resolveView: async () => view,
    env: { templateName: undefined, lang: "es", schedule: undefined, max: undefined, vars: undefined, ...env },
    listLeads: async () => { listCalls++; return leads; },
    isOwner: (p) => p === owner,
    getCount: async (p) => cnt[p] || 0,
    setCount: async (p, c) => { cnt[p] = c; },
    send: async (phone, tpl, lang, params, logId) => {
      sends.push({ phone, tpl, lang, params, logId });
      return sendImpl ? sendImpl(phone) : { ok: true };
    },
    skipStatus: new Set(["won", "lost", "noshow"]), skipIntent: new Set(["escalate", "urgent_service"]),
    dayCount: async () => day, dayBump: async () => { day++; },
  });
  return { r, out, sends, cnt, listCalls: () => listCalls, day: () => day };
}
const text = (out) => out.lines.map((l) => l[1]).join("\n");

// ── Sin variables ERP = comportamiento actual (FOLLOWUP_*) ──────────────────────────────────────────
{
  const t = setup({ view: ENVV, env: { templateName: "tpl_env", lang: "es", schedule: "24,72", max: "3", vars: "1" },
    leads: [lead("111", 30), lead("222", 10), lead("333", 80, {})], counts: { 333: 1 } });
  await t.r.tick();
  assert.deepEqual(t.sends.map((s) => s.phone), ["111", "333"]);
  assert.equal(t.sends[0].tpl, "tpl_env"); assert.equal(t.sends[0].lang, "es"); assert.deepEqual(t.sends[0].params, ["Maria"]);
  assert.equal(t.sends[0].logId, undefined);
  assert.equal(t.cnt[111], 1); assert.equal(t.cnt[333], 2);
  assert.ok(text(t.out).includes("Follow-up 1/3 enviado a 111 (frío 30h)")); // línea idéntica a la de siempre
  ok("modo env: mismas plantilla/cadencia/params/contador/log que el index.js anterior");
}
{
  const t = setup({ view: ENVV, env: {}, leads: [lead("111", 30)] }); // sin FOLLOWUP_TEMPLATE_NAME
  await t.r.tick(); assert.equal(t.sends.length, 0); assert.equal(t.listCalls(), 0); assert.equal(text(t.out), "");
  ok("modo env sin plantilla: sale en silencio antes de listLeads (como antes)");
}
{
  const t = setup({ view: ENVV, env: { templateName: "x", schedule: "5,10" }, leads: [lead("1", 99)] }); // todo <24 filtrado
  await t.r.tick(); assert.equal(t.sends.length, 0); assert.equal(t.listCalls(), 0);
  ok("modo env: cadencia <24 h filtrada (schedule vacío → no envía)");
}
{
  const t = setup({ view: ENVV, env: { templateName: "x", lang: "es", vars: "0" }, leads: [lead("1", 30)] });
  await t.r.tick(); assert.deepEqual(t.sends[0].params, []);
  ok("modo env: FOLLOWUP_TEMPLATE_VARS=0 → sin variables");
}
{
  // en modo env un envío fallido SÍ cuenta (comportamiento histórico documentado, no se toca)
  const t = setup({ view: ENVV, env: { templateName: "x", lang: "es" }, leads: [lead("1", 30)], sendImpl: () => ({ ok: false }) });
  await t.r.tick(); assert.equal(t.cnt[1], 1);
  ok("modo env: comportamiento histórico (fallo cuenta) intacto");
}
{
  const t = setup({ view: ENVV, env: { templateName: "x" }, leads: [lead("1", 30)], botEnabled: false });
  await t.r.tick(); assert.equal(t.sends.length, 0); assert.equal(t.listCalls(), 0);
  ok("bot apagado → no hay seguimiento (ambos modos)");
}

// ── Modo ERP ────────────────────────────────────────────────────────────────────────────────────────
{
  const t = setup({ view: OFF("apagado"), env: { templateName: "tpl_env" }, leads: [lead("1", 99)] });
  await t.r.tick();
  assert.equal(t.sends.length, 0); assert.equal(t.listCalls(), 0);
  assert.ok(text(t.out).includes("APAGADO por el ERP (motivo: apagado)"));
  ok("ERP apagado: sale antes de listLeads y NO usa FOLLOWUP_* aunque estén puestas");
  await t.r.tick(); assert.equal(t.out.lines.length, 1); ok("el log de apagado no se repite cada tick");
}
{
  const t = setup({ view: OFF("erp_inalcanzable_sin_cache"), env: { templateName: "tpl_env" }, leads: [lead("1", 99)] });
  await t.r.tick(); assert.equal(t.sends.length, 0);
  ok("ERP caído sin caché: apagado, jamás FOLLOWUP_*");
}
{
  const t = setup({ view: ON(), leads: [lead("111", 50), lead("222", 40), lead("333", 100), lead("444", 100)], counts: { 333: 1, 444: 2 } });
  await t.r.tick();
  assert.deepEqual(t.sends.map((s) => s.phone), ["111", "333"]); // 111: 1º a 48 h; 222: aún no; 333: 2º a 96 h; 444: tope
  assert.equal(t.sends[0].tpl, "bbm_seg"); assert.equal(t.sends[0].lang, "en"); assert.deepEqual(t.sends[0].params, ["Maria"]);
  assert.equal(t.cnt[111], 1); assert.equal(t.cnt[333], 2);
  ok("ERP: cadencia horas*(n+1), tope por lead, plantilla/idioma/vars del ERP");
}
{
  const t = setup({ view: ON({ vars: [] }), leads: [lead("1", 50)] });
  await t.r.tick(); assert.deepEqual(t.sends[0].params, []); ok("ERP: vars [] → plantilla sin variables");
}
{
  // defensa en profundidad: el motor revalida lo que llega a Meta
  for (const bad of [{ plantilla: "A/b" }, { idioma: "xx_yy" }, { horas: 2 }, { horas: 9999 }, { max: 50 }, { max: 0 }, { vars: ["texto libre"] }, { vars: ["__proto__"] }, { vars: ["constructor"] }]) {
    const t = setup({ view: ON(bad), leads: [lead("1", 5000)] });
    await t.r.tick(); assert.equal(t.sends.length, 0, JSON.stringify(bad)); assert.equal(t.listCalls(), 0);
  }
  ok("el motor revalida plantilla/idioma/horas/max/vars aunque el lector dijera que sí (incluye __proto__/constructor)");
}
{
  const t = setup({ view: ON({ plantilla: "x", idioma: "es" }), leads: [lead("999", 100)] });
  await t.r.tick();
  assert.deepEqual(Object.keys(t.sends[0]).sort(), ["lang", "logId", "params", "phone", "tpl"]);
  assert.equal(t.sends[0].tpl, "x"); ok("plantilla e idioma viajan como argumentos (campos del cuerpo JSON en sendWhatsAppTemplate), no concatenados");
}
// envío fallido NO incrementa el contador (ni lanza: send devuelve ok:false) y deja descansar al lead
{
  let fail = true;
  const t = setup({ view: ON(), leads: [lead("1", 50), lead("2", 50)], sendImpl: (p) => (p === "1" && fail ? { ok: false, error: "x" } : { ok: true }) });
  await t.r.tick();
  assert.equal(t.cnt[1], undefined); assert.equal(t.cnt[2], 1);
  assert.ok(text(t.out).includes("NO enviada") || text(t.out).includes("NO enviado"));
  ok("ERP: un envío fallido NO incrementa followup:<tel>; el siguiente lead sigue");
  await t.r.tick(); // 6 h no han pasado (now fijo) → descansa
  assert.equal(t.sends.filter((s) => s.phone === "1").length, 1); ok("ERP: el lead fallido descansa (no reintenta cada tick)");
}
{
  // sendImpl que devuelve undefined/null/otro → tratado como fallo
  for (const ret of [undefined, null, { ok: false }, { ok: "yes" }, {}]) {
    const t = setup({ view: ON(), leads: [lead("1", 50)], sendImpl: () => ret });
    await t.r.tick(); assert.equal(t.cnt[1], undefined, JSON.stringify(ret));
  }
  ok("ERP: solo ok===true cuenta como enviado");
}
{
  // tope global por día independiente de la config
  const many = Array.from({ length: FOLLOWUP_ERP_DAILY_CAP + 25 }, (_, i) => lead(String(1000 + i), 50));
  const t = setup({ view: ON({ horas: 24, max: 5 }), leads: many });
  await t.r.tick();
  assert.equal(t.sends.length, FOLLOWUP_ERP_DAILY_CAP); assert.ok(text(t.out).includes("TOPE DIARIO"));
  await t.r.tick(); assert.equal(t.sends.length, FOLLOWUP_ERP_DAILY_CAP); // tick siguiente el mismo día: nada más
  ok(`ERP: tope global ${FOLLOWUP_ERP_DAILY_CAP}/día aunque el ERP permita más, y se mantiene entre ticks`);
}
{
  const t = setup({ view: ON(), leads: [lead("1", 50), lead("2", 50)], dayStart: FOLLOWUP_ERP_DAILY_CAP - 1, sendImpl: () => ({ ok: false }) });
  await t.r.tick(); assert.equal(t.sends.length, 1); ok("ERP: los intentos fallidos también gastan tope diario (un bucle de fallos no se desboca)");
}
{
  // el log del modo ERP no lleva el teléfono en claro y sí plantilla + versión de config
  const t = setup({ view: ON(), leads: [lead("6281234567890", 50)] });
  await t.r.tick();
  const all = text(t.out);
  assert.ok(!all.includes("6281234567890"), "teléfono en claro en el log");
  assert.ok(all.includes("plantilla bbm_seg") && all.includes("config v7") && /c_[0-9a-f]{10}/.test(all));
  assert.equal(t.sends[0].logId, t.r.hashId("6281234567890")); assert.ok(!t.sends[0].logId.includes("6281234567890"));
  ok("ERP: log sin teléfono en claro (id hasheado), con plantilla y versión de config; logId pasado al envío");
}
{
  // resumen con motivos de omisión
  const t = setup({ view: ON(), leads: [lead("1", 50, { paused: true }), lead("2", 50, { status: "won" }), lead("3", 50, { intent: "escalate" }), lead("4", 5), lead("5", 50, { tags: ["Waitlist-2027"] }), lead("6", 50, { nextFollowUp: "2026-12-01" }), { phone: "7", name: "X" }, lead("0", 50)] });
  await t.r.tick();
  const all = text(t.out);
  for (const k of ["pausado=1", "cerrado=1", "escalado=1", "ventana_abierta=1", "waitlist=1", "agendado=1", "sin_inbound=1", "owner=1"]) assert.ok(all.includes(k), k);
  assert.equal(t.sends.length, 0);
  ok("ERP: mantiene todos los filtros del tick actual y registra el motivo de omisión");
}
{
  // solape: dos ticks a la vez no duplican envíos
  let release; const gate = new Promise((r) => { release = r; });
  const t = setup({ view: ON(), leads: [lead("1", 50)], sendImpl: async () => { await gate; return { ok: true }; } });
  const a = t.r.tick(); const b = t.r.tick();
  await new Promise((r) => setTimeout(r, 10)); release(); await Promise.all([a, b]);
  assert.equal(t.sends.length, 1); ok("ERP: ticks solapados no duplican envíos");
}
{
  // cadencia con cambio a mitad de vida: documenta el desplazamiento del peldaño
  const t1 = setup({ view: ON({ horas: 48 }), leads: [lead("1", 60)], counts: { 1: 1 } }); await t1.r.tick();
  assert.equal(t1.sends.length, 0, "con horas=48 el 2º peldaño es 96 h");
  const t2 = setup({ view: ON({ horas: 24 }), leads: [lead("1", 60)], counts: { 1: 1 } }); await t2.r.tick();
  assert.equal(t2.sends.length, 1, "al bajar a 24 h el mismo lead entra ya (peldaño 48 h)");
  ok("cambiar horas a mitad de vida desplaza el peldaño (comportamiento documentado)");
}
// buildPlan puro
{
  assert.equal(buildPlan(ENVV, {}).silent, true);
  assert.deepEqual(buildPlan(ON({ horas: 24, max: 3 }), {}).schedule, [24, 48, 72]);
  assert.equal(buildPlan(OFF("x"), { templateName: "t" }).off, true);
  ok("buildPlan: env sin plantilla silencioso, cadencia múltiplos, off no cae a env");
}
console.log(`\n${n} comprobaciones OK`);
void FOLLOWUP_FAIL_REST_MS;
