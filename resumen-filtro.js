// FILTRO DE DATOS SENSIBLES DEL RESUMEN (S11 · LAW-509.4 · apartado e.2 de contexto/legal/bot_lawang_aviso_retencion_precio.md).
//
// El resumen de la conversación es un dato personal derivado del chat, se guarda append-only en la ficha y NO debe llevar datos sensibles.
// El modelo recibe la orden de no incluirlos, pero esto no depende de que obedezca: lista CERRADA y determinista, aplicada al texto que
// devuelve el modelo ANTES de insertarlo. Si salta, el resumen no se guarda (el llamador pone TEXTO_RESUMEN_OMITIDO, que además avanza el
// cursor para no volver a pedir y pagar el mismo resumen) y solo se registra el CONTEO por categoría, nunca el fragmento.
//
// Falso positivo = se pierde un resumen (el lado seguro). Falso negativo = dato sensible en una ficha que no se puede corregir: por eso la
// lista es amplia. Idiomas: en, es, id. Se compara sin tildes y en minúsculas, con límites de palabra Unicode.
// «Niños/hijos» en general NO están (una familia con «two kids» es contexto comercial normal): solo menor/minor/underage; el resto lo cubre
// la orden al modelo. Decisión de Bots, dicha en el informe de S11 para que Legal la confirme.

export const TEXTO_RESUMEN_OMITIDO = "Summary omitted: sensitive data detected in the conversation. Open the chat to review it.";

const SENSIBLES = {
  salud: [
    "health", "illness", "ill", "sick", "disease", "diagnos\\w*", "cancer", "tumou?r", "pregnan\\w*", "disabilit\\w*", "disabled", "wheelchair",
    "diabet\\w*", "hiv", "aids", "covid", "surgery", "chemo\\w*", "dialysis", "medication",
    "medical (?:condition|history|record|records|issue|issues|problem|problems|treatment|leave)", "mental (?:health|illness)", "depress\\w*",
    "anxiety", "hospitali[sz]ed", "terminal",
    "salud", "enferm\\w*", "diagnostic\\w*", "embaraz\\w*", "discapacidad", "discapacitad\\w*", "cirugia", "quimioterapia", "medicacion",
    "hospitalizad\\w*", "depresion", "ansiedad",
    "kesehatan", "sakit", "penyakit", "hamil", "kanker", "disabilitas", "cacat", "operasi", "depresi", "dirawat",
  ],
  religion: [
    "religio\\w*", "muslim\\w*", "islam\\w*", "christian\\w*", "catholic\\w*", "protestant\\w*", "hindu\\w*", "buddhis\\w*", "jewish", "judaism",
    "atheis\\w*", "sikh\\w*", "mormon\\w*", "church", "mosque", "synagogue", "halal",
    "musulman\\w*", "cristian\\w*", "catolic\\w*", "judio\\w*", "budis\\w*", "ateo", "iglesia", "mezquita", "sinagoga",
    "agama", "kristen", "katolik", "gereja", "masjid", "budha", "buddha", "yahudi", "ateis",
  ],
  orientacion: [
    "gay", "lesbian\\w*", "bisexual\\w*", "homosexual\\w*", "transgender", "transsexual", "lgbt\\w*", "queer", "sexual orientation",
    "gender identity", "same[- ]sex",
    "orientacion sexual", "identidad de genero", "lesbiana\\w*", "transexual\\w*", "mismo sexo",
    "orientasi seksual", "homoseksual\\w*", "lesbi\\w*", "waria",
  ],
  origen_migratorio: [
    "ethnic\\w*", "racial\\w*", "race", "caste", "immigration status", "migrant status", "undocumented", "illegal(?:ly)? (?:resident|immigrant|alien|stay)",
    "overstay\\w*", "deport\\w*", "asylum", "refugee\\w*", "visa (?:overstay|refus\\w*|reject\\w*|ban)", "kitas", "kitap", "stay permit",
    "etnia", "etnico\\w*", "raza", "casta", "estatus migratorio", "situacion migratoria", "indocumentad\\w*", "deportad\\w*", "asilo", "refugiad\\w*",
    "suku", "etnis", "ras", "pengungsi", "deportasi",
  ],
  politica_judicial: [
    "political (?:party|affiliation|opinion|views?)", "trade union", "union member\\w*", "criminal (?:record|history|case|charge\\w*)", "convict\\w*",
    "arrested", "arrest", "prison", "jail", "lawsuit against", "court case", "bankrupt\\w*", "in debt", "debts?",
    "partido politico", "afiliacion politica", "sindicato", "antecedentes penales", "condenad\\w*", "detenid\\w*", "carcel", "prision", "quiebra", "deuda\\w*",
    "partai politik", "serikat pekerja", "catatan kriminal", "penjara", "ditangkap", "bangkrut", "utang",
  ],
  menores: [
    "minors?", "underage", "under[- ]age", "under 18", "under eighteen", "juvenile",
    "menor(?:es)? de edad", "menores? de 18",
    "di bawah umur", "anak di bawah",
  ],
  identidad_financiero: [
    "passports?", "pasaporte\\w*", "paspor", "nik", "ktp", "npwp", "ssn", "social security", "national id", "id card", "identity card",
    "driver'?s licen[cs]e", "tax id", "tax number",
    "dni", "nie", "cedula", "documento de identidad", "carnet de identidad", "licencia de conducir", "numero fiscal",
    "kartu identitas", "nomor identitas",
    "iban", "swift code", "bic code", "cvv", "cvc", "credit card", "debit card", "card number", "bank account", "account number", "routing number", "sort code",
    "bank details", "pin code", "password", "passcode", "seed phrase", "private key",
    "tarjeta de credito", "tarjeta de debito", "numero de tarjeta", "cuenta bancaria", "numero de cuenta", "contrasena", "clave privada",
    "kartu kredit", "kartu debit", "nomor kartu", "rekening", "nomor rekening", "kata sandi",
  ],
};

