// Lets the app open without signal. Fresh files are used whenever there is a connection.
const CACHE = 'bird-log-v1';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'config.js', 'firebase-bundle.js',
  'manifest.webmanifest', 'icon-192.png', 'icon-512.png',
  'fonts/numbers.woff2', 'fonts/text.woff2', 'fonts/text-bold.woff2'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin) return;
  event.respondWith(
    fetch(event.request).then(response => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE).then(cache => cache.put(event.request, copy));
      }
      return response;
    }).catch(() => caches.match(event.request).then(hit => hit || caches.match('index.html')))
  );
});
