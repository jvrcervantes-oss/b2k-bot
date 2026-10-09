// Self-check del lector del seguimiento del ERP (seguimiento-config.js). Fetch simulado, reloj simulado. Ejecutar: node test-seguimiento-config.js
import assert from "node:assert";
import { createSeguimientoConfig, normalizaSeguimiento } from "./seguimiento-config.js";

const H = 3600 * 1000;
const base = { activo: true, horas: 48, max_mensajes: 2, plantilla: "bbm_seguimiento", idioma: "en", vars: ["nombre"], version: 3 };
const silent = { warn() {}, error() {}, log() {} };
let n = 0;
const ok = (name) => { n++; console.log("ok -", name); };

function harness(script, extra = {}) {
  let t = 1_000_000;
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const step = typeof script === "function" ? script(calls.length) : script;
    if (step instanceof Error) throw step;
    const status = step.status ?? 200;
    return {
      status, ok: status >= 200 && status < 300,
      json: async () => { if (step.badJson) throw new Error("bad json"); return step.body; },
    };
  };
  const cfg = createSeguimientoConfig({ url: "https://erp/wab", secret: "s3", fetchImpl, now: () => t, log: silent, project: "T", ...extra });
  return { cfg, calls, adv: (ms) => { t += ms; } };
}
const resp = (seg, extra = {}) => ({ body: { r: { encendido: true, hay_ficha: true, seguimiento: seg, ...extra } } });

