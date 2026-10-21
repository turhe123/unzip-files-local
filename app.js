// app.js — Unzip Files Online. Everything runs on this device; the only fetch() is __demo loading a bundled fixture.
// The archive is never read whole: the central directory is parsed from the end of the file, and each entry is
// sliced and decompressed only when the user previews or saves it (large entries inflate in worker.js).
import { toast, downloadBlob, formatBytes, wireDropzone } from './site.js';

const $ = (id) => document.getElementById(id);
const zone = $('dropzone');
const input = $('file-input');
const results = $('results');
const explorer = $('explorer');
const tbody = $('entries-body');
const filterInput = $('filter');
const selectAll = $('select-all');
const previewPanel = $('preview-panel');
const previewTitle = $('preview-title');
const previewBody = $('preview');
const listNote = $('list-note');
const selInfo = $('selection-info');
const btnSelected = $('save-selected');
const btnZip = $('zip-selected');
const btnAll = $('save-all');
const progressWrap = $('progress-wrap');
const progressEl = $('progress');
const progressBar = $('progress-bar');
const progressText = $('progress-text');

const WORKER_THRESHOLD = 4 * 1024 * 1024; // entries bigger than this inflate in the worker
const MAX_ENTRY = 2 ** 31 - 1; // a browser tab cannot hold one buffer much bigger than this
const BOMB_TOTAL = 4 * 1024 ** 3; // total uncompressed size that triggers the zip bomb warning
const BOMB_RATIO = 200; // or an overall ratio this extreme on a large archive
const MOBILE_WARN = 1024 ** 3; // archives over 1 GB may exhaust memory on mobile Safari
const TEXT_PREVIEW_BYTES = 4096;
const IMAGE_PREVIEW_CAP = 25 * 1024 * 1024;
const MAX_ROWS = 3000;
const STAGGER_MS = 350;

// ---------------------------------------------------------------- errors

const ERROR_TITLES = {
  'not-zip': 'Not a ZIP file',
  corrupt: 'Corrupt archive',
  unsupported: 'Unsupported compression',
  encrypted: 'Password protected',
  multipart: 'Split archive not supported',
  sfx: 'Executable rejected',
  'too-large': 'Too large for a browser tab',
};

class ZipError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

const METHOD_NAMES = { 1: 'Shrink', 6: 'Implode', 9: 'Deflate64', 12: 'bzip2', 14: 'LZMA', 93: 'Zstandard', 95: 'XZ', 96: 'JPEG', 97: 'WavPack', 98: 'PPMd', 99: 'AES encryption' };

// ---------------------------------------------------------------- small utilities

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c != null) el.append(c);
  return el;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Honest percentages: one decimal, never rounded up to 100% or down to 0%.
function pct(part, whole) {
  if (!whole) return '0%';
  const v = (part / whole) * 100;
  let s = v.toFixed(1);
  if (s === '100.0' && part < whole) s = '99.9';
  if (s === '0.0' && part > 0) s = '0.1';
  return `${s.replace(/\.0$/, '')}%`;
}

const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

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

const CP437_HIGH = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
const utf8 = new TextDecoder('utf-8');
const utf8Strict = new TextDecoder('utf-8', { fatal: true });

// UTF-8 when the archive says so; otherwise UTF-8 if the bytes are valid UTF-8 (macOS, Linux), else CP437 (old Windows).
function decodeName(bytes, utf8Flag) {
  if (utf8Flag) return utf8.decode(bytes);
  let ascii = true;
  for (const b of bytes) if (b > 0x7f) { ascii = false; break; }
  if (ascii) return String.fromCharCode(...bytes);
  try { return utf8Strict.decode(bytes); } catch { /* not UTF-8 */ }
  let s = '';
  for (const b of bytes) s += b < 0x80 ? String.fromCharCode(b) : CP437_HIGH[b - 0x80];
  return s;
}

// Split a stored path into safe segments: no "..", no ".", no drive letters, no characters file systems reject.
function sanitizePath(raw) {
  let unsafe = false;
  const segs = [];
  raw.replace(/\\/g, '/').split('/').forEach((seg, i) => {
    if (seg === '' || seg === '.') return;
    if (seg === '..') { unsafe = true; return; }
    if (i === 0 && /^[a-zA-Z]:$/.test(seg)) { unsafe = true; return; }
    // eslint-disable-next-line no-control-regex
    const clean = seg.replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/[. ]+$/, '') || '_';
    segs.push(clean);
  });
  if (raw.startsWith('/') || raw.startsWith('\\')) unsafe = true;
  return { segs, unsafe };
}

function numbered(name, n) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

const extOf = (name) => { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i + 1).toLowerCase() : ''; };

