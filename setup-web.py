#!/usr/bin/env python3
"""Reuse active httpd, or publish the bundled web server directly on port 80."""
import argparse
import errno
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile


def run(*args):
    return subprocess.run(list(args), check=True)


def existing_container(bundle):
    result = subprocess.run(['docker', 'container', 'inspect', 'ai-web-portable'],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
    if result.returncode:
        # Distinguish an absent container from an unavailable daemon.
        subprocess.run(['docker', 'info'], check=True, stdout=subprocess.DEVNULL)
        return None
    container = json.loads(result.stdout)[0]
    if (container['Config'].get('Labels') or {}).get('ai-web.bundle') != str(bundle):
        raise ValueError('The existing ai-web-portable container belongs to another folder; use its original bundle.')
    return container


def check_port_80():
    sockets = []
    try:
        for family, address in [(socket.AF_INET, ('0.0.0.0', 80)), (socket.AF_INET6, ('::', 80))]:
            try:
                sock = socket.socket(family, socket.SOCK_STREAM)
                sockets.append(sock)
                if family == socket.AF_INET6:
                    sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
                sock.bind(address)
            except OSError as error:
                if family == socket.AF_INET6 and error.errno in (errno.EAFNOSUPPORT, errno.EADDRNOTAVAIL):
                    continue
                if error.errno == errno.EADDRINUSE:
                    raise ValueError('Port 80 is already in use. No active httpd.service was detected. Configure that existing server with proxy/README.txt; it will not be stopped automatically.')
                raise
    finally:
        for sock in sockets:
            sock.close()


def direct_port_80(bundle):
    env = bundle / 'web.env'
    lines = [line for line in env.read_text().splitlines()
             if not line.startswith(('WEB_PORT=', 'BIND_ADDRESS='))]
    fd, temporary = tempfile.mkstemp(prefix='.web.env.', dir=str(bundle))
    try:
        with os.fdopen(fd, 'w') as file:
            file.write('\n'.join(lines + ['WEB_PORT=80', 'BIND_ADDRESS=0.0.0.0']) + '\n')
        os.replace(temporary, str(env))
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def setup(bundle, site=None, config=None):
    launcher = str(bundle / 'ai-web.sh')
    if not os.access(launcher, os.X_OK):
        raise ValueError('Bundle must contain executable ai-web.sh.')
    container = existing_container(bundle)
    active = bool(shutil.which('systemctl')) and subprocess.run(
        ['systemctl', 'is-active', '--quiet', 'httpd.service'],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    if active:
        print('Detected active httpd.service; configuring its existing site.', flush=True)
        args = [sys.executable, str(bundle / 'proxy/setup-httpd.py'), '--bundle', str(bundle)]
        if site:
            args += ['--site', site]
        if config:
            args += ['--config', config]
        run(*args)
        return
    if site or config:
        raise ValueError('--site and --config require an active httpd.service.')
    if container:
        bindings = (container.get('HostConfig', {}).get('PortBindings') or {}).get('8760/tcp') or []
        if not any(b['HostPort'] == '80' and b['HostIp'] in ('', '0.0.0.0') for b in bindings):
            raise ValueError('This bundle already has a container on another port. When work is idle, run ./ai-web.sh stop, then ./ai-web.sh setup.')
    else:
        check_port_80()
    print('Using the bundled web server directly on port 80; Apache is not required.', flush=True)
    run(launcher, 'init')
    direct_port_80(bundle)
    run(launcher, 'start')
    print('Open http://<server-ip>/ai/ . Web credentials are in web.env.', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--site', help='Existing Apache ServerName when multiple sites exist')
    parser.add_argument('--config', help='Existing active Apache configuration file')
    args = parser.parse_args()
    setup(args.bundle.resolve(), args.site, args.config)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        sys.exit('Setup failed: ' + str(error))
