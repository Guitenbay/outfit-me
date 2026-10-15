"""Local Outfit Me records. Standard library only; no network or model calls."""
import argparse
import json
import math
import re
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

KINDS = ('profile', 'wardrobe', 'candidate', 'outfit', 'feedback', 'evidence', 'order_import')
FIELDS = {
    'profile': {'name', 'city', 'timezone', 'preferences', 'constraints', 'budget', 'claims'},
    'wardrobe': {'name', 'category', 'color', 'status', 'attributes', 'image_path'},
    'candidate': {'name', 'platform', 'url', 'verification', 'fetched_at', 'price', 'currency', 'price_conditions', 'sku', 'details', 'source'},
    'outfit': {'name', 'occasion', 'date', 'garment_ids', 'reason', 'evidence_ids'},
    'feedback': {'outfit_id', 'date', 'notes', 'comfort'},
    'evidence': {'type', 'url', 'fetched_at', 'forecast_for', 'data', 'source'},
}
SECRET_KEYS = {'password', 'cookie', 'cookies', 'api_key', 'apikey', 'authorization', 'access_token', 'refresh_token', 'private_key'}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def text(value):
    return isinstance(value, str) and bool(value.strip())


def timestamp(value):
    require(text(value), 'timestamp must be a nonempty string')
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        raise ValueError('timestamp must be ISO 8601') from None
    require(parsed.tzinfo is not None, 'timestamp must include a timezone')


def url(value):
    require(text(value), 'url must be a nonempty string')
    parsed = urlsplit(value)
    require(parsed.scheme == 'https' and parsed.hostname and not parsed.username and not parsed.password,
            'url must be HTTPS without embedded credentials')


def walk(value):
    if isinstance(value, dict):
        for key, child in value.items():
            require(key.lower().replace('-', '_') not in SECRET_KEYS, 'credential fields are not allowed')
            walk(child)
    elif isinstance(value, list):
        for child in value:
            walk(child)
    elif isinstance(value, float):
        require(math.isfinite(value), 'non-finite numbers are not allowed')


def ids(value, label, nonempty=False):
    require(isinstance(value, list) and (not nonempty or value), f'{label} must be a list')
    require(all(text(x) for x in value), f'{label} must contain nonempty strings')
    require(len(value) == len(set(value)), f'{label} must not contain duplicates')


