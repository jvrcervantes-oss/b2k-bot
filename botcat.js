// Catálogo en vivo del ERP de Lawang para el bot (S6 del encargo encargos/20261008_lawang_bot_catalogo_crm.md).
// Funciones puras, sin red ni reloj propios: todo se inyecta (pide, ahora), para poder probarlo con node --test.
//
// Qué hace: pide a la edge `bot-api` las unidades que el ERP deja ver al bot, las guarda en una caché con TTL y las
// convierte en UN bloque de texto para el `system` (sin tool-calling, sin etiquetas que parsear). Calcula en servidor
// lo que el modelo no debe calcular: la fecha del catálogo y el precio por m² de las parcelas. Y, después de generar,
// comprueba que toda cifra con moneda de la respuesta esté en el bloque (post-check, SOLO LOG: es una medida legal,
// no se convierte en bloqueo sin que Legal vea los casos de la semana de solo log).
//
// Estados del bloque: ok · vacio ("no hay unidades publicadas") · antiguo (el último bueno con su hora, hasta 6 h)
// · caido ("CATÁLOGO NO DISPONIBLE, no cites precios"). Vacío y caído son cosas distintas a propósito: no inventar.

export const MAX_EDAD_MS = 6 * 3600 * 1000;   // pasadas 6 h sin catálogo bueno, no se cita ni el último bueno
export const TTL_MS = 60 * 1000;              // caché si todo va bien
export const TTL_ERROR_MS = 15 * 1000;        // tras un fallo no se reintenta en cada mensaje (la edge tiene tope de ritmo)

const CLAVES = ["proyecto", "tipo", "codigo", "superficie_m2", "precio", "moneda", "modelo", "disponible"];

// texto de la base que acaba dentro del prompt: una línea, sin corchetes (nada que parezca etiqueta), acotado
const limpia = (v, max = 80) => String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/[\[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Una fila de la edge → fila segura (solo las 8 columnas, tipos comprobados) o null si no vale. */
export function normalizaFila(f) {
  if (!f || typeof f !== "object") return null;
  const o = {};
  for (const k of CLAVES) o[k] = f[k];
  const codigo = limpia(o.codigo, 40);
  const proyecto = limpia(o.proyecto, 80);
  if (!codigo || !proyecto) return null;
  if (o.disponible === false) return null;   // «disponible» solo vale como filtro negativo: lo que no consta disponible no se enseña
  return {
    proyecto,
    tipo: limpia(o.tipo, 30).toLowerCase(),
    codigo,
    superficie_m2: num(o.superficie_m2),
    precio: num(o.precio),
    moneda: limpia(o.moneda, 6).toUpperCase(),
    modelo: limpia(o.modelo, 60),
  };
}

const esParcela = (u) => /^(parcela|land|plot)/.test(u.tipo);

/** Cifras derivadas EN SERVIDOR (el modelo no multiplica ni divide). */
export function derivaUnidad(u) {
  const conPrecio = u.precio !== null && u.precio > 0 && !!u.moneda;
  const porM2 = conPrecio && esParcela(u) && u.superficie_m2 && u.superficie_m2 > 0
    ? Math.round(u.precio / u.superficie_m2) : null;
  return { conPrecio, porM2 };
}

const fmtNum = (n) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(n);
const fmtImporte = (n, moneda) => `${moneda} ${fmtNum(n)}`;

export function fechaCatalogo(ts, tz) {
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: tz }).format(new Date(ts));
}
export function horaCatalogo(ts, tz) {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz }).format(new Date(ts)) + ` (${tz})`;
}

