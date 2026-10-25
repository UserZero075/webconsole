import hashlib
import gzip
import io
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'app'))
from coordination import CoordinationError, CoordinationStore
from coordination_mcp import handle as handle_mcp
from attachments import AttachmentError, AttachmentStore, MAX_ATTACHMENT_BYTES
from filesystem import FileAccessError, WorkspaceFiles
from git_service import create_worktree, inspect as inspect_git, parse_worktrees, remove_worktree
from projects import ProjectError, ProjectStore


def test_project_registry_is_private_atomic_and_rejects_duplicate_paths(tmp_path):
    state, repo = tmp_path / 'state', tmp_path / 'repo'
    repo.mkdir()
    store = ProjectStore(state)
    project = store.add(str(repo), 'Test repo')
    assert project['name'] == 'Test repo'
    assert project['workspaces'][0]['kind'] == 'primary'
    assert (state / 'projects.json').stat().st_mode & 0o777 == 0o600
    assert state.stat().st_mode & 0o777 == 0o700
    assert ProjectStore(state).get(project['id'])['path'] == str(repo.resolve())


def test_attachment_store_uses_private_generated_paths_and_prunes_only_owned_inactive_uploads(tmp_path):
    from werkzeug.datastructures import FileStorage

    store = AttachmentStore(tmp_path / 'state', tmp_path / 'tmp')
    uploaded = store.upload('session123', [FileStorage(
        stream=io.BytesIO(b'image-bytes'), filename='../../evil\nphoto.png', content_type='image/png')])[0]
    assert uploaded['name'] == 'evilphoto.png'
    assert uploaded['path'].startswith(str(tmp_path / 'tmp' / f'webconsole-attachments-{os.getuid()}'))
    assert Path(uploaded['path']).read_bytes() == b'image-bytes'
    directory = store.root / 'session123'
    assert directory.stat().st_mode & 0o777 == 0o700
    assert Path(uploaded['path']).stat().st_mode & 0o777 == 0o600
    assert store.get('session123', uploaded['id'])['path'] == uploaded['path']
    with pytest.raises(AttachmentError, match='No hay adjuntos'):
        store.get('session456', uploaded['id'])

    with pytest.raises(AttachmentError, match='vacío'):
        store.upload('session123', [FileStorage(stream=io.BytesIO(b''), filename='empty.png', content_type='image/png')])
    with pytest.raises(AttachmentError, match='Adjunta una imagen'):
        store.upload('session123', [FileStorage(stream=io.BytesIO(b'text'), filename='note.txt', content_type='text/plain')])

    old = store.upload('session456', [FileStorage(stream=io.BytesIO(b'%PDF'), filename='note.pdf', content_type='application/pdf')])[0]
    old_directory = store.root / 'session456'
    stale_time = time.time() - 100
    os.utime(old_directory, (stale_time, stale_time))
    assert store.prune({'session123'}, max_age=10) == 1
    assert not old_directory.exists()
    assert (store.root / 'session123' / Path(uploaded['path']).name).exists()


def test_tmux_attachment_alias_is_created_and_verified_in_the_tmux_command_context(tmp_path, monkeypatch):
    import server

    state = tmp_path / 'state'
    state.mkdir(mode=0o700)
    store = AttachmentStore(state, tmp_path / 'private-tmp')
    monkeypatch.setattr(server, 'TERMINAL_SESSIONS_DIR', state)
    monkeypatch.setattr(server, 'ATTACHMENT_STORE', store)

    def run_in_tmux_context(*args, **_kwargs):
        assert args[:2] == ('run-shell', '-b')
        subprocess.run(['/bin/sh', '-c', args[2]], check=True)
        return SimpleNamespace(returncode=0, stdout='', stderr='')

    monkeypatch.setattr(server, 'tmux_command', run_in_tmux_context)
    server.ensure_tmux_attachment_alias()
    assert store.alias.is_symlink()
    assert store.alias.resolve() == store.root.resolve()
    assert not list(state.glob('.attachment-alias-*'))


def test_attachment_api_requires_session_token_and_same_origin(tmp_path, monkeypatch):
    import server

    state = tmp_path / 'state'
    state.mkdir()
    token = 'a' * 43
    monkeypatch.setattr(server, 'terminal_sessions', {
        'agent123': {'session_token':token, 'launcher':'opencode'},
        'shell123': {'session_token':'b' * 43, 'launcher':'terminal', 'session_role':'workspace_shell'},
    })
    monkeypatch.setattr(server, 'session_tokens', {'agent123':token, 'shell123':'b' * 43})
    monkeypatch.setattr(server, 'ATTACHMENT_STORE', AttachmentStore(state, tmp_path / 'tmp'))
    monkeypatch.setattr(server, 'ensure_tmux_attachment_alias', lambda: None)
    monkeypatch.setattr(server, 'session_alive', lambda _sid: True)
    monkeypatch.delenv('WEBCONSOLE_PASSWORD', raising=False)
    client = server.app.test_client()
    url = '/api/sessions/agent123/attachments'

    denied = client.post(url, data={'files':(io.BytesIO(b'image'), 'photo.png', 'image/png')},
                         headers={'X-WebConsole':'1', 'X-WebConsole-Session':'wrong', 'Origin':'http://localhost'})
    assert denied.status_code == 403
    denied = client.post(url, data={'files':(io.BytesIO(b'image'), 'photo.png', 'image/png')},
                         headers={'X-WebConsole':'1', 'X-WebConsole-Session':token, 'Origin':'https://attacker.invalid'})
    assert denied.status_code == 403
    denied = client.post('/api/sessions/shell123/attachments',
                         data={'files':(io.BytesIO(b'image'), 'photo.png', 'image/png')},
                         headers={'X-WebConsole':'1', 'X-WebConsole-Session':'b' * 43, 'Origin':'http://localhost'})
    assert denied.status_code == 404

    uploaded = client.post(url, data={'files':(io.BytesIO(b'image'), 'photo.png', 'image/png')},
                           headers={'X-WebConsole':'1', 'X-WebConsole-Session':token, 'Origin':'http://localhost'})
    assert uploaded.status_code == 201
    attachment = uploaded.get_json()['attachments'][0]
    fetched = client.get(f"{url}/{attachment['id']}", headers={'X-WebConsole-Session':token, 'Origin':'http://localhost'})
    assert fetched.status_code == 200
    assert fetched.get_json()['attachment']['path'] == attachment['path']
    assert client.get(f"{url}/{attachment['id']}", headers={'X-WebConsole-Session':'wrong'}).status_code == 403


