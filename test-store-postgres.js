// S4b: el cliente de la edge `bot-api` (store/postgres.js). Sin red: la edge es una función falsa que anota cada petición.
import test from "node:test";
import assert from "node:assert";
import { creaPg, ErrorEdge, cabeceraRegion } from "./store/postgres.js";

const SEC = { estado: "se-estado", recordatorio: "se-recordatorio", humano: "se-humano" };
const T = "6281234567890";

function edge(respuestas, opciones = {}) {
  const peticiones = [];
  const post = async (url, cuerpo, op) => {
    peticiones.push({ url, cuerpo: JSON.parse(JSON.stringify(cuerpo)), headers: op.headers, timeout: op.timeout });
    const r = respuestas.length > 1 ? respuestas.shift() : respuestas[0];
    if (r instanceof Error || (r && r.lanza)) throw r.lanza || r;
    return typeof r === "function" ? r(cuerpo) : r;
  };
  const alarmas = [], recuperados = [], logs = [];
  const pg = creaPg({
    url: "https://x.supabase.co/functions/v1/bot-api/", secretos: SEC, post, pausaReintentoMs: 1,
    onAlarma: (i) => alarmas.push(i), onRecuperado: () => recuperados.push(1), log: (m) => logs.push(m), ...opciones,
  });
  return { pg, peticiones, alarmas, recuperados, logs };
}
const ok = (o) => ({ status: 200, data: { ok: true, ...o } });
const nada = () => new Promise((r) => setImmediate(r));

test("recibir: va a /estado con el secreto de esa ruta, quita ok/accion y reenvía el mensaje", async () => {
  const e = edge([ok({ accion: "mensaje_recibir", duplicado: false, procesado: false, reproceso: false, tope: false })]);
  const r = await e.pg.recibir({ tel: T, wamid: "wamid.A1", nombre: "Ana", mensaje: { rol: "user", texto: "hola", ts: 1 } });
  assert.deepStrictEqual(r, { duplicado: false, procesado: false, reproceso: false, tope: false });
  assert.strictEqual(e.peticiones.length, 1);
  assert.strictEqual(e.peticiones[0].url, "https://x.supabase.co/functions/v1/bot-api/estado");
  assert.strictEqual(e.peticiones[0].headers["X-Bot-Secret"], "se-estado");
  assert.deepStrictEqual(e.peticiones[0].cuerpo, { accion: "mensaje_recibir", tel: T, wamid: "wamid.A1", nombre_perfil: "Ana", mensaje: { rol: "user", texto: "hola", ts: 1 } });
  assert.strictEqual(e.pg.llamadas, 1);
});

test("cada acción usa el secreto de SU ruta: estado y recordatorio no se mezclan", async () => {
  const e = edge([ok({ citas: [] })]);
  await e.pg.citasRecordar();
  await e.pg.citaRecordatorioRes({ accionId: "11111111-1111-1111-1111-111111111111", resultado: "enviado" });
  await e.pg.baja({ tel: T, wamid: "w" });
  assert.deepStrictEqual(e.peticiones.map((p) => [p.url.split("/").pop(), p.headers["X-Bot-Secret"]]),
    [["recordatorio", "se-recordatorio"], ["recordatorio", "se-recordatorio"], ["estado", "se-estado"]]);
});

test("el cliente de la edge NO sabe llamar a /humano (su secreto es del proxy) y sus rutas nunca llevan Authorization", async () => {
  const e = edge([ok({ pausado: true, hasta: null })]);
  assert.strictEqual(typeof e.pg.humanoPausar, "undefined");
  assert.strictEqual(typeof e.pg.humanoEnviar, "undefined");
  // las rutas del bot nunca llevan Authorization
  const e2 = edge([ok({ baja: "nueva", pausado: true })]);
  await e2.pg.baja({ tel: T, wamid: "w" });
  assert.ok(!("authorization" in e2.peticiones[0].headers));
});

test("un error de negocio (ok:false) se devuelve como {error} y NO cuenta como caída", async () => {
  const e = edge([{ status: 200, data: { ok: false, accion: "turno_estado", error: "sin_chat" } }], { umbral: 2 });
  for (let i = 0; i < 5; i++) assert.deepStrictEqual(await e.pg.estado({ tel: T }), { error: "sin_chat" });
  assert.strictEqual(e.pg.fallosSeguidos, 0);
  assert.strictEqual(e.alarmas.length, 0);
});

