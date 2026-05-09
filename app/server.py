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
import shlex
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

def resolve_session_cwd(info):
    """Best-effort cwd for completions without prompt injection."""
    pid = info.get('pid')
    if pid:
        try:
            cwd = os.readlink(f'/proc/{int(pid)}/cwd')
            if cwd and os.path.isdir(cwd):
                info['cwd'] = cwd
                return cwd
        except Exception:
            pass
    cwd = info.get('cwd') or str(TERMINAL_SESSIONS_DIR)
    return cwd if os.path.isdir(cwd) else str(TERMINAL_SESSIONS_DIR)

def split_command_context(line, cursor=None):
    """Return command/token context before cursor for lightweight completion."""
    if cursor is None:
        cursor = len(line or '')
    try:
        cursor = max(0, min(int(cursor), len(line or '')))
    except Exception:
        cursor = len(line or '')
    before = (line or '')[:cursor]
    match = re.search(r'([^\s]*)$', before)
    token = match.group(1) if match else ''
    token_start = cursor - len(token)
    try:
        words = shlex.split(before[:token_start])
    except ValueError:
        words = before[:token_start].split()
    command = words[0] if words else (token if token_start == 0 else '')
    return {
        'before': before,
        'command': command,
        'token': token,
        'token_start': token_start,
        'cursor': cursor,
    }

def path_completion_items(cwd, token='', dirs_only=False, limit=40):
    """List filesystem completion candidates for the current token."""
    token = token or ''
    expanded = os.path.expanduser(token)
    if os.path.isabs(expanded):
        base_dir = os.path.dirname(expanded) or '/'
        prefix = os.path.basename(expanded)
        display_prefix = token[:len(token) - len(prefix)]
    else:
        base_part = os.path.dirname(expanded)
        prefix = os.path.basename(expanded)
        base_dir = os.path.normpath(os.path.join(cwd, base_part)) if base_part else cwd
        display_prefix = token[:len(token) - len(prefix)]

    items = []
    try:
        with os.scandir(base_dir) as entries:
            for entry in entries:
                name = entry.name
                if name.startswith('.') and not prefix.startswith('.'):
                    continue
                if prefix and not name.startswith(prefix):
                    continue
                try:
                    is_dir = entry.is_dir(follow_symlinks=True)
                except OSError:
                    is_dir = False
                if dirs_only and not is_dir:
                    continue
                value = f"{display_prefix}{name}{'/' if is_dir else ''}"
                items.append({
                    'value': value,
                    'label': value,
                    'type': 'dir' if is_dir else 'file',
                })
    except OSError:
        return []

    items.sort(key=lambda item: item['value'].lower())
    return items[:limit]

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

@app.route('/api/sessions/<session_id>/complete', methods=['POST'])
def api_complete_session(session_id):
    session_id = sanitize_session_id(session_id)
    if not session_id or session_id not in terminal_sessions:
        return jsonify({'error': 'session not found'}), 404

    payload = request.get_json(silent=True) or {}
    context = split_command_context(payload.get('line', ''), payload.get('cursor'))
    command = context['command']
    path_commands = {'cd': True, 'ls': False, 'cat': False, 'less': False, 'tail': False, 'head': False, 'vim': False, 'nano': False, 'code': False, 'open': False}
    if command in path_commands and context['token_start'] == 0 and context['token'] == command:
        # Treat bare `cd` / `ls` as "show candidates after the command".
        context['token'] = ''
        context['token_start'] = context['cursor'] + 1
    if command not in path_commands:
        return jsonify({
            'mode': 'none',
            'items': [],
            'token': context['token'],
            'token_start': context['token_start'],
            'cursor': context['cursor'],
        })

    info = terminal_sessions[session_id]
    cwd = resolve_session_cwd(info)
    dirs_only = path_commands[command]
    items = path_completion_items(cwd, context['token'], dirs_only=dirs_only)
    replacement = ''
    if len(items) == 1:
        replacement = items[0]['value']

    return jsonify({
        'mode': 'path',
        'command': command,
        'cwd': cwd,
        'dirs_only': dirs_only,
        'token': context['token'],
        'token_start': context['token_start'],
        'cursor': context['cursor'],
        'replacement': replacement,
        'items': items,
    })

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
