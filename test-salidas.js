// ponytail: self-check del panel de salidas (index.js → paxOf / paxPayment / depOccupancy).
// Duplica las funciones porque index.js arranca Express + Redis al importarse.
//
// Por qué existe: la primera versión de este panel deducía las salidas agrupando el `travelDate`
// del lead, que es texto libre, y contaba a cualquiera con una fecha en la ficha. Salían 8
// "salidas" de las que ninguna estaba confirmada. Ahora la salida es un objeto que crea el
// estudio y solo cuenta el lead marcado `won` a mano. El dinero es SOLO real: sin importe
// cerrado no se estima, porque una cifra inventada en un panel de caja es peor que un hueco.
import assert from "node:assert";

const DEP_CAPACITY = 12, DEP_MIN_PAX = 6;
const paxOf = (l) => Math.max(1, (parseInt(l.riders, 10) || 0) + (parseInt(l.pillions, 10) || 0));

function paxPayment(l) {
  const expected = Math.max(0, parseInt(l.dealValue, 10) || 0);
  const paid = (Array.isArray(l.payments) ? l.payments : []).reduce((a, p) => a + (Number(p.amount) || 0), 0);
  let state;
  if (!expected) state = paid > 0 ? "partial" : "unpriced";
  else if (paid >= expected) state = "paid";
  else state = paid > 0 ? "partial" : "unpaid";
  return { expected, paid, pending: Math.max(0, expected - paid), state };
}

function depOccupancy(dep, roster) {
  const capacity = parseInt(dep.capacity, 10) > 0 ? parseInt(dep.capacity, 10) : DEP_CAPACITY;
  const minPax = parseInt(dep.minPax, 10) >= 0 ? parseInt(dep.minPax, 10) : DEP_MIN_PAX;
  const pax = roster.reduce((a, l) => a + paxOf(l), 0);
  const occState = dep.state === "cancelled" ? "cancelled"
    : pax >= capacity ? "full"
    : pax >= minPax ? "confirmed"
    : "forming";
  return { capacity, minPax, pax, free: Math.max(0, capacity - pax), toMin: Math.max(0, minPax - pax), occState, overbooked: pax > capacity };
}

// ── Personas que ocupa un lead ───────────────────────────────────
assert.strictEqual(paxOf({ riders: 2, pillions: 1 }), 3);
assert.strictEqual(paxOf({ riders: 1 }), 1);
assert.strictEqual(paxOf({}), 1, "un ganado sin números sigue siendo UNA persona, no cero");
assert.strictEqual(paxOf({ riders: 0, pillions: 0 }), 1, "contarlo como 0 haría parecer vacía una salida llena");
assert.strictEqual(paxOf({ riders: "2" }), 2, "los números llegan como texto desde el formulario");

// ── Cobro: SOLO dinero real ──────────────────────────────────────
assert.strictEqual(paxPayment({ dealValue: 4000, payments: [{ amount: 4000 }] }).state, "paid");
assert.strictEqual(paxPayment({ dealValue: 4000, payments: [{ amount: 500 }] }).state, "partial");
assert.strictEqual(paxPayment({ dealValue: 4000, payments: [{ amount: 500 }] }).pending, 3500);
assert.strictEqual(paxPayment({ dealValue: 4000 }).state, "unpaid");
assert.strictEqual(paxPayment({ dealValue: 4000 }).pending, 4000);
// Sin importe cerrado NO se estima nada: ni por paquete ni por personas.
assert.deepStrictEqual(paxPayment({ package: "Deluxe", riders: 2 }), { expected: 0, paid: 0, pending: 0, state: "unpriced" });
// Pagó algo pero nadie cerró el precio: no se puede decir que esté pagado.
assert.strictEqual(paxPayment({ payments: [{ amount: 500 }] }).state, "partial");
assert.strictEqual(paxPayment({ payments: [{ amount: 500 }] }).pending, 0, "sin importe no se inventa una deuda");
// Pagó de más: la deuda no puede ser negativa.
assert.strictEqual(paxPayment({ dealValue: 1000, payments: [{ amount: 1500 }] }).pending, 0);
assert.strictEqual(paxPayment({ dealValue: 1000, payments: [{ amount: 1500 }] }).state, "paid");

// ── Ocupación ────────────────────────────────────────────────────
const DEP = { capacity: 12, minPax: 6, state: "open" };
const uno = (n) => Array.from({ length: n }, () => ({ riders: 1 }));

let o = depOccupancy(DEP, uno(5));
assert.strictEqual(o.occState, "forming", "por debajo del mínimo la salida puede no arrancar");
assert.strictEqual(o.toMin, 1);
assert.strictEqual(o.free, 7);

o = depOccupancy(DEP, uno(6));
assert.strictEqual(o.occState, "confirmed", "en el mínimo exacto ya sale");
assert.strictEqual(o.toMin, 0);

o = depOccupancy(DEP, uno(12));
assert.strictEqual(o.occState, "full");
assert.strictEqual(o.free, 0);
assert.strictEqual(o.overbooked, false, "estar lleno no es haberse pasado");

o = depOccupancy(DEP, uno(13));
assert.strictEqual(o.overbooked, true, "13 en un grupo de 12 tiene que verse");
assert.strictEqual(o.free, 0, "las plazas libres nunca son negativas");

// Una cancelada no cuenta como confirmada por mucha gente que tenga.
assert.strictEqual(depOccupancy({ ...DEP, state: "cancelled" }, uno(8)).occState, "cancelled");
// Salida vacía recién creada.
o = depOccupancy(DEP, []);
assert.strictEqual(o.pax, 0); assert.strictEqual(o.toMin, 6); assert.strictEqual(o.occState, "forming");
// Un solo lead con acompañante ocupa 2 plazas, no 1.
assert.strictEqual(depOccupancy(DEP, [{ riders: 1, pillions: 1 }]).pax, 2);
// Capacidad propia de la salida (un grupo privado más pequeño).
assert.strictEqual(depOccupancy({ capacity: 4, minPax: 2, state: "open" }, uno(4)).occState, "full");
// Sin capacidad definida se cae a los valores del tour (6-12).
assert.strictEqual(depOccupancy({ state: "open" }, uno(6)).capacity, 12);
assert.strictEqual(depOccupancy({ state: "open" }, uno(6)).occState, "confirmed");

// La ocupación NO puede devolver una clave `state`: el endpoint fusiona `{...salida, ...ocupación}`
// y la salida ya tiene su propio `state` guardado (open/cancelled). Cuando la ocupación lo llamaba
// igual, lo pisaba con "forming" y el desplegable de estado del formulario salía EN BLANCO.
assert.ok(!("state" in depOccupancy(DEP, uno(3))), "la ocupación no puede pisar el estado guardado de la salida");

console.log("OK — panel de salidas: 29 casos");
