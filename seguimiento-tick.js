// Tick del seguimiento automático (re-enganche de leads fríos tras la ventana de 24 h), sacado de index.js para poder probarlo entero
// con dependencias de mentira (index.js arranca Express + Redis al importarse y no se puede cargar en un test).
//
// DOS orígenes de configuración:
//   · source 'env'  — sin ERP_SEGUIMIENTO_URL/SECRET: variables FOLLOWUP_*, igual que en index.js salvo dos arreglos (9-oct-2026):
//                     un envío fallido NO sube el contador (descansa 6 h) y el contador tiene TTL largo con corte fuera_de_escalera.
//   · source 'erp'/'cache' — el ERP manda (seguimiento-config.js). Aquí hay endurecimientos propios:
//        - un envío FALLIDO no incrementa el contador `followup:<tel>` (si no, un fallo dejaba al lead «contactado» sin haberlo sido);
//          en su lugar el lead descansa 6 h en memoria para no reintentar cada 30 min;
//        - tope GLOBAL por día (FOLLOWUP_ERP_DAILY_CAP), independiente de lo que diga el ERP: freno contra bucles y contra una
//          configuración demasiado generosa;
//        - el teléfono NO sale en claro en los logs (id de contacto hasheado).
//
// CADENCIA. El ERP manda una sola cifra, `horas`, y un máximo. El peldaño n (n = mensajes ya enviados, 0-based) toca cuando el lead
// lleva frío horas*(n+1) h desde su último mensaje: con horas=48 y max=3 → 48 h, 96 h, 144 h. La cadencia se mide desde el último
// mensaje DEL CLIENTE, no desde el último envío del bot (igual que FOLLOWUP_SCHEDULE).
// ⚠ Cambiar `horas` o `max` a mitad de vida DESPLAZA el peldaño `schedule[sent]` de los leads que ya llevan mensajes enviados: un lead
//   con 1 enviado a las 48 h que pasa a horas=24 volvería a estar «por encima» de su siguiente peldaño (48 h) y recibiría el 2º
//   mensaje en el siguiente tick; al revés (24 → 72), esperaría más. Es intencionado (el contador es por lead, la cadencia es global);
//   se avisa en la pantalla del ERP y aquí. Subir `max` reabre a los leads que ya habían llegado al tope anterior.

import crypto from "crypto";

export const FOLLOWUP_ERP_DAILY_CAP = 40;          // envíos de seguimiento por día y por bot en modo ERP (constante; no la toca el ERP)
export const FOLLOWUP_FAIL_REST_MS = 6 * 3600 * 1000; // descanso de un lead tras un envío fallido (modo ERP)
// Filtro «cotización aún vendible» (F8 pieza 6, seguimiento-viva.js). Constantes del motor: el ERP no las toca.
export const VIVA_MAX_CONSULTAS_TICK = 10;            // consultas `cotiza` por pasada (cotiza no tiene tope en la edge: el freno es este). NO gastan el tope diario de ENVÍOS
export const VIVA_FALLOS_SEGUIDOS_MAX = 2;            // dos «el ERP no contesta» seguidos cortan las consultas de la pasada
export const VIVA_REST_MS = 6 * 3600 * 1000;          // un lead con veredicto negativo no se vuelve a consultar en 6 h
// TTL del contador followup:<tel> en modo ERP. El de siempre es 30 días, y con horas altas caduca ANTES de que el lead llegue al tope
// (horas=720,max=5 → la escalera dura 180 días): el contador volvería a 0 y el bot repetiría la tanda para siempre. 190 días cubre el
// máximo posible (HORAS_MAX*(MAX_MAX+1) = 4320 h = 180 días) con margen. El modo env conserva sus 30 días.
export const FOLLOWUP_ERP_COUNTER_TTL_S = 190 * 24 * 3600;

// Modo variables: TTL = última hora de la escalera + 30 días de margen, con tope de 400 días.
export const ENV_COUNTER_TTL_MARGIN_S = 30 * 24 * 3600;
export const ENV_COUNTER_TTL_MAX_S = 400 * 24 * 3600;

const H_MS = 3600 * 1000;
const RE_PLANTILLA = /^[a-z0-9_]+$/;
const RE_IDIOMA = /^[a-z]{2,3}(_[A-Z]{2})?$/;

// Lista cerrada: nombre de variable (lo manda el ERP) → cómo la resuelve el motor. Nada de texto libre del ERP en el mensaje.
export const VAR_RESOLVERS = {
  nombre: (lead) => (lead.name || "").trim().split(/\s+/)[0] || "there",
};

