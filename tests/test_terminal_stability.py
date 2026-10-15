"""Terminal stability: log safety and connection lifecycle diagnostics."""

import json
import logging
import os
import socket
import threading
import time
import urllib.request
import zlib
from pathlib import Path
import importlib.util

import pytest
from werkzeug.serving import make_server
from websockets.sync.client import connect
from websockets.exceptions import ConnectionClosed

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('webconsole_stability_server', ROOT / 'app' / 'server.py')
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)

from log_safety import RedactingLogFilter, install_access_log_redaction, redact_secrets

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


def read_until(ws, expected):
    """Read terminal frames, acknowledging sequenced flow frames."""
    output = bytearray()
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        frame = ws.recv(timeout=3)
        if isinstance(frame, bytes):
            if frame[0] in (2, 3):
                sequence = int.from_bytes(frame[1:9], 'big')
                payload = zlib.decompress(frame[9:]) if frame[0] == 3 else frame[9:]
                ws.send(json.dumps({'type': 'ack', 'seq': str(sequence)}))
                output.extend(payload)
            else:
                output.extend(zlib.decompress(frame[1:]) if frame[0] == 1 else frame[1:])
        if expected in output:
            return bytes(output)
    pytest.fail(f'No terminal redraw containing {expected!r}: {output!r}')


class _CapturingHandler(logging.Handler):
    def __init__(self):
        super().__init__()
        self.records = []

    def emit(self, record):
        self.records.append(record.getMessage())


@pytest.fixture
def captured_werkzeug_logs():
    """Capture the real werkzeug logger output, including the request line."""
    logger = logging.getLogger('werkzeug')
    previous_level = logger.level
    logger.setLevel(logging.INFO)
    handler = _CapturingHandler()
    logger.addHandler(handler)
    # Werkzeug attaches its colour handler only once; drop it while capturing so
    # the test asserts on one deterministic sink.
    disabled = [existing for existing in logger.handlers if existing is not handler]
    for existing in disabled:
        logger.removeHandler(existing)
    try:
        yield handler.records
    finally:
        logger.removeHandler(handler)
        logger.setLevel(previous_level)
        for existing in disabled:
            logger.addHandler(existing)


def test_redact_secrets_hides_session_tokens_in_access_targets():
    token = 'qVwJDCRro-lJZAulIvvuEU4hrAr-iB1CtcZ0YNLLAw8'
    assert token not in redact_secrets(f'GET /c/{token} HTTP/1.1')
    assert token not in redact_secrets(f'GET /ws/abc123?token={token}&cols=120&rows=30 HTTP/1.1')
    # Session ids and ordinary traffic stay readable for diagnosis.
    assert '/c/[redacted]' in redact_secrets(f'GET /c/{token} HTTP/1.1')
    assert 'token=[redacted]' in redact_secrets(f'GET /ws/abc123?token={token}&cols=12')
    assert redact_secrets('GET /api/sessions HTTP/1.1') == 'GET /api/sessions HTTP/1.1'
    assert redact_secrets('GET /ws/abc123?cols=120 HTTP/1.1') == 'GET /ws/abc123?cols=120 HTTP/1.1'


def test_redact_secrets_leaves_format_placeholders_and_non_strings_intact():
    assert redact_secrets('') == ''
    assert redact_secrets(None) is None
    assert '%s' in redact_secrets('%s GET /c/x HTTP/1.1')
    assert redact_secrets(42) == 42


def test_redacting_filter_rewrites_message_arguments_and_dict_args():
    token = 'B' * 43
    redacting = RedactingLogFilter()

    # Werkzeug passes the whole request line ("GET /c/<token> HTTP/1.1") as one arg.
    positional = logging.LogRecord('werkzeug', logging.INFO, __file__, 1,
                                   '"%s" %s %s', (f'GET /c/{token} HTTP/1.1', 200, '-'), None)
    assert redacting.filter(positional)
    assert token not in positional.getMessage()
    assert positional.args == ('GET /c/[redacted] HTTP/1.1', 200, '-')

    keyword = logging.LogRecord('werkzeug', logging.INFO, __file__, 1,
                                '%(target)s', ({'target': f'GET /ws/a?token={token}'},), None)
    assert redacting.filter(keyword)
    assert token not in keyword.getMessage()

    # A message with no substitution arguments is still redacted.
    inline = logging.LogRecord('werkzeug', logging.INFO, __file__, 1,
                               f'GET /c/{token} HTTP/1.1', None, None)
    assert redacting.filter(inline)
    assert token not in inline.getMessage()


