import { chromium } from "playwright";

// 江戸川・常滑は現在オリジナル展示が取得できず(常滑はタイム取得機材の故障で
// 一時的、江戸川は元々展示補正なし運用)、AI予想の質が他場と揃わないため
// 夜間キャプチャの対象から除外する。常滑は機材復旧後に戻す想定。
const VENUES = [
  "桐生","戸田","平和島","多摩川","浜名湖","蒲郡","津","三国","びわこ","住之江",
  "尼崎","鳴門","丸亀","児島","宮島","徳山","下関","若松","芦屋","福岡","唐津","大村",
];

const BASE = String(process.env.APP_BASE_URL || "https://newhunaken456.vercel.app").replace(/\/$/, "");
const TOKEN = String(process.env.CAPTURE_TOKEN || "");
const AUTH_SESSION = String(process.env.AUTOMATION_AUTH_SESSION_JSON || "");
const CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.AI_CAPTURE_CONCURRENCY || 2)));

function jstDate() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false,
  }).formatToParts(new Date()).reduce((a, x) => {
    if (x.type !== "literal") a[x.type] = x.value;
    return a;
  }, {});
  // A recovery run queued after midnight still belongs to the previous racing day.
  if (Number(parts.hour === "24" ? "0" : parts.hour) < 3) {
    return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" })
      .format(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  }
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function json(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = {};
  try { data = JSON.parse(text); } catch { /* handled below */ }
  if (!response.ok || !data.ok) throw new Error(`${response.status} ${data.error || text.slice(0, 160)}`);
  return data;
}

async function mapLimit(items, limit, fn) {
  let cursor = 0;
  const output = new Array(items.length);
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try { output[index] = await fn(items[index]); }
      catch (error) { output[index] = { ok: false, ...items[index], error: error?.message || String(error) }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return output;
}

const date = jstDate();
if (!TOKEN) throw new Error("CAPTURE_TOKEN is required");
if (!AUTH_SESSION) throw new Error("AUTOMATION_AUTH_SESSION_JSON is required");
JSON.parse(AUTH_SESSION);

console.log(`nightly AI capture start date=${date}`);

const venueData = await mapLimit(VENUES, 8, async (venue) => {
  const [schedule, manual] = await Promise.all([
    json(`${BASE}/api/yoso?action=schedule&venue=${encodeURIComponent(venue)}&date=${date}`),
    json(`${BASE}/api/yoso?action=manual_winds&venue=${encodeURIComponent(venue)}&date=${date}`),
  ]);
  return { ok: true, venue, schedule: schedule.schedule || [], winds: manual.winds || {}, noRace: !!schedule.noRace };
});

let jobs = [];
const missingWinds = [];
for (const item of venueData) {
  if (!item?.ok || item.noRace) continue;
  for (const row of item.schedule || []) {
    const race = Number(row.race);
    if (!(race >= 1 && race <= 12)) continue;
    const wind = String(item.winds?.[race] || item.winds?.[String(race)] || "").trim();
    if (!wind) {
      missingWinds.push(`${item.venue}${race}R`);
      continue;
    }
    jobs.push({ venue: item.venue, race, wind });
  }
}

// Recovery runs only process races that are not already persisted. This prevents
// 166 successful races from being opened again just to recover two timeouts.
const savedDay = await json(`${BASE}/api/yoso?action=ai_prediction_day&date=${date}`, {
  headers: { "x-capture-token": TOKEN },
});
const savedKeys = new Set((savedDay.items || []).map((row) => `${row.venue}:${Number(row.race_no)}`));
const scheduledTargets = jobs.length;
jobs = jobs.filter((job) => !savedKeys.has(`${job.venue}:${job.race}`));

console.log(`scheduled_targets=${scheduledTargets} already_saved=${scheduledTargets - jobs.length} recovery_targets=${jobs.length} missing_winds=${missingWinds.length}`);
if (missingWinds.length) console.log(`missing winds: ${missingWinds.join(", ")}`);

const browser = await chromium.launch({ headless: true });
try {
  // A small recovery set is processed serially so two heavy pages do not compete
  // for the same upstream/Vercel resources and time out together.
  const effectiveConcurrency = jobs.length <= 4 ? 1 : CONCURRENCY;
  console.log(`capture_concurrency=${effectiveConcurrency}`);
  const results = await mapLimit(jobs, effectiveConcurrency, async (job) => {
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const page = await browser.newPage();
      const diag = { console: [], pageErrors: [], requestFailed: [] };
      page.on("console", (msg) => {
        if (diag.console.length < 40) diag.console.push(`[${msg.type()}] ${msg.text()}`);
      });
      page.on("pageerror", (err) => {
        if (diag.pageErrors.length < 20) diag.pageErrors.push(err?.message || String(err));
      });
      page.on("requestfailed", (req) => {
        if (diag.requestFailed.length < 20) diag.requestFailed.push(`${req.method()} ${req.url()} :: ${req.failure()?.errorText || "?"}`);
      });
      try {
      await page.addInitScript(({ auth }) => {
        localStorage.setItem("hunaken_paid_auth_session_v1", auth);
      }, { auth: AUTH_SESSION });

      let resolveCapture;
      const captured = new Promise((resolve) => { resolveCapture = resolve; });
      await page.exposeFunction("__reportNightlyAi", (payload) => resolveCapture(payload));
      // Use a lightweight same-origin document as the parent. The iframe still receives
      // the saved auth session, while the full React app cannot re-render over the harness.
      await page.goto(`${BASE}/api/runtime-config.js`, { waitUntil: "domcontentloaded", timeout: 60000 });

      const captureToken = `nightly_${Date.now()}_${job.race}_${Math.random().toString(36).slice(2, 9)}`;
      await page.evaluate(({ base, dateValue, venue, race, token }) => {
        window.addEventListener("message", (event) => {
          if (event.origin !== window.location.origin) return;
          if (!["hunaken-ai-batch-ready", "hunaken-ai-batch-error"].includes(event.data?.type)) return;
          window.__reportNightlyAi(event.data);
        }, { once: true });
        document.body.innerHTML = "";
        const frame = document.createElement("iframe");
        frame.src = `${base}/?capture_ai=1&date=${encodeURIComponent(dateValue)}&venue=${encodeURIComponent(venue)}&race=${race}&capture_token=${encodeURIComponent(token)}`;
        frame.style.cssText = "width:100vw;height:100vh;border:0";
        document.body.appendChild(frame);
      }, { base: BASE, dateValue: date, venue: job.venue, race: job.race, token: captureToken });

      let payload;
      try {
        payload = await Promise.race([
          captured,
          new Promise((_, reject) => setTimeout(() => reject(new Error("AI capture timeout")), 100000)),
        ]);
      } catch (raceError) {
        // Timed out: pull whatever diagnostic state the app exposed inside the iframe
        // before we give up, so the log explains WHERE it got stuck (not just that it did).
        let frameStatus = null;
        try {
          const childFrame = page.frames().find((f) => f !== page.mainFrame());
          frameStatus = await childFrame?.evaluate(() => ({
            status: window.__HUNAKEN_AI_CAPTURE_STATUS__ || null,
            readyState: document.readyState,
            bodyText: (document.body?.innerText || "").slice(0, 200),
          }));
        } catch (evalError) {
          frameStatus = { evalError: evalError?.message || String(evalError) };
        }
        console.log(`DIAG ${job.venue}${job.race}R attempt=${attempt} frameStatus=${JSON.stringify(frameStatus)}`);
        if (diag.console.length) console.log(`DIAG ${job.venue}${job.race}R attempt=${attempt} console=${JSON.stringify(diag.console)}`);
        if (diag.pageErrors.length) console.log(`DIAG ${job.venue}${job.race}R attempt=${attempt} pageErrors=${JSON.stringify(diag.pageErrors)}`);
        if (diag.requestFailed.length) console.log(`DIAG ${job.venue}${job.race}R attempt=${attempt} requestFailed=${JSON.stringify(diag.requestFailed)}`);
        throw raceError;
      }
      if (payload?.type !== "hunaken-ai-batch-ready") throw new Error(payload?.error || "AI prediction unavailable");
      if (String(payload.wind || "") !== job.wind) throw new Error(`wind mismatch expected=${job.wind} actual=${payload.wind || "-"}`);

      const saveQuery = new URLSearchParams({
        action: "save_ai_prediction",
        venue: job.venue,
        race: String(job.race),
        date,
      });
      const saved = await json(`${BASE}/api/yoso?${saveQuery}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-capture-token": TOKEN },
        body: JSON.stringify({
          venue: job.venue,
          race: job.race,
          date,
          bets: payload.bets || [],
          ranked: payload.ranked || [],
          modelVersion: `${payload.modelVersion || "nightly-manual-wind-v1"}|wind=${job.wind}`,
        }),
      });
      console.log(`OK ${job.venue}${job.race}R wind=${job.wind} bets=${saved.count || 0}`);
      return { ok: true, ...job, count: Number(saved.count || 0) };
      } catch (error) {
        lastError = error;
        const message = error?.message || String(error);
        // A missing pre-deadline snapshot is a permanent data gap. Retrying cannot
        // reconstruct it after the race, and using current data would contaminate
        // the historical accuracy sample.
        if (message.includes("締切前の凍結データがありません")) {
          console.log(`SKIP ${job.venue}${job.race}R reason=${message}`);
          break;
        }
        if (attempt < 3) {
          console.log(`RETRY ${job.venue}${job.race}R attempt=${attempt + 1}/3 reason=${message}`);
          await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
        }
      } finally {
        await page.close().catch(() => {});
      }
    }
    throw lastError || new Error("AI capture failed after retry");
  });

  const ok = results.filter((x) => x?.ok).length;
  const failures = results.filter((x) => !x?.ok);
  const skipped = failures.filter((x) => String(x?.error || "").includes("締切前の凍結データがありません"));
  const errors = failures.filter((x) => !skipped.includes(x));
  console.log(JSON.stringify({ date, targets: jobs.length, saved: ok, skipped, missingWinds, errors }, null, 2));
  // Missing frozen snapshots are explicitly reported but do not fail the workflow.
  // Unexpected capture failures and missing manually verified winds still do.
  if (errors.length || missingWinds.length) process.exitCode = 1;
} finally {
  await browser.close();
}
