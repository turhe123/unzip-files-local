// make-fixtures.js — generates the small, fictional ZIP fixtures used by __demo and tests/smoke.spec.js.
// Run with: node tests/fixtures/make-fixtures.js
const fs = require('fs');
const path = require('path');
const fflate = require('../../vendor/fflate/fflate.js');

const out = (name) => path.join(__dirname, name);
const enc = (s) => fflate.strToU8(s);
const mtime = new Date(2026, 6, 14, 10, 30, 0);
const png = fs.readFileSync(out('small.png'));

// ---- sample-archive.zip: folders, an empty folder, a stored entry and a nested ZIP ----
const inner = fflate.zipSync({ 'hello.txt': [enc('Hello from inside the nested archive.\n'), { mtime }] });
const todo = '# To do\n\n- Water the plants\n- Return the library books\n- Book the bike repair\n';
const sample = fflate.zipSync({
  'readme.txt': [enc('Sample archive readme\nThis archive is used to test the unzip tool.\nLine three of the readme.\n'), { mtime }],
  notes: { 'todo.md': [enc(todo), { mtime }] },
  data: { 'inventory.csv': [enc('item,qty,shelf\nlantern,2,A1\nrope,5,B3\ntent pegs,24,C2\n'), { mtime, level: 0 }] },
  images: { 'small.png': [new Uint8Array(png), { mtime, level: 0 }] },
  nested: { 'inner.zip': [inner, { mtime, level: 0 }] },
  'empty-folder/': [new Uint8Array(0), { mtime, level: 0 }],
}, { level: 6 });
fs.writeFileSync(out('sample-archive.zip'), sample);

// ---- corrupt.zip: the first 60% of sample-archive.zip (download that never finished) ----
fs.writeFileSync(out('corrupt.zip'), sample.subarray(0, Math.floor(sample.length * 0.6)));

// ---- holiday-photos-notes.zip: the demo archive from a fictional family trip ----
const holiday = fflate.zipSync({
  'readme.txt': [enc('Lakeside cabin trip, summer 2026\n\nNotes from our week at the (fictional) Pinecrest Lake cabin.\n- Day 1: arrived late, pizza by the fire\n- Day 2: canoe to the island\n- Day 3: rain, board games all afternoon\n- Day 4: hike to the lookout\n'), { mtime }],
  'packing-list.csv': [enc('item,packed,who\nsunscreen,yes,everyone\nhiking boots,yes,kids\nfirst aid kit,yes,parents\nboard games,no,kids\nrain jackets,yes,everyone\n'), { mtime }],
  'lake-view.png': [new Uint8Array(png), { mtime, level: 0 }],
  Receipts: {
    'ferry-ticket.txt': [enc('Island ferry, return x4\nTotal: 32.00\nPaid by card\n'), { mtime }],
    'café-breakfast.txt': [enc('Harbour café breakfast\n2 pancakes, 2 omelettes, 4 juices\nTotal: 41.50\n'), { mtime }],
  },
}, { level: 6 });
fs.writeFileSync(out('holiday-photos-notes.zip'), holiday);

// ---- edge-cases.zip: hand-built (stored entries) so flags, methods and name bytes can be set exactly ----
const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (d) => { let c = 0xffffffff; for (const b of d) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function rawZip(items) {
  const locals = []; const centrals = []; let offset = 0;
  const dosTime = (10 << 11) | (30 << 5); const dosDate = ((2026 - 1980) << 9) | (7 << 5) | 14;
  for (const it of items) {
    const name = Buffer.from(it.nameBytes); const data = Buffer.from(it.data);
    const flags = (it.utf8 ? 0x800 : 0) | (it.encrypted ? 1 : 0); const method = it.method || 0; const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flags, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, data); centrals.push(ch, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(items.length, 8); eocd.writeUInt16LE(items.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
const ascii = (s) => Buffer.from(s, 'latin1');
fs.writeFileSync(out('edge-cases.zip'), rawZip([
  { nameBytes: ascii('../outside.txt'), data: enc('This name tried to climb out of the folder.\n') },
  { nameBytes: ascii('a/same.txt'), data: enc('same name, folder a\n') },
  { nameBytes: ascii('b/same.txt'), data: enc('same name, folder b\n') },
  { nameBytes: ascii('dup.txt'), data: enc('first copy\n') },
  { nameBytes: ascii('dup.txt'), data: enc('second copy\n') },
  { nameBytes: ascii('secret.txt'), data: enc('xxxxxxxxxxxxxxxx'), encrypted: true },
  { nameBytes: ascii('old-method.bin'), data: enc('BZh9 pretend bzip2 data'), method: 12 },
  // "Résumé.txt" written by an old Windows tool: CP437 bytes (0x82 = é), no UTF-8 flag
  { nameBytes: [0x52, 0x82, 0x73, 0x75, 0x6d, 0x82, 0x2e, 0x74, 0x78, 0x74], data: enc('Old Windows name encoding.\n') },
]));

console.log('fixtures written');
