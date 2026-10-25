import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const CONSOLE = new URL('../../templates/console.html', import.meta.url);
const WORKSPACE = new URL('../../static/js/workspace.js', import.meta.url);

test('Ctrl/Command+V shortcuts are left for the browser to dispatch paste events', async () => {
  const source = await readFile(CONSOLE, 'utf8');
  const start = source.indexOf('function isBrowserPasteShortcut(');
  const end = source.indexOf('\n        function mediaFilesFromClipboard', start);
  const implementation = source.slice(start, end);
  assert.ok(start >= 0 && end > start, 'the paste shortcut helper is present');

  const context = vm.createContext({});
  vm.runInContext(`${implementation}\nthis.isPasteShortcut = isBrowserPasteShortcut;`, context);
  for (const event of [
    {type:'keydown', key:'v', ctrlKey:true},
    {type:'keydown', key:'V', ctrlKey:true, shiftKey:true},
    {type:'keydown', key:'v', metaKey:true},
  ]) {
    assert.equal(context.isPasteShortcut(event), true);
  }
  assert.equal(context.isPasteShortcut({type:'keyup', key:'v', ctrlKey:true}), false);
  assert.equal(context.isPasteShortcut({type:'keydown', key:'c', ctrlKey:true}), false);
  assert.equal(context.isPasteShortcut({type:'keydown', key:'v', ctrlKey:true, altKey:true}), false);
  assert.match(source, /if \(isBrowserPasteShortcut\(e\)\) return false;/);
});

test('attachment progress auto-dismisses only after successful transfers', async () => {
  const source = await readFile(CONSOLE, 'utf8');
  const start = source.indexOf('function canAutoDismissAttachmentTransfers(');
  const end = source.indexOf('\n        function scheduleAttachmentTransferDismissal(', start);
  const implementation = source.slice(start, end);
  assert.ok(start >= 0 && end > start, 'the attachment auto-dismiss helper is present');

  const context = vm.createContext({});
  vm.runInContext(`${implementation}\nthis.canAutoDismiss = canAutoDismissAttachmentTransfers;`, context);
  assert.equal(context.canAutoDismiss([{state:'uploaded'}]), true);
  assert.equal(context.canAutoDismiss([{state:'inserted'}, {state:'uploaded'}]), true);
  assert.equal(context.canAutoDismiss([{state:'processing'}]), false);
  assert.equal(context.canAutoDismiss([{state:'failed'}]), false);
  assert.equal(context.canAutoDismiss([]), false);
  assert.match(source, /ATTACHMENT_TRANSFER_AUTO_DISMISS_MS = 2500/);
  assert.match(source, /scheduleAttachmentTransferDismissal\(\);/);
});

test('terminal copying uses the browser clipboard and embedded frames permit writes', async () => {
  const [consoleSource, workspaceSource, workspaceMarkup] = await Promise.all([
    readFile(CONSOLE, 'utf8'),
    readFile(WORKSPACE, 'utf8'),
    readFile(new URL('../../templates/workspace.html', import.meta.url), 'utf8'),
  ]);
  const start = consoleSource.indexOf('function fallbackClipboardCopy(');
  const end = consoleSource.indexOf('\n        function copyTerminalSelection(', start);
  const implementation = consoleSource.slice(start, end);
  assert.ok(start >= 0 && end > start, 'the browser clipboard helper is present');

  const writes = [];
  const context = vm.createContext({
    navigator: {clipboard: {writeText: text => { writes.push(text); return Promise.resolve(); }}},
  });
  vm.runInContext(`${implementation}\nthis.copyText = copyTextToClipboard;`, context);
  assert.equal(await context.copyText('selected terminal text'), true);
  assert.deepEqual(writes, ['selected terminal text']);
  assert.match(consoleSource, /Texto copiado al portapapeles de este navegador/);
  assert.match(workspaceMarkup, /id="terminal-frame"[^>]*allow="clipboard-write"/);
  assert.match(workspaceMarkup, /id="shell-frame"[^>]*allow="clipboard-write"/);
  assert.match(workspaceSource, /frame\.allow = 'clipboard-write'/);
});

test('workspace shell explains that attachments require an agent session', async () => {
  const [consoleSource, workspaceSource] = await Promise.all([
    readFile(CONSOLE, 'utf8'), readFile(WORKSPACE, 'utf8'),
  ]);
  assert.match(consoleSource, /type:'webconsole:attachment-error', session_id:sessionId, error:message/);
  assert.equal((workspaceSource.match(/data\.type === 'webconsole:attachment-error'/g) || []).length, 2);
});
