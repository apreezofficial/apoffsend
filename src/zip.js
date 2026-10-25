'use strict';
// Streaming "store" (no compression) ZIP writer. Files are streamed straight
// from disk, so memory use stays flat no matter how big the archive is.
const fs = require('fs');
const zlib = require('zlib');

let table;
function crc32(buf, prev = 0) {
  if (zlib.crc32) return zlib.crc32(buf, prev);
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = prev ^ 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(ms) {
  const d = new Date(ms);
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const FLAGS = 0x0808; // bit 3: sizes in data descriptor, bit 11: UTF-8 names
const MAX = 0xffffffff;

// Exact byte length of the archive, so the browser can show real progress.
function zipSize(entries) {
  let total = 22;
  for (const e of entries) {
    const n = Buffer.byteLength(e.name, 'utf8');
    total += 30 + n + e.size + 16 + 46 + n;
  }
  return total;
}

function fitsInZip32(entries) {
  return entries.length < 0xffff && zipSize(entries) < MAX;
}

async function writeZip(out, entries) {
  let offset = 0;
  const central = [];
  const write = (buf) => {
    if (out.destroyed) throw new Error('aborted');
    offset += buf.length;
    if (out.write(buf)) return null;
    return new Promise((resolve) => {
      const done = () => { out.off('drain', done); out.off('close', done); resolve(); };
      out.on('drain', done);
      out.on('close', done);
    });
  };

  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const { time, date } = dosDateTime(e.mtime);
    const localOffset = offset;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(FLAGS, 6);
    lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt16LE(name.length, 26);
    await write(lh);
    await write(name);

    let crc = 0, size = 0;
    if (e.size > 0) {
      for await (const chunk of fs.createReadStream(e.path, { start: 0, end: e.size - 1, highWaterMark: 1 << 20 })) {
        crc = crc32(chunk, crc);
        size += chunk.length;
        await write(chunk);
      }
    }
    // Keep the promised Content-Length even if the file shrank meanwhile
    if (size < e.size) {
      const pad = Buffer.alloc(e.size - size);
      crc = crc32(pad, crc);
      size = e.size;
      await write(pad);
    }

    const dd = Buffer.alloc(16);
    dd.writeUInt32LE(0x08074b50, 0);
    dd.writeUInt32LE(crc, 4);
    dd.writeUInt32LE(size, 8);
    dd.writeUInt32LE(size, 12);
    await write(dd);
    central.push({ name, crc, size, time, date, localOffset });
  }

  const cdStart = offset;
  for (const c of central) {
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(20, 6);
    h.writeUInt16LE(FLAGS, 8);
    h.writeUInt16LE(0, 10);
    h.writeUInt16LE(c.time, 12);
    h.writeUInt16LE(c.date, 14);
    h.writeUInt32LE(c.crc, 16);
    h.writeUInt32LE(c.size, 20);
    h.writeUInt32LE(c.size, 24);
    h.writeUInt16LE(c.name.length, 28);
    h.writeUInt32LE(c.localOffset, 42);
    await write(h);
    await write(c.name);
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(offset - cdStart, 12);
  end.writeUInt32LE(cdStart, 16);
  await write(end);
  out.end();
}

module.exports = { writeZip, zipSize, fitsInZip32, crc32 };
