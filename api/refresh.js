// Drives the on-demand Firecrawl re-crawl of the website.
//
//   GET /api/refresh?action=start     -> discover latest URLs + scrape first batch
//   GET /api/refresh?action=continue  -> scrape the next batch
//   GET /api/refresh?action=status    -> crawl progress + KB stats
//
// Each call processes only a small batch so it stays under the function time
// limit; the admin page calls start then continue in a loop until finished.
//
// Auth: `x-admin-key` header or `?key=` query param (= ADMIN_PASSWORD). Vercel
// cron's `Authorization: Bearer <CRON_SECRET>` is also accepted if you ever add
// a schedule.

import crypto from 'node:crypto';
import { startCrawl, continueCrawl, getCrawlStatus } from '../lib/kb.js';

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function authorized(req) {
  const cronSecret = process.env.CRON_SECRET || '';
  const adminPw = process.env.ADMIN_PASSWORD || '';
  const auth = req.headers['authorization'] || '';
  const key = String(req.headers['x-admin-key'] || (req.query && req.query.key) || '');
  if (cronSecret && safeEqual(auth, `Bearer ${cronSecret}`)) return true;
  if (adminPw && safeEqual(key, adminPw)) return true;
  return false;
}

export default async function handler(req, res) {
  if (!process.env.ADMIN_PASSWORD && !process.env.CRON_SECRET) {
    return res.status(500).json({ error: 'ADMIN_PASSWORD is not configured' });
  }
  if (!authorized(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const action = String((req.query && req.query.action) || 'start').toLowerCase();

  try {
    let status;
    if (action === 'status') {
      status = await getCrawlStatus();
    } else if (action === 'continue') {
      status = await continueCrawl();
    } else {
      status = await startCrawl();
    }
    return res.status(200).json({ ok: true, action, ...status });
  } catch (err) {
    console.error('refresh failed:', err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}
