# Deploy en Liquid Web (Ubuntu/Debian)

## 1) Preparar servidor

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

## 2) Subir proyecto

Ruta sugerida:

```bash
sudo mkdir -p /var/www/chatbotpro
sudo chown -R $USER:$USER /var/www/chatbotpro
```

Opcion A (clonar):

```bash
git clone <URL_REPO> /var/www/chatbotpro
cd /var/www/chatbotpro
git checkout master
npm ci
```

Opcion B (copiar desde local con scp/rsync):

```bash
rsync -avz --exclude node_modules --exclude .git ./ <user>@50.28.103.1:/var/www/chatbotpro/
```

## 3) Variables de entorno

Asegura puerto 3003:

```bash
cd /var/www/chatbotpro
sed -i 's/^PORT=.*/PORT=3003/' .env.production
```

## 4) PM2 (persistente)

```bash
cd /var/www/chatbotpro
pm2 start ecosystem.config.js --env production
pm2 save
pm2 startup systemd -u $USER --hp $HOME
# Ejecuta el comando que PM2 imprime en pantalla (con sudo)
pm2 status
```

## 5) Nginx

```bash
sudo tee /etc/nginx/sites-available/chatbotpro.systemdem.online > /dev/null <<'NGINX'
server {
    listen 80;
    listen [::]:80;
    server_name chatbotpro.systemdem.online;

    location / {
        proxy_pass http://127.0.0.1:3003;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
NGINX

sudo ln -sf /etc/nginx/sites-available/chatbotpro.systemdem.online /etc/nginx/sites-enabled/chatbotpro.systemdem.online
sudo nginx -t
sudo systemctl reload nginx
```

## 6) SSL Let's Encrypt

```bash
sudo certbot --nginx -d chatbotpro.systemdem.online --redirect -m <TU_EMAIL> --agree-tos --no-eff-email
sudo systemctl reload nginx
```

## 7) Validacion HTTPS

```bash
curl -I https://chatbotpro.systemdem.online
sudo certbot certificates
pm2 status
```

Esperado:
- HTTP 200 o 302 en HTTPS.
- Certificado emitido para chatbotpro.systemdem.online.
- Proceso PM2 online.
