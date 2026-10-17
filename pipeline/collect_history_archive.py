#!/usr/bin/env python3
"""Finite, resumable official-source archive; never modifies WAKE live tables.

Uses only Python/Node standard libraries and the OS libarchive reader.
Independent base/original workers share adaptive per-host request pacing.
Secrets are used only for the database transport and never written to logs.
"""
import argparse
import base64
import concurrent.futures
import contextlib
import ctypes
import ctypes.util
import datetime as dt
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import unicodedata
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from archive_transport import Transport, HostPacing

ROOT = Path(__file__).resolve().parent
JOB = 'five_year_20261017'
TABLE = 'wake_history_archive_days'
CONTROL = 'wake_history_archive_control'
MAX_SOURCE_BYTES = 4 * 1024 * 1024
HTTP = Transport()
PACING = HostPacing(8)
BASE_WORKERS = 8
ORIGINAL_WORKERS = 24
TRANSIENT = (429, 500, 502, 503, 504, "network_error")


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def pack(value):
    raw = json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()
    return base64.b64encode(gzip.compress(raw, mtime=0)).decode()


def unpack(value):
    return json.loads(gzip.decompress(base64.b64decode(value)))


def source_get(url):
    host = urllib.parse.urlsplit(url).hostname
    for attempt in range(3):
        PACING.acquire(host)
        try:
            status, headers, data = HTTP.request(url, maximum=MAX_SOURCE_BYTES,
                                                headers={'User-Agent': 'WAKE-History-Archive/2.0'})
            PACING.observe(host, status, headers)
            if len(data) > MAX_SOURCE_BYTES:
                return {'status': 'oversize', 'url': url}
            if status == 200:
                return {'status': status, 'url': url, 'data': data}
        except (OSError, TimeoutError):
            status = 'network_error'
        # Denied/missing responses are recorded without retries or bypasses.
        if status not in TRANSIENT or attempt == 2:
            return {'status': status, 'url': url}
        time.sleep(2 ** attempt)


def read_lzh(data):
    """Read in memory; do not trust archive paths or extract to the filesystem."""
    if len(data) < 10 or data[2:7] not in (b'-lh5-', b'-lh6-', b'-lh7-', b'-lh0-'):
        raise ValueError('not a recognized LZH source')
    lib = ctypes.CDLL(ctypes.util.find_library('archive') or 'libarchive.so.13')
    lib.archive_read_new.restype = ctypes.c_void_p
    for name in ('archive_read_support_filter_all', 'archive_read_support_format_all', 'archive_read_free'):
        getattr(lib, name).argtypes = [ctypes.c_void_p]
    lib.archive_read_open_memory.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t]
    lib.archive_read_next_header.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
    lib.archive_read_data.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t]
    lib.archive_read_data.restype = ctypes.c_ssize_t
    archive = lib.archive_read_new()
    buffer = ctypes.create_string_buffer(data)
    output = bytearray()
    try:
        lib.archive_read_support_filter_all(archive)
        lib.archive_read_support_format_all(archive)
        if lib.archive_read_open_memory(archive, buffer, len(data)) != 0:
            raise ValueError('cannot open LZH source')
        entry = ctypes.c_void_p()
        if lib.archive_read_next_header(archive, ctypes.byref(entry)) != 0:
            raise ValueError('missing LZH entry')
        chunk = ctypes.create_string_buffer(65536)
        while True:
            n = lib.archive_read_data(archive, chunk, len(chunk))
            if n == 0:
                break
            if n < 0 or len(output) + n > MAX_SOURCE_BYTES:
                raise ValueError('invalid LZH body')
            output.extend(chunk.raw[:n])
    finally:
        lib.archive_read_free(archive)
    return bytes(output).decode('cp932')


def validate_date(text, date):
    compact = re.sub(r'\s+', '', unicodedata.normalize('NFKC', text))
    # K uses YYYY/MM/DD; B uses fullwidth YYYY年MM月DD日.
    y, m, d = map(int, date.split('-'))
    if not re.search(rf'{y}(?:/|年)0?{m}(?:/|月)0?{d}(?:日|(?!\d))', compact):
        raise ValueError('source date does not match requested date')


