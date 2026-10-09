// S4a: caracterización de store/redis.js. Fija las claves, los TTL y el ORDEN de operaciones que el motor hacía
// antes de mover el código (index.js, commit e3fa3ee): si cambia una clave o se añade una llamada, falla.
// Con Redis (cliente falso que anota cada operación) y sin Redis (memoria de respaldo).
import test from "node:test";
import assert from "node:assert";

function clienteFalso() {
  const ops = [], kv = new Map(), listas = new Map(), zs = new Map(), sets = new Map(), ttls = new Map();
  const reg = (...a) => ops.push(a.join(" "));
  const c = {
    ops, kv,
    on() {}, async connect() {}, destroy() {},
    async get(k) { reg("get", k); return kv.has(k) ? kv.get(k) : null; },
    async set(k, v, o) { reg("set", k, o && o.NX ? "NX" : "", o && o.EX ? "EX" + o.EX : "");
      if (o && o.NX && kv.has(k)) return null; kv.set(k, String(v)); if (o && o.EX) ttls.set(k, o.EX); return "OK"; },
    async setEx(k, t, v) { reg("setEx", k, t); kv.set(k, String(v)); ttls.set(k, t); return "OK"; },
    async del(...ks) { reg("del", ...ks); ks.forEach((k) => kv.delete(k)); return ks.length; },
    async ttl(k) { reg("ttl", k); return ttls.has(k) ? ttls.get(k) : kv.has(k) ? -1 : -2; },
    async incr(k) { reg("incr", k); const n = Number(kv.get(k) || 0) + 1; kv.set(k, String(n)); return n; },
    async expire(k, t) { reg("expire", k, t); return 1; },
    async lPush(k, v) { reg("lPush", k); (listas.get(k) || listas.set(k, []).get(k)).unshift(v); },
    async rPop(k) { reg("rPop", k); return (listas.get(k) || []).pop() ?? null; },
    async lRem(k, n, v) { reg("lRem", k, n); const l = listas.get(k) || []; const i = l.indexOf(v); if (i >= 0) l.splice(i, 1); },
    async lRange(k, a, b) { reg("lRange", k, a, b); return (listas.get(k) || []).slice(a, b + 1); },
    async zAdd(k, { score, value }) { reg("zAdd", k, score); (zs.get(k) || zs.set(k, new Map()).get(k)).set(value, score); },
    async zRange(k, a, b, o) { reg("zRange", k, a, b, o && o.REV ? "REV" : ""); const m = [...(zs.get(k) || new Map())].sort((x, y) => x[1] - y[1]).map((x) => x[0]); return o && o.REV ? m.reverse() : m; },
    async zRem(k, v) { reg("zRem", k); (zs.get(k) || new Map()).delete(v); },
    async zCard(k) { reg("zCard", k); return (zs.get(k) || new Map()).size; },
    async sAdd(k, v) { reg("sAdd", k); (sets.get(k) || sets.set(k, new Set()).get(k)).add(v); },
    async sMembers(k) { reg("sMembers", k); return [...(sets.get(k) || [])]; },
    multi() { const q = []; const m = { set(k, v) { q.push(["set", k]); kv.set(k, v); return m; }, lPush(k, v) { q.push(["lPush", k]); (listas.get(k) || listas.set(k, []).get(k)).unshift(v); return m; },
      lTrim(k, a, b) { q.push(["lTrim", k, a, b]); return m; }, async exec() { reg("multi", ...q.map((x) => x.join(":"))); return []; } }; return m; },
  };
  return c;
}

// El almacén es un singleton por proceso: cada bloque de pruebas lo arranca en un proceso hijo no hace falta —
// initRedis puede llamarse otra vez y reemplaza el cliente (o lo deja a null).
const store = await import("./store/redis.js");

test("sin Redis: initRedis cae a RAM y las cosas se guardan y se leen", async () => {
  await store.initRedis({ url: "", projectName: "T" });
  assert.strictEqual(store.redisActivo(), false);
  assert.strictEqual(store.almacenNombre(), "ram");
  await store.saveConversation("1", Array.from({ length: 120 }, (_, i) => ({ role: "user", content: String(i) })));
  assert.strictEqual((await store.getConversation("1")).length, 100);       // tope de 100
  await store.setPaused("1", true); assert.strictEqual(await store.isPaused("1"), true);
  await store.optOutPoner("1"); assert.strictEqual(await store.optOutLeer("1"), true);
  assert.strictEqual(await store.alreadyProcessed("w1"), false); assert.strictEqual(await store.alreadyProcessed("w1"), true);
  assert.strictEqual(await store.testNotifYaAvisado("1"), false); assert.strictEqual(await store.testNotifYaAvisado("1"), true);
  assert.strictEqual(await store.incrTope("k"), 1); assert.strictEqual(await store.incrTope("k"), 2);
  await store.setPausedHumano("2", 0); assert.strictEqual(await store.isPaused("2"), true);
  await store.leadGuardar("1", { phone: "1", updatedAt: 5 }, 5);
  assert.strictEqual(await store.leadsContar(), 1);
  await store.leadBorrar("1");
  assert.strictEqual(await store.leadsContar(), 0);
  assert.deepStrictEqual(await store.getConversation("1"), []);            // el borrado definitivo limpia también la conversación
  assert.strictEqual(await store.isPaused("1"), false);
  assert.strictEqual((await store.unsubLeer()).size, 0);
});

