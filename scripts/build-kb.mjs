/**
 * Build the knowledge base from crawled pages (and extracted PDFs).
 *
 *   data/raw/pages.jsonl  ->  chunk  ->  embed (OpenAI)  ->  data/knowledge-base.json
 *
 * Requires OPENAI_API_KEY (in .env or the environment).
 * Run: npm run build:kb
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';
import { loadEnv } from './_env.mjs';

loadEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PAGES_FILE = path.join(ROOT, 'data', 'raw', 'pages.jsonl');
const PDFS_JSONL = path.join(ROOT, 'data', 'raw', 'pdfs.jsonl'); // optional, from extract-pdfs
const OUT_FILE = path.join(ROOT, 'data', 'knowledge-base.json');

const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = Number(process.env.EMBEDDING_DIMENSIONS || 512);
const CHUNK_SIZE = 1200; // characters
const CHUNK_OVERLAP = 150;
const MIN_CHUNK = 80;
const BATCH = 96;

if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is not set. Add it to .env (see .env.example).');
  process.exit(1);
}
if (!fs.existsSync(PAGES_FILE)) {
  console.error('No crawled pages found. Run `npm run crawl` first.');
  process.exit(1);
}
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function cleanTitle(t = '') {
  // Strip the repeated Greek site-name suffix from page titles.
  return t
    .replace(/\s*[-|]\s*Σύνδεσμος Εγκεκριμένων Λογιστών Κύπρου.*$/i, '')
    .replace(/\s*\(ΣΕΛΚ\)\s*\(Cyprus\)\s*$/i, '')
    .trim() || t.trim();
}

function chunkText(text) {
  const out = [];
  const clean = text.replace(/\n{3,}/g, '\n\n').trim();
  if (clean.length <= CHUNK_SIZE) return clean.length >= MIN_CHUNK ? [clean] : [];
  let i = 0;
  while (i < clean.length) {
    let end = Math.min(i + CHUNK_SIZE, clean.length);
    // try to break on a paragraph/sentence boundary near the end
    if (end < clean.length) {
      const slice = clean.slice(i, end);
      const br = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('. '), slice.lastIndexOf('\n'));
      if (br > CHUNK_SIZE * 0.5) end = i + br + 1;
    }
    const piece = clean.slice(i, end).trim();
    if (piece.length >= MIN_CHUNK) out.push(piece);
    if (end >= clean.length) break;
    i = end - CHUNK_OVERLAP;
  }
  return out;
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

async function embedBatch(texts) {
  const res = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
    dimensions: EMBEDDING_DIMENSIONS,
  });
  return res.data.map((d) => d.embedding);
}

async function main() {
  const pages = readJsonl(PAGES_FILE);
  const pdfs = readJsonl(PDFS_JSONL);
  const docs = [...pages, ...pdfs].filter((d) => d && d.text && d.text.length >= MIN_CHUNK);
  console.log(`Loaded ${pages.length} pages + ${pdfs.length} PDFs = ${docs.length} usable docs.`);

  // Build unique chunks (dedupe identical text — kills shared boilerplate).
  const seen = new Set();
  const chunks = [];
  for (const d of docs) {
    const title = cleanTitle(d.title);
    const url = d.finalUrl || d.url;
    for (const piece of chunkText(d.text)) {
      const key = piece.slice(0, 200);
      if (seen.has(key)) continue;
      seen.add(key);
      chunks.push({ id: `c${chunks.length}`, url, title, text: piece });
    }
  }
  console.log(`Prepared ${chunks.length} unique chunks. Embedding (${EMBEDDING_MODEL}, ${EMBEDDING_DIMENSIONS}d)...`);

  for (let i = 0; i < chunks.length; i += BATCH) {
    const slice = chunks.slice(i, i + BATCH);
    const vecs = await embedBatch(slice.map((c) => c.text));
    slice.forEach((c, j) => { c.embedding = vecs[j]; });
    console.log(`  embedded ${Math.min(i + BATCH, chunks.length)}/${chunks.length}`);
  }

  const kb = {
    builtAt: new Date().toISOString(),
    model: EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    chunks,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(kb));
  const mb = (fs.statSync(OUT_FILE).size / 1e6).toFixed(2);
  console.log(`\nWrote ${OUT_FILE} — ${chunks.length} chunks, ${mb} MB.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
