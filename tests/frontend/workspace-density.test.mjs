import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const STYLES = new URL('../../static/css/workspace.css', import.meta.url);
const TEMPLATE = new URL('../../templates/workspace.html', import.meta.url);

test('workspace controls live with Git instead of above the terminal', async () => {
  const css = await readFile(STYLES, 'utf8');
  const html = await readFile(TEMPLATE, 'utf8');
  assert.doesNotMatch(html, /<header class="topbar"/);
  assert.doesNotMatch(html, /class="pane-toolbar"/);
  assert.doesNotMatch(html, /id="add-project"|id="add-agent"/);
  assert.match(html, /<aside class="project-sidebar"[\s\S]*?id="open-preferences"/);
  assert.match(html, /<nav class="mobile-workspace-nav"[\s\S]*?id="toggle-projects"/);
  assert.match(html, /id="toggle-inspector"[^>]*aria-controls="inspector"/);
  assert.match(html, /<section class="git-section[\s\S]*?id="git-branch"[\s\S]*?class="workspace-context"[\s\S]*?id="branch-picker"[\s\S]*?id="new-worktree"[\s\S]*?id="mobile-shell-open"[\s\S]*?id="interrupt-agent"/);
  assert.match(css, /--workspace-top-offset:\s*0px/);
  assert.match(css, /\.tab-strip\s*\{height:27px; flex:0 0 27px/);
  assert.match(css, /\.tab\s*\{position:relative; min-width:100px; max-width:200px; height:27px/);
  assert.match(css, /\.tab-strip\s*\{height:40px; flex:0 0 40px/);
  assert.match(css, /grid-template-columns:repeat\(6,minmax\(0,1fr\)\)/);
  assert.match(css, /\.mobile-workspace-nav #toggle-projects \{display:flex\}/);
  assert.match(css, /\.mobile-workspace-nav #toggle-projects\[aria-expanded="true"\]/);
  assert.match(css, /#toggle-inspector \{display:none\}/);
  assert.match(css, /\.workspace-actions #mobile-shell-open \{display:inline-flex\}/);
  assert.match(css, /\.workspace-context \{padding:7px 12px 10px\}/);
  assert.match(css, /\.sidebar-heading \{height:48px; flex-basis:48px\}/);
  assert.match(css, /\.tab-strip \{height:35px; flex-basis:35px\}/);
});
