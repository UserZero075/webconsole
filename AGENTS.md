# Repository guidance

## Run and verify
- Linux and tmux 3.0+ are required; agent monitoring reads `/proc`.
- Install: `python3 -m venv .venv`, then `.venv/bin/pip install -r requirements.txt pytest`.
- Run: `.venv/bin/python app/server.py` (defaults to `127.0.0.1:3030`). Python does not load `.env`; only the supplied systemd unit does.
- Tests: `.venv/bin/python -m pytest tests -q`; focused test: `.venv/bin/python -m pytest tests/test_workspace_backend.py::test_git_worktree_creation_keeps_primary_checkout_on_its_branch -q`.
- Persistence tests use real tmux and local HTTP/WebSocket servers. UI tests currently inspect source; there is no lint/typecheck or frontend build pipeline.

## Architecture and invariants
- `/` is the project workspace; `/sessions` is the activity summary; `/c/<token>` is the standalone terminal. `app/server.py` is the entrypoint and starts telemetry only when run directly.
- Project/Git/filesystem/message services live in `app/projects.py`, `app/git_service.py`, `app/filesystem.py`, and `app/coordination.py`. `app/coordination_mcp.py` exposes project-scoped messages to OpenCode/Codex sessions launched from a workspace; launchers use per-session MCP configuration, not global config edits.
- Terminal code is inline in `templates/console.html`; workspace code is vanilla JS in `static/js/workspace.js`; dashboard code is `static/js/app.js`; `static/js/lib/` is vendored. No frontend build step is configured.
- tmux owns persistent shells. Disconnecting or closing a browser view must not kill a session; ended shells must not restart silently. Preserve `KillMode=process` in systemd or restarts kill agents.
- Session state defaults to `app/sessions` (override with `WEBCONSOLE_STATE_DIR`); importing `server.py` creates/chmods it and loads metadata. Private directories are `0700`, metadata/event files `0600`.
- Session URLs are bearer credentials. Mutations require `X-WebConsole: 1`; supplied Origins must match; WebSocket attachment requires both a matching Origin and session token.
- Telemetry distinguishes confirmed events, estimated activity, and process presence. Silence is not completion; viewing a permission notice never approves it.
- Agent launchers must not edit global agent configuration or enable automatic approvals. `app/session_shell.py` strips service secrets from child shells.
