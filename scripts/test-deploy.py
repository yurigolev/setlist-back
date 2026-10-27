"""Exercise deployment transactions with synthetic env and mocked Docker/SSH targets."""
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('deploy.sh').read_text()
FRONT = 'a' * 40
BACK = 'b' * 40
RELEASE = 'c' * 40
BASE = (
    f'FRONTEND_IMAGE=ghcr.io/yurigolev/setlist-front-pwa:{FRONT}\n'
    f'BACKEND_IMAGE=ghcr.io/yurigolev/setlist-back:{BACK}\n'
    'APP_DOMAIN=example.invalid\nPWA_ORIGIN=https://example.invalid\n'
    'POSTGRES_USER=test\nPOSTGRES_PASSWORD=synthetic\nPOSTGRES_DB=test\n'
    'MINIO_BUCKET=test\nYANDEX_CLIENT_SECRET=synthetic\n'
)
MOCK = '''#!/usr/bin/env python3
import json, os, pathlib, sys
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
root = pathlib.Path(os.environ['TEST_ROOT'])
with (root / 'calls').open('a') as f:
    f.write(json.dumps([name, args]) + '\\n')
mode = os.environ.get('FAIL_MODE')
fail = (name == 'docker' and ((mode == 'config' and 'config' in args) or
    (mode == 'pull' and args[0] == 'pull') or (mode == 'preflight' and 'run' in args)))
fail |= name == 'backup' and mode == 'backup'
if mode == 'health' and name == 'curl': fail = True
if mode == 'up' and name == 'docker' and 'up' in args and not (root / 'failed').exists():
    (root / 'failed').touch()
    fail = True
sys.exit(1 if fail else 0)
'''


class DeployTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env_file = self.root / '.env.production'
        self.env_file.write_text(BASE)
        self.env_file.chmod(0o600)
        binary = self.root / 'bin'
        binary.mkdir()
        for name in ('docker', 'curl', 'flock', 'backup'):
            path = binary / name
            path.write_text(MOCK)
            path.chmod(0o755)
        script = SCRIPT.replace('/opt/setlist', str(self.root))
        script = script.replace('/usr/local/sbin/setlist-backup', str(binary / 'backup'))
        script = script.replace('[[ $EUID == 0 ]]', 'true')
        self.script = self.root / 'deploy.sh'
        self.script.write_text(script)
        self.env = {**os.environ, 'PATH': f'{binary}:{os.environ["PATH"]}', 'TEST_ROOT': str(self.root)}

    def run_deploy(self, content=BASE, component='frontend', fail=''):
        return subprocess.run(
            ['bash', str(self.script), component, RELEASE, '--env-stdin'],
            input=content, text=True, capture_output=True,
            env={**self.env, 'FAIL_MODE': fail},
        )

    def calls(self):
        path = self.root / 'calls'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def test_same_settings_preserve_other_image_and_skip_backup(self):
        incoming = '\n'.join(line for line in BASE.splitlines() if not line.startswith(('FRONTEND_IMAGE=', 'BACKEND_IMAGE=')))
        result = self.run_deploy(incoming)
        self.assertEqual(result.returncode, 0, result.stderr)
        current = self.env_file.read_text()
        self.assertIn(f'BACKEND_IMAGE=ghcr.io/yurigolev/setlist-back:{BACK}', current)
        self.assertIn(f'FRONTEND_IMAGE=ghcr.io/yurigolev/setlist-front-pwa:{RELEASE}', current)
        self.assertFalse(any(name == 'backup' for name, _ in self.calls()))
        self.assertEqual(stat.S_IMODE(self.env_file.stat().st_mode), 0o600)
        self.assertEqual(list(self.root.glob('.env.*.??????')), [])

    def test_changed_settings_backup_and_apply_all_services(self):
        result = self.run_deploy(BASE.replace('YANDEX_CLIENT_SECRET=synthetic', 'YANDEX_CLIENT_SECRET=new-synthetic'))
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls()
        self.assertTrue(any(name == 'backup' for name, _ in calls))
        up = next(args for name, args in calls if name == 'docker' and 'up' in args)
        self.assertEqual(up[-5:], ['postgres', 'minio', 'api', 'frontend', 'caddy'])
        self.assertNotIn('new-synthetic', result.stdout + result.stderr)

    def test_rejected_env_never_changes_live_file(self):
        for content in ('', BASE + 'COMPOSE_FILE=evil.yml\n', BASE + 'APP_DOMAIN=duplicate\n',
                        BASE.replace('POSTGRES_PASSWORD=synthetic', 'POSTGRES_PASSWORD=changed'),
                        BASE.replace('MINIO_BUCKET=test', 'MINIO_BUCKET=other')):
            with self.subTest(content=content):
                result = self.run_deploy(content)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.env_file.read_text(), BASE)

    def test_precommit_failures_preserve_live_env(self):
        for fail in ('config', 'pull', 'preflight', 'backup'):
            with self.subTest(fail=fail):
                result = self.run_deploy(BASE + 'MAX_MP3_BYTES=1024\n', fail=fail)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.env_file.read_text(), BASE)

    def test_failed_replacement_or_health_restores_entire_env(self):
        for fail in ('up', 'health'):
            with self.subTest(fail=fail):
                result = self.run_deploy(BASE + 'MAX_MP3_BYTES=1024\n', fail=fail)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.env_file.read_text(), BASE)
                self.assertIn('restoring previous environment', result.stderr)

    def test_backend_always_preflights_and_backs_up(self):
        result = self.run_deploy(component='backend')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(any(name == 'backup' for name, _ in self.calls()))
        self.assertIn(f'FRONTEND_IMAGE=ghcr.io/yurigolev/setlist-front-pwa:{FRONT}', self.env_file.read_text())

    def test_dotenv_never_executes_shell(self):
        marker = self.root / 'must-not-exist'
        result = self.run_deploy(BASE.replace('YANDEX_CLIENT_SECRET=synthetic', f'YANDEX_CLIENT_SECRET=$(touch {marker})'))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(marker.exists())

    def test_manual_rollback_without_env_stdin(self):
        result = subprocess.run(['bash', str(self.script), 'frontend', RELEASE],
                                text=True, capture_output=True, env=self.env)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
