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

    def minimal_release(self, root):
        for name in release.CORE + release.PUBLIC:
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'synthetic\n')
        release.refresh(root)

    def test_git_metadata_pruned_without_reading_or_following(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.minimal_release(root)
            metadata = root / '.git'
            metadata.mkdir()
            (metadata / 'private.db').write_bytes(b'not utf8: \xff')
            (metadata / 'config').write_text('private synthetic metadata', encoding='utf-8')
            self.assertGreater(release.verify(root), 0)
            with tempfile.TemporaryDirectory() as outside:
                (metadata / 'private.db').unlink()
                (metadata / 'config').unlink()
                metadata.rmdir()
                try:
                    metadata.symlink_to(outside, target_is_directory=True)
                except OSError:
                    return  # Directory case above always runs on Windows.
                self.assertGreater(release.verify(root), 0)

    def test_worktree_git_file_is_ignored(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.minimal_release(root)
            (root / '.git').write_bytes(b'private metadata: \xff')
            self.assertGreater(release.verify(root), 0)

    def test_dirty_source_requires_explicit_refresh_not_git_cleanliness(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.minimal_release(root)
            (root / '.git').mkdir()
            (root / 'README.md').write_bytes(b'reviewed edit\n')
            with self.assertRaisesRegex(ValueError, 'manifest mismatch'):
                release.verify(root)
            release.refresh(root)
            self.assertNotIn(b'\r\n', (root / release.MANIFEST).read_bytes())
            self.assertGreater(release.verify(root), 0)
            (root / '__pycache__').mkdir()
            with self.assertRaisesRegex(ValueError, 'forbidden release directory'):
                release.inventory(root)

    def test_git_attributes_preserve_lf_manifest_bytes(self):
        attrs = (ROOT / '.gitattributes').read_bytes()
        self.assertIn(b'* text=auto eol=lf\n', attrs)
        self.assertNotIn(b'\r\n', attrs)

    def test_private_and_unlisted_paths_rejected(self):
        for name in ('private-data/fixture.json', '.mcp.json', '.env', 'cookies.json', 'unexpected.txt'):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b'{}')
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
