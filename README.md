# 🤖 ChatBotPro — Sistema multi-tenant de chatbot de pedidos para restaurantes

Sistema SaaS multi-tenant donde cada restaurante (tenant) tiene su **base de datos aislada**, su panel de administración y su **chatbot público de pedidos** accesible por liga (`/c/tu-slug`) con envío del resumen del pedido por **WhatsApp**.

## ✨ Funcionalidades

- **Registro multi-tenant**: nombre, teléfono, slug del negocio, usuario y contraseña.
- **Aislamiento de datos**: PostgreSQL en **Neon** con un **schema aislado por tenant** (`t_<slug>`); el schema público solo guarda tenants/usuarios.
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

Requiere `DATABASE_URL` (cadena de conexión de Neon) en `.env`. Los secretos (`JWT_SECRET`, `DATA_ENCRYPTION_KEY`) se generan automáticamente en el primer arranque. Para usar IA, agrega tu `OPENAI_API_KEY` en `.env`.

## 🗂️ Estructura

```
server.js              # Servidor Express + seguridad + rutas
src/
  config.js            # Configuración, secretos y DATABASE_URL
  db/index.js          # Pool de Neon + schema por tenant (t_<slug>)
  middleware/auth.js   # JWT + cookie httpOnly
  utils/crypto.js      # AES-256-GCM para datos de clientes
  chatbot/engine.js    # Máquina de estados del chatbot + OpenAI
  routes/              # auth, products, orders, dashboard, settings, chatbot
public/                # Frontend (login, registro, panel, chat público)
uploads/               # Logos y fotos de productos — fuera de git
```

## ☁️ Roadmap a producción

| Pieza | Hoy | Producción |
|---|---|---|
| Base de datos | ✅ **Neon** (PostgreSQL, schema por tenant) | Igual — ya lista |
| Hosting | localhost | **Liquid Web** (VPS con Node + Nginx + HTTPS/Let's Encrypt) |
| IA | Opcional | **OpenAI** `gpt-4o-mini` para lenguaje natural |
| Código | Git local | GitHub + despliegue por CI |

Pasos sugeridos para desplegar:
1. En Liquid Web: Nginx como proxy inverso al puerto Node, certificado SSL, `NODE_ENV=production` (activa cookies `secure`).
2. Mover `uploads/` a almacenamiento persistente (o S3 compatible).
3. Rotar la contraseña de Neon antes de salir a producción y usar una rama/proyecto dedicado.
