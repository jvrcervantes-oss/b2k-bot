// LAW-507 (revisión previa #248): contador de latencia de la edge. Reloj inyectado; sin red.
import test from "node:test";
import assert from "node:assert";
import { creaLatencia } from "./latencia.js";
import { creaPg } from "./store/postgres.js";

const reloj = () => { let t = 1000; const r = () => t; r.avanza = (ms) => { t += ms; }; return r; };
const mk = () => { const r = reloj(); return { r, l: creaLatencia({ reloj: r, ahora: () => new Date("2026-10-10T00:00:00Z") }) }; };

test("p50/p95/max solo con éxitos; con menos de 20 muestras el p95 es null", () => {
  const { l } = mk();
  for (let i = 1; i <= 19; i++) l.registra({ accion: "turno_estado", ms: i * 10, ok: true });
  l.registra({ accion: "turno_estado", ms: 9999, ok: false, tipo: "timeout" });          // un fallo no entra en los percentiles
  const a = l.instantanea().por_accion.turno_estado;
  assert.strictEqual(a.fallos.timeout, 1);
  const total = a.caliente.n + a.fria.n;
  assert.strictEqual(total, 19);
  assert.strictEqual(a.caliente.p95, null, "n<20 no publica p95");
  assert.ok(a.caliente.max <= 190);
});

test("p95 con ≥20 muestras; frío y caliente por separado (>60 s sin llamadas)", () => {
  const { r, l } = mk();
  l.registra({ accion: "turno_estado", ms: 900, ok: true });          // primera tras arranque = fría
  for (let i = 1; i <= 20; i++) { r.avanza(1000); l.registra({ accion: "turno_estado", ms: i, ok: true }); }
  let a = l.instantanea().por_accion.turno_estado;
  assert.deepStrictEqual([a.fria.n, a.caliente.n], [1, 20]);
  assert.strictEqual(a.caliente.p95, 19);
  r.avanza(61_000);
  l.registra({ accion: "turno_estado", ms: 500, ok: true });
  a = l.instantanea().por_accion.turno_estado;
  assert.strictEqual(a.fria.n, 2, "tras >60 s en silencio la llamada cuenta como fría");
});

test("negativos y NaN se descartan; una acción desconocida no rompe nada", () => {
  const { l } = mk();
  l.registra({ accion: "x", ms: -5, ok: true });
  l.registra({ accion: "x", ms: NaN, ok: true });
  l.registra({ accion: undefined, ms: 5, ok: true });
  assert.deepStrictEqual(l.instantanea().por_accion, {});
});

test("el turno acumula el coste de la edge de mensaje_recibir a turno_cerrar y se publica al cerrar", async () => {
  const { l } = mk();
  await l.enTurno(async () => {
    l.registra({ accion: "mensaje_recibir", ms: 100, ok: true });
    await new Promise((r) => setImmediate(r));
    l.registra({ accion: "turno_estado", ms: 150, ok: true });
    l.registra({ accion: "turno_cerrar", ms: 120, ok: true });
  });
  l.registra({ accion: "turno_estado", ms: 50, ok: true });                    // fuera de un turno: no se suma a ninguno
  const t = l.instantanea().turno;
  assert.deepStrictEqual([t.n, t.max], [1, 370]);
});

test("dos turnos a la vez no se mezclan", async () => {
  const { l } = mk();
  const turno = (ms) => l.enTurno(async () => {
    l.registra({ accion: "mensaje_recibir", ms, ok: true });
    await new Promise((r) => setTimeout(r, 5));
    l.registra({ accion: "turno_cerrar", ms, ok: true });
  });
  await Promise.all([turno(100), turno(300)]);
  const t = l.instantanea().turno;
  assert.strictEqual(t.n, 2);
  assert.strictEqual(t.max, 600);
});

test("la línea del log y la instantánea no llevan datos del cliente", () => {
  const { l } = mk();
  l.registra({ accion: "turno_estado", ms: 10, ok: true });
  assert.match(l.linea(), /^latencia edge desde 2026-10-10/);
  assert.ok(!/\d{8,}/.test(JSON.stringify(l.instantanea()) + l.linea()), "ni teléfonos ni wamid");
});

// ── integración con el cliente de la edge ──
const SEC = { estado: "s1", recordatorio: "s2" };
const ok = (o) => ({ status: 200, data: { ok: true, ...o } });
function cli(respuestas) {
  const { r, l } = mk();
  const post = async () => { r.avanza(40); const x = respuestas.length > 1 ? respuestas.shift() : respuestas[0]; if (x instanceof Error) throw x; return x; };
  return { l, pg: creaPg({ url: "https://x/functions/v1/bot-api", secretos: SEC, post, pausaReintentoMs: 1, latencia: l }) };
}

test("creaPg mide cada llamada; la pausa entre reintentos no cuenta; un 429 cuenta como éxito", async () => {
  const { l, pg } = cli([{ status: 502, data: {} }, ok({ baja: false })]);
  await pg.estado({ tel: "6281234567890" });
  let a = l.instantanea().por_accion.turno_estado;
  assert.strictEqual(a.fria.n + a.caliente.n, 1);
  assert.strictEqual(a.fria.max, 80, "dos intentos de 40 ms, sin la pausa");
  const c2 = cli([{ status: 429, data: {} }]);
  await c2.pg.recibir({ tel: "6281234567890", wamid: "w", mensaje: {} });
  a = c2.l.instantanea().por_accion.mensaje_recibir;
  assert.strictEqual(a.fria.n + a.caliente.n, 1);
});

test("creaPg: los fallos se cuentan por tipo y no entran en los percentiles", async () => {
  const e = Object.assign(new Error("boom"), { code: "ECONNABORTED" });
  const { l, pg } = cli([e]);
  await assert.rejects(pg.estado({ tel: "6281234567890" }));
  const a = l.instantanea().por_accion.turno_estado;
  assert.strictEqual(a.fallos.timeout, 1);
  assert.strictEqual(a.fria.n + a.caliente.n, 0);
});

test("un contador que lanza no afecta a la llamada", async () => {
  const roto = { reloj: () => { throw new Error("reloj"); }, registra: () => { throw new Error("registra"); } };
  const pg = creaPg({ url: "https://x/f", secretos: SEC, post: async () => ok({ baja: false }), latencia: roto });
  assert.deepStrictEqual(await pg.estado({ tel: "6281234567890" }), { baja: false });
});
