import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {JSDOM} from '../../../tools/editor-assets/node_modules/jsdom/lib/api.js';

const touchModule = await readFile(new URL('../../../static/js/terminal-touch.js', import.meta.url), 'utf8');
const xtermBundle = await readFile(new URL('../../../static/js/lib/xterm-531.js', import.meta.url), 'utf8');
const consoleTemplate = await readFile(new URL('../../../templates/console.html', import.meta.url), 'utf8');

function harness({mode = 'none', buffer = 'normal'} = {}) {
  const dom = new JSDOM('<main id="terminal"><div class="xterm-screen"></div></main>', {runScripts: 'outside-only'});
  const {window} = dom;
  window.eval(touchModule);
  const screen = window.document.querySelector('.xterm-screen');
  screen.getBoundingClientRect = () => ({height: 480, width: 800});
  const element = window.document.getElementById('terminal');
  const wheelEvents = [];
  let inputBytes = 0;
  element.addEventListener('wheel', event => wheelEvents.push(event));
  const terminal = {
    element,
    rows: 24,
    modes: {mouseTrackingMode: mode},
    buffer: {active: {type: buffer}},
    onData: data => { inputBytes += data.length; },
  };
  const states = [];
  const controller = window.WebConsoleTerminalTouch.bind(terminal, state => states.push(state));
  const makeTouch = (identifier, clientX, clientY) => ({identifier, clientX, clientY});
  const dispatchTouch = (type, touches, changedTouches = touches) => {
    const event = new window.Event(type, {bubbles: true, cancelable: true});
    Object.defineProperties(event, {
      touches: {value: touches},
      changedTouches: {value: changedTouches},
    });
    screen.dispatchEvent(event);
    return event;
  };
  return {dom, window, screen, terminal, controller, states, wheelEvents, makeTouch, dispatchTouch, inputBytes: () => inputBytes};
}

test('normal buffer touch remains xterm-owned and emits no terminal input', () => {
  const h = harness({mode: 'none', buffer: 'normal'});
  const start = h.makeTouch(1, 40, 100);
  h.dispatchTouch('touchstart', [start]);
  const move = h.dispatchTouch('touchmove', [h.makeTouch(1, 40, 60)]);
  assert.equal(move.defaultPrevented, false);
  assert.equal(h.wheelEvents.length, 0);
  assert.equal(h.inputBytes(), 0);
  h.controller.dispose();
  h.dom.window.close();
});

test('wheel-capable mouse modes receive only one native wheel event per crossed row', () => {
  const h = harness({mode: 'vt200', buffer: 'alternate'});
  h.dispatchTouch('touchstart', [h.makeTouch(1, 50, 100)]);
  const move = h.dispatchTouch('touchmove', [h.makeTouch(1, 50, 60)]);
  assert.equal(move.defaultPrevented, true);
  assert.deepEqual(h.wheelEvents.map(event => [event.deltaY, event.deltaMode]), [[1, 1], [1, 1]]);
  assert.deepEqual(h.states, ['wheel']);
  assert.equal(h.inputBytes(), 0, 'the adapter never calls xterm keyboard/data APIs');
  h.controller.dispose();
  h.dom.window.close();
});

test('x10 and alternate-screen mode without tracking show a fallback and emit no input', () => {
  for (const mode of ['x10', 'none']) {
    const h = harness({mode, buffer: 'alternate'});
    h.dispatchTouch('touchstart', [h.makeTouch(1, 50, 100)]);
    const move = h.dispatchTouch('touchmove', [h.makeTouch(1, 50, 80)]);
    assert.equal(move.defaultPrevented, true);
    assert.equal(h.wheelEvents.length, 0);
    assert.deepEqual(h.states, ['unsupported']);
    assert.equal(h.inputBytes(), 0);
    h.controller.dispose();
    h.dom.window.close();
  }
});

test('horizontal, multitouch, touchcancel, mode changes, and pointercancel abandon a gesture', () => {
  const h = harness({mode: 'vt200', buffer: 'alternate'});
  h.dispatchTouch('touchstart', [h.makeTouch(1, 40, 40)]);
  const horizontal = h.dispatchTouch('touchmove', [h.makeTouch(1, 62, 42)]);
  assert.equal(horizontal.defaultPrevented, false);
  assert.equal(h.wheelEvents.length, 0);

  h.dispatchTouch('touchstart', [h.makeTouch(1, 40, 40)]);
  h.dispatchTouch('touchmove', [h.makeTouch(1, 40, 20)]);
  assert.equal(h.wheelEvents.length, 1);
  h.terminal.modes.mouseTrackingMode = 'x10';
  h.dispatchTouch('touchmove', [h.makeTouch(1, 40, 0)]);
  assert.equal(h.wheelEvents.length, 1, 'mode change cancels further events');

  h.terminal.modes.mouseTrackingMode = 'vt200';
  h.dispatchTouch('touchstart', [h.makeTouch(1, 40, 40)]);
  h.dispatchTouch('touchstart', [h.makeTouch(1, 40, 40), h.makeTouch(2, 42, 40)]);
  h.dispatchTouch('touchmove', [h.makeTouch(1, 40, 0), h.makeTouch(2, 42, 40)]);
  assert.equal(h.wheelEvents.length, 1, 'multitouch cancels instead of emitting wheel events');

  h.dispatchTouch('touchstart', [h.makeTouch(1, 40, 40)]);
  h.dispatchTouch('touchcancel', [], [h.makeTouch(1, 40, 40)]);
  h.dispatchTouch('touchmove', [h.makeTouch(1, 40, 0)]);
  assert.equal(h.wheelEvents.length, 1, 'touchcancel clears the gesture');

  h.dispatchTouch('touchstart', [h.makeTouch(1, 40, 40)]);
  h.screen.dispatchEvent(new h.window.Event('pointercancel'));
  h.dispatchTouch('touchmove', [h.makeTouch(1, 40, 0)]);
  assert.equal(h.wheelEvents.length, 1, 'pointercancel clears the gesture');
  h.controller.dispose();
  h.dom.window.close();
});

test('the vendored xterm bundle exposes the expected mouse modes and native touch/wheel paths', () => {
  assert.match(xtermBundle, /X10:\{events:1,/);
  assert.match(xtermBundle, /VT200:\{events:19,/);
  assert.match(xtermBundle, /DRAG:\{events:23,/);
  assert.match(xtermBundle, /ANY:\{events:31,/);
  assert.match(xtermBundle, /"touchstart".*handleTouchStart/s);
  assert.match(xtermBundle, /"touchmove".*handleTouchMove/s);
  assert.match(xtermBundle, /case"wheel".*triggerMouseEvent/s);
});

test('console subscribes to xterm buffer changes through the buffer namespace API', () => {
  assert.match(xtermBundle, /this\.onBufferChange=this\._onBufferChange\.event/);
  assert.match(consoleTemplate, /terminal\.buffer\.onBufferChange\(/);
  assert.doesNotMatch(consoleTemplate, /terminal\.onBufferChange\(/);
});
