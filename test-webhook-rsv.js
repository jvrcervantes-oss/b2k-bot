// Self-check del webhook de Xendit de reservas del ERP (xendit-rsv.js, F8-7b). Sin red: fetch simulado, req/res de mentira.
// Ejecutar: node test-webhook-rsv.js
// index.js no se puede importar en un test (arranca Express + Redis); por eso la puerta vive en xendit-rsv.js y es la MISMA que usa index.js.
import assert from "node:assert";
import { createRsvForwarder, createXenditGate, esAvisoRsv, RSV_TIMEOUT_MS } from "./xendit-rsv.js";

const silent = { warn() {}, error() {}, log() {} };
const TOKEN = "tok-xendit-0123456789";
let n = 0;
const ok = (m) => { n++; console.log("ok -", m); };

function mkReq({ token = TOKEN, body, raw }) {
  const rawBody = raw !== undefined ? Buffer.from(raw) : Buffer.from(JSON.stringify(body ?? {}));
  return { get: (h) => (h.toLowerCase() === "x-callback-token" ? token : undefined), body, rawBody };
}
function mkRes() { const r = { code: null, sendStatus(c) { r.code = c; return r; } }; return r; }

function harness({ erpUrl = "https://erp.test", fetchImpl, token = TOKEN } = {}) {
  const calls = [];
  const f = fetchImpl || (async () => ({ status: 200 }));
  const wrapped = async (url, init) => { calls.push({ url, init }); return f(url, init, calls.length); };
  const forwarder = createRsvForwarder({ erpUrl, fetchImpl: wrapped, log: silent, project: "T" });
  const gate = createXenditGate({ token, forwarder, log: silent, project: "T" });
  let nextCalls = 0;
  const run = async (req) => { const res = mkRes(); nextCalls = 0; await gate(req, res, () => { nextCalls++; }); return res; };
  return { run, calls, next: () => nextCalls };
}

const RSV = "rsv:3f0c1b1e-7b1a-4c53-9a53-2a6f0f5c1111";
const body = { id: "inv_abc123", external_id: RSV, status: "PAID", amount: 1500000 };

assert.equal(esAvisoRsv(body), true);
assert.equal(esAvisoRsv({ external_id: "paylink_62811_1" }), false);
assert.equal(esAvisoRsv({ external_id: 5 }), false);
assert.equal(esAvisoRsv(null), false);
assert.equal(esAvisoRsv({}), false);
ok("esAvisoRsv solo con external_id string que empieza por rsv:");

// reenvío exacto de bytes (espacios y orden que JSON.stringify(req.body) no reproduciría) y de token
{
  const raw = '{ "status":"PAID",  "external_id":"' + RSV + '",\n "id":"inv_abc123", "amount":1500000.00 }';
  const h = harness();
  const res = await h.run(mkReq({ body: JSON.parse(raw), raw }));
  assert.equal(res.code, 200);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, "https://erp.test/functions/v1/reservas-pago");
  assert.ok(Buffer.isBuffer(h.calls[0].init.body));
  assert.equal(h.calls[0].init.body.toString("utf8"), raw, "bytes idénticos al cuerpo original");
  assert.notEqual(h.calls[0].init.body.toString("utf8"), JSON.stringify(JSON.parse(raw)));
  assert.equal(h.calls[0].init.headers["x-callback-token"], TOKEN);
  assert.equal(h.next(), 0, "un rsv: no sigue a la rama paylink_");
  ok("reenvía el cuerpo EXACTO (rawBody) y el token tal cual, y NO llama a next()");
}

{
  const h = harness({ erpUrl: "https://erp.test/" });
  await h.run(mkReq({ body }));
  assert.equal(h.calls[0].url, "https://erp.test/functions/v1/reservas-pago");
  ok("barra final de BBM_ERP_URL normalizada");
}

for (const [edge, esperado] of [[200, 200], [400, 400], [413, 413], [401, 502], [403, 502], [404, 502], [429, 502], [500, 502], [502, 502], [503, 502]]) {
  const h = harness({ fetchImpl: async () => ({ status: edge }) });
  const res = await h.run(mkReq({ body }));
  assert.equal(res.code, esperado, `edge ${edge}`);
  assert.equal(h.next(), 0);
}
ok("edge 200→200 · 400/413→mismo 4xx · 401/403/404/429/5xx→502");