const MIME = {
  txt: 'text/plain', log: 'text/plain', md: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json',
  xml: 'application/xml', html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', yaml: 'text/yaml', yml: 'text/yaml',
  srt: 'application/x-subrip', vtt: 'text/vtt', ini: 'text/plain', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif', heic: 'image/heic', pdf: 'application/pdf',
  zip: 'application/zip', gz: 'application/gzip', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', mp4: 'video/mp4',
  webm: 'video/webm', mov: 'video/quicktime', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  epub: 'application/epub+zip', ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
};
const mimeOf = (name) => MIME[extOf(name)] || 'application/octet-stream';
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg']);
const TEXT_EXT = new Set(['txt', 'log', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'html', 'htm', 'css', 'js', 'mjs', 'ts', 'yaml', 'yml', 'srt', 'vtt', 'ini', 'cfg', 'conf', 'toml', 'py', 'rb', 'sh', 'bat', 'ps1', 'c', 'h', 'cpp', 'java', 'go', 'rs', 'php', 'sql', 'svg', 'rtf', 'tex', 'gitignore', 'env', 'properties', 'nfo']);
const STORE_EXT = new Set(['zip', 'gz', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'heic', 'mp3', 'mp4', 'm4a', 'mov', 'webm', 'ogg', 'docx', 'xlsx', 'pptx', 'epub', 'woff', 'woff2', '7z', 'rar']);
const isZipName = (name) => extOf(name) === 'zip';

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const dayFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
function dosDate(date, time) {
  if (!date) return null;
  const d = new Date(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ---------------------------------------------------------------- reading the archive

async function readBytes(file, start, end) {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

function sniffOther(b) {
  if (b[0] === 0x52 && b[1] === 0x61 && b[2] === 0x72 && b[3] === 0x21) return 'RAR archive';
  if (b[0] === 0x37 && b[1] === 0x7a && b[2] === 0xbc && b[3] === 0xaf) return '7-Zip archive';
  if (b[0] === 0x1f && b[1] === 0x8b) return 'gzip file (.gz)';
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'PDF document';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'PNG image';
  if (b[0] === 0xff && b[1] === 0xd8) return 'JPEG image';
  return '';
}

async function parseArchive(file) {
  const lower = file.name.toLowerCase();
  if (/\.(z\d\d|zip\.\d{3})$/.test(lower)) {
    throw new ZipError('multipart', `"${file.name}" is one part of a split (multi-part) archive. This tool opens single ZIP files only. Join the parts with a desktop tool such as 7-Zip, or ask the sender for a single ZIP.`);
  }
  if (file.size < 22) throw new ZipError(file.size >= 4 ? 'corrupt' : 'not-zip', file.size ? `"${file.name}" is too small to be a ZIP archive.` : `"${file.name}" is empty.`);
  const head = await readBytes(file, 0, 8);
  const dvh = new DataView(head.buffer);
  const sig = dvh.getUint32(0, true);
  if (head[0] === 0x4d && head[1] === 0x5a) {
    throw new ZipError('sfx', `"${file.name}" is a Windows program (.exe), possibly a self-extracting archive. For your safety this tool does not open executables. If it is an archive, open it with a desktop tool such as 7-Zip.`);
  }
  const isPK = sig === 0x04034b50 || sig === 0x06054b50 || sig === 0x08074b50 || sig === 0x30304b50;
  if (!isPK) {
    const fmt = sniffOther(head);
    if (fmt) throw new ZipError('not-zip', `"${file.name}" is a ${fmt}, not a ZIP archive. This tool only opens ZIP files.`);
  }

  const tailLen = Math.min(file.size, 22 + 0xffff + 20);
  const tailStart = file.size - tailLen;
  const tail = await readBytes(file, tailStart, file.size);
  const dv = new DataView(tail.buffer);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 5 && tail[i + 3] === 6 && i + 22 + dv.getUint16(i + 20, true) <= tail.length) { eocd = i; break; }
  }
  if (eocd < 0) {
    if (!isPK) throw new ZipError('not-zip', `"${file.name}" is not a ZIP file. Choose a file that ends in .zip.`);
    if (sig === 0x08074b50 || sig === 0x30304b50) throw new ZipError('multipart', `"${file.name}" is the first part of a split archive. This tool opens single ZIP files only; join the parts with a desktop tool such as 7-Zip.`);
    throw new ZipError('corrupt', `"${file.name}" is damaged or incomplete: the file list at the end of the archive is missing. It may not have finished downloading, so try downloading it again.`);
  }

  let disk = dv.getUint16(eocd + 4, true);
  let cdDisk = dv.getUint16(eocd + 6, true);
  let total = dv.getUint16(eocd + 10, true);
  let cdSize = dv.getUint32(eocd + 12, true);
  let cdOffset = dv.getUint32(eocd + 16, true);
  let cdEnd = tailStart + eocd;
  let zip64 = false;
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc >= 0 && dv.getUint32(loc, true) === 0x07064b50) {
      const recOffset = Number(dv.getBigUint64(loc + 8, true));
      const rec = await readBytes(file, recOffset, recOffset + 56);
      const rv = new DataView(rec.buffer);
      if (rec.length < 56 || rv.getUint32(0, true) !== 0x06064b50) throw new ZipError('corrupt', `"${file.name}" is damaged: its ZIP64 directory record is unreadable.`);
      disk = rv.getUint32(16, true);
      cdDisk = rv.getUint32(20, true);
      total = Number(rv.getBigUint64(32, true));
      cdSize = Number(rv.getBigUint64(40, true));
      cdOffset = Number(rv.getBigUint64(48, true));
      cdEnd = recOffset;
      zip64 = true;
    }
  }
  if (disk !== 0 || cdDisk !== 0) {
    throw new ZipError('multipart', `"${file.name}" is the last part of a split (multi-part) archive. This tool opens single ZIP files only; join the parts with a desktop tool such as 7-Zip.`);
  }
  // Data prepended before the archive shifts every offset by the same amount.
  const delta = cdEnd - (cdOffset + cdSize);
  if (delta < 0) throw new ZipError('corrupt', `"${file.name}" is damaged or incomplete: its file list points past the end of the file.`);
  if (cdSize > 512 * 1024 * 1024) throw new ZipError('too-large', `"${file.name}" lists so many files that its directory alone is over 512 MB.`);
  const cdStart = cdOffset + delta;
  const cd = await readBytes(file, cdStart, cdStart + cdSize);
  const cv = new DataView(cd.buffer);
  const entries = [];
  let p = 0;
  for (let i = 0; i < total; i++) {
    if (p + 46 > cd.length || cv.getUint32(p, true) !== 0x02014b50) {
      throw new ZipError('corrupt', `"${file.name}" is damaged: the file list is broken after ${plural(i, 'entry', 'entries')}.`);
    }
    const flags = cv.getUint16(p + 8, true);
    const method = cv.getUint16(p + 10, true);
    const time = cv.getUint16(p + 12, true);
    const date = cv.getUint16(p + 14, true);
    const crc = cv.getUint32(p + 16, true);
    let csize = cv.getUint32(p + 20, true);
    let size = cv.getUint32(p + 24, true);
    const nlen = cv.getUint16(p + 28, true);
    const elen = cv.getUint16(p + 30, true);
    const clen = cv.getUint16(p + 32, true);
    const attrs = cv.getUint32(p + 38, true);
    let offset = cv.getUint32(p + 42, true);
    const nameBytes = cd.subarray(p + 46, p + 46 + nlen);
    let name = decodeName(nameBytes, flags & 0x800);
    // Extra fields: ZIP64 sizes/offset (0x0001) and the Info-ZIP Unicode path (0x7075).
    let q = p + 46 + nlen;
    const qEnd = q + elen;
    while (q + 4 <= qEnd && qEnd <= cd.length) {
      const id = cv.getUint16(q, true);
      const len = cv.getUint16(q + 2, true);
      let r = q + 4;
      if (id === 0x0001) {
        if (size === 0xffffffff && r + 8 <= q + 4 + len) { size = Number(cv.getBigUint64(r, true)); r += 8; }
        if (csize === 0xffffffff && r + 8 <= q + 4 + len) { csize = Number(cv.getBigUint64(r, true)); r += 8; }
        if (offset === 0xffffffff && r + 8 <= q + 4 + len) { offset = Number(cv.getBigUint64(r, true)); r += 8; }
      } else if (id === 0x7075 && len > 5 && !(flags & 0x800)) {
        name = utf8.decode(cd.subarray(q + 9, q + 4 + len));
      }
      q += 4 + len;
    }
    p += 46 + nlen + elen + clen;
    if (p > cd.length) throw new ZipError('corrupt', `"${file.name}" is damaged: the file list is cut short.`);
    const dir = /[/\\]$/.test(name) || ((attrs & 0x10) !== 0 && size === 0 && csize === 0);
    const { segs, unsafe } = sanitizePath(name);
    entries.push({
      id: i, rawName: name, segs, unsafe, dir, flags, method, crc, csize, size, offset: offset + delta,
      encrypted: (flags & 1) !== 0, mtime: dosDate(date, time), name: segs[segs.length - 1] || 'unnamed',
    });
  }
  return { entries, zip64 };
}