def test_workspace_terminal_is_reused_and_restarts_only_on_explicit_request(tmp_path, monkeypatch):
    import server

    state = tmp_path / 'state'
    state.mkdir()
    repo = tmp_path / 'repo'
    repo.mkdir()
    store = ProjectStore(state)
    project = store.add(str(repo), 'Terminal project')
    workspace = project['workspaces'][0]
    sessions, tokens = {}, {}
    calls = []
    alive = {'value':'0'}

    def fake_tmux(*args, check=True):
        calls.append(args)
        if args[0] == 'display-message':
            return SimpleNamespace(returncode=0, stdout=alive['value'] + '\n', stderr='')
        return SimpleNamespace(returncode=0, stdout='', stderr='')

    monkeypatch.setattr(server, 'PROJECT_STORE', store)
    monkeypatch.setattr(server, 'TERMINAL_SESSIONS_DIR', state)
    monkeypatch.setattr(server, 'terminal_sessions', sessions)
    monkeypatch.setattr(server, 'session_tokens', tokens)
    monkeypatch.setattr(server, 'tmux_command', fake_tmux)
    monkeypatch.delenv('WEBCONSOLE_PASSWORD', raising=False)
    client = server.app.test_client()
    headers = {'X-WebConsole':'1', 'Origin':'http://localhost', 'Content-Type':'application/json'}
    url = f"/api/workspaces/{workspace['id']}/terminal"

    created = client.post(url, headers=headers, json={'cwd':'/tmp'})
    assert created.status_code == 201
    first = created.get_json()['session']
    info = sessions[first['id']]
    assert info['session_role'] == 'workspace_shell'
    assert info['cwd'] == workspace['path']
    assert json.loads((state / f"{first['id']}.json").read_text())['session_role'] == 'workspace_shell'

    reused = client.post(url, headers=headers, json={})
    assert reused.status_code == 200
    assert reused.get_json()['session']['id'] == first['id']
    assert len([call for call in calls if call[0] == 'new-session']) == 1

    alive['value'] = '1'
    ended = client.post(url, headers=headers, json={})
    assert ended.status_code == 200 and ended.get_json()['session']['ended'] is True
    replacement = client.post(url, headers=headers, json={'new':True})
    assert replacement.status_code == 201
    assert replacement.get_json()['session']['id'] != first['id']
    assert len(sessions) == 2
    with pytest.raises(ProjectError, match='ya está registrado'):
        store.add(str(repo / '.'), 'Duplicate')


def test_project_registry_rejects_missing_directories_and_symlinked_registry(tmp_path):
    store = ProjectStore(tmp_path / 'state')
    with pytest.raises(ProjectError):
        store.add(str(tmp_path / 'missing'))
    store.state_dir.mkdir()
    target = tmp_path / 'other.json'
    target.write_text('{"version":1,"projects":[]}')
    store.path.symlink_to(target)
    with pytest.raises(ProjectError, match='enlace simbólico'):
        store.list()


def test_workspace_file_api_blocks_traversal_symlinks_binary_and_detects_conflicts(tmp_path):
    root = tmp_path / 'repo'
    root.mkdir()
    (root / 'src').mkdir()
    (root / 'src' / 'app.py').write_text('one\n', encoding='utf-8')
    (root / 'binary.dat').write_bytes(b'\x00\xff')
    (root / '.git').mkdir()
    outside = tmp_path / 'outside'
    outside.mkdir()
    (outside / 'secret.txt').write_text('secret')
    (root / 'linked').symlink_to(outside, target_is_directory=True)
    files = WorkspaceFiles(root)

    listing = files.list()
    assert '.git' not in [entry['name'] for entry in listing['entries']]
    with pytest.raises(FileAccessError):
        files.list('../')
    with pytest.raises(FileAccessError):
        files.read('linked/secret.txt')
    with pytest.raises(FileAccessError):
        files.read('binary.dat')
    with pytest.raises(FileAccessError):
        files.read('.git/config')

    original = files.read('src/app.py')
    (root / 'src' / 'app.py').write_text('agent changed\n', encoding='utf-8')
    with pytest.raises(FileAccessError) as error:
        files.write('src/app.py', 'my edit\n', original['revision'])
    assert error.value.status == 409
    assert 'agent changed' in (root / 'src' / 'app.py').read_text()

    current = files.read('src/app.py')
    saved = files.write('src/app.py', 'manual edit\n', current['revision'])
    assert saved['content'] == 'manual edit\n'
    assert saved['revision'] == hashlib.sha256(b'manual edit\n').hexdigest()

    swapped = tmp_path / 'swapped-root'
    swapped.symlink_to(outside, target_is_directory=True)
    with pytest.raises(FileAccessError):
        WorkspaceFiles(swapped)


def test_workspace_file_listing_does_not_require_read_access_to_filesystem_root(tmp_path, monkeypatch):
    root = tmp_path / 'repo'
    root.mkdir()
    (root / 'README.md').write_text('available')
    real_open = os.open

    def deny_root_read(path, flags, *args, **kwargs):
        if os.fspath(path) == os.sep and flags & os.O_DIRECTORY and not flags & os.O_PATH:
            raise PermissionError('filesystem root is traversable but not readable')
        return real_open(path, flags, *args, **kwargs)

    monkeypatch.setattr(os, 'open', deny_root_read)
    listing = WorkspaceFiles(root).list()
    assert [entry['name'] for entry in listing['entries']] == ['README.md']


def _git(directory, *args, env=None):
    merged = os.environ.copy()
    merged.update({'GIT_AUTHOR_NAME': 'WebConsole Test', 'GIT_AUTHOR_EMAIL': 'test@example.com',
                   'GIT_COMMITTER_NAME': 'WebConsole Test', 'GIT_COMMITTER_EMAIL': 'test@example.com'})
    if env:
        merged.update(env)
    return subprocess.run(['git', '-C', str(directory), *args], check=True, capture_output=True, text=True, env=merged)


