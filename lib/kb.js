// Knowledge base: batched crawl orchestration + per-query retrieval.
//
// The crawl is split into small batches so it never exceeds a serverless
// function's time limit. It is driven on-demand: start the crawl, then call
// "continue" repeatedly until it reports finished (the admin page does this in a
// loop). State lives in KV, so this requires KV to be configured in production.
//
// Storage layout:
//   crawl:job       -> { startedAt, total, processed, queue:[{url,lastmod}], finished }
//   kb:index:new    -> Redis list, index entries appended during a crawl
//   kb:index        -> array of { id, url, title, date, excerpt }  (live, used for retrieval)
//   kb:meta         -> { startedAt, finishedAt, pageCount }
//   page:<id>       -> { id, url, title, date, text }              (full text)

import crypto from 'node:crypto';
import {
  discoverLatestUrls,
  scrapePage,
  normalizeText,
  mapLimit,
  MAX_PAGES,
} from './scraper.js';
import { kvGet, kvSet, kvDel, kvRPush, kvLRange } from './store.js';

const JOB = 'crawl:job';
const INDEX = 'kb:index';
const INDEX_BUILD = 'kb:index:new';
const META = 'kb:meta';

const BATCH = Number(process.env.SCRAPE_BATCH || 10);
const CONCURRENCY = Number(process.env.SCRAPE_CONCURRENCY || 5);
const EXCERPT_CHARS = Number(process.env.KB_EXCERPT_CHARS || 800);
const RETRIEVE_LIMIT = Number(process.env.RETRIEVE_LIMIT || 15);
const LATEST_INCLUDE = Number(process.env.RETRIEVE_LATEST || 5);
const SEND_CHAR_CAP = Number(process.env.SEND_CHAR_CAP || 6000);
const RECENCY_WEIGHT = Number(process.env.RECENCY_WEIGHT || 2);

const idFor = (url) => crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);

// ---------------------------------------------------------------------------
// Crawl
// ---------------------------------------------------------------------------

export async function startCrawl() {
  const urls = await discoverLatestUrls();
  const job = {
    startedAt: Date.now(),
    total: urls.length,
    processed: 0,
    queue: urls.slice(0, MAX_PAGES),
    finished: urls.length === 0,
  };
  await kvDel(INDEX_BUILD);
  await kvSet(JOB, job);
  if (job.finished) {
    // Nothing discovered — keep any existing index rather than wiping it.
    return getCrawlStatus();
  }
  return continueCrawl();
}

export async function continueCrawl() {
  const job = await kvGet(JOB);
  if (!job) throw new Error('No active crawl. Start one first.');
  if (job.finished) return statusFromJob(job);

  const batch = job.queue.slice(0, BATCH);
  await mapLimit(batch, CONCURRENCY, async (item) => {
    try {
      const page = await scrapePage(item.url, item.lastmod);
      if (!page) return;
      const id = idFor(page.url);
      await kvSet(`page:${id}`, { id, ...page });
      await kvRPush(INDEX_BUILD, {
        id,
        url: page.url,
        title: page.title,
        date: page.date,
        excerpt: (page.text || '').slice(0, EXCERPT_CHARS),
      });
    } catch (err) {
      console.error(`crawl page failed (${item.url}):`, err.message);
    }
  });

  job.queue = job.queue.slice(batch.length);
  job.processed += batch.length;
  if (job.queue.length === 0) {
    await finalizeIndex(job);
    job.finished = true;
  }
  await kvSet(JOB, job);
  return statusFromJob(job);
}

async function finalizeIndex(job) {
  const entries = await kvLRange(INDEX_BUILD, 0, -1);
  entries.sort((a, b) => (b.date || 0) - (a.date || 0)); // newest first
  await kvSet(INDEX, entries);
  await kvSet(META, {
    startedAt: job.startedAt,
    finishedAt: Date.now(),
    pageCount: entries.length,
  });
  await kvDel(INDEX_BUILD);
  _idxCache = { ts: 0, data: null };
}

