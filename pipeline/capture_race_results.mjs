// ============================================================
// 全開催場の確定結果（着順・実ST・進入・決まり手・F）をSupabaseへ保存する。
// Vercelの /api/yoso?action=result を叩き、同じレースはupsertで欠損補修する。
// v118: Supabase空本文対応・ST1艇欠損許容・0件保存時は失敗終了。
// ============================================================

import fs from "node:fs";

const BASE_URL = (process.env.PUBLIC_APP_URL || process.env.APP_URL || "https://newhunaken456.vercel.app").replace(/\/$/, "");
const argDate = process.argv.find((x) => /^\d{4}-\d{2}-\d{2}$/.test(x));
const DRY = process.argv.includes("--dry");
const YESTERDAY = process.argv.includes("--yesterday");
const CAPTURE_TOKEN = process.env.CAPTURE_TOKEN || "";
const CONCURRENCY = Math.min(6, Math.max(1, Number(process.env.RESULT_CAPTURE_CONCURRENCY || 4)));
const REQUEST_TIMEOUT_MS = Math.max(10000, Number(process.env.RESULT_CAPTURE_TIMEOUT_MS || 45000));

function jstDate(offsetDays = 0) {
  const now = new Date(Date.now() + offsetDays * 86400000);
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now).reduce((a, p) => {
    if (p.type !== "literal") a[p.type] = p.value;
    return a;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

const date = argDate || jstDate(YESTERDAY ? -1 : 0);
const venues = [
  "桐生","戸田","江戸川","平和島","多摩川","浜名湖","蒲郡","常滑","津","三国","びわこ","住之江",
  "尼崎","鳴門","丸亀","児島","宮島","徳山","下関","若松","芦屋","福岡","唐津","大村"
];

const headers = {
  "user-agent": "HunakenRaceResultCapture/1.1",
  ...(CAPTURE_TOKEN ? { "x-capture-token": CAPTURE_TOKEN } : {}),
};

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    if (!res.ok || json?.ok === false) {
      throw new Error(`${res.status} ${json?.error || text.slice(0, 240)}`);
    }
    return json || {};
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`request timeout ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function getRaceNumbers(venue) {
  const url = `${BASE_URL}/api/yoso?action=schedule&venue=${encodeURIComponent(venue)}&date=${date}`;
  if (DRY) {
    console.log(`[dry schedule] ${url}`);
    return Array.from({ length: 12 }, (_, i) => i + 1);
  }
  const data = await getJson(url);
  const nums = (Array.isArray(data.schedule) ? data.schedule : [])
    .map((r) => Number(r?.race || r?.race_no || r))
    .filter((r) => r >= 1 && r <= 12);
  return [...new Set(nums)];
}

async function captureOne(venue, race) {
  const url = `${BASE_URL}/api/yoso?action=result&venue=${encodeURIComponent(venue)}&race=${race}&date=${date}`;
  if (DRY) {
    console.log(`[dry result] ${url}`);
    return { completed: false, dry: true };
  }
  return await getJson(url);
}

async function captureWithRetry(venue, race) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const data = await captureOne(venue, race);
      return { venue, race, data, error: null };
    } catch (error) {
      if (attempt < 2) {
        await sleep(1000);
        continue;
      }
      return { venue, race, data: null, error };
    }
  }
  return { venue, race, data: null, error: new Error("unknown capture error") };
}

function appendSummary(stats) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const lines = [
    `## race_results capture ${date}`,
    "",
    `- parser: v118-empty-body-partial-st`,
    `- concurrency: ${CONCURRENCY}`,
    `- venues held: ${stats.venuesHeld}`,
    `- saved races: ${stats.savedRaces}`,
    `- saved rows: ${stats.savedRows}`,
    `- pending races: ${stats.pendingRaces}`,
    `- failed races: ${stats.failedRaces}`,
    "",
  ];
  fs.appendFileSync(file, lines.join("\n"), "utf8");
}

console.log(`race_results capture start date=${date} base=${BASE_URL} dry=${DRY} yesterday=${YESTERDAY} concurrency=${CONCURRENCY}`);

let venuesHeld = 0;
let savedRaces = 0;
let pendingRaces = 0;
let failedRaces = 0;
let savedRows = 0;

for (const venue of venues) {
  let races = [];
  try {
    races = await getRaceNumbers(venue);
  } catch (error) {
    console.log(`SCHEDULE NG ${venue}: ${error.message || error} / 1〜12Rを直接確認します`);
    races = Array.from({ length: 12 }, (_, i) => i + 1);
  }

  if (!races.length) {
    console.log(`SKIP ${venue}: 未開催`);
    continue;
  }
  venuesHeld++;

  for (let i = 0; i < races.length; i += CONCURRENCY) {
    const chunk = races.slice(i, i + CONCURRENCY);
    const results = await Promise.all(chunk.map((race) => captureWithRetry(venue, race)));

    for (const item of results) {
      const { race, data, error } = item;
      if (error) {
        console.log(`NG ${venue}${race}R ${error.message || error}`);
        failedRaces++;
        continue;
      }
      if (DRY) continue;

      if (data.completed) {
        const count = Number(data.resultSaved?.count || data.rowsCount || 0);
        const partial = data.partialSt ? ` PARTIAL_ST missing=${(data.missingStBoats || []).join(",") || "?"}` : "";
        console.log(`SAVED ${venue}${race}R rows=${count} ST=${data.stCount ?? "?"} F=${data.fCount ?? "?"}${partial} 決まり手=${data.kimarite || "-"} parser=${data.parserVersion || data.appVersion || "?"}`);
        savedRaces++;
        savedRows += count;
      } else {
        const diag = [
          data.reason || "結果未確定",
          data.resultHtmlLength != null ? `html=${data.resultHtmlLength}` : "",
          data.resultPageHasResultText != null ? `hasResultText=${data.resultPageHasResultText}` : "",
          data.parserVersion ? `parser=${data.parserVersion}` : "",
        ].filter(Boolean).join(" ");
        console.log(`PENDING ${venue}${race}R ${diag}`);
        pendingRaces++;
      }
    }

    await sleep(250);
  }
}

const stats = { venuesHeld, savedRaces, savedRows, pendingRaces, failedRaces };
console.log(`race_results capture done date=${date} venuesHeld=${venuesHeld} savedRaces=${savedRaces} savedRows=${savedRows} pending=${pendingRaces} failed=${failedRaces}`);
appendSummary(stats);

if (!DRY && savedRaces === 0 && (pendingRaces > 0 || failedRaces > 0)) {
  console.error("保存0件のため失敗終了します。Actionsの緑完了と実データ保存を混同しないための安全策です。");
  process.exit(2);
}
if (!DRY && failedRaces > 0 && savedRaces === 0) process.exit(1);

