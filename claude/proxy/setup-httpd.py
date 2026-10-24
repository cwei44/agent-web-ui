#!/usr/bin/env python3
"""Connect a portable Claude container to an existing systemd httpd service.

Run as root with --bundle /path/to/claude-web-portable. The running httpd
service supplies its configuration path. Use --site HOSTNAME when several
port-80 sites exist, or --config to select an active file explicitly.
Use --dry-run to preview changes without modifying files or services.
Requires Docker, Python 3, httpd and systemctl. Does not change Listen/TLS.
"""
import argparse
import difflib
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tempfile

BEGIN = '# BEGIN CLAUDE WEB CONTAINER'
END = '# END CLAUDE WEB CONTAINER'
ROUTE = r'/claude(?:/|(?=[\s$"\'>]|$))'


def run(*command, capture=False, env=None):
    return subprocess.run(command, check=True, universal_newlines=True,
                          stdout=subprocess.PIPE if capture else None,
                          stderr=subprocess.STDOUT if capture else None, env=env)


def running_httpd():
    pid = int(run('systemctl', 'show', 'httpd.service', '--property=MainPID', '--value', capture=True).stdout.strip())
    if pid <= 0:
        raise ValueError('httpd.service is not running.')
    process = Path('/proc') / str(pid)
    arguments = (process / 'cmdline').read_bytes().decode().rstrip('\0').split('\0')[1:]
    command = [str((process / 'exe').resolve(strict=True))]
    index = 0
    while index < len(arguments):
        arg = arguments[index]
        if arg[:2] in ('-f', '-d', '-D'):
            command.append(arg)
            if len(arg) == 2:
                index += 1
                command.append(arguments[index])
        elif arg == '-k':
            index += 1  # Do not replay start/restart when querying configuration.
        elif arg[:2] in ('-C', '-c'):
            raise ValueError('Inline -C/-c Apache configuration requires manual setup.')
        elif arg not in ('-X', '-DFOREGROUND') and not arg.startswith('-k'):
            raise ValueError('Unsupported running httpd argument: ' + arg)
        index += 1
    environment = os.environ.copy()
    for entry in (process / 'environ').read_bytes().split(b'\0'):
        if b'=' in entry:
            key, value = os.fsdecode(entry).split('=', 1)
            environment[key] = value
    return command, environment


def active_text(text):
    return '\n'.join(line for line in text.splitlines() if not line.lstrip().startswith('#'))


def discover(included, dump, config=None, site=None):
    # Use Apache's evaluated vhost dump, so disabled IfDefine blocks are ignored.
    hosts = []
    for line in dump.splitlines():
        match = re.search(r'(?:\S+:80\s+|port 80 namevhost\s+)(\S+)\s+\((.+):(\d+)\)', line)
        if match:
            entry = (Path(match[2]).resolve(), int(match[3]), match[1])
            if entry not in hosts:
                hosts.append(entry)
    candidates = [host for host in hosts if (config is None or host[0] == config)
                  and (site is None or host[2] == site)]
    if len(candidates) == 1:
        return candidates[0][:2]
    if hosts or site:
        choices = '\n'.join('  --site {}  ({}:{})'.format(name, path, line) for path, line, name in hosts)
        raise ValueError('Select one port-80 site with --site and/or --config:\n' + choices)
    if re.search(r'namevhost|\([^\n]+:\d+\)', dump):
        raise ValueError('Virtual hosts exist but none use port 80; configure an HTTP site first.')
    existing = [path for path in included if re.search(ROUTE, active_text(path.read_text()))]
    if config:
        return config, None
    if len(existing) > 1:
        raise ValueError('Multiple existing /claude config files; select and resolve them explicitly: ' + ', '.join(map(str, existing)))
    return (existing[0] if existing else included[0]), None


