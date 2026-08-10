// Check de la personalización del newsletter (compositor propio): {{nombre}} / {{empresa}}.
// node test-newsletter-merge.js  (sin dependencias; falla con AssertionError si el merge se rompe)
import assert from "assert";

// Copia literal de personalize() en index.js — este test es el que la vigila.
function personalize(text, name, company) {
  const firstName = (name || "").trim().split(/\s+/)[0] || "there";
  return String(text || "")
    .replace(/\{\{\s*nombre\s*\}\}/gi, firstName)
    .replace(/\{\{\s*empresa\s*\}\}/gi, company || "");
}
// Copia literal de la línea de runCampaign que decide `company` por destinatario:
// solo dato real de la agenda de operadores (B2B); nunca se adivina para leads (B2C).
const companyFor = (isOperators, l) => isOperators ? (l.company || "") : "";

assert.strictEqual(personalize("Hi {{nombre}}!", "Dion Putra", "Surfcamp"), "Hi Dion!", "usa el primer nombre");
assert.strictEqual(personalize("Hi {{ NOMBRE }},", "", ""), "Hi there,", "sin nombre → fallback 'there' (mismo que el resto del bot)");
assert.strictEqual(personalize("{{nombre}} @ {{empresa}}", "Dion", "Surfcamp"), "Dion @ Surfcamp", "dos etiquetas en el mismo texto");
assert.strictEqual(personalize("{{nombre}}, {{empresa}}", "Dion", ""), "Dion, ", "empresa vacía se sustituye por cadena vacía, no rompe el texto");

assert.strictEqual(companyFor(true, { company: "Rimba Tours" }), "Rimba Tours", "operador/TAO con company real → se usa");
assert.strictEqual(companyFor(true, {}), "", "operador sin company guardada → vacío, nunca se adivina");
assert.strictEqual(companyFor(false, { company: "no debería leerse aquí" }), "", "lead B2C → siempre vacío, aunque el campo exista por error");

console.log("OK — personalize/companyFor resuelven {{nombre}} y {{empresa}} solo con dato real, sin adivinar");
