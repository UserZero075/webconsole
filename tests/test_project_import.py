import json
import os
import sys
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'app'))

from host_directories import DirectoryError, list_directories, resolve_directory
from github_service import GitHubError, validate_public_url


def test_host_directory_listing_hides_hidden_symlink_and_excluded_roots(tmp_path):
    home = tmp_path / 'home'
    home.mkdir()
    (home / 'workspace').mkdir()
    (home / '.private').mkdir()
    secret = tmp_path / 'secret'
    secret.mkdir()
    (home / 'secret-link').symlink_to(secret, target_is_directory=True)

    result = list_directories(home, excluded=(secret,))
    assert [item['name'] for item in result['directories']] == ['workspace']
    assert result['path'] == str(home)
    with pytest.raises(DirectoryError):
        resolve_directory(home / 'secret-link', excluded=(secret,))
    with pytest.raises(DirectoryError):
        resolve_directory(secret, excluded=(secret,))


def test_public_github_url_accepts_only_canonical_https_repository_urls():
    assert validate_public_url('https://github.com/Owner/Repo') == (
        'https://github.com/Owner/Repo.git', 'Owner/Repo')
    assert validate_public_url('https://github.com/Owner/Repo.git/') == (
        'https://github.com/Owner/Repo.git', 'Owner/Repo')
    for value in (
        'http://github.com/owner/repo', 'https://user:token@github.com/owner/repo',
        'https://github.com.evil.invalid/owner/repo', 'https://github.com/owner/repo?tab=readme',
        'file:///tmp/repo', 'ssh://git@github.com/owner/repo.git',
        'https://github.com/owner/repo/other',
    ):
        with pytest.raises(GitHubError):
            validate_public_url(value)


def test_clone_ignores_global_git_smudge_filters(tmp_path):
    from git_service import clone_repository

    source = tmp_path / 'source'
    source.mkdir()
    marker = tmp_path / 'filter-ran'
    global_config = tmp_path / 'gitconfig'
    env = {**os.environ, 'GIT_CONFIG_GLOBAL':str(global_config)}
    subprocess.run(['git', 'init', str(source)], check=True, capture_output=True, env=env)
    subprocess.run(['git', '-C', str(source), 'checkout', '-b', 'main'], check=True, capture_output=True, env=env)
    subprocess.run(['git', '-C', str(source), 'config', 'user.name', 'Test'], check=True, env=env)
    subprocess.run(['git', '-C', str(source), 'config', 'user.email', 'test@example.invalid'], check=True, env=env)
    (source / '.gitattributes').write_text('payload.txt filter=probe\n')
    (source / 'payload.txt').write_text('unchanged\n')
    subprocess.run(['git', '-C', str(source), 'add', '.'], check=True, env=env)
    subprocess.run(['git', '-C', str(source), 'commit', '-m', 'fixture'], check=True, capture_output=True, env=env)
    global_config.write_text(
        '[filter "probe"]\n\tsmudge = touch ' + str(marker) + '\n\trequired = true\n')
    destination = tmp_path / 'clone'
    destination.mkdir()

    clone_repository(str(source), destination, 'main')

    assert not marker.exists()
    assert (destination / 'payload.txt').read_text() == 'unchanged\n'


def test_github_repository_pagination_includes_org_and_collaboration_repos(monkeypatch):
    import github_service

    monkeypatch.setattr(github_service, 'resolve_gh', lambda: '/fake/gh')
    responses = iter([
        'octocat\n',
        json.dumps([{'full_name':'octocat/personal', 'name':'personal', 'owner':{'login':'octocat'},
                      'visibility':'private', 'default_branch':'main', 'archived':False,
                      'permissions':{'push':True}},
                     {'full_name':'team/shared', 'name':'shared', 'owner':{'login':'team'},
                      'visibility':'public', 'default_branch':'trunk', 'archived':False,
                      'permissions':{'push':True}}])
    ])
    commands = []

    def fake_run(_args, timeout=12):
        commands.append(_args)
        return next(responses)

    monkeypatch.setattr(github_service, '_run', fake_run)
    result = github_service.repositories()
    assert [item['full_name'] for item in result['repositories']] == ['octocat/personal', 'team/shared']
    assert result['repositories'][0]['owned'] is True
    assert result['repositories'][1]['owned'] is False
    assert result['repositories'][1]['push'] is True
    assert '--paginate' in commands[-1]
    assert '--slurp' not in commands[-1]
    assert '--jq' not in commands[-1]


def test_github_repo_response_handles_pages_and_does_not_return_credentials(monkeypatch):
    import github_service

    monkeypatch.setattr(github_service, 'resolve_gh', lambda: '/fake/gh')
    responses = iter(['octocat\n',
                      json.dumps([{'full_name':'octocat/a', 'name':'a', 'owner':{'login':'octocat'}, 'visibility':'public',
          'default_branch':'main', 'permissions':{'push':True}}],
                      ) + '\n' + json.dumps([{'full_name':'org/b', 'name':'b', 'owner':{'login':'org'}, 'visibility':'private',
          'default_branch':'develop', 'permissions':{'push':False}}])])
    monkeypatch.setattr(github_service, '_run', lambda *_args, **_kwargs: next(responses))
    result = github_service.repositories('org/')
    assert [repo['full_name'] for repo in result['repositories']] == ['org/b']
    assert 'token' not in json.dumps(result).lower()


