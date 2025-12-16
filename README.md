# ICPAC AI Chatbot

Live at: **https://icpac.vercel.app**

---

## Setup Custom Domain (ai.icpac.org.cy)

Add this DNS record in your domain provider:

| Type  | Name | Value                |
|-------|------|----------------------|
| CNAME | ai   | cname.vercel-dns.com |

Then in Vercel dashboard → Project Settings → Domains → Add `ai.icpac.org.cy`

Wait 5-10 minutes for DNS to propagate.

---

## Add Chat Bubble to Your Website

Paste this code before `</body>` on any page:

```html
<script src="https://icpac.vercel.app/widget/icpac-chat-widget.js"></script>
```

A blue chat icon appears in the bottom-right corner.

---

## Link for Emails

```
https://icpac.vercel.app
```

(Or `https://ai.icpac.org.cy` once the custom domain is set up)
