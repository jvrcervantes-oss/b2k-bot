// Seguimiento del bot leído del ERP (F8 pieza 6, 9-oct-2026).
//
// Qué es: con ERP_SEGUIMIENTO_URL + ERP_SEGUIMIENTO_SECRET puestas, la configuración del seguimiento automático (activo, cada cuántas
// horas, máximo por lead, plantilla, idioma, variables) sale del ERP del cliente (edge wab-config → objeto `seguimiento`), no de las
// variables FOLLOWUP_*. SIN esas dos variables este módulo no se usa y el motor se comporta EXACTAMENTE como antes.
//
// Este módulo SOLO devuelve el objeto `seguimiento`. No es erp-config.js (el de la ficha de main): aquel activa todo el modo ERP
// (contexto desde ficha, aviso de IA, consentimiento) y aquí no se quiere nada de eso. Variables y flag propios.
//
// Todo entra por createSeguimientoConfig(opciones): no toca el entorno ni la red por su cuenta, así se prueba con un fetch de mentira.
//
// Reglas (cada una con su porqué):
//   · Con las variables del ERP puestas, MANDA el ERP. Nunca se vuelve a FOLLOWUP_* por un fallo: un bot que, con el ERP caído, retoma la
//     configuración vieja puede mandar plantillas que el cliente apagó a propósito. El peor caso es callarse.
//   · La caché SOLO tapa «el ERP no contesta» (red, timeout, 5xx, respuesta ilegible), y como máximo 24 h. Pasadas, APAGADO.
//   · Un apagado explícito del ERP (activo:false, 404 de módulo apagado, valor ausente o inválido) se sirve al instante aunque haya caché,
//     y SUSTITUYE a la caché: no hay forma de que una caída posterior reactive un seguimiento que el cliente apagó.
//   · Un 401/403 es un secreto roto: apagado, log ruidoso y se descarta la caché (rotar el secreto tiene que cortar el envío).
//   · Valor ausente, de tipo erróneo o fuera de rango ⇒ APAGADO. Nunca se rellena con FOLLOWUP_* ni con un valor «razonable».
//   · Los topes duros viven AQUÍ como constantes (no se leen del ERP): aunque la base se cambie o alguien edite la fila, el motor no
//     manda cada 2 horas ni 50 mensajes por lead.

export const HORAS_MIN = 24, HORAS_MAX = 720;      // cada cuántas horas: ni spam (<24 h) ni «seguimiento» de más de 30 días
export const MAX_MIN = 1, MAX_MAX = 5;             // mensajes por lead
export const VARS_MAX = 10;
export const PLANTILLA_MAX = 512;
// Lista CERRADA de variables: el ERP manda NOMBRES de dato, nunca texto. Cada nombre lo resuelve el motor (seguimiento-tick.js).
export const VARS_VALIDAS = ["nombre"];

const RE_PLANTILLA = /^[a-z0-9_]+$/;
const RE_IDIOMA = /^[a-z]{2,3}(_[A-Z]{2})?$/;

const OFF = (reason) => ({ on: false, reason });

// Valida y normaliza el objeto `seguimiento` tal como llega del ERP. NUNCA lanza.
export function normalizaSeguimiento(s) {
  if (s === null || s === undefined || typeof s !== "object" || Array.isArray(s)) return OFF("ausente");
  if (s.activo === false) return OFF("apagado");
  if (s.activo !== true) return OFF("activo_invalido"); // «true», 1, "si"… no valen: solo el booleano
  if (!Number.isInteger(s.horas) || s.horas < HORAS_MIN || s.horas > HORAS_MAX) return OFF("horas_invalido");
  if (!Number.isInteger(s.max_mensajes) || s.max_mensajes < MAX_MIN || s.max_mensajes > MAX_MAX) return OFF("max_invalido");
  if (typeof s.plantilla !== "string" || s.plantilla.length > PLANTILLA_MAX || !RE_PLANTILLA.test(s.plantilla)) return OFF("plantilla_invalida");
  if (typeof s.idioma !== "string" || !RE_IDIOMA.test(s.idioma)) return OFF("idioma_invalido");
  if (!Array.isArray(s.vars) || s.vars.length > VARS_MAX || !s.vars.every((v) => typeof v === "string" && VARS_VALIDAS.includes(v))) return OFF("vars_invalidas");
  return {
    on: true, reason: null,
    cfg: {
      horas: s.horas, max: s.max_mensajes, plantilla: s.plantilla, idioma: s.idioma, vars: [...s.vars],
      version: Number.isInteger(s.version) ? s.version : null,
    },
  };
}

