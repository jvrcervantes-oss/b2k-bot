// Self-check de la lógica de decisión de vigilanteTick (qué lead se salta, cuándo avisa,
// cuándo NO repite el aviso). Copia literal de la lógica del tick — si cambia allá, cambia
// aquí y falla el test.
//   node test-vigilante-tick.js
import assert from "assert";

const VIGILANTE_ALERT_ACTIONS = new Set(["escalate_human", "send_quote", "confirm_date"]);
const VIGILANTE_WINDOW_H = 48;
const FOLLOWUP_SKIP_STATUS = new Set(["won", "lost", "noshow"]);

function isOwner(phone) { return phone === "OWNER"; }

// Replica la decisión de una vuelta del bucle: null = no avisa, string = motivo del aviso.
function decidir(l, now, resumen) {
  if (isOwner(l.phone)) return null;
  if (l.archived || l.paused) return null;
  if (FOLLOWUP_SKIP_STATUS.has(l.status)) return null;
  if (!l.lastInboundAt || (now - l.lastInboundAt) / 3600000 > VIGILANTE_WINDOW_H) return null;
  if (resumen.error || !VIGILANTE_ALERT_ACTIONS.has(resumen.nextAction)) return null;
  if (l.vigilanteAlertedCount === resumen.msgCount) return null;
  return resumen.nextAction;
}

const NOW = Date.parse("2026-08-24T12:00:00Z");
const H = 3600000;

// 1. Lead activo con nextAction accionable → avisa.
assert.equal(decidir({ phone: "1", lastInboundAt: NOW - 2 * H }, NOW, { nextAction: "escalate_human", msgCount: 5 }), "escalate_human");

// 2. Mismo lead, mismo msgCount que la última vez que avisó → NO repite.
assert.equal(decidir({ phone: "1", lastInboundAt: NOW - 2 * H, vigilanteAlertedCount: 5 }, NOW, { nextAction: "escalate_human", msgCount: 5 }), null);

// 3. Llegó un mensaje nuevo tras el aviso (msgCount subió) → vuelve a avisar.
assert.equal(decidir({ phone: "1", lastInboundAt: NOW - 1 * H, vigilanteAlertedCount: 5 }, NOW, { nextAction: "escalate_human", msgCount: 7 }), "escalate_human");

// 4. nextAction "none"/"wait_customer"/"follow_up" → nunca avisa (follow_up ya lo cubre followupTick).
["none", "wait_customer", "follow_up"].forEach(a => {
  assert.equal(decidir({ phone: "1", lastInboundAt: NOW - 1 * H }, NOW, { nextAction: a, msgCount: 3 }), null);
});

// 5. Lead frío (fuera de la ventana de 48h) → no se revisa aunque el resumen diga escalate_human.
assert.equal(decidir({ phone: "1", lastInboundAt: NOW - 49 * H }, NOW, { nextAction: "escalate_human", msgCount: 3 }), null);

// 6. Cerrado (won/lost/noshow) o pausado o archivado → nunca avisa.
assert.equal(decidir({ phone: "1", lastInboundAt: NOW - H, status: "won" }, NOW, { nextAction: "escalate_human", msgCount: 3 }), null);
assert.equal(decidir({ phone: "1", lastInboundAt: NOW - H, paused: true }, NOW, { nextAction: "send_quote", msgCount: 3 }), null);
assert.equal(decidir({ phone: "1", lastInboundAt: NOW - H, archived: true }, NOW, { nextAction: "confirm_date", msgCount: 3 }), null);

// 7. El número del owner nunca se revisa aunque tenga actividad reciente.
assert.equal(decidir({ phone: "OWNER", lastInboundAt: NOW - H }, NOW, { nextAction: "escalate_human", msgCount: 3 }), null);

// 8. Error del extractor (Claude falló) → no avisa con datos a medias.
assert.equal(decidir({ phone: "1", lastInboundAt: NOW - H }, NOW, { error: "fallo extracción" }), null);

console.log("OK — decisión del vigilante: 8 casos");
