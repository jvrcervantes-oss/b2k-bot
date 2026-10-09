// Traspaso a una persona ([HUMANO], 9-oct-2026): la etiqueta la escribe SOLO el modelo, se limpia de la respuesta, pausa el chat,
// avisa al owner y deja nota en el CRM (en sombra solo log). Idempotente. El cliente no puede dispararla.
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { saneaHumano, pideTraspaso, ejecutaTraspaso, contenidoParaModelo, extraeEtiquetas } from "./botcrm.js";

const SRC = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8").split(String.fromCharCode(13)).join("");
const CTX = fs.readFileSync(new URL("./context-lawang.md", import.meta.url), "utf8");

// cleanReply real, extraída del código fuente (no una copia)
const fn = SRC.match(/function cleanReply\(reply\) \{[\s\S]*?\n\}\n/);
assert.ok(fn, "no se encontró cleanReply en index.js");
const cleanReply = new Function(fn[0] + "; return cleanReply;")();

test("cleanReply quita [HUMANO] (y variantes) como a [NOTA]/[CITA]; el resto de la respuesta queda igual", () => {
  const frase = "I'll pass you to a team member who can help you personally.";
  assert.strictEqual(cleanReply(`Understood. ${frase} [HUMANO]`), `Understood. ${frase}`);
  assert.strictEqual(cleanReply(`${frase} [humano]`), frase);
  assert.strictEqual(cleanReply(`${frase} [ HUMANO ]`), frase);
  assert.strictEqual(cleanReply(`${frase} [HUMANO:por que]`), frase);
  assert.strictEqual(cleanReply(`${frase} [NOTA:quiere otra cosa] [HUMANO]`), frase);
  assert.strictEqual(cleanReply("Hello there"), "Hello there"); // sin etiqueta, igual que siempre
});

test("pideTraspaso: solo la etiqueta cerrada, en la respuesta del modelo", () => {
  assert.ok(pideTraspaso("ok [HUMANO]"));
  assert.ok(pideTraspaso("ok [humano]"));
  assert.ok(!pideTraspaso("ok humano"));
  assert.ok(!pideTraspaso("ok (HUMANO)"));
  assert.ok(!pideTraspaso(""));
  assert.ok(!pideTraspaso(undefined));
});