// Plan de envío a partir de la vista del lector del ERP y de las variables FOLLOWUP_*. Devuelve:
//   { off: true, reason } si no hay que enviar,  o  { source, template, lang, schedule, maxN, vars|nVars, version }.
export function buildPlan(view, env) {
  if (view.mode === "off") return { off: true, reason: view.reason, source: view.source };
  if (view.mode === "on") {
    const c = view.cfg;
    // Defensa en profundidad: la config ya viene validada, pero el motor revalida lo que acaba en una petición a Meta.
    if (!c || !Number.isInteger(c.horas) || c.horas < 24 || c.horas > 720
      || !Number.isInteger(c.max) || c.max < 1 || c.max > 5
      || typeof c.plantilla !== "string" || !RE_PLANTILLA.test(c.plantilla)
      || typeof c.idioma !== "string" || !RE_IDIOMA.test(c.idioma)
      || !Array.isArray(c.vars) || !c.vars.every((v) => Object.prototype.hasOwnProperty.call(VAR_RESOLVERS, v))) {
      return { off: true, reason: "config_invalida", source: view.source };
    }
    const schedule = Array.from({ length: c.max }, (_, i) => c.horas * (i + 1));
    return { source: view.source, template: c.plantilla, lang: c.idioma, schedule, maxN: c.max, vars: c.vars, version: c.version, horas: c.horas };
  }
  // mode 'env': exactamente lo que hacía index.js con FOLLOWUP_*
  if (!env.templateName) return { off: true, reason: "sin_plantilla_env", source: null, silent: true };
  const schedule = (env.schedule || "24,72").split(",").map((s) => parseFloat(s)).filter((n) => !isNaN(n) && n >= 24);
  if (!schedule.length) return { off: true, reason: "sin_cadencia_env", source: null, silent: true };
  const maxN = parseInt(env.max) || schedule.length;
  const nVars = env.vars != null ? parseInt(env.vars) : 1;
  // TTL del contador y corte de escalera propios del modo variables (antes: 30 días fijos, y al caducar se rearmaba la tanda para siempre).
  const last = schedule[schedule.length - 1];
  const step = schedule.length > 1 ? last - schedule[schedule.length - 2] : last;
  const ttlS = Math.min(Math.ceil(last * 3600) + ENV_COUNTER_TTL_MARGIN_S, ENV_COUNTER_TTL_MAX_S);
  return { source: "env", template: env.templateName, lang: env.lang, schedule, maxN, nVars, version: null, ttlS, cutoffH: last + step };
}