const norm = (t) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const RE_PALABRAS = Object.fromEntries(Object.entries(SENSIBLES).map(([cat, lista]) => [
  cat, new RegExp(`(?<![\\p{L}\\p{N}])(?:${lista.map(norm).join("|")})(?![\\p{L}\\p{N}])`, "gu"),
]));

// Formas, no palabras: 16 a 19 dígitos seguidos o con un espacio/guion (NIK de 16, tarjetas; un teléfono E.164 llega a 15 y ese lo quita limpiaResumen), tarjeta Amex 4-6-5, IBAN y nº de pasaporte (1-2 letras + 6-9 dígitos).
const RE_FORMAS = [
  /(?<![\d+])(?:\d[ -]?){15,18}\d(?!\d)/g,
  /(?<!\d)\d{4}[ -]\d{6}[ -]\d{5}(?!\d)/g,
  /\b[a-z]{2}\d{2}[a-z0-9]{10,30}\b/gi,
  /\b(?!rp\d)[a-z]{1,2}\d{6,9}\b/gi,
];

/** ¿Tiene el texto algo de la lista cerrada? Devuelve {sensible, cuentas}: el CONTEO por categoría, nunca el fragmento. */
export function filtraSensibles(texto) {
  const cuentas = {};
  const t = norm(texto);
  for (const [cat, re] of Object.entries(RE_PALABRAS)) { const m = t.match(re); if (m) cuentas[cat] = (cuentas[cat] || 0) + m.length; }
  let formas = 0;
  for (const re of RE_FORMAS) { const m = String(texto || "").match(re); if (m) formas += m.length; }
  if (formas) cuentas.identidad_financiero = (cuentas.identidad_financiero || 0) + formas;
  return { sensible: Object.keys(cuentas).length > 0, cuentas };
}
