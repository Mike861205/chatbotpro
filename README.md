# 🤖 ChatBotPro — Sistema multi-tenant de chatbot de pedidos para restaurantes

Sistema SaaS multi-tenant donde cada restaurante (tenant) tiene su **base de datos aislada**, su panel de administración y su **chatbot público de pedidos** accesible por liga (`/c/tu-slug`) con envío del resumen del pedido por **WhatsApp**.

## ✨ Funcionalidades

- **Registro multi-tenant**: nombre, teléfono, slug del negocio, usuario y contraseña.
- **Aislamiento de datos**: la BD maestra solo guarda tenants/usuarios; cada negocio tiene su propio archivo SQLite en `data/tenants/<slug>.db`.
- **Seguridad**:
  - Contraseñas con `bcrypt` (12 rondas).
  - Datos sensibles de clientes (nombre, teléfono, dirección) cifrados con **AES-256-GCM**.
  - Sesiones JWT en cookies `httpOnly` + rate limiting + cabeceras de seguridad.
- **Dashboard** con reportes: ventas de hoy, pedidos, gráficas de 7 días, top productos.
- **Pedidos**: gestión de estatus (pendiente → confirmado → preparando → enviado → entregado).
- **Productos**: categorías, fotos, precios, activar/desactivar para el chatbot.
- **Chatbot con flujos guiados** (botones): menú → producto → cantidad → carrito → datos del cliente → confirmación → pedido + liga de WhatsApp con el resumen.
- **OpenAI (opcional)**: si configuras `OPENAI_API_KEY`, el bot responde preguntas libres sobre el menú con IA.
- **Branding por tenant**: logo, color principal, mensaje de bienvenida, moneda, horarios.

## 🚀 Arranque local

```bash
npm install
npm start
```

- Panel: http://localhost:3000/login
- Registro: http://localhost:3000/register
- Chatbot público: http://localhost:3000/c/<tu-slug>

Los secretos (`JWT_SECRET`, `DATA_ENCRYPTION_KEY`) se generan automáticamente en `.env` en el primer arranque. Para usar IA, agrega tu `OPENAI_API_KEY` en `.env`.

## 🗂️ Estructura

```
server.js              # Servidor Express + seguridad + rutas
src/
  config.js            # Configuración y generación de secretos
  db/master.js         # BD maestra (tenants + usuarios)
  db/tenant.js         # Fábrica de BD aislada por tenant
  middleware/auth.js   # JWT + cookie httpOnly
  utils/crypto.js      # AES-256-GCM para datos de clientes
  chatbot/engine.js    # Máquina de estados del chatbot + OpenAI
  routes/              # auth, products, orders, dashboard, settings, chatbot
public/                # Frontend (login, registro, panel, chat público)
data/                  # SQLite (master.db + tenants/<slug>.db) — fuera de git
uploads/               # Logos y fotos de productos — fuera de git
```

## ☁️ Roadmap a producción

| Pieza | Local (hoy) | Producción |
|---|---|---|
| Base de datos | SQLite por tenant | **Neon** (PostgreSQL): un schema por tenant (`DATABASE_URL` en `.env`) |
| Hosting | localhost | **Liquid Web** (VPS con Node + Nginx + HTTPS/Let's Encrypt) |
| IA | Opcional | **OpenAI** `gpt-4o-mini` para lenguaje natural |
| Código | Git local | GitHub + despliegue por CI |

Pasos sugeridos al migrar:
1. Crear proyecto en Neon y definir `DATABASE_URL`.
2. Sustituir `better-sqlite3` por `pg` y mapear `getTenantDb(slug)` a `SET search_path TO tenant_<slug>`.
3. En Liquid Web: Nginx como proxy inverso al puerto Node, certificado SSL, `NODE_ENV=production` (activa cookies `secure`).
4. Mover `uploads/` a almacenamiento persistente (o S3 compatible).