def test_git_inspection_lists_local_branch_status_and_worktrees(tmp_path):
    repo = tmp_path / 'project with spaces'
    repo.mkdir()
    subprocess.run(['git', 'init', str(repo)], check=True, capture_output=True)
    _git(repo, 'checkout', '-b', 'main')
    (repo / 'README.md').write_text('initial')
    (repo / 'modified.txt').write_text('initial content')
    _git(repo, 'add', 'README.md', 'modified.txt')
    _git(repo, 'commit', '-m', 'initial')
    (repo / 'untracked file.txt').write_text('new')
    (repo / 'modified.txt').write_text('changed content')
    (repo / 'staged.txt').write_text('staged content')
    _git(repo, 'add', 'staged.txt')
    _git(repo, 'mv', 'README.md', 'renamed.md')

    info = inspect_git(repo)
    assert info['is_git'] is True
    assert info['branch'] == 'main'
    assert any(item['name'] == 'main' and item['kind'] == 'local' for item in info['branches'])
    assert any(item['path'] == 'untracked file.txt' and item['status'] == 'untracked' for item in info['changes'])
    assert any(item['path'] == 'modified.txt' and item['status'] == 'modified' and item['worktree'] == 'M' for item in info['changes'])
    assert any(item['path'] == 'staged.txt' and item['status'] == 'added' and item['index'] == 'A' for item in info['changes'])
    assert any(item['path'] == 'renamed.md' and item['index'] == 'R' for item in info['changes'])
    assert info['worktrees'][0]['path'] == str(repo)
    assert parse_worktrees('worktree /tmp/repo with spaces\nHEAD deadbeef\nbranch refs/heads/main\n\n')[0]['path'] == '/tmp/repo with spaces'


def test_project_and_message_api_scopes_sessions_to_project(tmp_path, monkeypatch):
    monkeypatch.setenv('WEBCONSOLE_STATE_DIR', str(tmp_path / 'state'))
    sys.path.insert(0, str(ROOT / 'app'))
    import server

    repo = tmp_path / 'source'
    repo.mkdir()
    monkeypatch.setattr(server, 'PROJECT_STORE', ProjectStore(tmp_path / 'state'))
    monkeypatch.setattr(server, 'COORDINATION_STORE', CoordinationStore(tmp_path / 'state'))
    monkeypatch.delenv('WEBCONSOLE_PASSWORD', raising=False)
    client = server.app.test_client()
    headers = {'X-WebConsole': '1', 'Content-Type': 'application/json'}
    response = client.post('/api/projects', headers=headers, json={'path': str(repo), 'name': 'Source'})
    assert response.status_code == 201
    project = response.get_json()['project']
    project_id = project['id']
    workspace = ProjectStore(tmp_path / 'state').get(project_id)['workspaces'][0]

    sid = 'agent123'
    target = {'project_id': project_id, 'workspace_id': workspace['id'], 'title': 'Reviewer', 'launcher': 'opencode'}
    (tmp_path / 'state' / f'{sid}.json').write_text(json.dumps(target))
    response = client.post(f'/api/projects/{project_id}/messages', headers=headers,
                           json={'recipient_session_id': sid, 'body': 'Please review the API changes.'})
    assert response.status_code == 201
    sent = response.get_json()['message']
    assert sent['state'] == 'pending'
    assert server.COORDINATION_STORE.inbox(sid, project_id)[0]['body'] == 'Please review the API changes.'
    assert server.COORDINATION_STORE.history(project_id)[0]['id'] == sent['id']

    other = ProjectStore(tmp_path / 'state').add(str(tmp_path), 'Other')
    with pytest.raises(CoordinationError, match='no pertenece'):
        server.COORDINATION_STORE.send(other['id'], sid, 'cross-project')


def test_coordination_mcp_authentication_is_bound_to_session_and_project(tmp_path, monkeypatch):
    store = CoordinationStore(tmp_path)
    info = {'project_id': 'project123456', 'coordination_token': 'secret-session-token', 'title': 'Builder'}
    (tmp_path / 'agent123.json').write_text(json.dumps(info))
    monkeypatch.setenv('WEBCONSOLE_SESSION_ID', 'agent123')
    monkeypatch.setenv('WEBCONSOLE_PROJECT_ID', 'project123456')
    monkeypatch.setenv('WEBCONSOLE_COORDINATION_TOKEN', 'wrong-token')
    with pytest.raises(CoordinationError, match='ausente o revocada'):
        store.authenticate_environment()
    monkeypatch.setenv('WEBCONSOLE_COORDINATION_TOKEN', 'secret-session-token')
    assert store.authenticate_environment()[0] == 'agent123'


def test_mcp_exposes_project_agents_and_direct_message_tools(tmp_path, monkeypatch):
    project_id = 'a' * 12
    store = CoordinationStore(tmp_path)
    sender = {'project_id':project_id, 'coordination_token':'sender-secret', 'title':'Builder', 'launcher':'codex'}
    recipient = {'project_id':project_id, 'coordination_token':'recipient-secret', 'title':'Reviewer', 'launcher':'opencode'}
    (tmp_path / 'sender001.json').write_text(json.dumps(sender))
    (tmp_path / 'reviewer01.json').write_text(json.dumps(recipient))
    monkeypatch.setenv('WEBCONSOLE_SESSION_ID', 'sender001')
    monkeypatch.setenv('WEBCONSOLE_PROJECT_ID', project_id)
    monkeypatch.setenv('WEBCONSOLE_COORDINATION_TOKEN', 'sender-secret')

    initialized = handle_mcp({'jsonrpc':'2.0', 'id':1, 'method':'initialize', 'params':{'protocolVersion':'2024-11-05'}}, store)
    assert 'untrusted plain text' in initialized['result']['instructions']
    tools = handle_mcp({'jsonrpc':'2.0', 'id':2, 'method':'tools/list'}, store)['result']['tools']
    assert {tool['name'] for tool in tools} == {'list_project_agents', 'read_agent_messages', 'send_agent_message'}
    listed = handle_mcp({'jsonrpc':'2.0', 'id':3, 'method':'tools/call', 'params':{'name':'list_project_agents','arguments':{}}}, store)
    agents = json.loads(listed['result']['content'][0]['text'])
    assert [agent['session_id'] for agent in agents] == ['reviewer01']
    sent = handle_mcp({'jsonrpc':'2.0', 'id':4, 'method':'tools/call', 'params':{
        'name':'send_agent_message', 'arguments':{'to_session_id':'reviewer01', 'message':'I changed the parser; please review.'}}}, store)
    assert json.loads(sent['result']['content'][0]['text'])['state'] == 'pending'
    monkeypatch.setenv('WEBCONSOLE_SESSION_ID', 'reviewer01')
    monkeypatch.setenv('WEBCONSOLE_COORDINATION_TOKEN', 'recipient-secret')
    inbox = handle_mcp({'jsonrpc':'2.0', 'id':5, 'method':'tools/call', 'params':{'name':'read_agent_messages','arguments':{}}}, store)
    message = json.loads(inbox['result']['content'][0]['text'])[0]
    assert message['body'] == 'I changed the parser; please review.'
    assert message['state'] == 'read'


