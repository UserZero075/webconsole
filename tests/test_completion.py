import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("webconsole_server", ROOT / "app" / "server.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


def setup_function():
    server.terminal_sessions.clear()
    server.session_tokens.clear()


def test_completion_endpoint_lists_directories_for_cd_and_ignores_files(tmp_path):
    (tmp_path / "apps").mkdir()
    (tmp_path / "archive.txt").write_text("x")
    sid = "testsession"
    server.terminal_sessions[sid] = {
        "created_at": 0,
        "last_active": 0,
        "pid": None,
        "master_fd": None,
        "cwd": str(tmp_path),
        "session_token": "tok",
    }

    client = server.app.test_client()
    res = client.post(f"/api/sessions/{sid}/complete", json={"line": "cd a", "cursor": 4})

    assert res.status_code == 200
    data = res.get_json()
    assert data["mode"] == "path"
    assert data["replacement"] == "apps/"
    assert [item["value"] for item in data["items"]] == ["apps/"]
    assert all(item["type"] == "dir" for item in data["items"])

    bare = client.post(f"/api/sessions/{sid}/complete", json={"line": "cd", "cursor": 2}).get_json()
    assert bare["items"] == [{"label": "apps/", "type": "dir", "value": "apps/"}]
    assert bare["token_start"] == 3


def test_completion_endpoint_lists_files_and_dirs_for_ls(tmp_path):
    (tmp_path / "src").mkdir()
    (tmp_path / "server.py").write_text("print('ok')")
    sid = "testsession"
    server.terminal_sessions[sid] = {"created_at": 0, "last_active": 0, "pid": None, "master_fd": None, "cwd": str(tmp_path)}

    client = server.app.test_client()
    res = client.post(f"/api/sessions/{sid}/complete", json={"line": "ls s", "cursor": 4})

    assert res.status_code == 200
    values = [item["value"] for item in res.get_json()["items"]]
    assert values == ["server.py", "src/"]


def test_completion_endpoint_rejects_unknown_session():
    client = server.app.test_client()
    res = client.post("/api/sessions/nope/complete", json={"line": "cd ", "cursor": 3})

    assert res.status_code == 404


def test_frontend_has_dom_suggestions_and_tab_without_writing_local_edits_to_xterm():
    html = (ROOT / "templates" / "console.html").read_text()
    css = (ROOT / "static" / "css" / "console.css").read_text()

    assert "suggestion-panel" in html
    assert "refreshSuggestions" in html
    assert "handleTabCompletion" in html
    assert "commandHistory" in html
    assert "fetch(`/api/sessions/${sessionId}/complete`" in html
    assert ".suggestion-panel" in css

    local_block = html[html.index("function renderLocalInput"):html.index("terminal.onData")]
    assert "terminal.write" not in local_block
    assert "data === '\\t'" in local_block
