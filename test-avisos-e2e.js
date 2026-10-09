// S13 (LAW-507): el bot de punta a punta. Arranca `node index.js` DE VERDAD con el API de Meta falso (nada sale a Meta) y comprueba lo que llega al cliente
// y al equipo: ventana cerrada → plantilla con sus variables; ventana abierta → texto libre; freno de testing; interruptor apagado; alerta al equipo
// sin saltos de línea. Se repite con BOT_STORE=supabase (edge falsa) y con BOT_STORE=redis (memoria).
import test from "node:test";
import assert from "node:assert";
import { creaEdgeFalsa, creaGraphFalso, creaAnthropicFalso, lanzaBot, payloadTexto, hasta, esperar } from "./fakes-pg.js";

const SEC = { estado: "sec-estado", recordatorio: "sec-recordatorio", humano: "sec-humano", crm: "sec-crm" };
const OWNER = "6281100000000";
const ADMIN = { "x-admin-key": "admin-test" };
const PLANTILLAS = { CITA_CONFIRMADA_TEMPLATE_NAME: "lawang_cita_confirmada", CITA_REPROGRAMADA_TEMPLATE_NAME: "lawang_cita_reprogramada", CITA_CANCELADA_TEMPLATE_NAME: "lawang_cita_cancelada", TRASPASO_TEMPLATE_NAME: "lawang_traspaso_persona", ALERTA_EQUIPO_TEMPLATE_NAME: "lawang_alerta_equipo" };
let n = 0;
const wamid = () => `wamid.E${Date.now().toString(36)}${++n}`;
const tel = (k) => `62813000000${String(k).padStart(2, "0")}`;
const CUANDO = "2026-10-10T07:00:00Z";   // sábado 10 de octubre, 15:00 en Bali

async function entorno(modo, env = {}) {
  const edge = await creaEdgeFalsa({ secretos: SEC });
  const graph = await creaGraphFalso();
  const anthropic = await creaAnthropicFalso();
  const bot = await lanzaBot({ edge, graph, anthropic, secretos: SEC, modo, env });
  return { edge, graph, bot, async cierra() { await bot.para(); await edge.cierra(); await graph.cierra(); await anthropic.cierra(); } };
}
const params = (e) => (e.params && e.params[0] ? e.params[0].parameters.map((p) => p.text) : []);

for (const modo of ["supabase", "redis"]) {
  test(`[${modo}] sin BOT_AVISOS_CLIENTE=on el endpoint está cerrado (404) y no sale nada`, async (t) => {
    const E = await entorno(modo, PLANTILLAS);
    t.after(() => E.cierra());
    const r = await E.bot.enviaJson("/admin/api/aviso-cliente", { evento: "confirmada", phone: tel(1), cuando: CUANDO }, ADMIN);
    assert.strictEqual(r.status, 404);
    assert.strictEqual((await E.bot.enviaJson("/admin/api/aviso-cliente", { evento: "confirmada", phone: tel(1), cuando: CUANDO }, {})).status, 403, "sin la clave del panel no entra");
    assert.strictEqual(E.graph.enviados.length, 0);
  });

  test(`[${modo}] ventana cerrada → la plantilla de cita con las 3 variables en orden (nombre, tipo, fecha de Bali) y el idioma en/es`, async (t) => {
    const E = await entorno(modo, { ...PLANTILLAS, BOT_AVISOS_CLIENTE: "on", BOT_MODE: "testing", BOT_ALLOWLIST: tel(2) });
    t.after(() => E.cierra());
    const r = await E.bot.enviaJson("/admin/api/aviso-cliente", { evento: "confirmada", phone: tel(2), tipo: "visita", cuando: CUANDO, nombre: "Ana López" }, ADMIN);
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.via, "plantilla");
    const env = E.graph.a(tel(2));
    assert.strictEqual(env.length, 1);
    assert.strictEqual(env[0].type, "template");
    assert.strictEqual(env[0].plantilla, "lawang_cita_confirmada");
    assert.deepStrictEqual(params(env[0]), ["Ana", "visit", "Saturday 10 October, 15:00"]);
    const cancel = await E.bot.enviaJson("/admin/api/aviso-cliente", { evento: "cancelada", phone: tel(2), tipo: "llamada", cuando: CUANDO, nombre: "Ana López" }, ADMIN);
    assert.strictEqual(cancel.status, 200);
    assert.strictEqual(E.graph.a(tel(2))[1].plantilla, "lawang_cita_cancelada");
    assert.deepStrictEqual(params(E.graph.a(tel(2))[1]), ["Ana", "call", "Saturday 10 October, 15:00"]);
  });

  test(`[${modo}] FRENO DE TESTING: un teléfono fuera de BOT_ALLOWLIST no recibe NADA, ni plantilla ni texto`, async (t) => {
    const E = await entorno(modo, { ...PLANTILLAS, BOT_AVISOS_CLIENTE: "on", BOT_MODE: "testing", BOT_ALLOWLIST: tel(3) });
    t.after(() => E.cierra());
    for (const evento of ["confirmada", "reprogramada", "cancelada"]) {
      const r = await E.bot.enviaJson("/admin/api/aviso-cliente", { evento, phone: tel(4), tipo: "llamada", cuando: CUANDO }, ADMIN);
      assert.strictEqual(r.status, 409);
      assert.strictEqual(r.json.motivo, "frenado_testing");
    }
    assert.strictEqual((await E.bot.enviaJson("/admin/api/aviso-cliente", { evento: "traspaso", phone: tel(4) }, ADMIN)).json.motivo, "frenado_testing");
    await esperar(100);
    assert.strictEqual(E.graph.a(tel(4)).length, 0);
    assert.strictEqual(E.graph.enviados.length, 0);
  });

  test(`[${modo}] cita pasada con fecha inválida o evento desconocido: 409 y nada sale`, async (t) => {
    const E = await entorno(modo, { ...PLANTILLAS, BOT_AVISOS_CLIENTE: "on", BOT_MODE: "testing", BOT_ALLOWLIST: tel(5) });
    t.after(() => E.cierra());
    assert.strictEqual((await E.bot.enviaJson("/admin/api/aviso-cliente", { evento: "confirmada", phone: tel(5), cuando: "mañana" }, ADMIN)).json.motivo, "fecha_invalida");
    assert.strictEqual((await E.bot.enviaJson("/admin/api/aviso-cliente", { evento: "recordatorio", phone: tel(5), cuando: CUANDO }, ADMIN)).json.motivo, "evento_invalido");
    assert.strictEqual((await E.bot.enviaJson("/admin/api/aviso-cliente", { evento: "traspaso", phone: tel(5) }, ADMIN)).json.motivo, "no_pidio_persona");
    assert.strictEqual(E.graph.enviados.length, 0);
  });
}

