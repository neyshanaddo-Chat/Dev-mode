// ============ Dev mode ============
// Opens any site folder on your PC, shows it in a private preview, and lets you change anything:
// click things on the page and edit them, or edit the code itself. Everything saves straight
// into the files in that folder. Nothing is uploaded anywhere.
(() => {
'use strict';
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const SCOPE = new URL('./', location.href).pathname;
const TEST = new URLSearchParams(location.search).get('test') === 'opfs';
const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', '.cache', '__pycache__', '.vs', '.idea']);
const TEXT_EXT = /\.(html?|css|js|mjs|cjs|json|webmanifest|md|txt|svg|xml|ts|tsx|jsx|vue|svelte|php|py|yml|yaml|toml|ini|csv|gitignore|gitattributes|nojekyll|env|sh|bat|cmd|ps1|map|htaccess)$/i;
const IMG_EXT = /\.(png|jpe?g|gif|webp|avif|ico|bmp)$/i;
const TYPES = { html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2',
  ttf: 'font/ttf', otf: 'font/otf', mp3: 'audio/mpeg', mp4: 'video/mp4', webm: 'video/webm', wav: 'audio/wav',
  txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', xml: 'application/xml', pdf: 'application/pdf', wasm: 'application/wasm' };
const ext = (p) => (p.match(/\.([^./]+)$/) || [, ''])[1].toLowerCase();
const isText = (p) => TEXT_EXT.test(p) || !/\.[^./]+$/.test(p.split('/').pop());

// ---------- small UI helpers ----------
function toast(msg, bad) {
  const d = document.createElement('div');
  d.textContent = msg; if (bad) d.className = 'bad';
  $('#toast').appendChild(d);
  setTimeout(() => d.remove(), bad ? 5000 : 2600);
}
function modal(text, { input = null, ok = 'OK', danger = false, cancel = 'Cancel' } = {}) {
  return new Promise((res) => {
    $('#modalText').textContent = text;
    const inp = $('#modalInput');
    inp.hidden = input === null; inp.value = input ?? '';
    const yes = $('#modalYes'), no = $('#modalNo');
    yes.textContent = ok; no.textContent = cancel;
    yes.className = 'btn ' + (danger ? 'danger' : 'primary');
    $('#modal').hidden = false;
    (input !== null ? inp : yes).focus();
    if (input !== null) inp.select();
    const done = (v) => { $('#modal').hidden = true; yes.onclick = no.onclick = inp.onkeydown = null; document.removeEventListener('keydown', key, true); res(v); };
    const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(null); } else if (e.key === 'Enter' && !$('#modal').hidden) { e.preventDefault(); yes.click(); } };
    document.addEventListener('keydown', key, true);
    yes.onclick = () => done(input !== null ? inp.value : true);
    no.onclick = () => done(input !== null ? null : false);
  });
}
const store = {
  get(k, d) { try { const v = localStorage.getItem('dm-' + k); return v === null ? d : JSON.parse(v); } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem('dm-' + k, JSON.stringify(v)); } catch (_) {} }
};

// ---------- saved sites (folder handles live in IndexedDB) ----------
const idb = (() => {
  let dbp;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('devmode', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('sites', { keyPath: 'id' });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => { const db = await open(); return new Promise((res, rej) => {
    const t = db.transaction('sites', mode); const s = t.objectStore('sites'); const out = fn(s);
    t.oncomplete = () => res(out && out.result !== undefined ? out.result : out); t.onerror = () => rej(t.error);
  }); };
  return {
    all: () => tx('readonly', (s) => s.getAll()),
    put: (v) => tx('readwrite', (s) => s.put(v)),
    del: (id) => tx('readwrite', (s) => s.delete(id))
  };
})();

// ---------- state ----------
let site = null;            // { id, name, handle }
let files = new Map();      // 'path/to/file' -> FileSystemFileHandle
let dirs = new Map();       // 'path/to' -> FileSystemDirectoryHandle ('' = root)
let lower = new Map();      // lower-case path -> real path
const known = new Map();    // path -> lastModified we know about
let served = new Set();     // files the current preview page loaded
let tabs = [];              // { path, handle, text, disk, lm, scroll, sel, kind }
let active = null;
const undo = [];            // { path, before, after|null (deleted), label }
let picked = null;          // info about the selected element from the preview
let pending = {};           // style changes shown live but not saved yet
let inspecting = false;
let curPage = 'index.html';
let lastScroll = 0;

// ---------- service worker: the preview is served from your folder ----------
async function startSW() {
  if (!('serviceWorker' in navigator)) { toast('This browser can’t run Dev mode previews.', true); return; }
  await navigator.serviceWorker.register('sw.js');
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {   // first run: let the worker take over this page
    await new Promise((r) => { navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }); setTimeout(r, 1500); });
  }
}
navigator.serviceWorker?.startMessages?.();
navigator.serviceWorker?.addEventListener('message', async (e) => {
  const m = e.data, port = e.ports[0];
  if (!m || m.dm !== 'read' || !port) return;
  if (!site || site.id !== m.key) { port.postMessage({ status: 'no-site' }); return; }
  try { port.postMessage(await readForPreview(m.path, m.dest)); }
  catch (err) { console.error(err); port.postMessage({ status: 404 }); }
});

async function findFile(path) {
  if (files.has(path)) return path;
  const lp = lower.get(path.toLowerCase());
  if (lp) return lp;
  // maybe it was just made (by Claude or another program): look it up directly
  try {
    const parts = path.split('/').filter(Boolean);
    let d = site.handle;
    for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p);
    const h = await d.getFileHandle(parts[parts.length - 1]);
    addFile(path, h);
    scheduleTree();
    return path;
  } catch (_) { return null; }
}

async function readForPreview(raw, dest) {
  let path = raw.replace(/^\/+/, '');
  const nav = dest === 'document' || dest === 'iframe' || dest === 'frame';
  if (path === '' || path.endsWith('/')) path += 'index.html';
  let real = await findFile(path);
  if (!real && !/\.[^./]+$/.test(path)) {
    if (await findFile(path + '/index.html')) return { status: 'redirect', to: path + '/' };
    real = await findFile(path + '.html');
  }
  if (!real) return { status: 404 };
  if (nav) served = new Set();
  served.add(real);
  const file = await files.get(real).getFile();
  if (!known.has(real)) known.set(real, file.lastModified);
  const type = TYPES[ext(real)] || 'application/octet-stream';
  if (nav && /\.html?$/i.test(real)) {
    curPage = real;
    const src = await file.text();
    return { status: 200, type, body: injectDevmode(annotate(src)) };
  }
  return { status: 200, type, body: await file.arrayBuffer() };
}

// ---------- HTML code tools ----------
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title']);

// Reads the start tag at src[i] === '<'. Returns its name, where it ends and its attributes.
function startTag(src, i) {
  const m = /^<([a-zA-Z][^\s/>]*)/.exec(src.slice(i, i + 80));
  if (!m) return null;
  const name = m[1].toLowerCase();
  let j = i + m[0].length;
  const attrs = [];
  while (j < src.length) {
    while (/\s/.test(src[j])) j++;
    if (src[j] === '>') return { name, attrs, close: j, end: j + 1, self: false };
    if (src[j] === '/' && src[j + 1] === '>') return { name, attrs, close: j, end: j + 2, self: true };
    if (j >= src.length) break;
    const a0 = j;
    while (j < src.length && !/[\s=>]/.test(src[j]) && !(src[j] === '/' && src[j + 1] === '>')) j++;
    if (j === a0) { j++; continue; }
    const an = src.slice(a0, j);
    let k = j; while (/\s/.test(src[k])) k++;
    let value = null, vEnd = j;
    if (src[k] === '=') {
      k++; while (/\s/.test(src[k])) k++;
      const q = src[k];
      if (q === '"' || q === "'") { const e = src.indexOf(q, k + 1); vEnd = e < 0 ? src.length : e + 1; value = src.slice(k + 1, vEnd - 1); }
      else { let e = k; while (e < src.length && !/[\s>]/.test(src[e])) e++; vEnd = e; value = src.slice(k, e); }
      j = vEnd;
    }
    attrs.push({ name: an.toLowerCase(), raw: an, value, start: a0, end: j });
  }
  return null;
}

