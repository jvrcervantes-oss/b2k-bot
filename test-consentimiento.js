// S12 (LAW-507): el consentimiento de seguimiento y el reenganche, con el bot de VERDAD (node index.js) contra una edge falsa, el Graph falso y el
// Anthropic falso. Sin red, sin secretos y SIN ningún mensaje real: los envíos son simulados y los teléfonos son sintéticos (62812000099xx).
// La semántica del SQL (listas cerradas, reglas, ancla, 30 días) se prueba contra la base REAL en supabase/pruebas/bot_sin_redis_s12.sql;
// aquí se prueba lo que HACE EL BOT con cada respuesta (batería de Legal §5).
import test from "node:test";
import assert from "node:assert";
import { creaEdgeFalsa, creaGraphFalso, creaAnthropicFalso, lanzaBot, payloadTexto, payloadMedia, hasta, esperar } from "./fakes-pg.js";
import { PREGUNTA, REPREGUNTA, PLANTILLAS, decidePregunta, esDespedida, tieneCifra, VERSION } from "./consentimiento.js";

const SEC = { estado: "sec-estado", recordatorio: "sec-recordatorio", humano: "sec-humano", crm: "sec-crm" };
let n = 0;
const wamid = (p = "C") => `wamid.${p}${Date.now().toString(36)}${++n}`;
const tel = (k) => `628120000${String(k).padStart(3, "0")}`;
const H = 3600 * 1000;

async function entorno(env = {}) {
  const edge = await creaEdgeFalsa({ secretos: SEC });
  const graph = await creaGraphFalso();
  const anthropic = await creaAnthropicFalso();
  const bot = await lanzaBot({ edge, graph, anthropic, secretos: SEC, env: { BOT_PREGUNTA_PAUSA_MS: "0", BOT_CONSENTIMIENTO: "on", ...env } });
  return { edge, graph, anthropic, bot, async cierra() { await bot.para(); await edge.cierra(); await graph.cierra(); await anthropic.cierra(); } };
}
/** El lead escribe y esperamos a que el turno se cierre (una vez más que antes). */
async function di(E, T, texto, extra = {}) {
  const antes = E.edge.de("turno_cerrar").length;
  const w = wamid("U");
  assert.strictEqual(await E.bot.post(payloadTexto(T, texto, w, extra)), 200);
  await hasta(() => E.edge.de("turno_cerrar").length === antes + 1, `turno cerrado tras «${texto}»`);
  return w;
}
const mensajes = (E, T) => E.graph.a(T).filter((e) => e.type === "text").map((e) => e.texto);
const preguntas = (E, T) => mensajes(E, T).filter((t) => t === PREGUNTA.en || t === PREGUNTA.es);
const estadoDe = (E, T) => E.edge.consent.cs(E.edge.chat(T)).estado;
/** Deja al lead con la pregunta hecha: «Hi» (1.er mensaje: no se pregunta) + «thanks…» (despedida: sí). */
async function hastaLaPregunta(E, T, textoDespedida = "thanks, I will think about it") {
  await di(E, T, "Hi");
  assert.strictEqual(preguntas(E, T).length, 0, "nunca en el primer mensaje");
  await di(E, T, textoDespedida);
  await hasta(() => preguntas(E, T).length === 1, "la pregunta de seguimiento");
  await hasta(() => E.edge.consent.cs(E.edge.chat(T)).preguntaWamid, "wamid de la pregunta anclado");
}

