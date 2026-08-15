# 🤖 ChatBotPro — Sistema multi-tenant de chatbot de pedidos para restaurantes

Sistema SaaS multi-tenant donde cada restaurante (tenant) tiene su **base de datos aislada**, su panel de administración y su **chatbot público de pedidos** accesible por liga (`/tu-slug`) con envío del resumen del pedido por **WhatsApp**.

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
- **SuperAdmin**: panel separado para gestionar tenants activos/por pagar/inactivos y editar datos comerciales.
- **Integraciones centralizadas**: OpenAI y APIs del chatbot configuradas en SuperAdmin, separadas del panel de tenants.
- **Branding por tenant**: logo, color principal, mensaje de bienvenida, moneda, horarios.

## 🚀 Arranque local

```bash
npm install
npm start
```

- Panel: http://localhost:3000/login
- Registro: http://localhost:3000/register
- SuperAdmin: http://localhost:3000/superadmin/login
- Chatbot público: http://localhost:3000/<tu-slug>

Requiere `DATABASE_URL` (cadena de conexión de Neon) en `.env`. Los secretos (`JWT_SECRET`, `SUPERADMIN_JWT_SECRET`, `DATA_ENCRYPTION_KEY`) se generan automáticamente en desarrollo. En producción configura valores únicos de al menos 32 caracteres y define `SUPERADMIN_USERNAME` y una `SUPERADMIN_PASSWORD` de al menos 12 caracteres. Para usar IA puedes dejar `OPENAI_API_KEY` como fallback o configurarla desde SuperAdmin.

### Acceso demo desde login

Puedes habilitar el botón **Ver demo del panel** en `/login` configurando estas variables en `.env`:

- `DEMO_LOGIN_ENABLED=true`
- `DEMO_USERNAME=demo`
- `DEMO_PASSWORD=<clave aleatoria de al menos 12 caracteres>` (opcional; si se omite, una cuenta demo nueva recibe una clave interna aleatoria)
- `DEMO_TENANT_SLUG=slug-demo` (obligatorio; debe ser un negocio exclusivo para pruebas)

Comportamiento por defecto:

- Si `DEMO_LOGIN_ENABLED` o el tenant exclusivo no están configurados, el botón permanece oculto y el endpoint queda desactivado.
- El sistema nunca selecciona automáticamente el primer negocio activo. Si el usuario demo no existe, sólo se crea dentro del tenant indicado explícitamente.
- Si el usuario ya existe, su contraseña no se sobrescribe automáticamente.

## 🍳 Pantallas KDS por área de preparación

El panel incluye el módulo **Pantallas KDS** para enviar automáticamente las comandas del POS y del chatbot a Cocina, Barra u otras estaciones.

1. Entra a `/app#kds` como propietario.
2. Crea un área y asigna sus categorías o productos individuales.
3. Copia el enlace privado del área y ábrelo en una TV, tableta o celular.
4. Cada estación administra su avance: Nuevo → Preparando → Listo → Entregado.

Los pedidos mixtos aparecen en todas las áreas correspondientes, pero cada pantalla resalta únicamente las partidas que debe preparar. Los enlaces contienen un token privado y pueden renovarse desde el panel.

## 🧪 Separar test y producción

El proyecto ya soporta archivos de entorno separados:

- `NODE_ENV=test` usa `.env.test`
- `NODE_ENV=production` usa `.env.production`
- `ENV_FILE=.env.algo` permite forzar un archivo específico

Ejemplo Windows PowerShell:

```powershell
$env:NODE_ENV='test'; node server.js
$env:NODE_ENV='production'; node server.js
```

## ⚡ Deploy rápido de cambios

Flujo recomendado:

1. En local: `git add . && git commit -m "..." && git push origin main`
2. En servidor (una sola orden):

```bash
cd /var/www/chatbotpro
chmod +x deploy/quick-deploy.sh
./deploy/quick-deploy.sh
```

Si el servidor tiene cambios locales y quieres forzar el código remoto:

```bash
cd /var/www/chatbotpro
./deploy/quick-deploy.sh --force
```

Deploy remoto en un solo comando (desde tu PC Windows con PowerShell):

```powershell
cd c:\chatbotpro
powershell -ExecutionPolicy Bypass -File .\deploy\remote-deploy.ps1
```

Forzado (descarta cambios locales en servidor):

```powershell
cd c:\chatbotpro
powershell -ExecutionPolicy Bypass -File .\deploy\remote-deploy.ps1 -Force
```

Deploy desde SuperAdmin (sin abrir PowerShell):

1. Entra a `/superadmin` -> sección **Integraciones**.
2. En tarjeta **Deploy a producción**, pulsa **Deploy ahora**.
3. Opcional: activa **Forzar** para usar `--force` en servidor.
4. Si quieres todo en uno, usa **Push + Deploy** escribiendo mensaje de commit.

Notas importantes:

- El deploy remoto publica lo que ya está en GitHub (`origin/main`).
- Antes de pulsar deploy, asegúrate de haber hecho `git push` de tus cambios locales.
- Con **Push + Deploy**, el panel ejecuta: `git add -A` -> `git commit` -> `git push` -> deploy remoto.
- Puedes configurar SSH con variables `DEPLOY_*` en `.env` (ver `.env.example`).

Recomendación:

- Usa un `DATABASE_URL` distinto para test y producción.
- No subas `.env*` al repo (excepto `.env.example`).

## Portal de resellers

1. Entra a `/superadmin` y abre **Resellers**.
2. Crea el reseller con nombre, clave de enlace, usuario y contraseña.
3. Comparte con el reseller su acceso: `/resellers/<clave>`.
4. El reseller comparte con sus clientes: `/<clave>`.

Los registros y solicitudes de demo iniciados desde ese último enlace quedan atribuidos al reseller. Su panel privado contiene Prospectos, Clientes, Leads demo y Seguimiento; no expone Integraciones. El aislamiento también se valida en la API mediante `reseller_id`.

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
