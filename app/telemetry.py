"""Bounded, read-only terminal observation and structured agent events.

Screen-derived activity is an estimate. Explicit hook events take precedence.
No keys are injected into panes and no agent transcript outside the pane is read.
"""
import difflib
import hashlib
import json
import math
import os
import re
import subprocess
import threading
import time
from pathlib import Path

AGENTS = {'codex': 'Codex', 'opencode': 'OpenCode', 'hermes': 'Hermes', 'claude': 'Claude Code', 'aider': 'Aider'}
SHELLS = {'bash', 'sh', 'zsh', 'fish', 'dash'}
EVENT_TYPES = {'working', 'idle', 'permission', 'completed', 'message', 'tool', 'error'}
CONTROL = re.compile(r'\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|[\x00-\x08\x0b-\x1f\x7f]')
PERMISSION = re.compile(r'would you like to (?:run|allow|proceed)|do you (?:want to (?:run|allow|proceed|execute)|approve)|allow (?:once|always|execution)|permission required|requires? (?:your )?approval|approve this|¿(?:permites|autorizas)|necesita(?: tu)? permiso', re.I)


def clean_text(value, limit=1200):
    return CONTROL.sub('', str(value))[:limit]


def process_snapshot():
    """Read process identity and CPU counters; never expose command arguments."""
    processes = {}
    for directory in Path('/proc').iterdir():
        if not directory.name.isdigit():
            continue
        try:
            stat = (directory / 'stat').read_text()
            fields = stat[stat.rfind(')') + 2:].split()
            comm = stat[stat.find('(') + 1:stat.rfind(')')]
            # Read only executable/script positions, not prompts, tokens or env vars.
            argv = (directory / 'cmdline').read_bytes()[:2048].split(b'\0')
            identities = [comm]
            for arg in argv[:3]:
                name = Path(arg.decode('utf-8', errors='replace')).name.lower()
                if name in AGENTS or name in {'codex.js', 'hermes_cli.py', '__main__.py'}:
                    identities.append(name)
            agent = next((key for key in AGENTS if key in identities or key + '.js' in identities), None)
            if 'hermes_cli.py' in identities:
                agent = 'hermes'
            processes[int(directory.name)] = dict(pid=int(directory.name), parent=int(fields[1]),
                group=int(fields[2]), foreground=int(fields[5]), ticks=int(fields[11]) + int(fields[12]),
                name=comm, agent=agent, start=fields[19])
        except (OSError, ValueError, IndexError):
            continue
    return processes


def descendants(root, processes):
    children = {}
    for process in processes.values():
        children.setdefault(process['parent'], []).append(process)
    result, pending, visited = [], [root], set()
    while pending:
        pid = pending.pop()
        if pid in visited:
            continue
        visited.add(pid)
        for process in children.get(pid, []):
            result.append(process)
            pending.append(process['pid'])
    return result


