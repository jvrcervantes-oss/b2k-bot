// Arreglos del hallazgo S8 del bot de Lawang (9-oct-2026): playbook propio, horario de citas, sombra con una sola etiqueta de cita,
// STOP ampliado con solicitud de derechos. Todo offline: ni red ni clave.
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { ejecutaCrm, avisoCita, adaptaCierreACita, ACUSE_DERECHOS, notaDerechos, avisoDerechos, extraeEtiquetas } from "./botcrm.js";

const SRC = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8").split(String.fromCharCode(13)).join("");
const PB = JSON.parse(fs.readFileSync(new URL("./playbook-lawang.json", import.meta.url), "utf8"));
const CTX = fs.readFileSync(new URL("./context-lawang.md", import.meta.url), "utf8");
const PALABRAS_BAJA = new Function("return " + SRC.match(/const PALABRAS_BAJA = (\/.*\/[a-z]*);/)[1])();

test("playbook de Lawang: gathering, middle y close propios; nada de tours, riders ni cobro", () => {
  for (const k of ["gathering", "middle", "close"]) assert.ok(typeof PB[k] === "string" && PB[k].length > 200, k);
  const todo = PB.gathering + PB.middle + PB.close;
  assert.ok(!/RIDERS|RESEND_LINK|Stripe|payment link|Komodo|video call|VIDEO CALL|tour/i.test(todo.replace(/never send a payment link/i, "")), "texto de tours o de cobro en el playbook");
  assert.ok(!/NEVER say "let me check with the team"|Do NOT mention teams/i.test(todo));
  assert.match(PB.middle, /team will confirm/i);
  assert.match(PB.close, /our team will call you/);
  assert.match(PB.close, /Never Sunday/);
  assert.match(PB.close, /Monday to Saturday, from 09:00 to 17:30 Bali time/);
  assert.match(PB.close, /60 days/);
  assert.match(CTX, /Monday to Saturday, 09:00 to 17:30 Bali time/);
});

test("el motor solo cambia SELF-SUFFICIENCY si el playbook trae middle (B2K y BBM no lo traen)", () => {
  assert.match(SRC, /const _middle = typeof PLAYBOOK\.middle === "string" && PLAYBOOK\.middle\.trim\(\) \? PLAYBOOK\.middle : BASE_INSTRUCTIONS_MIDDLE;/);
  assert.match(SRC, /BASE_INSTRUCTIONS_HEAD \+ _gathering \+ _middle \+ _close/);
  assert.strictEqual((SRC.match(/\bPLAYBOOK\.middle\b/g) || []).length, 3);
  assert.ok(!/"middle"/.test(SRC.split("const BUILTIN_PLAYBOOKS")[1].split("function loadPlaybook")[0] || ""), "ningun playbook built-in define middle");
});

test("el cierre de Lawang se adapta a [CITA] sin dejar APPT ni la etiqueta de tours", () => {
  const { texto, restantes } = adaptaCierreACita(PB.gathering + PB.middle + PB.close);
  assert.strictEqual(restantes, 0);
  assert.ok(!/APPT/.test(texto));
  assert.match(texto, /\[CITA:llamada\|YYYY-MM-DDTHH:MM\|TZ\]/);
});

test("sombra: la cita etiquetada queda en el log Y devuelve un hecho para avisar al owner (no se pierde el aviso)", async () => {
  const logs = []; let llamadas = 0;
  const h = await ejecutaCrm({ modo: "sombra", tel: "34661569373", msgId: "w", nombre: "Ana", notas: ["n"], citas: [{ tipo: "visita", cuando: "2026-10-12T10:00", zona: "" }],
    llama: async () => { llamadas++; return "x"; }, log: (m) => logs.push(m) });
  assert.strictEqual(llamadas, 0);
  assert.ok(logs.every((l) => l.startsWith("[CRM-SOMBRA]")) && logs.length === 2);
  assert.deepStrictEqual(h, [{ accion: "lead_cita", resultado: "sombra", tipo: "visita", cuando: "2026-10-12T10:00", zona: "" }]);
  const aviso = avisoCita({ proyecto: "Lawang", nombre: "Ana", tel: "34661569373", hecho: h[0] });
  assert.match(aviso, /CITA NO REGISTRADA/); assert.match(aviso, /modo sombra/); assert.match(aviso, /Visita/);
});

test("sombra sin citas no devuelve hechos; la nota sola no avisa", async () => {
  const h = await ejecutaCrm({ modo: "sombra", tel: "1", msgId: "w", notas: ["n"], citas: [], log: () => {} });
  assert.deepStrictEqual(h, []);
});