// ═════════ piezas puras ═════════
test("decidePregunta: solo en cierre, nunca con cifra/cita/traspaso/queja/derechos/menor, y apagada por defecto", () => {
  const ok = { habilitado: true, consent: { estado: "sin_preguntar", puede_preguntar: true }, esPrimerTurno: false, nivelAviso: null, textoCliente: "thanks, I will think about it", respuestaBot: "Sure, take your time.", intent: "exploring", traspaso: false, hayCita: false, pausado: false, mensajesCliente: 2 };
  assert.strictEqual(decidePregunta(ok).pregunta, true);
  assert.strictEqual(decidePregunta({ ...ok, habilitado: false }).motivo, "apagado");
  assert.strictEqual(decidePregunta({ ...ok, esPrimerTurno: true }).motivo, "primer_mensaje");
  assert.strictEqual(decidePregunta({ ...ok, nivelAviso: "completo" }).motivo, "aviso_de_asistente");
  for (const respuestaBot of ["The plot is 250,000 USD", "It is Rp 2 miliar", "Unit 1234 is available", "about $50k"]) assert.strictEqual(decidePregunta({ ...ok, respuestaBot }).motivo, "cifra", respuestaBot);
  for (const x of [{ traspaso: true }, { hayCita: true }, { intent: "escalate" }, { intent: "booking" }, { pausado: true }]) assert.strictEqual(decidePregunta({ ...ok, ...x }).pregunta, false);
  for (const textoCliente of ["thanks but this is wrong", "gracias, es un error vuestro", "thanks, please delete my data", "gracias, quiero ejercer mis derechos", "thanks, I'm 16"]) assert.strictEqual(decidePregunta({ ...ok, textoCliente }).pregunta, false, textoCliente);
  for (const c of [null, { estado: "preguntado", puede_preguntar: false }, { estado: "no", puede_preguntar: false }, { estado: "revocado", puede_preguntar: false }, { estado: "sin_preguntar", puede_preguntar: false }]) assert.strictEqual(decidePregunta({ ...ok, consent: c }).pregunta, false);
  // sin despedida: solo si no queda nada abierto (ni el lead ni el bot) y la conversación ya tiene cuerpo
  const sinDespedida = { ...ok, textoCliente: "I am interested in Sumba land", respuestaBot: "Great, we have several options in the south." };
  assert.strictEqual(decidePregunta({ ...sinDespedida, mensajesCliente: 3 }).motivo, "sin_pendientes");
  assert.strictEqual(decidePregunta({ ...sinDespedida, mensajesCliente: 2 }).pregunta, false);
  assert.strictEqual(decidePregunta({ ...sinDespedida, mensajesCliente: 3, respuestaBot: "Which area do you prefer?" }).pregunta, false);
  assert.strictEqual(decidePregunta({ ...sinDespedida, mensajesCliente: 3, textoCliente: "what does it cost?" }).pregunta, false);
  assert.ok(esDespedida("Gracias, lo pienso") && esDespedida("let me check with my partner") && !esDespedida("thanks, what about the price?") && !esDespedida("hello"));
  assert.ok(tieneCifra("USD 100") && tieneCifra("1500") && !tieneCifra("two bedrooms"));
});

