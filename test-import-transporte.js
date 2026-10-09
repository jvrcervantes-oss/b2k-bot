// S5 fase B (LAW-507): el transporte a /importar con un http FALSO. Sin red.
import test from "node:test";
import assert from "node:assert";
import { creaTransporte } from "./import_transporte.js";

const sinEspera = () => { const esperas = []; const f = async (ms) => { esperas.push(ms); }; f.esperas = esperas; return f; };
function httpDe(respuestas) {
  const llamadas = [];
  return { llamadas, post: async (url, cuerpo, cfg) => { llamadas.push({ url, cuerpo, cfg }); const r = respuestas.shift(); if (r instanceof Error) throw r; return r; } };
}
const ok = (data) => ({ status: 200, data: { ok: true, ...data }, headers: {} });
const mk = (resp, extra = {}) => { const http = httpDe(resp); const espera = sinEspera(); return { http, espera, t: creaTransporte({ url: "https://x.supabase.co/functions/v1/bot-api/", secreto: "S3CRET", http, espera, ...extra }) }; };

test("sin URL o sin secreto no hay transporte", () => {
  assert.equal(creaTransporte({ url: "", secreto: "x" }), null);
  assert.equal(creaTransporte({ url: "https://a", secreto: "" }), null);
});

test("chat: URL /importar sin barra doble, secreto en cabecera, acción y campos del contrato, timeout puesto", async () => {
  const { http, t } = mk([ok({ accion: "chat", chat: "creado" })]);
  const r = await t.chat({ tel: "628111", chat: { a: 1 }, mensajes: [], escalaciones: [], extra: "no viaja" });
  assert.equal(r.ok, true);
  const c = http.llamadas[0];
  assert.equal(c.url, "https://x.supabase.co/functions/v1/bot-api/importar");
  assert.equal(c.cfg.headers["X-Bot-Secret"], "S3CRET");
  assert.deepStrictEqual(Object.keys(c.cuerpo).sort(), ["accion", "chat", "escalaciones", "mensajes", "tel"]);
  assert.equal(c.cuerpo.accion, "chat");
  assert.ok(c.cfg.timeout > 0);
});

test("config y cuadre usan su acción y solo sus campos", async () => {
  const { http, t } = mk([ok({ resultado: "importada" }), ok({ existe: true, n_mensajes: 2 })]);
  await t.config({ config: { x: 1 }, log: [], otro: 1 });
  const d = await t.cuadre("628111");
  assert.equal(d.n_mensajes, 2);
  assert.deepStrictEqual(Object.keys(http.llamadas[0].cuerpo).sort(), ["accion", "config", "log"]);
  assert.deepStrictEqual(http.llamadas[1].cuerpo, { accion: "cuadre", tel: "628111" });
});

test("error de red: UN reintento y luego falla sin volcar nada", async () => {
  const a = mk([new Error("ECONNRESET 628111999 secreto"), ok({ accion: "chat" })]);
  assert.equal((await a.t.chat({ tel: "1", chat: {}, mensajes: [], escalaciones: [] })).ok, true);
  assert.equal(a.http.llamadas.length, 2);
  const b = mk([new Error("x 628111999"), new Error("y")]);
  await assert.rejects(b.t.chat({ tel: "628111999", chat: {}, mensajes: [], escalaciones: [] }), (e) => !/628111999|S3CRET/.test(e.message) && /sin respuesta/.test(e.message));
  assert.equal(b.http.llamadas.length, 2);
});

test("5xx: un reintento; 4xx: ninguno", async () => {
  const a = mk([{ status: 502, data: {}, headers: {} }, ok({})]);
  await a.t.cuadre("1"); assert.equal(a.http.llamadas.length, 2);
  const b = mk([{ status: 502, data: {}, headers: {} }, { status: 500, data: {}, headers: {} }]);
  await assert.rejects(b.t.cuadre("1"), /HTTP 500/); assert.equal(b.http.llamadas.length, 2);
  const c = mk([{ status: 400, data: { error: "tel" }, headers: {} }]);
  await assert.rejects(c.t.cuadre("1"), /HTTP 400/); assert.equal(c.http.llamadas.length, 1);
});

