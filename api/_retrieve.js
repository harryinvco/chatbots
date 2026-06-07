/**
 * Knowledge-base retrieval. Loads the prebuilt KB (chunks + embeddings) once,
 * embeds the incoming query, and returns the top-k most similar passages with
 * their source URLs for grounding + citation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { embed } from './_llm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KB_PATH = path.join(__dirname, '..', 'data', 'knowledge-base.json');

let _kb = null;
function kb() {
  if (!_kb) {
    if (!fs.existsSync(KB_PATH)) {
      throw new Error('Knowledge base not found. Run `npm run crawl` then `npm run build:kb`.');
    }
    _kb = JSON.parse(fs.readFileSync(KB_PATH, 'utf8'));
  }
  return _kb;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/**
 * @param {string} query
 * @param {number} k
 * @returns {Promise<{passages: {url,title,text,score}[]}>}
 */
export async function retrieve(query, k = 6) {
  const data = kb();
  const qv = await embed(query);
  const scored = data.chunks.map((c) => ({ ...c, score: cosine(qv, c.embedding) }));
  scored.sort((a, b) => b.score - a.score);
  const passages = scored.slice(0, k).map(({ url, title, text, score }) => ({ url, title, text, score }));
  return { passages };
}

export function kbStats() {
  const data = kb();
  return { chunks: data.chunks.length, model: data.model, dimensions: data.dimensions, builtAt: data.builtAt };
}