// ---------------------------------------------------------------- tree

function buildTree(entries) {
  const mkDir = (name, parent) => ({ key: `${parent ? parent.key : ''}/d:${name}`, name, dir: true, parent, depth: parent ? parent.depth + 1 : -1, children: new Map(), size: 0, csize: 0, files: 0, entry: null, path: parent && parent.path ? `${parent.path}/${name}` : name });
  const root = mkDir('', null);
  root.key = '';
  root.path = '';
  for (const e of entries) {
    if (!e.segs.length) continue;
    let node = root;
    const last = e.dir ? e.segs.length : e.segs.length - 1;
    for (let i = 0; i < last; i++) {
      let child = node.children.get(`d:${e.segs[i]}`);
      if (!child) { child = mkDir(e.segs[i], node); node.children.set(`d:${e.segs[i]}`, child); }
      node = child;
    }
    if (e.dir) { node.entry = node.entry || e; continue; }
    const base = e.segs[e.segs.length - 1];
    let name = base;
    for (let n = 2; node.children.has(`f:${name}`); n++) name = numbered(base, n);
    e.displayName = name;
    e.savePath = node.path ? `${node.path}/${name}` : name;
    node.children.set(`f:${name}`, { key: `${node.key}/f:${name}`, name, dir: false, parent: node, depth: node.depth + 1, entry: e });
  }
  const finish = (node) => {
    node.sorted = [...node.children.values()].sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : a.dir ? -1 : 1));
    for (const c of node.sorted) {
      if (c.dir) finish(c);
      node.size += c.dir ? c.size : c.entry.size;
      node.csize += c.dir ? c.csize : c.entry.csize;
      node.files += c.dir ? c.files : 1;
    }
  };
  finish(root);
  return root;
}

function* filesUnder(node) {
  for (const c of node.sorted) {
    if (c.dir) yield* filesUnder(c);
    else yield c.entry;
  }
}

// ---------------------------------------------------------------- state

const state = {
  file: null, entries: [], tree: null, stack: [], expanded: new Set(), selected: new Set(),
  rows: [], rowByKey: new Map(), focusKey: null, previewKey: null, previewUrl: null, busy: false,
};
let loadToken = 0;
let previewToken = 0;
const localCache = new Map();

const canExtract = (e) => !e.dir && !e.encrypted && (e.method === 0 || e.method === 8) && e.size <= MAX_ENTRY;
function blockReason(e) {
  if (e.encrypted) return 'Password protected: this tool cannot open encrypted files.';
  if (e.method !== 0 && e.method !== 8) return `Uses ${METHOD_NAMES[e.method] || `method ${e.method}`} compression, which this tool cannot decompress.`;
  if (e.size > MAX_ENTRY) return `At ${formatBytes(e.size)} this file is too large to extract in a browser tab.`;
  return '';
}

// ---------------------------------------------------------------- extraction

let worker = null;
let jobId = 0;
const jobs = new Map();
function runWorker(msg, transfer, onProgress) {
  if (!worker) {
    worker = new Worker('./worker.js');
    worker.onmessage = (ev) => {
      const job = jobs.get(ev.data.id);
      if (!job) return;
      if ('progress' in ev.data) { job.onProgress && job.onProgress(ev.data.progress); return; }
      jobs.delete(ev.data.id);
      if (ev.data.ok) job.resolve(ev.data);
      else job.reject(new Error(ev.data.error));
    };
    worker.onerror = (ev) => {
      ev.preventDefault();
      for (const job of jobs.values()) job.reject(new Error('The background worker stopped unexpectedly.'));
      jobs.clear();
      worker = null;
    };
  }
  const id = ++jobId;
  return new Promise((resolve, reject) => {
    jobs.set(id, { resolve, reject, onProgress });
    worker.postMessage({ ...msg, id }, transfer);
  });
}

async function dataStart(e) {
  if (localCache.has(e.id)) return localCache.get(e.id);
  const lh = await readBytes(state.file, e.offset, e.offset + 30);
  const lv = new DataView(lh.buffer);
  if (lh.length < 30 || lv.getUint32(0, true) !== 0x04034b50) {
    throw new ZipError('corrupt', `"${e.displayName}" could not be found where the archive says it is, so the archive is damaged.`);
  }
  const start = e.offset + 30 + lv.getUint16(26, true) + lv.getUint16(28, true);
  if (start + e.csize > state.file.size) throw new ZipError('corrupt', `"${e.displayName}" is cut off: the archive is incomplete.`);
  localCache.set(e.id, start);
  return start;
}

