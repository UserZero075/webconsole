import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {JSDOM} from '../../tools/editor-assets/node_modules/jsdom/lib/api.js';
import {NavigationHistory} from '../../tools/editor-assets/src/navigation-history.js';

test('navigation history deduplicates locations, supports back/forward and skips closed tabs', () => {
  const history = new NavigationHistory(4);
  const entry = (tabId, head) => ({workspaceId: 'w1', tabId, path: `${tabId}.js`, anchor: head, head});
  history.record(entry('a', 0));
  history.record(entry('a', 0));
  history.record(entry('a', 20));
  history.record(entry('b', 0));
  assert.equal(history.entries.length, 3);
  assert.equal(history.back(() => true).tabId, 'a');
  assert.equal(history.back(() => true).head, 0);
  assert.equal(history.forward(() => true).head, 20);
  assert.equal(history.forward(item => item.tabId !== 'b'), null);
  assert.equal(history.entries.some(item => item.tabId === 'b'), false);
});

test('history truncates forward entries after a new navigation and enforces its bound', () => {
  const history = new NavigationHistory(3);
  const record = head => history.record({workspaceId: 'w', tabId: 'file', head});
  record(1); record(2); record(3);
  history.back(() => true);
  record(9);
  assert.deepEqual(history.entries.map(item => item.head), [1, 2, 9]);
  record(10);
  assert.deepEqual(history.entries.map(item => item.head), [2, 9, 10]);
});

test('Markdown preview drops raw HTML, dangerous URLs, handlers and image fetches', async () => {
  const dom = new JSDOM('', {runScripts: 'outside-only'});
  globalThis.window = dom.window;
  const source = await readFile(new URL('../../static/js/lib/editor/markdown.js', import.meta.url), 'utf8');
  dom.window.eval(source);
  const output = dom.window.WebConsoleMarkdown.renderMarkdown([
    '# Safe heading',
    '<script>window.compromised = true</script>',
    '<img src="https://example.invalid/track.png" onerror="alert(1)">',
    '[bad](javascript:alert%281%29)',
    '![remote image](https://example.invalid/image.png)',
    '```js\nconst message = "safe";\n```',
    '- [x] tarea verificada',
  ].join('\n\n'));
  const document = new JSDOM(`<main>${output}</main>`).window.document;
  assert.equal(document.querySelector('script'), null);
  assert.equal(document.querySelector('img'), null);
  assert.equal(document.querySelector('[onerror]'), null);
  assert.equal(document.querySelector('a[href^="javascript:"]'), null);
  assert.match(document.querySelector('h1')?.textContent || '', /Safe heading/);
  assert.equal(document.querySelector('h1')?.id, 'safe-heading');
  assert.match(document.querySelector('.markdown-image-placeholder')?.textContent || '', /remote image/);
  assert.ok(document.querySelector('pre code .hljs-keyword'));
  assert.match(document.querySelector('.markdown-task-check')?.textContent || '', /✓/);
  assert.equal(dom.window.compromised, undefined);
});

test('editor asset bundles are local, nonempty, and the editor resolves supported modes', async () => {
  const dom = new JSDOM('', {runScripts: 'outside-only'});
  const editor = await readFile(new URL('../../static/js/lib/editor/editor.js', import.meta.url), 'utf8');
  const markdown = await readFile(new URL('../../static/js/lib/editor/markdown.js', import.meta.url), 'utf8');
  const merge = await readFile(new URL('../../static/js/lib/editor/merge.js', import.meta.url), 'utf8');
  assert.ok(editor.length > 10_000 && markdown.length > 1_000 && merge.length > 10_000);
  dom.window.eval(editor);
  assert.equal(dom.window.WebConsoleEditor.isMarkdownPath('README.MD'), true);
  assert.equal(dom.window.WebConsoleEditor.isMarkdownPath('script.js'), false);
  assert.ok(dom.window.WebConsoleEditor.languageForPath('script.tsx'));
  assert.ok(dom.window.WebConsoleEditor.languageForPath('settings.toml'));
  assert.equal(dom.window.WebConsoleEditor.languageForPath('file.unknown').length, 0);
});

test('terminal copy uses Ctrl+Shift+C while Ctrl+C remains native', async () => {
  const dom = new JSDOM('', {runScripts: 'outside-only'});
  const source = await readFile(new URL('../../static/js/terminal-shortcuts.js', import.meta.url), 'utf8');
  dom.window.eval(source);
  let copied = 0;
  const key = ({ctrl = false, shift = false, meta = false, type = 'keydown', value = 'c'} = {}) => {
    const event = new dom.window.KeyboardEvent(type, {
      key: value, ctrlKey: ctrl, shiftKey: shift, metaKey: meta, cancelable: true,
    });
    const result = dom.window.WebConsoleTerminalShortcuts.handleTerminalCopyShortcut(event, true, () => copied++);
    return {event, result};
  };
  const native = key({ctrl: true});
  assert.equal(native.result, true);
  assert.equal(native.event.defaultPrevented, false);
  assert.equal(copied, 0);

  const copy = key({ctrl: true, shift: true});
  assert.equal(copy.result, false);
  assert.equal(copy.event.defaultPrevented, true);
  assert.equal(copied, 1);

  const noSelection = new dom.window.KeyboardEvent('keydown', {
    key: 'c', ctrlKey: true, shiftKey: true, cancelable: true,
  });
  assert.equal(dom.window.WebConsoleTerminalShortcuts.handleTerminalCopyShortcut(noSelection, false, () => copied++), false);
  assert.equal(noSelection.defaultPrevented, true);
  assert.equal(copied, 1);

  key({meta: true});
  assert.equal(copied, 2);
  const nativeWithSelection = key({ctrl: true});
  assert.equal(nativeWithSelection.result, true);
  assert.equal(copied, 2);
});
