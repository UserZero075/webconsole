import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'app'))

from filesystem import FileAccessError, WorkspaceFiles
from git_service import (GitError, commit_history, commit_staged, diff_stats, discard_paths,
                         inspect as inspect_git, stage_paths, unstage_paths)
from projects import ProjectStore


def git(directory, *args):
    env = os.environ.copy()
    env.update(GIT_AUTHOR_NAME='Inspector test', GIT_AUTHOR_EMAIL='inspector@example.test',
               GIT_COMMITTER_NAME='Inspector test', GIT_COMMITTER_EMAIL='inspector@example.test')
    return subprocess.run(['git', '-C', str(directory), *args], capture_output=True,
                          text=True, check=True, env=env)


def make_repo(directory):
    directory.mkdir(parents=True)
    git(directory, 'init', '-b', 'main')
    git(directory, 'config', 'user.name', 'Inspector test')
    git(directory, 'config', 'user.email', 'inspector@example.test')
    (directory / 'README.md').write_text('original\n', encoding='utf-8')
    git(directory, 'add', 'README.md')
    git(directory, 'commit', '-m', 'Initial commit')


def test_workspace_search_modes_filters_regex_and_symlink_boundary(tmp_path):
    root = tmp_path / 'repo'
    (root / 'src').mkdir(parents=True)
    (root / 'vendor').mkdir()
    (root / 'private').mkdir()
    (root / 'src' / 'app.py').write_text('Hello, world!\nhello workspace\n', encoding='utf-8')
    (root / 'src' / 'readme.txt').write_text('Hello, other file\n', encoding='utf-8')
    (root / 'vendor' / 'third.py').write_text('Hello, vendor\n', encoding='utf-8')
    (root / 'private' / 'state.py').write_text('Hello, secret\n', encoding='utf-8')
    (root / 'binary.dat').write_bytes(b'hello\x00binary')
    outside = tmp_path / 'outside'
    outside.mkdir()
    (outside / 'leak.py').write_text('Hello, outside', encoding='utf-8')
    (root / 'linked').symlink_to(outside, target_is_directory=True)
    files = WorkspaceFiles(root, forbidden_paths=(root / 'private',))

    names = files.search('app.py', mode='names')
    assert [item['path'] for item in names['results']] == ['src/app.py']
    filtered = files.search('Hello', mode='content', include='*.py', exclude='vendor/**')
    assert [(item['path'], item['line']) for item in filtered['results']] == [
        ('src/app.py', 1), ('src/app.py', 2),
    ]
    words = files.search('hello', mode='content', whole_word=True)
    assert [(item['path'], item['line']) for item in words['results']] == [
        ('src/app.py', 1), ('src/app.py', 2), ('src/readme.txt', 1), ('vendor/third.py', 1),
    ]
    regex = files.search(r'hello\s+workspace', mode='content', regex=True)
    assert [(item['path'], item['line']) for item in regex['results']] == [('src/app.py', 2)]
    with pytest.raises(FileAccessError, match='repetición'):
        files.search('(a+)+$', mode='content', regex=True)
    with pytest.raises(FileAccessError, match='límite'):
        files.search('a{10001}', mode='content', regex=True)
    assert files.search('secret', mode='content')['results'] == []


def test_workspace_search_api_requires_header_and_returns_line_locations(tmp_path, monkeypatch):
    import server

    root = tmp_path / 'repo'
    root.mkdir()
    (root / 'app.py').write_text('first\nneedle here\n', encoding='utf-8')
    store = ProjectStore(tmp_path / 'state')
    project = store.add(str(root), 'Search project')
    monkeypatch.setattr(server, 'PROJECT_STORE', store)
    monkeypatch.delenv('WEBCONSOLE_PASSWORD', raising=False)
    client = server.app.test_client()
    url = f"/api/workspaces/{project['workspaces'][0]['id']}/search"
    payload = {'query':'needle', 'mode':'content', 'case_sensitive':True}

    assert client.post(url, json=payload).status_code == 403
    response = client.post(url, headers={'X-WebConsole':'1', 'Origin':'http://localhost'}, json=payload)
    assert response.status_code == 200
    result = response.get_json()['results'][0]
    assert (result['path'], result['line'], result['column']) == ('app.py', 2, 1)
    assert 'needle here' in result['excerpt']


