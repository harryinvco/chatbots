/**
 * ICPAC site crawler.
 *
 * Uses a real (headed) Chromium via Playwright so it transparently solves the
 * Cloudflare managed challenge, then BFS-crawls the English informational site
 * under /selk/en/. Extracts cleaned page text + links and records PDF links for
 * a separate extraction pass. Output is resumable JSONL.
 *
 * Run with a virtual display:  npm run crawl
 * (which is `xvfb-run -a node scripts/crawl.mjs`)
 *
 * Authorized scrape: ICPAC has agreed in writing to this crawl of their own site.
 *
 * Env overrides: MAX_PAGES, CRAWL_DELAY_MS, START_URL
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RAW_DIR = path.join(ROOT, 'data', 'raw');
const PAGES_FILE = path.join(RAW_DIR, 'pages.jsonl');
const PDFS_FILE = path.join(RAW_DIR, 'pdfs.txt');
const FRONTIER_FILE = path.join(RAW_DIR, 'frontier.json');

const HOST = 'www.icpac.org.cy';
const SCOPE_PREFIX = '/selk/en/';
const START_URL = process.env.START_URL || 'https://www.icpac.org.cy/selk/en/default.aspx';
const MAX_PAGES = Number(process.env.MAX_PAGES || 600);
// Human-ish randomized pacing avoids the rate-based bot-score escalation that
// makes Cloudflare wall off the whole site mid-crawl.
const DELAY_MIN = Number(process.env.DELAY_MIN || 3000);
const DELAY_MAX = Number(process.env.DELAY_MAX || 6000);
const NAV_TIMEOUT = Number(process.env.NAV_TIMEOUT || 35000);
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || 3); // requeue attempts per URL
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS || 75000); // pause when Cloudflare escalates
const PROFILE_DIR = process.env.PROFILE_DIR || '/tmp/icpac-profile';

// Optional, for an authorized crawl:
// - BYPASS_HEADER: "Name: value" of a header ICPAC allowlists in a Cloudflare
//   WAF skip rule, so the crawler is never challenged (cleanest method).
// - PROXY_SERVER (+ PROXY_USERNAME/PROXY_PASSWORD): route through a residential
//   proxy if crawling from this IP keeps getting challenged.
const BYPASS_HEADER = process.env.BYPASS_HEADER || '';
const PROXY_SERVER = process.env.PROXY_SERVER || '';
const extraHeaders = {};
if (BYPASS_HEADER && BYPASS_HEADER.includes(':')) {
  const idx = BYPASS_HEADER.indexOf(':');
  extraHeaders[BYPASS_HEADER.slice(0, idx).trim()] = BYPASS_HEADER.slice(idx + 1).trim();
}

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

// Links we never want to enqueue (interactive endpoints, assets, Greek mirror,
// and the explosive member/firm directory detail pages which aren't useful for Q&A).
const EXCLUDE_RE =
  /(\/selk\/gr\/)|(login|logout|signin|signout|cart|basket|checkout|epayment|e-payment|addtocart|\?firmno=|firmno=|memberno=|practicingfirmauditorsdetails|memberdetails)/i;
const ASSET_RE = /\.(jpe?g|png|gif|svg|webp|ico|css|js|zip|rar|docx?|xlsx?|pptx?|mp4|mp3|woff2?|ttf)(\?|$)/i;

fs.mkdirSync(RAW_DIR, { recursive: true });

// ---- resume support -------------------------------------------------------
const visited = new Set();
const pdfSet = new Set();
if (fs.existsSync(PAGES_FILE)) {
  for (const line of fs.readFileSync(PAGES_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { visited.add(JSON.parse(line).url); } catch { /* ignore */ }
  }
  console.log(`Resuming: ${visited.size} pages already crawled.`);
}
if (fs.existsSync(PDFS_FILE)) {
  for (const l of fs.readFileSync(PDFS_FILE, 'utf8').split('\n')) if (l.trim()) pdfSet.add(l.trim());
}

const pagesStream = fs.createWriteStream(PAGES_FILE, { flags: 'a' });

function normalize(u) {
  try {
    const url = new URL(u, START_URL);
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function inScope(u) {
  try {
    const url = new URL(u);
    return url.host === HOST && url.pathname.startsWith(SCOPE_PREFIX);
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a));

// Detect a Cloudflare interstitial by DOM content, not just the title.
async function isChallenge(page) {
  return page.evaluate(() => {
    const body = document.body ? document.body.innerText : '';
    const t = (document.title || '') + ' ' + body;
    if (/just a moment|enable javascript and cookies|verify you are human|attention required|__cf_chl|cf-chl/i.test(t)) return true;
    return !!document.querySelector('#challenge-form, #cf-challenge-running, script[src*="challenge-platform"]');
  }).catch(() => false);
}

// Navigate, then wait (up to ~45s, with one reload) for the managed challenge
// to auto-solve. Returns the HTTP status, or -1 if the challenge never cleared.
async function fetchPage(page, url) {
  let status = 0;
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    status = resp ? resp.status() : 0;
  } catch (e) {
    console.log(`    goto error: ${e.message.split('\n')[0]}`);
    return -1;
  }
  for (let i = 0; i < 30; i++) {
    if (!(await isChallenge(page))) { await page.waitForTimeout(400); return status; }
    if (i === 14) { await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {}); }
    await page.waitForTimeout(1500);
  }
  return -1; // never cleared
}

