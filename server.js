#!/usr/bin/env node
'use strict';
// ApOffSend — send files and text between your PC and phone over the local
// network (Wi-Fi or hotspot). No internet, no app install, no dependencies.
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pipeline } = require('stream');
const QR = require('./public/qr.js');
const { writeZip, zipSize, fitsInZip32 } = require('./src/zip.js');

const VERSION = require('./package.json').version;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------------------------------------------------------------- options --

function printHelp() {
  console.log(`ApOffSend ${VERSION}

Usage: node server.js [options] [files to share...]

Options:
  -p, --port <n>   Port to listen on (default 8080, next free port is used)
  -d, --dir <dir>  Folder for transferred files (default ~/ApOffSend)
      --no-open    Don't open the browser on this PC
      --no-pin     Don't require the access code (anyone on the network can connect)
      --allow-proxy  Serve the full app behind a reverse proxy (by default proxied
                     visitors only see the install page)
  -h, --help       Show this help

Files given on the command line are copied into the "from-pc" folder so the
phone can download them.`);
}

function parseArgs(argv) {
  const opts = {
    port: Number(process.env.PORT) || 8080,
    dir: path.join(os.homedir(), 'ApOffSend'),
    open: true,
    pin: true,
    allowProxy: false,
    files: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-p' || a === '--port') opts.port = parseInt(argv[++i], 10);
    else if (a === '-d' || a === '--dir') opts.dir = path.resolve(argv[++i]);
    else if (a === '--no-open') opts.open = false;
    else if (a === '--no-pin') opts.pin = false;
    else if (a === '--allow-proxy') opts.allowProxy = true;
    else if (a === '-h' || a === '--help') { printHelp(); process.exit(0); }
    else opts.files.push(path.resolve(a));
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const DIRS = { pc: path.join(opts.dir, 'from-pc'), phone: path.join(opts.dir, 'from-phone') };
const CONFIG_FILE = path.join(opts.dir, '.apoffsend.json');
const TEXTS_FILE = path.join(opts.dir, '.texts.json');

for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// The access code is kept between runs so a phone bookmark keeps working.
const config = loadJSON(CONFIG_FILE, {});
if (!config.key) {
  config.key = crypto.randomBytes(6).toString('base64url');
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}
const KEY = config.key;

let texts = loadJSON(TEXTS_FILE, []);
const saveTexts = () => fsp.writeFile(TEXTS_FILE, JSON.stringify(texts)).catch(() => {});

// ---------------------------------------------------------------- network --

const VIRTUAL_IF = /vEthernet|VirtualBox|VMware|Hyper-V|WSL|docker|vbox|Loopback|Tailscale|ZeroTier|^br-|^veth|utun|Npcap/i;

function lanAddresses() {
  const list = [];
  for (const [ifname, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if ((a.family !== 'IPv4' && a.family !== 4) || a.internal || a.address.startsWith('169.254.')) continue;
      let score = 0;
      if (VIRTUAL_IF.test(ifname)) score -= 10;
      if (/wi-?fi|wlan|wireless|^wl/i.test(ifname)) score += 3;
      if (a.address.startsWith('192.168.')) score += 2;
      else if (/^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(a.address)) score += 1;
      list.push({ ifname, address: a.address, score });
    }
  }
  return list.sort((x, y) => y.score - x.score);
}

function ownAddresses() {
  const set = new Set(['127.0.0.1', '::1']);
  for (const addrs of Object.values(os.networkInterfaces())) for (const a of addrs || []) set.add(a.address);
  return set;
}

// "pc" for requests coming from this machine, "phone" for everything else.
// The smoke test sets APOFFSEND_TEST to pretend local requests come from a phone.
const TEST_MODE = process.env.APOFFSEND_TEST === '1';

function deviceOf(req) {
  if (TEST_MODE && req.headers['x-test-device'] === 'phone') return 'phone';
  const addr = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return ownAddresses().has(addr) ? 'pc' : 'phone';
}

function deviceName(ua = '') {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) {
    const m = ua.match(/Android [^;)]*;\s*([^;)]+?)(?:\s+Build|\))/);
    return m && m[1] !== 'K' ? m[1].trim() : 'Android phone';
  }
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Linux/.test(ua)) return 'Linux PC';
  return 'Device';
}

// ------------------------------------------------------------------ files --

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

function safeName(name) {
  let n = String(name || '').split(/[\\/]/).pop();
  n = n.replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/^[\s.]+|[\s.]+$/g, '');
  if (!n) n = 'file';
  if (RESERVED.test(n)) n = '_' + n;
  if (Buffer.byteLength(n) > 200) {
    const ext = path.extname(n).slice(0, 20);
    n = Buffer.from(n).subarray(0, 180).toString().replace(/\uFFFD+$/, '') + ext;
  }
  return n;
}