{
  const h = harness({ fetchImpl: async () => ({ status: 200, json: async () => ({ revisar: true }) }) });
  assert.equal((await h.run(mkReq({ body }))).code, 200);
  ok("pago a revisar (200 de la edge) → 200");
}

{
  const h = harness({ fetchImpl: async () => { throw new TypeError("fetch failed"); } });
  assert.equal((await h.run(mkReq({ body }))).code, 502);
  const t = Object.assign(new Error("t"), { name: "TimeoutError" });
  const h2 = harness({ fetchImpl: async () => { throw t; } });
  assert.equal((await h2.run(mkReq({ body }))).code, 502);
  ok("fallo de red / timeout → 502");
}

{
  const h = harness();
  await h.run(mkReq({ body }));
  assert.ok(h.calls[0].init.signal instanceof AbortSignal);
  assert.ok(RSV_TIMEOUT_MS < 30000);
  ok("timeout propio < 30 s con AbortSignal");
}

{
  const h = harness({ erpUrl: "" });
  const res = await h.run(mkReq({ body }));
  assert.equal(res.code, 503);
  assert.equal(h.calls.length, 0);
  assert.equal(h.next(), 0, "tampoco cae en paylink_");
  ok("sin BBM_ERP_URL → 503 para rsv: (reintento), sin perderlo");
}

{
  const h = harness();
  const req = mkReq({ body }); req.rawBody = undefined;
  assert.equal((await h.run(req)).code, 502, "un fallo nuestro no puede ser un 4xx: Xendit dejaría de reintentar");
  assert.equal(h.calls.length, 0);
  ok("sin rawBody no se reenvía JSON re-serializado: 502 (Xendit reintenta)");
}

{
  const h = harness();
  assert.equal((await h.run(mkReq({ body }))).code, 200);
  assert.equal((await h.run(mkReq({ body }))).code, 200);
  assert.equal(h.calls.length, 2);
  ok("mismo callback dos veces → dos reenvíos (sin dedup en el bot)");
}

{
  const h = harness();
  assert.equal((await h.run(mkReq({ body, token: "otro-token" }))).code, 403);
  assert.equal((await h.run(mkReq({ body, token: "" }))).code, 403);
  assert.equal((await h.run(mkReq({ body, token: TOKEN + "x" }))).code, 403);
  assert.equal(h.calls.length, 0);
  assert.equal(h.next(), 0);
  const h2 = harness({ token: "" });
  assert.equal((await h2.run(mkReq({ body }))).code, 503);
  assert.equal(h2.calls.length, 0);
  ok("token inválido/ausente → 403 y sin reenvío; sin XENDIT_CALLBACK_TOKEN → 503 (como antes)");
}

{
  const pay = { id: "x1", external_id: "paylink_628111_17", status: "PAID" };
  const h = harness();
  const res = await h.run(mkReq({ body: pay }));
  assert.equal(res.code, null);
  assert.equal(h.next(), 1);
  assert.equal(h.calls.length, 0);
  const h2 = harness({ erpUrl: "" });
  await h2.run(mkReq({ body: pay }));
  assert.equal(h2.next(), 1, "sin variables, comportamiento de hoy");
  const h3 = harness();
  await h3.run(mkReq({ body: {} }));
  assert.equal(h3.next(), 1);
  await h3.run(mkReq({ body: undefined }));
  assert.equal(h3.next(), 1);
  ok("paylink_ / vacío → next() y sin red; sin variables todo sigue como hoy");
}

{
  const h = harness();
  await h.run(mkReq({ body: { id: "a", external_id: "paylink_1_rsv:x" } }));
  assert.equal(h.calls.length, 0);
  ok("solo el prefijo cuenta");
}

{
  const logs = [];
  const rec = { warn: (m) => logs.push(m), error: (m) => logs.push(m), log: (m) => logs.push(m) };
  for (const status of [200, 500, 400]) {
    const forwarder = createRsvForwarder({ erpUrl: "https://erp.test", fetchImpl: async () => ({ status }), log: rec, project: "T" });
    const gate = createXenditGate({ token: TOKEN, forwarder, log: rec, project: "T" });
    await gate(mkReq({ body: { ...body, payer_email: "a@b.com", phone: "+6281234567890" } }), mkRes(), () => {});
  }
  const todo = logs.join("\n");
  assert.ok(logs.length >= 3);
  assert.ok(!/1500000|a@b\.com|6281234567890|PAID/.test(todo), "sin importes, correos ni teléfonos");
  assert.ok(!todo.includes(TOKEN));
  ok("logs sin cuerpo, importe, correo, teléfono ni token");
}

