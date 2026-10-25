import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const TEMPLATE = new URL('../../templates/console.html', import.meta.url);

/** Strip Jinja placeholders so the inline script becomes parseable JavaScript. */
async function loadSource({sessionRole = 'workspace_shell'} = {}) {
  const html = await readFile(TEMPLATE, 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  return script
    .replaceAll(/\{\{\s*preferences\.terminal_background\s*\}\}/g, '"#1a1a2e"')
    .replaceAll(/\{\{\s*asset_version\([^}]*\)\s*\}\}/g, '"0"')
    .replaceAll(/\{\{\s*session_id\s*\|\s*tojson\s*\}\}/g, '"sess-1"')
    .replaceAll(/\{\{\s*token\s*\|\s*tojson\s*\}\}/g, '"tok-1"')
    .replaceAll(/\{\{\s*session_role\s*\|\s*tojson\s*\}\}/g, JSON.stringify(sessionRole))
    .replaceAll(/\{\{\s*embedded\s*\|\s*tojson\s*\}\}/g, 'true');
}

/** Minimal DOM: every id resolves to a permissive stub element. */
function makeElement() {
  const listeners = {};
  return {
    hidden: false,
    value: '',
    textContent: '',
    innerHTML: '',
    style: {},
    dataset: {},
    classList: {add() {}, remove() {}, toggle() {}, contains() { return false; }},
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    setAttribute() {},
    getAttribute() { return null; },
    append() {},
    appendChild() {},
    replaceChildren() {},
    remove() {},
    insertBefore() {},
    contains() { return false; },
    closest() { return null; },
    matches() { return false; },
    blur() {},
    click() {},
    scrollIntoView() {},
    focus() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return {width: 800, height: 400, top: 0, left: 0}; },
    offsetWidth: 800,
    clientWidth: 800,
    listeners,
  };
}

/** Deterministic clock: run scheduled work by advancing virtual time. */
function makeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  const intervals = new Map();
  const api = {
    now: () => now,
    setTimeout(fn, delay = 0) {
      const id = ++seq;
      timers.set(id, {at: now + Math.max(0, delay), fn});
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn, delay = 0) {
      const id = ++seq;
      intervals.set(id, {every: Math.max(1, delay), next: now + Math.max(1, delay), fn});
      return id;
    },
    clearInterval(id) { intervals.delete(id); },
    clearAll() { timers.clear(); intervals.clear(); },
    pending() { return [...timers.values()].sort((a, b) => a.at - b.at); },
    /** Advance virtual time, running everything due, up to `ms`. */
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const dueTimers = api.pending().filter(t => t.at <= target);
        const dueIntervals = [...intervals.values()].filter(i => i.next <= target);
        if (!dueTimers.length && !dueIntervals.length) break;
        const timer = dueTimers[0];
        const interval = dueIntervals[0];
        if (timer && (!interval || timer.at <= interval.next)) {
          now = timer.at;
          timers.delete([...timers.entries()].find(([, t]) => t === timer)[0]);
          timer.fn();
        } else {
          now = interval.next;
          interval.next = now + interval.every;
          interval.fn();
        }
      }
      now = target;
    },
  };
  return api;
}

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.binaryType = '';
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    FakeWebSocket.instances.push(this);
  }
  send(payload) { this.sent.push(payload); }
  close(code, reason) {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({code: code ?? 1000, reason: reason ?? ''});
  }
  /** Test helper: server accepts the socket. */
  accept() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
  /** Test helper: server pushes a control message. */
  deliver(message) { this.onmessage?.({data: JSON.stringify(message)}); }
  /** Test helper: server reports an abrupt transport failure. */
  drop(code = 1006, reason = '') {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({code, reason});
  }
}

