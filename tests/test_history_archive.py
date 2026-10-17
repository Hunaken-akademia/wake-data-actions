import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
import urllib.error
import concurrent.futures
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('history', ROOT / 'pipeline/collect_history_archive.py')
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)

K = '''STARTK
22KBGN
 第 3日 2021/10/17 ボートレース福　岡
 1R 予選 H1800m 晴 風 北東 5m 波 5cm
 着 艇 登番 選手名 ﾓｰﾀｰ ﾎﾞｰﾄ 展示 進入 ｽﾀｰﾄﾀｲﾐﾝｸ ﾚｰｽﾀｲﾑ 逃げ
 01 1 4857 加　藤　　翔　馬 25 109 6.72 1 0.21 1.51.4
 02 4 4251 川　崎　　誠　志 29 152 6.72 4 0.18 1.52.7
 03 6 4056 小　西　　英　輝 38 134 6.80 5 0.17 1.55.4
 04 3 5114 小　林　　孝　彰 48 104 6.72 3 0.27 1.56.2
 05 2 4204 柴　田　　大　輔 63 106 6.70 2 0.31 . .
 06 5 5177 松　井　　貫　太 74 131 6.72 6 0.17 . .
22KEND
ENDK
'''


class ArchiveTests(unittest.TestCase):
    def test_parallel_base_days_are_unique_and_bounded(self):
        class DB:
            def control(self):
                return {'enabled': True}
        active, peak = 0, 0
        calls = []
        lock = threading.Lock()
        def fetch(db, row):
            nonlocal active, peak
            with lock:
                active += 1
                peak = max(peak, active)
                calls.append(row['race_date'])
            time.sleep(0.02)
            with lock:
                active -= 1
            return True
        index = [{'race_date': f'2021-10-{d:02d}', 'base_status': 'pending', 'base_attempts': 0} for d in range(17,29)]
        with patch.object(h, 'collect_base_day', side_effect=fetch):
            count = h.collect_base(DB(), index, time.monotonic() + 5, 10)
        self.assertEqual(count, 10)
        self.assertEqual(len(set(calls)), 10)
        self.assertGreater(peak, 1)
        self.assertLessEqual(peak, h.BASE_WORKERS)

    def test_original_resume_uses_race_identity_after_out_of_order_completion(self):
        parsed = h.parse_k(K, '2021-10-17')
        parsed['rows'] = [{**r, 'race_no': race} for race in range(1,4) for r in parsed['rows']]
        done = {'place_no': 22, 'race_no': 3, 'status': 200, 'rows': [{'boat': x} for x in range(1,7)],
                'start_exhibition': {'status': 200, 'text': 'known'}}
        row = {'base_payload_gzip_base64': h.pack({'parsed': parsed}),
               'original_payload_gzip_base64': h.pack({'date': '2021-10-17', 'records': [done]}),
               'original_cursor': 1, 'original_status': 'running', 'original_attempts': 0}
        class DB:
            def request(self, path): return [row]
            def all(self, path): return []
            def control(self): return {'enabled': True}
            def patch(self, date, values): row.update(values)
        calls = []
        def fetch(date, key, racers, previous=None):
            calls.append(key)
            time.sleep(0.03 if key[1] == 1 else 0.001)
            return {'place_no': key[0], 'race_no': key[1], 'status': 403,
                    'start_exhibition': {'status': 403}}
        with patch.object(h, 'fetch_original', side_effect=fetch):
            self.assertTrue(h.collect_original_day(DB(), '2021-10-17', time.monotonic() + 5))
            self.assertTrue(h.collect_original_day(DB(), '2021-10-17', time.monotonic() + 5))
        self.assertEqual(set(calls), {(22,1),(22,2)})
        self.assertEqual(len(calls), 2)
        self.assertEqual(row['original_cursor'], 3)
        records = h.unpack(row['original_payload_gzip_base64'])['records']
        self.assertEqual(len(records), 3)
        self.assertEqual(next(r for r in records if r['race_no'] == 3), done)

    def test_retry_only_fetches_failed_feed(self):
        previous = {'place_no': 22, 'race_no': 1, 'status': 403,
                    'start_exhibition': {'status': 'network_error'}}
        with patch.object(h, 'source_get', return_value={'status':200, 'url':'source', 'data':b'exhibition ST'}) as get:
            record = h.fetch_original('2021-10-17', (22,1), [], previous)
        self.assertEqual(get.call_count, 1)
        self.assertIn('bc_j_stt_', get.call_args.args[0])
        self.assertEqual(record['status'], 403)
        self.assertEqual(record['start_exhibition']['status'], 200)

    def test_retry_after_reduces_shared_host_rate(self):
        pacing = h.HostPacing(8)
        pacing.observe('source', 429, {'Retry-After': '3'})
        state = pacing.hosts['source']
        self.assertGreaterEqual(state['blocked_until'], time.monotonic() + 2.9)
        self.assertGreater(state['interval'], 1/8)
        self.assertNotIn('other-source', pacing.hosts)

    def test_reused_measurements_are_not_complete_before_exhibition_st_checked(self):
        class DB:
            def patch(self, date, values): self.values = values
        db = DB()
        records = {(22,1): {'place_no':22,'race_no':1,'status':'database','rows':[{}]*6}}
        status = h.checkpoint_original(db, '2021-10-17', {}, records, 1, 0)
        self.assertEqual(status, 'running')

    def test_official_k_exhibition_is_separate_from_result_st_and_course(self):
        data = h.parse_k(K, '2021-10-17')
        self.assertEqual(data['audit'], {'expected_rows': 6, 'parsed_rows': 6, 'unparsed_rows': 0})
        boat6 = next(r for r in data['rows'] if r['boat'] == 6)
        self.assertEqual((boat6['course'], boat6['st']), (5, 0.17))
        exhibition6 = next(r for r in data['exhibitions'] if r['boat'] == 6)
        self.assertEqual(exhibition6['ex_time'], 6.80)
        self.assertIsNone(exhibition6['course'])
        self.assertIsNone(exhibition6['st'])
        self.assertIsNone(exhibition6['turn'])

    def test_archive_roundtrip_preserves_source_text(self):
        value = {'date': '2021-10-17', 'text': K, 'missing': None, 'metrics': [6.72, 0.0]}
        self.assertEqual(h.unpack(h.pack(value)), value)

    def test_wrong_source_date_is_rejected(self):
        with self.assertRaises(ValueError):
            h.parse_k(K, '2021-10-18')

    def test_fullwidth_program_header_date(self):
        h.validate_date('第　３日　２０２１年１０月１７日　ボートレース福岡', '2021-10-17')
        with self.assertRaises(ValueError):
            h.validate_date('２０２１年１０月１７日', '2021-10-18')

    def test_original_missing_turn_does_not_become_straight(self):
        racers = [{'boat': 1, 'regno': 4857, 'racer_name': '加藤翔馬'}]
        rows, warnings = h.parse_original('一周\tまわり足\t直線\n1\t加藤 翔馬\t37.12\t\t7.22\n', racers)
        self.assertEqual(len(rows), 1)
        self.assertIsNone(rows[0]['turn'])
        self.assertEqual(rows[0]['straight'], 7.22)
        self.assertEqual(warnings, [])

    def test_original_wrong_racer_is_not_attached_to_boat(self):
        racers = [{'boat': 1, 'regno': 4857, 'racer_name': '加藤翔馬'}]
        rows, warnings = h.parse_original('1\t別の選手\t37.12\t5.55\t7.22\n', racers)
        self.assertEqual(rows, [])
        self.assertIn('boat_name_mismatch', warnings)

    def test_half_lap_is_not_a_full_lap(self):
        racers = [{'boat': 1, 'regno': 4857, 'racer_name': '加藤翔馬'}]
        rows, _ = h.parse_original('半周\tまわり足\t直線\n1\t加藤翔馬\t18.22\t5.55\t7.22\n', racers)
        self.assertIsNone(rows[0]['lap'])
        self.assertEqual(rows[0]['half_lap'], 18.22)

    def test_forbidden_source_is_recorded_without_retries(self):
        with patch.object(h.HTTP, 'request', return_value=(403, {}, b'')) as request:
            result = h.source_get('https://example.invalid')
        self.assertEqual(result['status'], 403)
        self.assertEqual(request.call_count, 1)

    def test_database_pagination_does_not_drop_rows_after_1000(self):
        db = object.__new__(h.Database)
        with patch.object(db, 'request', side_effect=[list(range(1000)), list(range(1000, 1826))]):
            rows = db.all('queue?select=race_date')
        self.assertEqual(len(rows), 1826)
        self.assertEqual(rows[-1], 1825)


if __name__ == '__main__':
    unittest.main()
