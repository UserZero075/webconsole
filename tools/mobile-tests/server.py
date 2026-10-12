"""Render the real UI against static fixture APIs; never imports app.server or tmux."""

from __future__ import annotations

import os
from pathlib import Path

from flask import Flask, jsonify, render_template, send_file


ROOT = Path(__file__).resolve().parents[2]
app = Flask(__name__, template_folder=str(ROOT / "templates"), static_folder=str(ROOT / "static"))
app.jinja_env.globals["asset_version"] = lambda _path: "mobile-fixture"

PROJECT = {"id": "p1", "name": "Mobile fixture", "path": "/fixture", "session_count": 0, "workspace_count": 1}
GIT = {"is_git": False, "available": True, "branch": "main", "branches": [], "remotes": [], "changes": []}
WORKSPACE = {
    "id": "w1", "project_id": "p1", "name": "Fixture", "path": "/fixture",
    "kind": "primary", "branch": "main", "available": True, "git": GIT,
}


@app.get("/")
def workspace():
    return render_template("workspace.html")


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/tests/frontend/mobile/terminal-fixture.html")
def terminal_fixture():
    return send_file(ROOT / "tests/frontend/mobile/terminal-fixture.html", mimetype="text/html")


@app.get("/api/projects")
def projects():
    return jsonify(projects=[PROJECT])


@app.get("/api/sessions")
def sessions():
    return jsonify(sessions=[])


@app.get("/api/projects/p1/workspaces")
def workspaces():
    return jsonify(project=PROJECT, workspaces=[WORKSPACE])


@app.get("/api/projects/p1/messages")
def messages():
    return jsonify(messages=[])


@app.get("/api/workspaces/w1/files")
def files():
    return jsonify(path="", entries=[{"name": "README.md", "type": "file", "size": 31}], truncated=False)


@app.get("/api/workspaces/w1/git")
def git():
    return jsonify(git=GIT)


@app.get("/api/workspaces/w1/file")
def file_content():
    return jsonify(content="# Fixture\n\nMobile editor buffer.\n", revision="fixture-revision")


@app.post("/api/workspaces/w1/terminal")
def no_terminal():
    # The real terminal-creation endpoint is intentionally absent: this fixture
    # never starts a shell, agent, tmux server, or WebSocket connection.
    return jsonify(session=None)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("WEBCONSOLE_MOBILE_TEST_PORT", "3031")), threaded=True)