async function buildContext({embedded = true, sessionRole = 'workspace_shell', webgl = false} = {}) {
  const source = await loadSource({sessionRole});
  const clock = makeClock();
  FakeWebSocket.instances.length = 0;

  const elements = new Map();
  const documentListeners = {};
  const windowListeners = {};
  const parentMessages = [];
  const terminals = [];
  let touchBindCount = 0;

  const document = {
    hidden: false,
    visibilityState: 'visible',
    documentElement: makeElement(),
    body: makeElement(),
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement());
      return elements.get(id);
    },
    createElement() { return makeElement(); },
    querySelector() { return makeElement(); },
    querySelectorAll() { return []; },
    addEventListener(type, fn) { (documentListeners[type] ||= []).push(fn); },
    fonts: {ready: {then() {}}},
    exitFullscreen() {},
  };
  // The terminal wrapper must report a real size so the client will connect.
  elements.set('terminal-wrapper', makeElement());

  const window = {
    location: {protocol: 'https:', host: 'example.test', origin: 'https://example.test'},
    addEventListener(type, fn) { (windowListeners[type] ||= []).push(fn); },
    parent: {postMessage(data) { parentMessages.push(data); }},
    matchMedia() { return {matches: false}; },
    WebConsoleTerminalTouch: {bind() { touchBindCount++; return {dispose() {}}; }},
    localStorage: {getItem() { return null; }, setItem() {}, removeItem() {}},
    navigator: {maxTouchPoints: 0, clipboard: {writeText() { return Promise.resolve(); }}},
  };
  if (webgl) {
    window.WebglAddon = {WebglAddon: class {
      constructor() { this.disposed = false; this.contextLossHandler = null; }
      onContextLoss(handler) { this.contextLossHandler = handler; }
      dispose() { this.disposed = true; }
    }};
  }

  class FakeTerminal {
    constructor() {
      this.opened = false;
      this.loadedAddons = [];
      terminals.push(this);
      this.element = null;
      this.modes = {mouseTrackingMode: 'none'};
      this.buffer = {
        active: {type: 'normal', viewportY: 0, baseY: 0},
        onBufferChange() {},
      };
      this._core = {viewport: {scrollBarWidth: 0}};
    }
    loadAddon(addon) { this.loadedAddons.push(addon); }
    open() { this.opened = true; }
    write(payload, cb) { cb?.(); }
  }
  // The template calls a large xterm surface; any unstubbed method is a no-op.
  const terminalTarget = FakeTerminal.prototype;
  for (const name of ['focus', 'paste', 'onScroll', 'onWriteParsed',
                      'onData', 'scrollToBottom', 'attachCustomKeyEventHandler',
                      'clear', 'reset', 'refresh', 'scrollToLine', 'hasSelection']) {
    terminalTarget[name] = function () {};
  }

  const context = vm.createContext({
    document,
    window,
    localStorage: window.localStorage,
    navigator: window.navigator,
    location: window.location,
    WebSocket: FakeWebSocket,
    Terminal: FakeTerminal,
    FitAddon: {FitAddon: class { proposeDimensions() { return {cols: 120, rows: 30}; } fit() {} }},
    WebLinksAddon: {WebLinksAddon: class {}},
    ResizeObserver: class { observe() {} disconnect() {} },
    pako: {inflate(x) { return x; }},
    URLSearchParams,
    TextEncoder,
    console,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    Date: {now: clock.now},
    Math,
    JSON,
    BigInt,
    ArrayBuffer,
    Uint8Array,
    DataView,
    Error,
    Set,
    Map,
    Promise,
  });
  // The template already rendered `const embedded = ...` via loadSource().
  vm.runInContext(source, context);
  // Test helpers toggle the fake document's visibility directly.
  context.__doc = document;
  // Drop the load-time timers (local-input UI schedules a resize on start) so
  // each test begins from a clean slate instead of inheriting a stray socket.
  clock.clearAll();
  FakeWebSocket.instances.length = 0;
  return {context, clock, parentMessages, documentListeners, windowListeners, elements,
    terminals,
    touchBindCount: () => touchBindCount};
}

function fire(listeners, type, event = {}) {
  for (const fn of listeners[type] || []) fn(event);
}

