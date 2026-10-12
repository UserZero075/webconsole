"""Private temporary uploads with a stable /tmp alias visible to tmux sessions."""
import json
import mimetypes
import os
import re
import secrets
import shutil
import stat
import tempfile
import threading
import time
from pathlib import Path


MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
MAX_ATTACHMENTS_PER_REQUEST = 5
MAX_REQUEST_BYTES = MAX_ATTACHMENT_BYTES * MAX_ATTACHMENTS_PER_REQUEST + 65536
MAX_SESSION_BYTES = 100 * 1024 * 1024
MAX_SESSION_FILES = 50
ATTACHMENT_ID = re.compile(r'^[a-f0-9]{32}$')
SESSION_ID = re.compile(r'^[A-Za-z0-9_-]{1,64}$')
EXTENSION = re.compile(r'^\.[a-z0-9]{1,10}$')
ALLOWED_TYPES = ('image/', 'audio/', 'video/', 'application/pdf')


class AttachmentError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def safe_display_name(value):
    value = str(value or 'attachment').replace('\\', '/').split('/')[-1]
    value = ''.join(char for char in value if ord(char) >= 32 and ord(char) != 127)
    value = value.strip().strip('.')[:120]
    return value or 'attachment'


class AttachmentStore:
    def __init__(self, state_dir, tmp_root='/tmp'):
        self.root = Path(state_dir).absolute() / 'attachments'
        self.tmp_root = Path(tmp_root).absolute()
        self.alias = self.tmp_root / f'webconsole-attachments-{os.getuid()}'
        self.lock = threading.RLock()

    def _ensure_root(self):
        state_root = self.root.parent
        state_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        state_root.chmod(0o700)
        self.root.mkdir(mode=0o700, exist_ok=True)
        info = os.lstat(self.root)
        if not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode) & 0o077:
            raise AttachmentError('El directorio privado de adjuntos debe tener permisos 0700.', 500)

    def ensure_alias(self):
        """Create a /tmp path that resolves to persistent private state across service restarts.

        systemd PrivateTmp gives each service invocation its own /tmp namespace. Keeping
        files in the private state directory and recreating this symlink in each namespace
        lets old tmux processes and the new HTTP process use the same absolute /tmp path.
        """
        self._ensure_root()
        self.tmp_root.mkdir(mode=0o1777, parents=True, exist_ok=True)
        target = str(self.root.resolve())
        try:
            os.symlink(target, self.alias)
        except FileExistsError:
            pass
        try:
            info = os.lstat(self.alias)
            link = os.readlink(self.alias)
        except OSError as error:
            raise AttachmentError('No se pudo preparar la ruta temporal compartida.', 500) from error
        if not stat.S_ISLNK(info.st_mode) or link != target:
            raise AttachmentError('La ruta temporal de adjuntos ya existe y no pertenece a WebConsole.', 409)
        return self.alias

    def _session_dir(self, session_id, create=False):
        if not isinstance(session_id, str) or not SESSION_ID.fullmatch(session_id):
            raise AttachmentError('Sesión no válida.', 404)
        self.ensure_alias()
        directory = self.root / session_id
        if create:
            try:
                directory.mkdir(mode=0o700)
            except FileExistsError:
                pass
        try:
            info = os.lstat(directory)
        except FileNotFoundError as error:
            raise AttachmentError('No hay adjuntos para esta sesión.', 404) from error
        if not stat.S_ISDIR(info.st_mode):
            raise AttachmentError('El directorio de adjuntos no es privado.', 403)
        if stat.S_IMODE(info.st_mode) & 0o077:
            try:
                os.chmod(directory, 0o700, follow_symlinks=False)
            except (OSError, NotImplementedError) as error:
                raise AttachmentError('El directorio de adjuntos no es privado.', 403) from error
        marker = directory / '.webconsole-attachments'
        if create:
            try:
                marker_fd = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            except FileExistsError:
                marker_fd = None
            if marker_fd is not None:
                os.close(marker_fd)
        try:
            marker_info = os.lstat(marker)
        except OSError as error:
            raise AttachmentError('Directorio de adjuntos no reconocido.', 404) from error
        if not stat.S_ISREG(marker_info.st_mode) or stat.S_IMODE(marker_info.st_mode) & 0o077:
            raise AttachmentError('Directorio de adjuntos no reconocido.', 404)
        return directory

    @staticmethod
    def _content_type(filename, supplied_type):
        mime = str(supplied_type or '').split(';', 1)[0].strip().lower()
        if not mime or mime == 'application/octet-stream':
            mime = mimetypes.guess_type(filename)[0] or mime
        if not any(mime.startswith(prefix) for prefix in ALLOWED_TYPES):
            raise AttachmentError('Adjunta una imagen, audio, vídeo o PDF.')
        return mime or 'application/octet-stream'

    @staticmethod
    def _extension(filename, mime):
        suffix = Path(filename).suffix.lower()
        if not EXTENSION.fullmatch(suffix):
            suffix = mimetypes.guess_extension(mime) or '.bin'
        return suffix

    def upload(self, session_id, uploads):
        uploads = list(uploads)
        if not uploads or len(uploads) > MAX_ATTACHMENTS_PER_REQUEST:
            raise AttachmentError(f'Adjunta entre 1 y {MAX_ATTACHMENTS_PER_REQUEST} archivos por vez.')
        created = []
        total_request = 0
        with self.lock:
            directory = self._session_dir(session_id, create=True)
            used_bytes = 0
            used_files = 0
            for entry in os.scandir(directory):
                if not entry.name.endswith('.meta.json') or entry.is_symlink():
                    continue
                try:
                    metadata = json.loads(Path(entry.path).read_text(encoding='utf-8'))
                    used_bytes += int(metadata.get('size', 0))
                    used_files += 1
                except (OSError, ValueError, TypeError):
                    continue
            try:
                for upload in uploads:
                    display_name = safe_display_name(getattr(upload, 'filename', '') or 'attachment')
                    content_type = self._content_type(display_name, getattr(upload, 'mimetype', ''))
                    extension = self._extension(display_name, content_type)
                    attachment_id = secrets.token_hex(16)
                    filename = attachment_id + extension
                    final_path = directory / filename
                    meta_path = directory / f'{attachment_id}.meta.json'
                    fd, temporary_name = tempfile.mkstemp(prefix='.upload-', dir=directory)
                    temporary = Path(temporary_name)
                    meta_temporary = None
                    committed = False
                    size = 0
                    try:
                        os.fchmod(fd, 0o600)
                        with os.fdopen(fd, 'wb') as output:
                            source = upload.stream
                            while True:
                                chunk = source.read(65536)
                                if not chunk:
                                    break
                                size += len(chunk)
                                total_request += len(chunk)
                                if size > MAX_ATTACHMENT_BYTES:
                                    raise AttachmentError('Cada adjunto debe pesar 25 MiB o menos.', 413)
                                if total_request > MAX_REQUEST_BYTES:
                                    raise AttachmentError('La subida supera el límite total permitido.', 413)
                                output.write(chunk)
                            output.flush()
                            os.fsync(output.fileno())
                        if size == 0:
                            raise AttachmentError('El archivo está vacío.')
                        if used_bytes + size > MAX_SESSION_BYTES or used_files >= MAX_SESSION_FILES:
                            raise AttachmentError('La sesión alcanzó su cuota de adjuntos (100 MiB o 50 archivos).', 413)
                        os.replace(temporary, final_path)
                        os.chmod(final_path, 0o600)
                        public_path = self.alias / session_id / filename
                        metadata = {
                            'id': attachment_id, 'session_id': session_id,
                            'filename': filename, 'name': display_name,
                            'content_type': content_type, 'size': size, 'created_at': time.time(),
                        }
                        meta_fd, meta_temp_name = tempfile.mkstemp(prefix='.meta-', dir=directory)
                        meta_temporary = Path(meta_temp_name)
                        with os.fdopen(meta_fd, 'w', encoding='utf-8') as meta_file:
                            os.fchmod(meta_fd, 0o600)
                            json.dump(metadata, meta_file, ensure_ascii=True, separators=(',', ':'))
                            meta_file.flush()
                            os.fsync(meta_file.fileno())
                        os.replace(meta_temp_name, meta_path)
                        created.append((final_path, meta_path, {
                            **metadata, 'path': str(public_path), 'state': 'uploaded',
                        }))
                        committed = True
                        used_bytes += size
                        used_files += 1
                    finally:
                        try:
                            temporary.unlink()
                        except FileNotFoundError:
                            pass
                        if meta_temporary:
                            meta_temporary.unlink(missing_ok=True)
                        if not committed:
                            final_path.unlink(missing_ok=True)
                            meta_path.unlink(missing_ok=True)
            except Exception:
                # Roll back only files committed by this request, never older uploads.
                for data_path, meta_path, _ in created:
                    data_path.unlink(missing_ok=True)
                    meta_path.unlink(missing_ok=True)
                raise
        return [item[2] for item in created]

    def get(self, session_id, attachment_id):
        if not isinstance(attachment_id, str) or not ATTACHMENT_ID.fullmatch(attachment_id):
            raise AttachmentError('Adjunto no válido.', 404)
        directory = self._session_dir(session_id)
        metadata_path = directory / f'{attachment_id}.meta.json'
        try:
            metadata_info = os.lstat(metadata_path)
            if (not stat.S_ISREG(metadata_info.st_mode) or metadata_info.st_size > 4096
                    or stat.S_IMODE(metadata_info.st_mode) & 0o077):
                raise AttachmentError('Metadata de adjunto no válida.', 404)
            metadata = json.loads(metadata_path.read_text(encoding='utf-8'))
        except (OSError, ValueError, UnicodeError) as error:
            raise AttachmentError('Adjunto no encontrado para esta sesión.', 404) from error
        if not isinstance(metadata, dict):
            raise AttachmentError('Metadata de adjunto no válida.', 404)
        if metadata.get('id') != attachment_id or metadata.get('session_id') != session_id:
            raise AttachmentError('El adjunto no pertenece a esta sesión.', 403)
        filename = metadata.get('filename')
        if not isinstance(filename, str) or filename != f'{attachment_id}{Path(filename).suffix}' or not EXTENSION.fullmatch(Path(filename).suffix):
            raise AttachmentError('Nombre interno de adjunto no válido.', 404)
        file_path = directory / filename
        try:
            info = os.lstat(file_path)
        except OSError as error:
            raise AttachmentError('El archivo temporal ya no está disponible.', 404) from error
        if (not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) & 0o077
                or info.st_size != metadata.get('size')):
            raise AttachmentError('El archivo temporal no es válido.', 404)
        os.utime(directory, None, follow_symlinks=False)
        return {**metadata, 'path': str(self.alias / session_id / filename), 'state': 'uploaded'}

    def prune(self, active_session_ids, max_age=7 * 24 * 60 * 60, now=None):
        """Remove only old WebConsole-owned directories for sessions no longer active."""
        try:
            root_info = os.lstat(self.root)
        except FileNotFoundError:
            return 0
        if not stat.S_ISDIR(root_info.st_mode) or stat.S_IMODE(root_info.st_mode) & 0o077:
            raise AttachmentError('El directorio privado de adjuntos no tiene permisos 0700.', 500)
        active = set(active_session_ids)
        cutoff = (time.time() if now is None else now) - max_age
        removed = 0
        for entry in os.scandir(self.root):
            if entry.name in active or not SESSION_ID.fullmatch(entry.name) or entry.is_symlink() or not entry.is_dir(follow_symlinks=False):
                continue
            try:
                marker = Path(entry.path) / '.webconsole-attachments'
                marker_info = os.lstat(marker)
                if not stat.S_ISREG(marker_info.st_mode) or stat.S_IMODE(marker_info.st_mode) & 0o077:
                    continue
                if entry.stat(follow_symlinks=False).st_mtime >= cutoff:
                    continue
                shutil.rmtree(entry.path)
                removed += 1
            except OSError:
                continue
        return removed
