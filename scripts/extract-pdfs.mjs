/**
 * Download and extract text from PDFs discovered during the crawl
 * (data/raw/pdfs.txt) -> data/raw/pdfs.jsonl, which build-kb.mjs folds into the
 * knowledge base. PDFs are behind Cloudflare too, so we reuse a real browser
 * session to obtain cf_clearance, then download via the authenticated context.
 *
 * Run with a virtual display:  xvfb-run -a node scripts/extract-pdfs.mjs
 * Env: MAX_PDFS (default 60), CRAWL_DELAY_MS (default 800)
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PDFS_TXT = path.join(ROOT, 'data', 'raw', 'pdfs.txt');
const OUT = path.join(ROOT, 'data', 'raw', 'pdfs.jsonl');

const MAX_PDFS = Number(process.env.MAX_PDFS || 60);
const DELAY_MS = Number(process.env.CRAWL_DELAY_MS || 800);
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

if (!fs.existsSync(PDFS_TXT)) { console.error('No data/raw/pdfs.txt. Run the crawl first.'); process.exit(1); }

const urls = [...new Set(fs.readFileSync(PDFS_TXT, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean))];
const done = new Set();
if (fs.existsSync(OUT)) {
  for (const l of fs.readFileSync(OUT, 'utf8').split('\n')) { if (!l.trim()) continue; try { done.add(JSON.parse(l).url); } catch {} }
}
const todo = urls.filter((u) => !done.has(u)).slice(0, MAX_PDFS);
console.log(`${urls.length} PDFs found, ${done.size} already done, processing ${todo.length} (cap ${MAX_PDFS}).`);

const out = fs.createWriteStream(OUT, { flags: 'a' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function titleFromUrl(u) {
  try { return decodeURIComponent(new URL(u).pathname.split('/').pop().replace(/\.pdf$/i, '')); } catch { return u; }
}

async function isChallenge(page) {
  return page.evaluate(() => /just a moment|enable javascript and cookies|__cf_chl/i.test(document.title + (document.body?.innerText || ''))).catch(() => false);
}

const browser = await chromium.launch({ headless: false, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage'] });
const ctx = await browser.newContext({ userAgent: UA, locale: 'en-US', acceptDownloads: true });
await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); window.chrome = { runtime: {} }; });
const page = await ctx.newPage();

// Prime cf_clearance.
await page.goto('https://www.icpac.org.cy/selk/en/default.aspx', { waitUntil: 'domcontentloaded', timeout: 60000 });
for (let i = 0; i < 20 && (await isChallenge(page)); i++) await page.waitForTimeout(1500);

let ok = 0, fail = 0;
for (const url of todo) {
  try {
    const resp = await ctx.request.get(url, { timeout: 60000 });
    if (!resp.ok()) { console.warn(`  ! ${resp.status()} ${url}`); fail++; await sleep(DELAY_MS); continue; }
    const buf = Buffer.from(await resp.body());
    const data = await pdfParse(buf);
    const text = (data.text || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    if (text.length < 80) { console.warn(`  - empty/scanned ${url}`); fail++; await sleep(DELAY_MS); continue; }
    out.write(JSON.stringify({ url, finalUrl: url, title: titleFromUrl(url), text, type: 'pdf' }) + '\n');
    ok++;
    console.log(`[${ok}] ${data.numpages}p ${text.length}c  ${titleFromUrl(url).slice(0, 50)}`);
  } catch (e) {
    console.warn(`  ! ${url}: ${e.message}`);
    fail++;
  }
  await sleep(DELAY_MS);
}

out.end();
await browser.close();
console.log(`\nDone. Extracted ${ok}, failed/skipped ${fail}.`);
