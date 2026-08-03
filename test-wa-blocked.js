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

// ── ¿Deshace el rebote la marca de "ya contactado"? (index.js → isOutreachBounce) ──
// El 31-jul quedó abierto esto: `outreached` se pone en cuanto la API dice 200, y un rebote
// por destinatario (131049 "healthy ecosystem engagement", 130472 "experimento de usuario")
// dejaba al lead como hablado sin que le hubiera llegado nada. 6 de cada 10 outreach.
function isOutreachBounce(st, lead) {
  const wamid = lead && lead.outreachWamid;
  return !!(lead && lead.outreached && wamid && st && st.id && st.id === wamid);
}

const WAMID_INTRO = "wamid.HBgLNDQ3ODUyMTQ4OTQyFQIAERgSNzcyMkE1RkE0RTdBQjAA";
const LEAD = { phone: "447852148942", outreached: true, outreachWamid: WAMID_INTRO };

assert.equal(isOutreachBounce({ id: WAMID_INTRO, status: "failed" }, LEAD), true, "el rebote del propio intro sí desmarca");
assert.equal(isOutreachBounce({ id: "wamid.OTRO", status: "failed" }, LEAD), false, "un recordatorio que rebota no borra que el intro llegó");
assert.equal(isOutreachBounce({ status: "failed" }, LEAD), false, "sin wamid no se adivina");
assert.equal(isOutreachBounce({ id: WAMID_INTRO }, { ...LEAD, outreachWamid: "" }), false, "lead de antes de guardar el wamid: no se toca");
assert.equal(isOutreachBounce({ id: WAMID_INTRO }, { ...LEAD, outreached: false }), false, "ya desmarcado: idempotente");
assert.equal(isOutreachBounce({ id: WAMID_INTRO }, null), false, "un fallo a un desconocido no crea nada");

// ── ¿A qué ficha se apunta el rebote? (index.js → findLeadLoose) ──
// Producción, 3-ago-2026: `Plantilla "intro_form" enviada a 4254329068` y acto seguido
// `ENTREGA FALLIDA a 14254329068`. Meta devuelve el recipient_id CON prefijo de país aunque el
// mensaje se enviara sin él, así que el match exacto falla justo en los leads peor grabados y el
// rebote no se apunta en ninguna ficha. Mismo criterio que el import de Meta: últimos 8 dígitos
// y solo si hay UN candidato — fusionar dos personas es peor que no encontrar ninguna.
function findLeadLoose(raw, all) {
  const clean = String(raw || "").replace(/\D/g, "");
  if (!clean) return null;
  const exact = all.find((l) => l.phone === clean);
  if (exact) return exact;
  const tail = clean.slice(-8);
  if (tail.length < 8) return null;
  const cand = all.filter((l) => String(l.phone || "").endsWith(tail));
  return cand.length === 1 ? cand[0] : null;
}

const BD = [{ phone: "4254329068" }, { phone: "19198305157" }, { phone: "34600111222" }];
assert.equal(findLeadLoose("14254329068", BD).phone, "4254329068", "el caso real: rebote con prefijo, lead sin él");
assert.equal(findLeadLoose("19198305157", BD).phone, "19198305157", "el match exacto sigue mandando");
assert.equal(findLeadLoose("+34 600 111 222", BD).phone, "34600111222", "el formato con espacios y + no importa");
assert.equal(findLeadLoose("15551234567", BD), null, "un desconocido no se pega al primero que se parezca");
assert.equal(findLeadLoose("", BD), null);
assert.equal(findLeadLoose("4329068", BD), null, "menos de 8 dígitos no basta para decidir");
// Guarda de unicidad: DOS leads acaban en los mismos 8 dígitos ("38309862") y ninguno es
// match exacto → no se elige ninguno. (Comprobado que los dos son candidatos de verdad; si no,
// el assert pasaría por no encontrar a nadie, que es otro caso.)
const AMBIGUOS = [{ phone: "138309862" }, { phone: "9938309862" }];
assert.equal(AMBIGUOS.filter((l) => l.phone.endsWith("38309862")).length, 2, "el propio caso de prueba tiene que ser ambiguo");
assert.equal(findLeadLoose("5538309862", AMBIGUOS), null, "con dos candidatos no se adivina: apuntar el rebote en la ficha equivocada es peor");

console.log("OK — test-wa-blocked: 131042/131031 bloquean, 131026 no, delivered/read desbloquean, el rebote del intro desmarca `outreached` y cae en la ficha correcta");
