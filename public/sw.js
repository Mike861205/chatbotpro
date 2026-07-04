// Service Worker — ChatBotPro Notificaciones
// Maneja push notifications en segundo plano
const CACHE_NAME = 'cbp-notify-v1';
const PRECACHE = ['/notificaciones', '/sw.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(PRECACHE)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => clients.claim())
  );
});

// FETCH: network-first, fallback a cache (requerido por Chrome para PWA installability)
self.addEventListener('fetch', (e) => {
  // Solo interceptar GETs del mismo origen
  if (e.request.method !== 'GET' || !e.request.url.startsWith(self.location.origin)) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        // Guardar en cache solo respuestas OK
        if (res && res.status === 200 && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
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
