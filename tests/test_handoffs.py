import hashlib
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'app'))

from handoff_mcp import handle as handle_handoff_mcp
from handoffs import HandoffError, HandoffStore, normalize_opencode_export
from projects import ProjectStore


def opencode_export(session_id='ses-source123', cwd='/tmp/repo'):
    return {'data': {
        'info': {'id':session_id, 'title':'Login flow', 'time':{'created':1, 'updated':2},
                 'location':{'directory':cwd}},
        'messages': [
            {'id':'message-user', 'type':'user', 'time':{'created':1},
             'text':'Please review the login flow and identify remaining work.'},
            {'id':'message-system', 'type':'system', 'time':{'created':1}, 'text':'source system prompt'},
            {'id':'message-assistant', 'type':'assistant', 'time':{'created':2}, 'content':[
                {'type':'reasoning', 'text':'private internal reasoning'},
                {'type':'text', 'text':'I inspected the login flow.'},
                {'type':'tool', 'name':'read', 'state':{'status':'completed',
                    'input':{'file':'auth.py'}, 'output':'The route uses a session cookie.'}},
            ]},
        ],
    }}


def make_package(store, messages=None, mode='wait'):
    messages = messages or [{'index':0, 'role':'user', 'time':1, 'text':'Please continue.'}]
    preview = {'title':'Login flow', 'last_user':'Please continue.', 'last_assistant':'', 'warnings':[]}
    handoff_id = store.create(source_session_id='source123', native_session_id='ses-source123',
                              project_id='project123', workspace_id='workspace123', cwd='/tmp/repo',
                              source_title='Login flow', source_updated=2,
                              source_fingerprint=hashlib.sha256(b'transcript').hexdigest(),
                              messages=messages, preview=preview, token='secret-handoff-token', mode=mode)
    target_id = 'target123'
    store.claim_target(handoff_id, target_id, mode)
    store.update(handoff_id, state='awaiting_context')
    return handoff_id, target_id


def test_opencode_export_normalization_keeps_full_public_history_and_excludes_private_prompts():
    messages, preview = normalize_opencode_export(opencode_export(), 'ses-source123')

    assert [message['role'] for message in messages] == ['user', 'assistant']
    assert messages[0]['text'].startswith('Please review')
    assistant_text = messages[1]['text']
    assert 'I inspected the login flow.' in assistant_text
    assert 'The route uses a session cookie.' in assistant_text
    assert 'auth.py' in assistant_text
    assert 'private internal reasoning' not in assistant_text
    assert 'source system prompt' not in json.dumps(messages)
    assert preview['message_count'] == 2
    assert preview['tool_count'] == 1
    assert any('razonamiento interno' in warning for warning in preview['warnings'])
    with pytest.raises(HandoffError, match='otro directorio'):
        normalize_opencode_export(opencode_export(cwd='/tmp/elsewhere'), 'ses-source123', '/tmp/repo')


def test_handoff_store_is_private_paged_and_rejects_missing_packages(tmp_path):
    store = HandoffStore(tmp_path / 'state')
    long_text = 'x' * 30_000
    handoff_id, _ = make_package(store, [{'index':0, 'role':'user', 'text':long_text}])

    directory = tmp_path / 'state' / 'handoffs' / handoff_id
    assert directory.stat().st_mode & 0o777 == 0o700
    assert (directory / 'manifest.json').stat().st_mode & 0o777 == 0o600
    assert (directory / 'messages.json').stat().st_mode & 0o777 == 0o600
    assert (directory / 'continuity.json').stat().st_mode & 0o777 == 0o600
    assert store.get(handoff_id)['continuity']['destination_mode'] == 'wait'
    assert store.read_message_chunk(handoff_id, 0, 12_000, 12_000)['text'] == long_text[12_000:24_000]
    assert store.read_message_chunk(handoff_id, 0, 12_000, 12_000)['has_more'] is True

    with pytest.raises(HandoffError, match='no está disponible'):
        store.get('a' * 32)
    with pytest.raises(HandoffError, match='Rango'):
        store.read_message_chunk(handoff_id, 0, -1, 12)


