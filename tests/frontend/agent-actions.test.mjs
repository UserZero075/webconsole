import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const WORKSPACE = new URL('../../static/js/workspace.js', import.meta.url);
const CONSOLE = new URL('../../templates/console.html', import.meta.url);

test('the sidebar toggle is listed only among OpenCode agent actions', async () => {
  const source = await readFile(WORKSPACE, 'utf8');
  const openActions = source.slice(source.indexOf('function openActions(session)'), source.indexOf('function dispatchAgentAction(session, action)'));
  const opencode = openActions.slice(openActions.indexOf("agent === 'opencode' ? ["), openActions.indexOf("] : agent === 'codex' ? ["));
  const codex = openActions.slice(openActions.indexOf("] : agent === 'codex' ? ["));

  assert.match(opencode, /id:'opencode-sidebar', title:'Alternar panel lateral', key:'Ctrl\+X, B'/);
  assert.match(opencode, /contexto, tokens, costos, MCP y LSP/);
  assert.doesNotMatch(codex, /opencode-sidebar/);
  assert.match(openActions, /Atajos predeterminados de la TUI; la configuración del usuario puede cambiarlos/);
});

test('the rendered action menu exposes the toggle for OpenCode, not Codex', async () => {
  const source = await readFile(WORKSPACE, 'utf8');
  const start = source.indexOf('function openActions(session)');
  const end = source.indexOf('function dispatchAgentAction(session, action)');
  const implementation = source.slice(start, end);

  function renderFor(launcher) {
    const elements = new Map();
    const actions = [];
    const createNode = (tag, className, text) => ({
      tag, className, textContent:text ?? '', children:[], listeners:{},
      append(...children) { this.children.push(...children); },
      addEventListener(type, listener) { this.listeners[type] = listener; },
    });
    const list = {
      append(child) { actions.push(child); },
      replaceChildren(...children) { actions.splice(0, actions.length, ...children); },
    };
    elements.set('action-list', list);
    elements.set('actions-title', {textContent:''});
    elements.set('actions-description', {textContent:''});
    elements.set('agent-actions-dialog', {showModal() { this.open = true; }});
    const context = vm.createContext({
      $, node:createNode,
      detectedAgent:session => session.launcher,
      agentName:session => session.launcher,
      session:{id:'fixture', title:'Fixture', launcher, token:'fixture-token'},
    });
    function $(id) { return elements.get(id); }
    vm.runInContext(`${implementation}\nopenActions(session);`, context);
    return actions.map(button => button.children[1].children[0].textContent);
  }

  assert.ok(renderFor('opencode').includes('Alternar panel lateral'));
  assert.ok(!renderFor('codex').includes('Alternar panel lateral'));
});