def parse_k(text, date):
    validate_date(text, date)
    with tempfile.TemporaryDirectory(prefix='wake-history-') as temporary:
        path = Path(temporary) / 'source.txt'
        path.write_text(text)
        result = subprocess.run(['node', str(ROOT / 'parse_k_archive.mjs'), date, str(path)],
                                capture_output=True, text=True, timeout=30, check=False)
    if result.returncode != 0:
        raise ValueError('K parser failed')
    parsed = json.loads(result.stdout)
    if not parsed['rows'] or parsed['audit']['unparsed_rows'] < 0:
        raise ValueError('K parser returned no valid result rows')
    # Keep K course/ST only under results. Exhibition course/ST are unknown here.
    parsed['exhibitions'] = [
        {'race_date': date, 'place_no': row['place_no'], 'race_no': row['race_no'],
         'boat': row['boat'], 'regno': row['regno'], 'ex_time': row['exhibition_time'],
         'course': None, 'st': None, 'lap': None, 'turn': None, 'straight': None,
         'source': 'OFFICIAL_K_ARCHIVE'}
        for row in parsed['rows'] if isinstance(row.get('exhibition_time'), (int, float))
        and 5 <= row['exhibition_time'] <= 10
    ]
    return parsed


def fetch_base(date):
    compact = date.replace('-', '')
    sources = {}
    for kind in ('K', 'B'):
        url = f'https://www1.mbrace.or.jp/od2/{kind}/{compact[:6]}/{kind.lower()}{compact[2:]}.lzh'
        fetched = source_get(url)
        source = {key: value for key, value in fetched.items() if key != 'data'}
        source['fetched_at'] = now()
        if fetched['status'] == 200:
            text = read_lzh(fetched['data'])
            validate_date(text, date)
            source.update(text=text, sha256=hashlib.sha256(fetched['data']).hexdigest())
        sources[kind] = source
    if 'text' not in sources['K']:
        raise ValueError(f"K source unavailable: {sources['K']['status']}")
    parsed = parse_k(sources['K']['text'], date)
    payload = {'format_version': 1, 'date': date, 'sources': sources, 'parsed': parsed,
               'warning': 'Retrospective source archive. K course/ST and weather are race-result values; not pre-deadline snapshots.'}
    return payload


def name_key(value):
    return re.sub(r'[\s　]+', '', str(value or ''))


def parse_original(text, racers):
    """Accept measurements only when each explicit boat/name matches the K file."""
    by_boat = {int(row['boat']): row for row in racers}
    by_name = {name_key(row['racer_name']): row for row in racers}
    by_regno = {str(row['regno']): row for row in racers}
    half = '半周' in text
    out = {}
    warnings = []
    for line in text.splitlines():
        cells = [cell.strip() for cell in line.split('\t')]
        if len(cells) < 3:
            continue
        racer = None
        if cells[0] in {str(x) for x in range(1, 7)} and len(cells) >= 4:
            candidate = by_boat.get(int(cells[0]))
            if candidate and name_key(cells[1]) == name_key(candidate['racer_name']):
                racer, metrics = candidate, cells[2:5]
            elif re.search(r'[一-龠ぁ-んァ-ヶ]', cells[1]):
                warnings.append('boat_name_mismatch')
        elif cells[0] in by_regno and len(cells) >= 4:
            candidate = by_regno[cells[0]]
            if name_key(cells[1]) == name_key(candidate['racer_name']):
                racer, metrics = candidate, cells[2:5]
        elif name_key(cells[0]) in by_name:
            racer, metrics = by_name[name_key(cells[0])], cells[1:4]
        if racer is None:
            continue
        values = []
        for cell, minimum, maximum in zip(metrics, (10 if half else 25, 0.1, 0.1), (50, 25, 25)):
            try:
                value = float(cell)
            except ValueError:
                value = None
            values.append(value if value is not None and minimum <= value <= maximum else None)
        while len(values) < 3:
            values.append(None)
        if values[0] is None and values[1] is None and values[2] is None:
            continue
        boat = int(racer['boat'])
        if boat in out:
            raise ValueError('duplicate original boat')
        out[boat] = {'boat': boat, 'regno': racer['regno'], 'lap': values[0] if not half else None,
                     'half_lap': values[0] if half else None, 'turn': values[1], 'straight': values[2]}
    return list(out.values()), sorted(set(warnings))


