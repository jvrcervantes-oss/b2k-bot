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
| `BOT_CONTEXT` | El contexto del negocio (system prompt completo) | ver bot-config del proyecto |
| `BOT_MODEL` | (Opcional) modelo de Claude | `claude-sonnet-4-6` |

> ⚠️ **El Sheet del CRM debe estar COMPARTIDO con el `client_email` de la Service Account (permiso Editor).** Si no, la API responde `404 — Requested entity was not found` aunque la autenticación sea correcta. Las variables `GOOGLE_CREDENTIALS` / `GOOGLE_TOKEN` de versiones antiguas ya **no se usan** — se pueden borrar.

### Newsletter por email (opcional)

Activa el envío de newsletters desde el panel (`/admin` → icono del sobre). Sin `RESEND_API_KEY` + `MAIL_FROM`, el botón de enviar avisa de que falta configurarlo.

| Variable | Descripción | Ejemplo |
|----------|-------------|---------|
| `RESEND_API_KEY` | API key de [resend.com](https://resend.com) (proveedor de email) | `re_...` |
| `MAIL_FROM` | Remitente. El dominio DEBE estar verificado en Resend (SPF/DKIM en el DNS) | `Bali Moto Adventures <newsletter@balimotoadventures.com>` |
| `MAIL_REPLY_TO` | (Opcional) a dónde llegan las respuestas | `info@balimotoadventures.com` |
| `MAIL_COMPANY` | Pie legal del email: nombre + dirección física (obligatorio anti-spam) | `Bali Moto Adventures · Jl. ... , Bali, Indonesia` |
| `MAIL_UNSUB_SECRET` | (Opcional) firma los links de baja; si falta se usa `ADMIN_PASSWORD` | cualquier texto largo |

> ⚠️ **Deliverability:** sin dominio verificado en Resend los correos caen en spam o se rechazan. La baja (`/unsubscribe`) es pública y automática; todo email la incluye en el pie.

## Cómo añadir un proyecto nuevo

1. Crear `proyectos/NombreProyecto/bot-config/contexto.md` con el contexto del negocio
2. Conseguir las credenciales de Meta de ese proyecto (número, token, phone ID)
3. En Railway, crear un servicio nuevo apuntando a este repo
4. Configurar las variables de entorno de ese proyecto
5. Configurar el webhook en Meta apuntando a la URL de Railway
6. Listo — el mismo motor funciona con el nuevo contexto

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