def configure(original, snippet, vhost_line=None):
    insertion = None
    if vhost_line is not None:
        lines = original.splitlines(keepends=True)
        if not 1 <= vhost_line <= len(lines) or not re.match(r'\s*<VirtualHost\b', lines[vhost_line - 1], re.I):
            raise ValueError('Apache vhost location does not match the file; inspect configuration manually.')
        insertion = sum(map(len, lines[:vhost_line]))
    if original.count(BEGIN) != original.count(END) or original.count(BEGIN) > 1:
        raise ValueError('Malformed or duplicate Claude configuration markers.')
    if BEGIN in original:
        pattern = re.escape(BEGIN) + r'.*?' + re.escape(END) + r'\n?'
        # Replace in place on repeat runs, without moving the block to another site.
        original, count = re.subn(pattern, lambda _: BEGIN + '\n' + snippet.rstrip() + '\n' + END + '\n', original, flags=re.S)
        if count != 1:
            raise ValueError('Malformed Claude configuration markers.')
        if insertion is not None:
            end = re.search(r'</VirtualHost\s*>', original[insertion:], re.I)
            marker = original.index(BEGIN)
            if not end or not insertion <= marker < insertion + end.start():
                raise ValueError('Managed Claude route belongs to a different virtual host.')
        return original
    active = active_text(original)
    if re.search(ROUTE, active):
        raise ValueError('Existing /claude configuration found; replace it explicitly first.')
    hosts = list(re.finditer(r'^[ \t]*<VirtualHost\s+([^>]+)>[^\n]*\n', original, re.M | re.I))
    matches = [host for host in hosts
               if any(address.endswith(':80') for address in host.group(1).split())]
    block = BEGIN + '\n' + snippet.rstrip() + '\n' + END + '\n'
    if insertion is not None:
        return original[:insertion] + block + original[insertion:]
    if hosts:
        if len(matches) != 1:
            raise ValueError('Select a config file with exactly one port-80 VirtualHost.')
        index = matches[0].end()
        return original[:index] + block + original[index:]
    if re.search(r'<\s*/?VirtualHost\b', active, re.I):
        raise ValueError('Unsupported VirtualHost formatting; use a conventional multiline block.')
    return original.rstrip('\n') + '\n' + block


def update_existing(original, port):
    """Migrate only the known localhost Claude proxy, preserving its other settings."""
    if re.search(r'<\s*/?VirtualHost\b', active_text(original), re.I):
        raise ValueError('An unmanaged Claude route inside a virtual host needs manual migration.')
    updated = original
    for directive in ('ProxyPass', 'ProxyPassReverse'):
        pattern = r'(^[ \t]*' + directive + r'\s+/claude/\s+)http://(?:127\.0\.0\.1|localhost):\d+/claude/(?=\s|$)'
        updated, count = re.subn(pattern, lambda match: match[1] + 'http://127.0.0.1:' + str(port) + '/claude/', updated, flags=re.M | re.I)
        if count != 1:
            raise ValueError('Unrecognized existing /claude proxy; migrate this route manually.')
    return updated


def module_config(missing, included, run_config):
    match = re.search(r'^ServerRoot: "([^"]+)"', run_config, re.M)
    if not match:
        raise ValueError('Cannot determine Apache ServerRoot to locate module files.')
    server_root = Path(match[1])
    directories = [server_root / 'modules']
    for config in included:
        for match in re.finditer(r'^\s*LoadModule\s+\S+\s+"?([^"\s]+)', active_text(config.read_text()), re.M | re.I):
            directories.append((server_root / match[1]).parent)
    directories += [Path(path) for path in ('/usr/lib/httpd/modules', '/usr/lib64/httpd/modules', '/usr/lib/apache2/modules')]
    lines = ['# Modules required by Claude web proxy']
    for name in missing:
        filename = 'mod_' + name[:-len('_module')] + '.so'
        module = next((directory / filename for directory in directories if (directory / filename).is_file()), None)
        if module is None:
            raise ValueError('Apache module file not installed: ' + filename + '. Install it using your distribution package manager, then rerun setup.')
        lines += ['<IfModule !' + name + '>', '    LoadModule ' + name + ' "' + str(module.resolve()) + '"', '</IfModule>']
    return '\n'.join(lines) + '\n'