class Database:
    def __init__(self):
        self.url = os.environ['SUPABASE_URL'].rstrip('/') + '/rest/v1/'
        self.key = os.environ['SUPABASE_SERVICE_KEY']

    def request(self, path, method='GET', payload=None):
        headers = {'apikey': self.key, 'Authorization': 'Bearer ' + self.key,
                   'Content-Type': 'application/json', 'Prefer': 'return=minimal'}
        data = None if payload is None else json.dumps(payload, separators=(',', ':')).encode()
        for attempt in range(3):
            try:
                status, _, body = HTTP.request(self.url + path, method=method, data=data, headers=headers)
                if status >= 400:
                    if status < 500 or attempt == 2:
                        raise RuntimeError(f'database HTTP {status}')
                else:
                    return json.loads(body) if body else None
            except (OSError, TimeoutError):
                if attempt == 2:
                    raise RuntimeError('database network error') from None
            time.sleep(2 ** attempt)

    def all(self, path):
        result = []
        for offset in range(0, 100000, 1000):
            rows = self.request(path + f'&offset={offset}&limit=1000')
            result.extend(rows)
            if len(rows) < 1000:
                return result
        raise RuntimeError('database pagination bound exceeded')

    def patch(self, date, values):
        self.request(f'{TABLE}?race_date=eq.{date}', 'PATCH', {**values, 'updated_at': now()})

    def control(self):
        rows = self.request(f'{CONTROL}?job_id=eq.{JOB}')
        if len(rows) != 1:
            raise RuntimeError('archive job not configured')
        return rows[0]

    def update_control(self, **values):
        self.request(f'{CONTROL}?job_id=eq.{JOB}', 'PATCH', {**values, 'updated_at': now()})


def archive_index(db, job):
    fields = 'race_date,base_status,base_attempts,original_status,original_attempts'
    return db.all(f'{TABLE}?race_date=gte.{job["start_date"]}&race_date=lte.{job["end_date"]}&select={fields}&order=race_date.asc')


def collect_base_day(db, row):
    date = row['race_date']
    db.patch(date, {'base_attempts': row['base_attempts'] + 1})
    try:
        payload = fetch_base(date)
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        db.patch(date, {'base_status': 'error', 'last_error': str(error)[:160]})
        print(json.dumps({'date': date, 'base': 'error', 'reason': str(error)[:160]}), flush=True)
        return False
    parsed = payload['parsed']
    races = {(r['place_no'], r['race_no']) for r in parsed['rows']}
    values = {'base_status': 'complete', 'base_payload_gzip_base64': pack(payload),
              'race_count': len(races), 'result_rows': len(parsed['rows']),
              'exhibition_rows': len(parsed['exhibitions']),
              'actual_st_rows': sum(r.get('st') is not None for r in parsed['rows']),
              'parse_missing_rows': parsed['audit']['unparsed_rows'],
              'b_available': 'text' in payload['sources']['B'], 'last_error': None}
    db.patch(date, values)
    print(json.dumps({'date': date, 'base': 'complete', 'races': len(races),
                      'rows': len(parsed['rows']), 'exhibition': len(parsed['exhibitions']),
                      'actual_st': values['actual_st_rows'],
                      'unparsed': parsed['audit']['unparsed_rows']}), flush=True)
    return True