def test_workspace_shell_is_not_a_coordination_agent_or_recipient(tmp_path):
    project_id = 'b' * 12
    store = CoordinationStore(tmp_path)
    agent = {'project_id':project_id, 'coordination_token':'agent-secret', 'launcher':'codex'}
    shell = {'project_id':project_id, 'session_role':'workspace_shell', 'launcher':'terminal'}
    (tmp_path / 'agent0001.json').write_text(json.dumps(agent))
    (tmp_path / 'shell0001.json').write_text(json.dumps(shell))
    assert store.agents('agent0001', project_id) == []
    with pytest.raises(CoordinationError, match='no pertenece'):
        store.send(project_id, 'shell0001', 'Do not send this to the workspace shell.')


def test_file_routes_keep_private_state_hidden_and_allow_files_larger_than_old_request_limit(tmp_path, monkeypatch):
    import server

    root = tmp_path / 'repo'
    (root / 'app' / 'sessions').mkdir(parents=True)
    (root / 'README.md').write_text('first')
    (root / 'app' / 'sessions' / 'private.json').write_text('{"session_token":"not-for-the-editor"}')
    store = ProjectStore(tmp_path / 'registry')
    project = store.add(str(root), 'Editor project')
    workspace = project['workspaces'][0]
    monkeypatch.setattr(server, 'PROJECT_STORE', store)
    monkeypatch.setattr(server, 'TERMINAL_SESSIONS_DIR', root / 'app' / 'sessions')
    monkeypatch.setattr(server, 'WORKTREE_DIR', tmp_path / 'worktrees')
    monkeypatch.delenv('WEBCONSOLE_PASSWORD', raising=False)
    client = server.app.test_client()
    headers = {'X-WebConsole': '1', 'Content-Type': 'application/json'}

    listing = client.get(f"/api/workspaces/{workspace['id']}/files").get_json()
    assert 'app' in [item['name'] for item in listing['entries']]
    app_listing = client.get(f"/api/workspaces/{workspace['id']}/files?path=app").get_json()
    assert 'sessions' not in [item['name'] for item in app_listing['entries']]
    forbidden = client.get(f"/api/workspaces/{workspace['id']}/file?path=app/sessions/private.json")
    assert forbidden.status_code == 403

    original = client.get(f"/api/workspaces/{workspace['id']}/file?path=README.md").get_json()
    content = 'x' * 90_000
    saved = client.put(f"/api/workspaces/{workspace['id']}/file", headers=headers,
                       json={'path':'README.md', 'content':content, 'revision':original['revision']})
    assert saved.status_code == 200
    assert (root / 'README.md').stat().st_size == 90_000
    assert client.put(f"/api/workspaces/{workspace['id']}/file", headers=headers,
                      json={'path':'../private', 'content':'x', 'revision':original['revision']}).status_code == 400


def test_git_worktree_creation_keeps_primary_checkout_on_its_branch(tmp_path):
    repo = tmp_path / 'repo'
    repo.mkdir()
    subprocess.run(['git', 'init', str(repo)], check=True, capture_output=True)
    _git(repo, 'checkout', '-b', 'main')
    (repo / 'README.md').write_text('initial')
    _git(repo, 'add', 'README.md')
    _git(repo, 'commit', '-m', 'initial')
    original = inspect_git(repo)
    created = create_worktree(repo, tmp_path / 'managed-worktrees', 'feature/work', 'refs/heads/main', 'Feature work')
    assert Path(created).is_dir()
    assert inspect_git(repo)['branch'] == 'main'
    assert inspect_git(created)['branch'] == 'feature/work'
    assert (Path(created) / 'README.md').read_text() == 'initial'
    assert len(inspect_git(repo)['worktrees']) == len(original['worktrees']) + 1


def test_git_worktree_removal_requires_clean_owned_worktree_and_keeps_branch(tmp_path):
    repo = tmp_path / 'repo'; repo.mkdir()
    subprocess.run(['git', 'init', str(repo)], check=True, capture_output=True)
    _git(repo, 'checkout', '-b', 'main')
    (repo / 'README.md').write_text('initial')
    _git(repo, 'add', 'README.md'); _git(repo, 'commit', '-m', 'initial')
    managed_parent = tmp_path / 'managed' / 'project123456'
    root = Path(create_worktree(repo, managed_parent, 'feature/keep-branch', 'refs/heads/main', 'Feature'))
    with pytest.raises(ValueError, match='administrado'):
        remove_worktree(repo, root, tmp_path / 'another-parent')
    assert root.is_dir()

    (root / 'local.txt').write_text('preserve this')
    with pytest.raises(ValueError, match='cambios'):
        remove_worktree(repo, root, managed_parent)
    assert (root / 'local.txt').read_text() == 'preserve this'

    (root / 'local.txt').unlink()
    (root / 'README.md').write_text('modified')
    with pytest.raises(ValueError, match='cambios'):
        remove_worktree(repo, root, managed_parent)
    assert (root / 'README.md').read_text() == 'modified'

    (root / 'README.md').write_text('initial')
    _git(root, 'checkout', '--', 'README.md')
    _git(repo, 'worktree', 'lock', '--reason', 'user lock', str(root))
    with pytest.raises(ValueError, match='bloqueado'):
        remove_worktree(repo, root, managed_parent)
    assert root.is_dir()
    _git(repo, 'worktree', 'unlock', str(root))
    removed = remove_worktree(repo, root, managed_parent)
    assert removed == str(root)
    assert not root.exists()
    assert _git(repo, 'show-ref', '--verify', '--quiet', 'refs/heads/feature/keep-branch').returncode == 0


