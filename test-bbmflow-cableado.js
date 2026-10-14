// Comprobación ESTÁTICA del cableado de bbmflow.js en index.js (F8 pieza 7). index.js no se puede importar en un test (arranca Express + Redis), así que se
// comprueba el texto: lo que garantiza que con el interruptor en `dion` (el ERP dice dion, sin ERP configurado o con BBM_FRENO_DION=1) el bot hace
// exactamente lo de antes, y que el modo erp no se cuela por otro sitio.
// Ejecutar: node test-bbmflow-cableado.js
import assert from "node:assert";
import fs from "node:fs";

const src = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");
const sinComentarios = (t) => t.replace(/\/\/.*$/gm, "");
let n = 0;
const ok = (m) => { n++; console.log("ok -", m); };
const trozo = (ini, fin) => { const i = src.indexOf(ini); assert.ok(i >= 0, `no está: ${ini.slice(0, 50)}`); const j = src.indexOf(fin, i + ini.length); assert.ok(j > i, `no está el final: ${fin.slice(0, 50)}`); return src.slice(i, j); };

// 1) un solo sitio decide el backend de un turno, y sin ERP configurado ni lee nada
{
  const f = sinComentarios(trozo("async function bbmBackendTurno(tel) {", "\n}\n"));
  assert.ok(/if \(BOT_VERTICAL !== "rental" \|\| !bbmErp\.enabled\) return "dion";/.test(f), "sin ERP configurado (o en tour): dion sin consultar nada");
  assert.ok(/catch \{ return "dion"; \}/.test(f), "si falla la lectura: dion");
  const llamadas = sinComentarios(src).match(/bbmBackendSw\.bbmBackend\(/g) || [];
  assert.equal(llamadas.length, 1, "bbmBackend se lee en UN solo sitio (bbmBackendTurno)");
  const usos = sinComentarios(src).match(/bbmBackendTurno\(/g) || [];
  assert.equal(usos.length, 2, "bbmBackendTurno: su definición y UNA llamada por mensaje");
  ok("el backend del turno se decide en un único sitio y, sin ERP configurado, es dion sin leer nada");
}
// 2) el valor del turno llega a la herramienta, al prompt y a [PAY]
{
  assert.ok(/const backendTurno = await bbmBackendTurno\(from\);/.test(src));
  assert.ok(/system: await buildSystemBlocks\(mediaLib, from, backendTurno\)/.test(src));
  assert.ok(/\}, \{ backend: backendTurno, tel: from \}\);/.test(src), "claudeConverse recibe el backend del turno");
  assert.ok(/payMatch && BOT_VERTICAL === "rental" && backendTurno === "erp"/.test(src), "[PAY] usa el MISMO valor");
  ok("herramienta, prompt y [PAY] usan el backend leído una vez al empezar el mensaje");
}
// 3) el camino de Dion queda como estaba
{
  assert.ok(/if \(!erpMode && !quoteToolEnabled\(\)\) return claudeMessage\(params\);/.test(src), "sin tool de Dion y sin erp: una sola llamada, igual que antes");
  assert.ok(/out = await runGetQuote\(tu\.input \|\| \{\}\);/.test(src), "la tool de Dion sigue llamando a runGetQuote");
  const bsb = trozo("async function buildSystemBlocks(mediaLib, phone, backend = \"dion\") {", "const live = [");
  assert.equal((bsb.match(/backend === "erp"/g) || []).length, 1, "buildSystemBlocks solo se desvía con backend === erp");
  assert.ok(/const live = \[mediaHint, await buildStockHint\(\), priceHint, noPrices, gatewayHint, await buildDeliveryHint\(\), await buildOfferHint\(\)\];/.test(src), "los bloques de Dion no cambian");
  assert.equal((src.match(/\} else if \(payMatch && BOT_VERTICAL === "rental"\) \{/g) || []).length, 1, "la rama [PAY] de Dion existe, una vez");
  assert.ok(src.indexOf('payMatch && BOT_VERTICAL === "rental" && backendTurno === "erp"') < src.indexOf('} else if (payMatch && BOT_VERTICAL === "rental") {'), "la rama erp va ANTES que la de Dion");
  assert.ok(src.includes("const link = await createRentalPayLink(payAmount, from);"), "Dion sigue creando el enlace con createRentalPayLink");
  ok("camino de Dion: misma tool, mismos bloques de prompt, misma rama [PAY]");
}
// 4) la rama erp no toca nada de Dion ni deja pasar el importe del modelo
{
  const rama = trozo('payMatch && BOT_VERTICAL === "rental" && backendTurno === "erp"', '} else if (payMatch && BOT_VERTICAL === "rental") {');
  const c = sinComentarios(rama);
  assert.ok(!/createRentalPayLink|pushInquiryToERP|setPendingPay|getPendingPay|cancelPaymentLink|createXenditInvoice/.test(c), "la rama erp no usa nada del flujo de pago de Dion");
  assert.ok(/cierreErp\.cierra\(/.test(c) && /payAmount/.test(c), "el importe del modelo solo se pasa para compararlo");
  assert.ok(/else reply = reply \+ "\\n\\n" \+ cierre\.texto;/.test(c), "si falla, el texto de reserva se añade siempre (nunca un «aquí tienes tu enlace» sin enlace)");
  ok("la rama [PAY] de erp: no usa el flujo de pago de Dion; si falla, añade el texto de reserva");
}
// 5) el enlace de pago del erp lo crea el ERP (F3 Entrega 2, camino B, 12-oct-2026): el modo erp no puede crear facturas con la clave de Railway
{
  assert.ok(!/crearFacturaRsv|crearFactura:/.test(sinComentarios(src)), "el modo erp ya no tiene una función que cree facturas de Xendit");
  const c = sinComentarios(trozo("const cierreErp = createCierreErp({", "});"));
  assert.ok(!/XENDIT|axios|xendit/i.test(c), "el cierre del erp no recibe nada de Xendit");
  assert.ok(/derivaPersona: derivaPersonaBbm/.test(c), "lo que promete «el equipo te escribe» deja la petición de persona en la ficha");
  assert.ok(/derivaPersona: derivaPersonaBbm/.test(sinComentarios(trozo("const bbmErpTools = createErpTools(", "\n"))), "también la herramienta (sin configurar)");
  const d = sinComentarios(trozo("async function derivaPersonaBbm(", "\n}\n"));
  assert.ok(/pidePersona: Date\.now\(\), intent: "human"/.test(d) && /setWaiting\(tel, true\)/.test(d), "derivar = la misma petición de persona de BBM-50");
  assert.ok(/if \(lead && lead\.pidePersona\) return false;/.test(d), "una petición ya abierta no se vuelve a avisar");
  assert.ok(/notifyTelegram\(/.test(d) && /escPush\(tel, nombre, que\)/.test(d) && /escmap:\$\{rNotif\.id\}/.test(d) && /return true;/.test(d), "avisa como BBM-50: Telegram + WhatsApp al owner con enrutado por cita (revisor 12-oct)");
  ok("el enlace del erp lo crea el ERP; el cierre no toca Xendit; derivar a una persona usa pidePersona (BBM-50)");
}
// 6) interruptores
{
  assert.ok(/enviaClave: process\.env\.BBM_ERP_CLAVE === "1"/.test(src), "la clave de idempotencia va atada a una variable (edge vieja = campo_no_admitido)");
  assert.ok(!/enviaClave:\s*true/.test(src));
  assert.ok(/const bbmSombra = process\.env\.BBM_SOMBRA === "1" && bbmErp\.enabled \? createSombra/.test(src), "la sombra es opt-in y exige ERP configurado");
  assert.ok(/enlaceVivo: async \(tel\) => !!\(await bbmPendingRsv\.lee\(tel\)\)/.test(src), "un enlace rsv vivo ata la conversación a erp");
  ok("clave de idempotencia y sombra: detrás de variables; el enlace vivo ata la conversación");
}
// 7) la sombra no espera y la cotización de Dion fija el backend
{
  const f = sinComentarios(trozo("function bbmDionCotizo(tel, out) {", "\n}\n"));
  assert.ok(/if \(!bbmErp\.enabled \|\| !out \|\| out\.ok !== true\) return;/.test(f), "sin ERP configurado no hace nada");
  assert.ok(/bbmSombra\.observa\(out\)\.catch/.test(f) && !/await/.test(f), "la sombra se lanza sin esperar");
  ok("sombra: sin ERP no hace nada; nunca se espera en el camino del cliente");
}
// 8) el aviso de pago cuelga de la puerta y se deduplica por factura
{
  assert.ok(/onResultado: avisoPagoRsv/.test(src));
  assert.ok(/ipDe: \(req\) => ipCliente\(req\)\.ip/.test(src), "el límite por IP de los avisos rsv: usa la IP del cliente tras el proxy (penúltimo salto)");
  assert.ok(/dedupe: async \(invoiceId\) => !\(await alreadyProcessedPayment\(`xendit-rsv:\$\{invoiceId\}`\)\)/.test(src));
  const m = trozo("async function marcaLeadPagadoErp(", "\n}\n");
  assert.ok(!/sendWhatsApp|notifyTelegram|Falta crear la reserva/.test(m), "marcar ganado no manda los avisos del flujo viejo");
  ok("aviso de pago: colgado de la puerta del webhook, deduplicado por factura, sin los avisos del flujo viejo");
}
// 9) salud
assert.ok(/if \(bbmSombra\) \{ try \{ bbm\.sombra = await bbmSombra\.estado\(\)/.test(src));
ok("/admin/api/health enseña el avance de la sombra");
// 10) B10 (14-oct-2026): el interruptor vive en el ERP; BBM_BACKEND y `bbm:backend` ya no mandan
{
  const sc = sinComentarios(src);
  const lib = sinComentarios(fs.readFileSync(new URL("./bbmerp.js", import.meta.url), "utf8"));
  const sw = sinComentarios(trozo("const bbmBackendSw = createBackendSwitch({", "});"));
  assert.ok(/erp: \(\) => \(BOT_VERTICAL === "rental" \? bbmErp : null\)/.test(sw), "el interruptor lee el ERP solo en rental, por un cierre perezoso");
  assert.ok(/freno: process\.env\.BBM_FRENO_DION/.test(sw), "el freno de emergencia es BBM_FRENO_DION");
  assert.ok(/bbmBackendObsoleta: process\.env\.BBM_BACKEND/.test(sw), "BBM_BACKEND solo llega para avisar de que está obsoleta");
  assert.ok(!/envValue/.test(sc) && !/envValue/.test(lib), "BBM_BACKEND ya no es un valor por defecto");
  assert.ok(!/\.get\("bbm:backend"\)/.test(sc) && !/\.get\("bbm:backend"\)/.test(lib), "nadie LEE el valor de bbm:backend (solo exists, para el health)");
  assert.ok(/\.exists\("bbm:backend"\)/.test(lib));
  const iErp = src.indexOf("const bbmErp = createBbmErp("), iPend = src.indexOf("const bbmPendingRsv = createPendingRsv("), iSw = src.indexOf("const bbmBackendSw = createBackendSwitch(");
  const iArr = src.indexOf("if (BOT_VERTICAL === \"rental\" && bbmErp.enabled) bbmBackendSw.arranca().catch(() => {});");
  assert.ok(iErp > 0 && iPend > iErp && iSw > iPend && iArr > iSw, "orden de declaración: bbmErp y bbmPendingRsv antes del interruptor, y la lectura de arranque después");
  assert.equal((sc.match(/bbmBackendSw\.arranca\(/g) || []).length, 1, "una sola lectura de arranque, detrás de rental + ERP configurado");
  const h = sinComentarios(trozo('app.get("/admin/api/health"', "\n});\n"));
  assert.ok(/bbmSalud = await bbmBackendSw\.salud\(\)/.test(h) && /const bbm = \{ \.\.\.bbmSalud,/.test(h), "el health usa salud() (misma caché de 30 s que el turno)");
  assert.ok(!/porDefecto/.test(sc), "index.js ya no lee porDefecto (el health va por salud(), el turno por bbmBackend)");
  ok("B10: interruptor del ERP con freno BBM_FRENO_DION; BBM_BACKEND y bbm:backend solo como obsoletas; orden de declaración; health por salud()");
}

console.log(`\n${n} comprobaciones OK`);
