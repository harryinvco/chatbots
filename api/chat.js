// Chat endpoint. Keeps the same request/response contract the frontends already
// use ({ query, conversation_id, user } -> { answer, conversation_id }) so the
// widget and full-page UI need no changes.
//
// Pipeline: load scraped knowledge base (cached) -> load conversation history ->
// ask Claude (grounded on the scraped content) -> persist the turn.

import Anthropic from '@anthropic-ai/sdk';
import { getKnowledgeBase } from '../lib/scraper.js';
import { getConversation, saveTurn } from '../lib/store.js';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';
const MAX_TOKENS = Number(process.env.ANTHROPIC_MAX_TOKENS || 8000);
const EFFORT = process.env.ANTHROPIC_EFFORT || 'medium'; // low | medium | high | max
const THINKING = (process.env.ANTHROPIC_THINKING || 'adaptive').toLowerCase(); // adaptive | off
const HISTORY_LIMIT = Number(process.env.HISTORY_LIMIT || 20); // messages of context

const PERSONA = `You are the ICPAC AI Assistant for the Institute of Certified Public Accountants of Cyprus — in Greek, ΣΕΛΚ (Σύνδεσμος Εγκεκριμένων Λογιστών Κύπρου). The official website is https://www.icpac.org.cy/selk/ .

You help visitors with questions about ICPAC / ΣΕΛΚ: its latest news, announcements, articles, events, services, membership, professional development, and leadership.

How to answer:
- Ground every factual claim about ICPAC in the SOURCE CONTENT below, which was scraped from the official website (latest news, articles and main topics).
- Many answers are not stated in a single place. When needed, SYNTHESISE across several news items, announcements and articles to build the answer — for example, tracing who has held a role over time by combining an appointment announcement with a later departure announcement. Reason carefully across all the sources before answering.
- When you synthesise, briefly note which announcements/articles the facts came from.
- If the SOURCE CONTENT does not contain the answer, say so honestly, point the user to the relevant part of the website, and suggest contacting ICPAC directly. Never invent names, dates, figures, or announcements.
- Reply in the SAME language as the user's question. Greek question → Greek answer; English question → English answer.
- Be concise, accurate and professional. Use short paragraphs or bullet points.`;

function buildSystem(kb) {
  const blocks = [{ type: 'text', text: PERSONA }];
  if (kb && kb.pages?.length) {
    const parts = kb.pages.map(
      (p, i) => `### Source ${i + 1}: ${p.title || '(untitled)'}\nURL: ${p.url}\n${p.text}`
    );
    const when = new Date(kb.scrapedAt).toISOString();
    blocks.push({
      type: 'text',
      text: `SOURCE CONTENT — scraped from the official ICPAC / ΣΕΛΚ website on ${when} (${kb.pages.length} pages):\n\n${parts.join('\n\n---\n\n')}`,
      // Cache the large, slowly-changing source block to cut cost/latency.
      cache_control: { type: 'ephemeral' },
    });
  } else {
    blocks.push({
      type: 'text',
      text: 'SOURCE CONTENT: unavailable right now — the live website could not be reached. Tell the user the latest details are temporarily unavailable and that they can try again shortly or visit https://www.icpac.org.cy/selk/ directly. Do not fabricate ICPAC specifics.',
    });
  }
  return blocks;
}

function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body;
}

function newConversationId() {
  return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({
      error: 'ANTHROPIC_API_KEY is not configured',
      answer: 'The assistant is not configured yet. Please set the API key.',
    });
  }

  try {
    const body = readBody(req);
    const query = String(body.query || body.message || '').trim();
    const user = String(body.user || 'anonymous');
    let conversationId = String(body.conversation_id || '').trim();

    if (!query) {
      return res.status(400).json({ error: 'Empty query' });
    }
    if (!conversationId) conversationId = newConversationId();

    // 1. Knowledge base (cached; scrapes only on a cold cache).
    let kb = null;
    try {
      kb = await getKnowledgeBase();
    } catch (err) {
      console.error('knowledge base unavailable:', err.message);
    }

    // 2. Prior conversation history (bounded).
    const conv = await getConversation(conversationId);
    const history = (conv?.messages || [])
      .slice(-HISTORY_LIMIT)
      .map((m) => ({ role: m.role, content: m.content }));

    // 3. Ask Claude. Stream internally and collect the final message so long
    //    answers / thinking never trip the HTTP timeout.
    const client = new Anthropic();
    const params = {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      output_config: { effort: EFFORT },
      system: buildSystem(kb),
      messages: [...history, { role: 'user', content: query }],
    };
    if (THINKING !== 'off') params.thinking = { type: 'adaptive' };

    const stream = client.messages.stream(params);
    const final = await stream.finalMessage();
    const answer =
      final.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim() || 'Sorry, I could not generate a response. Please try again.';

    // 4. Persist the turn for the admin history view (best effort).
    try {
      await saveTurn(conversationId, user, query, answer, {
        assistant: { model: final.model, usage: final.usage },
      });
    } catch (err) {
      console.error('failed to persist conversation:', err.message);
    }

    return res.status(200).json({ answer, conversation_id: conversationId });
  } catch (err) {
    console.error('chat error:', err);
    return res.status(500).json({
      error: 'Failed to generate a response',
      answer: 'Sorry, something went wrong. Please try again.',
    });
  }
}
