// Reenvío del aviso de pago de Xendit de una RESERVA del ERP (external_id `rsv:…`) a la edge reservas-pago (F8 pieza 7b, 9-oct-2026).
//
// Por qué existe: el webhook de Xendit de BBM es UNO y apunta a este bot. Los cobros del flujo viejo (`paylink_<tel>_…`) los procesa el
// bot; los de una reserva del ERP (`rsv:<uuid>`) los confirma la edge reservas-pago del ERP, que vuelve a pedir la factura a Xendit y no se
// fía del cuerpo. El bot solo hace de pasarela, SIN mirar ni cambiar nada.
//
// Reglas (cada una con su porqué):
//   · Se reenvía el cuerpo EXACTO (req.rawBody) y el `x-callback-token` tal cual. Nunca JSON.stringify(req.body): re-serializar cambia
//     bytes y rompe cualquier comprobación futura sobre el cuerpo original.
//   · Independiente del interruptor (el del ERP desde B10, o el freno BBM_FRENO_DION): un pago `rsv:` llegado con el interruptor en `dion` (vuelta atrás) no puede perderse.
//   · El token de un `rsv:` lo valida la EDGE, no el bot (ver createXenditGate); el bot solo filtra la forma y limita por IP.
//   · La idempotencia es de la EDGE. Aquí no se deduplica: dos avisos iguales se reenvían los dos.
//   · Respuesta a Xendit (Xendit reintenta todo lo que no sea 2xx):
//        edge 200                      → 200 (incluso si la edge dice «pago a revisar»: ya lo tiene la base y avisa al equipo)
//        edge 400 / 413 (cuerpo malo)  → ese mismo 4xx (reintentar no lo arregla: nada de tormenta de reintentos)
//        sin cuerpo original (rawBody)  → 502 (es un fallo NUESTRO de parser/config: un 400 haría que Xendit dejara de reintentar y se perdería el pago)
//        cualquier otra cosa           → 502 (red, tiempo agotado, 5xx, y también 401/403/404/429: secreto o URL rotos, que NO son culpa
//                                         del cuerpo; Xendit seguirá reintentando mientras alguien lo arregla, y el pago no se pierde)
//        sin BBM_ERP_URL               → 503 (reintento; jamás perderlo en silencio)
//   · Tiempo propio MENOR que el de Xendit. La edge puede tardar hasta ~28 s en el peor caso (Xendit 8 + subida 8 + base 12); aquí 25 s.
//   · Nada de PII en logs: ni cuerpo, ni importes, ni teléfonos, ni correos. Solo el id de la factura y el código devuelto.

import crypto from "crypto";

export const RSV_PREFIX = "rsv:";
export const RSV_TIMEOUT_MS = 25000;

// ¿Este aviso es de una reserva del ERP? Mira el external_id ya parseado del cuerpo.
export function esAvisoRsv(body) {
  return !!body && typeof body === "object" && typeof body.external_id === "string" && body.external_id.startsWith(RSV_PREFIX);
}

