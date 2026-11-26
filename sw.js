/* 8:30 Desk service worker: works offline with the last briefing, always tries the network first for fresh data. */
const VERSION = 'desk-v3';                 // change this after editing the page so phones pick up the new version
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'data/briefing.json', 'assets/logo.svg', 'assets/banner.svg',
  'assets/band-markets.svg', 'assets/band-trading.svg', 'assets/band-global.svg', 'assets/band-science.svg',
  'assets/band-day.svg', 'assets/icon-192.png', 'assets/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;   // Apps Script, Finnhub, fonts: straight to network
  const fresh = req.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('/briefing.json');
  if (fresh) {                                                         // network first, cached copy when offline
    e.respondWith(fetch(req).then(r => { const c = r.clone(); caches.open(VERSION).then(x => x.put(req, c)); return r; })
      .catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
  } else {                                                             // images, icons: cache first
    e.respondWith(caches.match(req).then(r => r || fetch(req).then(n => { const c = n.clone(); caches.open(VERSION).then(x => x.put(req, c)); return n; })));
  }
});
