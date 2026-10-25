import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const SOURCE = new URL('../../static/js/workspace.js', import.meta.url);

function element(width = 1440) {
  const listeners = new Map();
  const attributes = new Map();
  const style = new Map();
  const classes = new Set();
  return {
    clientWidth:width,
    style:{setProperty:(key, value) => style.set(key, value)},
    attributes,
    styleValues:style,
    classes,
    listeners,
    classList:{add:value => classes.add(value), remove:value => classes.delete(value)},
    setAttribute:(key, value) => attributes.set(key, value),
    addEventListener(type, listener) {
      const bucket = listeners.get(type) || [];
      bucket.push(listener);
      listeners.set(type, bucket);
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) || []).filter(item => item !== listener));
    },
    fire(type, event) { for (const listener of [...(listeners.get(type) || [])]) listener(event); },
    setPointerCapture(pointerId) { this.capturedPointer = pointerId; },
    hasPointerCapture(pointerId) { return this.capturedPointer === pointerId; },
    releasePointerCapture() { this.capturedPointer = null; },
  };
}

test('sidebar handles resize by pointer and keyboard, persist widths, and clamp to keep the center usable', async () => {
  const source = await readFile(SOURCE, 'utf8');
  const start = source.indexOf('function setupSidebarResizing()');
  const end = source.indexOf('\nfunction attachEvents()', start);
  const implementation = source.slice(start, end);
  assert.ok(start >= 0 && end > start, 'sidebar resizing setup is present');

  const workbench = element();
  const project = element();
  const inspector = element();
  const stored = new Map();
  const windowListeners = new Map();
  const context = vm.createContext({
    $:id => ({workbench, 'project-sidebar-resize':project, 'inspector-sidebar-resize':inspector}[id]),
    window:{innerWidth:1440, addEventListener(type, listener) { windowListeners.set(type, listener); }},
    document:{body:{classList:element().classList}},
    localStorage:{getItem:key => stored.get(key) ?? null, setItem:(key, value) => stored.set(key, value)},
  });
  vm.runInContext(`${implementation}\nsetupSidebarResizing();`, context);

  const pointer = (clientX, pointerId = 1) => ({
    button:0, clientX, pointerId, preventDefault() {},
  });
  project.fire('pointerdown', pointer(244));
  project.fire('pointermove', {clientX:294, pointerId:1});
  assert.equal(workbench.styleValues.get('--project-sidebar-width'), '294px');
  project.fire('pointerup', {});
  assert.equal(stored.get('webconsole.projectSidebarWidth'), '294');

  inspector.fire('pointerdown', pointer(1000, 2));
  inspector.fire('pointermove', {clientX:960, pointerId:2});
  assert.equal(workbench.styleValues.get('--inspector-width'), '340px');
  inspector.fire('pointerup', {});
  assert.equal(stored.get('webconsole.inspectorWidth'), '340');

  project.fire('pointerdown', pointer(300, 3));
  project.fire('pointermove', {clientX:1300, pointerId:3});
  assert.equal(workbench.styleValues.get('--project-sidebar-width'), '420px', 'the center pane retains its minimum width');
  project.fire('pointerup', {});

  let prevented = false;
  project.fire('keydown', {key:'ArrowLeft', preventDefault() { prevented = true; }});
  assert.equal(prevented, true);
  assert.equal(workbench.styleValues.get('--project-sidebar-width'), '400px');
  project.fire('keydown', {key:'Home', preventDefault() {}});
  assert.equal(workbench.styleValues.get('--project-sidebar-width'), '180px');
  assert.equal(project.attributes.get('aria-valuenow'), '180');
});