@pytest.mark.parametrize('dirty_kind', ['modified', 'untracked', 'ignored'])
def test_workspace_delete_api_preserves_dirty_or_ignored_worktrees(tmp_path, monkeypatch, dirty_kind):
    import server

    repo = tmp_path / 'repo'; repo.mkdir()
    subprocess.run(['git', 'init', str(repo)], check=True, capture_output=True)
    _git(repo, 'checkout', '-b', 'main')
    (repo / 'README.md').write_text('initial')
    (repo / '.gitignore').write_text('ignored.dat\n')
    _git(repo, 'add', 'README.md', '.gitignore'); _git(repo, 'commit', '-m', 'initial')
    store = ProjectStore(tmp_path / 'state')
    project = store.add(str(repo), 'Project')
    managed_parent = tmp_path / 'worktrees' / project['id']
    root = Path(create_worktree(repo, managed_parent, f'feature/{dirty_kind}', 'refs/heads/main', 'Feature'))
    workspace = {'id':'workspace123', 'name':'Feature', 'path':str(root), 'worktree_root':str(root),
                 'kind':'managed_worktree', 'created_at':time.time(), 'branch':f'feature/{dirty_kind}'}
    store.add_workspace(project['id'], workspace)
    if dirty_kind == 'modified':
        (root / 'README.md').write_text('changed')
        preserved = root / 'README.md'
    else:
        preserved = root / ('ignored.dat' if dirty_kind == 'ignored' else 'new file.txt')
        preserved.write_text('keep me')

    monkeypatch.setattr(server, 'PROJECT_STORE', store)
    monkeypatch.setattr(server, 'WORKTREE_DIR', tmp_path / 'worktrees')
    monkeypatch.setattr(server, 'terminal_sessions', {})
    monkeypatch.delenv('WEBCONSOLE_PASSWORD', raising=False)
    client = server.app.test_client()
    response = client.delete(f"/api/workspaces/{workspace['id']}",
                             headers={'X-WebConsole':'1', 'Origin':'http://localhost'})
    assert response.status_code == 409
    assert preserved.read_text() == ('changed' if dirty_kind == 'modified' else 'keep me')
    assert root.is_dir()
    assert store.get_workspace(workspace['id'])[1]['path'] == str(root)


def test_workspace_delete_api_blocks_sessions_and_primary_or_external_workspaces(tmp_path, monkeypatch):
    import server

    repo = tmp_path / 'repo'; repo.mkdir()
    subprocess.run(['git', 'init', str(repo)], check=True, capture_output=True)
    _git(repo, 'checkout', '-b', 'main')
    (repo / 'README.md').write_text('initial')
    _git(repo, 'add', 'README.md'); _git(repo, 'commit', '-m', 'initial')
    store = ProjectStore(tmp_path / 'state')
    project = store.add(str(repo), 'Project')
    primary = project['workspaces'][0]
    managed_parent = tmp_path / 'worktrees' / project['id']
    root = Path(create_worktree(repo, managed_parent, 'feature/blocked', 'refs/heads/main', 'Feature'))
    managed = {'id':'workspace123', 'name':'Feature', 'path':str(root), 'worktree_root':str(root),
               'kind':'managed_worktree', 'created_at':time.time(), 'branch':'feature/blocked'}
    store.add_workspace(project['id'], managed)
    external_root = Path(create_worktree(repo, tmp_path / 'external', 'feature/external', 'refs/heads/main', 'External'))
    external = {'id':'external123', 'name':'External', 'path':str(external_root), 'worktree_root':str(external_root),
                'kind':'existing_worktree', 'created_at':time.time(), 'branch':'feature/external'}
    store.add_workspace(project['id'], external)
    monkeypatch.setattr(server, 'PROJECT_STORE', store)
    monkeypatch.setattr(server, 'WORKTREE_DIR', tmp_path / 'worktrees')
    monkeypatch.setattr(server, 'terminal_sessions', {
        'agent123456': {'project_id':project['id'], 'workspace_id':managed['id'], 'session_role':'agent'},
    })
    monkeypatch.delenv('WEBCONSOLE_PASSWORD', raising=False)
    client = server.app.test_client()
    headers = {'X-WebConsole':'1', 'Origin':'http://localhost'}

    assert client.delete(f"/api/workspaces/{primary['id']}", headers=headers).status_code == 409
    assert client.delete(f"/api/workspaces/{external['id']}", headers=headers).status_code == 409
    blocked = client.delete(f"/api/workspaces/{managed['id']}", headers=headers)
    assert blocked.status_code == 409 and 'sesiones asociadas' in blocked.get_json()['error']
    assert root.is_dir()
    assert store.get_workspace(managed['id'])[1] is not None


