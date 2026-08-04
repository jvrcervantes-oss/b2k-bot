// Check del Embedded Signup (Coexistence). Dos cosas que solo fallarían delante del cliente,
// con 24h de reloj corriendo: perder el waba_id, y servir la página con un placeholder sin
// sustituir (el flujo no abriría y no hay forma de saberlo hasta que alguien pulsa el botón).
// node test-onboarding.js
import assert from "assert";
import fs from "fs";

// Copia literal de wabaIdFromDebug() en index.js — este test es el que la vigila.
function wabaIdFromDebug(debugData) {
  const scopes = debugData?.data?.granular_scopes || [];
  const s = scopes.find((x) => x.scope === "whatsapp_business_management")
         || scopes.find((x) => x.scope === "whatsapp_business_messaging");
  return (s?.target_ids || [])[0] || "";
}

const dbg = (scopes) => ({ data: { granular_scopes: scopes } });

assert.strictEqual(
  wabaIdFromDebug(dbg([{ scope: "whatsapp_business_management", target_ids: ["1111"] }])),
  "1111", "management → su target_id");

assert.strictEqual(
  wabaIdFromDebug(dbg([
    { scope: "public_profile" },
    { scope: "whatsapp_business_messaging", target_ids: ["2222"] },
    { scope: "whatsapp_business_management", target_ids: ["1111"] },
  ])),
  "1111", "management manda aunque messaging aparezca antes");

assert.strictEqual(
  wabaIdFromDebug(dbg([{ scope: "whatsapp_business_messaging", target_ids: ["2222"] }])),
  "2222", "sin management, vale messaging");

assert.strictEqual(
  wabaIdFromDebug(dbg([{ scope: "whatsapp_business_management" }])),
  "", "scope sin target_ids → cadena vacía, no crash (dispara el 502 con mensaje)");

assert.strictEqual(wabaIdFromDebug({}), "", "respuesta vacía de Meta → cadena vacía");
assert.strictEqual(wabaIdFromDebug(undefined), "", "sin respuesta → cadena vacía");

// La página servida no puede llevar ningún __PLACEHOLDER__ sin sustituir.
const html = fs.readFileSync("onboarding.html", "utf8");
const served = html
  .replace(/__APP_ID__/g, "123")
  .replace(/__CONFIG_ID__/g, "456")
  .replace(/__GRAPH__/g, "v25.0")
  .replace(/__PROJECT__/g, "BaliBest");
const left = served.match(/__[A-Z_]+__/g);
assert.strictEqual(left, null, `placeholders sin sustituir en onboarding.html: ${left}`);

// Los tres parámetros que Meta exige para Coexistence: si alguno se cae, el flujo abre el
// onboarding normal (número nuevo) en vez del de la app — y eso saca el número del móvil de Dion.
assert.ok(html.includes('featureType: "whatsapp_business_app_onboarding"'), "featureType de Coexistence");
assert.ok(html.includes('sessionInfoVersion: "3"'), "session logging");
assert.ok(html.includes("override_default_response_type: true"), "response_type code");

console.log("OK — waba_id a prueba de postMessage perdido, y la página sale sin placeholders");
