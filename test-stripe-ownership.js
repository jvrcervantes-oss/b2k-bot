// ponytail: self-check de a QUIÉN pertenece un cobro de Stripe (index.js → stripeOwnership).
// Duplica la función porque index.js arranca Express + Redis al importarse.
//
// Por qué existe: BBM y B2K comparten UNA cuenta de Stripe y Stripe reparte cada evento a TODOS
// los endpoints de la cuenta — no hay filtro por metadata en el propio Stripe. Este handler lee
// el importe como IDR (zero-decimal): un depósito de tour de B2K en USD entraría con el importe
// ×100 y en la ficha de un lead ajeno. Gemelo del de la rama b2k, con la moneda invertida.
import assert from "node:assert";

function stripeOwnership(s, me, myCurrency = "idr") {
  const md = (s && s.metadata) || {};
  const ref = (s && s.client_reference_id) || "";
  if (md.bot && md.bot === me) return { verdict: "mine", owner: me, phone: md.phone || ref };
  if (md.bot) return { verdict: "foreign", owner: md.bot, phone: "" };
  if (md.lead_phone) return { verdict: "foreign", owner: "b2k", phone: "" };
  if (md.phone || ref) return { verdict: "mine", owner: me, phone: md.phone || ref };
  if (String((s && s.currency) || "").toLowerCase() !== myCurrency) return { verdict: "foreign", owner: "otra moneda", phone: "" };
  return { verdict: "unmatched", owner: "", phone: "" };
}

const ME = "Bali Best Motorcycle";

// ── Lo nuestro ───────────────────────────────────────────────────
const mine = { currency: "idr", client_reference_id: "628123456789", metadata: { bot: ME, phone: "628123456789" } };
assert.strictEqual(stripeOwnership(mine, ME).verdict, "mine");
assert.strictEqual(stripeOwnership(mine, ME).phone, "628123456789");

// Sesión nuestra de ANTES de la marca `bot` (puede estar en vuelo al desplegar): se sigue cobrando.
const legado = { currency: "idr", client_reference_id: "628999888777", metadata: { phone: "628999888777" } };
assert.strictEqual(stripeOwnership(legado, ME).verdict, "mine", "una sesión ya abierta no se pierde por desplegar");
assert.strictEqual(stripeOwnership(legado, ME).phone, "628999888777");

// ── Lo de B2K: forma REAL de sus sesiones (b2k:index.js ~1595) ───
const b2k = { currency: "usd", metadata: { bot: "Bali Moto Adventures", lead_phone: "447852148942", units: "2" } };
assert.strictEqual(stripeOwnership(b2k, ME).verdict, "foreign", "un depósito de tour de B2K no es caja de BBM");
assert.strictEqual(stripeOwnership(b2k, ME).phone, "", "y jamás devuelve teléfono que atribuir");
// Su clave de teléfono sola, aunque perdiera la marca: sigue siendo ajena.
assert.strictEqual(stripeOwnership({ currency: "usd", metadata: { lead_phone: "447852148942" } }, ME).verdict, "foreign");
// El link de pago de la web de B2K (sin metadata, en USD).
assert.strictEqual(stripeOwnership({ currency: "usd" }, ME).verdict, "foreign", "otra moneda = no es nuestro");

// ── Bordes ───────────────────────────────────────────────────────
assert.strictEqual(stripeOwnership({ currency: "idr" }, ME).verdict, "unmatched", "en nuestra moneda pero sin destinatario: se avisa y se descarta");
assert.strictEqual(stripeOwnership({ currency: "IDR" }, ME).verdict, "unmatched", "la moneda llega en mayúsculas a veces");
assert.strictEqual(stripeOwnership({}, ME).verdict, "foreign", "sin moneda no se asume que es nuestro");
assert.strictEqual(stripeOwnership(null, ME).verdict, "foreign", "un payload vacío nunca cuenta como caja");

console.log("OK — propiedad de un cobro de Stripe en cuenta compartida (BBM): 12 casos");
