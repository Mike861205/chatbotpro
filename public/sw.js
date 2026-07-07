// Service Worker - ChatBotPro Notificaciones
const CACHE_NAME = 'cbp-notify-v2';
const PRECACHE = ['/notificaciones', '/sw.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || !e.request.url.startsWith(self.location.origin)) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

self.addEventListener('push', (e) => {
  let data = { title: 'Nuevo pedido', body: 'Tienes un nuevo pedido', slug: '', url: '/notificaciones' };
  try {
    if (e.data) data = { ...data, ...JSON.parse(e.data.text()) };
  } catch {}

  const options = {
    body: data.body,
    icon: '/static/icons/icon-192.png',
    badge: '/static/icons/badge-72.png',
    tag: data.orderId ? `order-${data.orderId}` : `${data.event || 'chatbot'}-${data.sessionId || Date.now()}`,
    renotify: true,
    requireInteraction: true,
    silent: false,
    timestamp: Date.now(),
    vibrate: [200, 100, 200, 100, 400],
    data: {
      url: data.url || '/notificaciones',
      slug: data.slug,
      orderId: data.orderId,
      event: data.event,
    },
    actions: [
      { action: 'open', title: 'Ver pedidos' },
      { action: 'dismiss', title: 'Cerrar' },
    ],
  };

  e.waitUntil(self.registration.showNotification(data.title, options));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  if (e.action === 'dismiss') return;

  const targetUrl = e.notification.data?.url || '/notificaciones';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      const existing = windowClients.find((windowClient) => windowClient.url.includes('/notificaciones') && 'focus' in windowClient);
      if (existing) return existing.focus();
      return clients.openWindow(targetUrl);
    })
  );
});
