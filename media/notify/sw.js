// Claude 通知：只负责接收 Web Push 并显示系统通知。
// 作用域限定在 /media/notify/，与博客根目录的 sw.js 互不影响。

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()); });

self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data && event.data.text() }; }
  // iOS 要求每条推送都必须显示通知，否则会撤销订阅，所以解析失败也要兜底显示。
  event.waitUntil(self.registration.showNotification(data.title || 'Claude 通知', {
    body: data.body || '',
    icon: '/media/notify/icon-v2-192.png',
    tag: data.tag,
    data: { url: data.url || '/media/notify/' }
  }));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || '/media/notify/';
  event.waitUntil(self.clients.openWindow(url));
});
