import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'skills/outfit-me/scripts/store.py'
spec = importlib.util.spec_from_file_location('outfit_store', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def garment(item_id='dress-1', status='available'):
    return dict(id=item_id, schema_version=1, name='连衣裙', category='one_piece', color='蓝', status=status)


def outfit():
    return dict(id='look-1', schema_version=1, name='通勤', occasion='office', date='2026-10-08', reason='已有衣物', garment_ids=['dress-1'])


def candidate():
    return dict(id='product-1', schema_version=1, name='衣服', platform='jd', url='https://item.jd.com/123.html', verification='search_result', fetched_at='2026-10-08T10:00:00+08:00', source='manual test fixture')


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'private' / 'data.sqlite3'
        self.store = module.Store(self.path, create=True)

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def test_unicode_roundtrip_and_timestamp(self):
        saved = self.store.put('wardrobe', garment())
        self.assertEqual(self.store.get('wardrobe', 'dress-1')['name'], '连衣裙')
        self.assertIn('updated_at', saved)

    def test_idempotent_init_and_upsert(self):
        self.store.put('wardrobe', garment())
        other = module.Store(self.path, create=True)
        try:
            other.put('wardrobe', garment(status='laundry'))
        finally:
            other.close()
        self.assertEqual(len(self.store.list('wardrobe')), 1)
        self.assertEqual(self.store.get('wardrobe', 'dress-1')['status'], 'laundry')

    def test_missing_database_read_does_not_create(self):
        absent = Path(self.tmp.name) / 'absent.sqlite3'
        with self.assertRaises(ValueError):
            module.Store(absent)
        self.assertFalse(absent.exists())

    def test_references_and_failed_update_rollback(self):
        self.store.put('wardrobe', garment())
        self.store.put('outfit', outfit())
        invalid = dict(outfit(), garment_ids=['missing'])
        with self.assertRaises(ValueError):
            self.store.put('outfit', invalid)
        self.assertEqual(self.store.get('outfit', 'look-1')['garment_ids'], ['dress-1'])
        with self.assertRaises(sqlite3.IntegrityError):
            self.store.delete('wardrobe', 'dress-1')
        self.store.delete('outfit', 'look-1')
        self.store.delete('wardrobe', 'dress-1')
        self.assertEqual(self.store.list('wardrobe'), [])

    def test_unavailable_and_candidate_not_owned(self):
        self.store.put('wardrobe', garment(status='laundry'))
        with self.assertRaises(ValueError):
            self.store.put('outfit', outfit())
        self.store.put('candidate', candidate())
        with self.assertRaises(ValueError):
            self.store.put('outfit', dict(outfit(), garment_ids=['product-1']))

    def test_feedback_history_and_purge(self):
        self.store.put('wardrobe', garment())
        self.store.put('outfit', outfit())
        self.store.put('feedback', dict(id='feedback-1', schema_version=1, outfit_id='look-1', date='2026-10-08', notes='舒适'))
        self.store.put('wardrobe', garment(status='retired'))
        self.assertEqual(len(self.store.list('feedback')), 1)
        with self.assertRaises(sqlite3.IntegrityError):
            self.store.delete('outfit', 'look-1')
        self.store.purge()
        self.assertTrue(all(not records for records in self.store.export()['records'].values()))

    def test_candidate_evidence_levels(self):
        for changes in ({'price': -1}, {'price': True}, {'price': 80}, {'url': 'https://item.jd.com.evil.test/123'}, {'verification': 'sku_verified'}, {'fetched_at': '2026-10-08T10:00:00'}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.store.put('candidate', dict(candidate(), **changes))
        verified = dict(candidate(), verification='sku_verified', price=100, currency='CNY', price_conditions='标价', details={'fabric': '棉'}, sku={'id': '123', 'color': '蓝', 'size': 'M', 'stock': 'available', 'source': 'detail page'})
        self.store.put('candidate', verified)
        verified['sku']['stock'] = 'unknown'
        with self.assertRaises(ValueError):
            self.store.put('candidate', verified)

    def test_secrets_nonfinite_and_unknown_fields(self):
        for changes in ({'attributes': {'nested': {'api_key': 'not-a-real-key'}}}, {'attributes': {'value': float('nan')}}, {'unexpected': 'x'}, {'schema_version': True}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.store.put('wardrobe', dict(garment(), **changes))

    def test_duplicate_ids_and_empty_outfits(self):
        for values in ([], ['dress-1', 'dress-1'], 'dress-1'):
            with self.subTest(values=values), self.assertRaises(ValueError):
                self.store.put('outfit', dict(outfit(), garment_ids=values))

    def test_weather_evidence(self):
        record = dict(id='weather-1', schema_version=1, type='weather', url='https://dev.qweather.com/', fetched_at='2026-10-08T10:00:00+08:00', source='synthetic test only', data={'location': 'test-city', 'timezone': 'Asia/Shanghai'})
        with self.assertRaises(ValueError):
            self.store.put('evidence', record)
        record['forecast_for'] = '2026-10-08T12:00:00+08:00'
        self.store.put('evidence', record)
        self.store.put('wardrobe', garment())
        self.store.put('outfit', dict(outfit(), evidence_ids=['weather-1']))
        with self.assertRaises(sqlite3.IntegrityError):
            self.store.delete('evidence', 'weather-1')

    def test_cli_export_refuses_overwrite(self):
        dest = Path(self.tmp.name) / 'export.json'
        args = ['--db', str(self.path), 'export', '--output', str(dest)]
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(module.main(args), 0)
            original = dest.read_bytes()
            self.assertEqual(module.main(args), 1)
        self.assertEqual(dest.read_bytes(), original)
        self.assertEqual(json.loads(original)['schema_version'], 1)

    def test_unsupported_version(self):
        self.store.db.execute('PRAGMA user_version=99')
        with self.assertRaises(ValueError):
            module.Store(self.path)


if __name__ == '__main__':
    unittest.main()
