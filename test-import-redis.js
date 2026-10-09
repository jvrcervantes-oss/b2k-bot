// S5 (LAW-507): el importador Redis → Postgres con un Redis FALSO. Sin red, sin datos reales.
import test from "node:test";
import assert from "node:assert";
import { clasificarClave, enmascarar, inventario, leerTodo, importar, cuadre, digestMensajes, limpia, GRUPOS } from "./import_redis.js";

const AHORA = 1790000000000;
const T1 = "628111111111", T2 = "628222222222", T3 = "628333333333";

// Lector falso: kv = Map clave → {tipo, valor, pttl}
function lectorFalso(claves, { dbs = [{ db: 0 }], dbsize } = {}) {
  const m = new Map(Object.entries(claves));
  return {
    async *escanear() { for (const k of m.keys()) yield k; },
    async tipo(k) { return m.get(k).tipo || "string"; },
    async pttl(k) { return m.get(k).pttl ?? -1; },
    async get(k) { return m.get(k).v; },
    async lista(k) { return m.get(k).v; },
    async dbsize() { return dbsize ?? m.size; },
    async keyspace() { return { dbs: dbs.map((d) => ({ db: d.db, keys: m.size })) }; },
  };
}
const J = (o) => JSON.stringify(o);
const mundo = () => ({
  [`conv:${T1}`]: { v: J([{ role: "user", content: "Hola", ts: AHORA - 5000, wamid: "wamid.A" }, { role: "assistant", content: "Hi!  ", ts: AHORA - 4000, by: "bot" }, { role: "assistant", content: "te llamo", ts: AHORA - 3000, by: "human", byUser: "ana@x.com" }]), pttl: 86400000 },
  [`conv:${T2}`]: { v: J([{ role: "user", content: "stop", ts: AHORA - 100 }]), pttl: 86400000 },
  [`conv:sim:abc123`]: { v: "[]" },
  [`lead:${T1}`]: { v: J({ phone: T1, name: "Ana", intent: "interested", lastMessage: "te llamo", lastBy: "human", createdAt: AHORA - 9000, updatedAt: AHORA - 3000, history: [{ type: "created" }], nextFollowUp: 5, extra: "ficha" }) },
  [`lead:${T2}`]: { v: J({ phone: T2, name: "Bo", lastBy: "client", createdAt: AHORA - 200, updatedAt: AHORA - 100 }) },
  leads_index: { tipo: "zset", v: null },
  [`paused:${T1}`]: { v: "1", pttl: 3600000 },
  [`paused:${T3}`]: { v: "1", pttl: -1 },
  [`waiting:${T1}`]: { v: "1" },
  [`inbound:${T1}`]: { v: String(AHORA - 5000), pttl: 86400000 },
  [`optout:${T2}`]: { v: String(AHORA - 90) },
  [`optoutack:${T2}`]: { v: "1" },
  [`notified:${T1}`]: { v: "booking", pttl: 86400000 },
  [`testnotif:${T1}`]: { v: "1", pttl: 86400000 },
  [`followup:${T1}`]: { v: "2", pttl: 86400000 },
  esc_queue: { tipo: "list", v: [J({ customerPhone: T1, customerName: "Ana", question: "¿precio?" }), J({ customerPhone: T3, customerName: "Cy", question: "otra" })] },
  "escmap:wamid.AVISO": { v: J({ customerPhone: T1, customerName: "Ana", question: "¿precio?" }), pttl: 6 * 86400000 },
  "botcfg:v1": { v: J({ extra: "x", bienvenida: "hola", pausaHoras: 12, updatedAt: AHORA - 10, updatedBy: "a@b.c" }) },
  "botcfg:log": { tipo: "list", v: [J({ ts: AHORA - 10, by: "a@b.c", prev: { extra: "v1", bienvenida: "", pausaHoras: 0 }, next: { extra: "x", bienvenida: "hola", pausaHoras: 12 } }), J({ ts: AHORA - 20, by: "z", prev: { extra: "", bienvenida: "", pausaHoras: 0 }, next: { extra: "v1", bienvenida: "", pausaHoras: 0 } })] },
  [`wamid:wamid.OLD`]: { v: "1", pttl: 1000 },
  canned: { v: "[]" },
});
// el escmap guarda el MISMO string que la cola
{ const w = mundo(); }

