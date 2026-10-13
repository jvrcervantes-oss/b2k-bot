// Ensayo del corte de BBM al ERP con el index.js REAL (E1.10, 13-oct-2026, bbm-corte-bot). No es una prueba del gate: se lanza a mano.
//
//   node --import ./qa/ensayo_corte_erp.mjs index.js            (desde la raíz del repo, con node_modules instalado)
//   ENSAYO_CASO=en|id|id_sin_cobros|regla|telefono_prueba (este: BBM_BACKEND=dion + BBM_ERP_TELEFONOS con el teléfono del ensayo, el ensayo de E1.6)   ENSAYO_FIXTURES=<json capturado de una rama de bbm>   (opcionales)
//
// Qué es de verdad y qué no:
//   · DE VERDAD: index.js entero (webhook de Meta, turno, herramienta get_quote del modo erp, cierre [PAY], puerta de Xendit, aviso de pago),
//     bbmerp.js, bbmflow.js, xendit-rsv.js, aviso-ia.js, con BBM_BACKEND=erp.
//   · DE MENTIRA: el modelo (un guion que llama a get_quote y emite [LEAD]/[PAY] como lo haría Haiku; NO prueba cómo obedece el modelo),
//     WhatsApp y Telegram (se apuntan, no salen) y las tres edges del ERP (un doble con estado que contesta como bbmerp.contract.json; con
//     ENSAYO_FIXTURES, con las salidas reales de las funciones de la base capturadas en una rama efímera de bbm).
//   · RED: bloqueada. fetch, axios, http y https solo llegan a 127.0.0.1/localhost; cualquier otro destino lanza y queda en el informe.
//     Sin REDIS_URL (memoria del proceso). Nunca se lanza con `railway run`: inyectaría el Redis y el token de WhatsApp de producción.
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import https from "node:https";
import fs from "node:fs";
import axios from "axios";
import Anthropic from "@anthropic-ai/sdk";

// ── entorno del ensayo (se fija ANTES de que index.js lea process.env) ──────────────────────────────────────────────────────
const URL_ERP = "https://erp-prueba.invalid";
const SECRETO = "ensayo-secreto-de-reservas-bot-0123456789abcdef";
const TOKEN_AJUSTES = "tok_ensayo_Ajustes_Cobros_0123456789";
const TEL = "62800000001";            // teléfono de mentira: no sale nada del ordenador
const OWNER = "62899999999";
const PORT = String(39000 + Math.floor(Math.random() * 900));
const CASO = process.env.ENSAYO_CASO || "en";
// Lanzado con el entorno de un servicio (p. ej. `railway run`) se NIEGA en vez de limpiar: una lista de nombres para borrar siempre se queda corta
// (REDIS_PRIVATE_URL, REDISHOST…). Revisor, 13-oct-2026.
const sospechosas = Object.keys(process.env).filter((k) => /^(RAILWAY_|REDIS|WHATSAPP_|META_APP_SECRET$|XENDIT_|STRIPE_SECRET|ANTHROPIC_API_KEY$|BBM_RESERVAS_SECRET$|TELEGRAM_BOT_TOKEN$)/.test(k));
if (sospechosas.length) { console.error(`ensayo: el entorno trae variables de un servicio (${sospechosas.join(", ")}): no se lanza. Nunca con railway run.`); process.exit(3); }
for (const k of Object.keys(process.env)) if (/^(REDIS_URL|WHATSAPP_|META_|TELEGRAM_|XENDIT_|STRIPE_|BBM_|SUPABASE_|GOOGLE_|BREVO_|ANTHROPIC_|OPENAI_|SHEET_|CRM_|PANEL_|PRIV_|ERP_|RAILWAY_)/.test(k)) delete process.env[k];
Object.assign(process.env, {
  PORT, PROJECT_NAME: "BaliBest", BOT_VERTICAL: "rental", CONTEXT_FILE: "context-balibest.md", PANEL_FILE: "panel-rental.html",
  BOT_MODEL: "ensayo-guion", ANTHROPIC_API_KEY: "ensayo-sin-clave", WHATSAPP_TOKEN: "ensayo", WHATSAPP_PHONE_ID: "100000000000000", WHATSAPP_VERIFY_TOKEN: "ensayo",
  OWNER_PHONE: OWNER, ADMIN_PASSWORD: "ensayo-admin-0123456789", XENDIT_CALLBACK_TOKEN: "tok-railway-viejo-9876543210",
  BBM_BACKEND: CASO === "telefono_prueba" ? "dion" : "erp", ...(CASO === "telefono_prueba" ? { BBM_ERP_TELEFONOS: TEL } : {}), BBM_ERP_URL: URL_ERP, BBM_RESERVAS_SECRET: SECRETO, BBM_ERP_CLAVE: "1",
});

