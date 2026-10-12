import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

test('a save response never clears edits made while the request was in flight', async () => {
  const source = await readFile(new URL('../../static/js/workspace.js', import.meta.url), 'utf8');
  let finishRequest;
  const context = vm.createContext({
    document: {addEventListener() {}},
    fetch: () => new Promise(resolve => { finishRequest = resolve; }),
    URLSearchParams,
    console,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(source, context);
  vm.runInContext(`
    renderTabs = () => {};
    refreshGit = async () => {};
    toast = () => {};
  `, context);
  const tab = {
    id: 'file:w:note.js', type: 'file', workspaceId: 'w', path: 'note.js',
    content: 'submitted', revision: 'old', dirty: true, editGeneration: 4,
  };
  context.tab = tab;
  const pending = vm.runInContext('saveFile(tab)', context);
  tab.content = 'edited during save';
  tab.editGeneration = 5;
  finishRequest({
    ok: true,
    headers: {get: () => null},
    json: async () => ({content: 'submitted', revision: 'saved-revision'}),
  });
  await pending;
  assert.equal(tab.content, 'edited during save');
  assert.equal(tab.revision, 'saved-revision');
  assert.equal(tab.dirty, true);
});

test('reload asks again rather than overwriting edits made during its request', async () => {
  const source = await readFile(new URL('../../static/js/workspace.js', import.meta.url), 'utf8');
  let finishRequest;
  let confirmCalls = 0;
  const context = vm.createContext({
    document: {addEventListener() {}},
    fetch: () => new Promise(resolve => { finishRequest = resolve; }),
    confirm: () => ++confirmCalls === 1,
    URLSearchParams,
    console,
    setTimeout,
    clearTimeout,
  });
  vm.runInNewContext(source, context);
  vm.runInContext(`
    renderEditor = () => {};
    renderTabs = () => {};
    setEditorDocument = (tab, content) => { tab.content = content; };
  `, context);
  const tab = {
    id: 'file:w:note.js', type: 'file', workspaceId: 'w', path: 'note.js',
    content: 'before request', revision: 'old', dirty: true, editGeneration: 7,
  };
  context.tab = tab;
  vm.runInContext('state.tabs.push(tab); state.activeTabId = tab.id', context);
  const pending = vm.runInContext('reloadFile(tab)', context);
  tab.content = 'new edit';
  tab.editGeneration = 8;
  finishRequest({
    ok: true,
    headers: {get: () => null},
    json: async () => ({content: 'disk version', revision: 'new-revision'}),
  });
  await pending;
  assert.equal(confirmCalls, 2);
  assert.equal(tab.content, 'new edit');
  assert.equal(tab.revision, 'old');
  assert.equal(tab.dirty, true);
});
