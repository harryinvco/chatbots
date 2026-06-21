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
// Max secondary listing pages (year filters) to fetch while discovering.
const MAX_LISTING_PAGES = Number(process.env.SCRAPE_MAX_LISTING_PAGES || 12);
// Slots reserved for non-article (static/info) pages so they aren't crowded out.
const STATIC_RESERVE = Number(process.env.SCRAPE_STATIC_RESERVE || 40);
const DISCOVERY_CONCURRENCY = Number(process.env.SCRAPE_CONCURRENCY || 5);
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

function normalizeUrl(u) {
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

// Discover the latest content URLs, newest first.
//
// The site's sitemap is stale (every lastmod is identical) so we can't trust it
// for recency. Instead: harvest real article links from the news/events listing
// pages (and their year filters), rank articles by id descending (higher =
// newer), and pull the useful static/info pages from the sitemap. Junk (error /
// login / sitemap pages) is filtered out by isContentLink.
export async function discoverLatestUrls() {
  if (!SCRAPER_KEY) throw new Error('SCRAPERAPI_KEY is not configured');

  const map = new Map(); // normalized url -> { url, lastmod, score, id, order }
  let order = 0;
  const add = (rawUrl, { lastmod = null, score = 0 } = {}) => {
    if (!isContentLink(rawUrl)) return;
    const key = normalizeUrl(rawUrl);
    const id = extractId(rawUrl);
    const prev = map.get(key);
    if (prev) {
      if (lastmod && !prev.lastmod) prev.lastmod = lastmod;
      if (score) prev.score = Math.max(prev.score, score);
      if (id != null && prev.id == null) prev.id = id;
    } else {
      map.set(key, { url: rawUrl, lastmod, score, id, order: order++ });
    }
  };

  // 1. Sitemap(s): source of static/info pages (lastmod ignored — it's stale).
  await mapLimit(sitemapCandidates(), DISCOVERY_CONCURRENCY, async (sm) => {
    try {
      const xml = await fetchViaScraperApi(sm);
      if (looksBlocked(xml) || !/<(urlset|sitemapindex)/i.test(xml)) return;
      const { urls, children } = parseSitemap(xml);
      for (const e of urls) if (!isListingUrl(e.url)) add(e.url, { lastmod: e.lastmod });
      for (const child of children.slice(0, 2)) {
        try {
          const cxml = await fetchViaScraperApi(child);
          if (!looksBlocked(cxml)) {
            for (const e of parseSitemap(cxml).urls) if (!isListingUrl(e.url)) add(e.url, { lastmod: e.lastmod });
          }
        } catch {
          /* skip child sitemap */
        }
      }
    } catch {
      /* sitemap not available */
    }
  });

  // 2. Listing pages (homepage + news/events): collect article links and the
  //    secondary listing links (year filters) to dig further back.
  const secondary = new Set();
  await mapLimit([...SEED_URLS, ...NEWS_URLS], DISCOVERY_CONCURRENCY, async (seed) => {
    try {
      const html = await fetchViaScraperApi(seed);
      if (looksBlocked(html)) return;
      if (!isListingUrl(seed)) add(seed, { score: 1 });
      for (const link of parsePage(html, seed).links) {
        if (!isContentLink(link.url)) continue;
        if (isArticleUrl(link.url)) add(link.url);
        else if (isListingUrl(link.url)) {
          if (/[?&]year=/i.test(link.url)) secondary.add(link.url);
        } else {
          add(link.url, { score: newsScore(link) }); // plain info page
        }
      }
    } catch {
      /* skip seed */
    }
  });

  // 3. Secondary listings (year filters) → more article links.
  await mapLimit([...secondary].slice(0, MAX_LISTING_PAGES), DISCOVERY_CONCURRENCY, async (url) => {
    try {
      const html = await fetchViaScraperApi(url);
      if (looksBlocked(html)) return;
      for (const link of parsePage(html, url).links) {
        if (isArticleUrl(link.url)) add(link.url);
      }
    } catch {
      /* skip listing */
    }
  });

  // 4. Rank: latest articles (by id desc) first, then static/info pages.
  const all = [...map.values()];
  const articlesAll = all.filter((e) => e.id != null).sort((a, b) => b.id - a.id);
  const statics = all
    .filter((e) => e.id == null)
    .sort((a, b) => b.score - a.score || a.order - b.order);

  const reserve = Math.min(statics.length, STATIC_RESERVE);
  const articles = articlesAll.slice(0, Math.max(0, MAX_PAGES - reserve));
  let ordered = [...articles, ...statics.slice(0, MAX_PAGES - articles.length)];
  if (ordered.length < MAX_PAGES && articlesAll.length > articles.length) {
    ordered = ordered.concat(articlesAll.slice(articles.length, articles.length + (MAX_PAGES - ordered.length)));
  }
  return ordered.slice(0, MAX_PAGES).map((e) => ({ url: e.url, lastmod: e.lastmod, id: e.id }));
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
