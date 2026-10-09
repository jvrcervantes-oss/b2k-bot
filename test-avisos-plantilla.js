// S13 (LAW-507): plantillas utility de cita, traspaso y alerta al equipo. Unitarias, con envíos y estado FALSOS (ni Meta ni Postgres ni Redis).
// El punto de entrada real (index.js + freno de testing) se prueba aparte en test-avisos-e2e.js.
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { creaAvisos, paramsCita, paramsTraspaso, paramsAlertaEquipo, fechaHoraBali, aplana, clientePidioPersona, textoAviso, idiomaAviso, normalizaHistorial, ENV_PLANTILLA, VENTANA_MS } from "./avisos-plantilla.js";

const AHORA = Date.parse("2026-10-09T10:00:00Z");
const CUANDO = "2026-10-10T15:00:00+08:00";           // en Bali: sábado 10 de octubre, 15:00
const user = (texto, ts = AHORA - 3600_000) => ({ rol: "user", texto, ts });
const montaje = (est = {}, extra = {}) => {
  const salidas = [];
  const a = creaAvisos({
    plantillas: { confirmada: "lawang_cita_confirmada", reprogramada: "lawang_cita_reprogramada", cancelada: "lawang_cita_cancelada", traspaso: "lawang_traspaso_persona" },
    estadoLead: async () => ({ baja: false, historial: [user("hello, I want to see the land please")], ultimoEntranteTs: AHORA - 3600_000, nombre: "Ana López", ...est }),
    isAllowed: () => true, ahora: () => AHORA,
    enviaLibre: async (tel, texto) => { salidas.push({ via: "libre", tel, texto }); return true; },
    enviaPlantilla: async (tel, nombre, idioma, params) => { salidas.push({ via: "plantilla", tel, nombre, idioma, params }); return { ok: true }; },
    ...extra,
  });
  return { a, salidas };
};
const CERRADA = { ultimoEntranteTs: AHORA - VENTANA_MS - 60_000 };

test("variables de cita en el orden {{1}} nombre · {{2}} tipo · {{3}} fecha y hora de Bali, por idioma", () => {
  assert.deepStrictEqual(paramsCita({ nombre: "Ana López", tipo: "llamada", cuando: CUANDO }, "en"), ["Ana", "call", "Saturday 10 October, 15:00"]);
  assert.deepStrictEqual(paramsCita({ nombre: "Ana López", tipo: "visita", cuando: CUANDO }, "es"), ["Ana", "visita", "sábado 10 de octubre, 15:00"]);
  assert.deepStrictEqual(paramsCita({ nombre: "", tipo: "visita", cuando: CUANDO }, "en"), ["there", "visit", "Saturday 10 October, 15:00"]);
  assert.strictEqual(paramsCita({ nombre: "A", tipo: "llamada", cuando: "no es fecha" }, "en"), null);
  assert.deepStrictEqual(paramsTraspaso({ nombre: "Ana López" }, "es"), ["Ana"]);
});

test("la hora es SIEMPRE la de Bali (WITA), venga la fecha en UTC, en otro huso o en milisegundos", () => {
  assert.strictEqual(fechaHoraBali("2026-10-10T07:00:00Z", "en"), "Saturday 10 October, 15:00");
  assert.strictEqual(fechaHoraBali("2026-10-10T17:00:00+10:00", "en"), "Saturday 10 October, 15:00");
  assert.strictEqual(fechaHoraBali(Date.parse("2026-10-10T07:00:00Z"), "en"), "Saturday 10 October, 15:00");
  assert.strictEqual(fechaHoraBali("2026-10-09T16:30:00Z", "en"), "Saturday 10 October, 00:30", "medianoche de Bali: 00:30, nunca 24:30");
});

test("idioma por lead: en/es por lo que escribió; el indonesio NO está activado (cae a en)", () => {
  assert.strictEqual(idiomaAviso([user("hola, quiero información del terreno por favor")]), "es");
  assert.strictEqual(idiomaAviso([user("hello, I want the price please")]), "en");
  assert.strictEqual(idiomaAviso([user("halo, saya mau tanah, berapa harga")]), "en");
  assert.strictEqual(idiomaAviso([]), "en");
  assert.deepStrictEqual(normalizaHistorial([{ role: "assistant", content: "x", ts: 1 }, { role: "user", content: "hola" }]).map((m) => m.rol), ["assistant", "user"], "el historial de Redis se normaliza");
});

