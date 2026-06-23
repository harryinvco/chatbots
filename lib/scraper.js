// Low-level scraping for the ICPAC / ΣΕΛΚ website via ScraperAPI.
//
// Responsibilities:
//   - fetch a URL through ScraperAPI (gets past the site's Cloudflare wall)
//   - parse a page into { title, text, links }
//   - parse sitemaps
//   - discover the LATEST content URLs (sitemap lastmod first, then news links)
//
// The actual crawl orchestration + retrieval lives in lib/kb.js.

import * as cheerio from 'cheerio';

const SCRAPER_KEY = process.env.SCRAPERAPI_KEY || '';

export const MAX_PAGES = Number(process.env.SCRAPE_MAX_PAGES || 200);
export const STORE_CHAR_CAP = Number(process.env.SCRAPE_MAX_CHARS || 9000);
const FETCH_TIMEOUT_MS = Number(process.env.SCRAPE_TIMEOUT_MS || 35000);

const SEED_URLS = splitEnv(
  process.env.SCRAPE_SEED_URLS,
  'https://www.icpac.org.cy/selk/default.aspx'
);
// News / events listing pages. Their article links (newdetails.aspx?id=,
// eventdetails.aspx?id=) are the "latest" content; we also follow their year
// filters to reach further back. Higher id = newer.
const NEWS_URLS = splitEnv(
  process.env.SCRAPE_NEWS_URLS,
  [
    'https://www.icpac.org.cy/selk/news.aspx?catid=1001',
    'https://www.icpac.org.cy/selk/events.aspx?catid=1002',
    'https://www.icpac.org.cy/selk/events.aspx?catid=1003',
  ].join(',')
);
const DISCOVERY_CONCURRENCY = Number(process.env.SCRAPE_CONCURRENCY || 5);
// How many years of listings to generate per category (news.aspx?...&year=YYYY).
// The site pages its archive via JS post-backs, so we generate the year URLs
// (which work as plain GETs) instead of relying on the dropdown/pager links.
const YEARS_BACK = Number(process.env.SCRAPE_YEARS_BACK || 12);
// Optional explicit sitemap URLs; otherwise derived from the seed origin.
const SITEMAP_URLS = splitEnv(process.env.SCRAPE_SITEMAP_URLS, '');

