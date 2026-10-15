import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const SOURCE = new URL('../../static/js/workspace.js', import.meta.url);

async function buildContext(fetchImpl = async () => ({
  ok:true, status:200, headers:{get:() => null}, json:async () => ({workspaces:[]}),
})) {
  const source = await readFile(SOURCE, 'utf8');
  const context = vm.createContext({
    document:{addEventListener() {}},
    fetch:fetchImpl,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
  });
  vm.runInContext(source, context);
  vm.runInContext('renderTree = () => {}', context);
  return {context, state:vm.runInContext('state', context), source};
}

test('expanding another project or branch changes only expansion state', async () => {
  const {context, state, source} = await buildContext();
  state.selectedProjectId = 'project-a';
  state.selectedWorkspaceId = 'branch-a';
  state.selectedSessionId = 'agent-a';
  state.activeTabId = 'terminal:agent-a';
  state.projects = [{id:'project-a'}, {id:'project-b'}];
  state.workspacesByProject.set('project-b', {workspaces:[{id:'branch-b'}]});

  vm.runInContext("toggleProjectExpansion('project-b'); toggleWorkspaceExpansion('branch-b')", context);

  assert.equal(state.expandedProjects.has('project-b'), true);
  assert.equal(state.expandedWorkspaces.has('branch-b'), true);
  assert.equal(state.selectedProjectId, 'project-a');
  assert.equal(state.selectedWorkspaceId, 'branch-a');
  assert.equal(state.selectedSessionId, 'agent-a');
  assert.equal(state.activeTabId, 'terminal:agent-a');
  assert.match(source, /toggle\.addEventListener\('click', \(\) => toggleProjectExpansion\(project\.id\)\)/);
  assert.match(source, /workspaceButton\.addEventListener\('click', \(\) => toggleWorkspaceExpansion\(workspace\.id\)\)/);
});

test('project workspace cache deduplicates requests and refreshes only when forced', async () => {
  let fetchCount = 0;
  let resolveFetch;
  const {context, state} = await buildContext(() => {
    fetchCount++;
    return new Promise(resolve => { resolveFetch = resolve; });
  });
  state.projects = [{id:'p'}];
  const first = vm.runInContext("loadProjectWorkspaces('p')", context);
  const duplicate = vm.runInContext("loadProjectWorkspaces('p')", context);
  assert.equal(fetchCount, 1, 'concurrent requests share a promise');

  const response = data => ({ok:true, status:200, headers:{get:() => null}, json:async () => data});
  resolveFetch(response({project:{id:'p'}, workspaces:[{id:'w1'}]}));
  const [data, sameData] = await Promise.all([first, duplicate]);
  assert.equal(data, sameData);
  assert.equal(state.workspacesByProject.get('p').workspaces[0].id, 'w1');
  const cached = vm.runInContext("loadProjectWorkspaces('p')", context);
  assert.equal(await cached, data);
  assert.equal(fetchCount, 1, 'cached expansion performs no request');

  const forced = vm.runInContext("loadProjectWorkspaces('p', {force:true})", context);
  assert.equal(fetchCount, 2, 'explicit inventory refresh fetches again');
  resolveFetch(response({project:{id:'p'}, workspaces:[{id:'w2'}]}));
  const refreshed = await forced;
  assert.equal(refreshed.workspaces[0].id, 'w2');
});

test('a delayed workspace response cannot repopulate a removed project', async () => {
  let resolveFetch;
  const {context, state} = await buildContext(() => new Promise(resolve => { resolveFetch = resolve; }));
  state.projects = [{id:'gone'}];
  const pending = vm.runInContext("loadProjectWorkspaces('gone')", context);
  state.projects = [];
  resolveFetch({ok:true, status:200, headers:{get:() => null}, json:async () => ({workspaces:[{id:'w'}]})});
  assert.equal(await pending, null);
  assert.equal(state.workspacesByProject.has('gone'), false);
});

test('open-project inventory refresh has a five-minute interval', async () => {
  const {context, state} = await buildContext();
  const interval = vm.runInContext('WORKSPACE_INVENTORY_REFRESH_MS', context);
  assert.equal(interval, 300_000);
  state.nextInventoryRefreshAt = 1_300_000;
  assert.equal(vm.runInContext('inventoryRefreshDue(1_299_999)', context), false);
  assert.equal(vm.runInContext('inventoryRefreshDue(1_300_000)', context), true);
});
