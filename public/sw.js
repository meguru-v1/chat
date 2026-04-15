const CACHE_NAME = 'smart-archiver-cache-v3.3';
const urlsToCache = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './icons/icon.png'
];

// インストール時にキャッシュ
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        return cache.addAll(urlsToCache);
      })
  );
});

// 古いキャッシュの削除
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.filter(cacheName => cacheName !== CACHE_NAME).map(cacheName => caches.delete(cacheName))
      );
    })
  );
});

// fetch をインターセプト (Network first, fallback to cache)
self.addEventListener('fetch', event => {
  // GAS Proxy や GitHub API の通信はキャッシュせずにネットワークに流す
  if (event.request.url.includes('script.google.com') || 
      event.request.url.includes('api.github.com') || 
      event.request.url.includes('raw.githubusercontent.com') ||
      event.request.url.includes('sessions.json')) {
    return;
  }

  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