// Gives every tag in the page a data-dm="position" so a click can be traced back to the code.
function annotate(src) {
  let out = '', last = 0, i = 0;
  while ((i = src.indexOf('<', i)) !== -1) {
    if (src.startsWith('<!--', i)) { const e = src.indexOf('-->', i + 4); i = e < 0 ? src.length : e + 3; continue; }
    if (src[i + 1] === '/' || src[i + 1] === '!' || src[i + 1] === '?') { const e = src.indexOf('>', i); i = e < 0 ? src.length : e + 1; continue; }
    const t = startTag(src, i);
    if (!t) { i++; continue; }
    out += src.slice(last, t.close) + (/\s/.test(src[t.close - 1]) ? '' : ' ') + `data-dm="${i}"`;
    last = t.close;
    i = t.end;
    if (RAW.has(t.name)) {
      const re = new RegExp('</' + t.name + '\\s*>', 'ig'); re.lastIndex = i;
      const m = re.exec(src); i = m ? m.index : src.length;
    }
  }
  return out + src.slice(last);
}

function injectDevmode(html) {
  const head = `<script data-dm-ui>(function(){try{var s=navigator.serviceWorker;if(s){s.register=function(){return new Promise(function(){})}}}catch(e){}})();</script>`;
  const tail = `<script data-dm-ui src="${SCOPE}__devmode/inspect.js"></script>`;
  let h = /<head\b[^>]*>/i.exec(html);
  html = h ? html.slice(0, h.index + h[0].length) + head + html.slice(h.index + h[0].length) : head + html;
  const b = html.toLowerCase().lastIndexOf('</body>');
  return b >= 0 ? html.slice(0, b) + tail + html.slice(b) : html + tail;
}

// Where an element starts and ends in the code.
function elementRange(src, at) {
  const t = startTag(src, at);
  if (!t) return null;
  if (t.self || VOID.has(t.name)) return { tag: t, innerStart: t.end, innerEnd: t.end, end: t.end };
  if (RAW.has(t.name)) {
    const re = new RegExp('</' + t.name + '\\s*>', 'ig'); re.lastIndex = t.end;
    const m = re.exec(src); if (!m) return null;
    return { tag: t, innerStart: t.end, innerEnd: m.index, end: m.index + m[0].length };
  }
  let depth = 1, i = t.end;
  while ((i = src.indexOf('<', i)) !== -1) {
    if (src.startsWith('<!--', i)) { const e = src.indexOf('-->', i + 4); i = e < 0 ? src.length : e + 3; continue; }
    if (src[i + 1] === '/') {
      const m = /^<\/([a-zA-Z][^\s>]*)\s*>/.exec(src.slice(i, i + 80));
      if (m && m[1].toLowerCase() === t.name && --depth === 0) return { tag: t, innerStart: t.end, innerEnd: i, end: i + m[0].length };
      i++; continue;
    }
    const s = startTag(src, i);
    if (!s) { i++; continue; }
    if (s.name === t.name && !s.self) depth++;
    i = s.end;
    if (RAW.has(s.name) && s.name !== t.name) { const re = new RegExp('</' + s.name + '\\s*>', 'ig'); re.lastIndex = i; const m = re.exec(src); i = m ? m.index + m[0].length : src.length; }
  }
  return null;
}
function dedent(t) {
  const lines = t.replace(/^\s*\n/, '').replace(/\s+$/, '').split('\n');
  const min = Math.min(...lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)[0].length));
  return lines.map((l) => l.slice(Number.isFinite(min) ? min : 0)).join('\n');
}
const lineOf = (src, pos) => src.slice(0, pos).split('\n').length;
const attrEsc = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const textEsc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function setAttr(src, at, name, value) {
  const t = startTag(src, at); if (!t) return null;
  const a = t.attrs.find((x) => x.name === name);
  if (a) {
    if (value === null) { let s = a.start; while (s > 0 && /[ \t]/.test(src[s - 1])) s--; return src.slice(0, s) + src.slice(a.end); }
    return src.slice(0, a.start) + `${a.raw}="${attrEsc(value)}"` + src.slice(a.end);
  }
  if (value === null) return src;
  let c = t.close; while (c > at && /\s/.test(src[c - 1])) c--;
  return src.slice(0, c) + ` ${name}="${attrEsc(value)}"` + src.slice(c);
}
function parseStyle(s) {
  const out = {};
  (s || '').split(';').forEach((d) => { const k = d.indexOf(':'); if (k > 0) out[d.slice(0, k).trim().toLowerCase()] = d.slice(k + 1).trim(); });
  return out;
}
const styleText = (o) => Object.entries(o).filter(([, v]) => v !== '' && v != null).map(([k, v]) => `${k}: ${v}`).join('; ');
const kebab = (k) => k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

// ---------- file list ----------
function addFile(path, h) { files.set(path, h); lower.set(path.toLowerCase(), path); }
async function scan() {
  const f = new Map(), d = new Map([['', site.handle]]), lo = new Map();
  let count = 0;
  async function walk(dir, prefix) {
    for await (const [name, h] of dir.entries()) {
      if (++count > 8000) return;
      const p = prefix + name;
      if (h.kind === 'directory') { if (SKIP_DIRS.has(name)) continue; d.set(p, h); await walk(h, p + '/'); }
      else { f.set(p, h); lo.set(p.toLowerCase(), p); }
    }
  }
  await walk(site.handle, '');
  const same = f.size === files.size && d.size === dirs.size && [...f.keys()].every((k) => files.has(k));
  files = f; dirs = d; lower = lo;
  if (!same) renderTree();
}
let treeTimer = null;
const scheduleTree = () => { clearTimeout(treeTimer); treeTimer = setTimeout(renderTree, 200); };
const open = new Set(store.get('open-dirs', []));
function fileIcon(p) {
  const e = ext(p);
  return { html: '🌐', htm: '🌐', css: '🎨', js: '⚙️', mjs: '⚙️', json: '🧾', webmanifest: '🧾', md: '📝', txt: '📝', svg: '🖼', png: '🖼', jpg: '🖼', jpeg: '🖼', gif: '🖼', webp: '🖼', ico: '🖼' }[e] || '📄';
}
function renderTree() {
  const box = $('#tree');
  const q = $('#fileFilter').value.trim().toLowerCase();
  const dirty = new Set(tabs.filter((t) => t.text !== t.disk).map((t) => t.path));
  const row = (p, depth, isDir) => {
    const nm = p.split('/').pop();
    const cls = 'tr' + (!isDir && active && active.path === p ? ' active' : '');
    const ico = isDir ? (open.has(p) ? '📂' : '📁') : fileIcon(p);
    return `<div class="${cls}" data-${isDir ? 'dir' : 'file'}="${esc(p)}" style="padding-left:${8 + depth * 14}px">
      <span>${ico}</span><span class="nm">${esc(q ? p : nm)}</span>${dirty.has(p) ? '<span class="dirty">●</span>' : ''}
      ${isDir ? '' : `<button class="icon del" data-del="${esc(p)}" title="Delete this file">🗑</button>`}</div>`;
  };
  if (q) {
    const hits = [...files.keys()].filter((p) => p.toLowerCase().includes(q)).sort().slice(0, 300);
    box.innerHTML = hits.map((p) => row(p, 0, false)).join('') || '<p class="muted small" style="padding:8px 12px">No files match.</p>';
    return;
  }
  const kids = new Map();
  const put = (parent, item) => { if (!kids.has(parent)) kids.set(parent, []); kids.get(parent).push(item); };
  for (const p of dirs.keys()) if (p) put(p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '', { p, dir: true });
  for (const p of files.keys()) put(p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '', { p, dir: false });
  let html = '';
  const draw = (parent, depth) => {
    const list = (kids.get(parent) || []).sort((a, b) => (b.dir - a.dir) || a.p.localeCompare(b.p, undefined, { sensitivity: 'base' }));
    for (const it of list) { html += row(it.p, depth, it.dir); if (it.dir && open.has(it.p)) draw(it.p, depth + 1); }
  };
  draw('', 0);
  box.innerHTML = html;
}
$('#tree').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del]');
  if (del) { e.stopPropagation(); deleteFile(del.dataset.del); return; }
  const d = e.target.closest('[data-dir]');
  if (d) { const p = d.dataset.dir; open.has(p) ? open.delete(p) : open.add(p); store.set('open-dirs', [...open]); renderTree(); return; }
  const f = e.target.closest('[data-file]');
  if (f) {
    const p = f.dataset.file;
    await openTab(p);
    if (/\.html?$/i.test(p)) go(p);
  }
});
$('#fileFilter').addEventListener('input', renderTree);
$('#rescanBtn').onclick = async () => { await scan(); toast('File list refreshed'); };

