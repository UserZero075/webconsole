# Matriz de scroll móvil

## Hallazgos reproducibles

- El bundle local es xterm.js 5.31 (`static/js/lib/xterm-531.js`). En modo de
  ratón inactivo, xterm registra `touchstart`/`touchmove` y ajusta su viewport;
  ese camino no genera datos de entrada.
- Cuando el seguimiento de ratón está activo, xterm omite su handler táctil.
  Su handler de rueda envía eventos al protocolo de ratón. En el bundle, los
  modos públicos `vt200`, `drag` y `any` incluyen el bit de rueda; `x10` no.
- La consola no convierte gestos en flechas, PageUp, texto, Enter, ETX ni clicks.
  En modos `vt200`/`drag`/`any`, un arrastre vertical se representa como eventos
  `WheelEvent` DOM y pasa por el handler/encoder de rueda de xterm. En `x10`,
  modo desconocido o pantalla alternativa sin tracking, se informa el límite y
  no se genera entrada.
- Un TUI puede ignorar la rueda aunque xterm la codifique correctamente. No se
  ha enviado entrada a sesiones reales para comprobar la navegación interna de
  OpenCode o Codex; el historial visible de esos TUI queda sujeto a su soporte.

## Matriz de superficie

| Buffer | Mouse tracking | xterm independiente | iframe del workspace | Teclado visible | Acción táctil |
| --- | --- | --- | --- | --- | --- |
| normal con scrollback | none | local viewport | local viewport | no cambia el camino | xterm nativo; sin bytes de entrada |
| normal con scrollback | none | local viewport | local viewport | altura visible se reajusta | xterm nativo; sin bytes de entrada |
| alternativo | none | no hay historial local | no hay historial local | no cambia el camino | límite visible; cero teclas |
| alternativo | x10 | no anuncia rueda | no anuncia rueda | no cambia el camino | límite visible; cero teclas |
| normal o alternativo | vt200 / drag / any | rueda nativa de xterm | rueda nativa de xterm | no cambia el protocolo | rueda solamente; el TUI decide su efecto |
| cualquier buffer | multitouch / horizontal / cancel | no se adapta | no se adapta | no cambia el camino | gesto abandonado; zoom/selección no se capturan globalmente |

La rotación y la apertura/cierre del teclado se miden con `VisualViewport` solo
en escala normal. El pinch zoom no activa un ciclo de `fit`/resize. Los frames
de los fixtures son sintéticos y no conectan con tmux, agentes ni sesiones reales.
