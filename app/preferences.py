"""Private, atomic persistence for global WebConsole appearance preferences."""
import json
import os
import re
import tempfile
import threading
from pathlib import Path


class PreferencesError(ValueError):
    pass


_HEX_COLOR = re.compile(r'^#[0-9a-fA-F]{6}$')
_CONTROL_CHARS = re.compile(r'[\x00-\x1f\x7f]')

DEFAULTS = {
    'brand_name': 'WebConsole',
    'accent_color': '#8acfb3',
    'terminal_background': '#1a1a2e',
}
FIELDS = tuple(DEFAULTS)
MAX_BRAND_LENGTH = 80


def _clean_color(value, label):
    if not isinstance(value, str) or not _HEX_COLOR.fullmatch(value.strip()):
        raise PreferencesError(f'{label} debe ser un color hexadecimal #rrggbb.')
    return value.strip().lower()


def _clean_name(value):
    if not isinstance(value, str):
        raise PreferencesError('El nombre debe ser texto.')
    name = value.strip()
    if not name:
        raise PreferencesError('El nombre no puede quedar vacío.')
    if _CONTROL_CHARS.search(name):
        raise PreferencesError('El nombre no puede contener caracteres de control.')
    if len(name) > MAX_BRAND_LENGTH:
        raise PreferencesError(f'El nombre no puede superar {MAX_BRAND_LENGTH} caracteres.')
    return name


def normalize(payload):
    """Validate an update payload and return only known, sanitized fields."""
    if not isinstance(payload, dict):
        raise PreferencesError('La personalización debe ser un objeto.')
    unknown = set(payload) - set(FIELDS)
    if unknown:
        raise PreferencesError('La personalización contiene campos no reconocidos.')
    result = dict(DEFAULTS)
    if 'brand_name' in payload:
        result['brand_name'] = _clean_name(payload['brand_name'])
    if 'accent_color' in payload:
        result['accent_color'] = _clean_color(payload['accent_color'], 'El color de acento')
    if 'terminal_background' in payload:
        result['terminal_background'] = _clean_color(payload['terminal_background'], 'El fondo de la terminal')
    return result


class PreferencesStore:
    SCHEMA_VERSION = 1

    def __init__(self, state_dir):
        self.state_dir = Path(state_dir)
        self.path = self.state_dir / 'preferences.json'
        self.lock = threading.RLock()

    def _read(self):
        try:
            if self.path.is_symlink():
                raise PreferencesError('Las preferencias no pueden ser un enlace simbólico.')
            raw = json.loads(self.path.read_text(encoding='utf-8'))
        except FileNotFoundError:
            return dict(DEFAULTS)
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise PreferencesError('No se pudieron leer las preferencias privadas.') from error
        if not isinstance(raw, dict) or raw.get('version') != self.SCHEMA_VERSION:
            raise PreferencesError('Las preferencias tienen un formato no compatible.')
        stored = raw.get('preferences')
        if not isinstance(stored, dict):
            return dict(DEFAULTS)
        result = dict(DEFAULTS)
        for field in FIELDS:
            value = stored.get(field)
            try:
                if field == 'brand_name' and value is not None:
                    result[field] = _clean_name(value)
                elif field != 'brand_name' and isinstance(value, str) and _HEX_COLOR.fullmatch(value):
                    result[field] = value.lower()
            except PreferencesError:
                continue
        return result

    def _write(self, data):
        self.state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.state_dir.chmod(0o700)
        fd, temporary = tempfile.mkstemp(prefix='.preferences-', suffix='.tmp', dir=self.state_dir)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, 'w', encoding='utf-8') as file:
                json.dump({'version': self.SCHEMA_VERSION, 'preferences': data}, file,
                          ensure_ascii=True, separators=(',', ':'))
                file.flush()
                os.fsync(file.fileno())
            os.replace(temporary, self.path)
            os.chmod(self.path, 0o600)
        finally:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass

    def get(self):
        with self.lock:
            return self._read()

    def update(self, payload):
        clean = normalize(payload)
        with self.lock:
            self._write(clean)
            return dict(clean)
