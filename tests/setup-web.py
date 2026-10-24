import errno
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('setup_web', Path(__file__).resolve().parent.parent / 'setup-web.py')
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.bundle = Path(self.temp.name)
        self.launcher = self.bundle / 'ai-web.sh'
        self.launcher.write_text('#!/bin/sh\n')
        self.launcher.chmod(0o755)
        (self.bundle / 'web.env').write_text('AI_WEB_PASSWORD=test-secret\nAI_WEB_PROVIDERS=claude\nWEB_PORT=8082\nBIND_ADDRESS=127.0.0.1\n')

    def invoke(self, active=False, container=None, busy=False, **kwargs):
        with patch.object(app, 'existing_container', return_value=container), \
             patch.object(app.shutil, 'which', return_value='/bin/systemctl' if active else None), \
             patch.object(app.subprocess, 'run', return_value=Mock(returncode=0)), \
             patch.object(app, 'check_port_80', side_effect=ValueError('Port 80 is already in use') if busy else None) as check, \
             patch.object(app, 'run') as run:
            app.setup(self.bundle, **kwargs)
            return run.call_args_list, check.call_count

    def test_fresh_direct_setup_preserves_credentials_and_provider(self):
        calls, checks = self.invoke()
        self.assertEqual(checks, 1)
        self.assertEqual([c[0] for c in calls], [(str(self.launcher), 'init'), (str(self.launcher), 'start')])
        text = (self.bundle / 'web.env').read_text()
        self.assertIn('AI_WEB_PASSWORD=test-secret', text)
        self.assertIn('AI_WEB_PROVIDERS=claude', text)
        self.assertIn('WEB_PORT=80\nBIND_ADDRESS=0.0.0.0', text)
        self.assertEqual(os.stat(str(self.bundle / 'web.env')).st_mode & 0o777, 0o600)

    def test_httpd_delegates_without_direct_port_change(self):
        before = (self.bundle / 'web.env').read_text()
        calls, checks = self.invoke(active=True, site='example.test', config='/etc/site.conf')
        self.assertEqual(checks, 0)
        self.assertEqual(calls[0][0], (app.sys.executable, str(self.bundle / 'proxy/setup-httpd.py'), '--bundle', str(self.bundle), '--site', 'example.test', '--config', '/etc/site.conf'))
        self.assertEqual((self.bundle / 'web.env').read_text(), before)

    def test_busy_port_leaves_configuration_untouched(self):
        before = (self.bundle / 'web.env').read_text()
        with self.assertRaisesRegex(ValueError, 'already in use'):
            self.invoke(busy=True)
        self.assertEqual((self.bundle / 'web.env').read_text(), before)

    def test_existing_direct_container_is_reused(self):
        container = {'HostConfig': {'PortBindings': {'8760/tcp': [{'HostIp': '0.0.0.0', 'HostPort': '80'}]}}}
        calls, checks = self.invoke(container=container)
        self.assertEqual(checks, 0)
        self.assertEqual(calls[-1][0], (str(self.launcher), 'start'))

    def test_existing_private_container_requires_stop(self):
        with self.assertRaisesRegex(ValueError, 'When work is idle'):
            self.invoke(container={'HostConfig': {'PortBindings': {'8760/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '18760'}]}}})

    def test_site_without_httpd_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'require an active'):
            self.invoke(site='example.test')

    def test_another_bundle_is_never_adopted(self):
        result = Mock(returncode=0, stdout=json.dumps([{'Config': {'Labels': {'ai-web.bundle': '/another/folder'}}}]))
        with patch.object(app.subprocess, 'run', return_value=result):
            with self.assertRaisesRegex(ValueError, 'another folder'):
                app.existing_container(self.bundle)

    def test_unlabelled_container_is_not_adopted(self):
        result = Mock(returncode=0, stdout=json.dumps([{'Config': {'Labels': None}}]))
        with patch.object(app.subprocess, 'run', return_value=result):
            with self.assertRaisesRegex(ValueError, 'another folder'):
                app.existing_container(self.bundle)

    def test_daemon_failure_is_not_treated_as_absent_container(self):
        with patch.object(app.subprocess, 'run', side_effect=[Mock(returncode=1), subprocess.CalledProcessError(1, 'docker info')]):
            with self.assertRaises(subprocess.CalledProcessError):
                app.existing_container(self.bundle)

    def test_ipv6_busy_is_detected_and_all_sockets_closed(self):
        ipv4, ipv6 = Mock(), Mock()
        ipv6.bind.side_effect = OSError(errno.EADDRINUSE, 'busy')
        with patch.object(app.socket, 'socket', side_effect=[ipv4, ipv6]):
            with self.assertRaisesRegex(ValueError, 'Port 80 is already in use'):
                app.check_port_80()
        ipv4.close.assert_called_once(); ipv6.close.assert_called_once()

    def test_disabled_ipv6_is_supported(self):
        ipv4 = Mock()
        with patch.object(app.socket, 'socket', side_effect=[ipv4, OSError(errno.EAFNOSUPPORT, 'disabled')]):
            app.check_port_80()
        ipv4.close.assert_called_once()

    def test_start_failure_is_reported(self):
        with patch.object(app, 'existing_container', return_value=None), patch.object(app.shutil, 'which', return_value=None), patch.object(app, 'check_port_80'), patch.object(app, 'run', side_effect=[None, subprocess.CalledProcessError(1, 'start')]):
            with self.assertRaises(subprocess.CalledProcessError):
                app.setup(self.bundle)


if __name__ == '__main__':
    unittest.main()
