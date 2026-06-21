// Scrapes the official ICPAC / ΣΕΛΚ website through ScraperAPI and turns it into
// a compact "knowledge base": the homepage plus the latest news / announcements
// / article pages, as readable text. The result is cached in KV so we don't
// re-scrape on every chat message.
//
// The target site (https://www.icpac.org.cy/selk/) sits behind Cloudflare, so
// ScraperAPI's premium proxy is used by default to get past the challenge.

import * as cheerio from 'cheerio';
import { kvGet, kvSet } from './store.js';

const SCRAPER_KEY = process.env.SCRAPERAPI_KEY || '';

const KB_CACHE_KEY = 'kb:icpac';
const KB_TTL_SECONDS = Number(process.env.KB_TTL_SECONDS || 6 * 60 * 60); // 6h
const MAX_PAGES = Number(process.env.SCRAPE_MAX_PAGES || 8);
const MAX_CHARS_PER_PAGE = Number(process.env.SCRAPE_MAX_CHARS || 9000);
const FETCH_TIMEOUT_MS = Number(process.env.SCRAPE_TIMEOUT_MS || 35000);
const CONCURRENCY = Number(process.env.SCRAPE_CONCURRENCY || 4);

const SEED_URLS = (
  process.env.SCRAPE_SEED_URLS ||
  'https://www.icpac.org.cy/selk/en/default.aspx'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function bool(v, fallback = false) {
  if (v === undefined || v === null || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(v));
}

function scraperApiUrl(target) {
  const params = new URLSearchParams({ api_key: SCRAPER_KEY, url: target });
  // The site is Cloudflare-protected, so premium is on by default. Turn it off
  // with SCRAPE_PREMIUM=false to save credits if the site is ever unprotected.
  if (bool(process.env.SCRAPE_PREMIUM, true)) params.set('premium', 'true');
  if (bool(process.env.SCRAPE_RENDER, false)) params.set('render', 'true');
  if (bool(process.env.SCRAPE_ULTRA_PREMIUM, false)) params.set('ultra_premium', 'true');
  if (process.env.SCRAPE_COUNTRY) params.set('country_code', process.env.SCRAPE_COUNTRY);
  return `https://api.scraperapi.com/?${params.toString()}`;
}

async function fetchPage(target) {
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

// Detect a Cloudflare / bot-wall page so we don't store junk as "content".
function looksBlocked(html) {
  if (!html) return true;
  const head = html.slice(0, 4000).toLowerCase();
  return (
    head.includes('attention required') ||
    head.includes('cf-browser-verification') ||
    head.includes('just a moment') ||
    head.includes('enable javascript and cookies to continue')
  );
}

function normalize(u) {
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

function isContentLink(u) {
  try {
    const url = new URL(u);
    if (!/(^|\.)icpac\.org\.cy$/i.test(url.hostname)) return false;
    if (!/\/selk\//i.test(url.pathname)) return false;
    if (/\.(pdf|jpe?g|png|gif|svg|zip|rar|docx?|xlsx?|pptx?|mp4|mp3)$/i.test(url.pathname)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// Prioritise links that look like news / announcements / articles / events,
// in both English and Greek.
function newsScore(link) {
  const s = `${link.label} ${link.url}`.toLowerCase();
  const keywords = [
    'news', 'article', 'announc', 'press', 'event', 'publication', 'circular', 'notice',
    'nea', 'anakoin', 'deltio', 'ekdilos', 'ειδήσ', 'νέα', 'ανακοίν', 'δελτ', 'εκδήλ', 'άρθρ',
  ];
  let score = 0;
  for (const k of keywords) if (s.includes(k)) score += 5;
  return score;
}

function parsePage(html, baseUrl) {
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

async function mapLimit(items, limit, fn) {
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

// Scrape the site and assemble the knowledge base. Stores it in KV.
export async function buildKnowledgeBase() {
  if (!SCRAPER_KEY) throw new Error('SCRAPERAPI_KEY is not configured');

  const seen = new Set();
  const pages = [];
  const discovered = [];

  // 1. Scrape the seed page(s) and collect candidate links.
  for (const seed of SEED_URLS) {
    try {
      const html = await fetchPage(seed);
      if (looksBlocked(html)) throw new Error('blocked by site protection');
      const parsed = parsePage(html, seed);
      seen.add(normalize(seed));
      pages.push({
        url: seed,
        title: parsed.title || 'ICPAC / ΣΕΛΚ',
        text: parsed.text.slice(0, MAX_CHARS_PER_PAGE),
      });
      for (const link of parsed.links) {
        if (isContentLink(link.url) && !seen.has(normalize(link.url))) discovered.push(link);
      }
    } catch (err) {
      console.error(`scrape seed failed (${seed}):`, err.message);
    }
  }

  // 2. Rank + de-duplicate discovered links (news/announcements first).
  const queue = [];
  const qSeen = new Set();
  discovered.sort((a, b) => newsScore(b) - newsScore(a));
  for (const link of discovered) {
    const n = normalize(link.url);
    if (qSeen.has(n) || seen.has(n)) continue;
    qSeen.add(n);
    queue.push(link);
  }

  // 3. Scrape the top N article pages with limited concurrency.
  const budget = Math.max(0, MAX_PAGES - pages.length);
  const targets = queue.slice(0, budget);
  const scraped = await mapLimit(targets, CONCURRENCY, async (link) => {
    try {
      const html = await fetchPage(link.url);
      if (looksBlocked(html)) return null;
      const parsed = parsePage(html, link.url);
      if (!parsed.text || parsed.text.length < 80) return null;
      return {
        url: link.url,
        title: parsed.title || link.label || link.url,
        text: parsed.text.slice(0, MAX_CHARS_PER_PAGE),
      };
    } catch (err) {
      console.error(`scrape page failed (${link.url}):`, err.message);
      return null;
    }
  });
  for (const p of scraped) if (p) pages.push(p);

  const kb = { scrapedAt: Date.now(), pageCount: pages.length, pages };
  if (pages.length > 0) {
    // Keep cache around longer than the freshness window so we can serve a
    // (slightly stale) result instead of failing if a later scrape errors.
    await kvSet(KB_CACHE_KEY, kb, KB_TTL_SECONDS * 4);
  }
  return kb;
}

// Return the knowledge base, scraping only when there is nothing cached.
// A stale (but present) cache is returned immediately; the scheduled
// /api/refresh job keeps it fresh without adding latency to chat requests.
export async function getKnowledgeBase({ force = false } = {}) {
  if (!force) {
    const cached = await kvGet(KB_CACHE_KEY);
    if (cached && cached.pages?.length) return cached;
  }
  return buildKnowledgeBase();
}

export function kbIsFresh(kb) {
  return kb && Date.now() - kb.scrapedAt < KB_TTL_SECONDS * 1000;
}
