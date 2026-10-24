"""Isolated installer tests; never runs Docker or changes the host httpd."""
import contextlib
import importlib.util
import io
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('setup_httpd', str(Path(__file__).resolve().parents[1] / 'proxy/setup-httpd.py'))
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)
SNIPPET = 'ProxyPass /claude/ http://127.0.0.1:18766/claude/\n'
ORIGINAL = '<VirtualHost *:80>\nServerName example.test\nProxyPass / http://127.0.0.1:9000/\n</VirtualHost>\n'


class SetupTests(unittest.TestCase):
    def test_preserve_site_and_repeat(self):
        updated = setup.configure(ORIGINAL, SNIPPET)
        self.assertEqual(setup.configure(updated, SNIPPET), updated)
        self.assertLess(updated.index('ProxyPass /claude/'), updated.index('ProxyPass / '))
        self.assertEqual(updated.replace(setup.BEGIN + '\n' + SNIPPET + setup.END + '\n', ''), ORIGINAL)
        main = setup.configure('Listen 80\n', SNIPPET)
        self.assertEqual(setup.configure(main, SNIPPET), main)

    def test_refuse_ambiguous_or_existing_routes(self):
        for config in (ORIGINAL * 2, ORIGINAL.replace(':80', ':443'),
                       ORIGINAL + SNIPPET, setup.BEGIN + '\n',
                       setup.END + '\n' + setup.BEGIN):
            with self.assertRaises(ValueError):
                setup.configure(config, SNIPPET)

    def exercise(self, failure=None, conflict=False, auto=False, dry_run=False, missing_modules=False, foreign_container=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / 'site.conf'
            config.write_text(ORIGINAL)
            launcher = root / 'claude-web.sh'
            launcher.write_text('#!/bin/bash\n')
            launcher.chmod(0o700)
            other = root / 'other.conf'
            other.write_text(SNIPPET if conflict else '# unrelated site\n')
            main = root / 'httpd.conf'
            main.write_text('Listen 80\n')
            (root / 'modules').mkdir()
            for name in ('mod_proxy.so', 'mod_proxy_http.so'):
                (root / 'modules' / name).touch()
            calls = []
            def fake_run(*command, capture=False, env=None):
                calls.append(command)
                if failure == 'validation' and command == ('httpd', '-t') and calls.count(command) == 2:
                    raise subprocess.CalledProcessError(1, command)
                if failure == 'start' and command[-1] == 'start':
                    raise subprocess.CalledProcessError(1, command)
                if failure == 'reload' and command == ('systemctl', 'reload', 'httpd.service'):
                    raise subprocess.CalledProcessError(1, command)
                output = ''
                if command[0].endswith('render.sh'):
                    output = SNIPPET
                elif command == ('httpd', '-M'):
                    output = 'alias_module env_module' if missing_modules else 'proxy_module proxy_http_module alias_module env_module'
                elif 'DUMP_INCLUDES' in command:
                    output = '(*) ' + str(config) + '\n(12) ' + str(other) + '\n'
                    if missing_modules:
                        output = '(*) ' + str(main) + '\n' + output
                elif 'DUMP_VHOSTS' in command:
                    output = '*:80 example.test (' + str(config) + ':1)\n'
                elif 'DUMP_RUN_CFG' in command:
                    output = 'ServerRoot: "' + str(root) + '"\n'
                elif command[:3] == ('docker', 'container', 'ls') and foreign_container:
                    output = 'container-id\n'
                elif command[:3] == ('docker', 'container', 'inspect'):
                    output = '/original/claude-web-portable\n'
                return subprocess.CompletedProcess(command, 0, stdout=output)
            argv = ['setup-httpd.py', '--bundle', str(root), '--config', str(config)]
            if auto:
                argv = argv[:-2]
            if dry_run:
                argv.append('--dry-run')
            with patch.object(sys, 'argv', argv), patch.object(setup.os, 'geteuid', return_value=0), \
                 patch.object(setup.shutil, 'which', return_value='/mock/tool'), \
                 patch.object(setup, 'running_httpd', return_value=(['httpd'], {})), \
                 patch.object(setup, 'run', side_effect=fake_run), \
                 patch.object(setup.subprocess, 'run') as recovery, \
                 contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                if failure or conflict or foreign_container:
                    with self.assertRaises((ValueError, subprocess.CalledProcessError)):
                        setup.main()
                    self.assertEqual(config.read_text(), ORIGINAL)
                    self.assertEqual(main.read_text(), 'Listen 80\n')
                else:
                    setup.main()
                    if dry_run:
                        self.assertEqual(config.read_text(), ORIGINAL)
                        self.assertFalse(any(c[0] in (str(launcher), 'docker') for c in calls))
                        self.assertNotIn(('systemctl', 'reload', 'httpd.service'), calls)
                        self.assertFalse(list(root.glob('site.conf.claude-backup-*')))
                        self.assertEqual(main.read_text(), 'Listen 80\n')
                    else:
                        self.assertIn(SNIPPET, config.read_text())
                        self.assertEqual([c[-1] for c in calls if c[0] == str(launcher)], ['stop', '18766', 'start'])
                        self.assertIn(('systemctl', 'reload', 'httpd.service'), calls)
                        if missing_modules:
                            self.assertIn('LoadModule proxy_module', main.read_text())
                            self.assertIn('LoadModule proxy_http_module', main.read_text())
                if failure == 'validation' or conflict or foreign_container:
                    self.assertFalse(any(c[0] == str(launcher) for c in calls))
                if foreign_container:
                    self.assertFalse(list(root.glob('*.claude-backup-*')))
                    self.assertNotIn(('systemctl', 'reload', 'httpd.service'), calls)
                if failure == 'reload':
                    recovery.assert_called_once_with(['systemctl', 'reload', 'httpd.service'])
            if not conflict and not dry_run and not foreign_container:
                self.assertEqual(next(root.glob('site.conf.claude-backup-*')).read_text(), ORIGINAL)
                if missing_modules:
                    self.assertEqual(next(root.glob('httpd.conf.claude-backup-*')).read_text(), 'Listen 80\n')

    def test_success(self):
        self.exercise()

    def test_foreign_container_stops_before_config_changes(self):
        self.exercise(auto=True, missing_modules=True, foreign_container=True)

    def test_existing_container_ownership(self):
        for owner in ('/bundle', '', '<no value>', '/other bundle'):
            with patch.object(setup, 'run', side_effect=[subprocess.CompletedProcess([], 0, stdout='id'),
                                                       subprocess.CompletedProcess([], 0, stdout=owner)]):
                if owner == '/bundle':
                    setup.check_container_folder(Path('/bundle'))
                else:
                    with self.assertRaisesRegex(ValueError, 'existing'):
                        setup.check_container_folder(Path('/bundle'))

    def test_auto_success(self):
        self.exercise(auto=True)

    def test_auto_dry_run(self):
        self.exercise(auto=True, dry_run=True)

    def test_enable_missing_modules(self):
        self.exercise(auto=True, missing_modules=True)

    def test_missing_modules_dry_run(self):
        self.exercise(auto=True, missing_modules=True, dry_run=True)

    def test_missing_modules_validation_rollback(self):
        self.exercise(auto=True, missing_modules=True, failure='validation')

    def test_missing_modules_reload_rollback(self):
        self.exercise(auto=True, missing_modules=True, failure='reload')

    def test_uninstalled_module(self):
        with self.assertRaisesRegex(ValueError, 'not installed'):
            setup.module_config(['nonexistent_claude_test_module'], [], 'ServerRoot: "/tmp"\n')

    def test_validation_rollback(self):
        self.exercise(failure='validation')

    def test_container_failure_rollback(self):
        self.exercise(failure='start')

    def test_reload_failure_rollback(self):
        self.exercise(failure='reload')

    def test_route_in_another_include(self):
        self.exercise(conflict=True)

    def test_discovery_main_server_and_existing_include(self):
        with tempfile.TemporaryDirectory() as directory:
            main = Path(directory) / 'httpd.conf'
            proxy = Path(directory) / 'claude.conf'
            main.write_text('Listen 80\n')
            proxy.write_text('# placeholder\n')
            self.assertEqual(setup.discover([main, proxy], ''), (main, None))
            proxy.write_text(SNIPPET)
            self.assertEqual(setup.discover([main, proxy], ''), (proxy, None))

    def test_discovery_sites_and_shared_file(self):
        path = Path('/tmp/sites.conf')
        dump = '*:80 is a NameVirtualHost\n port 80 namevhost first.test (/tmp/sites.conf:1)\n port 80 namevhost second.test (/tmp/sites.conf:5)\n'
        with self.assertRaises(ValueError):
            setup.discover([path], dump)
        self.assertEqual(setup.discover([path], dump, site='second.test'), (path, 5))
        original = ORIGINAL + ORIGINAL.replace('example.test', 'second.test')
        updated = setup.configure(original, SNIPPET, 5)
        self.assertTrue(updated.startswith(ORIGINAL))
        self.assertEqual(setup.configure(updated, SNIPPET, 5), updated)
        with self.assertRaises(ValueError):
            setup.configure(updated, SNIPPET, 1)
        self.assertEqual(setup.discover([path], '*:80 first.test (/tmp/sites.conf:1)\n'), (path, 1))
        with self.assertRaises(ValueError):
            setup.discover([path], '*:443 first.test (/tmp/sites.conf:1)\n')

    def test_existing_proxy_migration(self):
        original = '# site\n' + SNIPPET + 'ProxyPassReverse /claude/ http://localhost:8766/claude/\n<Location /claude/>\nProxyPreserveHost On\n</Location>\n'
        updated = setup.update_existing(original, 18766)
        self.assertEqual(updated.count('http://127.0.0.1:18766/claude/'), 2)
        self.assertIn('<Location /claude/>\nProxyPreserveHost On\n</Location>', updated)
        self.assertEqual(setup.update_existing(updated, 18766), updated)
        with self.assertRaises(ValueError):
            setup.update_existing(original.replace('localhost', 'remote.example'), 18766)

    def test_running_process_options(self):
        with tempfile.TemporaryDirectory() as directory:
            process = Path(directory) / '123'
            process.mkdir()
            binary = Path(directory) / 'httpd'
            binary.touch()
            (process / 'exe').symlink_to(binary)
            (process / 'cmdline').write_bytes(b'httpd\0-f\0/custom/httpd.conf\0-d/custom\0-D\0CUSTOM\0-k\0start\0')
            (process / 'environ').write_bytes(b'APACHE_TEST=value\0')
            with patch.object(setup, 'run', return_value=subprocess.CompletedProcess([], 0, stdout='123\n')), \
                 patch.object(setup, 'Path', return_value=Path(directory)):
                command, env = setup.running_httpd()
                self.assertEqual(command, [str(binary), '-f', '/custom/httpd.conf', '-d/custom', '-D', 'CUSTOM'])
                self.assertEqual(env['APACHE_TEST'], 'value')
                (process / 'cmdline').write_bytes(b'httpd\0-C\0Listen 80\0')
                with self.assertRaises(ValueError):
                    setup.running_httpd()


if __name__ == '__main__':
    unittest.main()
