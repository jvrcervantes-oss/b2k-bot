// BBM-40 (11-oct-2026): privacidad antes de abrir. Fija dos cosas:
//   1) con las variables nuevas AUSENTES el bot se comporta como en bfda172 (comprobación del módulo y estática de index.js,
//      que no se puede importar en un test porque arranca Express + Redis);
//   2) con ellas encendidas, cada pieza hace lo que promete: borrado completo, Telegram sin datos, purga que nunca toca un
//      lead que pagó, cuentas del panel con scrypt, límite de intentos, sesión revocable y registro de accesos.
// Ejecutar: node test-privacidad.js
import assert from "node:assert";
import fs from "node:fs";
import { leeConfigPrivacidad, docKeysDeLead, textoTelegram, ultimoTs, purgaPasada, leadRetenido, TOPE_PURGA } from "./privacidad.js";
import { leeConfigPanel, createPanelCuentas, igualSeguro, ipCliente, leeCookie, MAX_FALLOS_USUARIO_IP, MAX_FALLOS_IP } from "./panel-cuentas.js";

let n = 0;
const ok = (m) => { n++; console.log("ok -", m); };
const DIA = 24 * 3600 * 1000;

// ── Redis de juguete: solo lo que usan privacidad.js y panel-cuentas.js ──
function fakeRedis() {
  const kv = new Map(), z = new Map(), sets = new Map(), lists = new Map(), ttl = new Map();
  const glob = (pat) => new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
  return {
    _kv: kv, _ttl: ttl, _lists: lists,
    async get(k) { return kv.has(k) ? kv.get(k) : null; },
    async set(k, v, o = {}) { if (o.NX && kv.has(k)) return null; kv.set(k, String(v)); if (o.EX) ttl.set(k, o.EX); else ttl.delete(k); return "OK"; },
    async del(...a) { const ks = a.flat(); let c = 0; for (const k of ks) { for (const m of [kv, z, sets, lists]) if (m.delete(k)) c++; ttl.delete(k); } return c; },
    async *scanIterator({ MATCH }) { const re = glob(MATCH); for (const k of [...kv.keys()]) if (re.test(k)) yield k; },
    async zAdd(k, { score, value }) { if (!z.has(k)) z.set(k, new Map()); z.get(k).set(value, score); },
    async zCard(k) { return z.has(k) ? z.get(k).size : 0; },
    async zRangeByScore(k, min, max) { return z.has(k) ? [...z.get(k)].filter(([, s]) => s >= min && s <= max).sort((a, b) => a[1] - b[1]).map(([v]) => v) : []; },
    async zRem(k, v) { return z.has(k) && z.get(k).delete(v) ? 1 : 0; },
    async incr(k) { const v = Number(kv.get(k) || 0) + 1; kv.set(k, String(v)); return v; },
    async expire(k, s) { ttl.set(k, s); return 1; },
    async sAdd(k, v) { if (!sets.has(k)) sets.set(k, new Set()); sets.get(k).add(v); },
    async sMembers(k) { return sets.has(k) ? [...sets.get(k)] : []; },
    async sRem(k, v) { return sets.has(k) && sets.get(k).delete(v) ? 1 : 0; },
    async lPush(k, v) { if (!lists.has(k)) lists.set(k, []); lists.get(k).unshift(v); },
    async lTrim(k, a, b) { if (lists.has(k)) lists.set(k, lists.get(k).slice(a, b + 1)); },
    async lIndex(k, i) { const l = lists.get(k) || []; const v = l[i < 0 ? l.length + i : i]; return v === undefined ? null : v; },
    async rPop(k) { const l = lists.get(k) || []; return l.length ? l.pop() : null; },
    async lRange(k, a, b) { const l = lists.get(k) || []; return l.slice(a, b < 0 ? l.length + b + 1 : b + 1); },
  };
}
const silencio = { log() {}, error() {}, warn() {} };

