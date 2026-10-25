import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const TEMPLATE = new URL('../../templates/workspace.html', import.meta.url);
const SOURCE = new URL('../../static/js/workspace.js', import.meta.url);
const STYLES = new URL('../../static/css/workspace.css', import.meta.url);

test('the inspector exposes four accessible tabs and one initially visible panel', async () => {
  const html = await readFile(TEMPLATE, 'utf8');
  const css = await readFile(STYLES, 'utf8');
  assert.match(html, /role="tablist" aria-label="Panel lateral"/);
  for (const [tab, panel] of [['files', 'explorer-section'], ['history', 'history-section'], ['git', 'git-section'], ['messages', 'message-section']]) {
    assert.match(html, new RegExp(`data-inspector-tab="${tab}"[^>]*aria-controls="${panel}"`));
    assert.match(html, new RegExp(`id="${panel}"[^>]*role="tabpanel"`));
  }
  assert.match(html, /id="inspector-tab-files"[^>]*aria-selected="true"/);
  assert.match(html, /id="git-section"[^>]*hidden/);
  assert.match(html, /id="history-section"[^>]*hidden/);
  assert.match(html, /id="message-section"[^>]*hidden/);
  assert.match(css, /\.inspector-tab-panel\[hidden\]\s*\{\s*display:\s*none\s*\}/);
});

test('tab selection updates panel visibility, persists, and supports arrow-key navigation', async () => {
  const source = await readFile(SOURCE, 'utf8');
  const start = source.indexOf('const INSPECTOR_TABS =');
  const end = source.indexOf('\nfunction mobileViewport()', start);
  assert.ok(start >= 0 && end > start, 'inspector tab controller is present');

  const elements = new Map();
  for (const [id, tab] of [
    ['inspector-tab-files', 'files'], ['inspector-tab-history', 'history'],
    ['inspector-tab-git', 'git'], ['inspector-tab-messages', 'messages'],
  ]) {
    elements.set(id, {
      dataset:{inspectorTab:tab}, attributes:new Map(),
      setAttribute(name, value) { this.attributes.set(name, value); },
      focus() { this.focused = true; },
    });
  }
  for (const id of ['explorer-section', 'history-section', 'git-section', 'message-section']) elements.set(id, {hidden:false});
  const stored = new Map();
  const context = vm.createContext({
    state:{inspectorTab:'files'},
    $:id => elements.get(id),
    localStorage:{setItem:(key, value) => stored.set(key, value)},
  });
  vm.runInContext(source.slice(start, end), context);

  vm.runInContext("setInspectorTab('git')", context);
  assert.equal(vm.runInContext('state.inspectorTab', context), 'git');
  assert.equal(elements.get('explorer-section').hidden, true);
  assert.equal(elements.get('git-section').hidden, false);
  assert.equal(elements.get('message-section').hidden, true);
  assert.equal(elements.get('history-section').hidden, true);
  assert.equal(elements.get('inspector-tab-git').attributes.get('aria-selected'), 'true');
  assert.equal(stored.get('webconsole.inspectorTab'), 'git');

  let prevented = false;
  context.handleInspectorTabKeydown({
    target:{closest:() => elements.get('inspector-tab-git')},
    key:'ArrowRight',
    preventDefault() { prevented = true; },
  });
  assert.equal(prevented, true);
  assert.equal(vm.runInContext('state.inspectorTab', context), 'messages');
  assert.equal(elements.get('inspector-tab-messages').focused, true);
  context.handleInspectorTabKeydown({
    target:{closest:() => elements.get('inspector-tab-messages')},
    key:'Home', preventDefault() {},
  });
  assert.equal(vm.runInContext('state.inspectorTab', context), 'files');
});
