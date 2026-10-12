"""Private, atomic persistence for registered projects and workspaces."""
import json
import os
import re
import tempfile
import threading
import time
import uuid
from pathlib import Path


class ProjectError(ValueError):
    pass


class ProjectStore:
    SCHEMA_VERSION = 1

    def __init__(self, state_dir):
        self.state_dir = Path(state_dir)
        self.path = self.state_dir / 'projects.json'
        self.lock = threading.RLock()

    def _read(self):
        try:
            if self.path.is_symlink():
                raise ProjectError('El registro de proyectos no puede ser un enlace simbólico.')
            raw = json.loads(self.path.read_text(encoding='utf-8'))
        except FileNotFoundError:
            return {'version': self.SCHEMA_VERSION, 'projects': []}
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise ProjectError('No se pudo leer el registro privado de proyectos.') from error
        if not isinstance(raw, dict) or raw.get('version') != self.SCHEMA_VERSION or not isinstance(raw.get('projects'), list):
            raise ProjectError('El registro de proyectos tiene un formato no compatible.')
        projects = []
        seen = set()
        for project in raw['projects']:
            if not isinstance(project, dict):
                continue
            project_id, name, root = project.get('id'), project.get('name'), project.get('path')
            if not isinstance(project_id, str) or not re.fullmatch(r'[a-f0-9]{12}', project_id):
                continue
            if not isinstance(name, str) or not isinstance(root, str):
                continue
            try:
                root = str(Path(root).resolve(strict=True))
            except (OSError, RuntimeError):
                # Keep unavailable projects in the list so their sessions can be recovered later.
                root = os.path.abspath(root)
            if project_id in seen:
                continue
            seen.add(project_id)
            workspaces = []
            for workspace in project.get('workspaces', []):
                if not isinstance(workspace, dict):
                    continue
                wid, workspace_path = workspace.get('id'), workspace.get('path')
                if not isinstance(wid, str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,64}', wid):
                    continue
                if not isinstance(workspace_path, str):
                    continue
                workspaces.append({
                    'id': wid,
                    'name': str(workspace.get('name') or Path(workspace_path).name)[:100],
                    'path': os.path.abspath(workspace_path),
                    'worktree_root': os.path.abspath(workspace.get('worktree_root') or workspace_path),
                    'kind': workspace.get('kind') if workspace.get('kind') in {'primary', 'existing_worktree', 'managed_worktree'} else 'existing_worktree',
                    'created_at': float(workspace.get('created_at') or project.get('created_at') or 0),
                    'branch': workspace.get('branch') if isinstance(workspace.get('branch'), str) else '',
                })
            projects.append({
                'id': project_id, 'name': name[:100], 'path': root,
                'created_at': float(project.get('created_at') or 0),
                'workspaces': workspaces,
            })
        return {'version': self.SCHEMA_VERSION, 'projects': projects}

    def _write(self, data):
        self.state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.state_dir.chmod(0o700)
        fd, temporary = tempfile.mkstemp(prefix='.projects-', suffix='.tmp', dir=self.state_dir)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, 'w', encoding='utf-8') as file:
                json.dump(data, file, ensure_ascii=True, separators=(',', ':'))
                file.flush()
                os.fsync(file.fileno())
            os.replace(temporary, self.path)
            os.chmod(self.path, 0o600)
            directory = os.open(self.state_dir, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass

    def list(self):
        with self.lock:
            return self._read()['projects']

    def get(self, project_id):
        return next((item for item in self.list() if item['id'] == project_id), None)

    def add(self, path, name=''):
        if not isinstance(path, str) or len(path) > 4096:
            raise ProjectError('Indica una ruta de proyecto válida.')
        try:
            root = Path(path).expanduser().resolve(strict=True)
        except (OSError, RuntimeError) as error:
            raise ProjectError('La ruta no existe o no se puede resolver.') from error
        if not root.is_dir():
            raise ProjectError('La ruta del proyecto debe ser un directorio.')
        canonical = str(root)
        with self.lock:
            data = self._read()
            if any(project['path'] == canonical for project in data['projects']):
                raise ProjectError('Ese directorio ya está registrado.')
            clean_name = name.strip() if isinstance(name, str) else ''
            clean_name = clean_name[:100] or root.name or canonical
            project_id = uuid.uuid4().hex[:12]
            workspace_id = uuid.uuid4().hex[:12]
            now = time.time()
            project = {
                'id': project_id, 'name': clean_name, 'path': canonical, 'created_at': now,
                'workspaces': [{'id': workspace_id, 'name': 'Principal', 'path': canonical,
                                'worktree_root': canonical, 'kind': 'primary', 'created_at': now, 'branch': ''}],
            }
            data['projects'].append(project)
            self._write(data)
            return project

    def rename(self, project_id, name):
        if not isinstance(name, str) or not name.strip() or len(name.strip()) > 100:
            raise ProjectError('El nombre debe tener entre 1 y 100 caracteres.')
        with self.lock:
            data = self._read()
            project = next((item for item in data['projects'] if item['id'] == project_id), None)
            if not project:
                return None
            project['name'] = name.strip()
            self._write(data)
            return project

    def remove(self, project_id):
        with self.lock:
            data = self._read()
            remaining = [item for item in data['projects'] if item['id'] != project_id]
            if len(remaining) == len(data['projects']):
                return False
            data['projects'] = remaining
            self._write(data)
            return True

    def add_workspace(self, project_id, workspace):
        with self.lock:
            data = self._read()
            project = next((item for item in data['projects'] if item['id'] == project_id), None)
            if not project:
                raise ProjectError('El proyecto ya no existe.')
            for current in project['workspaces']:
                if current['path'] == workspace['path']:
                    return current
            if any(item['id'] == workspace['id'] for item in project['workspaces']):
                raise ProjectError('El identificador del workspace ya está en uso.')
            project['workspaces'].append(workspace)
            self._write(data)
            return workspace

    def update_workspace(self, project_id, workspace_id, **fields):
        with self.lock:
            data = self._read()
            project = next((item for item in data['projects'] if item['id'] == project_id), None)
            if not project:
                return None
            workspace = next((item for item in project['workspaces'] if item['id'] == workspace_id), None)
            if not workspace:
                return None
            changed = False
            for key in ('name', 'branch', 'kind'):
                if key in fields and workspace.get(key) != fields[key]:
                    workspace[key] = fields[key]
                    changed = True
            if changed:
                self._write(data)
            return workspace

    def remove_workspace(self, project_id, workspace_id):
        with self.lock:
            data = self._read()
            project = next((item for item in data['projects'] if item['id'] == project_id), None)
            if not project:
                return None
            workspace = next((item for item in project['workspaces'] if item['id'] == workspace_id), None)
            if not workspace:
                return None
            if workspace.get('kind') == 'primary':
                raise ProjectError('El workspace principal solo se quita al retirar el proyecto de WebConsole.')
            project['workspaces'].remove(workspace)
            self._write(data)
            return workspace

    def get_workspace(self, workspace_id):
        for project in self.list():
            workspace = next((item for item in project['workspaces'] if item['id'] == workspace_id), None)
            if workspace:
                return project, workspace
        return None, None
