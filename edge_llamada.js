// Llamada de catálogo y CRM a la edge bot-api (LAW-507). Con `x-region` fijada la edge NO se reenruta si esa región cae (doc de Supabase):
// ante error de red o 5xx se hace UN reintento sin la cabecera. Un 4xx no se reintenta.
import { cabeceraRegion } from "./store/postgres.js";

export function creaLlamaEdge({ url, region = "", http, timeoutMs = 5000 }) {
  return async function llamaEdge(ruta, secreto, cuerpo) {
    const base = { "X-Bot-Secret": secreto, "content-type": "application/json" };
    const conRegion = cabeceraRegion(region);
    const fijada = Object.keys(conRegion).length > 0;
    const una = (headers) => http.post(`${url}/${ruta}`, cuerpo, { headers, timeout: timeoutMs, validateStatus: () => true, maxContentLength: 1024 * 1024 });
    let r = null;
    try { r = await una({ ...base, ...conRegion }); }
    catch (e) { if (!fijada) throw e; }
    if (fijada && (!r || r.status >= 500)) r = await una(base);
    if (r.status !== 200 || !r.data || r.data.ok !== true) throw new Error(`bot-api/${ruta} HTTP ${r.status}`); // sin cuerpo: no se vuelca nada ajeno al log
    return r.data;
  };
}
