"""Emit a bounded local event without credentials, network calls or agent interruption.

Codex notify: python /path/app/agent_event.py '{"type":"agent-turn-complete",...}'
Other hooks: python /path/app/agent_event.py --type permission --agent hermes --message '...'
"""
import argparse
import json
import os
import sys
import time
import uuid
from pathlib import Path


def emit(event):
    directory = os.environ.get('WEBCONSOLE_EVENT_DIR')
    if not directory:
        return
    try:
        root = Path(directory)
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        files = sorted(root.glob('*.json'))
        for path in files[:-127]:
            path.unlink(missing_ok=True)
        for field in ('message', 'key'):
            if field in event:
                event[field] = str(event[field])[:1200]
        event['at'] = time.time()
        destination = root / f'{time.time_ns()}-{uuid.uuid4().hex[:8]}.json'
        temporary = destination.with_suffix('.tmp')
        with temporary.open('x') as file:
            os.chmod(temporary, 0o600)
            json.dump(event, file)
        temporary.replace(destination)
    except (OSError, ValueError):
        # Observability must never prevent an agent from finishing its hook.
        return


def main():
    if len(sys.argv) == 2 and sys.argv[1].startswith('{'):
        try:
            payload = json.loads(sys.argv[1])
            if payload.get('type') == 'agent-turn-complete':
                emit({'type': 'completed', 'agent': 'codex', 'message': payload.get('last-assistant-message') or 'Codex terminó su turno'})
        except (ValueError, AttributeError):
            pass
        return
    parser = argparse.ArgumentParser()
    parser.add_argument('--type', choices=['working', 'idle', 'permission', 'completed', 'message', 'tool', 'error'], required=True)
    parser.add_argument('--agent', default='hermes')
    parser.add_argument('--message', default='')
    args = parser.parse_args()
    emit(vars(args))


if __name__ == '__main__':
    main()
