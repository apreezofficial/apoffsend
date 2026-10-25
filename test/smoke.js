'use strict';
// End-to-end check: starts the server in a temp folder and exercises every API.
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { crc32 } = require('../src/zip.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apoffsend-'));
const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--no-open', '-p', '18780', '-d', dir], {
  env: Object.assign({}, process.env, { APOFFSEND_TEST: '1' }),
});
let out = '';
server.stdout.on('data', (d) => { out += d; });
server.stderr.on('data', (d) => process.stderr.write(d));

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function main() {
  let base;
  for (let i = 0; i < 50 && !base; i++) {
    const m = /localhost:(\d+)/.exec(out);
    if (m) base = `http://127.0.0.1:${m[1]}`;
    else await new Promise((r) => setTimeout(r, 100));
  }
  assert(base, 'server did not start');
  const key = JSON.parse(fs.readFileSync(path.join(dir, '.apoffsend.json'), 'utf8')).key;
  const phone = { 'x-test-device': 'phone' };

  // PC uploads a file (unicode name, needs a unique rename the second time)
  const data = crypto.randomBytes(5 * 1024 * 1024 + 123);
  const name = 'Photo ✓ test.bin';
  let r = await fetch(`${base}/api/upload?name=${encodeURIComponent(name)}`, { method: 'POST', body: data });
  assert.strictEqual(r.status, 200);
  r = await fetch(`${base}/api/upload?name=${encodeURIComponent(name)}`, { method: 'POST', body: Buffer.from('second') });
  assert.strictEqual((await r.json()).name, 'Photo ✓ test (1).bin');

  // Phone is locked out without the code
  r = await fetch(`${base}/api/files`, { headers: phone });
  assert.strictEqual(r.status, 401);
  r = await fetch(`${base}/`, { headers: phone });
  assert((await r.text()).includes('Access code'));
  r = await fetch(`${base}/?k=wrong`, { headers: phone, redirect: 'manual' });
  assert.strictEqual(r.status, 200);

  // Code from the QR sets a cookie
  r = await fetch(`${base}/?k=${key}`, { headers: phone, redirect: 'manual' });
  assert.strictEqual(r.status, 302);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const authed = Object.assign({ cookie }, phone);

  r = await fetch(`${base}/api/info`, { headers: authed });
  const info = await r.json();
  assert.strictEqual(info.me, 'phone');
  assert.strictEqual(info.key, undefined, 'phone must not see the key');

  // Phone downloads the PC's file intact, including a range request
  r = await fetch(`${base}/api/files/pc/${encodeURIComponent(name)}`, { headers: authed });
  assert.strictEqual(r.status, 200);
  assert(r.headers.get('content-disposition').includes("filename*=UTF-8''Photo%20%E2%9C%93%20test.bin"));
  assert.strictEqual(sha(Buffer.from(await r.arrayBuffer())), sha(data));
  r = await fetch(`${base}/api/files/pc/${encodeURIComponent(name)}`, { headers: Object.assign({ range: 'bytes=100-199' }, authed) });
  assert.strictEqual(r.status, 206);
  assert.deepStrictEqual(Buffer.from(await r.arrayBuffer()), data.subarray(100, 200));

  // Phone uploads to the PC
  const pdata = crypto.randomBytes(300000);
  r = await fetch(`${base}/api/upload?name=${encodeURIComponent('../../evil/IMG_001.jpg')}`, { method: 'POST', body: pdata, headers: authed });
  assert.strictEqual((await r.json()).name, 'IMG_001.jpg');
  assert.strictEqual(sha(fs.readFileSync(path.join(dir, 'from-phone', 'IMG_001.jpg'))), sha(pdata));

  // Path traversal is refused
  r = await fetch(`${base}/api/files/pc/${encodeURIComponent('../.apoffsend.json')}`, { headers: authed });
  assert.strictEqual(r.status, 404);

  // Listing
  r = await fetch(`${base}/api/files`, { headers: authed });
  const files = await r.json();
  assert.strictEqual(files.length, 3);

  // Zip of the PC's files: check structure and CRCs
  r = await fetch(`${base}/api/zip?from=pc`, { headers: authed });
  assert.strictEqual(r.status, 200);
  const zip = Buffer.from(await r.arrayBuffer());
  assert.strictEqual(Number(r.headers.get('content-length')), zip.length);
  const eocd = zip.length - 22;
  assert.strictEqual(zip.readUInt32LE(eocd), 0x06054b50);
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  assert.strictEqual(count, 2);
  for (let i = 0; i < count; i++) {
    assert.strictEqual(zip.readUInt32LE(p), 0x02014b50);
    const crc = zip.readUInt32LE(p + 16), size = zip.readUInt32LE(p + 24), nlen = zip.readUInt16LE(p + 28);
    const local = zip.readUInt32LE(p + 42);
    const lnlen = zip.readUInt16LE(local + 26);
    const body = zip.subarray(local + 30 + lnlen, local + 30 + lnlen + size);
    assert.strictEqual(crc32(body), crc);
    p += 46 + nlen;
  }

  // Text messages
  r = await fetch(`${base}/api/text`, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, authed), body: JSON.stringify({ text: 'hi from phone https://x.y' }) });
  const t = await r.json();
  assert.strictEqual(t.from, 'phone');

  // Live events reach the PC
  const ctrl = new AbortController();
  r = await fetch(`${base}/api/events`, { signal: ctrl.signal });
  const reader = r.body.getReader();
  let sse = '';
  while (!sse.includes('event: texts')) sse += new TextDecoder().decode((await reader.read()).value);
  assert(sse.includes('hi from phone'));
  ctrl.abort();

  // Delete
  r = await fetch(`${base}/api/files/phone/IMG_001.jpg`, { method: 'DELETE', headers: authed });
  assert.strictEqual(r.status, 200);
  assert(!fs.existsSync(path.join(dir, 'from-phone', 'IMG_001.jpg')));

  // Static assets
  for (const f of ['/', '/app.js', '/qr.js', '/style.css']) {
    r = await fetch(base + f);
    assert.strictEqual(r.status, 200, f);
  }

  console.log('All smoke tests passed');
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => { server.kill(); setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 300); });
