"""Exact-allowlist release verifier and optional commerce importer. No repository-wide copy."""
import argparse
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
CORE = (
    'skills/outfit-me/SKILL.md',
    *('skills/outfit-me/references/' + n + '.md' for n in ('connectors', 'profile', 'styling', 'storage', 'orders', 'privacy')),
    'skills/outfit-me/scripts/store.py', 'skills/outfit-me/scripts/orders.py',
    'skills/outfit-me/schemas/records.schema.json', 'skills/outfit-me/evals/scenarios.json',
    'tests/test_store.py', 'tests/test_orders.py', 'docs/DESIGN.md',
)
PUBLIC = ('README.md', '.gitignore', 'THIRD_PARTY_NOTICES.md', 'docs/PRODUCT.md',
          'docs/INSTALL.md', 'config_examples/mcp-client.json', 'scripts/release.py', 'tests/test_release.py',
          'LICENSE', '.gitattributes', 'package.json', 'bin/setup.cjs', 'tests/setup.test.cjs', 'docs/SETUP.md')
COMMERCE = (
    'LICENSE', 'pyproject.toml', 'README.md', 'SECURITY.md', '.env.example', '.gitignore', 'server.py',
    *('jd_taobao_mcp/' + n + '.py' for n in ('__init__', 'browser', 'config', 'extension_bridge', 'safety', 'service')),
    *('jd_taobao_mcp/extractors/' + n + '.py' for n in ('__init__', 'detail', 'helpers', 'search')),
    *('chrome-extension/' + n for n in ('manifest.json', 'popup.html', 'popup.js', 'service-worker.js')),
    'config_examples/mcp-client.json', 'config_examples/codex-config.toml',
    'scripts/install_windows.ps1', 'scripts/start_windows.bat',
    *('tests/' + n for n in ('test_bridge_lifecycle.py', 'test_extension_mode.py', 'test_safety.py', 'extension-popup.test.cjs', 'extension-worker.test.cjs')),
)
PREFIX = 'integrations/commerce-browser-mcp/'
MANIFEST = 'release-manifest.json'
FORBIDDEN = {'.git', '.mcp.json', '.env', 'private-data', 'node_modules', '__pycache__',
             '.venv', 'venv', 'env', 'artifacts', '.pytest_cache', '.claude'}


def linked(path):
    return path.is_symlink() or getattr(path, 'is_junction', lambda: False)()


def check_payload(name, payload):
    path = Path(name)
    if any(p.lower() in FORBIDDEN for p in path.parts) or path.suffix.lower() in {'.db', '.sqlite', '.sqlite3', '.exe', '.dll', '.pem', '.key'}:
        raise ValueError('forbidden release path: ' + name)
    text = payload.decode('utf-8-sig')
    # Deliberately not a scan for field names such as api_key or test-only tokens.
    if re.search(r'(?i)[A-Z]:[\\/](?:Users|hummel)[\\/]|/' + r'Users/[^/\s]+/|/' + r'home/[^/\s]+/', text):
        raise ValueError('machine-specific path: ' + name)
    if re.search(r'sk-ant-[A-Za-z0-9_-]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----', text):
        raise ValueError('credential-like payload: ' + name)
    if name.endswith('.env.example'):
        for line in text.splitlines():
            if re.match(r'\s*(?:COMMERCE_BRIDGE_TOKEN|API_KEY|ACCESS_TOKEN)\s*=', line) and line.split('=', 1)[1].strip():
                raise ValueError('example credentials must be blank: ' + name)


def inventory(root=ROOT):
    """Ignore root .git metadata without opening it; never follow links.

    Git cleanliness is independent of payload validity: reviewed, uncommitted
    edits are accepted after explicit manifest refresh. Caches remain forbidden.
    """
    root = Path(root)
    allowed = set(CORE + PUBLIC) | {PREFIX + p for p in COMMERCE} | {MANIFEST}
    found = {}
    def walk(directory):
        for path in directory.iterdir():
            name = path.relative_to(root).as_posix()
            # Prune before stat/link checks, including a worktree .git file or
            # linked metadata. No .git contents are read, scanned or followed.
            if name == '.git':
                continue
            if linked(path):
                raise ValueError('linked release path: ' + name)
            if path.is_dir():
                if any(p.lower() in FORBIDDEN for p in path.relative_to(root).parts):
                    raise ValueError('forbidden release directory: ' + name)
                walk(path)
                continue
            if name not in allowed:
                raise ValueError('unlisted release file: ' + name)
            if name == MANIFEST:
                continue
            payload = path.read_bytes()
            check_payload(name, payload)
            found[name] = hashlib.sha256(payload).hexdigest()
    walk(root)
    missing = set(CORE + PUBLIC) - found.keys()
    if missing:
        raise ValueError('missing required files: ' + ', '.join(sorted(missing)))
    bundled = {n for n in found if n.startswith(PREFIX)}
    if bundled and bundled != {PREFIX + p for p in COMMERCE}:
        raise ValueError('incomplete commerce allowlist')
    return dict(sorted(found.items()))


def refresh(root=ROOT):
    data = {'schema_version': 1, 'files': inventory(root)}
    (root / MANIFEST).write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
    return len(data['files'])


def verify(root=ROOT):
    actual = inventory(root)
    manifest = json.loads((root / MANIFEST).read_text(encoding='utf-8'))
    if manifest != {'schema_version': 1, 'files': actual}:
        raise ValueError('manifest mismatch; review changes before explicit refresh')
    return len(actual)


def import_commerce(source):
    """Caller must supply reviewed, completed sources; refuse overwrite and escaping links."""
    source = Path(source).resolve()
    dest = ROOT / PREFIX
    if dest.exists():
        raise ValueError('commerce destination already exists; refusing overwrite')
    reviewed = []
    for name in COMMERCE:
        path = source / name
        if not path.is_file() or any(linked(p) for p in (path, *path.parents)):
            raise ValueError('missing or linked source: ' + name)
        payload = path.read_bytes()
        if name == 'README.md':
            # Only documentation placeholders are sanitized; runtime code is byte-preserved.
            content = payload.decode('utf-8-sig')
            content = re.sub(r'[A-Z]:[\\/]Users[\\/][^\s`]+', '<COMPONENT_DIR>', content)
            payload = content.encode('utf-8')
        check_payload(PREFIX + name, payload)
        reviewed.append((name, payload))
    license_text = dict(reviewed)['LICENSE'].decode('utf-8-sig')
    if 'MIT License' not in license_text or 'Permission is hereby granted' not in license_text:
        raise ValueError('expected upstream MIT license; stop and review provenance')
    for name, payload in reviewed:
        path = dest / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(payload)
    return len(reviewed)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('verify', 'refresh', 'import-commerce'))
    parser.add_argument('--source', help='Reviewed commerce source directory; never the whole workspace')
    parser.add_argument('--reviewed-complete', action='store_true', help='Explicitly confirm source edits and privacy review are complete')
    args = parser.parse_args()
    try:
        if args.action == 'import-commerce':
            if not args.source or not args.reviewed_complete:
                parser.error('import requires --source and --reviewed-complete')
            count = import_commerce(args.source)
            print('Imported', count, 'explicitly allowlisted files; review docs, run tests, then refresh manifest')
        else:
            print(args.action, (verify() if args.action == 'verify' else refresh()), 'files')
    except (ValueError, OSError) as exc:
        parser.exit(1, str(exc) + '\n')


if __name__ == '__main__':
    main()