function lineaUnidad(u) {
  const d = derivaUnidad(u);
  const p = [`Project: ${u.proyecto}`, `Type: ${u.tipo || "unit"}`, `Code: ${u.codigo}`];
  if (u.modelo) p.push(`Model: ${u.modelo}`);
  if (u.superficie_m2) p.push(`Area: ${fmtNum(u.superficie_m2)} m2`);
  if (!d.conPrecio) p.push("Price: not published, the team confirms");
  else if (d.porM2 !== null) {
    p.push(`Price per m2: ${fmtImporte(d.porM2, u.moneda)} (calculated by the system)`);
    p.push(`Total for the plot: ${fmtImporte(u.precio, u.moneda)} (calculated from the per-m2 price)`);
  } else p.push(`Price: ${fmtImporte(u.precio, u.moneda)}`);
  p.push("shows as available, an advisor confirms");
  return "- " + p.join(" | ");
}

const REGLAS = "This block is the ONLY source of prices and availability. Copy figures exactly as written; never calculate, round, convert currency or estimate. "
  + "Every price you quote carries the indicative-price sentence with the catalog date below.";

/** El texto del bloque `system` para cada estado. `estado` ∈ ok | vacio | antiguo | caido. */
export function textoBloque({ estado, unidades = [], ts = 0, tz = "Asia/Makassar" }) {
  if (estado === "caido") {
    return "CATALOG NOT AVAILABLE right now. Do not quote any price, size or availability, not even from memory or from earlier in this chat. "
      + "Say the team will confirm the exact figures, and keep working on the call or visit.";
  }
  const fecha = fechaCatalogo(ts, tz);
  if (estado === "vacio") {
    return `CATALOG (catalog date ${fecha}): there are no units published right now. Do not quote any price or availability. `
      + "Say the team will share what is open at the moment, and keep working on the call or visit.";
  }
  const cab = estado === "antiguo"
    ? `CATALOG (last refreshed ${fecha} at ${horaCatalogo(ts, tz)}; the live system could not be reached since, so this may be out of date; say prices are to be confirmed by the team)`
    : `CATALOG (catalog date ${fecha}, live from the Lawang system)`;
  if (!unidades.length) {
    return `${cab}: there were no units published at that time. Do not quote any price or availability; say the team will share what is open.`;
  }
  return [cab, REGLAS, ...unidades.map(lineaUnidad)].join("\n");
}

/** Cifras (números) que la respuesta puede citar: las del bloque. */
export function cifrasPermitidas(unidades) {
  const s = [];
  for (const u of unidades || []) {
    const d = derivaUnidad(u);
    if (d.conPrecio) s.push(u.precio);
    if (d.porM2 !== null) s.push(d.porM2);
  }
  return s;
}

/**
 * Caché con TTL + último bueno + una sola petición en vuelo.
 *   pide(): Promise<filas[]> — lanza si la edge está caída/cerrada. Un array vacío ES un catálogo vacío.
 *   ahora(): ms epoch.
 */
export function creaCatalogo({ pide, ahora = Date.now, tz = "Asia/Makassar", ttlMs = TTL_MS, ttlErrorMs = TTL_ERROR_MS, maxEdadMs = MAX_EDAD_MS, log = () => {} }) {
  let bueno = null;     // { unidades, ts } último catálogo leído bien (puede estar vacío)
  let ultimo = null;    // { ts, ok } último intento
  let enVuelo = null;

  async function refresca() {
    const t0 = ahora();
    try {
      const filas = await pide();
      if (!Array.isArray(filas)) throw new Error("respuesta sin lista");
      const unidades = filas.map(normalizaFila).filter(Boolean);
      bueno = { unidades, ts: ahora() };
      ultimo = { ts: t0, ok: true };
    } catch (e) {
      ultimo = { ts: t0, ok: false };
      log(`catálogo: no se pudo leer (${e && e.message ? e.message : "error"})`);
    }
  }

  async function bloque() {
    const t = ahora();
    if (!ultimo || t - ultimo.ts >= (ultimo.ok ? ttlMs : ttlErrorMs)) {
      if (!enVuelo) enVuelo = refresca().finally(() => { enVuelo = null; });
      await enVuelo;
    }
    const t1 = ahora();
    let estado, unidades = [], ts = 0;
    if (bueno && ultimo && ultimo.ok) {
      estado = bueno.unidades.length ? "ok" : "vacio"; unidades = bueno.unidades; ts = bueno.ts;
    } else if (bueno && t1 - bueno.ts <= maxEdadMs) {
      estado = "antiguo"; unidades = bueno.unidades; ts = bueno.ts;
    } else {
      estado = "caido";
    }
    return { estado, unidades, ts, texto: textoBloque({ estado, unidades, ts, tz }) };
  }
  return { bloque };
}

