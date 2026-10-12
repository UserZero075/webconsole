(() => {
    function handleTerminalCopyShortcut(event, hasSelection, copySelection) {
        if (event.type !== 'keydown' || event.key?.toLowerCase() !== 'c') return true;
        const controlCopy = event.ctrlKey && event.shiftKey;
        const macCopy = event.metaKey && !event.ctrlKey && !event.shiftKey;
        if (!controlCopy && !macCopy) return true;
        event.preventDefault();
        if (hasSelection) copySelection();
        return false;
    }
    window.WebConsoleTerminalShortcuts = {handleTerminalCopyShortcut};
})();
