import base64
import importlib.util
import threading
import os
import socket
import subprocess
import urllib.request
import time
import zlib
from pathlib import Path

import pytest
from werkzeug.serving import make_server
from websockets.sync.client import connect

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('webconsole_persistence_server', ROOT / 'app' / 'server.py')
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)
HEADERS = {'X-WebConsole': '1'}


@pytest.fixture(autouse=True)
def isolated_sessions(tmp_path, monkeypatch):
    server.terminal_sessions.clear()
    server.session_tokens.clear()
    monkeypatch.setattr(server, 'TERMINAL_SESSIONS_DIR', tmp_path)
    monkeypatch.setattr(server, 'TMUX_SOCKET', str(tmp_path / 'tmux.sock'))
    monkeypatch.delenv('WEBCONSOLE_PASSWORD', raising=False)
    monkeypatch.delenv('PUBLIC_ORIGIN', raising=False)
    yield
    server.tmux_command('kill-server', check=False)
    server.terminal_sessions.clear()
    server.session_tokens.clear()


@pytest.fixture
def live_server():
    http = make_server('127.0.0.1', 0, server.app, threaded=True)
    thread = threading.Thread(target=http.serve_forever, daemon=True)
    thread.start()
    yield f'http://127.0.0.1:{http.server_port}'
    http.shutdown()
    thread.join(timeout=3)


def create_session():
    response = server.app.test_client().post('/api/sessions', headers=HEADERS)
    assert response.status_code == 201, response.data
    return response.get_json()


def read_until(ws, expected):
    output = bytearray()
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        frame = ws.recv(timeout=3)
        if isinstance(frame, bytes):
            output.extend(zlib.decompress(frame[1:]) if frame[0] == 1 else frame[1:])
        if expected in output:
            return bytes(output)
    pytest.fail(f'No terminal redraw containing {expected!r}: {output!r}')


def test_health_reports_process_uptime(monkeypatch):
    monkeypatch.setattr(server, 'SERVER_STARTED_MONOTONIC', 10_000)
    monkeypatch.setattr(server.time, 'monotonic', lambda: 10_123)
    response = server.app.test_client().get('/health')
    assert response.get_json()['uptime_seconds'] == 123


def test_disconnect_reconnect_and_metadata_reload_preserve_running_tool(live_server):
    data = create_session()
    sid, token = data['id'], data['token']
    shell_pid = server.tmux_command('display-message', '-p', '-t', sid, '#{pane_pid}').stdout.strip()
    url = live_server.replace('http:', 'ws:') + f'/ws/{sid}?token={token}&cols=120&rows=30'
    with connect(url, origin=live_server) as ws:
        read_until(ws, b'\x1b')
        ws.send(b"printf '\\033[2J\\033[H'; export RESUME_MARKER=survived; sleep 2; printf 'TOOL_STILL_RUNNING\\n'; sleep 60\r")
        time.sleep(0.1)
    # The detached tool produces output while no browser is present.
    time.sleep(2.3)
    with connect(url, origin=live_server) as ws:
        read_until(ws, b'TOOL_STILL_RUNNING')
        same_pid = server.tmux_command('display-message', '-p', '-t', sid, '#{pane_pid}').stdout.strip()
        assert same_pid == shell_pid
        ws.send(b'\x03')
        ws.send(b"printf 'ENV=%s\\n' \"$RESUME_MARKER\"\r")
        read_until(ws, b'ENV=survived')
    deadline = time.monotonic() + 3
    while server.terminal_sessions[sid]['clients'] and time.monotonic() < deadline:
        time.sleep(0.05)
    assert server.terminal_sessions[sid]['clients'] == 0
    # Simulate losing all Python session state during an HTTP server restart.
    server.terminal_sessions.clear()
    server.session_tokens.clear()
    server.load_sessions()
    assert server.app.test_client().get(f'/c/{token}').status_code == 200
    with connect(url, origin=live_server) as ws:
        read_until(ws, b'ENV=survived')
    assert server.session_alive(sid)


