"""Recovery tests; --integration also uses an isolated disposable Docker container."""
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr
from unittest.mock import patch

integration = '--integration' in sys.argv
if integration:
    sys.argv.remove('--integration')
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('recovery', str(Path(__file__).resolve().parents[1] / 'proxy/recover-running-bundle.py'))
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)


def assets(source):
    (source / 'proxy').mkdir(parents=True)
    for name in ('claude-web.sh', 'IMAGE_ID', 'image-linux-amd64.tar.gz', 'proxy/render.sh',
                 'proxy/apache.conf.template', 'proxy/setup-httpd.py'):
        (source / name).write_text('fixture\n')


def data(root):
    (root / 'data/claude').mkdir(parents=True)
    (root / 'data/claude/auth.json').write_text('saved login fixture')
    (root / 'data/conversation.json').write_text('saved history fixture')
    (root / 'workspace/empty').mkdir(parents=True)
    (root / 'workspace/project.txt').write_text('project data')
    (root / 'workspace/project.txt').chmod(0o640)
    (root / 'workspace/link').symlink_to('project.txt')


class RecoveryTests(unittest.TestCase):
    def exercise(self, corrupt=False, bad_credentials=False, paused=False, deleted=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, owner = root / 'copied', root / 'original'
            assets(source)
            live = root / 'proc/123/root'
            data(live)
            if deleted:
                (live / 'data/claude').rename(root / 'removed-claude-fixture')
            before = recovery.fingerprint(live)
            container = {'Id': 'fixture-id', 'State': {'Running': True, 'Paused': paused, 'Pid': 123},
                         'Config': {'Labels': {'claude-web.bundle': str(owner)},
                                    'Env': ['CLAUDE_WEB_USERNAME=alice', 'CLAUDE_WEB_PASSWORD=fixture-secret']},
                         'Mounts': [{'Type': 'bind', 'Source': str(owner / name), 'Destination': '/' + name} for name in ('data', 'workspace')]}
            if bad_credentials:
                container['Config']['Env'] = []
            calls = []
            real_run = recovery.run
            def invoke(*command, capture=False):
                calls.append(command)
                if command[:2] == ('docker', 'inspect'):
                    return subprocess.CompletedProcess(command, 0, stdout=json.dumps([container]))
                if command[0] == 'cp':
                    result = real_run(*command, capture=capture)
                    if corrupt and command[-1].endswith('/workspace'):
                        (Path(command[-1]) / 'project.txt').write_text('corrupted copy')
                    return result
                return subprocess.CompletedProcess(command, 0)
            with patch.object(recovery, 'run', side_effect=invoke), \
                 patch.object(recovery, 'Path', side_effect=lambda value: root / 'proc' if value == '/proc' else Path(value)), \
                 redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                if corrupt or bad_credentials or paused or deleted:
                    with self.assertRaises(ValueError):
                        recovery.recover(source)
                    self.assertFalse(any(c[:2] == ('docker', 'stop') for c in calls))
                    self.assertFalse(any(c[0] == sys.executable for c in calls))
                    if corrupt:
                        self.assertIn(('docker', 'unpause', 'fixture-id'), calls)
                    else:
                        self.assertFalse(any(c[:2] == ('docker', 'pause') for c in calls))
                else:
                    recovery.recover(source)
                    for name in ('data', 'workspace'):
                        self.assertEqual(recovery.fingerprint(owner / name), recovery.fingerprint(live / name))
                    self.assertIn('CLAUDE_WEB_PASSWORD=fixture-secret', (owner / 'web.env').read_text())
                    self.assertEqual((owner / 'web.env').stat().st_mode & 0o777, 0o600)
                    self.assertLess(calls.index(('docker', 'unpause', 'fixture-id')), calls.index(('docker', 'stop', 'fixture-id')))
                    self.assertEqual(calls[-1], (sys.executable, str(owner / 'proxy/setup-httpd.py'), '--bundle', str(owner)))
                    snapshot = next(owner.glob('.claude-recovery-*'))
                    self.assertTrue((snapshot / 'data/claude/auth.json').is_file())
            self.assertEqual(recovery.fingerprint(live), before)

    def test_success(self):
        self.exercise()

    def test_bad_copy_resumes_original(self):
        self.exercise(corrupt=True)

    def test_missing_credentials_does_not_pause(self):
        self.exercise(bad_credentials=True)

    def test_already_paused_does_not_change_container(self):
        self.exercise(paused=True)

    def test_deleted_live_data_does_not_stop_container(self):
        self.exercise(deleted=True)

    @unittest.skipUnless(integration, 'use --integration for real Docker namespace test')
    def test_real_missing_bind_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, owner = root / 'copied', root / 'original'
            assets(source)
            data(owner)
            container_id = subprocess.check_output(['docker', 'run', '-d', '--label', 'claude-web.bundle=' + str(owner),
                '-e', 'CLAUDE_WEB_USERNAME=fixture', '-e', 'CLAUDE_WEB_PASSWORD=fixture-secret',
                '-v', str(owner / 'data') + ':/data', '-v', str(owner / 'workspace') + ':/workspace',
                'claude-web:1.3.0', 'sh', '-c', 'sleep 600'], universal_newlines=True).strip()
            try:
                owner.rename(root / 'hidden-original-mounts')
                real_run = recovery.run
                setups = []
                def invoke(*command, capture=False):
                    if command[:2] == ('docker', 'inspect'):
                        return real_run('docker', 'inspect', container_id, capture=capture)
                    if command[0] == sys.executable:
                        setups.append(command)
                        return subprocess.CompletedProcess(command, 0)
                    return real_run(*command, capture=capture)
                with patch.object(recovery, 'run', side_effect=invoke):
                    recovery.recover(source)
                for name in ('data', 'workspace'):
                    self.assertEqual(recovery.fingerprint(owner / name), recovery.fingerprint(root / 'hidden-original-mounts' / name))
                self.assertEqual(len(setups), 1)
                status = subprocess.check_output(['docker', 'inspect', '--format', '{{.State.Running}}', container_id], universal_newlines=True).strip()
                self.assertEqual(status, 'false')
            finally:
                subprocess.run(['docker', 'rm', '-f', '-v', container_id], check=True, stdout=subprocess.DEVNULL)


if __name__ == '__main__':
    unittest.main()