async function newFile() {
  const p = await modal('New file name (you can include a folder, e.g. pages/about.html):', { input: 'new-page.html', ok: 'Create' });
  if (!p) return;
  const path = p.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!path || path.endsWith('/')) return;
  if (files.has(path)) { toast('That file already exists'); openTab(path); return; }
  try {
    const parts = path.split('/');
    let d = site.handle, sofar = '';
    for (const part of parts.slice(0, -1)) { d = await d.getDirectoryHandle(part, { create: true }); sofar += (sofar ? '/' : '') + part; dirs.set(sofar, d); open.add(sofar); }
    const h = await d.getFileHandle(parts[parts.length - 1], { create: true });
    addFile(path, h);
    const start = /\.html?$/i.test(path) ? `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>New page</title>\n</head>\n<body>\n  <h1>New page</h1>\n</body>\n</html>\n` : '';
    await writeFile(path, start, '');
    undo.push({ path, before: null, after: start, label: 'Create ' + path }); updateUndo();
    renderTree();
    await openTab(path);
    if (/\.html?$/i.test(path)) go(path);
    toast('Created ' + path);
  } catch (err) { toast('Couldn’t create the file: ' + err.message, true); }
}
$('#newFileBtn').onclick = newFile;

async function deleteFile(path) {
  if (!(await modal(`Delete “${path}”?\nYou can bring it back with ↶ Undo.`, { ok: 'Delete', danger: true, cancel: 'Keep' }))) return;
  try {
    const before = await (await files.get(path).getFile()).text().catch(() => '');
    const dir = path.includes('/') ? dirs.get(path.slice(0, path.lastIndexOf('/'))) : site.handle;
    await dir.removeEntry(path.split('/').pop());
    files.delete(path); lower.delete(path.toLowerCase()); known.delete(path);
    undo.push({ path, before, after: null, label: 'Delete ' + path }); updateUndo();
    const t = tabs.find((x) => x.path === path); if (t) closeTab(t, true);
    renderTree(); reload();
    toast('Deleted ' + path);
  } catch (err) { toast('Couldn’t delete: ' + err.message, true); }
}

// ---------- writing files (with Undo) ----------
async function writeFile(path, text, before, label) {
  let h = files.get(path);
  if (!h) { const real = await findFile(path); h = real && files.get(real); }
  if (!h) throw new Error('file not found');
  if (h.queryPermission && (await h.queryPermission({ mode: 'readwrite' })) !== 'granted') {
    if ((await h.requestPermission({ mode: 'readwrite' })) !== 'granted') throw new Error('Dev mode wasn’t allowed to save in this folder');
  }
  const w = await h.createWritable();
  await w.write(text); await w.close();
  const lm = (await h.getFile()).lastModified;
  known.set(path, lm);
  if (label !== undefined && before !== text) { undo.push({ path, before, after: text, label }); updateUndo(); }
  const t = tabs.find((x) => x.path === path);
  if (t) { const wasClean = t.text === t.disk; t.disk = text; t.lm = lm; if (wasClean || t.text === text) { t.text = text; if (t === active) showTab(t, true); } }
  renderTabs();
  return lm;
}
function updateUndo() {
  const u = undo[undo.length - 1];
  $('#undoBtn').disabled = !u;
  $('#undoBtn').title = u ? 'Undo: ' + u.label : 'Nothing to undo';
}
async function doUndo() {
  const u = undo.pop(); updateUndo();
  if (!u) return;
  try {
    if (u.before === null) {                      // it was created: remove it
      const dir = u.path.includes('/') ? dirs.get(u.path.slice(0, u.path.lastIndexOf('/'))) : site.handle;
      await dir.removeEntry(u.path.split('/').pop());
      files.delete(u.path); lower.delete(u.path.toLowerCase());
      const t = tabs.find((x) => x.path === u.path); if (t) closeTab(t, true);
    } else {
      if (!files.has(u.path)) {                   // it was deleted: make it again
        const parts = u.path.split('/'); let d = site.handle;
        for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
        addFile(u.path, await d.getFileHandle(parts[parts.length - 1], { create: true }));
      }
      const t = tabs.find((x) => x.path === u.path);
      if (t) t.text = u.before;
      await writeFile(u.path, u.before);
      if (t) { t.text = t.disk = u.before; if (t === active) showTab(t, true); }
    }
    renderTree(); reload(true);
    toast('↶ Undone: ' + u.label);
  } catch (err) { toast('Couldn’t undo: ' + err.message, true); }
}
$('#undoBtn').onclick = doUndo;

// ---------- code editor ----------
const ta = $('#code'), hl = $('#hl'), gutter = $('#gutter');
function langOf(p) { const e = ext(p); return /^html?$|^svg$|^xml$/.test(e) ? 'html' : e === 'css' ? 'css' : /^(m?js|cjs|jsx|ts|tsx|json|webmanifest)$/.test(e) ? 'js' : 'text'; }
function paint(text, re, cls) {
  let out = '', last = 0;
  for (const m of text.matchAll(re)) {
    out += esc(text.slice(last, m.index));
    const g = m.slice(1).findIndex((x) => x !== undefined);
    out += g >= 0 && cls[g] ? `<span class="${cls[g]}">${esc(m[0])}</span>` : esc(m[0]);
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}
const JS_RE = /(\/\*[\s\S]*?\*\/|\/\/[^\n]*)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|try|catch|finally|throw|class|extends|import|export|from|default|async|await|of|in|typeof|instanceof|this|null|undefined|true|false|void|delete|yield)\b|\b(\d+(?:\.\d+)?)\b/g;
const CSS_RE = /(\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|([^{};\n/][^{};]*?)(?=\s*\{)|([\w-]+)(?=\s*:)|(#[0-9a-fA-F]{3,8}\b|-?\d*\.?\d+(?:px|rem|em|%|vh|vw|s|ms|deg|fr)?\b)/g;
const hlJs = (t) => paint(t, JS_RE, ['k-c', 'k-s', 'k-k', 'k-n']);
const hlCss = (t) => paint(t, CSS_RE, ['k-c', 'k-s', 'k-sel', 'k-p', 'k-n']);
function hlTag(tag) {
  const m = /^(<\/?)([\w:-]+)([\s\S]*?)(\/?>)$/.exec(tag);
  if (!m) return esc(tag);
  const attrs = m[3].replace(/[^]/g, (c) => c);
  let a = '', last = 0;
  for (const x of attrs.matchAll(/([^\s=]+)(\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)?/g)) {
    a += esc(attrs.slice(last, x.index)) + `<span class="k-a">${esc(x[1])}</span>` + esc(x[2] || '') + (x[3] ? `<span class="k-s">${esc(x[3])}</span>` : '');
    last = x.index + x[0].length;
  }
  a += esc(attrs.slice(last));
  return esc(m[1]) + `<span class="k-t">${esc(m[2])}</span>` + a + esc(m[4]);
}
function hlHtml(t) {
  let out = '', last = 0;
  const re = /(<!--[\s\S]*?-->)|(<script\b[^>]*>)([\s\S]*?)(<\/script\s*>)|(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)|(<\/?[a-zA-Z][^>]*>)/gi;
  for (const m of t.matchAll(re)) {
    out += esc(t.slice(last, m.index));
    if (m[1]) out += `<span class="k-c">${esc(m[1])}</span>`;
    else if (m[2]) out += hlTag(m[2]) + hlJs(m[3]) + hlTag(m[4]);
    else if (m[5]) out += hlTag(m[5]) + hlCss(m[6]) + hlTag(m[7]);
    else out += hlTag(m[8]);
    last = m.index + m[0].length;
  }
  return out + esc(t.slice(last));
}
let paintQueued = false, marks = null;
function repaint() {
  if (paintQueued) return; paintQueued = true;
  requestAnimationFrame(() => {
    paintQueued = false;
    if (!active || active.kind !== 'text') return;
    const t = ta.value, lang = langOf(active.path);
    let html = t.length > 600000 ? esc(t) : lang === 'html' ? hlHtml(t) : lang === 'css' ? hlCss(t) : lang === 'js' ? hlJs(t) : esc(t);
    hl.innerHTML = html + '\n\n';
    const n = t.split('\n').length;
    if (gutter.dataset.n !== String(n)) { gutter.dataset.n = n; let g = ''; for (let i = 1; i <= n; i++) g += i + '\n'; gutter.textContent = g + '\n'; }
    syncScroll();
  });
}
function syncScroll() { hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft; gutter.scrollTop = ta.scrollTop; }
ta.addEventListener('scroll', syncScroll);
ta.addEventListener('input', () => { if (!active) return; active.text = ta.value; repaint(); dirtyUI(); });
function dirtyUI() {
  const d = active && active.text !== active.disk;
  $('#saveBtn').disabled = !d; $('#revertBtn').hidden = !d;
  renderTabs(); scheduleTree(); pos();
}
function pos() {
  if (!active || active.kind !== 'text') { $('#stPos').textContent = ''; return; }
  const before = ta.value.slice(0, ta.selectionStart);
  const ln = before.split('\n').length, col = before.length - before.lastIndexOf('\n');
  $('#stPos').textContent = `${active.path} · line ${ln}, col ${col}`;
}
ta.addEventListener('keyup', pos); ta.addEventListener('click', pos);
ta.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && !e.ctrlKey) {
    e.preventDefault();
    const s = ta.selectionStart, en = ta.selectionEnd, v = ta.value;
    if (s !== en && v.slice(s, en).includes('\n')) {           // indent / un-indent several lines
      const ls = v.lastIndexOf('\n', s - 1) + 1;
      const block = v.slice(ls, en);
      const nb = e.shiftKey ? block.replace(/^ {1,2}/gm, '') : block.replace(/^/gm, '  ');
      ta.setSelectionRange(ls, en); document.execCommand('insertText', false, nb);
      ta.setSelectionRange(ls, ls + nb.length);
    } else if (!e.shiftKey) document.execCommand('insertText', false, '  ');
  } else if (e.key === 'Enter' && !e.ctrlKey && !e.shiftKey) {     // keep the indent
    const v = ta.value, s = ta.selectionStart;
    const ind = /^[ \t]*/.exec(v.slice(v.lastIndexOf('\n', s - 1) + 1))[0];
    if (ind) { e.preventDefault(); document.execCommand('insertText', false, '\n' + ind); }
  }
});

