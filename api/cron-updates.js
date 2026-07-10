// Vercel Cron (11:30 UTC daily): Rupert fills the Mike's Updates feed + job
// boards (separate app: mikesupdates). All logic lives in ./_updates-core.js —
// shared with /api/refresh-updates (the app's pull-to-refresh / 🦚 button).
import { runUpdates } from './_updates-core.js';

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const out = await runUpdates({ scope: 'all' });
    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    console.error('cron-updates', e);
    return res.status(500).json({ error: e.message });
  }
}
