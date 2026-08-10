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

// El botón NO puede quedar habilitado sin aceptar las implicaciones. El fallo que vigila esto es
// un `btn.disabled = false` suelto reaparecido en fbAsyncInit: dejaría conectar sin leer nada, y
// nadie lo notaría porque el flujo funcionaría igual de bien.
assert.ok(!/btn\.disabled\s*=\s*false/.test(html),
  "el botón no puede habilitarse a pelo: tiene que pasar por refreshButton()");
assert.ok(/sdkReady\s*&&|if\s*\(!sdkReady\)/.test(html), "el gate mira también a que el SDK esté listo");
assert.ok(html.includes("accepted_at: acceptedAt"), "el sello de aceptación viaja al servidor");

// Las casillas se cuentan del DOM. Si alguien añade una al HTML y el gate no la ve, el cliente
// acepta menos de lo que cree haber aceptado.
const checkboxes = (html.match(/type="checkbox" data-accept/g) || []).length;
assert.ok(checkboxes >= 7, `esperadas >=7 casillas de aceptación, hay ${checkboxes}`);
assert.ok(html.includes('querySelectorAll("#accept input[data-accept]")'),
  "el gate cuenta las casillas del DOM, no de una lista a mano");

// Y el servidor no se fía del front: sin accepted_at válido, no hay canje.
const server = fs.readFileSync("index.js", "utf8");
assert.ok(/accepted_at/.test(server) && /Date\.parse\(acceptedAt\)/.test(server),
  "el exchange exige accepted_at válido: sin esto el gate se salta con un POST a mano");

// El sync hay que ARRANCARLO en el canje. Si esto desaparece, el cliente escanea, todo parece ir
// bien, y Meta le tira el onboarding a las 24h — el fallo más caro posible, porque se manifiesta
// un día tarde y obliga a repetirle el proceso entero.
assert.ok(server.includes("smb_app_data"), "falta arrancar el sync: Meta invalida el onboarding a las 24h");
["smb_app_state_sync", "history"].forEach(function (t) {
  assert.ok(new RegExp('"' + t + '"').test(server), `falta el sync_type ${t}`);
});
assert.ok(/sync_ok/.test(server), "el canje debe informar de si el sync salió bien, para reintentar dentro de la ventana");

// 10-ago-2026: se probó a mandar redirect_uri en el canje (subcode 36008 apuntaba ahí) y Meta lo
// rechazó igual — el valor no coincidía con lo que usa internamente el popup de FB.login(). Revertido:
// la doc oficial de Business Integration System User Access Token no lo lleva, solo client_id/secret/code.
assert.ok(!/oauth\/access_token[\s\S]{0,200}redirect_uri/.test(server),
  "el canje NO debe mandar redirect_uri (probado y descartado 10-ago, ver memoria del proyecto)");

console.log("OK — waba_id a prueba de postMessage perdido, página sin placeholders, y el connect "
  + `cerrado tras ${checkboxes} aceptaciones (front y servidor)`);