test("los textos de la pregunta son los de Legal (versión CONSENT-SEGUIMIENTO-2026-10-09-v1) y las plantillas, las dos de Meta", () => {
  assert.strictEqual(VERSION, "CONSENT-SEGUIMIENTO-2026-10-09-v1");
  assert.match(PREGUNTA.en, /^Would you like us to follow up here on WhatsApp if we don't hear from you\? If you say yes, Lawang's automated assistant \(AI\) will send you up to 2 short messages, about 2 days and 7 days after our last message\. It's optional, and you can stop it any time by replying STOP\. Please reply YES or NO\. How we handle your data: lawangproperties\.com\/legal#privacy$/);
  assert.match(PREGUNTA.es, /^¿Quieres que te escribamos por aquí, por WhatsApp, si no volvemos a hablar\? Si dices que sí, el asistente automático \(IA\) de Lawang te enviará hasta 2 mensajes cortos, a los 2 días y a los 7 días de nuestro último mensaje\. Es opcional y puedes pararlo cuando quieras respondiendo STOP\. Responde SÍ o NO\. Cómo tratamos tus datos: lawangproperties\.com\/legal#privacy$/);
  assert.strictEqual(REPREGUNTA.en, "Just to be sure: may we write to you up to 2 times on WhatsApp after this chat? Please reply YES or NO.");
  assert.strictEqual(REPREGUNTA.es, "Para confirmar: ¿podemos escribirte hasta 2 veces por WhatsApp después de este chat? Responde SÍ o NO.");
  assert.deepStrictEqual(PLANTILLAS, { "48h": "lawang_reenganche_48h", "7d": "lawang_reenganche_7d" });
});

// ═════════ la pregunta ═════════
test("se pregunta SOLO en el cierre (despedida), como mensaje propio tras la respuesta, una vez, y la salida guardada lleva el wamid de la pregunta", async (t) => {
  const E = await entorno(); t.after(() => E.cierra());
  const T = tel(1);
  await hastaLaPregunta(E, T);
  const msgs = mensajes(E, T);
  assert.strictEqual(msgs.length, 3, "respuesta 1, respuesta 2 y la pregunta (mensaje propio)");
  assert.strictEqual(msgs[2], PREGUNTA.en);
  assert.ok(!msgs[1].includes("YES or NO"), "no va pegada a la respuesta");
  assert.strictEqual(estadoDe(E, T), "preguntado");
  const cerrar = E.edge.de("turno_cerrar")[1].cuerpo;
  assert.strictEqual(cerrar.salida.length, 2);
  assert.strictEqual(cerrar.salida[1].texto, PREGUNTA.en);
  assert.match(cerrar.salida[1].wamid, /^wamid\.OUT/);
  const k = E.edge.consent.cs(E.edge.chat(T));
  assert.strictEqual(k.preguntaWamid, cerrar.salida[1].wamid, "el wamid anclado es el del mensaje enviado");
  // jamás se manda un «estado» a la base
  for (const l of E.edge.llamadas.filter((x) => /^consentimiento_/.test(x.accion))) assert.ok(!("estado" in l.cuerpo), `${l.accion} no lleva estado`);
  // una sola vez por lead, aunque no conteste y vuelva a despedirse
  await di(E, T, "thanks again");
  await di(E, T, "gracias, lo pienso");
  assert.strictEqual(preguntas(E, T).length, 1, "una sola pregunta por lead, también si no contesta");
});

test("en español pregunta en español; en indonesio, en inglés (la versión indonesa no está activa)", async (t) => {
  const E = await entorno(); t.after(() => E.cierra());
  const Tes = tel(2), Tid = tel(3);
  await di(E, Tes, "hola, quiero información de las parcelas por favor");
  await di(E, Tes, "gracias, lo pienso");
  await hasta(() => mensajes(E, Tes).includes(PREGUNTA.es), "pregunta en español");
  await di(E, Tid, "halo, saya mau tanya harga tanah");
  await di(E, Tid, "terima kasih, saya pikir dulu");
  await hasta(() => mensajes(E, Tid).includes(PREGUNTA.en), "pregunta en inglés para quien escribe en indonesio");
});

test("NUNCA en el primer mensaje del bot (ni con una despedida), ni con cifra, cita o traspaso; con la bandera apagada tampoco", async (t) => {
  const E = await entorno(); t.after(() => E.cierra());
  // primer mensaje que ya es una despedida
  const T0 = tel(4);
  await di(E, T0, "thanks");
  assert.strictEqual(preguntas(E, T0).length, 0, "primer mensaje del bot: no");
  // con cifra
  const T1 = tel(5);
  await di(E, T1, "Hi");
  E.anthropic.guion.push("The plot is 250,000 USD. [INTENT:interested]");
  await di(E, T1, "thanks, I will think about it");
  assert.strictEqual(preguntas(E, T1).length, 0, "pegada a una cifra: no");
  assert.strictEqual(estadoDe(E, T1), "sin_preguntar");
  // con cita
  const T2 = tel(6);
  await di(E, T2, "Hi");
  E.anthropic.guion.push("Done, see you then. [APPT:2026-10-20 10:00|call]");
  await di(E, T2, "thanks, see you");
  assert.strictEqual(preguntas(E, T2).length, 0, "con una cita en curso: no");
  // con traspaso
  const T3 = tel(7);
  await di(E, T3, "Hi");
  E.anthropic.guion.push("I'll pass you to a team member. [HUMANO]");
  await di(E, T3, "thanks, I would like to speak to a person");
  assert.strictEqual(preguntas(E, T3).length, 0, "con traspaso a persona: no");
  // con la operadora: el chat en pausa no habla
  const T4 = tel(8);
  await di(E, T4, "Hi");
  E.edge.chat(T4).pausado = true;
  await di(E, T4, "thanks");
  assert.strictEqual(preguntas(E, T4).length, 0);
  await E.cierra();
  const E2 = await entorno({ BOT_CONSENTIMIENTO: "" }); t.after(() => E2.cierra());
  const T5 = tel(9);
  await di(E2, T5, "Hi"); await di(E2, T5, "thanks, I will think about it");
  assert.strictEqual(preguntas(E2, T5).length, 0, "con BOT_CONSENTIMIENTO apagada nunca pregunta");
  assert.strictEqual(E2.edge.llamadas.filter((l) => /^consentimiento_/.test(l.accion)).length, 0);
});

// ═════════ la respuesta ═════════
for (const [dice, esperado] of [["Sí", "si"], ["yes", "si"], ["Claro", "si"], ["no", "no"], ["No, gracias", "no"]]) {
  test(`«${dice}» a la pregunta → ${esperado}, con wamid, texto literal y regla; el modelo recibe solo el tono`, async (t) => {
    const E = await entorno(); t.after(() => E.cierra());
    const T = tel(10 + n);
    await hastaLaPregunta(E, T);
    const w = await di(E, T, dice);
    const k = E.edge.consent.cs(E.edge.chat(T));
    assert.strictEqual(k.estado, esperado);
    assert.strictEqual(k.respuestaWamid, w);
    assert.strictEqual(k.respuestaTexto, dice, "texto literal");
    assert.match(k.regla, /^turno_siguiente:/);
    const ult = E.anthropic.peticiones.at(-1);
    assert.ok(ult.system.some((b) => /FOLLOW-UP CONSENT/.test(b.text)), "el modelo recibe el tono (ya decidido)");
    const r = E.edge.de("consentimiento_responder").at(-1).cuerpo;
    assert.deepStrictEqual(Object.keys(r).sort(), ["accion", "tel", "texto", "wamid"], "solo teléfono, wamid y texto literal (+cita si la hay)");
    assert.strictEqual(preguntas(E, T).length, 1);
  });
}

test("«ok» → UNA repregunta (mensaje propio, tras responder) → otro «ok» → no; «👍» y «maybe» igual", async (t) => {
  for (const ambiguo of ["ok", "👍", "maybe"]) {
    const E = await entorno(); t.after(() => E.cierra());
    const T = tel(30 + n);
    await hastaLaPregunta(E, T);
    await di(E, T, ambiguo);
    await hasta(() => mensajes(E, T).includes(REPREGUNTA.en), `repregunta tras «${ambiguo}»`);
    await hasta(() => E.edge.consent.cs(E.edge.chat(T)).repreguntaWamid, "wamid de la repregunta");
    assert.strictEqual(estadoDe(E, T), "preguntado");
    await di(E, T, ambiguo);
    assert.strictEqual(estadoDe(E, T), "no", `«${ambiguo}» tras la repregunta → no`);
    assert.strictEqual(mensajes(E, T).filter((m) => m === REPREGUNTA.en).length, 1, "una sola repregunta");
    assert.strictEqual(preguntas(E, T).length, 1, "y no se vuelve a preguntar");
    await E.cierra();
  }
});

test("un «ok» a OTRA cosa no cuenta (la operadora habló en medio); un «sí» que CITA la pregunta sí", async (t) => {
  const E = await entorno(); t.after(() => E.cierra());
  const T = tel(40);
  await hastaLaPregunta(E, T);
  const preguntaWamid = E.edge.consent.cs(E.edge.chat(T)).preguntaWamid;
  await E.bot.post({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "smb_message_echoes", value: { message_echoes: [{ to: T, id: wamid("E"), type: "text", text: { body: "Hola, soy Ana" } }] } }] }] });
  await hasta(() => E.edge.de("eco_operadora").length === 1, "eco de la operadora");
  E.edge.chat(T).pausado = false;                                            // la pausa por la operadora no es lo que probamos aquí
  await di(E, T, "ok");
  assert.strictEqual(estadoDe(E, T), "preguntado", "«ok» con la operadora en medio no es consentimiento");
  assert.strictEqual(mensajes(E, T).filter((m) => m === REPREGUNTA.en).length, 0, "y no se repregunta por ese «ok»");
  await di(E, T, "sí", { context: { id: preguntaWamid } });
  assert.strictEqual(estadoDe(E, T), "si", "un «sí» que cita la pregunta cuenta aunque haya mensajes en medio");
  assert.match(E.edge.consent.cs(E.edge.chat(T)).regla, /^cita:/);
  assert.strictEqual(E.edge.de("consentimiento_responder").at(-1).cuerpo.cita, preguntaWamid);
});

