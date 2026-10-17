import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
import urllib.error

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
        with patch.object(h.urllib.request, 'urlopen', side_effect=urllib.error.HTTPError('https://example.invalid', 403, 'Forbidden', {}, None)) as request:
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
