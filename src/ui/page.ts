/** Self-contained inspector page; model content is rendered only as text. */
export function renderPage(nonce: string): string {
  return String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Glove · API Inspector</title>
<style nonce="${nonce}">
:root{color-scheme:dark;--bg:#0b1017;--panel:#101823;--border:#243041;--muted:#8d9bb0;--text:#e2eaf5;--mint:#76e1bc;--blue:#90b6ff}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(ellipse at 80% 0%,#15273a 0,transparent 45%),var(--bg);color:var(--text);font:14px/1.6 system-ui,sans-serif}
button,input{font:inherit}
.controls{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.controls label{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text)}
.controls input{width:auto;margin:0;accent-color:var(--mint)}
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
.message{border:1px solid var(--border);border-radius:8px;margin-bottom:12px;overflow:hidden}
.message summary{cursor:pointer;padding:10px 12px;background:#152131;font-size:12px}
.message .prose,.message .section-label{margin:12px}
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
<main><div class="toolbar controls"><label><input id="live" type="checkbox" checked>Live updates</label><label><input id="follow" type="checkbox" checked>Follow newest request</label><button id="refresh" type="button">Refresh now</button><span class="subtitle">Live captures update every 0.5s; pause to inspect.</span></div><div id="error" class="error" role="alert" hidden></div><div id="empty" class="empty"><div class="empty-icon">⌘</div><b>Every exchange, in view.</b>Select a request to explore its input and output.<br>Live mode follows new requests automatically.</div><div id="detail" hidden><div class="eyebrow">Chat Completions · request detail</div><div class="detail-head"><h2 id="title"></h2><span id="state" class="badge"></span></div><div id="meta" class="meta"></div><div class="panels">
<section class="panel"><div class="panel-head"><span class="number">01</span><b>Conversation sent</b><span class="size" id="input-size"></span></div><div class="toolbar" id="input-toolbar"><span class="spacer"></span><button data-action="copy">Copy text</button><button data-action="download">↓ Save text</button></div><div id="input" class="body"></div></section>
<section class="panel output"><div class="panel-head"><span class="number">02</span><b>Assistant output</b><span class="size" id="output-size"></span></div><div class="toolbar" id="output-toolbar"><span class="spacer"></span><button data-action="copy">Copy text</button><button data-action="download">↓ Save text</button></div><div id="output" class="body"></div></section>
</div><div class="foot"><span>Read-only archive · live updates optional · authorization headers excluded</span><span id="request-id"></span></div></div></main></div>
<script nonce="${nonce}">
const $ = id => document.getElementById(id);
let items = [], selected = null, detail = null, next = null, generation = 0, busy = false, searchTimer, filterRevision = 0;
function node(tag, text, cls) { const e = document.createElement(tag); if (text !== undefined)
    e.textContent = text; if (cls)
    e.className = cls; return e; }
function prose(value) { return node('div', String(value ?? ''), 'prose'); }
function readableValue(value) {
    const root = node('div');
    if (Array.isArray(value)) for (const item of value) root.append(readableValue(item));
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
        root.append(node('div', key.replace(/_/g, ' '), 'section-label'), readableValue(item));
    }
    else root.append(prose(value));
    return root;
}
function toolCalls(calls) {
    const root = node('div');
    for (const call of calls) {
        const card = node('details', undefined, 'message');
        card.open = true;
        const fn = call.function || call;
        card.append(node('summary', fn.name || 'Tool call'));
        const args = fn.arguments;
        try { card.append(readableValue(typeof args === 'string' ? JSON.parse(args) : args)); }
        catch { card.append(prose(args)); }
        root.append(card);
    }
    return root;
}
function messageContent(content) {
    const root = node('div');
    if (typeof content === 'string') root.append(prose(content));
    else if (Array.isArray(content)) for (const part of content) {
        if (part.type === 'text') root.append(prose(part.text));
        else if (part.type === 'image_url') root.append(prose('Image attached'));
        else root.append(prose('Attachment: ' + (part.type || 'unknown type')));
    }
    return root;
}
async function api(url) { const res = await fetch(url); if (!res.ok)
    throw Error('Could not read archive (' + res.status + '). See the UI terminal for details.'); return res.json(); }
function showError(e) { $('error').textContent = e.message; $('error').hidden = false; $('connection').textContent = 'Connection paused'; }
function timeline() { const root = $('list'); root.replaceChildren(); $('count').textContent = items.length + (next ? '＋' : ''); $('more').hidden = !next; if (!items.length)
    root.append(node('div', 'No matching requests yet.', 'empty')); for (const item of items) {
    const b = node('button', undefined, 'request' + (selected === item.id ? ' selected' : ''));
    const top = node('div', undefined, 'request-top');
    top.append(node('span', item.scope.purpose || 'reply'), node('span', item.state, 'badge ' + item.state));
    b.append(top, node('small', new Date(item.time).toLocaleString()), node('small', 'Channel ' + (item.scope.channelId || '—')), node('code', item.id.slice(0, 18) + '…'));
    b.onclick = () => { $('follow').checked = false; select(item.id); };
    root.append(b);
} }
async function select(id) { selected = id; detail = null; const token = ++generation; timeline(); $('empty').hidden = false; $('empty').replaceChildren(node('b', 'Loading interaction…')); $('detail').hidden = true; try {
    const d = await api('/api/requests/' + encodeURIComponent(id) + '?view=readable');
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
    meta.append(chip('Tokens', (event('model.finished').usage.input ?? '—') + ' input · ' + (event('model.finished').usage.output ?? '—') + ' output')); $('request-id').textContent = detail.id; $('input-size').textContent = (event('model.request')?.messages?.length || 0) + ' messages'; $('output-size').textContent = detail.state === 'pending' ? 'Generating…' : 'Captured'; renderInput(); renderOutput(); }
function preservePanel(id, draw) {
    const root = $(id), top = root.scrollTop;
    const atEnd = root.scrollHeight - root.clientHeight - top < 24;
    const expanded = Array.from(root.querySelectorAll('details')).map(d => d.open);
    draw();
    root.querySelectorAll('details').forEach((d, i) => { if (i < expanded.length) d.open = expanded[i]; });
    root.scrollTop = id === 'output' && $('live').checked && atEnd ? root.scrollHeight : top;
}
function renderInput() { preservePanel('input', drawInput); }
function renderOutput() { preservePanel('output', drawOutput); }
function drawInput() { const root = $('input'); root.replaceChildren(); const request = event('model.request'); if (!request) {
    root.append(node('div', 'The request body was not sent or captured.', 'subtitle'));
    return;
}
    root.append(node('div', 'Conversation · ' + (request.messages || []).length + ' messages', 'section-label'));
    for (const [i, m] of (request.messages || []).entries()) {
        const card = node('details', undefined, 'message');
        card.open = true;
        const summary = node('summary');
        const role = { system: 'Instructions', user: 'User', assistant: 'Assistant', tool: 'Tool result' }[m.role] || m.role;
        summary.append(node('span', role, 'role'), document.createTextNode('Message ' + (i + 1) + (m.name ? ' · ' + m.name : '')));
        card.append(summary, messageContent(m.content));
        if (m.reasoning_content) card.append(node('div', 'Reasoning', 'section-label'), prose(m.reasoning_content));
        if (m.tool_calls?.length) card.append(toolCalls(m.tool_calls));
        root.append(card);
    }
    if (request.tools?.length) {
        const tools = node('details', undefined, 'message');
        tools.append(node('summary', 'Available tools'));
        for (const tool of request.tools) tools.append(node('div', tool.function?.name || 'Tool', 'section-label'), prose(tool.function?.description || ''));
        root.append(tools);
    }
}

function drawOutput() { const root = $('output'); root.replaceChildren(); const result = event('model.finished'), failed = event('model.failed'); if (failed)
    root.append(node('div', failed.error, 'error')); let content = result?.content || '', reasoning = result?.reasoning || '', calls = result?.toolCalls || []; if (!result) {
    const partialCalls = new Map();
    function consume(message, delta) {
        content += message?.content || '';
        reasoning += message?.reasoning_content || message?.reasoning || '';
        for (const [i, call] of (message?.tool_calls || []).entries()) {
            const index = call.index ?? i;
            const previous = partialCalls.get(index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
            if (call.id) previous.id = call.id;
            if (call.type) previous.type = call.type;
            for (const key of ['name', 'arguments']) {
                const value = call.function?.[key];
                if (typeof value === 'string') previous.function[key] = delta ? previous.function[key] + value : value;
            }
            partialCalls.set(index, previous);
        }
    }
    const progress = detail.events.filter(e => e.type === 'model.progress');
    if (progress.length) {
        for (const { data } of progress) {
            content += data.content || '';
            reasoning += data.reasoning || '';
            for (const call of data.toolCalls || []) {
                const previous = partialCalls.get(call.index) || { id: '', name: '', arguments: '' };
                if (call.id) previous.id = call.id;
                previous.name += call.name || '';
                previous.arguments += call.arguments || '';
                partialCalls.set(call.index, previous);
            }
        }
    } else {
        try { consume(JSON.parse(detail.rawResponse).choices?.[0]?.message, false); }
        catch {
            for (const line of detail.rawResponse.split(/\r?\n/)) {
                if (!line.startsWith('data:')) continue;
                try { consume(JSON.parse(line.slice(5)).choices?.[0]?.delta, true); }
                catch { } // Wait for a complete frame before rendering.
            }
        }
    }
    calls = Array.from(partialCalls.values());
} if (reasoning) {
    const d = node('details', undefined, 'message');
    d.open = true;
    d.append(node('summary', 'Reasoning'), prose(reasoning));
    root.append(d);
} if (content)
    root.append(node('div', 'Assistant response', 'section-label'), node('div', content, 'prose')); if (calls.length)
    root.append(node('div', 'Tool calls', 'section-label'), toolCalls(calls)); if (!content && !reasoning && !calls.length)
    root.append(node('div', detail.state === 'pending' ? 'Prompt sent · waiting for the API to generate output…' : 'No assistant text was returned.', 'subtitle')); }
for (const side of ['input', 'output']) {
    $(side + '-toolbar').onclick = async (e) => {
        const b = e.target.closest('button');
        if (!b || !detail) return;
        const text = $(side).innerText;
        if (b.dataset.action === 'copy') {
            try {
                await navigator.clipboard.writeText(text);
                b.textContent = 'Copied';
                setTimeout(() => b.textContent = 'Copy text', 1200);
            } catch { showError(Error('Clipboard unavailable. Use Save text instead.')); }
        } else {
            const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
            const a = node('a');
            a.href = url;
            a.download = detail.id + '-' + side + '.txt';
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
    };
}
async function refresh(append = false, automatic = false) { if (busy)
    return; busy = true; let token = generation; const revision = filterRevision, query = $('search').value; try {
    const page = await api('/api/requests?q=' + encodeURIComponent(query) + (append && next ? '&before=' + next : ''));
    if (revision !== filterRevision || (automatic && (token !== generation || !$('live').checked)))
        return;
    if (append)
        items.push(...page.items.filter(n => !items.some(i => i.id === n.id)));
    else {
        const older = items.filter(i => !page.items.some(n => n.id === i.id));
        items = page.items.concat(older);
        if (!older.length)
            next = page.next;
    }
    if (append)
        next = page.next;
    timeline();
    if ($('follow').checked && page.items.length && selected !== page.items[0].id && !append && token === generation) {
        await select(page.items[0].id);
        token = generation;
    }
    if (selected && token === generation) {
        const current = items.find(i => i.id === selected);
        if (!detail || (current && current.updated !== detail.updated)) {
            const d = await api('/api/requests/' + encodeURIComponent(selected) + '?view=readable');
            if (token === generation && revision === filterRevision) {
                detail = d;
                render();
            }
        }
    }
    if (automatic && token !== generation) return;
    $('connection').textContent = $('live').checked ? 'Live · 0.5s refresh' : 'Paused';
    $('error').hidden = true;
}
catch (e) {
    showError(e);
}
finally {
    busy = false;
    if (revision !== filterRevision) refresh();
} }
$('search').oninput = () => { clearTimeout(searchTimer); filterRevision++; items = []; next = null; searchTimer = setTimeout(() => refresh(), 200); };
$('more').onclick = () => refresh(true);
$('live').onchange = () => {
    generation++; // Discard in-flight automatic detail updates when pausing.
    $('connection').textContent = $('live').checked ? 'Connecting' : 'Paused';
    if ($('live').checked) refresh(false, true);
};
$('follow').onchange = () => { if ($('follow').checked) refresh(); };
$('refresh').onclick = () => refresh();
refresh();
setInterval(() => { if ($('live').checked && !document.hidden) refresh(false, true); }, 500);
</script></body></html>`;
}
