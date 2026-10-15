// Aviso al responsable que llega fuera de su ventana de 24 h (bbm-bot, 15-oct-2026). node --test test-avisos.js
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { createAvisoResponsable, paramsPlantilla, VENTANA_SEGURA_MS } from "./avisos.js";

const src = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8").split(String.fromCharCode(13)).join("");
const silent = { log() {}, warn() {}, error() {} };
const PLANTILLA = { nombre: "bbm_owner_alert", idioma: "en", vars: 2 };

function fakeRedis() {
  const m = new Map();
  return { m, async get(k) { return m.has(k) ? m.get(k) : null; }, async setEx(k, _ttl, v) { m.set(k, String(v)); } };
}
function doble(o = {}) {
  let t = 1_000_000_000;
  const envios = [];
  const redis = o.redis === undefined ? fakeRedis() : o.redis;
  const av = createAvisoResponsable({
    ownerPhone: "ownerPhone" in o ? o.ownerPhone : "62881000000", plantilla: "plantilla" in o ? o.plantilla : PLANTILLA, redis: () => redis, log: silent, now: () => t,
    enviaTexto: async (to, texto) => { envios.push({ via: "texto", to, texto }); return o.fallaTexto ? { ok: false, error: "x" } : { ok: true, id: "wamid.T" }; },
    enviaPlantilla: async (to, nombre, idioma, params) => { envios.push({ via: "plantilla", to, nombre, idioma, params }); return o.fallaPlantilla ? { ok: false, error: "y" } : { ok: true, id: "wamid.P" }; },
  });
  return { av, envios, avanza: (ms) => { t += ms; }, redis };
}
const AVISO = { texto: "🙋 BaliBest — reserva por el ERP no completada\n\n*Marco*", etiqueta: "Needs a person", quien: "Marco (+6281)", que: "reserva por el ERP no completada (sin_configurar)" };

test("ventana DESCONOCIDA (el responsable no consta que haya escrito): plantilla aprobada, que Meta entrega siempre", async () => {
  const { av, envios } = doble();
  const r = await av.avisa(AVISO);
  assert.deepStrictEqual(r, { ok: true, id: "wamid.P", via: "plantilla", error: undefined });
  assert.strictEqual(envios.length, 1);
  assert.deepStrictEqual(envios[0], { via: "plantilla", to: "62881000000", nombre: "bbm_owner_alert", idioma: "en", params: ["Marco (+6281)", "Needs a person: reserva por el ERP no completada (sin_configurar)"] });
});

test("ventana ABIERTA (escribió hace < 23 h): texto libre con el detalle y su id para responder citando", async () => {
  const { av, envios, avanza } = doble();
  await av.marca();
  avanza(VENTANA_SEGURA_MS - 1000);
  const r = await av.avisa(AVISO);
  assert.deepStrictEqual([r.via, r.ok, r.id], ["texto", true, "wamid.T"]);
  assert.strictEqual(envios[0].texto, AVISO.texto);
});

test("ventana CERRADA (≥ 23 h, margen de 1 h antes de las 24 de Meta): plantilla", async () => {
  const { av, envios, avanza } = doble();
  await av.marca();
  avanza(VENTANA_SEGURA_MS);
  assert.strictEqual((await av.avisa(AVISO)).via, "plantilla");
  assert.strictEqual(envios[0].via, "plantilla");
});

test("la marca vive en Redis (sobrevive a un reinicio) y, sin Redis, en memoria", async () => {
  const a = doble();
  await a.av.marca();
  assert.strictEqual(a.redis.m.size, 1);
  const otro = createAvisoResponsable({ ownerPhone: "1", plantilla: PLANTILLA, redis: () => a.redis, log: silent, now: () => 1_000_000_000 + 60_000,
    enviaTexto: async () => ({ ok: true, id: "t" }), enviaPlantilla: async () => ({ ok: true, id: "p" }) });
  assert.strictEqual((await otro.avisa(AVISO)).via, "texto", "otro proceso (tras un despliegue) lee la marca de Redis");
  const sin = doble({ redis: null });
  await sin.av.marca();
  assert.strictEqual((await sin.av.avisa(AVISO)).via, "texto");
});

