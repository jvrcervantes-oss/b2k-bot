// Guardas de servidor que salen de la batería adversaria S8 (9-oct-2026, primera ejecución contra Haiku 5.5):
//   · aviso de asistente (IA) lo pone el servidor, no el modelo
//   · la frase exacta de traspaso ES el traspaso (el modelo se olvidaba de [HUMANO])
//   · las notas no guardan teléfonos, emails ni nada de un menor
// Informe: encargos/20261009_lawang_bot_bateria_s8.md
import test from "node:test";
import assert from "node:assert";
import {
  AVISO_EN, AVISO_ES, aplicaAviso, debeAvisar, escribeEnEspanol, pideTraspaso, extraeEtiquetas, quitaDatosPersonales, esNotaDeMenor, saneaNotas, ejecutaCrm,
} from "./botcrm.js";

const H = 3600 * 1000;

test("aviso: toca en la primera respuesta del bot y tras más de 24 h desde su último mensaje, no antes", () => {
  assert.strictEqual(debeAvisar([{ role: "user", content: "hola", ts: 1 }], 10), true);
  assert.strictEqual(debeAvisar([], 10), true);
  assert.strictEqual(debeAvisar([{ role: "user", ts: 1 }, { role: "assistant", ts: 1000 }, { role: "user", ts: 2000 }], 1000 + 23 * H), false);
  assert.strictEqual(debeAvisar([{ role: "user", ts: 1 }, { role: "assistant", ts: 1000 }, { role: "user", ts: 2000 }], 1000 + 25 * H), true);
  assert.strictEqual(debeAvisar([{ role: "assistant", content: "historial viejo sin hora" }, { role: "user" }], Date.now()), false, "sin hora no se repite por error");
});

test("aviso: idioma. Español si el cliente escribe en español (en cualquiera de sus últimos mensajes); inglés para el resto, indonesio incluido", () => {
  assert.strictEqual(escribeEnEspanol(["Hola, busco una parcela"]), true);
  assert.strictEqual(escribeEnEspanol(["ok", "¿cuánto cuesta?"]), true);
  assert.strictEqual(escribeEnEspanol(["Halo, berapa harga tanah di Bonian Village?"]), false);
  assert.strictEqual(escribeEnEspanol(["Hi, how much is a plot?"]), false);
  assert.ok(aplicaAviso("Claro.", { enviar: true, cliente: ["Hola"] }).startsWith(AVISO_ES));
  assert.ok(aplicaAviso("Baik.", { enviar: true, cliente: ["Halo, saya cari tanah"] }).startsWith(AVISO_EN));
});

test("aviso: enviar=false no toca nada; enviar=true antepone el aviso exacto con una línea en blanco", () => {
  assert.strictEqual(aplicaAviso("BV-12 is 500 m2.", { enviar: false }), "BV-12 is 500 m2.");
  assert.strictEqual(aplicaAviso("BV-12 is 500 m2.", { enviar: true, cliente: ["hi"] }), `${AVISO_EN}\n\nBV-12 is 500 m2.`);
});

test("aviso: no se duplica si el modelo ya lo escribió exacto, ni cuando lo escribió traducido o abreviado", () => {
  assert.strictEqual(aplicaAviso(`${AVISO_EN}\n\nBV-12 is 500 m2.`, { enviar: true, cliente: ["hi"] }), `${AVISO_EN}\n\nBV-12 is 500 m2.`);
  // partido por un salto de línea dentro del enlace (visto en C05)
  const roto = AVISO_EN.replace("data: ", "data: \n");
  assert.strictEqual(aplicaAviso(`${roto}\n\nAnswer.`, { enviar: true, cliente: ["hi"] }), `${AVISO_EN}\n\nAnswer.`);
  // traducción propia del modelo (L01): se sustituye por la exacta de Legal
  const traducido = "Hola, soy el asistente automatizado (IA) de Lawang. Puedo compartir precios. Cómo tratamos tus datos: lawangproperties.com/legal#privacy\n\nTenemos dos parcelas.";
  assert.strictEqual(aplicaAviso(traducido, { enviar: true, cliente: ["Hola"] }), `${AVISO_ES}\n\nTenemos dos parcelas.`);
  // variante corta (P06 r2)
  assert.strictEqual(aplicaAviso("Automated assistant (AI) here. I can't see earlier chats.", { enviar: true, cliente: ["hi"] }), `${AVISO_EN}\n\nI can't see earlier chats.`);
  // el cliente escribe en español y el modelo puso el inglés: sale el español
  assert.strictEqual(aplicaAviso(`${AVISO_EN}\n\nHola.`, { enviar: true, cliente: ["Hola, busco algo"] }), `${AVISO_ES}\n\nHola.`);
});