test("5xx: un reintento con el MISMO cuerpo; si el segundo sale bien, devuelve el resultado", async () => {
  const e = edge([{ status: 502, data: { error: "db_error" } }, ok({ avisar: null, resumir: null, repetido: false })]);
  const r = await e.pg.cerrar({ tel: T, wamid: "w1", salida: [{ texto: "hola" }], intent: "exploring" });
  assert.deepStrictEqual(r, { avisar: null, resumir: null, repetido: false });
  assert.strictEqual(e.peticiones.length, 2);
  assert.deepStrictEqual(e.peticiones[0].cuerpo, e.peticiones[1].cuerpo);
  assert.strictEqual(e.pg.fallosSeguidos, 0);
});

test("timeout y caída de red: timeout de 10 s por llamada, un reintento y luego lanza ErrorEdge", async () => {
  const e = edge([{ lanza: Object.assign(new Error("timeout of 10000ms exceeded"), { code: "ECONNABORTED" }) }]);
  await assert.rejects(() => e.pg.estado({ tel: T }), (x) => x instanceof ErrorEdge && x.tipo === "timeout");
  assert.strictEqual(e.peticiones.length, 2);
  assert.ok(e.peticiones.every((p) => p.timeout === 10_000));
  const e2 = edge([{ lanza: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) }]);
  await assert.rejects(() => e2.pg.estado({ tel: T }), (x) => x.tipo === "red");
  assert.strictEqual(e2.peticiones.length, 2);
});

test("un 4xx no se reintenta (una sola petición) y cuenta como fallo", async () => {
  const e = edge([{ status: 401, data: { error: "no_autorizado" } }]);
  await assert.rejects(() => e.pg.estado({ tel: T }), (x) => x.tipo === "http" && x.status === 401);
  assert.strictEqual(e.peticiones.length, 1);
  assert.strictEqual(e.pg.fallosSeguidos, 1);
});

test("429 en mensaje_recibir = tope (descartar con 200), sin reintento ni alarma; en otra acción lanza 'ritmo'", async () => {
  const e = edge([{ status: 429, data: { error: "demasiadas_peticiones" } }], { umbral: 1 });
  const r = await e.pg.recibir({ tel: T, wamid: "w", mensaje: { texto: "x" } });
  assert.strictEqual(r.tope, true);
  assert.strictEqual(r.duplicado, true);
  assert.strictEqual(e.peticiones.length, 1);
  await assert.rejects(() => e.pg.estado({ tel: T }), (x) => x.tipo === "ritmo");
  assert.strictEqual(e.alarmas.length, 0);
  assert.strictEqual(e.pg.fallosSeguidos, 0);
});

test("200 sin la forma esperada (sin ok, no JSON) = fallo 'forma', sin reintento", async () => {
  const e = edge([{ status: 200, data: "<html>" }]);
  await assert.rejects(() => e.pg.estado({ tel: T }), (x) => x.tipo === "forma");
  assert.strictEqual(e.peticiones.length, 1);
  const e2 = edge([{ status: 200, data: { sinok: true } }]);
  await assert.rejects(() => e2.pg.estado({ tel: T }), (x) => x.tipo === "forma");
});

test("alarma: tras N fallos SEGUIDOS, una sola vez por caída; el primer éxito la rearma y avisa de la recuperación", async () => {
  const e = edge([{ status: 503, data: {} }], { umbral: 3 });
  for (let i = 0; i < 2; i++) await assert.rejects(() => e.pg.estado({ tel: T }));
  await nada();
  assert.strictEqual(e.alarmas.length, 0, "con 2 fallos todavía no");
  await assert.rejects(() => e.pg.estado({ tel: T }));
  await nada();
  assert.strictEqual(e.alarmas.length, 1);
  assert.strictEqual(e.alarmas[0].fallos, 3);
  for (let i = 0; i < 4; i++) await assert.rejects(() => e.pg.estado({ tel: T }));
  await nada();
  assert.strictEqual(e.alarmas.length, 1, "una sola alarma por caída");
  // vuelve la edge
  const e2 = edge([ok({ baja: false, pausado: false, esperando: false, avisar_testing: false, primer_turno: true, historial: [], config: null })], { umbral: 3 });
  e2.pg.llamadas; // (otra instancia: la recuperación se prueba abajo con la misma)
  let fase = 0;
  const e3 = edge([function () { return fase === 0 ? { status: 503, data: {} } : ok({ historial: [], config: null }); }], { umbral: 2 });
  await assert.rejects(() => e3.pg.estado({ tel: T }));
  await assert.rejects(() => e3.pg.estado({ tel: T }));
  await nada();
  assert.strictEqual(e3.alarmas.length, 1);
  fase = 1;
  await e3.pg.estado({ tel: T });
  await nada();
  assert.strictEqual(e3.recuperados.length, 1);
  assert.strictEqual(e3.pg.fallosSeguidos, 0);
  fase = 0;
  await assert.rejects(() => e3.pg.estado({ tel: T }));
  await assert.rejects(() => e3.pg.estado({ tel: T }));
  await nada();
  assert.strictEqual(e3.alarmas.length, 2, "se rearmó: una caída nueva vuelve a avisar");
});