def test_handoff_mcp_requires_target_session_binding_and_marks_context_received(tmp_path, monkeypatch):
    state = tmp_path / 'state'
    store = HandoffStore(state)
    handoff_id, target_id = make_package(store, [
        {'index':0, 'role':'user', 'time':1, 'text':'Please continue.'},
        {'index':1, 'role':'assistant', 'time':2, 'text':'A' * 5000},
    ], mode='continue')
    store.update(handoff_id, state='creating')
    session_file = state / f'{target_id}.json'
    session_file.write_text(json.dumps({'handoff_id':handoff_id, 'handoff_token':'secret-handoff-token',
                                        'project_id':'project123', 'session_role':'agent'}))
    session_file.chmod(0o600)
    monkeypatch.setenv('WEBCONSOLE_STATE_DIR', str(state))
    monkeypatch.setenv('WEBCONSOLE_SESSION_ID', target_id)
    monkeypatch.setenv('WEBCONSOLE_HANDOFF_ID', handoff_id)
    monkeypatch.setenv('WEBCONSOLE_HANDOFF_TOKEN', 'secret-handoff-token')

    manifest = handle_handoff_mcp({'jsonrpc':'2.0', 'id':1, 'method':'tools/call',
                                   'params':{'name':'webconsole_handoff_manifest', 'arguments':{}}})
    result = json.loads(manifest['result']['content'][0]['text'])
    assert result['state'] == 'received'
    assert result['continuity']['destination_mode'] == 'continue'
    assert 'mcp_token' not in result and 'token_hash' not in result
    assert store.update_if_state(handoff_id, {'creating'}, state='awaiting_context')['state'] == 'received'

    page = handle_handoff_mcp({'jsonrpc':'2.0', 'id':2, 'method':'tools/call',
                               'params':{'name':'webconsole_handoff_read_messages',
                                         'arguments':{'offset':1, 'limit':1}}})
    page_result = json.loads(page['result']['content'][0]['text'])
    assert page_result['messages'][0]['text_truncated'] is True
    assert page_result['messages'][0]['total_chars'] == 5000

    chunk = handle_handoff_mcp({'jsonrpc':'2.0', 'id':3, 'method':'tools/call',
                                'params':{'name':'webconsole_handoff_read_message',
                                          'arguments':{'index':1, 'offset':4200, 'limit':800}}})
    assert len(json.loads(chunk['result']['content'][0]['text'])['text']) == 800

    monkeypatch.setenv('WEBCONSOLE_HANDOFF_TOKEN', 'wrong-token')
    denied = handle_handoff_mcp({'jsonrpc':'2.0', 'id':4, 'method':'tools/call',
                                 'params':{'name':'webconsole_handoff_manifest', 'arguments':{}}})
    assert denied['result']['isError'] is True


def test_handoff_prepare_confirm_is_idempotent_and_preserves_source(tmp_path, monkeypatch):
    import server

    state = tmp_path / 'state'
    state.mkdir(mode=0o700)
    repo = tmp_path / 'repo'
    repo.mkdir()
    projects = ProjectStore(state)
    project = projects.add(str(repo), 'Handoff project')
    workspace = project['workspaces'][0]
    source_id = 'source123'
    source_token = 's' * 43
    source = {'session_token':source_token, 'launcher':'opencode', 'session_role':'agent',
              'project_id':project['id'], 'workspace_id':workspace['id'], 'cwd':str(repo),
              'title':'Review login', 'created_at':1, 'last_active':1, 'cols':120, 'rows':30}
    source_directory = state / source_id
    source_directory.mkdir(mode=0o700)
    ref = source_directory / 'opencode-session.json'
    ref.write_text(json.dumps({'session_id':'ses-source123', 'cwd':str(repo)}))
    ref.chmod(0o600)
    sessions, tokens = {source_id:source}, {source_id:source_token}
    created_tmux_sessions = []

    monkeypatch.setattr(server, 'TERMINAL_SESSIONS_DIR', state)
    monkeypatch.setattr(server, 'PROJECT_STORE', projects)
    monkeypatch.setattr(server, 'HANDOFF_STORE', HandoffStore(state))
    monkeypatch.setattr(server, 'terminal_sessions', sessions)
    monkeypatch.setattr(server, 'session_tokens', tokens)
    monkeypatch.setattr(server, 'session_alive', lambda _sid: True)
    monkeypatch.setattr(server.telemetry, 'sample', lambda force=False: None)
    monkeypatch.setattr(server.telemetry, 'payload', lambda _sid, _info: {
        'state':'idle', 'state_source':'event', 'notification':None})
    monkeypatch.setattr(server, 'agent_available', lambda _name: True)
    monkeypatch.setattr(server, 'agent_version', lambda _name: 'codex-cli test')
    monkeypatch.setattr(server, 'export_opencode_conversation', lambda _cwd, _sid: opencode_export(cwd=_cwd))

    def fake_tmux(*args, **_kwargs):
        if args[0] == 'new-session':
            target_id = args[3]
            created_tmux_sessions.append(target_id)
            # Simulate Codex's very first MCP call before the HTTP creator can
            # finish changing `creating` to `awaiting_context`.
            target_info = json.loads((state / f'{target_id}.json').read_text())
            monkeypatch.setenv('WEBCONSOLE_STATE_DIR', str(state))
            monkeypatch.setenv('WEBCONSOLE_SESSION_ID', target_id)
            monkeypatch.setenv('WEBCONSOLE_HANDOFF_ID', target_info['handoff_id'])
            monkeypatch.setenv('WEBCONSOLE_HANDOFF_TOKEN', target_info['handoff_token'])
            received = handle_handoff_mcp({'jsonrpc':'2.0', 'id':1, 'method':'tools/call',
                                           'params':{'name':'webconsole_handoff_manifest', 'arguments':{}}})
            assert received['result']['isError'] is False
        return SimpleNamespace(returncode=0, stdout='', stderr='')

    monkeypatch.setattr(server, 'tmux_command', fake_tmux)
    monkeypatch.delenv('WEBCONSOLE_PASSWORD', raising=False)
    client = server.app.test_client()
    headers = {'X-WebConsole':'1', 'Origin':'http://localhost', 'Content-Type':'application/json'}

    prepared = client.post(f'/api/sessions/{source_id}/handoffs', headers=headers,
                           json={'target_agent':'codex', 'mode':'wait'})
    assert prepared.status_code == 201
    handoff = prepared.get_json()['handoff']
    assert handoff['state'] == 'prepared'
    assert handoff['message_count'] == 2
    original_source = dict(source)

    first = client.post(f"/api/handoffs/{handoff['id']}/confirm", headers=headers, json={})
    assert first.status_code == 201
    target_id = first.get_json()['id']
    assert first.get_json()['handoff']['state'] == 'received'
    assert target_id != source_id
    assert sessions[source_id] == original_source
    assert len(created_tmux_sessions) == 1
    assert sessions[target_id]['handoff_source_session_id'] == source_id
    assert sessions[target_id]['handoff_mode'] == 'wait'

    retry = client.post(f"/api/handoffs/{handoff['id']}/confirm", headers=headers, json={})
    assert retry.status_code == 200
    assert retry.get_json()['id'] == target_id
    assert len(created_tmux_sessions) == 1