async function openTab(path, { quiet } = {}) {
  let t = tabs.find((x) => x.path === path);
  if (!t) {
    const real = await findFile(path);
    if (!real) { toast('Can’t find ' + path, true); return null; }
    path = real;
    t = tabs.find((x) => x.path === path);
  }
  if (!t) {
    const h = files.get(path), f = await h.getFile();
    const kind = IMG_EXT.test(path) ? 'image' : (isText(path) && f.size < 5e6 ? 'text' : 'binary');
    const text = kind === 'text' ? await f.text() : '';
    t = { path, handle: h, text, disk: text, lm: f.lastModified, scroll: 0, sel: [0, 0], kind };
    known.set(path, f.lastModified);
    tabs.push(t);
  }
  showTab(t);
  if (!quiet) sidePane('code');
  return t;
}
let imgUrl = null;
async function showTab(t, keepPos) {
  if (active && active !== t && active.kind === 'text') { active.scroll = ta.scrollTop; active.sel = [ta.selectionStart, ta.selectionEnd]; }
  active = t;
  $('#edEmpty').hidden = !!t;
  $('#imgView').hidden = !(t && t.kind === 'image');
  const textMode = t && t.kind === 'text';
  ta.hidden = hl.hidden = !textMode; gutter.style.visibility = textMode ? '' : 'hidden';
  if (t && t.kind === 'image') { if (imgUrl) URL.revokeObjectURL(imgUrl); imgUrl = URL.createObjectURL(await t.handle.getFile()); $('#imgView').src = imgUrl; }
  if (t && t.kind === 'binary') { $('#edEmpty').hidden = false; $('#edEmpty').textContent = 'This file can’t be edited as text.'; }
  else $('#edEmpty').innerHTML = '<div>Pick a file on the left, or select something on the page and press <b>&lt;/&gt; Code</b>.</div>';
  if (textMode) {
    const s = ta.scrollTop, a = ta.selectionStart, b = ta.selectionEnd;
    if (ta.value !== t.text) ta.value = t.text;
    gutter.dataset.n = '';
    if (keepPos) { ta.scrollTop = s; ta.setSelectionRange(Math.min(a, ta.value.length), Math.min(b, ta.value.length)); }
    else { ta.scrollTop = t.scroll; ta.setSelectionRange(t.sel[0], t.sel[1]); }
    repaint();
  }
  checkConflict();
  dirtyUI();
  renderTree();
  store.set('tabs-' + site.id, { open: tabs.map((x) => x.path), active: t && t.path });
}
function renderTabs() {
  $('#fileTabs').innerHTML = tabs.map((t, i) => `<div class="ft${t === active ? ' on' : ''}" data-i="${i}" title="${esc(t.path)}">
    ${fileIcon(t.path)} ${esc(t.path.split('/').pop())}${t.text !== t.disk ? '<span class="dot">●</span>' : ''}
    <span class="x icon" data-x="${i}">✕</span></div>`).join('');
}
$('#fileTabs').addEventListener('click', (e) => {
  const x = e.target.closest('[data-x]');
  if (x) { closeTab(tabs[+x.dataset.x]); return; }
  const f = e.target.closest('[data-i]'); if (f) showTab(tabs[+f.dataset.i]);
});
async function closeTab(t, force) {
  if (!force && t.text !== t.disk && !(await modal(`“${t.path}” has changes you haven't saved. Close it anyway?`, { ok: 'Close without saving', danger: true }))) return;
  const i = tabs.indexOf(t); tabs.splice(i, 1);
  if (active === t) { active = null; if (tabs.length) showTab(tabs[Math.min(i, tabs.length - 1)]); else { showTab(null); } }
  renderTabs();
}
async function saveActive() {
  if (!active || active.kind !== 'text' || active.text === active.disk) return;
  const t = active;
  try {
    await writeFile(t.path, t.text, t.disk, 'Code change in ' + t.path);
    t.conflict = false; checkConflict();
    dirtyUI(); renderTree();
    toast('💾 Saved ' + t.path);
    reload(true);
  } catch (err) { toast('Couldn’t save: ' + err.message, true); }
}
$('#saveBtn').onclick = saveActive;
$('#revertBtn').onclick = async () => {
  if (!active) return;
  if (!(await modal('Throw away your unsaved changes in ' + active.path + '?', { ok: 'Discard', danger: true }))) return;
  active.text = active.disk; showTab(active, true);
};
function revealRange(a, b) {
  ta.focus();
  ta.setSelectionRange(a, b);
  const line = ta.value.slice(0, a).split('\n').length;
  ta.scrollTop = Math.max(0, (line - 1) * 20 - ta.clientHeight / 3);
  syncScroll(); pos();
}

