import { spawnSync } from "node:child_process";

const SUPABASE_URL = String(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "").replace(/\/$/, "");
const SERVICE_KEY = String(process.env.SUPABASE_SERVICE_KEY || "");
const APP_URL = String(process.env.PUBLIC_APP_URL || process.env.APP_URL || process.env.APP_BASE_URL || "https://newhunaken456.vercel.app").replace(/\/$/, "");
const CAPTURE_TOKEN = String(process.env.CAPTURE_TOKEN || "");
const TARGET_DATE = String(process.env.WAKE_HEALTH_DATE || process.argv.find((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)) || jstDate()).trim();
const REPAIR = String(process.env.WAKE_HEALTH_REPAIR || "") === "1";
const WRITE_DB = String(process.env.WAKE_HEALTH_WRITE_DB || "1") !== "0";
const GRACE_MIN = Math.max(5, Math.min(60, Number(process.env.WAKE_HEALTH_GRACE_MIN || 15)));
const ODDS_REQUIRED_COUNT = Math.max(1, Number(process.env.WAKE_HEALTH_ODDS_REQUIRED_COUNT || 120));
const REQUIRE_AI = String(process.env.WAKE_HEALTH_REQUIRE_AI || "0") === "1";
const NO_ORIGINAL_DISPLAY_PLACES = new Set([3]);
const SCHEDULE_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.WAKE_HEALTH_SCHEDULE_CONCURRENCY || 6)));

if (!SUPABASE_URL || !SERVICE_KEY) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_KEY が必要です");

const venueByPlace = ["","桐生","戸田","江戸川","平和島","多摩川","浜名湖","蒲郡","常滑","津","三国","びわこ","住之江","尼崎","鳴門","丸亀","児島","宮島","徳山","下関","若松","芦屋","福岡","唐津","大村"];
const placeByVenue = Object.fromEntries(venueByPlace.map((v, i) => [v, i]).filter(([v]) => v));
const headers = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

function jstDate() {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date()).reduce((a, x) => { if (x.type !== "literal") a[x.type] = x.value; return a; }, {});
  return `${p.year}-${p.month}-${p.day}`;
}

function jstNow() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(new Date()).reduce((a, x) => { if (x.type !== "literal") a[x.type] = x.value; return a; }, {});
  const hh = parts.hour === "24" ? "00" : parts.hour;
  return new Date(`${parts.year}-${parts.month}-${parts.day}T${hh}:${parts.minute}:${parts.second}+09:00`);
}

function raceKey(placeNo, raceNo) { return `${Number(placeNo)}:${Number(raceNo)}`; }
function uniq(arr) { return [...new Set(arr)]; }

async function rest(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

async function restAll(path) {
  const out = [];
  const sep = path.includes("?") ? "&" : "?";
  for (let offset = 0; ; offset += 1000) {
    const page = await rest(`${path}${sep}offset=${offset}&limit=1000`);
    const rows = Array.isArray(page) ? page : [];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

async function mapLimit(items, limit, mapper) {
  const list = Array.isArray(items) ? items : [];
  const out = new Array(list.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= list.length) return;
      out[i] = await mapper(list[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), Math.max(1, list.length)) }, () => worker()));
  return out;
}

function hhmmToTime(value) {
  const m = String(value || "").match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  return `${String(Number(m[1])).padStart(2, "0")}:${m[2]}:${m[3] || "00"}`;
}

