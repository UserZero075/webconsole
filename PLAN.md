# Plan: Personalización global de WebConsole

## Problem

La interfaz fija el color de acento (`--mint`), el fondo de la terminal (`#1a1a2e`) y el nombre «WebConsole». Además conserva una página `/sessions`, plantilla `index.html`, JavaScript `app.js` y CSS `styles.css` de un dashboard anterior que ya no es parte del flujo principal.

## Solution

Añadir una pestaña de Personalización en el workspace con persistencia privada global: nombre de la aplicación, color de acento y color de fondo de la terminal. El selector usará tres canales RGB, un control nativo y círculos predefinidos; los valores se normalizan a `#rrggbb` y se guardan mediante una API pequeña con validación. El servidor inyectará los valores validados en `workspace.html` y `console.html`, y la UI los aplicará en vivo al guardar sin recargar.

Eliminar la página `/sessions` y sus assets deprecados, retirar los enlaces al dashboard, mantener `/api/sessions` intacto para terminales/workspaces, y actualizar pruebas/docs. No se modificarán credenciales, telemetría, tmux ni el contrato de las APIs de sesiones.

## Tasks

- [x] [01-contract-and-persistence](tasks/01-contract-and-persistence.md) - Defaults, validación y almacenamiento privado.
- [x] [02-preferences-ui](tasks/02-preferences-ui.md) - Pestaña, canales RGB y presets.
- [x] [03-theme-application](tasks/03-theme-application.md) - Workspace, terminal, xterm y nombre global.
- [x] [04-remove-dashboard](tasks/04-remove-dashboard.md) - Retirar `/sessions` y assets deprecados.
- [x] [05-verification](tasks/05-verification.md) - Suites, revisión y publicación.

## Dependencies

- Flask, plantillas Jinja, JS vanilla y CSS existente.
- Estado privado en `WEBCONSOLE_STATE_DIR` (por defecto `app/sessions`).
- Las APIs `/api/sessions`, `/ws/<id>` y `/c/<token>` se conservan por ser funcionales.
- El proyecto tiene cambios locales sin commit; preservarlos.

## Notes

- Preferencias globales, no por proyecto, para alinear nombre y colores generales.
- Color de acento: `#rrggbb` validado; se derivarán variantes suaves para fondos/bordes.
- Fondo de terminal: `#rrggbb` validado; se propagará al iframe y a xterm.
- Nombre: 1–80 caracteres, texto escapado, sin HTML ni control characters.
- Conservar `X-WebConsole: 1` y validación de Origin en mutaciones.
- No publicar ni hacer commit sin autorización.
- No reiniciar el servicio salvo autorización explícita.