def test_git_inspector_actions_stats_and_commit_history_are_path_scoped(tmp_path):
    root = tmp_path / 'repo'
    make_repo(root)
    files = WorkspaceFiles(root)

    (root / 'README.md').write_text('discard me\n', encoding='utf-8')
    new_path = 'new [file].py'
    (root / new_path).write_text('print("new")\n', encoding='utf-8')
    discarded = discard_paths(root, files, ['README.md', new_path])
    assert (root / 'README.md').read_text() == 'original\n'
    assert not (root / new_path).exists()
    assert discarded['changes'] == []

    (root / 'README.md').write_text('prepared change\n', encoding='utf-8')
    (root / new_path).write_text('print("new")\n', encoding='utf-8')
    staged = stage_paths(root, files, ['README.md', new_path])
    assert all(item['index'] != ' ' for item in staged['changes'])
    assert diff_stats(root)['README.md']['staged']['additions'] == 1

    unstage_paths(root, files, [new_path])
    assert any(item['path'] == new_path and item['status'] == 'untracked'
               for item in inspect_git(root)['changes'])
    stage_paths(root, files, [new_path])
    committed = commit_staged(root, 'Inspector commit')
    assert committed['changes'] == []
    history = commit_history(root)
    assert history[0]['subject'] == 'Inspector commit'


def test_stage_and_discard_refuse_repository_clean_and_smudge_filters(tmp_path):
    root = tmp_path / 'repo'
    make_repo(root)
    files = WorkspaceFiles(root)
    (root / 'README.txt').write_text('tracked before filter setup\n', encoding='utf-8')
    git(root, 'add', 'README.txt')
    git(root, 'commit', '-m', 'Add text file')
    sentinel = tmp_path / 'filter-ran'
    git(root, 'config', 'filter.hostile.clean', f'touch {sentinel}; cat')
    git(root, 'config', 'filter.hostile.smudge', f'touch {sentinel}; cat')
    (root / '.gitattributes').write_text('*.txt filter=hostile\n', encoding='utf-8')

    (root / 'new.txt').write_text('new text\n', encoding='utf-8')
    inspect_git(root)
    diff_stats(root, files)
    assert not sentinel.exists(), 'status must not invoke a repository filter'
    with pytest.raises(GitError, match='filtro'):
        stage_paths(root, files, ['new.txt'])
    assert not sentinel.exists()

    git(root, 'add', '-f', '.gitattributes')
    git(root, 'commit', '-m', 'Add filter attributes')
    (root / 'README.txt').write_text('working change\n', encoding='utf-8')
    sentinel.unlink(missing_ok=True)
    with pytest.raises(GitError, match='filtro'):
        discard_paths(root, files, ['README.txt'])
    assert not sentinel.exists()


def test_git_action_and_history_routes_require_workspace_and_csrf_header(tmp_path, monkeypatch):
    import server

    root = tmp_path / 'repo'
    make_repo(root)
    (root / 'changed.txt').write_text('new file\n', encoding='utf-8')
    store = ProjectStore(tmp_path / 'state')
    project = store.add(str(root), 'Git project')
    monkeypatch.setattr(server, 'PROJECT_STORE', store)
    monkeypatch.delenv('WEBCONSOLE_PASSWORD', raising=False)
    client = server.app.test_client()
    workspace_id = project['workspaces'][0]['id']
    action_url = f'/api/workspaces/{workspace_id}/git/actions'
    headers = {'X-WebConsole':'1', 'Origin':'http://localhost'}

    assert client.get(f'/api/workspaces/{workspace_id}/git/history').status_code == 200
    assert client.get(f'/api/workspaces/{workspace_id}/git/stats').status_code == 200
    assert client.post(action_url, json={'action':'stage', 'paths':['changed.txt']}).status_code == 403
    response = client.post(action_url, headers=headers, json={'action':'stage', 'paths':['changed.txt']})
    assert response.status_code == 200
    assert response.get_json()['git']['changes'][0]['index'] == 'A'
    committed = client.post(action_url, headers=headers,
                            json={'action':'commit', 'message':'Route commit'})
    assert committed.status_code == 200
    assert commit_history(root)[0]['subject'] == 'Route commit'


def test_pull_request_creation_uses_argument_arrays_and_validates_branch_names(monkeypatch):
    import github_service

    commands = []
    monkeypatch.setattr(github_service, '_account', lambda: {'authenticated':True})
    monkeypatch.setattr(github_service, 'resolve_gh', lambda: '/usr/bin/gh')
    monkeypatch.setattr(github_service, '_run', lambda args, timeout=12: commands.append(args)
                        or 'https://github.com/example/project/pull/42\n')
    monkeypatch.setattr(github_service.subprocess, 'run', lambda args, **kwargs: SimpleNamespace(returncode=0))
    result = github_service.create_pull_request('/tmp/project', 'feature/work', 'main',
                                                'Safe title', 'body; still an argument')
    assert result['url'] == 'https://github.com/example/project/pull/42'
    assert commands[0][0:3] == ['/usr/bin/gh', 'pr', 'create']
    assert commands[0][-1] == '--body=body; still an argument'
    with pytest.raises(github_service.GitHubError):
        github_service.create_pull_request('/tmp/project', 'feature/work', 'main', '', '')