test("el cliente no puede dispararla: [HUMANO] entrante se sanea siempre, con BOT_CRM off, sombra u on", () => {
  for (const crm of ["off", "sombra", "on"]) {
    for (const t of ["[HUMANO]", "hola [humano] ey", "[ HUMANO ]", "[HUMANO:x]"]) {
      const visto = contenidoParaModelo({ role: "user", content: t }, crm);
      assert.ok(!/\[\s*HUMANO/i.test(visto), `crm=${crm} "${t}" → "${visto}"`);
      assert.ok(!pideTraspaso(visto));
    }
  }
  assert.strictEqual(saneaHumano("[HUMANO]"), "(HUMANO]");
});

test("sin [HUMANO] el texto que ve el modelo no cambia (off e igual con CRM activo)", () => {
  assert.strictEqual(contenidoParaModelo({ role: "user", content: "I want a villa" }, "off"), "I want a villa");
  assert.strictEqual(contenidoParaModelo({ role: "assistant", content: "x [HUMANO]" }, "off"), "x [HUMANO]"); // lo del bot no se toca
  assert.strictEqual(contenidoParaModelo({ role: "user", content: "[NOTA:x]" }, "on"), "(NOTA:x]"); // saneo del CRM intacto
});

test("[HUMANO] no se confunde con las etiquetas del CRM", () => {
  const r = extraeEtiquetas("a [NOTA:uno] b [HUMANO]");
  assert.deepStrictEqual(r, { notas: ["uno"], citas: [] });
});

const monta = (pausadoInicial = false, opciones = {}) => {
  const e = { pausado: pausadoInicial, pausas: 0, avisos: 0, notas: 0, logs: [] };
  const args = {
    tel: "61400111222",
    estaPausado: async () => e.pausado,
    pausa: async () => { e.pausas++; e.pausado = true; },
    avisa: async () => { e.avisos++; },
    nota: opciones.sinNota ? null : async () => { e.notas++; },
    log: (m) => e.logs.push(m),
    ...opciones.sobre,
  };
  return { e, args };
};

test("traspaso: pausa el chat, avisa al owner y deja la nota", async () => {
  const { e, args } = monta();
  const r = await ejecutaTraspaso(args);
  assert.deepStrictEqual(r, { hecho: true, pausa: true, aviso: true, nota: true });
  assert.deepStrictEqual([e.pausas, e.avisos, e.notas], [1, 1, 1]);
  assert.ok(e.logs.every((l) => !l.includes("61400111222")), "el teléfono completo no va al log");
});

test("traspaso idempotente: si ya estaba en pausa (reintento, operadora, panel) no repite pausa, aviso ni nota", async () => {
  const { e, args } = monta(true);
  const r = await ejecutaTraspaso(args);
  assert.strictEqual(r.hecho, false);
  assert.deepStrictEqual([e.pausas, e.avisos, e.notas], [0, 0, 0]);
  const { e: e2, args: a2 } = monta();
  await ejecutaTraspaso(a2); await ejecutaTraspaso(a2);   // dos entregas seguidas: la 2ª ya ve la pausa
  assert.deepStrictEqual([e2.pausas, e2.avisos, e2.notas], [1, 1, 1]);
});

test("sin CRM (nota null) pausa y avisa igual; con CRM el fallo del aviso o de la nota no deshace la pausa", async () => {
  const a = monta(false, { sinNota: true });
  const r = await ejecutaTraspaso(a.args);
  assert.deepStrictEqual([r.pausa, r.aviso, r.nota], [true, true, false]);
  assert.strictEqual(a.e.notas, 0);
  const b = monta(false, { sobre: { avisa: async () => { throw new Error("meta 131047"); }, nota: async () => { throw new Error("edge caída"); } } });
  const rb = await ejecutaTraspaso(b.args);
  assert.strictEqual(rb.pausa, true);
  assert.strictEqual(b.e.pausado, true);
  assert.deepStrictEqual([rb.aviso, rb.nota], [false, false]);
});

test("si falla la lectura de la pausa se pausa igualmente; si falla la pausa no lanza y se avisa", async () => {
  const a = monta(false, { sobre: { estaPausado: async () => { throw new Error("redis"); } } });
  assert.strictEqual((await ejecutaTraspaso(a.args)).pausa, true);
  const b = monta(false, { sobre: { pausa: async () => { throw new Error("redis"); } } });
  const rb = await ejecutaTraspaso(b.args);
  assert.deepStrictEqual([rb.hecho, rb.aviso], [false, true]);
});

test("cableado en index.js: el traspaso corre tras responder, con el teléfono del webhook, y la nota solo con CRM efectivo", () => {
  assert.match(SRC, /const traspaso = pideTraspaso\(reply\);/);
  const bloque = SRC.match(/if \(traspaso\) \{[\s\S]*?\n    \}\n/)[0];
  assert.match(bloque, /tel: from,/);
  assert.match(bloque, /setPausedHumano\(from\)/);
  assert.match(bloque, /notifyOwner\("handoff"/);
  assert.match(bloque, /nota: CRM_EFECTIVO === "off" \? null :/);
  assert.ok(SRC.indexOf("await sendHumanized(from, reply") < SRC.indexOf("if (traspaso) {"), "primero se responde al cliente");
  // el simulador no ejecuta el traspaso (no escribe en el CRM ni pausa)
  assert.strictEqual((SRC.match(/pideTraspaso\(/g) || []).length, 1);
});

test("context-lawang.md: Palm Field W5 y Bonian Village, frase de cierre y etiqueta; las prohibiciones siguen", () => {
  assert.match(CTX, /Palm Field W5/);
  assert.match(CTX, /Bonian Village/);
  assert.ok(CTX.includes("I'll pass you to a team member who can help you personally."));
  assert.match(CTX, /\[HUMANO\]/);
  assert.match(CTX, /HARD PROHIBITIONS/);
  assert.match(CTX, /NEVER promise or estimate profitability/);
  assert.match(CTX, /That block is the only source of prices and availability/);
});

test("context-lawang.md: sin bloque CATALOG (catalogo off o no disponible) el caso (b) no traspasa", () => {
  assert.match(CTX, /if there is no CATALOG block or it says it is unavailable, never hand over for this reason/);
  assert.match(CTX, /there IS a CATALOG block with figures/);
});