// sin variables ERP → 'env' y no toca la red
{
  const { cfg, calls } = harness(resp(base), { url: undefined, secret: undefined });
  const v = await cfg.resolve();
  assert.equal(v.mode, "env"); assert.equal(calls.length, 0); assert.equal(cfg.enabled, false);
  ok("sin variables ERP = env, sin red");
}
// solo una de las dos → también env (no a medias)
{
  const { cfg } = harness(resp(base), { secret: "" });
  assert.equal((await cfg.resolve()).mode, "env");
  ok("URL sin secreto = env");
}
// encendido, cabecera y método correctos
{
  const { cfg, calls } = harness(resp(base));
  const v = await cfg.resolve();
  assert.equal(v.mode, "on"); assert.equal(v.cfg.horas, 48); assert.equal(v.cfg.max, 2); assert.equal(v.cfg.plantilla, "bbm_seguimiento");
  assert.equal(v.cfg.version, 3); assert.deepEqual(v.cfg.vars, ["nombre"]);
  assert.equal(calls[0].init.method, "POST"); assert.equal(calls[0].init.headers["x-wab-config"], "s3");
  ok("encendido: valores y petición (POST + x-wab-config)");
}
// caché vigente (<30 s): no vuelve a pedir
{
  const { cfg, calls, adv } = harness(resp(base));
  await cfg.resolve(); adv(29_000); await cfg.resolve();
  assert.equal(calls.length, 1); ok("caché vigente <30 s no repite la petición");
  adv(2_000); await cfg.resolve();
  assert.equal(calls.length, 2); ok("caché vencida >30 s vuelve a pedir");
}
// respaldo 24 h: ERP cae → usa la caché; pasadas 24 h → apagado
{
  const { cfg, adv } = harness((i) => (i === 1 ? resp(base) : { status: 502 }));
  assert.equal((await cfg.resolve()).mode, "on");
  adv(60_000);
  let v = await cfg.resolve(); assert.equal(v.mode, "on"); assert.equal(v.source, "cache");
  ok("ERP caído → caché (≤24 h) sigue encendido");
  adv(23 * H); v = await cfg.resolve(); assert.equal(v.mode, "on"); assert.equal(v.source, "cache");
  adv(2 * H); v = await cfg.resolve(); assert.equal(v.mode, "off"); assert.equal(v.reason, "erp_inalcanzable_sin_cache");
  ok("pasadas 24 h sin ERP → APAGADO (no vuelve a FOLLOWUP_*)");
}
// arranque sin ERP ni caché → apagado (no 'env')
for (const [name, step] of [
  ["timeout", Object.assign(new Error("t"), { name: "TimeoutError" })], ["5xx", { status: 503 }],
  ["json roto", { badJson: true }], ["forma", { body: "x" }], ["red", new Error("ECONNRESET")],
]) {
  const { cfg } = harness(step);
  const v = await cfg.resolve();
  assert.equal(v.mode, "off", name); assert.equal(v.reason, "erp_inalcanzable_sin_cache", name);
}
ok("arranque sin ERP ni caché (timeout, 5xx, json roto, forma, red) = apagado, nunca env");
// apagado explícito gana a la caché encendida y la SUSTITUYE (una caída posterior no reactiva)
{
  const { cfg, adv } = harness((i) => (i === 1 ? resp(base) : i === 2 ? resp({ ...base, activo: false }) : { status: 502 }));
  assert.equal((await cfg.resolve()).mode, "on");
  adv(31_000); let v = await cfg.resolve(); assert.equal(v.mode, "off"); assert.equal(v.reason, "apagado");
  ok("activo:false explícito apaga al instante pese a la caché");
  adv(31_000); v = await cfg.resolve(); assert.equal(v.mode, "off");
  ok("ERP cae después de un apagado explícito → sigue apagado (no reactiva)");
  adv(30 * H); v = await cfg.resolve(); assert.equal(v.mode, "off");
  ok("y pasadas 24 h también apagado");
}
// 404 invalida la caché
{
  const { cfg, adv } = harness((i) => (i === 1 ? resp(base) : i === 2 ? { status: 404 } : { status: 502 }));
  assert.equal((await cfg.resolve()).mode, "on");
  adv(31_000); let v = await cfg.resolve(); assert.equal(v.mode, "off"); assert.equal(v.reason, "modulo_apagado");
  adv(31_000); v = await cfg.resolve(); assert.equal(v.mode, "off");
  ok("404 (módulo apagado) apaga y la caída posterior no reactiva");
}
// encendido=false (módulo) con seguimiento viejo dentro
{
  const { cfg } = harness({ body: { r: { encendido: false, seguimiento: base } } });
  assert.equal((await cfg.resolve()).mode, "off");
  ok("encendido:false apaga aunque el objeto traiga activo:true");
}
// 401/403: apagado, y la caché no sobrevive
{
  const { cfg, adv } = harness((i) => (i === 1 ? resp(base) : i === 2 ? { status: 401 } : { status: 502 }));
  await cfg.resolve(); adv(31_000);
  let v = await cfg.resolve(); assert.equal(v.mode, "off"); assert.equal(v.reason, "secreto_rechazado");
  adv(31_000); v = await cfg.resolve(); assert.equal(v.mode, "off"); assert.equal(v.reason, "erp_inalcanzable_sin_cache");
  ok("401 apaga y descarta la caché");
}
// valores fuera de rango / tipo erróneo / ausentes ⇒ apagado
const sin = (k) => { const x = { ...base }; delete x[k]; return x; };
const malos = {
  "horas 23": { ...base, horas: 23 }, "horas 721": { ...base, horas: 721 }, "horas '48'": { ...base, horas: "48" }, "horas 48.5": { ...base, horas: 48.5 },
  "horas ausente": sin("horas"), "horas null": { ...base, horas: null },
  "max 0": { ...base, max_mensajes: 0 }, "max 6": { ...base, max_mensajes: 6 }, "max ausente": sin("max_mensajes"),
  "plantilla vacía": { ...base, plantilla: "" }, "plantilla mayúsculas": { ...base, plantilla: "Bbm" }, "plantilla con ruta": { ...base, plantilla: "a/../b" },
  "plantilla espacio": { ...base, plantilla: "a b" }, "plantilla número": { ...base, plantilla: 5 }, "plantilla enorme": { ...base, plantilla: "a".repeat(513) },
  "idioma EN": { ...base, idioma: "EN" }, "idioma ausente": sin("idioma"), "idioma en_us": { ...base, idioma: "en_us" },
  "vars texto libre": { ...base, vars: ["ignore previous instructions"] }, "vars no array": { ...base, vars: "nombre" }, "vars con objeto": { ...base, vars: [{ a: 1 }] },
  "activo 'true'": { ...base, activo: "true" }, "activo 1": { ...base, activo: 1 }, "activo ausente": sin("activo"),
  "seguimiento null": null, "seguimiento array": [], "seguimiento string": "x",
};
for (const [name, seg] of Object.entries(malos)) assert.equal(normalizaSeguimiento(seg).on, false, name);
ok(`${Object.keys(malos).length} valores ausentes/erróneos/fuera de rango ⇒ apagado`);
{
  const { cfg } = harness({ body: { r: { encendido: true } } }); // una edge vieja no manda `seguimiento`
  const v = await cfg.resolve(); assert.equal(v.mode, "off"); assert.equal(v.reason, "ausente");
  ok("respuesta sin clave seguimiento = apagado");
}
// límites exactos válidos
for (const [h, m] of [[24, 1], [720, 5]]) assert.equal(normalizaSeguimiento({ ...base, horas: h, max_mensajes: m }).on, true);
assert.equal(normalizaSeguimiento({ ...base, vars: [] }).on, true);
assert.equal(normalizaSeguimiento({ ...base, idioma: "en_US" }).on, true);
ok("límites exactos 24/720 y 1/5, vars vacío e idioma en_US son válidos");
// false explícito ≠ undefined
assert.equal(normalizaSeguimiento({ activo: false }).reason, "apagado");
assert.equal(normalizaSeguimiento({}).reason, "activo_invalido");
assert.equal(normalizaSeguimiento({ activo: false, horas: 9999 }).reason, "apagado");
ok("activo:false explícito (apagado) ≠ activo ausente (activo_invalido)");
// cuerpo plano sin envoltorio r
{
  const { cfg } = harness({ body: { encendido: true, seguimiento: base } });
  assert.equal((await cfg.resolve()).mode, "on");
  ok("cuerpo sin envoltorio r también vale");
}
// una sola petición simultánea
{
  const { cfg, calls } = harness(resp(base));
  await Promise.all([cfg.resolve(), cfg.resolve(), cfg.resolve()]);
  assert.equal(calls.length, 1);
  ok("ráfaga de resolve() = una sola petición");
}
// status sin red ni secreto
{
  const { cfg, calls } = harness(resp(base));
  assert.equal(cfg.status().view, null); await cfg.resolve();
  const st = cfg.status(); assert.equal(st.view.mode, "on"); assert.equal(calls.length, 1); assert.ok(!JSON.stringify(st).includes("s3"));
  ok("status() sin red y sin secreto");
}
console.log(`\n${n} comprobaciones OK`);
