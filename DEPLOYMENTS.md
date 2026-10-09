# Bots desplegados — mapa único (¿dónde estoy trabajando?)

> **Fuente autoritativa:** `agencia/departamentos/infraestructura/prompt.md` → "Mapa de bots desplegados".
> Este archivo es la copia dentro del repo del bot. Si divergen, manda el prompt de Infraestructura.

Un **solo repo** (`b2k-bot`), un **solo motor** (`index.js`). Cada bot es un **servicio Railway distinto**
que despliega de **su propia rama** y elige qué archivos carga con **variables de entorno**
(`CONTEXT_FILE`, `PANEL_FILE`, `BOT_VERTICAL`, `PROJECT_NAME`).

⚠️ Los 4 archivos (`context.md`, `context-balibest.md`, `panel.html`, `panel-rental.html`) existen en
**TODAS las ramas**. Lo que decide cuál se usa es la **variable del servicio**, no la rama ni el nombre
más parecido.

| Bot | Rama | Servicio Railway (project id) | PROJECT_NAME | VERTICAL | CONTEXT_FILE | PANEL_FILE | URL |
|-----|------|-------------------------------|--------------|----------|--------------|------------|-----|
| **Bali Moto Adventures (B2K)** | `b2k` | b2k-bot (`0347015a-…`) | Bali Moto Adventures | tour *(default)* | `context.md` *(default)* | `panel.html` *(default)* | https://b2k-bot-production.up.railway.app |
| **Bali Best Motorcycle (BBM)** | `balibest` | bbm-bot (`bcd4b2a6-…`) | BaliBest | `rental` | `context-balibest.md` | `panel-rental.html` | https://b2k-bot-production-5498.up.railway.app |
| **Lawang + Sumba Hills** (un solo número, dos campañas) | `lawang` | *(por crear)* | Lawang | *(sin definir — `PLAYBOOK_FILE=playbook-lawang.json` lo sustituye, closeStyle `appointment` cae en los bloques TOUR_* built-in, igual que sumbahills)* | `context-lawang.md` | `panel-rental.html` | — |
| `bnb-bot` (`c26007ad-…`) | ? | **entorno de pruebas del owner — NO tocar** | — | — | — | — | uso interno de testeo |

`main` = rama **base común**. NO la despliega ningún servicio; es donde se integran cambios comunes del
motor que luego se mergean a `b2k`, `balibest` y `lawang`. Las tres van por delante de `main`.

**`lawang` nace de `origin/sumbahills`, no de `main`** (30-jul-2026, sesión previa: `context-sumbahills.md` +
`playbook-sumbahills.json` + el mecanismo `PLAYBOOK_FILE` ya vivían ahí, sin desplegar). El número
`+62 811-3830-5237` sirve las dos campañas (Bali/Lawang y Sumba Hills) — un número, un webhook, un
servicio: no se puede repartir en dos ramas. `context-lawang.md` cubre ambas marcas y remite a
`context-sumbahills.md` para el detalle de Sumba en vez de duplicarlo. **`HUMAN_ONLY=1`** arranca este bot
sin IA — todo lead entra pausado desde el primer mensaje (misma puerta que el control humano por-lead) y
se avisa una vez al `OWNER_PHONE` por lead nuevo. Se quita cuando el owner quiera activar la persona.

## Antes de EDITAR un archivo de bot (preflight — evita tocar el bot equivocado)
1. **¿Qué bot?** Mira la tabla: su rama y qué `CONTEXT_FILE`/`PANEL_FILE` usa **ese** servicio.
   Ej.: BBM = `panel-rental.html` + `context-balibest.md`; B2K = `panel.html` + `context.md`.
2. **Aíslate en un worktree.** El working dir es COMPARTIDO entre sesiones y la rama se voltea bajo los
   pies. Trabaja SIEMPRE en `git worktree add <tmp> <rama>`, edita ahí, commit+push, `git worktree remove`.
   Nunca edites en el dir principal.
3. **Verifica el push:** `git rev-parse <rama>` == `git rev-parse origin/<rama>` (el push a rama puede
   reportar OK sin subir).
4. **Verifica el deploy:** Railway redespliega solo al hacer push a la rama del servicio. Confirma contra
   la URL (`curl .../admin | grep <marcador>`), no lo des por hecho.

## Regla de oro
El archivo que edites tiene que ser el que la **variable del servicio** carga de verdad, no el que se
llama parecido. *(Gotcha real 27-jul-2026: el botón se puso en `panel.html` y BBM sirve `panel-rental.html`.)*

## Rama `lawang`: almacén Redis o Supabase (`BOT_STORE`, S4b del encargo `20261009_lawang_bot_sin_redis`)
Solo en la rama `lawang` (`b2k` y `balibest` no lo tienen y siguen en Redis).