function statusFromJob(job) {
  return {
    running: !job.finished,
    finished: job.finished,
    processed: job.processed,
    total: job.total,
  };
}

export async function getCrawlStatus() {
  const [job, meta] = await Promise.all([kvGet(JOB), kvGet(META)]);
  return {
    running: Boolean(job && !job.finished),
    finished: job ? job.finished : true,
    processed: job ? job.processed : 0,
    total: job ? job.total : 0,
    pageCount: meta ? meta.pageCount : 0,
    lastCrawl: meta ? meta.finishedAt : null,
    startedAt: job ? job.startedAt : null,
  };
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

let _idxCache = { ts: 0, data: null };

async function getIndex() {
  if (_idxCache.data && Date.now() - _idxCache.ts < 60000) return _idxCache.data;
  const data = (await kvGet(INDEX)) || [];
  _idxCache = { ts: Date.now(), data };
  return data;
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'was', 'with', 'this', 'that', 'who', 'what', 'how', 'from',
  'που', 'και', 'για', 'την', 'τον', 'της', 'του', 'στο', 'στη', 'των', 'ειναι', 'ποιος', 'ποιοι',
]);

function queryTerms(q) {
  const all = normalizeText(q).match(/[\p{L}\p{N}]+/gu) || [];
  return [...new Set(all.filter((t) => t.length >= 2 && !STOPWORDS.has(t)))];
}

function keywordScore(entry, terms) {
  const title = normalizeText(entry.title);
  const body = normalizeText(`${entry.title} ${entry.excerpt || ''}`);
  let s = 0;
  for (const t of terms) {
    if (title.includes(t)) s += 3;
    let idx = 0;
    while ((idx = body.indexOf(t, idx)) !== -1) {
      s += 1;
      idx += t.length;
    }
  }
  return s;
}

// Select the most relevant pages for a query: keyword matches (recency-boosted)
// plus the newest few pages always, so "latest news" questions work even when
// no keyword matches. Returns full page text for the selected pages.
export async function retrieveContext(query, opts = {}) {
  const limit = opts.limit || RETRIEVE_LIMIT;
  const latest = opts.latest != null ? opts.latest : LATEST_INCLUDE;

  const index = await getIndex();
  const meta = await kvGet(META);
  if (!index.length) {
    return { pages: [], pageCount: 0, lastCrawl: meta ? meta.finishedAt : null, matched: 0 };
  }

  const terms = queryTerms(query);
  const dated = index.map((e) => e.date).filter(Boolean);
  const minD = dated.length ? Math.min(...dated) : 0;
  const maxD = dated.length ? Math.max(...dated) : 0;
  const span = Math.max(1, maxD - minD);

  const scored = index.map((e) => {
    const kw = terms.length ? keywordScore(e, terms) : 0;
    const recency = e.date ? ((e.date - minD) / span) * RECENCY_WEIGHT : 0;
    return { e, kw, total: kw + recency };
  });

  const matched = scored
    .filter((x) => x.kw > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, limit)
    .map((x) => x.e);

  const newest = [...index]
    .filter((e) => e.date)
    .sort((a, b) => b.date - a.date)
    .slice(0, latest);

  const picked = [];
  const seen = new Set();
  const push = (e) => {
    if (e && !seen.has(e.id)) {
      seen.add(e.id);
      picked.push(e);
    }
  };
  matched.forEach(push);
  newest.forEach(push);
  if (picked.length < limit) {
    for (const e of [...index].sort((a, b) => (b.date || 0) - (a.date || 0))) {
      if (picked.length >= limit) break;
      push(e);
    }
  }

  const pages = [];
  for (const e of picked.slice(0, limit + latest)) {
    const full = await kvGet(`page:${e.id}`);
    pages.push({
      url: e.url,
      title: e.title,
      date: e.date,
      text: ((full && full.text) || e.excerpt || '').slice(0, SEND_CHAR_CAP),
    });
  }

  return {
    pages,
    pageCount: index.length,
    lastCrawl: meta ? meta.finishedAt : null,
    matched: matched.length,
  };
}