function checkExtractable(e) {
  if (e.encrypted) throw new ZipError('encrypted', `"${e.displayName}" is password protected. This tool cannot open encrypted files; use a desktop tool such as 7-Zip with the password.`);
  if (e.method !== 0 && e.method !== 8) throw new ZipError('unsupported', `"${e.displayName}" uses ${METHOD_NAMES[e.method] || `method ${e.method}`} compression. This tool can only decompress the standard Deflate and Stored methods; try a desktop tool such as 7-Zip.`);
  if (e.size > MAX_ENTRY) throw new ZipError('too-large', `"${e.displayName}" is ${formatBytes(e.size)} uncompressed, more than a browser tab can hold in memory.`);
}

async function extract(e, onProgress) {
  checkExtractable(e);
  const start = await dataStart(e);
  const raw = await readBytes(state.file, start, start + e.csize);
  let out;
  let crc;
  if (e.method === 0) {
    out = raw;
  } else if (Math.max(e.csize, e.size) > WORKER_THRESHOLD) {
    try {
      const res = await runWorker({ type: 'inflate', data: raw.buffer, limit: Math.min(MAX_ENTRY, e.size + 1024) }, [raw.buffer], onProgress);
      out = res.data;
      crc = res.crc;
    } catch (err) {
      throw new ZipError('corrupt', `"${e.displayName}" could not be decompressed (${err.message}). The archive is damaged.`);
    }
  } else {
    try { out = globalThis.fflate.inflateSync(raw); } catch {
      throw new ZipError('corrupt', `"${e.displayName}" could not be decompressed. The archive is damaged.`);
    }
  }
  if (out.length !== e.size || (crc ?? crc32(out)) !== e.crc) {
    throw new ZipError('corrupt', `"${e.displayName}" failed its checksum, so the archive is damaged and the file would not be correct.`);
  }
  return out;
}

// First bytes only, for text previews: stored entries are sliced, deflated ones inflate just far enough.
async function extractHead(e, limit) {
  checkExtractable(e);
  const start = await dataStart(e);
  if (e.method === 0) return readBytes(state.file, start, start + Math.min(limit, e.csize));
  const chunks = [];
  let got = 0;
  let done = false;
  const inf = new globalThis.fflate.Inflate((chunk) => { chunks.push(chunk); got += chunk.length; });
  const STEP = 32 * 1024;
  try {
    for (let pos = 0; pos < e.csize && got < limit && !done; pos += STEP) {
      const end = Math.min(e.csize, pos + STEP);
      inf.push(await readBytes(state.file, start + pos, start + end), end === e.csize);
      done = end === e.csize;
    }
  } catch {
    throw new ZipError('corrupt', `"${e.displayName}" could not be decompressed. The archive is damaged.`);
  }
  const out = new Uint8Array(Math.min(got, limit));
  let o = 0;
  for (const c of chunks) { if (o >= out.length) break; out.set(c.subarray(0, out.length - o), o); o += c.length; }
  return out;
}

// ---------------------------------------------------------------- UI: alerts, summary, progress

function addAlert(kind, title, text) {
  const el = h('div', { class: `alert alert--${kind}`, role: kind === 'error' ? 'alert' : null },
    h('strong', { text: `${title}. ` }), text);
  results.append(el);
  return el;
}

function showError(err) {
  const kind = err instanceof ZipError ? err.kind : 'other';
  const title = ERROR_TITLES[kind] || 'Something went wrong';
  const msg = err instanceof ZipError ? err.message : `${err && err.message ? err.message : err}`;
  const el = addAlert('error', title, msg);
  el.dataset.kind = kind;
  el.scrollIntoView({ block: 'nearest' });
  return el;
}

function setProgress(fraction, text) {
  if (fraction == null) { progressWrap.hidden = true; return; }
  progressWrap.hidden = false;
  const v = Math.max(0, Math.min(1, fraction));
  progressBar.style.width = `${v * 100}%`;
  progressEl.setAttribute('aria-valuenow', String(Math.floor(v * 100)));
  progressText.textContent = text || '';
}

const ZIP_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M10 4v2m0 2v2m0 2v2m-1 2h2v3H9z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

function renderSummary() {
  const { tree, file, stack, entries } = state;
  const folders = countFolders(tree);
  const csize = entries.reduce((s, e) => s + (e.dir ? 0 : e.csize), 0);
  const icon = h('span', { class: 'archive-summary__icon' });
  icon.innerHTML = ZIP_ICON;
  const ratio = tree.size === 0 ? 'nothing to compress' : csize >= tree.size ? 'not compressed' : `compressed to ${pct(csize, tree.size)} of full size`;
  const info = h('div', { class: 'result__info archive-summary__stats' },
    h('span', { class: 'stat', 'data-stat': 'files', text: plural(tree.files, 'file') }),
    h('span', { class: 'stat', text: plural(folders, 'folder') }),
    h('span', { class: 'stat', 'data-stat': 'size', text: `${formatBytes(tree.size)} uncompressed` }),
    h('span', { class: 'stat', 'data-stat': 'ratio', text: ratio }));
  const meta = h('div', { class: 'result__meta' }, h('div', { class: 'result__name', id: 'archive-name', text: file.name, title: file.name }), info);
  const card = h('div', { class: 'result archive-summary' }, icon, meta);
  if (stack.length) {
    const parent = stack[stack.length - 1];
    const back = h('button', { class: 'btn btn--small', type: 'button', id: 'back-parent', text: `Back to ${parent.name}` });
    back.addEventListener('click', () => { const s = state.stack.slice(0, -1); openArchive(parent, { stack: s }); });
    card.append(h('div', { class: 'archive-summary__crumbs' },
      h('span', { class: 'archive-summary__path', text: `Inside ${[...stack.map((f) => f.name), file.name].join(' › ')}` }), back));
  }
  results.prepend(card);
  return card;
}

function countFolders(node) {
  let n = 0;
  for (const c of node.sorted) if (c.dir) n += 1 + countFolders(c);
  return n;
}