// find & replace
let findHits = [], findI = -1;
function doFind(keep) {
  const q = $('#findIn').value;
  findHits = [];
  if (q && active && active.kind === 'text') {
    const v = ta.value.toLowerCase(), ql = q.toLowerCase();
    for (let i = v.indexOf(ql); i >= 0 && findHits.length < 5000; i = v.indexOf(ql, i + ql.length)) findHits.push(i);
  }
  if (!keep) findI = findHits.findIndex((i) => i >= ta.selectionStart);
  if (findI < 0) findI = findHits.length ? 0 : -1;
  $('#findCount').textContent = q ? (findHits.length ? `${findI + 1} of ${findHits.length}` : 'none') : '';
}
function findStep(d) {
  doFind(true);
  if (!findHits.length) return;
  findI = (findI + d + findHits.length) % findHits.length;
  const q = $('#findIn').value;
  revealRange(findHits[findI], findHits[findI] + q.length);
  $('#findCount').textContent = `${findI + 1} of ${findHits.length}`;
  $('#findIn').focus();
}
function openFind() {
  $('#findBar').hidden = false; sidePane('code');
  const s = ta.value.slice(ta.selectionStart, ta.selectionEnd);
  if (s && !s.includes('\n')) $('#findIn').value = s;
  $('#findIn').focus(); $('#findIn').select(); doFind();
}
$('#findIn').addEventListener('input', () => { doFind(); if (findHits.length) { const q = $('#findIn').value; revealRange(findHits[findI], findHits[findI] + q.length); $('#findIn').focus(); } });
$('#findIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); } if (e.key === 'Escape') $('#findClose').click(); });
$('#findNext').onclick = () => findStep(1);
$('#findPrev').onclick = () => findStep(-1);
$('#findClose').onclick = () => { $('#findBar').hidden = true; ta.focus(); };
$('#replOne').onclick = () => {
  const q = $('#findIn').value; if (!q) return;
  if (ta.value.slice(ta.selectionStart, ta.selectionEnd).toLowerCase() !== q.toLowerCase()) { findStep(1); return; }
  ta.focus(); document.execCommand('insertText', false, $('#replIn').value);
  findStep(1);
};
$('#replAll').onclick = () => {
  const q = $('#findIn').value; if (!q || !active) return;
  doFind(); const n = findHits.length; if (!n) return;
  const r = $('#replIn').value;
  let v = ta.value, out = '', last = 0;
  for (const i of findHits) { out += v.slice(last, i) + r; last = i + q.length; }
  out += v.slice(last);
  ta.focus(); ta.setSelectionRange(0, v.length); document.execCommand('insertText', false, out);
  toast(`Replaced ${n}`); doFind();
};

// search in every file
let grepTimer = null;
$('#grepInput').addEventListener('input', () => { clearTimeout(grepTimer); grepTimer = setTimeout(grep, 250); });
const grepCache = new Map();
async function grep() {
  const q = $('#grepInput').value.trim(), box = $('#grepResults');
  if (q.length < 2) { box.hidden = true; return; }
  const ql = q.toLowerCase(), out = [];
  for (const [p, h] of files) {
    if (!isText(p) || out.length > 200) continue;
    let text;
    const tab = tabs.find((t) => t.path === p);
    if (tab) text = tab.text;
    else {
      const f = await h.getFile(); if (f.size > 2e6) continue;
      const c = grepCache.get(p);
      if (c && c.lm === f.lastModified) text = c.text; else { text = await f.text(); grepCache.set(p, { lm: f.lastModified, text }); }
    }
    const lo = text.toLowerCase();
    for (let i = lo.indexOf(ql); i >= 0 && out.length <= 200; i = lo.indexOf(ql, i + ql.length)) {
      const ls = text.lastIndexOf('\n', i) + 1, le = text.indexOf('\n', i);
      const line = text.slice(ls, le < 0 ? undefined : le);
      const cut = Math.max(0, i - ls - 30);
      out.push({ p, i, ln: lineOf(text, i), snip: (cut ? '…' : '') + line.slice(cut, cut + 90).trim() });
    }
  }
  box.hidden = false;
  box.innerHTML = out.length ? out.map((r) => `<div class="gr" data-p="${esc(r.p)}" data-i="${r.i}"><span class="p">${esc(r.p)}:${r.ln}</span><br><code>${esc(r.snip)}</code></div>`).join('')
    : '<p class="muted small" style="padding:4px 12px">Not found.</p>';
  box.dataset.q = q;
}
$('#grepResults').addEventListener('click', async (e) => {
  const r = e.target.closest('.gr'); if (!r) return;
  const t = await openTab(r.dataset.p); if (!t) return;
  const i = +r.dataset.i; revealRange(i, i + $('#grepResults').dataset.q.length);
});

// files changed on disk while open
function checkConflict() {
  const b = $('#conflict');
  if (!active || !active.conflict) { b.hidden = true; return; }
  b.hidden = false;
  b.innerHTML = `⚠️ ${esc(active.path)} was changed outside Dev mode while you had unsaved edits.
    <button class="btn small" id="cfTheirs">Load the new version</button><button class="btn small" id="cfMine">Keep mine</button>`;
  $('#cfTheirs').onclick = async () => { const f = await active.handle.getFile(); active.text = active.disk = await f.text(); active.lm = f.lastModified; active.conflict = false; showTab(active, true); };
  $('#cfMine').onclick = () => { active.conflict = false; checkConflict(); };
}

// ---------- preview ----------
const frame = $('#frame');
const previewBase = () => `${SCOPE}preview/${site.id}/`;
function go(path) {
  path = (path || 'index.html').replace(/^\/+/, '');
  frame.src = previewBase() + path.split('#')[0].split('/').map(encodeURIComponent).join('/') + (path.includes('#') ? '#' + path.split('#')[1] : '');
}
function reload(keepScroll) {
  if (!site) return;
  try {
    lastScroll = keepScroll ? frame.contentWindow.scrollY : 0;
    frame.contentWindow.location.reload();
  } catch (_) { go(curPage); }
}
frame.addEventListener('load', () => {
  if (inspecting) post({ type: 'inspect', on: true });
  if (lastScroll) { post({ type: 'scroll', y: lastScroll }); lastScroll = 0; }
  if (picked && picked.at != null && picked.page && frameRel(frame.contentWindow.location.href).split('#')[0] === picked.page.split('#')[0]) {
    post({ type: 'select-at', at: picked.at });
  }
});
function frameRel(href) {
  try { const u = new URL(href); const b = previewBase(); return decodeURIComponent(u.pathname.startsWith(b) ? u.pathname.slice(b.length) : u.pathname) + u.hash; } catch (_) { return ''; }
}
const post = (m) => { try { frame.contentWindow.postMessage(Object.assign({ dm: 1 }, m), location.origin); } catch (_) {} };
$('#addrForm').addEventListener('submit', (e) => { e.preventDefault(); go($('#addr').value.trim()); });
$('#reloadBtn').onclick = () => reload(true);
$('#popBtn').onclick = () => window.open(frame.src, '_blank');
$('#devices').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  $$('#devices button').forEach((x) => x.classList.toggle('on', x === b));
  const w = b.dataset.w;
  $('#frameWrap').style.width = w ? w + 'px' : '100%';
  $('#frameWrap').classList.toggle('dev', !!w);
  store.set('device', w);
});
function setInspect(on) {
  inspecting = on;
  $('#inspectBtn').classList.toggle('on', on);
  $('#inspectHint').hidden = !on;
  post({ type: 'inspect', on });
}
$('#inspectBtn').onclick = () => setInspect(!inspecting);
$('#elemInspect').onclick = () => setInspect(true);

addEventListener('message', (e) => {
  if (e.source !== frame.contentWindow || !e.data || !e.data.dm) return;
  const m = e.data;
  if (m.type === 'loc') { $('#addr').value = frameRel(m.href); }
  else if (m.type === 'pick') { m.info.page = frameRel(location.origin + m.info.page); picked = m.info; if (!m.quiet) { pending = {}; sidePane('elem'); } renderElem(); }
  else if (m.type === 'key') {
    if (m.key === 'inspect') setInspect(!inspecting);
    else if (m.key === 'inspect-off') setInspect(false);
    else if (m.key === 'save') saveActive();
    else if (m.key === 'undo') doUndo();
  }
  else if (m.type === 'text-done') saveText(m);
});