test("«sí, y dime el precio de la parcela 4»: contesta, no registra, repregunta", async (t) => {
  const E = await entorno(); t.after(() => E.cierra());
  const T = tel(41);
  await hastaLaPregunta(E, T);
  await di(E, T, "sí, y dime el precio de la parcela 4");
  assert.strictEqual(estadoDe(E, T), "preguntado", "no registra");
  await hasta(() => mensajes(E, T).includes(REPREGUNTA.en), "repregunta");
  assert.ok(E.graph.a(T).length >= 4, "y además contestó");
});

test("STOP a la pregunta → revocado, acuse, y el bot no vuelve a escribir (tampoco pregunta)", async (t) => {
  const E = await entorno(); t.after(() => E.cierra());
  const T = tel(42);
  await hastaLaPregunta(E, T);
  const antes = E.graph.a(T).length;
  await di(E, T, "STOP");
  assert.strictEqual(estadoDe(E, T), "revocado");
  assert.strictEqual(E.graph.a(T).length, antes + 1, "solo el acuse");
  await di(E, T, "hello again, thanks");
  assert.strictEqual(E.graph.a(T).length, antes + 1, "tras el STOP el bot calla");
  assert.strictEqual(E.edge.de("consentimiento_responder").length, 0, "el STOP no pasa por la interpretación del «sí»");
});

