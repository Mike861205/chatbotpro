const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const config = require('./src/config');
const { initMaster } = require('./src/db');

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
app.use('/api/dashboard', require('./src/routes/dashboard'));
app.use('/api/settings', require('./src/routes/settings'));
app.use('/api/chat', rateLimit(120, 60 * 1000), require('./src/routes/chatbot'));

// Páginas
const page = (name) => (req, res) => res.sendFile(path.join(__dirname, 'public', name));
app.get('/', page('index.html'));
app.get('/login', page('login.html'));
app.get('/register', page('register.html'));
app.get('/app', page('app.html'));
app.get('/c/:slug', page('chat.html'));

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
  .then(() => {
    app.listen(config.PORT, () => {
      console.log(`\n🤖 ChatBotPro corriendo en http://localhost:${config.PORT}`);
      console.log(`   Panel:    http://localhost:${config.PORT}/login`);
      console.log(`   Registro: http://localhost:${config.PORT}/register\n`);
    });
  })
  .catch((e) => {
    console.error('[db] No se pudo conectar a Neon:', e.message);
    process.exit(1);
  });
