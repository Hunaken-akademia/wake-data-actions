-- Isolated, service-only archives. No change to live WAKE prediction tables.
create table public.wake_history_archive_days (
  race_date date primary key,
  base_status text not null default 'pending' check (base_status in ('pending','complete','unavailable','error')),
  base_attempts integer not null default 0,
  base_payload_gzip_base64 text,
  race_count integer not null default 0,
  result_rows integer not null default 0,
  exhibition_rows integer not null default 0,
  actual_st_rows integer not null default 0,
  parse_missing_rows integer not null default 0,
  b_available boolean not null default false,
  original_status text not null default 'pending' check (original_status in ('pending','running','complete','partial','error')),
  original_cursor integer not null default 0,
  original_payload_gzip_base64 text,
  original_races integer not null default 0,
  original_boat_rows integer not null default 0,
  original_unavailable_races integer not null default 0,
  original_failed_races integer not null default 0,
  start_exhibition_races integer not null default 0,
  original_attempts integer not null default 0,
  last_error text,
  updated_at timestamptz not null default now()
);
alter table public.wake_history_archive_days enable row level security;
revoke all on public.wake_history_archive_days from public, anon, authenticated;
grant select, insert, update on public.wake_history_archive_days to service_role;

create table public.wake_history_archive_control (
  job_id text primary key,
  start_date date not null,
  end_date date not null,
  enabled boolean not null default true,
  state text not null default 'active',
  phase text not null default 'base',
  run_url text,
  last_summary jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  check (end_date >= start_date)
);
alter table public.wake_history_archive_control enable row level security;
revoke all on public.wake_history_archive_control from public, anon, authenticated;
grant select, insert, update on public.wake_history_archive_control to service_role;

insert into public.wake_history_archive_control(job_id,start_date,end_date)
values ('five_year_20261017','2021-10-17','2026-10-16');
insert into public.wake_history_archive_days(race_date)
select d::date from generate_series(date '2021-10-17', date '2026-10-16', interval '1 day') d;

comment on table public.wake_history_archive_days is 'Historical source archive only. K course/ST are race-result values, not exhibition values. Missing original measurements remain missing. Audit before promotion to live tables.';
notify pgrst, 'reload schema';