test("clasificador: el orden de los prefijos importa y todo grupo tiene destino", () => {
  assert.equal(clasificarClave("conv:sim:xyz").g, "conv_sim");
  assert.equal(clasificarClave("conv:6281").g, "conv");
  assert.equal(clasificarClave("optoutack:6281").g, "optoutack");
  assert.equal(clasificarClave("optout:6281").g, "optout");
  assert.equal(clasificarClave("botcfg:log").g, "botcfg_log");
  assert.equal(clasificarClave("botcfg:v1").g, "botcfg");
  assert.equal(clasificarClave("algo:raro"), null);
  assert.equal(clasificarClave("xconv:1"), null, "ancla al inicio");
  for (const g of GRUPOS) assert.ok(g.destino && g.accion);
});

test("enmascarar: ni un teléfono ni un id largo sobreviven en la forma", () => {
  assert.equal(enmascarar("raro:628111111111:x"), "raro:<x>:x");
  assert.equal(enmascarar("foo:+62-812-3456-7890"), "foo:<x>");
  assert.equal(enmascarar("x:maria@mail.com"), "x:<x>");
  assert.ok(!/[0-9]{2}/.test(enmascarar("k:12345678901234:AbCdEfGhIjKlMnOpQr")));
});

test("inventario: solo conteos; una clave desconocida bloquea S9 y sale enmascarada", async () => {
  const k = mundo(); k[`raro:${T1}`] = { v: "secreto-no-debe-salir" };
  const inv = await inventario(lectorFalso(k));
  const txt = JSON.stringify(inv);
  assert.ok(!txt.includes(T1) && !txt.includes(T2) && !txt.includes("secreto-no-debe-salir") && !txt.includes("Hola"), "el inventario no debe llevar teléfonos ni valores");
  assert.equal(inv.sin_clasificar, 1);
  assert.equal(inv.bloquea_s9, true);
  assert.deepEqual(Object.keys(inv.desconocidas), ["raro:<x>"]);
  assert.equal(inv.grupos.conv.n, 2);
  assert.equal(inv.grupos.paused.sin_ttl, 1);
  assert.equal(inv.grupos.paused.con_ttl, 1);
  assert.equal(inv.mensajes_conv.total, 4);
  assert.deepEqual(inv.a_eliminar_con_datos, [{ grupo: "canned", n: 1 }]);
});

test("inventario: sin desconocidas y cuadrando con DBSIZE no bloquea; una 2ª base o un DBSIZE distinto sí", async () => {
  const ok = await inventario(lectorFalso(mundo()));
  assert.equal(ok.sin_clasificar, 0);
  assert.equal(ok.cuadra_con_dbsize, true);
  assert.equal(ok.bloquea_s9, false);
  const dosBases = await inventario(lectorFalso(mundo(), { dbs: [{ db: 0 }, { db: 1 }] }));
  assert.equal(dosBases.bloquea_s9, true);
  const dist = await inventario(lectorFalso(mundo(), { dbsize: 999 }));
  assert.equal(dist.cuadra_con_dbsize, false);
});

test("inventario: un conv: ilegible bloquea y no tumba el recorrido", async () => {
  const k = mundo(); k[`conv:${T3}`] = { v: "{no json" };
  const inv = await inventario(lectorFalso(k));
  assert.equal(inv.conv_ilegibles, 1);
  assert.equal(inv.bloquea_s9, true);
});