function postDateTime(date, time) {
  const t = hhmmToTime(time);
  if (!date || !t) return null;
  const d = new Date(`${date}T${t}+09:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function fetchOfficialExpected() {
  const venues = venueByPlace.slice(1);
  const results = await mapLimit(venues, SCHEDULE_CONCURRENCY, async (venue) => {
    try {
      const q = new URLSearchParams({ action: "schedule", venue, date: TARGET_DATE, t: String(Date.now()) });
      const res = await fetch(`${APP_URL}/api/yoso?${q}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      return {
        venue,
        ok: true,
        noRace: data.noRace === true,
        eventDay: String(data.eventDay || ""),
        schedule: Array.isArray(data.schedule) ? data.schedule : [],
      };
    } catch (e) {
      return { venue, ok: false, noRace: false, schedule: [], error: e?.message || String(e) };
    }
  });

  const expected = new Map();
  let usableVenues = 0;
  for (const item of results) {
    if (!item?.ok || item.noRace || !item.schedule.length) continue;
    const placeNo = placeByVenue[item.venue];
    if (!placeNo) continue;
    usableVenues += 1;
    for (const row of item.schedule) {
      const raceNo = Number(row?.race);
      if (!(raceNo >= 1 && raceNo <= 12)) continue;
      const deadline = hhmmToTime(row?.deadline || row?.postTime || row?.time || "");
      const sourceUnavailable = row?.cancelled === true || row?.canceled === true || row?.available === false;
      expected.set(raceKey(placeNo, raceNo), {
        place_no: placeNo,
        race_no: raceNo,
        post_time: deadline,
        sourceUnavailable,
        eventDay: item.eventDay || "",
        scheduleSource: "official_schedule",
      });
    }
  }
  return { expected, usableVenues, errors: results.filter((x) => !x?.ok).map((x) => ({ venue: x.venue, error: x.error })) };
}

function classifyRace({ race, preCount, exCount, snapshotOk, weatherOk, aiOk, oddsCount, resultCount, payoutOk, now, afterRepair = false }) {
  if (race?.officialCancelled === true) {
    return { status: "unavailable", missing: [], reason: "official_cancelled" };
  }
  if (race?.sourceUnavailable || race?.excluded_from_analysis === true) {
    return { status: "unavailable", missing: [], reason: race?.sourceUnavailable ? "source_not_provided" : "excluded_from_analysis" };
  }

  const missing = [];
  if (!race?.dbRace) missing.push("race");
  if (preCount < 6) missing.push("start_list");
  if (!NO_ORIGINAL_DISPLAY_PLACES.has(Number(race?.place_no)) && exCount < 6) missing.push("exhibition");
  if (!snapshotOk) missing.push("snapshot");
  if (!weatherOk) missing.push("weather");
  if (REQUIRE_AI && !aiOk) missing.push("ai");
  const oddsRequiredCount = resultCount >= 3
    ? Math.min(ODDS_REQUIRED_COUNT, resultCount * (resultCount - 1) * (resultCount - 2))
    : ODDS_REQUIRED_COUNT;
  if (oddsCount < oddsRequiredCount) missing.push("odds");
  if (resultCount < 6) missing.push("results");
  if (!payoutOk) missing.push("payout");
  if (!missing.length) return { status: "complete", missing };

  // 公式が「順延・中止・打切」と示すレースで結果自体が存在しない場合は、
  // 取得漏れではなく提供対象外として扱う。途中打切りの日は完走済みレースだけ
  // 通常どおり監査し、未実施レースだけを unavailable に分ける。
  const eventSuspended = /順延|中止|打ち切り|打切/.test(String(race?.eventDay || ""));
  if (eventSuspended && resultCount < 6) {
    return { status: "unavailable", missing: [], reason: "event_suspended" };
  }

  // 取得を再試行しても過去の公式beforeinfoが返さない展示データは、
  // 完走・払戻・オッズまで揃っている場合に限り「提供終了」として分離する。
  // 初回scanではfailureのままにして必ず補修を試し、補修後scanだけで判定する。
  if (afterRepair && resultCount >= 6 && missing.length > 0 && missing.every((part) => part === "exhibition")) {
    return { status: "unavailable", missing: [], reason: "historical_exhibition_unavailable" };
  }

  const post = postDateTime(TARGET_DATE, race?.post_time);
  const today = jstDate();
  if (TARGET_DATE > today) return { status: "pending", missing, reason: "future_date" };
  if (post) {
    const afterGrace = now.getTime() >= post.getTime() + GRACE_MIN * 60000;
    if (TARGET_DATE === today && !afterGrace) return { status: "pending", missing, reason: "before_grace" };
    return { status: "failure", missing, reason: "past_grace" };
  }
  if (TARGET_DATE < today) return { status: "failure", missing, reason: "race_or_post_time_missing" };
  return { status: "pending", missing, reason: "post_time_pending" };
}