function renderWarnings() {
  const { entries, tree, file } = state;
  const csize = entries.reduce((s, e) => s + e.csize, 0);
  if (!tree.files && !entries.some((e) => e.dir)) addAlert('warn', 'Empty archive', `"${file.name}" is a valid ZIP but contains no files.`);
  if (tree.size > BOMB_TOTAL || (tree.size > 1024 ** 3 && csize > 0 && tree.size / csize > BOMB_RATIO)) {
    addAlert('warn', 'Possible zip bomb', `These files would take ${formatBytes(tree.size)} once extracted, from a ${formatBytes(file.size)} archive. Listing is safe, but only save the files you need: extracting everything could freeze this tab or fill your disk.`);
  }
  if (file.size > MOBILE_WARN) {
    addAlert('warn', 'Large archive', `At ${formatBytes(file.size)} this archive is fine to browse, but extracting very large files may run out of memory on phones and tablets, especially Safari on iPhone and iPad.`);
  }
  const enc = entries.filter((e) => !e.dir && e.encrypted).length;
  if (enc) addAlert('warn', 'Password protected', `${plural(enc, 'file is', 'files are')} encrypted and marked with a lock. This tool cannot open password-protected files; use a desktop tool such as 7-Zip with the password. The other files open normally.`);
  const unsup = entries.filter((e) => !e.dir && !e.encrypted && e.method !== 0 && e.method !== 8);
  if (unsup.length) {
    const names = [...new Set(unsup.map((e) => METHOD_NAMES[e.method] || `method ${e.method}`))].join(', ');
    addAlert('warn', 'Unsupported compression', `${plural(unsup.length, 'file uses', 'files use')} ${names} compression, which this tool cannot decompress. They are listed but cannot be saved here.`);
  }
  const unsafe = entries.filter((e) => e.unsafe).length;
  if (unsafe) addAlert('warn', 'Unsafe paths cleaned', `${plural(unsafe, 'file name', 'file names')} tried to point outside the archive folder (for example with ".."). They were cleaned up so nothing can be saved outside your downloads folder.`);
}

// ---------------------------------------------------------------- UI: file list

const ICONS = {
  folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" fill="currentColor" opacity=".85"/></svg>',
  file: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M14 3v5h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  image: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="9" cy="10" r="2" fill="currentColor"/><path d="m4 18 5-5 4 4 3-3 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  zip: ZIP_ICON,
  lock: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
};

function iconFor(node) {
  if (node.dir) return ICONS.folder;
  if (node.entry.encrypted) return ICONS.lock;
  const ext = extOf(node.name);
  if (ext === 'zip') return ICONS.zip;
  if (IMAGE_EXT.has(ext)) return ICONS.image;
  return ICONS.file;
}

function visibleNodes() {
  const q = filterInput.value.trim().toLowerCase();
  const out = [];
  if (!q) {
    const walk = (node) => {
      for (const c of node.sorted) {
        out.push(c);
        if (c.dir && state.expanded.has(c.key)) walk(c);
      }
    };
    walk(state.tree);
    return out;
  }
  const hit = new Map();
  const test = (node) => {
    let any = node.name.toLowerCase().includes(q);
    if (node.dir) for (const c of node.sorted) if (test(c)) any = true;
    hit.set(node, any);
    return any;
  };
  test(state.tree);
  const walk = (node, all) => {
    for (const c of node.sorted) {
      const self = c.name.toLowerCase().includes(q);
      if (!all && !hit.get(c)) continue;
      out.push(c);
      if (c.dir) walk(c, all || self);
    }
  };
  walk(state.tree, false);
  return out;
}

function caret() {
  const c = h('span', { class: 'entry__caret', 'aria-hidden': 'true' });
  c.innerHTML = CARET;
  return c;
}

function dateCell(d) {
  return h('td', { class: 'c-date', text: d ? dayFmt.format(d) : '', title: d ? dateFmt.format(d) : null });
}

const CARET = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function renderList() {
  const nodes = visibleNodes();
  const shown = nodes.slice(0, MAX_ROWS);
  state.rows = shown;
  state.rowByKey = new Map();
  const frag = document.createDocumentFragment();
  const filtering = Boolean(filterInput.value.trim());
  for (const node of shown) {
    const tr = h('tr', { class: `entry ${node.dir ? 'entry--dir' : 'entry--file'}`, tabindex: '-1', 'data-key': node.key, 'aria-level': String(node.depth + 1) });
    state.rowByKey.set(node.key, tr);
    tr._node = node;
    const e = node.entry;
    const selectable = node.dir ? node.files > 0 : canExtract(e);
    const check = h('input', { type: 'checkbox', class: 'entry__check', tabindex: '-1', 'aria-label': `Select ${node.name}`, disabled: !selectable });
    const icon = h('span', { class: 'entry__icon' });
    icon.innerHTML = iconFor(node);
    const open = h('button', { type: 'button', class: 'entry__open', tabindex: '-1', title: node.dir ? node.path : e.rawName },
      node.dir ? caret() : null, icon, h('span', { class: 'entry__label', text: node.name }));
    if (node.dir) open.setAttribute('aria-expanded', String(filtering || state.expanded.has(node.key)));
    const name = h('div', { class: 'entry__name', style: `--depth:${Math.min(node.depth, 10)}` }, open);
    if (!node.dir && e.encrypted) name.append(h('span', { class: 'tag tag--lock', text: 'Password protected' }));
    else if (!node.dir && !canExtract(e)) name.append(h('span', { class: 'tag tag--warn', text: e.size > MAX_ENTRY ? 'Too large' : 'Unsupported compression' }));
    if (node.dir && !node.files) name.append(h('span', { class: 'tag', text: 'Empty folder' }));
    const sub = h('div', { class: 'entry__sub', text: node.dir ? plural(node.files, 'file') : e.mtime ? dayFmt.format(e.mtime) : '' });
    const act = h('td', { class: 'c-act' });
    if (!node.dir) {
      act.append(h('button', { type: 'button', class: 'btn btn--small entry__save', tabindex: '-1', 'aria-label': `Save ${node.name}`, title: blockReason(e) || `Save ${node.name}`, disabled: !canExtract(e), text: 'Save' }));
    }
    tr.append(
      h('td', { class: 'c-check' }, check),
      h('td', { class: 'c-name' }, name, sub),
      h('td', { class: 'c-size', text: formatBytes(node.dir ? node.size : e.size) }),
      h('td', { class: 'c-packed', text: formatBytes(node.dir ? node.csize : e.csize) }),
      dateCell(node.dir ? node.entry && node.entry.mtime : e.mtime),
      act,
    );
    frag.append(tr);
  }
  if (!shown.length) {
    frag.append(h('tr', { class: 'entries__empty' }, h('td', { colspan: '6', text: filtering ? `No file names contain "${filterInput.value.trim()}".` : 'This archive is empty.' })));
  }
  tbody.replaceChildren(frag);
  listNote.hidden = nodes.length <= MAX_ROWS;
  listNote.textContent = `Showing the first ${MAX_ROWS.toLocaleString()} of ${nodes.length.toLocaleString()} rows. Use the filter to find a file.`;
  if (!state.rowByKey.has(state.focusKey)) state.focusKey = shown.length ? shown[0].key : null;
  const fr = state.rowByKey.get(state.focusKey);
  if (fr) fr.tabIndex = 0;
  const pr = state.rowByKey.get(state.previewKey);
  if (pr) pr.classList.add('is-previewed');
  syncChecks();
}

