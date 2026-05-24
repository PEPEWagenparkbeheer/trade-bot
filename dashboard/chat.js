// Chat widget — praat met /api/chat (Claude Haiku met live bot-context).
// Werkt alleen lokaal (lokale FastAPI heeft Anthropic key); op Vercel verbergen we de bubbel.

if (!window.BOT_CONFIG?.LOCAL) {
    document.getElementById('chat-fab')?.remove();
    document.getElementById('chat-panel')?.remove();
}

const fab = document.getElementById('chat-fab');
const panel = document.getElementById('chat-panel');
const closeBtn = document.getElementById('chat-close');
const form = document.getElementById('chat-form');
const input = document.getElementById('chat-input');
const sendBtn = document.getElementById('chat-send');
const messagesEl = document.getElementById('chat-messages');

const history = []; // [{role:'user'|'assistant', content:'...'}]

if (!fab) { /* on Vercel — chat hidden */ } else {

fab.addEventListener('click', () => {
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) input.focus();
});
closeBtn.addEventListener('click', () => panel.classList.add('hidden'));

form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;

    addMessage('user', text);
    history.push({ role: 'user', content: text });
    input.value = '';
    sendBtn.disabled = true;

    const thinking = addMessage('assistant', '…', true);
    try {
        const r = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: history }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.detail || 'fout');
        thinking.textContent = data.reply;
        history.push({ role: 'assistant', content: data.reply });
    } catch (err) {
        thinking.textContent = '⚠️ ' + err.message;
        thinking.classList.add('text-red-400');
    } finally {
        sendBtn.disabled = false;
        messagesEl.scrollTop = messagesEl.scrollHeight;
        input.focus();
    }
});

}  // end if(fab) wrapper

function addMessage(role, content, italic = false) {
    const wrap = document.createElement('div');
    wrap.className = role === 'user'
        ? 'flex justify-end'
        : 'flex justify-start';
    const bubble = document.createElement('div');
    bubble.className = role === 'user'
        ? 'bg-emerald-500/20 border border-emerald-500/30 rounded-lg px-3 py-2 max-w-[85%] whitespace-pre-wrap'
        : 'bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 max-w-[85%] whitespace-pre-wrap' + (italic ? ' italic text-slate-400' : '');
    bubble.textContent = content;
    wrap.appendChild(bubble);
    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return bubble;
}