test('the sidebar toggle has a fixed allowlisted sequence and a correlated single-request response', async () => {
  const source = await readFile(CONSOLE, 'utf8');
  const workspaceSource = await readFile(WORKSPACE, 'utf8');
  const handler = source.slice(source.indexOf("if (action === 'opencode-sidebar')"), source.indexOf('const execute = agentActions[action]'));

  assert.match(handler, /sendInput\('\\x18'\)/);
  assert.match(handler, /sendInput\('b'\)/);
  assert.match(handler, /request_id:requestId/);
  assert.match(handler, /transportReady[\s\S]*socket\.readyState === WebSocket\.OPEN/);
  assert.match(handler, /!sessionEnded[\s\S]*!viewSuspended[\s\S]*mobileTerminalInputAllowed/);
  assert.match(handler, /}, 150\)/);
  assert.doesNotMatch(handler, /sendInput\('\\x18b|sendInput\('b\\r|sendInput\('b\\n/);
  assert.match(workspaceSource, /event\.data\.request_id !== state\.pendingAction\.requestId/);
  assert.match(workspaceSource, /no se reintentó/i);
});

test('dispatch sends the sidebar toggle once and reports timeout without replay', async () => {
  const source = await readFile(WORKSPACE, 'utf8');
  const start = source.indexOf('function dispatchAgentAction(session, action)');
  const end = source.indexOf('function interruptWorkspaceShell()');
  const implementation = source.slice(start, end);
  const session = {id:'sess-1', token:'fixture-token', launcher:'opencode', state:'working'};
  const sent = [];
  const notices = [];
  const timers = [];
  const frame = {contentWindow:{postMessage(...args) { sent.push(args); }}};
  const state = {
    pendingAction:null, actionTimer:null, activeTabId:'terminal:sess-1', frameSessionId:'sess-1', terminalFrameReady:true,
  };
  const context = vm.createContext({
    state,
    session,
    sessionFor:id => id === session.id ? session : null,
    sessionEnded:() => false,
    detectedAgent:() => 'opencode',
    isWorkspaceShell:() => false,
    activeTerminalFrame:() => frame,
    openTerminal() {},
    toast:message => notices.push(message),
    window:{location:{origin:'https://example.test'}},
    Date, Math,
    setTimeout:(callback, delay) => { timers.push({callback, delay}); return timers.length; },
    clearTimeout() {},
    clearInterval() {},
    setInterval() { throw new Error('sidebar toggle must not use retry intervals'); },
  });

  vm.runInContext(`${implementation}\ndispatchAgentAction(session, {id:'opencode-sidebar'});`, context);
  assert.equal(sent.length, 1, 'one postMessage request only');
  assert.equal(sent[0][0].type, 'webconsole:agent-action');
  assert.equal(sent[0][0].action, 'opencode-sidebar');
  assert.equal(sent[0][0].session_id, 'sess-1');
  assert.equal(typeof sent[0][0].request_id, 'string');
  assert.equal(sent[0][1], 'https://example.test');
  assert.equal(timers[0].delay, 5000);
  vm.runInContext(`dispatchAgentAction(session, {id:'opencode-sidebar'});`, context);
  assert.equal(sent.length, 1, 'a second click cannot interleave another toggle');
  assert.equal(timers.length, 1, 'the second click does not create another timeout');

  timers[0].callback();
  assert.equal(state.pendingAction, null);
  assert.match(notices.at(-1), /no se reintentó/i);
  assert.equal(sent.length, 1, 'timeout never replays a non-idempotent toggle');
});

test('sidebar action results are correlated to the pending request and owning iframe', async () => {
  const source = await readFile(WORKSPACE, 'utf8');
  const start = source.indexOf('function handleActionResult(event)');
  const end = source.indexOf('function handleTerminalMessage(event)');
  const implementation = source.slice(start, end);
  const frame = {contentWindow:{}};
  const notices = [];
  const state = {
    pendingAction:{sessionId:'sess-1', action:'opencode-sidebar', requestId:'request-current'},
    actionTimer:123,
  };
  const context = vm.createContext({
    state,
    window:{location:{origin:'https://example.test'}},
    terminalFrameFor:id => id === 'sess-1' ? frame : null,
    activeTerminalFrame:() => frame,
    clearTimeout:id => assert.equal(id, 123),
    clearInterval() {},
    toast:message => notices.push(message),
  });
  vm.runInContext(implementation, context);

  // Supply event objects from the VM realm so the real event handler checks all
  // three boundaries: origin, frame ownership, and the unique request id.
  const send = ({origin='https://example.test', source:sourceFrame=frame.contentWindow,
    sessionId='sess-1', requestId='request-current', success=true} = {}) => {
    context.event = {
      origin, source:sourceFrame,
      data:{type:'webconsole:action-result', action:'opencode-sidebar', session_id:sessionId, request_id:requestId, success},
    };
    vm.runInContext('handleActionResult(event)', context);
  };

  send({origin:'https://evil.example'});
  send({source:{}});
  send({requestId:'stale-request'});
  send({sessionId:'another-session'});
  assert.ok(state.pendingAction, 'unrelated or late results leave the pending request alone');
  assert.equal(notices.length, 0);

  send({success:false});
  assert.equal(state.pendingAction, null);
  assert.equal(state.actionTimer, null);
  assert.match(notices[0], /no se reintentó/i);
});
