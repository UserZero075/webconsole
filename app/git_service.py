"""Bounded, non-interactive Git queries and explicit worktree creation."""
import os
import re
import stat
import subprocess
import uuid
from pathlib import Path

from filesystem import MAX_FILE_BYTES


class GitError(ValueError):
    pass


def run_git(directory, *args, timeout=5, check=True):
    env = os.environ.copy()
    for key in tuple(env):
        if key.startswith('WEBCONSOLE_') or key in {'SECRET_KEY', 'FLASK_SECRET_KEY'}:
            env.pop(key, None)
    env.update(GIT_OPTIONAL_LOCKS='0', GIT_TERMINAL_PROMPT='0', GCM_INTERACTIVE='Never')
    try:
        result = subprocess.run(['git', '-C', str(directory), *args], capture_output=True,
                                text=True, encoding='utf-8', errors='replace', timeout=timeout,
                                check=False, env=env)
    except subprocess.TimeoutExpired as error:
        raise GitError('Git tardó demasiado en responder.') from error
    except OSError as error:
        raise GitError('No se pudo ejecutar Git.') from error
    if check and result.returncode:
        message = (result.stderr or result.stdout or 'La operación Git falló.').strip()[:500]
        raise GitError(message)
    return result


def run_git_bytes(directory, *args, timeout=5, check=True):
    """Run a read-only Git query without decoding blob bytes as terminal text."""
    env = os.environ.copy()
    for key in tuple(env):
        if key.startswith('WEBCONSOLE_') or key in {'SECRET_KEY', 'FLASK_SECRET_KEY'}:
            env.pop(key, None)
    env.update(GIT_OPTIONAL_LOCKS='0', GIT_TERMINAL_PROMPT='0', GCM_INTERACTIVE='Never')
    try:
        result = subprocess.run(['git', '-C', str(directory), *args], capture_output=True,
                                timeout=timeout, check=False, env=env)
    except subprocess.TimeoutExpired as error:
        raise GitError('Git tardó demasiado en responder.') from error
    except OSError as error:
        raise GitError('No se pudo ejecutar Git.') from error
    if check and result.returncode:
        message = (result.stderr or result.stdout or 'La operación Git falló.'.encode()).decode('utf-8', 'replace').strip()[:500]
        raise GitError(message)
    return result


def repository_root(directory):
    result = run_git(directory, 'rev-parse', '--show-toplevel', check=False)
    if result.returncode:
        return None
    return os.path.realpath(result.stdout.strip())


def parse_worktrees(output):
    records, current = [], {}
    for line in output.splitlines():
        if not line:
            if current:
                records.append(current)
                current = {}
            continue
        key, _, value = line.partition(' ')
        if key == 'worktree':
            current['path'] = value
        elif key == 'HEAD':
            current['head'] = value
        elif key == 'branch':
            current['branch'] = value
        elif line == 'detached':
            current['detached'] = True
        elif line == 'bare':
            current['bare'] = True
        elif key == 'locked':
            current['locked'] = True
            current['lock_reason'] = value
    if current:
        records.append(current)
    return records


