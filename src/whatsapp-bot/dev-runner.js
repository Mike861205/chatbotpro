// Start the local app and its private QR gateway together during development.
const { spawn } = require('node:child_process');
const path = require('node:path');
const dotenv = require('dotenv');

const root = path.resolve(__dirname, '../..');
dotenv.config({ path: path.join(root, process.env.ENV_FILE || '.env'), override: true });

const children = [];
let stopping = false;
function start(label, args) {
  const child = spawn(process.execPath, args, { cwd: root, env: process.env, stdio: 'inherit' });
  children.push(child);
  child.on('exit', (code, signal) => {
    if (stopping) return;
    console.error(`[dev] ${label} terminó (${signal || code}).`);
    if (label === 'app') stop(code || 1);
  });
  child.on('error', (error) => console.error(`[dev] No se pudo iniciar ${label}: ${error.message}`));
  return child;
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null && !child.killed) child.kill();
  setTimeout(() => process.exit(code), 250).unref();
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

if (String(process.env.WHATSAPP_BOT_GATEWAY_SECRET || '').length >= 32) start('gateway', ['src/whatsapp-bot/gateway.js']);
else console.warn('[dev] WhatsApp Bot QR desactivado: configura WHATSAPP_BOT_GATEWAY_SECRET en .env.');
start('app', ['--watch', 'server.js']);