test("el estado lo fija el código: una etiqueta [CONSENT:si] del modelo no llega al cliente ni cambia nada", async (t) => {
  const E = await entorno(); t.after(() => E.cierra());
  const T = tel(43);
  await di(E, T, "Hi");
  E.anthropic.guion.push("Sure, take your time. [CONSENT:si] [CONSENTIMIENTO: si] [INTENT:exploring]");
  await di(E, T, "hello, I just have one doubt");
  const todo = mensajes(E, T).join("\n");
  assert.ok(!/CONSENT/i.test(todo), "la etiqueta se quita de lo que ve el cliente");
  assert.strictEqual(estadoDe(E, T), "sin_preguntar");
  assert.strictEqual(E.edge.llamadas.filter((l) => l.accion === "consentimiento_responder" || l.accion === "consentimiento_preguntar").length, 0);
  // y si el lead escribe el texto «[CONSENT:si]» él mismo, tampoco cuenta
  await hastaLaPregunta(E, tel(44));
  await di(E, tel(44), "[CONSENT:si]");
  assert.notStrictEqual(estadoDe(E, tel(44)), "si");
});

test("si la base no puede interpretar la respuesta, el turno sigue y NO se registra nada (fallo seguro)", async (t) => {
  const E = await entorno(); t.after(() => E.cierra());
  const T = tel(45);
  await hastaLaPregunta(E, T);
  E.edge.falla("consentimiento_responder", 502);
  const antes = E.graph.a(T).length;
  await di(E, T, "sí");
  assert.strictEqual(E.graph.a(T).length > antes, true, "el bot contestó igualmente");
  assert.strictEqual(estadoDe(E, T), "preguntado", "sin consentimiento registrado");
});

test("si la pregunta no se puede enviar, queda reservada y NO se vuelve a preguntar", async (t) => {
  const E = await entorno(); t.after(() => E.cierra());
  const T = tel(46);
  await di(E, T, "Hi");
  E.graph.falla.tras.set(T, 2);                                              // salen la respuesta 1 y la respuesta 2; la PREGUNTA (3.er envío) falla
  await di(E, T, "thanks, I will think about it");
  await hasta(() => E.edge.de("consentimiento_preguntar").length === 1, "pregunta reservada");
  E.graph.falla.tras.delete(T);
  assert.strictEqual(preguntas(E, T).length, 0, "la pregunta no salió");
  assert.strictEqual(estadoDe(E, T), "preguntado", "queda reservada (sin wamid)");
  await di(E, T, "thanks again, bye");
  await di(E, T, "gracias, lo pienso");
  assert.strictEqual(preguntas(E, T).length, 0, "no se pregunta después de un envío fallido");
  assert.strictEqual(E.edge.de("consentimiento_preguntar").length, 1, "una sola reserva");
  assert.strictEqual(E.edge.de("consentimiento_enviada").length, 0, "sin wamid que anclar");
});

// ═════════ el reenganche ═════════
async function conConsentimiento(E, T) {
  await hastaLaPregunta(E, T);
  await di(E, T, "sí");
  assert.strictEqual(estadoDe(E, T), "si");
}
const plantillasA = (E, T) => E.graph.a(T).filter((e) => e.type === "template");

