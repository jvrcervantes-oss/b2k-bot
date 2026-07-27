// ponytail: self-check de lastXenditInvoice() y del gate de re-envío de pushInquiryToERP (index.js).
// Duplica las funciones en vez de importar index.js porque ese archivo arranca Express + Redis al
// importarse. Si cambian allí, actualizar aquí también.
import assert from "node:assert";

function lastXenditInvoice(lead) {
  const h = Array.isArray(lead.history) ? lead.history : [];
  for (let i = h.length - 1; i >= 0; i--) {
    const e = h[i];
    if (e.type !== "paylink" || e.provider !== "xendit" || !e.refId || e.cancelled) continue;
    const paid = h.some((p) => p.type === "payment" && p.provider === "xendit" && p.ts >= e.ts);
    return { id: e.refId, url: e.url || null, amount: Math.round(e.amount) || 0, status: paid ? "paid" : "pending" };
  }
  return null;
}
function xenditFields(inv) {
  const f = { xendit_invoice_id: inv.id, xendit_status: inv.status };
  if (inv.url) f.xendit_invoice_url = inv.url;
  if (inv.amount > 0) f.xendit_amount = inv.amount;
  return f;
}
function lastInquiryId(lead) {
  const h = Array.isArray(lead.history) ? lead.history : [];
  for (let i = h.length - 1; i >= 0; i--) if (h[i].type === "inquiry" && h[i].id) return h[i].id;
  return null;
}
// delivery_fee que ve el modelo: ida+vuelta, o solo la ida si el cliente devuelve la moto él mismo
function deliveryFeeFor(d, self_return) {
  const dv = d.delivery || {};
  const oneWay = Math.round(Number(dv.one_way_fee) || 0);
  return (self_return === true && dv.round_trip === true && oneWay > 0) ? oneWay : d.delivery_fee;
}
// gate real de pushInquiryToERP: true = no se manda nada
const skip = (sent, inv) => !!(sent && (!inv || sent.endsWith(`|${inv.id}`)));

// sin historial → nada que adjuntar, la inquiry va como siempre
assert.strictEqual(lastXenditInvoice({}), null);
assert.strictEqual(lastXenditInvoice({ history: [{ type: "tag", to: "x" }] }), null);

// paylink de Stripe no cuenta como invoice de Xendit
assert.strictEqual(lastXenditInvoice({ history: [{ type: "paylink", provider: "stripe", refId: "cs_1", ts: 1 }] }), null);

// paylink viejo sin url (anterior a este cambio) → id sí, url null
assert.deepStrictEqual(
  lastXenditInvoice({ history: [{ type: "paylink", provider: "xendit", refId: "inv_old", amount: 2750000, ts: 1 }] }),
  { id: "inv_old", url: null, amount: 2750000, status: "pending" }
);

// el más reciente gana y las anuladas se ignoran
const lead = { history: [
  { type: "paylink", provider: "xendit", refId: "inv_1", url: "https://checkout.xendit.co/1", amount: 1000000, ts: 10 },
  { type: "paylink", provider: "xendit", refId: "inv_2", url: "https://checkout.xendit.co/2", amount: 2750000, ts: 20, cancelled: true },
] };
assert.strictEqual(lastXenditInvoice(lead).id, "inv_1");

// amount siempre entero IDR, nunca decimal
assert.strictEqual(lastXenditInvoice({ history: [{ type: "paylink", provider: "xendit", refId: "i", amount: 2750000.4, ts: 1 }] }).amount, 2750000);

// pago posterior confirmado → "paid", no "pending"
assert.strictEqual(lastXenditInvoice({ history: [
  { type: "paylink", provider: "xendit", refId: "inv_3", amount: 500000, ts: 5 },
  { type: "payment", provider: "xendit", amount: 500000, ts: 9 },
] }).status, "paid");

// gate: nunca enviada → se envía; sin invoice y ya enviada → no se repite
const inv = { id: "inv_9" };
assert.strictEqual(skip(null, inv), false);
assert.strictEqual(skip(null, null), false);
assert.strictEqual(skip("41|", null), true);
// marker viejo (formato "41", pre-cambio) + invoice nueva → se repite UNA vez, luego ya no
assert.strictEqual(skip("41", inv), false);
assert.strictEqual(skip("41|inv_9", inv), true);
// invoice distinta (la anterior se anuló y se creó otra) → vuelve a viajar
assert.strictEqual(skip("41|inv_9", { id: "inv_10" }), false);

// body del POST/PATCH: nunca se manda una clave con null, el ERP recibe solo lo que existe
assert.deepStrictEqual(xenditFields({ id: "inv_1", url: null, amount: 0, status: "pending" }), {
  xendit_invoice_id: "inv_1", xendit_status: "pending",
});
assert.deepStrictEqual(xenditFields({ id: "inv_1", url: "https://x/1", amount: 2832500, status: "paid" }), {
  xendit_invoice_id: "inv_1", xendit_status: "paid", xendit_invoice_url: "https://x/1", xendit_amount: 2832500,
});

// id de la inquiry para el PATCH: sale del timeline, el más reciente
assert.strictEqual(lastInquiryId({}), null);
assert.strictEqual(lastInquiryId({ history: [{ type: "inquiry", id: "" }] }), null); // el ERP no devolvió id → no se parchea
assert.strictEqual(lastInquiryId({ history: [
  { type: "inquiry", id: 41 }, { type: "paylink", provider: "xendit", refId: "i" }, { type: "inquiry", id: 42 },
] }), 42);

// delivery por trayecto (regla del owner 27-jul): devolviéndola el cliente se cobra solo la ida
const q = { delivery_fee: 100000, delivery: { one_way_fee: 50000, round_trip: true, matched_area: "Canggu" } };
assert.strictEqual(deliveryFeeFor(q, true), 50000);
assert.strictEqual(deliveryFeeFor(q, false), 100000);
assert.strictEqual(deliveryFeeFor(q, undefined), 100000); // si no lo han dicho, se cobra entero
// tarifa que el ERP no da por trayecto → nunca la partimos a ojo
assert.strictEqual(deliveryFeeFor({ delivery_fee: 100000, delivery: { one_way_fee: 0, round_trip: true } }, true), 100000);
assert.strictEqual(deliveryFeeFor({ delivery_fee: 80000, delivery: { one_way_fee: 80000, round_trip: false } }, true), 80000);

console.log("OK — inquiry xendit fields");
