"""Safe, server-side directory navigation for the project picker."""
import os
import stat
from pathlib import Path


class DirectoryError(ValueError):
    pass


def _blocked(path, excluded):
    candidate = os.path.realpath(path)
    for item in excluded:
        blocked = os.path.realpath(item)
        try:
            if os.path.commonpath((candidate, blocked)) == blocked:
                return True
        except ValueError:
            continue
    return False


def resolve_directory(path, excluded=()):
    requested = Path(path or Path.home()).expanduser()
    absolute = Path(os.path.abspath(requested))
    current = Path(absolute.anchor)
    for part in absolute.parts[1:]:
        current = current / part
        try:
            if current.is_symlink():
                raise DirectoryError('No se puede navegar mediante un enlace simbólico.')
        except OSError as error:
            raise DirectoryError('No se pudo comprobar la ruta solicitada.') from error
    try:
        target = absolute.resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise DirectoryError('La carpeta no existe o no se puede resolver.') from error
    if not target.is_dir() or _blocked(target, excluded):
        raise DirectoryError('Esa carpeta no está disponible para explorar.')
    return target


def list_directories(path=None, excluded=(), limit=200):
    """Return readable direct child directories; symlinks and private roots are omitted."""
    target = Path(path or Path.home()).expanduser()
    try:
        target = resolve_directory(target, excluded)
        parent = target.parent if target != target.parent else None
        entries = []
        with os.scandir(target) as scan:
            for entry in scan:
                try:
                    if entry.name.startswith('.') or entry.is_symlink() or not entry.is_dir(follow_symlinks=False):
                        continue
                    if _blocked(entry.path, excluded) or not os.access(entry.path, os.R_OK | os.X_OK):
                        continue
                    entries.append({'name': entry.name, 'path': entry.path})
                except OSError:
                    continue
        entries.sort(key=lambda item: (item['name'].casefold(), item['name']))
        return {'path': str(target), 'parent': str(parent) if parent else None,
                'directories': entries[:limit], 'truncated': len(entries) > limit}
    except DirectoryError:
        raise
    except (OSError, RuntimeError) as error:
        raise DirectoryError('No se pudo leer esa carpeta. Comprueba la ruta y los permisos.') from error
