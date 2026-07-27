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

console.log("OK — inquiry xendit fields");
