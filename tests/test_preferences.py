import json
import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'app'))

from preferences import PreferencesError, PreferencesStore, normalize, DEFAULTS


def test_normalize_defaults_and_partial_updates():
    assert normalize({}) == DEFAULTS
    assert DEFAULTS['terminal_background'] == '#0b0b0d'
    assert normalize({'brand_name': '  Mi Consola  '})['brand_name'] == 'Mi Consola'
    assert normalize({'accent_color': '#AABBCC'})['accent_color'] == '#aabbcc'
    assert normalize({'terminal_background': '#0d1117'})['terminal_background'] == '#0d1117'
    merged = normalize({'brand_name': 'X', 'accent_color': '#ff0000'})
    assert merged['terminal_background'] == DEFAULTS['terminal_background']
    assert merged['brand_name'] == 'X'


def test_normalize_rejects_invalid_values():
    for payload in (
        'not-a-dict',
        {'unknown_field': 1},
        {'brand_name': ''},
        {'brand_name': 'a' * 81},
        {'brand_name': 'bad\x00name'},
        {'brand_name': 42},
        {'accent_color': 'red'},
        {'accent_color': '#fff'},
        {'accent_color': '#gggggg'},
        {'accent_color': 'rgb(1,2,3)'},
        {'terminal_background': 'javascript:alert(1)'},
    ):
        with pytest.raises(PreferencesError):
            normalize(payload)


def test_store_persists_privately_and_atomically(tmp_path):
    state = tmp_path / 'state'
    store = PreferencesStore(state)
    assert store.get() == DEFAULTS

    updated = store.update({'brand_name': 'Panel', 'accent_color': '#e18b83', 'terminal_background': '#0d1117'})
    assert updated['brand_name'] == 'Panel'
    assert (state / 'preferences.json').stat().st_mode & 0o777 == 0o600
    assert state.stat().st_mode & 0o777 == 0o700

    reloaded = PreferencesStore(state).get()
    assert reloaded == updated


def test_store_falls_back_per_field_on_corrupt_values(tmp_path):
    state = tmp_path / 'state'
    state.mkdir(mode=0o700)
    (state / 'preferences.json').write_text(json.dumps({
        'version': 1,
        'preferences': {'brand_name': 'ok', 'accent_color': 'not-a-color', 'terminal_background': '#123456'},
    }))
    store = PreferencesStore(state)
    result = store.get()
    assert result['brand_name'] == 'ok'
    assert result['accent_color'] == DEFAULTS['accent_color']
    assert result['terminal_background'] == '#123456'


def test_preferences_api_requires_header_and_origin(tmp_path, monkeypatch):
    import server

    state = tmp_path / 'state'
    state.mkdir(mode=0o700)
    monkeypatch.setattr(server, 'TERMINAL_SESSIONS_DIR', state)
    monkeypatch.setattr(server, 'PREFERENCES_STORE', PreferencesStore(state))
    monkeypatch.delenv('WEBCONSOLE_PASSWORD', raising=False)
    client = server.app.test_client()

    assert client.get('/api/preferences').get_json() == DEFAULTS

    denied = client.put('/api/preferences', json={'brand_name': 'X'})
    assert denied.status_code == 403

    bad_origin = client.put('/api/preferences', headers={'X-WebConsole': '1', 'Origin': 'https://evil.invalid'},
                            json={'brand_name': 'X'})
    assert bad_origin.status_code == 403

    ok = client.put('/api/preferences', headers={'X-WebConsole': '1', 'Content-Type': 'application/json'},
                    json={'brand_name': 'Panel rojo', 'accent_color': '#e18b83', 'terminal_background': '#0d1117'})
    assert ok.status_code == 200
    assert ok.get_json()['brand_name'] == 'Panel rojo'
    assert client.get('/api/preferences').get_json()['accent_color'] == '#e18b83'

    invalid = client.put('/api/preferences', headers={'X-WebConsole': '1', 'Content-Type': 'application/json'},
                         json={'accent_color': 'javascript:alert(1)'})
    assert invalid.status_code == 400


def test_workspace_and_console_render_custom_preferences(tmp_path, monkeypatch):
    import server

    state = tmp_path / 'state'
    state.mkdir(mode=0o700)
    store = PreferencesStore(state)
    store.update({'brand_name': 'Mi & Consola "X"', 'accent_color': '#ff0000', 'terminal_background': '#010203'})
    monkeypatch.setattr(server, 'PREFERENCES_STORE', store)
    monkeypatch.setattr(server, 'PROJECT_STORE', server.PROJECT_STORE.__class__(tmp_path / 'projects'))
    monkeypatch.setattr(server, 'terminal_sessions', {'s1': {'created_at': 1, 'last_active': 1, 'session_token': 't' * 43, 'cols': 80, 'rows': 24, 'cwd': str(tmp_path)}})
    monkeypatch.setattr(server, 'session_tokens', {'s1': 't' * 43})
    monkeypatch.delenv('WEBCONSOLE_PASSWORD', raising=False)
    client = server.app.test_client()

    page = client.get('/')
    assert page.status_code == 200
    assert b'--accent: #ff0000' in page.data
    assert b'--terminal-background: #010203' in page.data
    assert b'Mi &amp; Consola &#34;X&#34;' in page.data
    assert b'javascript:' not in page.data

    console_page = client.get('/c/' + 't' * 43)
    assert console_page.status_code == 200
    assert b'#010203' in console_page.data
    assert b"background: '#010203'" in console_page.data