test("con Redis: claves, TTL y orden de operaciones idénticos a los del motor antes de moverlo", async () => {
  const c = clienteFalso();
  await store.initRedis({ url: "redis://x", projectName: "T", crear: () => c });
  assert.strictEqual(store.redisActivo(), true);
  assert.strictEqual(store.almacenNombre(), "redis");
  const salto = () => { const o = c.ops.slice(); c.ops.length = 0; return o; };

  await store.saveConversation("62", [{ role: "user", content: "hi" }]);
  assert.deepStrictEqual(salto(), [`setEx conv:62 ${30 * 86400}`]);
  await store.getConversation("62");
  assert.deepStrictEqual(salto(), ["get conv:62"]);

  await store.setPaused("62", true); await store.setPaused("62", false); await store.isPaused("62");
  assert.deepStrictEqual(salto(), ["set paused:62  ", "del paused:62", "get paused:62"]);

  await store.optOutPoner("62"); await store.optOutLeer("62"); await store.optOutAckPoner("62"); await store.optOutAckLeer("62");
  assert.deepStrictEqual(salto(), ["set optout:62  ", "get optout:62", "set optoutack:62  ", "get optoutack:62"]);

  assert.strictEqual(await store.alreadyProcessed("wamid.A"), false);
  assert.strictEqual(await store.alreadyProcessed("wamid.A"), true);
  assert.deepStrictEqual(salto(), ["set wamid:wamid.A NX EX86400", "set wamid:wamid.A NX EX86400"]);

  await store.setInbound("62", 123); await store.getInbound("62");
  assert.deepStrictEqual(salto(), [`setEx inbound:62 ${30 * 86400}`, "get inbound:62"]);

  await store.setWaiting("62", true); await store.isWaiting("62");
  assert.deepStrictEqual(salto(), ["set waiting:62  ", "get waiting:62"]);

  // pausa por una persona: lee el TTL, y SOLO escribe si procede (cfg 0 = sin caducidad; ya pausado sin TTL → no se vuelve caducable)
  await store.setPausedHumano("62", 0);
  assert.deepStrictEqual(salto(), ["ttl paused:62", "set paused:62  "]);
  await store.setPausedHumano("62", 24);
  assert.deepStrictEqual(salto(), ["ttl paused:62"]);

  await store.leadGuardar("62", { phone: "62" }, 77);
  assert.deepStrictEqual(salto(), ["set lead:62  ", "zAdd leads_index 77"]);
  await store.getLead("62");
  assert.deepStrictEqual(salto(), ["get lead:62"]);
  await store.leadsListar();
  assert.deepStrictEqual(salto(), ["zRange leads_index 0 -1 REV", "get lead:62"]);
  await store.leadsContar();
  assert.deepStrictEqual(salto(), ["zCard leads_index"]);
  await store.leadBorrar("62");
  assert.deepStrictEqual(salto(), ["del lead:62 notes:62 status:62 conv:62 paused:62 waiting:62 inbound:62 followup:62 notified:62 lastlink:62", "zRem leads_index"]);

  const e = await store.escPush("62", "Ana", "¿precio?");
  assert.deepStrictEqual(salto(), ["lPush esc_queue"]);
  await store.escMapGuardar("wamid.N", e);
  assert.deepStrictEqual(salto(), [`setEx escmap:wamid.N ${7 * 86400}`]);
  const p = await store.escRutaPorCita("wamid.N");
  assert.strictEqual(p.customerPhone, "62");
  assert.deepStrictEqual(salto(), ["get escmap:wamid.N", "lRem esc_queue 1", "del escmap:wamid.N"]);
  assert.strictEqual(await store.escRutaPorCita(undefined), null);
  assert.deepStrictEqual(salto(), []);
  await store.escPop();
  assert.deepStrictEqual(salto(), ["rPop esc_queue"]);

  await store.incrTope("crm:x"); await store.incrTope("crm:x");
  assert.deepStrictEqual(salto(), ["incr crm:x", "expire crm:x 86400", "incr crm:x"]);   // el expire solo en la primera

  await store.cfgRawLeer(); await store.cfgGuardarConLog("{}", "{}"); await store.cfgLogRaw(20);
  assert.deepStrictEqual(salto(), ["get botcfg:v1", "multi set:botcfg:v1 lPush:botcfg:log lTrim:botcfg:log:0:49", "lRange botcfg:log 0 19"]);

  await store.testNotifYaAvisado("62"); await store.testNotifYaAvisado("62");
  assert.deepStrictEqual(salto(), ["get testnotif:62", `setEx testnotif:62 ${30 * 86400}`, "get testnotif:62"]);

  await store.setNotifiedLevel("62", "booking"); await store.getNotifiedLevel("62");
  assert.deepStrictEqual(salto(), [`setEx notified:62 ${30 * 86400}`, "get notified:62"]);

  await store.setWaBlocked(131042, "x"); await store.getWaBlocked(); await store.clearWaBlocked();
  assert.deepStrictEqual(salto(), [`setEx wa:blocked ${6 * 3600}`, "get wa:blocked", "del wa:blocked"]);

  await store.unsubAgregar("a@b.c"); await store.unsubLeer();
  assert.deepStrictEqual(salto(), ["sAdd unsub_emails", "sMembers unsub_emails"]);
});