test("[supabase] ventana ABIERTA (el lead acaba de escribir) → texto libre con aviso de asistente, no plantilla", async (t) => {
  const E = await entorno("supabase", { ...PLANTILLAS, BOT_AVISOS_CLIENTE: "on" });
  t.after(() => E.cierra());
  const T = tel(6);
  assert.strictEqual(await E.bot.post(payloadTexto(T, "Hola, quiero una visita por favor, información del terreno", wamid())), 200);
  await hasta(() => E.edge.de("turno_cerrar").length === 1 && E.graph.a(T).length === 1, "turno cerrado y respuesta enviada");
  const r = await E.bot.enviaJson("/admin/api/aviso-cliente", { evento: "reprogramada", phone: T, tipo: "visita", cuando: CUANDO, nombre: "Ana" }, ADMIN);
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.via, "libre");
  const ultimo = E.graph.a(T)[E.graph.a(T).length - 1];
  assert.strictEqual(ultimo.type, "text");
  assert.match(ultimo.texto, /asistente automático \(IA\)/);
  assert.match(ultimo.texto, /sábado 10 de octubre, 15:00 \(hora de Bali\)/);
  assert.match(ultimo.texto, /Responde STOP/);
});

test("[supabase] un lead que pidió la baja (STOP) no recibe ningún aviso", async (t) => {
  const E = await entorno("supabase", { ...PLANTILLAS, BOT_AVISOS_CLIENTE: "on" });
  t.after(() => E.cierra());
  const T = tel(7);
  assert.strictEqual(await E.bot.post(payloadTexto(T, "STOP", wamid())), 200);
  await hasta(() => E.edge.de("baja").length >= 1, "baja registrada");
  await esperar(200);
  const antes = E.graph.a(T).length;
  const r = await E.bot.enviaJson("/admin/api/aviso-cliente", { evento: "cancelada", phone: T, tipo: "llamada", cuando: CUANDO }, ADMIN);
  assert.strictEqual(r.json.motivo, "baja");
  assert.strictEqual(E.graph.a(T).length, antes);
});

test("[redis] la alerta al equipo usa lawang_alerta_equipo con 2 variables SIN saltos de línea ni tabuladores", async (t) => {
  const E = await entorno("redis", { ...PLANTILLAS, HUMAN_ONLY: "1" });
  t.after(() => E.cierra());
  const T = tel(8);
  assert.strictEqual(await E.bot.post(payloadTexto(T, "Hola\nquiero\tver   el terreno\n\nmañana", wamid(), { nombre: "Ana\nLópez" })), 200);
  await hasta(() => E.graph.a(OWNER).length >= 1, "alerta al equipo");
  const a = E.graph.a(OWNER)[0];
  assert.strictEqual(a.plantilla, "lawang_alerta_equipo");
  const p = params(a);
  assert.strictEqual(p.length, 2);
  for (const v of p) assert.ok(!/[\n\r\t]/.test(v) && !/ {2,}/.test(v), JSON.stringify(v));
  assert.match(p[0], new RegExp(T));
  assert.strictEqual(p[1], "Hola quiero ver el terreno mañana");
  assert.strictEqual(E.graph.a(T).length, 0, "HUMAN_ONLY: al lead no se le escribe");
});

test("[redis] ALERT_TEMPLATE_NAME ya no se lee: sin la variable nueva el aviso sale como texto libre y el arranque lo grita", async (t) => {
  const E = await entorno("redis", { HUMAN_ONLY: "1", ALERT_TEMPLATE_NAME: "lawang_alerta_lead", ALERT_TEMPLATE_LANG: "es", ALERT_TEMPLATE_VARS: "2" });
  t.after(() => E.cierra());
  assert.match(E.bot.texto(), /ALERT_TEMPLATE_NAME está puesta y este motor YA NO la lee/);
  const T = tel(9);
  await E.bot.post(payloadTexto(T, "Hola", wamid()));
  await hasta(() => E.graph.a(OWNER).length >= 1, "aviso al equipo");
  const a = E.graph.a(OWNER)[0];
  assert.notStrictEqual(a.plantilla, "lawang_alerta_lead");
  assert.strictEqual(a.type, "text");
});
