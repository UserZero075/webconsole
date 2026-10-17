# Acciones de agente

En el menú **Acciones de agente** de una sesión OpenCode está disponible **Alternar panel lateral**. Envía Ctrl+X y, 150 ms después, `b`, sin Enter. En OpenCode CLI/TUI con los keybinds predeterminados, esto corresponde a alternar el panel lateral (contexto, tokens, costos e integraciones MCP/LSP).

La configuración personal puede cambiar el leader o este atajo. En ese caso la acción puede no tener el efecto esperado; la paleta de comandos de OpenCode (**Ctrl+P**) sigue disponible como alternativa manual. WebConsole no detecta si el panel quedó abierto o cerrado: el mensaje de éxito indica solo que las dos teclas se aceptaron en la conexión activa. Si no hay confirmación, no se reenvía el toggle automáticamente porque podría alternar el estado una segunda vez.

En OpenCode V2 los keybinds de la TUI se configuran en `cli.json`; el identificador del comando es `session.sidebar.toggle` y su valor predeterminado es `<leader>b` con leader `ctrl+x`. WebConsole no modifica esa configuración.
