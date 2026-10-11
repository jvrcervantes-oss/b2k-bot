// Privacidad antes de abrir BBM a clientes (BBM-40; origen: Legal, contexto/legal/bbm/01_plazos_y_purga.md B.4 y A.4).
// TODO nace APAGADO: con las variables ausentes, el bot hace exactamente lo de antes (lo fija test-privacidad.js).
// Los interruptores son variables de entorno de Railway y no claves de Redis a propósito: lo que borra datos o
// cambia cómo se entra al panel no puede encenderse desde el propio panel. Los enciende el owner (BBM-40 en pendientes).
//
//   PRIV_BORRADO_COMPLETO=1    borrar un lead borra también sus fotos `doc:<id>` (hoy quedan huérfanas hasta su TTL),
//                              sus citas `appt:*` y sus entradas de la cola de escalación `esc_queue` (llevan su teléfono)
//   PRIV_TELEGRAM_SIN_DATOS=1  los avisos de Telegram salen sin nombre, teléfono, texto del cliente ni importe
//   DOC_TTL_DAYS               días que vive una foto que manda el cliente (por defecto 60, como hoy)
//   PRIV_PURGA=contar|aplicar  pasada diaria de conversaciones y leads vencidos (ausente = no corre nada)
//   PRIV_CONV_DIAS / PRIV_LEAD_DIAS  plazos de esa pasada; vacíos o por debajo del suelo = esa categoría no hace nada

export const DOC_TTL_DEFECTO = 60;
export const SUELO_CONV_DIAS = 30; // Legal B.2: 30 días para conversaciones
export const SUELO_LEAD_DIAS = 90; // Legal B.2: 90 días para leads
export const TOPE_PURGA = 200;     // máximo de borrados por categoría y pasada
const DIA_MS = 24 * 3600 * 1000;

function entero(v) {
  const s = String(v ?? "").trim();
  return /^\d+$/.test(s) ? parseInt(s, 10) : null;
}

export function leeConfigPrivacidad(env = {}) {
  const avisos = [];
  let docTtlDias = DOC_TTL_DEFECTO;
  if (env.DOC_TTL_DAYS != null && String(env.DOC_TTL_DAYS).trim() !== "") {
    const n = entero(env.DOC_TTL_DAYS);
    if (n != null && n >= 1 && n <= 365) docTtlDias = n;
    else avisos.push(`DOC_TTL_DAYS="${String(env.DOC_TTL_DAYS).slice(0, 20)}" no es un entero de 1 a 365: se usa ${DOC_TTL_DEFECTO}`);
  }
  const modoRaw = String(env.PRIV_PURGA ?? "").trim().toLowerCase();
  let modo = "off";
  if (modoRaw === "contar" || modoRaw === "aplicar") modo = modoRaw;
  else if (modoRaw !== "" && modoRaw !== "off") avisos.push(`PRIV_PURGA="${modoRaw.slice(0, 20)}" no es contar ni aplicar: la purga queda apagada`);
  const plazo = (nombre, suelo) => {
    const raw = env[nombre];
    if (raw == null || String(raw).trim() === "") return null;
    const n = entero(raw);
    if (n == null || n < suelo) { avisos.push(`${nombre} vacío, ilegible o por debajo de ${suelo} días: esa categoría no hace nada`); return null; }
    return n;
  };
  return {
    borradoCompleto: env.PRIV_BORRADO_COMPLETO === "1",
    telegramSinDatos: env.PRIV_TELEGRAM_SIN_DATOS === "1",
    docTtlDias,
    purga: { modo, convDias: modo === "off" ? null : plazo("PRIV_CONV_DIAS", SUELO_CONV_DIAS), leadDias: modo === "off" ? null : plazo("PRIV_LEAD_DIAS", SUELO_LEAD_DIAS) },
    avisos,
  };
}

// Las claves `doc:<id>` de un lead. El id lo genera saveInboundDoc (32 hex): cualquier otra cosa se ignora, para que un
// `docs` manipulado no pueda convertir el borrado de un lead en el borrado de otra clave de Redis.
export function docKeysDeLead(lead) {
  if (!lead || !Array.isArray(lead.docs)) return [];
  const out = [];
  for (const d of lead.docs) {
    const id = d && typeof d.id === "string" ? d.id : "";
    if (/^[0-9a-f]{32}$/.test(id)) out.push(`doc:${id}`);
  }
  return [...new Set(out)];
}

// Texto que sale a Telegram. Apagado: el de siempre. Encendido: solo el tipo de aviso y el enlace al panel; si quien
// llama no da versión mínima, sale un genérico (fail-closed: un aviso nuevo que se olvide de darla no filtra datos).
export function textoTelegram(cfg, proyecto, texto, minimo, panelUrl) {
  if (!cfg || !cfg.telegramSinDatos) return `🏍️ [${proyecto}] ${texto}`;
  const tipo = typeof minimo === "string" && minimo.trim() ? minimo.trim() : "Aviso nuevo";
  return `🏍️ [${proyecto}] ${tipo}\n${panelUrl ? `Panel: ${panelUrl}` : "Detalle en el panel del bot."}`;
}

// Último mensaje con fecha de una conversación guardada (`conv:<tel>`). null si no se puede leer: entonces no se borra.
export function ultimoTs(raw) {
  let arr;
  try { arr = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(arr)) return null;
  let max = null;
  for (const m of arr) { const t = m && Number(m.ts); if (Number.isFinite(t) && t > 0 && (max == null || t > max)) max = t; }
  return max;
}

