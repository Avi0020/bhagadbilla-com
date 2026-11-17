/* Index Signals — Service Worker for Home Screen PWA & Push Notifications */
const CACHE_NAME = 'ix-signals-v1';

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || './index.html';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (let i = 0; i < clientList.length; i++) {
        const client = clientList[i];
        if ('focus' in client) {
          if (client.url && client.url.includes('index.html')) {
            return client.focus();
          }
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SHOW_NOTIFICATION') {
    const { title, options } = event.data;
    event.waitUntil(
      self.registration.showNotification(title, Object.assign({
        icon: 'icon-192.png',
        badge: 'icon-192.png',
        vibrate: [200, 100, 200, 100, 250]
      }, options || {}))
    );
  }
});

self.addEventListener('push', event => {
  let d = { title: 'Index Signals Alert', body: 'New market call generated' };
  if (event.data) {
    try {
      d = event.data.json();
    } catch (e) {
      d.body = event.data.text();
    }
  }
  event.waitUntil(
    self.registration.showNotification(d.title || 'Index Signals', {
      body: d.body || 'New call generated',
      icon: d.icon || 'icon-192.png',
      badge: d.badge || 'icon-192.png',
      vibrate: [200, 100, 200, 100, 250],
      tag: d.tag || ('sig-' + Date.now()),
      renotify: true,
      data: d.data || { url: './index.html' }
    })
  );
});
