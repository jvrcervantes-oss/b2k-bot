// ponytail: self-check de a QUIÉN pertenece un cobro de Stripe (index.js → stripeOwnership).
// Duplica la función porque index.js arranca Express + Redis al importarse.
//
// Por qué existe: B2K y BBM comparten UNA cuenta de Stripe y Stripe reparte cada evento a TODOS
// los endpoints de la cuenta — no hay filtro por metadata en el propio Stripe. Descubierto el
// 31-jul-2026 al ir a crear el endpoint de B2K: ya había uno apuntando al bot de BBM.
// El handler de BBM atribuye por `client_reference_id` / `metadata.phone` y lee el importe como
// IDR (zero-decimal). Si un cobro de B2K llevara esas claves, BBM se apuntaría un lead pagado
// ajeno y con el importe multiplicado por 100. Por eso el teléfono de B2K viaja en `lead_phone`.
import assert from "node:assert";

function stripeOwnership(s, me, myCurrency = "usd") {
  const md = (s && s.metadata) || {};
  if (md.bot && md.bot === me) return { verdict: "mine", owner: me, phone: md.lead_phone || "" };
  if (md.bot) return { verdict: "foreign", owner: md.bot, phone: "" };
  if (md.phone || (s && s.client_reference_id)) return { verdict: "foreign", owner: "sin marcar", phone: "" };
  if (String((s && s.currency) || "").toLowerCase() !== myCurrency) return { verdict: "foreign", owner: "otra moneda", phone: "" };
  return { verdict: "unmatched", owner: "", phone: "" };
}

const ME = "Bali Moto Adventures";

// ── Lo nuestro ───────────────────────────────────────────────────
const mine = { currency: "usd", metadata: { bot: ME, lead_phone: "447852148942", units: "2" } };
assert.strictEqual(stripeOwnership(mine, ME).verdict, "mine");
assert.strictEqual(stripeOwnership(mine, ME).phone, "447852148942");

// ── Lo de BBM: forma REAL de sus sesiones (balibest:index.js ~1817) ──
const bbm = { currency: "idr", client_reference_id: "628123456789", metadata: { phone: "628123456789" } };
assert.strictEqual(stripeOwnership(bbm, ME).verdict, "foreign", "un alquiler de BBM no es caja de B2K");
assert.strictEqual(stripeOwnership(bbm, ME).phone, "", "y jamás devuelve teléfono que atribuir");
// Aunque algún día marquen sus sesiones, sigue siendo ajeno.
assert.strictEqual(stripeOwnership({ currency: "idr", metadata: { bot: "BaliBest" } }, ME).verdict, "foreign");

// ── El link de pago de la web (sin metadata) ─────────────────────
assert.strictEqual(stripeOwnership({ currency: "usd" }, ME).verdict, "unmatched", "va al cajón de asignar a mano");
// Mismo caso pero en IDR: no puede ser de la web de B2K, que cobra en USD.
assert.strictEqual(stripeOwnership({ currency: "idr" }, ME).verdict, "foreign");

// ── Bordes ───────────────────────────────────────────────────────
assert.strictEqual(stripeOwnership({}, ME).verdict, "foreign", "sin moneda no se asume que es nuestro");
assert.strictEqual(stripeOwnership(null, ME).verdict, "foreign", "un payload vacío nunca cuenta como caja");
assert.strictEqual(stripeOwnership({ currency: "USD" }, ME).verdict, "unmatched", "la moneda llega en mayúsculas a veces");
// Nuestra marca pero sin teléfono (sesión creada sin lead): es nuestra, va a unmatched por falta
// de destinatario — eso lo decide el handler, no esta función, que solo dice de quién es.
assert.deepStrictEqual(stripeOwnership({ currency: "usd", metadata: { bot: ME } }, ME), { verdict: "mine", owner: ME, phone: "" });

console.log("OK — propiedad de un cobro de Stripe en cuenta compartida: 11 casos");
