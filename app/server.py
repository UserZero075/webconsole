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
import hashlib
from urllib.parse import urlsplit
import select
import signal
import socket
import struct
import fcntl
import termios
import stat
import zlib
import gzip
import shlex
import sys
from functools import lru_cache
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from telemetry import Telemetry
from projects import ProjectError, ProjectStore
from git_service import (GitError, create_worktree, fetch as git_fetch, inspect as inspect_git, run_git,
                         read_diff as read_git_diff, remove_worktree as git_remove_worktree,
                         clone_repository, switch_to_new_branch, push_branch)
from filesystem import FileAccessError, WorkspaceFiles, MAX_FILE_BYTES
from coordination import CoordinationError, CoordinationStore, new_coordination_token
from attachments import AttachmentError, AttachmentStore, MAX_REQUEST_BYTES as MAX_ATTACHMENT_REQUEST_BYTES
from handoffs import HandoffError, HandoffStore, MAX_EXPORT_BYTES as MAX_HANDOFF_EXPORT_BYTES, NATIVE_SESSION_ID, normalize_opencode_export
from host_directories import DirectoryError, list_directories, resolve_directory
from github_service import (GitHubError, status as github_status, repositories as github_repositories,
                            branches as github_branches, validate_public_url,
                            repository_permission, resolve_gh)
from preferences import PreferencesError, PreferencesStore, DEFAULTS as PREFERENCE_DEFAULTS

app = Flask(__name__,
            static_folder=str(Path(__file__).parent.parent / 'static'),
            template_folder=str(Path(__file__).parent.parent / 'templates'))
STATIC_ROOT = Path(app.static_folder).resolve()
app.config.update(
    SECRET_KEY=os.environ.get('SECRET_KEY', secrets.token_hex(32)),
    MAX_CONTENT_LENGTH=max(MAX_FILE_BYTES * 6 + 65536, MAX_ATTACHMENT_REQUEST_BYTES),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE='Strict',
    SESSION_COOKIE_SECURE=os.environ.get('COOKIE_SECURE', '0') == '1',
    SOCK_SERVER_OPTIONS={'ping_interval': 25, 'max_message_size': 65536},
)

sock = Sock(app)
SERVER_STARTED_MONOTONIC = time.monotonic()


@lru_cache(maxsize=128)
def _static_digest(path, modified_ns, size):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()[:16]


def static_asset_version(filename):
    """Return a content version for safe long-lived caching of public assets."""
    try:
        path = (STATIC_ROOT / filename).resolve(strict=True)
        if os.path.commonpath((str(STATIC_ROOT), str(path))) != str(STATIC_ROOT) or not path.is_file():
            return ''
        metadata = path.stat()
    except (OSError, RuntimeError, ValueError):
        return ''
    return _static_digest(str(path), metadata.st_mtime_ns, metadata.st_size)


def client_accepts_gzip():
    return request.accept_encodings.best_match(['gzip', 'identity']) == 'gzip'


@lru_cache(maxsize=32)
def _gzip_static_asset(path, modified_ns, size):
    return gzip.compress(Path(path).read_bytes(), compresslevel=6, mtime=0)


app.jinja_env.globals['asset_version'] = static_asset_version

# Session storage
terminal_sessions = {}
session_tokens = {}

TERMINAL_SESSIONS_DIR = Path(os.environ.get('WEBCONSOLE_STATE_DIR', str(Path(__file__).parent / 'sessions'))).expanduser().resolve()
TERMINAL_SESSIONS_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
TERMINAL_SESSIONS_DIR.chmod(0o700)
TMUX_SOCKET = str(TERMINAL_SESSIONS_DIR / 'tmux.sock')
TMUX_BIN = shutil.which('tmux')
SESSIONS_LOCK = threading.RLock()
MAX_SESSIONS = int(os.environ.get('MAX_SESSIONS', '32'))
MAX_CLIENTS = 4
PROJECT_STORE = ProjectStore(TERMINAL_SESSIONS_DIR)
COORDINATION_STORE = CoordinationStore(TERMINAL_SESSIONS_DIR)
WORKTREE_DIR = Path(os.environ.get('WEBCONSOLE_WORKTREE_DIR', str(Path.home() / '.local' / 'share' / 'webconsole' / 'worktrees'))).expanduser().resolve()
ATTACHMENT_STORE = AttachmentStore(TERMINAL_SESSIONS_DIR)
HANDOFF_STORE = HandoffStore(TERMINAL_SESSIONS_DIR)
PREFERENCES_STORE = PreferencesStore(TERMINAL_SESSIONS_DIR)


def current_preferences():
    """Read preferences, falling back to safe defaults if the private file is corrupt."""
    try:
        return PREFERENCES_STORE.get()
    except PreferencesError:
        app.logger.warning('Unable to read appearance preferences; using defaults.')
        return dict(PREFERENCE_DEFAULTS)


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
        json.dump({key: info[key] for key in ('created_at', 'last_active', 'session_token', 'cols', 'rows', 'cwd', 'title', 'launcher', 'launcher_version', 'notification', 'dismissed_notification', 'project_id', 'workspace_id', 'coordination_token', 'session_role', 'handoff_id', 'handoff_token', 'handoff_source_session_id', 'handoff_mode') if key in info}, file)
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
            if info.get('session_role') not in (None, 'agent', 'workspace_shell'):
                raise ValueError('Invalid session role')
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


def session_api_payload(sid, info, ended=None):
    if ended is None:
        try:
            ended = not session_alive(sid)
        except (RuntimeError, OSError, subprocess.SubprocessError):
            ended = True
    return {
        'id': sid, 'token': info.get('session_token', ''), 'url': get_session_url(sid),
        'title': info.get('title', ''), 'launcher': info.get('launcher', 'terminal'),
        'session_role': info.get('session_role', 'agent'), 'project_id': info.get('project_id'),
        'workspace_id': info.get('workspace_id'), 'cwd': info.get('cwd', ''),
        'created_at': info.get('created_at'), 'ended': bool(ended),
    }


def get_session_by_token(token):
    with SESSIONS_LOCK:
        return next((sid for sid, value in session_tokens.items() if hmac.compare_digest(value.encode(), token.encode())), None)


def session_alive(sid):
    result = tmux_command('display-message', '-p', '-t', sid, '#{pane_dead}', check=False)
    return result.returncode == 0 and result.stdout.strip() == '0'


def ensure_tmux_attachment_alias():
    """Make the same /tmp path resolve inside the persistent tmux server namespace."""
    alias = ATTACHMENT_STORE.ensure_alias()
    target = str(ATTACHMENT_STORE.root.resolve())
    marker = TERMINAL_SESSIONS_DIR / f'.attachment-alias-{secrets.token_hex(12)}'
    alias_q, target_q, marker_q = map(shlex.quote, (str(alias), target, str(marker)))
    command = (
        'umask 077; '
        f'if [ -L {alias_q} ]; then '
        f'if [ "$(readlink -- {alias_q})" = {target_q} ]; then result=0; else result=2; fi; '
        f'elif [ -e {alias_q} ]; then result=2; '
        f'elif ln -s -- {target_q} {alias_q}; then result=0; '
        f'elif [ -L {alias_q} ] && [ "$(readlink -- {alias_q})" = {target_q} ]; then result=0; '
        f'else result=1; fi; '
        f'printf "%s" "$result" > {marker_q}'
    )
    try:
        tmux_command('run-shell', '-b', command)
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            try:
                result = marker.read_text(encoding='ascii')
                if result:
                    break
            except FileNotFoundError:
                pass
            time.sleep(0.02)
        else:
            raise AttachmentError('No se pudo verificar la ruta de adjuntos dentro de tmux.', 503)
        if result != '0':
            raise AttachmentError('La ruta de adjuntos no está disponible de forma segura dentro de tmux.', 503)
    except AttachmentError:
        raise
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        raise AttachmentError('No se pudo preparar la ruta compartida con tmux.', 503) from error
    finally:
        marker.unlink(missing_ok=True)


