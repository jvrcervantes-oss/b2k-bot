// S4b: pruebas ESTRUCTURALES (leen el código fuente). Lo que no se puede olvidar al añadir una función mañana:
//  · todo envío a un cliente pasa por el guardián que exige un turno_estado previo;
//  · con BOT_STORE=redis los módulos de Postgres ni se cargan, y los relojes de Redis no corren con Postgres;
//  · el handler de Redis es el mismo, carácter por carácter, que el de antes de S4b.
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const quitaCR = (s) => s.split(String.fromCharCode(13)).join("");
const IDX = quitaCR(fs.readFileSync(new URL("./index.js", import.meta.url), "utf8"));
const lineas = IDX.split("\n");

function funcionDe(numLinea) {                 // nombre de la función de nivel superior que contiene esa línea
  for (let i = numLinea; i >= 0; i--) {
    const m = lineas[i].match(/^(?:async )?function (\w+)\(/);
    if (m) return m[1];
  }
  return null;
}

test("todo POST a /messages de Meta vive en una función que exige autorización de turno (o es el «leído»)", () => {
  const sitios = [];
  lineas.forEach((l, i) => { if (/GRAPH_BASE\}\/\$\{WHATSAPP_PHONE_ID\}\/messages/.test(l)) sitios.push({ i, fn: funcionDe(i) }); });
  assert.ok(sitios.length >= 4, "se esperaban los envíos de texto, plantilla, media y el «leído»");
  const nombres = new Set(sitios.map((s) => s.fn));
  assert.deepStrictEqual([...nombres].sort(), ["markRead", "sendWhatsAppMedia", "sendWhatsAppResult", "sendWhatsAppTemplateResult"].sort(),
    "hay un envío nuevo fuera de los cuatro núcleos conocidos: " + [...nombres].join(", "));
  for (const f of ["sendWhatsAppResult", "sendWhatsAppTemplateResult", "sendWhatsAppMedia"]) {
    const ini = lineas.findIndex((l) => l.startsWith(`async function ${f}(`));
    let fin = ini; while (!/^}/.test(lineas[fin])) fin++;
    const cuerpo = lineas.slice(ini, fin + 1).join("\n");
    assert.match(cuerpo, /if \(STORE_PG\)/, `${f}: sin el guardián de BOT_STORE=postgres`);
    assert.match(cuerpo, /autorizaciones\.motivo\(/, `${f}: no consulta la autorización`);
    assert.ok(cuerpo.indexOf("autorizaciones.motivo(") < cuerpo.indexOf("axios.post("), `${f}: la autorización debe comprobarse ANTES del envío`);
  }
  const rl = lineas.findIndex((l) => l.startsWith("async function markRead("));
  assert.match(lineas.slice(rl, rl + 6).join("\n"), /status: "read"/, "markRead solo marca como leído");
});

test("sendWhatsApp (el embudo del BOT) sigue pasando por el freno de testing y delega en el núcleo", () => {
  const ini = lineas.findIndex((l) => l.startsWith("async function sendWhatsApp("));
  const cuerpo = lineas.slice(ini, ini + 12).join("\n");
  assert.match(cuerpo, /isAllowed\(to\)/);
  assert.match(cuerpo, /sendWhatsAppResult\(to, message\)/);
});

test("los módulos de Postgres no se importan en estático: con BOT_STORE=redis ni se cargan", () => {
  assert.ok(!/^import .*(turno-pg|store\/postgres)/m.test(IDX), "import estático de un módulo de Postgres");
  assert.match(IDX, /const turnoMod = STORE_PG \? await import\("\.\/turno-pg\.js"\) : null;/);
  assert.match(IDX, /if \(STORE_PG\) \{\n  const \{ creaPg \} = await import\("\.\/store\/postgres\.js"\);/);
});

test("turno-pg.js y store/postgres.js no tocan Redis ni importan el motor", () => {
  for (const f of ["turno-pg.js", "store/postgres.js"]) {
    const s = quitaCR(fs.readFileSync(new URL("./" + f, import.meta.url), "utf8"));
    assert.ok(!/from\s+["'](redis|\.\/store\/redis\.js|\.\.\/store\/redis\.js|\.\/index\.js)["']/.test(s), `${f} importa Redis o el motor`);
    assert.ok(!/getOptOut|isPaused|getConversation|saveConversation|setPaused|optOut/i.test(s.replace(/baja|BAJA/g, "")), `${f} nombra una función del almacén de Redis`);
  }
});

test("con BOT_STORE=postgres no corre ningún reloj de Redis: cada setInterval/enrichSweep va condicionado a STORE_PG", () => {
  const relojes = lineas.filter((l) => /setInterval\(|setTimeout\(\(\) => enrichSweep/.test(l) && !/^\s*\/\//.test(l));
  assert.ok(relojes.length >= 6);
  for (const l of relojes) assert.match(l, /STORE_PG/, "reloj sin condicionar: " + l.trim());
});

test("la firma estricta (sin META_APP_SECRET = 403) es la que usa el webhook de Postgres, y la compatible sigue siendo la de redis", () => {
  assert.match(IDX, /function validSignatureEstricta\(req\) \{\n  if \(!META_APP_SECRET\) return false;/);
  assert.match(IDX, /firmaValida: validSignatureEstricta/);
  assert.match(IDX, /function validSignature\(req\) \{\n  if \(!META_APP_SECRET\) return true;/);
});

test("el handler de Redis es EXACTAMENTE el de antes (S4a, commit 4b30403): solo cambian la primera y la última línea", () => {
  let antes;
  try { antes = quitaCR(execFileSync("git", ["show", "4b30403:index.js"], { cwd: new URL(".", import.meta.url), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 20_000_000 })); }
  catch { return; }          // sin el historial (copia suelta del repo) no se puede comparar: las pruebas e2e en modo redis siguen cubriendo
  const cuerpoViejo = antes.slice(antes.indexOf('app.post("/webhook", async (req, res) => {') + 'app.post("/webhook", async (req, res) => {'.length, antes.indexOf("\n});\n\n// ─── PANEL WEB"));
  const ini = IDX.indexOf("const webhookRedis = async (req, res) => {") + "const webhookRedis = async (req, res) => {".length;
  const cuerpoNuevo = IDX.slice(ini, IDX.indexOf("\n};\n// ─── BOT_STORE=postgres"));
  assert.ok(cuerpoViejo.length > 10000, "no se extrajo el handler antiguo");
  assert.strictEqual(cuerpoNuevo, cuerpoViejo);
});
