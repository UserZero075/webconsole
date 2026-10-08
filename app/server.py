"""
WebConsole Server - Tailscale-only web terminal
Minimal, Material You design, Google-style aesthetics
"""

from flask import Flask, render_template, request, jsonify, send_from_directory, abort, session, Response
from flask_sock import Sock
import os
import uuid
import json
import time
import threading
import re
import pty
import subprocess
import shutil
import secrets
import hmac
from urllib.parse import urlsplit
import select
import struct
import fcntl
import termios
import zlib
import shlex
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from telemetry import Telemetry

app = Flask(__name__,
            static_folder=str(Path(__file__).parent.parent / 'static'),
            template_folder=str(Path(__file__).parent.parent / 'templates'))
app.config.update(
    SECRET_KEY=os.environ.get('SECRET_KEY', secrets.token_hex(32)),
    MAX_CONTENT_LENGTH=65536,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE='Strict',
    SESSION_COOKIE_SECURE=os.environ.get('COOKIE_SECURE', '0') == '1',
    SOCK_SERVER_OPTIONS={'ping_interval': 25, 'max_message_size': 65536},
)

sock = Sock(app)
SERVER_STARTED_MONOTONIC = time.monotonic()

# Session storage
terminal_sessions = {}
session_tokens = {}

TERMINAL_SESSIONS_DIR = Path(os.environ.get('WEBCONSOLE_STATE_DIR', str(Path(__file__).parent / 'sessions')))
TERMINAL_SESSIONS_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
TERMINAL_SESSIONS_DIR.chmod(0o700)
TMUX_SOCKET = str(TERMINAL_SESSIONS_DIR / 'tmux.sock')
TMUX_BIN = shutil.which('tmux')
SESSIONS_LOCK = threading.RLock()
MAX_SESSIONS = int(os.environ.get('MAX_SESSIONS', '32'))
MAX_CLIENTS = 4


def generate_token():
    return secrets.token_urlsafe(32)


def sanitize_session_id(sid):
    return sid if isinstance(sid, str) and re.fullmatch(r'[a-zA-Z0-9_-]{1,64}', sid) else None


def tmux_command(*args, check=True):
    if not TMUX_BIN:
        raise RuntimeError('tmux is required: install tmux before starting WebConsole')
    env = os.environ.copy()
    env.pop('TMUX', None)
    env['PATH'] = str(Path.home() / '.local' / 'bin') + ':' + env.get('PATH', '')
    return subprocess.run([TMUX_BIN, '-S', TMUX_SOCKET, '-f', str(Path(__file__).with_name('tmux.conf')), *args],
                          capture_output=True, text=True, timeout=5, check=check, env=env)


def persist_session(sid, info):
    path = TERMINAL_SESSIONS_DIR / f'{sid}.json'
    temporary = path.with_suffix('.tmp')
    with temporary.open('w') as file:
        os.chmod(temporary, 0o600)
        json.dump({key: info[key] for key in ('created_at', 'last_active', 'session_token', 'cols', 'rows', 'cwd', 'title', 'launcher', 'notification', 'dismissed_notification') if key in info}, file)
    temporary.replace(path)


def load_sessions():
    for path in TERMINAL_SESSIONS_DIR.glob('*.json'):
        if not sanitize_session_id(path.stem):
            continue
        try:
            info = json.loads(path.read_text())
            if not isinstance(info, dict) or not re.fullmatch(r'[A-Za-z0-9_-]{40,64}', info.get('session_token', '')):
                raise ValueError('Invalid session metadata')
            for key in ('created_at', 'last_active', 'cols', 'rows'):
                if not isinstance(info.get(key), (int, float)):
                    raise ValueError('Missing or invalid session metadata')
            if not isinstance(info.get('cwd'), str):
                raise ValueError('Invalid directory')
            info.update(pid=None, clients=0)
            terminal_sessions[path.stem] = info
            session_tokens[path.stem] = info['session_token']
        except (OSError, ValueError, TypeError):
            app.logger.warning('Unable to read session metadata: %s', path.name)


load_sessions()


def get_session_token(session_id):
    return session_tokens.get(session_id)


def get_session_url(session_id):
    return f"/c/{get_session_token(session_id)}"


def get_session_by_token(token):
    with SESSIONS_LOCK:
        return next((sid for sid, value in session_tokens.items() if hmac.compare_digest(value.encode(), token.encode())), None)


def session_alive(sid):
    result = tmux_command('display-message', '-p', '-t', sid, '#{pane_dead}', check=False)
    return result.returncode == 0 and result.stdout.strip() == '0'