def cleanup_session(session_id):
    with SESSIONS_LOCK:
        if session_id not in terminal_sessions:
            return
        info = terminal_sessions[session_id]
        tmux_command('kill-session', '-t', session_id, check=False)
        terminal_sessions.pop(session_id, None)
        session_tokens.pop(session_id, None)
        (TERMINAL_SESSIONS_DIR / f'{session_id}.json').unlink(missing_ok=True)
        shutil.rmtree(TERMINAL_SESSIONS_DIR / session_id, ignore_errors=True)
        handoff_id = info.get('handoff_id')
        if handoff_id:
            try:
                HANDOFF_STORE.delete(handoff_id)
            except (HandoffError, OSError):
                app.logger.warning('Unable to remove private handoff package for session %s', session_id)


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
    # JSON can expand control characters to six-byte escapes before the decoded file limit applies.
    body_limit = (MAX_FILE_BYTES * 6 + 65536 if request.path.endswith('/file') and request.method == 'PUT'
                  else MAX_ATTACHMENT_REQUEST_BYTES if '/attachments' in request.path and request.method == 'POST'
                  else 65536)
    # Werkzeug uses this per-request limit while reading the body (including chunked bodies).
    request.max_content_length = body_limit
    if request.content_length is not None and request.content_length > body_limit:
        abort(413)
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
    embedded_console = request.path.startswith('/c/') and request.args.get('embed') == '1'
    response.headers['X-Frame-Options'] = 'SAMEORIGIN' if embedded_console else 'DENY'
    response.headers['Content-Security-Policy'] = "frame-ancestors 'self'; object-src 'none'; base-uri 'self'" if embedded_console else "frame-ancestors 'none'; object-src 'none'; base-uri 'self'"
    if (request.method == 'GET' and request.path == '/' and response.status_code == 200
            and client_accepts_gzip()):
        response.direct_passthrough = False
        response.set_data(gzip.compress(response.get_data(), compresslevel=6, mtime=0))
        response.headers['Content-Encoding'] = 'gzip'
        response.vary.add('Accept-Encoding')
    if request.method == 'GET' and request.path.startswith('/api/') and response.status_code == 200 \
            and response.mimetype == 'application/json':
        payload = response.get_data()
        if request.path == '/api/sessions':
            try:
                snapshot = json.loads(payload)
                observed_at = snapshot.get('observed_at')
                response.headers['X-WebConsole-Observed-At'] = str(observed_at or '')
                snapshot.pop('observed_at', None)
                for item in snapshot.get('sessions', []):
                    if isinstance(item, dict):
                        item.pop('observed_at', None)
                payload = json.dumps(snapshot, sort_keys=True, separators=(',', ':')).encode()
            except (TypeError, ValueError):
                pass
        # Session responses contain bearer tokens. A keyed validator permits
        # in-memory conditional polling without exposing a hash of those tokens.
        key = str(app.config['SECRET_KEY']).encode()
        response.set_etag(hmac.new(key, payload, hashlib.sha256).hexdigest())
        response.make_conditional(request)
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


TERMINAL_FLOW_VERSION = 1
TERMINAL_FLOW_FRAME_BYTES = 16 * 1024
TERMINAL_FLOW_MAX_UNACKED_BYTES = 128 * 1024
TERMINAL_FLOW_MAX_UNACKED_FRAMES = 32
TERMINAL_FLOW_ACK_TIMEOUT = 4.0
TERMINAL_PTY_COALESCE_SECONDS = 0.003
TERMINAL_PTY_BATCH_BYTES = 64 * 1024
TERMINAL_PTY_READ_BYTES = 8 * 1024


def enable_websocket_low_latency(ws):
    """Disable Nagle for small interactive terminal frames where supported."""
    try:
        ws.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        return True
    except (AttributeError, OSError, TypeError):
        # Some WSGI adapters expose a wrapped or non-TCP socket.
        return False


def read_pty_output_batch(master_fd):
    """Drain immediately available PTY output with only a tiny coalescing window."""
    output = bytearray()
    deadline = time.monotonic() + TERMINAL_PTY_COALESCE_SECONDS
    closed = False
    while len(output) < TERMINAL_PTY_BATCH_BYTES:
        try:
            chunk = os.read(master_fd, min(TERMINAL_PTY_READ_BYTES,
                                           TERMINAL_PTY_BATCH_BYTES - len(output)))
        except BlockingIOError:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([master_fd], [], [], remaining)[0]:
                break
            continue
        except OSError:
            closed = True
            break
        if not chunk:
            closed = True
            break
        output.extend(chunk)
    return bytes(output), closed


def encode_terminal_flow_frame(raw, sequence):
    """Encode a versioned, sequenced output block for render acknowledgements."""
    if len(raw) >= 192:
        compressed = zlib.compress(raw, level=1)
        if len(compressed) < len(raw):
            return b'\x03' + struct.pack('!Q', sequence) + compressed
    return b'\x02' + struct.pack('!Q', sequence) + raw


@sock.route('/ws/<session_id>')
def terminal_ws(ws, session_id):
    """Each browser attaches its own tmux client; tmux owns the persistent shell."""
    with SESSIONS_LOCK:
        info = terminal_sessions.get(session_id)
        if not info or info.get('clients', 0) >= MAX_CLIENTS:
            ws.close(reason=1008, message='Session unavailable or client limit reached')
            return
        info['clients'] = info.get('clients', 0) + 1
    if not enable_websocket_low_latency(ws):
        app.logger.debug('TCP_NODELAY is unavailable for terminal client %s', session_id)
    master_fd = slave_fd = None
    client = None
    stop = threading.Event()
    send_lock = threading.Lock()
    flow_enabled = request.args.get('flow') == str(TERMINAL_FLOW_VERSION)
    flow_condition = threading.Condition()
    flow = {
        'next_sequence': 1,
        'last_ack': 0,
        'last_sent': 0,
        'inflight': [],
        'unacked_bytes': 0,
        'lagged': False,
    }

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

    def send_terminal_output(raw):
        if not flow_enabled:
            safe_send(encode_terminal_frame(raw))
            return True

        for offset in range(0, len(raw), TERMINAL_FLOW_FRAME_BYTES):
            chunk = raw[offset:offset + TERMINAL_FLOW_FRAME_BYTES]
            with flow_condition:
                while not stop.is_set() and flow_enabled and (
                    len(flow['inflight']) >= TERMINAL_FLOW_MAX_UNACKED_FRAMES
                    or (flow['inflight'] and flow['unacked_bytes'] + len(chunk) > TERMINAL_FLOW_MAX_UNACKED_BYTES)
                ):
                    flow_condition.wait(timeout=0.2)
                if stop.is_set():
                    return False
                sequence = flow['next_sequence']
                flow['next_sequence'] += 1
                flow['last_sent'] = sequence
                sent_at = time.monotonic()
                flow['inflight'].append((sequence, sent_at, len(chunk)))
                flow['unacked_bytes'] += len(chunk)
            safe_send(encode_terminal_flow_frame(chunk, sequence))
        return True

    def acknowledge_terminal_output(sequence):
        with flow_condition:
            if sequence <= flow['last_ack'] or sequence > flow['last_sent']:
                return
            acknowledged = False
            while flow['inflight'] and flow['inflight'][0][0] <= sequence:
                _, _, size = flow['inflight'].pop(0)
                flow['unacked_bytes'] = max(0, flow['unacked_bytes'] - size)
                acknowledged = True
            if acknowledged:
                flow['last_ack'] = sequence
                flow_condition.notify_all()

    def terminal_output_is_lagging():
        if not flow_enabled:
            return False
        with flow_condition:
            if flow['lagged']:
                return True
            if flow['inflight'] and time.monotonic() - flow['inflight'][0][1] >= TERMINAL_FLOW_ACK_TIMEOUT:
                flow['lagged'] = True
                flow_condition.notify_all()
            return flow['lagged']

    def pty_reader():
        try:
            while not stop.is_set():
                ready, _, _ = select.select([master_fd], [], [], 0.045)
                if not ready:
                    continue
                buf, closed = read_pty_output_batch(master_fd)
                if buf:
                    if not send_terminal_output(buf):
                        break
                if closed:
                    stop.set()
                    break
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
        safe_send(json.dumps({'type': 'ready', 'flow_version': TERMINAL_FLOW_VERSION if flow_enabled else 0}))
        reader = threading.Thread(target=pty_reader, daemon=True)
        reader.start()
        while True:
            msg = ws.receive(timeout=0.5)
            if terminal_output_is_lagging():
                stop.set()
                try:
                    with send_lock:
                        ws.close(reason=1013, message='Terminal view fell behind; reconnect to current screen')
                except Exception:
                    pass
                break
            if stop.is_set():
                break
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
            elif data.get('type') == 'ack' and flow_enabled:
                sequence = data.get('seq')
                if isinstance(sequence, str) and sequence.isascii() and sequence.isdecimal() and len(sequence) <= 20:
                    acknowledge_terminal_output(int(sequence))
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
    return render_template('workspace.html', preferences=current_preferences())


@app.route('/api/preferences', methods=['GET', 'PUT'])
def api_preferences():
    if request.method == 'GET':
        return jsonify(current_preferences())
    payload = request.get_json(silent=True) or {}
    try:
        return jsonify(PREFERENCES_STORE.update(payload))
    except PreferencesError as error:
        return jsonify({'error': str(error)}), 400


@app.route('/c/<token>')
def console(token):
    session_id = get_session_by_token(token)
    if session_id and session_id in terminal_sessions:
        info = terminal_sessions[session_id]
        return render_template('console.html',
                             session_id=session_id,
                             token=token,
                             session_role=info.get('session_role', 'agent'),
                             embedded=request.args.get('embed') == '1',
                             cols=info.get('cols', 120),
                             rows=info.get('rows', 30),
                             preferences=current_preferences())
    abort(404, description='Session not found. Create a new session from the dashboard.')

