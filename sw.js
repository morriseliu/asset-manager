// 全能资产管家 service worker: app shell cache-first, price/rate APIs network-only.
const PREFIX = 'asset-manager-';
const CACHE = PREFIX + 'v18'; // v18：记一笔识别截图；账本月支出日历
const CHART_JS = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js';
const SHELL = [
  './',
  './index.html',
  './quick.html',
  './sync.js',
  './quick.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL);
    try { await cache.add(new Request(CHART_JS, { mode: 'cors' })); } catch (e) { /* CDN offline at install; retried on next fetch */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith(PREFIX) && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Same-origin app shell: network-first for pages (so updates show up), cache fallback offline.
  if (url.origin === self.location.origin) {
    if (req.mode === 'navigate') {
      // 每个页面各自缓存（记一笔页 quick.html 不能覆盖主页面的缓存）
      const page = /\/quick\.html$/.test(url.pathname) ? './quick.html' : './index.html';
      event.respondWith((async () => {
        try {
          const res = await fetch(req);
          if (res.ok) (await caches.open(CACHE)).put(page, res.clone());
          return res;
        } catch (e) {
          return (await caches.match(page)) || (await caches.match('./index.html')) || (await caches.match('./'));
        }
      })());
      return;
    }
    event.respondWith(caches.match(req).then(hit => hit || fetch(req)));
    return;
  }

  // 识别引擎和中文字库：用过一次就缓存，之后可离线识别。
  if ((url.hostname === 'cdn.jsdelivr.net' && /\/tesseract\.js/.test(url.pathname)) || url.hostname === 'tessdata.projectnaptha.com') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    })());
    return;
  }

  // Pinned chart.js CDN file: cache-first.
  if (req.url === CHART_JS) {
    event.respondWith((async () => {
      const hit = await caches.match(CHART_JS);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') (await caches.open(CACHE)).put(CHART_JS, res.clone());
      return res;
    })());
    return;
  }

  // Everything else (stock/fund/crypto price APIs, exchange rates): not intercepted -> straight to network, never cached.
});
