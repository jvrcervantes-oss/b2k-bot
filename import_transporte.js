// ─── TRANSPORTE DE LA IMPORTACIÓN (S5 fase B, LAW-507) — TEMPORAL: se retira en S9 con /importar y el secreto ───
// Habla con la ruta /importar de la edge bot-api (secreto propio BOT_API_SECRET_IMPORTAR). Devuelve el objeto
// { chat(p), config(p), cuadre(tel) } que consume importar() de import_redis.js.
//
// Reglas: timeout por llamada; UN reintento ante error de red o 5xx; ante 429 espera el retry-after de la edge
// (con tope) y reintenta hasta `max429` veces; un 4xx NO se reintenta. Nada de lo que viaja (teléfono, contenido) se
// escribe jamás en un error ni en el log: los errores llevan solo la acción y el código HTTP.
import axios from "axios";

// La edge tiene el esquema CERRADO: una clave de más (p. ej. `_media_descartada`, `updated_ms`) o un wamid/media con caracteres fuera de su
// patrón tumbaría el teléfono entero con un 400. Aquí se deja pasar SOLO lo que la edge reconoce, y un wamid o media ilegible se vuelve null
// (el contenido del mensaje no depende de ellos). Patrones copiados de bot-api/index.ts (RE_MSG, RE_ID_MEDIA, RE_TIPO_MEDIA).
const RE_MSG = /^[A-Za-z0-9._:=@+\/-]{1,120}$/;
const RE_ID_MEDIA = /^[A-Za-z0-9._:=@+/-]{1,200}$/;
const RE_TIPO_MEDIA = /^[a-z_]{1,20}$/;
export function mensajeParaEdge(m) {
  const md = m.media && typeof m.media === "object" && typeof m.media.id === "string" && RE_ID_MEDIA.test(m.media.id) && RE_TIPO_MEDIA.test(String(m.media.tipo ?? "otro"))
    ? { tipo: String(m.media.tipo ?? "otro"), id: m.media.id } : null;
  return { rol: m.rol, por: m.por, por_usuario: m.por_usuario ?? null, contenido: m.contenido, media: md,
    wamid: typeof m.wamid === "string" && RE_MSG.test(m.wamid) ? m.wamid : null, ts_ms: m.ts_ms };
}
export function escalacionParaEdge(e) {
  return { nombre: e.nombre ?? null, pregunta: e.pregunta ?? "", aviso_wamid: typeof e.aviso_wamid === "string" && RE_MSG.test(e.aviso_wamid) ? e.aviso_wamid : null, creada_ms: e.creada_ms ?? null };
}
const ent = (v) => (v === null || v === undefined ? null : (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) < 1e15 ? Math.floor(Number(v)) : null));
export function chatParaEdge(c) {
  const o = { ...c };
  for (const k of ["creado_ms", "actualizado_ms", "ultimo_entrante_ms", "pausa_hasta_ms", "baja_ms"]) o[k] = ent(c[k]);
  o.aviso_nivel = Math.max(0, Math.min(2, ent(c.aviso_nivel) ?? 0));
  o.seguimientos = Math.max(0, Math.min(1000000, ent(c.seguimientos) ?? 0));
  return o;
}
export function configParaEdge(c) { return { extra: c.extra, bienvenida: c.bienvenida, pausa_horas: c.pausa_horas, updated_by: c.updated_by ?? null }; }

import { cabeceraRegion } from "./store/postgres.js";
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

export function creaTransporte({ url, secreto, http = axios, timeoutMs = 25000, espera = dormir, max429 = 5, tope429Ms = 30000, region = "" } = {}) {
  const base = String(url || "").trim().replace(/\/+$/, "");
  const sec = String(secreto || "").trim();
  if (!base || !sec) return null;

  const razones = {};                                           // "400:mensajes" -> n. Solo palabras [a-z_] de la edge: nunca contenido ni teléfonos
  async function llama(accion, cuerpo) {
    let reintentoRed = false, n429 = 0;
    for (;;) {
      let r;
      try {
        r = await http.post(`${base}/importar`, { accion, ...cuerpo }, {
          headers: { "X-Bot-Secret": sec, "content-type": "application/json", ...cabeceraRegion(region) },
          timeout: timeoutMs, validateStatus: () => true, maxContentLength: 1024 * 1024, maxBodyLength: 4 * 1024 * 1024,
        });
      } catch (_) {
        if (reintentoRed) throw new Error(`importar/${accion}: sin respuesta`);
        reintentoRed = true; await espera(1000); continue;
      }
      if (r.status === 429) {
        if (++n429 > max429) throw new Error(`importar/${accion}: HTTP 429 (tope)`);
        const seg = Number(r.headers && (r.headers["retry-after"] ?? r.headers["Retry-After"]));
        await espera(Math.min(tope429Ms, Number.isFinite(seg) && seg > 0 ? seg * 1000 : 5000)); continue;
      }
      if (r.status >= 500) {
        if (reintentoRed) throw new Error(`importar/${accion}: HTTP ${r.status}`);
        reintentoRed = true; await espera(1000); continue;
      }
      if (r.status === 400 || (r.status === 200 && r.data && r.data.ok === false)) {
        const w = r.data && typeof r.data.error === "string" && /^[a-z_]{1,40}$/.test(r.data.error) ? r.data.error : "?";
        const k = `${r.status}:${accion}:${w}`; razones[k] = (razones[k] || 0) + 1;
      }
      if (r.status !== 200 || !r.data || typeof r.data !== "object") throw new Error(`importar/${accion}: HTTP ${r.status}`);
      return r.data;
    }
  }

  return {
    razones,
    // un teléfono: { tel, chat, mensajes, escalaciones } → { ok, ... } (ok:false con error = fallo de ese teléfono)
    chat: (p) => llama("chat", { tel: p.tel, chat: chatParaEdge(p.chat), mensajes: p.mensajes.map(mensajeParaEdge), escalaciones: p.escalaciones.map(escalacionParaEdge) }),
    config: (p) => llama("config", { config: configParaEdge(p.config), log: (p.log || []).map((e) => ({ ...e, ts_ms: ent(e.ts_ms) ?? 0 })) }),
    cuadre: async (tel) => {
      const d = await llama("cuadre", { tel });
      if (d.ok !== true) throw new Error("importar/cuadre: respuesta no ok");
      return d;
    },
  };
}
