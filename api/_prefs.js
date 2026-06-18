// Shared timing/quiet-hours helpers for the cron pushers. All hours are Eastern.
export const etHour = (dt = new Date()) =>
  +new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(dt) % 24;

// The Eastern hour the user wants the morning brief/check-in (Settings → briefHour).
export function briefHour(settings, def = 7) {
  const h = settings && settings.briefHour;
  return Number.isInteger(h) ? h : def;
}

// True if `dt` falls inside the user's quiet-hours window (handles wrap past midnight).
export function inQuietHours(settings, dt = new Date()) {
  if (!settings) return false;
  const s = settings.quietStart, e = settings.quietEnd;
  if (s == null || e == null || s === '' || e === '') return false;
  if (s === e) return false;
  const h = etHour(dt);
  return s < e ? (h >= s && h < e) : (h >= s || h < e);
}
