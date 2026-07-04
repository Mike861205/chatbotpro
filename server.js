const path = require('path');
const http = require('http');
const express = require('express');
const { Server: SocketIO } = require('socket.io');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const config = require('./src/config');
const { initMaster, refreshTenantBillingStatuses, q } = require('./src/db');
const { setIo } = require('./src/notifications');
const jwt = require('jsonwebtoken');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Cabeceras básicas de seguridad
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

// Rate limit sencillo en memoria para auth y chat
const hits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const entry = hits.get(key) || { count: 0, start: now };
    if (now - entry.start > windowMs) {
      entry.count = 0;
      entry.start = now;
    }
    entry.count++;
    hits.set(key, entry);
    if (entry.count > max) return res.status(429).json({ error: 'Demasiadas solicitudes, intenta más tarde' });
    next();
  };
}

// Estáticos
app.use('/static', express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(config.UPLOADS_DIR));

// APIs
app.use('/api/auth', rateLimit(30, 10 * 60 * 1000), require('./src/routes/auth'));
app.use('/api/products', require('./src/routes/products'));
app.use('/api/orders', require('./src/routes/orders'));
app.use('/api/customers', require('./src/routes/customers'));
app.use('/api/dashboard', require('./src/routes/dashboard'));
app.use('/api/settings', require('./src/routes/settings'));
app.use('/api/branches', require('./src/routes/branches'));
app.use('/api/cashiers', require('./src/routes/cashiers'));
app.use('/api/pos', require('./src/routes/pos'));
app.use('/api/chat', rateLimit(120, 60 * 1000), require('./src/routes/chatbot'));
app.use('/api/superadmin', rateLimit(80, 10 * 60 * 1000), require('./src/routes/superadmin'));
app.use('/api/notifications', require('./src/routes/notifications'));

// Páginas
const page = (name) => (req, res) => res.sendFile(path.join(__dirname, 'public', name));
app.get('/', page('index.html'));
app.get('/login', page('login.html'));
app.get('/register', page('register.html'));
app.get('/app', page('app.html'));
app.get('/notificaciones', page('notify.html'));
app.get('/caja/:slug([a-z0-9-]{3,40})', page('cashier-login.html'));
app.get('/superadmin/login', page('superadmin-login.html'));
app.get('/superadmin', page('superadmin.html'));
app.get('/c/:slug([a-z0-9-]{3,40})', page('chat.html'));
app.get('/:slug([a-z0-9-]{3,40})', page('chat.html'));

// Manejador central de errores (mensajes amigables, sin stack al cliente)
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'La imagen es demasiado grande (máximo 8 MB). Usa una imagen más ligera.'
        : `Error al subir el archivo: ${err.message}`;
    return res.status(400).json({ error: msg });
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
    }, 60 * 60 * 1000);

    // HTTP server + Socket.io
    const httpServer = http.createServer(app);
    const io = new SocketIO(httpServer, {
      cors: { origin: false },
      path: '/socket.io',
    });

    // Auth de sockets: valida el JWT cookie o query param token
    io.use(async (socket, next) => {
      try {
        const token =
          socket.handshake.auth?.token ||
          socket.handshake.query?.token ||
          (socket.handshake.headers.cookie || '').split(';').map(c => c.trim()).find(c => c.startsWith('cbp_owner_token='))?.split('=')[1];
        if (!token) return next(new Error('auth'));
        const decoded = jwt.verify(token, config.JWT_SECRET);
        if (!decoded?.tenantSlug || decoded?.role !== 'owner') return next(new Error('auth'));
        // Verifica que el tenant exista y esté activo
        const { rows } = await q('SELECT slug FROM tenants WHERE slug = $1 AND account_status = $2', [decoded.tenantSlug, 'active']);
        if (!rows[0]) return next(new Error('auth'));
        socket.tenantSlug = decoded.tenantSlug;
        next();
      } catch {
        next(new Error('auth'));
      }
    });

    io.on('connection', (socket) => {
      socket.join(`tenant:${socket.tenantSlug}`);
      console.log(`[ws] ${socket.tenantSlug} conectado (${socket.id})`);
      socket.on('disconnect', () => {
        console.log(`[ws] ${socket.tenantSlug} desconectado (${socket.id})`);
      });
    });

    setIo(io);

    httpServer.listen(config.PORT, () => {
      console.log(`\n🤖 ChatBotPro corriendo en http://localhost:${config.PORT}`);
      console.log(`   Panel:    http://localhost:${config.PORT}/login`);
      console.log(`   Registro: http://localhost:${config.PORT}/register`);
      console.log(`   Notifs:   http://localhost:${config.PORT}/notificaciones\n`);
    });
  })
  .catch((e) => {
    console.error('[db] No se pudo conectar a Neon:', e.message);
    process.exit(1);
  });
