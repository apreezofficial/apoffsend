(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const state = { info: null, me: 'phone', files: [], texts: [], tab: 'in', address: null, seen: null };
  const queue = [];
  let active = null;

  // ------------------------------------------------------------ helpers --

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
    return n.toFixed(n < 10 ? 1 : 0) + ' ' + units[i];
  }

  function fmtTime(ms) {
    const d = new Date(ms), now = new Date();
    const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return t;
    return d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ', ' + t;
  }

  function fmtEta(sec) {
    if (!isFinite(sec) || sec < 0) return '';
    if (sec < 60) return Math.ceil(sec) + 's left';
    return Math.floor(sec / 60) + 'm ' + Math.round(sec % 60) + 's left';
  }

  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  async function api(url, options) {
    const r = await fetch(url, Object.assign({ credentials: 'same-origin' }, options));
    if (r.status === 401) { location.reload(); throw new Error('Not connected'); }
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || r.statusText);
    return body;
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
    } catch {}
    // Plain http on the LAN is not a "secure context", so fall back to execCommand
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    ta.remove();
    return ok;
  }

  const fileUrl = (f) => `/api/files/${f.from}/${encodeURIComponent(f.name)}`;
  const otherSide = () => (state.me === 'pc' ? 'phone' : 'pc');
  const sideLabel = (from) => (from === 'pc' ? 'PC' : 'phone');

  function kindOf(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    if (/^(jpe?g|png|gif|webp|bmp|svg|avif)$/.test(ext)) return 'image';
    if (/^(mp4|mkv|webm|mov|avi|3gp|m4v)$/.test(ext)) return 'video';
    if (/^(mp3|m4a|wav|ogg|flac|aac|opus)$/.test(ext)) return 'audio';
    if (/^(zip|rar|7z|tar|gz|apk)$/.test(ext)) return 'archive';
    if (/^(pdf|docx?|xlsx?|pptx?|txt|md|csv|epub)$/.test(ext)) return 'doc';
    return 'other';
  }

  // ------------------------------------------------------------- connect --

  function renderConnect() {
    const info = state.info;
    if (!info || info.me !== 'pc') return;
    $('#connect').classList.remove('hidden');
    const addrs = info.addresses || [];
    if (!addrs.some((a) => a.address === state.address)) state.address = addrs.length ? addrs[0].address : null;

    if (!state.address) {
      $('#qr').innerHTML = '';
      $('#url').textContent = 'No network found — connect this PC to Wi-Fi or to your phone\'s hotspot.';
      $('#ip-list').innerHTML = '';
      $('#code-line').textContent = '';
      return;
    }
    const link = `http://${state.address}:${info.port}/` + (info.key ? `?k=${info.key}` : '');
    $('#qr').innerHTML = QR.toSVG(link, { ecl: 'M', border: 2 });
    $('#url').textContent = `http://${state.address}:${info.port}`;
    $('#ip-list').innerHTML = addrs.length > 1
      ? addrs.map((a) => `<button type="button" class="chip${a.address === state.address ? ' active' : ''}" data-ip="${esc(a.address)}" title="${esc(a.ifname)}">${esc(a.address)} · ${esc(a.ifname)}</button>`).join('')
      : '';
    $('#code-line').innerHTML = info.key ? `Typing the address instead? Access code: <b>${esc(info.key)}</b>` : '';
  }

  function renderDevices(list) {
    if (state.me !== 'pc') return;
    const phones = list.filter((d) => d.device === 'phone');
    const el = $('#devices');
    if (phones.length) {
      el.innerHTML = '<span class="ok">&#10003; Connected:</span> ' + [...new Set(phones.map((p) => p.name))].map(esc).join(', ');
      setStatus(true, phones.length === 1 ? `${phones[0].name} connected` : `${phones.length} devices connected`);
    } else {
      el.textContent = 'Waiting for your phone…';
      setStatus(true, 'Waiting for phone');
    }
  }

  function setStatus(on, text) {
    const s = $('#status');
    s.classList.toggle('on', on);
    s.classList.toggle('off', !on);
    $('#status-text').textContent = text;
  }

  // -------------------------------------------------------------- upload --

  function enqueue(fileList) {
    const files = [...fileList].filter((f) => f && f.size !== undefined);
    if (!files.length) return;
    for (const file of files) {
      const item = { id: Math.random().toString(36).slice(2), file, loaded: 0, status: 'waiting', speed: 0 };
      queue.push(item);
      const li = document.createElement('li');
      li.className = 'q';
      li.id = 'q-' + item.id;
      li.innerHTML = `<div class="q-top"><span class="q-name">${esc(file.name)}</span><button type="button" class="icon-btn" title="Cancel">&#10005;</button></div>
        <div class="bar"><i></i></div><div class="q-meta"><span class="q-left"></span><span class="q-right"></span></div>`;
      li.querySelector('button').onclick = () => cancel(item);
      $('#queue').appendChild(li);
      item.el = li;
      updateItem(item);
    }
    $('#queue-head').classList.remove('hidden');
    updateSummary();
    pump();
  }

  function cancel(item) {
    if (item.status === 'uploading' && item.xhr) item.xhr.abort();
    else if (item.status === 'waiting') { item.status = 'cancelled'; updateItem(item); }
    else if (item.status === 'error' || item.status === 'cancelled') { item.status = 'waiting'; item.loaded = 0; updateItem(item); pump(); return; }
    else removeItem(item);
    updateSummary();
  }

  function removeItem(item) {
    item.el.remove();
    queue.splice(queue.indexOf(item), 1);
    if (!queue.length) $('#queue-head').classList.add('hidden');
    updateSummary();
  }

  function updateItem(item) {
    const { el, file } = item;
    el.className = 'q ' + item.status;
    const pct = file.size ? (item.loaded / file.size) * 100 : item.status === 'done' ? 100 : 0;
    el.querySelector('.bar > i').style.width = (item.status === 'done' ? 100 : pct) + '%';
    const left = el.querySelector('.q-left'), right = el.querySelector('.q-right');
    const btn = el.querySelector('button');
    btn.innerHTML = item.status === 'error' || item.status === 'cancelled' ? '&#8635;' : '&#10005;';
    btn.title = item.status === 'error' || item.status === 'cancelled' ? 'Retry' : item.status === 'done' ? 'Remove' : 'Cancel';
    switch (item.status) {
      case 'waiting': left.textContent = 'Waiting · ' + fmtSize(file.size); right.textContent = ''; break;
      case 'uploading':
        left.textContent = `${fmtSize(item.loaded)} / ${fmtSize(file.size)} · ${fmtSize(item.speed)}/s`;
        right.textContent = fmtEta((file.size - item.loaded) / item.speed);
        break;
      case 'done': left.textContent = `Sent · ${fmtSize(file.size)}`; right.textContent = item.took ? `${item.took.toFixed(1)}s` : ''; break;
      case 'error': left.textContent = item.error || 'Failed'; right.textContent = 'tap ↻ to retry'; break;
      case 'cancelled': left.textContent = 'Cancelled'; right.textContent = ''; break;
    }
  }

  function updateSummary() {
    const pending = queue.filter((i) => i.status === 'waiting' || i.status === 'uploading');
    const done = queue.filter((i) => i.status === 'done').length;
    $('#queue-summary').textContent = pending.length
      ? `Sending ${pending.length} file${pending.length > 1 ? 's' : ''}… keep this page open`
      : `${done} sent`;
  }

  function pump() {
    if (active) return;
    const item = queue.find((i) => i.status === 'waiting');
    if (!item) { updateSummary(); return; }
    active = item;
    upload(item).then(() => { active = null; updateSummary(); pump(); });
  }

  function upload(item) {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      item.xhr = xhr;
      item.status = 'uploading';
      item.loaded = 0;
      const start = performance.now();
      let lastT = start, lastLoaded = 0;
      xhr.open('POST', '/api/upload?name=' + encodeURIComponent(item.file.name));
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (e) => {
        const now = performance.now();
        if (now - lastT > 400) {
          const inst = (e.loaded - lastLoaded) / ((now - lastT) / 1000);
          item.speed = item.speed ? item.speed * 0.6 + inst * 0.4 : inst;
          lastT = now;
          lastLoaded = e.loaded;
        }
        item.loaded = e.loaded;
        updateItem(item);
      };
      xhr.onload = () => {
        if (xhr.status === 200) {
          item.status = 'done';
          item.took = (performance.now() - start) / 1000;
          setTimeout(() => { if (item.status === 'done' && item.el.isConnected) removeItem(item); }, 6000);
        } else if (xhr.status === 401) {
          location.reload();
        } else {
          item.status = 'error';
          try { item.error = JSON.parse(xhr.responseText).error; } catch { item.error = 'Failed (' + xhr.status + ')'; }
        }
        updateItem(item);
        resolve();
      };
      xhr.onerror = () => { item.status = 'error'; item.error = 'Connection lost — is the PC still on the same network?'; updateItem(item); resolve(); };
      xhr.onabort = () => { item.status = 'cancelled'; updateItem(item); resolve(); };
      updateItem(item);
      xhr.send(item.file);
    });
  }

  // --------------------------------------------------------------- files --

  function renderFiles() {
    const incoming = state.files.filter((f) => f.from === otherSide());
    const outgoing = state.files.filter((f) => f.from === state.me);
    $('#count-in').textContent = incoming.length || '';
    $('#count-out').textContent = outgoing.length || '';
    const list = state.tab === 'in' ? incoming : outgoing;
    const source = state.tab === 'in' ? otherSide() : state.me;

    const zip = $('#zip-btn');
    zip.classList.toggle('hidden', list.length < 2);
    zip.href = `/api/zip?from=${source}`;
    $('#open-folder').classList.toggle('hidden', state.me !== 'pc');

    // Highlight files that arrived after the first load
    const prev = state.seen;
    state.seen = new Set(state.files.map((f) => f.from + '/' + f.name + '/' + f.mtime));

    $('#files').innerHTML = list.map((f) => {
      const kind = kindOf(f.name);
      const ext = (f.name.includes('.') ? f.name.split('.').pop() : 'file').slice(0, 4);
      const icon = kind === 'image' && f.size < 15 * 1048576
        ? `<img loading="lazy" alt="" src="${fileUrl(f)}?inline=1">`
        : esc(ext);
      const fresh = prev && !prev.has(f.from + '/' + f.name + '/' + f.mtime) ? ' fresh' : '';
      return `<li class="file${fresh}" data-from="${f.from}" data-name="${esc(f.name)}">
        <div class="ficon ${kind}">${icon}</div>
        <div class="fmeta">
          <a class="fname" href="${fileUrl(f)}?inline=1" target="_blank" rel="noopener">${esc(f.name)}</a>
          <div class="muted small">${fmtSize(f.size)} · ${fmtTime(f.mtime)}</div>
        </div>
        <a class="btn small" href="${fileUrl(f)}" download="${esc(f.name)}">Download</a>
        <button type="button" class="icon-btn" data-del title="Delete">&#10005;</button>
      </li>`;
    }).join('');

    $('#empty').textContent = list.length ? '' : state.tab === 'in'
      ? `Nothing received yet. Files sent from your ${sideLabel(otherSide())} will appear here.`
      : 'Files you send appear here.';
  }

  function notifyNew(oldFiles, newFiles) {
    if (!oldFiles) return;
    const before = new Set(oldFiles.map((f) => f.from + '/' + f.name));
    const arrived = newFiles.filter((f) => f.from === otherSide() && !before.has(f.from + '/' + f.name));
    if (!arrived.length) return;
    toast(arrived.length === 1 ? `Received ${arrived[0].name}` : `Received ${arrived.length} files`);
    if (state.tab !== 'in') switchTab('in');
    if (navigator.vibrate) navigator.vibrate(60);
  }

  function switchTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    renderFiles();
  }

  // --------------------------------------------------------------- texts --

  function linkify(text) {
    return esc(text).replace(/\bhttps?:\/\/[^\s<]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
  }

  function renderTexts() {
    $('#texts').innerHTML = state.texts.map((t) => `<li class="tmsg${t.from === state.me ? ' mine' : ''}" data-id="${t.id}">
      <div class="tbody">${linkify(t.text)}</div>
      <div class="tfoot"><span>${t.from === state.me ? 'You' : 'From ' + sideLabel(t.from)} · ${fmtTime(t.time)}</span>
      <span><button type="button" class="btn ghost" data-copy>Copy</button> <button type="button" class="icon-btn" data-tdel title="Delete">&#10005;</button></span></div>
    </li>`).join('');
  }

  // -------------------------------------------------------------- events --

  function connectEvents() {
    const es = new EventSource('/api/events');
    es.addEventListener('files', (e) => {
      const files = JSON.parse(e.data);
      notifyNew(state.files.length || state.seen ? state.files : null, files);
      state.files = files;
      renderFiles();
    });
    es.addEventListener('texts', (e) => {
      const texts = JSON.parse(e.data);
      const fresh = state.texts.length && texts[0] && texts[0].from !== state.me && !state.texts.some((t) => t.id === texts[0].id);
      if (fresh) toast('New text from ' + sideLabel(texts[0].from));
      state.texts = texts;
      renderTexts();
    });
    es.addEventListener('devices', (e) => renderDevices(JSON.parse(e.data)));
    es.onopen = () => {
      if (state.me !== 'pc') setStatus(true, `Connected to ${state.info ? state.info.hostname : 'PC'}`);
    };
    es.onerror = () => setStatus(false, state.me === 'pc' ? 'Server stopped' : 'Disconnected — reconnecting…');
  }

  async function loadInfo() {
    try {
      state.info = await api('/api/info');
      state.me = state.info.me;
      document.body.classList.toggle('is-pc', state.me === 'pc');
      $('#send-title').textContent = state.me === 'pc' ? 'Send to phone' : 'Send to PC';
      $('#send-hint').textContent = state.me === 'pc'
        ? 'Files go to your phone instantly — any size.'
        : `Files are saved on ${state.info.hostname}.`;
      renderConnect();
    } catch {}
  }

  // ---------------------------------------------------------------- init --

  function bind() {
    $('#file-input').addEventListener('change', (e) => { enqueue(e.target.files); e.target.value = ''; });

    // Drag & drop anywhere on the page
    let depth = 0;
    const overlay = $('#drag-overlay');
    const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { depth++; overlay.classList.add('show'); } });
    window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) overlay.classList.remove('show'); });
    window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      overlay.classList.remove('show');
      enqueue(e.dataTransfer.files);
    });

    // Paste screenshots/files with Ctrl+V
    window.addEventListener('paste', (e) => {
      const files = e.clipboardData && e.clipboardData.files;
      if (files && files.length && e.target.id !== 'text-input') { e.preventDefault(); enqueue(files); }
    });

    $('#queue-clear').onclick = () => {
      queue.filter((i) => i.status === 'done' || i.status === 'cancelled').forEach(removeItem);
    };

    document.querySelectorAll('.tabs button').forEach((b) => { b.onclick = () => switchTab(b.dataset.tab); });

    $('#files').addEventListener('click', async (e) => {
      const del = e.target.closest('[data-del]');
      if (!del) return;
      const li = del.closest('.file');
      if (!confirm(`Delete "${li.dataset.name}" from the PC?`)) return;
      try { await api(`/api/files/${li.dataset.from}/${encodeURIComponent(li.dataset.name)}`, { method: 'DELETE' }); }
      catch (err) { toast(err.message); }
    });

    $('#open-folder').onclick = () => {
      api('/api/open-folder?from=' + (state.tab === 'in' ? otherSide() : state.me), { method: 'POST' }).catch((err) => toast(err.message));
    };

    $('#ip-list').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-ip]');
      if (chip) { state.address = chip.dataset.ip; renderConnect(); }
    });

    const input = $('#text-input');
    $('#text-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = input.value;
      if (!text.trim()) return;
      try {
        await api('/api/text', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
        input.value = '';
        toast('Sent');
      } catch (err) { toast(err.message); }
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#text-form').requestSubmit();
    });

    $('#texts').addEventListener('click', async (e) => {
      const li = e.target.closest('.tmsg');
      if (!li) return;
      const item = state.texts.find((t) => t.id === li.dataset.id);
      if (e.target.closest('[data-copy]')) toast((await copyText(item.text)) ? 'Copied' : 'Copy failed — long-press the text to copy');
      if (e.target.closest('[data-tdel]')) api('/api/text/' + item.id, { method: 'DELETE' }).catch((err) => toast(err.message));
    });

    window.addEventListener('beforeunload', (e) => {
      if (queue.some((i) => i.status === 'uploading' || i.status === 'waiting')) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  bind();
  loadInfo().then(() => {
    connectEvents();
    // Networks change (e.g. hotspot turned on later) — keep the QR code current
    if (state.me === 'pc') setInterval(loadInfo, 5000);
  });
})();