// ── informe ────────────────────────────────────────────────────────────────────────────────────────────
const inf = { caso: CASO, whatsapp: [], telegram: [], erp: [], bloqueado: [], errores: [] };

// ── red bloqueada ──────────────────────────────────────────────────────────────────────────────────────
const LOCAL = (h) => h === "127.0.0.1" || h === "localhost" || h === "::1";
const fetchReal = globalThis.fetch;
for (const mod of [http, https]) {
  const orig = mod.request.bind(mod), origGet = mod.get.bind(mod);
  const host = (a) => (typeof a === "string" ? new URL(a).hostname : a instanceof URL ? a.hostname : (a && (a.hostname || a.host)) || "");
  mod.request = (a, ...r) => { const h = host(a); if (!LOCAL(h)) { inf.bloqueado.push(`${mod === https ? "https" : "http"}:${h}`); throw new Error(`ensayo: red bloqueada (${h})`); } return orig(a, ...r); };
  mod.get = (a, ...r) => { const h = host(a); if (!LOCAL(h)) { inf.bloqueado.push(`get:${h}`); throw new Error(`ensayo: red bloqueada (${h})`); } return origGet(a, ...r); };
}

// net/tls (por ahí iría un cliente de Redis o cualquier socket a mano): solo a localhost
for (const [mod, nombre] of [[net, "net"], [tls, "tls"]]) {
  for (const fn of nombre === "net" ? ["connect", "createConnection"] : ["connect"]) {
    const orig = mod[fn].bind(mod);
    mod[fn] = (...a) => {
      const o = a[0], h = typeof o === "object" && o ? (o.host || o.hostname || "localhost") : (typeof a[1] === "string" ? a[1] : "localhost");
      if (!LOCAL(String(h))) { inf.bloqueado.push(`${nombre}:${h}`); throw new Error(`ensayo: red bloqueada (${h})`); }
      return orig(...a);
    };
  }
}

