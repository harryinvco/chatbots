# ICPAC (ΣΕΛΚ) AI Assistant

Live at: **https://ai.icpac.org.cy**

An AI chat assistant for the Institute of Certified Public Accountants of Cyprus
(ΣΕΛΚ). It reads the **latest pages** (news, articles, main topics) from the
official website and answers visitors' questions — in English or Greek — using
the Anthropic (Claude) API.

## How it works

```
Refresh (on-demand)                        Chat
─────────────────────                      ──────────────────────────────
/api/refresh ──► Firecrawl crawl            Visitor ──► /api/chat
  submit crawl job, poll it,                  ├─ retrieve the ~15 most relevant
  ingest markdown results,                    │  pages for the question (+ newest)
  store each page in KV  ─────────────────►   ├─ Anthropic API (Claude) answers,
  (up to ~300 pages)             KV ◄──────   │  grounded on those pages
                                              └─ save the conversation → /admin
```

- **Crawl (on-demand)** — [Firecrawl](https://firecrawl.dev) crawls the site
  server-side: it renders JavaScript, gets past the Cloudflare/anti-bot wall,
  discovers URLs (via the sitemap + link following), and returns clean **markdown**
  per page. We submit one async crawl job, poll it, and ingest the results into
  KV. It runs only when you trigger it (no schedule).
  > Firecrawl replaced a per-URL scraper that could only see the first page of the
  > site's JS-paginated listings. `lib/firecrawl.js` is the only scraping code; to
  > swap providers you'd only touch that file.
- **Retrieval** — a few hundred pages is far too much to send to the model per
  question, so each question retrieves only the **~15 most relevant pages**
  (keyword + recency) plus the **newest few** (so "latest news" always works), and
  sends just those to Claude. This keeps answers fast and cheap.
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
| `FIRECRAWL_API_KEY` | ✅ | Firecrawl API key (firecrawl.dev) |
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
now.”** Firecrawl crawls the site (a few minutes) while the progress bar shows
"Scraping site…" then "Saving pages…". Re-run it whenever you want the latest news.

> Keep the admin tab open while it runs — the page polls the crawl job to
> completion, so each request stays well under the serverless time limit.

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
- **Coverage / where it crawls:** set `FIRECRAWL_CRAWL_URL` (default
  `https://www.icpac.org.cy/selk/`) and `FIRECRAWL_LIMIT` (default 300 pages).
  Firecrawl discovers pages itself; raise the limit or point it at a specific
  section to change coverage.
- **Cost:** each refresh scrapes up to `FIRECRAWL_LIMIT` pages = that many
  Firecrawl credits. It's on-demand, so you control when it runs. See
  `.env.example` for `FIRECRAWL_*` and retrieval knobs.

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
| `api/refresh.js` | On-demand crawl driver (`start` / `continue` / `status`) |
| `api/admin.js` | Chat-history API (password-protected) |
| `lib/firecrawl.js` | Firecrawl client (submit crawl, poll, parse results) |
| `lib/kb.js` | Crawl orchestration + retrieval |
| `lib/store.js` | KV storage + conversation persistence |