// ─── Post-check: cifras con moneda de la respuesta ───────────────────────────────────────
const MON = String.raw`(?:IDR|Rp\.?|USD|US\$|AUD|A\$|EUR|€|£|\$)`;
const SUF = String.raw`(?:\s?(?:billion|bn|miliar|milyar|million|mn|juta|jt|thousand|k|ribu|rb|m(?![²2a-z])))?`;
const NUM = String.raw`\d[\d.,]*\d|\d`;
const RE_ANTES = new RegExp(String.raw`(?<![A-Za-z])${MON}\s?(${NUM})(${SUF})`, "gi");
const RE_DESPUES = new RegExp(String.raw`(${NUM})(${SUF})\s?(?:IDR|USD|AUD|EUR|rupiah|rupees|dollars?|euros?|pounds?)\b`, "gi");
const MULT = { billion: 1e9, bn: 1e9, miliar: 1e9, milyar: 1e9, million: 1e6, mn: 1e6, juta: 1e6, jt: 1e6, m: 1e6, thousand: 1e3, k: 1e3, ribu: 1e3, rb: 1e3 };

function aNumero(s, suf) {
  const tieneSuf = !!suf.trim();
  const pun = (s.match(/\./g) || []).length, com = (s.match(/,/g) || []).length;
  let t = s;
  if (pun && com) {                         // ambos: el último es el decimal
    const dec = t.lastIndexOf(".") > t.lastIndexOf(",") ? "." : ",";
    t = t.split(dec === "." ? "," : ".").join("").replace(dec, ".");
  } else if (pun > 1 || com > 1) {          // un mismo separador repetido = miles
    t = t.replace(/[.,]/g, "");
  } else if (pun === 1 || com === 1) {
    const sep = pun ? "." : ",";
    const tras = t.split(sep)[1];
    t = (!tieneSuf && tras.length === 3) ? t.replace(sep, "") : t.replace(sep, ".");
  }
  const v = Number(t);
  if (!Number.isFinite(v)) return null;
  return v * (tieneSuf ? (MULT[suf.trim().toLowerCase()] || 1) : 1);
}

/** Todas las cifras con moneda de un texto, como números. */
export function cifrasConMoneda(texto) {
  const out = [];
  for (const re of [RE_ANTES, RE_DESPUES]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(texto || ""))) {
      const v = aNumero(m[1], m[2] || "");
      if (v !== null && v > 0) out.push({ valor: v, texto: m[0].trim() });
    }
  }
  return out;
}

/**
 * Cifras con moneda de la respuesta que NO están en el bloque. Legal (§c): TODA cifra debe estar en el bloque, también
 * cuando el cliente la dijo antes («¿son IDR 1 billion, verdad?» y el bot lo confirma es justo el caso caro). Las que el
 * cliente había dicho van marcadas `eco: true` para que Legal las vea aparte en la semana de solo log. Solo para log.
 */
export function postCheckCifras({ respuesta, permitidas = [], delCliente = "" }) {
  const cerca = (v, lista) => lista.some((a) => Math.abs(v - a) <= Math.max(0.5, a * 0.002));
  const dichas = cifrasConMoneda(delCliente).map((c) => c.valor);
  return cifrasConMoneda(respuesta)
    .filter((c) => !cerca(c.valor, permitidas))
    .map((c) => ({ ...c, eco: cerca(c.valor, dichas) }));
}