test("reenganche: 48 h y 7 d en el idioma consentido, con el nombre; nunca un tercero; no usa FOLLOWUP_TEMPLATE_NAME", async (t) => {
  const E = await entorno({ BOT_SEGUIMIENTO: "postgres", BOT_SEGUIMIENTO_CADA_MS: "150", BOT_SEGUIMIENTO_HORAS: "0-24", FOLLOWUP_TEMPLATE_NAME: "lawang_seguimiento_lead" });
  t.after(() => E.cierra());
  const T = tel(50);
  await conConsentimiento(E, T);
  await esperar(500);
  assert.strictEqual(plantillasA(E, T).length, 0, "recién consentido: no hay nada debido");
  E.edge.consent.envejece(T, 49 * H);
  await hasta(() => plantillasA(E, T).length === 1, "plantilla de 48 h");
  assert.strictEqual(plantillasA(E, T)[0].plantilla, "lawang_reenganche_48h");
  assert.deepStrictEqual(plantillasA(E, T)[0].params[0].parameters.map((p) => p.text), ["Test"], "una variable: el nombre de pila");
  await esperar(500);
  assert.strictEqual(plantillasA(E, T).length, 1, "no se repite");
  E.edge.consent.envejece(T, 6 * 24 * H);
  await hasta(() => plantillasA(E, T).length === 2, "plantilla de 7 d");
  assert.strictEqual(plantillasA(E, T)[1].plantilla, "lawang_reenganche_7d");
  await esperar(500);
  E.edge.consent.envejece(T, 20 * 24 * H);
  await esperar(500);
  assert.strictEqual(plantillasA(E, T).length, 2, "máximo 2 por lead");
  assert.strictEqual(estadoDe(E, T), "usado");
  assert.ok(E.graph.enviados.every((e) => e.plantilla !== "lawang_seguimiento_lead"), "FOLLOWUP_TEMPLATE_NAME no se usa jamás");
  const reg = E.edge.de("seguimiento_registrar");
  assert.strictEqual(reg.length, 2);
  assert.ok(reg.every((r) => r.cuerpo.resultado === "enviado" && /^wamid\.OUT/.test(r.cuerpo.wamid)));
});

test("reenganche: sin consentimiento `si` (no, preguntado sin respuesta, revocado) no sale NADA aunque pase el tiempo", async (t) => {
  const E = await entorno({ BOT_SEGUIMIENTO: "postgres", BOT_SEGUIMIENTO_CADA_MS: "150", BOT_SEGUIMIENTO_HORAS: "0-24" });
  t.after(() => E.cierra());
  const Tno = tel(51), Tsin = tel(52), Tstop = tel(53), Tnunca = tel(54);
  await hastaLaPregunta(E, Tno); await di(E, Tno, "no");
  await hastaLaPregunta(E, Tsin);
  await hastaLaPregunta(E, Tstop); await di(E, Tstop, "STOP");
  await di(E, Tnunca, "Hi"); await di(E, Tnunca, "bye, thanks");            // se le preguntó o no: da igual, no contestó
  for (const T of [Tno, Tsin, Tstop, Tnunca]) E.edge.consent.envejece(T, 60 * H);
  await esperar(800);
  assert.strictEqual(E.graph.enviados.filter((e) => e.type === "template").length, 0);
  assert.strictEqual(E.edge.de("seguimiento_reservar").length, 0, "ni siquiera se reserva");
});

test("reenganche: si el lead contesta, la operadora interviene o hay STOP antes de la hora, no sale", async (t) => {
  const E = await entorno({ BOT_SEGUIMIENTO: "postgres", BOT_SEGUIMIENTO_CADA_MS: "150", BOT_SEGUIMIENTO_HORAS: "0-24" });
  t.after(() => E.cierra());
  const Tresp = tel(55), Top = tel(56), Tstop = tel(57);
  for (const T of [Tresp, Top, Tstop]) await conConsentimiento(E, T);
  // el lead escribe después de nuestro último mensaje y el bot aún no ha contestado (p. ej. una pausa): hay respuesta pendiente, no se le escribe encima
  E.edge.chat(Tresp).msgs.push({ id: 9999, rol: "user", por: "cliente", texto: "one more question", ts: Date.now(), wamid: "wamid.resp1" });
  await E.bot.post({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "smb_message_echoes", value: { message_echoes: [{ to: Top, id: wamid("E"), type: "text", text: { body: "Hola" } }] } }] }] });
  await hasta(() => E.edge.de("eco_operadora").length === 1, "eco");
  await di(E, Tstop, "stop");
  for (const T of [Tresp, Top, Tstop]) E.edge.consent.envejece(T, 60 * H);
  await esperar(800);
  assert.strictEqual(E.graph.enviados.filter((e) => e.type === "template").length, 0);
});