// ── doble del ERP (reservas-bot, reservas-enlace, reservas-pago) ──────────────────────────────────────────────────────────────
const fx = process.env.ENSAYO_FIXTURES ? JSON.parse(fs.readFileSync(process.env.ENSAYO_FIXTURES, "utf8")) : null;
const PID = fx?.producto_id || "3f0c1b1e-7b1a-4c53-9a53-2a6f0f5c1111";
const st = { reservas: new Map(), invoices: new Map(), facturas: [], seq: 0, cobros: CASO !== "id_sin_cobros" };
const res = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const uuid = () => `9a1e6c1a-0d52-4e0e-8a77-${String(++st.seq).padStart(12, "0")}`;
function edgeReservasBot(b) {
  if (b.accion === "catalogo") return res(200, { r: fx?.catalogo || [{ id: PID, numero_producto: "P-1", nombre: "Honda Scoopy", descripcion: "Automatic 110cc", unidad: "moto", tarifas: [{ dias: 1, precio: 110000, moneda: "IDR", etiqueta: null }], unidades: 2 }] });
  if (b.accion === "cotiza") {
    if (CASO === "regla") return res(409, { error: "reserva_dias_min", mensaje: "El alquiler más corto es de 7 días" });
    return res(200, { r: fx?.cotiza ? { ...fx.cotiza, producto_id: b.producto_id, desde: b.desde, hasta: b.hasta } : { dias: 3, precio: 330000, total: 330000, moneda: "IDR", precio_alquiler: 330000, desglose: null, base: 297297, impuestos: 32703, incluye_impuesto: true, impuesto: { nombre: "PPN", porcentaje: 11 }, lineas: [{ descripcion: "Honda Scoopy — 3 días", concepto: "alquiler", base: 297297, cuota: 32703, bruto: 330000 }], producto_id: b.producto_id, desde: b.desde, hasta: b.hasta, disponibles: 2 } });
  }
  if (b.accion === "reserva") {
    if (!st.cobros) return res(409, { error: "sin_configurar", paso: "cobros" });
    const total = fx?.cotiza?.total ?? 330000;
    const id = uuid(), caduca = Date.now() + 3540_000;
    st.reservas.set(id, { id, estado: "bloqueo", caduca, importe: total, clave: b.clave || null, cliente: null });
    return res(200, { r: { id, numero_reserva: `RSV-${st.seq}`, estado: "bloqueo", caduca_en: new Date(caduca).toISOString(), desde: b.desde, hasta: b.hasta, dias: 3, precio_total: total, moneda: "IDR", desglose: null, base: null, impuestos: null, incluye_impuesto: true, lineas: [{ descripcion: "Honda Scoopy", base: total }], cobro: { external_id: `rsv:${id}`, importe: total, moneda: "IDR", segundos_hasta_caducar: 3540 } } });
  }
  if (b.accion === "cliente") { const x = st.reservas.get(b.reserva_id); if (!x || x.cliente) return res(409, { error: "no_aplica" }); x.cliente = { nombre: b.nombre, pais: b.pais }; return res(200, { r: { ok: true, cliente_identificado: true, creado: true, motivo: null } }); }
  return res(400, { error: "accion" });
}
function edgeReservasEnlace(b) {
  const x = st.reservas.get(b.reserva_id);
  if (!x || x.estado !== "bloqueo") return res(409, { error: "no_pagable" });
  if (x.enlace) return res(200, { r: { url: x.enlace.url, caduca_en: new Date(x.enlace.caduca).toISOString(), external_id: `rsv:${x.id}`, repetido: true } });
  const inv = `inv_ensayo_${st.seq}`;
  x.enlace = { inv, url: `https://checkout-staging.xendit.co/web/${inv}`, caduca: x.caduca - 120_000 };
  st.invoices.set(inv, x.id);
  return res(200, { r: { url: x.enlace.url, caduca_en: new Date(x.enlace.caduca).toISOString(), external_id: `rsv:${x.id}`, repetido: false } });
}
function edgeReservasPago(raw, token) {
  if (token !== TOKEN_AJUSTES) return res(401, { error: "no_autorizado" });
  const b = JSON.parse(raw);
  const rid = st.invoices.get(b.id);
  if (!rid || `rsv:${rid}` !== b.external_id) return res(200, { ignorado: true });
  const x = st.reservas.get(rid);
  if (x.estado === "confirmada") return res(200, { ok: true, factura: { numero: x.factura } });
  x.estado = "confirmada"; x.factura = fx?.factura_numero || `PRBE110-F2026-${String(st.facturas.length + 1).padStart(5, "0")}`;
  st.facturas.push({ numero: x.factura, reserva: rid, total: x.importe, cliente: x.cliente });
  return res(200, { ok: true, factura: { numero: x.factura, total: x.importe, moneda: "IDR" } });
}
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (LOCAL(u.hostname)) return fetchReal(url, init);
  if (u.origin === URL_ERP) {
    const edge = u.pathname.replace("/functions/v1/", "");
    const hdr = init.headers || {};
    const get = (k) => (typeof hdr.get === "function" ? hdr.get(k) : hdr[k] ?? hdr[k.toLowerCase()]);
    if (edge === "reservas-pago") { inf.erp.push({ edge }); return edgeReservasPago(String(init.body), get("x-callback-token")); }
    if (get("x-bot-secret") !== SECRETO) return res(401, { error: "no_autorizado" });
    const b = JSON.parse(String(init.body));
    inf.erp.push({ edge, ...b, ...(b.contacto_telefono ? { contacto_telefono: "<tel>" } : {}) });
    if (edge === "reservas-bot") return edgeReservasBot(b);
    if (edge === "reservas-enlace") return edgeReservasEnlace(b);
    return res(404, { error: "modulo_no_activo" });
  }
  inf.bloqueado.push(`fetch:${u.hostname}`);
  throw new TypeError(`ensayo: red bloqueada (${u.hostname})`);
};