/** scheduleConnect(0) arms a zero-delay timer; flush it so the socket exists. */
function connectNow(context, clock) {
  vm.runInContext('scheduleConnect(0)', context);
  clock.advance(0);
  return FakeWebSocket.instances.at(-1);
}

test('WebGL renderer activates after xterm opens and disposes safely on context loss', async () => {
  const {terminals} = await buildContext({webgl:true});
  const terminal = terminals[0];
  assert.equal(terminal.opened, true);
  const addon = terminal.loadedAddons.find(item => typeof item.contextLossHandler === 'function');
  assert.ok(addon, 'the WebGL addon is loaded');
  addon.contextLossHandler();
  assert.equal(addon.disposed, true, 'disposing the addon lets xterm restore its built-in renderer');
});

test('a scheduled attempt is never abandoned when the pane is not measurable', async () => {
  const {context, clock, elements} = await buildContext();
  // Hide the terminal so proposeTerminalDimensions() returns null.
  elements.get('terminal-wrapper').getBoundingClientRect = () => ({width: 0, height: 0, top: 0, left: 0});

  vm.runInContext('connect()', context);
  assert.equal(FakeWebSocket.instances.length, 0, 'no socket while unmeasurable');

  // Before, connect() cleared the retry and returned: the view stayed dark
  // forever. It must now keep retrying until the parent resizes it.
  clock.advance(5000);
  assert.equal(FakeWebSocket.instances.length, 0, 'still unmeasurable, still no socket');
  clock.advance(5000);
  assert.equal(FakeWebSocket.instances.length, 0);

  // Once the pane has a size, the pending retry finally connects.
  elements.get('terminal-wrapper').getBoundingClientRect = () => ({width: 800, height: 400, top: 0, left: 0});
  clock.advance(5000);
  assert.equal(FakeWebSocket.instances.length, 1, 'retry connected after the pane became measurable');
});

test('a late heartbeat cannot bypass the backoff of a pending attempt', async () => {
  const {context, clock} = await buildContext();
  vm.runInContext('reconnectAttempts = 6; scheduleConnect(30000)', context);
  assert.equal(FakeWebSocket.instances.length, 0);

  // The heartbeat fires while the 30s backoff is still pending.
  clock.advance(25000);
  vm.runInContext('checkConnection()', context);
  assert.equal(FakeWebSocket.instances.length, 0, 'heartbeat honoured the pending backoff');

  clock.advance(5000);
  assert.equal(FakeWebSocket.instances.length, 1, 'the scheduled attempt ran at its own time');
});

test('the earliest pending attempt wins instead of stacking timers', async () => {
  const {context, clock} = await buildContext();
  vm.runInContext('scheduleConnect(30000)', context);
  vm.runInContext('scheduleConnect(1000)', context);
  vm.runInContext('scheduleConnect(20000)', context);
  assert.equal(FakeWebSocket.instances.length, 0);

  clock.advance(1000);
  assert.equal(FakeWebSocket.instances.length, 1, 'the shortest delay ran');
  // Settle the socket so the handshake watchdog cannot schedule another attempt.
  FakeWebSocket.instances[0].accept();
  FakeWebSocket.instances[0].deliver({type: 'ready', flow_version: 1});
  clock.advance(30000);
  assert.equal(FakeWebSocket.instances.length, 1, 'later requests did not spawn extra sockets');
});

test('a forced schedule overrides a long pending backoff', async () => {
  const {context, clock} = await buildContext();
  vm.runInContext('scheduleConnect(30000)', context);
  vm.runInContext('scheduleConnect(0, true)', context);
  clock.advance(0);
  assert.equal(FakeWebSocket.instances.length, 1, 'force connected immediately');
});

test('a socket that opens but never negotiates is closed and retried', async () => {
  const {context, clock} = await buildContext();
  const socket = connectNow(context, clock);
  socket.accept();

  // No "ready" arrives: the handshake watchdog must reclaim the view.
  clock.advance(15000);
  assert.equal(socket.readyState, FakeWebSocket.CLOSED, 'stalled handshake closed');
  assert.equal(vm.runInContext('transportReady', context), false);

  // The close schedules a retry rather than leaving the view stuck.
  clock.advance(1000);
  assert.ok(FakeWebSocket.instances.length >= 2, 'a retry followed the stalled handshake');
});

