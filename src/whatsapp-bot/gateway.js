// Separate, loopback-only Baileys process. Run with PM2, never behind the public proxy.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const sharp = require('sharp');
require('dotenv').config({ path: path.join(__dirname, '../..', process.env.ENV_FILE || '.env'), override: true });

const secret = String(process.env.WHATSAPP_BOT_GATEWAY_SECRET || '');
if (secret.length < 32) throw new Error('WHATSAPP_BOT_GATEWAY_SECRET requiere al menos 32 caracteres');
const port = Number(process.env.WHATSAPP_BOT_GATEWAY_PORT || 3013);
const root = path.resolve(process.env.WHATSAPP_BOT_AUTH_DIR || path.join(__dirname, '../..', 'data', 'whatsapp-bot'));
const registryPath = path.join(root, 'sessions.json');
let registryWrite = Promise.resolve();
const callbackUrl = `http://127.0.0.1:${Number(process.env.WHATSAPP_BOT_APP_PORT || process.env.PORT || 3000)}/api/whatsapp-bot/internal/message`;
const sessions = new Map();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const slug = /^[a-z0-9-]{3,40}$/;
let baileysPromise;
function baileys() { return baileysPromise ||= import('@whiskeysockets/baileys'); }
function authorized(req, res, next) {
  const supplied = Buffer.from(String(req.get('authorization') || '').replace(/^Bearer /i, ''));
  const expected = Buffer.from(secret);
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return res.status(401).json({ error: 'No autorizado' });
  next();
}
function sessionDir(row) { return path.join(root, row.tenant, row.id); }
function incomingContent(msg) {
  const location = msg.locationMessage || msg.liveLocationMessage;
  const lat = Number(location?.degreesLatitude);
  const lng = Number(location?.degreesLongitude);
  const hasLocation = Boolean(location) && Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
  const label = String(location?.name || location?.address || '').replace(/[|\r\n]/g, ' ').slice(0, 160);
  const image = msg.imageMessage;
  return {
    text: hasLocation ? `geo:${lat},${lng}|${label}` : String(msg.conversation || msg.extendedTextMessage?.text || image?.caption || '').slice(0, 10000),
    type: hasLocation ? 'location' : image ? 'image' : 'text',
    image,
  };
}
function saveRegistry() {
  registryWrite = registryWrite.catch(() => {}).then(async () => {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const entries = [...sessions.values()].map(({ id, tenant }) => ({ id, tenant }));
    const temp = `${registryPath}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(entries), { mode: 0o600 });
    await fs.rename(temp, registryPath);
  });
  return registryWrite;
}
async function forward(row, payload) {
  const body = JSON.stringify({ sessionId: row.id, ...payload });
  const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(callbackUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'x-gateway-signature': signature }, body, signal: AbortSignal.timeout(10000) });
      if (response.ok) return;
      if (response.status < 500) throw new Error(`Webhook rechazado: ${response.status}`);
    } catch (error) { if (attempt === 2) throw error; }
    await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
  }
  throw new Error('Webhook no disponible');
}
async function start(row) {
  if (row.removed || row.starting || row.socket) return;
  row.starting = true;
  row.status = 'connecting'; row.qr = ''; row.error = '';
  try {
    const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = await baileys();
    if (row.removed) return;
    const dir = sessionDir(row);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const { state, saveCreds } = await useMultiFileAuthState(dir);
    if (row.removed) { await fs.rm(dir, { recursive: true, force: true }); return; }
    const socket = makeWASocket({ auth: state, logger: pino({ level: 'silent' }), markOnlineOnConnect: false, syncFullHistory: false });
    row.socket = socket;
    socket.ev.on('creds.update', saveCreds);
    socket.ev.on('connection.update', async ({ connection, qr, lastDisconnect }) => {
      if (row.removed || row.socket !== socket) return;
      if (qr) {
        const encoded = await QRCode.toDataURL(qr);
        if (row.socket === socket && row.status !== 'connected') { row.qr = encoded; row.status = 'qr'; }
      }
      if (connection === 'open') { row.status = 'connected'; row.qr = ''; row.error = ''; row.phone = String(socket.user?.id || '').split(':')[0].split('@')[0]; row.attempts = 0; }
      if (connection !== 'close') return;
      row.socket = null; row.qr = '';
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) { row.status = 'logged_out'; await fs.rm(dir, { recursive: true, force: true }); return; }
      row.status = 'reconnecting';
      row.attempts = Math.min((row.attempts || 0) + 1, 6);
      row.timer = setTimeout(() => start(row).catch(console.error), Math.min(30000, 1000 * 2 ** row.attempts));
    });
    socket.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const item of messages || []) {
        const contactJid = item.key?.remoteJidAlt?.endsWith('@s.whatsapp.net') ? item.key.remoteJidAlt : item.key?.remoteJid;
        if (!item.message || item.key?.fromMe || !/^\d{8,20}@(s\.whatsapp\.net|lid)$/.test(String(contactJid || ''))) continue;
        const outer = item.message.ephemeralMessage?.message || item.message;
        const msg = outer.viewOnceMessageV2?.message || outer.viewOnceMessage?.message || outer;
        const { text, type, image } = incomingContent(msg);
        (async () => {
          let mediaBase64 = '';
          if (image) try {
            const raw = await downloadMediaMessage(item, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: socket.updateMediaMessage });
            mediaBase64 = (await sharp(raw).rotate().resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer()).toString('base64');
            if (mediaBase64.length > 650000) mediaBase64 = '';
          } catch (error) { console.warn('[whatsapp-bot][image]', row.id, error.message); }
          await forward(row, { messageId: item.key.id, jid: contactJid, pushName: item.pushName || '', text, type, mediaBase64 });
        })().catch(error => console.error('[whatsapp-bot][inbound]', row.id, error.message));
      }
    });
  } catch (error) { row.status = 'error'; row.error = error.message; row.socket = null; throw error; }
  finally { row.starting = false; }
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }), authorized);
app.post('/sessions', async (req, res) => {
  const { id, tenant } = req.body || {};
  if (!uuid.test(id) || !slug.test(tenant)) return res.status(400).json({ error: 'Identificador inválido' });
  let row = sessions.get(id);
  if (row && row.tenant !== tenant) return res.status(409).json({ error: 'Sesión ajena' });
  if (!row) { row = { id, tenant, status: 'starting', qr: '', phone: '' }; sessions.set(id, row); await saveRegistry(); }
  start(row).catch(error => console.error('[whatsapp-bot][start]', id, error.message));
  res.json({ ok: true });
});
app.get('/sessions/:id', (req, res) => {
  const row = sessions.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Sesión no encontrada' });
  res.json({ status: row.status, qr: row.qr, phone: row.phone, error: row.error || '' });
});
app.post('/sessions/:id/send', async (req, res) => {
  const row = sessions.get(req.params.id);
  const phone = String(req.body?.phone || '').replace(/\D/g, '');
  const jid = String(req.body?.jid || (phone ? `${phone}@s.whatsapp.net` : ''));
  const message = String(req.body?.message || '').trim();
  if (!row || row.status !== 'connected') return res.status(409).json({ error: 'WhatsApp no está conectado' });
  if (!/^\d{8,20}@(s\.whatsapp\.net|lid)$/.test(jid) || !message || message.length > 10000) return res.status(400).json({ error: 'Destinatario o mensaje inválido' });
  try {
    const sent = await row.socket.sendMessage(jid, { text: message });
    res.json({ ok: true, messageId: sent?.key?.id || '' });
  } catch (error) { res.status(502).json({ error: error.message }); }
});
app.delete('/sessions/:id', async (req, res) => {
  const row = sessions.get(req.params.id);
  if (!row) return res.json({ ok: true });
  row.removed = true;
  clearTimeout(row.timer);
  sessions.delete(row.id);
  await saveRegistry();
  try { await row.socket?.logout(); } catch { row.socket?.end(); }
  await fs.rm(sessionDir(row), { recursive: true, force: true });
  res.json({ ok: true });
});
async function boot() {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  try {
    const saved = JSON.parse(await fs.readFile(registryPath, 'utf8'));
    for (const item of saved) if (uuid.test(item.id) && slug.test(item.tenant)) {
      const row = { id: item.id, tenant: item.tenant, status: 'starting', qr: '', phone: '' };
      sessions.set(item.id, row);
      start(row).catch(error => console.error('[whatsapp-bot][restore]', item.id, error.message));
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  app.listen(port, '127.0.0.1', () => console.log(`[whatsapp-bot] escuchando en 127.0.0.1:${port}`));
}
if (require.main === module) boot().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { app, boot, incomingContent };