const reserved = new Set(); // names claimed by uploads in progress

async function uniqueName(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 0; ; i++) {
    const candidate = i === 0 ? name : `${base} (${i})${ext}`;
    const full = path.join(dir, candidate);
    if (reserved.has(full)) continue;
    try { await fsp.access(full); } catch { return candidate; }
  }
}

function resolveFile(from, name) {
  const dir = DIRS[from];
  if (!dir || !name) return null;
  const full = path.resolve(dir, name);
  if (path.dirname(full) !== path.resolve(dir)) return null;
  return full;
}

async function listFiles() {
  const out = [];
  for (const [from, dir] of Object.entries(DIRS)) {
    let names = [];
    try { names = await fsp.readdir(dir); } catch {}
    for (const name of names) {
      if (name.startsWith('.') || name.endsWith('.part') || /^desktop\.ini$|^thumbs\.db$/i.test(name)) continue;
      try {
        const st = await fsp.stat(path.join(dir, name));
        if (st.isFile()) out.push({ from, name, size: st.size, mtime: st.mtimeMs });
      } catch {}
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.heic': 'image/heic', '.avif': 'image/avif', '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
  '.mov': 'video/quicktime', '.avi': 'video/x-msvideo', '.3gp': 'video/3gpp', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.aac': 'audio/aac', '.opus': 'audio/opus',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.rar': 'application/vnd.rar', '.7z': 'application/x-7z-compressed',
  '.apk': 'application/vnd.android.package-archive', '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.epub': 'application/epub+zip', '.ps1': 'text/plain; charset=utf-8',
};
const mimeOf = (name) => MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';

function contentDisposition(type, name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

// ----------------------------------------------------------------- events --

const clients = new Set();

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, data) {
  for (const c of clients) send(c.res, event, data);
}

function devices() {
  return [...clients].map((c) => ({ id: c.id, device: c.device, name: c.name, since: c.since }));
}

let filesTimer;
function broadcastFiles() {
  clearTimeout(filesTimer);
  filesTimer = setTimeout(async () => broadcast('files', await listFiles()), 150);
}

// Files dropped straight into the folders (e.g. via Explorer) show up live too
for (const dir of Object.values(DIRS)) {
  try { fs.watch(dir, () => broadcastFiles()); } catch {}
}

setInterval(() => { for (const c of clients) c.res.write(': ping\n\n'); }, 20000).unref();

// --------------------------------------------------------------- helpers --

function sendJSON(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store' });
  res.end(data);
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function openExternal(target) {
  const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  try { spawn(cmd, [target], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref(); } catch {}
}

async function serveStatic(res, file) {
  try {
    const data = await fsp.readFile(path.join(PUBLIC_DIR, file));
    res.writeHead(200, { 'Content-Type': mimeOf(file), 'Content-Length': data.length, 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    sendJSON(res, 404, { error: 'Not found' });
  }
}

// ---------------------------------------------------------------- handlers --

function handleUpload(req, res, url, device) {
  const name = safeName(url.searchParams.get('name'));
  const dir = DIRS[device];
  const tmp = path.join(dir, `.${crypto.randomBytes(6).toString('hex')}.part`);
  const expected = req.headers['content-length'] !== undefined ? Number(req.headers['content-length']) : null;

  pipeline(req, fs.createWriteStream(tmp, { highWaterMark: 1 << 20 }), async (err) => {
    const fail = (status, message) => {
      fsp.unlink(tmp).catch(() => {});
      if (!res.headersSent && !res.destroyed) sendJSON(res, status, { error: message });
    };
    if (err) return fail(err.code === 'ENOSPC' ? 507 : 400, err.code === 'ENOSPC' ? 'The PC is out of disk space' : 'Upload interrupted');
    try {
      const { size } = await fsp.stat(tmp);
      if (expected !== null && size !== expected) return fail(400, 'Upload incomplete');
      const finalName = await uniqueName(dir, name);
      const full = path.join(dir, finalName);
      reserved.add(full);
      try { await fsp.rename(tmp, full); } finally { reserved.delete(full); }
      sendJSON(res, 200, { name: finalName, from: device, size });
      broadcastFiles();
      const who = device === 'pc' ? 'PC  ->' : 'PHONE ->';
      console.log(`  ${who} ${finalName} (${(size / 1048576).toFixed(1)} MB)`);
    } catch (e) {
      fail(500, e.message);
    }
  });
}

async function handleDownload(req, res, url, from, name) {
  const file = resolveFile(from, name);
  let st;
  try { st = file && (await fsp.stat(file)); } catch {}
  if (!st || !st.isFile()) return sendJSON(res, 404, { error: 'File not found' });

  const headers = {
    'Content-Type': mimeOf(name),
    'Accept-Ranges': 'bytes',
    'Content-Disposition': contentDisposition(url.searchParams.has('inline') ? 'inline' : 'attachment', name),
    'Last-Modified': st.mtime.toUTCString(),
    'Cache-Control': 'no-cache',
  };
  let start = 0, end = st.size - 1, status = 200;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && st.size > 0) {
    if (range[1] === '') { start = Math.max(0, st.size - Number(range[2])); }
    else { start = Number(range[1]); if (range[2] !== '') end = Math.min(end, Number(range[2])); }
    if (start > end || start >= st.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  }
  headers['Content-Length'] = st.size === 0 ? 0 : end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || st.size === 0) return res.end();
  pipeline(fs.createReadStream(file, { start, end, highWaterMark: 1 << 20 }), res, () => {});
}

async function handleZip(req, res, url) {
  const from = url.searchParams.get('from');
  if (!DIRS[from]) return sendJSON(res, 400, { error: 'Bad source' });
  const files = (await listFiles()).filter((f) => f.from === from);
  if (!files.length) return sendJSON(res, 404, { error: 'No files' });
  const entries = files.map((f) => ({ name: f.name, size: f.size, mtime: f.mtime, path: path.join(DIRS[from], f.name) }));
  if (!fitsInZip32(entries)) return sendJSON(res, 413, { error: 'Too much for one zip (over 4 GB) — download files one by one' });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Length': zipSize(entries),
    'Content-Disposition': contentDisposition('attachment', `ApOffSend-${from === 'pc' ? 'from-PC' : 'from-phone'}-${stamp}.zip`),
    'Cache-Control': 'no-store',
  });
  writeZip(res, entries).catch(() => res.destroy());
}

function handleEvents(req, res, device) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 2000\n\n');
  const client = { id: crypto.randomBytes(4).toString('hex'), res, device, name: deviceName(req.headers['user-agent']), since: Date.now() };
  clients.add(client);
  listFiles().then((files) => send(res, 'files', files));
  send(res, 'texts', texts);
  broadcast('devices', devices());
  if (device === 'phone') console.log(`  + ${client.name} connected`);
  req.on('close', () => {
    clients.delete(client);
    broadcast('devices', devices());
    if (device === 'phone') console.log(`  - ${client.name} disconnected`);
  });
}

function lockPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#ff5a1f"><title>ApOffSend</title><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/style.css"></head><body class="lock">
<main><section class="card lock-card">
<span class="mark big"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h15l-4-4"/><path d="M20 16H5l4 4"/></svg></span>
<h1 class="display">Almost there</h1>
<p class="sub">Scan the QR code on your PC again, or type the access code shown under it.</p>
<form onsubmit="event.preventDefault();location.href='/?k='+encodeURIComponent(this.k.value.trim())">
<input name="k" class="input" placeholder="Access code" autocomplete="off" autocapitalize="off" spellcheck="false" required>
<button class="btn" type="submit">Connect</button></form></section></main></body></html>`;
}

// Requests that came through a reverse proxy (e.g. the app was deployed to a
// hosting service) are from the internet, not the local network. They only get
// the install page — never the files, and never the access code.
function isProxied(req) {
  if (opts.allowProxy) return false;
  const h = req.headers;
  return Boolean(h['x-forwarded-for'] || h.forwarded || h['x-real-ip'] || h['cf-connecting-ip'] || h['x-forwarded-host']);
}

function routePublic(req, res, p) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJSON(res, 405, { error: 'Not available here' });
  if (p === '/' || p === '/index.html') return serveStatic(res, 'landing.html');
  if (['/style.css', '/favicon.svg', '/icons.js', '/install.ps1'].includes(p)) return serveStatic(res, p.slice(1));
  res.writeHead(302, { Location: '/' });
  res.end();
}

// ----------------------------------------------------------------- router --

async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (isProxied(req)) return routePublic(req, res, p);
  if (p === '/install.ps1' || p === '/get') return serveStatic(res, p === '/get' ? 'landing.html' : 'install.ps1');
  const device = deviceOf(req);

  const cookies = parseCookies(req.headers.cookie);
  let authed = !opts.pin || device === 'pc' || safeEqual(cookies.aos || '', KEY);
  if (!authed && url.searchParams.has('k') && safeEqual(url.searchParams.get('k'), KEY)) {
    res.writeHead(302, { 'Set-Cookie': `aos=${KEY}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`, Location: '/' });
    return res.end();
  }
  if (authed && url.searchParams.has('k') && p === '/') {
    res.writeHead(302, { Location: '/' });
    return res.end();
  }

  if (p === '/style.css' || p === '/favicon.svg' || p === '/icons.js') return serveStatic(res, p.slice(1));
  if (!authed) {
    if (p === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(lockPage());
    }
    return sendJSON(res, 401, { error: 'Access code required' });
  }

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveStatic(res, 'index.html');
  if (req.method === 'GET' && (p === '/app.js' || p === '/qr.js' || p === '/icons.js')) return serveStatic(res, p.slice(1));

  if (p === '/api/info' && req.method === 'GET') {
    const info = { me: device, hostname: os.hostname(), version: VERSION, port: server.address().port };
    if (device === 'pc') Object.assign(info, { key: opts.pin ? KEY : null, addresses: lanAddresses(), dir: opts.dir });
    return sendJSON(res, 200, info);
  }
  if (p === '/api/events' && req.method === 'GET') return handleEvents(req, res, device);
  if (p === '/api/files' && req.method === 'GET') return sendJSON(res, 200, await listFiles());
  if (p === '/api/upload' && (req.method === 'POST' || req.method === 'PUT')) return handleUpload(req, res, url, device);
  if (p === '/api/zip' && req.method === 'GET') return handleZip(req, res, url);

  let m = /^\/api\/files\/(pc|phone)\/(.+)$/.exec(p);
  if (m) {
    const name = decodeURIComponent(m[2]);
    if (req.method === 'GET' || req.method === 'HEAD') return handleDownload(req, res, url, m[1], name);
    if (req.method === 'DELETE') {
      const file = resolveFile(m[1], name);
      try { await fsp.unlink(file); } catch { return sendJSON(res, 404, { error: 'File not found' }); }
      broadcastFiles();
      return sendJSON(res, 200, { ok: true });
    }
  }

  if (p === '/api/text' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req, 256 * 1024) || '{}');
    const text = String(body.text || '').slice(0, 200000);
    if (!text.trim()) return sendJSON(res, 400, { error: 'Empty text' });
    const item = { id: crypto.randomBytes(5).toString('hex'), text, from: device, time: Date.now() };
    texts = [item, ...texts].slice(0, 100);
    saveTexts();
    broadcast('texts', texts);
    return sendJSON(res, 200, item);
  }
  m = /^\/api\/text\/([a-f0-9]+)$/.exec(p);
  if (m && req.method === 'DELETE') {
    texts = texts.filter((t) => t.id !== m[1]);
    saveTexts();
    broadcast('texts', texts);
    return sendJSON(res, 200, { ok: true });
  }

  if (p === '/api/open-folder' && req.method === 'POST') {
    if (device !== 'pc') return sendJSON(res, 403, { error: 'Only from the PC' });
    const which = url.searchParams.get('from');
    openExternal(DIRS[which] || opts.dir);
    return sendJSON(res, 200, { ok: true });
  }

  sendJSON(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    if (!res.headersSent) sendJSON(res, err.status || (err instanceof SyntaxError ? 400 : 500), { error: err.message });
    else res.destroy();
  });
});
server.requestTimeout = 0; // big uploads can take a long time
server.headersTimeout = 60000;
server.keepAliveTimeout = 65000;

// ----------------------------------------------------------------- start --

async function shareCliFiles() {
  for (const f of opts.files) {
    try {
      const st = await fsp.stat(f);
      if (!st.isFile()) { console.log(`  ! skipped (not a file): ${f}`); continue; }
      const name = await uniqueName(DIRS.pc, safeName(path.basename(f)));
      await fsp.copyFile(f, path.join(DIRS.pc, name));
      console.log(`  shared ${name}`);
    } catch (e) {
      console.log(`  ! could not share ${f}: ${e.message}`);
    }
  }
}

function listen(port, attemptsLeft) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) return listen(port + 1, attemptsLeft - 1);
    console.error(`Could not start server: ${err.message}`);
    process.exit(1);
  });
  server.listen(port, '0.0.0.0', onListening);
}

async function onListening() {
  const port = server.address().port;
  await shareCliFiles();
  const addrs = lanAddresses();
  const suffix = opts.pin ? `/?k=${KEY}` : '/';
  console.log(`\n  ApOffSend ${VERSION} is running\n`);
  console.log(`  On this PC:   http://localhost:${port}`);
  if (addrs.length) {
    for (const a of addrs) console.log(`  On the phone: http://${a.address}:${port}${suffix}   (${a.ifname})`);
    console.log('\n  Scan with your phone camera:\n');
    console.log(QR.toTerminal(`http://${addrs[0].address}:${port}${suffix}`).replace(/^/gm, '    '));
  } else {
    console.log('\n  ! No network found. Connect this PC to Wi-Fi, or turn on your phone\'s hotspot and join it.');
  }
  if (opts.pin) console.log(`\n  Access code: ${KEY}`);
  console.log(`  Files are saved in: ${opts.dir}\n  Press Ctrl+C to stop.\n`);
  if (opts.open) openExternal(`http://localhost:${port}`);
}

listen(opts.port, 10);
