/**
 * Service Worker — cache only deployment-neutral static assets.
 * Never cache HTML, RSC/navigation responses, Next.js chunks, or Server Actions:
 * those resources contain build-specific Server Action references.
 */

const CACHE_NAME = 'qimo-static-v2';

// 安装：预缓存关键资源
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(['/manifest.json', '/icon.svg']);
    })
  );
  self.skipWaiting();
});

// 激活：清理旧缓存
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

// 拦截请求
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.mode === 'navigate' || event.request.destination === 'document') return;
  if (url.pathname.startsWith('/_next/') || url.pathname.startsWith('/api/')) return;
  if (event.request.headers.get('RSC') || event.request.headers.get('Next-Action')) return;
  if (!['image', 'font'].includes(event.request.destination) && !['/manifest.json', '/icon.svg'].includes(url.pathname)) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // 成功拿到网络响应 → 缓存一份
        if (response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, clone);
          });
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || Response.error()))
  );
});
