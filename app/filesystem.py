"""Race-resistant, bounded file operations rooted at a registered workspace."""
import hashlib
import errno
import os
import re
import secrets
import stat


MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_DIRECTORY_ENTRIES = 500
MAX_SEARCH_FILES = 2000
MAX_SEARCH_DIRECTORIES = 500
MAX_SEARCH_ENTRIES = 10000
MAX_SEARCH_BYTES = 24 * 1024 * 1024
MAX_SEARCH_DEPTH = 24
MAX_SEARCH_RESULTS = 200
MAX_SEARCH_LINE_CHARS = 16384
MAX_REGEX_SEARCH_BYTES = 64 * 1024
MAX_REGEX_LINE_CHARS = 128
MAX_SEARCH_FILTER_STEPS = 5_000_000


def _glob_match(path, pattern):
    """Bounded wildcard matching for `*` and `?` without invoking a regex engine."""
    path_index = pattern_index = 0
    last_star = -1
    retry_at = 0
    steps = 0
    while path_index < len(path):
        steps += 1
        if pattern_index < len(pattern) and (pattern[pattern_index] == '?'
                                             or pattern[pattern_index] == path[path_index]):
            path_index += 1
            pattern_index += 1
        elif pattern_index < len(pattern) and pattern[pattern_index] == '*':
            while pattern_index < len(pattern) and pattern[pattern_index] == '*':
                pattern_index += 1
            last_star = pattern_index - 1
            retry_at = path_index
        elif last_star >= 0:
            retry_at += 1
            path_index = retry_at
            pattern_index = last_star + 1
        else:
            return False, steps
    while pattern_index < len(pattern) and pattern[pattern_index] == '*':
        pattern_index += 1
    return pattern_index == len(pattern), steps


