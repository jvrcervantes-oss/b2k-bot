// ponytail: self-check de que las DOS agendas B2B no se pisan (index.js → OP_DBS / opNs).
// Duplica el mapa porque index.js arranca Express + Redis al importarse.
//
// Por qué existe: "Operadores" y "Travel Adventures Operators" comparten ficha, endpoints y
// vista — lo único que las separa es este mapa. Si dos entradas apuntaran al mismo prefijo o
// al mismo índice, las dos agendas se fundirían en silencio y solo se notaría al mandar una
// newsletter a quien no tocaba. Un `db` desconocido tiene que reventar, no caer en la primera.
import assert from "node:assert";

const OP_DBS = { ops: { key: "op", index: "ops_index" }, tao: { key: "tao", index: "taos_index" } };
function opNs(db) {
  const ns = OP_DBS[db || "ops"];
  if (!ns) throw new Error(`base de datos de operadores desconocida: ${db}`);
  return ns;
}

const dbs = Object.keys(OP_DBS);
assert.equal(new Set(dbs.map((d) => OP_DBS[d].key)).size, dbs.length, "dos agendas con el mismo prefijo escriben la una sobre la otra");
assert.equal(new Set(dbs.map((d) => OP_DBS[d].index)).size, dbs.length, "dos agendas con el mismo índice se listan juntas");

// El prefijo de los leads de chat es `lead:` — ninguna agenda B2B puede colisionar con él.
assert.ok(!dbs.some((d) => OP_DBS[d].key === "lead"), "una agenda B2B jamás escribe en el namespace de los leads");
// Ni un prefijo puede ser prefijo del otro con el mismo separador (`op:` vs `op:x:`…).
assert.ok(!dbs.some((a) => dbs.some((b) => a !== b && OP_DBS[b].key.startsWith(OP_DBS[a].key + ":"))), "un prefijo anidado en otro haría ambigua la clave");

assert.equal(opNs(undefined).key, "op", "sin db se opera sobre la agenda de siempre");
assert.equal(opNs("tao").index, "taos_index");
assert.throws(() => opNs("Ops"), /desconocida/, "el nombre es sensible a mayúsculas: un typo no puede caer en otra agenda");
assert.throws(() => opNs("leads"), /desconocida/, "los leads de chat no son una agenda de operadores");

console.log(`OK — ${dbs.length} agendas B2B con namespace propio, y un db desconocido revienta`);
