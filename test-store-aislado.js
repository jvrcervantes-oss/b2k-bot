// S4a (encargo 20261009_lawang_bot_sin_redis): TODO el acceso a Redis y TODA la memoria de respaldo viven en
// store/redis.js. Este test falla si el cliente de Redis o cualquier variable de respaldo aparecen en otro .js
// del bot (excepto los test-*.js, que pueden nombrarlos para vigilarlos).
//
// Por qué: es lo que hace imposible que un STOP o una pausa se guarden en RAM por un sitio olvidado, y lo que
// permite apagar Redis (S9) borrando un fichero. "Cerrar una salida no cierra las hermanas": una lista a mano
// de sitios de llamada se queda corta el día que el motor crezca; esto mira el código entero.
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

const RAIZ = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const PROHIBIDO = /redisClient|fallback/i;
const SALTAR = new Set(["node_modules", ".git", "Backups"]);

function jsDelBot(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SALTAR.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) jsDelBot(p, acc);
    else if (/\.(js|mjs|cjs)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

const rel = (p) => path.relative(RAIZ, p).split(path.sep).join("/");
const ficheros = jsDelBot(RAIZ).filter((p) => !/^test-.*\.js$/.test(path.basename(p)) && !/^_v2check_/.test(path.basename(p)));

test("el árbol del bot tiene su módulo de almacén y el motor lo importa", () => {
  assert.ok(ficheros.map(rel).includes("store/redis.js"), "falta store/redis.js");
  assert.ok(ficheros.map(rel).includes("index.js"), "no se encontró index.js (¿ruta mal calculada?)");
  const idx = fs.readFileSync(path.join(RAIZ, "index.js"), "utf8");
  assert.match(idx, /from "\.\/store\/redis\.js"/);
  assert.ok(!/from "redis"/.test(idx), "index.js no debe importar el paquete redis: solo store/redis.js");
});

test("ni redisClient ni fallback* aparecen fuera de store/redis.js", () => {
  const fuera = [];
  for (const f of ficheros) {
    if (rel(f) === "store/redis.js") continue;
    const lineas = fs.readFileSync(f, "utf8").split("\n");
    lineas.forEach((l, i) => { if (PROHIBIDO.test(l)) fuera.push(`${rel(f)}:${i + 1}: ${l.trim().slice(0, 100)}`); });
  }
  assert.deepStrictEqual(fuera, [], "acceso a Redis o memoria de respaldo fuera de store/redis.js:\n" + fuera.join("\n"));
});

test("solo store/redis.js importa el paquete redis", () => {
  const otros = ficheros.filter((f) => rel(f) !== "store/redis.js" && /from\s+["']redis["']|require\(["']redis["']\)/.test(fs.readFileSync(f, "utf8")));
  assert.deepStrictEqual(otros.map(rel), []);
});

test("el test sabe fallar: un fichero con redisClient o fallback sería detectado", () => {
  assert.ok(PROHIBIDO.test("await redisClient.get(x)"));
  assert.ok(PROHIBIDO.test("const fallbackPaused = {};"));
  assert.ok(!PROHIBIDO.test("await isPaused(phone)"));
});