// Una pasada de la purga. `contar`: no cambia nada, devuelve recuentos. `aplicar`: borra lo vencido, como mucho TOPE_PURGA
// por categoría. Conversación vencida = su último mensaje con fecha es anterior al plazo. Lead vencido = su última
// actividad (`updatedAt`, el score de leads_index) es anterior al plazo y no tiene un pago pendiente. Cualquier duda
// (sin fecha, JSON roto, lead desaparecido) = no se borra.
// Un lead con cualquier rastro de cobro (enlace de pago generado o pago confirmado), marcado como pagado, ganado o con un
// alquiler ganado o ya pasado al ERP (`deals`, de donde sale /admin/api/bookings) no se purga nunca aquí.
export function leadRetenido(lead) {
  if (!lead) return true;
  if (lead.paid === true || lead.paidAt || lead.status === "won" || lead.erpCreated) return true;
  const h = Array.isArray(lead.history) ? lead.history : [];
  if (h.some((e) => e && (e.type === "paylink" || e.type === "payment"))) return true;
  const deals = Array.isArray(lead.deals) ? lead.deals : [];
  return deals.some((d) => d && (d.status === "won" || d.erpCreated));
}

export async function purgaPasada({ redis, cfg, now = Date.now(), deleteLead, tieneCitaFutura = async () => false, log = console, proyecto = "bot" }) {
  const p = cfg && cfg.purga;
  const r = { modo: p ? p.modo : "off", ts: now, conv: null, leads: null };
  if (!redis || !p || p.modo === "off") return r;
  const aplicar = p.modo === "aplicar";
  if (p.convDias) {
    const corte = now - p.convDias * DIA_MS;
    const c = { dias: p.convDias, total: 0, vencidas: 0, sin_fecha: 0, borradas: 0 };
    for await (const key of redis.scanIterator({ MATCH: "conv:*", COUNT: 100 })) {
      c.total++;
      const t = ultimoTs(await redis.get(key));
      if (t == null) { c.sin_fecha++; continue; }
      if (t >= corte) continue;
      c.vencidas++;
      if (aplicar && c.borradas < TOPE_PURGA) {
        // se vuelve a leer justo antes de borrar: si entró un mensaje entre medias, ya no está vencida
        const t2 = ultimoTs(await redis.get(key));
        if (t2 != null && t2 < corte) {
          await redis.del(key);
          c.borradas++;
          // la ficha guarda hasta 200 caracteres del último mensaje (vista previa del panel): con la conversación, se va
          const tel = key.slice("conv:".length);
          const raw = await redis.get(`lead:${tel}`);
          let lead = null; try { lead = raw ? JSON.parse(raw) : null; } catch { lead = null; }
          if (lead && lead.lastMessage && Number(lead.updatedAt) < corte) { lead.lastMessage = ""; await redis.set(`lead:${tel}`, JSON.stringify(lead)); }
        }
      }
    }
    r.conv = c;
  }
  if (p.leadDias) {
    const corte = now - p.leadDias * DIA_MS;
    const l = { dias: p.leadDias, total: await redis.zCard("leads_index"), vencidos: 0, retenidos: 0, borrados: 0 };
    const tels = await redis.zRangeByScore("leads_index", 0, corte - 1);
    for (const tel of tels) {
      const raw = await redis.get(`lead:${tel}`);
      let lead = null;
      try { lead = raw ? JSON.parse(raw) : null; } catch { lead = null; }
      const upd = lead ? Number(lead.updatedAt) : NaN;
      if (!lead || !Number.isFinite(upd) || upd >= corte) continue; // sin ficha o con fecha que no cuadra: no se toca
      // Legal A.2 fila 5: la purga es del «contacto que NO reservó». El cobro solo vive en lead.history (no hay almacén
      // aparte): borrar un lead que pagó borraría lo único que queda del pago. Se retiene, y también con un pago a medias,
      // estado «won» o una cita futura (Seguridad, revisión previa del 11-oct).
      if (leadRetenido(lead) || (await redis.get(`pendingpay:${tel}`)) || (await redis.get(`pendingrsv:${String(tel).replace(/\D/g, "")}`))
        || (await redis.get(`status:${tel}`)) === "won" || (await tieneCitaFutura(tel))) { l.retenidos++; continue; }
      l.vencidos++;
      if (aplicar && l.borrados < TOPE_PURGA) { await deleteLead(tel); l.borrados++; }
    }
    r.leads = l;
  }
  const partes = [];
  if (r.conv) partes.push(`conversaciones vencidas ${r.conv.vencidas} de ${r.conv.total} (${r.conv.dias} d${aplicar ? `, borradas ${r.conv.borradas}` : ""}; sin fecha ${r.conv.sin_fecha})`);
  if (r.leads) partes.push(`leads vencidos ${r.leads.vencidos} de ${r.leads.total} (${r.leads.dias} d${aplicar ? `, borrados ${r.leads.borrados}` : ""}; retenidos por pago, reserva o cita ${r.leads.retenidos})`);
  log.log(`[${proyecto}] Purga de privacidad (${p.modo}): ${partes.join(" · ") || "sin plazos válidos, no hace nada"}`);
  return r;
}
