const base = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const key = String(process.env.SUPABASE_SERVICE_KEY || '');

if (!base || !key) {
  throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY is required');
}

const periods = [180, 365, 730];
const summary = [];

for (const days of periods) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 14 * 60 * 1000);
  try {
    const response = await fetch(`${base}/rest/v1/rpc/wake_lab_refresh_exhibition_profile_cache`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_days: days }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`refresh ${days}d failed: ${text || response.status}`);
    const rows = text ? JSON.parse(text) : [];
    const result = Array.isArray(rows) ? rows[0] : rows;
    summary.push({ days, ...result });
    console.log(`OK ${days}d rows=${result?.cached_rows ?? 0} through=${result?.calculated_through ?? '-'}`);
  } finally {
    clearTimeout(timer);
  }
}

console.log(JSON.stringify({ ok: true, refreshed: summary }, null, 2));
