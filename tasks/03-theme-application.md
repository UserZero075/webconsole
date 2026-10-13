# Task: Aplicar tema y nombre en workspace y terminal

## Status

DONE

## Requires

- Task 02 complete.

## Description

Propagar el nombre y los colores validados a las plantillas renderizadas y a xterm, eliminando dependencias de valores fijos en la UI.

## Proposed Solution

Inyectar preferencias validadas en `workspace.html` y `console.html`. Workspace usará variables CSS en `:root`; console usará `--bg-terminal` y un tema xterm calculado desde el color de fondo. Reemplazar referencias duras al verde/azul oscuro por variables derivadas. El nombre se mostrará en brand, título y etiquetas aria; las clases/IDs y URLs seguirán siendo estables.

## Subtasks

- [ ] Renderizar workspace con variables CSS y nombre escapado.
- [ ] Renderizar console/iframe con `--bg-terminal` y tema xterm basado en `terminal_background`.
- [ ] Reemplazar hardcoded greens/blues usados como estados/acentos por variables.
- [ ] Añadir contraste suficiente para texto sobre acentos y mantener foco visible.
- [ ] Probar que nombres con Unicode, ampersands y comillas no rompen plantillas.
- [ ] Probar que colores personalizados se aplican al recargar y al abrir `/c/<token>`.

## Files to Modify

- `app/server.py` - Contexto de plantillas.
- `templates/workspace.html`, `templates/console.html` - Variables y xterm.
- `static/css/workspace.css`, `static/css/console.css` - Variables y estados.
- `tests/test_workspace_backend.py` - Renderizado y cabeceras.

## Verification

- [ ] `.venv/bin/python -m pytest tests/test_workspace_backend.py -q` (timeout: 5min).
- [ ] `git diff --check` (timeout: 30s).
- [ ] El HTML renderizado no contiene strings de color no normalizados.

## Notes

No tocar el protocolo WebSocket ni la lógica de xterm más allá del tema inicial.