async function fetchOfficialCancellationKeys(expectedMap, resultMap) {
  const placeNos = uniq([...expectedMap.values()]
    .filter((row) => (resultMap.get(raceKey(row.place_no, row.race_no))?.size || 0) < 6)
    .map((row) => Number(row.place_no))
    .filter((placeNo) => placeNo >= 1 && placeNo <= 24));
  if (!placeNos.length) return { cancelled: new Set(), errors: [] };

  const hd = TARGET_DATE.replaceAll("-", "");
  const rows = await mapLimit(placeNos, 4, async (placeNo) => {
    const jcd = String(placeNo).padStart(2, "0");
    try {
      const url = `https://www.boatrace.jp/owpc/pc/race/resultlist?hd=${hd}&jcd=${jcd}`;
      const res = await fetch(url, { headers: { "user-agent": "WAKE-DataHealth/1.0" }, cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      const cancelled = [];
      for (let raceNo = 1; raceNo <= 12; raceNo++) {
        const anchor = new RegExp(`raceresult\\?rno=${raceNo}(?:&amp;|&)jcd=${jcd}(?:&amp;|&)hd=${hd}`);
        const start = html.search(anchor);
        if (start < 0) continue;
        const end = html.indexOf("</tbody>", start);
        const block = html.slice(start, end > start ? end : start + 2400);
        if (block.includes("レース中止")) cancelled.push(raceKey(placeNo, raceNo));
      }
      return { placeNo, cancelled, error: null };
    } catch (e) {
      return { placeNo, cancelled: [], error: e?.message || String(e) };
    }
  });

  return {
    cancelled: new Set(rows.flatMap((row) => row.cancelled)),
    errors: rows.filter((row) => row.error).map((row) => ({ placeNo: row.placeNo, error: row.error })),
  };
}

async function scan({ afterRepair = false } = {}) {
  const official = await fetchOfficialExpected();
  const [races, preRace, exhibition, aiRows, reviewRows, oddsRows, results, payouts] = await Promise.all([
    restAll(`races?select=race_date,place_no,race_no,post_time,weather,wind_dir,wind_speed,wave,excluded_from_analysis&race_date=eq.${TARGET_DATE}&order=place_no.asc,race_no.asc`),
    restAll(`pre_race_status?select=place_no,race_no,boat&race_date=eq.${TARGET_DATE}`),
    restAll(`exhibition?select=place_no,race_no,boat&race_date=eq.${TARGET_DATE}`),
    restAll(`ai_prediction_snapshots?select=place_no,race_no,ranked,bets,captured_at&race_date=eq.${TARGET_DATE}`),
    restAll(`race_review_snapshots?select=place_no,race_no,odds_count,odds_t5_count,is_final,captured_at&race_date=eq.${TARGET_DATE}`),
    restAll(`race_odds_backfill?select=place_no,race_no,odds_count,status,fetched_at&race_date=eq.${TARGET_DATE}`),
    restAll(`race_results?select=place_no,race_no,boat,rank,result_status&race_date=eq.${TARGET_DATE}`),
    restAll(`race_payouts?select=place_no,race_no,trifecta_result,trifecta_payout_per_100&race_date=eq.${TARGET_DATE}`),
  ]);

  const raceMap = new Map(races.map((r) => [raceKey(r.place_no, r.race_no), r]));
  const fallbackPlaceNos = uniq([
    ...races, ...preRace, ...exhibition, ...aiRows, ...reviewRows, ...oddsRows, ...results, ...payouts,
  ].map((r) => Number(r?.place_no)).filter((p) => p >= 1 && p <= 24));

  const expectedMap = new Map(official.expected);
  if (!expectedMap.size) {
    for (const placeNo of fallbackPlaceNos) {
      for (let raceNo = 1; raceNo <= 12; raceNo++) expectedMap.set(raceKey(placeNo, raceNo), { place_no: placeNo, race_no: raceNo, scheduleSource: "database_fallback" });
    }
  }
  // DBにだけ存在するレースも監視対象から落とさない。ただし races 1行だけの
  // 孤立データは、順延・中止日に生成された仮レースのことがあるため対象外にする。
  const evidenceKeys = new Set([
    ...preRace, ...exhibition, ...aiRows, ...results, ...payouts,
  ].map((row) => raceKey(row.place_no, row.race_no)));
  for (const r of races) {
    const key = raceKey(r.place_no, r.race_no);
    if (!expectedMap.has(key) && (evidenceKeys.has(key) || !official.expected.size)) {
      expectedMap.set(key, {
        place_no: Number(r.place_no),
        race_no: Number(r.race_no),
        post_time: r.post_time || null,
        scheduleSource: "database_extra",
      });
    }
  }

  const countBoats = (rows) => {
    const map = new Map();
    for (const row of rows) {
      const key = raceKey(row.place_no, row.race_no);
      if (!map.has(key)) map.set(key, new Set());
      const boat = Number(row.boat);
      if (boat >= 1 && boat <= 6) map.get(key).add(boat);
    }
    return map;
  };
  const preMap = countBoats(preRace);
  const exMap = countBoats(exhibition);
  const resultMap = countBoats(results);
  const officialCancellations = await fetchOfficialCancellationKeys(expectedMap, resultMap);

  const aiMap = new Map();
  for (const row of aiRows) {
    const rankedN = Array.isArray(row.ranked) ? row.ranked.length : 0;
    const betsN = Array.isArray(row.bets) ? row.bets.length : 0;
    const key = raceKey(row.place_no, row.race_no);
    aiMap.set(key, aiMap.get(key) === true || (rankedN >= 6 && betsN > 0));
  }
  const reviewMap = new Set(reviewRows.map((row) => raceKey(row.place_no, row.race_no)));
  const oddsMap = new Map();
  const deadlineOddsMap = new Map();
  for (const row of reviewRows) {
    const key = raceKey(row.place_no, row.race_no);
    oddsMap.set(key, Math.max(oddsMap.get(key) || 0, Number(row.odds_count || 0)));
    deadlineOddsMap.set(key, Math.max(deadlineOddsMap.get(key) || 0, Number(row.odds_t5_count || 0)));
  }
  for (const row of oddsRows) {
    const key = raceKey(row.place_no, row.race_no);
    oddsMap.set(key, Math.max(oddsMap.get(key) || 0, Number(row.odds_count || 0)));
  }
  const payoutMap = new Map();
  for (const row of payouts) {
    const key = raceKey(row.place_no, row.race_no);
    const ok = /^[1-6]-[1-6]-[1-6]$/.test(String(row?.trifecta_result || "")) && Number(row?.trifecta_payout_per_100) > 0;
    payoutMap.set(key, payoutMap.get(key) === true || ok);
  }

  const now = jstNow();
  const items = [...expectedMap.values()]
    .sort((a, b) => Number(a.place_no) - Number(b.place_no) || Number(a.race_no) - Number(b.race_no))
    .map((scheduled) => {
      const key = raceKey(scheduled.place_no, scheduled.race_no);
      const dbRace = raceMap.get(key) || null;
      const race = {
        ...scheduled,
        ...(dbRace || {}),
        dbRace: !!dbRace,
        officialCancelled: officialCancellations.cancelled.has(key),
        post_time: dbRace?.post_time || scheduled?.post_time || null,
      };
      const preCount = preMap.get(key)?.size || 0;
      const exCount = exMap.get(key)?.size || 0;
      const snapshotOk = reviewMap.has(key);
      const weatherOk = !!dbRace && !!String(dbRace.weather || "").trim() && dbRace.wind_dir != null && Number.isFinite(Number(dbRace.wind_speed)) && Number.isFinite(Number(dbRace.wave));
      const aiOk = aiMap.get(key) === true;
      const oddsCount = oddsMap.get(key) || 0;
      const deadlineOddsCount = deadlineOddsMap.get(key) || 0;
      const resultCount = resultMap.get(key)?.size || 0;
      const payoutOk = payoutMap.get(key) === true;
      const classified = classifyRace({ race, preCount, exCount, snapshotOk, weatherOk, aiOk, oddsCount, resultCount, payoutOk, now, afterRepair });
      const oddsRequiredCount = resultCount >= 3
        ? Math.min(ODDS_REQUIRED_COUNT, resultCount * (resultCount - 1) * (resultCount - 2))
        : ODDS_REQUIRED_COUNT;
      return {
        target_date: TARGET_DATE,
        place_no: Number(race.place_no),
        race_no: Number(race.race_no),
        venue: venueByPlace[Number(race.place_no)] || String(race.place_no),
        post_time: race.post_time || null,
        status: classified.status,
        missing_parts: classified.missing,
        detail: {
          raceRow: !!dbRace,
          startListCount: preCount,
          exCount,
          exhibitionRequired: !NO_ORIGINAL_DISPLAY_PLACES.has(Number(race.place_no)),
          snapshotOk,
          weatherOk,
          aiRequired: REQUIRE_AI,
          aiOk,
          oddsCount,
          oddsRequiredCount,
          deadlineOddsCount,
          resultCount,
          payoutOk,
          reason: classified.reason || null,
          scheduleSource: race.scheduleSource || null,
        },
      };
    });

  const failures = items.filter((x) => x.status === "failure");
  const summary = {
    targetDate: TARGET_DATE,
    checkedAt: new Date().toISOString(),
    expectedRaces: items.length,
    completeRaces: items.filter((x) => x.status === "complete").length,
    pendingCount: items.filter((x) => x.status === "pending").length,
    failureCount: failures.length,
    unavailableCount: items.filter((x) => x.status === "unavailable").length,
    missingRace: failures.filter((x) => x.missing_parts.includes("race")).length,
    missingStartList: failures.filter((x) => x.missing_parts.includes("start_list")).length,
    missingExhibition: failures.filter((x) => x.missing_parts.includes("exhibition")).length,
    missingSnapshot: failures.filter((x) => x.missing_parts.includes("snapshot")).length,
    missingWeather: failures.filter((x) => x.missing_parts.includes("weather")).length,
    missingOdds: failures.filter((x) => x.missing_parts.includes("odds")).length,
    missingDeadlineOdds: items.filter((x) => x.detail.resultCount >= 3 && x.detail.deadlineOddsCount < x.detail.oddsRequiredCount).length,
    missingAi: failures.filter((x) => x.missing_parts.includes("ai")).length,
    missingResults: failures.filter((x) => x.missing_parts.includes("results")).length,
    missingPayout: failures.filter((x) => x.missing_parts.includes("payout")).length,
    aiRequired: REQUIRE_AI,
    officialSchedule: { usableVenues: official.usableVenues, errorCount: official.errors.length, errors: official.errors.slice(0, 8) },
    officialCancellations: {
      count: officialCancellations.cancelled.size,
      errorCount: officialCancellations.errors.length,
      errors: officialCancellations.errors.slice(0, 8),
    },
  };
  return { summary, items };
}

async function saveRun({ summary, items }) {
  if (!WRITE_DB) return null;
  const rows = await rest("wake_data_health_runs", {
    method: "POST",
    headers: { "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({
      target_date: TARGET_DATE,
      expected_races: summary.expectedRaces,
      complete_races: summary.completeRaces,
      pending_count: summary.pendingCount,
      failure_count: summary.failureCount,
      unavailable_count: summary.unavailableCount,
      missing_exhibition: summary.missingExhibition,
      missing_odds: summary.missingOdds,
      missing_ai: summary.missingAi,
      missing_results: summary.missingResults,
      summary,
    }),
  });
  const run = Array.isArray(rows) ? rows[0] : null;
  if (!run?.id || !items.length) return run;
  for (let i = 0; i < items.length; i += 250) {
    const batch = items.slice(i, i + 250).map((x) => ({ ...x, run_id: run.id }));
    await rest("wake_data_health_items", {
      method: "POST",
      headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify(batch),
    });
  }
  return run;
}

function runRepair(label, command, args, extraEnv = {}) {
  console.log(`[health-repair] ${label}: ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    stdio: "inherit",
    env: { ...process.env, PUBLIC_APP_URL: APP_URL, APP_URL, ...extraEnv },
  });
  if ((result.status ?? 1) !== 0) console.error(`[health-repair] ${label} failed status=${result.status}`);
  return (result.status ?? 1) === 0;
}

async function repairRaceIdentity(items, part) {
  const targets = items.filter((x) => x.status === "failure" && x.missing_parts.includes(part));
  if (!targets.length) return true;
  const results = await mapLimit(targets, 4, async (x) => {
    const params = part === "start_list"
      ? { action: "prerace", venue: x.venue, race: String(x.race_no), date: TARGET_DATE, t: String(Date.now()) }
      : part === "results"
        ? { action: "result", venue: x.venue, race: String(x.race_no), date: TARGET_DATE, t: String(Date.now()) }
        : { action: "capture", venue: x.venue, race: String(x.race_no), date: TARGET_DATE, final: "1", t: String(Date.now()) };
    try {
      const res = await fetch(`${APP_URL}/api/yoso?${new URLSearchParams(params)}`, {
        cache: "no-store",
        headers: CAPTURE_TOKEN ? { "x-capture-token": CAPTURE_TOKEN } : {},
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) throw new Error(data?.error || `HTTP ${res.status}`);
      return true;
    } catch (e) {
      console.error(`[health-repair] ${part} ${x.venue}${x.race_no}R: ${e?.message || e}`);
      return false;
    }
  });
  return results.every(Boolean);
}

async function repairFailures(items) {
  if (!REPAIR) return { attempted: false, parts: [] };
  const failures = items.filter((x) => x.status === "failure");
  const parts = uniq(failures.flatMap((x) => x.missing_parts));
  if (!parts.length) return { attempted: false, parts: [] };
  const results = {};

  // race/start_list は対象レースだけをAPIで再取得する。
  if (parts.includes("race")) results.race = await repairRaceIdentity(failures, "race");
  if (parts.includes("start_list")) results.start_list = await repairRaceIdentity(failures, "start_list");
  if (parts.includes("snapshot")) results.snapshot = await repairRaceIdentity(failures, "snapshot");
  if (parts.includes("weather")) results.weather = await repairRaceIdentity(failures, "weather");
  // その他は既存のパーツ別補修処理を利用する。
  if (parts.includes("exhibition")) results.exhibition = runRepair("exhibition", process.execPath, ["pipeline/backfill_race_exhibition.mjs", TARGET_DATE]);
  if (parts.includes("odds")) results.odds = runRepair("odds", process.execPath, ["pipeline/backfill_race_odds.mjs", TARGET_DATE]);
  if (parts.includes("results")) results.results = await repairRaceIdentity(failures, "results");
  if (parts.includes("payout")) results.payout = runRepair("payout", process.execPath, ["pipeline/backfill_race_payouts.mjs", TARGET_DATE]);
  if (REQUIRE_AI && parts.includes("ai")) results.ai = runRepair("ai", process.execPath, ["pipeline/capture_nightly_ai_predictions.mjs"], {
    AI_CAPTURE_DATE: TARGET_DATE,
    AI_CAPTURE_FORCE_RECAPTURE: "0",
    GITHUB_EVENT_NAME: "workflow_dispatch",
  });
  return { attempted: true, parts, results };
}

const first = await scan();
await saveRun(first);
console.log(`[wake-health] ${TARGET_DATE} expected=${first.summary.expectedRaces} complete=${first.summary.completeRaces} pending=${first.summary.pendingCount} failure=${first.summary.failureCount} unavailable=${first.summary.unavailableCount}`);
console.log(`[wake-health] failures race=${first.summary.missingRace} start=${first.summary.missingStartList} exhibition=${first.summary.missingExhibition} snapshot=${first.summary.missingSnapshot} weather=${first.summary.missingWeather} odds=${first.summary.missingOdds} ai=${first.summary.missingAi} results=${first.summary.missingResults} payout=${first.summary.missingPayout}`);
for (const item of first.items.filter((x) => x.status !== "complete").slice(0, 80)) {
  console.log(`[wake-health:${item.status}] ${item.venue}${item.race_no}R missing=${item.missing_parts.join(",") || "-"} start=${item.detail.startListCount} ex=${item.detail.exCount} snapshot=${item.detail.snapshotOk ? "ok" : "ng"} weather=${item.detail.weatherOk ? "ok" : "ng"} odds=${item.detail.oddsCount} t5=${item.detail.deadlineOddsCount} ai=${item.detail.aiOk ? "ok" : "ng"} result=${item.detail.resultCount} payout=${item.detail.payoutOk ? "ok" : "ng"}`);
}

const repair = await repairFailures(first.items);
if (repair.attempted) {
  const second = await scan({ afterRepair: true });
  await saveRun(second);
  console.log(`[wake-health-after-repair] complete=${second.summary.completeRaces}/${second.summary.expectedRaces} pending=${second.summary.pendingCount} failure=${second.summary.failureCount} unavailable=${second.summary.unavailableCount}`);
}
