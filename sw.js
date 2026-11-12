'use strict';
// EARN IT service worker. Caches only the app shell. API responses are never cached, because
// they hold private account data and must not leak to another user of the same browser.
const CACHE_NAME = 'earn-it-shell-v4';
const APP_SHELL = ['/', '/earn-it.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/icon.svg'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;            // never cache or serve API data from cache
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then(response => {
      caches.open(CACHE_NAME).then(cache => cache.put('/earn-it.html', response.clone()));
      return response;
    }).catch(() => caches.match('/earn-it.html')));
    return;
  }
  event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => {
    if (response && response.ok) caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone()));
    return response;
  })));
});
