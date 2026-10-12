"""Project-scoped agent mailbox with per-session bearer authentication."""
import hmac
import json
import os
import re
import secrets
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path


MAX_MESSAGE_BYTES = 8192
SESSION_ID = re.compile(r'^[A-Za-z0-9_-]{1,64}$')


class CoordinationError(ValueError):
    pass


class CoordinationStore:
    def __init__(self, state_dir):
        self.state_dir = Path(state_dir)
        self.path = self.state_dir / 'coordination.sqlite3'

    def _connect(self):
        self.state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.state_dir.chmod(0o700)
        if self.path.is_symlink():
            raise CoordinationError('La base de coordinación no puede ser un enlace simbólico.')
        connection = sqlite3.connect(self.path, timeout=5)
        os.chmod(self.path, 0o600)
        connection.row_factory = sqlite3.Row
        connection.execute('PRAGMA busy_timeout=5000')
        connection.execute('PRAGMA journal_mode=WAL')
        connection.execute('PRAGMA synchronous=FULL')
        connection.execute('''CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            sender_session_id TEXT,
            sender_name TEXT NOT NULL,
            recipient_session_id TEXT NOT NULL,
            body TEXT NOT NULL,
            created_at REAL NOT NULL,
            read_at REAL
        )''')
        connection.execute('CREATE INDEX IF NOT EXISTS messages_project_time ON messages(project_id, created_at, id)')
        connection.execute('CREATE INDEX IF NOT EXISTS messages_recipient ON messages(recipient_session_id, read_at, created_at)')
        connection.commit()
        for suffix in ('', '-wal', '-shm'):
            candidate = Path(str(self.path) + suffix)
            if candidate.exists() and not candidate.is_symlink():
                os.chmod(candidate, 0o600)
        return connection

    @contextmanager
    def _connection(self):
        connection = self._connect()
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def _session(self, session_id):
        if not isinstance(session_id, str) or not SESSION_ID.fullmatch(session_id):
            return None
        path = self.state_dir / f'{session_id}.json'
        try:
            if path.is_symlink() or path.stat().st_size > 65536:
                return None
            value = json.loads(path.read_text(encoding='utf-8'))
        except (OSError, ValueError, UnicodeError):
            return None
        return value if isinstance(value, dict) else None

    def authenticate_environment(self):
        session_id = os.environ.get('WEBCONSOLE_SESSION_ID', '')
        project_id = os.environ.get('WEBCONSOLE_PROJECT_ID', '')
        token = os.environ.get('WEBCONSOLE_COORDINATION_TOKEN', '')
        info = self._session(session_id)
        saved = info.get('coordination_token', '') if info else ''
        if not info or not isinstance(saved, str) or not token or not hmac.compare_digest(saved.encode(), token.encode()):
            raise CoordinationError('Credencial de coordinación ausente o revocada.')
        if info.get('project_id') != project_id or not project_id:
            raise CoordinationError('La sesión no pertenece al proyecto indicado.')
        return session_id, project_id, info

    def _project(self, session_id, project_id):
        info = self._session(session_id)
        if not info or info.get('project_id') != project_id or info.get('session_role') == 'workspace_shell':
            raise CoordinationError('La sesión no pertenece a este proyecto.')
        return info

    def agents(self, session_id, project_id):
        self._project(session_id, project_id)
        agents = []
        for path in self.state_dir.glob('*.json'):
            if path.is_symlink() or not SESSION_ID.fullmatch(path.stem):
                continue
            try:
                info = json.loads(path.read_text(encoding='utf-8'))
            except (OSError, ValueError, UnicodeError):
                continue
            if (path.stem != session_id and isinstance(info, dict)
                    and info.get('project_id') == project_id
                    and info.get('session_role') != 'workspace_shell'):
                agents.append({'session_id': path.stem, 'title': str(info.get('title') or '')[:100],
                               'agent': str(info.get('launcher') or 'terminal')[:32],
                               'workspace_id': info.get('workspace_id'),
                               'cwd': str(info.get('cwd') or '')[:4096]})
        return sorted(agents, key=lambda item: (item['title'].casefold(), item['session_id']))

    def send(self, project_id, recipient_session_id, body, sender_session_id=None, sender_name='Usuario'):
        if not isinstance(body, str) or not body.strip() or len(body.encode('utf-8')) > MAX_MESSAGE_BYTES:
            raise CoordinationError('El mensaje debe contener entre 1 byte y 8 KiB.')
        if not isinstance(recipient_session_id, str) or not SESSION_ID.fullmatch(recipient_session_id):
            raise CoordinationError('Selecciona una sesión destinataria válida.')
        recipient = self._session(recipient_session_id)
        if (not recipient or recipient.get('project_id') != project_id
                or recipient.get('session_role') == 'workspace_shell'):
            raise CoordinationError('El destinatario no pertenece a este proyecto o ya no existe.')
        if sender_session_id:
            sender = self._session(sender_session_id)
            if not sender or sender.get('project_id') != project_id:
                raise CoordinationError('El remitente no pertenece a este proyecto.')
            sender_name = str(sender.get('title') or sender.get('launcher') or sender_session_id)[:100]
        message_id = uuid.uuid4().hex
        created = time.time()
        with self._connection() as db:
            if sender_session_id:
                recent = db.execute('SELECT COUNT(*) FROM messages WHERE sender_session_id=? AND created_at>?',
                                    (sender_session_id, created - 60)).fetchone()[0]
                if recent >= 30:
                    raise CoordinationError('Límite de envío alcanzado; espera un minuto antes de enviar más mensajes.')
            db.execute('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, NULL)',
                       (message_id, project_id, sender_session_id, sender_name[:100], recipient_session_id,
                        body.strip(), created))
            db.execute('''DELETE FROM messages WHERE project_id=? AND id IN (
                SELECT id FROM messages WHERE project_id=? ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET 1000
            )''', (project_id, project_id))
        return {'id': message_id, 'project_id': project_id, 'sender_session_id': sender_session_id,
                'sender_name': sender_name[:100], 'recipient_session_id': recipient_session_id,
                'body': body.strip(), 'created_at': created, 'read_at': None, 'state': 'pending'}

    def inbox(self, session_id, project_id, limit=30):
        self._project(session_id, project_id)
        limit = max(1, min(int(limit), 100))
        with self._connection() as db:
            rows = db.execute('''SELECT id, sender_session_id, sender_name, recipient_session_id, body, created_at, read_at
                FROM messages WHERE project_id=? AND recipient_session_id=? ORDER BY created_at, id LIMIT ?''',
                              (project_id, session_id, limit)).fetchall()
            now = time.time()
            db.executemany('UPDATE messages SET read_at=COALESCE(read_at, ?) WHERE id=? AND recipient_session_id=?',
                           ((now, row['id'], session_id) for row in rows))
        return [self._row(row, read_at=row['read_at'] or now) for row in rows]

    def history(self, project_id, limit=100):
        limit = max(1, min(int(limit), 200))
        with self._connection() as db:
            rows = db.execute('''SELECT id, sender_session_id, sender_name, recipient_session_id, body, created_at, read_at
                FROM messages WHERE project_id=? ORDER BY created_at DESC, id DESC LIMIT ?''',
                              (project_id, limit)).fetchall()
        return [self._row(row) for row in reversed(rows)]

    def delete_project(self, project_id):
        with self._connection() as db:
            db.execute('DELETE FROM messages WHERE project_id=?', (project_id,))

    @staticmethod
    def _row(row, read_at=None):
        read_at = read_at if read_at is not None else row['read_at']
        return {'id': row['id'], 'sender_session_id': row['sender_session_id'],
                'sender_name': row['sender_name'], 'recipient_session_id': row['recipient_session_id'],
                'body': row['body'], 'created_at': row['created_at'], 'read_at': read_at,
                'state': 'read' if read_at else 'pending'}


def new_coordination_token():
    return secrets.token_urlsafe(32)
