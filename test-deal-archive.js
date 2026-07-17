// ponytail: self-check para dealToArchive() (index.js) — la lógica que decide si un lead
// abandona un deal ya cotizado por uno nuevo distinto. Duplica la función en vez de hacer
// require("./index.js") porque ese archivo arranca el server Express + cliente Redis como
// efecto secundario del import. Si dealToArchive() cambia en index.js, actualizar aquí también.
import assert from "node:assert";

const RENTAL_FIELDS = ["model", "plan", "startDate", "endDate", "dealValue", "deliveryLocation", "insuranceTier", "paymentMethod"];

function dealToArchive(prev, fields, idField, snapshotFields) {
  const id = fields && fields[idField];
  if (!id || !prev || !prev[idField] || prev[idField] === id) return null;
  const snapshot = {};
  snapshotFields.forEach((k) => { if (prev[k] != null && prev[k] !== "") snapshot[k] = prev[k]; });
  return snapshot;
}

// Caso real del bug (Diann, 15-jul-2026): CBX200 ya cerrado, luego pregunta por un Yamaha Gear distinto.
const prevDeal = { model: "Honda CBX200", plan: "3 weeks", dealValue: 3300000, deliveryLocation: "Kintamani" };
const archived = dealToArchive(prevDeal, { model: "Yamaha Gear" }, "model", RENTAL_FIELDS);
assert.ok(archived, "debe archivar el deal anterior cuando el modelo cambia");
assert.strictEqual(archived.model, "Honda CBX200");
assert.strictEqual(archived.dealValue, 3300000);
assert.strictEqual(archived.plan, "3 weeks");

// Re-confirmación del mismo modelo → no archiva nada (no es un deal nuevo).
assert.strictEqual(dealToArchive(prevDeal, { model: "Honda CBX200" }, "model", RENTAL_FIELDS), null);

// Lead nuevo sin deal previo → no archiva nada.
assert.strictEqual(dealToArchive({}, { model: "Yamaha Gear" }, "model", RENTAL_FIELDS), null);

// El mensaje nuevo no trae identidad de deal (ej. solo un email) → no archiva nada.
assert.strictEqual(dealToArchive(prevDeal, { email: "x@y.com" }, "model", RENTAL_FIELDS), null);

console.log("OK — test-deal-archive.js");