// index.js usa de verdad esta puerta (no se puede importar: se comprueba el texto)
{
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");
  const rutas = src.match(/app\.post\(\s*["']\/webhook\/xendit["'][^\n]*/g) || [];
  assert.equal(rutas.length, 1, "una sola ruta /webhook/xendit");
  assert.ok(/app\.post\("\/webhook\/xendit", xenditGate, async \(req, res\) => \{/.test(rutas[0]), "la ruta lleva la puerta antes del handler");
  assert.ok(/import \{ createRsvForwarder, createXenditGate \} from "\.\/xendit-rsv\.js";/.test(src));
  assert.ok(/createXenditGate\(\{\s*token: XENDIT_CALLBACK_TOKEN, forwarder: createRsvForwarder\(\{ erpUrl: process\.env\.BBM_ERP_URL/.test(src), "la puerta se construye con el token y BBM_ERP_URL");
  // el handler que queda no usa lo que se movió a la puerta (token, a, b): un ReferenceError no lo detecta node --check
  const i = src.indexOf('app.post("/webhook/xendit", xenditGate');
  const j = src.indexOf("\n});\n", i);
  const cuerpo = src.slice(i, j);
  assert.ok(j > i && cuerpo.length > 200);
  assert.ok(!/\btoken\b|\ba\.length|\bb\)/.test(cuerpo.replace(/\/\/.*$/gm, "")), "el handler no referencia las variables que ahora viven en la puerta");
  // la rama paylink_ sigue ahí y el catch genérico devuelve 500 (como hoy)
  assert.ok(cuerpo.includes("paylink_") && cuerpo.includes("res.sendStatus(500)"));
  ok("index.js: una sola ruta /webhook/xendit con la puerta delante; el handler no usa variables huérfanas");
}

// F8-7: el cuerpo de la edge llega a onResultado DESPUÉS de contestar 200; un fallo del aviso no cambia la respuesta a Xendit
{
  const avisos = [];
  const forwarder = createRsvForwarder({ erpUrl: "https://erp.test", fetchImpl: async () => ({ status: 200, json: async () => ({ ok: true, factura: { numero: "INV-1" } }) }), log: silent, project: "T" });
  const orden = [];
  const gate = createXenditGate({ token: TOKEN, forwarder, log: silent, project: "T", onResultado: async (x) => { orden.push("aviso"); avisos.push(x); } });
  const res = { code: null, sendStatus(c) { orden.push("respuesta"); res.code = c; return res; } };
  await gate(mkReq({ body }), res, () => {});
  assert.equal(res.code, 200); assert.deepEqual(orden, ["respuesta", "aviso"], "primero se contesta a Xendit, luego se avisa al cliente");
  assert.equal(avisos[0].externalId, RSV); assert.equal(avisos[0].invoiceId, "inv_abc123"); assert.deepEqual(avisos[0].cuerpo, { ok: true, factura: { numero: "INV-1" } });
  const gate2 = createXenditGate({ token: TOKEN, forwarder, log: silent, project: "T", onResultado: async () => { throw new Error("boom"); } });
  const res2 = mkRes();
  await gate2(mkReq({ body }), res2, () => {});
  assert.equal(res2.code, 200, "si el aviso al cliente revienta, Xendit sigue recibiendo 200 (el pago ya está en la base)");
  const fwd502 = createRsvForwarder({ erpUrl: "https://erp.test", fetchImpl: async () => ({ status: 500 }), log: silent, project: "T" });
  let llamado = 0;
  const gate3 = createXenditGate({ token: TOKEN, forwarder: fwd502, log: silent, project: "T", onResultado: async () => { llamado++; } });
  const res3 = mkRes();
  await gate3(mkReq({ body }), res3, () => {});
  assert.equal(res3.code, 502); assert.equal(llamado, 0, "sin 200 de la edge no se avisa al cliente de nada");
  const fwdSinCuerpo = createRsvForwarder({ erpUrl: "https://erp.test", fetchImpl: async () => ({ status: 200 }), log: silent, project: "T" });
  const r = await fwdSinCuerpo.reenvia({ rawBody: Buffer.from("{}"), token: TOKEN, invoiceId: "x" });
  assert.equal(r.status, 200); assert.equal(r.cuerpo, null);
  ok("onResultado: después del 200, con el cuerpo de la edge; no cambia la respuesta si falla; nada si la edge no dio 200");
}

console.log(`\n${n} comprobaciones OK`);
