// ─── ALMACÉN POSTGRES DEL BOT (S4b del encargo 20261009_lawang_bot_sin_redis) ───────────────────
// Cliente de la edge `bot-api` de Lawang (rutas /estado, /recordatorio y /humano). El bot NO se conecta a la base: habla con la edge,
// que ejecuta UNA función SQL por acción (lista cerrada). Este módulo es SOLO la puerta; la lógica del turno vive en turno-pg.js.
//
// Reglas de fiabilidad (plan, «Fiabilidad de la llamada a la edge»):
//  · Timeout por llamada (10 s: la edge corta a los 8 s) y UN reintento con el mismo cuerpo (los pasos 1 y 3 son idempotentes por wamid).
//    Se reintenta solo ante fallo de red, timeout y 5xx. Un 4xx no se reintenta: es un fallo de quien llama, no de la red.
//  · Un 429 de `mensaje_recibir` es `tope` (ritmo por teléfono): el llamador descarta con 200 a Meta, NUNCA 5xx.
//  · Alarma tras N fallos SEGUIDOS (N sale de la configuración del bot; 3 por defecto): una sola por caída, se rearma al primer éxito.
//    Que la base no responda no puede ser un fallo mudo (es la forma exacta del fallo de LAW-106).
//  · Los errores de negocio de la edge (`ok:false`, p. ej. sin_chat) NO son caídas: se devuelven como `{error}`.
//  · Nada del cuerpo ni de la respuesta pasa por el log: solo el nombre de la acción, el estado HTTP y el teléfono enmascarado.
import axios from "axios";

export class ErrorEdge extends Error {
  constructor(accion, tipo, status = null) {
    super(`bot-api ${accion}: ${tipo}${status ? " HTTP " + status : ""}`);
    this.name = "ErrorEdge";
    this.accion = accion;
    this.tipo = tipo;      // 'red' | 'timeout' | 'http' | 'ritmo' | 'forma' | 'sin_configurar'
    this.status = status;
  }
}

const RUTA_DE = {
  mensaje_recibir: "estado", turno_estado: "estado", turno_cerrar: "estado", eco_operadora: "estado", pausar: "estado", baja: "estado",
  entrega_fallida: "estado", escalar: "estado", escalacion_tomar: "estado", lead_resumen: "estado",
  citas_recordar: "recordatorio", cita_recordatorio_res: "recordatorio",
  humano_pausar: "humano", humano_enviar: "humano",
};
const ACCION_EDGE = { humano_pausar: "pausar", humano_enviar: "enviar" };   // en /humano la acción se llama como en la lista cerrada de la edge

export const enmascara = (tel) => { const d = String(tel || "").replace(/\D/g, ""); return d.length > 4 ? "…" + d.slice(-4) : "…"; };

// Envío por defecto: axios sin lanzar por el estado HTTP. Los tests inyectan otro.
async function postAxios(url, cuerpo, { headers, timeout }) {
  const r = await axios.post(url, cuerpo, { headers, timeout, validateStatus: () => true, maxContentLength: 1024 * 1024, maxBodyLength: 1024 * 1024 });
  return { status: r.status, data: r.data };
}