def _validate_bounded_regex(pattern):
    """Accept a deliberately small regex subset so searches cannot monopolize the server."""
    groups = []
    in_class = False
    escaped = False
    closed_group = None
    repetitions = 0
    index = 0
    while index < len(pattern):
        char = pattern[index]
        if escaped:
            escaped = False
            closed_group = None
            index += 1
            continue
        if char == '\\':
            escaped = True
            index += 1
            continue
        if in_class:
            if char == ']':
                in_class = False
            index += 1
            continue
        if char == '[':
            in_class = True
            closed_group = None
        elif char == '(':
            groups.append({'repetition': False, 'alternation': False})
            closed_group = None
        elif char == ')':
            if not groups:
                raise FileAccessError('La expresión regular no es válida.')
            closed_group = groups.pop()
            if groups:
                groups[-1]['repetition'] |= closed_group['repetition']
                groups[-1]['alternation'] |= closed_group['alternation']
        elif char == '|' and groups:
            groups[-1]['alternation'] = True
            closed_group = None
        elif char in '*+?{' and not (char == '?' and index > 0 and pattern[index - 1] in '*+?}'):
            repetitions += 1
            if repetitions > 1:
                raise FileAccessError('La expresión regular solo admite un operador de repetición por seguridad.')
            if closed_group and (closed_group['repetition'] or closed_group['alternation']):
                raise FileAccessError('No se admite repetir grupos con alternativas u otras repeticiones.')
            if char == '{':
                bound = re.match(r'\{(\d+)(?:,(\d*)?)?\}', pattern[index:])
                if bound:
                    lower = int(bound.group(1))
                    upper = int(bound.group(2)) if bound.group(2) else lower
                    if max(lower, upper) > 10000:
                        raise FileAccessError('El límite de repetición es demasiado alto.')
            if groups:
                groups[-1]['repetition'] = True
            closed_group = None
        elif char not in '}' or not (index > 0 and pattern[index - 1] == '{'):
            closed_group = None
        index += 1
    if escaped or in_class or groups:
        raise FileAccessError('La expresión regular no es válida.')


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
        fd = None
        try:
            if self.root == os.sep:
                return os.open(os.sep, os.O_RDONLY | os.O_DIRECTORY)

            # Ancestor directories only need to be traversable. Opening `/` in
            # O_RDONLY mode can be denied by the service's filesystem sandbox
            # even when the workspace itself is readable, so use O_PATH until
            # reaching the workspace root that callers need to list.
            fd = os.open(os.sep, os.O_PATH | os.O_DIRECTORY)
            parts = self.root.strip(os.sep).split(os.sep)
            for index, part in enumerate(parts):
                access = os.O_RDONLY if index == len(parts) - 1 else os.O_PATH
                child = os.open(part, access | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = child
            return fd
        except OSError as error:
            try:
                if fd is not None:
                    os.close(fd)
            except OSError:
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

    def search(self, query, *, mode='names', include='', exclude='', case_sensitive=False,
               whole_word=False, regex=False, show_dotfiles=True, limit=100):
        """Search workspace names or UTF-8 file contents within strict scan bounds."""
        if not isinstance(query, str) or not query.strip() or len(query) > 200 or '\x00' in query:
            raise FileAccessError('Escribe una búsqueda de hasta 200 caracteres.')
        query = query.strip()
        if mode not in {'names', 'content'}:
            raise FileAccessError('El modo de búsqueda no es válido.')
        if any(not isinstance(value, str) or len(value) > 1000 or '\x00' in value
               for value in (include, exclude)):
            raise FileAccessError('Los filtros de búsqueda no son válidos.')
        try:
            limit = max(1, min(int(limit), MAX_SEARCH_RESULTS))
        except (TypeError, ValueError):
            limit = 100

        patterns = lambda value: [part.strip().replace('\\', '/') for part in value.split(',') if part.strip()]
        includes, excludes = patterns(include), patterns(exclude)
        if len(includes) > 50 or len(excludes) > 50 or any(len(pattern) > 200 for pattern in includes + excludes):
            raise FileAccessError('Usa hasta 50 patrones de filtro, de 200 caracteres cada uno.')
        filter_steps = MAX_SEARCH_FILTER_STEPS

        def matches_patterns(path):
            nonlocal filter_steps
            def any_match(patterns):
                nonlocal filter_steps
                for pattern in patterns:
                    matched, steps = _glob_match(path, pattern)
                    filter_steps -= steps
                    if filter_steps < 0:
                        raise FileAccessError('Los filtros recorren demasiadas rutas. Simplifica los patrones.')
                    if matched:
                        return True
                return False
            return (not includes or any_match(includes)) and not any_match(excludes)

        matcher = None
        if mode == 'content':
            if regex and (len(query) > 100 or '(?' in query or re.search(r'\\[1-9]|\\k', query)):
                raise FileAccessError('La expresión regular es demasiado compleja o usa una función no admitida.')
            if regex:
                _validate_bounded_regex(query)
            expression = query if regex else re.escape(query)
            if whole_word:
                expression = rf'(?<!\w)(?:{expression})(?!\w)'
            try:
                matcher = re.compile(expression, 0 if case_sensitive else re.IGNORECASE)
            except re.error as error:
                raise FileAccessError('La expresión de búsqueda no es válida.') from error
        else:
            name_query = query if case_sensitive else query.casefold()

        queue = [('', 0)]
        results = []
        scanned_files = 0
        scanned_bytes = 0
        scanned_directories = 0
        scanned_entries = 0
        truncated = False
        byte_budget = MAX_REGEX_SEARCH_BYTES if mode == 'content' and regex else MAX_SEARCH_BYTES
        line_limit = MAX_REGEX_LINE_CHARS if mode == 'content' and regex else MAX_SEARCH_LINE_CHARS
        while queue:
            relative, depth = queue.pop()
            scanned_directories += 1
            if scanned_directories > MAX_SEARCH_DIRECTORIES:
                truncated = True
                break
            listing = self._search_directory(relative)
            truncated = truncated or listing['truncated']
            for entry in listing['entries']:
                scanned_entries += 1
                if scanned_entries > MAX_SEARCH_ENTRIES:
                    truncated = True
                    queue.clear()
                    break
                path = f"{relative}/{entry['name']}" if relative else entry['name']
                if not show_dotfiles and any(part.startswith('.') for part in path.split('/')):
                    continue
                if entry['type'] == 'directory':
                    if depth < MAX_SEARCH_DEPTH:
                        queue.append((path, depth + 1))
                    else:
                        truncated = True
                    continue
                if entry['type'] != 'file':
                    continue
                scanned_files += 1
                if scanned_files > MAX_SEARCH_FILES:
                    truncated = True
                    queue.clear()
                    break
                if not matches_patterns(path):
                    continue

                if mode == 'names':
                    candidate = path if case_sensitive else path.casefold()
                    if name_query in candidate:
                        results.append({'path': path, 'line': None, 'column': None, 'excerpt': ''})
                else:
                    size = entry.get('size') or 0
                    if size > MAX_FILE_BYTES or (regex and size > byte_budget):
                        truncated = True
                        continue
                    if scanned_bytes + size > byte_budget:
                        truncated = True
                        queue.clear()
                        break
                    scanned_bytes += size
                    try:
                        content = self.read(path)['content']
                    except FileAccessError:
                        # Binary, unreadable, or concurrently removed files do not stop a workspace search.
                        continue
                    lines = content.splitlines()
                    for line_number, line in enumerate(lines, 1):
                        if len(line) > line_limit:
                            truncated = True
                            continue
                        match = matcher.search(line)
                        if not match or match.end() == match.start():
                            continue
                        start = max(0, match.start() - 80)
                        excerpt = line[start:start + 240]
                        if start:
                            excerpt = '…' + excerpt
                        if start + 240 < len(line):
                            excerpt += '…'
                        prefix_utf16 = len(line[:match.start()].encode('utf-16-le')) // 2
                        match_utf16 = len(line[match.start():match.end()].encode('utf-16-le')) // 2
                        excerpt_offset_utf16 = len(line[start:match.start()].encode('utf-16-le')) // 2 + (1 if start else 0)
                        results.append({'path': path, 'line': line_number,
                                        'column': match.start() + 1, 'excerpt': excerpt,
                                        'match_length': match.end() - match.start(),
                                        'column_utf16': prefix_utf16 + 1, 'match_length_utf16': match_utf16,
                                        'excerpt_match_offset': match.start() - start + (1 if start else 0),
                                        'excerpt_match_offset_utf16': excerpt_offset_utf16})
                        if len(results) >= limit:
                            truncated = True
                            queue.clear()
                            break
                if len(results) >= limit:
                    truncated = True
                    queue.clear()
                    break

        results.sort(key=lambda item: (item['path'].casefold(), item['line'] or 0, item['column'] or 0))
        return {'results': results, 'truncated': truncated, 'scanned_files': min(scanned_files, MAX_SEARCH_FILES),
                'scanned_bytes': scanned_bytes, 'mode': mode}

    def _search_directory(self, relative):
        parts = _parts(relative)
        self._check_forbidden(parts)
        fd = self._dir_fd(parts)
        entries = []
        truncated = False
        try:
            with os.scandir(fd) as iterator:
                for item in iterator:
                    name = item.name
                    if name == '.git' or any(
                        len(forbidden) == len(parts) + 1 and tuple(parts) == forbidden[:len(parts)]
                        and name == forbidden[len(parts)] for forbidden in self.forbidden
                    ):
                        continue
                    if len(entries) >= MAX_DIRECTORY_ENTRIES:
                        truncated = True
                        break
                    try:
                        info = item.stat(follow_symlinks=False)
                    except OSError:
                        continue
                    mode = info.st_mode
                    kind = 'directory' if stat.S_ISDIR(mode) else 'file' if stat.S_ISREG(mode) else 'symlink' if stat.S_ISLNK(mode) else 'other'
                    entries.append({'name': name, 'type': kind, 'size': info.st_size if kind == 'file' else None})
            entries.sort(key=lambda item: (item['type'] != 'directory', item['name'].casefold()))
            return {'entries': entries, 'truncated': truncated}
        except OSError as error:
            raise FileAccessError('No se pudo leer el directorio.') from error
        finally:
            os.close(fd)

    def unlink_file(self, relative):
        """Unlink one regular file or symlink without following it or removing directories."""
        parts = self.validate_path(relative)
        if not parts:
            raise FileAccessError('Selecciona un archivo.')
        parent = self._dir_fd(parts[:-1])
        try:
            try:
                info = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError as error:
                raise FileAccessError('El archivo ya no existe.', 404) from error
            if not (stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode)):
                raise FileAccessError('Solo se pueden quitar archivos o enlaces simbólicos.', 415)
            os.unlink(parts[-1], dir_fd=parent)
        except FileAccessError:
            raise
        except OSError as error:
            raise FileAccessError('No se pudo quitar el archivo.', 403) from error
        finally:
            os.close(parent)

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