test("leerTodo: baja, pausa con PTTL, escalaciones y config", async () => {
  const l = await leerTodo(lectorFalso(mundo()), { ahora: AHORA });
  assert.equal(l.chats.length, 3);
  const c1 = l.chats.find((c) => c.tel === T1), c2 = l.chats.find((c) => c.tel === T2), c3 = l.chats.find((c) => c.tel === T3);
  // T1: pausa que caduca en AHORA + 1 h; no es baja
  assert.equal(c1.chat.pausado, true);
  assert.equal(c1.chat.pausa_hasta_ms, AHORA + 3600000);
  assert.equal(c1.chat.baja_ms, null);
  assert.equal(c1.chat.aviso_nivel, 2);
  assert.equal(c1.chat.aviso_testing, true);
  assert.equal(c1.chat.seguimientos, 2);
  assert.equal(c1.chat.esperando, true);
  assert.equal(c1.chat.ultimo_por, "humano");
  assert.equal(c1.mensajes.length, 3);
  assert.equal(c1.mensajes[1].contenido, "Hi!", "se recorta solo espacios, como btrim");
  assert.equal(c1.mensajes[2].por, "humano");
  assert.equal(c1.mensajes[2].por_usuario, "ana@x.com");
  assert.equal(c1.mensajes[0].rol, "user");
  // T2: baja con acuse → pausa que no caduca
  assert.equal(c2.chat.baja_ms, AHORA - 90);
  assert.equal(c2.chat.baja_acuse, true);
  assert.equal(c2.chat.pausado, true);
  assert.equal(c2.chat.pausa_hasta_ms, null);
  // T3: solo pausa indefinida (PTTL -1), sin conv ni lead
  assert.equal(c3.chat.pausado, true);
  assert.equal(c3.chat.pausa_hasta_ms, null);
  assert.equal(c3.mensajes.length, 0);
  // escalaciones: la de T1 enlaza con su escmap; la de T3 no tiene mapa
  assert.equal(c1.escalaciones.length, 1);
  assert.equal(c1.escalaciones[0].aviso_wamid, "wamid.AVISO");
  assert.equal(c3.escalaciones[0].aviso_wamid, null);
  assert.equal(l.anomalias.cola_sin_escmap, 1);
  // config: camelCase → snake_case; el log más viejo primero
  assert.equal(l.config.pausa_horas, 12);
  assert.equal(l.config_log.length, 2);
  assert.equal(l.config_log[0].next.extra, "v1");
  assert.equal(l.config_log[1].prev.extra, "v1");
  // lo que se descarta a propósito se CUENTA
  assert.equal(l.descartes.lead_history_eventos, 1);
  assert.equal(l.descartes.lead_nextFollowUp, 1);
  assert.equal(l.descartes.lead_ficha_enriquecida, 1);
  assert.ok(l.descartes.claves_ram_o_eliminadas >= 3);
});

test("leerTodo: una clave que caduca entre el SCAN y la lectura (PTTL -2) se cuenta aparte", async () => {
  const k = mundo(); k[`paused:${T2}`] = { v: "1", pttl: -2 };
  const l = await leerTodo(lectorFalso(k), { ahora: AHORA });
  assert.equal(l.anomalias.clave_caducada_al_leer, 1);
});

test("leerTodo: una baja sin fecha válida SIGUE siendo una baja; un teléfono con formato raro se normaliza a dígitos", async () => {
  const l = await leerTodo(lectorFalso({ "optout:+62 811-111-1111": { v: "basura" }, "optout:12": { v: "1" } }), { ahora: AHORA });
  assert.equal(l.chats.length, 1);
  assert.equal(l.chats[0].tel, "628111111111");
  assert.equal(l.chats[0].chat.baja_ms, AHORA);
  assert.equal(l.anomalias.tel_invalido, 1, "un teléfono irrecuperable se cuenta, no se pierde en silencio");
  assert.equal(l.anomalias.tel_normalizado_distinto, 1);
});

test("leerTodo: media solo {tipo,id}; sin id se descarta y se cuenta; nunca una URL", async () => {
  const k = { [`conv:${T1}`]: { v: J([{ role: "assistant", content: "x", ts: AHORA, by: "bot", media: { type: "image", url: "https://x/y.jpg" } }, { role: "user", content: "foto", ts: AHORA + 1, media: { type: "image", id: "MID1" } }]) } };
  const l = await leerTodo(lectorFalso(k), { ahora: AHORA });
  const m = l.chats[0].mensajes;
  assert.equal(m[0].media, null);
  assert.deepEqual(m[1].media, { tipo: "image", id: "MID1" });
  assert.equal(l.descartes.mensajes_media_sin_id, 1);
  assert.ok(!JSON.stringify(l).includes("https://"));
});

test("leerTodo: un ts ausente se rellena de forma determinista y el orden queda por ts", async () => {
  const k = { [`conv:${T1}`]: { v: J([{ role: "user", content: "a" }, { role: "assistant", content: "b", by: "bot" }]) }, [`lead:${T1}`]: { v: J({ createdAt: AHORA - 1000 }) } };
  const a = await leerTodo(lectorFalso(k), { ahora: AHORA });
  const b = await leerTodo(lectorFalso(k), { ahora: AHORA + 99999 });
  assert.deepEqual(a.chats[0].mensajes.map((m) => m.ts_ms), [AHORA - 1000, AHORA - 999]);
  assert.deepEqual(digestMensajes(a.chats[0].mensajes), digestMensajes(b.chats[0].mensajes));
});

