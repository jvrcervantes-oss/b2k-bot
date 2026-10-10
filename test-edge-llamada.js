// LAW-507: catalogo/CRM -> edge con x-region; el reintento sale sin ella. Sin red.
import test from "node:test";
import assert from "node:assert";
import { creaLlamaEdge } from "./edge_llamada.js";

const httpDe = (resp) => { const llamadas = []; return { llamadas, post: async (u, c, cfg) => { llamadas.push({ u, cfg }); const r = resp.length > 1 ? resp.shift() : resp[0]; if (r instanceof Error) throw r; return r; } }; };
const ok = { status: 200, data: { ok: true, x: 1 } };

test("con region: primer intento lleva x-region; error de red o 5xx -> un reintento SIN ella", async () => {
  for (const fallo of [new Error("ECONNRESET"), { status: 503, data: {} }]) {
    const http = httpDe([fallo, ok]);
    const r = await creaLlamaEdge({ url: "https://x/f", region: "ap-southeast-1", http })("catalogo", "S", {});
    assert.equal(r.x, 1);
    assert.equal(http.llamadas.length, 2);
    assert.equal(http.llamadas[0].cfg.headers["x-region"], "ap-southeast-1");
    assert.ok(!("x-region" in http.llamadas[1].cfg.headers));
    assert.equal(http.llamadas[1].cfg.headers["X-Bot-Secret"], "S");
  }
});
test("4xx no se reintenta; sin region no hay reintento", async () => {
  const a = httpDe([{ status: 401, data: {} }]);
  await assert.rejects(creaLlamaEdge({ url: "https://x/f", region: "ap-southeast-1", http: a })("crm", "S", {}), /HTTP 401/);
  assert.equal(a.llamadas.length, 1);
  const b = httpDe([new Error("red")]);
  await assert.rejects(creaLlamaEdge({ url: "https://x/f", http: b })("crm", "S", {}), /red/);
  assert.equal(b.llamadas.length, 1);
  const c = httpDe([{ status: 502, data: {} }]);
  await assert.rejects(creaLlamaEdge({ url: "https://x/f", http: c })("crm", "S", {}), /HTTP 502/);
  assert.equal(c.llamadas.length, 1);
});
test("si tambien falla el reintento, error sin volcar cuerpo", async () => {
  const http = httpDe([{ status: 500, data: { secreto: "zzz" } }]);
  await assert.rejects(creaLlamaEdge({ url: "https://x/f", region: "ap-southeast-1", http })("crm", "S", {}), (e) => /HTTP 500/.test(e.message) && !/zzz/.test(e.message));
  assert.equal(http.llamadas.length, 2);
});
