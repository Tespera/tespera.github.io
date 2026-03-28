// Gridea Pro PWA Service Worker
const CACHE_NAME = 'gridea-cache-v1774718905';

// 安装时不预缓存，由运行时缓存处理
self.addEventListener('install', function(event) {
  self.skipWaiting();
});

// 激活时清理旧缓存
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(cacheNames) {
      return Promise.all(
        cacheNames.filter(function(name) {
          return name !== CACHE_NAME;
        }).map(function(name) {
          return caches.delete(name);
        })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

// 请求拦截策略
self.addEventListener('fetch', function(event) {
  var request = event.request;

  // 只处理 GET 请求
  if (request.method !== 'GET') return;

  // 跳过非同源请求
  if (!request.url.startsWith(self.location.origin)) return;

  // 导航请求（HTML）：network-first
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then(function(response) {
        if (response.ok) {
          var responseClone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(request, responseClone);
          });
        }
        return response;
      }).catch(function() {
        return caches.match(request);
      })
    );
    return;
  }

  // 静态资源（CSS, JS, 图片, 字体）：cache-first
  if (isStaticAsset(request.url)) {
    event.respondWith(
      caches.match(request).then(function(cached) {
        if (cached) return cached;
        return fetch(request).then(function(response) {
          if (response.ok) {
            var responseClone = response.clone();
            caches.open(CACHE_NAME).then(function(cache) {
              cache.put(request, responseClone);
            });
          }
          return response;
        });
      })
    );
    return;
  }
});

function isStaticAsset(url) {
  return /\.(css|js|png|jpg|jpeg|gif|svg|webp|ico|woff|woff2|ttf|eot)(\?.*)?$/i.test(url);
}
