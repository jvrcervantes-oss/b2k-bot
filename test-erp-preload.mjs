// Preload SOLO de pruebas (node --import ./test-erp-preload.mjs index.js): corta la red del motor.
// Toda llamada de axios (Meta Graph, Brevo, OpenAI…) se anota en stdout como `__NET__{json}` y se contesta con un OK de mentira;
// cualquier otro destino revienta. Así las pruebas ejercitan el motor REAL sin mandar ni un mensaje a un tercero.
import axios from "axios";

let n = 0;
const emit = (o) => process.stdout.write("\n__NET__" + JSON.stringify(o) + "\n");
axios.defaults.adapter = async (config) => {
  const url = String(config.url);
  let body = config.data;
  try { body = JSON.parse(body); } catch { /* no era JSON */ }
  emit({ method: config.method, url, body });
  let data;
  if (/graph\.facebook\.com/.test(url)) data = { messages: [{ id: "wamid.TEST" + ++n }] };
  else if (/api\.brevo\.com/.test(url)) data = { messageId: "x" };
  else throw new Error("RED BLOQUEADA EN PRUEBA: " + url);
  return { data, status: 200, statusText: "OK", headers: {}, config, request: {} };
};

// Solo si TEST_FAST_TICKS=1: los temporizadores del motor (cada 5-30 min) corren cada 1,5 s y el reloj (Date.now) puede
// adelantarse escribiendo milisegundos en el fichero TEST_CLOCK_FILE. Permite ejercitar followupTick con un lead «frío de 48 h»
// sin esperar. El comportamiento del motor no cambia: solo el tiempo que ve.
import fs from "node:fs";
if (process.env.TEST_FAST_TICKS === "1") {
  const realNow = Date.now.bind(Date);
  const file = process.env.TEST_CLOCK_FILE;
  Date.now = () => { let off = 0; try { off = Number(fs.readFileSync(file, "utf8")) || 0; } catch { /* sin desfase */ } return realNow() + off; };
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (f, ms, ...a) => realSetInterval(f, ms >= 60000 ? 1500 : ms, ...a);
}