def session_snapshot():
    with SESSIONS_LOCK:
        return list(terminal_sessions.items())


def prune_finished_attachments():
    active = set()
    for sid, _info in session_snapshot():
        try:
            if session_alive(sid):
                active.add(sid)
        except (OSError, RuntimeError, subprocess.SubprocessError):
            # Fail closed: an uncertain session must keep its temporary files.
            active.add(sid)
    try:
        removed = ATTACHMENT_STORE.prune(active)
        if removed:
            app.logger.info('Removed %s expired WebConsole attachment directories.', removed)
    except (OSError, AttachmentError):
        app.logger.exception('Attachment retention cleanup failed.')


def attachment_maintenance():
    while True:
        prune_finished_attachments()
        time.sleep(60 * 60)


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
            'launcher': info.get('launcher', 'terminal'), 'launcher_version': info.get('launcher_version', ''),
            'project_id': info.get('project_id'), 'workspace_id': info.get('workspace_id'),
            'session_role': info.get('session_role', 'agent'),
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


def agent_version(name):
    if name not in {'codex', 'opencode', 'hermes'}:
        return ''
    env = os.environ.copy()
    env.pop('WEBCONSOLE_PASSWORD', None)
    env.pop('SECRET_KEY', None)
    try:
        result = subprocess.run(['bash', '-lc', '"$1" --version', 'webconsole', name],
                                env=env, capture_output=True, text=True, timeout=5)
        if result.returncode:
            return ''
        line = (result.stdout or result.stderr).strip().splitlines()[0][:120]
        return re.sub(r'[\x00-\x1f\x7f]', '', line)
    except (OSError, subprocess.SubprocessError, IndexError):
        return ''


@app.route('/api/sessions', methods=['POST'])
def api_create_session():
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        abort(400)
    return create_agent_session_response(payload)


def create_agent_session_response(payload, trusted_info=None, session_identity=None):
    """Create one persistent workspace session; trusted handoff metadata never comes from HTTP input."""
    launcher = payload.get('agent', 'terminal')
    if not isinstance(launcher, str) or launcher not in {'terminal', 'codex', 'opencode', 'hermes'}:
        abort(400)
    title = payload.get('title', '')
    if not isinstance(title, str) or len(title) > 100:
        abort(400)
    workspace_id = payload.get('workspace_id')
    project_id = None
    if workspace_id is not None:
        if not isinstance(workspace_id, str):
            abort(400)
        project, workspace = PROJECT_STORE.get_workspace(workspace_id)
        if not project or not workspace:
            return jsonify({'error': 'El workspace ya no existe. Actualiza la lista de proyectos.'}), 400
        cwd = workspace['path']
        supplied_cwd = payload.get('cwd')
        if supplied_cwd and (not isinstance(supplied_cwd, str) or os.path.realpath(supplied_cwd) != os.path.realpath(cwd)):
            return jsonify({'error': 'El directorio debe coincidir con el workspace seleccionado.'}), 400
        project_id = project['id']
    else:
        cwd = payload.get('cwd') or str(Path.home())
    if not isinstance(cwd, str) or not os.path.isdir(cwd):
        abort(400)
    if launcher != 'terminal' and not agent_available(launcher):
        return jsonify({'error': f'{launcher} no está instalado o no está en PATH.'}), 400
    launcher_version = agent_version(launcher)
    with SESSIONS_LOCK:
        if project_id:
            current_project, current_workspace = PROJECT_STORE.get_workspace(workspace_id)
            if (not current_project or current_project['id'] != project_id or not current_workspace
                    or os.path.realpath(current_workspace['path']) != os.path.realpath(cwd)
                    or not os.path.isdir(current_workspace['path'])):
                return jsonify({'error': 'El workspace cambió o se quitó antes de iniciar la sesión.'}), 409
            cwd = current_workspace['path']
        if len(terminal_sessions) >= MAX_SESSIONS:
            return jsonify({'error': 'Session limit reached; delete unused sessions.'}), 429
        sid, token = session_identity if session_identity else (uuid.uuid4().hex[:12], generate_token())
        if not sanitize_session_id(sid) or not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9_-]{40,64}', token):
            abort(400)
        if sid in terminal_sessions or (TERMINAL_SESSIONS_DIR / f'{sid}.json').exists():
            return jsonify({'error': 'El identificador de sesión ya está en uso.'}), 409
        now = time.time()
        info = dict(created_at=now, last_active=now, session_token=token,
                    cols=120, rows=30, cwd=os.path.abspath(cwd), pid=None, clients=0, title=title.strip(), launcher=launcher,
                    launcher_version=launcher_version)
        if project_id:
            info.update(project_id=project_id, workspace_id=workspace_id,
                        coordination_token=new_coordination_token())
        allowed_internal_fields = {'handoff_id', 'handoff_token', 'handoff_source_session_id', 'handoff_mode'}
        if isinstance(trusted_info, dict):
            info.update({key:value for key, value in trusted_info.items() if key in allowed_internal_fields})
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
    return jsonify({'id': sid, 'token': token, 'url': get_session_url(sid),
                    'project_id': project_id, 'workspace_id': workspace_id}), 201


def opencode_conversation_reference(session_id, info):
    directory = TERMINAL_SESSIONS_DIR / session_id
    try:
        directory_info = os.lstat(directory)
    except OSError as error:
        raise HandoffError('Esta sesión no tiene un enlace OpenCode registrado. Inicia una sesión OpenCode con la integración actual; no se adivina la conversación desde el scrollback.') from error
    if not stat.S_ISDIR(directory_info.st_mode) or stat.S_IMODE(directory_info.st_mode) & 0o077:
        raise HandoffError('El registro privado de OpenCode no es válido.')
    path = directory / 'opencode-session.json'
    try:
        file_info = os.lstat(path)
    except OSError as error:
        raise HandoffError('OpenCode aún no ha registrado su ID nativo. El traspaso requiere la integración cargada al iniciar la sesión; no se usa el scrollback.') from error
    if not stat.S_ISREG(file_info.st_mode) or stat.S_IMODE(file_info.st_mode) & 0o077 or file_info.st_size > 4096:
        raise HandoffError('No se encontró un identificador privado de conversación OpenCode válido.')
    try:
        reference = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise HandoffError('No se pudo leer el identificador de conversación OpenCode.') from error
    native_id = reference.get('session_id') if isinstance(reference, dict) else None
    native_cwd = reference.get('cwd') if isinstance(reference, dict) else None
    if not isinstance(native_id, str) or not NATIVE_SESSION_ID.fullmatch(native_id):
        raise HandoffError('OpenCode aún no ha registrado su ID nativo. El traspaso requiere la integración cargada al iniciar la sesión; no se usa el scrollback.')
    if not isinstance(native_cwd, str) or os.path.realpath(native_cwd) != os.path.realpath(info.get('cwd', '')):
        raise HandoffError('La conversación OpenCode pertenece a otro directorio; no se exportó.')
    return native_id


def export_opencode_conversation(cwd, native_session_id):
    """Run the documented CLI export with a timeout and a hard output bound."""
    if not NATIVE_SESSION_ID.fullmatch(native_session_id):
        raise HandoffError('El identificador de conversación no es válido.')
    command = shlex.join(['opencode', 'session', 'export', '--sanitize', native_session_id])
    shell = 'cd -- ' + shlex.quote(cwd) + ' && exec ' + command
    env = os.environ.copy()
    for name in ('WEBCONSOLE_PASSWORD', 'SECRET_KEY', 'WEBCONSOLE_SESSION_ID',
                 'WEBCONSOLE_EVENT_DIR', 'WEBCONSOLE_PROJECT_ID',
                 'WEBCONSOLE_COORDINATION_TOKEN', 'WEBCONSOLE_HANDOFF_ID',
                 'WEBCONSOLE_HANDOFF_TOKEN'):
        env.pop(name, None)
    try:
        process = subprocess.Popen(['bash', '-lc', shell], cwd=cwd, env=env,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    start_new_session=True)
    except OSError as error:
        raise HandoffError('No se pudo iniciar la exportación de OpenCode.') from error
    streams = [process.stdout, process.stderr]
    output, errors = bytearray(), bytearray()
    deadline = time.monotonic() + 45
    try:
        while streams:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise HandoffError('La exportación de OpenCode agotó el tiempo límite.')
            ready, _, _ = select.select(streams, [], [], min(0.25, remaining))
            if not ready and process.poll() is not None:
                ready = list(streams)
            for stream in ready:
                chunk = os.read(stream.fileno(), 65536)
                if not chunk:
                    streams.remove(stream)
                    stream.close()
                elif stream is process.stdout:
                    if len(output) + len(chunk) > MAX_HANDOFF_EXPORT_BYTES:
                        raise HandoffError('La exportación de OpenCode supera el límite privado de 32 MiB.')
                    output.extend(chunk)
                elif len(errors) < 65536:
                    errors.extend(chunk[:65536 - len(errors)])
        try:
            return_code = process.wait(timeout=max(0.1, deadline - time.monotonic()))
        except subprocess.TimeoutExpired as error:
            raise HandoffError('La exportación de OpenCode agotó el tiempo límite.') from error
    except Exception:
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except OSError:
                process.kill()
            process.wait(timeout=5)
        for stream in streams:
            try:
                stream.close()
            except OSError:
                pass
        raise
    if return_code != 0:
        raise HandoffError('OpenCode no pudo exportar esta conversación. Comprueba que su servicio sigue disponible.')
    try:
        return json.loads(output.decode('utf-8'))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise HandoffError('OpenCode no devolvió una exportación JSON válida.') from error


