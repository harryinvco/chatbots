// Knowledge base: Firecrawl-driven crawl orchestration + per-query retrieval.
//
// On-demand crawl: submit a Firecrawl job (startCrawl), then poll it repeatedly
// (continueCrawl) until it reports finished — the admin page does this in a
// loop. Firecrawl does the scraping; we ingest its markdown results into the KB.
// State lives in KV, so this requires KV to be configured in production.
//
// Storage layout:
//   crawl:job     -> { id, phase, next, startedAt, total, completed, stored, ... }
//   kb:index:new  -> Redis list, index entries appended while ingesting
//   kb:index      -> array of { id, url, title, date, articleId, excerpt } (live)
//   kb:meta       -> { startedAt, finishedAt, pageCount }
//   page:<id>     -> { id, url, title, date, articleId, text }  (full markdown)

import crypto from 'node:crypto';
import {
  submitCrawl,
  submitCrawlUrls,
  pollCrawl,
  pageFromFirecrawl,
  articleLinksFrom,
  extractId,
  normalizeText,
} from './firecrawl.js';
import { kvGet, kvSet, kvDel, kvRPush, kvLRange } from './store.js';

const JOB = 'crawl:job';
const INDEX = 'kb:index';
const INDEX_BUILD = 'kb:index:new';
const META = 'kb:meta';

const STORE_CHAR_CAP = Number(process.env.KB_STORE_CHARS || 12000);
const EXCERPT_CHARS = Number(process.env.KB_EXCERPT_CHARS || 800);
const RETRIEVE_LIMIT = Number(process.env.RETRIEVE_LIMIT || 15);
const LATEST_INCLUDE = Number(process.env.RETRIEVE_LATEST || 5);
const SEND_CHAR_CAP = Number(process.env.SEND_CHAR_CAP || 6000);
const RECENCY_WEIGHT = Number(process.env.RECENCY_WEIGHT || 2);
const MAX_ERRORS = Number(process.env.CRAWL_MAX_ERRORS || 8);
const TARGET_PAGES = Number(process.env.FIRECRAWL_LIMIT || 300); // overall page ceiling

const idFor = (url) => crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
const keyOf = (url) => String(url).toLowerCase();

// ---------------------------------------------------------------------------
// Crawl (Firecrawl)
// ---------------------------------------------------------------------------

// Submit the Firecrawl job and record it. Ingestion happens in continueCrawl().
export async function startCrawl() {
  const { id, total, urls } = await submitCrawl();
  const job = {
    id,
    phase: 'crawling',
    round: 1,
    next: null,
    startedAt: Date.now(),
    total: total || 0,
    completed: 0,
    stored: 0,
    blocked: 0,
    errors: 0,
    lastError: null,
    seen: (urls || []).map(keyOf), // URLs already submitted (round 1)
    found: [], // article links harvested from scraped pages (round 2 candidates)
    finished: false,
  };
  await kvDel(INDEX_BUILD);
  await kvSet(JOB, job);
  return statusFromJob(job);
}

// One poll/ingest step. While Firecrawl is still scraping we just report
// progress; once complete we page through the results into the index.
export async function continueCrawl() {
  const job = await kvGet(JOB);
  if (!job) throw new Error('No active crawl. Start one first.');
  if (job.finished) return statusFromJob(job);

  try {
    if (job.phase === 'crawling') {
      const r = await pollCrawl(job.id);
      job.total = r.total;
      job.completed = r.completed;
      if (r.status === 'failed' || r.status === 'cancelled') {
        job.lastError = `Firecrawl crawl ${r.status}`;
        job.finished = true; // keep any existing index
        await kvSet(JOB, job);
        return statusFromJob(job);
      }
      if (r.status !== 'completed') {
        await kvSet(JOB, job);
        return statusFromJob(job, 'crawling');
      }
      // Completed — ingest the first result page and move to ingesting.
      await ingest(r.data, job);
      job.next = r.next || null;
      job.phase = 'ingesting';
      if (!job.next) job.finished = await onRoundComplete(job);
      await kvSet(JOB, job);
      return statusFromJob(job);
    }

    // Ingesting phase: follow `next` result pages until exhausted.
    if (job.next) {
      const r = await pollCrawl(job.next);
      await ingest(r.data, job);
      job.next = r.next || null;
    }
    if (!job.next) job.finished = await onRoundComplete(job);
    await kvSet(JOB, job);
    return statusFromJob(job);
  } catch (err) {
    console.error('crawl step failed:', err.message);
    job.errors = (job.errors || 0) + 1;
    job.lastError = err.message;
    if (job.errors >= MAX_ERRORS) job.finished = true; // give up; keep old index
    await kvSet(JOB, job);
    return statusFromJob(job);
  }
}

