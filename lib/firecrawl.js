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

// The live English site lives under /selk/en/. Content (regulations, news,
// committees) is largely in linked PDFs, which Firecrawl can extract.
const CRAWL_URL = process.env.FIRECRAWL_CRAWL_URL || 'https://www.icpac.org.cy/selk/en/';
const LIMIT = Number(process.env.FIRECRAWL_LIMIT || 300);
const YEARS_BACK = Number(process.env.FIRECRAWL_YEARS_BACK || 8);
const FETCH_TIMEOUT_MS = Number(process.env.FIRECRAWL_TIMEOUT_MS || 30000);

const SITEMAP_URLS = splitEnv(
  process.env.FIRECRAWL_SITEMAP_URLS,
  'https://www.icpac.org.cy/selk/en/sitemap.xml,https://www.icpac.org.cy/selk/sitemap.xml,https://www.icpac.org.cy/sitemap.xml'
);
// Listing pages whose year variants we generate to surface recent articles.
// The Greek /selk/ news listing is where the news PDFs live; include the
// English one too.
const NEWS_BASES = splitEnv(
  process.env.FIRECRAWL_NEWS_URLS,
  'https://www.icpac.org.cy/selk/news.aspx?catid=1001,https://www.icpac.org.cy/selk/en/news.aspx?catid=1001,https://www.icpac.org.cy/selk/events.aspx?catid=1002,https://www.icpac.org.cy/selk/events.aspx?catid=1003'
);
// Base directories used to build news-article (newDetails) URLs for the id
// back-fill — Greek first (news PDFs), then English.
const ARTICLE_BASES = splitEnv(
  process.env.FIRECRAWL_ARTICLE_BASES,
  'https://www.icpac.org.cy/selk/,https://www.icpac.org.cy/selk/en/'
);
// Safety net: key section pages, in case the sitemap/map both come back empty.
const SECTION_URLS = splitEnv(
  process.env.FIRECRAWL_SECTION_URLS,
  [
    'https://www.icpac.org.cy/selk/en/default.aspx',
    'https://www.icpac.org.cy/selk/en/whoweare.aspx',
    'https://www.icpac.org.cy/selk/en/president.aspx',
    'https://www.icpac.org.cy/selk/en/council.aspx',
    'https://www.icpac.org.cy/selk/en/management.aspx',
    'https://www.icpac.org.cy/selk/en/committees.aspx',
    'https://www.icpac.org.cy/selk/en/accountants.aspx',
    'https://www.icpac.org.cy/selk/en/accountingfirms.aspx',
    'https://www.icpac.org.cy/selk/en/seminars.aspx',
    'https://www.icpac.org.cy/selk/en/cpd.aspx',
    'https://www.icpac.org.cy/selk/en/vacancies.aspx',
    'https://www.icpac.org.cy/selk/en/laws.aspx',
    'https://www.icpac.org.cy/selk/en/ethicscode.aspx',
    'https://www.icpac.org.cy/selk/en/regulations.aspx',
    'https://www.icpac.org.cy/selk/news.aspx?catid=1001',
    'https://www.icpac.org.cy/selk/en/news.aspx?catid=1001',
    'https://www.icpac.org.cy/selk/en/contact.aspx',
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

const isPdfUrl = (u) => /\.pdf(\?|#|$)/i.test(String(u));

function isContentUrl(u) {
  try {
    const url = new URL(u);
    if (!/icpac\.org\.cy$/i.test(url.hostname)) return false;
    // PDFs (the real content) are allowed from anywhere on the site.
    if (isPdfUrl(url.pathname)) return true;
    if (!/\/selk\//i.test(url.pathname)) return false;
    if (/\.(jpe?g|png|gif|svg|ico|zip|rar|mp4|mp3|css|js|woff2?|ttf)$/i.test(url.pathname)) {
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
    // rawHtml is included so we can harvest article links even if onlyMainContent
    // strips the listing links from the markdown.
    formats: ['markdown', 'links', 'rawHtml'],
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

// Directory of the crawl URL, e.g. https://…/selk/en/ — used to build canonical
// article URLs so they match the site's actual path (/selk/en/).
const SELK_BASE = (() => {
  try {
    const u = new URL(CRAWL_URL);
    return u.origin + u.pathname.replace(/[^/]*$/, '');
  } catch {
    return 'https://www.icpac.org.cy/selk/en/';
  }
})();

// News-article (newDetails) URLs for an id, one per configured language base.
export function newsArticleUrls(id) {
  return ARTICLE_BASES.map((base) => {
    const b = base.endsWith('/') ? base : base + '/';
    return `${b}newDetails.aspx?id=${id}&catid=1001`;
  });
}

function bigHay(item) {
  return (
    (item.markdown || '') + '\n' + (item.rawHtml || item.html || '') + '\n' +
    JSON.stringify(item.links || [])
  );
}

// Article links found on a scraped page. Scans the markdown, raw HTML and links
// array for the newDetails/eventDetails?id=N pattern (case-insensitive) and
// rebuilds a canonical absolute URL for each.
export function articleLinksFrom(item) {
  if (!item) return [];
  const out = new Map();
  for (const m of bigHay(item).matchAll(/\b(new|event)details\.aspx\?id=(\d+)/gi)) {
    const type = m[1].toLowerCase();
    const catid = type === 'new' ? '1001' : '1002';
    const name = type === 'new' ? 'newDetails' : 'eventDetails';
    const url = `${SELK_BASE}${name}.aspx?id=${m[2]}&catid=${catid}`;
    out.set(url.toLowerCase(), url);
  }
  return [...out.values()];
}

// PDF links found on a scraped page (the real content lives in PDFs). Handles
// absolute and relative hrefs.
export function pdfLinksFrom(item) {
  if (!item) return [];
  const base = (item.metadata && item.metadata.sourceURL) || CRAWL_URL;
  const out = new Map();
  for (const m of bigHay(item).matchAll(/["'(\s]((?:https?:\/\/|\/)?[^"'()\s<>]+?\.pdf)(?:\?[^"'()\s<>]*)?/gi)) {
    let u = m[1];
    try {
      u = new URL(u, base).toString();
    } catch {
      continue;
    }
    if (isPdfUrl(u) && /icpac\.org\.cy$/i.test(new URL(u).hostname)) {
      out.set(u.toLowerCase(), u);
    }
  }
  return [...out.values()];
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

// Detect Cloudflare / anti-bot interstitials so we don't store them as content.
function looksBlocked(text) {
  const head = String(text || '').slice(0, 1500).toLowerCase();
  return (
    /attention required|just a moment|enable javascript and cookies to continue|verify(ing)? you are human|cf-browser-verification|checking your browser before|checking if the site connection is secure/.test(
      head
    )
  );
}

// Normalise one Firecrawl result item into a storable page, or null to skip.
export function pageFromFirecrawl(item) {
  if (!item) return null;
  const md = item.markdown || (item.content && item.content.markdown) || '';
  const meta = item.metadata || {};
  const url = meta.sourceURL || meta.url || meta.ogUrl || '';
  if (!url || md.length < 80 || looksBlocked(md)) return null;
  const title = meta.title || meta.ogTitle || url;
  const metaDate =
    meta['article:published_time'] || meta.publishedTime || meta.modifiedTime || meta.date;
  const date = (metaDate && Date.parse(metaDate)) || extractDate(md) || null;
  return { url, title, date, id: extractId(url), text: md };
}