// ═══ 1) APAGADO = como siempre ═══
{
  const c = leeConfigPrivacidad({});
  assert.equal(c.borradoCompleto, false); assert.equal(c.telegramSinDatos, false);
  assert.equal(c.docTtlDias, 60, "las fotos siguen caducando a los 60 días");
  assert.equal(c.purga.modo, "off"); assert.equal(c.purga.convDias, null); assert.equal(c.purga.leadDias, null);
  assert.deepEqual(c.avisos, []);
  const p = leeConfigPanel({});
  assert.deepEqual(p, { cuentas: false, claveUrl: true, sesionHoras: 12 });
  // Plazos puestos sin PRIV_PURGA no hacen nada
  assert.equal(leeConfigPrivacidad({ PRIV_CONV_DIAS: "365", PRIV_LEAD_DIAS: "730" }).purga.modo, "off");
  ok("sin variables: todo apagado, fotos a 60 días, panel con clave compartida y ?key= como hoy");
}
{
  const c = leeConfigPrivacidad({});
  const t = "🔔 LEAD CALIENTE — quiere reservar\nAna\nÚltimo mensaje: \"hola\"";
  assert.equal(textoTelegram(c, "BaliBest", t, "🔔 LEAD CALIENTE", "https://x/admin"), `🏍️ [BaliBest] ${t}`, "apagado: el texto de siempre, byte a byte");
  ok("Telegram apagado: el mismo texto que bfda172 (`🏍️ [proyecto] texto`)");
}
{
  const r = fakeRedis();
  await r.set("conv:1", JSON.stringify([{ role: "user", content: "x", ts: 1 }]));
  const res = await purgaPasada({ redis: r, cfg: leeConfigPrivacidad({ PRIV_CONV_DIAS: "30" }), now: Date.now(), deleteLead: async () => { throw new Error("no debe llamarse"); }, log: silencio });
  assert.equal(res.modo, "off"); assert.equal(res.conv, null); assert.ok(await r.get("conv:1"));
  ok("purga apagada: no lee ni borra nada aunque haya plazos puestos");
}

