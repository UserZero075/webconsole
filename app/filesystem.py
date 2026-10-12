"""Race-resistant, bounded file operations rooted at a registered workspace."""
import hashlib
import errno
import os
import re
import secrets
import stat


MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_DIRECTORY_ENTRIES = 500


class FileAccessError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def _parts(relative):
    if not isinstance(relative, str) or len(relative) > 4096 or '\x00' in relative or relative.startswith('/'):
        raise FileAccessError('Ruta relativa no válida.')
    parts = relative.split('/') if relative else []
    if any(part in {'', '.', '..'} for part in parts):
        raise FileAccessError('La ruta no puede salir del workspace.')
    if any(part == '.git' for part in parts):
        raise FileAccessError('El directorio interno de Git no está disponible desde el explorador.', 403)
    return parts


class WorkspaceFiles:
    def __init__(self, root, forbidden_paths=()):
        absolute = os.path.abspath(root)
        if os.path.realpath(absolute) != absolute:
            raise FileAccessError('La ruta del workspace contiene un enlace simbólico.', 403)
        self.root = absolute
        self.forbidden = []
        for path in forbidden_paths:
            canonical = os.path.realpath(path)
            try:
                if os.path.commonpath((self.root, canonical)) == self.root:
                    relative = os.path.relpath(canonical, self.root)
                    self.forbidden.append(tuple() if relative == '.' else tuple(relative.split(os.sep)))
            except ValueError:
                continue

    def _check_forbidden(self, parts):
        for forbidden in self.forbidden:
            if tuple(parts[:len(forbidden)]) == forbidden:
                raise FileAccessError('El estado interno de WebConsole no está disponible desde el explorador.', 403)

    def validate_path(self, relative):
        """Validate a workspace-relative path even when its file is deleted."""
        parts = _parts(relative)
        self._check_forbidden(parts)
        return parts

    def _root_fd(self):
        try:
            fd = os.open(os.sep, os.O_RDONLY | os.O_DIRECTORY)
            for part in self.root.strip(os.sep).split(os.sep):
                if not part:
                    continue
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = child
            return fd
        except OSError as error:
            try:
                os.close(fd)
            except (OSError, UnboundLocalError):
                pass
            raise FileAccessError('El workspace no está disponible.', 404) from error

    def _dir_fd(self, parts):
        fd = self._root_fd()
        try:
            for part in parts:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = child
            return fd
        except OSError as error:
            os.close(fd)
            status = 404 if error.errno == errno.ENOENT else 415
            raise FileAccessError('La carpeta no existe o contiene un enlace simbólico.', status) from error

    def list(self, relative='', limit=MAX_DIRECTORY_ENTRIES):
        parts = _parts(relative)
        self._check_forbidden(parts)
        try:
            limit = max(1, min(int(limit), MAX_DIRECTORY_ENTRIES))
        except (TypeError, ValueError):
            limit = MAX_DIRECTORY_ENTRIES
        fd = self._dir_fd(parts)
        try:
            entries = []
            for name in os.listdir(fd):
                if name == '.git' or any(
                    len(forbidden) == len(parts) + 1 and tuple(parts) == forbidden[:len(parts)] and name == forbidden[len(parts)]
                    for forbidden in self.forbidden
                ):
                    continue
                try:
                    info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                except OSError:
                    continue
                mode = info.st_mode
                kind = 'directory' if stat.S_ISDIR(mode) else 'file' if stat.S_ISREG(mode) else 'symlink' if stat.S_ISLNK(mode) else 'other'
                entries.append({'name': name, 'type': kind, 'size': info.st_size if kind == 'file' else None})
            entries.sort(key=lambda item: (item['type'] != 'directory', item['name'].casefold()))
            return {'path': relative, 'entries': entries[:limit],
                    'truncated': len(entries) > limit}
        except OSError as error:
            raise FileAccessError('No se pudo leer el directorio.') from error
        finally:
            os.close(fd)

    def _read_fd(self, parent_fd, name):
        try:
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent_fd)
        except OSError as error:
            raise FileAccessError('El archivo no existe o es un enlace simbólico.', 404) from error
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode):
                raise FileAccessError('Solo se pueden abrir archivos normales.', 415)
            if info.st_size > MAX_FILE_BYTES:
                raise FileAccessError('El archivo supera el límite de 2 MiB.', 413)
            chunks, remaining = [], MAX_FILE_BYTES + 1
            while remaining:
                chunk = os.read(fd, min(65536, remaining))
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
            data = b''.join(chunks)
            if len(data) > MAX_FILE_BYTES:
                raise FileAccessError('El archivo supera el límite de 2 MiB.', 413)
            latest = os.fstat(fd)
            identity = lambda item: (item.st_dev, item.st_ino, item.st_size, item.st_mtime_ns, item.st_ctime_ns)
            if identity(info) != identity(latest):
                raise FileAccessError('El archivo cambió durante la lectura. Actualiza e inténtalo de nuevo.', 409)
            if b'\x00' in data:
                raise FileAccessError('Este archivo parece binario y no se abre en el editor.', 415)
            try:
                content = data.decode('utf-8')
            except UnicodeDecodeError as error:
                raise FileAccessError('El archivo no es texto UTF-8 válido.', 415) from error
            return {'content': content, 'revision': hashlib.sha256(data).hexdigest(),
                    'size': len(data), 'mode': stat.S_IMODE(info.st_mode), 'inode': info.st_ino}
        finally:
            os.close(fd)

    def read(self, relative):
        parts = self.validate_path(relative)
        if not parts:
            raise FileAccessError('Selecciona un archivo.')
        parent = self._dir_fd(parts[:-1])
        try:
            result = self._read_fd(parent, parts[-1])
            result['path'] = relative
            return result
        finally:
            os.close(parent)

    def read_optional(self, relative):
        """Read a regular UTF-8 file, returning None only when it is absent."""
        parts = self.validate_path(relative)
        if not parts:
            raise FileAccessError('Selecciona un archivo.')
        try:
            parent = self._dir_fd(parts[:-1])
        except FileAccessError as error:
            if error.status == 404:
                return None
            raise
        try:
            try:
                info = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError:
                return None
            except OSError as error:
                raise FileAccessError('No se pudo verificar el archivo.') from error
            if stat.S_ISLNK(info.st_mode):
                raise FileAccessError('Los enlaces simbólicos no se comparan desde el editor.', 415)
            if not stat.S_ISREG(info.st_mode):
                raise FileAccessError('Solo se pueden comparar archivos normales.', 415)
            result = self._read_fd(parent, parts[-1])
            result['path'] = relative
            return result
        finally:
            os.close(parent)

    def exists_regular(self, relative):
        """Check whether a normal file exists without following symlinks."""
        parts = self.validate_path(relative)
        if not parts:
            return False
        try:
            parent = self._dir_fd(parts[:-1])
        except FileAccessError as error:
            if error.status == 404:
                return False
            raise
        try:
            try:
                info = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError:
                return False
            except OSError as error:
                raise FileAccessError('No se pudo verificar el archivo.') from error
            return stat.S_ISREG(info.st_mode)
        finally:
            os.close(parent)

    def write(self, relative, content, revision):
        parts = _parts(relative)
        self._check_forbidden(parts)
        if not parts:
            raise FileAccessError('Selecciona un archivo.')
        if not isinstance(content, str) or not isinstance(revision, str) or not re.fullmatch(r'[a-f0-9]{64}', revision):
            raise FileAccessError('Contenido o revisión no válidos.')
        encoded = content.encode('utf-8')
        if len(encoded) > MAX_FILE_BYTES:
            raise FileAccessError('El archivo supera el límite de 2 MiB.', 413)
        parent = self._dir_fd(parts[:-1])
        temporary = f'.webconsole-{secrets.token_hex(12)}.tmp'
        fd = None
        try:
            current = self._read_fd(parent, parts[-1])
            if current['revision'] != revision:
                raise FileAccessError('El archivo cambió en disco. Conservé tus cambios locales; recarga o compara antes de guardar.', 409)
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, current['mode'], dir_fd=parent)
            os.fchmod(fd, current['mode'])
            view = memoryview(encoded)
            while view:
                written = os.write(fd, view)
                view = view[written:]
            os.fsync(fd)
            os.close(fd)
            fd = None
            latest = self._read_fd(parent, parts[-1])
            if latest['revision'] != revision:
                raise FileAccessError('El archivo cambió durante el guardado; no reemplacé la versión nueva.', 409)
            os.replace(temporary, parts[-1], src_dir_fd=parent, dst_dir_fd=parent)
            os.fsync(parent)
            result = self._read_fd(parent, parts[-1])
            result['path'] = relative
            return result
        except FileAccessError:
            raise
        except OSError as error:
            raise FileAccessError('No se pudo guardar el archivo. Comprueba los permisos del workspace.', 403) from error
        finally:
            if fd is not None:
                os.close(fd)
            try:
                os.unlink(temporary, dir_fd=parent)
            except OSError:
                pass
            os.close(parent)