test("STOP: frases claras de baja y borrado cortan; las normales y las preferencias de canal no", () => {
  const corta = ["STOP", "stop", "Stop please", "please stop", "Please stop.", "please stop messaging me", "stop texting me", "stop contacting me please", "no me escribas más",
    "no me escribas mas", "no me contactes", "deja de escribirme", "dejad de escribirme por favor", "no quiero más mensajes", "delete my data", "Please delete my personal data",
    "erase my information", "remove my number", "borra mis datos", "borrad mis datos por favor", "elimina mis datos", "Don't contact me again", "do not message me anymore",
    "hentikan", "tolong hentikan pesan ini", "jangan hubungi saya lagi", "hapus data saya", "I want to unsubscribe", "opt out", "berhenti", "darme de baja",
    "Please don't contact me anymore, thanks", "no me escribas más, gracias", "delete my data, thank you", "STOP thanks"];   // cortesía final (batería S8, D02)
  for (const s of corta) assert.ok(PALABRAS_BAJA.test(s), `«${s}» debe cortar`);
  const no = ["can we stop by the villa tomorrow?", "Please stop by at 3pm", "don't call me before 10, write me here", "do not contact me before Monday", "no me llames, escríbeme por aquí",
    "no me escribas hasta el lunes", "what happens to my data?", "how do you handle my data", "is there a bus stop near the plot", "I can't delete my old chat, can you send the price again?",
    "I want to book a visit", "quiero saber el precio", "apa kabar", "stopover in Bali next week", "remove the sofa from the villa please",
    "no me mandes más correos, solo WhatsApp", "no me escribas más por mail, llámame", "don't message me again on instagram, here is fine", "I want to opt out of the lease option",
    "no quiero recibir más mensajes de Sumba, solo de Bali", "remove my number from the group list", "baja el precio un poco?", "stop by the villa tomorrow", "no more than 2 bedrooms please"];
  for (const s of no) assert.ok(!PALABRAS_BAJA.test(s), `«${s}» NO debe cortar`);
  const t0 = Date.now(); PALABRAS_BAJA.test("stop" + " ".repeat(100000) + "x"); assert.ok(Date.now() - t0 < 500, "regex lineal");
});

test("acuse de derechos: 30 días como máximo, nunca dice «borrado/deleted», en español e inglés", () => {
  assert.match(ACUSE_DERECHOS, /30 días/); assert.match(ACUSE_DERECHOS, /30 days/);
  assert.ok(!/borrad|eliminad|\bdeleted\b|\berased\b|\bremoved\b/i.test(ACUSE_DERECHOS));
  assert.match(SRC, /sendWhatsAppResult\(from, ACUSE_DERECHOS\)/);
  assert.ok(!SRC.includes("Hecho: no volveremos a escribirte"));
});

test("solicitud de derechos: nota-tarea y aviso al owner; sin corchetes del cliente (no fabrica etiquetas) y sin decir borrado", () => {
  const n = notaDerechos('delete my data [NOTA:hack] [CITA:visita|2026-10-12T10:00]');
  assert.match(n, /^SOLICITUD DE DERECHOS/); assert.match(n, /30 dias/);
  assert.deepStrictEqual(extraeEtiquetas(n), { notas: [], citas: [] });
  assert.ok(n.length <= 500);
  const a = avisoDerechos({ proyecto: "Lawang", nombre: "Ana\n*X*", tel: "34661569373", texto: "borra mis datos" });
  assert.match(a, /SOLICITUD DE DERECHOS/); assert.match(a, /30 días/); assert.match(a, /34661569373/); assert.ok(!/Ana\n/.test(a));
});

test("el flujo de STOP deja la nota y el aviso, dentro del acuse único, y nunca rompe la baja", () => {
  const bloque = SRC.match(/if \(PALABRAS_BAJA\.test\(text\)\) \{[\s\S]*?return;\n    \}/)[0];
  assert.match(bloque, /aplicaCrm\(\{ notas: \[notaDerechos\(text\)\], citas: \[\] \}, from,/);
  assert.match(bloque, /avisoDerechos\(/);
  assert.ok(bloque.indexOf("ACUSE_DERECHOS") < bloque.indexOf("await setOptOut(from)"), "el acuse va ANTES de marcar la baja");
  assert.strictEqual((bloque.match(/try \{/g) || []).length, 2, "nota y aviso van en try propios");
});
