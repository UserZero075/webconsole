import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'app'))
import telemetry as module
from telemetry import Telemetry


def fixture_monitor(tmp_path, monkeypatch):
    info = dict(created_at=0, last_active=0, cols=120, rows=30, cwd=str(tmp_path))
    processes = {42: dict(pid=42, parent=1, group=42, foreground=43, ticks=0, name='bash', agent=None, start='1'),
                 43: dict(pid=43, parent=42, group=43, foreground=43, ticks=0, name='node', agent='codex', start='2')}
    screen = ['Ready']
    def tmux(*args, **kwargs):
        if args[0] == 'list-panes':
            return SimpleNamespace(returncode=0, stdout=f'test123\t%0\t42\t{tmp_path}\t0\tnode\n')
        return SimpleNamespace(returncode=0, stdout='\n'.join(screen))
    monkeypatch.setattr(module, 'process_snapshot', lambda: processes)
    monitor = Telemetry(tmux, lambda: [('test123', info)], lambda: tmp_path, lambda *args: None)
    return monitor, info, screen, processes


def write_event(tmp_path, event, name='001'):
    directory = tmp_path / 'test123' / 'events'
    directory.mkdir(parents=True, exist_ok=True)
    (directory / f'{name}.json').write_text(json.dumps(event))


def test_process_detection_and_recent_output_are_estimates(tmp_path, monkeypatch):
    monitor, info, screen, _ = fixture_monitor(tmp_path, monkeypatch)
    monitor.sample(force=True)
    payload = monitor.payload('test123', info)
    assert payload['agent']['name'] == 'Codex'
    assert payload['state_source'] == 'estimated'
    screen.append('Ran npm run build')
    monitor.sample(force=True)
    payload = monitor.payload('test123', info)
    assert payload['state'] == 'working'
    assert payload['activity'][-1]['kind'] == 'tool'
    assert payload['notification'] is None


def test_permissions_acknowledge_and_new_prompt(tmp_path, monkeypatch):
    monitor, info, screen, _ = fixture_monitor(tmp_path, monkeypatch)
    screen[:] = ['Would you like to run the following command?']
    monitor.sample(force=True)
    notice = monitor.payload('test123', info)['notification']
    assert notice['kind'] == 'permission' and notice['source'] == 'screen'
    assert not monitor.acknowledge('test123', info, 'outdated-id')
    assert monitor.acknowledge('test123', info, notice['fingerprint'])
    monitor.sample(force=True)
    assert monitor.payload('test123', info)['notification'] is None
    assert monitor.payload('test123', info)['state'] == 'permission'
    screen[:] = ['Ready']
    monitor.sample(force=True)
    screen[:] = ['Do you approve a different command?']
    monitor.sample(force=True)
    assert monitor.payload('test123', info)['notification'] is not None


def test_native_events_do_not_depend_on_browser_and_streams_upsert(tmp_path, monkeypatch):
    monitor, info, _, _ = fixture_monitor(tmp_path, monkeypatch)
    write_event(tmp_path, {'type': 'working', 'agent': 'opencode'})
    monitor.sample(force=True)
    assert monitor.payload('test123', info)['state_source'] == 'event'
    assert monitor.payload('test123', info)['state'] == 'working'
    write_event(tmp_path, {'type': 'message', 'message': 'Hello', 'key': 'message1'})
    monitor.sample(force=True)
    write_event(tmp_path, {'type': 'message', 'message': 'Hello world', 'key': 'message1'})
    monitor.sample(force=True)
    messages = [e for e in monitor.payload('test123', info)['activity'] if e.get('key') == 'message1']
    assert len(messages) == 1 and messages[0]['text'] == 'Hello world'
    write_event(tmp_path, {'type': 'completed', 'agent': 'codex', 'message': 'La tarea terminó'})
    monitor.sample(force=True)
    assert monitor.payload('test123', info)['notification']['kind'] == 'completed'
    assert not list((tmp_path / 'test123' / 'events').glob('*.json'))