def test_two_tabs_receive_the_same_output(live_server):
    data = create_session()
    url = live_server.replace('http:', 'ws:') + f"/ws/{data['id']}?token={data['token']}"
    with connect(url, origin=live_server) as first, connect(url, origin=live_server) as second:
        read_until(first, b'\x1b')
        read_until(second, b'\x1b')
        first.send(b"printf 'BOTH_TABS_123\\n'\r")
        read_until(first, b'BOTH_TABS_123')
        read_until(second, b'BOTH_TABS_123')


def test_unknown_url_does_not_create_session():
    client = server.app.test_client()
    assert client.get('/c/unknown').status_code == 404
    assert not server.terminal_sessions


def test_security_guards_and_private_metadata():
    client = server.app.test_client()
    assert client.post('/api/sessions').status_code == 403
    assert client.post('/api/sessions', headers={**HEADERS, 'Origin': 'https://evil.example'}).status_code == 403
    data = create_session()
    path = server.TERMINAL_SESSIONS_DIR / f"{data['id']}.json"
    assert path.stat().st_mode & 0o777 == 0o600
    for suffix, origin in [(f"?token={data['token']}", 'https://evil.example'), ('?token=wrong', 'http://localhost')]:
        response = client.get(f"/ws/{data['id']}{suffix}", headers={'Origin': origin})
        assert response.status_code == 403
    response = client.get(data['url'])
    assert response.headers['Referrer-Policy'] == 'no-referrer'
    assert response.headers['Cache-Control'] == 'no-store'
    assert response.headers['X-Frame-Options'] == 'DENY'
    assert server.sanitize_session_id('bad/session') is None


def test_optional_password_protects_dashboard_and_api(monkeypatch):
    monkeypatch.setenv('WEBCONSOLE_PASSWORD', 'test-password')
    client = server.app.test_client()
    assert client.get('/').status_code == 401
    assert client.get('/api/sessions').status_code == 401
    authorization = base64.b64encode(b'user:test-password').decode()
    assert client.get('/', headers={'Authorization': 'Basic ' + authorization}).status_code == 200
    assert client.get('/api/sessions').status_code == 200


def test_delete_revokes_url_and_stops_tmux_session():
    data = create_session()
    client = server.app.test_client()
    assert client.delete(f"/api/sessions/{data['id']}", headers=HEADERS).status_code == 200
    assert not server.session_alive(data['id'])
    assert client.get(data['url']).status_code == 404
    assert not list(server.TERMINAL_SESSIONS_DIR.glob('*.json'))


def test_ended_shell_is_not_restarted():
    data = create_session()
    server.tmux_command('send-keys', '-t', data['id'], 'exit', 'Enter')
    deadline = time.monotonic() + 3
    while server.session_alive(data['id']) and time.monotonic() < deadline:
        time.sleep(0.05)
    assert not server.session_alive(data['id'])
    assert server.app.test_client().get('/api/sessions').get_json()['sessions'][0]['is_active'] is False


def test_dashboard_uses_backend_uptime_instead_of_page_load_time():
    source = (ROOT / 'static' / 'js' / 'app.js').read_text()
    html = (ROOT / 'templates' / 'index.html').read_text()
    assert 'uptime_seconds' in source
    assert 'let startTime = Date.now()' not in source
    assert 'refreshUptime();' in source
    assert 'defer' in html