// ---------- the selected element ----------
const toHex = (c) => {
  const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/.exec(c || '');
  if (!m || m[4] === '0') return null;
  return '#' + [m[1], m[2], m[3]].map((x) => (+x | 0).toString(16).padStart(2, '0')).join('');
};
function renderElem() {
  const p = picked;
  $('#elemEmpty').hidden = !!p; $('#elem').hidden = !p;
  if (!p) return;
  const s = p.styles, inl = parseStyle(p.inline);
  const val = (k) => k in pending ? pending[k] : s[k];
  const can = p.exact && p.at != null && /\.html?$/i.test(curPage);
  const color = toHex(val('color')) || '#000000', bg = toHex(val('backgroundColor'));
  const fs = parseFloat(val('fontSize')) || 16;
  const bold = (+val('fontWeight') || (val('fontWeight') === 'bold' ? 700 : 400)) >= 600;
  const italic = val('fontStyle') === 'italic';
  const align = val('textAlign');
  const hidden = val('display') === 'none';
  const has = Object.keys(pending).length;
  $('#elem').innerHTML = `
    <div class="el-head"><div class="grow"><div class="el-name">${esc(p.name)}</div>
      <div class="el-where" id="elWhere">${p.at != null ? `${esc(curPage)} · line …` : 'made by a script'}</div></div></div>
    ${p.text ? `<div class="el-text">“${esc(p.text)}”</div>` : ''}
    ${!can ? `<div class="note">${p.at == null ? 'This part is made by a script, so it isn’t written in the HTML. Use <b>&lt;/&gt; Code</b> on the nearest part, or add a 📝 request for Claude.'
      : 'This part is made by a script inside the nearest part shown in the code. You can see that part’s code, or add a 📝 request for Claude.'}</div>` : ''}
    <div class="el-tools">
      <button class="btn small" id="elCode" ${p.at == null ? 'disabled' : ''}>&lt;/&gt; Code</button>
      <button class="btn small" id="elParent">↑ Parent</button>
      ${can && p.canText ? '<button class="btn small" id="elEditOn" title="Type straight onto the page; Enter saves, Esc cancels">✏️ Edit on page</button>' : ''}
      ${can ? '<button class="btn small" id="elDup">⧉ Duplicate</button><button class="btn small" id="elDel">🗑 Delete</button>' : ''}
    </div>
    ${can && p.canText && p.leaf ? `<div class="box"><h4>Text</h4><textarea id="elText" rows="2">${esc(p.text)}</textarea>
      <div class="row"><span class="muted small">Enter saves · Shift+Enter new line</span><span class="grow"></span><button class="btn small primary" id="elTextSave">Save text</button></div></div>` : ''}
    ${can && p.canText && !p.leaf ? `<div class="box"><h4>What's inside (code)</h4><textarea id="elInner" rows="4" spellcheck="false" style="font:12px/1.5 var(--mono)">…</textarea>
      <div class="row"><span class="muted small">Ctrl+Enter saves</span><span class="grow"></span><button class="btn small primary" id="elInnerSave">Save</button></div></div>` : ''}
    ${can ? `<div class="box"><h4>Look</h4><div class="grid">
      <label>Text colour</label><input type="color" data-st="color" value="${color}">
      <label>Background</label><div class="row" style="margin:0"><input type="color" data-st="backgroundColor" value="${bg || '#ffffff'}">${bg ? '' : '<span class="muted small">none</span>'}</div>
      <label>Text size (px)</label><input type="number" min="6" max="200" step="1" data-st="fontSize" data-unit="px" value="${Math.round(fs)}">
      <label>Style</label><div class="mini-seg"><button data-tog="fontWeight" data-on="700" data-off="400" class="${bold ? 'on' : ''}"><b>B</b></button><button data-tog="fontStyle" data-on="italic" data-off="normal" class="${italic ? 'on' : ''}"><i>I</i></button><button data-tog="display" data-on="none" data-off="" class="${hidden ? 'on' : ''}" title="Hide it">🙈 Hide</button></div>
      <label>Line up</label><div class="mini-seg">${['left', 'center', 'right'].map((a) => `<button data-set="textAlign" data-v="${a}" class="${align === a || (a === 'left' && align === 'start') ? 'on' : ''}">${{ left: '⯇ Left', center: '≡ Centre', right: 'Right ⯈' }[a]}</button>`).join('')}</div>
      <label>Space inside</label><input type="text" data-st="padding" value="${esc(val('padding'))}" placeholder="e.g. 12px">
      <label>Space around</label><input type="text" data-st="margin" value="${esc(val('margin'))}" placeholder="e.g. 0 auto">
      <label>Round corners</label><input type="number" min="0" max="999" data-st="borderRadius" data-unit="px" value="${parseFloat(val('borderRadius')) || 0}">
      <label>Width</label><input type="text" data-st="width" value="${esc(inl.width || '')}" placeholder="${esc(s.width)}">
      <label>Height</label><input type="text" data-st="height" value="${esc(inl.height || '')}" placeholder="${esc(s.height)}">
      </div>
      <div class="row"><span class="muted small">${has ? `● ${has} change${has > 1 ? 's' : ''} not saved yet` : 'Changes show on the page straight away.'}</span><span class="grow"></span>
        <button class="btn small ghost" id="elStyleReset" ${has ? '' : 'disabled'}>Reset</button>
        <button class="btn small primary" id="elStyleSave" ${has ? '' : 'disabled'}>💾 Save look</button></div></div>` : ''}
    ${can ? `<div class="box"><h4>Details (attributes)</h4>
      ${p.attrs.filter((a) => a.name !== 'style').map((a) => `<div class="attr-row"><span class="an" title="${esc(a.name)}">${esc(a.name)}</span><input data-attr="${esc(a.name)}" value="${esc(a.value)}"><button class="icon" data-rmattr="${esc(a.name)}" title="Remove">✕</button></div>`).join('') || '<p class="muted small">None yet.</p>'}
      <div class="row"><button class="btn small" id="elAddAttr">＋ Add</button><span class="muted small">e.g. href for a link, src / alt for a picture</span></div></div>` : ''}
    ${p.rules.length ? `<div class="box"><h4>Styles from CSS (click to edit)</h4>${p.rules.map((r, i) => `<div class="rule" data-rule="${i}"><span class="rf">${esc(r.href ? frameRel(r.href) || r.href.split('/').pop() : 'in this page')}</span><span class="rs">${esc(r.selector)}</span><span class="rc">${esc(r.css)}</span></div>`).join('')}</div>` : ''}
    <div class="box"><h4>📝 Ask Claude</h4><textarea id="elReq" rows="2" placeholder="Describe a change for Claude to make…"></textarea>
      <div class="row"><span class="grow"></span><button class="btn small primary" id="elReqAdd">Add request</button></div></div>`;
  if (p.at != null) srcFor(curPage).then((src) => {
    const w = $('#elWhere'); if (w && src != null) w.textContent = `${curPage} · line ${lineOf(src, p.at)}`;
    const box = $('#elInner'), r = src != null && elementRange(src, p.at);
    if (box) { if (r) { box.value = dedent(src.slice(r.innerStart, r.innerEnd)); box.dataset.orig = box.value; } else box.closest('.box').remove(); }
  });
  wireElem(can);
}
async function srcFor(path) {
  const t = tabs.find((x) => x.path === path);
  if (t) return t.disk;
  const h = files.get(path); return h ? (await h.getFile()).text() : null;
}
function wireElem(can) {
  const p = picked;
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  on('elWhere', () => showCode());
  on('elCode', () => showCode());
  on('elParent', () => post({ type: 'parent' }));
  on('elEditOn', () => post({ type: 'edit-text' }));
  on('elDel', () => removeEl());
  on('elDup', () => duplicateEl());
  on('elTextSave', () => { const v = $('#elText').value; saveText({ plain: true, text: v, fromBox: true }); });
  on('elInnerSave', () => {
    const v = $('#elInner').value; if (v === $('#elInner').dataset.orig) return;
    editEl('Content', (src, r) => {
      const inner = src.slice(r.innerStart, r.innerEnd);
      const lead = /^\s*/.exec(inner)[0], trail = /\s*$/.exec(inner)[0];
      if (!lead.includes('\n')) return src.slice(0, r.innerStart) + lead + v.trim() + trail + src.slice(r.innerEnd);
      const ind = lead.slice(lead.lastIndexOf('\n') + 1);
      const body = v.trim().split('\n').map((l) => (l ? ind + l : l)).join('\n');
      return src.slice(0, r.innerStart) + '\n' + body + trail + src.slice(r.innerEnd);
    }, { reloadAfter: true }).then((ok) => ok && toast('💾 Saved'));
  });
  const inn = $('#elInner');
  if (inn) inn.onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('#elInnerSave').click(); } };
  const tx = $('#elText');
  if (tx) tx.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#elTextSave').click(); } };
  $$('#elem [data-st]').forEach((inp) => {
    const apply = () => { let v = inp.value; if (inp.dataset.unit && v !== '') v += inp.dataset.unit; pending[inp.dataset.st] = v; post({ type: 'style', prop: inp.dataset.st, value: v }); updatePendingNote(); };
    inp.addEventListener('input', apply);
  });
  $$('#elem [data-tog]').forEach((b) => b.onclick = () => {
    const on = !b.classList.contains('on'); b.classList.toggle('on', on);
    const v = on ? b.dataset.on : b.dataset.off;
    pending[b.dataset.tog] = v; post({ type: 'style', prop: b.dataset.tog, value: v }); updatePendingNote();
  });
  $$('#elem [data-set]').forEach((b) => b.onclick = () => {
    $$(`#elem [data-set="${b.dataset.set}"]`).forEach((x) => x.classList.toggle('on', x === b));
    pending[b.dataset.set] = b.dataset.v; post({ type: 'style', prop: b.dataset.set, value: b.dataset.v }); updatePendingNote();
  });
  on('elStyleReset', () => { post({ type: 'set-style-attr', value: p.inline }); pending = {}; renderElem(); });
  on('elStyleSave', saveStyle);
  $$('#elem [data-attr]').forEach((inp) => {
    inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } };
    inp.onchange = () => editAttr(inp.dataset.attr, inp.value);
  });
  $$('#elem [data-rmattr]').forEach((b) => b.onclick = () => editAttr(b.dataset.rmattr, null));
  on('elAddAttr', async () => {
    const n = await modal('Name of the detail to add (for example href, src, alt, title, class, id):', { input: '', ok: 'Next' });
    if (!n || !/^[a-zA-Z_:][\w:.-]*$/.test(n.trim())) return;
    const v = await modal(`Value for ${n.trim()}:`, { input: '', ok: 'Add' });
    if (v === null) return;
    editAttr(n.trim().toLowerCase(), v);
  });
  $$('#elem [data-rule]').forEach((r) => r.onclick = () => jumpToRule(p.rules[+r.dataset.rule]));
  on('elReqAdd', () => { const v = $('#elReq').value.trim(); if (!v) return; addRequest(v, p); $('#elReq').value = ''; toast('📝 Request added'); });
}
function updatePendingNote() {
  const has = Object.keys(pending).length;
  const r = $('#elStyleSave'); if (!r) return;
  r.disabled = !has; $('#elStyleReset').disabled = !has;
  r.parentElement.querySelector('.muted').textContent = has ? `● ${has} change${has > 1 ? 's' : ''} not saved yet` : 'Changes show on the page straight away.';
}

