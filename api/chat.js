// Chat endpoint. Keeps the same request/response contract the frontends already
// use ({ query, conversation_id, user } -> { answer, conversation_id }) so the
// widget and full-page UI need no changes.
//
// Pipeline: retrieve the most relevant scraped pages for the question (from the
// ~200-page knowledge base) -> load conversation history -> ask Claude, grounded
// on the retrieved pages -> persist the turn.

import Anthropic from '@anthropic-ai/sdk';
import { retrieveContext } from '../lib/kb.js';
import { getConversation, saveTurn } from '../lib/store.js';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';
const MAX_TOKENS = Number(process.env.ANTHROPIC_MAX_TOKENS || 8000);
const EFFORT = process.env.ANTHROPIC_EFFORT || 'medium'; // low | medium | high | max
const THINKING = (process.env.ANTHROPIC_THINKING || 'adaptive').toLowerCase(); // adaptive | off
const HISTORY_LIMIT = Number(process.env.HISTORY_LIMIT || 20); // messages of context

const PERSONA = `You are the ICPAC AI Assistant for the Institute of Certified Public Accountants of Cyprus — in Greek, ΣΕΛΚ (Σύνδεσμος Εγκεκριμένων Λογιστών Κύπρου). The official website is https://www.icpac.org.cy/selk/ .

You help visitors with questions about ICPAC / ΣΕΛΚ: its latest news, announcements, articles, events, services, membership, professional development, and leadership.

How to answer:
- Ground every factual claim about ICPAC in the SOURCE CONTENT below. It contains the pages from the official website most relevant to the question (and the most recent news), selected from a larger crawl of the site.
- Many answers are not stated in a single place. When needed, SYNTHESISE across several news items, announcements and articles to build the answer — for example, tracing who has held a role over time by combining an appointment announcement with a later departure announcement. Reason carefully across all the sources before answering.
- When you synthesise, briefly note which announcements/articles the facts came from.
- If the SOURCE CONTENT does not contain the answer, say so honestly, point the user to the relevant part of the website, and suggest contacting ICPAC directly. Never invent names, dates, figures, or announcements.
- Reply in the SAME language as the user's question. Greek question → Greek answer; English question → English answer.
- Be concise, accurate and professional. Use short paragraphs or bullet points.`;

function fmtDate(ms) {
  if (!ms) return '';
  try {
    return ` (dated ${new Date(ms).toISOString().slice(0, 10)})`;
  } catch {
    return '';
  }
}

function buildSystem(ctx) {
  const blocks = [{ type: 'text', text: PERSONA }];
  if (ctx && ctx.pages && ctx.pages.length) {
    const parts = ctx.pages.map(
      (p, i) =>
        `### Source ${i + 1}: ${p.title || '(untitled)'}${fmtDate(p.date)}\nURL: ${p.url}\n${p.text}`
    );
    const when = ctx.lastCrawl ? new Date(ctx.lastCrawl).toISOString() : 'unknown';
    blocks.push({
      type: 'text',
      text: `SOURCE CONTENT — ${ctx.pages.length} most relevant pages from the official ICPAC / ΣΕΛΚ website (knowledge base of ${ctx.pageCount} pages, last updated ${when}):\n\n${parts.join('\n\n---\n\n')}`,
      cache_control: { type: 'ephemeral' },
    });
  } else {
    blocks.push({
      type: 'text',
      text: 'SOURCE CONTENT: none available yet — the website content has not been scraped (or could not be reached). Tell the user the latest details are temporarily unavailable and to try again shortly or visit https://www.icpac.org.cy/selk/ directly. Do not fabricate ICPAC specifics.',
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

    // 1. Retrieve the most relevant pages for this question.
    let ctx = null;
    try {
      ctx = await retrieveContext(query);
    } catch (err) {
      console.error('retrieval failed:', err.message);
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
      system: buildSystem(ctx),
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
        assistant: {
          model: final.model,
          usage: final.usage,
          sources: ctx ? ctx.pages.map((p) => p.url) : [],
        },
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