test("limpia: misma forma que _bot_limpia (controles fuera, solo espacios recortados, corte por caracteres)", () => {
  assert.equal(limpia("  hola\x07\n", 50), "hola\n");
  assert.equal(limpia("😀😀😀", 2), "😀😀");
  assert.equal(limpia(null, 5), "");
});

// ── Transporte falso con la semántica de la función SQL (solo añade restricciones, repetible) ──
function pgFalso() {
  const chats = new Map();
  const t = {
    chats, llamadas: 0,
    async chat(p) {
      t.llamadas++;
      const c = chats.get(p.tel) || { msgs: [], pausado: false, pausa_hasta: null, baja: null, ultimo_entrante: null, aviso: 0, esc: 0, claves: new Set() };
      const antes = c.msgs.length;
      for (const m of p.mensajes) { const k = `${m.ts_ms}|${m.rol}|${m.contenido}`; if (!c.claves.has(k)) { c.claves.add(k); c.msgs.push(m); } }
      c.msgs.sort((a, b) => a.ts_ms - b.ts_ms);
      if (p.chat.pausado) { c.pausa_hasta = c.pausado && c.pausa_hasta === null ? null : (p.chat.pausa_hasta_ms === null ? null : Math.max(c.pausa_hasta || 0, p.chat.pausa_hasta_ms)); c.pausado = true; }
      if (p.chat.baja_ms !== null) { c.baja = c.baja ?? p.chat.baja_ms; c.pausado = true; c.pausa_hasta = null; }
      c.ultimo_entrante = Math.max(c.ultimo_entrante || 0, p.chat.ultimo_entrante_ms || 0) || null;
      c.aviso = Math.max(c.aviso, p.chat.aviso_nivel);
      c.esc = Math.max(c.esc, p.escalaciones.length);
      chats.set(p.tel, c);
      return { ok: true, mensajes: { insertados: c.msgs.length - antes } };
    },
    async config(p) { return { ok: true, resultado: "importada" }; },
    async cuadre(tel) {
      const c = chats.get(tel); if (!c) return { existe: false };
      return { existe: true, n_mensajes: c.msgs.length, hash_mensajes: digestMensajes(c.msgs), ultimo_entrante_ms: c.ultimo_entrante, pausado: c.pausado, pausa_hasta_ms: c.pausa_hasta, baja: c.baja !== null, aviso_nivel: c.aviso, escalaciones_abiertas: c.esc };
    },
  };
  return t;
}

test("importar: cuadra por completo, es repetible y el informe no lleva teléfonos ni contenido", async () => {
  const pg = pgFalso();
  const inf = await importar(lectorFalso(mundo()), pg, { ahora: AHORA });
  assert.equal(inf.enviados, 3);
  assert.equal(inf.fallos_envio, 0);
  assert.equal(inf.cuadre.ninguna_baja_ni_pausa_vigente_falta, true);
  assert.equal(inf.cuadre.bajas.en_redis, 1);
  assert.equal(inf.cuadre.pausas.vigentes_en_redis, 2);
  for (const campo of Object.values(inf.cuadre.campos)) assert.equal(campo.difieren, 0);
  const txt = JSON.stringify(inf);
  for (const prohibido of [T1, T2, T3, "Hola", "ana@x.com", "¿precio?"]) assert.ok(!txt.includes(prohibido), "el informe filtra: " + prohibido);
  // segunda pasada: nada se duplica
  const antes = pg.chats.get(T1).msgs.length;
  const inf2 = await importar(lectorFalso(mundo()), pg, { ahora: AHORA });
  assert.equal(pg.chats.get(T1).msgs.length, antes);
  assert.equal(inf2.cuadre.ninguna_baja_ni_pausa_vigente_falta, true);
});

test("cuadre: una baja que falta en Postgres se ve, por ordinal y en el veredicto", async () => {
  const pg = pgFalso();
  const lectura = await leerTodo(lectorFalso(mundo()), { ahora: AHORA });
  for (const p of lectura.chats) await pg.chat(p);
  pg.chats.get(T2).baja = null;                                          // alguien (o un bug) la quita
  const r = await cuadre(lectura, pg);
  assert.equal(r.bajas.faltan, 1);
  assert.equal(r.ninguna_baja_ni_pausa_vigente_falta, false);
  assert.deepEqual(r.campos.baja.ordinales, [1]);                        // T2 es el 2.º por teléfono
  assert.ok(!JSON.stringify(r).includes(T2));
});

