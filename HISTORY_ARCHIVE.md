# Five-year official source archive

The finite job covers 2021-10-17 through 2026-10-16 inclusive. Today's data is already handled by the existing live collectors.

1. Download one official K (results) and B (race card) LZH file per day.
2. Retain source text, original archive hashes, acquisition time, normalized results, and ordinary exhibition times in compressed, service-only database archives.
3. After the daily sources have been archived, inspect original exhibition feeds per race. Reuse complete original measurements already saved by WAKE. Preserve the raw source and any missing/failed statuses.

`wake_history_archive_days` is a staging archive. No prediction, score, live results, or live exhibition table is changed by this job. Historical source availability does not prove that an identical snapshot was available before the race deadline. K-file course, ST, and weather are result-time values. They must not be used as exhibition course, exhibition ST, or pre-deadline weather.

Original measurements require boat/registration/name agreement. Full and half laps stay distinct. Unknown values remain null. HTTP 401/403/404 are recorded once without trying to bypass the source response. They are availability observations, not proof that a source never existed.

The workflow runs only in the public data repository on the standard Ubuntu runner. It stores no Actions artifacts or caches. Each run checkpoints to Supabase and dispatches the next run only while dates remain. Database, network, and other service costs are separate from GitHub runner minutes.

To pause, set `wake_history_archive_control.enabled = false` for job `five_year_20261017`. To resume, enable it and run the workflow manually. A transport or parser failure stops the workflow visibly; completed day archives and original-feed checkpoints remain intact.

The current phase and cumulative progress are in `wake_history_archive_control.last_summary`. Coverage is measured from day/race counters, not from the earliest archived date. Archive verification and live-table promotion are separate steps.

Validation: `python3 -m unittest discover -s tests -p 'test_history_archive.py' -v`.

## Parallel collector v2

Base archives use eight day workers. Original measurements and exhibition ST use 24 rolling race workers at the same time as base collection; they do not wait for all five years of base data. Recent dates are filled first so useful original measurements are available early.

Workers share independent per-host pacing with a ceiling of eight request starts per second per source. HTTP 429/503 reduces the shared rate and honors Retry-After. HTTPS connections are reused per worker, including the configured network proxy and database connections. Date/race identities prevent duplicate work after out-of-order completion. Only transient failed feeds are retried; successful and unavailable feeds are preserved. Complete original measurements already in WAKE are reused, while the separate exhibition ST source is still checked.
