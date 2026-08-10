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
