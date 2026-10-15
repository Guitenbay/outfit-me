"""Stage sanitized order lines and explicitly confirm ownership. No browser/network access."""
import argparse
import hashlib
import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

from store import Store, require, text, timestamp, validate, walk

STATUSES = ('completed', 'shipped', 'pending', 'cancelled', 'returned', 'partial_refund', 'exchanged', 'unknown')
FIELDS = {'platform', 'account_alias', 'order_ref', 'line_ref', 'name', 'color', 'size', 'quantity', 'order_status', 'purchased_at', 'source_kind', 'source_ref', 'captured_at', 'product_url'}


def normalize(line):
    require(isinstance(line, dict) and set(line) <= FIELDS, 'order line has unknown fields; remove private page data first')
    walk(line)
    for field in FIELDS - {'product_url'}:
        if field != 'quantity':
            require(text(line.get(field)), f'{field} must be a nonempty string')
    require(line['platform'] in ('taobao', 'tmall', 'jd'), 'unsupported platform')
    require(line['source_kind'] in ('ego_lite', 'screenshot', 'file', 'manual'), 'invalid source_kind')
    require(line['order_status'] in STATUSES, 'invalid order_status')
    require(type(line.get('quantity')) is int and 1 <= line['quantity'] <= 100, 'quantity must be 1..100')
    timestamp(line['captured_at'])
    try:
        datetime.strptime(line['purchased_at'], '%Y-%m-%d')
    except ValueError:
        raise ValueError('purchased_at must be YYYY-MM-DD') from None
    if 'product_url' in line:
        validate('candidate', dict(id='check', schema_version=1, name=line['name'], platform=line['platform'], url=line['product_url'], verification='search_result', fetched_at=line['captured_at'], source='order'))
    # Taobao and Tmall share an order namespace. Keep account aliases stable.
    marketplace = 'ali' if line['platform'] in ('taobao', 'tmall') else 'jd'
    key = [marketplace, line['account_alias'], line['order_ref'], line['line_ref']]
    digest = hashlib.sha256(json.dumps(key, ensure_ascii=False).encode('utf-8')).hexdigest()
    saved = {k: v for k, v in line.items() if k not in ('order_ref', 'line_ref')}
    saved.update(id='order-' + digest, schema_version=1, status='pending_review', garments=[], updated_at=datetime.now(timezone.utc).isoformat())
    return saved


def write_record(store, kind, record):
    store.db.execute('INSERT INTO records VALUES (?,?,?)', (kind, record['id'], json.dumps(record, ensure_ascii=False, allow_nan=False)))


def stage(store, lines):
    require(isinstance(lines, list) and 0 < len(lines) <= 500, 'provide 1..500 sanitized order lines')
    normalized = [normalize(line) for line in lines]
    results = []
    with store.db:
        store.db.execute('BEGIN IMMEDIATE')
        for record in normalized:
            previous = store.db.execute('SELECT body FROM records WHERE kind=? AND id=?', ('order_import', record['id'])).fetchone()
            if previous:
                old = json.loads(previous[0])
                # Never overwrite an already reviewed purchase or silently refresh changed specs.
                fields = ('name', 'color', 'size', 'quantity', 'order_status', 'purchased_at')
                changed = any(old[k] != record[k] for k in fields)
                results.append({'id': record['id'], 'result': 'conflict' if changed else 'duplicate', 'status': old['status']})
            else:
                write_record(store, 'order_import', record)
                results.append({'id': record['id'], 'result': 'staged'})
    return results


def review(store, order_id, decision):
    require(isinstance(decision, dict), 'decision must be an object')
    require(set(decision) <= {'action', 'confirmed', 'reason', 'garments', 'status_resolution'}, 'unknown decision fields')
    require(decision.get('confirmed') is True, 'explicit user confirmation required')
    require(text(decision.get('reason')), 'review reason required')
    require(decision.get('action') in ('accept', 'reject'), 'action must be accept or reject')
    walk(decision)
    with store.db:
        store.db.execute('BEGIN IMMEDIATE')
        order = store.get('order_import', order_id)
        require(order['status'] == 'pending_review', 'order already reviewed; do not import twice')
        garments = decision.get('garments', [])
        if decision['action'] == 'reject':
            require(garments == [], 'rejection must not include garments')
            order['status'] = 'rejected'
        else:
            require(order['order_status'] not in ('cancelled', 'returned', 'pending', 'shipped'), 'cancelled/returned/unreceived orders cannot enter wardrobe; reject or wait for a verified correction')
            if order['order_status'] in ('partial_refund', 'exchanged', 'unknown'):
                require(text(decision.get('status_resolution')), 'ambiguous order needs explanation of what was actually retained')
            require(isinstance(garments, list) and 1 <= len(garments) <= order['quantity'], 'confirm each retained physical item, up to purchased quantity')
            used = set()
            for entry in garments:
                require(isinstance(entry, dict) and set(entry) in ({'existing_id'}, {'record'}), 'each garment needs existing_id OR record')
                if 'existing_id' in entry:
                    require(text(entry['existing_id']), 'existing_id must be a string')
                    item = store.get('wardrobe', entry['existing_id'])
                else:
                    item = dict(entry['record']) if isinstance(entry['record'], dict) else None
                    require(item is not None, 'record must be an object')
                    validate('wardrobe', item)
                    require(not store.db.execute('SELECT 1 FROM records WHERE kind=? AND id=?', ('wardrobe', item['id'])).fetchone(), 'wardrobe id already exists; explicitly link existing_id instead')
                    item['updated_at'] = datetime.now(timezone.utc).isoformat()
                    write_record(store, 'wardrobe', item)
                require(item['id'] not in used, 'one physical garment cannot represent multiple retained units')
                require(not store.db.execute('SELECT 1 FROM links WHERE owner_kind=? AND target_kind=? AND target_id=?', ('order_import', 'wardrobe', item['id'])).fetchone(), 'garment already linked to another order import; inspect duplicate source')
                used.add(item['id'])
                store.db.execute('INSERT INTO links VALUES (?,?,?,?)', ('order_import', order_id, 'wardrobe', item['id']))
            order['garments'] = sorted(used)
            order['status'] = 'accepted'
        order['review'] = {'reason': decision['reason'], 'status_resolution': decision.get('status_resolution'), 'confirmed': True}
        order['updated_at'] = datetime.now(timezone.utc).isoformat()
        store.db.execute('UPDATE records SET body=? WHERE kind=? AND id=?', (json.dumps(order, ensure_ascii=False, allow_nan=False), 'order_import', order_id))
    return order


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', required=True)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('stage')
    p.add_argument('--file', required=True)
    p = sub.add_parser('review')
    p.add_argument('id')
    p.add_argument('--file', required=True)
    args = parser.parse_args(argv)
    store = None
    try:
        data = json.loads(sys.stdin.read() if args.file == '-' else Path(args.file).read_text(encoding='utf-8-sig'))
        store = Store(args.db)
        result = stage(store, data) if args.command == 'stage' else review(store, args.id, data)
        print(json.dumps(result, ensure_ascii=False, allow_nan=False))
        return 0
    except (ValueError, OSError, sqlite3.Error) as exc:
        print(json.dumps({'error': str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1
    finally:
        if store:
            store.close()


if __name__ == '__main__':
    raise SystemExit(main())