test('receiving ready clears the handshake watchdog', async () => {
  const {context, clock} = await buildContext();
  const socket = connectNow(context, clock);
  socket.accept();
  socket.deliver({type: 'ready', flow_version: 1});
  assert.equal(vm.runInContext('transportReady', context), true);

  clock.advance(60000);
  assert.equal(socket.readyState, FakeWebSocket.OPEN, 'a healthy socket is not closed by the watchdog');
});

test('a full client limit retries, an unknown session does not', async () => {
  const limited = await buildContext();
  const limitedSocket = connectNow(limited.context, limited.clock);
  limitedSocket.accept();
  limitedSocket.drop(1008, 'client-limit');

  assert.equal(vm.runInContext('sessionEnded', limited.context), false, 'capacity limit keeps the view alive');
  limited.clock.advance(5000);
  assert.ok(FakeWebSocket.instances.length >= 2, 'the limited view retried');

  const unknown = await buildContext();
  const unknownSocket = connectNow(unknown.context, unknown.clock);
  unknownSocket.accept();
  unknownSocket.drop(1008, 'session-unavailable');

  assert.equal(vm.runInContext('sessionEnded', unknown.context), true, 'a missing session stops retrying');
  unknown.clock.advance(120000);
  assert.equal(FakeWebSocket.instances.length, 1, 'no retry loop for a gone session');
});

test('a normal close backs off further on every consecutive failure', async () => {
  const {context, clock} = await buildContext();
  const first = connectNow(context, clock);
  first.accept();
  first.drop(1006);
  assert.equal(vm.runInContext('reconnectAttempts', context), 1);

  clock.advance(1500);
  assert.equal(FakeWebSocket.instances.length, 2, 'first retry after ~1s');
  FakeWebSocket.instances[1].accept();
  FakeWebSocket.instances[1].drop(1006);
  assert.equal(vm.runInContext('reconnectAttempts', context), 2);
});

test('a rendered screen resets the attempt counter', async () => {
  const {context} = await buildContext();
  vm.runInContext('reconnectAttempts = 7; markTerminalRendered()', context);
  assert.equal(vm.runInContext('reconnectAttempts', context), 0);
});

test('the heartbeat pings an open socket and reports latency', async () => {
  const {context, clock, documentListeners} = await buildContext();
  fire(documentListeners, 'DOMContentLoaded');
  clock.advance(0);
  const socket = FakeWebSocket.instances[0];
  socket.accept();
  socket.deliver({type: 'ready', flow_version: 1});
  socket.sent.length = 0;

  clock.advance(25000);
  assert.ok(socket.sent.some(p => p.includes('"type":"ping"')), 'heartbeat sent a ping');
  socket.deliver({type: 'pong'});
  assert.match(vm.runInContext('document.getElementById("status-latency").textContent', context), /\d+ms$/);
});

// --- Visibility: a hidden view detaches instead of fighting its own watchdog ---

/** Hide the document and fire the visibilitychange listeners. */
function hideDocument(context, documentListeners, clock) {
  context.__doc.hidden = true;
  context.__doc.visibilityState = 'hidden';
  fire(documentListeners, 'visibilitychange');
  clock.advance(0);
}

function showDocument(context, documentListeners, clock) {
  context.__doc.hidden = false;
  context.__doc.visibilityState = 'visible';
  fire(documentListeners, 'visibilitychange');
  clock.advance(0);
}