test("sin plantilla configurada: texto libre como siempre (con la ventana cerrada puede no llegar, y se grita)", async () => {
  const { av, envios } = doble({ plantilla: null });
  assert.strictEqual((await av.avisa(AVISO)).via, "texto");
  assert.strictEqual(envios.length, 1);
});

test("sin OWNER_PHONE no se envía nada; un fallo devuelve ok:false sin lanzar", async () => {
  const s = doble({ ownerPhone: "" });
  assert.deepStrictEqual(await s.av.avisa(AVISO), { ok: false, via: "nada", error: "sin OWNER_PHONE" });
  assert.strictEqual(s.envios.length, 0);
  const f = doble({ fallaPlantilla: true });
  const r = await f.av.avisa(AVISO);
  assert.deepStrictEqual([r.ok, r.via, r.id], [true, "texto_tras_plantilla", "wamid.T"], "plantilla rota: se intenta el texto libre");
  assert.deepStrictEqual(f.envios.map((e) => e.via), ["plantilla", "texto"]);
  const g = doble({ fallaPlantilla: true, fallaTexto: true });
  const r2 = await g.av.avisa(AVISO);
  assert.deepStrictEqual([r2.ok, r2.via], [false, "texto_tras_plantilla"]);
});

test("parámetros de la plantilla según ALERT_TEMPLATE_VARS (como notifyOwner), recortados y sin saltos de línea", () => {
  const d = { etiqueta: "E", quien: "Q", que: "línea 1\nlínea 2" };
  assert.deepStrictEqual(paramsPlantilla(2, d), ["Q", "E: línea 1 línea 2"]);
  assert.deepStrictEqual(paramsPlantilla(1, d), ["E: Q. línea 1 línea 2"]);
  assert.deepStrictEqual(paramsPlantilla(3, d), ["E", "Q", "línea 1 línea 2"]);
  assert.deepStrictEqual(paramsPlantilla(0, d), []);
  assert.deepStrictEqual(paramsPlantilla(NaN, d), ["Q", "E: línea 1 línea 2"], "sin número válido: 2, el valor por defecto");
  assert.ok(paramsPlantilla(2, { etiqueta: "E", quien: "Q", que: "x".repeat(2000) })[1].length <= 403);
  assert.deepStrictEqual(paramsPlantilla(2, {}), ["-", "-: -"], "nunca un parámetro vacío (Meta lo rechaza)");
});

test("CABLEADO en index.js: los avisos que prometen una persona (y sus hermanos) pasan por el embudo; ninguno manda texto libre suelto al responsable", () => {
  // \s* también casa la llamada repartida en varias líneas (revisor de ed1e47f: «LLAMADA AGENDADA» se le escapaba a la versión de una línea).
  const sueltos = [...src.matchAll(/sendWhatsApp(Result)?\(\s*OWNER_PHONE/g)];
  assert.strictEqual(sueltos.length, 1, `solo queda el texto libre de notifyOwner cuando NO hay plantilla configurada: ${sueltos.length}`);
  const iNotify = src.indexOf("async function notifyOwner(");
  const iFin = src.indexOf("\n}\n", iNotify);
  assert.ok(sueltos[0].index > iNotify && sueltos[0].index < iFin, "y ese único está dentro de notifyOwner (rama sin ALERT_TEMPLATE_NAME)");
  const usos = src.match(/avisoResponsable\.avisa\(/g) || [];
  assert.ok(usos.length >= 7, `escalación, BBM-50, derivaPersonaBbm, avisaEquipoBbm, seguimiento, pago y llamada agendada: ${usos.length}`);
  assert.ok(/if \(isOwner\(from\)\) \{\s*\n\s*try \{ await avisoResponsable\.marca\(\)/.test(src), "el responsable marca su ventana al escribir");
  assert.ok(/return \{ ok: true, id: resp\?\.data\?\.messages\?\.\[0\]\?\.id \};/.test(src), "la plantilla devuelve su id (escmap)");
});
