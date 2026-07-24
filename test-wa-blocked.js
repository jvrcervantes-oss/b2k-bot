// ponytail: self-check del guardrail de CUENTA BLOQUEADA (index.js → classifyDeliveryStatus).
// Duplica la función en vez de hacer require("./index.js") porque ese archivo arranca el server
// Express + Redis como efecto secundario del import. Si cambia allí, actualizar aquí también.
//
// Caso real que lo motivó (B2K, 24-jul-2026 01:51 UTC): 13 plantillas `intro_form` enviadas,
// 11 rebotadas con 131042 ("payment has been restricted") y 2 con 131026. La API devolvió 200
// en las 13 → el panel las dio por enviadas y marcó los leads como contactados.
import assert from "node:assert";

const ACCOUNT_BLOCK_CODES = new Set([131042, 131031]);

function classifyDeliveryStatus(st) {
  if (!st) return { action: "ignore" };
  if (st.status === "delivered" || st.status === "read") return { action: "clear" };
  if (st.status !== "failed") return { action: "ignore" };
  const err = (st.errors && st.errors[0]) || {};
  const code = Number(err.code);
  return {
    action: "fail",
    code: Number.isFinite(code) ? code : null,
    detail: err.error_data?.details || err.message || err.title || "",
    accountBlock: ACCOUNT_BLOCK_CODES.has(code),
  };
}

// Payload literal del webhook que rebotó a 61407012157 el 24-jul.
const BILLING = {
  id: "wamid.HBgLNjE0MDcwMTIxNTcVAgARGBJDNjY1QjM2N0UyMDQ3REE0OTIA",
  status: "failed",
  recipient_id: "61407012157",
  errors: [{ code: 131042, title: "Business eligibility payment issue", error_data: { details: "Message failed to send because your WhatsApp Business account payment has been restricted." } }],
};

const c1 = classifyDeliveryStatus(BILLING);
assert.equal(c1.action, "fail");
assert.equal(c1.code, 131042);
assert.equal(c1.accountBlock, true, "131042 es fallo de CUENTA: tiene que levantar la bandera");
assert.match(c1.detail, /payment has been restricted/);

// 131026 = ese número no tiene WhatsApp. Es del mensaje, no de la cuenta: se anota y ya.
const c2 = classifyDeliveryStatus({ status: "failed", recipient_id: "15306732323", errors: [{ code: 131026, title: "Message Undeliverable" }] });
assert.equal(c2.action, "fail");
assert.equal(c2.accountBlock, false, "131026 NO puede bloquear la cuenta entera");
assert.equal(c2.detail, "Message Undeliverable", "sin error_data cae a title");

// Cuenta suspendida: mismo tratamiento que el billing.
assert.equal(classifyDeliveryStatus({ status: "failed", errors: [{ code: 131031, message: "account has been locked" }] }).accountBlock, true);

// Una entrega real prueba que la cuenta volvió → limpia la bandera.
assert.equal(classifyDeliveryStatus({ status: "delivered", recipient_id: "34600111222" }).action, "clear");
assert.equal(classifyDeliveryStatus({ status: "read", recipient_id: "34600111222" }).action, "clear");

// "sent" solo dice que la API lo aceptó — que es exactamente la mentira que causó el problema.
assert.equal(classifyDeliveryStatus({ status: "sent" }).action, "ignore");
assert.equal(classifyDeliveryStatus(null).action, "ignore");

// Fallo sin código: se registra, pero no bloquea nada a ciegas.
const c3 = classifyDeliveryStatus({ status: "failed", errors: [] });
assert.equal(c3.code, null);
assert.equal(c3.accountBlock, false);

console.log("OK — test-wa-blocked: 131042/131031 bloquean, 131026 no, delivered/read desbloquean");
