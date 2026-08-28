// ============================================================
// 補正テーブルJSON更新スクリプト
// 使い方:
//   node build_corrections.mjs          # 365日 / wind K=20
//   node build_corrections.mjs 180 20   # 日数とKを指定
// 必要な環境変数:
//   SUPABASE_URL, SUPABASE_SERVICE_KEY
// ============================================================

const SUPA = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPA || !KEY) {
  console.error("SUPABASE_URL / SUPABASE_SERVICE_KEY が未設定です");
  process.exit(1);
}

const days = Number(process.argv[2] || 365);
const windK = Number(process.argv[3] || 20);

if (!Number.isFinite(days) || days <= 0) throw new Error("days が不正です");
if (!Number.isFinite(windK) || windK < 0) throw new Error("windK が不正です");

async function rpc(name, body) {
  const res = await fetch(`${SUPA}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`${name} 失敗 ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

console.log(`補正テーブル更新 start days=${days} windK=${windK}`);
const result = await rpc("refresh_correction_tables", {
  p_days: days,
  p_wind_k: windK,
});
console.log(JSON.stringify(result, null, 2));
console.log("✓ 補正テーブル更新完了");
