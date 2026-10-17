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