def check_container_folder(bundle):
    existing = run('docker', 'container', 'ls', '-a', '--filter',
                   'name=^/claude-web-portable$', '--format', '{{.ID}}', capture=True).stdout.strip()
    if not existing:
        return
    owner = run('docker', 'container', 'inspect', '--format',
                '{{index .Config.Labels "claude-web.bundle"}}', 'claude-web-portable', capture=True).stdout.strip()
    if owner != str(bundle):
        if not owner or owner == '<no value>':
            raise ValueError('The existing claude-web-portable container has no bundle label. Inspect its mounts before replacing it; nothing was changed.')
        raise ValueError('The existing container belongs to ' + owner + '. Nothing was changed. '
                         'To reuse its saved data, rerun with --bundle ' + shlex.quote(owner) +
                         '. If that folder no longer exists, inspect the container mounts before migrating it.')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--config', type=Path, help='Override automatic selection with an active config file')
    parser.add_argument('--site', help='ServerName of the port-80 virtual host to update')
    parser.add_argument('--dry-run', action='store_true', help='Show the selected file and diff; make no changes')
    parser.add_argument('--port', type=int, default=18766, help='Private localhost backend port (default: 18766)')
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('Run with sudo/root to update httpd configuration and reload the service.')
    if not 1 <= args.port <= 65535 or args.port in (80, 443):
        parser.error('Choose a backend port from 1-65535 other than 80 or 443.')
    bundle = args.bundle.resolve()
    selected = args.config.resolve(strict=True) if args.config else None
    launcher = str(bundle / 'claude-web.sh')
    for command in ('systemctl', 'docker'):
        if not shutil.which(command):
            parser.error('Required command not found: ' + command)
    if not os.access(launcher, os.X_OK):
        parser.error('Bundle must contain executable claude-web.sh from the Claude Web portable release.')
    snippet = run(str(bundle / 'proxy/render.sh'), 'apache', str(args.port), capture=True).stdout
    run('systemctl', 'is-active', '--quiet', 'httpd.service')
    httpd, environment = running_httpd()
    def apache(*arguments, capture=False):
        return run(*httpd, *arguments, capture=capture, env=environment)
    apache('-t')
    modules = apache('-M', capture=True).stdout
    missing = [name for name in ('proxy_module', 'proxy_http_module', 'alias_module', 'env_module')
               if not re.search(r'\b' + name + r'\b', modules)]
    includes = apache('-t', '-D', 'DUMP_INCLUDES', capture=True).stdout
    included = list(dict.fromkeys(Path(match[1]).resolve() for match in
                    re.finditer(r'^\s*\([^)]*\) (.+)$', includes, re.M)))
    if not included:
        raise ValueError('Apache did not report its active configuration files.')
    if selected and selected not in included:
        raise ValueError('Selected config is not listed in httpd DUMP_INCLUDES; use an active file.')
    config, line = discover(included, apache('-t', '-D', 'DUMP_VHOSTS', capture=True).stdout, selected, args.site)
    original = config.read_text()
    if BEGIN not in original and re.search(ROUTE, active_text(original)) and line is None:
        updated = update_existing(original, args.port)
    else:
        updated = configure(original, snippet, line)
    for other in included:
        if other == config:
            continue
        active = active_text(other.read_text())
        if re.search(ROUTE, active):
            raise ValueError('Existing /claude route in ' + str(other) + '; resolve it before setup.')
    print('Selected Apache configuration: ' + str(config), flush=True)
    changes = {config: updated}
    if missing:
        main_config = included[0]
        load = module_config(missing, included, apache('-t', '-D', 'DUMP_RUN_CFG', capture=True).stdout)
        changes[main_config] = load + changes.get(main_config, main_config.read_text())
        print('Enabling installed Apache modules: ' + ', '.join(missing), flush=True)
    if args.dry_run:
        for path, content in changes.items():
            print(''.join(difflib.unified_diff(path.read_text().splitlines(True), content.splitlines(True),
                                             fromfile=str(path), tofile=str(path) + ' (proposed)')))
        print('Dry run: no files, containers or services changed.')
        return
    run('docker', 'info', capture=True)
    check_container_folder(bundle)
    backups = {}
    for path in changes:
        fd, backup = tempfile.mkstemp(prefix=path.name + '.claude-backup-', dir=str(path.parent))
        os.close(fd)
        shutil.copy2(str(path), backup)
        backups[path] = backup
        print('Apache backup: ' + backup, flush=True)
    reload_attempted = False
    try:
        # Write in place to retain ownership, permissions and SELinux attributes.
        for path, content in changes.items():
            path.write_text(content)
        apache('-t')
        run(launcher, 'stop')
        run(launcher, 'proxy-setup', str(args.port))
        run(launcher, 'start')
        reload_attempted = True
        run('systemctl', 'reload', 'httpd.service')
    except BaseException:
        for path, backup in backups.items():
            shutil.copyfile(backup, str(path))
        print('Restored Apache configuration. Container changes are not rolled back.', file=sys.stderr)
        if reload_attempted:
            subprocess.run(['systemctl', 'reload', 'httpd.service'])
        raise
    print('Ready: open http://<your-server-ip>/claude/ on the selected site.')
    print('Web credentials: ' + str(bundle / 'web.env'))
    print('If Claude needs sign-in, run: sudo bash ' + repr(launcher) + ' login')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        sys.exit('Setup failed: ' + str(error))
