// Regla de entrega por km de BBM (cliente, 9-oct-2026). Función pura: el sistema del cliente
// (bbm-erp) sigue siendo quien geocodifica y devuelve los km, pero su tabla `delivery_km_rates`
// todavía trae las tarifas viejas (6.000/km) y no sabe que el semestral es gratis; el bot aplica
// aquí las nuevas sobre los km que ese sistema devuelve. Si Dion actualiza su tabla, esta regla
// y la suya darán lo mismo y esto puede retirarse.
//
//   semestral (180 días o más)  → gratis en toda la isla, incluido Gilimanuk
//   mensual (30-179 días)       → gratis hasta 30 km; pasado eso, 100.000 + 6.500/km
//   resto (diario, semanal…)    → hasta 30 km lo que diga su sistema; pasado eso, igual que el mensual
// Los km de más se cuentan sobre los 30 gratis y por ida y vuelta (misma fórmula que su sistema).
export const DELIVERY_FREE_KM = 30;
export const DELIVERY_BASE_FEE = 100000;
export const DELIVERY_PER_KM = 6500;
export const BIANNUAL_FROM_DAYS = 180;
export const MONTHLY_FROM_DAYS = 30;

// Devuelve el total ida+vuelta en IDR, o null si no se puede decidir y vale el importe del sistema
// (zona con tarifa plana sin km, datos que no cuadran).
export function deliveryFeeByKm({ km, days, erpFee }) {
  const d = Number(days);
  if (!Number.isFinite(d) || d <= 0) return null;
  if (d >= BIANNUAL_FROM_DAYS) return 0;
  if (km === null || km === undefined || km === "") return null;
  const k = Number(km);
  if (!Number.isFinite(k) || k < 0) return null;
  if (k > DELIVERY_FREE_KM) {
    return DELIVERY_BASE_FEE + Math.round((k - DELIVERY_FREE_KM) * 2 * DELIVERY_PER_KM);
  }
  if (d >= MONTHLY_FROM_DAYS) return 0;
  return Number.isFinite(Number(erpFee)) ? Number(erpFee) : null;
}