export function createRsvForwarder(o = {}) {
  const { erpUrl, fetchImpl = globalThis.fetch, timeoutMs = RSV_TIMEOUT_MS, log = console, project = "bot" } = o;
  const base = typeof erpUrl === "string" ? erpUrl.trim().replace(/\/+$/, "") : "";
  const enabled = !!base;
  const p = (m) => `[${project}] [xendit-rsv] ${m}`;

  // → { status }  (el código que el bot devuelve a Xendit)
  async function reenvia({ rawBody, token, invoiceId }) {
    const id = typeof invoiceId === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(invoiceId) ? invoiceId : "?";
    if (!enabled) { log.warn(p(`aviso rsv sin BBM_ERP_URL: 503 para que Xendit reintente (factura ${id})`)); return { status: 503 }; }
    if (!Buffer.isBuffer(rawBody) && typeof rawBody !== "string") { log.error(p(`aviso rsv SIN cuerpo original (fallo del parser del bot, no del aviso): 502 para que Xendit reintente (factura ${id})`)); return { status: 502 }; }
    let r;
    try {
      r = await fetchImpl(`${base}/functions/v1/reservas-pago`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-callback-token": token },
        body: rawBody,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      log.error(p(`reservas-pago no contesta (${e && e.name === "TimeoutError" ? "tiempo" : "red"}): 502, Xendit reintenta (factura ${id})`));
      return { status: 502 };
    }
    const st = r.status;
    if (st === 200) {
      // El cuerpo de la edge dice qué pasó con el pago ({ok,factura|factura_espera} o {revisar}); solo se pasa tal cual a quien avisa al cliente.
      let cuerpo = null;
      try { cuerpo = await r.json(); } catch { /* sin cuerpo legible: el aviso al cliente será el genérico */ }
      log.log(p(`reenviado ok (factura ${id})`));
      return { status: 200, cuerpo };
    }
    if (st === 400 || st === 413) { log.error(p(`reservas-pago rechaza el cuerpo (${st}): se devuelve ${st} (factura ${id})`)); return { status: st }; }
    log.error(p(`reservas-pago devolvió ${st}: 502, Xendit reintenta (factura ${id})`));
    return { status: 502 };
  }

  return { enabled, reenvia };
}

// Filtro barato de un aviso `rsv:` ANTES de reenviarlo (condiciones de la consulta de Seguridad del 12-oct, F3 E2 Cobros, plan_f3_setup_modulos.md ›
// Corte del bot (3)). Un aviso real de Xendit las cumple siempre; lo que no, no llega a la edge.
export const RSV_MAX_BYTES = 64 * 1024;                 // un aviso de factura de Xendit ocupa ~2 KB
export const RSV_POR_IP_MIN = 120;                      // avisos `rsv:` por IP y minuto. Xendit los manda desde pocas IPs compartidas por TODOS los avisos
                                                       // de esta cuenta, así que el tope es por encima del volumen de BBM; frena el martilleo, no a Xendit
const TOKEN_FORMA = /^[A-Za-z0-9_-]{16,200}$/;
const RSV_EXTERNAL = /^rsv:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INVOICE_ID = /^[A-Za-z0-9_-]{1,100}$/;

// Límite por IP en memoria (un proceso): ventana fija de 1 minuto. Se vacía entero si crece demasiado (no es una lista de bloqueo).
export function createLimitePorIp({ max = RSV_POR_IP_MIN, ventanaMs = 60_000, now = () => Date.now(), tope = 5000 } = {}) {
  const m = new Map();
  return function admite(ip) {
    const t = now(), k = String(ip || "?").slice(0, 64);
    let e = m.get(k);
    if (!e || t - e.desde >= ventanaMs) { if (m.size >= tope) m.clear(); e = { desde: t, n: 0 }; m.set(k, e); }
    e.n += 1;
    return e.n <= max;
  };
}

// Puerta del webhook de Xendit, como middleware de Express.
//   · Aviso de una RESERVA del ERP (`rsv:`): filtro de forma (cabecera, external_id, id, tamaño) → límite por IP → reenvío a reservas-pago con el
//     `x-callback-token` del aviso. NO se exige el XENDIT_CALLBACK_TOKEN de Railway: decide la edge, que lo compara con el de Ajustes › Cobros (Vault)
//     o, si está vacío, con el de su entorno (F3 Entrega 2, 12-oct-2026). Si el bot exigiera el suyo, unas claves de otro modo o cuenta en Ajustes
//     dejarían morir aquí los avisos de pagos reales. Un token falso lo rechaza la edge (401 → 502 aquí; nada cambia en la base).
//   · Todo lo demás (`paylink_`, el flujo de Dion): el token de Railway, como siempre. Sin token configurado 503; distinto 403, en tiempo constante.
export function createXenditGate(o = {}) {
  // onResultado({ externalId, invoiceId, cuerpo }) — opcional, mejor esfuerzo, DESPUÉS de responder 200: avisar al cliente de que pagó. Un fallo ahí
  // jamás cambia lo que se contesta a Xendit (el pago ya está en la base; reintentar solo duplicaría el aviso, que además se deduplica aguas abajo).
  // ipDe(req) → ip del cliente (ipCliente de panel-cuentas.js); admiteIp(ip) → bool (createLimitePorIp).
  const { token: esperado, forwarder, onResultado, ipDe = (req) => String(req.ip || ""), admiteIp = createLimitePorIp(), log = console, project = "bot" } = o;
  return async function xenditGate(req, res, next) {
    const token = req.get("x-callback-token") || "";
    if (esAvisoRsv(req.body)) {
      const raw = req.rawBody;
      const largo = Buffer.isBuffer(raw) ? raw.length : typeof raw === "string" ? Buffer.byteLength(raw) : 0;
      if (!TOKEN_FORMA.test(token)) { log.warn(`[${project}] [xendit-rsv] aviso rsv sin token con forma válida: 403`); return res.sendStatus(403); }
      if (!RSV_EXTERNAL.test(req.body.external_id) || typeof req.body.id !== "string" || !INVOICE_ID.test(req.body.id)) { log.warn(`[${project}] [xendit-rsv] aviso rsv con external_id o id inválidos: 400`); return res.sendStatus(400); }
      if (largo > RSV_MAX_BYTES) { log.warn(`[${project}] [xendit-rsv] aviso rsv demasiado grande: 413`); return res.sendStatus(413); }
      let ipOk = true;
      try { ipOk = admiteIp(ipDe(req)); } catch { /* sin IP legible: se deja pasar, la edge decide */ }
      if (!ipOk) { log.warn(`[${project}] [xendit-rsv] demasiados avisos rsv desde una IP: 429`); return res.sendStatus(429); }
      try {
        const r = await forwarder.reenvia({ rawBody: req.rawBody, token, invoiceId: req.body.id });
        res.sendStatus(r.status);
        if (r.status === 200 && typeof onResultado === "function") {
          try { await onResultado({ externalId: req.body.external_id, invoiceId: req.body.id, cuerpo: r.cuerpo ?? null }); }
          catch { log.error(`[${project}] [xendit-rsv] el aviso al cliente falló (el pago ya está en la base)`); }
        }
        return;
      } catch (e) {
        log.error(`[${project}] [xendit-rsv] fallo inesperado al reenviar: 502, Xendit reintenta`);   // sin e.message: podría arrastrar datos del cuerpo
        return res.sendStatus(502);
      }
    }
    if (!esperado) { log.warn(`[${project}] /webhook/xendit recibido pero falta XENDIT_CALLBACK_TOKEN — ignorado`); return res.sendStatus(503); }
    const a = Buffer.from(token), b = Buffer.from(esperado);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) { log.warn(`[${project}] /webhook/xendit token inválido`); return res.sendStatus(403); }
    return next();
  };
}
