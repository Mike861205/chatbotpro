const nodemailer = require('nodemailer');
const config = require('../config');

/* ───────────────────── transporte SMTP (singleton) ───────────────────── */

let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;
  if (!config.SMTP_USER || !config.SMTP_PASS) {
    console.error('[mailer] SMTP desactivado: configura SMTP_USER y SMTP_PASS');
    return null;
  }
  _transporter = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_PORT === 465,
    auth: { user: config.SMTP_USER, pass: config.SMTP_PASS },
  });
  return _transporter;
}

async function verifyNotificationMailer() {
  const transport = getTransporter();
  if (!transport) return false;
  if (!config.NOTIFICATION_EMAIL) {
    console.error('[mailer] Notificaciones desactivadas: configura NOTIFICATION_EMAIL');
    return false;
  }
  try {
    await transport.verify();
    console.log(`[mailer] SMTP listo; notificaciones dirigidas a ${config.NOTIFICATION_EMAIL}`);
    return true;
  } catch (error) {
    console.error(`[mailer] SMTP no disponible: ${error.message}`);
    return false;
  }
}

function requireNotificationTransport() {
  const transport = getTransporter();
  if (!transport) throw new Error('SMTP_USER o SMTP_PASS no configurados');
  if (!config.NOTIFICATION_EMAIL) throw new Error('NOTIFICATION_EMAIL no configurado');
  return transport;
}

/* ───────────────────── helpers de formato ───────────────────── */

function formatDate() {
  return new Intl.DateTimeFormat('es-MX', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'America/Mexico_City',
  }).format(new Date());
}

function row(label, value) {
  if (!value) return '';
  return `<tr><td style="padding:8px 12px;font-weight:600;color:#475569;white-space:nowrap;border-bottom:1px solid #e2e8f0">${label}</td><td style="padding:8px 12px;color:#1e293b;border-bottom:1px solid #e2e8f0">${value}</td></tr>`;
}

function emailWrapper(accentColor, title, tableRows) {
  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:560px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1)">
    <div style="background:${accentColor};padding:20px 24px">
      <h1 style="margin:0;color:#fff;font-size:18px;font-weight:700">${title}</h1>
      <p style="margin:6px 0 0;color:rgba(255,255,255,.85);font-size:13px">${formatDate()}</p>
    </div>
    <div style="padding:20px 24px">
      <table style="width:100%;border-collapse:collapse;font-size:14px;line-height:1.5">
        ${tableRows}
      </table>
    </div>
    <div style="padding:12px 24px;background:#f8fafc;text-align:center">
      <p style="margin:0;font-size:12px;color:#94a3b8">ChatBotPro — Panel SuperAdmin</p>
    </div>
  </div>
</body>
</html>`;
}

/* ───────────────────── notificación: nuevo lead demo ───────────────────── */

async function sendLeadNotification({ contactName, phone, phoneCountry, callingCode, businessGiro, sourcePage }) {
  const transport = requireNotificationTransport();

  const sourceLabel = sourcePage === 'login' ? 'Pantalla de Login' : 'Landing Page';
  const tableRows = [
    row('Nombre', contactName),
    row('Teléfono', phone),
    row('País', phoneCountry),
    row('Cód. llamada', callingCode),
    row('Giro del negocio', businessGiro),
    row('Origen', sourceLabel),
  ].filter(Boolean).join('\n');

  const html = emailWrapper('#0ea5e9', '🆕 Nuevo Lead Demo', tableRows);

  await transport.sendMail({
    from: `"ChatBotPro" <${config.SMTP_USER}>`,
    to: config.NOTIFICATION_EMAIL,
    subject: `🆕 Nuevo Lead Demo — ${contactName}`,
    html,
  });
  console.log(`[mailer] Lead demo notificado: ${contactName}`);
  return true;
}

/* ───────────────────── notificación: nuevo registro ───────────────────── */

async function sendRegistrationNotification({ ownerName, phone, phoneCountry, callingCode, businessName, slug, username, timezone }) {
  const transport = requireNotificationTransport();

  const tableRows = [
    row('Dueño', ownerName),
    row('Teléfono', phone),
    row('País', phoneCountry),
    row('Cód. llamada', callingCode),
    row('Negocio', businessName),
    row('Slug', slug),
    row('Usuario', username),
    row('Zona horaria', timezone),
  ].filter(Boolean).join('\n');

  const html = emailWrapper('#16a34a', '🎉 Nuevo Registro de Prospecto', tableRows);

  await transport.sendMail({
    from: `"ChatBotPro" <${config.SMTP_USER}>`,
    to: config.NOTIFICATION_EMAIL,
    subject: `🎉 Nuevo Registro — ${businessName} (${ownerName})`,
    html,
  });
  console.log(`[mailer] Registro notificado: ${businessName} (${ownerName})`);
  return true;
}

module.exports = { verifyNotificationMailer, sendLeadNotification, sendRegistrationNotification };
