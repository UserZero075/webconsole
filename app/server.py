"""
WebConsole Server - Tailscale-only web terminal
Minimal, Material You design, Google-style aesthetics
"""

from flask import Flask, render_template, request, jsonify, send_from_directory
from flask_sock import Sock
import os
import uuid
import json
import time
import threading
import re
import pty
import select
import struct
import fcntl
import termios
import signal
import zlib
from datetime import datetime
from pathlib import Path

app = Flask(__name__,
            static_folder=str(Path(__file__).parent.parent / 'static'),
            template_folder=str(Path(__file__).parent.parent / 'templates'))
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', os.urandom(32).hex())

sock = Sock(app)

# Session storage
terminal_sessions = {}
session_tokens = {}

TERMINAL_SESSIONS_DIR = Path(__file__).parent / 'sessions'
TERMINAL_SESSIONS_DIR.mkdir(exist_ok=True)

def generate_token():
    return uuid.uuid4().hex + uuid.uuid4().hex[:12]

def sanitize_session_id(sid):
    if not sid or len(sid) > 64:
        return None
    return re.sub(r'[^a-zA-Z0-9_-]', '', sid)

def get_session_token(session_id):
    if session_id not in session_tokens:
        session_tokens[session_id] = generate_token()
    return session_tokens[session_id]

def get_session_url(session_id):
    token = get_session_token(session_id)
    return f"/c/{token}"

def get_session_by_token(token):
    for sid, tok in session_tokens.items():
        if tok == token:
            return sid
    return None

def cleanup_session(session_id):
    if session_id in terminal_sessions:
        info = terminal_sessions[session_id]
        if info.get('master_fd') is not None:
            try:
                os.close(info['master_fd'])
            except:
                pass
        if info.get('pid'):
            try:
                os.kill(info['pid'], signal.SIGTERM)
            except:
                pass
        del terminal_sessions[session_id]
    for tok, sid in list(session_tokens.items()):
        if sid == session_id:
            del session_tokens[tok]

# ANSI color codes
ANSI_COLORS = {
    '0': '#000000', '1': '#CC0000', '2': '#4E9A06', '3': '#C4A000',
    '4': '#3465A4', '5': '#75517B', '6': '#06989A', '7': '#D3D7CF',
    '8': '#555753', '9': '#EF2929', '10': '#8AE234', '11': '#FCE94F',
    '12': '#729FCF', '13': '#AD7FA8', '14': '#34E2E2', '15': '#EEEEEC',
}

@sock.route('/ws/<session_id>')
def terminal_ws(ws, session_id):
    """PTY <-> WebSocket bridge optimized for low bandwidth/latency.

    PTY output is sent as compressed binary frames, batched for weak links.
    Control messages (resize/ping/input) remain small JSON frames from browser -> server.
    """
    session_id = sanitize_session_id(session_id)
    if not session_id:
        ws.close()
        return

    # Create or get session
    if session_id not in terminal_sessions:
        try:
            master_fd, slave_fd = pty.openpty()
            cols, rows = 120, 30
            winsize = struct.pack('HHHH', rows, cols, 0, 0)
            fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, winsize)

            pid = os.fork()
            if pid == 0:
                # Child process: real interactive shell attached to PTY.
                os.close(master_fd)
                os.setsid()
                fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
                os.dup2(slave_fd, 0)
                os.dup2(slave_fd, 1)
                os.dup2(slave_fd, 2)
                if slave_fd > 2:
                    os.close(slave_fd)

                env = os.environ.copy()
                env['TERM'] = 'xterm-256color'
                env['COLORTERM'] = 'truecolor'
                env['LANG'] = 'en_US.UTF-8'
                env['LC_ALL'] = env.get('LC_ALL', 'en_US.UTF-8')
                env['PATH'] = '/home/nanoclaw/.local/bin:' + env.get('PATH', '')
                os.execvpe('bash', ['bash', '-l'], env)

            os.close(slave_fd)
            flags = fcntl.fcntl(master_fd, fcntl.F_GETFL)
            fcntl.fcntl(master_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)
            terminal_sessions[session_id] = {
                'created_at': time.time(),
                'last_active': time.time(),
                'pid': pid,
                'master_fd': master_fd,
                'cwd': str(TERMINAL_SESSIONS_DIR),
                'session_token': get_session_token(session_id),
                'cols': cols,
                'rows': rows,
            }
        except Exception as e:
            ws.send(json.dumps({'type': 'error', 'data': str(e)}))
            ws.close()
            return

    info = terminal_sessions[session_id]
    master_fd = info['master_fd']
    stop = threading.Event()
    send_lock = threading.Lock()

    def safe_send(payload):
        """Serialize sends; simple-websocket is not guaranteed send-thread-safe."""
        with send_lock:
            ws.send(payload)

    def encode_terminal_frame(raw: bytes) -> bytes:
        """Prefix terminal frames: 0x00 raw, 0x01 zlib-compressed.

        Terminal/TUI streams compress extremely well. For ETECSA-class links,
        fewer bytes matters more than shaving a few CPU cycles.
        """
        if not raw:
            return b'\x00'
        if len(raw) < 192:
            return b'\x00' + raw
        compressed = zlib.compress(raw, level=1)
        if len(compressed) + 1 < len(raw):
            return b'\x01' + compressed
        return b'\x00' + raw

    def pty_reader():
        """Batch PTY bytes into binary websocket frames for smoother rendering."""
        buf = bytearray()
        last_flush = time.monotonic()
        max_batch = 65536       # bigger batches = fewer packets on weak links
        frame_interval = 0.045  # ~22fps transport; xterm still renders smoothly
        try:
            while not stop.is_set():
                ready, _, _ = select.select([master_fd], [], [], frame_interval)
                if master_fd in ready:
                    while True:
                        try:
                            chunk = os.read(master_fd, 8192)
                            if not chunk:
                                stop.set()
                                break
                            buf.extend(chunk)
                            info['last_active'] = time.time()
                            if len(buf) >= max_batch:
                                safe_send(encode_terminal_frame(bytes(buf)))
                                buf.clear()
                                last_flush = time.monotonic()
                        except BlockingIOError:
                            break
                        except OSError:
                            stop.set()
                            break

                now = time.monotonic()
                if buf and (now - last_flush >= frame_interval or len(buf) >= max_batch):
                    safe_send(encode_terminal_frame(bytes(buf)))
                    buf.clear()
                    last_flush = now
        finally:
            if buf:
                try:
                    safe_send(encode_terminal_frame(bytes(buf)))
                except Exception:
                    pass
            stop.set()

    reader = threading.Thread(target=pty_reader, daemon=True)
    reader.start()

    try:
        while not stop.is_set():
            msg = ws.receive()
            if msg is None:
                break
            try:
                if isinstance(msg, bytes):
                    os.write(master_fd, msg)
                    info['last_active'] = time.time()
                    continue

                data = json.loads(msg)
                msg_type = data.get('type')
                if msg_type == 'input':
                    os.write(master_fd, data.get('data', '').encode('utf-8'))
                    info['last_active'] = time.time()
                elif msg_type == 'resize':
                    cols = int(data.get('cols') or 120)
                    rows = int(data.get('rows') or 30)
                    cols = max(20, min(cols, 500))
                    rows = max(5, min(rows, 200))
                    winsize = struct.pack('HHHH', rows, cols, 0, 0)
                    fcntl.ioctl(master_fd, termios.TIOCSWINSZ, winsize)
                    info['cols'] = cols
                    info['rows'] = rows
                    info['last_active'] = time.time()
                elif msg_type == 'ping':
                    safe_send(json.dumps({'type': 'pong'}))
            except json.JSONDecodeError:
                if isinstance(msg, str):
                    os.write(master_fd, msg.encode('utf-8'))
                    info['last_active'] = time.time()
            except (BrokenPipeError, OSError):
                break
    finally:
        stop.set()
        # Keep the old behavior: closing browser tab kills the PTY session.
        cleanup_session(session_id)

