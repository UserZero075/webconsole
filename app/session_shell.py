"""Per-session environment and optional launcher; never edits global agent config."""
import json
import os
import shlex
import subprocess
import sys
from pathlib import Path
from agent_event import emit

state = Path(sys.argv[1])
sid = sys.argv[2]
info = json.loads((state / f'{sid}.json').read_text())
os.environ['WEBCONSOLE_SESSION_ID'] = sid
os.environ['WEBCONSOLE_EVENT_DIR'] = str(state / sid / 'events')
os.environ.pop('WEBCONSOLE_PASSWORD', None)
os.environ.pop('SECRET_KEY', None)
launcher = info.get('launcher', 'terminal')
if launcher != 'terminal':
    command = [launcher]
    if launcher == 'codex':
        notify = json.dumps([sys.executable, str(Path(__file__).with_name('agent_event.py'))])
        command += ['-c', 'notify=' + notify]
    elif launcher == 'opencode':
        # OpenCode merges inline config with existing user/project config.
        config = json.loads(os.environ.get('OPENCODE_CONFIG_CONTENT') or '{}')
        plugins = config.setdefault('plugin', [])
        plugin = (Path(__file__).resolve().parent.parent / 'integrations' / 'opencode.mjs').as_uri()
        if plugin not in plugins:
            plugins.append(plugin)
        os.environ['OPENCODE_CONFIG_CONTENT'] = json.dumps(config)
    try:
        # Load the same user environment as an ordinary console, including NVM.
        # Reapply the chosen directory after loading the login profile.
        shell_command = 'cd -- ' + shlex.quote(info['cwd']) + ' && exec ' + shlex.join(command)
        result = subprocess.run(['bash', '-lc', shell_command])
        emit({'type': 'completed' if result.returncode == 0 else 'error', 'agent': launcher,
              'message': f'{launcher}: el proceso terminó (código {result.returncode})'})
    except OSError as error:
        print(f'No se pudo iniciar {launcher}: {error}', flush=True)
os.execvpe('bash', ['bash', '-l'], os.environ)