def collect_base(db, index, deadline, max_days):
    candidates = iter(sorted((r for r in index if r['base_status'] != 'complete' and r['base_attempts'] < 3),
                             key=lambda r: r['race_date'], reverse=True))
    finished, submitted, errors = 0, 0, 0
    active = True
    checked = 0.0
    with concurrent.futures.ThreadPoolExecutor(max_workers=BASE_WORKERS) as pool:
        running = set()
        exhausted = False
        while running or not exhausted:
            if time.monotonic() - checked >= 10:
                active = db.control()['enabled']
                checked = time.monotonic()
            while not exhausted and active and time.monotonic() < deadline and submitted < max_days and len(running) < BASE_WORKERS:
                row = next(candidates, None)
                if row is None:
                    exhausted = True
                    break
                running.add(pool.submit(collect_base_day, db, row))
                submitted += 1
            if not running:
                break
            done, running = concurrent.futures.wait(running, timeout=1, return_when=concurrent.futures.FIRST_COMPLETED)
            for future in done:
                if future.result():
                    finished += 1
                    errors = 0
                else:
                    errors += 1
                    if errors >= 8:
                        raise RuntimeError('eight consecutive source failures; stopped for inspection')
    return finished


def record_needs_retry(record):
    return record.get('status') in TRANSIENT or record.get('start_exhibition', {}).get('status') in TRANSIENT


def fetch_original(date, key, racers, previous=None):
    place, race = key
    d, j, r = date.replace('-', ''), f'{place:02d}', f'{race:02d}'
    record = dict(previous or {})
    if not record or record.get('status') in TRANSIENT:
        result = source_get(f'https://race.boatcast.jp/txt/{j}/bc_oriten_{d}_{j}_{r}.txt')
        record.update({k: v for k, v in result.items() if k != 'data'})
        record.update(place_no=place, race_no=race, fetched_at=now())
        if result['status'] == 200:
            try:
                text = result['data'].decode('utf-8-sig')
                rows, warnings = parse_original(text, racers)
                record.update(text=text, rows=rows, warnings=warnings)
            except (ValueError, UnicodeError):
                record.update(status='parse_error', raw_base64=base64.b64encode(result['data']).decode())
    old_st = record.get('start_exhibition', {})
    if not old_st or old_st.get('status') in TRANSIENT:
        st = source_get(f'https://race.boatcast.jp/hp_txt/{j}/bc_j_stt_{d}_{j}_{r}.txt')
        record['start_exhibition'] = {k: v for k, v in st.items() if k != 'data'}
        if st['status'] == 200:
            try:
                record['start_exhibition']['text'] = st['data'].decode('utf-8-sig')
            except UnicodeError:
                record['start_exhibition'].update(status='parse_error', raw_base64=base64.b64encode(st['data']).decode())
    return record


def original_counts(records):
    return {'original_races': sum(bool(r.get('rows')) for r in records),
            'original_boat_rows': sum(len(r.get('rows', [])) for r in records),
            'original_unavailable_races': sum(r['status'] in (401, 403, 404) for r in records),
            'original_failed_races': sum(r['status'] not in (200, 'database', 401, 403, 404) or record_needs_retry(r) for r in records),
            'start_exhibition_races': sum(r.get('start_exhibition', {}).get('status') == 200 for r in records)}


def checkpoint_original(db, date, original, records, total, attempts):
    original['records'] = [records[key] for key in sorted(records)]
    original['format_version'] = 2  # completed race identities, not a contiguous prefix
    values = list(records.values())
    counts = original_counts(values)
    status = 'running'
    if len(records) == total and all('start_exhibition' in r for r in values):
        status = 'error' if any(record_needs_retry(r) for r in values) and attempts < 3 else (
            'partial' if counts['original_unavailable_races'] or counts['original_failed_races'] or any(len(r.get('rows', [])) < 6 for r in values) else 'complete')
    db.patch(date, {'original_status': status, 'original_cursor': len(records),
                    'original_attempts': attempts, 'original_payload_gzip_base64': pack(original), **counts})
    return status


