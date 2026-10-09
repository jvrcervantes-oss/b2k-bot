// Tick del seguimiento automático (re-enganche de leads fríos tras la ventana de 24 h), sacado de index.js para poder probarlo entero
// con dependencias de mentira (index.js arranca Express + Redis al importarse y no se puede cargar en un test).
//
// DOS orígenes de configuración:
//   · source 'env'  — sin ERP_SEGUIMIENTO_URL/SECRET: variables FOLLOWUP_*, comportamiento IDÉNTICO al que había en index.js
//                     (incluido que un envío fallido incrementa el contador; ver más abajo por qué no se ha tocado).
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
    return { source: view.source, template: c.plantilla, lang: c.idioma, schedule, maxN: c.max, vars: c.vars, version: c.version };
  }
  // mode 'env': exactamente lo que hacía index.js con FOLLOWUP_*
  if (!env.templateName) return { off: true, reason: "sin_plantilla_env", source: null, silent: true };
  const schedule = (env.schedule || "24,72").split(",").map((s) => parseFloat(s)).filter((n) => !isNaN(n) && n >= 24);
  if (!schedule.length) return { off: true, reason: "sin_cadencia_env", source: null, silent: true };
  const maxN = parseInt(env.max) || schedule.length;
  const nVars = env.vars != null ? parseInt(env.vars) : 1;
  return { source: "env", template: env.templateName, lang: env.lang, schedule, maxN, nVars, version: null };
}

// d: { project, isBotEnabled, resolveView, env, listLeads, isOwner, getCount, setCount, send, skipStatus, skipIntent,
//      dayCount, dayBump, now, log }
//   send(phone, template, lang, params, logId) → { ok } (sendWhatsAppTemplate de index.js; NO lanza)
//   dayCount() → envíos de hoy;  dayBump() → +1
export function createFollowupRunner(d) {
  const log = d.log || console;
  const now = d.now || (() => Date.now());
  const failedAt = new Map();   // teléfono → ms del último fallo de envío (modo ERP)
  let running = false;
  let lastStateKey = "";
  const hashId = (phone) => "c_" + crypto.createHash("sha256").update(`${d.project}:${String(phone)}`).digest("hex").slice(0, 10);

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
      const sent = await d.getCount(l.phone);
      if (sent >= maxN) { skip("tope_intentos"); continue; }                    // tope de intentos alcanzado
      const dueH = schedule[sent] != null ? schedule[sent] : schedule[schedule.length - 1];
      if (coldH < dueH) { skip("no_toca"); continue; }                          // aún no toca el siguiente intento

      if (!erp) {
        // Origen variables: idéntico al index.js anterior. Un envío fallido SÍ cuenta aquí (comportamiento histórico, no se toca).
        const firstName = VAR_RESOLVERS.nombre(l);
        const params = plan.nVars >= 1 ? [firstName] : [];
        await d.send(l.phone, plan.template, plan.lang, params);
        await d.setCount(l.phone, sent + 1);
        log.log(`[${d.project}] Follow-up ${sent + 1}/${maxN} enviado a ${l.phone} (frío ${coldH.toFixed(0)}h)`);
        continue;
      }

      // Origen ERP
      const rest = failedAt.get(l.phone);
      if (rest && t - rest < FOLLOWUP_FAIL_REST_MS) { skip("descanso_tras_fallo"); continue; }
      if ((await d.dayCount()) >= FOLLOWUP_ERP_DAILY_CAP) { skip("tope_diario"); capHit = true; break; }
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
      await d.setCount(l.phone, sent + 1);
      sentNow++;
      log.log(`[${d.project}] Follow-up ${sent + 1}/${maxN} enviado a ${id} (plantilla ${plan.template}, config v${plan.version}, frío ${coldH.toFixed(0)}h)`);
    }
    if (erp) {
      const resumen = Object.entries(skipped).map(([k, n]) => `${k}=${n}`).join(" ") || "-";
      log.log(`[${d.project}] Seguimiento (ERP v${plan.version}): enviados ${sentNow}, fallidos ${failedNow}${capHit ? ", TOPE DIARIO alcanzado" : ""}; omitidos: ${resumen}`);
    }
    return { sentNow, failedNow, skipped, capHit };
  }

  return { tick, pass, hashId };
}
