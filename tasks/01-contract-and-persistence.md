# Task: Contrato y persistencia de preferencias

## Status

DONE

## Requires

- None.

## Description

Definir el contrato de preferencias globales y almacenarlo de forma privada y atómica, sin exponer valores no validados a plantillas o CSS.

## Proposed Solution

Crear un store de preferencias bajo `WEBCONSOLE_STATE_DIR/preferences.json`, con permisos `0700`/`0600`, escritura atómica y defaults deterministas. Validar colores con regex `^#[0-9a-fA-F]{6}$`, normalizar a minúsculas, y validar nombre como texto plano de 1–80 caracteres sin caracteres de control. Exponer `GET /api/preferences` y `PUT /api/preferences`; la mutación mantiene `X-WebConsole: 1` y Origin. No aceptar campos arbitrarios ni inyectar CSS/HTML.

## Subtasks

- [ ] Revisar `TERMINAL_SESSIONS_DIR`, rutas API y patrón de mutaciones existentes.
- [ ] Añadir store con defaults: `brand_name=WebConsole`, `accent_color=#8acfb3`, `terminal_background=#1a1a2e`.
- [ ] Normalizar entradas y rechazar valores inválidos con mensajes claros.
- [ ] Exponer API GET/PUT sin incluir rutas/secretos adicionales.
- [ ] Añadir pruebas de permisos, defaults, normalización, rechazo de payloads maliciosos y persistencia.

## Files to Modify

- `app/preferences.py` - Store y validación.
- `app/server.py` - API y contexto de plantillas.
- `tests/test_preferences.py` - Nuevas pruebas.

## Verification

- [ ] `.venv/bin/python -m pytest tests/test_preferences.py -q` (timeout: 2min).
- [ ] `preferences.json` queda `0600`; directorio `0700`.
- [ ] Colores inválidos, HTML y campos desconocidos se rechazan.

## Notes

No usar localStorage como fuente de verdad; la UI puede previsualizar antes de guardar, pero el servidor debe persistir y validar.
