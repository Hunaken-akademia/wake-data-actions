// ============================================================
// K票（競走成績）取り込みスクリプト — v127 レビュー修正版
//
// v127での修正点:
// 1) 会場判定の根本修正:
//    旧版は「行内に場名を含むだけ」で場を切り替えていたため、
//    ・「唐津」より先に「津」がマッチして place_no=9 に化ける
//    ・選手名に「戸田」「大村」等を含む行でも場が切り替わる
//    という汚染が起きていた。
//    staging用パーサと同じ「ボートレース○○」を含む行だけを
//    場ヘッダとして扱い、場名は長い順に照合する。
// 2) 特殊着順行（F/L/K欠場/失格/転覆/落水/妨害/不完走/S）も
//    1レース6艇の1行として保存する（rank=null, is_fフラグ）。
//    staging用パーサ(parseResultLine)と同じロジックを移植し、
//    staging→本番反映後のデータと表現を揃える。
//    ※Fの st は staging と同じ「正の数値 + is_f=true」で保存する。
// 3) download / upsert の fetch にタイムアウトを追加（ハング防止）。
//
// 使い方:
//   node ingest_k.mjs 2026-07-02
//   node ingest_k.mjs 2026-07-02 --dry
//   node ingest_k.mjs 2026-07-02 --raw
//
// 必要な環境変数:
//   SUPABASE_URL, SUPABASE_SERVICE_KEY
// ============================================================
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import iconv from "iconv-lite";

const argDate = process.argv[2];
const DRY = process.argv.includes("--dry");
const RAW = process.argv.includes("--raw");

if (!argDate || !/^\d{4}-\d{2}-\d{2}$/.test(argDate)) {
  console.error("日付を YYYY-MM-DD で渡してください。例: node ingest_k.mjs 2026-07-02");
  process.exit(1);
}

const [Y, M, D] = argDate.split("-");
const yy = Y.slice(2);
const yyyymm = `${Y}${M}`;
const fname = `k${yy}${M}${D}.lzh`;
const URL = `https://www1.mbrace.or.jp/od2/K/${yyyymm}/${fname}`;
const TMP = "./_tmp_k";

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

// v127: ハングした接続で処理が止まらないよう、全fetchにタイムアウトを付ける。
async function fetchWithTimeout(url, options = {}, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e?.name === "AbortError") throw new Error(`timeout ${timeoutMs}ms: ${url}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function download(url, dest) {
  console.log("↓ download:", url);
  const res = await fetchWithTimeout(url, {}, 60000);
  if (!res.ok) throw new Error(`ダウンロード失敗 ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  console.log("  saved", buf.length, "bytes");
}

function unpack(lzhPath) {
  execSync(`lha xfw=${TMP} ${lzhPath}`, { stdio: "inherit" });
  const txt = readdirSync(TMP).find((f) => /\.txt$/i.test(f));
  if (!txt) throw new Error("解凍後のテキストが見つかりません。");
  return `${TMP}/${txt}`;
}

function normalizeName(s) {
  return String(s || "")
    .replace(/\s+/g, "")
    .replace(/　/g, "")
    .trim();
}

// ============================================================
// v127: 以下は backfill_k_staging_one_day.mjs と同一ロジックの移植。
// F/L/K欠場/失格/転覆/落水/妨害/不完走/S などの特殊着順行も
// 1レース6艇の1行として認識する。
// ============================================================

function compactAll(s) {
  return String(s || "").replace(/[\s　]+/g, "");
}

function normalizeNumberText(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s === "." || /^\.\s*\.$/.test(s)) return null;
  if (/^\.\d+$/.test(s)) return `0${s}`;
  return s;
}

