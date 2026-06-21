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
  'https://www.icpac.org.cy/selk/en/default.aspx'
);
// Optional: news/announcement listing pages (incl. pagination) to maximise
// coverage of "latest" when the site has no usable sitemap.
const NEWS_URLS = splitEnv(process.env.SCRAPE_NEWS_URLS, '');
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
    return (url.origin + url.pathname).toLowerCase() + url.search;
  } catch {
    return String(u).toLowerCase();
  }
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

// Discover the latest content URLs, newest first. Sitemap <lastmod> drives
// recency; news-looking links from the homepage / listing pages fill the rest.
export async function discoverLatestUrls() {
  if (!SCRAPER_KEY) throw new Error('SCRAPERAPI_KEY is not configured');

  const map = new Map(); // normalized url -> { url, lastmod, score, order }
  let order = 0;
  const add = (rawUrl, lastmod, score) => {
    if (!isContentLink(rawUrl)) return;
    const key = normalizeUrl(rawUrl);
    const prev = map.get(key);
    if (prev) {
      if (lastmod && !prev.lastmod) prev.lastmod = lastmod;
      if (score) prev.score = Math.max(prev.score, score);
    } else {
      map.set(key, { url: rawUrl, lastmod: lastmod || null, score: score || 0, order: order++ });
    }
  };

  // 1. Sitemaps (best signal for "latest").
  for (const sm of sitemapCandidates()) {
    try {
      const xml = await fetchViaScraperApi(sm);
      if (looksBlocked(xml) || !/<(urlset|sitemapindex)/i.test(xml)) continue;
      const { urls, children } = parseSitemap(xml);
      for (const e of urls) add(e.url, e.lastmod, 0);
      let fetched = 0;
      for (const child of children) {
        if (fetched >= 3) break;
        try {
          const cxml = await fetchViaScraperApi(child);
          if (looksBlocked(cxml)) continue;
          for (const e of parseSitemap(cxml).urls) add(e.url, e.lastmod, 0);
          fetched++;
        } catch {
          /* skip child sitemap */
        }
      }
    } catch {
      /* sitemap not available */
    }
  }

  // 2. Homepage + news listing pages → collect links.
  for (const seed of [...SEED_URLS, ...NEWS_URLS]) {
    try {
      const html = await fetchViaScraperApi(seed);
      if (looksBlocked(html)) continue;
      const parsed = parsePage(html, seed);
      add(seed, null, 1); // include the seed page itself (main topics)
      for (const link of parsed.links) add(link.url, null, newsScore(link));
    } catch {
      /* skip seed */
    }
  }

  const all = [...map.values()];
  all.sort((a, b) => {
    const ad = a.lastmod ? Date.parse(a.lastmod) || 0 : 0;
    const bd = b.lastmod ? Date.parse(b.lastmod) || 0 : 0;
    if (bd !== ad) return bd - ad; // newest sitemap entries first
    if (b.score !== a.score) return b.score - a.score; // then news-looking links
    return a.order - b.order; // then discovery order
  });
  return all.slice(0, MAX_PAGES).map((e) => ({ url: e.url, lastmod: e.lastmod }));
}

// Fetch + parse a single content page into a storable record.
export async function scrapePage(url, lastmod = null) {
  const html = await fetchViaScraperApi(url);
  if (looksBlocked(html)) return null;
  const parsed = parsePage(html, url);
  if (!parsed.text || parsed.text.length < 80) return null;
  const date = (lastmod && Date.parse(lastmod)) || extractDate(parsed.text) || null;
  return {
    url,
    title: parsed.title || url,
    date,
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
