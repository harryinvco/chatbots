# ICPAC AI Chatbot

Live at: **https://icpac.vercel.app**

---

## 1. Full Chat Page

Use this link in emails, newsletters, or anywhere:

```
https://icpac.vercel.app
```

---

## 2. Chat Bubble for Your Website

To add the chat bubble to any page on your website, paste this code right before the `</body>` tag:

```html
<script src="https://icpac.vercel.app/widget/icpac-chat-widget.js"></script>
```

This adds a blue chat icon in the bottom-right corner. Click it to open the chat.

---

## 3. Custom Domain (Optional)

If you want to use `ai.icpac.org.cy` instead:

1. Go to your domain provider (where you manage icpac.org.cy)
2. Add this DNS record:

| Type  | Name | Value                |
|-------|------|----------------------|
| CNAME | ai   | cname.vercel-dns.com |

3. Wait 5-10 minutes
4. Then update the widget code to:

```html
<script src="https://ai.icpac.org.cy/widget/icpac-chat-widget.js"></script>
```
