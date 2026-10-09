// ─── TRANSPORTE DE LA IMPORTACIÓN (S5 fase B, LAW-507) — TEMPORAL: se retira en S9 con /importar y el secreto ───
// Habla con la ruta /importar de la edge bot-api (secreto propio BOT_API_SECRET_IMPORTAR). Devuelve el objeto
// { chat(p), config(p), cuadre(tel) } que consume importar() de import_redis.js.
//
// Reglas: timeout por llamada; UN reintento ante error de red o 5xx; ante 429 espera el retry-after de la edge
// (con tope) y reintenta hasta `max429` veces; un 4xx NO se reintenta. Nada de lo que viaja (teléfono, contenido) se
// escribe jamás en un error ni en el log: los errores llevan solo la acción y el código HTTP.
import axios from "axios";

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

export function creaTransporte({ url, secreto, http = axios, timeoutMs = 25000, espera = dormir, max429 = 5, tope429Ms = 30000 } = {}) {
  const base = String(url || "").trim().replace(/\/+$/, "");
  const sec = String(secreto || "").trim();
  if (!base || !sec) return null;

  async function llama(accion, cuerpo) {
    let reintentoRed = false, n429 = 0;
    for (;;) {
      let r;
      try {
        r = await http.post(`${base}/importar`, { accion, ...cuerpo }, {
          headers: { "X-Bot-Secret": sec, "content-type": "application/json" },
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
      if (r.status !== 200 || !r.data || typeof r.data !== "object") throw new Error(`importar/${accion}: HTTP ${r.status}`);
      return r.data;
    }
  }

  return {
    // un teléfono: { tel, chat, mensajes, escalaciones } → { ok, ... } (ok:false con error = fallo de ese teléfono)
    chat: (p) => llama("chat", { tel: p.tel, chat: p.chat, mensajes: p.mensajes, escalaciones: p.escalaciones }),
    config: (p) => llama("config", { config: p.config, log: p.log }),
    cuadre: async (tel) => {
      const d = await llama("cuadre", { tel });
      if (d.ok !== true) throw new Error("importar/cuadre: respuesta no ok");
      return d;
    },
  };
}
