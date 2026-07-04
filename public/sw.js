// Service Worker — ChatBotPro Notificaciones
// Maneja push notifications en segundo plano
const CACHE_NAME = 'cbp-notify-v1';

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(clients.claim());
});

// Escucha eventos push del servidor
self.addEventListener('push', (e) => {
  let data = { title: '🛒 Nuevo pedido', body: 'Tienes un nuevo pedido', slug: '' };
  try {
    if (e.data) data = { ...data, ...JSON.parse(e.data.text()) };
  } catch {}

  const options = {
    body: data.body,
    icon: '/static/icons/icon-192.png',
    badge: '/static/icons/badge-72.png',
    tag: `order-${data.orderId || Date.now()}`,
    renotify: true,
    requireInteraction: true,
    vibrate: [200, 100, 200, 100, 400],
    data: { url: '/notificaciones', slug: data.slug, orderId: data.orderId },
    actions: [
      { action: 'open',    title: '👁️ Ver pedido' },
      { action: 'dismiss', title: 'Cerrar' },
    ],
  };

  e.waitUntil(self.registration.showNotification(data.title, options));
});

// Al tocar la notificación → abrir/enfocar la página de notificaciones
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  if (e.action === 'dismiss') return;

  const targetUrl = e.notification.data?.url || '/notificaciones';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      const existing = windowClients.find(w => w.url.includes('/notificaciones') && 'focus' in w);
      if (existing) return existing.focus();
      return clients.openWindow(targetUrl);
    })
  );
});
