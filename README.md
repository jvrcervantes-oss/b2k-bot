# Motor de Bot de WhatsApp — AxisWorks

Motor único y reutilizable para bots de WhatsApp de todos los proyectos.
Un solo código, configuración por proyecto mediante variables de entorno.

## Qué hace

1. Recibe mensajes de WhatsApp vía webhook (WhatsApp Business API oficial)
2. Responde usando Claude con el contexto del negocio
3. Guarda cada lead automáticamente en el CRM (Google Sheets)
4. Avisa al dueño cuando un lead muestra intención de reservar

## Arquitectura escalable

```
infraestructura/bot-whatsapp/   ← ESTE motor (código único)
proyectos/B2K/bot-config/        ← config de B2K (contexto + credenciales)
proyectos/SumbaRental/bot-config/ ← config de Sumba (contexto + credenciales)
```

El mismo `index.js` sirve para todos los proyectos. Lo único que cambia
por proyecto son las variables de entorno. En Railway cada proyecto es
un servicio separado que apunta a este mismo repo con su propia config.

## Stack

- **WhatsApp Business API** (Meta) — canal de mensajería oficial
- **Claude API** (Anthropic) — cerebro que genera las respuestas
- **Google Sheets API** — CRM de leads
- **Express** (Node.js) — servidor del webhook
- **Railway** — hosting del servidor 24/7

## Variables de entorno necesarias

| Variable | Descripción | Ejemplo |
|----------|-------------|---------|
| `PROJECT_NAME` | Nombre del proyecto (para logs y CRM) | `B2K` |
| `WHATSAPP_TOKEN` | Access token permanente de Meta (System User) | `EAAxxx...` |
| `WHATSAPP_PHONE_ID` | ID del número de teléfono en WhatsApp Manager | `992420763958806` |
| `WHATSAPP_VERIFY_TOKEN` | Texto secreto que inventas para verificar el webhook | `b2k_secreto_2026` |
| `ANTHROPIC_API_KEY` | API key de console.anthropic.com | `sk-ant-...` |
| `GOOGLE_SERVICE_ACCOUNT` | JSON completo de la Service Account (string). El bot usa Service Account, NO OAuth de usuario | `{"type":"service_account","client_email":"...","private_key":"..."}` |
| `SHEET_ID` | ID del Google Sheet del CRM | `1D4ub_...` |
| `OWNER_PHONE` | Tu número para recibir avisos de reserva | `34601170044` |
| `BOT_CONTEXT` | El contexto del negocio (system prompt completo) — solo se usa si `CONTEXT_FILE` no existe en el repo | ver bot-config del proyecto |
| `CONTEXT_FILE` | (Opcional) nombre del archivo de contexto a cargar del repo | `context-balibest.md` (default: `context.md`) |
| `BOT_MODEL` | (Opcional) modelo de Claude | `claude-sonnet-4-6` |
| `BOT_VERTICAL` | (Opcional) `tour` (default) o `rental` — selecciona el bloque de cierre en `BASE_INSTRUCTIONS`, los campos que extrae `enrichLeadFromConversation` y el mapeo de `LEAD_KEYMAP` (tour = agendar videollamada + tour/package/riders/pillions; rental = cerrar directo en el chat + model/plan/startDate/deliveryLocation/insuranceTier/paymentMethod) | `rental` |
| `PANEL_FILE` | (Opcional) nombre del archivo del panel `/admin` a cargar del repo — cada vertical tiene columnas y campos de ficha distintos | `panel-rental.html` (default: `panel.html`) |

> ⚠️ **El Sheet del CRM debe estar COMPARTIDO con el `client_email` de la Service Account (permiso Editor).** Si no, la API responde `404 — Requested entity was not found` aunque la autenticación sea correcta. Las variables `GOOGLE_CREDENTIALS` / `GOOGLE_TOKEN` de versiones antiguas ya **no se usan** — se pueden borrar.

### Newsletter por email (opcional)

Activa el envío de newsletters desde el panel (`/admin` → icono del sobre). Sin `BREVO_API_KEY` + `MAIL_FROM`, el botón de enviar avisa de que falta configurarlo.