| Variable | Valores | Efecto |
|---|---|---|
| `BOT_STORE` | `redis` (por defecto) · `supabase` (`postgres` sigue valiendo como alias antiguo y avisa en el log) | `redis`: el bot de siempre, sin cambios. `supabase`: el estado vive en Postgres de Lawang vía la edge `bot-api`; el módulo de Redis queda **bloqueado** (cualquier acceso lanza) y el webhook es el de `turno-pg.js`. Un valor desconocido cae a `redis` y lo grita en el log. |
| `BOT_API_URL` | URL de la edge | La misma de catálogo/CRM. |
| `BOT_API_SECRET_ESTADO` · `_RECORDATORIO` | secretos | Un secreto por ruta de la edge (`/estado`, `/recordatorio`). Cada uno abre solo su ruta. **`BOT_API_SECRET_HUMANO` NO debe existir en Railway**: `/humano` la llama `lawang-bot-proxy` (interruptor `BOT_HUMANO_STORE=postgres` en la edge, a encender junto con `BOT_STORE=postgres`). |
| `BOT_RECORDATORIO` | `off` (por defecto) · `postgres` | Recordatorio de cita 1 h antes desde Postgres (`/recordatorio`). Sin plantilla de Meta cableada: ventana cerrada = `sin_ventana` + aviso al dueño. |
| `BOT_CONSENTIMIENTO` | vacío (por defecto) · `on` | **S12 (LAW-507).** `on`: al cerrar una conversación (despedida, nunca en el 1.er mensaje ni con cifra, cita o traspaso) el bot hace UNA sola vez por lead la pregunta de seguimiento de Legal (`consentimiento.js`, versión `CONSENT-SEGUIMIENTO-2026-10-09-v1`) y la base interpreta la respuesta. El estado lo fija la base (listas cerradas), nunca el modelo. Con `BOT_MODE=testing` el freno sigue vigente. Encender fuera de testing = OK del owner. |
| `BOT_SEGUIMIENTO` | `off` (por defecto) · `postgres` | **S12.** `postgres`: cada 30 min envía `lawang_reenganche_48h` (a las 48 h del último mensaje nuestro) y `lawang_reenganche_7d` (a los 7 d), SOLO con consentimiento `si` vigente (≤30 d), máx. 2 por lead, nunca tras respuesta, STOP u operadora, entre las 9 y las 20 h de Bali. Nombres de plantilla: `BOT_SEGUIMIENTO_PLANTILLA_48H` / `_7D` (por defecto las dos de Meta). **No usa `FOLLOWUP_TEMPLATE_NAME`** (decisión del owner). Antes de encender: contrastar la política de opt-in de Meta y validar UU PDP con abogado indonesio. |
| `BOT_AVISOS_CLIENTE` | `off` (por defecto) · `on` | S13 (LAW-507). Abre `POST /admin/api/aviso-cliente` (clave del panel; `{evento: confirmada\|reprogramada\|cancelada\|traspaso, phone, tipo, cuando, nombre}`) que manda al cliente el aviso de cita o de traspaso: ventana de 24 h abierta = texto libre con aviso de asistente y STOP; cerrada = la plantilla de abajo, en el idioma del lead (en/es; id sin activar) y con la hora de Bali. Todo pasa por el freno de testing y la baja. Apagado responde 404. Llamador previsto: `lawang-bot-proxy`/intranet cuando una persona confirma, mueve o cancela una cita (aún no cableado). El traspaso solo sale si el cliente pidió una persona en sus últimos mensajes (lo comprueba el bot). |
| `CITA_CONFIRMADA_TEMPLATE_NAME` · `CITA_REPROGRAMADA_TEMPLATE_NAME` · `CITA_CANCELADA_TEMPLATE_NAME` · `TRASPASO_TEMPLATE_NAME` | `lawang_cita_confirmada` · `lawang_cita_reprogramada` · `lawang_cita_cancelada` · `lawang_traspaso_persona` | Una variable por plantilla (UTILITY, APPROVED en en/es el 9-oct). Propias de S13: NO reutilizan `REMINDER_TEMPLATE_NAME` (S6b) ni `FOLLOWUP_TEMPLATE_NAME` (S12). Sin la variable y con la ventana cerrada no sale nada (`sin_plantilla`). Variables: cita `{{1}}` nombre · `{{2}}` tipo · `{{3}}` fecha y hora de Bali; traspaso `{{1}}` nombre. |
| `ALERTA_EQUIPO_TEMPLATE_NAME` | `lawang_alerta_equipo` | Aviso interno al `OWNER_PHONE` (es, `{{1}}` contacto · `{{2}}` último mensaje, aplanados: sin saltos de línea ni tabuladores). **Sustituye a `ALERT_TEMPLATE_NAME`/`_LANG`/`_VARS` (`lawang_alerta_lead`, MARKETING), que el motor ya no lee: ponerla ANTES del despliegue y borrar las viejas después.** Sin ella, texto libre. |
| `META_APP_SECRET` | obligatorio con `supabase` | Sin él **el bot se niega a arrancar** (sale con código 1; el modo redis conserva su compatibilidad: sin la variable acepta todo). |
| `BOT_TURNO_REINTENTOS_MS` · `BOT_CIERRE_REINTENTOS_MS` · `BOT_API_TIMEOUT_MS` | opcionales | Plazos de fiabilidad (por defecto `20000,90000` · `1000,3000,8000` · `10000`). |

Con `BOT_STORE=supabase` el bot ya no tiene `/admin/api/leads`, `conv`, `config*`, `note`, `status`, media, newsletter… (responden 410). Siguen: `health`, `wa-status`, `templates`, `simulate`, `send` / `send-template` (comprueban la baja, envían y devuelven `registrar{texto,wamid}`: el proxy lo anota por `/humano` con la persona del JWT) y `pause` (410: la pausa de una persona la escribe el proxy por `/humano`).
Pruebas: `node --test test-store-bloqueo.js test-store-postgres.js test-turno-pg.js test-pg-estructura.js test-pg-e2e.js` (la última arranca el bot de verdad con una edge, un Meta y un Anthropic falsos: sin secretos ni red).