function selectableUnder(node) {
  return node.dir ? [...filesUnder(node)].filter(canExtract) : canExtract(node.entry) ? [node.entry] : [];
}

function syncChecks() {
  for (const tr of tbody.rows) {
    const node = tr._node;
    if (!node) continue;
    const box = tr.querySelector('.entry__check');
    const list = selectableUnder(node);
    const n = list.filter((e) => state.selected.has(e)).length;
    box.checked = list.length > 0 && n === list.length;
    box.indeterminate = n > 0 && n < list.length;
    tr.classList.toggle('is-selected', box.checked);
  }
  const all = visibleSelectable();
  const n = all.filter((e) => state.selected.has(e)).length;
  selectAll.checked = all.length > 0 && n === all.length;
  selectAll.indeterminate = n > 0 && n < all.length;
  selectAll.disabled = !all.length;
  updateActions();
}

function visibleSelectable() {
  if (!filterInput.value.trim()) return state.entries.filter(canExtract);
  const set = new Set();
  for (const node of visibleNodes()) for (const e of selectableUnder(node)) set.add(e);
  return [...set];
}

function updateActions() {
  const sel = [...state.selected];
  const total = state.entries.filter(canExtract).length;
  const bytes = sel.reduce((s, e) => s + e.size, 0);
  selInfo.textContent = sel.length ? `${sel.length.toLocaleString()} of ${plural(total, 'file')} selected · ${formatBytes(bytes)}` : `No files selected · ${plural(total, 'file')} can be saved`;
  btnSelected.textContent = sel.length ? `Save ${plural(sel.length, 'selected file')}` : 'Save selected';
  btnSelected.disabled = state.busy || !sel.length;
  btnZip.disabled = state.busy || !sel.length;
  btnAll.disabled = state.busy || !total;
  btnAll.textContent = total > 1 ? `Save all ${total.toLocaleString()} as separate files` : 'Save all as separate files';
}

function toggleSelect(node, force) {
  const list = selectableUnder(node);
  if (!list.length) return;
  const on = force ?? !list.every((e) => state.selected.has(e));
  for (const e of list) on ? state.selected.add(e) : state.selected.delete(e);
  syncChecks();
}

function setExpanded(node, open) {
  if (!node || !node.dir) return;
  if (open) state.expanded.add(node.key);
  else state.expanded.delete(node.key);
  state.focusKey = node.key;
  renderList();
  focusRow(node.key);
}

function focusRow(key) {
  const tr = state.rowByKey.get(key);
  if (!tr) return;
  const prev = state.rowByKey.get(state.focusKey);
  if (prev) prev.tabIndex = -1;
  state.focusKey = key;
  tr.tabIndex = 0;
  tr.focus({ preventScroll: false });
}

tbody.addEventListener('click', (ev) => {
  const tr = ev.target.closest('tr.entry');
  if (!tr) return;
  const node = tr._node;
  if (ev.target.closest('.entry__check')) { focusRow(node.key); return; }
  if (ev.target.closest('.entry__save')) {
    focusRow(node.key);
    saveOne(node.entry);
    return;
  }
  if (ev.target.closest('.entry__open')) {
    if (node.dir && !filterInput.value.trim()) setExpanded(node, !state.expanded.has(node.key));
    else showPreview(node, true);
    focusRow(node.key);
    return;
  }
  focusRow(node.key);
});

tbody.addEventListener('change', (ev) => {
  const box = ev.target.closest('.entry__check');
  const tr = box && box.closest('tr.entry');
  if (tr) toggleSelect(tr._node, box.checked);
});

tbody.addEventListener('keydown', (ev) => {
  const tr = ev.target.closest('tr.entry');
  if (!tr) return;
  if ((ev.key === ' ' || ev.key === 'Enter') && ev.target !== tr) return;
  const node = tr._node;
  const i = state.rows.indexOf(node);
  const filtering = Boolean(filterInput.value.trim());
  const move = (j) => { const n = state.rows[Math.max(0, Math.min(state.rows.length - 1, j))]; if (n) focusRow(n.key); };
  switch (ev.key) {
    case 'ArrowDown': move(i + 1); break;
    case 'ArrowUp': move(i - 1); break;
    case 'Home': move(0); break;
    case 'End': move(state.rows.length - 1); break;
    case 'PageDown': move(i + 10); break;
    case 'PageUp': move(i - 10); break;
    case 'ArrowRight':
      if (node.dir && !filtering && !state.expanded.has(node.key)) setExpanded(node, true);
      else if (node.dir) move(i + 1);
      break;
    case 'ArrowLeft':
      if (node.dir && !filtering && state.expanded.has(node.key)) setExpanded(node, false);
      else if (node.parent && node.parent.key) focusRow(node.parent.key);
      break;
    case ' ':
      toggleSelect(node);
      break;
    case 'Enter':
      if (node.dir && !filtering) setExpanded(node, !state.expanded.has(node.key));
      else showPreview(node, false);
      break;
    default: return;
  }
  ev.preventDefault();
});

