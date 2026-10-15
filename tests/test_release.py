"""Offline release safety checks. All payload fixtures are synthetic."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('release', ROOT / 'scripts/release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def test_manifest_matches_exact_allowlist(self):
        self.assertGreater(release.verify(), 0)

    def test_private_and_unlisted_paths_rejected(self):
        for name in ('private-data/fixture.json', '.mcp.json', '.env', 'cookies.json', 'unexpected.txt'):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('{}', encoding='utf-8')
                with self.assertRaises(ValueError):
                    release.inventory(root)

    def test_machine_paths_and_secret_payloads_rejected(self):
        values = ('C:' + '/' + 'Users' + '/example/file', 'sk-ant-' + 'x' * 30,
                  '-----BEGIN ' + 'PRIVATE KEY-----')
        for value in values:
            with self.subTest(value=value), self.assertRaises(ValueError):
                release.check_payload('README.md', value.encode())

    def test_dummy_fixture_tokens_and_field_names_are_allowed(self):
        release.check_payload('tests/fixture.py', b'api_key = "not-a-real-key"; token = "test-only-token"')
        release.check_payload('integrations/commerce-browser-mcp/.env.example', b'COMMERCE_BRIDGE_TOKEN=\n')

    def test_linked_files_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / 'target'
            target.write_text('synthetic', encoding='utf-8')
            try:
                (root / 'README.md').symlink_to(target)
            except OSError:
                self.skipTest('symlink creation not permitted by this platform')
            with self.assertRaises(ValueError):
                release.inventory(root)


if __name__ == '__main__':
    unittest.main()
