// Self-check del umbral de pausa de adsGuardTick. Copia literal de la lógica de decisión —
// si cambia allá, cambia aquí y falla el test.
//   node test-ads-guard.js
import assert from "assert";

const ADS_MIN_SPEND_NO_RESULTS = 18;

function countAdLeadActions(actions) {
  if (!Array.isArray(actions)) return 0;
  return actions
    .filter((a) => /lead|messaging_conversation_started/i.test(a.action_type || ""))
    .reduce((sum, a) => sum + (parseInt(a.value, 10) || 0), 0);
}

function decidirPausa(insight) {
  const spend = parseFloat(insight?.spend || "0");
  if (spend < ADS_MIN_SPEND_NO_RESULTS) return false;
  return countAdLeadActions(insight?.actions) === 0;
}

// 1. Gasto por debajo del umbral, aunque tenga 0 leads → NO pausa (puede ser un anuncio nuevo).
assert.equal(decidirPausa({ spend: "10.50", actions: [] }), false);

// 2. Gasto justo en el umbral, 0 leads → pausa.
assert.equal(decidirPausa({ spend: "18.00", actions: [] }), true);

// 3. Gasto por encima, con al menos 1 lead (Lead Ads) → NO pausa, está funcionando.
assert.equal(decidirPausa({ spend: "40.00", actions: [{ action_type: "lead", value: "1" }] }), false);

// 4. Gasto por encima, con conversaciones de WhatsApp iniciadas (Click-to-WhatsApp) → cuenta como resultado.
assert.equal(decidirPausa({ spend: "40.00", actions: [{ action_type: "onsite_conversion.messaging_conversation_started_7d", value: "3" }] }), false);

// 5. Gasto por encima, solo acciones irrelevantes (ej. "link_click") → SÍ pausa, no hay leads de verdad.
assert.equal(decidirPausa({ spend: "40.00", actions: [{ action_type: "link_click", value: "50" }] }), true);

// 6. Sin insight todavía (anuncio recién creado, sin datos) → spend cae a 0, nunca pausa a ciegas.
assert.equal(decidirPausa(undefined), false);

console.log("OK — umbral del guardarraíl de ads: 6 casos");