def current_handoff_source_state(session_id, info):
    telemetry.sample(force=True)
    return telemetry.payload(session_id, info)


def public_handoff(manifest):
    return {key: manifest.get(key) for key in (
        'id', 'state', 'source', 'project_id', 'workspace_id', 'target_agent',
        'mode', 'target_session_id', 'created_at', 'updated_at', 'received_at',
        'message_count', 'preview', 'error')}


def verify_handoff_source(session_id, info):
    if not info or info.get('launcher') != 'opencode' or info.get('session_role') == 'workspace_shell':
        raise HandoffError('El traspaso OpenCode → Codex requiere una sesión de OpenCode.')
    if not info.get('project_id') or not info.get('workspace_id'):
        raise HandoffError('La sesión debe pertenecer a un workspace registrado.')
    project, workspace = PROJECT_STORE.get_workspace(info['workspace_id'])
    if (not project or project['id'] != info['project_id'] or not workspace
            or os.path.realpath(workspace['path']) != os.path.realpath(info.get('cwd', ''))):
        raise HandoffError('El workspace original cambió o ya no está disponible.')
    try:
        if not session_alive(session_id):
            raise HandoffError('La sesión de origen ya terminó; se conserva y no se ha creado otra.')
    except (RuntimeError, OSError, subprocess.SubprocessError) as error:
        raise HandoffError('No se pudo comprobar la sesión de origen.') from error
    activity = current_handoff_source_state(session_id, info)
    if activity.get('state') in {'working', 'permission'} or (info.get('notification') or {}).get('kind') == 'permission':
        raise HandoffError('OpenCode está trabajando o espera un permiso. Espera a que termine o resuelve el permiso antes del traspaso.')
    native_id = opencode_conversation_reference(session_id, info)
    return project, workspace, native_id, activity


@app.route('/api/sessions/<session_id>/handoff/capabilities')
def api_handoff_capabilities(session_id):
    sid = sanitize_session_id(session_id)
    info = terminal_sessions.get(sid)
    if not sid or not info:
        abort(404)
    available = agent_available('codex')
    try:
        project, workspace, native_id, activity = verify_handoff_source(sid, info)
        source_ready = True
        message = ''
    except HandoffError as error:
        project = workspace = native_id = activity = None
        source_ready = False
        message = str(error)
    return jsonify({'source_agent':info.get('launcher'), 'source_ready':source_ready,
                    'source_message':message, 'source_state':activity.get('state') if activity else None,
                    'source_state_source':activity.get('state_source') if activity else None,
                    'native_conversation_linked':bool(native_id),
                    'targets':[{'id':'codex', 'available':available,
                                'enabled':bool(source_ready and available),
                                'message':'' if available else 'Codex no está instalado o no está en PATH.'}],
                    'workspace_id':workspace['id'] if workspace else info.get('workspace_id'),
                    'project_id':project['id'] if project else info.get('project_id')})


