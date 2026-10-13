"""Non-interactive GitHub CLI discovery; never returns credentials or raw stderr."""
import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from urllib.parse import quote, urlsplit


class GitHubError(ValueError):
    def __init__(self, message, category='request'):
        super().__init__(message)
        self.category = category


def resolve_gh():
    """Find gh from PATH or the standard per-user install without changing PATH."""
    candidates = [shutil.which('gh'), str(Path.home() / '.local' / 'bin' / 'gh')]
    for candidate in candidates:
        if not candidate:
            continue
        try:
            path = Path(candidate).expanduser()
            if path.is_file() and os.access(path, os.X_OK):
                return str(path.resolve())
        except (OSError, RuntimeError):
            continue
    return None


def _env():
    env = os.environ.copy()
    for key in tuple(env):
        if key.startswith('WEBCONSOLE_') or key in {'SECRET_KEY', 'FLASK_SECRET_KEY'}:
            env.pop(key, None)
    env['GH_PROMPT_DISABLED'] = '1'
    env['GIT_TERMINAL_PROMPT'] = '0'
    return env


def _run(args, timeout=12):
    try:
        result = subprocess.run(args, capture_output=True, text=True, encoding='utf-8',
                                errors='replace', timeout=timeout, check=False, env=_env())
    except subprocess.TimeoutExpired as error:
        raise GitHubError('GitHub tardó demasiado en responder. Inténtalo de nuevo.') from error
    except OSError as error:
        raise GitHubError('No se pudo ejecutar la herramienta solicitada.') from error
    if result.returncode:
        detail = f"{result.stderr or ''} {result.stdout or ''}".casefold()
        if any(marker in detail for marker in ('http 401', 'status 401', 'bad credentials',
                                                'requires authentication', 'not logged in')):
            raise GitHubError('gh no tiene una sesión válida para github.com.', 'auth')
        raise GitHubError('GitHub no permitió completar la consulta. Revisa la sesión de gh y los permisos de la organización.')
    return result.stdout


def _parse_pages(raw, label):
    """Decode gh --paginate's consecutive JSON page payloads without --slurp."""
    decoder = json.JSONDecoder()
    pages = []
    offset = 0
    try:
        while offset < len(raw):
            while offset < len(raw) and raw[offset].isspace():
                offset += 1
            if offset >= len(raw):
                break
            page, offset = decoder.raw_decode(raw, offset)
            if not isinstance(page, list):
                raise ValueError('A page was not an array')
            pages.append(page)
    except (ValueError, json.JSONDecodeError) as error:
        raise GitHubError(f'GitHub devolvió páginas de {label} con un formato no válido.') from error
    return pages


def status():
    gh = resolve_gh()
    git = shutil.which('git')
    if not gh:
        return {'git_available': bool(git), 'gh_available': False, 'authenticated': False,
                'state': 'missing',
                'login': '', 'message': 'GitHub CLI (gh) no está instalado. Puedes clonar un repositorio público por URL.'}
    try:
        login = _run([gh, 'api', 'user', '--jq', '.login'], timeout=8).strip()
        if not re.fullmatch(r'[A-Za-z0-9-]{1,39}', login):
            raise GitHubError('La cuenta de GitHub devolvió una identidad no válida.')
        return {'git_available': bool(git), 'gh_available': True, 'authenticated': True,
                'state': 'authenticated', 'login': login, 'message': ''}
    except GitHubError as error:
        if error.category != 'auth':
            return {'git_available': bool(git), 'gh_available': True, 'authenticated': False,
                    'state': 'error', 'login': '',
                    'message': 'No se pudo comprobar la cuenta de GitHub. Revisa la conectividad e inténtalo de nuevo.'}
        return {'git_available': bool(git), 'gh_available': True, 'authenticated': False,
                'state': 'unauthenticated',
                'login': '', 'message': 'gh no tiene una sesión válida para github.com. Puedes clonar un repositorio público por URL.'}


def _account():
    current = status()
    if not current['authenticated']:
        raise GitHubError(current['message'] or 'Inicia sesión en gh para ver tus repositorios.')
    return current


