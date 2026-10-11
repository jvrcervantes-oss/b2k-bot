// BBM — foto de comparación Dion ↔ ERP para el día del corte (F8, subtarea 7 de `bbm_carga_datos_reales`). SOLO LECTURA.
//
// Qué mide (criterio de la subtarea 7):
//   (a) los mismos modelos, con el mismo nombre exacto (altas y bajas a la vista);
//   (b) TODAS las tarifas iguales (hoy 313): precio de cada tramo de días, en las dos direcciones;
//   (c) estado de cada moto: ninguna «disponible» en el ERP está alquilada, en taller o retirada en Dion; cada moto ALQUILADA en Dion tiene en
//       el ERP un bloqueo vivo (reserva en bloqueo/confirmada/en_curso) y las motos nuevas de Dion están dadas de alta.
// Qué NO hace: no escribe en ningún sitio, no bloquea ninguna moto, no cambia ninguna variable, no manda ningún mensaje. Lo que encuentra lo CORRIGE
// otra persona (Backend, por `/flota/` o por sus RPC) y se vuelve a medir. Con 0 diferencias sale con código 0; con alguna, con código 1.
//
// Cómo se usa (cada paso lo hace quien tiene el acceso; este fichero no necesita ninguna credencial del ERP):
//   1. Foto de Dion — la hace el bot, que ya tiene las claves (`railway run` en el servicio bbm-bot; solo un GET a `products`, la misma lectura de
//      `/admin/api/fleet`, con la clave anónima que da SELECT público):
//        node bbm-foto-corte.js --lee-dion dion.json
//   2. Foto del ERP — la hace Backend con su herramienta de solo lectura. Este fichero imprime la consulta (una sola SELECT):
//        node bbm-foto-corte.js --sql-erp > foto_erp.sql        # y Backend: python erp/sql.py bbm -f foto_erp.sql   (SIN --escribe) → erp.json
//   3. Comparar (offline, sin red):
//        node bbm-foto-corte.js --compara dion.json erp.json [--json informe.json]
//
// Qué no puede saber (queda dicho en el informe, no se rellena): la FECHA en que Dion devuelve cada moto alquilada. La lectura de Dion de aquí no
// trae sus alquileres, solo el estado; cuánto le queda a cada una se mira en Dion al crear el bloqueo.
//
// Los nombres se comparan EXACTOS (solo espacios y mayúsculas se normalizan), igual que el bot (`normNombre` de bbmflow.js): «Honda Vario» ≠ «Honda Vario 160».

import fs from "node:fs";
import { pathToFileURL } from "node:url";

// Columna de Dion → días en el ERP (encargo bbm_carga_datos_reales §3). La tarifa baja de 3 semanas no la usa el sistema de Dion y no se carga.
export const TRAMOS_DION = [
  ["daily_rate", 1], ["weekly_rate", 7], ["fortnight_rate", 14], ["three_week_high_rate", 21],
  ["monthly_rate", 30], ["biannual_rate", 182], ["yearly_rate", 365],
];
const ESTADOS_BLOQUEO = new Set(["bloqueo", "confirmada", "en_curso"]);

export const normNombre = (s) => String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
const normPlaca = (s) => String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();   // el ERP exige identificador único sin mirar mayúsculas ni espacios

// ── La consulta del ERP (una SELECT; ninguna escritura) ─────────────────────────────────────────────────────────────────────────────────
export const SQL_ERP = `-- Foto del ERP de BBM para compararla con Dion (bbm-foto-corte.js). SOLO LECTURA: una SELECT. Ejecutar SIN --escribe.
select jsonb_build_object(
  'fecha', current_date,
  'productos', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'nombre', p.nombre, 'referencia', p.referencia, 'activo', p.activo,
      'tarifas', (select coalesce(jsonb_agg(jsonb_build_object('dias', t.dias, 'precio', t.precio, 'moneda', t.moneda) order by t.dias), '[]'::jsonb)
                    from public.producto_tarifas t where t.producto_id = p.id),
      'unidades', (select coalesce(jsonb_agg(jsonb_build_object(
                      'identificador', u.identificador, 'estado', u.estado,
                      'bloqueos', (select coalesce(jsonb_agg(jsonb_build_object('desde', r.desde, 'hasta', r.hasta, 'estado', r.estado) order by r.desde), '[]'::jsonb)
                                     from public.reservas_producto r
                                    where r.unidad_id = u.id and r.estado in ('bloqueo', 'confirmada', 'en_curso') and r.hasta > current_date)
                    ) order by u.identificador), '[]'::jsonb)
                    from public.producto_unidades u where u.producto_id = p.id)
    ) order by p.nombre), '[]'::jsonb)
    from public.productos p
  )
) as foto;
`;

