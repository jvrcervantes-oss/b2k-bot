// Regla de entrega por km (BBM, 9-oct-2026). Ejecutar: node test-delivery-rule.js
import assert from "node:assert";
import { deliveryFeeByKm as f } from "./delivery-rule.js";

// Jembrana (Negara) 94 km: 64 km de exceso × 2 × 6.500 + 100.000
assert.strictEqual(f({ km: 94, days: 2, erpFee: 968000 }), 932000, "diario >30 km");
assert.strictEqual(f({ km: 94, days: 7, erpFee: 968000 }), 932000, "semanal igual que diario");
assert.strictEqual(f({ km: 94, days: 34, erpFee: 768000 }), 932000, "mensual >30 km: 100k + 6.500/km");
assert.strictEqual(f({ km: 126, days: 34, erpFee: 1152000 }), 100000 + 96 * 2 * 6500, "Gilimanuk mensual");
// Semestral: gratis aunque sea Gilimanuk
assert.strictEqual(f({ km: 126, days: 180, erpFee: 1152000 }), 0, "semestral gratis hasta Gilimanuk");
assert.strictEqual(f({ km: 5, days: 365, erpFee: 100000 }), 0, "anual gratis");
assert.strictEqual(f({ km: null, days: 180, erpFee: 200000 }), 0, "semestral gratis aunque sea zona sin km");
// Mensual hasta 30 km gratis; corto hasta 30 km = lo del sistema
assert.strictEqual(f({ km: 22, days: 34, erpFee: 200000 }), 0, "mensual <=30 km gratis");
assert.strictEqual(f({ km: 30, days: 30, erpFee: 100000 }), 0, "mensual justo 30 km gratis");
assert.strictEqual(f({ km: 22, days: 2, erpFee: 200000 }), 200000, "diario <=30 km: importe del sistema");
// Fuera de regla: zona con tarifa plana sin km y alquiler corto/mensual -> null (vale el sistema)
assert.strictEqual(f({ km: null, days: 34, erpFee: 200000 }), null, "sin km mensual: el sistema");
assert.strictEqual(f({ km: 94, days: 0, erpFee: 1 }), null, "dias invalidos");
console.log("test-delivery-rule OK");