for (const [evento, plantilla] of [["confirmada", "lawang_cita_confirmada"], ["reprogramada", "lawang_cita_reprogramada"], ["cancelada", "lawang_cita_cancelada"]]) {
  test(`${evento}: ventana CERRADA → plantilla ${plantilla} con las variables en orden y el idioma del lead`, async () => {
    const { a, salidas } = montaje({ ...CERRADA, historial: [user("hola, quiero una visita por favor", AHORA - 2 * VENTANA_MS), user("gracias, quiero información del terreno", AHORA - 2 * VENTANA_MS)] });
    const r = await a.enviaAviso({ evento, tel: "+62 812-0000-0001", tipo: "visita", cuando: CUANDO });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.via, "plantilla");
    assert.deepStrictEqual(salidas, [{ via: "plantilla", tel: "6281200000001", nombre: plantilla, idioma: "es", params: ["Ana", "visita", "sábado 10 de octubre, 15:00"] }]);
  });
  test(`${evento}: ventana ABIERTA → texto libre (nunca plantilla), con aviso de asistente y STOP`, async () => {
    const { a, salidas } = montaje();
    const r = await a.enviaAviso({ evento, tel: "628120000001", tipo: "llamada", cuando: CUANDO });
    assert.strictEqual(r.via, "libre");
    assert.strictEqual(salidas.length, 1);
    assert.strictEqual(salidas[0].via, "libre");
    assert.match(salidas[0].texto, /automated assistant \(AI\)/);
    assert.match(salidas[0].texto, /Reply STOP/);
    assert.match(salidas[0].texto, /Saturday 10 October, 15:00 \(Bali time\)/);
    assert.ok(/Hi Ana,/.test(salidas[0].texto), "solo el nombre de pila");
  });
}

test("el texto libre de la cancelación y del traspaso también va en español cuando el lead escribe en español", () => {
  assert.match(textoAviso("cancelada", { nombre: "Ana", tipo: "llamada", cuando: CUANDO }, "es"), /hora de Bali\).*queda cancelada.*Responde STOP/);
  assert.match(textoAviso("traspaso", { nombre: "Ana" }, "es"), /asistente automático \(IA\).*persona.*Responde STOP/);
  assert.strictEqual(textoAviso("confirmada", { nombre: "Ana", tipo: "llamada", cuando: "x" }, "en"), null);
});

test("traspaso: SOLO si el cliente lo pidió explícitamente (lo comprueba el servidor en su historial, no quien llama)", async () => {
  for (const frase of ["I want to speak with a real person please", "can I talk to someone from your team?", "quiero hablar con una persona", "necesito hablar con alguien del equipo", "bisa bicara dengan orang?"])
    assert.strictEqual(clientePidioPersona([user(frase)]), true, frase);
  for (const frase of ["hello, how much is the land?", "thanks, are you a bot?", "I will speak to my wife and come back to you", "hola, me interesa el terreno"])
    assert.strictEqual(clientePidioPersona([user(frase)]), false, frase);
  assert.strictEqual(clientePidioPersona([{ rol: "assistant", texto: "Would you like to speak with a person?" }]), false, "lo que dice el bot no cuenta");
  // sin petición: ni plantilla ni texto, aunque la ventana esté cerrada
  const sin = montaje({ ...CERRADA, historial: [user("hello, how much is a plot?")] });
  assert.deepStrictEqual(await sin.a.enviaAviso({ evento: "traspaso", tel: "628120000001" }), { ok: false, motivo: "no_pidio_persona" });
  assert.strictEqual(sin.salidas.length, 0);
  // con petición y ventana cerrada → lawang_traspaso_persona con UNA variable
  const con = montaje({ ...CERRADA, historial: [user("I want to talk to a person")] });
  const r = await con.a.enviaAviso({ evento: "traspaso", tel: "628120000001" });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(con.salidas, [{ via: "plantilla", tel: "628120000001", nombre: "lawang_traspaso_persona", idioma: "en", params: ["Ana"] }]);
});

test("lawang_alerta_equipo: {{1}} contacto · {{2}} último mensaje, SIN saltos de línea ni tabuladores", () => {
  const sucio = "Hola\r\nquiero\tver   el terreno\n\n\ny    precio" + String.fromCharCode(0x2028) + "ok" + String.fromCharCode(7);
  const p = paramsAlertaEquipo({ nombre: "Ana\nLópez", telefono: "+62 812-0000-0001", ultimoMensaje: sucio });
  assert.strictEqual(p.length, 2);
  assert.strictEqual(p[0], "Ana López (+6281200000001)");
  for (const v of p) {
    assert.ok(!/[\n\r\t]/.test(v), JSON.stringify(v));
    assert.ok(!/ {2,}/.test(v));
    assert.ok(!/[\u0000-\u001f\u007f]/.test(v));
    assert.ok(!v.includes(String.fromCharCode(0x2028)));
  }
  assert.strictEqual(p[1], "Hola quiero ver el terreno y precio ok");
  assert.deepStrictEqual(paramsAlertaEquipo({ telefono: "628120000001", ultimoMensaje: "" }), ["+628120000001", "-"], "Meta rechaza un parámetro vacío");
  assert.ok(aplana("x".repeat(900)).length <= 300);
});

test("sin plantilla configurada y ventana cerrada no sale NADA; con la ventana abierta sale el texto libre aunque no haya plantillas", async () => {
  const cerrada = montaje(CERRADA, { plantillas: {} });
  assert.deepStrictEqual(await cerrada.a.enviaAviso({ evento: "confirmada", tel: "628120000001", cuando: CUANDO }), { ok: false, motivo: "sin_plantilla" });
  assert.strictEqual(cerrada.salidas.length, 0);
  const abierta = montaje({}, { plantillas: {} });
  assert.strictEqual((await abierta.a.enviaAviso({ evento: "confirmada", tel: "628120000001", cuando: CUANDO })).via, "libre");
});

