// ─── CONTADOR DE LATENCIA DE LA EDGE (LAW-507, revisión previa #248, plan v2) ─────────────────────
// Mide lo que cuesta hablar con `bot-api` desde Railway, que es lo único que el plan no pudo medir antes del corte (presupuesto: +1,5 s por turno).
// Módulo PURO: sin red ni log propio; el reloj y la alarma llegan inyectados. Un fallo aquí NUNCA debe afectar a una llamada: todo va en try/catch.
//
// Qué guarda (y qué no): por muestra solo {ms, tipo del fallo, fría o caliente}. Nada del cuerpo, ni teléfono, ni wamid, ni e.message.
// La clave es el NOMBRE de la acción (lista cerrada de RUTA_DE), nunca un argumento: la cardinalidad está acotada por diseño.
import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

const ANILLO = 200;          // muestras por acción
const MIN_P95 = 20;          // con menos muestras el p95 no se publica (sería el máximo disfrazado)
const FRIA_MS = 60_000;      // más de 60 s sin llamadas = la siguiente se mide como «fría»
const TIPOS = ["red", "timeout", "http", "forma"];

const pct = (orden, p) => orden[Math.min(orden.length - 1, Math.ceil(p * orden.length) - 1)];
const redondea = (n) => Math.round(n * 10) / 10;

function resumenDe(valores) {
  const n = valores.length;
  if (!n) return { n: 0, p50: null, p95: null, max: null };
  const o = [...valores].sort((a, b) => a - b);
  return { n, p50: redondea(pct(o, 0.5)), p95: n >= MIN_P95 ? redondea(pct(o, 0.95)) : null, max: redondea(o[n - 1]) };
}

export function creaLatencia({ reloj = () => performance.now(), ahora = () => new Date() } = {}) {
  const desde = ahora().toISOString();
  const acciones = new Map();     // nombre → { ok:{calientes[], frias[]}, fallos:{red,timeout,http,forma} }
  const turnos = [];              // ms de edge acumulados por turno (de mensaje_recibir a turno_cerrar)
  const als = new AsyncLocalStorage();
  let ultimaLlamada = null;

  const anillo = (arr, v) => { arr.push(v); if (arr.length > ANILLO) arr.shift(); };
  const de = (accion) => {
    let a = acciones.get(accion);
    if (!a) { a = { calientes: [], frias: [], fallos: { red: 0, timeout: 0, http: 0, forma: 0 } }; acciones.set(accion, a); }
    return a;
  };

  return {
    reloj,
    // Se llama una vez por llamada a la edge, ya terminada. `ms` = suma de intentos SIN la pausa entre reintentos.
    registra({ accion, ms, tipo = null, ok }) {
      try {
        if (typeof accion !== "string" || !Number.isFinite(ms) || ms < 0) return;     // un negativo (reloj raro) se descarta
        const t = reloj();
        const fria = ultimaLlamada === null || t - ultimaLlamada > FRIA_MS;
        ultimaLlamada = t;
        const a = de(accion);
        if (ok) {
          anillo(fria ? a.frias : a.calientes, ms);
          const turno = als.getStore();
          if (turno) { turno.ms += ms; if (accion === "turno_cerrar") { anillo(turnos, turno.ms); turno.ms = 0; } }
        } else if (TIPOS.includes(tipo)) a.fallos[tipo] += 1;
      } catch { /* medir no puede romper la llamada */ }
    },
    // Envuelve el tratamiento de UN mensaje entrante: lo que registre dentro se acumula en su turno.
    enTurno(fn) { return als.run({ ms: 0 }, fn); },
    // Forma publicada en /admin/api/health → edge.latencia
    instantanea() {
      try {
        const por_accion = {};
        for (const [nombre, a] of acciones) {
          por_accion[nombre] = { caliente: resumenDe(a.calientes), fria: resumenDe(a.frias), fallos: { ...a.fallos } };
        }
        return { desde, por_accion, turno: resumenDe(turnos) };
      } catch { return { desde, error: "instantanea" }; }
    },
    // Una línea sin PII para el log (cada hora y al apagar): la memoria muere con cada redespliegue.
    linea() {
      const s = this.instantanea();
      if (s.error) return "latencia edge: sin datos";
      const t = s.turno;
      const acc = Object.entries(s.por_accion).map(([k, v]) => `${k} n=${v.caliente.n + v.fria.n} p50=${v.caliente.p50 ?? v.fria.p50 ?? "-"}`).join(" ");
      return `latencia edge desde ${s.desde}: turno n=${t.n} p50=${t.p50 ?? "-"} p95=${t.p95 ?? "-"} max=${t.max ?? "-"} ms | ${acc || "sin llamadas"}`;
    },
  };
}
