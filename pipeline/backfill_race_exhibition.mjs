// 公式beforeinfo（過去日付を指定して再取得可能）から展示タイム・1周・回り足を復元し、
// exhibitionへ保存する。backfill_race_payouts.mjsと同じ仕組み。
// 例: node pipeline/backfill_race_exhibition.mjs 2026-08-19
//     node pipeline/backfill_race_exhibition.mjs 2025-07-07 2025-07-31

const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const APP_URL = String(process.env.PUBLIC_APP_URL || process.env.APP_URL || "https://newhunaken456.vercel.app").replace(/\/$/, "");
const CAPTURE_TOKEN = process.env.CAPTURE_TOKEN || "";
const CONCURRENCY = Math.max(1, Math.min(12, Number(process.env.EXHIBITION_CONCURRENCY || 10)));
const args = process.argv.slice(2).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x));
if (!SUPABASE_URL || !SERVICE_KEY) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_KEY が必要です");
const venueByPlace = ["","桐生","戸田","江戸川","平和島","多摩川","浜名湖","蒲郡","常滑","津","三国","びわこ","住之江","尼崎","鳴門","丸亀","児島","宮島","徳山","下関","若松","芦屋","福岡","唐津","大村"];
// 江戸川はオリジナル展示（一周・まわり足）を持たないため、展示補正の対象外。
const NO_ORIGINAL_DISPLAY_PLACES = new Set([3]);

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

// PostgRESTはdb-max-rows(既定1000件)を超える結果を黙って切り詰める。
// 1日分のrace_resultsは1レース6艇分の行を持つため、開催規模によっては
// 楽に1000件を超え、place_noが大きい場(=order末尾)のレースが
// サイレントに欠落し続ける不具合があった。Rangeヘッダー相当のoffset/limitで
// 全件をページングして取得することでこれを回避する。
const PAGE_SIZE = 1000;
async function restAll(path) {
  const sep = path.includes("?") ? "&" : "?";
  const out = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}${sep}offset=${offset}&limit=${PAGE_SIZE}`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${text.slice(0, 300)}`);
    const page = text ? JSON.parse(text) : [];
    out.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return out;
}

function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const BATCH_DAYS = Math.max(1, Math.min(60, Number(process.env.EXHIBITION_BATCH_DAYS || 60)));

// カーソル用の別テーブルは作らない（SQLエディタでの新規テーブル作成が必要になるため）。
// 代わりに、exhibition側で「今どこまで遡って埋まっているか」を毎回そのまま調べて使う。
// 実運用では「exhibitionはある日から後だけライブ収集されている」状態なので、
// exhibitionの最古日の1日前から、さらに過去へ向かって少しずつ埋めていけば良い。
async function resolveAutomaticRange() {
  const today = new Date().toISOString().slice(0, 10);
  const oneYearAgo = addDays(today, -365);
  const [[earliestResult], [earliestExhibition]] = await Promise.all([
    rest("race_results?select=race_date&order=race_date.asc&limit=1"),
    rest("exhibition?select=race_date&order=race_date.asc&limit=1"),
  ]);
  // race_resultsが無い日まで遡っても展示だけ復元できないので、そこが実質的な下限。
  // 「today - 365日」は実データが無いときのフォールバックに過ぎない。これをfloorの
  // 上限として使うと、実行日が進むたびにfloorが後ろへ這い上がり、earliestResultへ
  // 到達する前に「もう遡る余地がない」と誤判定して止まってしまう(2026-09時点で実測)。
  const floor = earliestResult?.race_date || oneYearAgo;
  const coveredFrom = earliestExhibition?.race_date || addDays(today, -1);
  const end = addDays(coveredFrom, -1);
  if (end < floor) return null; // もう遡る余地なし＝完了
  const start = end < addDays(floor, BATCH_DAYS - 1) ? floor : addDays(end, -(BATCH_DAYS - 1));
  return { start, end };
}

let startDate = args[0] || "";
let endDate = args[1] || args[0] || "";
if (!startDate) {
  const range = await resolveAutomaticRange();
  if (!range) {
    console.log("historical exhibition backfill already completed (これ以上遡る範囲がありません)");
    process.exit(0);
  }
  startDate = range.start;
  endDate = range.end;
  console.log(`auto-detected range: ${startDate} 〜 ${endDate}`);
}

async function racesForDate(date) {
  const [results, saved] = await Promise.all([
    restAll(`race_results?race_date=eq.${date}&select=place_no,race_no&order=place_no.asc,race_no.asc`),
    restAll(`exhibition?race_date=eq.${date}&select=place_no,race_no`),
  ]);
  const done = new Set(saved.map((r) => `${r.place_no}:${r.race_no}`));
  const unique = new Map();
  for (const row of results) {
    if (NO_ORIGINAL_DISPLAY_PLACES.has(Number(row.place_no))) continue;
    unique.set(`${row.place_no}:${row.race_no}`, row);
  }
  return [...unique.values()].filter((r) => !done.has(`${r.place_no}:${r.race_no}`));
}

async function capture(date, row) {
  const venue = venueByPlace[Number(row.place_no)];
  const url = `${APP_URL}/api/yoso?action=exhibition_backfill&venue=${encodeURIComponent(venue)}&race=${Number(row.race_no)}&date=${date}`;
  const res = await fetch(url, { headers: { ...(CAPTURE_TOKEN ? { "x-capture-token": CAPTURE_TOKEN } : {}), "user-agent": "WAKE-Exhibition-Backfill/1.0" } });
  const text = await res.text();
  let body = {};
  try { body = JSON.parse(text); } catch {}
  if (!res.ok && res.status !== 202) throw new Error(`${res.status} ${text.slice(0, 180)}`);
  return { ok: body?.exhibitionSaved?.ok === true, reason: body?.exhibitionSaved?.reason || "" };
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
console.log(`exhibition backfill done saved=${savedCount} pending=${pendingCount} failed=${failedCount}`);
if (failedCount > 0 && savedCount === 0) process.exit(1);