def test_workspace_delete_api_removes_clean_managed_tree_without_deleting_branch(tmp_path, monkeypatch):
    import server

    repo = tmp_path / 'repo'; repo.mkdir()
    project_root = repo / 'web'
    project_root.mkdir()
    subprocess.run(['git', 'init', str(repo)], check=True, capture_output=True)
    _git(repo, 'checkout', '-b', 'main')
    (project_root / 'README.md').write_text('initial')
    _git(repo, 'add', 'web/README.md'); _git(repo, 'commit', '-m', 'initial')
    store = ProjectStore(tmp_path / 'state')
    project = store.add(str(project_root), 'Project')
    managed_parent = tmp_path / 'worktrees' / project['id']
    root = Path(create_worktree(repo, managed_parent, 'feature/delete', 'refs/heads/main', 'Feature'))
    workspace_path = root / 'web'
    workspace = {'id':'workspace123', 'name':'Feature', 'path':str(workspace_path), 'worktree_root':str(root),
                 'kind':'managed_worktree', 'created_at':time.time(), 'branch':'feature/delete'}
    store.add_workspace(project['id'], workspace)
    monkeypatch.setattr(server, 'PROJECT_STORE', store)
    monkeypatch.setattr(server, 'WORKTREE_DIR', tmp_path / 'worktrees')
    monkeypatch.setattr(server, 'terminal_sessions', {})
    monkeypatch.delenv('WEBCONSOLE_PASSWORD', raising=False)
    client = server.app.test_client()

    assert client.delete(f"/api/workspaces/{workspace['id']}").status_code == 403
    assert client.delete(f"/api/workspaces/{workspace['id']}",
                         headers={'X-WebConsole':'1', 'Origin':'https://attacker.invalid'}).status_code == 403
    response = client.delete(f"/api/workspaces/{workspace['id']}",
                             headers={'X-WebConsole':'1', 'Origin':'http://localhost'})
    assert response.status_code == 200
    assert response.get_json()['success'] is True
    assert not root.exists()
    assert store.get_workspace(workspace['id']) == (None, None)
    assert _git(repo, 'show-ref', '--verify', '--quiet', 'refs/heads/feature/delete').returncode == 0


def test_project_delete_preserves_folder_and_refuses_sessions_or_managed_worktrees(tmp_path, monkeypatch):
    import server

    repo = tmp_path / 'repo'; repo.mkdir()
    store = ProjectStore(tmp_path / 'state')
    coordination = CoordinationStore(tmp_path / 'state')
    project = store.add(str(repo), 'Project')
    monkeypatch.setattr(server, 'PROJECT_STORE', store)
    monkeypatch.setattr(server, 'COORDINATION_STORE', coordination)
    monkeypatch.setattr(server, 'terminal_sessions', {})
    monkeypatch.delenv('WEBCONSOLE_PASSWORD', raising=False)
    client = server.app.test_client()
    headers = {'X-WebConsole':'1', 'Origin':'http://localhost'}

    renamed = client.patch(f"/api/projects/{project['id']}", headers=headers,
                           json={'name':'Renamed project'})
    assert renamed.status_code == 200
    assert store.get(project['id'])['name'] == 'Renamed project'
    removed = client.delete(f"/api/projects/{project['id']}", headers=headers)
    assert removed.status_code == 200
    assert store.get(project['id']) is None
    assert repo.is_dir() and (repo / '.').is_dir()

    project = store.add(str(repo), 'Blocked project')
    monkeypatch.setattr(server, 'terminal_sessions', {
        'agent123456': {'project_id':project['id'], 'workspace_id':project['workspaces'][0]['id']},
    })
    blocked = client.delete(f"/api/projects/{project['id']}", headers=headers)
    assert blocked.status_code == 409 and repo.is_dir()
    monkeypatch.setattr(server, 'terminal_sessions', {})

    subprocess.run(['git', 'init', str(repo)], check=True, capture_output=True)
    _git(repo, 'checkout', '-b', 'main')
    (repo / 'README.md').write_text('initial')
    _git(repo, 'add', 'README.md'); _git(repo, 'commit', '-m', 'initial')
    managed_parent = tmp_path / 'worktrees' / project['id']
    root = Path(create_worktree(repo, managed_parent, 'feature/project-block', 'refs/heads/main', 'Feature'))
    store.add_workspace(project['id'], {'id':'managed123', 'name':'Feature', 'path':str(root),
                        'worktree_root':str(root), 'kind':'managed_worktree', 'created_at':time.time(),
                        'branch':'feature/project-block'})
    blocked = client.delete(f"/api/projects/{project['id']}", headers=headers)
    assert blocked.status_code == 409
    assert root.is_dir() and store.get(project['id']) is not None


def test_workspace_context_actions_and_embedded_terminal_fill_available_height():
    workspace = (ROOT / 'static' / 'js' / 'workspace.js').read_text()
    workspace_html = (ROOT / 'templates' / 'workspace.html').read_text()
    workspace_css = (ROOT / 'static' / 'css' / 'workspace.css').read_text()
    console_html = (ROOT / 'templates' / 'console.html').read_text()
    console_css = (ROOT / 'static' / 'css' / 'console.css').read_text()

    assert "row.addEventListener('contextmenu'" in workspace
    assert "event.key !== 'ContextMenu'" in workspace
    assert 'function removeSession(session)' in workspace
    assert 'function removeProject(project)' in workspace
    assert 'function removeWorkspace(workspace)' in workspace
    assert 'id="context-menu"' in workspace_html
    assert 'embedded-terminal-document' in console_html
    assert 'terminalResizeObserver.observe' in console_html
    assert '.embedded-terminal-document body {height: 100%' in console_css
    assert '.context-menu-item' in workspace_css


def test_worktree_api_requires_a_known_branch_and_persists_created_workspace(tmp_path, monkeypatch):
    import server

    repo = tmp_path / 'repo'; repo.mkdir()
    subprocess.run(['git', 'init', str(repo)], check=True, capture_output=True)
    _git(repo, 'checkout', '-b', 'main')
    (repo / 'README.md').write_text('initial')
    _git(repo, 'add', 'README.md'); _git(repo, 'commit', '-m', 'initial')
    store = ProjectStore(tmp_path / 'state')
    project = store.add(str(repo), 'Routed repo')
    monkeypatch.setattr(server, 'PROJECT_STORE', store)
    monkeypatch.setattr(server, 'WORKTREE_DIR', tmp_path / 'external-worktrees')
    monkeypatch.delenv('WEBCONSOLE_PASSWORD', raising=False)
    client = server.app.test_client()
    headers = {'X-WebConsole':'1', 'Content-Type':'application/json'}

    invalid = client.post(f"/api/projects/{project['id']}/workspaces", headers=headers,
                          json={'branch':'invalid', 'base_ref':'refs/heads/not-real'})
    assert invalid.status_code == 400
    created = client.post(f"/api/projects/{project['id']}/workspaces", headers=headers,
                          json={'branch':'feature/routed', 'base_ref':'refs/heads/main', 'name':'Routed'})
    assert created.status_code == 201
    record = created.get_json()['workspace']
    assert record['kind'] == 'managed_worktree'
    assert record['branch'] == 'feature/routed'
    assert Path(record['path']).is_relative_to(tmp_path / 'external-worktrees')
    loaded = client.get(f"/api/projects/{project['id']}/workspaces").get_json()['workspaces']
    assert any(item['id'] == record['id'] and item['git']['branch'] == 'feature/routed' for item in loaded)


