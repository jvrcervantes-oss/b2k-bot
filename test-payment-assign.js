// ponytail: self-check de a QUÉ cobro se aplica un "asignar" (index.js → /admin/api/payments/assign).
// Duplica la selección porque index.js arranca Express + Redis al importarse.
//
// Por qué existe: la bandeja de pagos sin asignar se listaba por POSICIÓN en la lista de Redis.
// Entre el listado y el clic pueden entrar cobros nuevos (lPush mete por delante) o asignarse
// otro desde otra pestaña, y entonces la posición apunta a un cobro distinto: el dinero acaba en
// la ficha de otro cliente sin que nada falle visiblemente. Por eso manda el `ref` de Stripe.
import assert from "node:assert";

function pickRecord(raw, { ref, idx }) {
  return ref ? raw.find((r) => { try { return JSON.parse(r).ref === ref; } catch { return false; } }) : raw[idx];
}
const rec = (ref, amount) => JSON.stringify({ ref, amount, currency: "usd", method: "stripe" });

const A = rec("cs_AAA", 500), B = rec("cs_BBB", 1000);

// Caso normal: la lista no ha cambiado.
assert.equal(pickRecord([A, B], { ref: "cs_AAA", idx: 0 }), A);

// EL CASO QUE MOTIVA TODO: entra un cobro nuevo por delante, la posición 0 ya es otro.
const conNuevo = [rec("cs_NUEVO", 3950), A, B];
assert.equal(pickRecord(conNuevo, { ref: "cs_AAA", idx: 0 }), A, "manda el ref, no la posición");
assert.notEqual(pickRecord(conNuevo, { idx: 0 }), A, "sin ref, la posición ya apunta al cobro equivocado");

// El cobro ya se asignó desde otra pestaña: no se encuentra y el endpoint devuelve 404.
assert.equal(pickRecord([B], { ref: "cs_AAA", idx: 0 }), undefined, "mejor 404 que asignar otro cobro");

// Respaldo por posición: solo cuando el panel no manda ref (cliente viejo cacheado).
assert.equal(pickRecord([A, B], { idx: 1 }), B);
assert.equal(pickRecord([A, B], { idx: 9 }), undefined, "posición fuera de rango no revienta, devuelve nada");

// Un registro corrupto en la lista no puede tumbar la búsqueda de los demás.
assert.equal(pickRecord(["{no es json", A], { ref: "cs_AAA" }), A);

console.log("OK — asignar un cobro va por `ref`, no por posición: 7 casos");