export function createSeguimientoConfig(o = {}) {
  const {
    url, secret,
    ttlMs = 30000, timeoutMs = 3000, maxStaleMs = 24 * 3600 * 1000,
    fetchImpl = globalThis.fetch, now = () => Date.now(), log = console, project = "bot",
  } = o;
  const enabled = !!(url && secret);
  let last = null;      // { at, norm } último dato BUENO del ERP (también «apagado»: es un dato bueno)
  let inflight = null;
  let lastWarnAt = 0;
  let lastView = null;  // para /admin/api/health sin tocar la red

  const p = (m) => `[${project}] [ERP-seguimiento] ${m}`;
  const warnOnce = (msg) => { if (now() - lastWarnAt > 60000) { lastWarnAt = now(); log.warn(p(msg)); } };

  async function fetchOnce() {
    try {
      const r = await fetchImpl(url, {
        method: "POST", body: "{}",
        headers: { "x-wab-config": secret, "content-type": "application/json", accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (r.status === 401 || r.status === 403) {
        log.error(p(`SECRETO RECHAZADO por el ERP (HTTP ${r.status}): seguimiento APAGADO. Revisa ERP_SEGUIMIENTO_SECRET.`));
        return { ok: false, why: `http_${r.status}`, fatal: true };
      }
      if (r.status === 404) {
        // Módulo apagado o edge retirada (o URL mal puesta): es «apagado», no «caído». Si se tratara como caída, la caché seguiría
        // sirviendo un seguimiento encendido y apagar el módulo no surtiría efecto.
        warnOnce("el ERP contesta 404 (módulo apagado, edge retirada o ERP_SEGUIMIENTO_URL mal puesta): seguimiento APAGADO");
        return { ok: true, norm: OFF("modulo_apagado") };
      }
      if (!r.ok) return { ok: false, why: `http_${r.status}` };
      let body;
      try { body = await r.json(); } catch { return { ok: false, why: "json" }; }
      const d = body && body.r !== undefined ? body.r : body;
      if (!d || typeof d !== "object" || Array.isArray(d)) return { ok: false, why: "forma" };
      if (d.encendido === false) return { ok: true, norm: OFF("modulo_apagado") };
      return { ok: true, norm: normalizaSeguimiento(d.seguimiento) };
    } catch (e) {
      return { ok: false, why: e && e.name === "TimeoutError" ? "timeout" : (e && e.message) || "error" };
    }
  }

  // Un solo fetch a la vez.
  function refresh() {
    if (!inflight) inflight = fetchOnce().finally(() => { inflight = null; });
    return inflight;
  }

  const vista = (norm, source, at) =>
    norm.on
      ? { mode: "on", reason: null, source, version: norm.cfg.version, cfg: norm.cfg, at }
      : { mode: "off", reason: norm.reason, source, version: null, cfg: null, at };

  // resolve() → { mode: 'env'|'on'|'off', reason, source: 'erp'|'cache'|null, version, cfg?, at }
  //   env = sin variables del ERP: el llamador usa FOLLOWUP_* como siempre.
  //   on  = el ERP manda y está encendido (cfg ya validada y normalizada).
  //   off = el ERP manda y NO se debe enviar nada.
  async function resolve() {
    if (!enabled) return { mode: "env", reason: null, source: null, version: null, cfg: null, at: null };
    const t = now();
    let view;
    if (last && t - last.at < ttlMs) {
      view = vista(last.norm, "erp", last.at);
    } else {
      const r = await refresh();
      if (r.ok) {
        last = { at: now(), norm: r.norm };
        view = vista(r.norm, "erp", last.at);
      } else if (r.fatal) {
        last = null; // rotar el secreto corta el envío: la caché no sobrevive
        view = { mode: "off", reason: "secreto_rechazado", source: "erp", version: null, cfg: null, at: null };
      } else if (last && t - last.at <= maxStaleMs) {
        warnOnce(`ERP no contesta (${r.why}): se usa la caché de hace ${Math.round((t - last.at) / 1000)} s`);
        view = vista(last.norm, "cache", last.at);
      } else {
        warnOnce(`ERP no contesta (${r.why}) y no hay caché útil (<24 h): seguimiento APAGADO`);
        view = { mode: "off", reason: "erp_inalcanzable_sin_cache", source: null, version: null, cfg: null, at: null };
      }
    }
    lastView = { mode: view.mode, reason: view.reason, source: view.source, version: view.version, at: view.at };
    return view;
  }

  function status() {
    return {
      enabled, ttl_s: Math.round(ttlMs / 1000), view: lastView,
      cache_age_s: last ? Math.round((now() - last.at) / 1000) : null,
    };
  }

  return { enabled, resolve, status };
}
