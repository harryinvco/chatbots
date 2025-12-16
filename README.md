# ICPAC AI Chatbot - Setup Instructions

## What You Get

- **ai.icpac.org.cy** - Full chat page (link this in emails)
- **Chat bubble** - Popup widget for your website

---

## Setup the Domain

Add this DNS record to `icpac.org.cy`:

| Type  | Name | Value                |
|-------|------|----------------------|
| CNAME | ai   | cname.vercel-dns.com |

Wait 5-10 minutes for it to work.

---

## Add Chat Bubble to Your Website

Paste this line before `</body>` on any page:

```html
<script src="https://ai.icpac.org.cy/widget/icpac-chat-widget.js"></script>
```

A blue chat icon will appear in the bottom-right corner.

---

## Link for Emails

```
https://ai.icpac.org.cy
```