def test_resolve_gh_uses_user_local_install_with_restricted_path(tmp_path, monkeypatch):
    import github_service

    monkeypatch.setattr(github_service.shutil, 'which', lambda _name: None)
    monkeypatch.setattr(github_service.Path, 'home', staticmethod(lambda: tmp_path))
    binary = tmp_path / '.local' / 'bin' / 'gh'
    binary.parent.mkdir(parents=True)
    binary.write_text('#!/bin/sh\nexit 0\n')
    binary.chmod(0o700)

    assert github_service.resolve_gh() == str(binary.resolve())

    binary.chmod(0o600)
    assert github_service.resolve_gh() is None


def test_resolve_gh_prefers_path_and_credential_helper_uses_absolute_quoted_binary(tmp_path, monkeypatch):
    import github_service
    import git_service
    from types import SimpleNamespace

    path_binary = tmp_path / 'path-gh'
    path_binary.write_text('#!/bin/sh\nexit 0\n')
    path_binary.chmod(0o700)
    monkeypatch.setattr(github_service.shutil, 'which', lambda _name: str(path_binary))
    assert github_service.resolve_gh() == str(path_binary.resolve())

    captured = {}
    monkeypatch.setattr(git_service, 'resolve_gh', lambda: '/opt/GH CLI/bin/gh')
    monkeypatch.setattr(git_service.subprocess, 'run', lambda command, **kwargs: (
        captured.update(command=command, env=kwargs['env']) or SimpleNamespace(returncode=0)))
    git_service.clone_repository('https://github.com/org/repo.git', '/tmp/repo', 'main')
    helper = next(arg for arg in captured['command'] if arg.startswith('credential.helper=!exec'))
    assert helper == "credential.helper=!exec '/opt/GH CLI/bin/gh' auth git-credential"
    assert captured['env']['GIT_CONFIG_GLOBAL'] == os.devnull


def test_github_status_distinguishes_unauthenticated_from_network_failure(monkeypatch):
    import github_service

    monkeypatch.setattr(github_service, 'resolve_gh', lambda: '/home/test/.local/bin/gh')
    monkeypatch.setattr(github_service.shutil, 'which', lambda name: '/usr/bin/git' if name == 'git' else None)
    monkeypatch.setattr(github_service, '_run', lambda *_args, **_kwargs: (_ for _ in ()).throw(
        github_service.GitHubError('gh no tiene una sesión válida.', 'auth')))
    assert github_service.status()['state'] == 'unauthenticated'

    monkeypatch.setattr(github_service, '_run', lambda *_args, **_kwargs: (_ for _ in ()).throw(
        github_service.GitHubError('GitHub no permitió completar la consulta.')))
    status = github_service.status()
    assert status['state'] == 'error'
    assert 'conectividad' in status['message']


def test_directory_api_and_clone_endpoint_enforce_safe_inputs(tmp_path, monkeypatch):
    import server
    from projects import ProjectStore

    state = tmp_path / 'state'
    state.mkdir(mode=0o700)
    monkeypatch.setattr(server, 'TERMINAL_SESSIONS_DIR', state)
    monkeypatch.setattr(server, 'WORKTREE_DIR', tmp_path / 'worktrees')
    monkeypatch.setattr(server, 'PROJECT_STORE', ProjectStore(state))
    client = server.app.test_client()

    home = client.get('/api/host-directories')
    assert home.status_code == 200
    assert home.get_json()['path'] == str(Path.home())
    private_state = client.post('/api/projects', headers={'X-WebConsole':'1'}, json={'path':str(state)})
    assert private_state.status_code == 400
    bad_url = client.post('/api/projects/clone', headers={'X-WebConsole':'1'}, json={
        'parent':str(tmp_path), 'folder':'repo', 'branch':'main', 'url':'file:///etc/passwd'})
    assert bad_url.status_code == 400
    assert not (tmp_path / 'repo').exists()

    def fake_clone(_url, destination, branch, timeout=120):
        subprocess.run(['git', 'init', str(destination)], check=True, capture_output=True)
        subprocess.run(['git', '-C', str(destination), 'checkout', '-b', branch], check=True, capture_output=True)
        subprocess.run(['git', '-C', str(destination), 'config', 'user.name', 'Fixture'], check=True)
        subprocess.run(['git', '-C', str(destination), 'config', 'user.email', 'fixture@example.invalid'], check=True)
        (destination / 'README.md').write_text('fixture\n')
        subprocess.run(['git', '-C', str(destination), 'add', '.'], check=True)
        subprocess.run(['git', '-C', str(destination), 'commit', '-m', 'fixture'], check=True, capture_output=True)

    monkeypatch.setattr(server, 'clone_repository', fake_clone)
    cloned = client.post('/api/projects/clone', headers={'X-WebConsole':'1'}, json={
        'parent':str(tmp_path), 'folder':'repo', 'branch':'develop',
        'url':'https://github.com/owner/repo'})
    assert cloned.status_code == 201
    assert cloned.get_json()['branch'] == 'develop'
    assert Path(cloned.get_json()['project']['path']).is_dir()
    assert client.post('/api/projects/clone', headers={'X-WebConsole':'1'}, json={
        'parent':str(tmp_path), 'folder':'repo', 'branch':'main',
        'url':'https://github.com/owner/repo'}).status_code == 400
