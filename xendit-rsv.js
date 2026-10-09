// Reenvío del aviso de pago de Xendit de una RESERVA del ERP (external_id `rsv:…`) a la edge reservas-pago (F8 pieza 7b, 9-oct-2026).
//
// Por qué existe: el webhook de Xendit de BBM es UNO y apunta a este bot. Los cobros del flujo viejo (`paylink_<tel>_…`) los procesa el
// bot; los de una reserva del ERP (`rsv:<uuid>`) los confirma la edge reservas-pago del ERP, que vuelve a pedir la factura a Xendit y no se
// fía del cuerpo. El bot solo hace de pasarela, SIN mirar ni cambiar nada.
//
// Reglas (cada una con su porqué):
//   · Se reenvía el cuerpo EXACTO (req.rawBody) y el `x-callback-token` tal cual. Nunca JSON.stringify(req.body): re-serializar cambia
//     bytes y rompe cualquier comprobación futura sobre el cuerpo original.
//   · Independiente de BBM_BACKEND: un pago `rsv:` llegado con el interruptor en `dion` (vuelta atrás) no puede perderse.
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

// Puerta del webhook de Xendit, como middleware de Express: token → (si es `rsv:`) reenvío → next() para todo lo demás.
// El token se valida ANTES de mirar el cuerpo (un aviso sin token válido no llega a nada, ni siquiera al reenvío). Misma semántica que tenía
// el handler: sin token configurado 503; token distinto 403, comparado en tiempo constante.
export function createXenditGate(o = {}) {
  // onResultado({ externalId, invoiceId, cuerpo }) — opcional, mejor esfuerzo, DESPUÉS de responder 200: avisar al cliente de que pagó. Un fallo ahí
  // jamás cambia lo que se contesta a Xendit (el pago ya está en la base; reintentar solo duplicaría el aviso, que además se deduplica aguas abajo).
  const { token: esperado, forwarder, onResultado, log = console, project = "bot" } = o;
  return async function xenditGate(req, res, next) {
    if (!esperado) { log.warn(`[${project}] /webhook/xendit recibido pero falta XENDIT_CALLBACK_TOKEN — ignorado`); return res.sendStatus(503); }
    const token = req.get("x-callback-token") || "";
    const a = Buffer.from(token), b = Buffer.from(esperado);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) { log.warn(`[${project}] /webhook/xendit token inválido`); return res.sendStatus(403); }
    if (esAvisoRsv(req.body)) {
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
    return next();
  };
}
