// Dev mode service worker
// (Caches here are named devmode-… so this never touches your other sites' caches on the same address.)
// 1. Keeps a copy of the Dev mode app so it opens even when the launcher isn't running.
// 2. Serves the site you opened (preview/<site>/...) straight from the folder on your PC.
//    The files never leave your computer: this worker asks the Dev mode window for each
//    file, and that window reads it from the folder you picked.
const CACHE = 'devmode-v2';
const APP = ['./', 'index.html', 'app.js', 'app.css', 'inspect.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png'];

const SCOPE = new URL(self.registration.scope);
const PREVIEW = SCOPE.pathname + 'preview/';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(APP)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('devmode-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // A preview file
  if (url.pathname.startsWith(PREVIEW)) {
    const rest = url.pathname.slice(PREVIEW.length);
    const slash = rest.indexOf('/');
    const key = slash < 0 ? rest : rest.slice(0, slash);
    const path = slash < 0 ? '' : rest.slice(slash + 1);
    e.respondWith(serveSite(key, decodeURIComponent(path), req, e.clientId || e.resultingClientId));
    return;
  }

  // A site that links with "/something" (from the top of the site) while it's in the preview:
  // send it to the site, not to Dev mode.
  const ref = req.referrer ? new URL(req.referrer) : null;
  if (ref && ref.origin === location.origin && ref.pathname.startsWith(PREVIEW) &&
      !url.pathname.startsWith(SCOPE.pathname + '__devmode/')) {
    const key = ref.pathname.slice(PREVIEW.length).split('/')[0];
    let p = url.pathname.startsWith(SCOPE.pathname) ? url.pathname.slice(SCOPE.pathname.length) : url.pathname.slice(1);
    e.respondWith(Response.redirect(PREVIEW + key + '/' + p + url.search + url.hash, 302));
    return;
  }

  if (req.method !== 'GET') return;
  if (url.pathname.endsWith('/version.json')) return;   // always live (auto-update)
  if (url.pathname === SCOPE.pathname + '__devmode/inspect.js') {
    e.respondWith(appFile(SCOPE.pathname + 'inspect.js'));
    return;
  }
  e.respondWith(appFile(req));
});

// App files: newest when the launcher is running, saved copy otherwise.
function appFile(req) {
  return fetch(req, { cache: 'no-cache' })
    .then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    })
    .catch(() => caches.match(req, { ignoreSearch: true })
      .then((r) => r || caches.match(SCOPE.pathname + 'index.html')));
}

async function appWindows() {
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return all.filter((c) => !new URL(c.url).pathname.startsWith(PREVIEW));
}

function ask(client, msg) {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    const t = setTimeout(() => resolve(null), 15000);
    ch.port1.onmessage = (ev) => { clearTimeout(t); resolve(ev.data); };
    client.postMessage(msg, [ch.port2]);
  });
}

async function serveSite(key, path, req, clientId) {
  const wins = await appWindows();
  if (!wins.length) return page(503, 'Dev mode is closed',
    'Open the Dev mode app and pick this site again, then press reload.');
  const dest = req.destination || (req.mode === 'navigate' ? 'document' : '');
  let reply = null;
  for (const w of wins) {               // the window that has this site open answers
    reply = await ask(w, { dm: 'read', key, path, dest, method: req.method });
    if (reply && reply.status !== 'no-site') break;
  }
  if (!reply || reply.status === 'no-site') return page(404, 'This site is not open',
    'Go back to the Dev mode app and open the site folder again.');
  if (reply.status === 'redirect') return Response.redirect(PREVIEW + key + '/' + reply.to, 302);
  if (reply.status !== 200) return page(404, 'Not found', 'There is no file called “' + esc(path || 'index.html') + '” in this site folder.');
  return new Response(reply.body, {
    status: 200,
    headers: { 'Content-Type': reply.type, 'Cache-Control': 'no-store' }
  });
}

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function page(status, title, text) {
  return new Response(`<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:15px system-ui;display:grid;place-items:center;height:90vh;color:#334;margin:0">
<div style="text-align:center;max-width:420px"><div style="font-size:42px">🛠</div><h2 style="margin:.3em 0">${title}</h2><p>${text}</p></div>`,
  { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