filterInput.addEventListener('input', () => renderList());
filterInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'ArrowDown' && state.rows.length) { ev.preventDefault(); focusRow(state.rows[0].key); }
});
selectAll.addEventListener('change', () => {
  const list = visibleSelectable();
  const on = selectAll.checked;
  for (const e of list) on ? state.selected.add(e) : state.selected.delete(e);
  syncChecks();
});
$('expand-all').addEventListener('click', () => {
  const walk = (n) => { for (const c of n.sorted) if (c.dir) { state.expanded.add(c.key); walk(c); } };
  walk(state.tree);
  renderList();
});
$('collapse-all').addEventListener('click', () => { state.expanded.clear(); renderList(); });

// ---------------------------------------------------------------- preview

function clearPreviewUrl() {
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = null;
}

function looksBinary(bytes) {
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) return false;
  let bad = 0;
  for (const b of bytes) {
    if (b === 0) return true;
    if (b < 9 || (b > 13 && b < 32 && b !== 27)) bad++;
  }
  return bad > bytes.length * 0.02;
}

function decodeText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  return new TextDecoder('utf-8').decode(bytes, { stream: true }); // stream: drops a cut-off final character
}

async function showPreview(node, fromClick) {
  const token = ++previewToken;
  clearPreviewUrl();
  for (const tr of tbody.querySelectorAll('.is-previewed')) tr.classList.remove('is-previewed');
  state.previewKey = node.key;
  const row = state.rowByKey.get(node.key);
  if (row) row.classList.add('is-previewed');
  previewTitle.textContent = node.name;
  const body = [];
  if (node.dir) {
    body.push(h('p', { class: 'preview-panel__meta', text: `Folder · ${plural(node.files, 'file')} · ${formatBytes(node.size)}` }));
    if (!node.files) body.push(h('p', { text: 'This folder is empty in the archive.' }));
    previewBody.replaceChildren(...body);
    return;
  }
  const e = node.entry;
  const meta = [formatBytes(e.size), `${formatBytes(e.csize)} compressed`, e.mtime ? dateFmt.format(e.mtime) : ''].filter(Boolean).join(' · ');
  body.push(h('p', { class: 'preview-panel__meta', text: meta }));
  if (e.savePath !== e.displayName) body.push(h('p', { class: 'preview-panel__path', text: e.savePath }));
  const reason = blockReason(e);
  const content = h('div', { class: 'preview-panel__content' });
  body.push(content);
  if (!reason) {
    const save = h('button', { type: 'button', class: 'btn btn--primary btn--block', id: 'preview-save', text: `Save ${e.displayName}` });
    save.addEventListener('click', () => saveOne(e));
    body.push(save);
  }
  previewBody.replaceChildren(...body);
  if (fromClick && window.matchMedia('(max-width: 899px)').matches) previewPanel.scrollIntoView({ block: 'nearest' });

  if (reason) {
    content.append(h('div', { class: `alert alert--${e.encrypted ? 'lock' : 'warn'}`, text: reason }));
    return;
  }
  const ext = extOf(e.displayName);
  try {
    if (isZipName(e.displayName)) {
      content.append(h('p', { text: 'This is a ZIP inside the ZIP. Open it to browse its files.' }));
      const btn = h('button', { type: 'button', class: 'btn', id: 'open-nested', text: `Open ${e.displayName}` });
      btn.addEventListener('click', () => openNested(e));
      content.append(btn);
    } else if (IMAGE_EXT.has(ext) && e.size <= IMAGE_PREVIEW_CAP) {
      content.append(h('div', { class: 'preview-panel__loading' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), ' Decompressing…'));
      const bytes = await extract(e, (f) => setProgress(f, 'Decompressing for preview'));
      setProgress(null);
      if (token !== previewToken) return;
      state.previewUrl = URL.createObjectURL(new Blob([bytes], { type: mimeOf(e.displayName) }));
      const img = h('img', { src: state.previewUrl, alt: `Preview of ${e.displayName}`, class: 'preview-panel__img' });
      img.addEventListener('error', () => content.replaceChildren(h('p', { text: 'This image could not be displayed by your browser, but you can still save it.' })), { once: true });
      content.replaceChildren(h('div', { class: 'preview' }, img));
    } else if (IMAGE_EXT.has(ext)) {
      content.append(h('p', { text: `This image is ${formatBytes(e.size)}, too large to preview safely. Save it to view it.` }));
    } else {
      const bytes = await extractHead(e, TEXT_PREVIEW_BYTES);
      if (token !== previewToken) return;
      if (!e.size) {
        content.append(h('p', { text: 'This file is empty.' }));
      } else if (!TEXT_EXT.has(ext) && looksBinary(bytes)) {
        content.append(h('p', { text: 'This file is not text or a picture, so there is no preview. Save it to open it with the right app.' }));
      } else {
        content.append(h('pre', { class: 'code preview-panel__text', tabindex: '0', 'aria-label': `First lines of ${e.displayName}`, text: decodeText(bytes) }));
        if (e.size > bytes.length) content.append(h('p', { class: 'preview-panel__meta', text: `Showing the first ${formatBytes(bytes.length)} of ${formatBytes(e.size)}.` }));
      }
    }
  } catch (err) {
    setProgress(null);
    if (token !== previewToken) return;
    content.replaceChildren();
    showError(err);
  }
}

function resetPreview() {
  previewToken++;
  clearPreviewUrl();
  state.previewKey = null;
  previewTitle.textContent = 'Preview';
  previewBody.replaceChildren(h('p', { class: 'preview-panel__empty', text: 'Click a file name, or move to it and press Enter, to see its first lines or the picture inside.' }));
}

// ---------------------------------------------------------------- saving

function setBusy(on) {
  state.busy = on;
  updateActions();
}

async function saveOne(e) {
  if (state.busy) return;
  setBusy(true);
  try {
    const bytes = await extract(e, (f) => setProgress(f, `Decompressing ${e.displayName}`));
    downloadBlob(new Blob([bytes], { type: mimeOf(e.displayName) }), e.displayName);
    toast(`Saved ${e.displayName}`);
  } catch (err) {
    showError(err);
  } finally {
    setProgress(null);
    setBusy(false);
  }
}