// Change the HTML file for the selected element. fn(src, range) returns new src.
async function editEl(label, fn, { reloadAfter = false } = {}) {
  const p = picked;
  if (!p || p.at == null) return false;
  const path = curPage;
  const tab = tabs.find((t) => t.path === path);
  if (tab && tab.text !== tab.disk) { toast(`Save or discard your code changes in ${path} first`, true); sidePane('code'); showTab(tab); return false; }
  const src = await srcFor(path);
  const r = elementRange(src, p.at);
  if (!r || r.tag.name !== p.tag) { toast('The page was out of date. It has been reloaded, please try again.', true); reload(true); return false; }
  const out = fn(src, r);
  if (out == null || out === src) return false;
  try {
    await writeFile(path, out, src, label + ' — ' + p.name);
    if (reloadAfter) reload(true);
    else post({ type: 'shift', at: p.at, delta: out.length - src.length });
    return true;
  } catch (err) { toast('Couldn’t save: ' + err.message, true); return false; }
}
async function saveStyle() {
  const ch = { ...pending };
  const ok = await editEl('Look', (src, r) => {
    const a = r.tag.attrs.find((x) => x.name === 'style');
    const st = parseStyle(a ? a.value : '');
    for (const [k, v] of Object.entries(ch)) st[kebab(k)] = v;
    const t = styleText(st);
    return setAttr(src, picked.at, 'style', t || null);
  });
  if (ok) { pending = {}; toast('💾 Look saved'); post({ type: 'refresh-info' }); }
}
async function editAttr(name, value) {
  const ok = await editEl(value === null ? 'Remove ' + name : 'Change ' + name, (src) => setAttr(src, picked.at, name, value));
  if (ok) { post({ type: 'attr', name, value }); toast('💾 Saved'); setTimeout(() => post({ type: 'refresh-info' }), 50); }
}
async function saveText(m) {
  const ok = await editEl('Text', (src, r) => {
    const inner = src.slice(r.innerStart, r.innerEnd);
    let next;
    if (m.plain) {
      // keep the spaces / new lines around the text the way they were
      const lead = /^\s*/.exec(inner)[0], trail = /\s*$/.exec(inner)[0];
      next = (inner.trim() ? lead : '') + textEsc(m.text.trim()).replace(/\n/g, '<br>') + (inner.trim() ? trail : '');
    } else next = m.html;
    return src.slice(0, r.innerStart) + next + src.slice(r.innerEnd);
  }, { reloadAfter: !m.plain || m.fromBox });
  if (ok) toast('💾 Text saved');
  else if (!m.fromBox) reload(true);
}
async function removeEl() {
  if (!(await modal(`Delete ${picked.name} from the page?\nYou can bring it back with ↶ Undo.`, { ok: 'Delete', danger: true, cancel: 'Keep' }))) return;
  const ok = await editEl('Delete', (src, r) => {
    let a = r.tag ? picked.at : 0, b = r.end;
    const ls = src.lastIndexOf('\n', a - 1) + 1, le = src.indexOf('\n', b);
    if (/^\s*$/.test(src.slice(ls, a)) && /^\s*$/.test(src.slice(b, le < 0 ? src.length : le))) { a = ls; b = le < 0 ? src.length : le + 1; }
    return src.slice(0, a) + src.slice(b);
  });
  if (ok) { post({ type: 'remove' }); picked = null; renderElem(); toast('🗑 Deleted'); }
}
async function duplicateEl() {
  let copyAt = null;
  const ok = await editEl('Duplicate', (src, r) => {
    const ls = src.lastIndexOf('\n', picked.at - 1) + 1;
    const indent = /^\s*$/.test(src.slice(ls, picked.at)) ? '\n' + src.slice(ls, picked.at) : '';
    const piece = indent + src.slice(picked.at, r.end);
    copyAt = r.end + indent.length;
    return src.slice(0, r.end) + piece + src.slice(r.end);
  }, { reloadAfter: true });
  if (ok) { picked = { ...picked, at: copyAt }; toast('⧉ Duplicated — the copy is selected'); }
}
async function showCode() {
  const p = picked; if (!p || p.at == null) return;
  const t = await openTab(curPage); if (!t) return;
  if (t.text !== t.disk) toast('This file has unsaved changes, so the line may be a little off');
  const r = elementRange(t.text, p.at);
  revealRange(p.at, r ? r.tag.end : p.at + 1);
}
async function jumpToRule(rule) {
  let path = curPage, from = 0;
  if (rule.href) { path = frameRel(rule.href).split('#')[0]; }
  else if (rule.inlineAt != null) from = +rule.inlineAt;
  const t = await openTab(path); if (!t) return;
  const v = t.text;
  const first = rule.selector.split(',')[0].trim();
  const tries = [rule.selector, first, first.replace(/\s*>\s*/g, ' > '), first.replace(/\s+/g, ' '), first.split(/[\s>+~]/).pop()];
  for (const q of tries) {
    if (!q) continue;
    let i = v.indexOf(q, from);
    if (i < 0) i = v.indexOf(q);
    if (i >= 0) { const e = v.indexOf('}', i); revealRange(i, e > i ? e + 1 : i + q.length); return; }
  }
  toast('Opened ' + path + ' — couldn’t find that exact rule, try 🔍 Find (Ctrl+F)');
}

// ---------- requests for Claude ----------
let reqs = [];
const saveReqs = () => { store.set('reqs-' + site.id, reqs); renderReqs(); };
function addRequest(text, info) {
  reqs.push({ text, page: info ? info.page : $('#addr').value, item: info ? { name: info.name, selector: info.selector, text: info.text, file: curPage, at: info.at } : null, when: Date.now() });
  saveReqs();
}
async function renderReqs() {
  $('#reqCount').hidden = !reqs.length; $('#reqCount').textContent = reqs.length;
  $('#reqFor').textContent = picked ? 'About: ' + picked.name : 'About: the whole page';
  $('#reqList').innerHTML = reqs.length ? reqs.map((r, i) => `<div class="req"><div class="row" style="margin:0"><span class="n">${i + 1}</span>
      <span class="meta grow">${esc(r.page || '')}${r.item ? ' · ' + esc(r.item.name) : ''}</span><button class="icon" data-rdel="${i}" title="Delete">✕</button></div>
      <div class="t">${esc(r.text)}</div></div>`).join('') : '<p class="muted small">No requests yet.</p>';
}
$('#reqList').addEventListener('click', async (e) => {
  const d = e.target.closest('[data-rdel]'); if (!d) return;
  if (await modal(`Delete request ${+d.dataset.rdel + 1}?`, { ok: 'Delete', danger: true, cancel: 'Keep' })) { reqs.splice(+d.dataset.rdel, 1); saveReqs(); }
});
$('#reqAdd').onclick = () => { const v = $('#reqText').value.trim(); if (!v) return; addRequest(v, picked); $('#reqText').value = ''; };
$('#reqText').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#reqAdd').click(); } });
$('#reqClear').onclick = async () => { if (reqs.length && await modal('Clear all requests?', { ok: 'Clear', danger: true })) { reqs = []; saveReqs(); } };
$('#reqCopy').onclick = async () => {
  if (!reqs.length) { toast('No requests to copy'); return; }
  const lines = [`Dev mode requests for my site “${site.name}” (the folder on my laptop). Please make these changes in the private copy:`, ''];
  for (const [i, r] of reqs.entries()) {
    let line = '';
    if (r.item && r.item.at != null) { const src = await srcFor(r.item.file); if (src) line = `, line ${lineOf(src, r.item.at)}`; }
    lines.push(`${i + 1}. Page: ${r.page || '/'}`);
    if (r.item) lines.push(`   Item: ${r.item.name}${r.item.text ? ` “${r.item.text.slice(0, 60)}”` : ''} (${r.item.selector}) — ${r.item.file}${line}`);
    lines.push(`   Change: ${r.text}`, '');
  }
  try { await navigator.clipboard.writeText(lines.join('\n')); toast('📋 Copied ' + reqs.length + ' request(s). Paste into Claude with Ctrl + V'); }
  catch (_) { await modal('Copy this text:', { input: lines.join(' | ') }); }
};

