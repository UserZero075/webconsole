import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {JSDOM} from '../../../tools/editor-assets/node_modules/jsdom/lib/api.js';

const viewportModule = await readFile(new URL('../../../static/js/mobile-viewport.js', import.meta.url), 'utf8');

test('visible viewport follows keyboard and rotation, ignores pinch zoom, and cleans up', () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {runScripts: 'outside-only', pretendToBeVisual: true});
  const {window} = dom;
  const callbacks = new Map();
  let nextFrame = 1;
  window.requestAnimationFrame = callback => {
    const id = nextFrame++;
    callbacks.set(id, callback);
    return id;
  };
  window.cancelAnimationFrame = id => callbacks.delete(id);
  const flush = () => {
    const pending = [...callbacks.values()];
    callbacks.clear();
    pending.forEach(callback => callback(0));
  };
  const visualViewport = new window.EventTarget();
  visualViewport.height = 800;
  visualViewport.offsetTop = 0;
  visualViewport.scale = 1;
  Object.defineProperty(window, 'visualViewport', {value: visualViewport, configurable: true});
  Object.defineProperty(window, 'innerHeight', {value: 800, configurable: true});

  window.eval(viewportModule);
  let notifications = 0;
  window.addEventListener('webconsole:viewportchange', () => notifications++);
  flush();
  assert.equal(window.document.documentElement.style.getPropertyValue('--webconsole-visible-height'), '800px');

  visualViewport.height = 470;
  visualViewport.dispatchEvent(new window.Event('resize'));
  flush();
  assert.equal(window.WebConsoleMobileViewport.height(), 470);
  assert.equal(window.document.documentElement.style.getPropertyValue('--webconsole-visible-height'), '470px');

  const countBeforeZoom = notifications;
  visualViewport.scale = 2;
  visualViewport.height = 300;
  visualViewport.dispatchEvent(new window.Event('resize'));
  flush();
  assert.equal(window.document.documentElement.style.getPropertyValue('--webconsole-visible-height'), '470px');
  assert.equal(notifications, countBeforeZoom);

  visualViewport.scale = 1;
  visualViewport.height = 800;
  visualViewport.offsetTop = 12;
  visualViewport.dispatchEvent(new window.Event('scroll'));
  flush();
  assert.equal(window.document.documentElement.style.getPropertyValue('--webconsole-visible-height'), '800px');
  assert.equal(window.document.documentElement.style.getPropertyValue('--webconsole-visible-top'), '12px');

  const countBeforeCleanup = notifications;
  window.WebConsoleMobileViewport.dispose();
  visualViewport.height = 600;
  visualViewport.dispatchEvent(new window.Event('resize'));
  flush();
  assert.equal(notifications, countBeforeCleanup);
  dom.window.close();
});