test('a hidden view detaches after the grace period, before the render watchdog', async () => {
  const {context, clock, documentListeners} = await buildContext();
  const socket = connectNow(context, clock);
  socket.accept();
  socket.deliver({type: 'ready', flow_version: 1});
  assert.equal(socket.readyState, FakeWebSocket.OPEN);

  hideDocument(context, documentListeners, clock);
  // Still attached during the grace period: a brief tab switch costs nothing.
  clock.advance(1000);
  assert.equal(socket.readyState, FakeWebSocket.OPEN, 'grace period keeps the attach');

  clock.advance(1500);
  assert.equal(socket.readyState, FakeWebSocket.CLOSED, 'hidden view released its attach');
  assert.equal(vm.runInContext('viewSuspended', context), true);
});

test('a suspended view never reconnects while it stays hidden', async () => {
  const {context, clock, documentListeners} = await buildContext();
  const socket = connectNow(context, clock);
  socket.accept();
  socket.deliver({type: 'ready', flow_version: 1});

  hideDocument(context, documentListeners, clock);
  clock.advance(3000);
  const count = FakeWebSocket.instances.length;
  assert.ok(count >= 1);

  // Heartbeat and scheduled attempts must both stay quiet while suspended.
  clock.advance(120000);
  assert.equal(FakeWebSocket.instances.length, count, 'no reconnect loop while hidden');
  assert.equal(vm.runInContext('sessionEnded', context), false, 'suspension is not a session end');
});

test('showing the view reconnects once and resets the backoff', async () => {
  const {context, clock, documentListeners} = await buildContext();
  vm.runInContext('reconnectAttempts = 5', context);
  const socket = connectNow(context, clock);
  socket.accept();
  socket.deliver({type: 'ready', flow_version: 1});

  hideDocument(context, documentListeners, clock);
  clock.advance(3000);
  const before = FakeWebSocket.instances.length;

  showDocument(context, documentListeners, clock);
  clock.advance(0);
  assert.equal(vm.runInContext('viewSuspended', context), false, 'view resumed');
  assert.equal(FakeWebSocket.instances.length, before + 1, 'resuming reconnected immediately');
  assert.equal(vm.runInContext('reconnectAttempts', context), 0, 'backoff reset on resume');
});

test('suspension discards the queued frames and disarms the lag watchdog', async () => {
  const {context, clock, documentListeners} = await buildContext();
  const socket = connectNow(context, clock);
  socket.accept();
  socket.deliver({type: 'ready', flow_version: 1});

  // Queue a frame but never let xterm finish writing it.
  vm.runInContext(`
    activeFlowState.queue.push({sequence: 1n, payload: new Uint8Array(8), queuedAt: Date.now()});
    activeFlowState.pendingBytes = 8;
    scheduleTerminalLagCheck(ws, activeFlowState);
  `, context);
  assert.ok(vm.runInContext('activeFlowState.lagTimer', context), 'watchdog armed');

  hideDocument(context, documentListeners, clock);
  clock.advance(3000);
  assert.equal(vm.runInContext('activeFlowState.lagTimer', context), null, 'watchdog cleared');
  assert.equal(vm.runInContext('activeFlowState.queue.length', context), 0, 'queue dropped');
  assert.equal(vm.runInContext('activeFlowState.pendingBytes', context), 0, 'pending bytes dropped');
});

test('a briefly hidden view keeps its attach when it comes back in time', async () => {
  const {context, clock, documentListeners} = await buildContext();
  const socket = connectNow(context, clock);
  socket.accept();
  socket.deliver({type: 'ready', flow_version: 1});

  hideDocument(context, documentListeners, clock);
  clock.advance(1000);
  showDocument(context, documentListeners, clock);
  clock.advance(5000);

  assert.equal(socket.readyState, FakeWebSocket.OPEN, 'attach survived a short hide');
  assert.equal(vm.runInContext('viewSuspended', context), false);
});

