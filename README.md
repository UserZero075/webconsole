# WebConsole

Tailscale-only web terminal with a real PTY, xterm.js, Material-style UI, low-bandwidth WebSocket transport, and local input buffering for smooth typing on weak mobile links.

## Features

- Flask + `flask-sock` WebSocket PTY bridge.
- xterm.js terminal rendering.
- Binary PTY frames with optional zlib compression.
- Batched terminal output for weak links.
- Local input mode: text is edited/rendered locally and sent to the real PTY only on Enter.
- `Local/Live` input toggle via the `LI` button or `Ctrl+B`.
- Dashboard for session creation/management.

## Run locally

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python app/server.py
```

Open:

```text
http://127.0.0.1:3030/
```

## Deploy as a user service

Example systemd unit:

```ini
[Unit]
Description=WebConsole - Tailscale-only Web Terminal
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/webconsole
Environment=PYTHONUNBUFFERED=1
ExecStart=%h/webconsole/.venv/bin/python %h/webconsole/app/server.py
Restart=always
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=10

[Install]
WantedBy=default.target
```

Then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now webconsole.service
```

## Security model

This app is intended for private networks, especially Tailscale. It binds to `0.0.0.0:3030`; restrict access with Tailscale ACLs/firewall rules.