def test_workspace_routes_render_embed_policy_and_register_projects(tmp_path, monkeypatch):
    import server

    repo = tmp_path / 'repo'; repo.mkdir()
    monkeypatch.setattr(server, 'PROJECT_STORE', ProjectStore(tmp_path / 'state'))
    monkeypatch.setattr(server, 'terminal_sessions', {'session123': {'created_at': 1, 'last_active': 1, 'session_token':'t' * 43, 'cols':80, 'rows':24, 'cwd':str(repo)}})
    monkeypatch.setattr(server, 'session_tokens', {'session123': 't' * 43})
    monkeypatch.delenv('WEBCONSOLE_PASSWORD', raising=False)
    client = server.app.test_client()
    page = client.get('/')
    assert page.status_code == 200 and b'project-tree' in page.data
    assert page.headers['Cache-Control'] == 'no-store'
    assert b'/static/js/workspace.js?v=' in page.data
    assert client.get('/sessions').status_code == 404
    embedded = client.get('/c/' + 't' * 43 + '?embed=1')
    assert embedded.status_code == 200
    assert embedded.headers['X-Frame-Options'] == 'SAMEORIGIN'
    assert "frame-ancestors 'self'" in embedded.headers['Content-Security-Policy']
    assert b'<header class="terminal-header" hidden>' in embedded.data
    assert b'class="status-bar" hidden' in embedded.data
    assert b'https://fonts.googleapis.com' not in embedded.data
    assert b'/static/js/lib/xterm-531.js?v=' in embedded.data
    assert b'webconsole:terminal-status' in embedded.data
    assert b'[hidden] { display: none !important; }' in (ROOT / 'static' / 'css' / 'console.css').read_bytes()
    standard = client.get('/c/' + 't' * 43)
    assert standard.headers['X-Frame-Options'] == 'DENY'

    response = client.post('/api/projects', headers={'X-WebConsole':'1', 'Content-Type':'application/json'}, json={'path':str(repo)})
    assert response.status_code == 201
    assert client.get('/api/projects').get_json()['projects'][0]['name'] == 'repo'


def test_static_assets_are_fingerprinted_cached_and_gzipped(monkeypatch):
    import server

    monkeypatch.delenv('WEBCONSOLE_PASSWORD', raising=False)
    client = server.app.test_client()
    filename = 'js/lib/xterm-531.js'
    asset = ROOT / 'static' / filename
    version = server.static_asset_version(filename)

    compressed = client.get(f'/static/{filename}?v={version}', headers={'Accept-Encoding':'gzip'})
    assert compressed.status_code == 200
    assert compressed.headers['Content-Encoding'] == 'gzip'
    assert 'Accept-Encoding' in compressed.headers.get('Vary', '')
    assert compressed.headers['Cache-Control'] == 'public, max-age=31536000, immutable'
    assert gzip.decompress(compressed.data) == asset.read_bytes()
    assert len(compressed.data) < len(asset.read_bytes())

    cached = client.get(f'/static/{filename}?v={version}', headers={
        'Accept-Encoding':'gzip', 'If-None-Match':compressed.headers['ETag'],
    })
    assert cached.status_code == 304
    assert cached.headers['Cache-Control'] == 'public, max-age=31536000, immutable'

    identity = client.get(f'/static/{filename}?v={version}', headers={'Accept-Encoding':'identity'})
    assert identity.status_code == 200
    assert identity.headers.get('Content-Encoding') is None
    assert identity.data == asset.read_bytes()
    assert identity.headers['ETag'] != compressed.headers['ETag']

    unversioned = client.get(f'/static/{filename}', headers={'Accept-Encoding':'identity'})
    assert unversioned.headers['Cache-Control'] == 'public, max-age=0, must-revalidate'
    assert unversioned.headers.get('ETag')

    html = client.get('/', headers={'Accept-Encoding':'gzip'})
    assert html.status_code == 200 and html.headers['Content-Encoding'] == 'gzip'
    assert 'Accept-Encoding' in html.headers.get('Vary', '')
    assert html.headers['Cache-Control'] == 'no-store'
    assert b'id="terminal-loading"' in gzip.decompress(html.data)


def test_workspace_templates_auto_reload_when_source_changes():
    import server

    assert server.app.config['TEMPLATES_AUTO_RELOAD'] is True
    assert server.app.jinja_env.auto_reload is True


