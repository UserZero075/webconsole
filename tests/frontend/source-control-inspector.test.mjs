import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const TEMPLATE = new URL('../../templates/workspace.html', import.meta.url);
const SOURCE = new URL('../../static/js/workspace.js', import.meta.url);
const STYLES = new URL('../../static/css/workspace.css', import.meta.url);

test('the explorer and source-control panel expose Orca-style status and review controls', async () => {
  const html = await readFile(TEMPLATE, 'utf8');
  const js = await readFile(SOURCE, 'utf8');
  const css = await readFile(STYLES, 'utf8');

  assert.match(html, /id="collapse-file-tree"[^>]*aria-label="Contraer todo"/);
  assert.match(html, /id="toggle-dotfiles"[^>]*aria-pressed="true"/);
  assert.match(html, /id="git-search"[^>]*placeholder="Filtrar cambios"/);
  assert.match(html, /id="git-change-count"/);
  assert.match(js, /function buildGitDecorationMaps\(changes = \[\]\)/);
  assert.match(js, /function gitChangeAreas\(change\)/);
  assert.match(js, /function fileIconCategoryForPath\(path\)/);
  assert.match(js, /createExplorerIcon\(iconCategory\)/);
  assert.match(js, /openGitDiff\(change, section\.kind\)/);
  assert.match(css, /\.file-git-status\.modified/);
  assert.match(css, /\.file-entry\.git-status-modified \.file-name/);
  assert.match(css, /\.file-type-icon/);
  assert.match(css, /\.file-icon-javascript \{color:/);
  assert.match(css, /\.git-group-heading/);
  assert.match(css, /\.file-entry,\.git-entry \{min-height:42px/);
});

test('Git decorations propagate to folders and staged plus unstaged work appears in both sections', async () => {
  const source = await readFile(SOURCE, 'utf8');
  const start = source.indexOf('const GIT_STATUS_LABELS =');
  const end = source.indexOf('\nasync function loadDirectory', start);
  assert.ok(start >= 0 && end > start, 'Git status helpers are present');

  const context = vm.createContext({});
  vm.runInContext(source.slice(start, end), context);
  const changes = [
    {path:'src/app.js', status:'modified', index:' ', worktree:'M'},
    {path:'src/new.js', status:'untracked', index:'?', worktree:'?'},
    {path:'README.md', status:'modified', index:'M', worktree:' '},
    {path:'src/rewrite.js', status:'modified', index:'M', worktree:'M'},
    {path:'gone/file.txt', status:'deleted', index:' ', worktree:'D'},
  ];

  const maps = vm.runInContext('buildGitDecorationMaps(changes)', Object.assign(context, {changes}));
  assert.equal(maps.files.get('src/app.js'), 'modified');
  assert.equal(maps.files.get('src/new.js'), 'untracked');
  assert.equal(maps.folders.get('src'), 'modified');
  assert.equal(maps.folders.has('gone'), false);

  const flags = vm.runInContext('gitChangeAreas(changes[3])', context);
  assert.equal(flags.staged, true);
  assert.equal(flags.unstaged, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(changes.map(change =>
      vm.runInContext('gitChangeAreas(change)', Object.assign(context, {change}))))),
    [
      {staged:false, unstaged:true},
      {staged:false, unstaged:true},
      {staged:true, unstaged:false},
      {staged:true, unstaged:true},
      {staged:false, unstaged:true},
    ],
  );

  const categoryFor = path => vm.runInContext(
    'fileIconCategoryForPath(iconPath)', Object.assign(context, {iconPath:path}),
  );
  assert.equal(categoryFor('src/main.ts'), 'typescript');
  assert.equal(categoryFor('tools/check.py'), 'python');
  assert.equal(categoryFor('package.json'), 'package');
  assert.equal(categoryFor('.gitignore'), 'config');
  assert.equal(categoryFor('assets/logo.svg'), 'image');
  assert.equal(categoryFor('notes.unknown'), 'generic');
  assert.equal(categoryFor('src/file.constructor'), 'generic');
});