def collect_original_day(db, date, deadline, pool=None):
    row = db.request(f'{TABLE}?race_date=eq.{date}')[0]
    base = unpack(row['base_payload_gzip_base64'])
    grouped = {}
    for racer in base['parsed']['rows']:
        grouped.setdefault((racer['place_no'], racer['race_no']), []).append(racer)
    original = unpack(row['original_payload_gzip_base64']) if row['original_payload_gzip_base64'] else {'date': date, 'format_version': 2, 'records': []}
    records = {(r['place_no'], r['race_no']): r for r in original['records']}
    if len(records) != len(original['records']) or len(records) != row['original_cursor'] or not set(records) <= set(grouped):
        raise RuntimeError('original checkpoint does not match race identities')
    retry_pass = row['original_status'] == 'error'
    attempts = row['original_attempts'] + int(retry_pass)
    saved = db.all(f'exhibition?race_date=eq.{date}&select=place_no,race_no,boat,regno,ex_time,lap,turn,straight,source&order=place_no.asc,race_no.asc,boat.asc')
    saved_by_race = {}
    for item in saved:
        saved_by_race.setdefault((item['place_no'], item['race_no']), []).append(item)
    for key, existing in saved_by_race.items():
        if key not in grouped or key in records:
            continue
        expected = {r['boat']: r['regno'] for r in grouped[key]}
        usable = len(existing) == 6 and len({r['boat'] for r in existing}) == 6 and all(
            r['regno'] == expected.get(r['boat']) and all(r.get(c) and float(r[c]) > 0 for c in ('lap','turn','straight')) for r in existing)
        if usable:
            # Reuse original measurements but still collect the separate exhibition ST feed.
            records[key] = {'place_no': key[0], 'race_no': key[1], 'status': 'database', 'rows': existing,
                            'source': 'WAKE_existing_exhibition', 'fetched_at': now()}
    # Recompute after adding reusable measurements. Missing ST still needs a request.
    pending = iter(key for key in sorted(grouped) if key not in records or record_needs_retry(records[key]) or 'start_exhibition' not in records[key])
    changed = 0
    last_save = checked = time.monotonic()
    active, exhausted = True, False
    with (contextlib.nullcontext(pool) if pool is not None else concurrent.futures.ThreadPoolExecutor(max_workers=ORIGINAL_WORKERS)) as pool:
        running = {}
        while running or not exhausted:
            if time.monotonic() - checked >= 10:
                active = db.control()['enabled']
                checked = time.monotonic()
            while not exhausted and active and time.monotonic() < deadline and len(running) < ORIGINAL_WORKERS:
                key = next(pending, None)
                if key is None:
                    exhausted = True
                    break
                running[pool.submit(fetch_original, date, key, grouped[key], records.get(key))] = key
            if not running:
                break
            done, _ = concurrent.futures.wait(running, timeout=1, return_when=concurrent.futures.FIRST_COMPLETED)
            for future in done:
                key = running.pop(future)
                records[key] = future.result()
                changed += 1
            if changed >= 24 or changed and time.monotonic() - last_save >= 15:
                checkpoint_original(db, date, original, records, len(grouped), attempts)
                changed, last_save = 0, time.monotonic()
    status = checkpoint_original(db, date, original, records, len(grouped), attempts)
    print(json.dumps({'date': date, 'original_checked': len(records), 'total_races': len(grouped),
                      'status': status, **original_counts(list(records.values()))}), flush=True)
    return status in ('complete', 'partial', 'error')


def collect_original(db, index, deadline, max_days, pool=None):
    finished = 0
    with (contextlib.nullcontext(pool) if pool is not None else concurrent.futures.ThreadPoolExecutor(max_workers=ORIGINAL_WORKERS)) as executor:
        for brief in reversed(index):
            if brief['base_status'] != 'complete' or brief['original_status'] in ('complete','partial') or brief['original_attempts'] >= 3:
                continue
            if time.monotonic() >= deadline or finished >= max_days or not db.control()['enabled']:
                break
            if collect_original_day(db, brief['race_date'], deadline, pool=executor):
                finished += 1
            else:
                break
    return finished


