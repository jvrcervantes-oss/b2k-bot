// ponytail: self-check del dashboard de salidas y cobros (index.js → parseTripDate / expectedOf /
// paidOf / pkgKeyOf). Duplica las funciones en vez de importar index.js, que arranca Express +
// Redis al importarse. Si cambian allí, actualizar aquí.
//
// Lo que motivó cada bloque:
//  · parseTripDate — `travelDate` es TEXTO LIBRE del cliente. En los 94 leads reales conviven
//    "November 4, 2026", "late 2027" y "October 2026". Tratar un mes como un día llena el
//    calendario de salidas que nadie confirmó y dispara vencimientos de saldo inventados.
//  · expectedOf — la tabla de precios del panel llevaba meses desfasada (3200/3950/4300 contra
//    los 2700/3450/3950 reales) y falseaba el pipeline hacia arriba.
import assert from "node:assert";

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
function parseTripDate(raw) {
  const s = String(raw || "").toLowerCase().trim();
  if (!s) return { precision: "none", key: "", label: "" };
  const iso = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return { precision: "day", key: `${iso[1]}-${iso[2]}-${iso[3]}`, label: `${iso[1]}-${iso[2]}-${iso[3]}` };
  const yearM = s.match(/\b(20\d{2})\b/);
  if (!yearM) return { precision: "none", key: "", label: String(raw).trim() };
  const year = yearM[1];
  const mIdx = MONTHS.findIndex((m) => s.includes(m.slice(0, 3)) && new RegExp(`\\b${m.slice(0, 3)}`).test(s));
  if (mIdx < 0) return { precision: "year", key: year, label: String(raw).trim() };
  const mm = String(mIdx + 1).padStart(2, "0");
  const day = s.replace(year, " ").match(/\b([1-9]|[12]\d|3[01])(?:st|nd|rd|th)?\b/);
  if (day) return { precision: "day", key: `${year}-${mm}-${String(day[1]).padStart(2, "0")}`, label: `${year}-${mm}-${String(day[1]).padStart(2, "0")}` };
  return { precision: "month", key: `${year}-${mm}`, label: `${MONTHS[mIdx][0].toUpperCase() + MONTHS[mIdx].slice(1)} ${year}` };
}

const pkgKeyOf = (p) => {
  const s = String(p || "").toLowerCase();
  if (s.includes("deluxe")) return "deluxe";
  if (s.includes("extreme")) return "extreme";
  if (s.includes("roundtrip") || s.includes("round trip")) return "roundtrip";
  if (s.includes("standard") || s.includes("best value")) return "standard";
  return "";
};
const PRICING = { roundtrip: 2700, extreme: 3450, deluxe: 3950, standard: 2700 };
const PILLION_ADJ = -380;
const paidOf = (l) => (Array.isArray(l.payments) ? l.payments : []).reduce((a, p) => a + (Number(p.amount) || 0), 0);
function expectedOf(l, pricing, pillionAdjust) {
  const dv = parseInt(l.dealValue, 10);
  if (dv > 0) return { amount: dv, estimated: false };
  const unit = pricing[pkgKeyOf(l.package)] || 0;
  if (!unit) return { amount: 0, estimated: true };
  const riders = parseInt(l.riders, 10) || 0;
  const pillions = parseInt(l.pillions, 10) || 0;
  if (!riders && !pillions) return { amount: 0, estimated: true };
  return { amount: unit * riders + Math.max(0, unit + (pillionAdjust || 0)) * pillions, estimated: true };
}

// ── parseTripDate ────────────────────────────────────────────────
// Frase literal del lead real que motivó la tarea.
assert.deepStrictEqual(parseTripDate("November 4, 2026"), { precision: "day", key: "2026-11-04", label: "2026-11-04" });
assert.strictEqual(parseTripDate("2026-11-04").precision, "day");
assert.strictEqual(parseTripDate("4th November 2026").key, "2026-11-04");
assert.strictEqual(parseTripDate("Nov 2026").precision, "month", "un mes sin día NO es una salida cerrada");
assert.strictEqual(parseTripDate("October 2026").key, "2026-10");
assert.strictEqual(parseTripDate("late 2027").precision, "year");
assert.strictEqual(parseTripDate("late 2027").key, "2027");
assert.strictEqual(parseTripDate("").precision, "none");
assert.strictEqual(parseTripDate("sometime soon").precision, "none", "sin año no se puede agrupar");
assert.strictEqual(parseTripDate("sometime soon").key, "", "sin key = no entra en el calendario");
// El año no puede colarse como día: "2026" contiene "20" y "26".
assert.strictEqual(parseTripDate("May 2026").precision, "month", "el año no debe leerse como día");

// ── valor esperado ───────────────────────────────────────────────
const exp = (l) => expectedOf(l, PRICING, PILLION_ADJ);
assert.deepStrictEqual(exp({ package: "Deluxe", riders: 2 }), { amount: 7900, estimated: true });
assert.strictEqual(exp({ package: "Deluxe", riders: 2, dealValue: 9000 }).amount, 9000, "el importe cerrado pisa la estimación");
assert.strictEqual(exp({ package: "Deluxe", riders: 2, dealValue: 9000 }).estimated, false);
// El pillion ocupa plaza y paga, pero 380 menos: 2700 + (2700-380) = 5020, NO 5400.
assert.strictEqual(exp({ package: "Roundtrip", riders: 1, pillions: 1 }).amount, 5020);
assert.strictEqual(exp({ package: "Deluxe", riders: 2, pillions: 1 }).amount, 3950 * 2 + 3570);
// Banda del formulario de IG: se estima por el suelo, nunca por el techo viejo de 3.950.
assert.strictEqual(exp({ package: "Standard / best value (US$3,200–US$3,950)", riders: 1 }).amount, 2700);
assert.strictEqual(exp({ package: "Help me choose", riders: 1 }).amount, 0, "sin paquete no se inventa un valor");
assert.strictEqual(exp({ package: "Deluxe" }).amount, 0, "sin nº de riders tampoco");
// Un pillion sin rider (dato incompleto) no puede dar negativo ni romper.
assert.strictEqual(exp({ package: "Roundtrip", pillions: 1 }).amount, 2320);

// ── pagos ────────────────────────────────────────────────────────
assert.strictEqual(paidOf({}), 0);
assert.strictEqual(paidOf({ payments: [{ amount: 500 }, { amount: 1000 }] }), 1500);
assert.strictEqual(paidOf({ payments: [{ amount: "500" }] }), 500, "importe en texto no debe dar NaN");
// Un lead que ya pagó de más no genera saldo negativo.
const l = { package: "Roundtrip", riders: 1, payments: [{ amount: 3000 }] };
assert.strictEqual(Math.max(0, exp(l).amount - paidOf(l)), 0);

console.log("OK — dashboard de salidas y cobros: 23 casos");