def test_redaction_filter_is_installed_once_on_the_access_logger():
    logger = install_access_log_redaction('werkzeug')
    matches = [entry for entry in logger.filters if isinstance(entry, RedactingLogFilter)]
    assert len(matches) == 1
    assert install_access_log_redaction('werkzeug') is logger
    assert len([entry for entry in logger.filters
                if isinstance(entry, RedactingLogFilter)]) == 1


def test_websocket_io_timeout_is_bounded_when_supported():
    class FakeSocket:
        def __init__(self):
            self.timeout = None

        def settimeout(self, timeout):
            self.timeout = timeout

    class FakeWebSocket:
        def __init__(self):
            self.sock = FakeSocket()

    ws = FakeWebSocket()
    assert server.bound_websocket_io(ws)
    assert ws.sock.timeout == server.TERMINAL_SOCKET_IO_TIMEOUT_SECONDS


def test_serialized_websocket_socket_uses_sendall_and_delegates_socket_api():
    class FakeSocket:
        def __init__(self):
            self.writes = []

        def sendall(self, payload, *args, **kwargs):
            self.writes.append((payload, args, kwargs))

        def fileno(self):
            return 37

    raw_socket = FakeSocket()
    sock = server.SerializedWebSocketSocket(raw_socket)
    assert sock.send(b'complete-frame') == len(b'complete-frame')
    assert raw_socket.writes == [(b'complete-frame', (), {})]
    assert sock.fileno() == 37


def test_stalled_socket_write_is_bounded_by_the_configured_timeout(monkeypatch):
    monkeypatch.setattr(server, 'TERMINAL_SOCKET_IO_TIMEOUT_SECONDS', 0.05)
    sender, unread_peer = socket.socketpair()
    try:
        sender.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 4096)
        ws = type('WebSocket', (), {})()
        ws.sock = server.SerializedWebSocketSocket(sender)
        assert server.bound_websocket_io(ws)
        started = time.monotonic()
        with pytest.raises(TimeoutError):
            ws.sock.send(b'x' * (4 * 1024 * 1024))
        assert time.monotonic() - started < 1.0
    finally:
        sender.close()
        unread_peer.close()


def test_websocket_io_timeout_handles_wrapped_sockets_without_settimeout():
    class FakeWebSocket:
        sock = object()

    assert not server.bound_websocket_io(FakeWebSocket())


def test_access_log_never_writes_a_session_token(live_server, captured_werkzeug_logs):
    """The real request line reaches the logger with credentials redacted."""
    response = server.app.test_client().post('/api/sessions', headers=HEADERS)
    assert response.status_code == 201
    data = response.get_json()
    sid, token = data['id'], data['token']

    # Fetch over real HTTP: the Flask test client never reaches Werkzeug's logger.
    with urllib.request.urlopen(f'{live_server}/c/{token}', timeout=10) as body:
        assert body.status == 200

    with connect(live_server.replace('http:', 'ws:') + f'/ws/{sid}?token={token}', origin=live_server) as ws:
        read_until(ws, b'\x1b')

    # Give the access logger a moment to flush the request lines.
    for _ in range(50):
        if any(f'/ws/{sid}' in entry for entry in captured_werkzeug_logs):
            break
        time.sleep(0.05)

    logged = '\n'.join(captured_werkzeug_logs)
    assert token not in logged, 'A session bearer token reached the access log'
    assert '/c/[redacted]' in logged
    assert f'/ws/{sid}?token=[redacted]' in logged