@app.route('/api/sessions/<session_id>/handoffs', methods=['POST'])
def api_prepare_handoff(session_id):
    source_id = sanitize_session_id(session_id)
    source = terminal_sessions.get(source_id)
    if not source_id or not source:
        abort(404)
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict) or payload.get('target_agent') != 'codex' or payload.get('mode') not in {'wait', 'continue'}:
        return jsonify({'error':'El destino o el modo de continuación no son válidos.'}), 400
    if not agent_available('codex'):
        return jsonify({'error':'Codex no está instalado o no está en PATH.'}), 400
    try:
        project, workspace, native_id, activity = verify_handoff_source(source_id, source)
        exported = export_opencode_conversation(workspace['path'], native_id)
        messages, preview = normalize_opencode_export(exported, native_id, workspace['path'])
        # Refuse a snapshot that became active while the export was running.
        activity_after = current_handoff_source_state(source_id, source)
        if activity_after.get('state') in {'working', 'permission'}:
            return jsonify({'error':'OpenCode volvió a trabajar durante la exportación. No se guardó el traspaso; espera y prepara otra captura.'}), 409
        fingerprint = hashlib.sha256(json.dumps(messages, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')).hexdigest()
        if activity.get('state_source') != 'event':
            preview['warnings'].append('La inactividad del origen es una estimación de procesos; revísala antes de continuar automáticamente.')
        token = generate_token()
        export_data = exported.get('data', exported) if isinstance(exported, dict) else {}
        export_info = export_data.get('info') if isinstance(export_data, dict) else {}
        export_time = export_info.get('time') if isinstance(export_info, dict) else {}
        handoff_id = HANDOFF_STORE.create(
            source_session_id=source_id, native_session_id=native_id,
            project_id=project['id'], workspace_id=workspace['id'], cwd=workspace['path'],
            source_title=source.get('title', ''), source_updated=export_time.get('updated') if isinstance(export_time, dict) else None,
            source_fingerprint=fingerprint, messages=messages, preview=preview, token=token, mode=payload['mode'])
        manifest = HANDOFF_STORE.get(handoff_id)
        return jsonify({'handoff':public_handoff(manifest)}), 201
    except HandoffError as error:
        return jsonify({'error':str(error)}), 409
    except (OSError, RuntimeError, subprocess.SubprocessError, TypeError, ValueError):
        app.logger.exception('OpenCode handoff preparation failed for session %s', source_id)
        return jsonify({'error':'No se pudo preparar el contexto privado. La sesión original permanece intacta.'}), 503


@app.route('/api/handoffs/<handoff_id>')
def api_get_handoff(handoff_id):
    try:
        manifest = HANDOFF_STORE.get(handoff_id)
    except HandoffError:
        abort(404)
    if not PROJECT_STORE.get(manifest.get('project_id')):
        abort(404)
    return jsonify({'handoff':public_handoff(manifest)})


@app.route('/api/handoffs/<handoff_id>/confirm', methods=['POST'])
def api_confirm_handoff(handoff_id):
    try:
        manifest = HANDOFF_STORE.get(handoff_id)
    except HandoffError:
        abort(404)

    # Recover a completed or in-flight create before consulting the source again.
    # This makes a lost HTTP response safe without starting a duplicate agent.
    existing_id = manifest.get('target_session_id')
    if manifest.get('state') in {'awaiting_context', 'received'} and existing_id:
        existing = terminal_sessions.get(existing_id)
        if not existing or existing.get('handoff_id') != handoff_id:
            return jsonify({'error':'La entrega ya comenzó, pero no se pudo recuperar su sesión destino. No se creó otra.'}), 409
        return jsonify({'id':existing_id, 'token':existing.get('session_token'), 'url':get_session_url(existing_id),
                        'project_id':existing.get('project_id'), 'workspace_id':existing.get('workspace_id'),
                        'handoff':public_handoff(manifest)})
    if manifest.get('state') == 'creating' and existing_id:
        existing = terminal_sessions.get(existing_id)
        if existing and existing.get('handoff_id') == handoff_id:
            try:
                if session_alive(existing_id):
                    manifest = HANDOFF_STORE.update_if_state(handoff_id, {'creating'}, state='awaiting_context')
            except (RuntimeError, OSError, subprocess.SubprocessError):
                pass
            return jsonify({'id':existing_id, 'token':existing.get('session_token'), 'url':get_session_url(existing_id),
                            'project_id':existing.get('project_id'), 'workspace_id':existing.get('workspace_id'),
                            'handoff':public_handoff(manifest)})
        if not existing and not (TERMINAL_SESSIONS_DIR / f'{existing_id}.json').exists():
            try:
                if session_alive(existing_id):
                    return jsonify({'error':'La creación del destino tiene un estado incierto. No se duplicó la sesión; revisa la lista de agentes.'}), 409
            except (RuntimeError, OSError, subprocess.SubprocessError):
                return jsonify({'error':'No se pudo comprobar el estado de la creación. No se duplicó la sesión.'}), 409
            # A crash after claiming but before writing session metadata cannot
            # have launched the managed tmux session; allow a safe explicit retry.
            manifest = HANDOFF_STORE.update(handoff_id, state='failed', target_session_id=None,
                                            error='La creación anterior no llegó a registrar una sesión destino.')
        else:
            return jsonify({'error':'La creación del destino tiene un estado incierto. No se duplicó la sesión; revisa la lista de agentes.'}), 409

    source_id = sanitize_session_id(manifest.get('source', {}).get('session_id'))
    source = terminal_sessions.get(source_id)
    try:
        if not source:
            raise HandoffError('La sesión de origen ya no está registrada. El paquete se conserva.')
        project, workspace, native_id, activity = verify_handoff_source(source_id, source)
        if project['id'] != manifest.get('project_id') or workspace['id'] != manifest.get('workspace_id'):
            raise HandoffError('El workspace del origen cambió desde la vista previa. Prepara un traspaso nuevo.')
        if native_id != manifest.get('source', {}).get('native_session_id'):
            raise HandoffError('OpenCode cambió de conversación desde la vista previa. Prepara un traspaso nuevo.')
        exported = export_opencode_conversation(workspace['path'], native_id)
        messages, _ = normalize_opencode_export(exported, native_id, workspace['path'])
        activity_after = current_handoff_source_state(source_id, source)
        if activity_after.get('state') in {'working', 'permission'}:
            raise HandoffError('OpenCode volvió a trabajar durante la verificación. No se creó Codex; espera y prepara una captura nueva.')
        fingerprint = hashlib.sha256(json.dumps(messages, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')).hexdigest()
        if not hmac.compare_digest(fingerprint, manifest.get('source_fingerprint', '')):
            HANDOFF_STORE.update(handoff_id, state='stale', error='La conversación cambió desde la vista previa. Prepara una captura nueva.')
            return jsonify({'error':'La conversación cambió desde la vista previa. Prepara una captura nueva.'}), 409
    except HandoffError as error:
        return jsonify({'error':str(error)}), 409
    except (OSError, RuntimeError, subprocess.SubprocessError, TypeError, ValueError):
        app.logger.exception('OpenCode handoff revalidation failed for %s', handoff_id)
        return jsonify({'error':'No se pudo verificar que la captura siga actual. No se creó Codex.'}), 503

    target_id = uuid.uuid4().hex[:12]
    target_token = generate_token()
    try:
        manifest = HANDOFF_STORE.claim_target(handoff_id, target_id, manifest.get('mode'))
    except HandoffError as error:
        return jsonify({'error':str(error)}), 409
    title = ('Continuación: ' + str(source.get('title') or manifest.get('preview', {}).get('title') or 'OpenCode'))[:100]
    response = create_agent_session_response(
        {'agent':'codex', 'workspace_id':workspace['id'], 'title':title},
        trusted_info={'handoff_id':handoff_id, 'handoff_token':manifest.get('mcp_token'),
                      'handoff_source_session_id':source_id, 'handoff_mode':manifest.get('mode')},
        session_identity=(target_id, target_token))
    response_obj, status = response if isinstance(response, tuple) else (response, response.status_code)
    if status != 201:
        HANDOFF_STORE.update(handoff_id, state='failed', target_session_id=None,
                             error=(response_obj.get_json(silent=True) or {}).get('error', 'No se pudo crear Codex.'))
        return response
    HANDOFF_STORE.update_if_state(handoff_id, {'creating'}, state='awaiting_context')
    result = response_obj.get_json()
    result['handoff'] = public_handoff(HANDOFF_STORE.get(handoff_id))
    return jsonify(result), 201


@app.route('/api/handoffs/<handoff_id>/cancel', methods=['POST'])
def api_cancel_handoff(handoff_id):
    try:
        manifest = HANDOFF_STORE.get(handoff_id)
        if manifest.get('state') not in {'prepared', 'stale', 'failed'} or manifest.get('target_session_id'):
            return jsonify({'error':'El traspaso ya tiene una sesión destino y no puede cancelarse aquí.'}), 409
        HANDOFF_STORE.delete(handoff_id)
        return jsonify({'success':True})
    except HandoffError:
        abort(404)


@app.route('/api/workspaces/<workspace_id>/terminal', methods=['POST'])
def api_workspace_terminal(workspace_id):
    """Return this workspace's dedicated shell or explicitly create a replacement."""
    project, workspace = PROJECT_STORE.get_workspace(workspace_id)
    if not project or not workspace:
        abort(404)
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict) or not isinstance(payload.get('new', False), bool):
        abort(400)
    create_new = payload.get('new', False)
    cwd = workspace.get('path')
    if not isinstance(cwd, str) or not os.path.isdir(cwd):
        return jsonify({'error': 'El workspace ya no está disponible.'}), 409

    with SESSIONS_LOCK:
        current_project, current_workspace = PROJECT_STORE.get_workspace(workspace_id)
        if (not current_project or current_project['id'] != project['id'] or not current_workspace
                or os.path.realpath(current_workspace['path']) != os.path.realpath(cwd)
                or not os.path.isdir(current_workspace['path'])):
            return jsonify({'error': 'El workspace cambió o se quitó antes de abrir su terminal.'}), 409
        project, workspace = current_project, current_workspace
        cwd = workspace['path']
        matches = [(sid, info) for sid, info in terminal_sessions.items()
                   if info.get('session_role') == 'workspace_shell'
                   and info.get('workspace_id') == workspace_id
                   and info.get('project_id') == project['id']]
        live = []
        for sid, info in matches:
            try:
                if session_alive(sid):
                    live.append((sid, info))
            except (RuntimeError, OSError, subprocess.SubprocessError):
                return jsonify({'error': 'No se pudo comprobar la terminal persistente.'}), 503
        if live:
            sid, info = max(live, key=lambda item: item[1].get('created_at', 0))
            return jsonify({'session': session_api_payload(sid, info, ended=False), 'created': False})
        if matches and not create_new:
            sid, info = max(matches, key=lambda item: item[1].get('created_at', 0))
            return jsonify({'session': session_api_payload(sid, info, ended=True), 'created': False})
        if len(terminal_sessions) >= MAX_SESSIONS:
            return jsonify({'error': 'Se alcanzó el límite de sesiones; elimina sesiones finalizadas antes de crear otra.'}), 429
        sid = uuid.uuid4().hex[:12]
        token = generate_token()
        now = time.time()
        info = dict(created_at=now, last_active=now, session_token=token,
                    cols=120, rows=30, cwd=os.path.abspath(cwd), pid=None, clients=0,
                    title='Terminal del workspace', launcher='terminal', launcher_version='',
                    project_id=project['id'], workspace_id=workspace_id,
                    session_role='workspace_shell')
        try:
            persist_session(sid, info)
            command = shlex.join([sys.executable, str(Path(__file__).with_name('session_shell.py')),
                                  str(TERMINAL_SESSIONS_DIR), sid])
            tmux_command('new-session', '-d', '-s', sid, '-x', '120', '-y', '30',
                         '-c', info['cwd'], command)
        except (OSError, RuntimeError, subprocess.SubprocessError) as error:
            app.logger.exception('Workspace terminal creation failed: %s', getattr(error, 'stderr', str(error)))
            if TMUX_BIN:
                tmux_command('kill-session', '-t', sid, check=False)
            (TERMINAL_SESSIONS_DIR / f'{sid}.json').unlink(missing_ok=True)
            return jsonify({'error': 'No se pudo crear la terminal del workspace. Comprueba tmux y los registros del servidor.'}), 503
        terminal_sessions[sid] = info
        session_tokens[sid] = token
        return jsonify({'session': session_api_payload(sid, info, ended=False), 'created': True}), 201


def require_attachment_session(session_id):
    sid = sanitize_session_id(session_id)
    expected = session_tokens.get(sid)
    supplied = request.headers.get('X-WebConsole-Session', '')
    if not sid or not expected or not hmac.compare_digest(expected.encode(), supplied.encode()):
        abort(403)
    origin = request.headers.get('Origin')
    if (request.method == 'POST' or origin) and not same_origin():
        abort(403)
    info = terminal_sessions.get(sid)
    if not info or info.get('session_role') == 'workspace_shell':
        abort(404)
    return sid, info


@app.route('/api/sessions/<session_id>/attachments', methods=['POST'])
def api_upload_attachments(session_id):
    sid, _ = require_attachment_session(session_id)
    try:
        if not session_alive(sid):
            return jsonify({'error': 'La sesión ya terminó; no se aceptan adjuntos nuevos.'}), 409
    except (RuntimeError, OSError, subprocess.SubprocessError):
        return jsonify({'error': 'No se pudo comprobar la sesión.'}), 503
    try:
        ensure_tmux_attachment_alias()
        attachments = ATTACHMENT_STORE.upload(sid, request.files.getlist('files'))
        return jsonify({'attachments': attachments}), 201
    except AttachmentError as error:
        return jsonify({'error': str(error)}), error.status


@app.route('/api/sessions/<session_id>/attachments/<attachment_id>')
def api_get_attachment(session_id, attachment_id):
    sid, _ = require_attachment_session(session_id)
    try:
        ensure_tmux_attachment_alias()
        return jsonify({'attachment': ATTACHMENT_STORE.get(sid, attachment_id)})
    except AttachmentError as error:
        return jsonify({'error': str(error)}), error.status

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


def project_workspaces(project_id):
    """Discover existing Git worktrees without creating or changing any refs."""
    project = PROJECT_STORE.get(project_id)
    if not project:
        abort(404)
    try:
        base_git = inspect_git(project['path'])
    except GitError:
        base_git = {'available': False, 'is_git': False}
    if base_git.get('is_git'):
        repo_root = base_git['root']
        try:
            relative = os.path.relpath(project['path'], repo_root)
            if relative == '..' or relative.startswith('..' + os.sep):
                relative = None
        except ValueError:
            relative = None
        if relative is not None:
            for worktree in base_git.get('worktrees', []):
                if worktree.get('bare') or not worktree.get('path'):
                    continue
                root = os.path.realpath(worktree['path'])
                candidate = os.path.realpath(os.path.join(root, relative))
                try:
                    contained = os.path.commonpath((root, candidate)) == root
                except ValueError:
                    contained = False
                if not contained or not os.path.isdir(candidate):
                    continue
                if any(os.path.realpath(item['path']) == candidate for item in project['workspaces']):
                    continue
                identity = 'wt-' + hashlib.sha256(candidate.encode()).hexdigest()[:16]
                ref = worktree.get('branch', '')
                branch = ref.removeprefix('refs/heads/') if ref else ''
                label = branch or Path(root).name
                try:
                    PROJECT_STORE.add_workspace(project_id, {
                        'id': identity, 'name': label[:100], 'path': candidate,
                        'worktree_root': root, 'kind': 'existing_worktree',
                        'created_at': time.time(), 'branch': branch,
                    })
                except ProjectError as error:
                    app.logger.warning('Could not register discovered Git worktree: %s', error)
            project = PROJECT_STORE.get(project_id)

    sessions = session_snapshot()
    result = []
    for workspace in project['workspaces']:
        try:
            git = inspect_git(workspace['path'])
            if git.get('is_git'):
                PROJECT_STORE.update_workspace(project_id, workspace['id'], branch=git.get('branch', ''))
        except GitError as error:
            git = {'available': False, 'is_git': False, 'error': str(error)}
        result.append({**workspace, 'git': git,
                       'session_count': sum(1 for _, info in sessions if info.get('workspace_id') == workspace['id']),
                       'available': os.path.isdir(workspace['path'])})
    return {'project': {key: project[key] for key in ('id', 'name', 'path')},
            'workspaces': result}


@app.route('/workspace')
def workspace():
    return render_template('workspace.html')


@app.route('/api/projects', methods=['GET', 'POST'])
def api_projects():
    if request.method == 'GET':
        sessions = session_snapshot()
        return jsonify({'projects': [
            {'id': project['id'], 'name': project['name'], 'path': project['path'],
             'workspace_count': len(project['workspaces']),
             'managed_worktree_count': sum(1 for workspace in project['workspaces'] if workspace.get('kind') == 'managed_worktree'),
             'session_count': sum(1 for _, info in sessions if info.get('project_id') == project['id'])}
            for project in PROJECT_STORE.list()]})
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        abort(400)
    if not isinstance(payload.get('path'), str) or not payload['path'].strip():
        return jsonify({'error': 'Indica una ruta de carpeta válida.'}), 400
    try:
        selected_path = resolve_directory(payload.get('path'), excluded=(TERMINAL_SESSIONS_DIR, WORKTREE_DIR,
                                                                          ATTACHMENT_STORE.root, HANDOFF_STORE.root))
        project = PROJECT_STORE.add(str(selected_path), payload.get('name', ''))
    except (ProjectError, DirectoryError) as error:
        return jsonify({'error': str(error)}), 400
    return jsonify({'project': {'id': project['id'], 'name': project['name'], 'path': project['path']}}), 201


@app.get('/api/host-directories')
def api_host_directories():
    path = request.args.get('path') or None
    try:
        return jsonify(list_directories(path, excluded=(TERMINAL_SESSIONS_DIR, WORKTREE_DIR,
                                                         ATTACHMENT_STORE.root, HANDOFF_STORE.root)))
    except DirectoryError as error:
        return jsonify({'error': str(error)}), 400


@app.get('/api/github/status')
def api_github_status():
    return jsonify(github_status())


@app.get('/api/github/repositories')
def api_github_repositories():
    try:
        return jsonify(github_repositories(request.args.get('q', '')))
    except GitHubError as error:
        return jsonify({'error': str(error)}), 400


@app.get('/api/github/branches')
def api_github_branches():
    try:
        return jsonify(github_branches(request.args.get('repo', ''), request.args.get('authenticated') == '1'))
    except GitHubError as error:
        return jsonify({'error': str(error)}), 400


@app.post('/api/projects/clone')
def api_clone_project():
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        abort(400)
    parent, folder, branch = payload.get('parent'), payload.get('folder'), payload.get('branch')
    source_url, full_name = payload.get('url'), payload.get('repo')
    if not isinstance(parent, str) or not isinstance(folder, str) or not isinstance(branch, str):
        return jsonify({'error': 'Indica carpeta de destino, nombre y rama.'}), 400
    if (not folder or len(folder) > 100 or folder in {'.', '..'}
            or any(char in folder for char in '/\\\x00\r\n')):
        return jsonify({'error': 'El nombre de la carpeta no es válido.'}), 400
    if not branch or len(branch) > 250 or any(char in branch for char in '\x00\r\n'):
        return jsonify({'error': 'Selecciona una rama válida.'}), 400
    try:
        if full_name:
            if not isinstance(full_name, str) or not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', full_name):
                raise GitHubError('Selecciona un repositorio válido.')
            source_url = f'https://github.com/{full_name}.git'
        normalized_url, normalized_name = validate_public_url(source_url)
        if full_name and normalized_name.casefold() != full_name.casefold():
            raise GitHubError('El repositorio seleccionado no coincide con el enlace.')
        if not shutil.which('git'):
            raise GitHubError('Git no está instalado en el servidor.')
        parent_path = resolve_directory(parent, excluded=(TERMINAL_SESSIONS_DIR, WORKTREE_DIR,
                                                          ATTACHMENT_STORE.root, HANDOFF_STORE.root))
        if run_git(parent_path, 'check-ref-format', '--branch', branch, check=False).returncode:
            raise GitHubError('La rama seleccionada no es válida para Git.')
        requested_branch = payload.get('new_branch', '')
        if requested_branch:
            if (not isinstance(requested_branch, str) or not full_name or len(requested_branch) > 200
                    or any(char in requested_branch for char in '\x00\r\n')):
                raise GitHubError('La rama nueva requiere un repositorio de la cuenta autenticada.')
            permission = repository_permission(full_name)
            current = github_status()
            if not permission['owned'] or not current['authenticated']:
                raise GitHubError('Solo puedes crear una rama para un repositorio propio con gh autenticado.')
            new_branch = requested_branch
            if len(new_branch) > 200 or run_git(parent_path, 'check-ref-format', '--branch', new_branch, check=False).returncode:
                raise GitHubError('El nombre de la rama nueva no es válido para Git.')
        else:
            new_branch = ''
        destination = parent_path / folder
        if destination.exists() or destination.is_symlink():
            raise GitHubError('Ya existe una carpeta con ese nombre. Elige otro destino.')
        # mkdir reserves the exact user-selected destination atomically. Git only
        # writes into this new directory; no existing checkout is touched.
        destination.mkdir(mode=0o700)
        try:
            clone_repository(normalized_url, destination, branch, timeout=120)
            if new_branch:
                switch_to_new_branch(destination, new_branch, f'origin/{branch}', timeout=15)
        except GitError as error:
            # Keep the newly-created directory for explicit recovery; never
            # recursively delete a path whose ownership may have changed.
            raise GitHubError('No se pudo completar el clone. Revisa la conectividad o el acceso Git; la carpeta reservada puede contener un clone incompleto.') from error
        try:
            project = PROJECT_STORE.add(str(destination), folder)
        except ProjectError as error:
            raise GitHubError(f'El clone quedó en {destination}, pero no se pudo registrar: {error}') from error
        return jsonify({'project': {'id': project['id'], 'name': project['name'], 'path': project['path']},
                        'branch': new_branch or branch, 'published': False}), 201
    except (GitHubError, GitError, DirectoryError, OSError) as error:
        return jsonify({'error': str(error)}), 400


@app.post('/api/projects/publish-branch')
def api_publish_project_branch():
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        abort(400)
    project_path, repo, branch, base_branch = (payload.get('path'), payload.get('repo'),
                                               payload.get('branch'), payload.get('base_branch'))
    if not all(isinstance(value, str) for value in (project_path, repo, branch, base_branch)):
        abort(400)
    if (len(project_path) > 4096 or not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo)
            or len(branch) > 200 or len(base_branch) > 200
            or any(char in branch + base_branch for char in '\x00\r\n')):
        return jsonify({'error': 'El proyecto, repositorio o rama no es válido.'}), 400
    try:
        permission = repository_permission(repo)
        if not permission['owned'] or not permission['push']:
            raise GitHubError('Solo se pueden publicar ramas en repositorios propios con permiso de escritura.')
        project_root = Path(project_path).resolve(strict=True)
        project = next((item for item in PROJECT_STORE.list() if item['path'] == str(project_root)), None)
        if not project:
            raise GitHubError('El proyecto ya no está registrado.')
        branch_check = run_git(project_root, 'check-ref-format', '--branch', branch, check=False)
        base_check = run_git(project_root, 'check-ref-format', '--branch', base_branch, check=False)
        current = run_git(project_root, 'branch', '--show-current').stdout.strip()
        if branch_check.returncode or base_check.returncode or current != branch:
            raise GitHubError('La rama local seleccionada cambió. Actualiza el proyecto antes de publicar.')
        remote = run_git(project_root, 'remote', 'get-url', 'origin').stdout.strip()
        _, expected_repo = validate_public_url(f'https://github.com/{repo}')
        _, actual_repo = validate_public_url(remote)
        if actual_repo.casefold() != expected_repo.casefold():
            raise GitHubError('El remoto origin ya no coincide con el repositorio seleccionado.')
        base_ref = f'refs/remotes/origin/{base_branch}'
        base_commit = run_git(project_root, 'rev-parse', '--verify', f'{base_ref}^{{commit}}', check=False)
        if base_commit.returncode:
            raise GitHubError('No se encontró la rama base remota. No se creó ninguna referencia.')
        gh = resolve_gh()
        if not gh:
            raise GitHubError('GitHub CLI (gh) no está disponible para publicar la rama.')
        owner, name = repo.split('/', 1)
        # GitHub's create-ref endpoint is conditional: an existing remote ref
        # fails instead of being advanced by a racing push.
        result = subprocess.run([gh, 'api', '--method', 'POST',
                                 f'/repos/{owner}/{name}/git/refs',
                                 '-f', f'ref=refs/heads/{branch}', '-f', f'sha={base_commit.stdout.strip()}'],
                                capture_output=True, text=True, timeout=20, check=False,
                                env={**{key:value for key,value in os.environ.items()
                                        if not key.startswith('WEBCONSOLE_') and key not in {'SECRET_KEY','FLASK_SECRET_KEY'}},
                                     'GH_PROMPT_DISABLED':'1'})
        if result.returncode:
            raise GitHubError('GitHub no pudo crear la rama. Puede existir ya o faltar permisos; no se sobrescribió.')
        push_branch(project_root, branch)
        run_git(project_root, 'branch', '--set-upstream-to', f'origin/{branch}', branch, check=False)
        return jsonify({'published': True, 'branch': branch})
    except (GitHubError, GitError, DirectoryError, OSError, subprocess.TimeoutExpired) as error:
        return jsonify({'error': str(error) if isinstance(error, GitHubError) else 'No se pudo publicar la rama. Revisa el acceso Git y vuelve a comprobar el remoto.'}), 400


@app.route('/api/projects/<project_id>', methods=['PATCH', 'DELETE'])
def api_project(project_id):
    project = PROJECT_STORE.get(project_id)
    if not project:
        abort(404)
    if request.method == 'PATCH':
        payload = request.get_json(silent=True) or {}
        try:
            updated = PROJECT_STORE.rename(project_id, payload.get('name') if isinstance(payload, dict) else None)
        except ProjectError as error:
            return jsonify({'error': str(error)}), 400
        return jsonify({'project': {'id': updated['id'], 'name': updated['name'], 'path': updated['path']}})
    with SESSIONS_LOCK:
        project = PROJECT_STORE.get(project_id)
        if not project:
            abort(404)
        if any(info.get('project_id') == project_id for info in terminal_sessions.values()):
            return jsonify({'error': 'Desvincula o elimina las sesiones de este proyecto antes de quitarlo.'}), 409
        if any(workspace.get('kind') == 'managed_worktree' for workspace in project['workspaces']):
            return jsonify({'error': 'Este proyecto tiene worktrees administrados; quítalos explícitamente antes.'}), 409
        PROJECT_STORE.remove(project_id)
        COORDINATION_STORE.delete_project(project_id)
    return jsonify({'success': True})


@app.route('/api/projects/<project_id>/workspaces', methods=['GET', 'POST'])
def api_project_workspaces(project_id):
    project = PROJECT_STORE.get(project_id)
    if not project:
        abort(404)
    if request.method == 'GET':
        try:
            return jsonify(project_workspaces(project_id))
        except (ProjectError, GitError) as error:
            return jsonify({'error': str(error)}), 400
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        abort(400)
    branch, base_ref = payload.get('branch'), payload.get('base_ref')
    name = payload.get('name', '')
    existing_branch = payload.get('existing_branch', False)
    if not isinstance(existing_branch, bool):
        abort(400)
    if not isinstance(name, str) or len(name) > 100:
        abort(400)
    try:
        info = inspect_git(project['path'])
        if not info.get('is_git'):
            return jsonify({'error': 'Este proyecto no pertenece a un repositorio Git.'}), 400
        matching = next((item for item in info['branches'] if item['ref'] == base_ref), None)
        if not matching:
            return jsonify({'error': 'La rama base ya no está disponible. Actualiza las ramas e inténtalo de nuevo.'}), 400
        if existing_branch and (matching['kind'] != 'local' or branch != matching['name']):
            return jsonify({'error': 'Solo se puede conectar un worktree a una rama local seleccionada.'}), 400
        relative = os.path.relpath(project['path'], info['root'])
        if relative == '..' or relative.startswith('..' + os.sep):
            return jsonify({'error': 'La carpeta registrada debe estar dentro de la raíz del repositorio.'}), 400
        destination_parent = (WORKTREE_DIR / project_id).absolute()
        try:
            if os.path.commonpath((info['root'], str(destination_parent))) == info['root']:
                return jsonify({'error': 'El directorio configurado para worktrees no puede estar dentro del repositorio.'}), 400
        except ValueError:
            pass
        root = create_worktree(project['path'], destination_parent, branch, base_ref,
                               name or branch, existing_branch=existing_branch)
        resolved_root = os.path.realpath(root)
        workspace_path = os.path.realpath(os.path.join(resolved_root, relative))
        try:
            workspace_contained = os.path.commonpath((resolved_root, workspace_path)) == resolved_root
        except ValueError:
            workspace_contained = False
        if not workspace_contained or not os.path.isdir(workspace_path):
            try:
                from git_service import run_git
                run_git(project['path'], 'worktree', 'remove', root, timeout=15)
            except GitError:
                app.logger.exception('New worktree could not be cleaned up after its project subdirectory was missing.')
            return jsonify({'error': 'La carpeta del proyecto no está disponible dentro del worktree; no se registró el workspace.'}), 400
        workspace_record = {
            'id': uuid.uuid4().hex[:12], 'name': (name.strip() or branch)[:100],
            'path': workspace_path, 'worktree_root': root, 'kind': 'managed_worktree',
            'created_at': time.time(), 'branch': branch,
        }
        try:
            PROJECT_STORE.add_workspace(project_id, workspace_record)
        except ProjectError:
            try:
                from git_service import run_git
                run_git(project['path'], 'worktree', 'remove', root, timeout=15)
            except GitError:
                app.logger.exception('New worktree could not be cleaned up after metadata persistence failed.')
            raise
    except GitError as error:
        return jsonify({'error': str(error)}), 400
    except ProjectError as error:
        return jsonify({'error': str(error)}), 500
    return jsonify({'workspace': workspace_record}), 201


@app.route('/api/workspaces/<workspace_id>', methods=['DELETE'])
def api_delete_workspace(workspace_id):
    project, workspace = PROJECT_STORE.get_workspace(workspace_id)
    if not project or not workspace:
        abort(404)
    if workspace.get('kind') == 'primary':
        return jsonify({'error': 'El workspace principal solo se quita al retirar el proyecto de WebConsole.'}), 409
    if workspace.get('kind') != 'managed_worktree':
        return jsonify({'error': 'Este workspace pertenece a un worktree existente; no se puede retirar desde WebConsole.'}), 409

    try:
        worktree_root = Path(workspace['worktree_root']).expanduser()
        if worktree_root.is_symlink():
            return jsonify({'error': 'La ruta administrada no puede ser un enlace simbólico.'}), 409
        managed_parent = (WORKTREE_DIR / project['id']).resolve(strict=True)
        resolved_root = worktree_root.resolve(strict=True)
        repo_info = inspect_git(project['path'])
        if not repo_info.get('is_git'):
            return jsonify({'error': 'El proyecto ya no está dentro de un repositorio Git válido.'}), 409
        relative = os.path.relpath(project['path'], repo_info['root'])
        if relative == '..' or relative.startswith('..' + os.sep):
            return jsonify({'error': 'La ruta del proyecto no está dentro de la raíz Git registrada.'}), 409
        expected_workspace_path = os.path.realpath(os.path.join(resolved_root, relative))
        try:
            contained = os.path.commonpath((str(resolved_root), expected_workspace_path)) == str(resolved_root)
        except ValueError:
            contained = False
        if not contained:
            return jsonify({'error': 'La carpeta del workspace escapa de la ruta del worktree.'}), 409
        if os.path.realpath(workspace['path']) != expected_workspace_path:
            return jsonify({'error': 'La ruta guardada del workspace no coincide con su worktree administrado.'}), 409
    except (GitError, OSError, RuntimeError, ValueError) as error:
        return jsonify({'error': str(error) if isinstance(error, GitError) else 'No se pudo verificar la ruta administrada del worktree.'}), 409

    with SESSIONS_LOCK:
        current_project, current_workspace = PROJECT_STORE.get_workspace(workspace_id)
        if (not current_project or not current_workspace or current_project['id'] != project['id']
                or current_workspace.get('kind') != 'managed_worktree'
                or os.path.realpath(current_workspace.get('worktree_root', '')) != str(resolved_root)):
            return jsonify({'error': 'El workspace cambió mientras se preparaba su retirada. Actualiza la lista.'}), 409
        if any(info.get('project_id') == project['id'] and info.get('workspace_id') == workspace_id
               for info in terminal_sessions.values()):
            return jsonify({'error': 'Hay sesiones asociadas a este workspace. Elimina explícitamente cada agente o terminal antes de retirarlo.'}), 409
        try:
            git_remove_worktree(project['path'], str(resolved_root), str(managed_parent))
        except GitError as error:
            return jsonify({'error': str(error)}), 409
        try:
            removed = PROJECT_STORE.remove_workspace(project['id'], workspace_id)
        except ProjectError as error:
            app.logger.exception('Git worktree removed but workspace metadata could not be updated.')
            return jsonify({'error': f'Git retiró el worktree, pero no se pudo actualizar el registro: {error}'}), 500
        if not removed:
            app.logger.error('Git worktree removed but workspace metadata disappeared concurrently.')
            return jsonify({'error': 'Git retiró el worktree, pero el registro cambió. Actualiza la lista de proyectos.'}), 409
    return jsonify({'success': True, 'workspace_id': workspace_id})


@app.route('/api/workspaces/<workspace_id>/git')
def api_workspace_git(workspace_id):
    project, workspace = PROJECT_STORE.get_workspace(workspace_id)
    if not project or not workspace:
        abort(404)
    try:
        return jsonify({'git': inspect_git(workspace['path'])})
    except GitError as error:
        return jsonify({'git': {'available': False, 'is_git': False, 'error': str(error)}})


@app.route('/api/workspaces/<workspace_id>/diff')
def api_workspace_diff(workspace_id):
    project, workspace = PROJECT_STORE.get_workspace(workspace_id)
    if not project or not workspace:
        abort(404)
    files = get_workspace_files(workspace_id)
    if files is None:
        return jsonify({'error': 'El workspace ya no está disponible.'}), 404
    try:
        result = read_git_diff(workspace['path'], workspace, files,
                               request.args.get('path', ''), request.args.get('kind', 'worktree'))
        return jsonify(result)
    except FileAccessError as error:
        return jsonify({'error': str(error)}), error.status
    except GitError as error:
        return jsonify({'error': str(error)}), 409


@app.route('/api/workspaces/<workspace_id>/fetch', methods=['POST'])
def api_workspace_fetch(workspace_id):
    project, workspace = PROJECT_STORE.get_workspace(workspace_id)
    if not project or not workspace:
        abort(404)
    payload = request.get_json(silent=True) or {}
    remote = payload.get('remote') if isinstance(payload, dict) else None
    try:
        git_fetch(workspace['path'], remote)
        return jsonify({'success': True, 'git': inspect_git(workspace['path'])})
    except GitError as error:
        return jsonify({'error': str(error)}), 400


def get_workspace_files(workspace_id):
    project, workspace = PROJECT_STORE.get_workspace(workspace_id)
    if not project or not workspace:
        abort(404)
    try:
        return WorkspaceFiles(workspace['path'], forbidden_paths=(TERMINAL_SESSIONS_DIR, WORKTREE_DIR))
    except FileAccessError:
        return None


@app.route('/api/workspaces/<workspace_id>/files')
def api_workspace_files(workspace_id):
    files = get_workspace_files(workspace_id)
    if files is None:
        return jsonify({'error': 'El workspace ya no está disponible.'}), 404
    try:
        return jsonify(files.list(request.args.get('path', ''), request.args.get('limit', 500)))
    except FileAccessError as error:
        return jsonify({'error': str(error)}), error.status


@app.route('/api/workspaces/<workspace_id>/file', methods=['GET', 'PUT'])
def api_workspace_file(workspace_id):
    files = get_workspace_files(workspace_id)
    if files is None:
        return jsonify({'error': 'El workspace ya no está disponible.'}), 404
    if request.method == 'GET':
        try:
            return jsonify(files.read(request.args.get('path', '')))
        except FileAccessError as error:
            return jsonify({'error': str(error)}), error.status
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        abort(400)
    try:
        return jsonify(files.write(payload.get('path'), payload.get('content'), payload.get('revision')))
    except FileAccessError as error:
        return jsonify({'error': str(error)}), error.status


@app.route('/api/projects/<project_id>/messages', methods=['GET', 'POST'])
def api_project_messages(project_id):
    if not PROJECT_STORE.get(project_id):
        abort(404)
    if request.method == 'GET':
        try:
            return jsonify({'messages': COORDINATION_STORE.history(project_id)})
        except CoordinationError as error:
            return jsonify({'error': str(error)}), 400
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        abort(400)
    try:
        message = COORDINATION_STORE.send(project_id, payload.get('recipient_session_id'), payload.get('body'))
        return jsonify({'message': message}), 201
    except CoordinationError as error:
        return jsonify({'error': str(error)}), 400

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
    if 'Range' in request.headers:
        # Preserve Flask/Werkzeug's byte-range handling for browser downloads.
        response = send_from_directory(app.static_folder, filename, conditional=True)
        version = static_asset_version(filename)
        if version and hmac.compare_digest(request.args.get('v', ''), version):
            response.headers['Cache-Control'] = 'public, max-age=31536000, immutable'
        else:
            response.headers['Cache-Control'] = 'public, max-age=0, must-revalidate'
        if Path(filename).suffix.lower() in {'.css', '.js', '.json', '.svg', '.txt', '.xml'}:
            response.vary.add('Accept-Encoding')
        return response
    response = send_from_directory(app.static_folder, filename, conditional=False, etag=False)
    if response.status_code != 200:
        return response
    try:
        path = (STATIC_ROOT / filename).resolve(strict=True)
        metadata = path.stat()
        if os.path.commonpath((str(STATIC_ROOT), str(path))) != str(STATIC_ROOT) or not path.is_file():
            return response
    except (OSError, RuntimeError, ValueError):
        return response

    version = static_asset_version(filename)
    requested_version = request.args.get('v', '')
    fingerprinted = bool(version and hmac.compare_digest(requested_version, version))
    if fingerprinted:
        response.headers['Cache-Control'] = 'public, max-age=31536000, immutable'
    else:
        response.headers['Cache-Control'] = 'public, max-age=0, must-revalidate'

    compressible = path.suffix.lower() in {'.css', '.js', '.json', '.svg', '.txt', '.xml'}
    if compressible:
        response.vary.add('Accept-Encoding')
    use_gzip = (compressible and metadata.st_size >= 512 and 'Range' not in request.headers
                and client_accepts_gzip())
    if use_gzip:
        response.direct_passthrough = False
        response.set_data(_gzip_static_asset(str(path), metadata.st_mtime_ns, metadata.st_size))
        response.headers['Content-Encoding'] = 'gzip'
        response.set_etag(hashlib.sha256(response.get_data()).hexdigest())
    else:
        response.set_etag(version or _static_digest(str(path), metadata.st_mtime_ns, metadata.st_size))
    response.last_modified = metadata.st_mtime
    response.make_conditional(request)
    return response


# Flask registers its built-in /static route when the app is created. Point
# that earlier route at the bounded, version-aware handler above.
app.view_functions['static'] = static_files

if __name__ == '__main__':
    if not TMUX_BIN:
        raise SystemExit('tmux is required. Install it with your system package manager.')
    threading.Thread(target=telemetry.run, daemon=True, name='session-monitor').start()
    threading.Thread(target=attachment_maintenance, daemon=True, name='attachment-retention').start()
    # Sessions have no inactivity timeout: explicit deletion is the only cleanup.
    app.run(host=os.environ.get('HOST', '127.0.0.1'),
            port=int(os.environ.get('PORT', '3030')),
            debug=False, threaded=True)
