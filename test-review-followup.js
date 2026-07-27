// Self-check de la cadena de seguimiento agendado ("me lo reviso" → fecha → 2 toques).
// Replica la maquina de estados de followUpReminderTick sin red ni Redis. Node puro:
//   node test-review-followup.js
import assert from "assert";

const DAY = 24 * 3600000;
const GAP = 4 * DAY;

// Copia literal de la logica de decision del tick. Si cambia alla, cambia aqui y falla el test.
function decidir(sfu, lead, fu, now) {
  if (sfu.fu !== fu) sfu = { n: 0, at: 0, fu };
  if (sfu.n > 0 && sfu.n < 99 && lead.lastInboundAt && lead.lastInboundAt > sfu.at) {
    return { accion: "cerrar", sfu: { n: 99, at: sfu.at, fu } };
  }
  if (sfu.n === 0) return { accion: "toque1", sfu: { n: 1, at: now, fu } };
  if (sfu.n === 1 && now - sfu.at >= GAP) return { accion: "toque2", sfu: { n: 2, at: now, fu } };
  return { accion: "nada", sfu };
}

const FU = "2026-08-01";
const T0 = Date.parse("2026-08-01T09:00:00Z");
const vacio = { n: 0, at: 0, fu: null };

// 1. Vence la fecha → primer toque.
let r = decidir(vacio, {}, FU, T0);
assert.equal(r.accion, "toque1");

// 2. Media hora despues (el tick corre cada 30 min) NO repite.
assert.equal(decidir(r.sfu, {}, FU, T0 + 1800000).accion, "nada");

// 3. Sigue callado 3 dias: aun no toca el segundo.
assert.equal(decidir(r.sfu, {}, FU, T0 + 3 * DAY).accion, "nada");

// 4. A los 4 dias entra el re-follow-up.
const r2 = decidir(r.sfu, {}, FU, T0 + 4 * DAY);
assert.equal(r2.accion, "toque2");

// 5. Agotada: no manda mas aunque pasen semanas.
assert.equal(decidir(r2.sfu, {}, FU, T0 + 30 * DAY).accion, "nada");

// 6. Si contesta tras el 1er toque, la cadena se cierra y NO llega el segundo.
const contesto = { lastInboundAt: T0 + 1 * DAY };
const rc = decidir(r.sfu, contesto, FU, T0 + 2 * DAY);
assert.equal(rc.accion, "cerrar");
assert.equal(decidir(rc.sfu, contesto, FU, T0 + 10 * DAY).accion, "nada");

// 7. El bug que motivo atar el estado a la fecha: contestar borraba el contador y el lead
//    recibia otra vez el "dijiste que te lo mirabas". Con la misma fecha no debe reabrirse.
assert.equal(decidir(rc.sfu, contesto, FU, T0 + 40 * DAY).accion, "nada");

// 8. Pero una fecha NUEVA (el bot le agenda otro seguimiento) si arranca cadena limpia.
assert.equal(decidir(rc.sfu, contesto, "2026-11-20", T0 + 40 * DAY).accion, "toque1");

// 9. Un lead que responde ANTES del primer toque no lo bloquea: la cadena aun no existe,
//    y llegado el dia se le escribe igual (la fecha la puso el, no nosotros).
assert.equal(decidir(vacio, { lastInboundAt: T0 - 5 * DAY }, FU, T0).accion, "toque1");

console.log("OK — cadena de seguimiento agendado: 9 casos");
