#!/bin/bash
set -euo pipefail

DOMAIN="chatbotpro.systemdem.online"
INVOICE_DOMAIN="facturacion.chatbotpro.systemdem.online"
APP_DIR="/var/www/chatbotpro"
PORT=3003
REPO="https://github.com/Mike861205/chatbotpro.git"
BRANCH="main"
SSL_EMAIL="admin@systemdem.online"

echo "==> 1) Sistema base"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git ca-certificates gnupg nginx ufw

echo "==> 2) Node.js 20"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v)" != v20* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node -v
npm -v

echo "==> 3) PM2"
npm install -g pm2 >/dev/null
pm2 -v

echo "==> 4) Certbot"
apt-get install -y certbot python3-certbot-nginx

echo "==> 5) Clonar/actualizar proyecto en $APP_DIR"
mkdir -p /var/www
if [ -d "$APP_DIR/.git" ]; then
  cd "$APP_DIR"
  git fetch --all --prune
  git checkout "$BRANCH"
  git reset --hard "origin/$BRANCH"
else
  rm -rf "$APP_DIR"
  git clone -b "$BRANCH" "$REPO" "$APP_DIR"
  cd "$APP_DIR"
fi

echo "==> 6) Dependencias"
cd "$APP_DIR"
if [ -f package-lock.json ]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi

echo "==> 7) Validar .env.production"
if [ ! -f .env.production ]; then
  echo "ERROR: crea $APP_DIR/.env.production con secretos nuevos antes de desplegar."
  echo "Usa .env.example como guía; nunca guardes credenciales dentro del repositorio."
  exit 1
fi

for required_key in DATABASE_URL JWT_SECRET SUPERADMIN_JWT_SECRET DATA_ENCRYPTION_KEY; do
  if ! grep -Eq "^${required_key}=.{32,}$" .env.production; then
    echo "ERROR: ${required_key} falta o es demasiado corto en .env.production"
    exit 1
  fi
done
if grep -q '^SUPERADMIN_USERNAME=' .env.production && ! grep -Eq '^SUPERADMIN_USERNAME=[a-zA-Z0-9._-]{3,60}$' .env.production; then
  echo "ERROR: SUPERADMIN_USERNAME falta o no es válido en .env.production"
  exit 1
fi
if grep -Eq '^SUPERADMIN_PASSWORD=.+' .env.production && ! grep -Eq '^SUPERADMIN_PASSWORD=.{12,128}$' .env.production; then
  echo "ERROR: SUPERADMIN_PASSWORD debe tener entre 12 y 128 caracteres"
  exit 1
fi
if ! grep -Eq '^SUPERADMIN_PASSWORD=.+' .env.production; then
  echo "SUPERADMIN_PASSWORD no definido: se conservará la cuenta existente en Neon."
  echo "En una instalación nueva la aplicación exigirá una contraseña inicial robusta."
fi

if grep -q '^PORT=' .env.production; then
  sed -i "s/^PORT=.*/PORT=$PORT/" .env.production
else
  echo "PORT=$PORT" >> .env.production
fi
if grep -q '^NODE_ENV=' .env.production; then
  sed -i 's/^NODE_ENV=.*/NODE_ENV=production/' .env.production
else
  echo "NODE_ENV=production" >> .env.production
fi
if grep -q '^HOST=' .env.production; then
  sed -i 's/^HOST=.*/HOST=127.0.0.1/' .env.production
else
  echo "HOST=127.0.0.1" >> .env.production
fi
chmod 600 .env.production

echo "==> 8) ecosystem.config.js"
cat > "$APP_DIR/ecosystem.config.js" <<'EOF'
module.exports = {
  apps: [
    {
      name: 'chatbotpro',
      script: 'server.js',
      cwd: '/var/www/chatbotpro',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        ENV_FILE: '.env.production',
        PORT: 3003,
      },
      env_production: {
        NODE_ENV: 'production',
        ENV_FILE: '.env.production',
        PORT: 3003,
      },
    },
  ],
};
EOF

echo "==> 9) Iniciar PM2"
cd "$APP_DIR"
pm2 delete chatbotpro >/dev/null 2>&1 || true
pm2 start ecosystem.config.js --env production
pm2 save
pm2 startup systemd -u root --hp /root | tail -n 1 | bash || true
systemctl enable pm2-root >/dev/null 2>&1 || true

echo "==> 10) Esperar a que la app responda en $PORT"
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/" >/dev/null 2>&1 || curl -fsS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" | grep -qE '^(200|301|302|404)$'; then
    echo "App responde en puerto $PORT"
    break
  fi
  sleep 2
done
curl -sI "http://127.0.0.1:$PORT/" | head -n 1 || true

echo "==> 11) Nginx site para $DOMAIN"
cat > /etc/nginx/sites-available/$DOMAIN <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN $INVOICE_DOMAIN;

    client_max_body_size 16m;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
    }
}
EOF
ln -sf /etc/nginx/sites-available/$DOMAIN /etc/nginx/sites-enabled/$DOMAIN
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl restart nginx

echo "==> 12) Firewall (si UFW activo)"
if ufw status | grep -q "Status: active"; then
  ufw allow 'Nginx Full' || true
  ufw allow OpenSSH || true
fi

echo "==> 13) SSL Let's Encrypt"
certbot --nginx -d "$DOMAIN" -d "$INVOICE_DOMAIN" --redirect --non-interactive --agree-tos -m "$SSL_EMAIL" || {
  echo "Reintentando certbot..."
  sleep 5
  certbot --nginx -d "$DOMAIN" -d "$INVOICE_DOMAIN" --redirect --non-interactive --agree-tos -m "$SSL_EMAIL"
}
systemctl reload nginx

echo "==> 14) Estado final"
echo "--- pm2 status ---"
pm2 status
echo "--- certbot certificates ---"
certbot certificates
echo "--- curl https ---"
curl -sI "https://$DOMAIN" | head -n 5 || true
echo "--- listening port ---"
ss -ltnp | grep ":$PORT" || true

echo "==> DEPLOY COMPLETO"