// d: { project, isBotEnabled, resolveView, env, listLeads, isOwner, getCount, setCount, send, skipStatus, skipIntent,
//      dayCount, dayBump, now, log }
//   send(phone, template, lang, params, logId) → { ok } (sendWhatsAppTemplate de index.js; NO lanza)
//   dayCount() → envíos de hoy;  dayBump() → +1
export function createFollowupRunner(d) {
  const log = d.log || console;
  const now = d.now || (() => Date.now());
  const failedAt = new Map();   // teléfono → ms del último fallo de envío (modo ERP)
  const vivaRest = new Map();   // teléfono → ms del último veredicto negativo del filtro «vendible»
  let lastPass = null;          // resumen de la última pasada (lo lee /admin/api/health)
  let running = false;
  let lastStateKey = "";
  // HMAC con una clave del bot (d.hashKey = el secreto del ERP): un sha256 sin clave sobre teléfonos se revierte por fuerza bruta.
  const hashId = (phone) => "c_" + crypto.createHmac("sha256", String(d.hashKey || d.project)).update(`${d.project}:${String(phone)}`).digest("hex").slice(0, 10);

  async function tick() {
    try {
      if (!(await d.isBotEnabled())) return; // bot apagado (interruptor global) → tampoco hace seguimiento
      const view = await d.resolveView();
      const plan = buildPlan(view, d.env);
      if (plan.off) {
        if (plan.silent) return; // sin plantilla en variables: silencio de siempre
        const key = `off:${plan.reason}`;
        if (key !== lastStateKey) { lastStateKey = key; log.log(`[${d.project}] Seguimiento APAGADO por el ERP (motivo: ${plan.reason}); no se envía nada`); }
        return;
      }
      const erp = plan.source !== "env";
      const stateKey = `on:${plan.source}:${plan.version}:${plan.template}`;
      if (erp && stateKey !== lastStateKey) {
        lastStateKey = stateKey;
        log.log(`[${d.project}] Seguimiento ENCENDIDO por el ERP (fuente: ${plan.source}, versión de config: ${plan.version}, plantilla: ${plan.template}, cada ${plan.schedule[0]}h, máx ${plan.maxN})`);
      }
      if (erp) { if (running) return; running = true; } // sin solapes: dos ticks a la vez duplicarían envíos antes de contar
      try {
        await pass(plan, erp);
      } finally { if (erp) running = false; }
    } catch (e) {
      log.error(`[${d.project}] followupTick error: ${e.message}`);
    }
  }

  async function pass(plan, erp) {
    const { schedule, maxN } = plan;
    const t = now();
    const _d = new Date(t);
    const todayStr = _d.getFullYear() + "-" + ("0" + (_d.getMonth() + 1)).slice(-2) + "-" + ("0" + _d.getDate()).slice(-2);
    const leads = await d.listLeads();
    const skipped = {};
    const skip = (why) => { skipped[why] = (skipped[why] || 0) + 1; };
    let sentNow = 0, failedNow = 0, capHit = false;
    // Filtro «solo cotizaciones aún vendibles» (solo origen ERP). viva = verificador (seguimiento-viva.js) o null; vivaRequerida = el interruptor ERP_SEGUIMIENTO_VIVA no está en 0.
    // Requerido y sin verificador (bot sin BBM_ERP_URL) ⇒ no se envía a nadie: fail-closed, nunca «sin filtro por si acaso».
    const viva = erp && d.viva ? d.viva() : null;
    const vivaOn = erp && (d.vivaRequerida ? d.vivaRequerida() : false);
    let consultas = 0, fallosSeguidos = 0;
    for (const l of leads) {
      if (d.isOwner(l.phone)) { skip("owner"); continue; }
      if (l.paused) { skip("pausado"); continue; }                              // humano al mando
      if (d.skipStatus.has(l.status)) { skip("cerrado"); continue; }            // cerrado (ganado/perdido/no-show)
      if (d.skipIntent.has(l.intent)) { skip("escalado"); continue; }           // hay una duda escalada al owner
      // Seguimiento AGENDADO a futuro (p.ej. waitlist "avísame cuando abráis 2027"):
      // no auto-nudge; ya lo cubre followUpReminderTick avisando al owner en esa fecha.
      if (l.nextFollowUp && String(l.nextFollowUp).slice(0, 10) > todayStr) { skip("agendado"); continue; }
      if (Array.isArray(l.tags) && l.tags.some((x) => /waitlist/i.test(x))) { skip("waitlist"); continue; } // en lista de espera
      if (!l.lastInboundAt) { skip("sin_inbound"); continue; }
      const coldH = (t - l.lastInboundAt) / 3600000;
      if (coldH < 24) { skip("ventana_abierta"); continue; }                    // ventana abierta → el bot ya responde solo
      // Solo ERP: pasado el final de la escalera (horas*(max+1)) el lead ya no se toca. Esto ACOTA qué leads entran; NO evita la ráfaga
      // (eso lo hace la separación mínima de más abajo). Cierra dos huecos: (1) un contador que se perdió (Redis vaciado, reinicio sin
      // Redis) no rearma una tanda entera sobre un lead frío de meses; (2) acota el primer tick tras encender el ERP: los leads
      // antiguos con contador 0 no entran, solo los que están DENTRO de la escalera.
      if (erp && coldH >= schedule[schedule.length - 1] + plan.horas) { skip("fuera_de_escalera"); continue; }
      const sent = await d.getCount(l.phone);
      // Modo variables: un lead frío más allá del último peldaño (+ un paso) sin contador NO recibe un primer mensaje (el contador
      // caducado o perdido no rearma la tanda). Solo con contador 0: a mitad de escalera no se corta.
      if (!erp && sent === 0 && coldH >= plan.cutoffH) { skip("fuera_de_escalera"); continue; }
      if (sent >= maxN) { skip("tope_intentos"); continue; }                    // tope de intentos alcanzado
      const dueH = schedule[sent] != null ? schedule[sent] : schedule[schedule.length - 1];
      if (coldH < dueH) { skip("no_toca"); continue; }                          // aún no toca el siguiente intento

      if (!erp) {
        // Origen variables: misma plantilla, params, cadencia, filtros y línea de log de siempre. Un envío fallido ya NO cuenta (como en ERP):
        // el lead descansa 6 h en memoria para no reintentar cada tick.
        const rest = failedAt.get(l.phone);
        if (rest && t - rest < FOLLOWUP_FAIL_REST_MS) { skip("descanso_tras_fallo"); continue; }
        const firstName = VAR_RESOLVERS.nombre(l);
        const params = plan.nVars >= 1 ? [firstName] : [];
        const r = await d.send(l.phone, plan.template, plan.lang, params);
        if (!r || r.ok !== true) {
          failedAt.set(l.phone, t);
          log.error(`[${d.project}] Follow-up ${sent + 1}/${maxN} NO enviado a ${l.phone}: el contador NO sube`);
          continue;
        }
        failedAt.delete(l.phone);
        await d.setCount(l.phone, sent + 1, plan.ttlS);
        log.log(`[${d.project}] Follow-up ${sent + 1}/${maxN} enviado a ${l.phone} (frío ${coldH.toFixed(0)}h)`);
        continue;
      }

      // Origen ERP
      // Separación mínima: un lead frío 100 h con horas=48 ya supera los peldaños 1 y 2; sin esto recibiría el 1º y, 30 min después, el 2º.
      // Entre dos envíos al mismo lead pasan al menos `horas` horas (hora del último envío guardada aparte del contador).
      const lastAt = d.getLastSent ? await d.getLastSent(l.phone) : 0;
      if (lastAt && t - lastAt < plan.horas * H_MS) { skip("separacion_minima"); continue; }
      const rest = failedAt.get(l.phone);
      if (rest && t - rest < FOLLOWUP_FAIL_REST_MS) { skip("descanso_tras_fallo"); continue; }
      if ((await d.dayCount()) >= FOLLOWUP_ERP_DAILY_CAP) { skip("tope_diario"); capHit = true; break; }
      if (vivaOn) {
        // Va DESPUÉS de todos los filtros baratos y del tope diario, y ANTES de dayBump: la consulta no gasta el tope de envíos.
        if (!viva) { skip("sin_verificador"); continue; }
        const vr = vivaRest.get(l.phone);
        if (vr && t - vr < VIVA_REST_MS) { skip("descanso_vendible"); continue; }
        if (consultas >= VIVA_MAX_CONSULTAS_TICK) { skip("tope_consultas"); continue; }
        if (fallosSeguidos >= VIVA_FALLOS_SEGUIDOS_MAX) { skip("erp_caido"); continue; }
        let v;
        try { v = await viva.verifica(l.phone); } catch { v = { ok: false, motivo: "erp_no_confirma", descansa: true, llamo: true }; }
        if (v && v.llamo) consultas++;      // solo cuenta la que salió a la red: un lead sin cotización guardada (p. ej. los de Dion) no gasta presupuesto
        if (!v || v.ok !== true) {
          const motivo = v && v.motivo ? v.motivo : "erp_no_confirma";
          skip(motivo);
          if (motivo === "erp_no_confirma") fallosSeguidos++; else if (v && v.llamo) fallosSeguidos = 0; // solo una respuesta real del ERP rompe la racha
          if (!v || v.descansa) vivaRest.set(l.phone, t);
          continue;
        }
        fallosSeguidos = 0;
      }
      const params = plan.vars.map((v) => VAR_RESOLVERS[v](l));
      const id = hashId(l.phone);
      await d.dayBump(); // cuenta el INTENTO (también el fallido): un bucle de fallos tampoco puede pasar del tope
      const r = await d.send(l.phone, plan.template, plan.lang, params, id);
      if (!r || r.ok !== true) {
        failedAt.set(l.phone, t);
        failedNow++;
        log.error(`[${d.project}] Follow-up NO enviado a ${id} (plantilla ${plan.template}, config v${plan.version}, intento ${sent + 1}/${maxN}): el contador NO sube`);
        continue;
      }
      failedAt.delete(l.phone);
      await d.setCount(l.phone, sent + 1, FOLLOWUP_ERP_COUNTER_TTL_S);
      if (d.setLastSent) await d.setLastSent(l.phone, t, FOLLOWUP_ERP_COUNTER_TTL_S); // solo tras un envío OK: un fallo no guarda la hora
      sentNow++;
      log.log(`[${d.project}] Follow-up ${sent + 1}/${maxN} enviado a ${id} (plantilla ${plan.template}, config v${plan.version}, frío ${coldH.toFixed(0)}h)`);
    }
    if (erp) {
      const resumen = Object.entries(skipped).map(([k, n]) => `${k}=${n}`).join(" ") || "-";
      log.log(`[${d.project}] Seguimiento (ERP v${plan.version}): enviados ${sentNow}, fallidos ${failedNow}${capHit ? ", TOPE DIARIO alcanzado" : ""}; omitidos: ${resumen}`);
    }
    lastPass = { en: t, sentNow, failedNow, skipped, capHit, consultas };
    return { sentNow, failedNow, skipped, capHit };
  }

  return { tick, pass, hashId, last: () => lastPass };
}
