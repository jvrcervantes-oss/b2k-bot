// Parte de la EDGE FALSA que imita las funciones SQL de S12 (consentimiento de seguimiento y reenganche). Es un PUERTO a JavaScript de
// proyectos/Lawang/supabase/migrations/20261010170000_bot_sin_redis_s12_consentimiento.sql: la semántica real (listas cerradas, regla cita /
// turno_siguiente, una repregunta, ancla, 30 días, máx. 2 envíos) se prueba contra la BASE REAL en supabase/pruebas/bot_sin_redis_s12.sql; esto
// sirve para probar lo que hace el BOT con cada respuesta, sin red. Si se cambia una, se cambia la otra.
const norm = (p) => String(p ?? "").replace(/[’‘']/g, "").toLowerCase().replace(/[áàä]/g, "a").replace(/[éè]/g, "e").replace(/[íì]/g, "i").replace(/[óò]/g, "o").replace(/[úùü]/g, "u").replace(/ñ/g, "n")
  .replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const sinCola = (n) => n.replace(/( (please|por favor|thanks|thank you|gracias|terima kasih))+$/, "").trim();
const SI = ["yes", "y", "yes please", "yeah", "yep", "sure", "yes sure", "of course", "go ahead", "thats fine", "si", "s", "si por favor", "claro", "por supuesto", "de acuerdo", "adelante", "vale si", "si vale"];
const SI_COLA = ["yes", "y", "yeah", "yep", "sure", "yes sure", "of course", "go ahead", "thats fine", "si", "s", "claro", "por supuesto", "de acuerdo", "adelante", "vale si", "si vale"];
const NO = ["no", "n", "nope", "no thanks", "no thank you", "not now", "no need", "dont", "no gracias", "ahora no", "mejor no", "no hace falta", "no quiero"];
const NO_COLA = ["no", "n", "nope", "not now", "no need", "dont", "ahora no", "mejor no", "no hace falta", "no quiero"];
export function clase(texto) {
  const n = norm(texto);
  if (n === "") return "ambiguo";
  if (SI.includes(n) || SI_COLA.includes(sinCola(n))) return "si";
  if (NO.includes(n) || NO_COLA.includes(sinCola(n))) return "no";
  return "ambiguo";
}
const H = 3600 * 1000;

export function accionesConsentimiento({ chats, chat }) {
  const cs = (c) => (c.cs ||= { estado: "sin_preguntar", repreguntaTexto: null, preguntaWamid: null, repreguntaWamid: null, envio1: null, envio2: null, ancla: null, respondidoEn: null });
  const pausado = (c) => c.pausado === true;
  const esMarca = (m) => /^\[plantilla lawang_reenganche_/.test(m.texto || "");
  const cuenta = (c, rol) => c.msgs.filter((m) => m.rol === rol).length;
  const citaAbierta = (c) => c.citaAbierta === true;
  const ultimoNoPlantilla = (c) => [...c.msgs].reverse().find((m) => !esMarca(m));
  function debido(c) {
    const k = cs(c);
    if (k.estado !== "si" || !k.respondidoEn) return null;
    if (Date.now() - k.respondidoEn > 30 * 24 * H) return null;
    if (c.baja || k.revocadoEn) return null;
    if (pausado(c)) return null;
    if (k.envio2) return null;
    const u = ultimoNoPlantilla(c);
    if (!u || u.rol !== "assistant" || u.por !== "bot") return null;
    if (c.msgs.some((m) => m.por === "humano" && m.ts > k.respondidoEn)) return null;
    if (citaAbierta(c)) return null;
    const t0 = k.ancla ?? u.ts;
    if (c.msgs.some((m) => m.rol === "user" && m.ts > t0)) return null;
    const ahora = Date.now();
    if (!k.envio1) return ahora >= t0 + 48 * H && ahora < t0 + 96 * H ? "48h" : null;
    return ahora >= t0 + 7 * 24 * H && ahora < t0 + 10 * 24 * H ? "7d" : null;
  }
  return {
    consentimiento_preguntar(b) {
      const c = chats.get(b.tel); if (!c) return { error: "sin_chat" };
      const k = cs(c);
      if (b.version !== "CONSENT-SEGUIMIENTO-2026-10-09-v1") return { error: "version_desconocida" };
      if (c.baja || pausado(c)) return { error: "no_procede" };
      if (b.repregunta) {
        if (k.estado !== "preguntado" || !k.preguntaWamid || k.repreguntaTexto) return { error: "no_procede" };
        k.repreguntaTexto = b.texto; return { ok: true };
      }
      if (k.estado !== "sin_preguntar") return { error: "no_procede" };
      if (cuenta(c, "user") < 2 || cuenta(c, "assistant") < 1 || citaAbierta(c)) return { error: "no_procede" };
      Object.assign(k, { estado: "preguntado", idioma: b.idioma, texto: b.texto, preguntaWamid: null, preguntadoEn: Date.now() });
      return { ok: true };
    },
    consentimiento_enviada(b) {
      const c = chats.get(b.tel); if (!c) return { error: "sin_chat" };
      const k = cs(c);
      if (k.estado !== "preguntado") return { error: "no_procede" };
      if (b.repregunta) { if (!k.repreguntaTexto || k.repreguntaWamid) return { error: "no_procede" }; k.repreguntaWamid = b.wamid; }
      else { if (k.preguntaWamid) return { error: "no_procede" }; k.preguntaWamid = b.wamid; }
      return { ok: true };
    },
    consentimiento_responder(b) {
      const c = chats.get(b.tel); if (!c) return { error: "sin_chat" };
      const k = cs(c);
      if (k.respuestaWamid === b.wamid && ["si", "no"].includes(k.estado)) return { resultado: k.estado, estado: k.estado };
      if (k.estado !== "preguntado" || c.baja) return { resultado: "sin_efecto", estado: k.estado };
      const q = k.repreguntaWamid ?? k.preguntaWamid;
      let aplica = false, regla = null;
      if (b.cita && [k.preguntaWamid, k.repreguntaWamid].includes(b.cita)) { aplica = true; regla = "cita"; }
      else if (q) {
        const qm = [...c.msgs].reverse().find((m) => m.wamid === q && m.rol === "assistant");
        const mm = [...c.msgs].reverse().find((m) => m.wamid === b.wamid && m.rol === "user");
        if (qm && mm && mm.id > qm.id && !c.msgs.some((m) => m.id > qm.id && m.id < mm.id)) { aplica = true; regla = "turno_siguiente"; }
      }
      if (!aplica) {
        if (k.repreguntaTexto) { k.estado = "no"; k.regla = "repregunta_sin_respuesta"; return { resultado: "no_cuenta", estado: "no" }; }
        return { resultado: "no_cuenta", estado: "preguntado" };
      }
      const cl = clase(b.texto);
      if (cl === "si" || cl === "no") {
        Object.assign(k, { estado: cl, respuestaTexto: b.texto, respuestaWamid: b.wamid, respuestaCita: b.cita || null, respondidoEn: Date.now(), regla: `${regla}:${norm(b.texto)}` });
        return { resultado: cl, estado: cl };
      }
      if (!k.repreguntaTexto) return { resultado: "repreguntar", estado: "preguntado" };
      Object.assign(k, { estado: "no", respuestaTexto: b.texto, respuestaWamid: b.wamid, respondidoEn: Date.now(), regla: "ambiguo_tras_repregunta" });
      return { resultado: "no", estado: "no" };
    },
    seguimiento_candidatos() {
      const out = [];
      for (const [tel, c] of chats) {
        const k = cs(c);
        if (k.estado === "si" && k.respondidoEn && Date.now() - k.respondidoEn > 30 * 24 * H) k.estado = "caducado";
        if (k.estado === "si" && (k.envio2 || (k.envio1 && c.msgs.some((m) => m.rol === "user" && m.ts > k.envio1.en)))) k.estado = "usado";
        const d = k.estado === "si" && !c.baja ? debido(c) : null;
        if (d) out.push({ tel, plantilla: d, idioma: k.idioma || "en", nombre: c.nombre || null });
      }
      return { candidatos: out.slice(0, 20) };
    },
    seguimiento_reservar(b) {
      const c = chats.get(b.tel); if (!c) return { error: "sin_chat" };
      const k = cs(c);
      if (debido(c) !== b.plantilla) return { error: "no_procede" };
      if (b.plantilla === "48h") { k.ancla = ultimoNoPlantilla(c).ts; k.envio1 = { en: Date.now(), res: "reservado" }; }
      else k.envio2 = { en: Date.now(), res: "reservado" };
      return { ok: true, idioma: k.idioma || "en", nombre: c.nombre || null };
    },
    seguimiento_registrar(b) {
      const c = chats.get(b.tel); if (!c) return "no_aplica";
      const k = cs(c);
      const e = b.plantilla === "48h" ? k.envio1 : k.envio2;
      if (!e || e.res !== "reservado") return "no_aplica";
      e.res = b.resultado; e.wamid = b.wamid || null;
      if (b.plantilla === "7d") k.estado = "usado";
      if (b.resultado === "enviado") c.msgs.push({ id: (c.msgs.at(-1)?.id || 0) + 0.5, rol: "assistant", por: "bot", texto: `[plantilla lawang_reenganche_${b.plantilla}] ${b.texto || ""}`, ts: Date.now(), wamid: b.wamid });
      return "ok";
    },
    // lo que la base añade a turno_estado
    estadoConsentimiento(c) {
      const k = cs(c);
      const puede = k.estado === "sin_preguntar" && !c.baja && cuenta(c, "user") >= 2 && cuenta(c, "assistant") >= 1 && !citaAbierta(c);
      return { estado: k.estado, repreguntado: k.repreguntaTexto != null, puede_preguntar: puede };
    },
    revocaPorBaja(c) { const k = cs(c); k.estado = "revocado"; k.revocadoEn = Date.now(); },
    // envejecer un chat entero (el reloj no se espera)
    envejece(tel, ms) {
      const c = chats.get(tel); if (!c) return;
      const k = cs(c);
      for (const m of c.msgs) m.ts -= ms;
      for (const f of ["respondidoEn", "ancla", "preguntadoEn"]) if (k[f]) k[f] -= ms;
      for (const e of [k.envio1, k.envio2]) if (e) e.en -= ms;
    },
    cs,
  };
}