class Telemetry:
    def __init__(self, tmux, sessions, state_dir, persist):
        self.tmux, self.sessions, self.state_dir, self.persist = tmux, sessions, state_dir, persist
        self.lock = threading.RLock()
        self.cache = {}
        self.last_sample = 0
        self.available = True
        self.stop = threading.Event()

    def ensure(self, sid, info):
        if sid not in self.cache:
            self.cache[sid] = dict(activity=[], previous_lines=None, last_output=None,
                ticks={}, process_key=None, notification=info.get('notification'),
                dismissed=info.get('dismissed_notification'), agent=None,
                event_state=(info.get('notification') or {}).get('kind') if (info.get('notification') or {}).get('source') == 'event' else None, event_at=0, sequence=0)
        return self.cache[sid]

    def append(self, item, kind, text, now, source='screen', key=None):
        text = clean_text(text)
        if not text.strip():
            return
        if key:
            existing = next((entry for entry in item['activity'] if entry.get('key') == key), None)
            if existing:
                existing.update(text=text, at=now)
                return
        if item['activity'] and item['activity'][-1]['text'] == text:
            return
        item['sequence'] += 1
        item['activity'].append(dict(id=item['sequence'], kind=kind, text=text, at=now, source=source, key=key))
        item['activity'] = item['activity'][-60:]

    def notify(self, sid, info, item, kind, text, source, fingerprint):
        if item.get('dismissed') == fingerprint:
            return
        previous = item.get('notification')
        if previous and previous['fingerprint'] == fingerprint:
            return
        item['notification'] = dict(kind=kind, message=clean_text(text, 300), source=source,
                                    at=time.time(), fingerprint=fingerprint)
        info['notification'] = item['notification']
        self.persist(sid, info)

    def ingest(self, sid, info, item, now):
        directory = self.state_dir() / sid / 'events'
        for path in sorted(directory.glob('*.json'))[:128]:
            try:
                if path.is_symlink() or path.stat().st_size > 16384:
                    continue
                event = json.loads(path.read_text())
                if not isinstance(event, dict) or not isinstance(event.get('type'), str) or event.get('type') not in EVENT_TYPES:
                    continue
                kind = event['type']
                event_time = event.get('at', now)
                if not isinstance(event_time, (int, float)) or not math.isfinite(event_time):
                    event_time = now
                event_time = min(event_time, now)
                if kind in {'message', 'tool'}:
                    item['structured_activity'] = True
                    item['last_output'] = max(item.get('last_output') or 0, event_time)
                text = event.get('message') or {'working': 'El agente empezó a trabajar', 'idle': 'El agente está en espera',
                    'completed': 'El agente terminó su turno', 'permission': 'El agente necesita tu permiso', 'error': 'El agente notificó un error'}.get(kind, '')
                source_agent = event.get('agent')
                if isinstance(source_agent, str) and source_agent in AGENTS:
                    item['agent'] = dict(key=source_agent, name=AGENTS[source_agent], kind='agent')
                if kind not in {'message', 'tool'}:
                    item.update(event_state=kind, event_at=now)
                if kind in {'working', 'idle'} and (item.get('notification') or {}).get('kind') == 'permission':
                    item['notification'] = None
                    info['notification'] = None
                    self.persist(sid, info)
                if kind in {'permission', 'completed', 'error'}:
                    self.notify(sid, info, item, kind, text, 'event', path.stem)
                self.append(item, 'tool' if kind == 'tool' else 'message' if kind == 'message' else 'status', text, event_time, 'event', event.get('key'))
            except (OSError, ValueError, TypeError):
                pass
            finally:
                try:
                    path.unlink(missing_ok=True)
                except OSError:
                    pass

    def sample(self, force=False):
        with self.lock:
            now = time.time()
            sessions = self.sessions()
            if not force and now - self.last_sample < 2 and {sid for sid, _ in sessions} == set(self.cache):
                return
            self.last_sample = now
            try:
                result = self.tmux('list-panes', '-a', '-F', '#{session_name}\t#{pane_id}\t#{pane_pid}\t#{pane_current_path}\t#{pane_dead}\t#{pane_current_command}', check=False)
                panes = {}
                for line in result.stdout.splitlines():
                    fields = line.split('\t', 5)
                    if len(fields) == 6:
                        panes[fields[0]] = fields[1:]
                self.available = result.returncode == 0 or not sessions
                processes = process_snapshot() if panes else {}
                for sid, info in sessions:
                    item = self.ensure(sid, info)
                    pane = panes.get(sid)
                    alive = bool(pane and pane[3] == '0')
                    item.update(is_active=alive, observed_at=now)
                    if pane:
                        info.update(pid=int(pane[1]), cwd=pane[2])
                    tree = descendants(int(pane[1]), processes) if alive else []
                    root_process = processes.get(int(pane[1])) if alive else None
                    if root_process and root_process['name'] not in SHELLS:
                        tree.insert(0, root_process)
                    agent_process = next((process for process in tree if process['agent']), None)
                    foreground = next((process for process in tree if process['group'] == process['foreground'] and process['name'] not in SHELLS), None)
                    tool = agent_process or foreground or next((process for process in tree if process['name'] not in SHELLS), None)
                    if tool:
                        agent_key = tool['agent']
                        identity = dict(key=agent_key or 'tool', name=AGENTS[agent_key] if agent_key else clean_text(tool['name'], 80),
                                        kind='agent' if agent_key else 'tool')
                    else:
                        identity = dict(key='terminal', name='Terminal', kind='shell')
                    process_key = (tool['pid'], tool['start']) if tool else None
                    previous_key = item.get('process_key')
                    if previous_key and not process_key:
                        previous_agent = item.get('agent') or identity
                        # Ignore transient shell helpers such as prompt/status commands.
                        if previous_agent['kind'] == 'agent' or now - item.get('process_started', now) >= 2:
                            self.notify(sid, info, item, 'completed', previous_agent['name'] + ': el proceso finalizó', 'process', str(previous_key) + ':exit')
                            self.append(item, 'status', previous_agent['name'] + ': el proceso finalizó', now, 'process')
                        item['event_state'] = None
                    if process_key != previous_key:
                        if item['previous_lines'] is not None:
                            item['event_state'] = None
                        item.update(process_key=process_key, previous_lines=None, last_output=None, structured_activity=False, process_started=now)
                    item['agent'] = identity
                    self.ingest(sid, info, item, now)
                    ticks = {(p['pid'], p['start']): p['ticks'] for p in tree}
                    cpu_active = any(value > item['ticks'].get(key, value) + 1 for key, value in ticks.items())
                    item['ticks'] = ticks
                    screen = ''
                    if pane:
                        capture = self.tmux('capture-pane', '-p', '-t', pane[0], '-S', '-60', check=False)
                        screen = clean_text(capture.stdout, 160000)
                    lines = [line.rstrip() for line in screen.splitlines()]
                    previous = item['previous_lines']
                    changed = previous is not None and lines != previous
                    if changed:
                        item['last_output'] = now
                        added = []
                        for tag, _, _, start, end in difflib.SequenceMatcher(None, previous, lines, autojunk=False).get_opcodes():
                            if tag in ('insert', 'replace'):
                                added.extend(line for line in lines[start:end] if line.strip())
                        for line in ([] if item.get('structured_activity') else added[-8:]):
                            kind = 'tool' if re.match(r'^\s*(?:[•●>❯]\s*)?(?:Ran |Running |Read |Edited |Tool:|Herramienta:|Ejecutando |\$ )', line) else 'message' if identity['kind'] == 'agent' else 'output'
                            self.append(item, kind, line, now)
                    elif previous is None:
                        for line in ([] if item.get('structured_activity') else [line for line in lines if line.strip()][-6:]):
                            self.append(item, 'output', line, now)
                    item['previous_lines'] = lines
                    item['preview'] = '\n'.join(lines[-30:]).rstrip()[-16000:]
                    # Restrict prompt detection to the visible screen; never scan old scrollback.
                    visible = lines[-max(5, int(info.get('rows', 30))):]
                    prompt = next((line for line in reversed(visible) if PERMISSION.search(line)), None) if identity['kind'] == 'agent' and not item['event_state'] else None
                    if prompt:
                        index = len(visible) - 1 - visible[::-1].index(prompt)
                        context = '\n'.join(visible[max(0, index - 2):index + 6])
                        digest = hashlib.sha256((str(process_key) + context).encode()).hexdigest()[:16] + ':permission'
                        item['permission_fingerprint'] = digest
                        self.notify(sid, info, item, 'permission', prompt.strip(), 'screen', digest)
                    elif item.get('permission_fingerprint'):
                        item['permission_fingerprint'] = None
                        notice = item.get('notification')
                        if notice and notice['kind'] == 'permission' and notice['source'] == 'screen':
                            item['notification'] = None
                            info['notification'] = None
                        item['dismissed'] = None
                        info['dismissed_notification'] = None
                        self.persist(sid, info)
                    if not alive:
                        state, source, detail = 'ended', 'process', 'La consola terminó'
                    elif prompt:
                        state, source, detail = 'permission', 'estimated', 'Posible solicitud de permiso en pantalla'
                    elif item['event_state']:
                        state = {'completed': 'idle', 'error': 'idle'}.get(item['event_state'], item['event_state'])
                        source, detail = 'event', 'Estado comunicado por el agente'
                    elif not tool:
                        state, source, detail = 'idle', 'process', 'Consola lista; no hay un agente ejecutándose'
                    elif cpu_active or changed or (item['last_output'] and now - item['last_output'] < 10):
                        state, source, detail = 'working', 'estimated', 'Actividad reciente en el proceso o la consola'
                    else:
                        state, source, detail = 'idle', 'estimated', 'Sin actividad reciente; puede estar esperando una respuesta'
                    item.update(state=state, state_source=source, state_detail=detail)
                self.cache = {sid: value for sid, value in self.cache.items() if any(sid == current for current, _ in sessions)}
            except (OSError, RuntimeError, ValueError, subprocess.SubprocessError):
                self.available = False

    def payload(self, sid, info):
        with self.lock:
            item = self.ensure(sid, info)
            return {key: item.get(key) for key in ('agent', 'state', 'state_source', 'state_detail', 'observed_at', 'last_output', 'notification', 'preview')} | {'activity': list(item['activity'][-16:]), 'is_active': item.get('is_active', False)}

    def acknowledge(self, sid, info, fingerprint):
        with self.lock:
            item = self.ensure(sid, info)
            notice = item.get('notification')
            if not notice or notice['fingerprint'] != fingerprint:
                return False
            item['dismissed'] = fingerprint
            item['notification'] = None
            info.update(notification=None, dismissed_notification=fingerprint)
            self.persist(sid, info)
            return True

    def run(self):
        while not self.stop.is_set():
            self.sample()
            self.stop.wait(2)