def cleanup_session(session_id):
    with SESSIONS_LOCK:
        if session_id not in terminal_sessions:
            return
        tmux_command('kill-session', '-t', session_id, check=False)
        terminal_sessions.pop(session_id, None)
        session_tokens.pop(session_id, None)
        (TERMINAL_SESSIONS_DIR / f'{session_id}.json').unlink(missing_ok=True)
        shutil.rmtree(TERMINAL_SESSIONS_DIR / session_id, ignore_errors=True)


def same_origin():
    origin = request.headers.get('Origin')
    if not origin:
        return False
    try:
        parsed = urlsplit(origin)
    except ValueError:
        return False
    configured = os.environ.get('PUBLIC_ORIGIN')
    if configured:
        return origin.rstrip('/') == configured.rstrip('/')
    return parsed.scheme in ('http', 'https') and parsed.netloc == request.host and not parsed.path


@app.before_request
def protect_requests():
    # Tailscale ACLs remain the perimeter; optional password protects all routes.
    password = os.environ.get('WEBCONSOLE_PASSWORD')
    if password and not session.get('authorized'):
        auth = request.authorization
        if not auth or not auth.password or not hmac.compare_digest(auth.password.encode(), password.encode()):
            return Response('Authentication required', 401, {'WWW-Authenticate': 'Basic realm="WebConsole"'})
        session['authorized'] = True
    if request.path.startswith('/ws/'):
        if not same_origin():
            abort(403)
        sid = sanitize_session_id((request.view_args or {}).get('session_id'))
        expected = session_tokens.get(sid)
        if not expected or not hmac.compare_digest(expected.encode(), request.args.get('token', '').encode()):
            abort(403)
    if request.method in ('POST', 'DELETE', 'PUT', 'PATCH'):
        if request.headers.get('X-WebConsole') != '1':
            abort(403)
        if request.headers.get('Origin') and not same_origin():
            abort(403)


@app.after_request
def security_headers(response):
    response.headers['Referrer-Policy'] = 'no-referrer'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['Content-Security-Policy'] = "frame-ancestors 'none'; object-src 'none'; base-uri 'self'"
    if not request.path.startswith('/static/'):
        response.headers['Cache-Control'] = 'no-store'
    return response


def resolve_session_cwd(info):
    """Ask tmux for the active pane directory, including after server restart."""
    sid = next((sid for sid, value in terminal_sessions.items() if value is info), None)
    if sid:
        result = tmux_command('display-message', '-p', '-t', sid, '#{pane_current_path}', check=False)
        cwd = result.stdout.strip()
        if result.returncode == 0 and os.path.isdir(cwd):
            info['cwd'] = cwd
            return cwd
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

def encode_terminal_frame(raw):
    if len(raw) >= 192:
        compressed = zlib.compress(raw, level=1)
        if len(compressed) < len(raw):
            return b'\x01' + compressed
    return b'\x00' + raw


