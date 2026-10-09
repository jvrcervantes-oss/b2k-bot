// S5 del encargo del bot de Lawang (9-oct-2026): con BOT_CRM=on las citas van por [CITA:...] y las guarda la base.
// Lo que se prueba: el prompt de cierre deja de enseñar [APPT], apagado/sombra queda idéntico, ninguna cita pedida queda muda,
// y el aviso al owner cubre TODOS los resultados que la base puede devolver (se leen del SQL real, no de una lista copiada).
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { adaptaCierreACita, avisoCita, ejecutaCrm, creaTopes, extraeEtiquetas, citasIlegibles } from "./botcrm.js";

const SRC = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8").split(String.fromCharCode(13)).join("");
const plantilla = (nombre) => {
  const m = SRC.match(new RegExp("const " + nombre + " = `([\\s\\S]*?)\\n`;"));
  assert.ok(m, "no se encontró la plantilla " + nombre + " en index.js");
  return m[1];
};
// Lo que recibe el modelo de Lawang: su playbook trae gathering, middle y close propios (9-oct, hallazgo 1 de S8: antes cargaba los de tours)
const PB = JSON.parse(fs.readFileSync(new URL("./playbook-lawang.json", import.meta.url), "utf8"));
const PROMPT_LAWANG = plantilla("BASE_INSTRUCTIONS_HEAD") + PB.gathering + PB.middle + PB.close;

test("adaptaCierreACita: del prompt de cierre de Lawang no queda ni un APPT y aparece la etiqueta nueva", () => {
  assert.ok(/APPT/.test(PROMPT_LAWANG), "la prueba no tiene sentido si el original ya no menciona APPT");
  const { texto, restantes } = adaptaCierreACita(PROMPT_LAWANG);
  assert.strictEqual(restantes, 0);
  assert.ok(!/APPT/.test(texto));
  assert.match(texto, /\[CITA:llamada\|YYYY-MM-DDTHH:MM\|TZ\]/);
  assert.match(texto, /\[CITA:visita\|/);
  // el ejemplo que se le enseña al modelo lo entiende el parser real
  const ej = texto.match(/Example: (\[CITA:[^\]]+\])/)[1];
  assert.deepStrictEqual(extraeEtiquetas(ej).citas, [{ tipo: "visita", cuando: "2026-10-14T10:00", zona: "" }]);
});

test("adaptaCierreACita: es un reemplazo literal; un texto sin APPT sale idéntico", () => {
  const t = "hola [INTENT:booking] sin citas";
  assert.deepStrictEqual(adaptaCierreACita(t), { texto: t, restantes: 0 });
  assert.strictEqual(adaptaCierreACita("x [APPT:2026-01-01T10:00|raro]").restantes, 1);   // lo que no conoce lo cuenta, no lo oculta
});