// ---------- side tabs, splitters, keys ----------
function sidePane(name) {
  $$('#sideTabs button').forEach((b) => b.classList.toggle('on', b.dataset.pane === name));
  $$('#side .pane').forEach((p) => p.hidden = p.id !== 'pane-' + name);
  if (name === 'req') renderReqs();
}
$('#sideTabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) sidePane(b.dataset.pane); });
$$('.split').forEach((sp) => {
  const target = sp.dataset.split === 'files' ? $('#files') : $('#side');
  const saved = store.get('w-' + sp.dataset.split, null); if (saved) target.style.width = saved + 'px';
  sp.addEventListener('pointerdown', (e) => {
    e.preventDefault(); sp.classList.add('drag'); sp.setPointerCapture(e.pointerId);
    const x0 = e.clientX, w0 = target.offsetWidth, dir = sp.dataset.split === 'files' ? 1 : -1;
    frame.style.pointerEvents = 'none';
    const move = (ev) => { target.style.width = Math.max(140, Math.min(innerWidth - 300, w0 + dir * (ev.clientX - x0))) + 'px'; };
    const up = () => { sp.classList.remove('drag'); frame.style.pointerEvents = ''; sp.removeEventListener('pointermove', move); store.set('w-' + sp.dataset.split, target.offsetWidth); };
    sp.addEventListener('pointermove', move); sp.addEventListener('pointerup', up, { once: true });
  });
});
document.addEventListener('keydown', (e) => {
  if ($('#work').hidden || !$('#modal').hidden || !$('#screen-home').classList.contains('active')) return;
  const k = e.key.toLowerCase(), c = e.ctrlKey || e.metaKey;
  if (c && e.shiftKey && k === 'd') { e.preventDefault(); setInspect(!inspecting); }
  else if (c && e.shiftKey && k === 'f') { e.preventDefault(); $('#grepInput').focus(); }
  else if (c && k === 's') { e.preventDefault(); saveActive(); }
  else if (c && k === 'f' && active && active.kind === 'text') { e.preventDefault(); openFind(); }
  else if (e.key === 'Escape' && inspecting) setInspect(false);
});
addEventListener('beforeunload', (e) => { if (tabs.some((t) => t.text !== t.disk)) { e.preventDefault(); e.returnValue = ''; } });

// ---------- watch for changes made outside Dev mode (e.g. by Claude) ----------
let polling = false;
setInterval(async () => {
  if (!site || polling || document.hidden) return;
  polling = true;
  try {
    const watch = new Set([...served, ...tabs.map((t) => t.path)]);
    const changed = [];
    for (const p of watch) {
      const h = files.get(p); if (!h) continue;
      let f; try { f = await h.getFile(); } catch (_) { continue; }
      const k = known.get(p);
      if (k === undefined) { known.set(p, f.lastModified); continue; }
      if (f.lastModified === k) continue;
      known.set(p, f.lastModified);
      changed.push(p);
      const t = tabs.find((x) => x.path === p);
      if (t && t.kind === 'text') {
        const text = await f.text();
        if (text === t.disk) continue;
        if (t.text === t.disk) { t.text = t.disk = text; t.lm = f.lastModified; if (t === active) showTab(t, true); }
        else { t.disk = text; t.conflict = true; if (t === active) checkConflict(); }
      }
    }
    if (changed.some((p) => served.has(p))) { reload(true); toast('🔄 Updated: ' + changed.join(', ')); }
  } finally { polling = false; }
}, 1500);
setInterval(() => { if (site && !document.hidden && files.size < 3000) scan().catch(() => {}); }, 8000);

// ---------- home: open a site ----------
async function renderRecent() {
  let list = [];
  try { list = (await idb.all()).sort((a, b) => b.last - a.last); } catch (_) {}
  $('#recentTitle').hidden = !list.length;
  $('#recent').innerHTML = list.map((s) => `<button class="site-card" data-site="${s.id}"><span style="font-size:22px">🌐</span>
    <span class="grow"><div class="nm">${esc(s.name)}</div><div class="muted small">Last opened ${new Date(s.last).toLocaleString()}</div></span>
    <span class="icon" data-forget="${s.id}" title="Remove from this list (the folder isn't touched)">✕</span></button>`).join('');
}
$('#recent').addEventListener('click', async (e) => {
  const f = e.target.closest('[data-forget]');
  if (f) { e.stopPropagation(); await idb.del(f.dataset.forget); renderRecent(); return; }
  const b = e.target.closest('[data-site]'); if (!b) return;
  const s = (await idb.all()).find((x) => x.id === b.dataset.site);
  if (s) openSite(s);
});
$('#openFolder').onclick = async () => {
  try {
    const handle = TEST ? await navigator.storage.getDirectory() : await showDirectoryPicker({ id: 'devmode-site', mode: 'readwrite' });
    const all = await idb.all();
    let s = null;
    for (const x of all) { try { if (await x.handle.isSameEntry(handle)) { s = x; break; } } catch (_) {} }
    if (!s) s = { id: 's' + Math.random().toString(36).slice(2, 9), name: handle.name || 'My site', handle };
    openSite(s, true);
  } catch (err) { if (err.name !== 'AbortError') toast('Couldn’t open that folder: ' + err.message, true); }
};
async function openSite(s, fresh) {
  try {
    if (!fresh && s.handle.queryPermission && (await s.handle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
      if ((await s.handle.requestPermission({ mode: 'readwrite' })) !== 'granted') { toast('Dev mode needs permission to open that folder', true); return; }
    }
    await startSW();
    site = s; s.last = Date.now();
    await idb.put({ id: s.id, name: s.name, handle: s.handle, last: s.last });
    tabs = []; active = null; undo.length = 0; updateUndo(); picked = null; known.clear(); served = new Set();
    reqs = store.get('reqs-' + s.id, []);
    $('#siteName').textContent = s.name; document.title = s.name + ' — Dev mode';
    $('#home').hidden = true; $('#work').hidden = false;
    await scan();
    const first = files.has('index.html') ? 'index.html' : [...files.keys()].find((p) => /\.html?$/i.test(p));
    if (!first) toast('No HTML page found in this folder. Pick the folder that has index.html.', true);
    const st = store.get('tabs-' + s.id, null);
    for (const p of (st && st.open) || []) if (files.has(p)) await openTab(p, { quiet: true });
    if (st && st.active && files.has(st.active)) await openTab(st.active, { quiet: true });
    else if (first && !tabs.length) await openTab(first, { quiet: true });
    else if (!tabs.length) showTab(null);
    renderReqs(); renderElem();
    go(first || 'index.html');
    try { sessionStorage.setItem('dm-last-site', s.id); } catch (_) {}
    layoutMode();
  } catch (err) { console.error(err); toast('Couldn’t open the site: ' + err.message, true); }
}
$('#homeBtn').onclick = async () => {
  if (tabs.some((t) => t.text !== t.disk) && !(await modal('You have unsaved code. Leave this site anyway?', { ok: 'Leave', danger: true }))) return;
  site = null; frame.src = 'about:blank'; setInspect(false);
  $('#work').hidden = true; $('#home').hidden = false; document.title = 'Dev mode';
  try { sessionStorage.removeItem('dm-last-site'); } catch (_) {}
  layoutMode();
  renderRecent();
};

// ---------- start ----------
// When a site is open on the Home screen, the tool fills the window.
function layoutMode() {
  const on = !!site && $('#screen-home').classList.contains('active');
  document.body.classList.toggle('working', on);
  $('#screen-home').classList.toggle('working', !!site);
}
addEventListener('hashchange', layoutMode);
window.__dmBusy = () => tabs.some((t) => t.text !== t.disk);
// After an update reload, open the site you had open (if the browser still allows it).
(async () => {
  let id = null; try { id = sessionStorage.getItem('dm-last-site'); } catch (_) {}
  if (!id) return;
  const s = (await idb.all().catch(() => [])).find((x) => x.id === id);
  if (s && s.handle.queryPermission && (await s.handle.queryPermission({ mode: 'readwrite' })) === 'granted') openSite(s);
})();
if (!window.showDirectoryPicker && !TEST) { $('#unsupported').hidden = false; $('#openFolder').disabled = true; }
const dev = store.get('device', '');
if (dev) $(`#devices button[data-w="${dev}"]`)?.click();
renderRecent();
startSW().catch((e) => console.warn('service worker', e));
window.__dm = { annotate, elementRange, setAttr, startTag, state: () => ({ site, files: [...files.keys()], tabs: tabs.map((t) => t.path), picked, undo: undo.length, curPage }) };
})();