test("el umbral de alarma sale de la configuración (fallos_alarma) de la última lectura del estado", async () => {
  const e = edge([ok({ baja: false, config: { fallos_alarma: 5 }, historial: [] })]);
  assert.strictEqual(e.pg.umbral, 3);
  await e.pg.estado({ tel: T });
  assert.strictEqual(e.pg.umbral, 5);
});

test("recibir con reintento: si el 2º intento ve SU PROPIO reclamo (duplicado sin procesar) se sigue adelante (propio)", async () => {
  const e = edge([{ status: 502, data: {} }, ok({ duplicado: true, procesado: false })]);
  const r = await e.pg.recibir({ tel: T, wamid: "w", mensaje: { texto: "x" } });
  assert.strictEqual(r.duplicado, false);
  assert.strictEqual(r.propio, true);
  // sin reintento previo, un duplicado sin procesar es de OTRO handler y se descarta
  const e2 = edge([ok({ duplicado: true, procesado: false })]);
  const r2 = await e2.pg.recibir({ tel: T, wamid: "w", mensaje: { texto: "x" } });
  assert.strictEqual(r2.duplicado, true);
  assert.ok(!r2.propio);
  // un reproceso legítimo no se confunde con el propio
  const e3 = edge([{ status: 502, data: {} }, ok({ duplicado: false, procesado: false, reproceso: true })]);
  assert.strictEqual((await e3.pg.recibir({ tel: T, wamid: "w", mensaje: { texto: "x" } })).reproceso, true);
});

test("sin URL o sin secreto no sale ninguna petición: fallo cerrado, contado y ruidoso", async () => {
  const peticiones = [];
  const pg = creaPg({ url: "https://x/y", secretos: { estado: "" }, post: async (...a) => { peticiones.push(a); return ok({}); } });
  await assert.rejects(() => pg.estado({ tel: T }), (x) => x.tipo === "sin_configurar");
  const pg2 = creaPg({ url: "", secretos: SEC, post: async (...a) => { peticiones.push(a); return ok({}); } });
  await assert.rejects(() => pg2.estado({ tel: T }));
  assert.strictEqual(peticiones.length, 0);
});

test("el log no lleva cuerpos ni teléfonos completos", async () => {
  const e = edge([{ status: 500, data: { detalle: "secreto" } }]);
  await assert.rejects(() => e.pg.recibir({ tel: T, wamid: "w", mensaje: { texto: "mi pasaporte es 123" } }));
  const todo = e.logs.join("\n");
  assert.ok(!todo.includes(T) && !todo.includes("pasaporte") && !todo.includes("secreto"));
});

// ═════════ verificar: la sesión de la PERSONA va solo en Authorization; sus fallos no cuentan como «la base no responde» ═════════
test("verificar: va a /estado con el secreto de estado Y la sesión en Authorization; el cuerpo solo lleva el permiso (ni teléfono ni usuario)", async () => {
  const e = edge([ok({ accion: "verificar", permitido: true, email: "ana@lawang.com" })]);
  const r = await e.pg.verificar({ jwt: "jwt-secreto-1" });
  assert.deepStrictEqual(r, { permitido: true, email: "ana@lawang.com" });
  assert.strictEqual(e.peticiones[0].url, "https://x.supabase.co/functions/v1/bot-api/estado");
  assert.strictEqual(e.peticiones[0].headers["X-Bot-Secret"], "se-estado");
  assert.strictEqual(e.peticiones[0].headers.authorization, "Bearer jwt-secreto-1");
  assert.deepStrictEqual(e.peticiones[0].cuerpo, { accion: "verificar", permiso: "bot_escribir" });
  assert.ok(!JSON.stringify(e.peticiones[0].cuerpo).includes("jwt-secreto-1"), "el token no va en el cuerpo");
  // las demás acciones NO llevan Authorization
  const o = edge([ok({ baja: "nueva", pausado: true })]);
  await o.pg.baja({ tel: T, wamid: "wamid.B1" });
  assert.ok(!("authorization" in o.peticiones[0].headers));
});