export function creaPg({
  url, secretos = {}, post = postAxios, timeoutMs = 10_000, reintentos = 1, pausaReintentoMs = 300, umbral = 3,
  onAlarma = () => {}, onRecuperado = () => {}, log = () => {},
}) {
  const base = String(url || "").trim().replace(/\/+$/, "");
  const estado = { fallosSeguidos: 0, alarmado: false, umbral: Number.isInteger(umbral) && umbral > 0 ? umbral : 3, llamadas: 0 };
  const espera = (ms) => new Promise((r) => setTimeout(r, ms));

  function falloContado(accion, e) {
    estado.fallosSeguidos += 1;
    if (estado.fallosSeguidos >= estado.umbral && !estado.alarmado) {
      estado.alarmado = true;
      Promise.resolve().then(() => onAlarma({ fallos: estado.fallosSeguidos, accion, tipo: e.tipo, status: e.status })).catch((x) => log(`alarma de bot-api falló: ${x && x.message}`));
    }
  }
  function exitoContado() {
    const venia = estado.alarmado;
    estado.fallosSeguidos = 0; estado.alarmado = false;
    if (venia) Promise.resolve().then(() => onRecuperado()).catch((x) => log(`aviso de recuperación falló: ${x && x.message}`));
  }

  // Devuelve { data, intentos }. Lanza ErrorEdge si la edge no contesta como debe.
  async function llama(accion, cuerpo, { jwt = null } = {}) {
    const ruta = RUTA_DE[accion];
    const secreto = ruta ? secretos[ruta] : "";
    if (!base || !secreto) { const e = new ErrorEdge(accion, "sin_configurar", 0); falloContado(accion, e); throw e; }   // sin URL o sin secreto no se sale: fallo cerrado y ruidoso
    const headers = { "X-Bot-Secret": secreto, "content-type": "application/json" };
    if (jwt) headers.authorization = "Bearer " + jwt;
    const cuerpoFinal = { accion: ACCION_EDGE[accion] || accion, ...cuerpo };
    estado.llamadas += 1;
    let ultimo = null;
    for (let intento = 1; intento <= 1 + reintentos; intento++) {
      let resp = null;
      try { resp = await post(`${base}/${ruta}`, cuerpoFinal, { headers, timeout: timeoutMs }); }
      catch (e) {
        ultimo = new ErrorEdge(accion, e && (e.code === "ECONNABORTED" || e.code === "ETIMEDOUT" || /timeout/i.test(e.message || "")) ? "timeout" : "red");
      }
      if (resp) {
        const st = resp.status;
        if (st === 200 && resp.data && typeof resp.data === "object" && typeof resp.data.ok === "boolean") {
          exitoContado();
          return { data: resp.data, intentos: intento };
        }
        if (st === 429) { exitoContado(); throw new ErrorEdge(accion, "ritmo", 429); }              // la edge está viva: no cuenta como caída
        if (st >= 400 && st < 500) { const e = new ErrorEdge(accion, "http", st); falloContado(accion, e); throw e; }   // 4xx: no se reintenta
        if (st === 200) { ultimo = new ErrorEdge(accion, "forma", 200); break; }                    // 200 sin la forma esperada: no se reintenta
        ultimo = new ErrorEdge(accion, "http", st);                                                 // 5xx u otro: se reintenta
      }
      if (intento <= reintentos) await espera(pausaReintentoMs);
    }
    falloContado(accion, ultimo);
    log(`bot-api ${accion} sin respuesta tras ${1 + reintentos} intento(s): ${ultimo.tipo}${ultimo.status ? " HTTP " + ultimo.status : ""} (fallos seguidos: ${estado.fallosSeguidos})`);
    throw ultimo;
  }

  // Quita ok/accion de la respuesta y la devuelve; un error de negocio se devuelve como { error }.
  const cuerpoDe = ({ data }) => {
    if (data.ok === false) return { error: String(data.error || "desconocido") };
    const { ok, accion, ...resto } = data;                // eslint-disable-line no-unused-vars
    return resto;
  };

  const api = {
    get fallosSeguidos() { return estado.fallosSeguidos; },
    get umbral() { return estado.umbral; },
    get llamadas() { return estado.llamadas; },
    fijaUmbral(n) { if (Number.isInteger(n) && n > 0 && n <= 50) estado.umbral = n; },

    // PASO 1 — antes del 200 a Meta. Devuelve {duplicado, procesado, reproceso, tope, propio} o {error}.
    async recibir({ tel, wamid, nombre = null, mensaje }) {
      let r;
      try { r = await llama("mensaje_recibir", { tel, wamid, nombre_perfil: nombre || undefined, mensaje }); }
      catch (e) {
        if (e instanceof ErrorEdge && e.tipo === "ritmo") return { duplicado: true, procesado: true, tope: true, ritmo: true };
        throw e;
      }
      const b = cuerpoDe(r);
      if (b.error) return b;
      // Si hubo que reintentar, el primer intento pudo haberse confirmado en la base aunque la respuesta se perdiera: el reintento ve
      // SU PROPIO reclamo como «duplicado sin procesar». Eso es nuestro mensaje, no uno ajeno: se sigue (Meta ya tiene su 200 y no reentrega).
      if (r.intentos > 1 && b.duplicado === true && b.procesado === false && b.reproceso !== true) return { ...b, duplicado: false, propio: true };
      return b;
    },
    // PASO 2 — tras waitMyTurn.
    async estado({ tel, testing = false }) {
      const b = cuerpoDe(await llama("turno_estado", { tel, testing: testing === true }));
      if (!b.error && b.config && Number.isInteger(b.config.fallos_alarma)) api.fijaUmbral(b.config.fallos_alarma);
      return b;
    },
    // PASO 3 — fin de turno. `salida`: [{texto, media?, wamid?}]. Devuelve {avisar, resumir, repetido} o {error}.
    async cerrar({ tel, wamid, salida = [], intent = null, aviso = null, esperando = false, cambioTema = false }) {
      return cuerpoDe(await llama("turno_cerrar", {
        tel, wamid, salida, intent: intent || undefined, aviso: aviso || undefined, esperando: esperando === true, cambio_tema: cambioTema === true,
      }));
    },
    async eco({ tel, wamid, texto = "", horas = null }) {
      return cuerpoDe(await llama("eco_operadora", { tel, wamid, texto, horas: horas ?? undefined }));
    },
    async pausar({ tel, modo, horas = null }) { return cuerpoDe(await llama("pausar", { tel, modo, horas: horas ?? undefined })); },
    async baja({ tel, wamid }) { return cuerpoDe(await llama("baja", { tel, wamid })); },
    async entregaFallida({ tel, codigo, detalle = null }) { return cuerpoDe(await llama("entrega_fallida", { tel, codigo: String(codigo ?? "?"), detalle: detalle || undefined })); },
    async escalar({ tel, nombre = null, pregunta, avisoWamid = null }) {
      return cuerpoDe(await llama("escalar", { tel, nombre: nombre || undefined, pregunta, aviso_wamid: avisoWamid || undefined }));
    },
    // EXCEPCIÓN 1: devuelve el teléfono de OTRO cliente. Solo se llama cuando el remitente firmado es el dueño.
    async escalacionTomar({ wamid = null } = {}) { return cuerpoDe(await llama("escalacion_tomar", { wamid: wamid || undefined })); },
    async leadResumen({ tel, texto, hastaId }) { return cuerpoDe(await llama("lead_resumen", { tel, texto, hasta_id: hastaId })); },
    // EXCEPCIÓN 2 (reloj de recordatorios).
    async citasRecordar() { return cuerpoDe(await llama("citas_recordar", {})); },
    async citaRecordatorioRes({ accionId, resultado }) { return cuerpoDe(await llama("cita_recordatorio_res", { accion_id: accionId, resultado })); },
    // /humano — lo que hace una PERSONA. El usuario sale del JWT que reenvía el proxy, nunca del cuerpo.
    async humanoPausar({ tel, modo, jwt }) { return cuerpoDe(await llama("humano_pausar", { tel, modo }, { jwt })); },
    async humanoEnviar({ tel, texto = "", wamid, media = null, jwt }) { return cuerpoDe(await llama("humano_enviar", { tel, texto, wamid, media: media || undefined }, { jwt })); },
  };
  return api;
}