| Variable | Descripción | Ejemplo |
|----------|-------------|---------|
| `BREVO_API_KEY` | API key de [brevo.com](https://brevo.com) (SMTP & API → API Keys) | `xkeysib-...` |
| `MAIL_FROM` | Remitente. El dominio DEBE estar verificado en Brevo (SPF/DKIM en el DNS) | `Bali Moto Adventures <newsletter@balimotoadventures.com>` |
| `MAIL_REPLY_TO` | (Opcional) a dónde llegan las respuestas | `info@balimotoadventures.com` |
| `MAIL_COMPANY` | Pie legal del email: nombre + dirección física (obligatorio anti-spam) | `Bali Moto Adventures · Jl. ... , Bali, Indonesia` |
| `MAIL_LOGO` | (Opcional) URL del logo para la cabecera del email; si no, se usa el nombre en texto | `https://balimotoadventures.com/logo.png` |
| `MAIL_UNSUB_SECRET` | (Opcional) firma los links de baja; si falta se usa `ADMIN_PASSWORD` | cualquier texto largo |

**Formato del mensaje (markdown ligero):** `**negrita**`, `*cursiva*`, `## Título`, `### Subtítulo`, `- lista`, `---` (separador), `[texto](enlace)`, `[[Botón|enlace]]` (CTA), `![alt](url)` (imagen). El botón "Enviar prueba" del panel muestra cómo queda.

**Usar plantillas de Brevo:** en el panel puedes elegir "Usar una plantilla de Brevo" en vez de escribir el email. El desplegable muestra tus plantillas **transaccionales activas** (Brevo → *Transactional → Templates*; las de campaña de marketing NO aparecen ahí). Personaliza con `{{params.name}}` y añade `{{params.unsub}}` en el pie para el enlace de baja (el bot lo pasa por cada destinatario).

**Programar envíos:** el campo "Programar para" convierte el envío en programado; un tick del servidor (cada minuto) lo dispara a su hora. Los destinatarios se recalculan al disparar (respeta bajas y leads nuevos). La lista de programados permite cancelar. ⚠️ Requiere que el servicio de Railway esté vivo a esa hora (Railway no duerme en plan de pago; si el servicio estuviera parado, se envía al volver a arrancar si la hora ya pasó).

> ⚠️ **Deliverability:** sin dominio verificado en Brevo (Senders, Domains & Dedicated IPs → añadir dominio → registros SPF/DKIM en el DNS) los correos caen en spam o se rechazan. La baja (`/unsubscribe`) es pública y automática; todo email la incluye en el pie.

## Cómo añadir un proyecto nuevo

1. Crear `proyectos/NombreProyecto/bot-config/contexto.md` con el contexto del negocio (referencia) y su copia real de despliegue `context-nombreproyecto.md` en la raíz de este repo (el motor lee del repo, no de `proyectos/`)
2. Conseguir las credenciales de Meta de ese proyecto (número, token, phone ID)
3. En Railway, crear un servicio nuevo apuntando a este repo
4. Configurar las variables de entorno de ese proyecto, incluyendo `CONTEXT_FILE=context-nombreproyecto.md` (si no se pone, el servicio carga `context.md`, que es el de B2K) y `BOT_VERTICAL` si el negocio no es un tour multi-día (ej. `rental`)
5. Configurar el webhook en Meta apuntando a la URL de Railway
6. Listo — el mismo motor funciona con el nuevo contexto

> ⚠️ Todos los servicios de Railway que apunten a este repo comparten el mismo código en cada
> push (incluido `BASE_INSTRUCTIONS`). Los archivos `context-*.md` conviven todos en el repo;
> cada servicio elige el suyo con `CONTEXT_FILE`. Ejemplo real: Bali Best Motorcycle usa
> `context-balibest.md` + `BOT_VERTICAL=rental`, sin tocar el `context.md` de B2K.

## Cómo modificar el comportamiento

- **Comportamiento general** (todos los bots): editar `BASE_INSTRUCTIONS` en index.js
- **Contexto de un negocio** (solo ese bot): editar la variable `BOT_CONTEXT` en Railway
- **Detección de intención**: el bot etiqueta cada mensaje como exploring/interested/booking

## Despliegue en Railway

1. Subir este código a un repo de GitHub
2. En Railway: New Project → Deploy from GitHub repo
3. Configurar las variables de entorno del proyecto
4. Railway despliega automáticamente y da una URL pública (https)
5. Esa URL + `/webhook` se configura en Meta como webhook
6. Cada push a GitHub redespliega automáticamente

## Configuración del webhook en Meta

1. En la app de Meta → WhatsApp → Configuración
2. URL del webhook: `https://tu-servicio.up.railway.app/webhook`
3. Verify token: el mismo valor que pusiste en `WHATSAPP_VERIFY_TOKEN`
4. Suscribirse al campo `messages`

## Notas

- La memoria de conversaciones está en RAM (se pierde si el servidor reinicia).
  Para producción seria, considerar persistencia en base de datos.
- El bot responde de forma automática total. Para casos de reserva, avisa al dueño.
- Coste estimado: céntimos al mes con bajo volumen de leads.
