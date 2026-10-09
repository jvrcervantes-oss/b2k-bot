// S4b (encargo 20261009_lawang_bot_sin_redis): con BOT_STORE=supabase el módulo de Redis queda BLOQUEADO — cualquier función que
// toque Redis o la memoria de respaldo lanza. El test recorre TODAS las exportaciones del módulo, así que una función nueva que
// alguien añada mañana sin su guardia lo hace fallar (no hay lista a mano que se quede corta).
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";

const R = await import("./store/redis.js");

// Lo único que NO lanza al bloquear, con su porqué:
//  · apptTs / redisActivo / almacenNombre: no leen ni escriben nada.
//  · setWaBlocked/getWaBlocked/clearWaBlocked/incrTope: en ese modo son memoria del proceso por diseño (el cliente de Redis no se crea nunca).
const EXENTAS = new Set(["apptTs", "redisActivo", "almacenNombre", "setWaBlocked", "getWaBlocked", "clearWaBlocked", "incrTope", "bloqueaRedis"]);
const nombres = Object.keys(R).filter((k) => typeof R[k] === "function");

test("el módulo exporta funciones y bloqueaRedis existe", () => {
  assert.ok(nombres.length > 50, "pocas exportaciones: ¿ruta mal?");
  assert.ok(nombres.includes("bloqueaRedis"));
  for (const e of EXENTAS) assert.ok(nombres.includes(e), `la exención ${e} ya no existe: quítala de la lista`);
});

test("antes de bloquear, las funciones siguen funcionando (modo redis intacto, en memoria sin cliente)", async () => {
  await R.saveConversation("1", [{ role: "user", content: "hola" }]);
  assert.deepStrictEqual((await R.getConversation("1")).length, 1);
  assert.strictEqual(R.almacenNombre(), "ram");
});

test("después de bloquear, TODAS las demás funciones lanzan", async () => {
  R.bloqueaRedis();
  const fallos = [];
  for (const n of nombres) {
    if (EXENTAS.has(n)) continue;
    let lanzo = false;
    try { await R[n]("1", "2", "3"); } catch (e) { lanzo = /Redis bloqueado/.test(e.message); }
    if (!lanzo) fallos.push(n);
  }
  assert.deepStrictEqual(fallos, [], "funciones que no lanzan con Redis bloqueado: " + fallos.join(", "));
});

test("las exentas siguen vivas y no tocan Redis (no hay cliente)", async () => {
  assert.strictEqual(R.redisActivo(), false);
  assert.ok(Number.isFinite(R.apptTs("2026-10-09T10:00:00Z")));
  await R.setWaBlocked(131042, "x");
  assert.strictEqual((await R.getWaBlocked()).code, 131042);
  await R.clearWaBlocked();
  assert.strictEqual(await R.getWaBlocked(), null);
  assert.strictEqual(await R.incrTope("k"), 1);
  assert.strictEqual(await R.incrTope("k"), 2);
});

test("el código fuente: cada función exportada con cuerpo propio lleva su guardia en la primera línea", () => {
  const src = fs.readFileSync(new URL("./store/redis.js", import.meta.url), "utf8");
  const sin = [];
  for (const l of src.split("\n")) {
    const m = l.match(/^export (?:async )?function (\w+)\(/);
    if (m && !EXENTAS.has(m[1]) && !l.includes(`guardia("${m[1]}")`)) sin.push(m[1]);
  }
  assert.deepStrictEqual(sin, [], "sin guardia: " + sin.join(", "));
});