def test_handoff_refuses_permission_wait_and_changed_source_snapshot(tmp_path, monkeypatch):
    import server

    state = tmp_path / 'state'
    state.mkdir(mode=0o700)
    repo = tmp_path / 'repo'
    repo.mkdir()
    projects = ProjectStore(state)
    project = projects.add(str(repo), 'Handoff project')
    workspace = project['workspaces'][0]
    source_id = 'source123'
    source = {'session_token':'s' * 43, 'launcher':'opencode', 'session_role':'agent',
              'project_id':project['id'], 'workspace_id':workspace['id'], 'cwd':str(repo),
              'title':'Review login', 'created_at':1, 'last_active':1, 'cols':120, 'rows':30}
    source_directory = state / source_id
    source_directory.mkdir(mode=0o700)
    ref = source_directory / 'opencode-session.json'
    ref.write_text(json.dumps({'session_id':'ses-source123', 'cwd':str(repo)}))
    ref.chmod(0o600)
    monkeypatch.setattr(server, 'TERMINAL_SESSIONS_DIR', state)
    monkeypatch.setattr(server, 'PROJECT_STORE', projects)
    monkeypatch.setattr(server, 'HANDOFF_STORE', HandoffStore(state))
    monkeypatch.setattr(server, 'terminal_sessions', {source_id:source})
    monkeypatch.setattr(server, 'session_alive', lambda _sid: True)
    telemetry_state = {'state':'permission', 'state_source':'event', 'notification':None}
    monkeypatch.setattr(server.telemetry, 'sample', lambda force=False: None)
    monkeypatch.setattr(server.telemetry, 'payload', lambda _sid, _info: telemetry_state.copy())
    monkeypatch.setattr(server, 'agent_available', lambda _name: True)
    monkeypatch.setattr(server, 'export_opencode_conversation', lambda _cwd, _sid: opencode_export(cwd=_cwd))
    monkeypatch.delenv('WEBCONSOLE_PASSWORD', raising=False)
    client = server.app.test_client()
    headers = {'X-WebConsole':'1', 'Origin':'http://localhost', 'Content-Type':'application/json'}

    blocked = client.post(f'/api/sessions/{source_id}/handoffs', headers=headers,
                          json={'target_agent':'codex', 'mode':'continue'})
    assert blocked.status_code == 409
    assert 'permiso' in blocked.get_json()['error']

    telemetry_state['state'] = 'idle'
    prepared = client.post(f'/api/sessions/{source_id}/handoffs', headers=headers,
                           json={'target_agent':'codex', 'mode':'continue'})
    assert prepared.status_code == 201
    handoff_id = prepared.get_json()['handoff']['id']
    monkeypatch.setattr(server, 'export_opencode_conversation', lambda _cwd, _sid: {
        **opencode_export(cwd=_cwd), 'data':{**opencode_export(cwd=_cwd)['data'], 'messages':[
            {'id':'changed', 'type':'user', 'time':{'created':3}, 'text':'A newer request.'}]}})
    stale = client.post(f'/api/handoffs/{handoff_id}/confirm', headers=headers, json={})
    assert stale.status_code == 409
    assert 'cambió' in stale.get_json()['error']
    assert not any(info.get('launcher') == 'codex' for info in server.terminal_sessions.values())
