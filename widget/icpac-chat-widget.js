(function() {
  var API_URL = 'https://ai.icpac.org.cy/api/chat';
  var history = [];
  var isLoading = false;

  var css = '#icpac-widget{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;font-size:14px}#icpac-bubble{position:fixed;bottom:20px;right:20px;width:60px;height:60px;border-radius:50%;background:#1a56db;color:#fff;border:none;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.15);z-index:999999;display:flex;align-items:center;justify-content:center}#icpac-bubble:hover{transform:scale(1.05)}#icpac-bubble svg{width:28px;height:28px}#icpac-window{position:fixed;bottom:90px;right:20px;width:380px;height:520px;max-height:calc(100vh - 120px);background:#fff;border-radius:12px;box-shadow:0 5px 40px rgba(0,0,0,.16);z-index:999998;display:none;flex-direction:column;overflow:hidden}#icpac-window.open{display:flex}#icpac-header{background:#1a56db;color:#fff;padding:16px 20px;display:flex;align-items:center;justify-content:space-between}#icpac-header h3{margin:0;font-size:16px;font-weight:600}#icpac-close{background:none;border:none;color:#fff;cursor:pointer;padding:4px}#icpac-messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px}.icpac-msg{max-width:85%;padding:10px 14px;border-radius:12px;word-wrap:break-word;line-height:1.45}.icpac-msg.bot{background:#f1f3f4;color:#1f2937;align-self:flex-start;border-bottom-left-radius:4px}.icpac-msg.bot ul,.icpac-msg.bot ol{margin:4px 0;padding-left:20px}.icpac-msg.bot li{margin:2px 0}.icpac-msg.bot strong{font-weight:600}.icpac-msg.bot a{color:#1a56db}.icpac-msg.bot p{margin:5px 0}.icpac-msg.bot p:first-child{margin-top:0}.icpac-msg.bot p:last-child{margin-bottom:0}.icpac-src{margin-top:8px;padding-top:6px;border-top:1px solid #e2e5e9;font-size:12px;color:#6b7280}.icpac-src a{display:inline-block;margin:2px 6px 2px 0;color:#1a56db;text-decoration:none}.icpac-msg.user{background:#1a56db;color:#fff;align-self:flex-end;border-bottom-right-radius:4px}.icpac-msg.typing{display:flex;gap:4px;padding:14px 18px}.icpac-msg.typing span{width:8px;height:8px;background:#90949c;border-radius:50%;animation:icpac-dot 1.4s infinite}.icpac-msg.typing span:nth-child(2){animation-delay:.2s}.icpac-msg.typing span:nth-child(3){animation-delay:.4s}@keyframes icpac-dot{0%,60%,100%{transform:translateY(0)}30%{transform:translateY(-4px)}}#icpac-input-wrap{padding:12px 16px;border-top:1px solid #e5e7eb;display:flex;gap:8px}#icpac-input{flex:1;padding:10px 14px;border:1px solid #e5e7eb;border-radius:8px;outline:none;font-size:14px}#icpac-input:focus{border-color:#1a56db}#icpac-send{background:#1a56db;color:#fff;border:none;border-radius:8px;padding:10px 16px;cursor:pointer;font-weight:500}#icpac-send:disabled{background:#9ca3af;cursor:not-allowed}@media(max-width:480px){#icpac-window{width:calc(100vw - 20px);height:calc(100vh - 100px);bottom:80px;right:10px}}';

  var container = document.createElement('div');
  container.id = 'icpac-widget';

  var style = document.createElement('style');
  style.textContent = css;
  container.appendChild(style);

  container.innerHTML += '<button id="icpac-bubble"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12z"/></svg></button><div id="icpac-window"><div id="icpac-header"><h3>ICPAC Assistant</h3><button id="icpac-close"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg></button></div><div id="icpac-messages"></div><div id="icpac-input-wrap"><input type="text" id="icpac-input" placeholder="Type your message..."><button id="icpac-send">Send</button></div></div>';

  function init() {
    document.body.appendChild(container);
    var messagesEl = document.getElementById('icpac-messages');
    var input = document.getElementById('icpac-input');
    var sendBtn = document.getElementById('icpac-send');
    var win = document.getElementById('icpac-window');

    addStaticBot('Hello! I’m the ICPAC assistant. Ask me about membership, the accountancy & audit profession in Cyprus, regulations, CPD, events, forms, and more.');

    document.getElementById('icpac-bubble').onclick = function() { win.classList.toggle('open'); if(win.classList.contains('open')) input.focus(); };
    document.getElementById('icpac-close').onclick = function() { win.classList.remove('open'); };
    sendBtn.onclick = send;
    input.onkeypress = function(e) { if(e.key === 'Enter') send(); };

    function escapeHtml(str) {
      return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function formatMarkdown(text) {
      var s = escapeHtml(text);
      s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
      s = s.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
      s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      s = s.replace(/(^|[^*])\*(?!\s)([^*]+?)\*(?!\*)/g, '$1<em>$2</em>');
      s = s.replace(/^[\t ]*\d+\.\s+(.+)$/gm, '<oli>$1</oli>');
      s = s.replace(/^[\t ]*[-•]\s+(.+)$/gm, '<li>$1</li>');
      s = s.replace(/(<oli>[\s\S]*?<\/oli>)/g, function(m){ return '<ol>' + m.replace(/oli>/g,'li>') + '</ol>'; });
      s = s.replace(/<\/ol>\s*<ol>/g, '');
      s = s.replace(/(<li>[\s\S]*?<\/li>)/g, function(m){ return '<ul>' + m + '</ul>'; });
      s = s.replace(/<\/ul>\s*<ul>/g, '');
      s = s.split(/\n{2,}/).map(function(b){
        if (/^\s*<(ul|ol)>/.test(b)) return b;
        return '<p>' + b.replace(/\n/g, '<br>') + '</p>';
      }).join('');
      return s;
    }

    function addStaticBot(text) {
      var div = document.createElement('div');
      div.className = 'icpac-msg bot';
      div.innerHTML = formatMarkdown(text);
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function bubble(type) {
      var div = document.createElement('div');
      div.className = 'icpac-msg ' + type;
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return div;
    }

    function renderSources(el, sources) {
      if (!sources || !sources.length) return;
      var wrap = document.createElement('div');
      wrap.className = 'icpac-src';
      wrap.innerHTML = 'Sources: ' + sources.map(function(s){
        return '<a href="' + encodeURI(s.url) + '" target="_blank" rel="noopener">' + escapeHtml(s.title || s.url) + '</a>';
      }).join('');
      el.appendChild(wrap);
    }

    function send() {
      var text = input.value.trim();
      if (!text || isLoading) return;
      bubble('user').textContent = text;
      history.push({ role: 'user', content: text });
      input.value = '';
      isLoading = true;
      sendBtn.disabled = true;

      var botEl = bubble('bot');
      botEl.classList.add('typing');
      botEl.innerHTML = '<span></span><span></span><span></span>';

      var acc = '', sources = null, contentEl = null;
      function ensureContent() {
        if (!contentEl) {
          botEl.classList.remove('typing');
          botEl.innerHTML = '';
          contentEl = document.createElement('div');
          botEl.appendChild(contentEl);
        }
      }

      fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history.slice(-12) })
      }).then(function(resp) {
        if (!resp.ok || !resp.body) throw new Error('bad response');
        var reader = resp.body.getReader();
        var decoder = new TextDecoder();
        var buf = '';

        function pump() {
          return reader.read().then(function(res) {
            if (res.done) return finish();
            buf += decoder.decode(res.value, { stream: true });
            var parts = buf.split('\n\n');
            buf = parts.pop();
            parts.forEach(handleEvent);
            messagesEl.scrollTop = messagesEl.scrollHeight;
            return pump();
          });
        }

        function handleEvent(block) {
          var event = null, dataLines = [];
          block.split('\n').forEach(function(line) {
            if (line.indexOf('event:') === 0) event = line.slice(6).trim();
            else if (line.indexOf('data:') === 0) dataLines.push(line.slice(5).trim());
          });
          if (!dataLines.length) return;
          var payload;
          try { payload = JSON.parse(dataLines.join('\n')); } catch (e) { return; }
          if (event === 'sources') { sources = payload; return; }
          if (payload.error) { ensureContent(); contentEl.innerHTML = formatMarkdown(payload.error); return; }
          if (payload.delta) { acc += payload.delta; ensureContent(); contentEl.innerHTML = formatMarkdown(acc); }
          if (payload.done) finish();
        }

        function finish() {
          ensureContent();
          contentEl.innerHTML = formatMarkdown(acc || '…');
          renderSources(botEl, sources);
          if (acc) history.push({ role: 'assistant', content: acc });
          isLoading = false; sendBtn.disabled = false; input.focus();
        }

        return pump();
      }).catch(function() {
        botEl.classList.remove('typing');
        botEl.innerHTML = 'Sorry, something went wrong. Please try again.';
        isLoading = false; sendBtn.disabled = false; input.focus();
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