// ── WhatsApp, Telegram y Xendit por axios: se apuntan, no salen ────────────────────────────────────────────────────────────────
let wamid = 0;
axios.defaults.adapter = async (config) => {
  const u = new URL(config.url, config.baseURL);
  const ok = (data) => ({ data, status: 200, statusText: "OK", headers: {}, config, request: {} });
  if (LOCAL(u.hostname)) throw new Error("ensayo: axios a localhost no previsto");
  if (u.hostname === "graph.facebook.com" && /\/messages$/.test(u.pathname)) {
    const body = typeof config.data === "string" ? JSON.parse(config.data) : config.data;
    if (!body.to) return ok({ success: true });   // marca de leído / «escribiendo…»
    inf.whatsapp.push({ a: body.to === OWNER ? "owner" : body.to === TEL ? "cliente" : body.to, tipo: body.type, texto: body.text?.body ?? body.template?.name ?? null });
    return ok({ messages: [{ id: `wamid.ensayo.${++wamid}` }] });
  }
  if (u.hostname === "api.telegram.org") { const b = typeof config.data === "string" ? JSON.parse(config.data) : config.data; inf.telegram.push(String(b?.text || "").slice(0, 160)); return ok({ ok: true }); }
  inf.bloqueado.push(`axios:${u.hostname}${u.pathname.slice(0, 40)}`);
  throw new Error(`ensayo: red bloqueada (${u.hostname})`);
};

