// Private admin API for viewing chat history.
//   GET /api/admin            -> list recent conversations
//   GET /api/admin?id=<id>    -> one full conversation
// Auth: send the admin password as `x-admin-key` header or `?key=` query param.

import crypto from 'node:crypto';
import { listConversations, getConversation, kvEnabled } from '../lib/store.js';

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export default async function handler(req, res) {
  const adminPw = process.env.ADMIN_PASSWORD || '';
  if (!adminPw) {
    return res.status(500).json({ error: 'ADMIN_PASSWORD is not configured' });
  }

  const provided = String(
    req.headers['x-admin-key'] || (req.query && req.query.key) || ''
  );
  if (!safeEqual(provided, adminPw)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const id = String((req.query && req.query.id) || '');
    if (id) {
      const conversation = await getConversation(id);
      if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
      return res.status(200).json({ conversation });
    }

    const limit = Math.min(Number((req.query && req.query.limit) || 100) || 100, 500);
    const conversations = await listConversations(limit);
    return res.status(200).json({
      storage: kvEnabled ? 'kv' : 'memory (not persisted — configure KV)',
      count: conversations.length,
      conversations,
    });
  } catch (err) {
    console.error('admin error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}