test("429: espera el retry-after (con tope) y reintenta; tras max429 falla", async () => {
  const a = mk([{ status: 429, data: {}, headers: { "retry-after": "7" } }, { status: 429, data: {}, headers: { "retry-after": "999" } }, ok({})]);
  await a.t.cuadre("1");
  assert.deepStrictEqual(a.espera.esperas, [7000, 30000]);
  const b = mk(Array.from({ length: 3 }, () => ({ status: 429, data: {}, headers: {} })), { max429: 2 });
  await assert.rejects(b.t.cuadre("1"), /429/);
  assert.equal(b.http.llamadas.length, 3);
  assert.deepStrictEqual(b.espera.esperas, [5000, 5000]);
});

test("cuadre con ok:false lanza (cuenta como falta), chat con ok:false se devuelve para que importar() lo cuente como fallo", async () => {
  const a = mk([{ status: 200, data: { ok: false, error: "x" }, headers: {} }]);
  await assert.rejects(a.t.cuadre("1"), /no ok/);
  const b = mk([{ status: 200, data: { ok: false, accion: "chat", error: "forma" }, headers: {} }]);
  assert.equal((await b.t.chat({ tel: "1", chat: {}, mensajes: [], escalaciones: [] })).ok, false);
});

// ── De punta a punta: importar() real + transporte real + una edge FALSA que guarda y cuadra ──
import fs from "node:fs";
import { importar, digestMensajes } from "./import_redis.js";

function lectorMinimo() {
  const T = "628111111111", AHORA = 1790000000000;
  const m = new Map([[`conv:${T}`, { v: JSON.stringify([{ role: "user", content: "Hola", ts: AHORA - 5000 }, { role: "assistant", content: "Hi", ts: AHORA - 4000, by: "bot" }]) }],
    [`paused:${T}`, { v: "1", pttl: -1 }], [`optout:${T}`, { v: String(AHORA - 90) }]]);
  return { async *escanear() { for (const k of m.keys()) yield k; }, async tipo() { return "string"; }, async pttl(k) { return m.get(k).pttl ?? -1; },
    async get(k) { return m.get(k).v; }, async lista() { return []; }, async dbsize() { return m.size; }, async keyspace() { return { dbs: [{ db: 0, keys: m.size }] }; } };
}
function edgeFalsa() {
  const filas = new Map(); const log = [];
  return { log, post: async (_u, b) => {
    log.push(b.accion);
    if (b.accion === "chat") { filas.set(b.tel, b); return { status: 200, headers: {}, data: { ok: true, accion: "chat", chat: "creado", lead: "sin_lead", mensajes: { insertados: b.mensajes.length, omitidos_posteriores: false } } }; }
    if (b.accion === "config") return { status: 200, headers: {}, data: { ok: true, resultado: "importada" } };
    const f = filas.get(b.tel); if (!f) return { status: 200, headers: {}, data: { ok: true, existe: false } };
    return { status: 200, headers: {}, data: { ok: true, existe: true, n_mensajes: f.mensajes.length, hash_mensajes: digestMensajes(f.mensajes), ultimo_entrante_ms: f.chat.ultimo_entrante_ms,
      pausado: f.chat.pausado, pausa_hasta_ms: f.chat.pausa_hasta_ms, baja: f.chat.baja_ms !== null, aviso_nivel: f.chat.aviso_nivel, escalaciones_abiertas: f.escalaciones.length } };
  } };
}
test("importación completa por el transporte: cuadra, es repetible y el dry no escribe", async () => {
  const edge = edgeFalsa();
  const t = creaTransporte({ url: "https://x/y", secreto: "s", http: edge, espera: async () => {} });
  const seco = await importar(lectorMinimo(), t, { dryRun: true });
  assert.equal(seco.dryRun, true); assert.equal(edge.log.length, 0);
  const a = await importar(lectorMinimo(), t);
  assert.equal(a.enviados, 1); assert.equal(a.fallos_envio, 0);
  assert.equal(a.cuadre.ninguna_baja_ni_pausa_vigente_falta, true);
  const b = await importar(lectorMinimo(), t);
  assert.deepStrictEqual(b.cuadre, a.cuadre);
  assert.ok(!/628111111111|Hola/.test(JSON.stringify(a)), "el informe no lleva teléfono ni contenido");
});

