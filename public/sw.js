const CACHE = 'mdreader-v4';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()),
));

function store(request, res) {
  if (res.ok) {
    const copy = res.clone();
    caches.open(CACHE).then(c => c.put(request, copy));
  }
  return res;
}

const offline = () => new Response(
  '<!doctype html><meta name="viewport" content="width=device-width"><p style="font:16px sans-serif;padding:20px">Offline, and this page was not viewed before.</p>',
  { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
);

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname === '/reindex') return;

  // Large third-party bundles: cache first.
  if (url.pathname.startsWith('/vendor/')) {
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(res => store(e.request, res))));
    return;
  }
  // Pages and app assets: network first, cached copy when offline.
  e.respondWith(fetch(e.request).then(res => store(e.request, res)).catch(() => caches.match(e.request).then(hit => hit || offline())));
});
