# ICPAC (ΣΕΛΚ) AI Assistant

Live at: **https://ai.icpac.org.cy**

An AI chat assistant for the Institute of Certified Public Accountants of Cyprus
(ΣΕΛΚ). It reads the **latest ~200 pages** (news, articles, main topics) from the
official website and answers visitors' questions — in English or Greek — using
the Anthropic (Claude) API.

## How it works

```
Refresh (on-demand)                        Chat
─────────────────────                      ──────────────────────────────
/api/refresh  ──► ScraperAPI ──► scrape    Visitor ──► /api/chat
  discover latest URLs (sitemap +            ├─ retrieve the ~15 most relevant
  news index), scrape in batches,            │  pages for the question (+ newest)
  store each page in KV  ─────────────────►  ├─ Anthropic API (Claude) answers,
  (the ~200 latest pages)        KV ◄──────  │  grounded on those pages
                                             └─ save the conversation → /admin
```

- **Crawl (on-demand)** — the site is behind Cloudflare, so [ScraperAPI](https://www.scraperapi.com/)
  fetches it. The crawler harvests article links from the news/events listing
  pages (and their year filters), ranks them by article **id** (higher = newer),
  adds the static info pages from the sitemap, skips junk (login/error pages),
  and scrapes the result in small batches into KV. It runs only when you trigger
  it (no schedule).
  > The site's `sitemap.xml` is stale (every `lastmod` is 2018 and it omits
  > recent articles), so it is used only for the static info pages — recency
  > comes from the article id, not the sitemap.
- **Retrieval** — 200 pages is far too much to send to the model per question, so
  each question retrieves only the **~15 most relevant pages** (keyword + recency)
  plus the **newest few** (so "latest news" always works), and sends just those
  to Claude. This keeps answers fast and cheap.
- **Answers** — Claude (`claude-opus-4-8`) is prompted to **synthesise across
  multiple announcements/articles** — e.g. tracing who held a role over time by
  combining an appointment notice with a later departure notice.
- **Chat history** — every conversation is stored in KV and viewable on a
  password-protected admin page.

## Setup

### 1. Environment variables

Set these in **Vercel → Project → Settings → Environment Variables** (full
annotated list in `.env.example`):

| Variable | Required | What it is |
|----------|----------|------------|
| `ANTHROPIC_API_KEY` | ✅ | Anthropic API key (console.anthropic.com) |
| `SCRAPERAPI_KEY` | ✅ | ScraperAPI key (scraperapi.com) |
| `KV_REST_API_URL` | ✅ | Upstash Redis REST URL (stores pages + history) |
| `KV_REST_API_TOKEN` | ✅ | Upstash Redis REST token |
| `ADMIN_PASSWORD` | ✅ | Password for `/admin` and for triggering a refresh |

> **Storage is required** here (not just for history): the crawl, retrieval and
> chat history all use KV. On Vercel, add the **Upstash** integration (Storage
> tab) and the two `KV_REST_API_*` variables are filled in automatically.

### 2. Deploy

Push to the connected Git repo (or `vercel --prod`). Vercel installs the
dependencies (`@anthropic-ai/sdk`, `cheerio`) and serves the API automatically.
No build step.

### 3. Load the content (run this once after deploy)

Open **https://ai.icpac.org.cy/admin**, log in, and click **“Refresh content
now.”** It crawls the latest ~200 pages in batches (a few minutes) with a
progress bar. Re-run it whenever you want to pull in the latest news.

> Keep the admin tab open while it runs — the crawl is driven from the page,
> batch by batch, so it never exceeds the serverless time limit.

### 4. Custom domain (ai.icpac.org.cy)

Add this DNS record at your domain provider:

| Type  | Name | Value                |
|-------|------|----------------------|
| CNAME | ai   | cname.vercel-dns.com |

## Add the chat bubble to any website

Paste this before `</body>` on any page:

```html
<script src="https://ai.icpac.org.cy/widget/icpac-chat-widget.js"></script>
```

A blue chat icon appears in the bottom-right corner.

## View chat history (private)

Go to **https://ai.icpac.org.cy/admin** and enter `ADMIN_PASSWORD`. You'll see a
list of conversations (newest first) and can open any of them. The bar at the top
shows how many pages are in the knowledge base and when it was last refreshed.

## Refreshing / tuning the scraped content

- **Refresh:** click **“Refresh content now”** on `/admin`.
- **Refresh via URL/script** (e.g. for automation) — call these in order until
  `finished: true` (each scrapes one batch):
  ```
  /api/refresh?action=start&key=YOUR_ADMIN_PASSWORD
  /api/refresh?action=continue&key=YOUR_ADMIN_PASSWORD   (repeat until finished)
  /api/refresh?action=status&key=YOUR_ADMIN_PASSWORD
  ```
- **Coverage of "latest":** the site pages its archive with JS post-backs that a
  link crawler can't follow, so the crawler **generates** the year-filtered
  listing URLs (`news.aspx?...&year=YYYY`, which work as plain GETs) and harvests
  the article links from each. To pull in more history, raise `SCRAPE_YEARS_BACK`
  (default 12) or `SCRAPE_MAX_PAGES`; to cover more sections, add listing URLs
  (e.g. the English `/selk/en/...` listings, magazine, media coverage) to
  `SCRAPE_NEWS_URLS`.
- **Scale/cost knobs:** `SCRAPE_MAX_PAGES` (default 200), `SCRAPE_BATCH`,
  `SCRAPE_CONCURRENCY`, `RETRIEVE_LIMIT`, `SEND_CHAR_CAP` — see `.env.example`.

## Link for emails

```
https://ai.icpac.org.cy
```

## Project layout

| Path | Purpose |
|------|---------|
| `index.html` | Full-page chat UI |
| `widget/icpac-chat-widget.js` | Embeddable chat bubble |
| `admin.html` | Private history viewer + “Refresh content” button |
| `api/chat.js` | Chat endpoint (retrieve → Claude → save) |
| `api/refresh.js` | On-demand batched crawl (`start` / `continue` / `status`) |
| `api/admin.js` | Chat-history API (password-protected) |
| `lib/scraper.js` | ScraperAPI fetch/parse + latest-URL discovery |
| `lib/kb.js` | Crawl orchestration + retrieval |
| `lib/store.js` | KV storage + conversation persistence |