// ── Lectura de Dion (única parte con red: UN GET) ──────────────────────────────────────────────────────────────────────────────────────
export const SELECT_DION = "id,name,model,sku,product_pricing(daily_rate,weekly_rate,fortnight_rate,three_week_low_rate,three_week_high_rate,monthly_rate,biannual_rate,yearly_rate),serialized_items(id,serial_number,license_plate,bbm_code,status,condition)";

export async function leeDion({ url, key, fetchFn = globalThis.fetch, timeoutMs = 15000 } = {}) {
  if (!url || !key) throw new Error("Faltan SUPABASE_URL y SUPABASE_ANON_KEY (las del servicio bbm-bot: `railway run`).");
  const q = new URLSearchParams({ select: SELECT_DION, order: "name.asc" });
  const res = await fetchFn(`${String(url).replace(/\/+$/, "")}/rest/v1/products?${q}`, {
    method: "GET", headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Dion contestó HTTP ${res.status}`);
  const filas = await res.json();
  if (!Array.isArray(filas)) throw new Error("Dion no devolvió una lista de productos");
  return { fecha: new Date().toISOString().slice(0, 10), productos: filas.map(aFotoDion) };
}

// Forma de la foto de Dion que compara el resto: nombre, tarifas por días y unidades con matrícula/código/estado.
export function aFotoDion(p) {
  const pr = Array.isArray(p.product_pricing) ? p.product_pricing[0] : p.product_pricing;
  const tarifas = {};
  if (pr) for (const [col, dias] of TRAMOS_DION) if (pr[col] != null && Number.isFinite(Number(pr[col]))) tarifas[dias] = Number(pr[col]);
  return {
    nombre: String(p.name ?? ""), sku: p.sku ?? null, tarifas,
    unidades: (p.serialized_items || []).map((u) => ({ matricula: u.license_plate ?? null, codigo: u.bbm_code ?? null, estado: u.status ?? null })),
  };
}

// La foto del ERP puede venir tal cual o dentro de `foto` (según cómo la devuelva la herramienta de Backend).
export function leeFotoErp(texto) {
  let o = texto;
  if (typeof o === "string") {
    // `erp/sql.py` imprime la tabla de psql («foto», una raya, el JSON en una línea, «(1 row)»): se toma desde la primera llave a la última.
    try { o = JSON.parse(o); } catch { const a = o.indexOf("{"), b = o.lastIndexOf("}"); if (a < 0 || b < a) throw new Error("La foto del ERP no es JSON"); o = JSON.parse(o.slice(a, b + 1)); }
  }
  if (typeof o === "string") o = JSON.parse(o);
  if (o && o.foto) o = typeof o.foto === "string" ? JSON.parse(o.foto) : o.foto;
  if (!o || !Array.isArray(o.productos)) throw new Error("La foto del ERP no trae `productos`");
  return o;
}

// ── La comparación (pura: sin red, sin disco) ──────────────────────────────────────────────────────────────────────────────────────────
// Devuelve { ok, resumen, modelos:{...}, tarifas:{...}, motos:{...}, no_se_puede_saber:[...] }. `ok` solo si NO hay ninguna diferencia.
export function comparaFotos(dion, erp) {
  const dProd = (dion.productos || []).filter((p) => Object.keys(p.tarifas || {}).length > 0);   // sin tarifa no se ofrece ni se cargó (4 en la carga)
  const dSinTarifa = (dion.productos || []).filter((p) => !Object.keys(p.tarifas || {}).length);
  const eProd = erp.productos || [];

  const eMap = new Map(), eDup = [];
  for (const p of eProd) { const n = normNombre(p.nombre); if (eMap.has(n)) eDup.push(p.nombre); else eMap.set(n, p); }
  const dMap = new Map(), dDup = [];
  for (const p of dProd) { const n = normNombre(p.nombre); if (dMap.has(n)) dDup.push(p.nombre); else dMap.set(n, p); }

  // (a) modelos
  const faltan_en_erp = [], sobran_en_erp = [];
  for (const [n, p] of dMap) if (!eMap.has(n)) faltan_en_erp.push(p.nombre);
  for (const [n, p] of eMap) {
    if (dMap.has(n)) continue;
    // Un producto del ERP sin tarifas ni unidades no es una moto (p. ej. «entrega-km»): se anota aparte, no cuenta como diferencia.
    if ((p.tarifas || []).length || (p.unidades || []).length) sobran_en_erp.push(p.nombre);
  }
  const modelos = { dion: dMap.size, erp: eMap.size, faltan_en_erp, sobran_en_erp, nombres_repetidos: { dion: dDup, erp: eDup },
    dion_sin_tarifa_ignorados: dSinTarifa.map((p) => `${p.nombre} (${(p.unidades || []).length} unidades)`) };

  // (b) tarifas, solo de los modelos presentes en los dos lados (los que faltan ya están en (a))
  const tarifas = { comparadas: 0, iguales: 0, distintas: [], solo_en_dion: [], solo_en_erp: [], moneda_distinta: [] };
  for (const [n, d] of dMap) {
    const e = eMap.get(n);
    if (!e) continue;
    const et = new Map((e.tarifas || []).map((t) => [Number(t.dias), t]));
    const dias = new Set([...Object.keys(d.tarifas).map(Number), ...et.keys()]);
    for (const dia of [...dias].sort((a, b) => a - b)) {
      const pd = d.tarifas[dia], t = et.get(dia);
      if (pd === undefined) { tarifas.solo_en_erp.push({ modelo: d.nombre, dias: dia, erp: Number(t.precio) }); continue; }
      if (!t) { tarifas.solo_en_dion.push({ modelo: d.nombre, dias: dia, dion: pd }); continue; }
      tarifas.comparadas += 1;
      if (t.moneda !== "IDR") tarifas.moneda_distinta.push({ modelo: d.nombre, dias: dia, moneda: t.moneda });
      if (Math.round(Number(t.precio)) === Math.round(pd)) tarifas.iguales += 1;
      else tarifas.distintas.push({ modelo: d.nombre, dias: dia, dion: pd, erp: Number(t.precio) });
    }
  }

  // (c) motos, por matrícula (el identificador del ERP). Una moto de Dion retirada que no está en el ERP es lo correcto.
  const eUni = new Map(), eUniDup = [];
  for (const p of eProd) for (const u of p.unidades || []) {
    const k = normPlaca(u.identificador);
    if (eUni.has(k)) eUniDup.push(u.identificador); else eUni.set(k, { ...u, modelo: p.nombre });
  }
  const motos = { dion: 0, erp: eUni.size, correctas: 0, falta_alta: [], sobra_en_erp: [], modelo_distinto: [], disponible_en_erp_no_en_dion: [], alquilada_sin_bloqueo: [],
    en_taller_dion_no_taller_erp: [], disponible_en_dion_no_en_erp: [], sin_matricula: [], matriculas_repetidas: { erp: eUniDup, dion: [] } };
  const vistas = new Set();
  // Las unidades de un producto de Dion sin tarifa no se cargaron (la carga solo lleva modelos con precio): no son «falta de alta».
  for (const p of dProd) for (const u of p.unidades || []) {
    const etiqueta = `${p.nombre}: ${u.matricula ?? "sin matrícula"}${u.codigo ? ` (${u.codigo})` : ""}`;
    if (!u.matricula || !String(u.matricula).trim()) { motos.sin_matricula.push(etiqueta + ` [${u.estado}]`); continue; }
    const k = normPlaca(u.matricula);
    if (vistas.has(k)) { motos.matriculas_repetidas.dion.push(u.matricula); continue; }
    vistas.add(k);
    motos.dion += 1;
    const eu = eUni.get(k);
    if (u.estado === "retired") {
      if (eu && eu.estado === "disponible") motos.disponible_en_erp_no_en_dion.push({ moto: etiqueta, dion: "retirada", erp: eu.estado });
      else motos.correctas += 1;                                           // ausente o ya dada de baja/taller: no se ofrece
      continue;
    }
    if (!eu) { motos.falta_alta.push({ moto: etiqueta, dion: u.estado }); continue; }
    if (normNombre(eu.modelo) !== normNombre(p.nombre)) { motos.modelo_distinto.push({ moto: etiqueta, modelo_erp: eu.modelo }); continue; }
    const bloqueos = (eu.bloqueos || []).filter((b) => ESTADOS_BLOQUEO.has(b.estado));
    if (u.estado === "available") {
      if (eu.estado === "disponible") motos.correctas += 1;
      else motos.disponible_en_dion_no_en_erp.push({ moto: etiqueta, erp: eu.estado });
    } else if (u.estado === "rented") {
      // Alquilada en Dion: el ERP debe tener un bloqueo vivo, o la ofrecería libre (el peligro de 7.4 del encargo).
      if (eu.estado === "disponible" && !bloqueos.length) motos.alquilada_sin_bloqueo.push({ moto: etiqueta, erp: eu.estado });
      else motos.correctas += 1;
    } else if (u.estado === "maintenance") {
      if (eu.estado === "taller") motos.correctas += 1;
      else motos.en_taller_dion_no_taller_erp.push({ moto: etiqueta, erp: eu.estado });
    } else {
      motos.en_taller_dion_no_taller_erp.push({ moto: etiqueta, erp: eu.estado, dion: `estado desconocido «${u.estado}»` });
    }
  }
  for (const [k, u] of eUni) if (!vistas.has(k) && u.estado !== "baja") motos.sobra_en_erp.push({ moto: `${u.modelo}: ${u.identificador}`, erp: u.estado });

  const diferencias = {
    modelos: faltan_en_erp.length + sobran_en_erp.length + dDup.length + eDup.length,
    tarifas: tarifas.distintas.length + tarifas.solo_en_dion.length + tarifas.solo_en_erp.length + tarifas.moneda_distinta.length,
    motos: motos.falta_alta.length + motos.sobra_en_erp.length + motos.modelo_distinto.length + motos.disponible_en_erp_no_en_dion.length
      + motos.alquilada_sin_bloqueo.length + motos.en_taller_dion_no_taller_erp.length + motos.disponible_en_dion_no_en_erp.length
      + motos.sin_matricula.length + motos.matriculas_repetidas.erp.length + motos.matriculas_repetidas.dion.length,
  };
  const total = diferencias.modelos + diferencias.tarifas + diferencias.motos;
  return {
    ok: total === 0,
    resumen: { fecha_dion: dion.fecha ?? null, fecha_erp: erp.fecha ?? null, diferencias, total_diferencias: total,
      tarifas_comparadas: tarifas.comparadas, tarifas_iguales: tarifas.iguales },
    modelos, tarifas, motos,
    no_se_puede_saber: [
      "La fecha en que Dion devuelve cada moto alquilada: esta lectura trae el estado, no sus alquileres. El bloqueo se crea con la fecha que Dion tenga ese día.",
      "Que la foto sea de ese mismo día: se comparan las dos fotos que se le pasan; las fechas de cada una van arriba y deben ser las del corte.",
    ],
  };
}

export function textoInforme(inf) {
  const r = inf.resumen, L = [];
  L.push(`FOTO DION ↔ ERP (solo lectura) — Dion ${r.fecha_dion ?? "?"} · ERP ${r.fecha_erp ?? "?"}`);
  L.push(inf.ok ? "RESULTADO: 0 diferencias. Se puede dar la condición del corte por cumplida (con estas dos fotos)." : `RESULTADO: ${r.total_diferencias} diferencias (modelos ${r.diferencias.modelos} · tarifas ${r.diferencias.tarifas} · motos ${r.diferencias.motos}). El corte NO está listo.`);
  L.push(`Modelos: Dion ${inf.modelos.dion} · ERP ${inf.modelos.erp}. Tarifas: ${r.tarifas_iguales} de ${r.tarifas_comparadas} comparadas iguales. Motos: ${inf.motos.dion} en Dion con matrícula · ${inf.motos.erp} en el ERP · ${inf.motos.correctas} correctas.`);
  const lista = (titulo, a, f) => { if (a.length) { L.push(`\n${titulo} (${a.length}):`); for (const x of a.slice(0, 60)) L.push("  · " + f(x)); if (a.length > 60) L.push(`  … y ${a.length - 60} más (están en el JSON)`); } };
  lista("Modelos de Dion que faltan en el ERP", inf.modelos.faltan_en_erp, (x) => x);
  lista("Modelos del ERP que ya no están en Dion", inf.modelos.sobran_en_erp, (x) => x);
  lista("Nombres repetidos en Dion", inf.modelos.nombres_repetidos.dion, (x) => x);
  lista("Nombres repetidos en el ERP", inf.modelos.nombres_repetidos.erp, (x) => x);
  lista("Tarifas con precio distinto", inf.tarifas.distintas, (x) => `${x.modelo}, ${x.dias} días: Dion ${x.dion} · ERP ${x.erp}`);
  lista("Tarifas solo en Dion", inf.tarifas.solo_en_dion, (x) => `${x.modelo}, ${x.dias} días: ${x.dion}`);
  lista("Tarifas solo en el ERP", inf.tarifas.solo_en_erp, (x) => `${x.modelo}, ${x.dias} días: ${x.erp}`);
  lista("Tarifas en otra moneda", inf.tarifas.moneda_distinta, (x) => `${x.modelo}, ${x.dias} días: ${x.moneda}`);
  lista("Motos de Dion sin alta en el ERP", inf.motos.falta_alta, (x) => `${x.moto} [Dion: ${x.dion}]`);
  lista("Motos del ERP que Dion no tiene", inf.motos.sobra_en_erp, (x) => `${x.moto} [ERP: ${x.erp}]`);
  lista("Moto en otro modelo", inf.motos.modelo_distinto, (x) => `${x.moto} → en el ERP es ${x.modelo_erp}`);
  lista("ALQUILADAS en Dion y LIBRES en el ERP, sin bloqueo (el bot las ofrecería)", inf.motos.alquilada_sin_bloqueo, (x) => x.moto);
  lista("Retiradas en Dion y disponibles en el ERP", inf.motos.disponible_en_erp_no_en_dion, (x) => x.moto);
  lista("En taller o en otro estado en Dion y no en taller en el ERP", inf.motos.en_taller_dion_no_taller_erp, (x) => `${x.moto} [ERP: ${x.erp}${x.dion ? ` · ${x.dion}` : ""}]`);
  lista("Disponibles en Dion y no disponibles en el ERP", inf.motos.disponible_en_dion_no_en_erp, (x) => `${x.moto} [ERP: ${x.erp}]`);
  lista("Motos de Dion sin matrícula", inf.motos.sin_matricula, (x) => x);
  lista("Matrículas repetidas", [...inf.motos.matriculas_repetidas.dion, ...inf.motos.matriculas_repetidas.erp], (x) => x);
  L.push("\nNo se puede saber con estas lecturas:");
  for (const x of inf.no_se_puede_saber) L.push("  · " + x);
  return L.join("\n");
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function main(argv) {
  const [modo, ...resto] = argv;
  if (modo === "--sql-erp") { process.stdout.write(SQL_ERP); return 0; }
  if (modo === "--lee-dion") {
    const salida = resto[0];
    if (!salida) { console.error("Uso: node bbm-foto-corte.js --lee-dion dion.json"); return 2; }
    const foto = await leeDion({ url: process.env.SUPABASE_URL, key: process.env.SUPABASE_ANON_KEY });
    fs.writeFileSync(salida, JSON.stringify(foto, null, 2));
    console.log(`Foto de Dion guardada en ${salida}: ${foto.productos.length} productos, ${foto.productos.reduce((n, p) => n + p.unidades.length, 0)} unidades.`);
    return 0;
  }
  if (modo === "--compara") {
    const [fd, fe, ...o] = resto;
    if (!fd || !fe) { console.error("Uso: node bbm-foto-corte.js --compara dion.json erp.json [--json informe.json]"); return 2; }
    const dion = JSON.parse(fs.readFileSync(fd, "utf8"));
    const erp = leeFotoErp(fs.readFileSync(fe, "utf8"));
    const inf = comparaFotos(dion, erp);
    const i = o.indexOf("--json");
    if (i >= 0 && o[i + 1]) fs.writeFileSync(o[i + 1], JSON.stringify(inf, null, 2));
    console.log(textoInforme(inf));
    return inf.ok ? 0 : 1;
  }
  console.error("Uso: --sql-erp | --lee-dion dion.json | --compara dion.json erp.json [--json informe.json]");
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(`Error: ${e.message}`); process.exitCode = 2; });
}