def inspect(directory):
    root = repository_root(directory)
    if not root:
        return {'available': True, 'is_git': False, 'path': str(directory)}
    current_result = run_git(directory, 'symbolic-ref', '--quiet', '--short', 'HEAD', check=False)
    detached = current_result.returncode != 0
    current = current_result.stdout.strip() if not detached else run_git(directory, 'rev-parse', '--short', 'HEAD').stdout.strip()
    upstream = run_git(directory, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}', check=False)
    default = run_git(directory, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD', check=False)
    refs = run_git(directory, 'for-each-ref', '--format=%(refname)%00%(refname:short)%00%(objectname:short)%00%(upstream:short)%00%(upstream:track)', 'refs/heads', 'refs/remotes')
    branches = []
    for line in refs.stdout.splitlines():
        fields = line.split('\0')
        if len(fields) < 3:
            continue
        full_ref, name, commit = fields[0], fields[1], fields[2]
        if name.endswith('/HEAD'):
            continue
        is_remote = full_ref.startswith('refs/remotes/')
        short_name = name
        tracking = fields[4] if len(fields) > 4 else ''
        branches.append({'name': short_name, 'ref': full_ref, 'commit': commit,
                         'kind': 'remote' if is_remote else 'local', 'current': not detached and short_name == current,
                         'upstream': fields[3] if len(fields) > 3 else '',
                         'ahead_behind': tracking.strip('[]') if tracking else ''})
    remotes = []
    for name in run_git(directory, 'remote').stdout.splitlines():
        if not name:
            continue
        url = run_git(directory, 'remote', 'get-url', name, check=False).stdout.strip()
        provider = 'github' if re.search(r'(^|[/:])github\.com[:/]', url, re.I) else 'other'
        remotes.append({'name': name, 'provider': provider})
    status = run_git(directory, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.')
    scope = os.path.relpath(os.path.realpath(directory), root)
    entries = []
    status_items = status.stdout.split('\0')
    index = 0
    while index < len(status_items):
        item = status_items[index]
        index += 1
        if not item or len(item) < 4 or item[2] != ' ':
            continue
        code, path = item[:2], item[3:]
        previous = None
        # In -z mode Git writes the destination path first, then a separate source
        # path for rename/copy records. Consume the latter so it is not parsed as
        # another status entry.
        if 'R' in code or 'C' in code:
            previous = status_items[index] if index < len(status_items) else None
            index += 1
        if scope != '.':
            prefix = scope.rstrip(os.sep) + os.sep
            if not path.startswith(prefix):
                continue
            path = path[len(prefix):]
        item = {'path': path, 'index': code[0], 'worktree': code[1],
                'status': 'untracked' if code == '??' else 'renamed' if 'R' in code else 'deleted' if 'D' in code else 'added' if 'A' in code else 'modified'}
        if previous is not None:
            if scope == '.':
                item['previous_path'] = previous
            else:
                prefix = scope.rstrip(os.sep) + os.sep
                if previous.startswith(prefix):
                    item['previous_path'] = previous[len(prefix):]
                else:
                    # Do not expose or read Git paths outside this registered workspace.
                    item['source_outside_workspace'] = True
        entries.append(item)
        if len(entries) >= 500:
            break
    worktrees = parse_worktrees(run_git(directory, 'worktree', 'list', '--porcelain').stdout)
    return {
        'available': True, 'is_git': True, 'path': str(directory), 'root': root,
        'branch': current, 'detached': detached,
        'upstream': upstream.stdout.strip() if upstream.returncode == 0 else '',
        'default_branch': default.stdout.strip().removeprefix('origin/') if default.returncode == 0 else '',
        'branches': branches, 'remotes': remotes, 'github_available': any(remote['provider'] == 'github' for remote in remotes),
        'changes': entries, 'worktrees': worktrees,
    }


def _tree_blob(directory, commit, path):
    result = run_git_bytes(directory, 'ls-tree', '-z', '-r', '--full-tree', commit, '--', f':(literal){path}')
    for record in result.stdout.split(b'\0'):
        metadata, separator, candidate = record.partition(b'\t')
        if not separator or candidate != os.fsencode(path):
            continue
        fields = metadata.split()
        if len(fields) != 3 or fields[1] != b'blob':
            raise GitError('Git contiene un tipo de archivo que no se puede comparar como texto.')
        if fields[0] not in {b'100644', b'100755'}:
            raise GitError('Los enlaces y submódulos no se comparan como texto.')
        return fields[2].decode('ascii')
    return None


def _index_blob(directory, path):
    result = run_git_bytes(directory, 'ls-files', '--stage', '-z', '--', f':(literal){path}')
    matches = []
    wanted = os.fsencode(path)
    for record in result.stdout.split(b'\0'):
        metadata, separator, candidate = record.partition(b'\t')
        if not separator or candidate != wanted:
            continue
        fields = metadata.split()
        if len(fields) != 3:
            continue
        mode, object_id, stage = fields
        if stage != b'0':
            raise GitError('El archivo tiene un conflicto de índice; resuélvelo antes de comparar.')
        if mode not in {b'100644', b'100755'}:
            raise GitError('Los enlaces y submódulos no se comparan como texto.')
        matches.append(object_id.decode('ascii'))
    if len(matches) > 1:
        raise GitError('El índice contiene varias versiones del archivo.')
    return matches[0] if matches else None


def _blob_text(directory, object_id):
    size = run_git_bytes(directory, 'cat-file', '-s', object_id).stdout.strip()
    try:
        size = int(size)
    except ValueError as error:
        raise GitError('Git devolvió un tamaño de objeto no válido.') from error
    if size > MAX_FILE_BYTES:
        raise GitError('Una de las versiones supera el límite de 2 MiB para comparaciones.')
    data = run_git_bytes(directory, 'cat-file', 'blob', object_id).stdout
    if len(data) > MAX_FILE_BYTES:
        raise GitError('Una de las versiones supera el límite de 2 MiB para comparaciones.')
    if b'\x00' in data:
        raise GitError('El archivo es binario y no se puede comparar en el editor.')
    try:
        return data.decode('utf-8')
    except UnicodeDecodeError as error:
        raise GitError('El archivo no es texto UTF-8 válido.') from error


def _head_identity(directory):
    result = run_git(directory, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}', check=False)
    return result.stdout.strip() if result.returncode == 0 else None


def _index_identity(directory):
    result = run_git(directory, 'rev-parse', '--git-path', 'index', check=False)
    if result.returncode:
        return None
    candidate = Path(result.stdout.strip())
    if not candidate.is_absolute():
        candidate = Path(directory) / candidate
    try:
        info = candidate.stat()
        return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
    except FileNotFoundError:
        return None
    except OSError as error:
        raise GitError('No se pudo verificar el índice Git.') from error


def _verify_diff_snapshot(directory, relative, kind, change, head_identity, index_identity):
    if _head_identity(directory) != head_identity or _index_identity(directory) != index_identity:
        raise GitError('HEAD o el índice cambiaron mientras se preparaba el diff. Actualiza e inténtalo de nuevo.')
    latest = next((item for item in inspect(directory).get('changes', []) if item['path'] == relative), None)
    if not latest or any(latest.get(key) != change.get(key)
                         for key in ('index', 'worktree', 'status', 'previous_path', 'source_outside_workspace')):
        raise GitError('El estado Git cambió mientras se preparaba el diff. Actualiza e inténtalo de nuevo.')
    rename_column = 'index' if kind == 'staged' else 'worktree'
    if (kind == 'staged' and latest.get('index') in {None, '', ' ', '?'}) or (
            kind == 'worktree' and latest.get('status') != 'untracked'
            and latest.get('worktree') in {None, '', ' ', '?'}):
        raise GitError('El cambio dejó de estar disponible para comparar.')
    if latest.get(rename_column) in {'R', 'C'} and latest.get('previous_path') != change.get('previous_path'):
        raise GitError('La ruta original del renombre cambió durante la lectura.')


def read_diff(directory, workspace, files, relative, kind):
    """Read HEAD→index or index→working-tree text without invoking diff drivers."""
    if kind not in {'staged', 'worktree'}:
        raise GitError('Tipo de comparación no válido.')
    parts = files.validate_path(relative)
    if not parts:
        raise GitError('Selecciona un archivo.')
    root = repository_root(directory)
    if not root:
        raise GitError('Este workspace no tiene un repositorio Git disponible.')
    canonical_workspace = os.path.realpath(directory)
    try:
        scope = os.path.relpath(canonical_workspace, root)
        if scope == '..' or scope.startswith('..' + os.sep):
            raise GitError('El workspace está fuera de la raíz Git registrada.')
    except ValueError as error:
        raise GitError('No se pudo determinar el ámbito del workspace.') from error
    workspace_relative = '/'.join(parts)
    repo_path = workspace_relative if scope == '.' else f'{scope.replace(os.sep, "/")}/{workspace_relative}'
    changes = inspect(directory).get('changes', [])
    change = next((item for item in changes if item['path'] == relative), None)
    if not change:
        raise GitError('El archivo ya no aparece en los cambios de Git. Actualiza el estado e inténtalo de nuevo.')
    if kind == 'staged' and change.get('index') in {None, '', ' ', '?'}:
        raise GitError('El archivo no tiene un cambio preparado para comparar.')
    if kind == 'worktree' and change.get('status') != 'untracked' and change.get('worktree') in {None, '', ' ', '?'}:
        raise GitError('El archivo no tiene un cambio en disco para comparar.')
    previous = None
    rename_column = 'index' if kind == 'staged' else 'worktree'
    if change.get(rename_column) in {'R', 'C'}:
        if change.get('source_outside_workspace'):
            raise GitError('El lado anterior del cambio está fuera del workspace y no se puede mostrar.')
        previous = change.get('previous_path')
    old_workspace_path = previous or workspace_relative
    old_repo_path = old_workspace_path if scope == '.' else f'{scope.replace(os.sep, "/")}/{old_workspace_path}'

    index_identity = _index_identity(directory)
    commit = _head_identity(directory)
    index_path = repo_path
    if kind == 'staged':
        if not commit:
            base_oid = None
            base_label = 'HEAD (sin commit)'
        else:
            base_label = f'HEAD {commit[:8]}'
            base_oid = _tree_blob(directory, commit, old_repo_path)
        changed_oid = _index_blob(directory, repo_path)
        changed_label = 'Índice (preparado)'
    else:
        base_label = 'Índice'
        changed_label = 'Disco (sin guardar en Git)'
        base_oid = _index_blob(directory, old_repo_path)
        changed = files.read_optional(relative)
        changed_text = changed['content'] if changed else ''
        if base_oid:
            base_text = _blob_text(directory, base_oid)
        else:
            base_text = ''
        _verify_diff_snapshot(directory, relative, kind, change, commit, index_identity)
        return {
            'path': relative, 'kind': kind,
            'base_label': base_label if base_oid else 'Vacío (sin versión en índice)',
            'changed_label': changed_label if changed else 'Vacío (archivo eliminado)',
            'base': base_text, 'changed': changed_text,
            'working_file_exists': files.exists_regular(relative),
        }

    if changed_oid:
        changed_text = _blob_text(directory, changed_oid)
    else:
        changed_text = ''
    if base_oid:
        base_text = _blob_text(directory, base_oid)
    else:
        base_text = ''
    _verify_diff_snapshot(directory, relative, kind, change, commit, index_identity)
    return {
        'path': relative, 'kind': kind,
        'base_label': base_label if base_oid else 'Vacío (sin versión en HEAD)',
        'changed_label': changed_label if changed_oid else 'Vacío (eliminado del índice)',
        'base': base_text, 'changed': changed_text,
        'working_file_exists': files.exists_regular(relative),
    }


def fetch(directory, remote):
    if not isinstance(remote, str) or not re.fullmatch(r'[A-Za-z0-9._-]{1,100}', remote):
        raise GitError('Nombre de remoto no válido.')
    known = run_git(directory, 'remote').stdout.splitlines()
    if remote not in known:
        raise GitError('Ese remoto no existe en el repositorio.')
    try:
        run_git(directory, 'fetch', '--no-prune', remote, timeout=45)
    except GitError as error:
        # Avoid echoing remote URLs or credentials from Git's stderr into the browser.
        raise GitError(f'No se pudo actualizar {remote}. Revisa la conectividad y las credenciales configuradas en Git.') from error


def create_worktree(directory, destination_root, branch, base_ref, name, existing_branch=False):
    if not isinstance(branch, str) or len(branch) > 200 or any(c in branch for c in '\x00\n\r'):
        raise GitError('Nombre de rama no válido.')
    checked = run_git(directory, 'check-ref-format', '--branch', branch, check=False)
    if checked.returncode:
        raise GitError('El nombre de rama no es válido para Git.')
    if not isinstance(base_ref, str) or len(base_ref) > 250 or any(c in base_ref for c in '\x00\n\r'):
        raise GitError('Referencia base no válida.')
    if not base_ref.startswith('refs/') or run_git(directory, 'check-ref-format', base_ref, check=False).returncode:
        raise GitError('Selecciona una referencia local o remota válida.')
    verify = run_git(directory, 'show-ref', '--verify', '--quiet', base_ref, check=False)
    if verify.returncode:
        raise GitError('La referencia base no existe localmente. Actualiza las ramas remotas y vuelve a intentarlo.')
    existing = run_git(directory, 'show-ref', '--verify', '--quiet', f'refs/heads/{branch}', check=False)
    if existing_branch:
        if existing.returncode:
            raise GitError('La rama local seleccionada ya no existe.')
    elif existing.returncode == 0:
        raise GitError('Ya existe una rama local con ese nombre.')
    root = Path(destination_root).expanduser().absolute()
    if root.is_symlink():
        raise GitError('El directorio de worktrees no puede ser un enlace simbólico.')
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    root_info = os.lstat(root)
    if not stat.S_ISDIR(root_info.st_mode) or stat.S_IMODE(root_info.st_mode) & 0o077:
        raise GitError('El directorio de worktrees debe ser privado (permisos 0700).')
    root = Path(os.path.realpath(root))
    slug = re.sub(r'[^a-zA-Z0-9_-]+', '-', (name or branch).strip()).strip('-_')[:48] or 'workspace'
    destination = root / f'{slug}-{uuid.uuid4().hex[:8]}'
    if existing_branch:
        run_git(directory, 'worktree', 'add', str(destination), branch, timeout=30)
    else:
        run_git(directory, 'worktree', 'add', '-b', branch, str(destination), base_ref, timeout=30)
    return str(destination)


def remove_worktree(directory, worktree_root, managed_parent):
    """Remove one clean managed worktree without forcing or deleting its branch."""
    requested = Path(worktree_root).expanduser()
    if requested.is_symlink():
        raise GitError('No se puede retirar un worktree a través de un enlace simbólico.')
    try:
        root = requested.resolve(strict=True)
        parent = Path(managed_parent).expanduser().resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise GitError('El worktree o su directorio administrado ya no está disponible.') from error
    if not root.is_dir() or root.parent != parent:
        raise GitError('La ruta no corresponde a un worktree administrado por WebConsole.')

    repo_root = repository_root(directory)
    if not repo_root or root == Path(repo_root):
        raise GitError('No se puede retirar el checkout principal del proyecto.')
    worktrees = parse_worktrees(run_git(directory, 'worktree', 'list', '--porcelain').stdout)
    record = next((item for item in worktrees
                   if item.get('path') and os.path.realpath(item['path']) == str(root)), None)
    if not record or record.get('bare'):
        raise GitError('Git ya no reconoce esa ruta como un worktree de este proyecto.')
    admin_dir = run_git(root, 'rev-parse', '--absolute-git-dir').stdout.strip()
    locked_marker = Path(admin_dir) / 'locked'
    if record.get('locked') or locked_marker.exists() or locked_marker.is_symlink():
        raise GitError('El worktree está bloqueado en Git. Desbloquéalo explícitamente antes de retirarlo.')

    # Git's normal remove protects tracked and untracked changes. Check ignored
    # data too: removing the worktree would otherwise silently discard it.
    status = run_git(root, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored', timeout=15)
    if status.stdout:
        raise GitError('El worktree contiene cambios, archivos sin seguimiento o ignorados. Consérvalos o límpialos antes de retirarlo.')

    run_git(directory, 'worktree', 'remove', str(root), timeout=30)
    if root.exists():
        raise GitError('Git no confirmó la retirada del worktree; no se modificó el registro.')
    return str(root)
