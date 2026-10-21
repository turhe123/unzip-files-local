// worker.js — heavy lifting off the main thread: inflating large entries and repacking a new ZIP.
// Classic worker; uses the vendored fflate build only. Messages: { id, type: 'inflate' | 'zip', ... }.
importScripts('./vendor/fflate/fflate.js');

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function inflate(msg) {
  const src = new Uint8Array(msg.data);
  const chunks = [];
  let total = 0;
  const inf = new fflate.Inflate((chunk) => {
    total += chunk.length;
    if (total > msg.limit) throw new Error('too-large');
    chunks.push(chunk);
  });
  const STEP = 1 << 20;
  if (!src.length) inf.push(src, true);
  for (let i = 0; i < src.length; i += STEP) {
    const end = Math.min(src.length, i + STEP);
    inf.push(src.subarray(i, end), end === src.length);
    postMessage({ id: msg.id, progress: end / src.length });
  }
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) { out.set(c, pos); pos += c.length; }
  return out;
}

self.onmessage = (ev) => {
  const msg = ev.data;
  try {
    if (msg.type === 'inflate') {
      const out = inflate(msg);
      postMessage({ id: msg.id, ok: true, data: out, crc: crc32(out) }, [out.buffer]);
    } else if (msg.type === 'zip') {
      const out = fflate.zipSync(msg.files);
      postMessage({ id: msg.id, ok: true, data: out }, [out.buffer]);
    } else {
      postMessage({ id: msg.id, ok: false, error: 'unknown job' });
    }
  } catch (err) {
    postMessage({ id: msg.id, ok: false, error: String((err && err.message) || err) });
  }
};