test("BOT_CRM apagado: el prompt de cierre no cambia; en sombra Y en on el modelo solo ve [CITA] (9-oct, hallazgo 5 de S8)", () => {
  assert.match(SRC, /if \(CRM_EFECTIVO !== "off"\) \{\s*const adaptado = adaptaCierreACita\(BASE_INSTRUCTIONS\);/);
  assert.strictEqual((SRC.match(/adaptaCierreACita\(/g) || []).length, 1);   // un solo uso, el guardado
});

test("index.js: con CRM on la [APPT] no se guarda en Redis y avisa al owner; el panel viejo no escribe citas", () => {
  assert.match(SRC, /\(CRM_EFECTIVO === "on" && \(apptMatch \|\| crmIlegibles > 0\)\) \|\| \(CRM_EFECTIVO === "sombra" && crmIlegibles > 0 && !apptMatch\)\) \{[\s\S]*?etiqueta_antigua[\s\S]*?\} else if \(apptMatch\) \{\s*try \{\s*const appt = await createAppt/);
  assert.match(SRC, /app\.post\("\/admin\/api\/appts"[\s\S]*?if \(CRM_EFECTIVO === "on"\) return citasEnLaIntranet\(res\);/);
  assert.match(SRC, /app\.delete\("\/admin\/api\/appts\/:id"[\s\S]*?if \(CRM_EFECTIVO === "on"\) return citasEnLaIntranet\(res\);/);
  // y ningún otro sitio crea citas en Redis
  assert.strictEqual((SRC.match(/await createAppt\(/g) || []).length, 2);   // el webhook (rama else) y el POST del panel (ya cerrado con on)
});

// ── que ninguna cita pedida quede muda ───────────────────────────────────────────────────
const CITA = { tipo: "llamada", cuando: "2026-10-12T10:00", zona: "" };
test("ejecutaCrm: cada cita pedida deja una entrada con su resultado, también las que no llegan a la base", async () => {
  // alta ambigua → ninguna cita se intenta, pero queda dicho
  let h = await ejecutaCrm({ modo: "on", tel: "628111", msgId: "w", notas: [], citas: [CITA], llama: async () => "ambiguo" });
  assert.deepStrictEqual(h.filter((x) => x.accion === "lead_cita").map((x) => x.resultado), ["sin_alta:ambiguo"]);
  // zona no entendida
  h = await ejecutaCrm({ modo: "on", tel: "628111", msgId: "w", notas: [], citas: [{ ...CITA, zona: "CST" }], llama: async () => "existente" });
  assert.deepStrictEqual(h.filter((x) => x.accion === "lead_cita").map((x) => [x.resultado, x.zona]), [["zona_no_entendida", "CST"]]);
  // base caída
  h = await ejecutaCrm({ modo: "on", tel: "628111", msgId: "w", notas: [], citas: [CITA], llama: async (a) => { if (a === "lead_cita") throw new Error("503"); return "existente"; } });
  assert.deepStrictEqual(h.filter((x) => x.accion === "lead_cita").map((x) => x.resultado), ["error"]);
  // tope local
  const mem = new Map();
  const topes = creaTopes({ incr: async (k) => { mem.set(k, (mem.get(k) || 0) + 1); return mem.get(k); }, maxCitas: 1, hoy: () => "2026-10-09" });
  const llama = async (a) => (a === "lead_upsert" ? "existente" : "propuesta");
  await ejecutaCrm({ modo: "on", tel: "628111", msgId: "a", notas: [], citas: [CITA], llama, topes });
  h = await ejecutaCrm({ modo: "on", tel: "628111", msgId: "b", notas: [], citas: [CITA], llama, topes });
  assert.deepStrictEqual(h.filter((x) => x.accion === "lead_cita").map((x) => x.resultado), ["tope_local"]);
  // y la aceptada lleva los datos para el aviso
  h = await ejecutaCrm({ modo: "on", tel: "628111", msgId: "c", notas: [], citas: [{ ...CITA, tipo: "visita", zona: "AEST" }], llama: async (a) => (a === "lead_upsert" ? "creado" : "propuesta") });
  assert.deepStrictEqual(h.filter((x) => x.accion === "lead_cita").map((x) => [x.resultado, x.tipo, x.cuando, x.zona]), [["propuesta", "visita", "2026-10-12T10:00", "AEST"]]);
});

test("avisoCita: propuesta pide confirmar; cualquier otro resultado dice que NO se guardó y por qué", () => {
  const base = { proyecto: "Lawang", nombre: "Ana", tel: "34661569373" };
  const ok = avisoCita({ ...base, hecho: { accion: "lead_cita", resultado: "propuesta", tipo: "visita", cuando: "2026-10-12T10:00", zona: "" } });
  assert.match(ok, /VISITA PROPUESTA/); assert.match(ok, /Agenda de cierre/); assert.match(ok, /hora de Bali/); assert.match(ok, /34661569373/);
  const mal = avisoCita({ ...base, hecho: { accion: "lead_cita", resultado: "fuera_horario", tipo: "llamada", cuando: "2026-10-12T22:00", zona: "AEST" } });
  assert.match(mal, /CITA NO REGISTRADA/); assert.match(mal, /fuera del horario/); assert.match(mal, /AEST/);
  assert.match(avisoCita({ ...base, hecho: { accion: "lead_cita", resultado: "sin_alta:ambiguo", tipo: "llamada", cuando: "x" } }), /ambiguo/);
  assert.match(avisoCita({ ...base, hecho: { accion: "lead_cita", resultado: "inventado", tipo: "llamada", cuando: "x" } }), /motivo desconocido/);
  assert.strictEqual(avisoCita({ ...base, hecho: { accion: "lead_nota", resultado: "ok" } }), null);
  assert.strictEqual(avisoCita({ ...base, hecho: null }), null);
  // un nombre con etiquetas no puede colar nada en el aviso
  assert.ok(!/\[NOTA/.test(avisoCita({ ...base, nombre: "Ana [NOTA:x]", hecho: { accion: "lead_cita", resultado: "pasada", tipo: "llamada", cuando: "x" } })));
});

test("citasIlegibles: una [CITA] mal escrita se cuenta (si no, cleanReply la borra y la cita queda muda); las buenas no", () => {
  assert.strictEqual(citasIlegibles("ok [CITA:llamada|2026-10-12T10:00|AEST]"), 0);
  assert.strictEqual(citasIlegibles("[CITA:visita|2026-10-12T10:00]"), 0);
  assert.strictEqual(citasIlegibles("[CITA:llamada|2026-10-12T10:00:30]"), 1);
  assert.strictEqual(citasIlegibles("[CITA:llamada|2026-10-12 10:00]"), 1);
  assert.strictEqual(citasIlegibles("[CITA:llamada|2026-10-12T10:00|UNA ZONA MUY LARGA]"), 1);
  assert.strictEqual(citasIlegibles("sin etiquetas"), 0);
  const t = avisoCita({ proyecto: "L", nombre: "Ana\n*URGENTE*", tel: "1", hecho: { accion: "lead_cita", resultado: "etiqueta_ilegible", tipo: "llamada", cuando: "?" } });
  assert.match(t, /mal escrita/); assert.ok(!/\*URGENTE\*/.test(t) && !/Ana\n/.test(t));
  assert.match(SRC, /const crmIlegibles = CRM_EFECTIVO !== "off" \? citasIlegibles\(reply\) : 0;\s*[^\n]*\n\s*reply = cleanReply\(reply\)/);
});

const SQL_CITA = new URL("../../proyectos/Lawang/supabase/migrations/20261010080000_bot_catalogo_crm_s3.sql", import.meta.url);
test("avisoCita cubre TODOS los resultados que bot_lead_cita puede devolver (leídos del SQL real)", { skip: !fs.existsSync(SQL_CITA) && "el SQL de Lawang no está en este clon" }, () => {
  const sql = fs.readFileSync(SQL_CITA, "utf8");
  const cuerpo = sql.match(/create or replace function public\.bot_lead_cita[\s\S]*?end \$f\$;/)[0];
  const resultados = new Set([...cuerpo.matchAll(/return '(\w+)'/g)].map((m) => m[1]));
  for (const r of ["propuesta", "reprogramada", "fuera_horario", "pasada", "lejana", "sin_lead", "ambiguo", "tope", "ya_hay_cita", "fecha_invalida", "tipo_invalido", "telefono_invalido"]) {
    assert.ok(resultados.has(r), "el SQL ya no devuelve '" + r + "': actualizar la lista");
  }
  for (const r of resultados) {
    const t = avisoCita({ proyecto: "L", nombre: "A", tel: "1", hecho: { accion: "lead_cita", resultado: r, tipo: "llamada", cuando: "2026-10-12T10:00", zona: "" } });
    assert.ok(t && !/desconocido/.test(t), "sin aviso para el resultado '" + r + "'");
  }
});