// Runs in the browser: strip chrome (nav/header/footer/cookie/scripts), return
// title, meta description, cleaned text, and absolute links.
function extractInPage() {
  const abs = (href) => { try { return new URL(href, location.href).toString(); } catch { return null; } };
  const links = Array.from(document.querySelectorAll('a[href]'))
    .map((a) => abs(a.getAttribute('href')))
    .filter(Boolean);

  const clone = document.body.cloneNode(true);
  const junk = clone.querySelectorAll(
    'script,style,noscript,iframe,svg,header,footer,nav,form,' +
    '[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i],' +
    '[id*="breadcrumb" i],[class*="breadcrumb" i]'
  );
  junk.forEach((n) => n.remove());

  let text = (clone.innerText || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  const desc = document.querySelector('meta[name="description"]')?.content || '';
  return { title: document.title || '', description: desc, text, links };
}

async function main() {
  // Persistent profile keeps cookies/cf_clearance and looks more like a real
  // browser across pages and across re-runs.
  const launchOpts = {
    headless: false,
    userAgent: UA,
    locale: 'en-US',
    viewport: { width: 1366, height: 768 },
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage', '--start-maximized'],
  };
  if (Object.keys(extraHeaders).length) launchOpts.extraHTTPHeaders = extraHeaders;
  if (PROXY_SERVER) {
    launchOpts.proxy = { server: PROXY_SERVER, username: process.env.PROXY_USERNAME, password: process.env.PROXY_PASSWORD };
  }
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, launchOpts);
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    window.chrome = { runtime: {} };
  });
  const page = ctx.pages()[0] || (await ctx.newPage());

  // Restore the frontier (pending URLs) so the crawl is resumable across runs.
  // Without this, resuming would skip the already-visited seed and never
  // rediscover its links.
  let savedFrontier = [];
  if (fs.existsSync(FRONTIER_FILE)) {
    try { savedFrontier = JSON.parse(fs.readFileSync(FRONTIER_FILE, 'utf8')); } catch { /* ignore */ }
  }
  const queue = savedFrontier.filter((u) => !visited.has(u));
  if (!queue.includes(START_URL) && !visited.has(START_URL)) queue.unshift(START_URL);
  if (queue.length === 0) queue.push(START_URL); // fresh start
  const queued = new Set(queue);
  const attempts = new Map(); // url -> failed attempts
  const saveFrontier = () => { try { fs.writeFileSync(FRONTIER_FILE, JSON.stringify(queue)); } catch { /* ignore */ } };
  let crawled = 0;
  let consecutiveFails = 0;

  while (queue.length && crawled < MAX_PAGES) {
    const url = queue.shift();
    if (visited.has(url)) continue;

    try {
      console.log(`  -> fetching ${url.replace('https://www.icpac.org.cy/selk/en/', '')}`);
      const status = await fetchPage(page, url);
      if (status === -1) {
        const n = (attempts.get(url) || 0) + 1;
        attempts.set(url, n);
        consecutiveFails++;
        if (n < MAX_ATTEMPTS) {
          queue.push(url); // retry later, after a cooldown
          console.warn(`  ! challenge not cleared (try ${n}/${MAX_ATTEMPTS}), requeued ${url}`);
        } else {
          visited.add(url);
          console.warn(`  ! giving up after ${MAX_ATTEMPTS} tries: ${url}`);
        }
        // If Cloudflare has escalated (several misses in a row), cool down to let
        // the bot score decay before continuing.
        saveFrontier();
        if (consecutiveFails >= 2) {
          console.warn(`  ~ cooldown ${Math.round(COOLDOWN_MS / 1000)}s (Cloudflare escalation)`);
          await sleep(COOLDOWN_MS);
        } else {
          await sleep(rand(DELAY_MIN, DELAY_MAX));
        }
        continue;
      }
      consecutiveFails = 0;

      const data = await page.evaluate(extractInPage);
      visited.add(url);
      crawled++;

      const record = {
        url,
        finalUrl: page.url(),
        status,
        title: data.title,
        description: data.description,
        text: data.text,
        crawledAt: new Date().toISOString(),
      };
      pagesStream.write(JSON.stringify(record) + '\n');
      console.log(`[${crawled}/${MAX_PAGES}] (${status}) ${data.text.length}c  ${url}`);

      // enqueue discovered links
      for (const raw of data.links) {
        const n = normalize(raw);
        if (!n) continue;
        if (/\.pdf(\?|$)/i.test(n)) {
          if (!pdfSet.has(n) && new URL(n).host === HOST) {
            pdfSet.add(n);
            fs.appendFileSync(PDFS_FILE, n + '\n');
          }
          continue;
        }
        if (ASSET_RE.test(n) || EXCLUDE_RE.test(n)) continue;
        if (!inScope(n)) continue;
        if (!visited.has(n) && !queued.has(n)) {
          queued.add(n);
          queue.push(n);
        }
      }
    } catch (e) {
      console.warn(`  ! failed ${url}: ${e.message}`);
      visited.add(url); // don't retry forever
    }

    saveFrontier();
    await sleep(rand(DELAY_MIN, DELAY_MAX));
  }

  saveFrontier();
  pagesStream.end();
  await ctx.close();
  console.log(`\nDone. Pages: ${crawled}. PDFs found: ${pdfSet.size}. Queue remaining: ${queue.length}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
