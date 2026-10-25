import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const TEMPLATE = new URL('../../templates/workspace.html', import.meta.url);
const SOURCE = new URL('../../static/js/workspace.js', import.meta.url);
const STYLES = new URL('../../static/css/workspace.css', import.meta.url);

function control() {
  const attributes = new Map();
  return {
    hidden:false,
    attributes,
    setAttribute:(name, value) => attributes.set(name, value),
  };
}

test('desktop sidebars have persistent hide and restore controls on both edges', async () => {
  const html = await readFile(TEMPLATE, 'utf8');
  const source = await readFile(SOURCE, 'utf8');
  const css = await readFile(STYLES, 'utf8');
  assert.match(html, /id="collapse-project-sidebar"[^>]*aria-controls="project-sidebar"/);
  assert.match(html, /id="collapse-inspector-sidebar"[^>]*aria-controls="inspector"/);
  assert.match(html, /id="restore-project-sidebar"[^>]*aria-controls="project-sidebar"[^>]*hidden/);
  assert.match(html, /id="restore-inspector-sidebar"[^>]*aria-controls="inspector"[^>]*hidden/);
  assert.match(html, /id="workspace-tabs"/);
  assert.match(source, /function renderTabs\(\) \{\s*const strip = \$\('workspace-tabs'\)/);
  assert.match(css, /\.workbench\.project-sidebar-hidden\.inspector-hidden\s*\{grid-template-columns:minmax\(360px,1fr\)\}/);
  assert.match(css, /\.desktop-panel-collapse,\.workspace-panel-restore \{display:none!important\}/);

  const workbench = {classes:new Set(), classList:{toggle(name, enabled) {
    if (enabled) workbench.classes.add(name);
    else workbench.classes.delete(name);
  }}};
  const elements = {
    workbench,
    'collapse-project-sidebar':control(), 'restore-project-sidebar':control(),
    'collapse-inspector-sidebar':control(), 'restore-inspector-sidebar':control(),
  };
  const saved = new Map();
  const context = vm.createContext({
    state:{sidebarVisibility:{projects:true, inspector:true}},
    $:id => elements[id],
    localStorage:{setItem:(key, value) => saved.set(key, value)},
  });
  const start = source.indexOf('function setSidebarVisibility(');
  const end = source.indexOf('\nfunction toggleSidebarVisibility(', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(`${source.slice(start, end)}\nsetSidebarVisibility('projects', false); setSidebarVisibility('inspector', false);`, context);

  assert.deepEqual([...workbench.classes].sort(), ['inspector-hidden', 'project-sidebar-hidden']);
  assert.equal(elements['collapse-project-sidebar'].hidden, true);
  assert.equal(elements['restore-project-sidebar'].hidden, false);
  assert.equal(elements['restore-project-sidebar'].attributes.get('aria-expanded'), 'false');
  assert.equal(elements['restore-inspector-sidebar'].hidden, false);
  assert.equal(saved.get('webconsole.projectSidebarHidden'), 'true');
  assert.equal(saved.get('webconsole.inspectorSidebarHidden'), 'true');

  vm.runInContext(`setSidebarVisibility('projects', true);`, context);
  assert.equal(workbench.classes.has('project-sidebar-hidden'), false);
  assert.equal(elements['restore-project-sidebar'].hidden, true);
  assert.equal(elements['collapse-project-sidebar'].attributes.get('aria-expanded'), 'true');
});