test("freno de testing, baja y estado caído: no sale nada y ni se consulta lo que no hace falta", async () => {
  let consultas = 0;
  const frenado = montaje({}, { isAllowed: () => false, estadoLead: async () => { consultas++; return {}; } });
  assert.deepStrictEqual(await frenado.a.enviaAviso({ evento: "confirmada", tel: "628120000001", cuando: CUANDO }), { ok: false, motivo: "frenado_testing" });
  assert.strictEqual(frenado.salidas.length, 0);
  assert.strictEqual(consultas, 0, "ni se consulta a quien no está autorizado");
  const baja = montaje({ baja: true, ...CERRADA });
  assert.strictEqual((await baja.a.enviaAviso({ evento: "cancelada", tel: "628120000001", cuando: CUANDO })).motivo, "baja");
  assert.strictEqual(baja.salidas.length, 0);
  const caido = montaje({}, { estadoLead: async () => ({ error: "edge_caida" }) });
  assert.strictEqual((await caido.a.enviaAviso({ evento: "cancelada", tel: "628120000001", cuando: CUANDO })).motivo, "estado_no_disponible");
  assert.strictEqual(caido.salidas.length, 0);
});

test("validación: evento, teléfono y fecha; un reintento del llamador no duplica el mensaje", async () => {
  const { a, salidas } = montaje();
  assert.strictEqual((await a.enviaAviso({ evento: "recordatorio", tel: "628120000001" })).motivo, "evento_invalido", "el recordatorio es S6, no esta ruta");
  assert.strictEqual((await a.enviaAviso({ evento: "confirmada", tel: "12", cuando: CUANDO })).motivo, "telefono_invalido");
  assert.strictEqual((await a.enviaAviso({ evento: "confirmada", tel: "628120000001", cuando: "mañana" })).motivo, "fecha_invalida");
  assert.strictEqual((await a.enviaAviso({ evento: "confirmada", tel: "628120000001", cuando: CUANDO })).ok, true);
  assert.strictEqual((await a.enviaAviso({ evento: "confirmada", tel: "628120000001", cuando: CUANDO })).motivo, "duplicado");
  assert.strictEqual((await a.enviaAviso({ evento: "reprogramada", tel: "628120000001", cuando: "2026-10-11T10:00:00+08:00" })).ok, true, "otro evento o otra hora sí");
  assert.strictEqual(salidas.length, 2);
});

test("la autorización de envío de Postgres se concede antes y se revoca siempre, aunque el envío falle", async () => {
  const log = [];
  const { a } = montaje({}, { concede: () => { log.push("concede"); return 7; }, revoca: (t, k) => log.push("revoca" + k), enviaLibre: async () => { throw new Error("boom"); } });
  await assert.rejects(a.enviaAviso({ evento: "confirmada", tel: "628120000001", cuando: CUANDO }), /boom/);
  assert.deepStrictEqual(log, ["concede", "revoca7"]);
});

test("variables de entorno PROPIAS: ninguna reutiliza las del recordatorio (S6) ni las del reenganche (S12), y la alerta vieja ya no se lee", () => {
  const nombres = Object.values(ENV_PLANTILLA);
  assert.strictEqual(new Set(nombres).size, nombres.length);
  for (const n of nombres) assert.ok(!/^(REMINDER|FOLLOWUP|INTRO|ALERT)_/.test(n), n);
  const IDX = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8").split(String.fromCharCode(13)).join("");
  assert.ok(!/^\s*ALERT_TEMPLATE_(NAME|LANG|VARS),?\s*$/m.test(IDX), "ALERT_TEMPLATE_* sigue en el destructurado de index.js");
  const codigo = IDX.split(String.fromCharCode(10)).filter((l) => !/^\s*\/\//.test(l) && !/process\.env\.ALERT_TEMPLATE_NAME/.test(l)).join(String.fromCharCode(10));
  assert.ok(!/ALERT_TEMPLATE_(NAME|LANG|VARS)/.test(codigo), "index.js todavía lee ALERT_TEMPLATE_*");
  assert.match(IDX, /paramsAlertaEquipo\(/);
});

test("invariante de envío: los avisos usan los envíos del BOT (con freno), nunca los 'Result'", () => {
  const IDX = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8").split(String.fromCharCode(13)).join("");
  const i = IDX.indexOf("const avisosCliente = creaAvisos(");
  const bloque = IDX.slice(i, IDX.indexOf("\n});", i));
  assert.match(bloque, /enviaLibre: \(tel, texto\) => sendWhatsApp\(/);
  assert.match(bloque, /enviaPlantilla: .*sendWhatsAppTemplate\(/);
  assert.ok(!/Result|sendCliente/.test(bloque));
  assert.match(bloque, /\bisAllowed,/);
});