def test_terminal_connections_report_attach_and_detach(live_server, caplog):
    """Each WebSocket attach/detach logs an id, reason and duration."""
    response = server.app.test_client().post('/api/sessions', headers=HEADERS)
    sid, token = response.get_json()['id'], response.get_json()['token']
    url = live_server.replace('http:', 'ws:') + f'/ws/{sid}?token={token}&cols=120&rows=30'

    with caplog.at_level(logging.INFO, logger='webconsole_stability_server'):
        with connect(url, origin=live_server) as ws:
            read_until(ws, b'\x1b')

    messages = [record.getMessage() for record in caplog.records]
    attach = [m for m in messages if 'attach' in m and 'terminal ws=' in m]
    detach = [m for m in messages if 'detach' in m and 'terminal ws=' in m]
    assert attach, f'No attach log line: {messages}'
    assert detach, f'No detach log line: {messages}'
    assert 'reason=' in detach[0] and 'duration=' in detach[0]
    assert 'remaining_clients=' in detach[0]


def test_client_limit_rejection_is_logged_and_never_leaks_the_token(live_server, caplog):
    """The reachable rejection (client limit) records why and hides the token.

    An unknown session id never reaches the handler: before_request rejects it
    with 403, so the handler's own guard only fires when the view cap is hit.
    """
    response = server.app.test_client().post('/api/sessions', headers=HEADERS)
    sid, token = response.get_json()['id'], response.get_json()['token']
    url = live_server.replace('http:', 'ws:') + f'/ws/{sid}?token={token}&cols=120&rows=30'

    held = []
    try:
        with caplog.at_level(logging.INFO, logger='webconsole_stability_server'):
            for _ in range(server.MAX_CLIENTS):
                held.append(connect(url, origin=live_server, legacy=True))
                read_until(held[-1], b'\x1b')

            # The handshake succeeds; the handler closes the excess view with 1008.
            excess = connect(url, origin=live_server, legacy=True)
            try:
                with pytest.raises(Exception):
                    excess.recv(timeout=5)
            finally:
                excess.close()

            # The rejection is logged from the request thread; let it settle.
            for _ in range(50):
                if any('rejected' in record.getMessage() for record in caplog.records):
                    break
                time.sleep(0.05)

        messages = [record.getMessage() for record in caplog.records]
        rejected = [m for m in messages if 'rejected' in m and 'terminal ws=' in m]
        assert rejected, f'No rejection log line: {messages}'
        assert 'client-limit' in rejected[0]
        assert f'clients={server.MAX_CLIENTS}' in rejected[0]
        assert token not in '\n'.join(messages)
    finally:
        for ws in held:
            ws.close()

    # Disconnected browser views must release every slot; the shell survives.
    for _ in range(100):
        with server.SESSIONS_LOCK:
            clients = server.terminal_sessions[sid]['clients']
        if clients == 0:
            break
        time.sleep(0.05)
    assert clients == 0, 'closed attachments retained client slots'
    with connect(url, origin=live_server) as ws:
        assert b'\x1b' in read_until(ws, b'\x1b')


def test_fifty_attach_detach_cycles_release_slots_and_preserve_shell(live_server):
    """Repeated view churn must not accumulate PTYs/FDs or replace tmux shell."""
    response = server.app.test_client().post('/api/sessions', headers=HEADERS)
    assert response.status_code == 201
    data = response.get_json()
    sid, token = data['id'], data['token']
    url = live_server.replace('http:', 'ws:') + f'/ws/{sid}?token={token}&cols=120&rows=30'
    shell_pid = server.tmux_command('display-message', '-p', '-t', sid, '#{pane_pid}').stdout.strip()
    fd_baseline = len(os.listdir('/proc/self/fd'))
    thread_baseline = len(threading.enumerate())

    for cycle in range(50):
        with connect(url, origin=live_server) as ws:
            read_until(ws, b'\x1b')

        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            with server.SESSIONS_LOCK:
                clients = server.terminal_sessions[sid]['clients']
            if clients == 0:
                break
            time.sleep(0.02)
        assert clients == 0, f'cycle {cycle + 1} retained a terminal client slot'

    current_pid = server.tmux_command('display-message', '-p', '-t', sid, '#{pane_pid}').stdout.strip()
    assert current_pid == shell_pid, 'view churn replaced the persistent shell'
    assert len(os.listdir('/proc/self/fd')) <= fd_baseline + 3, 'file descriptors accumulated across attaches'
    time.sleep(0.1)
    assert len(threading.enumerate()) <= thread_baseline + 2, 'threads accumulated across attaches'


