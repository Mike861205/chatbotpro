// Service Worker - ChatBotPro Notificaciones y Bandeja WhatsApp
const CACHE_NAME = 'cbp-notify-v4';
const OFFLINE_PAGES = ['/notificaciones', '/bandeja'];
const PRECACHE = [...OFFLINE_PAGES, '/sw.js'];

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
  const url = new URL(e.request.url);
  // El worker sólo da soporte offline a las apps instalables y sus estáticos.
  // Nunca debe servir logins ni respuestas de API desde caché.
  if (!OFFLINE_PAGES.includes(url.pathname) && url.pathname !== '/sw.js' && !url.pathname.startsWith('/static/')) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});

self.addEventListener('push', (e) => {
  let data = { title: 'Nuevo pedido', body: 'Tienes un nuevo pedido', slug: '', url: '/notificaciones' };
  try {
    if (e.data) data = { ...data, ...JSON.parse(e.data.text()) };
  } catch {}

  const isChat = data.event === 'whatsapp_message';
  const options = isChat
    ? {
      body: data.body,
      icon: '/static/icons/icon-192.png',
      badge: '/static/icons/badge-72.png',
      tag: `wa-${data.conversationId || 'chat'}`,
      renotify: true,
      timestamp: Date.now(),
      vibrate: [120, 60, 120],
      data: { url: data.url || '/bandeja', conversationId: data.conversationId, event: data.event },
    }
    : {
      body: data.body,
      icon: '/static/icons/icon-192.png',
      badge: '/static/icons/badge-72.png',
      tag: data.orderId ? `order-${data.orderId}` : `${data.event || 'chatbot'}-${data.sessionId || Date.now()}`,
      renotify: true,
      requireInteraction: true,
      silent: false,
      timestamp: Date.now(),
      vibrate: [200, 100, 200, 100, 400],
      data: { url: data.url || '/notificaciones', slug: data.slug, orderId: data.orderId, event: data.event },
      actions: [
        { action: 'open', title: 'Ver pedidos' },
        { action: 'dismiss', title: 'Cerrar' },
      ],
    };

  e.waitUntil((async () => {
    // With the inbox open and visible the page already alerts the user.
    if (isChat) {
      const open = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (open.some((client) => client.visibilityState === 'visible' && new URL(client.url).pathname === '/bandeja')) return;
    }
    await self.registration.showNotification(data.title, options);
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  if (e.action === 'dismiss') return;

  const targetUrl = e.notification.data?.url || '/notificaciones';
  const target = new URL(targetUrl, self.location.origin);
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      const existing = windowClients.find((windowClient) => {
        try { return new URL(windowClient.url).pathname === target.pathname && 'focus' in windowClient; } catch { return false; }
      });
      if (existing) {
        const conversationId = e.notification.data?.conversationId;
        if (conversationId) existing.postMessage({ type: 'open-conversation', id: conversationId });
        return existing.focus();
      }
      return clients.openWindow(targetUrl);
    })
  );
});