def original_follow_base(db, job, deadline, max_days):
    finished = 0
    # Keep these workers alive across dates to reuse their HTTPS connections.
    with concurrent.futures.ThreadPoolExecutor(max_workers=ORIGINAL_WORKERS) as pool:
        while time.monotonic() < deadline and finished < max_days and db.control()['enabled']:
            index = archive_index(db, job)
            eligible = [r for r in index if r['base_status'] == 'complete' and r['original_status'] not in ('complete','partial') and r['original_attempts'] < 3]
            if eligible:
                finished += collect_original(db, index, deadline, max_days - finished, pool=pool)
            elif any(r['base_status'] != 'complete' and r['base_attempts'] < 3 for r in index):
                time.sleep(2)
            else:
                break
    return finished


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--phase', choices=('auto', 'base', 'original', 'both'), default='auto')
    parser.add_argument('--seconds', type=int, default=1500)
    parser.add_argument('--max-days', type=int, default=250)
    parser.add_argument('--probe-date')
    parser.add_argument('--probe-directory')
    args = parser.parse_args()
    if args.probe_date:
        payload = fetch_base(args.probe_date)
        if args.probe_directory:
            destination = Path(args.probe_directory)
            destination.mkdir(parents=True, exist_ok=True)
            (destination / (args.probe_date + '.json')).write_text(json.dumps(payload, ensure_ascii=False))
        print(json.dumps({'date': args.probe_date, 'audit': payload['parsed']['audit'],
                          'exhibition': len(payload['parsed']['exhibitions'])}))
        return
    db = Database()
    job = db.control()
    if not job['enabled']:
        print('archive is paused')
        return
    index = archive_index(db, job)
    expected = (dt.date.fromisoformat(job['end_date']) - dt.date.fromisoformat(job['start_date'])).days + 1
    if len(index) != expected:
        raise RuntimeError('date queue is incomplete')
    pending_base = any(r['base_status'] != 'complete' and r['base_attempts'] < 3 for r in index)
    phase = ('base' if pending_base else 'original') if args.phase == 'auto' else args.phase
    run_url = 'https://github.com/' + os.environ.get('GITHUB_REPOSITORY', '') + '/actions/runs/' + os.environ.get('GITHUB_RUN_ID', '')
    db.update_control(state='active', phase=phase, run_url=run_url)
    deadline = time.monotonic() + max(30, min(args.seconds, 18000))
    if phase == 'both':
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as coordinators:
            base_future = coordinators.submit(collect_base, db, index, deadline, args.max_days)
            original_future = coordinators.submit(original_follow_base, db, job, deadline, args.max_days)
            count = {'base': base_future.result(), 'original': original_future.result()}
    else:
        count = (collect_base if phase == 'base' else collect_original)(db, index, deadline, args.max_days)
    index = archive_index(db, job)
    pending_base = sum(r['base_status'] != 'complete' and r['base_attempts'] < 3 for r in index)
    pending_original = sum(r['base_status'] == 'complete' and r['original_status'] not in ('complete','partial') and r['original_attempts'] < 3 for r in index)
    active = db.control()['enabled']
    more = active and bool(pending_base or pending_original)
    summary = {'phase': phase, 'finished_days_this_run': count, 'total_days': len(index),
               'base_days_complete': sum(r['base_status'] == 'complete' for r in index),
               'original_days_checked': sum(r['original_status'] in ('complete','partial') for r in index),
               'pending_base': pending_base, 'pending_original': pending_original,
               'base_days_unresolved': sum(r['base_status'] != 'complete' for r in index)}
    db.update_control(state='active' if more else ('checked_with_gaps' if active else 'paused'), last_summary=summary)
    print(json.dumps(summary), flush=True)
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
            output.write(f'more={str(more).lower()}\n')
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as output:
            output.write('## WAKE historical archive\n\n```json\n' + json.dumps(summary, indent=2) + '\n```\n')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Do not expose request headers, credentials, or database response bodies.
        print(f'Archive stopped: {type(error).__name__}: {str(error)[:180]}', flush=True)
        raise SystemExit(1)
