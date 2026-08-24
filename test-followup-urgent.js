// Self-check de la eleccion de plantilla en followupTick (generica vs urgente por intent).
// Copia literal de la logica de decision del tick. Si cambia alla, cambia aqui y falla el test.
//   node test-followup-urgent.js
import assert from "assert";

const HOT_INTENTS = new Set(["interested", "booking"]);

function elegirPlantilla(lead, env) {
  const isHot = HOT_INTENTS.has(lead.intent) && env.URGENT_TEMPLATE_NAME;
  const tplName = isHot ? env.URGENT_TEMPLATE_NAME : env.FOLLOWUP_TEMPLATE_NAME;
  const tplLang = isHot ? (env.URGENT_TEMPLATE_LANG || env.FOLLOWUP_TEMPLATE_LANG) : env.FOLLOWUP_TEMPLATE_LANG;
  const nParams = isHot ? 2 : 1;
  return { tplName, tplLang, nParams };
}

const ENV_FULL = { FOLLOWUP_TEMPLATE_NAME: "followup_lead", FOLLOWUP_TEMPLATE_LANG: "en", URGENT_TEMPLATE_NAME: "followup_urgent", URGENT_TEMPLATE_LANG: "en" };

// 1. Lead caliente (interested) con la plantilla urgente configurada → la urgente, 2 params.
let r = elegirPlantilla({ intent: "interested" }, ENV_FULL);
assert.equal(r.tplName, "followup_urgent");
assert.equal(r.nParams, 2);

// 2. Lead a punto de reservar (booking) → tambien cuenta como caliente.
assert.equal(elegirPlantilla({ intent: "booking" }, ENV_FULL).tplName, "followup_urgent");

// 3. Lead solo explorando → la generica de siempre, 1 param.
r = elegirPlantilla({ intent: "exploring" }, ENV_FULL);
assert.equal(r.tplName, "followup_lead");
assert.equal(r.nParams, 1);

// 4. Sin intent (undefined) → tambien generica, nunca revienta.
assert.equal(elegirPlantilla({}, ENV_FULL).tplName, "followup_lead");

// 5. URGENT_TEMPLATE_NAME sin configurar (aun no aprobada en Meta) → cae a la generica
//    aunque el lead este caliente. Asi no rompe nada mientras Meta aprueba followup_urgent.
const ENV_SIN_URGENTE = { FOLLOWUP_TEMPLATE_NAME: "followup_lead", FOLLOWUP_TEMPLATE_LANG: "en" };
assert.equal(elegirPlantilla({ intent: "booking" }, ENV_SIN_URGENTE).tplName, "followup_lead");

// 6. URGENT_TEMPLATE_LANG vacio hereda el idioma del generico, nunca manda un idioma undefined.
const ENV_SIN_LANG = { ...ENV_FULL, URGENT_TEMPLATE_LANG: undefined };
assert.equal(elegirPlantilla({ intent: "interested" }, ENV_SIN_LANG).tplLang, "en");

console.log("OK — seleccion de plantilla followup urgente: 6 casos");
