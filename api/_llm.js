/**
 * Provider-agnostic LLM layer.
 *
 * Today: OpenAI for chat + embeddings. The chat provider is swappable via the
 * LLM_PROVIDER env var ("openai" | "anthropic") so the model can be changed
 * later without touching the rest of the app. Embeddings always use OpenAI
 * because the knowledge base was built with OpenAI embeddings — keep them in
 * sync (EMBEDDING_MODEL / EMBEDDING_DIMENSIONS).
 */
import OpenAI from 'openai';

const PROVIDER = process.env.LLM_PROVIDER || 'openai';
export const CHAT_MODEL = process.env.CHAT_MODEL || 'gpt-4o';
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
export const EMBEDDING_DIMENSIONS = Number(process.env.EMBEDDING_DIMENSIONS || 512);

let _openai;
function openai() {
  if (!_openai) {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set');
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openai;
}

/** Embed a single string. Returns number[]. Always OpenAI (matches the KB). */
export async function embed(text) {
  const res = await openai().embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
    dimensions: EMBEDDING_DIMENSIONS,
  });
  return res.data[0].embedding;
}

/**
 * Stream a chat completion. Yields text deltas (strings).
 * @param {{system: string, messages: {role:'user'|'assistant', content:string}[], model?: string}} opts
 */
export async function* streamChat({ system, messages, model }) {
  if (PROVIDER === 'anthropic') {
    yield* streamAnthropic({ system, messages, model });
    return;
  }
  const stream = await openai().chat.completions.create({
    model: model || CHAT_MODEL,
    messages: [{ role: 'system', content: system }, ...messages],
    temperature: 0.2,
    stream: true,
  });
  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) yield delta;
  }
}

// Swap-in path for Claude. Kept lazy so @anthropic-ai/sdk is only needed if used.
async function* streamAnthropic({ system, messages, model }) {
  let Anthropic;
  try {
    ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
  } catch {
    throw new Error('LLM_PROVIDER=anthropic requires `npm i @anthropic-ai/sdk` and ANTHROPIC_API_KEY');
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const stream = await client.messages.create({
    model: model || process.env.ANTHROPIC_CHAT_MODEL || 'claude-opus-4-8',
    max_tokens: 1500,
    system,
    messages,
    stream: true,
  });
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      yield event.delta.text;
    }
  }
}