def repositories(search=''):
    current = _account()
    gh = resolve_gh()
    # Affiliation includes repositories owned by the user, collaborations, and
    # organization memberships. Pagination is performed by gh; only safe fields
    # leave the process.
    raw = _run([gh, 'api', '--paginate',
                '/user/repos?visibility=all&affiliation=owner,collaborator,organization_member&per_page=100'],
               timeout=25)
    repos = [item for page in _parse_pages(raw, 'repositorios') for item in page]
    term = search.casefold().strip()[:100]
    result = []
    for repo in repos:
        if not isinstance(repo, dict):
            continue
        full_name = repo.get('full_name')
        owner = repo.get('owner')
        if not isinstance(full_name, str) or not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', full_name):
            continue
        if isinstance(owner, dict):
            owner = owner.get('login')
        if not isinstance(owner, str):
            continue
        if term and term not in full_name.casefold():
            continue
        result.append({'full_name': full_name, 'owner': owner, 'name': repo.get('name') or full_name.split('/')[-1],
                       'visibility': repo.get('visibility') or ('private' if repo.get('private') else 'public'),
                       'default_branch': repo.get('default_branch') or '', 'archived': bool(repo.get('archived')),
                       'push': bool((repo.get('permissions') or {}).get('push')), 'owned': owner.casefold() == current['login'].casefold()})
    result.sort(key=lambda item: item['full_name'].casefold())
    return {'repositories': result[:500], 'truncated': len(result) > 500, 'login': current['login']}


def validate_public_url(url):
    if not isinstance(url, str) or len(url) > 500:
        raise GitHubError('Introduce un enlace de repositorio público de GitHub válido.')
    try:
        parsed = urlsplit(url.strip())
        port = parsed.port
    except ValueError as error:
        raise GitHubError('El enlace no es válido.') from error
    match = re.fullmatch(r'/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?/?', parsed.path)
    if (parsed.scheme != 'https' or parsed.hostname != 'github.com' or parsed.username or parsed.password
            or port not in (None, 443) or parsed.query or parsed.fragment or not match):
        raise GitHubError('Usa un enlace https://github.com/propietario/repositorio, sin credenciales ni parámetros.')
    owner, name = match.groups()
    if owner in {'.', '..'} or name in {'.', '..'}:
        raise GitHubError('El propietario o nombre de repositorio no es válido.')
    return f'https://github.com/{owner}/{name}.git', f'{owner}/{name}'


def branches(full_name, authenticated=False):
    if not isinstance(full_name, str) or not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', full_name):
        raise GitHubError('Selecciona un repositorio válido.')
    current = status()
    if authenticated and current.get('state') == 'error':
        raise GitHubError(current['message'])
    if authenticated and current['authenticated']:
        gh = resolve_gh()
        owner, name = full_name.split('/', 1)
        endpoint = f'/repos/{quote(owner, safe="")}/{quote(name, safe="")}/branches?per_page=100'
        raw = _run([gh, 'api', '--paginate', endpoint], timeout=25)
        names = [item['name'] for page in _parse_pages(raw, 'ramas') for item in page
                 if isinstance(item, dict) and isinstance(item.get('name'), str)]
    else:
        import subprocess as sp
        git = shutil.which('git')
        if not git:
            raise GitHubError('Git no está instalado en el servidor.')
        url, _ = validate_public_url(f'https://github.com/{full_name}')
        try:
            result = sp.run([git, 'ls-remote', '--heads', url], capture_output=True, text=True,
                            timeout=15, check=False,
                            env={**_env(), 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull})
        except (OSError, sp.TimeoutExpired) as error:
            raise GitHubError('No se pudieron consultar las ramas públicas.') from error
        if result.returncode:
            raise GitHubError('No se pudieron consultar las ramas. Comprueba el enlace y la conectividad.')
        names = [line.split('\t', 1)[1][len('refs/heads/'):]
                 for line in result.stdout.splitlines() if '\trefs/heads/' in line]
    return {'branches': sorted(set(names), key=str.casefold)[:500]}


def repository_permission(full_name):
    current = _account()
    gh = resolve_gh()
    owner, name = full_name.split('/', 1)
    raw = _run([gh, 'api', f'/repos/{quote(owner, safe="")}/{quote(name, safe="")}',
                '--jq', '[.owner.login, (.permissions.push // false)]'], timeout=12)
    try:
        result = json.loads(raw)
    except ValueError as error:
        raise GitHubError('No se pudieron verificar los permisos del repositorio.') from error
    return {'owned': str(result[0]).casefold() == current['login'].casefold(), 'push': bool(result[1])}
