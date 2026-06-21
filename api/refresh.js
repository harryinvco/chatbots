// Re-scrapes the website and refreshes the cached knowledge base.
// Runs on a schedule (see "crons" in vercel.json) and can be triggered manually.
//
// Auth: Vercel cron sends `Authorization: Bearer <CRON_SECRET>` when CRON_SECRET
// is set. Manual triggers use `?key=<ADMIN_PASSWORD>`.

import crypto from 'node:crypto';
import { buildKnowledgeBase } from '../lib/scraper.js';

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET || '';
  const adminPw = process.env.ADMIN_PASSWORD || '';
  const auth = req.headers['authorization'] || '';
  const key = String((req.query && req.query.key) || '');

  const okCron = cronSecret && safeEqual(auth, `Bearer ${cronSecret}`);
  const okAdmin = adminPw && safeEqual(key, adminPw);
  if (!okCron && !okAdmin) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const kb = await buildKnowledgeBase();
    return res.status(200).json({
      ok: true,
      scrapedAt: kb.scrapedAt,
      pages: kb.pageCount,
      titles: kb.pages.map((p) => p.title),
    });
  } catch (err) {
    console.error('refresh failed:', err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}
