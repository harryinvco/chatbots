// Firecrawl-based scraping. Firecrawl (https://firecrawl.dev) crawls the site
// server-side — rendering JS, getting past anti-bot, discovering URLs via the
// sitemap + link following — and returns clean markdown per page. We submit one
// async crawl job and poll it; lib/kb.js ingests the results into the KB.
//
// Uses the REST API directly (no SDK) so there's nothing to keep in sync. The
// base URL is configurable in case you pin a different API version.

const FIRECRAWL_KEY = process.env.FIRECRAWL_API_KEY || '';
const API = (process.env.FIRECRAWL_API_URL || 'https://api.firecrawl.dev/v1').replace(/\/+$/, '');

// What to crawl.
const CRAWL_URL = process.env.FIRECRAWL_CRAWL_URL || 'https://www.icpac.org.cy/selk/';
const LIMIT = Number(process.env.FIRECRAWL_LIMIT || 300);
const MAX_DEPTH = Number(process.env.FIRECRAWL_MAX_DEPTH || 5);
const INCLUDE_PATHS = splitEnv(process.env.FIRECRAWL_INCLUDE_PATHS, '');
const EXCLUDE_PATHS = splitEnv(
  process.env.FIRECRAWL_EXCLUDE_PATHS,
  '[Ss]ecure/,[Uu]ser[Ll]ogin,[Ee]rror[Pp]age,aspxerrorpath,[Ss]itemap\\.aspx,\\.pdf$'
);
const FETCH_TIMEOUT_MS = Number(process.env.FIRECRAWL_TIMEOUT_MS || 30000);

function splitEnv(v, fallback) {
  return String(v ?? fallback ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function normalizeText(s) {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip Latin + Greek diacritics
    .toLowerCase();
}

export function extractId(u) {
  try {
    const v = new URL(u).searchParams.get('id');
    const n = v ? parseInt(v, 10) : NaN;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

const GREEK_MONTHS = {
  ιανουαριου: 1, φεβρουαριου: 2, μαρτιου: 3, απριλιου: 4, μαιου: 5, ιουνιου: 6,
  ιουλιου: 7, αυγουστου: 8, σεπτεμβριου: 9, οκτωβριου: 10, νοεμβριου: 11, δεκεμβριου: 12,
};

function safeDate(y, m, d) {
  if (!y || !m || !d || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const ms = Date.UTC(y, m - 1, d);
  return Number.isNaN(ms) ? null : ms;
}

export function extractDate(text) {
  if (!text) return null;
  let m = text.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (m) return safeDate(+m[1], +m[2], +m[3]);
  m = text.match(/\b(\d{1,2})[/.\-](\d{1,2})[/.\-](20\d{2})\b/);
  if (m) return safeDate(+m[3], +m[2], +m[1]);
  const norm = normalizeText(text);
  m = norm.match(/\b(\d{1,2})\s+([a-zα-ω]+)\s+(20\d{2})\b/);
  if (m && GREEK_MONTHS[m[2]]) return safeDate(+m[3], GREEK_MONTHS[m[2]], +m[1]);
  return null;
}

async function firecrawl(method, pathOrUrl, body) {
  if (!FIRECRAWL_KEY) throw new Error('FIRECRAWL_API_KEY is not configured');
  const url = /^https?:/i.test(pathOrUrl) ? pathOrUrl : API + pathOrUrl;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${FIRECRAWL_KEY}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || (data && data.success === false)) {
      const msg = (data && (data.error || data.message)) || res.statusText;
      throw new Error(`Firecrawl HTTP ${res.status}: ${msg}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// Kick off an async crawl; returns the crawl job id.
export async function submitCrawl() {
  const body = {
    url: CRAWL_URL,
    limit: LIMIT,
    maxDepth: MAX_DEPTH,
    allowBackwardLinks: true,
    scrapeOptions: { formats: ['markdown'], onlyMainContent: true },
  };
  if (INCLUDE_PATHS.length) body.includePaths = INCLUDE_PATHS;
  if (EXCLUDE_PATHS.length) body.excludePaths = EXCLUDE_PATHS;
  const r = await firecrawl('POST', '/crawl', body);
  const id = r.id || r.jobId || (r.data && r.data.id);
  if (!id) throw new Error('Firecrawl did not return a crawl id');
  return id;
}

// Poll a crawl by id, or follow a `next` pagination URL for more result pages.
export async function pollCrawl(idOrNextUrl) {
  const path = /^https?:/i.test(idOrNextUrl) ? idOrNextUrl : `/crawl/${idOrNextUrl}`;
  const r = await firecrawl('GET', path);
  return {
    status: r.status || 'scraping', // scraping | completed | failed | cancelled
    total: r.total || 0,
    completed: r.completed || 0,
    data: Array.isArray(r.data) ? r.data : [],
    next: r.next || null,
  };
}

// Normalise one Firecrawl result item into a storable page, or null to skip.
export function pageFromFirecrawl(item) {
  if (!item) return null;
  const md = item.markdown || (item.content && item.content.markdown) || '';
  const meta = item.metadata || {};
  const url = meta.sourceURL || meta.url || meta.ogUrl || '';
  if (!url || md.length < 80) return null;
  const title = meta.title || meta.ogTitle || url;
  const metaDate =
    meta['article:published_time'] || meta.publishedTime || meta.modifiedTime || meta.date;
  const date = (metaDate && Date.parse(metaDate)) || extractDate(md) || null;
  return { url, title, date, id: extractId(url), text: md };
}
