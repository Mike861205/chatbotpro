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
    {
      name: 'chatbotpro-whatsapp-bot',
      script: 'src/whatsapp-bot/gateway.js',
      cwd: '/var/www/chatbotpro',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '700M',
      env: { NODE_ENV: 'production', ENV_FILE: '.env.production' },
    },
  ],
};