// ═══ 2) Estática de index.js: el cableado no cambia nada con todo apagado ═══
{
  const src = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");
  const sinCom = src.replace(/\/\/.*$/gm, "");
  const trozo = (ini, fin) => { const i = src.indexOf(ini); assert.ok(i >= 0, `no está: ${ini.slice(0, 50)}`); const j = src.indexOf(fin, i + ini.length); assert.ok(j > i); return src.slice(i, j); };
  // Telegram: toda llamada pasa su versión mínima (el genérico solo es la red de seguridad)
  const llamadas = [...sinCom.matchAll(/notifyTelegram\(/g)].length;
  const definicion = (sinCom.match(/async function notifyTelegram\(text, minimo\)/g) || []).length;
  assert.equal(definicion, 1);
  const conMinimo = [...sinCom.matchAll(/await notifyTelegram\([^\n]*, ("|`)[^\n]*\);|await notifyTelegram\(\w+, [^\n]+\);|await notifyTelegram\(`[^\n]*`, [^\n]+\);/g)].length;
  assert.equal(conMinimo, llamadas - 1, `cada llamada a notifyTelegram (${llamadas - 1}) pasa su versión sin datos`);
  // deleteLead: con el interruptor apagado no lee la ficha ni borra nada más
  const dl = trozo("async function deleteLead(phone) {", "\napp.post(\"/admin/api/lead/delete\"");
  assert.ok(/const docKeys = privCfg\.borradoCompleto \? docKeysDeLead\(await getLead\(phone\)\) : \[\];/.test(dl));
  assert.ok(/if \(privCfg\.borradoCompleto && telN\) \{/.test(dl), "citas y escalaciones solo con el interruptor");
  assert.ok(dl.includes("await redisClient.del(`lead:${phone}`, `notes:${phone}`, `status:${phone}`, `conv:${phone}`"), "el borrado de siempre sigue igual");
  // fotos: 60 por defecto
  assert.ok(/const DOC_TTL_DAYS = privCfg\.docTtlDias;/.test(src));
  // adminAuth apagada: misma regla (cabecera o ?key=) con comparación en tiempo constante
  const aa = trozo("function adminAuth(req, res) {", "\n}\n");
  assert.ok(aa.includes('const key = req.get("x-admin-key") || (panelCfg.claveUrl ? req.query.key : undefined);'));
  assert.ok(aa.includes('if (typeof key !== "string" || !igualSeguro(key, ADMIN_PASSWORD)) { res.status(403).json({ error: "forbidden" }); return false; }'));
  // el middleware no toca nada sin cuentas
  const mw = trozo('app.use("/admin", async (req, _res, next) => {', "\n});\n");
  const corteMw = mw.indexOf("if (!panelCfg.cuentas) return next();");
  assert.ok(corteMw > 0 && mw.slice(0, corteMw).includes("panelUltimosSaltos = saltos;"), "sin cuentas solo cuenta saltos (un número) y sigue");
  assert.ok(!/req\.panel\w+ =/.test(mw.slice(0, corteMw)), "sin cuentas no marca nada en la petición");
  // con cuentas, el bloqueo por IP va antes que la clave compartida: si no, el límite no frenaría a quien la adivina
  const aa2 = trozo("function adminAuth(req, res) {", "\n}\n");
  assert.ok(aa2.indexOf("if (req.panelIpBloqueada)") < aa2.indexOf('igualSeguro(key, ADMIN_PASSWORD)) { req.panelQuien = "clave compartida"; return true; }'));
  // las rutas nuevas del panel solo existen con cuentas
  const bloque = src.indexOf("if (panelCfg.cuentas) {\n  app.post(\"/admin/api/sesion\"");
  assert.ok(bloque > 0);
  for (const ruta of ['"/admin/api/sesion"', '"/admin/api/sesion/salir"', '"/admin/cuentas"', '"/admin/api/cuentas"']) {
    const i = src.indexOf(`app.post(${ruta}`) >= 0 ? src.indexOf(`app.post(${ruta}`) : src.indexOf(`app.get(${ruta}`);
    assert.ok(i > bloque, `${ruta} va dentro del bloque de cuentas`);
  }
  // registro de accesos: solo con cuentas
  assert.ok(src.includes("function anotaAcceso(req, accion, extra) {\n  if (panelCfg.cuentas)"));
  // health idéntica con todo apagado; la purga ni se programa
  assert.ok(src.includes("...(priv ? { privacidad: priv } : {})"));
  assert.ok(/if \(privCfg\.purga\.modo !== "off"\) \{\n    setTimeout\(privPurgaTick/.test(src));
  // la retención de conversaciones de hoy (PERSIST al arrancar, set sin EX) no se ha tocado
  assert.ok(src.includes("if (await redisClient.persist(key)) freed++;"));
  assert.ok(src.includes("await redisClient.set(`conv:${phone}`, JSON.stringify(trimmed));"));
  ok("index.js: con todo apagado, adminAuth, deleteLead, fotos, health, conversaciones y rutas quedan como en bfda172");
}
{
  const html = fs.readFileSync(new URL("./panel-rental.html", import.meta.url), "utf8");
  assert.ok(html.includes("var CUENTAS = '__CUENTAS__' === '1', CLAVE_URL = '__CLAVE_URL__' !== '0';"));
  assert.ok(html.includes("var KEY = CUENTAS ? '' : ((CLAVE_URL ? new URLSearchParams(location.search).get('key') : null) || sessionStorage.getItem('botpanel_key') || '');"));
  // con los valores que pone el servidor apagado (0 y 1), el enlace del documento es el de siempre
  const docHref = new Function("CUENTAS", "CLAVE_URL", "KEY", html.match(/function docHref\(id\)\{[\s\S]*?\n  \}/)[0] + "; return docHref('abc');");
  assert.equal(docHref(false, true, "k#1"), "/admin/api/doc/abc?key=k%231", "apagado: como hoy");
  assert.equal(docHref(true, true, ""), "/admin/api/doc/abc", "con cuentas: sin clave, vale la cookie");
  assert.equal(docHref(false, false, "k"), "#", "sin clave en la URL: se abre por fetch con cabecera");
  assert.ok(html.includes('<input id="pwUser" type="text" data-ph="ph_user" placeholder="Usuario" autocomplete="username" autocapitalize="none" spellcheck="false" style="display:none">'), "el campo de usuario nace oculto");
  ok("panel: apagado pinta el mismo login y el mismo enlace de documento; el modo lo inyecta el servidor");
}

// ═══ 3) Encendido: cada pieza ═══
{
  const c = leeConfigPrivacidad({ PRIV_BORRADO_COMPLETO: "1", PRIV_TELEGRAM_SIN_DATOS: "1", DOC_TTL_DAYS: "30", PRIV_PURGA: "contar", PRIV_CONV_DIAS: "365", PRIV_LEAD_DIAS: "730" });
  assert.equal(c.borradoCompleto, true); assert.equal(c.docTtlDias, 30); assert.deepEqual(c.purga, { modo: "contar", convDias: 365, leadDias: 730 });
  const mal = leeConfigPrivacidad({ DOC_TTL_DAYS: "0", PRIV_PURGA: "aplicar", PRIV_CONV_DIAS: "7", PRIV_LEAD_DIAS: "abc" });
  assert.equal(mal.docTtlDias, 60); assert.equal(mal.purga.convDias, null, "por debajo del suelo de 30: nada"); assert.equal(mal.purga.leadDias, null);
  assert.equal(mal.avisos.length, 4, "incluye: aplicar sin borrado completo se queda en contar");
  assert.equal(mal.purga.modo, "contar", "Legal: aplicar exige PRIV_BORRADO_COMPLETO=1");
  assert.equal(leeConfigPrivacidad({ PRIV_PURGA: "borrar" }).purga.modo, "off", "un valor raro deja la purga apagada");
  ok("configuración: valores válidos se aplican; ilegibles o bajo el suelo no hacen nada y avisan");
}
{
  const lead = { docs: [{ id: "a".repeat(32) }, { id: "b".repeat(32) }, { id: "a".repeat(32) }, { id: "../lead:123" }, { id: "*" }, null, { id: 5 }] };
  assert.deepEqual(docKeysDeLead(lead), [`doc:${"a".repeat(32)}`, `doc:${"b".repeat(32)}`]);
  assert.deepEqual(docKeysDeLead(null), []); assert.deepEqual(docKeysDeLead({}), []);
  ok("borrado completo: solo ids de foto válidos (32 hex); un `docs` manipulado no borra otras claves");
}
{
  const c = leeConfigPrivacidad({ PRIV_TELEGRAM_SIN_DATOS: "1" });
  const lleno = "💰 PAGO RECIBIDO (Xendit)\n\n*Ana Pérez*\nTel: +6281234567890\nImporte: 1.500.000 IDR";
  const t = textoTelegram(c, "BaliBest", lleno, "💰 Pago recibido (Xendit)", "https://bot.up.railway.app/admin");
  assert.equal(t, "🏍️ [BaliBest] 💰 Pago recibido (Xendit)\nPanel: https://bot.up.railway.app/admin");
  for (const dato of ["Ana", "6281234567890", "1.500.000"]) assert.ok(!t.includes(dato), `sin ${dato}`);
  assert.equal(textoTelegram(c, "BaliBest", lleno, undefined, ""), "🏍️ [BaliBest] Aviso nuevo\nDetalle en el panel del bot.", "sin versión mínima: genérico, nunca el texto lleno");
  ok("Telegram encendido: solo el tipo de aviso y el enlace al panel; sin mínimo, genérico");
}
{
  assert.equal(ultimoTs(JSON.stringify([{ ts: 5 }, { ts: 9 }, { role: "x" }])), 9);
  assert.equal(ultimoTs(JSON.stringify([{ role: "x" }])), null); assert.equal(ultimoTs("{roto"), null); assert.equal(ultimoTs("{}"), null);
  assert.equal(leadRetenido({ history: [{ type: "created" }] }), false);
  assert.equal(leadRetenido({ history: [{ type: "paylink" }] }), true);
  assert.equal(leadRetenido({ history: [{ type: "payment" }] }), true);
  assert.equal(leadRetenido(null), true, "sin ficha legible: no se toca");
  assert.equal(leadRetenido({ deals: [{ status: "won" }] }), true); assert.equal(leadRetenido({ deals: [{ status: "open" }] }), false);
  assert.equal(leadRetenido({ deals: [{ status: "open", erpCreated: true }] }), true); assert.equal(leadRetenido({ status: "won" }), true);
  ok("fecha de la última conversación y retención de leads con cobro");
}
async function siembra(now) {
  const r = fakeRedis();
  const viejo = now - 400 * DIA, nuevo = now - 10 * DIA;
  await r.set("conv:viejo", JSON.stringify([{ role: "user", content: "hola", ts: viejo }]));
  await r.set("conv:nuevo", JSON.stringify([{ role: "user", content: "hola", ts: viejo }, { role: "assistant", content: "hey", ts: nuevo }]));
  await r.set("conv:sinfecha", JSON.stringify([{ role: "user", content: "hola" }]));
  await r.set("conv:roto", "{no es json");
  await r.set("conv:222", JSON.stringify([{ role: "user", content: "pago hecho", ts: viejo }]));          // chat viejo de quien pagó → se retiene
  await r.set("conv:555", JSON.stringify([{ role: "user", content: "llego el día 20", ts: viejo }]));     // chat viejo de quien tiene cita → se retiene
  const lead = async (tel, upd, extra = {}) => { await r.set(`lead:${tel}`, JSON.stringify({ phone: tel, updatedAt: upd, history: [{ ts: upd, type: "created" }], ...extra })); await r.zAdd("leads_index", { score: upd, value: tel }); };
  await lead("111", now - 800 * DIA);                                                         // vencido, sin compra → se borra
  await lead("222", now - 800 * DIA, { history: [{ type: "payment", amount: 100 }] });         // pagó → se retiene
  await lead("333", now - 800 * DIA); await r.set("pendingpay:333", "1");                    // pago a medias → se retiene
  await lead("444", now - 800 * DIA); await r.set("status:444", "won");                      // ganado → se retiene
  await lead("555", now - 800 * DIA);                                                         // cita futura → se retiene
  await lead("666", now - 30 * DIA);                                                          // reciente → no vence
  await lead("888", now - 800 * DIA, { deals: [{ id: "d1", status: "won", model: "NMAX" }] }); // alquiler ganado sin evento de pago → se retiene
  await lead("999", now - 800 * DIA); await r.set("pendingrsv:999", "{}");                    // reserva del ERP a medias → se retiene
  await r.set("lead:viejo", JSON.stringify({ phone: "viejo", updatedAt: now - 400 * DIA, lastMessage: "me alojo en Canggu" }));
  await r.zAdd("leads_index", { score: now - 900 * DIA, value: "777" });                     // índice sin ficha → no se toca
  return r;
}
{
  const now = Date.UTC(2026, 9, 11);
  const r = await siembra(now);
  const antes = JSON.stringify([...r._kv]);
  const borrados = [];
  const cfg = leeConfigPrivacidad({ PRIV_PURGA: "contar", PRIV_CONV_DIAS: "365", PRIV_LEAD_DIAS: "730" });
  const res = await purgaPasada({ redis: r, cfg, now, deleteLead: async (t) => borrados.push(t), tieneCitaFutura: async (t) => t === "555", log: silencio });
  assert.equal(JSON.stringify([...r._kv]), antes, "contar no cambia ninguna clave");
  assert.deepEqual(borrados, []);
  assert.deepEqual(res.conv, { dias: 365, total: 6, vencidas: 1, retenidas: 2, sin_fecha: 2, borradas: 0 });
  assert.equal(res.leads.vencidos, 1); assert.equal(res.leads.retenidos, 6); assert.equal(res.leads.borrados, 0);
  ok("purga en contar: no cambia nada y cuenta 1 conversación y 1 lead vencidos, 6 leads retenidos");
}
{
  const now = Date.UTC(2026, 9, 11);
  const r = await siembra(now);
  const borrados = [];
  const cfg = leeConfigPrivacidad({ PRIV_PURGA: "aplicar", PRIV_BORRADO_COMPLETO: "1", PRIV_CONV_DIAS: "365", PRIV_LEAD_DIAS: "730" });
  const res = await purgaPasada({ redis: r, cfg, now, deleteLead: async (t) => borrados.push(t), tieneCitaFutura: async (t) => t === "555", log: silencio });
  assert.equal(await r.get("conv:viejo"), null, "conversación vencida: borrada");
  for (const k of ["conv:nuevo", "conv:sinfecha", "conv:roto", "conv:222", "conv:555"]) assert.ok(await r.get(k), `${k} sigue`);
  assert.deepEqual(borrados, ["111"], "solo el lead vencido que no compró");
  assert.ok(await r.get("lead:222"), "el lead que pagó sigue intacto (su pago solo vive en su historial)");
  assert.ok(await r.get("lead:888"), "el alquiler ganado sin evento de pago sigue"); assert.ok(await r.get("lead:999"), "la reserva del ERP a medias sigue");
  assert.equal(JSON.parse(await r.get("lead:viejo")).lastMessage, "", "con la conversación se va también la vista previa del último mensaje");
  assert.equal(res.conv.borradas, 1); assert.equal(res.leads.borrados, 1);
  ok("purga en aplicar: borra exactamente lo vencido y deja intactos pagados, pago pendiente, ganados, citas, recientes y sin fecha");
}
{
  const now = Date.UTC(2026, 9, 11);
  const r = fakeRedis();
  for (let i = 0; i < TOPE_PURGA + 15; i++) await r.set(`conv:${i}`, JSON.stringify([{ ts: now - 400 * DIA }]));
  const res = await purgaPasada({ redis: r, cfg: leeConfigPrivacidad({ PRIV_PURGA: "aplicar", PRIV_BORRADO_COMPLETO: "1", PRIV_CONV_DIAS: "365" }), now, deleteLead: async () => {}, log: silencio });
  assert.equal(res.conv.borradas, TOPE_PURGA); assert.equal(res.conv.vencidas, TOPE_PURGA + 15); assert.equal(res.leads, null);
  ok(`purga: como mucho ${TOPE_PURGA} borrados por categoría y pasada; sin plazo de leads, los leads no se miran`);
}

// ═══ 4) Panel: cuentas, sesiones, límite de intentos, registro ═══
{
  assert.equal(igualSeguro("abc", "abc"), true); assert.equal(igualSeguro("abc", "abd"), false);
  assert.equal(igualSeguro("abc", ""), false, "sin clave configurada nunca entra"); assert.equal(igualSeguro(["abc"], "abc"), false);
  const req = (h) => ({ get: (k) => h[k.toLowerCase()], socket: { remoteAddress: "10.0.0.1" } });
  assert.deepEqual(ipCliente(req({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" })), { ip: "2.2.2.2", saltos: 2 }, "el último salto, no el que escribe el cliente");
  assert.deepEqual(ipCliente(req({})), { ip: "10.0.0.1", saltos: 0 });
  assert.equal(leeCookie(req({ cookie: "a=1; panel_sesion=tok%2Bx; b=2" })), "tok+x");
  assert.equal(leeCookie(req({})), "");
  assert.equal(leeCookie(req({ cookie: "panel_sesion=%" })), "", "cookie mal formada: sin sesión y sin excepción");
  assert.deepEqual(leeConfigPanel({ PANEL_CUENTAS: "1", PANEL_CLAVE_URL: "0", PANEL_SESION_HORAS: "999" }), { cuentas: true, claveUrl: false, sesionHoras: 12 });
  ok("comparación en tiempo constante, IP del último salto, cookie y configuración del panel");
}
{
  let t = Date.UTC(2026, 9, 11);
  const r = fakeRedis();
  const pc = createPanelCuentas({ redis: () => r, now: () => t, log: silencio, proyecto: "test", sesionHoras: 12 });
  assert.equal((await pc.crea("dion", "corta")).ok, false, "clave de menos de 12: no");
  assert.equal((await pc.crea("Dion Admin", "unaclavelarga123")).ok, false, "nombre con espacio: no");
  assert.equal((await pc.crea("dion", "unaclavelarga123")).ok, true);
  assert.equal((await pc.crea("dion", "otraclavelarga12")).ok, false, "no se pisa una cuenta existente");
  const guardada = JSON.parse(await r.get("panel:usuario:dion"));
  assert.ok(guardada.hash.startsWith("scrypt$32768$8$1$") && !JSON.stringify(guardada).includes("unaclavelarga123"), "solo el hash scrypt");
  // login
  assert.equal((await pc.login("dion", "malamalamala1", "9.9.9.9")).status, 401);
  assert.equal((await pc.login("nadie", "unaclavelarga123", "9.9.9.9")).status, 401, "usuario inexistente: misma respuesta");
  const bien = await pc.login("dion", "unaclavelarga123", "9.9.9.9");
  assert.equal(bien.ok, true); assert.equal(bien.maxAgeS, 12 * 3600);
  assert.ok(![...r._kv.keys()].some((k) => k.includes(bien.token)), "el token no se guarda en claro");
  assert.equal(r._ttl.get([...r._kv.keys()].find((k) => k.startsWith("panel:sesion:"))), 12 * 3600, "la sesión caduca sola");
  assert.equal(await pc.sesion(bien.token), "dion");
  assert.equal(await pc.sesion("inventado"), null);
  // desactivar mata la sesión; reactivar no la resucita
  assert.equal((await pc.activa("dion", false)).sesiones_cerradas, 1);
  assert.equal(await pc.sesion(bien.token), null);
  assert.equal((await pc.login("dion", "unaclavelarga123", "9.9.9.9")).status, 401, "desactivada no entra");
  await pc.activa("dion", true);
  assert.equal(await pc.sesion(bien.token), null);
  // cambiar la clave cierra sus sesiones
  const s2 = await pc.login("dion", "unaclavelarga123", "9.9.9.9");
  assert.equal((await pc.cambiaClave("dion", "nuevaclavelarga1")).sesiones_cerradas, 1);
  assert.equal(await pc.sesion(s2.token), null);
  assert.equal((await pc.login("dion", "unaclavelarga123", "9.9.9.9")).status, 401);
  assert.equal((await pc.login("dion", "nuevaclavelarga1", "9.9.9.9")).ok, true);
  // logout
  const s3 = await pc.login("dion", "nuevaclavelarga1", "9.9.9.9");
  await pc.logout(s3.token, "9.9.9.9");
  assert.equal(await pc.sesion(s3.token), null);
  assert.deepEqual((await pc.lista()).map((c) => [c.usuario, c.activo]), [["dion", true]]);
  ok("cuentas: scrypt, sesión con caducidad y sin token en claro, desactivar y cambiar clave cierran sesiones, logout");
}
{
  const r = fakeRedis();
  const pc = createPanelCuentas({ redis: () => r, log: silencio });
  await pc.crea("dueno", "claveDelDueno123");
  for (let i = 0; i < MAX_FALLOS_USUARIO_IP; i++) assert.equal((await pc.login("dueno", "mal" + i + "xxxxxxxxx", "6.6.6.6")).status, 401);
  assert.equal((await pc.login("dueno", "claveDelDueno123", "6.6.6.6")).status, 429, "tras 5 fallos desde esa IP, bloqueado aunque acierte");
  assert.equal((await pc.login("dueno", "claveDelDueno123", "7.7.7.7")).ok, true, "el dueño entra desde otra IP: un atacante no le bloquea la cuenta");
  for (let i = 0; i < MAX_FALLOS_IP; i++) await pc.cuentaFalloIP("8.8.8.8");
  assert.equal(await pc.ipBloqueada("8.8.8.8"), true);
  assert.equal((await pc.login("dueno", "claveDelDueno123", "8.8.8.8")).status, 429, "IP con 20 fallos (cuentas, clave compartida o maestra): bloqueada");
  ok("límite de intentos por usuario+IP (5) y por IP (20), comprobado antes de calcular el hash");
}
{
  let t = Date.UTC(2026, 9, 11);
  const r = fakeRedis();
  const pc = createPanelCuentas({ redis: () => r, now: () => t, log: silencio });
  await pc.registra("dion", "login", true, "1.2.3.4");
  t += 800 * DIA;
  await pc.registra("dion", "ver_documento", true, "1.2.3.4", "abc");
  const a = await pc.accesos();
  assert.equal(a.length, 1, "lo de más de 24 meses se cae");
  assert.deepEqual(Object.keys(a[0]).sort(), ["accion", "extra", "ip", "ok", "quien", "ts"]);
  ok("registro de accesos: quién, qué, cuándo, IP; nada de más de 24 meses");
}
{
  const r = fakeRedis();
  const pc = createPanelCuentas({ redis: () => r, log: silencio });
  const out = await pc.login("x", "y", "1.1.1.1");
  assert.equal(out.status, 401);
  const sinRedis = createPanelCuentas({ redis: () => null, log: silencio });
  assert.equal((await sinRedis.login("dion", "unaclavelarga123", "1.1.1.1")).status, 503, "sin Redis no se entra");
  assert.equal(await sinRedis.sesion("tok"), null);
  ok("sin almacén de sesiones: nunca acceso por defecto");
}

console.log(`\n${n} comprobaciones en verde`);
