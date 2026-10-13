# Task: Pestaña de personalización con RGB y presets

## Status

DONE

## Requires

- Task 01 complete.

## Description

Añadir una pestaña de Personalización en el workspace con nombre, color de acento y fondo de terminal. Debe ser accesible por teclado y móvil, con canales RGB y círculos predefinidos.

## Proposed Solution

Agregar botón/pestaña en el topbar del workspace y un panel/modal dedicado. Para cada color mostrar R/G/B como sliders y números, preview en vivo, círculos de presets y confirmación de guardado. Calcular y aplicar variables CSS `--accent`, `--accent-soft`, `--accent-faint` y `--terminal-background` en la raíz del documento. El nombre se aplica inmediatamente al brand visible, pero solo se persiste al guardar. Restaurar valores desde `GET /api/preferences` al abrir.

## Subtasks

- [ ] Añadir control de pestaña/pestañas accesible con `aria-selected`, foco y Escape.
- [ ] Implementar conversión RGB↔hex, sliders, inputs numéricos y presets sin duplicar estado.
- [ ] Previsualizar cambios en el workspace mientras se edita.
- [ ] Guardar con `PUT /api/preferences`, mostrar éxito/error y no cerrar en fallo.
- [ ] Añadir estilos responsive para desktop y 320px.
- [ ] Añadir pruebas Node/source para eventos, conversión y ausencia de HTML inyectado.

## Files to Modify

- `templates/workspace.html` - Pestaña y panel de preferencias.
- `static/js/workspace.js` - Estado, previsualización y guardado.
- `static/css/workspace.css` - Estilos del selector y variables derivadas.
- `tests/frontend/*.test.mjs` o tests fuente equivalentes - Regresiones.

## Verification

- [ ] `npm --prefix tools/editor-assets test` (timeout: 5min).
- [ ] `node --test tests/frontend/mobile/*.test.mjs` (timeout: 2min).
- [ ] `node --check static/js/workspace.js` (timeout: 30s).
- [ ] La UI no usa `innerHTML` para el nombre ni para valores de color.

## Notes

No cambiar el layout de proyectos, terminales ni editor; la personalización vive en una vista/pestaña separada.