// ── el «modelo»: un guion que hace lo que haría Haiku en el camino bueno ─────────────────────────────────────────────────────────
const GUION = {
  en: { pide: "Hi! I'd like to rent a Honda Scoopy from 10 to 13 November. I'll pick it up at your office.", reserva: "Yes, book it please. My name is Ana Pérez and I'm from Spain.",
        precio: (t) => `The Honda Scoopy for 10–13 November is Rp ${t.toLocaleString("id-ID")} in total (tax included). Shall I book it for you?`, link: "Perfect, Ana, one moment while I prepare your booking." },
  id: { pide: "Halo kak, saya mau sewa Honda Scoopy tanggal 10 sampai 13 November, ambil di kantor ya.", reserva: "Iya kak, tolong dipesan. Nama saya Budi Santoso, dari Indonesia.",
        precio: (t) => `Honda Scoopy untuk tanggal 10–13 November totalnya Rp ${t.toLocaleString("id-ID")} (sudah termasuk pajak). Mau saya pesankan, kak?`, link: "Siap kak Budi, sebentar ya, saya siapkan pemesanannya." },
};
const g = GUION[CASO.startsWith("id") ? "id" : "en"];
const anio = new Date().getFullYear() + (new Date().getMonth() >= 10 ? 1 : 0);
let ultimoTotal = null;
function modelo(params) {
  const fin = (texto) => ({ id: "msg_ensayo", type: "message", role: "assistant", model: params.model, content: [{ type: "text", text: texto }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
  if (!params.tools) return fin(JSON.stringify({ summary: "ensayo", nextAction: "none" }));   // extractor/resumen
  const ultimo = params.messages[params.messages.length - 1];
  if (Array.isArray(ultimo.content) && ultimo.content.some((b) => b.type === "tool_result")) {
    const out = JSON.parse(ultimo.content.find((b) => b.type === "tool_result").content);
    // E110-I/J: lo que el modelo recibe del ERP (comisión ya dentro del total, seguro aparte) queda en el informe
    inf.al_modelo = { total: out.total ?? null, online_payment_fee: out.online_payment_fee ?? null, insurance: out.insurance ?? null };
    if (fx?.cotiza?.comision && !(out.online_payment_fee && out.online_payment_fee.amount === fx.cotiza.comision.importe && out.total === fx.cotiza.total)) inf.errores.push("la comisión del ERP no llega al modelo dentro del total");
    if (out.ok && out.available) { ultimoTotal = out.total; return fin(g.precio(out.total)); }
    return fin(`[sin precio: ${out.error || "?"}] ${out.note ? out.note.slice(0, 160) : ""}`);
  }
  const texto = typeof ultimo.content === "string" ? ultimo.content : (ultimo.content.find?.((b) => b.type === "text")?.text || "");
  if (texto.includes(g.reserva.slice(0, 12)) && ultimoTotal) {
    const [nombre, pais] = CASO.startsWith("id") ? ["Budi Santoso", "Indonesia"] : ["Ana Pérez", "Spain"];
    return fin(`${g.link} [LEAD name=${nombre}; country=${pais}] [PAY:${ultimoTotal}]`);
  }
  return { id: "msg_ensayo", type: "message", role: "assistant", model: params.model, stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 },
           content: [{ type: "tool_use", id: "toolu_ensayo", name: "get_quote", input: { bike_model: "Honda Scoopy", from: `${anio}-11-10`, to: `${anio}-11-13` } }] };
}
const proto = Object.getPrototypeOf(new Anthropic({ apiKey: "x" }).messages);
proto.stream = function (params) { return { finalMessage: async () => modelo(params) }; };
proto.create = async function (params) { return modelo(params); };

// ── el guion de la conversación ────────────────────────────────────────────────────────────────────────────
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(ruta, cuerpo, cab = {}) {
  const r = await fetchReal(`http://127.0.0.1:${PORT}${ruta}`, { method: "POST", headers: { "content-type": "application/json", ...cab }, body: JSON.stringify(cuerpo) });
  return r.status;
}
let nmsg = 0;
const mensaje = (texto) => post("/webhook", { entry: [{ changes: [{ field: "messages", value: { contacts: [{ profile: { name: "Ensayo" } }], messages: [{ id: `wamid.in.ensayo.${++nmsg}`, from: TEL, type: "text", text: { body: texto }, timestamp: String(Math.floor(Date.now() / 1000)) }] } }] }] });
// espera a que el cliente reciba un mensaje que cumpla `pred` (el turno manda el aviso de IA y la respuesta por separado, con pausa de tecleo)
async function esperaCliente(pred, ms = 90000, visto = inf.whatsapp.length) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (inf.whatsapp.slice(visto).some((m) => m.a === "cliente" && pred(String(m.texto || "")))) return true; await espera(250); }
  return false;
}
const esUrlPago = (t) => /https:\/\/checkout[-a-z]*\.xendit\.co\//.test(t);
async function guion() {
  for (let i = 0; i < 80; i++) { try { const r = await fetchReal(`http://127.0.0.1:${PORT}/`); if (r.status) break; } catch { /* aún no escucha */ } await espera(250); }
  await mensaje(g.pide);
  if (!(await esperaCliente((t) => /Rp |\[sin precio/.test(t)))) inf.errores.push("sin respuesta a la consulta");
  if (CASO !== "regla") {
    await mensaje(g.reserva);
    const antes = inf.whatsapp.length;
    // con enlace: se espera la URL; sin enlace (sin cobros), el texto fijo del cierre (pago en línea no disponible / fallo)
    if (!(await esperaCliente((t) => esUrlPago(t) || /isn't available|belum tersedia|no está disponible|couldn't generate|belum bisa membuat|No he podido/.test(t), 90000, antes))) inf.errores.push("sin respuesta al pedir la reserva");
    const [rid, x] = [...st.reservas.entries()][0] || [];
    if (x && x.enlace) {
      // Xendit avisa del pago (modo prueba) con el token de Ajustes › Cobros: la puerta lo reenvía a reservas-pago
      const raw = { id: x.enlace.inv, external_id: `rsv:${rid}`, status: "PAID", amount: x.importe, currency: "IDR" };
      const antesPago = inf.whatsapp.length;
      inf.aviso_xendit = await post("/webhook/xendit", raw, { "x-callback-token": TOKEN_AJUSTES });
      if (!(await esperaCliente((t) => /^✅/.test(t), 30000, antesPago))) inf.errores.push("sin mensaje de pago recibido");
      inf.aviso_xendit_repetido = await post("/webhook/xendit", raw, { "x-callback-token": TOKEN_AJUSTES });
      await espera(1500);
    }
  }
  // silencio de 6 s: que salgan los mensajes partidos con pausa de tecleo antes de cerrar
  for (let n = inf.whatsapp.length, t = Date.now(); Date.now() - t < 6000; ) { await espera(250); if (inf.whatsapp.length !== n) { n = inf.whatsapp.length; t = Date.now(); } }
  inf.reservas = [...st.reservas.values()].map((x) => ({ estado: x.estado, importe: x.importe, clave: x.clave ? "sí" : "no", cliente: !!x.cliente, factura: x.factura || null }));
  inf.facturas = st.facturas.length;
  console.log("\n=== INFORME DEL ENSAYO ===\n" + JSON.stringify(inf, null, 1));
  process.exit(inf.errores.length || inf.bloqueado.length ? 1 : 0);
}
setTimeout(() => guion().catch((e) => { console.error("ensayo:", e); process.exit(2); }), 50);
