// 過去レースの確定オッズ(3連単・全組み合わせ)を復元し、race_odds_backfillへ保存する。
// backfill_race_exhibition.mjsと同じ仕組み。締切後にオッズは変動しないため、
// 確定オッズ=予想時点オッズとして評価差・回収率のバックテストに使える。
//
// ただし公式サイト側の保有期間は日付の単純な締切ではなく、レース単位でばらつく
// ことを実測で確認済み(2025-07中旬〜下旬は同じ日でも場によって有無が分かれた)。
// そのためaction=odds_backfill側で「取得できなかったレース」もstatus=unavailable
// として明示的に記録しており、このスクリプトはrace_odds_backfillに行が無い
// (=未着手の)レースだけを対象にする。
//
// 例: node pipeline/backfill_race_odds.mjs
//     node pipeline/backfill_race_odds.mjs 2025-07-07 2025-08-22

const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const APP_URL = String(process.env.PUBLIC_APP_URL || process.env.APP_URL || "https://newhunaken456.vercel.app").replace(/\/$/, "");
const CAPTURE_TOKEN = process.env.CAPTURE_TOKEN || "";
const CONCURRENCY = Math.max(1, Math.min(12, Number(process.env.ODDS_CONCURRENCY || 8)));
const args = process.argv.slice(2).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x));
if (!SUPABASE_URL || !SERVICE_KEY) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_KEY が必要です");
const venueByPlace = ["", "桐生", "戸田", "江戸川", "平和島", "多摩川", "浜名湖", "蒲郡", "常滑", "津", "三国", "びわこ", "住之江", "尼崎", "鳴門", "丸亀", "児島", "宮島", "徳山", "下関", "若松", "芦屋", "福岡", "唐津", "大村"];

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
// サイレントに欠落し続ける不具合があった。Rangeヘッダーで全件を
// ページングして取得することでこれを回避する。
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

const BATCH_DAYS = Math.max(1, Math.min(60, Number(process.env.ODDS_BATCH_DAYS || 60)));

// race_odds_backfillは「取得できたレース」だけでなく「試みて取得できなかったレース」
// (status=unavailable)も行として残るため、exhibitionと同じ「最古の未カバー日を
// 1日ずつ遡る」方式で永久に足踏みすることはない(unavailableでも行があればその日は
// カバー済みとして扱われ、resolveAutomaticRangeが先へ進める)。
async function resolveAutomaticRange() {
  const today = new Date().toISOString().slice(0, 10);
  const oneYearAgo = addDays(today, -365);
  const [[earliestResult], [earliestOdds]] = await Promise.all([
    rest("race_results?select=race_date&order=race_date.asc&limit=1"),
    rest("race_odds_backfill?select=race_date&order=race_date.asc&limit=1"),
  ]);
  const floor = earliestResult?.race_date || oneYearAgo;
  const coveredFrom = earliestOdds?.race_date || addDays(today, -1);
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
    console.log("historical odds backfill already completed (これ以上遡る範囲がありません)");
    process.exit(0);
  }
  startDate = range.start;
  endDate = range.end;
  console.log(`auto-detected range: ${startDate} 〜 ${endDate}`);
}

async function racesForDate(date) {
  const [results, saved] = await Promise.all([
    restAll(`race_results?race_date=eq.${date}&select=place_no,race_no,boat,result_status&order=place_no.asc,race_no.asc`),
    restAll(`race_odds_backfill?race_date=eq.${date}&select=place_no,race_no,status,odds_count`),
  ]);
  const savedByRace = new Map(saved.map((r) => [`${r.place_no}:${r.race_no}`, r]));
  const unique = new Map();
  for (const row of results) {
    const key = `${row.place_no}:${row.race_no}`;
    if (!unique.has(key)) unique.set(key, { place_no: row.place_no, race_no: row.race_no, boats: new Set() });
    const boat = Number(row.boat);
    const withdrawn = /^(ABSENT|SCRATCHED)$/i.test(String(row.result_status || ""));
    if (!withdrawn && boat >= 1 && boat <= 6) unique.get(key).boats.add(boat);
  }
  return [...unique.entries()].filter(([key, row]) => {
    const savedRow = savedByRace.get(key);
    if (!savedRow) return true;
    if (savedRow.status === "unavailable") return false;
    const boats = row.boats.size;
    const required = boats >= 3 ? boats * (boats - 1) * (boats - 2) : 120;
    return Number(savedRow.odds_count || 0) < required;
  }).map(([, row]) => ({ place_no: row.place_no, race_no: row.race_no }));
}

async function capture(date, row) {
  const venue = venueByPlace[Number(row.place_no)];
  const url = `${APP_URL}/api/yoso?action=odds_backfill&venue=${encodeURIComponent(venue)}&race=${Number(row.race_no)}&date=${date}`;
  const res = await fetch(url, { headers: { ...(CAPTURE_TOKEN ? { "x-capture-token": CAPTURE_TOKEN } : {}), "user-agent": "WAKE-Odds-Backfill/1.0" } });
  const text = await res.text();
  let body = {};
  try { body = JSON.parse(text); } catch {}
  if (!res.ok && res.status !== 202) throw new Error(`${res.status} ${text.slice(0, 180)}`);
  return { ok: body?.oddsSaved?.ok === true, reason: body?.oddsSaved?.reason || "" };
}

let savedCount = 0;
let unavailableCount = 0;
let failedCount = 0;
for (const date of datesBetween(startDate, endDate)) {
  const races = await racesForDate(date);
  console.log(`${date}: 未着手 ${races.length}R`);
  for (let i = 0; i < races.length; i += CONCURRENCY) {
    const chunk = races.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(chunk.map((row) => capture(date, row)));
    settled.forEach((item, index) => {
      const row = chunk[index];
      const label = `${venueByPlace[row.place_no]}${row.race_no}R`;
      if (item.status === "rejected") { failedCount++; console.log(`NG ${date} ${label}: ${item.reason?.message || item.reason}`); }
      else if (item.value.ok) { savedCount++; }
      else { unavailableCount++; }
    });
  }
}
console.log(`odds backfill done saved=${savedCount} unavailable=${unavailableCount} failed=${failedCount}`);
if (failedCount > 0 && savedCount === 0 && unavailableCount === 0) process.exit(1);
