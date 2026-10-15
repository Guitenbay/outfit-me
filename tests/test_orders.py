import sys
from pathlib import Path
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'skills/outfit-me/scripts'))
from store import Store
from orders import stage, review


def line(**changes):
    value = dict(platform='taobao', account_alias='local-account-a', order_ref='synthetic-order-1', line_ref='line-1', name='测试衬衫', color='蓝', size='M', quantity=1, order_status='completed', purchased_at='2026-09-01', source_kind='file', source_ref='synthetic fixture', captured_at='2026-10-08T10:00:00+08:00')
    return dict(value, **changes)


def item(item_id='shirt-1'):
    return dict(id=item_id, schema_version=1, name='测试衬衫', category='top', color='蓝', status='available', attributes={'purchased_size': 'M'})


def decision(*items, **changes):
    value = dict(action='accept', confirmed=True, reason='用户确认已收货、自己穿且仍拥有', garments=[{'record': x} for x in (items or (item(),))])
    return dict(value, **changes)


class OrderTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.tmp.name) / 'test.sqlite3', create=True)

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def stage(self, **changes):
        return stage(self.store, [line(**changes)])[0]['id']

    def test_staging_is_not_ownership_and_hashes_order_refs(self):
        key = self.stage()
        record = self.store.get('order_import', key)
        self.assertNotIn('order_ref', record)
        self.assertNotIn('line_ref', record)
        self.assertEqual(self.store.list('wardrobe'), [])
        self.assertEqual(record['status'], 'pending_review')

    def test_duplicate_across_sources_and_tmall(self):
        key = self.stage()
        result = stage(self.store, [line(platform='tmall', source_kind='ego_lite')])[0]
        self.assertEqual(result['id'], key)
        self.assertEqual(result['result'], 'duplicate')
        self.assertEqual(stage(self.store, [line(size='L')])[0]['result'], 'conflict')
        self.assertEqual(self.store.get('order_import', key)['size'], 'M')

    def test_accounts_and_order_lines_distinct(self):
        self.assertNotEqual(self.stage(), self.stage(account_alias='local-account-b'))
        self.assertEqual(len(stage(self.store, [line(line_ref='line-2'), line(order_ref='synthetic-2')])), 2)

    def test_confirm_quantity_and_no_reaccept(self):
        key = self.stage(quantity=2)
        accepted = review(self.store, key, decision(item(), item('shirt-2')))
        self.assertEqual(len(accepted['garments']), 2)
        with self.assertRaises(ValueError):
            review(self.store, key, decision())
        self.assertEqual(len(self.store.list('wardrobe')), 2)

    def test_batch_and_acceptance_rollback(self):
        with self.assertRaises(ValueError):
            stage(self.store, [line(), line(quantity=True)])
        self.assertEqual(self.store.list('order_import'), [])
        key = self.stage(quantity=2)
        with self.assertRaises(ValueError):
            review(self.store, key, decision(item(), dict(item('bad'), category='invalid')))
        self.assertEqual(self.store.list('wardrobe'), [])
        self.assertEqual(self.store.get('order_import', key)['status'], 'pending_review')

    def test_no_implicit_confirmation_or_generic_put(self):
        key = self.stage()
        with self.assertRaises(ValueError):
            review(self.store, key, decision(confirmed=False))
        with self.assertRaises(ValueError):
            self.store.put('order_import', self.store.get('order_import', key))

    def test_cancelled_returned_and_unreceived_blocked(self):
        for state in ('cancelled', 'returned', 'pending', 'shipped'):
            key = self.stage(order_ref=state, order_status=state)
            with self.assertRaises(ValueError):
                review(self.store, key, decision())
        self.assertEqual(self.store.list('wardrobe'), [])

    def test_ambiguous_requires_resolution_and_allows_partial_retention(self):
        key = self.stage(order_status='partial_refund', quantity=2)
        with self.assertRaises(ValueError):
            review(self.store, key, decision())
        review(self.store, key, decision(status_resolution='买两件退一件，保留蓝色 M'))
        self.assertEqual(len(self.store.list('wardrobe')), 1)

    def test_existing_garment_link_and_protection(self):
        self.store.put('wardrobe', item())
        key = self.stage()
        review(self.store, key, decision(garments=[{'existing_id': 'shirt-1'}]))
        self.assertEqual(len(self.store.list('wardrobe')), 1)
        other = self.stage(order_ref='other')
        with self.assertRaises(ValueError):
            review(self.store, other, decision(garments=[{'existing_id': 'shirt-1'}]))

    def test_rejection_export_and_purge(self):
        key = self.stage()
        review(self.store, key, dict(action='reject', confirmed=True, reason='给别人买的'))
        self.assertEqual(len(self.store.export()['records']['order_import']), 1)
        self.store.purge()
        self.assertEqual(self.store.list('order_import'), [])

    def test_unknown_private_fields_rejected(self):
        for changes in ({'address': 'not-real'}, {'cookie': 'not-real'}, {'product_url': 'https://evil.test/'}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                stage(self.store, [line(**changes)])


if __name__ == '__main__':
    unittest.main()
