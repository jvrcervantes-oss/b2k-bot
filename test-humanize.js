// Self-check del ritmo humano y de la cola por lead. `node test-humanize.js`
// Lo que rompe si esto falla: el bot vuelve a contestar en 3s (el tell que perdió un lead real)
// o dos mensajes seguidos del mismo cliente se pisan el historial.
import assert from "node:assert";

// ── Copia de la lógica de index.js (sin jitter, para poder afirmar sobre ella) ──
const TYPE_MS_PER_CHAR = 55, READ_MS = 2500, FIRST_BUBBLE_CAP_MS = 20000;
const target = (len, cap) => Math.min(READ_MS + len * TYPE_MS_PER_CHAR, cap);

// 1. Una respuesta corta ya no sale instantánea, pero tampoco hace esperar de más.
assert.ok(target(40, FIRST_BUBBLE_CAP_MS) >= 4000, "respuesta corta demasiado rápida");
assert.ok(target(40, FIRST_BUBBLE_CAP_MS) <= 6000, "respuesta corta demasiado lenta");

// 2. Una respuesta LARGA tarda claramente más que una corta: ese contraste es lo que faltaba.
//    En producción cortas=2,3s y largas=4,5s (casi igual) — imposible para alguien tecleando.
assert.ok(target(500, FIRST_BUBBLE_CAP_MS) > target(40, FIRST_BUBBLE_CAP_MS) * 3, "largas y cortas tardan casi igual");

// 3. Nunca se pasa de la ventana de 25s del indicador "escribiendo…" (con jitter máx 1,15).
assert.ok(target(5000, FIRST_BUBBLE_CAP_MS) * 1.15 < 25000, "se sale de la ventana de typing de Meta");

// 4. Lo que ya tardó Claude se DESCUENTA (una respuesta lenta no acumula espera encima).
const espera = (len, yaTardo) => target(len, FIRST_BUBBLE_CAP_MS) - yaTardo;
assert.ok(espera(200, 0) > espera(200, 5000), "no se descuenta la latencia del modelo");
assert.ok(espera(60, 30000) < 0, "una respuesta ya lentísima debería salir sin pausa extra");

// ── Cola por lead ──────────────────────────────────────────────────────────────
const turnQueue = new Map();
async function waitMyTurn(phone) {
  const prev = turnQueue.get(phone);
  let release;
  const mine = new Promise((r) => { release = r; });
  turnQueue.set(phone, mine);
  if (prev) await prev;
  return () => { release(); if (turnQueue.get(phone) === mine) turnQueue.delete(phone); };
}

(async () => {
  // 5. Dos turnos del MISMO lead no se solapan (el 2º no empieza hasta que el 1º suelta).
  const orden = [];
  const turno = async (etiqueta, ms) => {
    const soltar = await waitMyTurn("34600");
    orden.push("in:" + etiqueta);
    await new Promise((r) => setTimeout(r, ms));
    orden.push("out:" + etiqueta);
    soltar();
  };
  await Promise.all([turno("A", 60), turno("B", 5)]);
  assert.deepStrictEqual(orden, ["in:A", "out:A", "in:B", "out:B"], "los turnos del mismo lead se solapan");

  // 6. Leads DISTINTOS sí corren en paralelo (si no, un lead lento bloquea a todos).
  const par = [];
  const otro = async (p) => { const s = await waitMyTurn(p); par.push("in:" + p); await new Promise((r) => setTimeout(r, 30)); par.push("out:" + p); s(); };
  await Promise.all([otro("1"), otro("2")]);
  assert.deepStrictEqual(par, ["in:1", "in:2", "out:1", "out:2"], "un lead bloquea a otro distinto");

  // 7. La cola se vacía: no acumula una entrada por cada lead que ha escrito nunca.
  assert.strictEqual(turnQueue.size, 0, "fuga de memoria en turnQueue");

  console.log("OK — ritmo humano y cola por lead");
})();
