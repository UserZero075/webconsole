import importlib.util
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("webconsole_persistence_server", ROOT / "app" / "server.py")
assert spec is not None and spec.loader is not None
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


def setup_function():
    server.terminal_sessions.clear()
    server.session_tokens.clear()


def test_health_reports_process_uptime(monkeypatch):
    monkeypatch.setattr(server, "SERVER_STARTED_MONOTONIC", 10_000, raising=False)
    monkeypatch.setattr(server.time, "monotonic", lambda: 10_123)

    response = server.app.test_client().get("/health")

    assert response.status_code == 200
    assert response.get_json()["uptime_seconds"] == 123


def test_websocket_disconnect_keeps_session_listed_and_reopenable(monkeypatch):
    session_id = "resume123"
    token = "resume-token"
    pid = 2_147_483_647
    master_fd = os.open(os.devnull, os.O_RDONLY)
    server.terminal_sessions[session_id] = {
        "created_at": 1_000,
        "last_active": 1_000,
        "pid": pid,
        "master_fd": master_fd,
        "cwd": str(ROOT),
        "session_token": token,
        "cols": 120,
        "rows": 30,
    }
    server.session_tokens[session_id] = token

    def fake_kill(target_pid, _signal):
        assert target_pid == pid

    class NoopThread:
        def __init__(self, target, daemon=False):
            self.target = target

        def start(self):
            pass

    class DisconnectedWebSocket:
        def receive(self):
            return None

        def send(self, _payload):
            pass

        def close(self):
            pass

    monkeypatch.setattr(server.os, "kill", fake_kill)
    monkeypatch.setattr(server.threading, "Thread", NoopThread)

    try:
        route = server.app.view_functions["terminal_ws"]
        route.__wrapped__(DisconnectedWebSocket(), session_id)

        sessions = server.app.test_client().get("/api/sessions").get_json()["sessions"]
        assert len(sessions) == 1
        assert sessions[0]["id"] == session_id
        assert sessions[0]["token"] == token
        assert sessions[0]["is_active"] is True

        reopened = server.app.test_client().get(f"/c/{token}")
        assert reopened.status_code == 200
        assert f"session-{session_id}".encode() in reopened.data
    finally:
        server.cleanup_session(session_id)
        server.session_tokens.pop(session_id, None)


def test_dashboard_uses_backend_uptime_instead_of_page_load_time():
    source = (ROOT / "static" / "js" / "app.js").read_text()
    html = (ROOT / "templates" / "index.html").read_text()

    assert "uptime_seconds" in source
    assert "let startTime = Date.now()" not in source
    assert "refreshUptime();" in html
    assert 'src="/static/js/app.js?v=server-uptime"' in html