test("reenganche apagado por defecto: con consentimiento `si` vencido NO sale nada si BOT_SEGUIMIENTO no está encendida", async (t) => {
  const E = await entorno({ BOT_SEGUIMIENTO_CADA_MS: "150", BOT_SEGUIMIENTO_HORAS: "0-24" });
  t.after(() => E.cierra());
  const T = tel(58);
  await conConsentimiento(E, T);
  E.edge.consent.envejece(T, 60 * H);
  await esperar(800);
  assert.strictEqual(E.graph.enviados.filter((e) => e.type === "template").length, 0);
  assert.strictEqual(E.edge.de("seguimiento_candidatos").length, 0);
});

test("BOT_MODE=testing: el freno sigue vigente — un lead fuera de BOT_ALLOWLIST con consentimiento vencido no recibe la plantilla (ni se reserva)", async (t) => {
  const permitido = tel(60), fuera = tel(61);
  const E = await entorno({ BOT_MODE: "testing", BOT_ALLOWLIST: permitido, BOT_SEGUIMIENTO: "postgres", BOT_SEGUIMIENTO_CADA_MS: "150", BOT_SEGUIMIENTO_HORAS: "0-24" });
  t.after(() => E.cierra());
  // un lead «fuera» fabricado directamente en la base falsa: consentimiento si, 60 h de antigüedad
  const c = E.edge.chat(fuera);
  const ahora = Date.now() - 60 * H;
  c.msgs.push({ id: 1, rol: "user", por: "cliente", texto: "hi", ts: ahora - 5000, wamid: "wamid.f1" }, { id: 2, rol: "user", por: "cliente", texto: "thanks", ts: ahora - 4000, wamid: "wamid.f2" },
    { id: 3, rol: "assistant", por: "bot", texto: "ok", ts: ahora, wamid: "wamid.f3" });
  Object.assign(E.edge.consent.cs(c), { estado: "si", idioma: "en", respondidoEn: ahora, respuestaWamid: "wamid.f2", regla: "turno_siguiente:si" });
  await esperar(900);
  assert.strictEqual(E.graph.a(fuera).length, 0, "nada al lead fuera de la lista");
  assert.strictEqual(E.edge.de("seguimiento_reservar").length, 0, "ni se reserva: el freno va antes");
  // y el permitido, con el mismo freno puesto, sí puede recibirlo
  await conConsentimiento(E, permitido);
  E.edge.consent.envejece(permitido, 49 * H);
  await hasta(() => plantillasA(E, permitido).length === 1, "el de la lista sí");
});

test("un 429/fallo de la base al reservar o al listar NO envía nada y no rompe el bot", async (t) => {
  const E = await entorno({ BOT_SEGUIMIENTO: "postgres", BOT_SEGUIMIENTO_CADA_MS: "150", BOT_SEGUIMIENTO_HORAS: "0-24" });
  t.after(() => E.cierra());
  const T = tel(62);
  await conConsentimiento(E, T);
  E.edge.consent.envejece(T, 49 * H);
  E.edge.falla("seguimiento_reservar", 502, 3);
  await esperar(900);
  assert.strictEqual(plantillasA(E, T).length <= 1, true);
  const total = plantillasA(E, T).length + E.edge.de("seguimiento_registrar").filter((r) => r.cuerpo.resultado === "enviado").length;
  assert.ok(total <= 2, "como mucho una plantilla (y su registro)");
  const h = await E.bot.get("/admin/api/health", { "x-admin-key": "admin-test" });
  assert.strictEqual(h.status, 200);
  assert.deepStrictEqual(h.json.consentimiento, { pregunta: true, seguimiento: "postgres" });
});