test("el endpoint temporal existe, exige x-admin-key, admite dry y se marca para retirar en S9", () => {
  const src = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");
  const i = src.indexOf('app.post("/admin/api/redis-importar"');
  assert.ok(i > 0);
  const cuerpo = src.slice(i, i + 1400);
  assert.match(cuerpo, /req\.get\("x-admin-key"\) !== ADMIN_PASSWORD/);
  assert.match(cuerpo, /dry/); assert.match(cuerpo, /_importandoRedis/);
  assert.ok(!/req\.query\.key/.test(cuerpo));
  assert.match(src.slice(i - 700, i), /S9/);
});

// ── Conformidad con el esquema CERRADO de la edge (claves copiadas de bot-api/index.ts: CLAVES_CHAT, mensajeImportado, escalacionImportada, ajustesDe) ──
import { leerTodo } from "./import_redis.js";
const K = { chat: ["nombre_perfil", "intent", "ultimo_mensaje", "ultimo_por", "creado_ms", "actualizado_ms", "archivado", "ultimo_entrante_ms", "esperando", "pausado", "pausa_hasta_ms", "baja_ms", "baja_acuse", "seguimientos", "aviso_nivel", "aviso_testing"],
  msg: ["rol", "por", "por_usuario", "contenido", "media", "wamid", "ts_ms"], esc: ["nombre", "pregunta", "aviso_wamid", "creada_ms"], cfg: ["extra", "bienvenida", "pausa_horas", "updated_by"], cfgLog: ["extra", "bienvenida", "pausa_horas"] };
const mismas = (o, ks) => assert.deepStrictEqual(Object.keys(o).sort(), [...ks].sort());

test("lo que sale del transporte pasa el esquema cerrado de la edge (sin claves de más; wamid/media ilegibles pasan a null)", async () => {
  const T = "628111111111", AHORA = 1790000000000;
  const m = new Map([
    [`conv:${T}`, { v: JSON.stringify([{ role: "user", content: "Hola", ts: AHORA - 5000, wamid: "wamid.ok=" }, { role: "user", content: "foto", ts: AHORA - 4000, wamid: "malo wamid con espacios", media: { id: "mediaID1", type: "image" } },
      { role: "user", content: "foto2", ts: AHORA - 3000, media: { id: "id con espacio", type: "Image/PNG" } }]) }],
    ["esc_queue", { tipo: "list", v: [JSON.stringify({ customerPhone: T, customerName: "Ana", question: "¿precio?" })] }],
    ["botcfg:v1", { v: JSON.stringify({ extra: "x", bienvenida: "hola", pausaHoras: 12, updatedAt: AHORA, updatedBy: "a@b.c" }) }],
    ["botcfg:log", { tipo: "list", v: [JSON.stringify({ ts: AHORA, by: "a@b.c", prev: { extra: "", bienvenida: "", pausaHoras: 0 }, next: { extra: "x", bienvenida: "hola", pausaHoras: 12 } })] }]]);
  const lector = { async *escanear() { for (const k of m.keys()) yield k; }, async tipo(k) { return m.get(k).tipo || "string"; }, async pttl() { return -1; }, async get(k) { return m.get(k).v; },
    async lista(k) { return m.get(k).v; }, async dbsize() { return m.size; }, async keyspace() { return { dbs: [{ db: 0, keys: m.size }] }; } };
  const lectura = await leerTodo(lector, { ahora: AHORA });
  const enviados = [];
  const t = creaTransporte({ url: "https://x/y", secreto: "s", http: { post: async (_u, b) => { enviados.push(b); return { status: 200, headers: {}, data: { ok: true } }; } }, espera: async () => {} });
  await t.chat(lectura.chats[0]); await t.config({ config: lectura.config, log: lectura.config_log });
  const c = enviados[0], g = enviados[1];
  mismas(c.chat, K.chat); c.mensajes.forEach((x) => mismas(x, K.msg)); c.escalaciones.forEach((x) => mismas(x, K.esc));
  assert.equal(c.mensajes.length, 3); assert.equal(c.escalaciones.length, 1);
  assert.equal(c.mensajes[0].wamid, "wamid.ok="); assert.equal(c.mensajes[1].wamid, null);
  assert.deepStrictEqual(c.mensajes[1].media, { tipo: "image", id: "mediaID1" }); assert.equal(c.mensajes[2].media, null);
  mismas(g.config, K.cfg); g.log.forEach((e) => { mismas(e, ["ts_ms", "by", "prev", "next"]); mismas(e.prev, K.cfgLog); mismas(e.next, K.cfgLog); });
  assert.equal(g.config.pausa_horas, 12);
});
