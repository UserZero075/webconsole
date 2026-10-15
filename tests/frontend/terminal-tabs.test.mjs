import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const SOURCE = new URL('../../static/js/workspace.js', import.meta.url);

function makeFrame(id = '') {
  const messages = [];
  return {
    id, hidden:true, dataset:{}, title:'', src:'', listeners:{},
    contentWindow:{messages, postMessage(message) { messages.push(message); }},
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    remove() { this.removed = true; },
  };
}

async function buildContext() {
  const frames = [];
  const initialFrame = makeFrame('terminal-frame');
  const surface = {append(frame) { frames.push(frame); }};
  const document = {
    addEventListener() {},
    getElementById(id) { return id === 'terminal-frame' ? initialFrame : id === 'work-surface' ? surface : null; },
    createElement(tag) { assert.equal(tag, 'iframe'); return makeFrame(); },
  };
  const window = {location:{origin:'https://example.test'}};
  const context = vm.createContext({document, window, setTimeout, clearTimeout, console});
  vm.runInContext(await readFile(SOURCE, 'utf8'), context);
  return {context, frames, initialFrame};
}

test('opened agent tabs retain separate iframe instances and suspend inactive traffic', async () => {
  const {context, frames, initialFrame} = await buildContext();
  vm.runInContext(`
    const a = ensureTerminalView({id:'agent-a', title:'A', launcher:'codex'});
    const b = ensureTerminalView({id:'agent-b', title:'B', launcher:'opencode'});
    a.ready = b.ready = true;
    deactivateTerminalViews('agent-b');
  `, context);
  const state = vm.runInContext('state', context);
  const a = state.terminalViews.get('agent-a').frame;
  const b = state.terminalViews.get('agent-b').frame;

  assert.equal(a, initialFrame);
  assert.notEqual(a, b);
  assert.equal(frames.length, 1, 'only the requested second agent view is created');
  assert.equal(a.hidden, true);
  assert.equal(b.hidden, false);
  const hideMessage = a.contentWindow.messages.at(-1);
  assert.equal(hideMessage.type, 'webconsole:view-visibility');
  assert.equal(hideMessage.visible, false);
  assert.equal(hideMessage.immediate, true);
  const showMessage = b.contentWindow.messages.at(-1);
  assert.equal(showMessage.type, 'webconsole:view-visibility');
  assert.equal(showMessage.visible, true);
  assert.equal(showMessage.immediate, false);
  assert.equal(state.terminalViews.get('agent-a').ready, true, 'the hidden tab keeps its rendered screen');
});

test('closing an agent tab disposes its iframe without changing the tmux session', async () => {
  const {context, initialFrame} = await buildContext();
  vm.runInContext(`
    ensureTerminalView({id:'agent-a', title:'A', launcher:'codex'});
    disposeTerminalView('agent-a');
  `, context);
  const state = vm.runInContext('state', context);
  assert.equal(state.terminalViews.has('agent-a'), false);
  assert.equal(initialFrame.hidden, true);
  assert.equal(initialFrame.src, 'about:blank');
  assert.equal(initialFrame.contentWindow.messages.at(-1).immediate, true);
});