test('the workspace can suspend and resume the embedded view directly', async () => {
  const {context, clock, windowListeners} = await buildContext();
  const socket = connectNow(context, clock);
  socket.accept();
  socket.deliver({type: 'ready', flow_version: 1});

  // The iframe cannot observe display:none reliably, so the parent tells it.
  fire(windowListeners, 'message', {
    origin: 'https://example.test',
    source: context.window.parent,
    data: {type: 'webconsole:view-visibility', visible: false},
  });
  clock.advance(3000);
  assert.equal(vm.runInContext('viewSuspended', context), true, 'parent hid the view');

  fire(windowListeners, 'message', {
    origin: 'https://example.test',
    source: context.window.parent,
    data: {type: 'webconsole:view-visibility', visible: true},
  });
  clock.advance(0);
  assert.equal(vm.runInContext('viewSuspended', context), false, 'parent showed the view');
});

test('an inactive agent tab releases its attach immediately', async () => {
  const {context, clock, windowListeners} = await buildContext();
  const socket = connectNow(context, clock);
  socket.accept();
  socket.deliver({type: 'ready', flow_version: 1});

  fire(windowListeners, 'message', {
    origin:'https://example.test', source:context.window.parent,
    data:{type:'webconsole:view-visibility', visible:false, immediate:true},
  });

  assert.equal(socket.readyState, FakeWebSocket.CLOSED, 'inactive tabs do not retain a WebSocket');
  assert.equal(vm.runInContext('viewSuspended', context), true);
  clock.advance(120000);
  assert.equal(FakeWebSocket.instances.length, 1, 'suspended tab sends and receives no reconnect traffic');
});

test('mobile draft sends only on explicit tap and is never replayed after disconnect', async () => {
  const {context, clock, windowListeners, elements} = await buildContext({embedded:true});
  const parent = context.window.parent;
  fire(windowListeners, 'message', {
    origin:'https://example.test', source:parent,
    data:{type:'webconsole:session-state', session_id:'sess-1', input_allowed:true, state:'working'},
  });
  const socket = connectNow(context, clock);
  socket.accept();
  socket.deliver({type:'ready', flow_version:1});

  const draft = elements.get('mobile-terminal-draft');
  const send = elements.get('mobile-terminal-send');
  draft.value = 'echo móvil';
  fire(draft.listeners, 'input');
  assert.equal(socket.sent.length, 0, 'typing never sends keystrokes');
  assert.equal(send.disabled, false);

  fire(send.listeners, 'click');
  assert.equal(socket.sent.length, 1, 'explicit send emits one frame');
  assert.equal(new TextDecoder().decode(socket.sent[0]), 'echo móvil\r');
  assert.equal(draft.value, '');

  draft.value = 'not replayed';
  fire(draft.listeners, 'input');
  socket.drop();
  clock.advance(5000);
  assert.equal(draft.value, 'not replayed', 'the unsubmitted draft stays visible');
  assert.equal(socket.sent.length, 1, 'disconnect does not replay input');
});

test('a message from another origin cannot suspend the terminal', async () => {
  const {context, clock, windowListeners} = await buildContext();
  const socket = connectNow(context, clock);
  socket.accept();
  socket.deliver({type: 'ready', flow_version: 1});

  fire(windowListeners, 'message', {
    origin: 'https://evil.example',
    source: context.window.parent,
    data: {type: 'webconsole:view-visibility', visible: false},
  });
  clock.advance(3000);
  assert.equal(vm.runInContext('viewSuspended', context), false, 'cross-origin message ignored');
  assert.equal(socket.readyState, FakeWebSocket.OPEN, 'attach untouched');
});

function sendSidebarAction(windowListeners, parent, requestId = 'sidebar-test-1', sessionId = 'sess-1') {
  fire(windowListeners, 'message', {
    origin:'https://example.test', source:parent,
    data:{type:'webconsole:agent-action', action:'opencode-sidebar', session_id:sessionId, request_id:requestId},
  });
}

function allowAgentInput(windowListeners, parent, inputAllowed = true, sessionId = 'sess-1') {
  fire(windowListeners, 'message', {
    origin:'https://example.test', source:parent,
    data:{type:'webconsole:session-state', session_id:sessionId, input_allowed:inputAllowed, state:inputAllowed ? 'working' : 'permission'},
  });
}