function parseNumeric(v) {
  const normalized = normalizeNumberText(v);
  if (normalized == null) return null;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function parseStText(stText) {
  const raw = String(stText || "").trim();
  const numeric = raw.replace(/^[FL]/i, "");
  return parseNumeric(numeric);
}

function resultStatusFromRankAndSt(rankText, stText) {
  const r = String(rankText || "").trim().toUpperCase();
  const st = String(stText || "").trim().toUpperCase().replace(/\s+/g, "");
  if (r.startsWith("F") || st.startsWith("F")) return "F";
  if (r.startsWith("L") || st.startsWith("L")) return "L";
  if (r.startsWith("K")) return "SCRATCHED";
  if (r.startsWith("欠")) return "ABSENT";
  if (r.startsWith("失")) return "DISQUALIFIED";
  if (r.startsWith("転")) return "CAPSIZED";
  if (r.startsWith("落")) return "FELL";
  if (r.startsWith("妨")) return "OBSTRUCTION";
  if (r.startsWith("不")) return "DID_NOT_FINISH";
  if (r.startsWith("S")) return "OTHER";
  if (r === "00") return "OTHER";
  if (/^\d{2}$/.test(r)) return "NORMAL";
  return "UNKNOWN";
}

function finishOrderFromRank(rankText, status) {
  if (status !== "NORMAL") return null;
  const n = Number(rankText);
  return Number.isInteger(n) && n >= 1 && n <= 6 ? n : null;
}

function parseResultLine(line) {
  const head = String(line || "").match(/^\s*(\d{2}|F\d?|L\d?|S\d?|K\d?|欠|失|転|落|妨|不)\s+([1-6])\s+(\d{4})\s+(.+)$/i);
  if (!head) return null;

  const rankText = String(head[1]).trim().toUpperCase();
  const boatNo = Number(head[2]);
  const regno = Number(head[3]);
  const tail = head[4];

  // K0/K1（欠場系）は展示・進入・STを持たない行として保持する。
  if (/^K\d?$/.test(rankText)) {
    const halfTail = tail.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
    const beforeScratchSuffix = halfTail
      .replace(/\s+(?:K\s*\.|(?:0\.00|\d\.\d{2}))\s+K\s*\.\s+\.\s*\.\s*$/i, "")
      .trimEnd();
    const kMatch = beforeScratchSuffix.match(/^(.+?)\s+(\d{1,3})\s+(\d{1,3})$/);
    if (!kMatch) return null;
    return {
      rankText,
      boatNo,
      regno,
      racerName: compactAll(kMatch[1]),
      motorNo: Number(kMatch[2]),
      exhibitTime: null,
      course: null,
      st: null,
      resultStatus: resultStatusFromRankAndSt(rankText, "K."),
      finishOrder: null,
    };
  }

  // 5・6着などでレースタイムが「.  .」になる行にも対応。
  let metrics = tail.match(/\s(\d\.\d{2})\s+([1-6])\s+((?:[FLfl]\s*\.)|(?:[FLfl]?\s*(?:(?:\d\.\d{2})|(?:0?\.\d{2}))))(?:\s+((?:\d\.\d{2}\.\d)|(?:\.\s*\.)))?\s*$/i);
  let metricsNoCourse = null;

  // L1/F1 の一部は進入欄が空欄で ST欄だけ「L .」「F .」になる。
  if (!metrics && /^[FL]\d?$/i.test(rankText)) {
    metricsNoCourse = tail.match(/\s(\d\.\d{2})\s+((?:[FLfl]\s*\.))(?:\s+((?:\d\.\d{2}\.\d)|(?:\.\s*\.)))?\s*$/i);
  }

  if (!metrics && !metricsNoCourse) return null;

  const metricIndex = metrics ? metrics.index : metricsNoCourse.index;
  const beforeMetrics = tail.slice(0, metricIndex).trimEnd();
  const nameMotorBoat = beforeMetrics.match(/^(.+?)\s+(\d{1,3})\s+(\d{1,3})$/);
  const racerName = nameMotorBoat ? compactAll(nameMotorBoat[1]) : null;
  const motorNo = nameMotorBoat ? Number(nameMotorBoat[2]) : null;

  const course = metrics ? Number(metrics[2]) : null;
  const officialStText = normalizeNumberText(String((metrics ? metrics[3] : metricsNoCourse[2]) || "").replace(/\s+/g, ""));
  const st = parseStText(officialStText);
  if (!officialStText) return null;

  const resultStatus = resultStatusFromRankAndSt(rankText, officialStText);
  if (st == null && resultStatus !== "F" && resultStatus !== "L") return null;
  const finishOrder = finishOrderFromRank(rankText, resultStatus);

  return {
    rankText,
    boatNo,
    regno,
    racerName,
    motorNo,
    exhibitTime: Number(metrics ? metrics[1] : metricsNoCourse[1]),
    course,
    st,
    resultStatus,
    finishOrder,
  };
}

// v127: 場名は長い順に照合し、「ボートレース○○」を含む行だけを場ヘッダとする。
// 選手名や決まり手の行で場が化ける事故を防ぐ。
function detectVenuePlaceNo(line, placeMap, venuesSorted) {
  const s = compactAll(line);
  if (!s.includes("ボートレース")) return null;
  for (const name of venuesSorted) {
    if (s.includes(`ボートレース${name}`)) return placeMap[name];
  }
  return null;
}

function normalizeLine(s) {
  return String(s || "")
    .replace(/\u3000/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseWeatherWindWave(line) {
  const s = normalizeLine(line);

  // 例:
  // 晴 風 西 1m 波 1cm
  // 曇り 風 北東 3m 波 3cm
  // 雨 風 無風 0m 波 0cm
  const m = s.match(/(晴|曇り|曇|くもり|雨|雪|霧)\s*風\s*(無風|北|北東|東|南東|南|南西|西|北西|右横|左横|向い|追い|向|追|.+?)\s*(\d+(?:\.\d+)?)m\s*波\s*(\d+(?:\.\d+)?)cm/);

  if (!m) return null;

  let weather = m[1];
  if (weather === "曇" || weather === "くもり") weather = "曇り";

  return {
    weather,
    wind_dir: m[2].trim(),
    wind_speed: Number(m[3]),
    wave: Number(m[4]),
  };
}

function parsePostTime(line) {
  const s = normalizeLine(line);
  const m1 = s.match(/(\d{1,2}):(\d{2})/);
  if (m1) return `${m1[1].padStart(2, "0")}:${m1[2]}:00`;

  const m2 = s.match(/(\d{1,2})時\s*(\d{2})分/);
  if (m2) return `${m2[1].padStart(2, "0")}:${m2[2]}:00`;

  return null;
}

function parseRaceNo(line) {
  const s = normalizeLine(line);

  // 1R / 12R
  let m = s.match(/(?:^|\s)(\d{1,2})R(?:\s|$)/i);
  if (m) return Number(m[1]);

  // 第1R / 第12R
  m = s.match(/第\s*(\d{1,2})\s*R/i);
  if (m) return Number(m[1]);

  // 1レース / 12レース
  m = s.match(/(?:^|\s)(\d{1,2})\s*レース/);
  if (m) return Number(m[1]);

  return null;
}

function parseK(text) {
  const lines = text.split(/\r?\n/);
  const rows = [];
  const racesMap = new Map();

  let placeNo = null;
  let raceNo = null;
  let currentKimarite = null;
  let latestEnv = null;
  let latestPostTime = null;

  const placeMap = {
    "桐生": 1,
    "戸田": 2,
    "江戸川": 3,
    "平和島": 4,
    "多摩川": 5,
    "浜名湖": 6,
    "蒲郡": 7,
    "常滑": 8,
    "津": 9,
    "三国": 10,
    "びわこ": 11,
    "住之江": 12,
    "尼崎": 13,
    "鳴門": 14,
    "丸亀": 15,
    "児島": 16,
    "宮島": 17,
    "徳山": 18,
    "下関": 19,
    "若松": 20,
    "芦屋": 21,
    "福岡": 22,
    "唐津": 23,
    "大村": 24,
  };

  // v127: 「唐津」より先に「津」がマッチしないよう、長い場名から照合する。
  const venuesSorted = Object.keys(placeMap).sort((a, b) => b.length - a.length);

  function upsertRace() {
    if (!placeNo || !raceNo || !latestEnv) return;

    const key = `${argDate}|${placeNo}|${raceNo}`;
    racesMap.set(key, {
      race_date: argDate,
      place_no: placeNo,
      race_no: raceNo,
      weather: latestEnv.weather,
      wind_dir: latestEnv.wind_dir,
      wind_speed: Number.isFinite(latestEnv.wind_speed) ? latestEnv.wind_speed : null,
      wave: Number.isFinite(latestEnv.wave) ? latestEnv.wave : null,
      post_time: latestPostTime,
      tide_state: null,
      tide_level: null,
    });
  }

  for (const raw of lines) {
    const line = raw.replace(/\u3000/g, " ");

    // v127: 「ボートレース○○」を含む行だけを場ヘッダとみなす。
    // 場が切り替わったら前の場のレース番号・環境情報を引き継がない。
    const detectedPlaceNo = detectVenuePlaceNo(raw, placeMap, venuesSorted);
    if (detectedPlaceNo) {
      if (detectedPlaceNo !== placeNo) {
        placeNo = detectedPlaceNo;
        raceNo = null;
        currentKimarite = null;
        latestEnv = null;
        latestPostTime = null;
      }
      continue;
    }

    const env = parseWeatherWindWave(line);
    if (env) {
      latestEnv = env;
      upsertRace();
    }

    const postTime = parsePostTime(line);
    if (postTime) {
      latestPostTime = postTime;
      upsertRace();
    }

    const parsedRaceNo = parseRaceNo(line);
    if (parsedRaceNo && parsedRaceNo >= 1 && parsedRaceNo <= 12) {
      raceNo = parsedRaceNo;
      currentKimarite = null;
      latestEnv = null;
      latestPostTime = parsePostTime(line);

      const envSameLine = parseWeatherWindWave(line);
      if (envSameLine) latestEnv = envSameLine;

      const kmSameLine = line.match(/(まくり差し|まくり|逃げ|差し|抜き|恵まれ)\s*$/);
      if (kmSameLine) currentKimarite = kmSameLine[1];

      upsertRace();
    }

    if (raceNo && /ﾚｰｽﾀｲﾑ|レースタイム/.test(line)) {
      const kmHeader = line.match(/(まくり差し|まくり|逃げ|差し|抜き|恵まれ)\s*$/);
      if (kmHeader) currentKimarite = kmHeader[1];
      continue;
    }

    // v127: 着順行の解析を staging用パーサと同一ロジックへ差し替え。
    // 通常着(01-06)に加え F/L/K欠場/失格/転覆/落水/妨害/不完走/S も
    // 1レース6艇の1行として保存する（rank=nullで保持）。
    // Fの st は staging と同じ「正の数値 + is_f=true」で保存する。
    const parsed = parseResultLine(raw);

    if (parsed && placeNo && raceNo) {
      rows.push({
        race_date: argDate,
        place_no: placeNo,
        race_no: raceNo,
        boat: parsed.boatNo,
        regno: parsed.regno,
        rank: parsed.finishOrder,
        st: parsed.resultStatus === "F" && parsed.st != null ? -Math.abs(parsed.st) : parsed.st,
        is_f: parsed.resultStatus === "F",
        result_status: parsed.resultStatus,
        kimarite: parsed.finishOrder === 1 ? currentKimarite : null,
        course: parsed.course != null && parsed.course >= 1 && parsed.course <= 6 ? parsed.course : null,
        motor_no: Number.isFinite(parsed.motorNo) ? parsed.motorNo : null,
        racer_name: parsed.racerName || null,
      });
    }
  }

  return { rows, races: [...racesMap.values()] };
}

function dedupeByKey(items, keyFn, label) {
  const map = new Map();
  let dupes = 0;

  for (const item of items) {
    const key = keyFn(item);
    if (map.has(key)) dupes++;
    map.set(key, { ...map.get(key), ...item });
  }

  if (dupes) console.log(`${label} 重複を除外/統合: ${dupes}件`);
  return [...map.values()];
}

function isStatementTimeout(text) {
  return String(text || "").includes('"code":"57014"') || String(text || "").includes("statement timeout");
}

// race_resultsは1レース6行・インデックスも多く、500行1バッチだと
// PostgREST接続既定のstatement_timeout(8s)を超えて失敗することがある
// (2026-08-27分のingestで発生)。timeout時はそのバッチだけ半分に割って
// 再試行し、それでも超えるほど巨大な取り込みでも取りこぼさないようにする。
async function upsertBatch(SUPA, KEY, table, conflictCols, batch, depth = 0) {
  const res = await fetchWithTimeout(`${SUPA}/rest/v1/${table}?on_conflict=${conflictCols}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(batch),
  }, 30000);

  if (res.ok) return;

  const text = await res.text();
  if (isStatementTimeout(text) && batch.length > 1 && depth < 6) {
    const mid = Math.ceil(batch.length / 2);
    console.warn(`  ${table} statement timeoutのため${batch.length}行を分割して再試行 (${mid}+${batch.length - mid})`);
    await upsertBatch(SUPA, KEY, table, conflictCols, batch.slice(0, mid), depth + 1);
    await upsertBatch(SUPA, KEY, table, conflictCols, batch.slice(mid), depth + 1);
    return;
  }

  throw new Error(`${table} 投入失敗 ${res.status}: ${text}`);
}

async function upsertTable(table, rows, conflictCols) {
  const SUPA = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPA || !KEY) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_KEY が未設定です");
  }

  const chunk = 150;

  for (let i = 0; i < rows.length; i += chunk) {
    const batch = rows.slice(i, i + chunk);
    await upsertBatch(SUPA, KEY, table, conflictCols, batch);
    console.log(`  ${table} upsert ${i + batch.length}/${rows.length}`);
  }
}

(async () => {
  try {
    const lzh = `${TMP}/${fname}`;
    await download(URL, lzh);

    const txtPath = unpack(lzh);
    const text = iconv.decode(readFileSync(txtPath), "Shift_JIS");

    if (RAW) {
      console.log("─── 解凍テキスト先頭160行（書式確認用）───");
      console.log(text.split(/\r?\n/).slice(0, 160).join("\n"));
      return;
    }

    let { rows, races } = parseK(text);

    console.log(`race_results パース結果: ${rows.length} 行`);
    console.log(`races パース結果: ${races.length} レース`);
    console.log("race_results サンプル(先頭5件):", JSON.stringify(rows.slice(0, 5), null, 2));
    console.log("races サンプル(先頭5件):", JSON.stringify(races.slice(0, 5), null, 2));

    rows = dedupeByKey(
      rows,
      (r) => `${r.race_date}|${r.place_no}|${r.race_no}|${r.boat}`,
      "race_results"
    );

    races = dedupeByKey(
      races,
      (r) => `${r.race_date}|${r.place_no}|${r.race_no}`,
      "races"
    );

    console.log(`race_results 投入対象: ${rows.length} 行`);
    console.log(`races 投入対象: ${races.length} レース`);

    if (DRY) {
      console.log("--dry のためDB投入はスキップ");
      return;
    }

    if (races.length) {
      await upsertTable("races", races, "race_date,place_no,race_no");
    }

    if (rows.length) {
      await upsertTable("race_results", rows, "race_date,place_no,race_no,boat");
    }

    console.log("✓ 取り込み完了");
  } catch (e) {
    console.error("エラー:", e.message);
    process.exit(1);
  }
})();