function splitEnv(v, fallback) {
  return String(v || fallback || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function bool(v, fallback = false) {
  if (v === undefined || v === null || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(v));
}

export function normalizeText(s) {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip Latin + Greek diacritics
    .toLowerCase();
}

function scraperApiUrl(target) {
  const params = new URLSearchParams({ api_key: SCRAPER_KEY, url: target });
  if (bool(process.env.SCRAPE_PREMIUM, true)) params.set('premium', 'true');
  if (bool(process.env.SCRAPE_RENDER, false)) params.set('render', 'true');
  if (bool(process.env.SCRAPE_ULTRA_PREMIUM, false)) params.set('ultra_premium', 'true');
  if (process.env.SCRAPE_COUNTRY) params.set('country_code', process.env.SCRAPE_COUNTRY);
  return `https://api.scraperapi.com/?${params.toString()}`;
}

export async function fetchViaScraperApi(target) {
  if (!SCRAPER_KEY) throw new Error('SCRAPERAPI_KEY is not configured');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(scraperApiUrl(target), { signal: controller.signal });
    if (!res.ok) throw new Error(`ScraperAPI HTTP ${res.status} for ${target}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export function looksBlocked(html) {
  if (!html) return true;
  const head = html.slice(0, 4000).toLowerCase();
  return (
    head.includes('attention required') ||
    head.includes('cf-browser-verification') ||
    head.includes('just a moment') ||
    head.includes('enable javascript and cookies to continue')
  );
}

export function normalizeUrl(u) {
  try {
    const url = new URL(u);
    return (url.origin + url.pathname + url.search).toLowerCase();
  } catch {
    return String(u).toLowerCase();
  }
}

// Numeric article id from ...details.aspx?id=N — the site's recency signal.
export function extractId(u) {
  try {
    const v = new URL(u).searchParams.get('id');
    const n = v ? parseInt(v, 10) : NaN;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

const isArticleUrl = (u) => /details\.aspx/i.test(u) && extractId(u) != null;

// Listing / navigation pages (news.aspx?catid=, ...&year=): harvested for links
// but not stored as content. Articles (id=) and plain info pages are kept.
function isListingUrl(u) {
  let q = '';
  try {
    q = new URL(u).search.toLowerCase();
  } catch {
    return false;
  }
  return /[?&](catid|year)=/.test(q) && !/[?&]id=/.test(q);
}

function absolutize(href, base) {
  if (!href) return null;
  if (/^(mailto:|tel:|javascript:|#|data:)/i.test(href)) return null;
  try {
    return new URL(href, base).toString().split('#')[0];
  } catch {
    return null;
  }
}

export function isContentLink(u) {
  try {
    const url = new URL(u);
    if (!/(^|\.)icpac\.org\.cy$/i.test(url.hostname)) return false;
    if (!/\/selk\//i.test(url.pathname)) return false;
    if (/\.(pdf|jpe?g|png|gif|svg|zip|rar|docx?|xlsx?|pptx?|mp4|mp3|css|js)$/i.test(url.pathname)) {
      return false;
    }
    // Skip non-content / dead-end pages seen in the sitemap.
    const p = (url.pathname + url.search).toLowerCase();
    if (/errorpage\.aspx|userlogin\.aspx|\/secure\/|sitemap\.aspx|questionnairedone|aspxerrorpath/.test(p)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function newsScore(link) {
  const s = normalizeText(`${link.label || ''} ${link.url || ''}`);
  const keywords = [
    'news', 'article', 'announc', 'press', 'event', 'publication', 'circular', 'notice', 'update',
    'nea', 'anakoin', 'deltio', 'ekdilos', 'arthr', 'ειδησ', 'νεα', 'ανακοιν', 'δελτ', 'εκδηλ', 'αρθρ',
  ];
  let score = 0;
  for (const k of keywords) if (s.includes(k)) score += 5;
  return score;
}

export function parsePage(html, baseUrl) {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, iframe').remove();

  const title = (
    $('meta[property="og:title"]').attr('content') ||
    $('title').first().text() ||
    $('h1').first().text() ||
    ''
  ).trim();

  const text = $('body').text().replace(/\s+/g, ' ').trim();

  const links = [];
  $('a[href]').each((_, el) => {
    const abs = absolutize($(el).attr('href'), baseUrl);
    if (abs) links.push({ url: abs, label: $(el).text().replace(/\s+/g, ' ').trim() });
  });

  return { title, text, links };
}

export function parseSitemap(xml) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const urls = [];
  $('url').each((_, el) => {
    const loc = $(el).find('loc').first().text().trim();
    const lastmod = $(el).find('lastmod').first().text().trim() || null;
    if (loc) urls.push({ url: loc, lastmod });
  });
  const children = [];
  $('sitemap').each((_, el) => {
    const loc = $(el).find('loc').first().text().trim();
    if (loc) children.push(loc);
  });
  return { urls, children };
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

function sitemapCandidates() {
  if (SITEMAP_URLS.length) return SITEMAP_URLS;
  const out = new Set();
  for (const seed of SEED_URLS) {
    try {
      const o = new URL(seed).origin;
      out.add(`${o}/sitemap.xml`);
      out.add(`${o}/sitemap_index.xml`);
      out.add(`${o}/selk/sitemap.xml`);
    } catch {
      /* ignore */
    }
  }
  return [...out];
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

// Generate the year-filtered listing URLs (?year=YYYY and ?year=0 "all") for
// each configured news/events category. These are fetched later, in batches, to
// reach the full archive that the site's JS pager hides.
export function generateListingUrls() {
  const out = [];
  const now = new Date().getUTCFullYear();
  for (const base of NEWS_URLS) {
    for (let y = now; y >= now - YEARS_BACK; y--) out.push(withParam(base, 'year', y));
    out.push(withParam(base, 'year', 0));
  }
  return out;
}

// Extract article links (newdetails/eventdetails?id=) from a listing page.
export function harvestArticleLinks(html, baseUrl) {
  const out = [];
  for (const link of parsePage(html, baseUrl).links) {
    if (isArticleUrl(link.url) && isContentLink(link.url)) {
      out.push({ url: link.url, id: extractId(link.url) });
    }
  }
  return out;
}

// Initial discovery: static/info pages from the sitemap + the freshest article
// links from the default listing/home pages. The crawl orchestration (lib/kb.js)
// then expands coverage by fetching the generated year listings in batches.
//
// The sitemap's lastmod is stale, so recency comes from the article id (higher =
// newer); junk (error/login/sitemap) is filtered by isContentLink.
export async function discoverSeeds() {
  if (!SCRAPER_KEY) throw new Error('SCRAPERAPI_KEY is not configured');

  const statics = new Map(); // url -> { url, lastmod, score }
  const articles = new Map(); // url -> { url, id }
  const addStatic = (url, { lastmod = null, score = 0 } = {}) => {
    if (!isContentLink(url) || isListingUrl(url) || isArticleUrl(url)) return;
    const key = normalizeUrl(url);
    const prev = statics.get(key);
    if (prev) {
      if (lastmod && !prev.lastmod) prev.lastmod = lastmod;
      prev.score = Math.max(prev.score, score);
    } else {
      statics.set(key, { url, lastmod, score });
    }
  };
  const addArticle = (url) => {
    if (!isContentLink(url) || !isArticleUrl(url)) return;
    articles.set(normalizeUrl(url), { url, id: extractId(url) });
  };

  // 1. Sitemap(s): static/info pages.
  await mapLimit(sitemapCandidates(), DISCOVERY_CONCURRENCY, async (sm) => {
    try {
      const xml = await fetchViaScraperApi(sm);
      if (looksBlocked(xml) || !/<(urlset|sitemapindex)/i.test(xml)) return;
      const { urls, children } = parseSitemap(xml);
      for (const e of urls) {
        addArticle(e.url);
        addStatic(e.url, { lastmod: e.lastmod });
      }
      for (const child of children.slice(0, 2)) {
        try {
          const cxml = await fetchViaScraperApi(child);
          if (!looksBlocked(cxml)) {
            for (const e of parseSitemap(cxml).urls) {
              addArticle(e.url);
              addStatic(e.url, { lastmod: e.lastmod });
            }
          }
        } catch {
          /* skip child sitemap */
        }
      }
    } catch {
      /* sitemap not available */
    }
  });

  // 2. Homepage + default listing pages: freshest article links + info links.
  await mapLimit([...SEED_URLS, ...NEWS_URLS], DISCOVERY_CONCURRENCY, async (seed) => {
    try {
      const html = await fetchViaScraperApi(seed);
      if (looksBlocked(html)) return;
      addStatic(seed, { score: 1 });
      for (const link of parsePage(html, seed).links) {
        if (!isContentLink(link.url)) continue;
        if (isArticleUrl(link.url)) addArticle(link.url);
        else if (!isListingUrl(link.url)) addStatic(link.url, { score: newsScore(link) });
      }
    } catch {
      /* skip seed */
    }
  });

  return {
    statics: [...statics.values()].sort((a, b) => b.score - a.score),
    articles: [...articles.values()].sort((a, b) => (b.id || 0) - (a.id || 0)),
    expand: generateListingUrls(),
  };
}

// Fetch + parse a single content page into a storable record.
export async function scrapePage(url, lastmod = null) {
  const html = await fetchViaScraperApi(url);
  if (looksBlocked(html)) return null;
  const parsed = parsePage(html, url);
  if (!parsed.text || parsed.text.length < 80) return null;
  // The site's lastmod is stale, so prefer a date parsed from the page body.
  const date = extractDate(parsed.text) || (lastmod ? Date.parse(lastmod) || null : null);
  return {
    url,
    title: parsed.title || url,
    date,
    id: extractId(url),
    text: parsed.text.slice(0, STORE_CHAR_CAP),
  };
}

export async function mapLimit(items, limit, fn) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
