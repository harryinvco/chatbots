(function() {
  var API_URL = 'https://icpac.vercel.app/api/chat';
  var conversationId = null;
  var isLoading = false;

  var css = '#icpac-widget{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;font-size:14px}#icpac-bubble{position:fixed;bottom:20px;right:20px;width:60px;height:60px;border-radius:50%;background:#1a56db;color:#fff;border:none;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.15);z-index:999999;display:flex;align-items:center;justify-content:center}#icpac-bubble:hover{transform:scale(1.05)}#icpac-bubble svg{width:28px;height:28px}#icpac-window{position:fixed;bottom:90px;right:20px;width:380px;height:520px;max-height:calc(100vh - 120px);background:#fff;border-radius:12px;box-shadow:0 5px 40px rgba(0,0,0,.16);z-index:999998;display:none;flex-direction:column;overflow:hidden}#icpac-window.open{display:flex}#icpac-header{background:#1a56db;color:#fff;padding:16px 20px;display:flex;align-items:center;justify-content:space-between}#icpac-header h3{margin:0;font-size:16px;font-weight:600}#icpac-close{background:none;border:none;color:#fff;cursor:pointer;padding:4px}#icpac-messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px}.icpac-msg{max-width:85%;padding:10px 14px;border-radius:12px;word-wrap:break-word}.icpac-msg.bot{background:#f1f3f4;color:#1f2937;align-self:flex-start;border-bottom-left-radius:4px}.icpac-msg.user{background:#1a56db;color:#fff;align-self:flex-end;border-bottom-right-radius:4px}.icpac-msg.typing{display:flex;gap:4px;padding:14px 18px}.icpac-msg.typing span{width:8px;height:8px;background:#90949c;border-radius:50%;animation:icpac-dot 1.4s infinite}.icpac-msg.typing span:nth-child(2){animation-delay:.2s}.icpac-msg.typing span:nth-child(3){animation-delay:.4s}@keyframes icpac-dot{0%,60%,100%{transform:translateY(0)}30%{transform:translateY(-4px)}}#icpac-input-wrap{padding:12px 16px;border-top:1px solid #e5e7eb;display:flex;gap:8px}#icpac-input{flex:1;padding:10px 14px;border:1px solid #e5e7eb;border-radius:8px;outline:none;font-size:14px}#icpac-input:focus{border-color:#1a56db}#icpac-send{background:#1a56db;color:#fff;border:none;border-radius:8px;padding:10px 16px;cursor:pointer;font-weight:500}#icpac-send:disabled{background:#9ca3af;cursor:not-allowed}@media(max-width:480px){#icpac-window{width:calc(100vw - 20px);height:calc(100vh - 100px);bottom:80px;right:10px}}';

  var container = document.createElement('div');
  container.id = 'icpac-widget';

  var style = document.createElement('style');
  style.textContent = css;
  container.appendChild(style);

  container.innerHTML += '<button id="icpac-bubble"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12z"/></svg></button><div id="icpac-window"><div id="icpac-header"><h3>ICPAC Assistant</h3><button id="icpac-close"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg></button></div><div id="icpac-messages"></div><div id="icpac-input-wrap"><input type="text" id="icpac-input" placeholder="Type your message..."><button id="icpac-send">Send</button></div></div>';

  function init() {
    document.body.appendChild(container);
    var messages = document.getElementById('icpac-messages');
    var input = document.getElementById('icpac-input');
    var sendBtn = document.getElementById('icpac-send');
    var win = document.getElementById('icpac-window');

    addMsg('Hello! How can I help you today?', 'bot');

    document.getElementById('icpac-bubble').onclick = function() { win.classList.toggle('open'); if(win.classList.contains('open')) input.focus(); };
    document.getElementById('icpac-close').onclick = function() { win.classList.remove('open'); };
    sendBtn.onclick = send;
    input.onkeypress = function(e) { if(e.key === 'Enter') send(); };

    function addMsg(text, type) {
      var div = document.createElement('div');
      div.className = 'icpac-msg ' + type;
      div.textContent = text;
      messages.appendChild(div);
      messages.scrollTop = messages.scrollHeight;
    }

    function send() {
      var text = input.value.trim();
      if (!text || isLoading) return;
      addMsg(text, 'user');
      input.value = '';
      isLoading = true;
      sendBtn.disabled = true;

      var typing = document.createElement('div');
      typing.className = 'icpac-msg bot typing';
      typing.id = 'typing';
      typing.innerHTML = '<span></span><span></span><span></span>';
      messages.appendChild(typing);
      messages.scrollTop = messages.scrollHeight;

      fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputs: { user_name: 'Visitor' }, query: text, response_mode: 'blocking', conversation_id: conversationId || '', user: localStorage.getItem('icpac_uid') || (localStorage.setItem('icpac_uid', 'u' + Math.random().toString(36).substr(2, 9)), localStorage.getItem('icpac_uid')) })
      })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        conversationId = data.conversation_id;
        var t = document.getElementById('typing'); if(t) t.remove();
        addMsg(data.answer, 'bot');
      })
      .catch(function() {
        var t = document.getElementById('typing'); if(t) t.remove();
        addMsg('Sorry, something went wrong. Please try again.', 'bot');
      })
      .finally(function() { isLoading = false; sendBtn.disabled = false; input.focus(); });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