def test_view_without_render_acks_is_detached_but_shell_survives(live_server):
    """A stalled renderer is reclaimed by ACK timeout; tmux remains untouched."""
    response = server.app.test_client().post('/api/sessions', headers=HEADERS)
    assert response.status_code == 201
    data = response.get_json()
    sid, token = data['id'], data['token']
    url = live_server.replace('http:', 'ws:') + f'/ws/{sid}?token={token}&cols=120&rows=30&flow=1'
    shell_pid = server.tmux_command('display-message', '-p', '-t', sid, '#{pane_pid}').stdout.strip()

    with connect(url, origin=live_server) as ws:
        first_flow_frame = False
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            message = ws.recv(timeout=3)
            if isinstance(message, bytes) and message and message[0] in (2, 3):
                first_flow_frame = True
                break  # Deliberately never ACK: emulate a renderer that stopped.
        assert first_flow_frame, 'server did not send a sequenced terminal frame'
        ws.send(b"printf '\\nSLOW_VIEW_SURVIVED\\n'\r")
        started = time.monotonic()
        close_code = None
        while time.monotonic() - started < 8:
            try:
                ws.recv(timeout=1)  # Discard, but never ACK, later output frames.
            except TimeoutError:
                continue
            except ConnectionClosed as closed:
                close_code = getattr(closed.rcvd, 'code', None)
                break
        elapsed = time.monotonic() - started
        assert close_code == 1013, f'expected ACK-timeout close 1013, got {close_code}'
        assert elapsed < 7, 'ACK timeout did not reclaim the stalled view promptly'

    for _ in range(100):
        with server.SESSIONS_LOCK:
            clients = server.terminal_sessions[sid]['clients']
        if clients == 0:
            break
        time.sleep(0.03)
    assert clients == 0, 'stalled view retained a client slot'
    assert server.session_alive(sid), 'stalled view terminated the tmux session'
    current_pid = server.tmux_command('display-message', '-p', '-t', sid, '#{pane_pid}').stdout.strip()
    assert current_pid == shell_pid

    with connect(url, origin=live_server) as ws:
        assert b'SLOW_VIEW_SURVIVED' in read_until(ws, b'SLOW_VIEW_SURVIVED')


def test_output_send_failure_releases_slot_without_ending_shell(live_server, monkeypatch):
    """A controlled transport write failure exits the reader/finally cleanly."""
    response = server.app.test_client().post('/api/sessions', headers=HEADERS)
    assert response.status_code == 201
    data = response.get_json()
    sid, token = data['id'], data['token']
    url = live_server.replace('http:', 'ws:') + f'/ws/{sid}?token={token}&cols=120&rows=30'
    shell_pid = server.tmux_command('display-message', '-p', '-t', sid, '#{pane_pid}').stdout.strip()
    original_adapter = server.SerializedWebSocketSocket

    class FailingTerminalOutputSocket(original_adapter):
        def send(self, payload, *args, **kwargs):
            # Fail a WebSocket binary frame (opcode 2), but allow ready/control frames.
            if payload and payload[0] & 0x0f == 2:
                raise TimeoutError('controlled slow-reader send timeout')
            return super().send(payload, *args, **kwargs)

    monkeypatch.setattr(server, 'SerializedWebSocketSocket', FailingTerminalOutputSocket)
    with connect(url, origin=live_server) as ws:
        ready = False
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            message = ws.recv(timeout=2)
            if isinstance(message, str) and json.loads(message).get('type') == 'ready':
                ready = True
                break
        assert ready, 'the transport did not reach ready before the controlled output fault'

        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            with server.SESSIONS_LOCK:
                clients = server.terminal_sessions[sid]['clients']
            if clients == 0:
                break
            time.sleep(0.03)
        assert clients == 0, 'output send failure retained a terminal client slot'

    assert server.session_alive(sid), 'output send failure ended the tmux shell'
    current_pid = server.tmux_command('display-message', '-p', '-t', sid, '#{pane_pid}').stdout.strip()
    assert current_pid == shell_pid