# Routes
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/c/<token>')
def console(token):
    session_id = get_session_by_token(token)
    if session_id and session_id in terminal_sessions:
        info = terminal_sessions[session_id]
        return render_template('console.html',
                             session_id=session_id,
                             token=token,
                             cols=info.get('cols', 120),
                             rows=info.get('rows', 30))
    # Auto-create session
    session_id = uuid.uuid4().hex[:12]
    token = get_session_token(session_id)
    return render_template('console.html',
                         session_id=session_id,
                         token=token,
                         cols=120,
                         rows=30)

@app.route('/api/sessions')
def api_sessions():
    sessions_list = []
    for sid, info in terminal_sessions.items():
        # Check if process is alive
        is_active = False
        if info.get('pid'):
            try:
                os.kill(info['pid'], 0)
                is_active = True
            except:
                is_active = False

        sessions_list.append({
            'id': sid,
            'token': info.get('session_token', ''),
            'url': get_session_url(sid),
            'created_at': datetime.fromtimestamp(info['created_at']).isoformat(),
            'last_active': datetime.fromtimestamp(info['last_active']).isoformat(),
            'cwd': info.get('cwd', ''),
            'pid': info.get('pid'),
            'is_active': is_active
        })
    return jsonify({'sessions': sessions_list})

@app.route('/api/sessions', methods=['POST'])
def api_create_session():
    session_id = uuid.uuid4().hex[:12]
    token = get_session_token(session_id)
    return jsonify({
        'id': session_id,
        'token': token,
        'url': get_session_url(session_id)
    })

@app.route('/api/sessions/<session_id>', methods=['DELETE'])
def api_delete_session(session_id):
    session_id = sanitize_session_id(session_id)
    cleanup_session(session_id)
    return jsonify({'success': True})

@app.route('/api/sessions/<session_id>/keep-alive', methods=['POST'])
def api_keep_alive(session_id):
    session_id = sanitize_session_id(session_id)
    if session_id in terminal_sessions:
        terminal_sessions[session_id]['last_active'] = time.time()
    return jsonify({'success': True})

@app.route('/health')
def health():
    return jsonify({'status': 'ok', 'sessions': len(terminal_sessions)})

# Static
@app.route('/static/<path:filename>')
def static_files(filename):
    return send_from_directory('static', filename)

# Cleanup inactive sessions
def cleanup_loop():
    while True:
        time.sleep(60)
        now = time.time()
        for sid in list(terminal_sessions.keys()):
            if now - terminal_sessions[sid]['last_active'] > 1800:  # 30 min
                cleanup_session(sid)

if __name__ == '__main__':
    cleanup_thread = threading.Thread(target=cleanup_loop, daemon=True)
    cleanup_thread.start()

    # Run on all interfaces (Tailscale firewall handles access control)
    app.run(host='0.0.0.0', port=3030, debug=False, threaded=True)