def validate(kind, record):
    require(kind in KINDS, 'unknown record kind')
    require(isinstance(record, dict), 'record must be an object')
    require(set(record) <= FIELDS[kind] | {'id', 'schema_version', 'updated_at'}, 'unknown top-level field')
    require(isinstance(record.get('id'), str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,79}', record['id']), 'invalid id')
    require(type(record.get('schema_version')) is int and record['schema_version'] == 1, 'schema_version must be 1')
    if 'updated_at' in record:
        timestamp(record['updated_at'])
    walk(record)
    required = {
        'profile': ['name'], 'wardrobe': ['name', 'category', 'color', 'status'],
        'candidate': ['name', 'platform', 'url', 'verification', 'fetched_at', 'source'],
        'outfit': ['name', 'occasion', 'date', 'reason'],
        'feedback': ['outfit_id', 'date', 'notes'],
        'evidence': ['type', 'url', 'fetched_at', 'source'],
    }
    for key in required[kind]:
        require(text(record.get(key)), f'{key} must be a nonempty string')
    if kind == 'profile':
        for key in ('preferences', 'constraints'):
            if key in record:
                require(isinstance(record[key], list) and all(text(x) for x in record[key]), f'{key} must be a string list')
        if 'budget' in record:
            b = record['budget']
            require(isinstance(b, dict) and set(b) == {'amount', 'currency'}, 'budget needs amount and currency')
            require(type(b['amount']) in (int, float) and b['amount'] >= 0 and text(b['currency']), 'invalid budget')
        if 'claims' in record:
            require(isinstance(record['claims'], list), 'claims must be a list')
            for claim in record['claims']:
                require(isinstance(claim, dict) and set(claim) == {'name', 'value', 'basis', 'confidence'}, 'invalid claim fields')
                require(text(claim['name']) and text(claim['value']), 'claim requires name and value')
                require(claim['basis'] in ('user_confirmed', 'observed', 'inferred'), 'invalid claim basis')
                require(type(claim['confidence']) in (int, float) and 0 <= claim['confidence'] <= 1, 'invalid confidence')
    if kind == 'wardrobe':
        require(record['category'] in ('top', 'bottom', 'one_piece', 'outerwear', 'shoes', 'accessory'), 'invalid category')
        require(record['status'] in ('available', 'laundry', 'unavailable', 'retired'), 'invalid wardrobe status')
        if 'attributes' in record:
            require(isinstance(record['attributes'], dict), 'attributes must be an object')
    if kind in ('candidate', 'evidence'):
        url(record['url'])
        timestamp(record['fetched_at'])
    if kind == 'candidate':
        require(record['platform'] in ('taobao', 'tmall', 'jd', 'other'), 'invalid platform')
        host = urlsplit(record['url']).hostname.lower()
        domains = {'taobao': ('taobao.com',), 'tmall': ('tmall.com',), 'jd': ('jd.com', 'jd.hk')}
        if record['platform'] in domains:
            require(any(host == d or host.endswith('.' + d) for d in domains[record['platform']]), 'URL does not match platform; resolve short links first')
        require(record['verification'] in ('search_result', 'detail_verified', 'sku_verified'), 'invalid verification level')
        if 'price' in record:
            require(type(record['price']) in (int, float) and record['price'] >= 0, 'price must be nonnegative')
            require(text(record.get('currency')) and text(record.get('price_conditions')), 'price needs currency and conditions')
        if record['verification'] in ('detail_verified', 'sku_verified'):
            require(isinstance(record.get('details'), dict) and bool(record['details']), 'verified detail needs details')
        if record['verification'] == 'sku_verified':
            sku = record.get('sku')
            require(isinstance(sku, dict) and all(text(sku.get(k)) for k in ('id', 'color', 'size', 'stock', 'source')), 'verified SKU needs id/color/size/stock/source')
            require(sku['stock'] in ('available', 'out_of_stock'), 'unknown stock cannot be SKU verified')
    if kind == 'outfit':
        ids(record.get('garment_ids'), 'garment_ids', True)
        ids(record.get('evidence_ids', []), 'evidence_ids')
    if kind in ('outfit', 'feedback'):
        try:
            datetime.strptime(record['date'], '%Y-%m-%d')
        except ValueError:
            raise ValueError('date must be YYYY-MM-DD') from None
    if kind == 'evidence':
        require(record['type'] in ('weather', 'trend', 'product'), 'invalid evidence type')
        require(isinstance(record.get('data'), dict) and record['data'], 'evidence needs data object')
        if record['type'] == 'weather':
            timestamp(record.get('forecast_for'))
            require(all(text(record['data'].get(k)) for k in ('location', 'timezone')), 'weather needs location and timezone')
    for key in ('city', 'timezone', 'image_path', 'currency', 'price_conditions', 'comfort'):
        if key in record:
            require(text(record[key]), f'{key} must be a nonempty string')


class Store:
    def __init__(self, path, create=False):
        self.path = Path(path).resolve()
        if create:
            self.path.parent.mkdir(parents=True, exist_ok=True)
        else:
            require(self.path.is_file(), 'database missing; run init after storage consent')
        self.db = sqlite3.connect(self.path if create else self.path.as_uri() + '?mode=rw', uri=not create, timeout=10)
        try:
            self.db.execute('PRAGMA foreign_keys=ON')
            version = self.db.execute('PRAGMA user_version').fetchone()[0]
            require(version in (0, 1), 'unsupported database version')
            if version == 0:
                require(create, 'database not initialized')
                with self.db:
                    self.db.execute('CREATE TABLE records (kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,id))')
                    self.db.execute('''CREATE TABLE links (owner_kind TEXT, owner_id TEXT, target_kind TEXT, target_id TEXT,
                        PRIMARY KEY(owner_kind,owner_id,target_kind,target_id),
                        FOREIGN KEY(owner_kind,owner_id) REFERENCES records(kind,id) ON DELETE CASCADE,
                        FOREIGN KEY(target_kind,target_id) REFERENCES records(kind,id) ON DELETE RESTRICT)''')
                    self.db.execute('PRAGMA user_version=1')
        except Exception:
            self.db.close()
            raise

    def close(self):
        self.db.close()

    def get(self, kind, record_id):
        row = self.db.execute('SELECT body FROM records WHERE kind=? AND id=?', (kind, record_id)).fetchone()
        require(row is not None, f'{kind}/{record_id} not found')
        return json.loads(row[0])

    def list(self, kind):
        return [json.loads(row[0]) for row in self.db.execute('SELECT body FROM records WHERE kind=? ORDER BY id', (kind,))]

    def put(self, kind, record):
        require(kind != 'order_import', 'use orders.py to stage or review order imports')
        validate(kind, record)
        saved = dict(record, updated_at=datetime.now(timezone.utc).isoformat())
        with self.db:
            self.db.execute('BEGIN IMMEDIATE')
            targets = []
            if kind == 'outfit':
                for item_id in saved['garment_ids']:
                    item = self.get('wardrobe', item_id)
                    require(item['status'] == 'available', f'wardrobe/{item_id} is not available')
                    targets.append(('wardrobe', item_id))
                targets.extend(('evidence', x) for x in saved.get('evidence_ids', []))
            if kind == 'feedback':
                targets.append(('outfit', saved['outfit_id']))
            for target_kind, target_id in targets:
                self.get(target_kind, target_id)
            self.db.execute('INSERT INTO records VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body',
                            (kind, saved['id'], json.dumps(saved, ensure_ascii=False, allow_nan=False)))
            self.db.execute('DELETE FROM links WHERE owner_kind=? AND owner_id=?', (kind, saved['id']))
            self.db.executemany('INSERT INTO links VALUES (?,?,?,?)', [(kind, saved['id'], k, i) for k, i in targets])
        return saved

    def delete(self, kind, record_id):
        with self.db:
            self.db.execute('BEGIN IMMEDIATE')
            self.get(kind, record_id)
            self.db.execute('DELETE FROM records WHERE kind=? AND id=?', (kind, record_id))

    def export(self):
        with self.db:
            self.db.execute('BEGIN')
            return {'schema_version': 1, 'records': {kind: self.list(kind) for kind in KINDS}}

    def purge(self):
        with self.db:
            self.db.execute('BEGIN IMMEDIATE')
            self.db.execute('DELETE FROM links')
            self.db.execute('DELETE FROM records')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', required=True, help='Explicit database path; keep outside version control')
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('init')
    for name in ('put', 'list', 'get', 'delete'):
        p = sub.add_parser(name)
        p.add_argument('kind', choices=KINDS)
        if name in ('get', 'delete'):
            p.add_argument('id')
        if name == 'put':
            p.add_argument('--file', required=True, help='UTF-8 JSON file, or - for stdin')
        if name == 'delete':
            p.add_argument('--confirm', action='store_true', required=True)
    p = sub.add_parser('export')
    p.add_argument('--output', required=True, help='New file only; contains private data')
    p = sub.add_parser('purge')
    p.add_argument('--confirm', choices=['DELETE_ALL_RECORDS'], required=True)
    args = parser.parse_args(argv)
    store = None
    try:
        store = Store(args.db, create=args.command == 'init')
        if args.command == 'init':
            result = {'initialized': True, 'schema_version': 1}
        elif args.command == 'put':
            raw = sys.stdin.read() if args.file == '-' else Path(args.file).read_text(encoding='utf-8-sig')
            result = store.put(args.kind, json.loads(raw))
        elif args.command == 'list':
            result = store.list(args.kind)
        elif args.command == 'get':
            result = store.get(args.kind, args.id)
        elif args.command == 'delete':
            store.delete(args.kind, args.id)
            result = {'deleted': args.id}
        elif args.command == 'purge':
            store.purge()
            result = {'purged': True, 'scope': 'database records only; not photos, exports or external data'}
        else:
            snapshot = store.export()
            with Path(args.output).open('x', encoding='utf-8') as f:
                json.dump(snapshot, f, ensure_ascii=False, indent=2, allow_nan=False)
            result = {'exported': True}
        print(json.dumps(result, ensure_ascii=False, allow_nan=False))
        return 0
    except (ValueError, OSError, sqlite3.Error) as exc:
        # Do not dump payloads, credentials or full tracebacks to logs.
        message = 'record is referenced; remove dependents first' if isinstance(exc, sqlite3.IntegrityError) else str(exc)
        print(json.dumps({'error': message}, ensure_ascii=False), file=sys.stderr)
        return 1
    finally:
        if store:
            store.close()


if __name__ == '__main__':
    raise SystemExit(main())
