import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'app'))


def git(directory, *args):
    return subprocess.run(['git', '-C', str(directory), *args], check=True,
                          capture_output=True, text=True).stdout.strip()


def initialize_repo(directory):
    directory.mkdir()
    subprocess.run(['git', 'init', str(directory)], check=True, capture_output=True)
    git(directory, 'checkout', '-b', 'main')
    git(directory, 'config', 'user.name', 'Editor tests')
    git(directory, 'config', 'user.email', 'editor-tests@example.invalid')


def test_git_diff_route_compares_head_index_and_disk_without_mutating_repo(tmp_path, monkeypatch):
    import server
    from projects import ProjectStore

    repo = tmp_path / 'repo'
    initialize_repo(repo)
    (repo / 'note.md').write_text('before\n')
    (repo / 'remove.txt').write_text('delete me\n')
    (repo / 'rename-old.txt').write_text('rename base\n')
    (repo / 'odd\nü.txt').write_text('old unicode name\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'base')

    (repo / 'note.md').write_text('staged\n')
    git(repo, 'add', 'note.md')
    (repo / 'note.md').write_text('working tree\n')
    (repo / 'remove.txt').unlink()
    git(repo, 'add', 'remove.txt')
    git(repo, 'mv', 'rename-old.txt', 'rename-new.txt')
    (repo / 'new file.txt').write_text('untracked\n')
    (repo / 'odd\nü.txt').write_text('changed unicode name\n')
    git(repo, 'add', 'odd\nü.txt')
    original_head = git(repo, 'rev-parse', 'HEAD')
    original_index = (repo / '.git' / 'index').read_bytes()

    store = ProjectStore(tmp_path / 'state')
    project = store.add(str(repo), 'Diff test')
    monkeypatch.setattr(server, 'PROJECT_STORE', store)
    monkeypatch.setattr(server, 'WORKTREE_DIR', tmp_path / 'outside-worktrees')
    monkeypatch.delenv('WEBCONSOLE_PASSWORD', raising=False)
    client = server.app.test_client()
    workspace_id = project['workspaces'][0]['id']

    def get(path, kind):
        return client.get(f'/api/workspaces/{workspace_id}/diff', query_string={'path': path, 'kind': kind})

    staged = get('note.md', 'staged')
    assert staged.status_code == 200
    assert staged.get_json()['base'] == 'before\n'
    assert staged.get_json()['changed'] == 'staged\n'

    worktree = get('note.md', 'worktree')
    assert worktree.status_code == 200
    assert worktree.get_json()['base'] == 'staged\n'
    assert worktree.get_json()['changed'] == 'working tree\n'

    deleted = get('remove.txt', 'staged')
    assert deleted.status_code == 200
    assert deleted.get_json()['base'] == 'delete me\n'
    assert deleted.get_json()['changed'] == ''

    untracked = get('new file.txt', 'worktree')
    assert untracked.status_code == 200
    assert untracked.get_json()['base'] == ''
    assert untracked.get_json()['changed'] == 'untracked\n'

    renamed = get('rename-new.txt', 'staged')
    assert renamed.status_code == 200
    assert renamed.get_json()['base'] == 'rename base\n'
    assert renamed.get_json()['changed'] == 'rename base\n'

    unusual_path = get('odd\nü.txt', 'staged')
    assert unusual_path.status_code == 200
    assert unusual_path.get_json()['base'] == 'old unicode name\n'
    assert unusual_path.get_json()['changed'] == 'changed unicode name\n'
    assert git(repo, 'rev-parse', 'HEAD') == original_head
    assert (repo / '.git' / 'index').read_bytes() == original_index

    invalid = get('../outside', 'worktree')
    assert invalid.status_code == 400
    assert git(repo, 'status', '--porcelain')
    assert (repo / 'note.md').read_text() == 'working tree\n'


def test_git_diff_rejects_conflicts_binary_and_paths_outside_workspace(tmp_path, monkeypatch):
    import server
    from projects import ProjectStore

    repo = tmp_path / 'repo'
    initialize_repo(repo)
    (repo / 'inside').mkdir()
    (repo / 'outside.txt').write_text('private-ish repo sibling\n')
    (repo / 'inside' / 'tracked.txt').write_text('base\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'base')
    (repo / 'inside' / 'tracked.txt').write_bytes(b'\x00binary')

    store = ProjectStore(tmp_path / 'state')
    project = store.add(str(repo / 'inside'), 'Nested workspace')
    monkeypatch.setattr(server, 'PROJECT_STORE', store)
    monkeypatch.setattr(server, 'WORKTREE_DIR', tmp_path / 'outside-worktrees')
    monkeypatch.delenv('WEBCONSOLE_PASSWORD', raising=False)
    client = server.app.test_client()
    workspace_id = project['workspaces'][0]['id']

    binary = client.get(f'/api/workspaces/{workspace_id}/diff', query_string={
        'path': 'tracked.txt', 'kind': 'worktree',
    })
    assert binary.status_code == 415

    traversal = client.get(f'/api/workspaces/{workspace_id}/diff', query_string={
        'path': '../outside.txt', 'kind': 'staged',
    })
    assert traversal.status_code == 400
    assert 'private-ish repo sibling' not in traversal.get_data(as_text=True)

    invalid_kind = client.get(f'/api/workspaces/{workspace_id}/diff', query_string={
        'path': 'tracked.txt', 'kind': 'anything',
    })
    assert invalid_kind.status_code == 409


def test_git_diff_handles_unborn_head_and_index_conflicts(tmp_path):
    from filesystem import WorkspaceFiles
    from git_service import GitError, read_diff

    repo = tmp_path / 'unborn'
    initialize_repo(repo)
    (repo / 'new.txt').write_text('staged before first commit\n')
    git(repo, 'add', 'new.txt')
    files = WorkspaceFiles(str(repo))
    staged = read_diff(str(repo), {}, files, 'new.txt', 'staged')
    assert staged['base'] == ''
    assert staged['changed'] == 'staged before first commit\n'

    base = tmp_path / 'conflicts'
    initialize_repo(base)
    (base / 'conflict.txt').write_text('base\n')
    git(base, 'add', 'conflict.txt')
    git(base, 'commit', '-m', 'base')
    git(base, 'checkout', '-b', 'other')
    (base / 'conflict.txt').write_text('other\n')
    git(base, 'commit', '-am', 'other')
    git(base, 'checkout', 'main')
    (base / 'conflict.txt').write_text('main\n')
    git(base, 'commit', '-am', 'main')
    subprocess.run(['git', '-C', str(base), 'merge', 'other'], capture_output=True, check=False)
    assert git(base, 'ls-files', '-u')
    with pytest.raises(GitError, match='conflicto de índice'):
        read_diff(str(base), {}, WorkspaceFiles(str(base)), 'conflict.txt', 'worktree')


def test_git_diff_supports_linked_worktree_indexes(tmp_path):
    from filesystem import WorkspaceFiles
    from git_service import read_diff

    repo = tmp_path / 'primary'
    initialize_repo(repo)
    (repo / 'tracked.txt').write_text('base\n')
    git(repo, 'add', 'tracked.txt')
    git(repo, 'commit', '-m', 'base')
    worktree = tmp_path / 'linked'
    git(repo, 'worktree', 'add', '-b', 'diff-feature', str(worktree), 'main')
    (worktree / 'tracked.txt').write_text('worktree edit\n')
    diff = read_diff(str(worktree), {}, WorkspaceFiles(str(worktree)), 'tracked.txt', 'worktree')
    assert diff['base'] == 'base\n'
    assert diff['changed'] == 'worktree edit\n'


def test_editor_bundles_and_licenses_are_served_as_local_versioned_assets(monkeypatch):
    import server

    monkeypatch.delenv('WEBCONSOLE_PASSWORD', raising=False)
    client = server.app.test_client()
    page = client.get('/')
    assert page.status_code == 200
    assert b'/static/js/lib/editor/editor.js?v=' in page.data
    assert b'/static/js/lib/editor/markdown.js?v=' in page.data
    assert b'/static/js/lib/editor/merge.js?v=' in page.data
    assert b'https://fonts.googleapis.com' not in page.data

    for asset in (
        'js/lib/editor/editor.js', 'js/lib/editor/markdown.js',
        'js/lib/editor/merge.js', 'js/lib/editor/THIRD-PARTY-NOTICES.md',
    ):
        version = server.static_asset_version(asset)
        response = client.get(f'/static/{asset}?v={version}', headers={'Accept-Encoding': 'identity'})
        assert response.status_code == 200
        assert response.data
        assert response.headers['Cache-Control'] == 'public, max-age=31536000, immutable'