test('OpenCode sidebar action sends Ctrl+X then b once and confirms only after both bytes', async () => {
  const {context, clock, windowListeners, parentMessages} = await buildContext({embedded:true, sessionRole:'agent'});
  const parent = context.window.parent;
  allowAgentInput(windowListeners, parent);
  const socket = connectNow(context, clock);
  socket.accept();
  socket.deliver({type:'ready', flow_version:1});
  socket.sent.length = 0;

  sendSidebarAction(windowListeners, parent);
  assert.deepEqual([...new TextDecoder().decode(socket.sent[0])], ['\x18']);
  assert.equal(socket.sent.length, 1, 'the leader is the only byte sent immediately');
  assert.equal(parentMessages.some(message => message.type === 'webconsole:action-result'), false, 'no early success ACK');
  sendSidebarAction(windowListeners, parent);
  assert.equal(socket.sent.length, 1, 'a duplicate request cannot interleave or repeat the leader');

  clock.advance(149);
  assert.equal(socket.sent.length, 1, 'the second key waits for the leader sequence');
  clock.advance(1);
  assert.equal(socket.sent.length, 2);
  assert.equal(new TextDecoder().decode(socket.sent[1]), 'b');
  const result = parentMessages.filter(message => message.type === 'webconsole:action-result').at(-1);
  assert.equal(result.type, 'webconsole:action-result');
  assert.equal(result.action, 'opencode-sidebar');
  assert.equal(result.session_id, 'sess-1');
  assert.equal(result.request_id, 'sidebar-test-1');
  assert.equal(result.success, true);
});

test('OpenCode sidebar action is rejected while disconnected, ended, or awaiting permission', async () => {
  for (const setup of ['permission', 'disconnected', 'ended']) {
    const {context, clock, windowListeners, parentMessages} = await buildContext({embedded:true, sessionRole:'agent'});
    const parent = context.window.parent;
    allowAgentInput(windowListeners, parent, setup !== 'permission');
    const socket = connectNow(context, clock);
    if (setup !== 'disconnected') {
      socket.accept();
      socket.deliver({type:'ready', flow_version:1});
    }
    if (setup === 'ended') vm.runInContext('sessionEnded = true', context);
    socket.sent.length = 0;

    sendSidebarAction(windowListeners, parent, `request-${setup}`);
    assert.equal(socket.sent.length, 0, `${setup}: no key bytes sent`);
    assert.equal(parentMessages.at(-1).success, false, `${setup}: failure reported`);
  }
});

test('OpenCode sidebar action is rejected outside an embedded agent or from a non-parent message', async () => {
  const workspaceShell = await buildContext({embedded:true, sessionRole:'workspace_shell'});
  allowAgentInput(workspaceShell.windowListeners, workspaceShell.context.window.parent);
  const shellSocket = connectNow(workspaceShell.context, workspaceShell.clock);
  shellSocket.accept();
  shellSocket.deliver({type:'ready', flow_version:1});
  shellSocket.sent.length = 0;
  sendSidebarAction(workspaceShell.windowListeners, workspaceShell.context.window.parent);
  assert.equal(shellSocket.sent.length, 0, 'workspace shell cannot receive agent-only action');
  assert.equal(workspaceShell.parentMessages.at(-1).success, false);

  const agent = await buildContext({embedded:true, sessionRole:'agent'});
  allowAgentInput(agent.windowListeners, agent.context.window.parent);
  const socket = connectNow(agent.context, agent.clock);
  socket.accept();
  socket.deliver({type:'ready', flow_version:1});
  socket.sent.length = 0;
  fire(agent.windowListeners, 'message', {
    origin:'https://evil.example', source:agent.context.window.parent,
    data:{type:'webconsole:agent-action', action:'opencode-sidebar', session_id:'sess-1', request_id:'forged-origin'},
  });
  fire(agent.windowListeners, 'message', {
    origin:'https://example.test', source:{},
    data:{type:'webconsole:agent-action', action:'opencode-sidebar', session_id:'sess-1', request_id:'forged-source'},
  });
  fire(agent.windowListeners, 'message', {
    origin:'https://example.test', source:agent.context.window.parent,
    data:{type:'webconsole:agent-action', action:'opencode-sidebar', session_id:'another-session', request_id:'wrong-session'},
  });
  agent.clock.advance(500);
  assert.equal(socket.sent.length, 0, 'cross-origin/non-parent requests send no bytes');
  assert.equal(agent.parentMessages.some(message => message.type === 'webconsole:action-result'
    && message.action === 'opencode-sidebar'), false);
});

