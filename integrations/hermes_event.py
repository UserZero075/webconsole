"""Hermes shell-hook adapter: emit passive status/events, return no directives.

Configure the desired hook to run: python /path/integrations/hermes_event.py <event>
Hermes passes the hook payload as JSON on stdin. Its normal hook consent still applies.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
from agent_event import emit


def main():
    try:
        payload = json.loads(sys.stdin.read(16384))
        if not isinstance(payload, dict):
            return
        event = sys.argv[1] if len(sys.argv) > 1 else ''
        kind, message = None, ''
        if event == 'pre_llm_call':
            kind, message = 'working', 'Hermes está trabajando'
        elif event in {'pre_tool_call', 'post_tool_call'}:
            kind = 'tool'
            message = ('Ejecutando ' if event == 'pre_tool_call' else 'Terminó ') + str(payload.get('tool_name', 'herramienta'))
        elif event == 'on_session_end':
            if payload.get('completed'):
                kind, message = 'completed', 'Hermes terminó su turno'
            elif payload.get('failed'):
                kind, message = 'error', 'El turno de Hermes terminó con un error'
            elif payload.get('interrupted'):
                kind, message = 'idle', 'El turno de Hermes fue interrumpido'
        if kind:
            emit({'type': kind, 'agent': 'hermes', 'message': message})
    except (OSError, ValueError, IndexError):
        pass


if __name__ == '__main__':
    main()
