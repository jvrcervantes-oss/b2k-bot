// Pruebas de bbm-foto-corte.js (subtarea 7): la comparación es pura y la lectura de Dion es UN GET. Sin red, sin disco.
import assert from "node:assert/strict";
import test from "node:test";
import { comparaFotos, leeDion, leeFotoErp, aFotoDion, SQL_ERP, textoInforme } from "./bbm-foto-corte.js";

const dionBase = () => ({
  fecha: "2026-10-20",
  productos: [
    { nombre: "Honda Vario", tarifas: { 1: 120000, 7: 720000, 30: 2400000 }, unidades: [
      { matricula: "DK 1 A", codigo: "BBM-1", estado: "available" }, { matricula: "DK 2 A", codigo: "BBM-2", estado: "rented" },
      { matricula: "DK 3 A", codigo: "BBM-3", estado: "maintenance" }, { matricula: "DK 4 A", codigo: "BBM-4", estado: "retired" } ] },
    { nombre: "Honda Vario 160", tarifas: { 1: 150000 }, unidades: [] },
    { nombre: "Carro", tarifas: {}, unidades: [{ matricula: "DK 9 Z", codigo: "BBM-9", estado: "available" }] },   // sin tarifa: no se carga
  ],
});
const erpBase = () => ({
  fecha: "2026-10-20",
  productos: [
    { nombre: "Honda Vario", tarifas: [{ dias: 1, precio: 120000, moneda: "IDR" }, { dias: 7, precio: "720000.0000", moneda: "IDR" }, { dias: 30, precio: 2400000, moneda: "IDR" }], unidades: [
      { identificador: "DK 1 A", estado: "disponible", bloqueos: [] },
      { identificador: "DK 2 A", estado: "disponible", bloqueos: [{ desde: "2026-10-18", hasta: "2026-10-22", estado: "bloqueo" }] },
      { identificador: "dk  3 a", estado: "taller", bloqueos: [] } ] },
    { nombre: "Honda Vario 160", tarifas: [{ dias: 1, precio: 150000, moneda: "IDR" }], unidades: [] },
    { nombre: "entrega-km", tarifas: [], unidades: [] },
  ],
});

test("todo igual: 0 diferencias, y la retirada de Dion ausente del ERP es lo correcto", () => {
  const r = comparaFotos(dionBase(), erpBase());
  assert.equal(r.ok, true, JSON.stringify(r.resumen));
  assert.equal(r.resumen.tarifas_comparadas, 4); assert.equal(r.resumen.tarifas_iguales, 4);
  assert.equal(r.motos.correctas, 4);                              // disponible, alquilada con bloqueo, taller (placa con otras mayúsculas/espacios) y retirada ausente
  assert.deepEqual(r.modelos.dion_sin_tarifa_ignorados, ["Carro (1 unidades)"]);
  assert.match(textoInforme(r), /0 diferencias/);
});

test("modelos: altas y bajas a la vista; «Honda Vario» no se confunde con «Honda Vario 160»", () => {
  const d = dionBase(), e = erpBase();
  e.productos = e.productos.filter((p) => p.nombre !== "Honda Vario 160");
  e.productos.push({ nombre: "Honda Beat", tarifas: [{ dias: 1, precio: 1, moneda: "IDR" }], unidades: [] });
  const r = comparaFotos(d, e);
  assert.deepEqual(r.modelos.faltan_en_erp, ["Honda Vario 160"]);
  assert.deepEqual(r.modelos.sobran_en_erp, ["Honda Beat"]);       // «entrega-km» (sin tarifas ni unidades) NO cuenta
  assert.equal(r.ok, false);
});

test("tarifas: precio distinto, tramo de más y tramo de menos, en las dos direcciones", () => {
  const e = erpBase();
  e.productos[0].tarifas[0].precio = 130000;                       // 1 día distinto
  e.productos[0].tarifas.splice(1, 1);                             // falta el de 7
  e.productos[0].tarifas.push({ dias: 365, precio: 9, moneda: "IDR" });
  const r = comparaFotos(dionBase(), e);
  assert.deepEqual(r.tarifas.distintas, [{ modelo: "Honda Vario", dias: 1, dion: 120000, erp: 130000 }]);
  assert.deepEqual(r.tarifas.solo_en_dion, [{ modelo: "Honda Vario", dias: 7, dion: 720000 }]);
  assert.deepEqual(r.tarifas.solo_en_erp, [{ modelo: "Honda Vario", dias: 365, erp: 9 }]);
  assert.equal(r.resumen.diferencias.tarifas, 3);
});

test("motos: alquilada en Dion y libre sin bloqueo en el ERP es el caso peligroso y sale", () => {
  const e = erpBase();
  e.productos[0].unidades[1].bloqueos = [{ desde: "2026-10-01", hasta: "2026-10-02", estado: "devuelta" }];   // un estado muerto no es un bloqueo vivo
  const r = comparaFotos(dionBase(), e);
  assert.equal(r.motos.alquilada_sin_bloqueo.length, 1);
  assert.match(r.motos.alquilada_sin_bloqueo[0].moto, /DK 2 A/);
  assert.equal(r.ok, false);
});

