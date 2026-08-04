// Crea las 4 plantillas de BBM en una WABA, de una pasada.
//
// POR QUÉ NO SE PUEDE LANZAR TODAVÍA: las plantillas viven POR WABA y no se transfieren. Hoy el bot
// habla por el número de TEST de Meta (+1 555-146-5300), cuya WABA se tira el día del go-live; la
// WABA buena es la de Dion, que solo existe cuando completa el Coexistence. Crearlas antes es
// trabajo que hay que rehacer. Por eso los textos quedan aquí escritos y aprobados, listos para un
// solo comando el día que exista la WABA de verdad.
//
// Uso (el token NUNCA por argv — se filtra al primer stack trace):
//   WABA_ID=... WHATSAPP_TOKEN=... node crear-plantillas-bbm.js
//   WABA_ID=... WHATSAPP_TOKEN=... node crear-plantillas-bbm.js --dry-run
//
// Después, en Railway (los nombres tienen que casar con lo que lee index.js):
//   FOLLOWUP_TEMPLATE_NAME=bbm_followup_cold_lead   FOLLOWUP_TEMPLATE_LANG=en  FOLLOWUP_TEMPLATE_VARS=1
//   INTRO_TEMPLATE_NAME=bbm_intro                   INTRO_TEMPLATE_LANG=en     INTRO_TEMPLATE_VARS=1
//   ALERT_TEMPLATE_NAME=bbm_owner_alert             ALERT_TEMPLATE_LANG=en     ALERT_TEMPLATE_VARS=2
//   REMINDER_TEMPLATE_NAME=bbm_appointment_reminder REMINDER_TEMPLATE_LANG=en

import axios from "axios";

const GRAPH = "v21.0";
const WABA_ID = process.env.WABA_ID;
const TOKEN = process.env.WHATSAPP_TOKEN;
const DRY = process.argv.includes("--dry-run");

// Idioma: EN. Los clientes de BBM son turistas y nómadas digitales, y el contexto del bot ya
// trabaja en inglés. Meta trata cada idioma como una plantilla aparte: añadir ES es duplicarlas.
const LANG = "en";

const TEMPLATES = [
  {
    // Lo dispara followupTick() a las 24h y 72h de enfriarse un lead. {{1}} = nombre de pila, con
    // "there" de reserva cuando no lo sabemos, así que el texto tiene que funcionar con ambos.
    name: "bbm_followup_cold_lead",
    category: "MARKETING",
    components: [
      { type: "BODY",
        text: "Hi {{1}}, still thinking about the bike? Your quote is still good and we can deliver it to where you are staying. Reply here and we will sort it out.",
        example: { body_text: [["Marco"]] } },
      { type: "FOOTER", text: "Bali Best Motorcycle · Reply STOP to opt out" },
    ],
  },
  {
    // Primer contacto por iniciativa nuestra (fuera de ventana, así que plantilla obligatoria).
    name: "bbm_intro",
    category: "MARKETING",
    components: [
      { type: "BODY",
        text: "Hi {{1}}, thanks for getting in touch with Bali Best Motorcycle. Tell us your dates and the bike you have in mind and we will send you a price.",
        example: { body_text: [["Marco"]] } },
      { type: "FOOTER", text: "Bali Best Motorcycle · Reply STOP to opt out" },
    ],
  },
  {
    // Va al OWNER_PHONE (Dion), no al cliente. UTILITY: es una notificación operativa de su propio
    // negocio. 2 variables, que es el default de ALERT_TEMPLATE_VARS en index.js.
    name: "bbm_owner_alert",
    category: "UTILITY",
    components: [
      { type: "BODY",
        text: "New lead: {{1}}. Their message: {{2}}. Open the panel to take over.",
        example: { body_text: [["Marco Rossi", "Do you have an NMAX for a month?"]] } },
    ],
  },
  {
    // Recordatorio de cita. 1 variable: el titulo que arma el motor (a.title).
    name: "bbm_appointment_reminder",
    category: "UTILITY",
    components: [
      { type: "BODY",
        text: "Reminder: {{1}}. See you soon.",
        example: { body_text: [["bike delivery tomorrow at 10:00, Canggu"]] } },
      { type: "FOOTER", text: "Bali Best Motorcycle" },
    ],
  },
];

function check() {
  const missing = [];
  if (!WABA_ID) missing.push("WABA_ID");
  if (!TOKEN && !DRY) missing.push("WHATSAPP_TOKEN");
  if (missing.length) {
    console.error(`Faltan variables de entorno: ${missing.join(", ")}`);
    console.error("El WABA_ID es el de la WABA de Dion, la que queda tras el Coexistence — NO la del número de test.");
    process.exit(1);
  }
}

async function crear(t) {
  const url = `https://graph.facebook.com/${GRAPH}/${WABA_ID}/message_templates`;
  const body = { name: t.name, category: t.category, language: LANG, components: t.components };
  if (DRY) return { name: t.name, dry: true, body };
  try {
    const { data } = await axios.post(url, body, { headers: { Authorization: `Bearer ${TOKEN}` } });
    return { name: t.name, id: data?.id, status: data?.status || "PENDING" };
  } catch (e) {
    // Que una falle no puede dejar las otras sin crear: Meta rechaza de una en una (nombre
    // duplicado, texto que no le gusta) y lo normal es corregir esa y relanzar.
    return { name: t.name, error: e.response?.data?.error?.error_user_msg || e.response?.data?.error?.message || e.message };
  }
}

async function main() {
  check();
  if (DRY) console.log("— DRY RUN: no se envía nada a Meta —\n");
  const out = [];
  for (const t of TEMPLATES) out.push(await crear(t));

  for (const r of out) {
    if (r.dry) console.log(`· ${r.name}\n${JSON.stringify(r.body, null, 2)}\n`);
    else if (r.error) console.error(`✗ ${r.name}: ${r.error}`);
    else console.log(`✓ ${r.name} → ${r.status} (id ${r.id})`);
  }
  const fallidas = out.filter((r) => r.error);
  if (!DRY) {
    console.log(`\n${out.length - fallidas.length}/${out.length} creadas. Meta las revisa por su cuenta;`
      + " las de MARKETING tardan más que las de UTILITY.");
    console.log("Pega los nombres en Railway (cabecera de este fichero) o el bot seguirá sin poder salir de la ventana de 24h.");
  }
  process.exit(fallidas.length ? 1 : 0);
}

main();
