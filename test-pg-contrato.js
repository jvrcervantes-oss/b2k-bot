// S4b: el contrato que consume la edge. (1) la copia del esquema cerrado que usa la edge FALSA es idéntica a la de la edge REAL
// (bot-api/index.ts); (2) las pruebas de punta a punta, que usan esa edge falsa estricta, demuestran que los cuerpos del bot encajan.
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { ESQUEMA, ESQUEMA_INTERNO, validaContrato } from "./fakes-pg.js";

function leeEdgeReal() {
  const candidatas = [process.env.BOT_API_TS, new URL("../../proyectos/Lawang/supabase/functions/bot-api/index.ts", import.meta.url)].filter(Boolean);
  for (const c of candidatas) { try { return fs.readFileSync(c, "utf8").split(String.fromCharCode(13)).join(""); } catch { /* siguiente */ } }
  return null;
}

test("la copia del esquema cerrado coincide con LISTA_CERRADA de la edge real (bot-api/index.ts)", (t) => {
  const ts = leeEdgeReal();
  if (!ts) { console.warn("⚠️  test-pg-contrato: NO se encontró bot-api/index.ts (define BOT_API_TS=ruta); la comparación con la edge real NO se ha hecho"); return t.skip("sin el index.ts de la edge"); }
  const bloque = ts.slice(ts.indexOf("export const LISTA_CERRADA"), ts.indexOf("export const ACCIONES_RUTA"));
  const reales = [...bloque.matchAll(/(\w+): \{\s*(?:\/\/[^\n]*\s*)*claves: \[([^\]]*)\], tel: (true|false)/g)].map((m) => [m[1], m[2].replace(/'/g, "").split(",").map((x) => x.trim()), m[3] === "true"]);
  const copia = Object.values(ESQUEMA).flatMap((r) => Object.entries(r).map(([n, d]) => [n, d.claves, d.tel]));
  assert.ok(reales.length >= 14, "no se pudo leer la lista de la edge real: " + reales.length);
  assert.deepStrictEqual(copia, reales);
  const interno = (re) => ts.match(re)[1].replace(/'/g, "").split(",").map((x) => x.trim());
  assert.deepStrictEqual(ESQUEMA_INTERNO.mensaje, interno(/cerrado\(v, \[('rol'[^\]]*)\]\)/));
  assert.deepStrictEqual(ESQUEMA_INTERNO.salida, interno(/cerrado\(m, \[('texto', 'media', 'wamid')\]\)/));
  assert.deepStrictEqual(ESQUEMA_INTERNO.media, interno(/cerrado\(v, \[('tipo', 'id')\]\)/));
});

test("la edge falsa rechaza lo que rechazaría la real: clave de más, teléfono mal formado, usuario en /humano, rol que no es user", () => {
  const ok = { accion: "turno_estado", tel: "62812345678" };
  assert.strictEqual(validaContrato("estado", ok), null);
  assert.strictEqual(validaContrato("estado", { ...ok, extra: 1 }), "campo_no_permitido");
  assert.strictEqual(validaContrato("estado", { accion: "turno_estado", tel: "0812" }), "tel");
  assert.strictEqual(validaContrato("humano", { accion: "pausar", tel: "62812345678", modo: "pausar", usuario: "x" }), "campo_no_permitido");
  assert.strictEqual(validaContrato("estado", { accion: "mensaje_recibir", tel: "62812345678", wamid: "w", mensaje: { rol: "assistant", texto: "x" } }), "mensaje");
  assert.strictEqual(validaContrato("estado", { accion: "mensaje_recibir", tel: "62812345678", wamid: "w", mensaje: { texto: "x", media: { tipo: "image", id: "1", url: "http://x" } } }), "media");
  assert.strictEqual(validaContrato("estado", { accion: "turno_cerrar", tel: "62812345678", wamid: "w", salida: [{ texto: "x", base64: "..." }] }), "salida");
  assert.strictEqual(validaContrato("estado", { accion: "nueva", tel: "62812345678" }), "accion");
});