test("cuadre: una pausa con caducidad que Postgres acorta, o que no existe, cuenta como falta", async () => {
  const pg = pgFalso();
  const lectura = await leerTodo(lectorFalso(mundo()), { ahora: AHORA });
  for (const p of lectura.chats) await pg.chat(p);
  pg.chats.get(T1).pausa_hasta = AHORA + 1000;                           // 1 h → 1 s
  assert.equal((await cuadre(lectura, pg)).pausas.faltan, 1);
  pg.chats.get(T1).pausa_hasta = AHORA + 3600000;
  pg.chats.get(T3).pausa_hasta = AHORA + 5;                              // indefinida → con caducidad
  assert.equal((await cuadre(lectura, pg)).pausas.faltan, 1);
});

test("cuadre: un teléfono sin fila en Postgres cuenta todo como diferencia", async () => {
  const pg = pgFalso();
  const lectura = await leerTodo(lectorFalso(mundo()), { ahora: AHORA });
  const r = await cuadre(lectura, pg);
  assert.equal(r.telefonos_sin_fila_en_postgres, 3);
  assert.equal(r.ninguna_baja_ni_pausa_vigente_falta, false);
});

test("importar dryRun: no envía nada y cuenta lo que enviaría", async () => {
  const pg = pgFalso();
  const inf = await importar(lectorFalso(mundo()), pg, { ahora: AHORA, dryRun: true });
  assert.equal(pg.llamadas, 0);
  assert.equal(inf.telefonos, 3);
  assert.equal(inf.mensajes, 4);
  assert.equal(inf.bajas, 1);
  assert.equal(inf.pausas_vigentes, 2);
});

test("importar: un fallo de red en un teléfono no tumba a los demás y se cuenta", async () => {
  const pg = pgFalso();
  const orig = pg.chat; let n = 0;
  pg.chat = async (p) => { if (++n === 2) throw new Error("red"); return orig(p); };
  const inf = await importar(lectorFalso(mundo()), pg, { ahora: AHORA });
  assert.equal(inf.fallos_envio, 1);
  assert.equal(inf.enviados, 2);
  assert.equal(inf.cuadre.ninguna_baja_ni_pausa_vigente_falta, false, "un teléfono no importado no puede dar el visto bueno");
});

test("lectorImportacion (store/redis.js): sin Redis es null; con Redis solo lee (ninguna escritura) y entiende SCAN/INFO", async () => {
  const store = await import("./store/redis.js");
  await store.initRedis({ url: "", projectName: "T" });
  assert.equal(store.lectorImportacion(), null);
  const ops = [];
  const datos = new Map([["conv:628111111111", "[]"], ["paused:628111111111", "1"]]);
  const falso = {
    on() {}, async connect() {}, destroy() {},
    async *scanIterator() { for (const k of datos.keys()) yield k; },
    async type() { ops.push("type"); return "string"; }, async pTTL() { ops.push("pTTL"); return -1; },
    async get(k) { ops.push("get"); return datos.get(k); }, async lRange() { ops.push("lRange"); return []; },
    async dbSize() { return datos.size; }, async info() { return "# Keyspace\r\ndb0:keys=2,expires=0,avg_ttl=0\r\n"; },
    async set() { throw new Error("ESCRITURA"); }, async setEx() { throw new Error("ESCRITURA"); }, async del() { throw new Error("ESCRITURA"); },
  };
  await store.initRedis({ url: "redis://falso", projectName: "T", crear: () => falso });
  const l = store.lectorImportacion();
  const inv = await inventario(l);
  assert.equal(inv.claves_escaneadas, 2);
  assert.equal(inv.cuadra_con_dbsize, true);
  assert.deepEqual(inv.keyspace.dbs, [{ db: 0, keys: 2 }]);
  assert.equal(inv.bloquea_s9, false);
  await store.initRedis({ url: "", projectName: "T" });             // deja el almacén como estaba
});

test("una baja o pausa cuyo teléfono no se lee NO desaparece en silencio: el veredicto pasa a falso", async () => {
  const k = mundo(); k["optout:123"] = { v: String(AHORA) }; k["paused:+"] = { v: "1" };
  const pg = pgFalso();
  const inf = await importar(lectorFalso(k), pg, { ahora: AHORA });
  assert.equal(inf.cuadre.bajas_sin_telefono, 1);
  assert.equal(inf.cuadre.pausas_sin_telefono, 1);
  assert.equal(inf.cuadre.ninguna_baja_ni_pausa_vigente_falta, false);
});

test("limpia quita también NUL", () => { assert.equal(limpia("a\x00b", 10), "ab"); });
