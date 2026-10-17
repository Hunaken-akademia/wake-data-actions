// Historical archive parser derived from the existing WAKE K-file parser.
// The K-file course and ST are RESULT measurements, never exhibition course/ST.
// Pure parsing only: this module never writes production tables.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
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

export function parseK(text, argDate) {
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
        exhibition_time: parsed.exhibitTime,
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


if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [date, file] = process.argv.slice(2);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !file) throw new Error("date and UTF-8 K file required");
  const raw = readFileSync(file, "utf8");
  const data = parseK(raw, date);
  const expectedRows = raw.split(/\r?\n/).filter(line => /^\s*(?:\d{2}|F\d?|L\d?|S\d?|K\d?|欠|失|転|落|妨|不)\s+[1-6]\s+\d{4}\s+/i.test(line)).length;
  const keys = new Set(data.rows.map(r => [r.race_date,r.place_no,r.race_no,r.boat].join(":")));
  if (keys.size !== data.rows.length) throw new Error("duplicate result identity");
  data.audit = { expected_rows: expectedRows, parsed_rows: data.rows.length, unparsed_rows: expectedRows - data.rows.length };
  process.stdout.write(JSON.stringify(data));
}

