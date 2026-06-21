# ICPAC (ΣΕΛΚ) AI Assistant

Live at: **https://ai.icpac.org.cy**

An AI chat assistant for the Institute of Certified Public Accountants of Cyprus
(ΣΕΛΚ). It reads the **latest news, articles and main topics** from the official
website and answers visitors' questions — in English or Greek — using the
Anthropic (Claude) API.

## How it works

```
Visitor → widget / page → /api/chat → ┌─ ScraperAPI → icpac.org.cy/selk  (latest news, articles, topics)
                                       └─ Anthropic API (Claude)          (answers, grounded on the scraped content)
                                                │
                                                └─ KV store ── chat history → /admin
```

- **Scraping** — the official site is behind Cloudflare, so [ScraperAPI](https://www.scraperapi.com/)
  fetches the homepage plus the latest news / announcement / article pages. The
  result is cached (default 6h) and refreshed daily by a scheduled job, so chats
  stay fast.
- **Answers** — Claude (`claude-opus-4-8`) answers grounded on the scraped
  content. It is prompted to **synthesise across multiple announcements/articles**
  — e.g. tracing who held a role over time by combining an appointment notice
  with a later departure notice — rather than only quoting a single page.
- **Chat history** — every conversation is stored in KV and viewable on a small
  password-protected admin page.

## Setup

### 1. Environment variables

Set these in **Vercel → Project → Settings → Environment Variables** (see
`.env.example` for the full annotated list):

| Variable | Required | What it is |
|----------|----------|------------|
| `ANTHROPIC_API_KEY` | ✅ | Anthropic API key (console.anthropic.com) |
| `SCRAPERAPI_KEY` | ✅ | ScraperAPI key (scraperapi.com) |
| `KV_REST_API_URL` | ✅ | Upstash Redis REST URL (for history + cache) |
| `KV_REST_API_TOKEN` | ✅ | Upstash Redis REST token |
| `ADMIN_PASSWORD` | ✅ | Password for the `/admin` history page |
| `CRON_SECRET` | recommended | Protects the scheduled refresh job |

> **Storage:** on Vercel, add the **Upstash** integration (Storage tab) and the
> two `KV_REST_API_*` variables are filled in automatically. Without KV the app
> still runs, but chat history is not persisted.

### 2. Deploy

Push to the connected Git repo (or `vercel --prod`). Vercel installs the
dependencies (`@anthropic-ai/sdk`, `cheerio`) and serves the API automatically.
No build step.

### 3. Custom domain (ai.icpac.org.cy)

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
list of conversations and can open any of them.

## Refreshing the scraped content

- A scheduled job (`/api/refresh`, daily by default — see `vercel.json`) re-scrapes
  the site and updates the cache.
- To refresh manually: `https://ai.icpac.org.cy/api/refresh?key=YOUR_ADMIN_PASSWORD`
- Tune scraping with `SCRAPE_MAX_PAGES`, `KB_TTL_SECONDS`, `SCRAPE_SEED_URLS`,
  etc. (see `.env.example`). Raising `SCRAPE_MAX_PAGES` improves coverage of
  older articles at the cost of more ScraperAPI credits.

## Link for emails

```
https://ai.icpac.org.cy
```

## Project layout

| Path | Purpose |
|------|---------|
| `index.html` | Full-page chat UI |
| `widget/icpac-chat-widget.js` | Embeddable chat bubble |
| `admin.html` | Private chat-history viewer |
| `api/chat.js` | Chat endpoint (scrape → Claude → save) |
| `api/refresh.js` | Re-scrape + refresh cache (cron / manual) |
| `api/admin.js` | Chat-history API (password-protected) |
| `lib/scraper.js` | ScraperAPI scraping + knowledge-base builder |
| `lib/store.js` | KV storage + conversation persistence |
