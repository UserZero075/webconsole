# Task: Retirar el dashboard deprecado `/sessions`

## Status

DONE

## Requires

- Task 03 complete.

## Description

Eliminar la página y los assets del dashboard anterior, manteniendo las APIs de sesiones que sí son funcionales.

## Proposed Solution

Retirar la ruta `/sessions`, `templates/index.html`, `static/js/app.js` y `static/css/styles.css`. Quitar enlaces al dashboard desde workspace y console. Actualizar gzip/cache solo para `/`. Actualizar pruebas que referencian el dashboard, y documentación/AGENTS. `/api/sessions`, `/ws/<id>` y `/c/<token>` permanecen intactos.

## Subtasks

- [ ] Eliminar ruta y plantilla dashboard.
- [ ] Eliminar JS/CSS dashboard sin borrar assets usados por workspace/console.
- [ ] Quitar enlaces `Resumen` y «actividad de todas las sesiones».
- [ ] Actualizar pruebas que esperan `/sessions` o `app.js/index.html`.
- [ ] Actualizar README y AGENTS para reflejar el flujo actual.
- [ ] Buscar referencias residuales a `/sessions` y assets eliminados.

## Files to Modify

- `app/server.py` - Ruta y cache.
- `templates/workspace.html` - Enlaces.
- `templates/index.html`, `static/js/app.js`, `static/css/styles.css` - Eliminación.
- `tests/test_workspace_backend.py`, `tests/test_persistence.py` - Ajustes.
- `README.md`, `AGENTS.md` - Documentación.

## Verification

- [ ] `.venv/bin/python -m pytest tests -q` (timeout: 5min).
- [ ] `grep -R` no encuentra referencias a `templates/index.html`, `static/js/app.js`, `static/css/styles.css` ni enlaces `/sessions`.
- [ ] `/api/sessions` sigue respondiendo y las suites de persistencia pasan.

## Notes

«Quitar todo relacionado con `/sessions`» significa retirar el dashboard público deprecado; no significa eliminar la API ni el estado de sesiones.