@sock.route('/ws/<session_id>')
def terminal_ws(ws, session_id):
    """Each browser attaches its own tmux client; tmux owns the persistent shell."""
    with SESSIONS_LOCK:
        info = terminal_sessions.get(session_id)
        if not info or info.get('clients', 0) >= MAX_CLIENTS:
            ws.close(reason=1008, message='Session unavailable or client limit reached')
            return
        info['clients'] = info.get('clients', 0) + 1
    master_fd = slave_fd = None
    client = None
    stop = threading.Event()
    send_lock = threading.Lock()

    def safe_send(payload):
        with send_lock:
            ws.send(payload)

    def write_input(raw):
        # Nonblocking PTYs can accept only part of a paste. Never discard its tail.
        view = memoryview(raw)
        deadline = time.monotonic() + 5
        while view and not stop.is_set():
            try:
                count = os.write(master_fd, view)
                view = view[count:]
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise OSError('Terminal input timed out')
                select.select([], [master_fd], [], 0.1)

    def pty_reader():
        try:
            while not stop.is_set():
                ready, _, _ = select.select([master_fd], [], [], 0.045)
                if not ready:
                    continue
                buf = bytearray()
                batch_deadline = time.monotonic() + 0.025
                while len(buf) < 65536:
                    try:
                        chunk = os.read(master_fd, min(8192, 65536 - len(buf)))
                        if not chunk:
                            stop.set()
                            break
                        buf.extend(chunk)
                    except BlockingIOError:
                        remaining = batch_deadline - time.monotonic()
                        if remaining <= 0 or not select.select([master_fd], [], [], remaining)[0]:
                            break
                    except OSError:
                        stop.set()
                        break
                if buf:
                    safe_send(encode_terminal_frame(bytes(buf)))
        except Exception:
            app.logger.debug('Terminal client disconnected', exc_info=True)
        finally:
            stop.set()

    reader = None
    try:
        # Ended sessions are never silently replaced by another shell.
        if not session_alive(session_id):
            safe_send(json.dumps({'type': 'ended'}))
            return
        master_fd, slave_fd = pty.openpty()
        cols = max(20, min(int(request.args.get('cols', info.get('cols', 120))), 500))
        rows = max(5, min(int(request.args.get('rows', info.get('rows', 30))), 200))
        fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
        env = os.environ.copy()
        env.update(TERM='xterm-256color', COLORTERM='truecolor')
        env.pop('TMUX', None)
        client = subprocess.Popen(
            [os.sys.executable, str(Path(__file__).with_name('pty_exec.py')), TMUX_BIN, TMUX_SOCKET, session_id],
            stdin=slave_fd, stdout=slave_fd, stderr=slave_fd, start_new_session=True,
            close_fds=True, env=env)
        os.close(slave_fd)
        slave_fd = None
        os.set_blocking(master_fd, False)
        safe_send(json.dumps({'type': 'ready'}))
        reader = threading.Thread(target=pty_reader, daemon=True)
        reader.start()
        while not stop.is_set():
            msg = ws.receive(timeout=1)
            if msg is None:
                continue
            if isinstance(msg, bytes):
                if b'\r' in msg or b'\x03' in msg:
                    with telemetry.lock:
                        telemetry.ensure(session_id, info)['event_state'] = None
                write_input(msg)
                info['last_active'] = time.time()
                continue
            data = json.loads(msg)
            if not isinstance(data, dict):
                raise ValueError('Invalid control message')
            if data.get('type') == 'input':
                if not isinstance(data.get('data'), str):
                    raise ValueError('Invalid input')
                write_input(data['data'].encode('utf-8'))
                info['last_active'] = time.time()
            elif data.get('type') == 'resize':
                cols = max(20, min(int(data.get('cols', 120)), 500))
                rows = max(5, min(int(data.get('rows', 30)), 200))
                fcntl.ioctl(master_fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
                info.update(cols=cols, rows=rows)
            elif data.get('type') == 'ping':
                safe_send(json.dumps({'type': 'pong'}))
    except (ValueError, TypeError, OSError, subprocess.SubprocessError):
        app.logger.exception('Terminal attach failed')
        try:
            safe_send(json.dumps({'type': 'error', 'data': 'Unable to attach to terminal. Check server logs.'}))
        except Exception:
            pass
    finally:
        stop.set()
        if reader:
            reader.join(timeout=1)
        if master_fd is not None:
            os.close(master_fd)
        if slave_fd is not None:
            os.close(slave_fd)
        if client:
            # Terminate ONLY the disposable tmux client, never the session shell.
            if client.poll() is None:
                client.terminate()
            try:
                client.wait(timeout=2)
            except subprocess.TimeoutExpired:
                client.kill()
                client.wait()
        with SESSIONS_LOCK:
            info['clients'] = max(0, info.get('clients', 1) - 1)
            info['last_active'] = time.time()
            if terminal_sessions.get(session_id) is info:
                persist_session(session_id, info)

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
    abort(404, description='Session not found. Create a new session from the dashboard.')

def session_snapshot():
    with SESSIONS_LOCK:
        return list(terminal_sessions.items())


def save_telemetry(sid, info):
    with SESSIONS_LOCK:
        if terminal_sessions.get(sid) is info:
            persist_session(sid, info)


telemetry = Telemetry(tmux_command, session_snapshot, lambda: TERMINAL_SESSIONS_DIR, save_telemetry)
# Resolve tmux dynamically so isolated tests and state-directory overrides are honored.
telemetry.tmux = lambda *args, **kwargs: tmux_command(*args, **kwargs)


@app.route('/api/sessions')
def api_sessions():
    telemetry.sample()
    sessions_list = []
    for sid, info in session_snapshot():
        sessions_list.append({
            'id': sid, 'token': info.get('session_token', ''), 'url': get_session_url(sid),
            'title': info.get('title', ''),
            'created_at': datetime.fromtimestamp(info['created_at']).isoformat(),
            'last_active': datetime.fromtimestamp(info['last_active']).isoformat(),
            'cwd': info.get('cwd', ''), 'pid': info.get('pid'),
            **telemetry.payload(sid, info),
        })
    return jsonify({'sessions': sessions_list, 'monitor_available': telemetry.available,
                    'observed_at': telemetry.last_sample})


@app.route('/api/sessions/<session_id>/acknowledge', methods=['POST'])
def api_acknowledge(session_id):
    info = terminal_sessions.get(sanitize_session_id(session_id))
    if info is None:
        abort(404)
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict) or not isinstance(payload.get('fingerprint'), str):
        abort(400)
    if not telemetry.acknowledge(session_id, info, payload['fingerprint']):
        return jsonify({'error': 'Notification changed; refresh before acknowledging.'}), 409
    return jsonify({'success': True})