def test_real_http_process_restart_keeps_tmux_tool(tmp_path):
    # Start a separate HTTP process, stop it, and reopen the same URL after restart.
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    origin = f'http://127.0.0.1:{port}'
    env = os.environ.copy()
    env.update(WEBCONSOLE_STATE_DIR=str(tmp_path), HOST='127.0.0.1', PORT=str(port))
    env.pop('WEBCONSOLE_PASSWORD', None)
    env.pop('PUBLIC_ORIGIN', None)

    def start_http():
        process = subprocess.Popen([os.sys.executable, str(ROOT / 'app' / 'server.py')],
                                   env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                try:
                    with urllib.request.urlopen(origin + '/health', timeout=0.2):
                        return process
                except (OSError, TimeoutError):
                    if process.poll() is not None:
                        pytest.fail('HTTP server exited before becoming ready')
                    time.sleep(0.05)
            pytest.fail('HTTP server did not start')
        except BaseException:
            process.terminate()
            process.wait(timeout=3)
            raise

    process = start_http()
    try:
        import json
        request = urllib.request.Request(origin + '/api/sessions', method='POST', headers=HEADERS)
        with urllib.request.urlopen(request) as response:
            data = json.load(response)
        url = origin.replace('http:', 'ws:') + f"/ws/{data['id']}?token={data['token']}"
        with connect(url, origin=origin) as ws:
            read_until(ws, b'\x1b')
            ws.send(b"printf '\\033[2J\\033[H'; sleep 1; printf 'AFTER_HTTP_RESTART\\n'; sleep 60\r")
            time.sleep(0.1)
            process.terminate()
            process.wait(timeout=3)
        time.sleep(1.2)
        assert server.session_alive(data['id'])
        process = start_http()
        with urllib.request.urlopen(origin + data['url']) as response:
            assert response.status == 200
        with connect(url, origin=origin) as ws:
            read_until(ws, b'AFTER_HTTP_RESTART')
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=3)


def test_dashboard_observes_agent_without_terminal_attachment_and_ack_persists(tmp_path):
    # Controlled local stand-in, without launching a paid agent or touching its config.
    import json
    import shlex
    worker = tmp_path / 'fake_agent.py'
    worker.write_text("import ctypes, time\nctypes.CDLL(None).prctl(15, b'codex', 0, 0, 0)\nprint('Would you like to run the following command?', flush=True)\nprint('  pytest tests/security -q', flush=True)\ntime.sleep(30)\n")
    data = create_session()
    sid = data['id']
    server.tmux_command('send-keys', '-t', sid, shlex.join([os.sys.executable, str(worker)]), 'Enter')
    client = server.app.test_client()
    deadline = time.monotonic() + 4
    observed = None
    while time.monotonic() < deadline:
        server.telemetry.sample(force=True)
        observed = client.get('/api/sessions').get_json()['sessions'][0]
        if (observed.get('notification') or {}).get('kind') == 'permission':
            break
        time.sleep(0.05)
    assert observed['agent']['name'] == 'Codex'
    assert observed['state'] == 'permission'
    assert observed['state_source'] == 'estimated'
    assert 'pytest tests/security' in observed['preview']
    assert observed['activity']
    fingerprint = observed['notification']['fingerprint']
    assert client.post(f'/api/sessions/{sid}/acknowledge', json={'fingerprint': fingerprint}, headers=HEADERS).status_code == 200
    stored = json.loads((tmp_path / f'{sid}.json').read_text())
    assert stored['dismissed_notification'] == fingerprint
    assert stored['notification'] is None
    assert client.post(f'/api/sessions/{sid}/acknowledge', json={'fingerprint': 'stale'}, headers=HEADERS).status_code == 409


def test_native_event_spool_works_from_per_session_shell_environment(tmp_path):
    import shlex
    import json
    data = create_session()
    command = shlex.join([os.sys.executable, str(ROOT / 'app' / 'agent_event.py'), '--type', 'completed', '--agent', 'hermes', '--message', 'Turno finalizado'])
    server.tmux_command('send-keys', '-t', data['id'], command, 'Enter')
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        server.telemetry.sample(force=True)
        payload = server.telemetry.payload(data['id'], server.terminal_sessions[data['id']])
        if (payload['notification'] or {}).get('message') == 'Turno finalizado':
            break
        time.sleep(0.05)
    assert payload['notification']['message'] == 'Turno finalizado'
    assert payload['notification']['source'] == 'event'
    persisted = json.loads((tmp_path / f"{data['id']}.json").read_text())
    assert persisted['notification']['kind'] == 'completed'


def test_create_validates_agent_and_working_directory():
    client = server.app.test_client()
    assert client.post('/api/sessions', headers=HEADERS, json={'agent': ['codex']}).status_code == 400
    assert client.post('/api/sessions', headers=HEADERS, json={'agent': 'arbitrary-command'}).status_code == 400
    assert client.post('/api/sessions', headers=HEADERS, json={'cwd': '/does-not-exist'}).status_code == 400
