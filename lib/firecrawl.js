// Firecrawl-based scraping.
//
// The ICPAC site navigates/paginates with ASP.NET post-backs (not real links)
// and its sitemap lives under /selk/, so letting Firecrawl's crawler discover
// pages on its own finds almost nothing. Instead we discover the URL list
// ourselves — the sitemap(s) + Firecrawl's /map + known section pages + the
// recent year listings — and hand that explicit list to Firecrawl's batch
// scrape, which renders JS / gets past anti-bot and returns clean markdown.
//
// Uses the REST API directly (no SDK). Base URL is configurable.

const FIRECRAWL_KEY = process.env.FIRECRAWL_API_KEY || '';
const API = (process.env.FIRECRAWL_API_URL || 'https://api.firecrawl.dev/v1').replace(/\/+$/, '');

const CRAWL_URL = process.env.FIRECRAWL_CRAWL_URL || 'https://www.icpac.org.cy/selk/';
const LIMIT = Number(process.env.FIRECRAWL_LIMIT || 300);
const YEARS_BACK = Number(process.env.FIRECRAWL_YEARS_BACK || 8);
const FETCH_TIMEOUT_MS = Number(process.env.FIRECRAWL_TIMEOUT_MS || 30000);

const SITEMAP_URLS = splitEnv(
  process.env.FIRECRAWL_SITEMAP_URLS,
  'https://www.icpac.org.cy/selk/sitemap.xml,https://www.icpac.org.cy/sitemap.xml'
);
// Listing pages whose year variants we generate to surface recent articles.
const NEWS_BASES = splitEnv(
  process.env.FIRECRAWL_NEWS_URLS,
  'https://www.icpac.org.cy/selk/news.aspx?catid=1001,https://www.icpac.org.cy/selk/events.aspx?catid=1002,https://www.icpac.org.cy/selk/events.aspx?catid=1003'
);
// Safety net: key section pages, in case the sitemap/map both come back empty.
const SECTION_URLS = splitEnv(
  process.env.FIRECRAWL_SECTION_URLS,
  [
    'https://www.icpac.org.cy/selk/default.aspx',
    'https://www.icpac.org.cy/selk/whoweare.aspx',
    'https://www.icpac.org.cy/selk/president.aspx',
    'https://www.icpac.org.cy/selk/council.aspx',
    'https://www.icpac.org.cy/selk/management.aspx',
    'https://www.icpac.org.cy/selk/committees.aspx',
    'https://www.icpac.org.cy/selk/accountants.aspx',
    'https://www.icpac.org.cy/selk/accountingfirms.aspx',
    'https://www.icpac.org.cy/selk/seminars.aspx',
    'https://www.icpac.org.cy/selk/cpd.aspx',
    'https://www.icpac.org.cy/selk/vacancies.aspx',
    'https://www.icpac.org.cy/selk/laws.aspx',
    'https://www.icpac.org.cy/selk/ethicscode.aspx',
    'https://www.icpac.org.cy/selk/contact.aspx',
  ].join(',')
);

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

function isContentUrl(u) {
  try {
    const url = new URL(u);
    if (!/icpac\.org\.cy$/i.test(url.hostname)) return false;
    if (!/\/selk\//i.test(url.pathname)) return false;
    if (/\.(pdf|jpe?g|png|gif|svg|zip|rar|docx?|xlsx?|pptx?|mp4|mp3|css|js)$/i.test(url.pathname)) {
      return false;
    }
    const p = (url.pathname + url.search).toLowerCase();
    if (/errorpage|userlogin|\/secure\/|sitemap\.aspx|aspxerrorpath/.test(p)) return false;
    return true;
  } catch {
    return false;
  }
}

function parseLocs(xml) {
  return [...String(xml || '').matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) =>
    m[1].replace(/&amp;/g, '&').trim()
  );
}

function generateListingUrls() {
  const out = [];
  const now = new Date().getUTCFullYear();
  for (const base of NEWS_BASES) {
    for (let y = now; y >= now - YEARS_BACK; y--) out.push(withParam(base, 'year', y));
    out.push(withParam(base, 'year', 0));
  }
  return out;
}

function withParam(url, key, value) {
  try {
    const u = new URL(url);
    u.searchParams.set(key, String(value));
    return u.toString();
  } catch {
    return url + (url.includes('?') ? '&' : '?') + key + '=' + value;
  }
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

// Firecrawl /map — quick URL discovery for a site (uses sitemap + crawling).
async function mapSite() {
  try {
    const r = await firecrawl('POST', '/map', { url: CRAWL_URL, limit: LIMIT, ignoreSitemap: false });
    const links = Array.isArray(r.links) ? r.links : [];
    return links.map((l) => (typeof l === 'string' ? l : l && l.url)).filter(Boolean);
  } catch {
    return [];
  }
}

// Fetch raw content of a URL (used for sitemap XML).
async function scrapeRaw(url) {
  const r = await firecrawl('POST', '/scrape', { url, formats: ['rawHtml'] });
  const d = r.data || r;
  return d.rawHtml || d.html || d.markdown || '';
}

// Build the explicit URL list to scrape.
export async function discoverUrls() {
  const set = new Set();
  const add = (u) => {
    if (u && isContentUrl(u)) set.add(u.split('#')[0]);
  };

  // 1. Sitemap(s) — the reliable bulk source of URLs.
  for (const sm of SITEMAP_URLS) {
    try {
      for (const loc of parseLocs(await scrapeRaw(sm))) add(loc);
    } catch {
      /* sitemap not reachable */
    }
  }
  // 2. Firecrawl /map — breadth + any recent links it can find.
  for (const u of await mapSite()) add(u);
  // 3. Recent year listings + key sections (always).
  for (const u of generateListingUrls()) add(u);
  for (const u of SECTION_URLS) add(u);

  return [...set].slice(0, LIMIT);
}

async function submitBatch(urls) {
  // 'links' is requested so we can harvest article links from listing pages
  // (round 2) and scrape the individual recent articles.
  const r = await firecrawl('POST', '/batch/scrape', {
    urls,
    formats: ['markdown', 'links'],
    onlyMainContent: true,
  });
  const id = r.id || r.jobId || (r.data && r.data.id);
  if (!id) throw new Error('Firecrawl did not return a batch scrape id');
  return id;
}

// Round 1: discover URLs and submit them as a Firecrawl batch scrape.
export async function submitCrawl() {
  const urls = await discoverUrls();
  if (!urls.length) {
    throw new Error('Discovered 0 URLs to scrape (check FIRECRAWL_API_KEY and site reachability)');
  }
  const id = await submitBatch(urls);
  return { id, total: urls.length, urls };
}

// Round 2: batch-scrape a specific list of URLs (harvested article links).
export async function submitCrawlUrls(urls) {
  const id = await submitBatch(urls);
  return { id, total: urls.length };
}

// Article links (newdetails/eventdetails?id=) found on a scraped page.
export function articleLinksFrom(item) {
  const links = (item && item.links) || [];
  const out = [];
  for (const l of links) {
    const u = typeof l === 'string' ? l : l && l.url;
    if (u && isContentUrl(u) && /details\.aspx/i.test(u) && extractId(u) != null) {
      out.push(u.split('#')[0]);
    }
  }
  return out;
}

// Poll a batch scrape by id, or follow a `next` pagination URL for more results.
export async function pollCrawl(idOrNextUrl) {
  const path = /^https?:/i.test(idOrNextUrl) ? idOrNextUrl : `/batch/scrape/${idOrNextUrl}`;
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