test('OpenCode sidebar action cancels its second key after a socket drop and never replays it', async () => {
  const {context, clock, windowListeners, parentMessages} = await buildContext({embedded:true, sessionRole:'agent'});
  const parent = context.window.parent;
  allowAgentInput(windowListeners, parent);
  const firstSocket = connectNow(context, clock);
  firstSocket.accept();
  firstSocket.deliver({type:'ready', flow_version:1});
  firstSocket.sent.length = 0;

  sendSidebarAction(windowListeners, parent);
  assert.equal(new TextDecoder().decode(firstSocket.sent[0]), '\x18');
  firstSocket.drop();
  clock.advance(150);
  assert.equal(firstSocket.sent.length, 1, 'no b on the dropped socket');
  assert.equal(parentMessages.at(-1).success, false, 'partial sequence reported as incomplete');

  clock.advance(1000);
  const reconnectedSocket = FakeWebSocket.instances.at(-1);
  assert.notEqual(reconnectedSocket, firstSocket);
  reconnectedSocket.accept();
  reconnectedSocket.deliver({type:'ready', flow_version:1});
  clock.advance(1000);
  assert.equal(reconnectedSocket.sent.some(payload => payload instanceof Uint8Array
    && new TextDecoder().decode(payload) === 'b'), false, 'the second key is never replayed after reconnect');
});

test('OpenCode sidebar action cancels its second key when the parent immediately suspends the view', async () => {
  const {context, clock, windowListeners, parentMessages} = await buildContext({embedded:true, sessionRole:'agent'});
  const parent = context.window.parent;
  allowAgentInput(windowListeners, parent);
  const socket = connectNow(context, clock);
  socket.accept();
  socket.deliver({type:'ready', flow_version:1});
  socket.sent.length = 0;

  sendSidebarAction(windowListeners, parent);
  fire(windowListeners, 'message', {
    origin:'https://example.test', source:parent,
    data:{type:'webconsole:view-visibility', visible:false, immediate:true},
  });
  clock.advance(150);
  assert.equal(socket.sent.length, 1, 'view suspension cancels b');
  assert.equal(parentMessages.at(-1).success, false, 'cancelled sequence is reported');
});

test('a bfcache restore rebinds terminal touch scrolling', async () => {
  const {context, clock, windowListeners, touchBindCount} = await buildContext();
  const initialBindings = touchBindCount();
  const socket = connectNow(context, clock);
  socket.accept();
  socket.deliver({type: 'ready', flow_version: 1});

  fire(windowListeners, 'pagehide');
  assert.equal(socket.readyState, FakeWebSocket.CLOSED);
  fire(windowListeners, 'pageshow', {persisted: true});
  assert.equal(touchBindCount(), initialBindings + 1, 'touch handlers were bound again');
});

test('offline state waits for network recovery instead of opening a socket', async () => {
  const {context, clock, windowListeners} = await buildContext();
  context.navigator.onLine = false;
  vm.runInContext('scheduleConnect(0)', context);
  clock.advance(0);
  assert.equal(FakeWebSocket.instances.length, 0, 'no futile attempt while offline');
  assert.equal(vm.runInContext('document.getElementById("connection-badge").className', context),
    'connection-badge offline');

  context.navigator.onLine = true;
  fire(windowListeners, 'online');
  clock.advance(0);
  assert.equal(FakeWebSocket.instances.length, 1, 'online event retried immediately');
});