// Several files: one download per file, staggered so browsers accept them; basenames are numbered when they clash.
async function saveMany(list) {
  if (state.busy || !list.length) return;
  setBusy(true);
  const used = new Set();
  let saved = 0;
  const failed = [];
  if (list.length > 10) toast('Your browser may ask to allow multiple downloads. Choose Allow.', 4000);
  try {
    for (const [i, e] of list.entries()) {
      setProgress(i / list.length, `Saving ${i + 1} of ${list.length}: ${e.displayName}`);
      try {
        const bytes = await extract(e, (f) => setProgress((i + f) / list.length, `Saving ${i + 1} of ${list.length}: ${e.displayName}`));
        let name = e.displayName;
        for (let n = 2; used.has(name.toLowerCase()); n++) name = numbered(e.displayName, n);
        used.add(name.toLowerCase());
        downloadBlob(new Blob([bytes], { type: mimeOf(name) }), name);
        saved++;
        if (i < list.length - 1) await sleep(STAGGER_MS);
      } catch (err) {
        failed.push(e.displayName);
        showError(err);
      }
    }
    toast(failed.length ? `Saved ${saved} of ${list.length} files` : `Saved ${plural(saved, 'file')}`);
  } finally {
    setProgress(null);
    setBusy(false);
  }
}

async function repack(list) {
  if (state.busy || !list.length) return;
  setBusy(true);
  try {
    const files = {};
    let done = 0;
    for (const e of list) {
      setProgress((done / list.length) * 0.8, `Decompressing ${done + 1} of ${list.length}`);
      const bytes = await extract(e);
      files[e.savePath] = [bytes, { level: STORE_EXT.has(extOf(e.displayName)) ? 0 : 6, mtime: e.mtime || new Date() }];
      done++;
    }
    setProgress(0.85, 'Building the new ZIP');
    const res = await runWorker({ type: 'zip', files }, Object.values(files).map(([b]) => b.buffer).filter((b, i, a) => a.indexOf(b) === i));
    const base = state.file.name.replace(/\.zip$/i, '');
    const name = `${base}-${list.length === state.entries.filter(canExtract).length ? 'copy' : 'selected'}.zip`;
    downloadBlob(new Blob([res.data], { type: 'application/zip' }), name);
    toast(`Saved ${name} with ${plural(list.length, 'file')}`);
  } catch (err) {
    showError(err);
  } finally {
    setProgress(null);
    setBusy(false);
  }
}

const selectedInOrder = () => state.entries.filter((e) => state.selected.has(e));
btnSelected.addEventListener('click', () => saveMany(selectedInOrder()));
btnZip.addEventListener('click', () => repack(selectedInOrder()));
btnAll.addEventListener('click', () => saveMany(state.entries.filter(canExtract)));

// ---------------------------------------------------------------- opening

async function openNested(e) {
  try {
    const bytes = await extract(e, (f) => setProgress(f, `Decompressing ${e.displayName}`));
    setProgress(null);
    const child = new File([bytes], e.displayName, { type: 'application/zip' });
    await openArchive(child, { stack: [...state.stack, state.file] });
  } catch (err) {
    setProgress(null);
    showError(err);
  }
}

async function openArchive(file, { stack = [], notes = [] } = {}) {
  const token = ++loadToken;
  results.replaceChildren();
  const loading = h('div', { class: 'alert' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), ` Reading the file list of "${file.name}"…`);
  results.append(loading);
  let parsed;
  try {
    parsed = await parseArchive(file);
  } catch (err) {
    if (token !== loadToken) return;
    loading.remove();
    explorer.hidden = true;
    state.file = null;
    showError(err);
    for (const n of notes) addAlert('error', n.title, n.text);
    return;
  }
  if (token !== loadToken) return;
  loading.remove();
  localCache.clear();
  Object.assign(state, {
    file, stack, entries: parsed.entries, tree: buildTree(parsed.entries), expanded: new Set(), selected: new Set(), focusKey: null,
  });
  // Small archives open fully expanded; big ones show only the top level.
  if (state.entries.length <= 200) {
    const walk = (n) => { for (const c of n.sorted) if (c.dir) { state.expanded.add(c.key); walk(c); } };
    walk(state.tree);
  }
  filterInput.value = '';
  resetPreview();
  const card = renderSummary();
  renderWarnings();
  for (const n of notes) addAlert('error', n.title, n.text);
  renderList();
  explorer.hidden = false;
  zone.classList.add('dropzone--compact');
  $('dropzone-title').innerHTML = 'Drop another ZIP here or <span class="link">choose a different ZIP</span>';
  card.scrollIntoView({ block: 'nearest' });
  toast(`Opened ${file.name}: ${plural(state.tree.files, 'file')}, nothing uploaded`);
}

const looksLikeZip = (f) => /\.zip$/i.test(f.name) || /zip/i.test(f.type);

async function handleFiles(files) {
  if (!files.length) return;
  const pick = files.find(looksLikeZip) || files[0];
  const notes = [];
  for (const f of files) {
    if (f === pick) continue;
    if (looksLikeZip(f)) notes.push({ title: 'One ZIP at a time', text: `"${f.name}" was not opened. Drop it on its own after you are done with "${pick.name}".` });
    else notes.push({ title: 'Not a ZIP file', text: `"${f.name}" was skipped because it is not a ZIP archive.` });
  }
  await openArchive(pick, { notes });
}

wireDropzone(zone, input, handleFiles);

// Called by the factory's screenshot script: opens the bundled demo archive and previews its readme.
window.__demo = async () => {
  const res = await fetch('./tests/fixtures/holiday-photos-notes.zip');
  const blob = await res.blob();
  await openArchive(new File([blob], 'holiday-photos-notes.zip', { type: 'application/zip' }));
  const receipts = [...state.tree.children.values()].find((n) => n.dir && n.name === 'Receipts');
  if (receipts) toggleSelect(receipts, true);
  const readme = state.rows.find((n) => n.name === 'readme.txt');
  if (readme) await showPreview(readme, false);
};

export { handleFiles, parseArchive, sanitizePath, decodeName, pct };
