// Service Worker für Die Pudolfs Kegelclub – ausschließlich für Web Push.
// Bewusst kein Offline-Caching hier, um mit dem bestehenden
// "no-cache, no-store, must-revalidate"-Header und dem Self-Update-Mechanismus
// der App nicht zu kollidieren.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'Die Pudolfs', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'Die Pudolfs';
  const options = {
    body: data.body || '',
    icon: '/icons/icon-192-any.png',
    badge: '/icons/icon-192-any.png',
    data: { url: data.url || '/' },
    tag: data.tag || undefined,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
