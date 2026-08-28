// 公式結果ページから3連単払戻金を復元し、race_payoutsへ保存する。
// 例: node pipeline/backfill_race_payouts.mjs 2026-08-19
//     node pipeline/backfill_race_payouts.mjs 2025-07-07 2025-07-31

const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const APP_URL = String(process.env.PUBLIC_APP_URL || process.env.APP_URL || "https://newhunaken456.vercel.app").replace(/\/$/, "");
const CAPTURE_TOKEN = process.env.CAPTURE_TOKEN || "";
const CONCURRENCY = Math.max(1, Math.min(5, Number(process.env.PAYOUT_CONCURRENCY || 3)));
const args = process.argv.slice(2).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x));
if (!SUPABASE_URL || !SERVICE_KEY) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_KEY が必要です");
const venueByPlace = ["","桐生","戸田","江戸川","平和島","多摩川","浜名湖","蒲郡","常滑","津","三国","びわこ","住之江","尼崎","鳴門","丸亀","児島","宮島","徳山","下関","若松","芦屋","福岡","唐津","大村"];

function datesBetween(from, to) {
  const out = [];
  for (let d = new Date(`${from}T00:00:00Z`), end = new Date(`${to}T00:00:00Z`); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
    if (out.length > 60) throw new Error("1回の範囲は60日以内にしてください");
  }
  return out;
}

async function rest(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : [];
}

async function restWrite(path, method, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text.slice(0, 300)}`);
}

function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

let startDate = args[0] || "";
let endDate = args[1] || args[0] || "";
let automaticState = null;
if (!startDate) {
  const rows = await rest("payout_backfill_state?job_key=eq.historical_trifecta&select=*");
  automaticState = rows[0] || null;
  if (!automaticState) throw new Error("payout_backfill_state がありません");
  startDate = String(automaticState.next_date);
  const proposedEnd = addDays(startDate, Math.max(1, Number(automaticState.batch_days || 7)) - 1);
  endDate = proposedEnd <= automaticState.end_date ? proposedEnd : String(automaticState.end_date);
  if (startDate > automaticState.end_date) {
    console.log(`historical payout backfill already completed through ${automaticState.end_date}`);
    process.exit(0);
  }
  await restWrite("payout_backfill_state?job_key=eq.historical_trifecta", "PATCH", {
    last_started_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
}

async function racesForDate(date) {
  const [results, saved] = await Promise.all([
    rest(`race_results?race_date=eq.${date}&rank=gte.1&rank=lte.3&select=place_no,race_no&order=place_no.asc,race_no.asc`),
    rest(`race_payouts?race_date=eq.${date}&select=place_no,race_no`),
  ]);
  const done = new Set(saved.map((r) => `${r.place_no}:${r.race_no}`));
  const unique = new Map();
  for (const row of results) unique.set(`${row.place_no}:${row.race_no}`, row);
  return [...unique.values()].filter((r) => !done.has(`${r.place_no}:${r.race_no}`));
}

async function capture(date, row) {
  const venue = venueByPlace[Number(row.place_no)];
  const url = `${APP_URL}/api/yoso?action=payout&venue=${encodeURIComponent(venue)}&race=${Number(row.race_no)}&date=${date}`;
  const res = await fetch(url, { headers: { ...(CAPTURE_TOKEN ? { "x-capture-token": CAPTURE_TOKEN } : {}), "user-agent": "WAKE-Payout-Backfill/1.0" } });
  const text = await res.text();
  let body = {};
  try { body = JSON.parse(text); } catch {}
  if (!res.ok && res.status !== 202) throw new Error(`${res.status} ${text.slice(0, 180)}`);
  return { ok: body?.payoutSaved?.ok === true, reason: body?.payoutSaved?.reason || "" };
}

let savedCount = 0;
let pendingCount = 0;
let failedCount = 0;
for (const date of datesBetween(startDate, endDate)) {
  const races = await racesForDate(date);
  console.log(`${date}: 未保存 ${races.length}R`);
  for (let i = 0; i < races.length; i += CONCURRENCY) {
    const chunk = races.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(chunk.map((row) => capture(date, row)));
    settled.forEach((item, index) => {
      const row = chunk[index];
      const label = `${venueByPlace[row.place_no]}${row.race_no}R`;
      if (item.status === "rejected") { failedCount++; console.log(`NG ${date} ${label}: ${item.reason?.message || item.reason}`); }
      else if (item.value.ok) { savedCount++; }
      else { pendingCount++; console.log(`PENDING ${date} ${label}: ${item.value.reason}`); }
    });
  }
}
console.log(`payout backfill done saved=${savedCount} pending=${pendingCount} failed=${failedCount}`);
if (automaticState) {
  await restWrite("payout_backfill_state?job_key=eq.historical_trifecta", "PATCH", {
    next_date: addDays(endDate, 1),
    last_saved: savedCount,
    last_pending: pendingCount,
    last_failed: failedCount,
    last_finished_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  console.log(`historical cursor advanced to ${addDays(endDate, 1)}`);
}
if (failedCount > 0 && savedCount === 0) process.exit(1);
