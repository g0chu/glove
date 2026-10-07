/** Self-contained continuous inspector feed; archived content is rendered only as text. */
export function renderPage(nonce: string): string {
  return String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Glove · API Inspector</title>
<style nonce="${nonce}">
:root{color-scheme:dark;--bg:#0b1017;--border:#293548;--muted:#94a4b9;--text:#e2eaf5;--mint:#76e1bc}
*{box-sizing:border-box}
body{margin:0;height:100dvh;display:flex;flex-direction:column;background:var(--bg);color:var(--text);font:14px/1.65 system-ui,sans-serif}
header{padding:18px 26px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:18px;flex-wrap:wrap}
h1{font-size:18px;margin:0}h1 span,.muted{color:var(--muted);font-weight:400}
#connection{margin-left:auto;color:var(--mint);font-size:12px}
.controls{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 26px;border-bottom:1px solid var(--border);background:#101823}
button,input{font:inherit}button{cursor:pointer;background:#182433;border:1px solid #35465c;color:var(--text);border-radius:6px;padding:6px 12px}
button:hover{border-color:var(--mint)}button:disabled{opacity:.5;cursor:wait}
button:focus-visible,input:focus-visible,summary:focus-visible,#feed:focus-visible{outline:2px solid var(--mint);outline-offset:3px}
label{display:flex;gap:6px;align-items:center;font-size:12px}input[type=checkbox]{accent-color:var(--mint)}
#search{background:var(--bg);border:1px solid var(--border);color:var(--text);padding:7px 10px;border-radius:6px;min-width:230px;flex:1;max-width:420px}
#feed{position:relative;overflow-y:auto;overflow-anchor:none;scrollbar-color:#3b4f67 transparent;flex:1;min-height:0;padding:22px max(24px,calc((100vw - 1040px)/2));}
.entry{padding:22px 0;border-top:1px solid var(--border)}.entry:first-child{border-top:0}
.entry-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;color:var(--muted);font-size:12px;margin-bottom:16px}
.entry-head time{font-variant-numeric:tabular-nums}.purpose{font-weight:600;color:var(--text)}
.badge{font-size:10px;text-transform:uppercase;letter-spacing:.7px}.finished{color:var(--mint)}.pending{color:#ebd397}.failed{color:#ff9da8}
.section-label{color:var(--muted);font-size:11px;margin:14px 0 6px;text-transform:uppercase;letter-spacing:1px}
.prose{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.8;margin:0 0 14px}
.group{--accent:#94a4b9;--tint:#94a4b909;margin:16px 0;padding:10px 16px 1px;border-left:3px solid var(--accent);background:linear-gradient(90deg,var(--tint),transparent 85%)}
.group.user{--accent:#90b6ff;--tint:#90b6ff0d}.group.reasoning{--accent:#c5aff3;--tint:#c5aff30d}
.group.tools{--accent:#edc18a;--tint:#edc18a0d}.group.tool-result{--accent:#8dcbd9;--tint:#8dcbd90d}
.group.response{--accent:#76e1bc;--tint:#76e1bc0d}.group.failure{--accent:#ff9da8;--tint:#ff9da80d}
.group-title{display:flex;align-items:center;gap:8px;color:var(--accent);font-size:11px;font-weight:650;letter-spacing:.8px;text-transform:uppercase;margin:0 0 10px}
.group-body{min-width:0}.group.reasoning .prose{color:#bdafcf;font-size:13px}.group.response .prose{color:#e7f4ef}
.group.failure .prose{color:#ffb1bb}.group summary.group-title{cursor:pointer;display:list-item}
.group summary.group-title::marker{color:var(--accent)}.group:not([open]) summary.group-title{margin-bottom:8px}
.tool-call{padding:8px 0;border-top:1px solid #edc18a26}.tool-call:first-child{border-top:0;padding-top:0}
.tool-call .role{color:#edc18a}.tool-call .section-label{font-size:10px;margin-top:8px}
.role{font-weight:650;color:var(--mint);font-size:12px;margin-bottom:5px}
details{margin:10px 0}summary{cursor:pointer;color:var(--muted);font-size:12px}
.error{color:#ffb1bb;white-space:pre-wrap;padding:12px 26px}.empty{padding:60px 0;text-align:center;color:var(--muted)}
#more-wrap{text-align:center;margin:0 0 20px}footer{padding:9px 26px;border-top:1px solid var(--border);display:flex;align-items:center;gap:16px;font-size:12px;background:#101823}
#position{color:var(--muted);flex:1}#bottom{color:var(--mint)}[hidden]{display:none!important}
@media(max-width:600px){header,.controls,footer{padding:12px 16px}#feed{padding:14px 16px}#search{max-width:none;min-width:0;flex-basis:100%}.controls{gap:10px}header .muted{display:none}}
</style></head><body>
<header><h1>Glove <span>/ API Inspector</span></h1><span class="muted">One continuous conversation feed</span><span id="connection" role="status">Connecting…</span></header>
<div class="controls"><input id="search" type="search" aria-label="Filter feed" placeholder="Filter channel, purpose, status…"><label><input id="live" type="checkbox" checked>Live updates</label><label><input id="follow" type="checkbox" checked>Auto-scroll</label><label><input id="collapse" type="checkbox" checked>Auto-collapse</label><label><input id="prompts" type="checkbox">Full prompts</label><button id="refresh" type="button">Refresh</button><button id="copy" type="button">Copy feed</button><button id="save" type="button">Save text</button></div>
<div id="error" class="error" role="alert" hidden></div>
<main id="feed" tabindex="0" aria-label="Conversation feed"><div id="more-wrap" hidden><button id="more" type="button">Load earlier history</button></div><div id="entries"></div><div id="empty" class="empty">Loading conversation history…</div></main>
<footer><span id="count">No interactions loaded</span><span id="position" role="status">Following latest</span><button id="bottom" type="button">↓ Jump to bottom</button></footer>
<script nonce="${nonce}">
const $ = id => document.getElementById(id);
let items = [], next = null, revision = 0, busy = false, searchTimer, unseen = 0;
const details = new Map(), rendered = new Map();
function node(tag, text, cls) {
    const e = document.createElement(tag);
    if (text !== undefined) e.textContent = text;
    if (cls) e.className = cls;
    return e;
}
function prose(value) { return node('div', String(value ?? ''), 'prose'); }
function readableValue(value) {
    const root = node('div');
    if (Array.isArray(value)) for (const item of value) root.append(readableValue(item));
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
        root.append(node('div', key.replace(/_/g, ' '), 'section-label'), readableValue(item));
    } else root.append(prose(value));
    return root;
}
function group(kind, title, body, key, complete = true) {
    const collapsible = kind !== 'response';
    const root = node(collapsible ? 'details' : 'section', undefined, 'group ' + kind);
    root.dataset.kind = kind;
    if (collapsible) {
        root.dataset.key = key || kind;
        root.dataset.complete = String(complete);
        root.open = !$('collapse').checked || !complete;
        root.dataset.autoOpen = String(root.open);
    }
    const label = node(collapsible ? 'summary' : 'h3', title, 'group-title');
    if (collapsible) label.onclick = () => { root.dataset.manual = 'true'; };
    const content = node('div', undefined, 'group-body');
    content.append(body);
    root.append(label, content);
    return root;
}
function reasoningGroup(text, key, complete = true) { return group('reasoning', 'Reasoning', prose(text), key, complete); }
function toolsGroup(calls, key = 'tools', complete = true) { return group('tools', 'Tool calls · ' + calls.length, toolCalls(calls), key, complete); }
function toolCalls(calls) {
    const root = node('div');
    for (const call of calls) {
        const fn = call.function || call, tool = node('div', undefined, 'tool-call');
        tool.append(node('div', fn.name || 'Tool call', 'role'));
        try { tool.append(readableValue(typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments)); }
        catch { tool.append(prose(fn.arguments)); }
        root.append(tool);
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
function event(detail, type) { return detail.events.find(e => e.type === type)?.data; }
function output(detail) {
    const result = event(detail, 'model.finished');
    let content = result?.content || '', reasoning = result?.reasoning || '', calls = result?.toolCalls || []; if (!result) {
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
}
    return { content, reasoning, calls };
}
function messageKey(m) {
    return JSON.stringify([m.role, m.name || '', m.tool_call_id || '', m.content ?? '', m.reasoning_content || '',
        (m.tool_calls || []).map(c => [c.id || '', c.function?.name || c.name || '', c.function?.arguments || c.arguments || ''])]);
}
function promptMessages(detail, previous) {
    const all = event(detail, 'model.request')?.messages || [];
    if ($('prompts').checked) return all;
    const current = all.filter(m => m.role !== 'system');
    // Start the loaded window at its latest input rather than replaying the
    // entire earlier conversation embedded in the first request.
    if (!previous) return all.slice(Math.max(0, all.findLastIndex(m => m.role === 'user')));
    const before = (event(previous, 'model.request')?.messages || []).filter(m => m.role !== 'system');
    const result = event(previous, 'model.finished');
    if (result) before.push({ role: 'assistant', content: result.content, reasoning_content: result.reasoning, tool_calls: result.toolCalls });
    let common = 0;
    while (common < before.length && common < current.length && messageKey(before[common]) === messageKey(current[common])) common++;
    // Compare conversation entries without phase instructions, but render the
    // original suffix so chime/reply instructions remain visible on every call,
    // including identical retries that add no conversation entries.
    const start = common > 0 ? all.indexOf(current[common - 1]) + 1 : 0;
    return all.slice(start);
}
function drawEntry(detail, previous) {
    const root = node('section', undefined, 'entry');
    root.dataset.id = detail.id;
    const head = node('div', undefined, 'entry-head');
    const time = node('time', new Date(detail.time).toLocaleString());
    time.dateTime = detail.time;
    head.append(time, node('span', (detail.scope.purpose || 'reply').replace(/-/g, ' '), 'purpose'),
        node('span', 'Channel ' + (detail.scope.channelId || '—')), node('span', detail.state, 'badge ' + detail.state));
    if (detail.scope.round !== undefined) head.append(node('span', 'Round ' + (detail.scope.round + 1)));
    root.append(head);
    const toolNames = new Map();
    for (const m of event(detail, 'model.request')?.messages || []) for (const call of m.tool_calls || []) {
        if (call.id) toolNames.set(call.id, call.function?.name || call.name);
    }
    for (const [i, m] of promptMessages(detail, previous).entries()) {
        if (m.role === 'assistant') {
            if (m.reasoning_content) root.append(reasoningGroup(m.reasoning_content, 'prompt-reasoning-' + i));
            if (m.content) root.append(group('response', 'Assistant response' + (m.name ? ' · ' + m.name : ''), messageContent(m.content)));
            if (m.tool_calls?.length) root.append(toolsGroup(m.tool_calls, 'prompt-tools-' + i));
        } else {
            const toolName = m.name || toolNames.get(m.tool_call_id);
            const kind = m.role === 'tool' ? 'tool-result' : m.role === 'user' ? 'user' : 'instructions';
            const label = m.role === 'tool' ? 'Tool result' + (toolName ? ' · ' + toolName : '') :
                m.role === 'user' ? 'User message' + (m.name ? ' · ' + m.name : '') : 'Instructions';
            root.append(group(kind, label, messageContent(m.content), 'prompt-' + kind + '-' + i));
        }
    }
    const parsed = output(detail), failed = event(detail, 'model.failed');
    const finished = detail.state !== 'pending' || !!event(detail, 'model.finished') || !!failed;
    if (parsed.reasoning) root.append(reasoningGroup(parsed.reasoning, 'reasoning', finished || !!parsed.content || parsed.calls.length > 0));
    if (parsed.content) root.append(group('response', 'Assistant response', prose(parsed.content)));
    if (parsed.calls.length) root.append(toolsGroup(parsed.calls, 'tools', finished));
    if (failed) root.append(group('failure', 'Request failed', prose(failed.error)));
    if (!parsed.content && !parsed.reasoning && !parsed.calls.length && !failed)
        root.append(node('div', detail.state === 'pending' ? 'Waiting for the model…' : 'No assistant text returned.', 'muted'));
    const usage = event(detail, 'model.finished')?.usage;
    if (usage) root.append(node('div', usage.input + ' input tokens · ' + usage.output + ' output tokens', 'muted'));
    return root;
}
function atBottom() { const feed = $('feed'); return feed.scrollHeight - feed.clientHeight - feed.scrollTop < 48; }
function position() {
    if (atBottom()) unseen = 0;
    $('position').textContent = atBottom() && $('follow').checked ? 'Following latest' : 'Reading history';
    $('bottom').textContent = unseen ? '↓ ' + unseen + ' new interaction' + (unseen === 1 ? '' : 's') + ' · Jump to bottom' : '↓ Jump to bottom';
}
function jumpToBottom() {
    $('follow').checked = true;
    $('feed').scrollTop = $('feed').scrollHeight;
    unseen = 0;
    position();
}
function renderFeed(older = false, incoming = 0) {
    const feed = $('feed'), top = feed.scrollTop;
    const following = !older && $('follow').checked && atBottom();
    const anchor = Array.from($('entries').children).find(n => n.offsetTop + n.offsetHeight > top);
    const anchorId = anchor?.dataset.id, displacement = anchor ? top - anchor.offsetTop : 0;
    const previousByChannel = new Map(), nodes = [];
    for (const item of [...items].reverse()) {
        const detail = details.get(item.id);
        if (!detail) continue;
        const channel = detail.scope.channelId || '', previous = previousByChannel.get(channel);
        const key = detail.updated + ':' + (previous?.id || '') + ':' + (previous?.updated || '') + ':' + $('prompts').checked + ':' + $('collapse').checked;
        let entry = rendered.get(item.id);
        if (!entry || entry.key !== key) {
            const root = drawEntry(detail, previous);
            if (entry) {
                const expanded = new Map(Array.from(entry.root.querySelectorAll('details')).map(d =>
                    [d.dataset.key, { open: d.open, complete: d.dataset.complete,
                        manual: d.dataset.manual === 'true' || d.open !== (d.dataset.autoOpen === 'true') }]));
                for (const d of root.querySelectorAll('details')) {
                    const previous = expanded.get(d.dataset.key);
                    const completedNow = previous && d.dataset.complete === 'true' && previous.complete !== 'true';
                    // Apply automatic state on completion/toggle changes; retain manual choices otherwise.
                    if (previous?.manual && !($('collapse').checked && completedNow)) {
                        d.open = previous.open;
                        d.dataset.manual = 'true';
                    }
                }
            }
            entry = { key, root };
            rendered.set(item.id, entry);
        }
        nodes.push(entry.root);
        previousByChannel.set(channel, detail);
    }
    $('entries').replaceChildren(...nodes);
    $('empty').hidden = nodes.length > 0;
    $('empty').textContent = 'No matching interactions yet.';
    $('more-wrap').hidden = !next;
    $('count').textContent = nodes.length + ' interaction' + (nodes.length === 1 ? '' : 's') + (next ? ' · earlier history available' : '');
    if (following) jumpToBottom();
    else {
        const restored = anchorId && rendered.get(anchorId)?.root;
        feed.scrollTop = restored ? restored.offsetTop + displacement : top;
        if (!older) unseen += incoming;
        position();
    }
}
async function api(url) {
    const res = await fetch(url);
    if (!res.ok) throw Error('Could not read archive (' + res.status + '). Check the UI terminal.');
    return res.json();
}
async function loadDetails(changed, token) {
    let cursor = 0;
    const loaded = new Map();
    const outcomes = await Promise.allSettled(Array.from({ length: Math.min(4, changed.length) }, async () => {
        while (cursor < changed.length && token === revision) {
            const item = changed[cursor++];
            const detail = await api('/api/requests/' + encodeURIComponent(item.id) + '?view=readable');
            if (token === revision) loaded.set(item.id, detail);
        }
    }));
    const failed = outcomes.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    if (token === revision) for (const [id, detail] of loaded) details.set(id, detail);
}
async function refresh(older = false, automatic = false) {
    if (busy || (older && !next) || (automatic && !$('live').checked)) return;
    busy = true;
    const token = revision, query = $('search').value, known = new Set(items.map(i => i.id));
    $('more').disabled = true;
    try {
        const listUrl = '/api/requests?limit=20&q=' + encodeURIComponent(query);
        let page = await api(listUrl + (older ? '&before=' + next : ''));
        const received = [...page.items];
        // Catch up across page boundaries after a pause or hidden tab.
        while (!older && items.length && page.next && page.items.length && !page.items.some(i => known.has(i.id)) && token === revision) {
            page = await api(listUrl + '&before=' + page.next);
            received.push(...page.items);
        }
        if (token !== revision || (automatic && !$('live').checked)) return;
        const changed = received.filter(item => !details.has(item.id) || details.get(item.id).updated !== item.updated);
        // Long-running requests can fall out of the newest page; keep them live too.
        if (!older) for (const item of items) if (details.get(item.id)?.state === 'pending' && !received.some(i => i.id === item.id)) changed.push(item);
        await loadDetails(changed, token);
        if (token !== revision || (automatic && !$('live').checked)) return;
        const incoming = received.filter(i => !known.has(i.id)).length;
        const receivedIds = new Set(received.map(i => i.id));
        if (older) { items.push(...received.filter(i => !known.has(i.id))); next = page.next; }
        else { items = received.concat(items.filter(i => !receivedIds.has(i.id))); if (!known.size) next = page.next; }
        items = items.map(item => {
            const detail = details.get(item.id);
            return detail ? { id: detail.id, time: detail.time, scope: detail.scope, state: detail.state, updated: detail.updated } : item;
        }).filter(item => (item.id + ' ' + (item.scope.channelId || '') + ' ' + (item.scope.purpose || 'reply') + ' ' + item.state).toLowerCase().includes(query.toLowerCase()));
        const retained = new Set(items.map(item => item.id));
        for (const id of details.keys()) if (!retained.has(id)) { details.delete(id); rendered.delete(id); }
        if (changed.length || incoming || older) renderFeed(older, incoming);
        $('connection').textContent = $('live').checked ? 'Live · updates every 0.5s' : 'Paused';
        $('error').hidden = true;
    } catch (e) {
        if (token === revision) { $('error').textContent = e.message; $('error').hidden = false; $('connection').textContent = 'Retrying connection…'; }
    } finally {
        busy = false;
        $('more').disabled = false;
        if (token !== revision && ($('live').checked || query !== $('search').value)) refresh();
    }
}
$('feed').onscroll = position;
$('bottom').onclick = jumpToBottom;
$('follow').onchange = () => { if ($('follow').checked) jumpToBottom(); else position(); };
$('prompts').onchange = () => renderFeed();
$('collapse').onchange = () => renderFeed();
$('more').onclick = () => refresh(true);
$('refresh').onclick = () => refresh();
$('search').oninput = () => {
    clearTimeout(searchTimer);
    revision++;
    items = []; next = null; unseen = 0; details.clear(); rendered.clear();
    $('entries').replaceChildren(); $('more-wrap').hidden = true;
    $('empty').hidden = false; $('empty').textContent = 'Filtering history…';
    $('feed').scrollTop = 0;
    searchTimer = setTimeout(() => refresh(), 200);
};
$('live').onchange = () => {
    revision++;
    $('connection').textContent = $('live').checked ? 'Connecting…' : 'Paused';
    if ($('live').checked) refresh();
};
$('copy').onclick = async () => {
    try { await navigator.clipboard.writeText($('entries').innerText); $('copy').textContent = 'Copied'; setTimeout(() => $('copy').textContent = 'Copy feed', 1200); }
    catch { $('error').textContent = 'Clipboard unavailable. Use Save text instead.'; $('error').hidden = false; }
};
$('save').onclick = () => {
    const url = URL.createObjectURL(new Blob([$('entries').innerText], { type: 'text/plain;charset=utf-8' }));
    const link = node('a'); link.href = url; link.download = 'glove-conversation-feed.txt'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
};
refresh();
setInterval(() => { if ($('live').checked && !document.hidden) refresh(false, true); }, 500);
</script></body></html>`;
}
