// Comprobación previa del corte del bot de BBM al ERP (E1.10, 13-oct-2026, bbm-corte-bot). SOLO LEE: no cambia variables, no despliega,
// no escribe en Redis ni manda nada. Es el `--comprueba` del guion (bbm_corte_bot_13oct.md, punto 4); se lanza antes de cada paso.
//
//   node qa/corte_comprueba.mjs --fase <desplegado|prueba|precorte|corte|vuelta> [--sha <commit esperado en producción>]
//   BBM_ADMIN_KEY=<clave del panel> por el entorno (opcional): sin ella, el health queda NO MEDIDO y se dice. La clave nunca se escribe.
//
// Fases (qué tiene que ser verdad ANTES de seguir):
//   desplegado: el código nuevo corre (sha) con BBM_BACKEND=dion, BBM_ERP_CLAVE=1, sin teléfonos de prueba, backend efectivo dion.
//   prueba:     lo mismo, y BBM_ERP_TELEFONOS con 1 a 3 teléfonos (el del estudio) para el cobro de prueba de E1.6, y lo de la comisión de precorte.
//   precorte:   lo mismo que desplegado, y el código desplegado ya no dice «sin comisión» (requisito I): se lanza justo ANTES de BBM_BACKEND=erp.
//   corte:      BBM_BACKEND=erp y backend efectivo erp (después del cambio), y lo mismo de la comisión.
//   vuelta:     BBM_BACKEND=dion y backend efectivo dion (después de volver atrás).
// Salida: una línea por comprobación (OK / ROJO / NO MEDIDO) y código 0 solo si no hay ningún ROJO.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const RAIZ = fileURLToPath(new URL("..", import.meta.url));   // el repo del bot, para leer el código del sha desplegado

const PROYECTO = "bcd4b2a6-792f-4074-8f38-06aedb5782c2", SERVICIO = "bbm-bot", ENTORNO = "production";
const URL_BOT = "https://b2k-bot-production-5498.up.railway.app";
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const fase = arg("--fase"), shaEsperado = arg("--sha");
if (!["desplegado", "prueba", "precorte", "corte", "vuelta"].includes(fase)) { console.error("uso: node qa/corte_comprueba.mjs --fase desplegado|prueba|precorte|corte|vuelta [--sha <commit>]"); process.exit(2); }

const filas = [];
const fila = (estado, que, detalle = "") => { filas.push(estado); console.log(`${estado.padEnd(9)} ${que}${detalle ? ` — ${detalle}` : ""}`); };
const railway = (args) => execFileSync("railway", [...args, "--project", PROYECTO, "-e", ENTORNO, "-s", SERVICIO], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });

// 1. despliegue
let shaVivo = "";
try {
  const lista = JSON.parse(railway(["deployment", "list", "--json"]));
  const a = (Array.isArray(lista) ? lista : lista.deployments || []);
  const ok = a.find((d) => d.status === "SUCCESS");
  const vivo = a[0];
  if (vivo && vivo.status !== "SUCCESS") fila("ROJO", "último despliegue", `${vivo.status} (${String(vivo.id).slice(0, 8)}): esperar a que acabe o mirar el registro`);
  const sha = ok?.meta?.commitHash || "";
  if (!ok) fila("ROJO", "despliegue", "ningún SUCCESS");
  else if (shaEsperado && !sha.startsWith(shaEsperado)) fila("ROJO", "commit en producción", `${sha.slice(0, 7)} (rama ${ok.meta?.branch}); se esperaba ${shaEsperado}`);
  else fila("OK", "commit en producción", `${sha.slice(0, 7)} de ${ok.meta?.branch}, ${ok.createdAt}`);
  if (ok && ok.meta?.branch !== "balibest") fila("ROJO", "rama desplegada", `${ok.meta?.branch} (bbm-bot despliega de balibest)`);
  shaVivo = sha;
} catch (e) { fila("ROJO", "despliegue", `no se pudo leer (${String(e.message).split("\n")[0].slice(0, 80)})`); }

