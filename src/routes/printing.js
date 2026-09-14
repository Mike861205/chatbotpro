const fs = require('node:fs');
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { signQzRequest } = require('../utils/qzSigning');

const router = express.Router();

router.use(requireAuth);

function configuredPem(valueName, pathName) {
  const inlineValue = String(process.env[valueName] || '').replace(/\\n/g, '\n').trim();
  if (inlineValue) return inlineValue;
  const filePath = String(process.env[pathName] || '').trim();
  if (!filePath) return '';
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return '';
  }
}

function qzCredentials() {
  return {
    certificate: configuredPem('QZ_CERTIFICATE', 'QZ_CERTIFICATE_PATH'),
    privateKey: configuredPem('QZ_PRIVATE_KEY', 'QZ_PRIVATE_KEY_PATH'),
  };
}

router.get('/qz-status', (req, res) => {
  const credentials = qzCredentials();
  res.json({ signed: Boolean(credentials.certificate && credentials.privateKey) });
});

router.get('/qz-certificate', (req, res) => {
  const { certificate } = qzCredentials();
  if (!certificate) return res.status(404).type('text/plain').send('Certificado QZ no configurado');
  res.type('text/plain').send(certificate);
});

router.post('/qz-sign', express.text({ type: 'text/plain', limit: '512kb' }), (req, res) => {
  const { privateKey } = qzCredentials();
  if (!privateKey) return res.status(404).json({ error: 'Firma QZ no configurada' });
  const request = String(req.body || '');
  try {
    const signature = signQzRequest(request, privateKey);
    return res.type('text/plain').send(signature);
  } catch (error) {
    if (/Solicitud QZ inválida|Operación QZ no permitida/.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    return res.status(500).json({ error: 'No se pudo firmar la solicitud QZ' });
  }
});

module.exports = router;
