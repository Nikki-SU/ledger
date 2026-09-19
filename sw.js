/* ============================================
   账本 Service Worker
   策略：网络优先（network-first），离线时回退缓存
   发版即生效：新 SW 立即接管，无需用户清缓存
   ============================================ */

const CACHE_NAME = 'ledger-cache-v3';

// 全部使用相对路径，自动适配根目录 / 子目录（如 GitHub Pages 的 /ledger/）部署
const PRECACHE_URLS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-192.svg',
];

// 安装：预缓存（容错，单个文件 404 不影响整体）+ 立即接管
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) =>
        // 用 allSettled，任一资源缺失都不会导致整个 SW 安装失败
        Promise.allSettled(PRECACHE_URLS.map((url) => cache.add(url)))
      )
      .then(() => self.skipWaiting())
  );
});

// 激活：清理旧版本缓存 + 立即接管所有页面
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

// 请求：网络优先，失败时回退缓存
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // 只处理同源 GET
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(req)
      .then((resp) => {
        // 顺手更新缓存，保证离线可用
        if (resp && resp.status === 200 && resp.type === 'basic') {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return resp;
      })
      .catch(() =>
        // 离线：优先命中缓存；导航请求兜底到 index.html
        caches.match(req).then((cached) => {
          if (cached) return cached;
          if (req.mode === 'navigate') return caches.match('./index.html');
          return Response.error();
        })
      )
  );
});