def test_embedded_terminal_loader_and_resize_contracts():
    server = (ROOT / 'app' / 'server.py').read_text()
    workspace = (ROOT / 'static' / 'js' / 'workspace.js').read_text()
    workspace_html = (ROOT / 'templates' / 'workspace.html').read_text()
    workspace_css = (ROOT / 'static' / 'css' / 'workspace.css').read_text()
    console_html = (ROOT / 'templates' / 'console.html').read_text()
    console_css = (ROOT / 'static' / 'css' / 'console.css').read_text()

    assert 'id="terminal-loading"' in workspace_html
    assert "asset_version('js/workspace.js')" in workspace_html
    assert 'function setTerminalFrameStatus(sessionId, status)' in workspace
    assert "data.type === 'webconsole:terminal-status'" in workspace
    assert 'La sesión no se ha reiniciado' in workspace
    assert 'response.status === 304 && cached' in workspace
    assert 'apiResponseCache.clear()' in workspace
    assert 'hmac.new(key, payload, hashlib.sha256)' in server
    assert "reportTerminalState(terminalHasRendered ? 'reconnecting' : 'connecting')" in console_html
    assert "reportTerminalState('rendered')" in console_html
    assert 'lastSentDimensions?.cols === dims.cols' in console_html
    assert 'terminal.reset();' not in console_html
    assert 'encode_terminal_flow_frame' in server
    assert "type:'ack', seq:item.sequence.toString()" in console_html
    assert 'TERMINAL_RENDER_LAG_MS = 4000' in console_html
    assert 'TERMINAL_RESYNC_COOLDOWN_MS = 8000' in console_html
    assert "reportTerminalState('resyncing')" in console_html
    assert "resyncing: ['Sincronizando la vista'" in workspace
    assert 'syncTerminalScrollbarWidth' in console_html
    assert 'coreViewport.scrollBarWidth = Math.max(0, viewport.offsetWidth - viewport.clientWidth)' in console_html
    assert 'https://fonts.googleapis.com' not in console_html
    assert 'lineHeight: 1.0' in console_html
    assert "xterm-addon-webgl-016.js?v={{ asset_version('js/lib/xterm-addon-webgl-016.js') }}" in console_html
    assert 'xterm-addon-webgl-017.js' not in console_html
    assert 'addon.onContextLoss(() =>' in console_html
    assert '.embedded-terminal .terminal-wrapper {padding: 0; width: 100%; height: 100%; background: var(--bg-terminal)}' in console_css
    assert '.embedded-terminal .xterm {\n    height: 100%;\n    width: 100%;\n    margin: 0;\n    padding: 0;\n}' in console_css
    assert '.embedded-terminal .xterm-viewport {width: 100%}' in console_css
    assert '.embedded-terminal .xterm-viewport {background-color: var(--bg-terminal) !important' not in console_css
    assert '.embedded-terminal .xterm-screen {width: 100%; height: 100%; background: var(--bg-terminal)}' not in console_css
    assert '.embedded-terminal .xterm-viewport {scrollbar-width: none}' in console_css
    assert '.embedded-terminal .xterm-viewport::-webkit-scrollbar {width: 0; height: 0}' in console_css
    assert 'html.embedded-terminal-document .terminal-app, html.embedded-terminal-document .terminal-wrapper {background-color: var(--bg-terminal)}' in console_css
    assert 'html.embedded-terminal-document .terminal-app { display:flex; width:100%; height:100%; min-height:0; flex-direction:column; background:{{ preferences.terminal_background }}; }' in console_html
    assert '--terminal-background: #0b0b0d' in workspace_css
    assert '.work-surface {position:relative; min-width:0; min-height:0; flex:1 1 0; overflow:hidden; background:var(--terminal-background); box-sizing:border-box}' in workspace_css
    assert '.work-surface iframe {position:absolute; inset:0; display:block; width:100%; height:100%; min-width:0; min-height:0; border:0; margin:0; padding:0; box-sizing:border-box; background:var(--terminal-background)}' in workspace_css
    assert '.workspace-terminal {height:35px; flex:0 0 35px; min-height:0; display:flex; flex-direction:column; overflow:hidden; background:#151618}' in workspace_css
    assert '.inspector {display:flex; flex-direction:column; background:#17181a}' in workspace_css
    assert '.terminal-loading[data-state="resyncing"]' in workspace_css
    assert 'prefers-reduced-motion:reduce' in workspace_css
    assert 'id="attachment-transfer-panel"' in console_html
    assert "request.upload.addEventListener('progress'" in console_html
    assert 'MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024' in console_html
    assert 'attachmentTransferStatus(item)' in console_html
    assert 'Subido · referencia insertada, no enviada' in console_html
    assert 'La subida tardó demasiado. Puedes reintentar.' in console_html
    assert "retry.textContent = 'Reintentar'" in console_html
    assert "type:'webconsole:upload-attachments'" in workspace
    assert 'files:[...files]' in workspace


def test_terminal_flow_frames_are_versioned_and_compressed_when_useful():
    import struct
    import zlib
    import server

    raw = b'\x1b[2Jterminal output\n' * 100
    compressed = server.encode_terminal_flow_frame(raw, 0x102030405)
    assert compressed[0] == 3
    assert struct.unpack('!Q', compressed[1:9])[0] == 0x102030405
    assert zlib.decompress(compressed[9:]) == raw

    small = b'\x1b[?25h'
    uncompressed = server.encode_terminal_flow_frame(small, 7)
    assert uncompressed == b'\x02' + struct.pack('!Q', 7) + small


def test_session_poll_uses_private_conditional_etag_and_refreshes_observation(monkeypatch):
    import server

    session_id, token = 'session12345', 's' * 43
    monkeypatch.setattr(server, 'terminal_sessions', {session_id: {
        'created_at':100, 'last_active':101, 'session_token':token, 'cols':80, 'rows':24, 'cwd':'/tmp',
    }})
    monkeypatch.setattr(server, 'session_tokens', {session_id:token})
    snapshot = {'observed_at':102.0, 'state':'idle'}
    monkeypatch.setattr(server.telemetry, 'sample', lambda force=False: None)
    monkeypatch.setattr(server.telemetry, 'payload', lambda _sid, _info: dict(snapshot))
    monkeypatch.setattr(server.telemetry, 'available', True)
    monkeypatch.setattr(server.telemetry, 'last_sample', 102.0)
    monkeypatch.delenv('WEBCONSOLE_PASSWORD', raising=False)
    client = server.app.test_client()

    first = client.get('/api/sessions')
    assert first.status_code == 200
    etag = first.headers['ETag']
    assert token not in etag
    assert first.headers['Cache-Control'] == 'no-store'
    assert first.get_json()['sessions'][0]['observed_at'] == 102.0

    snapshot['observed_at'] = 108.0
    monkeypatch.setattr(server.telemetry, 'last_sample', 108.0)
    unchanged = client.get('/api/sessions', headers={'If-None-Match':etag})
    assert unchanged.status_code == 304
    assert unchanged.data == b''
    assert unchanged.headers['X-WebConsole-Observed-At'] == '108.0'
    assert unchanged.headers['Cache-Control'] == 'no-store'

    snapshot['state'] = 'working'
    changed = client.get('/api/sessions', headers={'If-None-Match':etag})
    assert changed.status_code == 200
    assert changed.headers['ETag'] != etag
    assert changed.get_json()['sessions'][0]['state'] == 'working'
