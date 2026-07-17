// ponytail: self-check para el motor de deals concurrentes (index.js) — findOpenDealIndex(),
// focusDeal()/mirrorOf() y capDeals(). Duplica las funciones en vez de hacer require("./index.js")
// porque ese archivo arranca el server Express + cliente Redis como efecto secundario del import.
// Si estas funciones cambian en index.js, actualizar aquí también.
import assert from "node:assert";

const DEAL_ID_FIELD = "model";
const DEAL_FIELDS = ["model", "plan", "startDate", "endDate", "dealValue", "deliveryLocation", "insuranceTier", "paymentMethod"];

function findOpenDealIndex(deals, dealFields) {
  const id = dealFields[DEAL_ID_FIELD];
  if (id) return deals.findIndex((d) => d.status === "open" && d[DEAL_ID_FIELD] === id);
  const openIdxs = [];
  deals.forEach((d, i) => { if (d.status === "open") openIdxs.push(i); });
  return openIdxs.length === 1 ? openIdxs[0] : -1;
}
function focusDeal(deals) {
  if (!deals.length) return null;
  const open = deals.filter((d) => d.status === "open");
  const pool = open.length ? open : deals;
  return pool.reduce((a, b) => ((b.updatedAt || 0) > (a.updatedAt || 0) ? b : a));
}
function mirrorOf(deal) {
  const m = {};
  if (deal) DEAL_FIELDS.forEach((k) => { if (deal[k] != null) m[k] = deal[k]; });
  return m;
}
function capDeals(deals, cap) {
  if (deals.length <= cap) return deals;
  const closedSorted = deals.filter((d) => d.status !== "open").sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
  const openCount = deals.length - closedSorted.length;
  const keepClosed = new Set(closedSorted.slice(-(Math.max(0, cap - openCount))));
  return deals.filter((d) => d.status === "open" || keepClosed.has(d));
}
function statusAfterDealClose(deals, prevLeadStatus) {
  if (deals.some((d) => d.status === "open")) return null;
  const newStatus = deals.some((d) => d.status === "won") ? "won" : "lost";
  if (prevLeadStatus === newStatus) return null;
  if (["won", "lost", "noshow"].includes(prevLeadStatus)) return null;
  return newStatus;
}
function statusAfterNewDeal(prevLeadStatus) {
  return ["won", "lost", "noshow"].includes(prevLeadStatus) ? "" : null;
}

// Caso real del bug (Diann, 15-jul-2026): CBX200 abierto, luego pregunta por un Yamaha Gear distinto.
// El fix real: los DOS quedan abiertos y visibles, ninguno se pisa ni se pierde.
const cbx = { id: "d1", status: "open", model: "Honda CBX200", plan: "3 weeks", dealValue: 3300000, updatedAt: 1 };
let deals = [cbx];
assert.strictEqual(findOpenDealIndex(deals, { model: "Yamaha Gear" }), -1, "modelo distinto sin match → crear deal nuevo, no pisar el existente");

const gear = { id: "d2", status: "open", model: "Yamaha Gear", updatedAt: 2 };
deals = [cbx, gear];
assert.strictEqual(deals.filter((d) => d.status === "open").length, 2, "ambos deals conviven abiertos");

// Reconfirmar el mismo modelo → SÍ hace match con el deal abierto existente (se actualiza, no se duplica).
assert.strictEqual(findOpenDealIndex(deals, { model: "Honda CBX200" }), 0);

// Solo llega un campo sin identidad (ej. delivery) y hay un único deal abierto → se aplica a ESE.
assert.strictEqual(findOpenDealIndex([cbx], { deliveryLocation: "Kintamani" }), 0);
// Mismo caso pero con DOS abiertos → ambiguo, no se puede saber a cuál pertenece.
assert.strictEqual(findOpenDealIndex(deals, { deliveryLocation: "Kintamani" }), -1);

// focusDeal(): el abierto más reciente manda el mirror de la ficha/tabla/dashboard.
assert.strictEqual(focusDeal(deals).id, "d2");
assert.deepStrictEqual(mirrorOf(focusDeal(deals)).model, "Yamaha Gear");

// Si se cierra el más reciente (ganado/perdido), el mirror pasa al que sigue abierto.
const gearWon = { ...gear, status: "won", updatedAt: 3 };
assert.strictEqual(focusDeal([cbx, gearWon]).id, "d1");

// capDeals(): nunca recorta un deal abierto, solo los ya cerrados más antiguos.
const many = [cbx, gearWon, ...Array.from({ length: 5 }, (_, i) => ({ id: "c" + i, status: "lost", updatedAt: 10 + i }))];
const capped = capDeals(many, 3);
assert.ok(capped.some((d) => d.id === "d1"), "el deal abierto sobrevive al recorte");
assert.strictEqual(capped.filter((d) => d.status === "open").length, 1);
assert.ok(capped.length <= 3 + 1); // el abierto no cuenta contra el cupo de cerrados

// statusAfterDealClose(): el bug real que encontró la auditoría del 17-jul — el status de
// nivel-lead (won/lost/noshow, lo lee followupTick/computeDropoff) no se sincronizaba solo con
// deals[] cuando se cerraba un deal desde el panel nuevo.
const oneOpenOneWon = [{ status: "won" }, { status: "open" }];
assert.strictEqual(statusAfterDealClose(oneOpenOneWon, ""), null, "todavía queda un deal abierto → no tocar el status del lead");

const bothWon = [{ status: "won" }, { status: "won" }];
assert.strictEqual(statusAfterDealClose(bothWon, ""), "won", "sin deals abiertos y alguno ganó → status=won");

const bothLost = [{ status: "lost" }, { status: "lost" }];
assert.strictEqual(statusAfterDealClose(bothLost, ""), "lost", "sin deals abiertos y ninguno ganó → status=lost");

assert.strictEqual(statusAfterDealClose(bothWon, "won"), null, "ya estaba en won → no reescribir (evita logs de status redundantes)");
assert.strictEqual(statusAfterDealClose(bothLost, "noshow"), null, "no pisar un status terminal ya puesto a mano (noshow) aunque los deals digan lost");

// statusAfterNewDeal(): un lead ya cerrado que abre un deal nuevo necesita atención de nuevo.
assert.strictEqual(statusAfterNewDeal("won"), "", "lead ganado con una consulta nueva → reabrir (status vacío)");
assert.strictEqual(statusAfterNewDeal("lost"), "", "lead perdido con una consulta nueva → reabrir");
assert.strictEqual(statusAfterNewDeal("quoted"), null, "lead ya en curso (no terminal) → no tocar");
assert.strictEqual(statusAfterNewDeal(""), null, "lead nuevo sin status → no tocar (ya está vacío)");

console.log("OK — test-deal-archive.js");
