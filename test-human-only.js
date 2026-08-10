// ponytail: self-check del guardrail HUMAN_ONLY (index.js → gates de isPaused + notifyOwner).
// Duplica la regla en vez de require("./index.js") (arranca Express+Redis como efecto secundario).
// Si cambia la condición allí, actualizar aquí también.
//
// Motivo: HUMAN_ONLY reusa la puerta de pausa por-lead (ya probada en producción), pero esa puerta
// asume que un humano YA está mirando esa conversación porque la pausó él a mano. En HUMAN_ONLY
// nadie la está mirando todavía — así que hace falta avisar al owner, y SOLO en el primer mensaje
// de cada lead (si se avisara en cada mensaje, cada nuevo "hola" del mismo cliente repetiría el aviso).
import assert from "node:assert";

function shouldPause(humanOnlyMode, isPausedForLead) {
  return humanOnlyMode || isPausedForLead;
}
function shouldNotifyNewLead(humanOnlyMode, prevLeadExists) {
  return humanOnlyMode && !prevLeadExists;
}

// Modo normal (HUMAN_ONLY apagado): manda el estado por-lead de siempre, sin tocar comportamiento.
assert.equal(shouldPause(false, false), false, "lead normal, sin pausar → la IA responde igual que hoy");
assert.equal(shouldPause(false, true), true, "lead pausado a mano → sigue pausado igual que hoy");

// HUMAN_ONLY activo: pausa SIEMPRE, incluso el lead que nadie pausó a mano.
assert.equal(shouldPause(true, false), true, "HUMAN_ONLY fuerza la pausa aunque el lead no estuviera pausado");

// Aviso al owner: solo en el primer contacto de cada lead, nunca en HUMAN_ONLY apagado.
assert.equal(shouldNotifyNewLead(true, false), true, "lead NUEVO bajo HUMAN_ONLY → avisar al owner");
assert.equal(shouldNotifyNewLead(true, true), false, "lead YA conocido → no repetir el aviso en cada mensaje");
assert.equal(shouldNotifyNewLead(false, false), false, "HUMAN_ONLY apagado → nunca el aviso nuevo (el control humano normal no lo tenía)");

console.log("OK — test-human-only: HUMAN_ONLY pausa siempre y avisa una vez por lead nuevo, sin tocar el modo normal");
