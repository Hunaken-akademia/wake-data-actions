import { createHmac, timingSafeEqual } from "node:crypto";

const ALLOWED_ACTIONS = new Set(["capture", "result", "prerace", "odds_backfill", "exhibition_backfill", "payout_backfill"]);
function target(value) {
  const url = new URL(value, "https://capture.invalid");
  return url.pathname + url.search;
}
function signature(key, timestamp, requestTarget) {
  return createHmac("sha256", key).update("WAKE capture GET\n" + timestamp + "\n" + requestTarget).digest("hex");
}
export function verifyServiceCapture(req, key, now = Date.now()) {
  if (!key || String(req.method || "GET").toUpperCase() !== "GET") return false;
  const requestTarget = target(req.url || "");
  const url = new URL(requestTarget, "https://capture.invalid");
  if (url.pathname !== "/api/yoso" || !ALLOWED_ACTIONS.has(url.searchParams.get("action"))) return false;
  const timestamp = String(req.headers?.["x-wake-capture-time"] || "");
  const supplied = String(req.headers?.["x-wake-capture-signature"] || "");
  if (!/^\d{13}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > 300000 || !/^[a-f0-9]{64}$/.test(supplied)) return false;
  return timingSafeEqual(Buffer.from(supplied, "hex"), Buffer.from(signature(key, timestamp, requestTarget), "hex"));
}
export function serviceCaptureHeaders(url, key, now = Date.now()) {
  if (!key) return {};
  const parsed = new URL(url);
  if (parsed.pathname !== "/api/yoso" || !ALLOWED_ACTIONS.has(parsed.searchParams.get("action"))) return {};
  const timestamp = String(now);
  return { "x-wake-capture-time": timestamp, "x-wake-capture-signature": signature(key, timestamp, target(url)) };
}
export async function captureFetch(url, options = {}) {
  const base = String(process.env.PUBLIC_APP_URL || process.env.APP_URL || process.env.APP_BASE_URL || "https://newhunaken456.vercel.app");
  const method = String(options.method || "GET").toUpperCase();
  const allowedHost = new URL(String(url)).origin === new URL(base).origin;
  const signed = allowedHost && method === "GET"
    ? serviceCaptureHeaders(String(url), String(process.env.SUPABASE_SERVICE_KEY || "")) : {};
  return globalThis.fetch(url, { ...options, headers: { ...options.headers, ...signed } });
}
