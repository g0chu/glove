/** Self-contained inspector page; model content is rendered only as text. */
export function renderPage(nonce: string): string {
  return String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Glove · API Inspector</title>
<style nonce="${nonce}
">
:root{color-scheme:dark;--bg:#0b1017;--panel:#101823;--border:#243041;--muted:#8d9bb0;--text:#e2eaf5;--mint:#76e1bc;--blue:#90b6ff}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(ellipse at 80% 0%,#15273a 0,transparent 45%),var(--bg);color:var(--text);font:14px/1.6 system-ui,sans-serif}
button,input{font:inherit}
button{cursor:pointer}
button:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid var(--mint);outline-offset:3px}
header{padding:23px 32px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:16px}
.logo{border:1px solid #365a54;color:var(--mint);border-radius:12px;width:42px;height:42px;display:grid;place-items:center;font-size:23px;background:#15322c}
.brand-suffix{color:var(--muted);font-weight:400}
h1{font-size:19px;margin:0;letter-spacing:-.5px}
.subtitle{color:var(--muted);font-size:12px}
.live{margin-left:auto;display:flex;align-items:center;gap:8px;color:var(--mint);font-size:12px}
.dot{width:7px;height:7px;background:var(--mint);border-radius:50%;box-shadow:0 0 14px #76e1bc66}
.shell{display:grid;grid-template-columns:310px minmax(0,1fr);min-height:calc(100vh - 90px)}
aside{border-right:1px solid var(--border);padding:22px 16px;position:sticky;top:0;height:calc(100vh - 90px);display:flex;flex-direction:column}
#list{overflow:auto;min-height:0;flex:1;scrollbar-color:#334457 transparent}
.eyebrow{text-transform:uppercase;letter-spacing:2px;font-size:10px;color:var(--muted);font-weight:700}
.aside-head{display:flex;justify-content:space-between;margin:0 8px 16px}
input{width:100%;background:#0b111b;border:1px solid var(--border);color:var(--text);padding:10px 12px;border-radius:8px;margin-bottom:15px}
.request{display:block;text-align:left;width:100%;border:1px solid transparent;border-radius:10px;padding:13px 12px;color:var(--text);background:transparent;margin-bottom:5px}
.request:hover{background:#17212e}
.request.selected{border-color:#38564f;background:#162d29}
.request-top{display:flex;justify-content:space-between;gap:10px;margin-bottom:5px}
.badge{border-radius:5px;padding:1px 7px;font-size:10px;text-transform:uppercase;letter-spacing:.6px;background:#263343;color:#b3c8e5}
.badge.finished{background:#183d32;color:var(--mint)}
.badge.failed{background:#46272d;color:#ff9da8}
.badge.pending{background:#3c3521;color:#ebd397}
.request small{display:block;color:var(--muted);font-size:11px}
.request code{font-size:10px;color:#8193a9}
main{min-width:0;padding:30px;max-width:1800px}
.empty{padding:90px 20px;text-align:center;color:var(--muted)}
.empty b{display:block;color:var(--text);font-size:23px;letter-spacing:-.6px;margin-bottom:8px}
.empty-icon{font-size:36px;color:var(--mint);margin-bottom:12px}
.detail-head{display:flex;align-items:center;gap:12px;margin-bottom:8px}
h2{font-size:24px;letter-spacing:-.7px;margin:0}
.meta{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0 23px}
.chip{border:1px solid var(--border);background:#111c29;border-radius:6px;padding:4px 9px;color:var(--muted);font-size:11px}
.chip span{color:#d0dff3;margin-left:6px}
.panels{display:grid;grid-template-columns:1fr 1fr;gap:18px}
.panel{border:1px solid var(--border);border-radius:12px;background:#101823;overflow:hidden;min-width:0}
.panel-head{padding:17px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px}
.number{font:12px ui-monospace,monospace;border:1px solid #3c4c60;border-radius:5px;padding:1px 5px;color:var(--blue)}
.panel.output .number{color:var(--mint);border-color:#365a54}
.panel-head b{font-size:13px}
.size{color:var(--muted);font:10px ui-monospace,monospace;margin-left:auto}
.toolbar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:10px 12px;border-bottom:1px solid var(--border);background:#0e1620}
.toolbar button,.secondary{border:1px solid var(--border);color:var(--muted);background:transparent;border-radius:6px;padding:4px 9px;font-size:11px}
.toolbar button.active{background:#243344;color:var(--text);border-color:#3b536a}
.toolbar .spacer{flex:1}
.toolbar button:hover,.secondary:hover{color:var(--text);border-color:#60758e}
.body{padding:18px;max-height:70vh;overflow:auto;scrollbar-color:#334457 transparent}
pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.85 ui-monospace,SFMono-Regular,Consolas,monospace;tab-size:2;color:#c1d0e2}
.key{color:#92b9fa}
.str{color:#a0ddc5}
.num{color:#e9bd8b}
.bool{color:#c1a0ec}
.message{border:1px solid var(--border);border-radius:8px;margin-bottom:12px;overflow:hidden}
.message summary{cursor:pointer;padding:10px 12px;background:#152131;font-size:12px}
.message pre{padding:13px}
.role{color:var(--mint);text-transform:uppercase;font-size:10px;letter-spacing:1px;margin-right:9px}
.prose{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;color:#d9e6f5;margin-bottom:16px}
.section-label{color:var(--muted);font-size:10px;letter-spacing:1.4px;text-transform:uppercase;margin:8px 0 10px}
.error{border:1px solid #72404a;color:#ffb1bb;background:#301c25;padding:12px;border-radius:8px;margin-bottom:18px}
.foot{margin-top:18px;color:var(--muted);font-size:11px;display:flex;justify-content:space-between;gap:10px}
#more{width:100%;margin-top:12px}
[hidden]{display:none!important}
@media(min-width:1600px){.body{max-height:74vh}
}
@media(max-width:1100px){.panels{grid-template-columns:1fr}
.body{max-height:55vh}
}
@media(max-width:700px){header{padding:18px}
.shell{grid-template-columns:1fr}
aside{border-right:0;border-bottom:1px solid var(--border);position:static;height:auto}
#list{max-height:220px;overflow:auto}
main{padding:20px}
.live{font-size:10px}
.foot{display:block}
}

</style></head><body>
<header><div class="logo" aria-hidden="true">↗</div><div><h1>Glove <span class="brand-suffix">/ API Inspector</span></h1><div class="subtitle">A window into your model conversations</div></div><div class="live"><span class="dot"></span><span id="connection" role="status">Connecting</span></div></header>
<div class="shell"><aside><div class="aside-head"><span class="eyebrow">Request timeline</span><span class="eyebrow" id="count"></span></div><input id="search" aria-label="Filter requests" placeholder="Search channel, purpose, status…"><div id="list"></div><button id="more" class="secondary" hidden>Load earlier requests</button></aside>
<main><div id="error" class="error" role="alert" hidden></div><div id="empty" class="empty"><div class="empty-icon">⌘</div><b>Every exchange, in view.</b>Select a request to explore its input and output.<br>New interactions appear here automatically.</div><div id="detail" hidden><div class="eyebrow">Chat Completions · request detail</div><div class="detail-head"><h2 id="title"></h2><span id="state" class="badge"></span></div><div id="meta" class="meta"></div><div class="panels">
<section class="panel"><div class="panel-head"><span class="number">01</span><b>Input</b><span class="size" id="input-size"></span></div><div class="toolbar" id="input-toolbar"><button data-view="messages" class="active">Messages</button><button data-view="json">JSON</button><button data-view="raw">Raw</button><span class="spacer"></span><button data-action="copy">Copy</button><button data-action="download">↓ Save</button></div><div id="input" class="body"></div></section>
<section class="panel output"><div class="panel-head"><span class="number">02</span><b>Output</b><span class="size" id="output-size"></span></div><div class="toolbar" id="output-toolbar"><button data-view="readable" class="active">Readable</button><button data-view="json">JSON</button><button data-view="raw">Raw stream</button><span class="spacer"></span><button data-action="copy">Copy</button><button data-action="download">↓ Save</button></div><div id="output" class="body"></div></section>
</div><div class="foot"><span>Read-only archive · refreshes every 2 seconds · authorization headers excluded</span><span id="request-id"></span></div></div></main></div>
<script nonce="${nonce}">
const $ = id => document.getElementById(id);
let items = [], selected = null, detail = null, next = null, inputView = 'messages', outputView = 'readable', generation = 0, busy = false, searchTimer;
function node(tag, text, cls) { const e = document.createElement(tag); if (text !== undefined)
    e.textContent = text; if (cls)
    e.className = cls; return e; }
function json(value) { return JSON.stringify(value, null, 2); }
function code(value, highlight = true) { const p = node('pre'); const text = typeof value === 'string' ? value : json(value); if (!highlight) {
    p.textContent = text;
    return p;
} const regex = /("(?:\\.|[^"\\])*"\s*:)|("(?:\\.|[^"\\])*")|\b(true|false|null)\b|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)/g; let last = 0; for (const m of text.matchAll(regex)) {
    p.append(document.createTextNode(text.slice(last, m.index)));
    p.append(node('span', m[0], m[1] ? 'key' : m[2] ? 'str' : m[3] ? 'bool' : 'num'));
    last = m.index + m[0].length;
} p.append(document.createTextNode(text.slice(last))); return p; }
async function api(url) { const res = await fetch(url); if (!res.ok)
    throw Error('Could not read archive (' + res.status + '). See the UI terminal for details.'); return res.json(); }
function showError(e) { $('error').textContent = e.message; $('error').hidden = false; $('connection').textContent = 'Connection paused'; }
function timeline() { const root = $('list'); root.replaceChildren(); $('count').textContent = items.length + (next ? '＋' : ''); $('more').hidden = !next; if (!items.length)
    root.append(node('div', 'No matching requests yet.', 'empty')); for (const item of items) {
    const b = node('button', undefined, 'request' + (selected === item.id ? ' selected' : ''));
    const top = node('div', undefined, 'request-top');
    top.append(node('span', item.scope.purpose || 'reply'), node('span', item.state, 'badge ' + item.state));
    b.append(top, node('small', new Date(item.time).toLocaleString()), node('small', 'Channel ' + (item.scope.channelId || '—')), node('code', item.id.slice(0, 18) + '…'));
    b.onclick = () => select(item.id);
    root.append(b);
} }
async function select(id) { selected = id; detail = null; const token = ++generation; timeline(); $('empty').hidden = false; $('empty').replaceChildren(node('b', 'Loading interaction…')); $('detail').hidden = true; try {
    const d = await api('/api/requests/' + encodeURIComponent(id));
    if (token !== generation)
        return;
    detail = d;
    render();
}
catch (e) {
    if (token === generation)
        showError(e);
} }
function event(type) { return detail.events.find(e => e.type === type)?.data; }
function chip(label, value) { const c = node('div', label, 'chip'); c.append(node('span', String(value))); return c; }
function render() { if (!detail)
    return; $('empty').hidden = true; $('detail').hidden = false; $('title').textContent = (detail.scope.purpose || 'reply').replace(/-/g, ' ') + ' interaction'; $('state').textContent = detail.state; $('state').className = 'badge ' + detail.state; const meta = $('meta'); meta.replaceChildren(chip('Channel', detail.scope.channelId || '—'), chip('Time', new Date(detail.time).toLocaleString()), chip('HTTP', event('model.status')?.status || '—'), chip('Model', event('model.request')?.model || '—')); if (detail.scope.round !== undefined)
    meta.append(chip('Round', detail.scope.round)); if (event('model.finished')?.usage)
    meta.append(chip('Usage', json(event('model.finished').usage))); $('request-id').textContent = detail.id; $('input-size').textContent = new TextEncoder().encode(JSON.stringify(event('model.request') || {})).length.toLocaleString() + ' bytes'; $('output-size').textContent = detail.responseBytes.toLocaleString() + ' bytes'; renderInput(); renderOutput(); }
function renderInput() { const root = $('input'); root.replaceChildren(); const request = event('model.request'); if (!request) {
    root.append(node('div', 'The request body was not sent or captured.', 'subtitle'));
    return;
} if (inputView === 'raw')
    root.append(code(JSON.stringify(request), false));
else if (inputView === 'json')
    root.append(code(request));
else {
    const settings = { ...request };
    delete settings.messages;
    const settingsPanel = node('details', undefined, 'message');
    settingsPanel.append(node('summary', 'Request settings & tool schemas'), code(settings));
    root.append(settingsPanel);
    root.append(node('div', 'Conversation · ' + (request.messages || []).length + ' messages', 'section-label'));
    for (const [i, m] of (request.messages || []).entries()) {
        const d = node('details', undefined, 'message');
        d.open = true;
        const summary = node('summary');
        summary.append(node('span', m.role, 'role'), document.createTextNode('Message ' + (i + 1) + (m.name ? ' · ' + m.name : '')));
        d.append(summary, typeof m.content === 'string' ? code(m.content, false) : code(m.content));
        const extra = { ...m };
        delete extra.role;
        delete extra.content;
        if (Object.keys(extra).length)
            d.append(code(extra));
        root.append(d);
    }
} }
function renderOutput() { const root = $('output'); root.replaceChildren(); const result = event('model.finished'), failed = event('model.failed'); if (failed)
    root.append(node('div', failed.error, 'error')); if (outputView === 'raw') {
    root.append(code(detail.rawResponse || 'No response bytes captured yet.', false));
    return;
} if (outputView === 'json') {
    try {
        root.append(code(JSON.parse(detail.rawResponse)));
    }
    catch {
        const frames = detail.rawResponse.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => { const raw = l.slice(5).trim(); try {
            return JSON.parse(raw);
        }
        catch {
            return raw;
        } });
        root.append(code(frames.length ? frames : result || { state: detail.state }));
    }
    return;
} let content = result?.content || '', reasoning = result?.reasoning || '', calls = result?.toolCalls || []; if (!result) {
    for (const line of detail.rawResponse.split(/\r?\n/)) {
        if (!line.startsWith('data:'))
            continue;
        try {
            const part = JSON.parse(line.slice(5));
            const delta = part.choices?.[0]?.delta;
            content += delta?.content || '';
            reasoning += delta?.reasoning_content || delta?.reasoning || '';
        }
        catch { }
    }
} if (reasoning) {
    const d = node('details', undefined, 'message');
    d.append(node('summary', 'Reasoning'), code(reasoning, false));
    root.append(d);
} if (content)
    root.append(node('div', 'Assistant response', 'section-label'), node('div', content, 'prose')); if (calls.length)
    root.append(node('div', 'Tool calls', 'section-label'), code(calls)); if (!content && !reasoning && !calls.length)
    root.append(node('div', detail.state === 'pending' ? 'Waiting for response…' : 'No assistant text. Inspect JSON or raw bytes for the complete exchange.', 'subtitle')); if (result) {
    const extra = { ...result };
    delete extra.content;
    delete extra.reasoning;
    delete extra.toolCalls;
    if (Object.keys(extra).length)
        root.append(node('div', 'Completion metadata', 'section-label'), code(extra));
} }
for (const side of ['input', 'output']) {
    $(side + '-toolbar').onclick = async (e) => { const b = e.target.closest('button'); if (!b || !detail)
        return; if (b.dataset.view) {
        if (side === 'input')
            inputView = b.dataset.view;
        else
            outputView = b.dataset.view;
        for (const t of $(side + '-toolbar').querySelectorAll('[data-view]'))
            t.classList.toggle('active', t === b);
        side === 'input' ? renderInput() : renderOutput();
        return;
    } const text = side === 'input' ? JSON.stringify(event('model.request') || {}) : detail.rawResponse; if (b.dataset.action === 'copy') {
        try {
            await navigator.clipboard.writeText(text);
            b.textContent = 'Copied';
            setTimeout(() => b.textContent = 'Copy', 1200);
        }
        catch {
            showError(Error('Clipboard unavailable. Use Save to download the captured body.'));
        }
    }
    else {
        const bytes = side === 'input' ? text : Uint8Array.from(atob(detail.responseBase64), c => c.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: side === 'input' ? 'application/json' : 'application/octet-stream' }));
        const a = node('a');
        a.href = url;
        a.download = detail.id + '-' + side + (side === 'input' ? '.json' : '.txt');
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    } };
}
async function refresh(append = false) { if (busy)
    return; busy = true; const token = generation, query = $('search').value; try {
    const page = await api('/api/requests?q=' + encodeURIComponent(query) + (append && next ? '&before=' + next : ''));
    if (query !== $('search').value)
        return;
    if (append)
        items.push(...page.items);
    else {
        const older = items.filter(i => !page.items.some(n => n.id === i.id));
        items = page.items.concat(older);
        if (!older.length)
            next = page.next;
    }
    if (append)
        next = page.next;
    timeline();
    if (selected && token === generation) {
        const current = items.find(i => i.id === selected);
        if (!detail || detail.state === 'pending' || current?.updated !== detail.updated) {
            const d = await api('/api/requests/' + encodeURIComponent(selected));
            if (token === generation) {
                detail = d;
                render();
            }
        }
    }
    $('connection').textContent = 'Live · 2s refresh';
    $('error').hidden = true;
}
catch (e) {
    showError(e);
}
finally {
    busy = false;
} }
$('search').oninput = () => { clearTimeout(searchTimer); items = []; next = null; searchTimer = setTimeout(() => refresh(), 200); };
$('more').onclick = () => refresh(true);
refresh();
setInterval(() => { if (!document.hidden)
    refresh(); }, 2000);
</script></body></html>`;
}
