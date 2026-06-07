# ICPAC AI Assistant

The digital assistant for **ICPAC — the Institute of Certified Public Accountants of Cyprus**. It answers questions grounded in the official ICPAC website (icpac.org.cy) using retrieval-augmented generation (RAG): the site is crawled into a local knowledge base, the most relevant passages are retrieved per question, and a large language model answers from them with source citations.

Live at: **https://ai.icpac.org.cy**

> **Replaces** the previous DIFY-based chatbot. The model layer is provider-agnostic — it ships on OpenAI and can be switched to Claude (or another provider) via one environment variable.

---

## How it works

```
crawl (Playwright)        build-kb (embeddings)            runtime (Vercel)
icpac.org.cy ──────────▶ data/raw/pages.jsonl ──────────▶ data/knowledge-base.json
                          + data/raw/pdfs.jsonl                     │
                                                                    ▼
   user ──▶ index.html / widget ──▶ /api/chat ──▶ retrieve top-k passages
                                                  └─▶ LLM (OpenAI) ──▶ streamed answer + sources
```

| File | Role |
| --- | --- |
| `scripts/crawl.mjs` | Crawls the ICPAC site (solves Cloudflare via a real browser), writes `data/raw/pages.jsonl`. |
| `scripts/extract-pdfs.mjs` | Downloads + extracts text from PDFs found during the crawl → `data/raw/pdfs.jsonl`. |
| `scripts/build-kb.mjs` | Chunks + embeds the crawled content → `data/knowledge-base.json`. |
| `api/chat.js` | Serverless endpoint: retrieves context, calls the LLM, streams the answer (SSE) with sources. |
| `api/_llm.js` | Provider-agnostic chat + embedding wrapper (OpenAI today, Claude-swappable). |
| `api/_retrieve.js` | Loads the knowledge base and returns the top-k passages for a query. |
| `index.html` | Full-page chat UI. |
| `widget/icpac-chat-widget.js` | Embeddable chat bubble for icpac.org.cy. |

---

## Prerequisites

- Node.js 18+
- An **OpenAI API key** (https://platform.openai.com/api-keys) — used for both embeddings and chat.
- For (re)crawling locally: a Linux box with Chromium dependencies + a virtual display:
  ```bash
  npx playwright install --with-deps chromium
  sudo apt-get install -y xvfb   # if not already present
  ```

---

## Setup

```bash
npm install
cp .env.example .env        # then edit .env and paste your OpenAI key
```

`.env` (never commit this):

```
OPENAI_API_KEY=sk-...
# optional overrides:
CHAT_MODEL=gpt-4o
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSIONS=512
```

### 1. Crawl the site

The ICPAC site is behind Cloudflare's bot protection, so the crawler drives a **real Chromium** (which solves the challenge) under a virtual display. It is slow and polite by design (randomized pacing + cooldown backoff) and **resumable** — re-run it to pick up where it left off or to fill gaps.

```bash
npm run crawl            # = xvfb-run -a node scripts/crawl.mjs
# optional: extract magazine/other PDFs found during the crawl
xvfb-run -a node scripts/extract-pdfs.mjs
```

Output: `data/raw/pages.jsonl` (and `data/raw/pdfs.jsonl`). Tunables via env: `MAX_PAGES`, `DELAY_MIN`, `DELAY_MAX`, `COOLDOWN_MS`, `MAX_PDFS`.

> Authorized use only. ICPAC has agreed in writing to this crawl of their own site.

### 2. Build the knowledge base

```bash
npm run build:kb         # embeds chunks → data/knowledge-base.json (needs OPENAI_API_KEY)
```

### 3. Run locally

```bash
npm run dev              # vercel dev  (or: vercel)
```

Open http://localhost:3000.

---

## Deploy (Vercel)

1. Push to the connected GitHub repo (Vercel auto-deploys), or run `vercel --prod`.
2. In the Vercel project, set the environment variable **`OPENAI_API_KEY`** (Project → Settings → Environment Variables). Add any model overrides you use.
3. `data/knowledge-base.json` is committed and bundled into the function (`vercel.json` → `includeFiles`). Re-run the crawl + build steps and commit the updated file to refresh the assistant's knowledge.

### Custom domain
Add a CNAME record: `ai` → `cname.vercel-dns.com`.

### Embed the chat bubble on icpac.org.cy
Paste before `</body>`:
```html
<script src="https://ai.icpac.org.cy/widget/icpac-chat-widget.js"></script>
```

---

## Switching the model / provider

The default is OpenAI (`gpt-4o`). To change models, set `CHAT_MODEL`. To switch providers to **Claude**:

```bash
npm i @anthropic-ai/sdk
```
then set:
```
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_CHAT_MODEL=claude-opus-4-8
```
Retrieval still uses OpenAI embeddings, so `OPENAI_API_KEY` is required regardless (the knowledge base was embedded with OpenAI). To move embeddings to another provider you must re-embed with `build:kb` and update `api/_llm.js`.

---

## Security

- **Never hardcode API keys.** Keys are read from environment variables only (`.env` locally, Vercel env vars in production). `.env` is git-ignored.
- If a key is ever pasted into a chat, email, or commit, **rotate it immediately** at the provider console — treat it as public.
- The previous DIFY token and backend IP that were hardcoded in `api/chat.js` are gone; revoke that DIFY app token if it's still active.
