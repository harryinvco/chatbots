// Tiny storage layer used for (a) caching the scraped knowledge base and
// (b) persisting chat history for the private admin view.
//
// It talks to an Upstash-compatible Redis REST API (this is what the Vercel KV /
// Upstash marketplace integration provisions). Set KV_REST_API_URL and
// KV_REST_API_TOKEN in your environment. If they are absent, everything falls
// back to a per-instance in-memory map so the app still runs in development —
// but nothing is persisted across cold starts, so chat history needs real KV.

const KV_URL =
  process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const KV_TOKEN =
  process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

export const kvEnabled = Boolean(KV_URL && KV_TOKEN);

// In-memory fallback (ephemeral, per serverless instance).
const memory = new Map();

async function command(args) {
  const res = await fetch(KV_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    throw new Error(`KV ${args[0]} failed: HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.result;
}

export async function kvGet(key) {
  if (!kvEnabled) {
    const v = memory.get(key);
    return v === undefined ? null : v;
  }
  const raw = await command(['GET', key]);
  return raw == null ? null : JSON.parse(raw);
}

export async function kvSet(key, value, ttlSeconds) {
  if (!kvEnabled) {
    memory.set(key, value);
    return;
  }
  const args = ['SET', key, JSON.stringify(value)];
  if (ttlSeconds) args.push('EX', String(ttlSeconds));
  await command(args);
}

export async function kvLPush(key, value) {
  if (!kvEnabled) {
    const arr = memory.get(key) || [];
    arr.unshift(value);
    memory.set(key, arr);
    return;
  }
  await command(['LPUSH', key, JSON.stringify(value)]);
}

export async function kvLRange(key, start, stop) {
  if (!kvEnabled) {
    const arr = memory.get(key) || [];
    const end = stop === -1 ? arr.length : stop + 1;
    return arr.slice(start, end);
  }
  const raw = await command(['LRANGE', key, String(start), String(stop)]);
  return (raw || []).map((s) => JSON.parse(s));
}

export async function kvRPush(key, value) {
  if (!kvEnabled) {
    const arr = memory.get(key) || [];
    arr.push(value);
    memory.set(key, arr);
    return;
  }
  await command(['RPUSH', key, JSON.stringify(value)]);
}

export async function kvDel(key) {
  if (!kvEnabled) {
    memory.delete(key);
    return;
  }
  await command(['DEL', key]);
}

// ---------------------------------------------------------------------------
// Conversation history
// ---------------------------------------------------------------------------

const CONV_TTL_SECONDS = 60 * 60 * 24 * 30; // keep 30 days
const CONV_INDEX = 'conv_index';

export async function getConversation(id) {
  return (await kvGet(`conv:${id}`)) || null;
}

// Append one user message + one assistant reply in a single write.
export async function saveTurn(id, user, userContent, assistantContent, meta = {}) {
  let conv = await getConversation(id);
  const now = Date.now();
  if (!conv) {
    conv = {
      id,
      user: user || 'anonymous',
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    await kvLPush(CONV_INDEX, id);
  }
  conv.messages.push({ role: 'user', content: userContent, ts: now, ...meta.user });
  conv.messages.push({ role: 'assistant', content: assistantContent, ts: now, ...meta.assistant });
  conv.updatedAt = now;
  if (user) conv.user = user;
  await kvSet(`conv:${id}`, conv, CONV_TTL_SECONDS);
  return conv;
}

export async function listConversations(limit = 100) {
  const ids = await kvLRange(CONV_INDEX, 0, limit - 1);
  const seen = new Set();
  const conversations = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const conv = await getConversation(id);
    if (conv) conversations.push(conv);
  }
  conversations.sort((a, b) => b.updatedAt - a.updatedAt);
  return conversations;
}