def test_background_tool_and_exit_notification(tmp_path, monkeypatch):
    monitor, info, screen, processes = fixture_monitor(tmp_path, monkeypatch)
    processes[43].update(name='ffmpeg', agent=None, group=99)
    monitor.sample(force=True)
    assert monitor.payload('test123', info)['agent'] == {'key': 'tool', 'name': 'ffmpeg', 'kind': 'tool'}
    monitor.cache['test123']['process_started'] -= 3
    processes.pop(43)
    monitor.sample(force=True)
    notice = monitor.payload('test123', info)['notification']
    assert notice['source'] == 'process' and 'ffmpeg' in notice['message']


def test_old_permission_text_and_done_text_are_not_task_notifications(tmp_path, monkeypatch):
    monitor, info, screen, _ = fixture_monitor(tmp_path, monkeypatch)
    screen[:] = ['Would you like to run a command?'] + ['old output'] * 35 + ['done compiling']
    monitor.sample(force=True)
    assert monitor.payload('test123', info)['notification'] is None


def test_event_helper_bounded_and_private(tmp_path):
    import os
    directory = tmp_path / 'events'
    env = {**os.environ, 'WEBCONSOLE_EVENT_DIR': str(directory)}
    payload = json.dumps({'type': 'agent-turn-complete', 'last-assistant-message': '<script>alert(1)</script>'})
    subprocess.run([sys.executable, str(ROOT / 'app' / 'agent_event.py'), payload], env=env, check=True)
    files = list(directory.glob('*.json'))
    assert len(files) == 1
    assert files[0].stat().st_mode & 0o777 == 0o600
    event = json.loads(files[0].read_text())
    assert event['type'] == 'completed' and event['agent'] == 'codex'
    # Text is retained as text; the frontend must not evaluate it.
    assert event['message'].startswith('<script>')


def test_same_permission_can_notify_again_after_it_disappears(tmp_path, monkeypatch):
    monitor, info, screen, _ = fixture_monitor(tmp_path, monkeypatch)
    question = 'Would you like to run the following command?'
    screen[:] = [question]
    monitor.sample(force=True)
    notice = monitor.payload('test123', info)['notification']
    monitor.acknowledge('test123', info, notice['fingerprint'])
    screen[:] = ['Ready']
    monitor.sample(force=True)
    screen[:] = [question]
    monitor.sample(force=True)
    assert monitor.payload('test123', info)['notification'] is not None


def test_hermes_hook_adapter_observes_tools_and_completion(tmp_path):
    import os
    directory = tmp_path / 'events'
    env = {**os.environ, 'WEBCONSOLE_EVENT_DIR': str(directory)}
    adapter = ROOT / 'integrations' / 'hermes_event.py'
    subprocess.run([sys.executable, str(adapter), 'pre_tool_call'], input=json.dumps({'tool_name': 'terminal'}), text=True, env=env, check=True)
    subprocess.run([sys.executable, str(adapter), 'on_session_end'], input=json.dumps({'completed': True}), text=True, env=env, check=True)
    events = [json.loads(path.read_text()) for path in sorted(directory.glob('*.json'))]
    assert [event['type'] for event in events] == ['tool', 'completed']
    assert all(event['agent'] == 'hermes' for event in events)


def test_blank_screen_rows_do_not_resurface_old_permission(tmp_path, monkeypatch):
    monitor, info, screen, _ = fixture_monitor(tmp_path, monkeypatch)
    screen[:] = ['Would you like to run an old command?'] + ['old history'] * 4 + ['Current screen'] + [''] * 29
    monitor.sample(force=True)
    assert monitor.payload('test123', info)['notification'] is None


def test_screen_capture_keeps_latest_output_after_long_lines(tmp_path, monkeypatch):
    monitor, info, screen, _ = fixture_monitor(tmp_path, monkeypatch)
    screen[:] = ['x' * 500] * 45 + ['LATEST_PROGRESS']
    monitor.sample(force=True)
    assert 'LATEST_PROGRESS' in monitor.payload('test123', info)['preview']



def test_agent_execing_over_the_shell_is_identified(tmp_path, monkeypatch):
    monitor, info, _, processes = fixture_monitor(tmp_path, monkeypatch)
    processes.pop(43)
    processes[42].update(name='codex', agent='codex')
    monitor.sample(force=True)
    assert monitor.payload('test123', info)['agent']['name'] == 'Codex'
