const path = require('path');
const http = require('http');
const express = require('express');
const { Server: SocketIO } = require('socket.io');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const config = require('./src/config');
const { initMaster, refreshTenantBillingStatuses, q, tdb } = require('./src/db');
const { setIo } = require('./src/notifications');
const { verifyNotificationMailer } = require('./src/utils/mailer');
const jwt = require('jsonwebtoken');
const {
  apiNoStore,
  createRateLimiter,
  requireSameOrigin,
  securityHeaders,
} = require('./src/middleware/security');

const app = express();
app.disable('x-powered-by');
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
app.use(securityHeaders());
app.use('/api', requireSameOrigin);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));
app.use(cookieParser());

const chatLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 90,
  message: 'Demasiados mensajes. Espera un momento.',
});
const BILLING_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Estáticos
app.use('/static', express.static(path.join(__dirname, 'public')));
app.use('/uploads', (req, res, next) => {
  if (/\.svg(?:$|[?#])/i.test(req.url)) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  next();
}, express.static(config.UPLOADS_DIR, { dotfiles: 'deny', fallthrough: true }));

// Service Worker en raíz para que el scope cubra toda la app (necesario para PWA)
app.get('/sw.js', (req, res) => {
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Content-Type', 'application/javascript');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

// APIs
app.use('/api', apiNoStore);
app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/products', require('./src/routes/products'));
app.use('/api/orders', require('./src/routes/orders'));
app.use('/api/customers', require('./src/routes/customers'));
app.use('/api/dashboard', require('./src/routes/dashboard'));
app.use('/api/sales', require('./src/routes/sales'));
app.use('/api/costs', require('./src/routes/costs'));
app.use('/api/purchases', require('./src/routes/purchases'));
app.use('/api/branch-stock', require('./src/routes/branchStock'));
app.use('/api/settings', require('./src/routes/settings'));
app.use('/api/branches', require('./src/routes/branches'));
app.use('/api/cashiers', require('./src/routes/cashiers'));
app.use('/api/pos', require('./src/routes/pos'));
app.use('/api/chat', chatLimiter, require('./src/routes/chatbot'));
app.use('/api/superadmin', require('./src/routes/superadmin'));
app.use('/api/resellers', require('./src/routes/resellers'));
app.use('/api/notifications', require('./src/routes/notifications'));
app.use('/api/inventory', require('./src/routes/inventory'));
app.use('/api/employees', require('./src/routes/employees'));
app.use('/api/kds', require('./src/routes/kds'));
app.use('/api/invoicing', require('./src/routes/invoicing'));

// Páginas
const page = (name) => (req, res) => res.sendFile(path.join(__dirname, 'public', name));
const validSlug = (req, res, next) => /^[a-z0-9-]{3,40}$/.test(String(req.params.slug || '')) ? next() : res.status(404).end();
const validKdsToken = (req, res, next) => /^[A-Za-z0-9_-]{20,80}$/.test(String(req.params.token || '')) ? next() : res.status(404).end();
app.get('/', page('index.html'));
app.get('/login', page('login.html'));
app.get('/register', page('register.html'));
app.get('/app', page('app.html'));
app.get('/notificaciones', page('notify.html'));
app.get('/caja/:slug', validSlug, page('cashier-login.html'));
app.get('/kds/:slug/:token', validSlug, validKdsToken, page('kds.html'));
app.get('/superadmin/login', page('superadmin-login.html'));
app.get('/superadmin', page('superadmin.html'));
app.get('/resellers/panel', page('reseller.html'));
app.get('/resellers/:slug', validSlug, page('reseller-login.html'));
app.get('/c/:slug', validSlug, page('chat.html'));
app.get('/facturacion/:slug', validSlug, page('invoice.html'));
app.get('/:slug', validSlug, async (req, res, next) => {
  try {
    const hostname = String(req.hostname || '').toLowerCase();
    if (hostname.startsWith('facturacion.')) {
      return res.sendFile(path.join(__dirname, 'public', 'invoice.html'));
    }
    const found = await q('SELECT id FROM resellers WHERE slug = $1 AND active = 1 LIMIT 1', [req.params.slug]);
    if (found.rows[0]) return res.redirect(302, `/?reseller=${encodeURIComponent(req.params.slug)}`);
    return res.sendFile(path.join(__dirname, 'public', 'chat.html'));
  } catch (error) {
    next(error);
  }
});

// Manejador central de errores (mensajes amigables, sin stack al cliente)
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'La imagen es demasiado grande (máximo 8 MB). Usa una imagen más ligera.'
        : 'No se pudo procesar el archivo. Revisa su tamaño y formato.';
    return res.status(400).json({ error: msg });
  }
  if (err?.code === 'UNSUPPORTED_FILE_TYPE') {
    return res.status(415).json({ error: 'Formato no permitido. Usa PNG, JPG, WEBP o GIF.' });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'La solicitud excede el tamaño permitido' });
  }
  if (err instanceof SyntaxError && err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'El contenido JSON no es válido' });
  }
  const status = Number(err?.status || err?.statusCode || 0);
  if (status >= 400 && status < 500) {
    return res.status(status).json({ error: String(err.message || 'Solicitud no válida').slice(0, 240) });
  }
  console.error('[error]', err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

initMaster()
  .then(async () => {
    try {
      const firstRefresh = await refreshTenantBillingStatuses();
      console.log(`[billing] refresco inicial -> due:${firstRefresh.movedToDue} suspended:${firstRefresh.movedToSuspended}`);
    } catch (e) {
      console.error('[billing] error en refresco inicial:', e.message);
    }

    setInterval(async () => {
      try {
        const refreshed = await refreshTenantBillingStatuses();
        if (refreshed.movedToDue || refreshed.movedToSuspended) {
          console.log(`[billing] cron -> due:${refreshed.movedToDue} suspended:${refreshed.movedToSuspended}`);
        }
      } catch (e) {
        console.error('[billing] error en cron:', e.message);
      }
    }, BILLING_REFRESH_INTERVAL_MS);

    // HTTP server + Socket.io
    const httpServer = http.createServer(app);
    const io = new SocketIO(httpServer, {
      cors: { origin: false },
      path: '/socket.io',
    });

    // Auth de sockets: valida sesiones del panel o la liga privada de KDS.
    io.use(async (socket, next) => {
      try {
        const kdsSlug = String(socket.handshake.auth?.kdsSlug || '').trim().toLowerCase();
        const kdsToken = String(socket.handshake.auth?.kdsToken || '');
        if (kdsSlug && kdsToken) {
          const tenantResult = await q(
            `SELECT slug FROM tenants
             WHERE slug = $1 AND account_status = 'active' AND billing_status <> 'suspended'
             LIMIT 1`,
            [kdsSlug]
          );
          const tenant = tenantResult.rows[0];
          if (!tenant) return next(new Error('auth'));
          const area = await tdb(tenant.slug).get(
            'SELECT id FROM {s}.kds_areas WHERE access_token = $1 AND active = 1 LIMIT 1',
            [kdsToken]
          );
          if (!area) return next(new Error('auth'));
          socket.tenantSlug = tenant.slug;
          socket.clientType = 'kds';
          return next();
        }

        const scope = String(socket.handshake.auth?.scope || 'owner').trim().toLowerCase() === 'cashier'
          ? 'cashier'
          : 'owner';
        const cookieName = scope === 'cashier' ? 'cbp_cashier_token' : 'cbp_owner_token';
        const rawToken = socket.handshake.auth?.token || (socket.handshake.headers.cookie || '')
          .split(';')
          .map((cookie) => cookie.trim())
          .find((cookie) => cookie.startsWith(`${cookieName}=`))
          ?.split('=')
          .slice(1)
          .join('=');
        if (!rawToken) return next(new Error('auth'));
        const decoded = jwt.verify(rawToken, config.JWT_SECRET, {
          issuer: 'chatbotpro',
          audience: `cbp:${scope}`,
        });
        const tenantSlug = decoded?.slug;
        if (!tenantSlug || decoded.typ !== scope) return next(new Error('auth'));
        const [{ rows: tRows }, { rows: uRows }] = await Promise.all([
          q('SELECT slug FROM tenants WHERE slug = $1 AND account_status = $2', [tenantSlug, 'active']),
          q('SELECT role FROM users WHERE id = $1 AND active = 1', [decoded.uid]),
        ]);
        if (!tRows[0]) return next(new Error('auth'));
        if (uRows[0]?.role !== scope) return next(new Error('auth'));
        socket.tenantSlug = tenantSlug;
        socket.clientType = scope;
        next();
      } catch {
        next(new Error('auth'));
      }
    });

    io.on('connection', (socket) => {
      socket.join(`tenant:${socket.tenantSlug}`);
      console.log(`[ws] ${socket.tenantSlug}/${socket.clientType} conectado (${socket.id})`);
      socket.on('disconnect', () => {
        console.log(`[ws] ${socket.tenantSlug}/${socket.clientType} desconectado (${socket.id})`);
      });
    });

    setIo(io);

    httpServer.listen(config.PORT, config.HOST, () => {
      console.log(`\n🤖 ChatBotPro corriendo en http://localhost:${config.PORT}`);
      console.log(`   Panel:    http://localhost:${config.PORT}/login`);
      console.log(`   Registro: http://localhost:${config.PORT}/register`);
      console.log(`   Notifs:   http://localhost:${config.PORT}/notificaciones\n`);
      verifyNotificationMailer().catch((error) => {
        console.error('[mailer] No se pudo verificar SMTP al iniciar:', error.message);
      });
    });
  })
  .catch((e) => {
    console.error('[db] No se pudo conectar a Neon:', e.message);
    process.exit(1);
  });