async function ingest(items, job) {
  const seen = new Set(job.seen || []);
  const found = job.found || [];
  const foundKeys = new Set(found.map(keyOf));
  for (const item of items || []) {
    // Harvest article links from this page for round 2 (recent articles that
    // aren't in the stale sitemap), skipping anything already scheduled.
    for (const link of articleLinksFrom(item)) {
      const k = keyOf(link);
      if (!seen.has(k) && !foundKeys.has(k)) {
        foundKeys.add(k);
        found.push(link);
      }
    }
    const page = pageFromFirecrawl(item);
    if (!page) {
      job.blocked = (job.blocked || 0) + 1;
      continue;
    }
    const text = (page.text || '').slice(0, STORE_CHAR_CAP);
    const id = idFor(page.url);
    await kvSet(`page:${id}`, {
      id,
      url: page.url,
      title: page.title,
      date: page.date,
      articleId: page.id,
      text,
    });
    await kvRPush(INDEX_BUILD, {
      id,
      url: page.url,
      title: page.title,
      date: page.date,
      articleId: page.id || null,
      excerpt: text.slice(0, EXCERPT_CHARS),
    });
    job.stored = (job.stored || 0) + 1;
  }
  job.found = found;
}

// Called when a batch scrape's results are fully ingested. After round 1, if we
// harvested article links not yet scraped, kick off a round-2 batch for the
// newest of them; otherwise finalize. Returns whether the crawl is finished.
async function onRoundComplete(job) {
  if (job.round === 1) {
    const seen = new Set(job.seen || []);
    const candidates = [...new Set(job.found || [])].filter((u) => !seen.has(keyOf(u)));
    // Newest first (higher article id), capped so total stays near the target.
    candidates.sort((a, b) => (extractId(b) || 0) - (extractId(a) || 0));
    const room = Math.max(0, TARGET_PAGES - (job.stored || 0));
    const round2 = candidates.slice(0, room);
    if (round2.length) {
      const { id } = await submitCrawlUrls(round2);
      job.id = id;
      job.round = 2;
      job.phase = 'crawling';
      job.next = null;
      round2.forEach((u) => seen.add(keyOf(u)));
      job.seen = [...seen];
      job.found = [];
      job.total = (job.total || 0) + round2.length;
      return false; // not finished; round 2 begins
    }
  }
  await finalizeIndex(job);
  return true;
}

// Newest first: prefer a parsed date; fall back to the article id (higher =
// newer) since most article pages don't expose a reliable date.
function recencyCmp(a, b) {
  const ad = a.date || 0;
  const bd = b.date || 0;
  if (bd !== ad) return bd - ad;
  return (b.articleId || 0) - (a.articleId || 0);
}

async function finalizeIndex(job) {
  const entries = await kvLRange(INDEX_BUILD, 0, -1);
  await kvDel(INDEX_BUILD);
  if (entries.length === 0) {
    // Crawl produced nothing (e.g. auth/credits failure). Do NOT wipe a
    // previously good index — keep it and flag the failure instead.
    job.empty = true;
    return;
  }
  entries.sort(recencyCmp); // newest first
  await kvSet(INDEX, entries);
  await kvSet(META, {
    startedAt: job.startedAt,
    finishedAt: Date.now(),
    pageCount: entries.length,
  });
  _idxCache = { ts: 0, data: null };
}

function statusFromJob(job, phase) {
  return {
    running: !job.finished,
    finished: Boolean(job.finished),
    phase: phase || (job.finished ? 'done' : job.phase || 'crawling'),
    round: job.round || 1,
    processed: job.stored || 0,
    total: job.total || 0,
    completed: job.completed || 0,
    stored: job.stored || 0,
    blocked: job.blocked || 0,
    errors: job.errors || 0,
    lastError: job.lastError || null,
    empty: Boolean(job.empty),
  };
}

export async function getCrawlStatus() {
  const [job, meta] = await Promise.all([kvGet(JOB), kvGet(META)]);
  return {
    running: Boolean(job && !job.finished),
    finished: job ? Boolean(job.finished) : true,
    phase: job ? (job.finished ? 'done' : job.phase || 'crawling') : 'done',
    processed: job ? job.stored || 0 : 0,
    total: job ? job.total || 0 : 0,
    completed: job ? job.completed || 0 : 0,
    stored: job ? job.stored || 0 : 0,
    blocked: job ? job.blocked || 0 : 0,
    errors: job ? job.errors || 0 : 0,
    lastError: job ? job.lastError || null : null,
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

  // Rank-based recency (0 = newest .. 1 = oldest) so it works whether recency
  // comes from a parsed date or the article id.
  const byRecency = [...index].sort(recencyCmp);
  const rank = new Map(byRecency.map((e, i) => [e.id, i]));
  const denom = Math.max(1, index.length - 1);

  const scored = index.map((e) => {
    const kw = terms.length ? keywordScore(e, terms) : 0;
    const recency = (1 - rank.get(e.id) / denom) * RECENCY_WEIGHT;
    return { e, kw, total: kw + recency };
  });

  const matched = scored
    .filter((x) => x.kw > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, limit)
    .map((x) => x.e);

  const newest = byRecency.slice(0, latest);

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
    for (const e of byRecency) {
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
