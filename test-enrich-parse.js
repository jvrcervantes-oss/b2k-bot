// Check del extractor del CRM: el modelo devuelve el JSON envuelto en prosa o en vallas.
// node test-enrich-parse.js  (sin dependencias; falla con AssertionError si el parseo se rompe)
import assert from "assert";

// Copia literal de parseJsonLoose() en index.js — este test es el que la vigila.
function parseJsonLoose(text) {
  const s = String(text || "");
  return JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1));
}

const OK = { name: "Dion", model: "Honda Scoopy", email: null };

assert.deepStrictEqual(parseJsonLoose('{"name":"Dion","model":"Honda Scoopy","email":null}'), OK, "JSON pelado");
assert.deepStrictEqual(parseJsonLoose('Based on the conversation, here are the fields:\n{"name":"Dion","model":"Honda Scoopy","email":null}'), OK, "prosa delante (el fallo real de producción)");
assert.deepStrictEqual(parseJsonLoose('```json\n{"name":"Dion","model":"Honda Scoopy","email":null}\n```'), OK, "vallas de código");
assert.deepStrictEqual(parseJsonLoose('Here:\n```json\n{"name":"Dion","model":"Honda Scoopy","email":null}\n```\nLet me know!'), OK, "prosa + vallas + coletilla");
assert.deepStrictEqual(parseJsonLoose('{"name":"Dion","model":"Honda Scoopy","email":null,"note":{"a":1}}').note, { a: 1 }, "objeto anidado al final");

assert.throws(() => parseJsonLoose("I can't extract anything from this chat."), SyntaxError, "sin objeto → throw (lo caza el catch de enrich)");
assert.throws(() => parseJsonLoose(""), SyntaxError, "vacío → throw");

console.log("OK — parseJsonLoose aguanta prosa, vallas y respuestas sin JSON");