def agent_available(name):
    if shutil.which(name):
        return True
    # User services often lack the NVM/venv PATH configured by the login shell.
    env = os.environ.copy()
    env.pop('WEBCONSOLE_PASSWORD', None)
    env.pop('SECRET_KEY', None)
    try:
        result = subprocess.run(['bash', '-lc', 'type -P -- "$1"', 'webconsole', name],
                                env=env, capture_output=True, text=True, timeout=5)
        return result.returncode == 0 and bool(result.stdout.strip())
    except (OSError, subprocess.SubprocessError):
        return False


@app.route('/api/sessions', methods=['POST'])
def api_create_session():
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        abort(400)
    launcher = payload.get('agent', 'terminal')
    if not isinstance(launcher, str) or launcher not in {'terminal', 'codex', 'opencode', 'hermes'}:
        abort(400)
    title = payload.get('title', '')
    cwd = payload.get('cwd') or str(Path.home())
    if not isinstance(title, str) or len(title) > 100 or not isinstance(cwd, str) or not os.path.isdir(cwd):
        abort(400)
    if launcher != 'terminal' and not agent_available(launcher):
        return jsonify({'error': f'{launcher} no está instalado o no está en PATH.'}), 400
    with SESSIONS_LOCK:
        if len(terminal_sessions) >= MAX_SESSIONS:
            return jsonify({'error': 'Session limit reached; delete unused sessions.'}), 429
        sid = uuid.uuid4().hex[:12]
        token = generate_token()
        now = time.time()
        info = dict(created_at=now, last_active=now, session_token=token,
                    cols=120, rows=30, cwd=os.path.abspath(cwd), pid=None, clients=0, title=title.strip(), launcher=launcher)
        try:
            persist_session(sid, info)
            command = shlex.join([sys.executable, str(Path(__file__).with_name('session_shell.py')), str(TERMINAL_SESSIONS_DIR), sid])
            tmux_command('new-session', '-d', '-s', sid, '-x', '120', '-y', '30',
                         '-c', info['cwd'], command)
        except (OSError, RuntimeError, subprocess.SubprocessError) as error:
            app.logger.exception('Session creation failed: %s', getattr(error, 'stderr', str(error)))
            if TMUX_BIN:
                tmux_command('kill-session', '-t', sid, check=False)
            (TERMINAL_SESSIONS_DIR / f'{sid}.json').unlink(missing_ok=True)
            return jsonify({'error': 'Unable to create session. Check tmux installation and server logs.'}), 503
        terminal_sessions[sid] = info
        session_tokens[sid] = token
    return jsonify({'id': sid, 'token': token, 'url': get_session_url(sid)}), 201

@app.route('/api/sessions/<session_id>', methods=['DELETE'])
def api_delete_session(session_id):
    session_id = sanitize_session_id(session_id)
    if not session_id or session_id not in terminal_sessions:
        abort(404)
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
    if not isinstance(payload, dict) or not isinstance(payload.get('line', ''), str) or len(payload.get('line', '')) > 8192:
        abort(400)
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
    uptime_seconds = max(0, int(time.monotonic() - SERVER_STARTED_MONOTONIC))
    return jsonify({
        'status': 'ok',
        'sessions': len(terminal_sessions),
        'uptime_seconds': uptime_seconds,
    })

# Static
@app.route('/static/<path:filename>')
def static_files(filename):
    return send_from_directory(app.static_folder, filename)

if __name__ == '__main__':
    if not TMUX_BIN:
        raise SystemExit('tmux is required. Install it with your system package manager.')
    threading.Thread(target=telemetry.run, daemon=True, name='session-monitor').start()
    # Sessions have no inactivity timeout: explicit deletion is the only cleanup.
    app.run(host=os.environ.get('HOST', '127.0.0.1'),
            port=int(os.environ.get('PORT', '3030')),
            debug=False, threaded=True)
