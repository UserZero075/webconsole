import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const TEMPLATE = new URL('../../templates/workspace.html', import.meta.url);
const SOURCE = new URL('../../static/js/workspace.js', import.meta.url);
const STYLES = new URL('../../static/css/workspace.css', import.meta.url);

test('Explorer modes, honest WebConsole session history, Source Control and Messages are present', async () => {
  const html = await readFile(TEMPLATE, 'utf8');
  const js = await readFile(SOURCE, 'utf8');
  const css = await readFile(STYLES, 'utf8');

  for (const mode of ['names', 'content']) assert.match(html, new RegExp(`data-explorer-mode="${mode}"`));
  for (const scope of ['workspace', 'project', 'all']) assert.match(html, new RegExp(`data-history-scope="${scope}"`));
  assert.match(html, /no es un índice de transcripciones/);
  assert.match(html, /id="message-section"/);
  assert.match(html, /id="commit-changes"/);
  assert.match(html, /id="stage-all"/);
  assert.match(html, /id="toggle-git-history"/);
  assert.match(html, /id="create-pr-form"/);
  assert.match(js, /function runWorkspaceSearch\(mode = state\.explorerMode\)/);
  assert.match(js, /generation !== state\.searchGeneration/);
  assert.match(js, /function renderAgentHistory\(\)/);
  assert.match(js, /function performGitAction\(action, paths = \[\]\)/);
  assert.match(js, /Esta acción no se puede deshacer/);
  assert.match(js, /\/pull-request/);
  assert.match(css, /body\.mobile-surface-history \.inspector \.history-section/);
  assert.match(css, /grid-template-columns:repeat\(6,minmax\(0,1fr\)\)/);
});