test("aviso: si el modelo repite el aviso con su razonamiento en medio (AV04), solo sobrevive lo que sigue a la última copia", () => {
  const raw = `${AVISO_EN}\n\nCustomer writes in Indonesian, so the disclosure goes in Spanish per the rule? Let me correct: English.\n\n${AVISO_EN}\n\nBaik, ada dua kavling.`;
  assert.strictEqual(aplicaAviso(raw, { enviar: true, cliente: ["Halo, saya cari tanah"] }), `${AVISO_EN}\n\nBaik, ada dua kavling.`);
});

test("aviso: si el modelo solo escribió el aviso, el cliente recibe el aviso (nunca vacío)", () => {
  assert.strictEqual(aplicaAviso(AVISO_EN, { enviar: true, cliente: ["hi"] }), AVISO_EN);
  assert.strictEqual(aplicaAviso("", { enviar: true, cliente: ["hi"] }), AVISO_EN);
});

test("traspaso: la frase exacta (EN o ES) cuenta como [HUMANO]; una frase parecida o ninguna, no", () => {
  assert.ok(pideTraspaso("Of course. I'll pass you to a team member who can help you personally."));
  assert.ok(pideTraspaso("Claro. Te paso con una persona del equipo que podrá ayudarte personalmente."));
  assert.ok(pideTraspaso("Hi. I’ll pass you to a team member who can help you personally. [HUMANO]"));
  assert.ok(pideTraspaso("ok [HUMANO]"));
  assert.ok(!pideTraspaso("Our team member can help you with that."));
  assert.ok(!pideTraspaso("I'll pass your question to the team."));
});

test("notas: teléfonos y emails se quitan; importes, fechas y m2 se respetan", () => {
  assert.strictEqual(quitaDatosPersonales("llamar a +62 812 000 1111"), "llamar a (tel omitido)");
  assert.strictEqual(quitaDatosPersonales("su madre 0812 555 0100"), "su madre (tel omitido)");
  assert.strictEqual(quitaDatosPersonales("escribe a tom@example.com"), "escribe a (email omitido)");
  assert.strictEqual(quitaDatosPersonales("BV-12 a IDR 1.500.000 por m2, total 750,000,000, cita 2026-10-12 10:00"), "BV-12 a IDR 1.500.000 por m2, total 750,000,000, cita 2026-10-12 10:00");
  const e = extraeEtiquetas("Hola [NOTA:Budi (+62 812 000 1111) pregunta por BV-12] [NOTA:visita sabado, hotel en Seminyak]");
  assert.deepStrictEqual(e.notas, ["Budi ((tel omitido)) pregunta por BV-12", "visita sabado, hotel en Seminyak"]);
});

test("notas: las que hablan de un menor se descartan; las de adultos y de metros no", () => {
  for (const n of ["Client says they are 16, wants to buy a plot with savings", "Lead is 17 years old", "Es menor de edad", "tengo 15 años", "usuario di bawah umur", "Minor: do not book"]) assert.ok(esNotaDeMenor(n), n);
  for (const n of ["Wants a plot of 15 m2 or bigger", "Looking at 12 plots", "Tom, 45, staying in Seminyak until the 20th", "Interested in villa for 4 people", "budget 15,000 EUR", "We are a team of 12"]) assert.ok(!esNotaDeMenor(n), n);
  assert.deepStrictEqual(extraeEtiquetas("ok [NOTA:Client says they are 16, wants to buy] [NOTA:prefers calls]").notas, ["prefers calls"]);
  assert.deepStrictEqual(saneaNotas(["x +62 899 111 2222", "se llama Ana, tiene 14 años"]), ["x (tel omitido)"]);
});

test("ejecutaCrm sanea también las notas que arma el servidor (la del traspaso copia el último mensaje del cliente)", async () => {
  const llamadas = [];
  await ejecutaCrm({
    modo: "on", tel: "34661569373", msgId: "w1", nombre: "Tom",
    notas: ["Handed over to a team member by the assistant. Customer's last message: \"I'm 16, my mom's number is 0812 555 0100\"", "Handed over. Customer's last message: \"call +62 812 000 1111 please\""],
    citas: [], llama: async (accion, cuerpo) => { llamadas.push({ accion, ...cuerpo }); return accion === "lead_upsert" ? "creado" : "ok"; },
  });
  const textos = llamadas.filter((l) => l.accion === "lead_nota").map((l) => l.texto);
  assert.strictEqual(textos.length, 1, "la del menor no se guarda");
  assert.ok(!/812/.test(textos[0]) && /\(tel omitido\)/.test(textos[0]));
});