test("motos: taller, disponible, retirada y altas", () => {
  const e = erpBase();
  e.productos[0].unidades[2].estado = "disponible";                          // en taller en Dion, libre en el ERP
  e.productos[0].unidades[0].estado = "taller";                              // libre en Dion, no en el ERP
  e.productos[0].unidades.push({ identificador: "DK 4 A", estado: "disponible", bloqueos: [] });   // retirada en Dion y libre en el ERP
  e.productos[0].unidades.push({ identificador: "DK 7 A", estado: "disponible", bloqueos: [] });   // el ERP tiene una que Dion no
  const d = dionBase();
  d.productos[0].unidades.push({ matricula: "DK 8 A", codigo: "BBM-8", estado: "available" });     // Dion tiene una nueva
  const r = comparaFotos(d, e);
  assert.equal(r.motos.en_taller_dion_no_taller_erp.length, 1);
  assert.equal(r.motos.disponible_en_dion_no_en_erp.length, 1);
  assert.equal(r.motos.disponible_en_erp_no_en_dion.length, 1);
  assert.equal(r.motos.sobra_en_erp.length, 1);
  assert.equal(r.motos.falta_alta.length, 1);
  assert.equal(r.resumen.diferencias.motos, 5);
});

test("la matrícula repetida en el ERP se señala", () => {
  const e = erpBase();
  e.productos[1].unidades.push({ identificador: "DK 1 A", estado: "disponible", bloqueos: [] });  // la misma matrícula en dos modelos del ERP
  const r = comparaFotos(dionBase(), e);
  assert.equal(r.motos.matriculas_repetidas.erp.length, 1);
  assert.equal(r.ok, false);
});

test("lectura del ERP: tal cual, envuelta en `foto` o como texto", () => {
  const e = erpBase();
  assert.equal(leeFotoErp(JSON.stringify(e)).productos.length, 3);
  assert.equal(leeFotoErp({ foto: e }).productos.length, 3);
  assert.equal(leeFotoErp(JSON.stringify({ foto: JSON.stringify(e) })).productos.length, 3);
  assert.throws(() => leeFotoErp("{}"));
  // La salida real de `erp/sql.py` (tabla de psql, medida contra bbm el 11-oct): cabecera, raya, el JSON en una línea y «(1 row)».
  const tabla = ` foto \n-------\n ${JSON.stringify(e)}\n(1 row)\n\n`;
  assert.equal(leeFotoErp(tabla).productos.length, 3);
  assert.throws(() => leeFotoErp("ERROR: relation does not exist"), /no es JSON/);
});

test("Dion: UN solo GET a /rest/v1/products, sin cuerpo, y nunca otro método", async () => {
  const llamadas = [];
  const fetchFn = async (url, init) => {
    llamadas.push({ url: String(url), init });
    return { ok: true, status: 200, json: async () => [{ name: "Honda Vario", sku: "B1", product_pricing: [{ daily_rate: 120000, weekly_rate: 720000, three_week_low_rate: 1, three_week_high_rate: 1300000, yearly_rate: null }],
      serialized_items: [{ license_plate: "DK 1 A", bbm_code: "BBM-1", status: "rented" }] }] };
  };
  const f = await leeDion({ url: "https://dion.example.co/", key: "k", fetchFn });
  assert.equal(llamadas.length, 1);
  assert.equal(llamadas[0].init.method, "GET");
  assert.equal(llamadas[0].init.body, undefined);
  assert.match(llamadas[0].url, /^https:\/\/dion\.example\.co\/rest\/v1\/products\?/);
  assert.deepEqual(f.productos[0].tarifas, { 1: 120000, 7: 720000, 21: 1300000 });   // la tarifa baja de 3 semanas no entra, el null tampoco
  assert.deepEqual(f.productos[0].unidades, [{ matricula: "DK 1 A", codigo: "BBM-1", estado: "rented" }]);
  await assert.rejects(leeDion({ url: "", key: "" }), /Faltan/);
  await assert.rejects(leeDion({ url: "https://x", key: "k", fetchFn: async () => ({ ok: false, status: 401 }) }), /401/);
});

test("la consulta del ERP es una sola SELECT: ni una palabra de escritura", () => {
  const sinComentarios = SQL_ERP.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert.match(sinComentarios.trim(), /^select /i);
  assert.equal((sinComentarios.match(/;/g) || []).length, 1);
  assert.doesNotMatch(sinComentarios, /\b(insert|update|delete|drop|alter|truncate|grant|revoke|create|call|perform|set_config)\b/i);
  assert.ok(aFotoDion({ name: "x", product_pricing: null, serialized_items: null }).unidades.length === 0);
});