test("verificar: un 401 (token que no vale), un 503 (Auth caída) y la red caída lanzan ErrorEdge y NUNCA disparan la alarma de la base", async () => {
  const casos = [[{ status: 401, data: { error: "no_autorizado" } }, "http", 401], [{ status: 503, data: { error: "auth_conexion" } }, "http", 503], [new Error("ECONNRESET"), "red", null]];
  for (const [resp, tipo, status] of casos) {
    const e = edge([resp], { umbral: 2 });
    for (let i = 0; i < 5; i++) {
      await assert.rejects(() => e.pg.verificar({ jwt: "jwt-x" }), (x) => x instanceof ErrorEdge && x.tipo === tipo && x.status === status);
    }
    await nada();
    assert.strictEqual(e.pg.fallosSeguidos, 0, "verificar no suma fallos seguidos");
    assert.strictEqual(e.alarmas.length, 0, "ninguna alarma por verificar");
    assert.ok(!e.logs.some((l) => l.includes("jwt-x")), "el token no sale en ningún log");
  }
  // un solo intento (una persona espera) y un éxito de verificar NO apaga la alarma de una caída real
  const un = edge([{ status: 503, data: { error: "auth_conexion" } }]);
  await assert.rejects(() => un.pg.verificar({ jwt: "j" }), ErrorEdge);
  assert.strictEqual(un.peticiones.length, 1, "verificar no reintenta");
  const real = edge([{ status: 502, data: {} }, { status: 502, data: {} }, { status: 502, data: {} }, { status: 502, data: {} }, ok({ accion: "verificar", permitido: true, email: "a@b.c" })], { umbral: 2 });
  await assert.rejects(() => real.pg.baja({ tel: T, wamid: "wamid.C1" }), ErrorEdge);
  await assert.rejects(() => real.pg.baja({ tel: T, wamid: "wamid.C2" }), ErrorEdge);
  await nada();
  assert.strictEqual(real.alarmas.length, 1, "la caída real alarma");
  assert.strictEqual((await real.pg.verificar({ jwt: "j" })).permitido, true);
  assert.ok(real.pg.fallosSeguidos >= 2, "un verificar bueno no pone a cero los fallos de la base: " + real.pg.fallosSeguidos);
  assert.strictEqual(real.recuperados.length, 0, "ni dispara un falso «ya responde»");
  // 429 (ritmo propio de verificar) también lanza y no es caída
  const r = edge([{ status: 429, data: { error: "demasiadas_peticiones" } }]);
  await assert.rejects(() => r.pg.verificar({ jwt: "j" }), (x) => x instanceof ErrorEdge && x.tipo === "ritmo");
  // permitido:false se devuelve tal cual, sin email
  const n = edge([ok({ accion: "verificar", permitido: false, email: null })]);
  assert.deepStrictEqual(await n.pg.verificar({ jwt: "j" }), { permitido: false, email: null });
  // un error de negocio de la edge no es un permiso
  const x = edge([{ status: 200, data: { ok: false, accion: "verificar", error: "permiso_invalido" } }]);
  assert.deepStrictEqual(await x.pg.verificar({ jwt: "j" }), { error: "permiso_invalido" });
});

test("LAW-507: region fija la cabecera x-region; vacia o rara = sin cabecera", async () => {
  const con = edge([ok({ citas: [] })], { region: "ap-southeast-1" });
  await con.pg.citasRecordar();
  assert.strictEqual(con.peticiones[0].headers["x-region"], "ap-southeast-1");
  const sin = edge([ok({ citas: [] })]);
  await sin.pg.citasRecordar();
  assert.ok(!("x-region" in sin.peticiones[0].headers));
  assert.deepStrictEqual(cabeceraRegion("  AP-Southeast-1 "), { "x-region": "ap-southeast-1" });
  for (const raro of ["", undefined, "x\r\nfoo: bar", "singapur", "ap-southeast-1; drop"]) assert.deepStrictEqual(cabeceraRegion(raro), {});
});
