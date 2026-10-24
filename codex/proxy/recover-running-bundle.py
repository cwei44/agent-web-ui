#!/usr/bin/env python3
"""Recover missing bind-mount directories from a running Linux Codex container.

Run as root on the Docker host, after letting active Codex work finish:
  python3 proxy/recover-running-bundle.py --bundle /path/to/copied/bundle
The original bundle folder comes from the container's label. Recovery reads
the live mount namespace through /proc, verifies a snapshot while paused,
restores the original folder and web credentials, then runs httpd setup.
Snapshots and any previous destination files are retained for recovery.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile


def run(*command, capture=False):
    return subprocess.run(command, check=True, universal_newlines=True,
                          stdout=subprocess.PIPE if capture else None)


def fingerprint(root):
    """Compare actual content, links, permissions and ownership without following links."""
    result = {}
    def visit(path):
        info = path.lstat()
        kind = stat.S_IFMT(info.st_mode)
        value = None
        if stat.S_ISREG(info.st_mode):
            digest = hashlib.sha256()
            with path.open('rb') as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b''):
                    digest.update(block)
            value = digest.hexdigest()
        elif stat.S_ISLNK(info.st_mode):
            value = os.readlink(str(path))
        elif not stat.S_ISDIR(info.st_mode):
            raise ValueError('Special file needs manual recovery: ' + str(path))
        result[str(path.relative_to(root))] = (kind, stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid, value)
        if stat.S_ISDIR(info.st_mode):
            for child in path.iterdir():
                visit(child)
    visit(root)
    return result


def copy_verified(source, destination):
    expected = fingerprint(source)
    run('cp', '-a', '--', str(source), str(destination))
    if fingerprint(destination) != expected or fingerprint(source) != expected:
        raise ValueError('Copy verification failed for ' + str(source))


def recover(source):
    for name in ('codex-web.sh', 'IMAGE_ID', 'image-linux-amd64.tar.gz',
                 'proxy/render.sh', 'proxy/apache.conf.template', 'proxy/setup-httpd.py'):
        if not (source / name).is_file():
            raise ValueError('Missing bundle file: ' + str(source / name))
    container = json.loads(run('docker', 'inspect', 'codex-web-portable', capture=True).stdout)[0]
    state = container['State']
    if not state.get('Running') or state.get('Paused') or state.get('Restarting'):
        raise ValueError('Recovery requires the original container running and unpaused.')
    label = (container['Config'].get('Labels') or {}).get('codex-web.bundle', '')
    owner = Path(label)
    if not label or not owner.is_absolute() or owner == Path('/'):
        raise ValueError('Container has no valid original bundle path.')
    owner = owner.resolve()
    for name in ('data', 'workspace'):
        matches = [mount for mount in container['Mounts'] if mount['Destination'] == '/' + name]
        if len(matches) != 1 or matches[0]['Type'] != 'bind' or Path(matches[0]['Source']).resolve() != owner / name:
            raise ValueError('Unexpected container mount for /' + name + '; inspect before migrating.')
    live = Path('/proc') / str(state['Pid']) / 'root'
    for name in ('data', 'workspace'):
        if not (live / name).is_dir() or (live / name).is_symlink():
            raise ValueError('Cannot access live /' + name + ' through the host /proc. Keep the container running.')
    if not (live / 'data/codex').is_dir():
        raise ValueError('The live /data/codex directory is missing too. Files may have been deleted, not just moved. Keep the container running for manual recovery.')
    env = dict(entry.split('=', 1) for entry in container['Config'].get('Env', []) if '=' in entry)
    credentials = {}
    for key in ('CODEX_WEB_USERNAME', 'CODEX_WEB_PASSWORD'):
        value = env.get(key, 'admin' if key == 'CODEX_WEB_USERNAME' else '')
        if not value or '\n' in value or '\r' in value:
            raise ValueError('Cannot recover a valid ' + key + ' from the running container.')
        credentials[key] = value
    owner.mkdir(mode=0o700, parents=True, exist_ok=True)
    snapshot = Path(tempfile.mkdtemp(prefix='.codex-recovery-', dir=str(owner)))
    print('Private recovery snapshot: ' + str(snapshot), flush=True)
    paused = False
    try:
        run('docker', 'pause', container['Id'])
        paused = True
        for name in ('data', 'workspace'):
            copy_verified(live / name, snapshot / name)
            print('Verified snapshot of /' + name, flush=True)
        for name in ('data', 'workspace'):
            target = owner / name
            if os.path.lexists(str(target)):
                target.rename(snapshot / ('previous-' + name))
            copy_verified(snapshot / name, target)
        # Restore launcher assets, without overwriting any recovered data.
        for name in ('codex-web.sh', 'IMAGE_ID', 'image-linux-amd64.tar.gz', 'proxy'):
            target = owner / name
            if source / name == target:
                continue
            if os.path.lexists(str(target)):
                target.rename(snapshot / ('previous-' + name))
            run('cp', '-a', '--', str(source / name), str(target))
        web_env = owner / 'web.env'
        if os.path.lexists(str(web_env)):
            web_env.rename(snapshot / 'previous-web.env')
        with web_env.open('x') as stream:
            os.chmod(str(web_env), 0o600)
            for key, value in credentials.items():
                stream.write(key + '=' + value + '\n')
            stream.write('BIND_ADDRESS=127.0.0.1\nWEB_PORT=18765\n')
    except BaseException:
        print('Recovery incomplete; the original container has not been stopped. Snapshot: ' + str(snapshot), file=sys.stderr)
        raise
    finally:
        if paused:
            run('docker', 'unpause', container['Id'])
    # Only stop after both copies have been verified and credentials restored.
    run('docker', 'stop', container['Id'])
    print('Recovered bundle: ' + str(owner) + '. Starting httpd setup.', flush=True)
    run(sys.executable, str(owner / 'proxy/setup-httpd.py'), '--bundle', str(owner))
    print('Recovery complete. Keep the snapshot until you have checked your saved sessions and files.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--bundle', type=Path, required=True)
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('Run as root on the Linux Docker host.')
    os.umask(0o077)
    try:
        recover(args.bundle.resolve(strict=True))
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        sys.exit('Recovery failed: ' + str(error))