// 1b. comisión de la pasarela (requisito I, owner 13-oct: «Se suma como hace Dion»). Mientras el ERP no la sume, el modo erp le dice al modelo
// que NO hay comisión; cuando el ERP la sume, esa frase tiene que haber salido del código desplegado, o el cliente oye «sin comisión» y paga más.
// Solo mira que la frase vieja ya no esté (el campo de la comisión del ERP aún no existe: cuando exista, se comprueba aquí también).
if (fase === "prueba" || fase === "precorte" || fase === "corte") {   // prueba también: sin la comisión habría que repetirla y quemar otro número de factura (Administración, 13-oct)
  const FRASE = "there is NO extra payment fee";
  // Sin sha del despliegue no hay nada que mirar: `git show :bbmflow.js` leería el índice local y podría dar un OK falso.
  if (!/^[0-9a-f]{7,40}$/i.test(shaVivo)) fila("ROJO", "comisión de la pasarela (requisito I)", "sin sha del despliegue: no se ha podido mirar el código que corre");
  else try {
    const fuente = execFileSync("git", ["show", `${shaVivo}:bbmflow.js`], { cwd: RAIZ, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    fila(fuente.includes(FRASE) ? "ROJO" : "OK", "comisión de la pasarela (requisito I)", fuente.includes(FRASE)
      ? `el código desplegado (${shaVivo.slice(0, 7)}) aún dice «${FRASE}»: el ERP tiene que sumar la comisión y la línea cambiar en el mismo paso`
      : "el código desplegado ya no dice que no hay comisión; Backend confirma que cotiza y factura la llevan");
  } catch { fila("ROJO", "comisión de la pasarela (requisito I)", `no se pudo leer bbmflow.js en ${shaVivo.slice(0, 7) || "(sin sha)"}: git fetch origin balibest y repetir`); }
}

// 2. variables: solo se miran las que no son secretas; de las secretas, solo si existen
let v = {};
try {
  for (const l of railway(["variables", "--kv"]).split(/\r?\n/)) { const i = l.indexOf("="); if (i > 0) v[l.slice(0, i)] = l.slice(i + 1); }
} catch (e) { fila("ROJO", "variables", "no se pudieron leer"); }
const leidas = Object.keys(v).length > 0;
const quiere = { desplegado: "dion", prueba: "dion", precorte: "dion", corte: "erp", vuelta: "dion" }[fase];
if (leidas) {
  for (const k of ["BBM_ERP_URL", "BBM_RESERVAS_SECRET", "XENDIT_CALLBACK_TOKEN", "REDIS_URL"]) fila(v[k] ? "OK" : "ROJO", `${k} existe`);
  fila(v.BBM_BACKEND === quiere ? "OK" : "ROJO", "BBM_BACKEND", `${v.BBM_BACKEND ?? "(no está)"}; en esta fase tiene que ser ${quiere}`);
  fila(v.BBM_ERP_CLAVE === "1" ? "OK" : "ROJO", "BBM_ERP_CLAVE=1 (anti-duplicado al reservar)", v.BBM_ERP_CLAVE === "1" ? "" : `vale «${String(v.BBM_ERP_CLAVE ?? "").slice(0, 3)}»: ponerla a 1 antes de cobrar`);
  const tels = String(v.BBM_ERP_TELEFONOS || "").split(",").map((t) => t.trim()).filter(Boolean).length;
  if (fase === "prueba") fila(tels >= 1 && tels <= 3 ? "OK" : "ROJO", "BBM_ERP_TELEFONOS", `${tels} teléfono(s); para la prueba, el del estudio (1 a 3)`);
  else fila(tels === 0 ? "OK" : "ROJO", "BBM_ERP_TELEFONOS", tels === 0 ? "sin teléfonos de prueba" : `${tels} teléfono(s): quitar la variable al acabar la prueba`);
}
v = null;   // nada de lo leído sale de aquí

// 3. el bot contesta
try { const r = await fetch(`${URL_BOT}/`, { signal: AbortSignal.timeout(10000) }); fila(r.status === 200 ? "OK" : "ROJO", "raíz del bot", `HTTP ${r.status}`); }
catch { fila("ROJO", "raíz del bot", "sin respuesta"); }

// 4. health (backend EFECTIVO: una clave bbm:backend en Redis manda sobre la variable)
const clave = process.env.BBM_ADMIN_KEY;
if (!clave) fila("NO MEDIDO", "health", "sin BBM_ADMIN_KEY en el entorno: el backend efectivo no se ha visto (una clave bbm:backend en Redis manda sobre la variable)");
else {
  try {
    const r = await fetch(`${URL_BOT}/admin/api/health`, { headers: { "x-admin-key": clave }, signal: AbortSignal.timeout(15000) });
    const j = r.status === 200 ? await r.json() : null;
    const b = j && j.bbm;
    if (!b) fila("ROJO", "health", `HTTP ${r.status} sin bloque bbm`);
    else {
      fila(b.backend === quiere ? "OK" : "ROJO", "backend efectivo", `${b.backend}${b.backend !== quiere ? " — si la variable dice otra cosa, hay una clave bbm:backend en Redis: parar y pasárselo a Deploy" : ""}`);
      fila(b.erp_configurado ? "OK" : "ROJO", "erp_configurado");
      if ("clave_reserva" in b) fila(b.clave_reserva ? "OK" : "ROJO", "clave_reserva (health)");
      else fila("ROJO", "health sin clave_reserva", "el código desplegado no es el de e110-corte-bot");
      if ("telefonos_prueba_erp" in b) fila((fase === "prueba" ? b.telefonos_prueba_erp >= 1 : b.telefonos_prueba_erp === 0) ? "OK" : "ROJO", "teléfonos de prueba (health)", String(b.telefonos_prueba_erp));
    }
  } catch { fila("ROJO", "health", "sin respuesta"); }
}

const rojos = filas.filter((x) => x === "ROJO").length, sin = filas.filter((x) => x === "NO MEDIDO").length;
console.log(`\n${rojos ? "ROJO" : "VERDE"}: ${rojos} en rojo, ${sin} sin medir (fase ${fase}).`);
process.exit(rojos ? 1 : 0);
