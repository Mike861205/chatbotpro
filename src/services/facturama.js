const config = require('../config');

class FacturamaError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'FacturamaError';
    this.status = options.status || 502;
    this.providerStatus = options.providerStatus || 0;
    this.details = options.details || null;
    this.uncertain = Boolean(options.uncertain);
  }
}

function flattenProviderError(payload) {
  if (!payload) return '';
  if (typeof payload === 'string') return payload.trim();
  const messages = [];
  for (const key of ['Message', 'message', 'ExceptionMessage', 'error_description', 'error']) {
    if (payload[key]) messages.push(String(payload[key]));
  }
  const modelState = payload.ModelState || payload.modelState;
  if (modelState && typeof modelState === 'object') {
    Object.values(modelState).flat().forEach((value) => {
      if (value) messages.push(String(value));
    });
  }
  return [...new Set(messages)].join(' · ').slice(0, 900);
}

class FacturamaClient {
  constructor(options = {}) {
    this.username = String(options.username ?? config.FACTURAMA_USERNAME ?? '').trim();
    this.password = String(options.password ?? config.FACTURAMA_PASSWORD ?? '');
    this.baseUrl = String(options.baseUrl ?? config.FACTURAMA_BASE_URL ?? '').replace(/\/+$/, '');
    this.timeoutMs = Number(options.timeoutMs || config.FACTURAMA_TIMEOUT_MS || 25000);
  }

  isConfigured() {
    return Boolean(this.username && this.password && /^https:\/\//i.test(this.baseUrl));
  }

  async request(path, options = {}) {
    if (!this.isConfigured()) {
      throw new FacturamaError('Configura las credenciales de Facturama en el servidor', { status: 503 });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const method = options.method || 'GET';
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.username}:${this.password}`, 'utf8').toString('base64')}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': this.username,
          ...(options.headers || {}),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      const raw = await response.text();
      let payload = null;
      if (raw) {
        try { payload = JSON.parse(raw); } catch { payload = raw; }
      }
      if (!response.ok) {
        const providerMessage = flattenProviderError(payload);
        const fallbackMessage = response.status === 401
          ? 'Facturama rechazó las credenciales de API del ambiente configurado'
          : `Facturama respondió HTTP ${response.status}`;
        throw new FacturamaError(providerMessage || fallbackMessage, {
          status: response.status >= 400 && response.status < 500 ? 422 : 502,
          providerStatus: response.status,
          details: payload,
        });
      }
      return payload;
    } catch (error) {
      if (error instanceof FacturamaError) throw error;
      const uncertain = method !== 'GET';
      const reason = error?.name === 'AbortError' ? 'tiempo de espera agotado' : 'conexión no disponible';
      throw new FacturamaError(`No se pudo confirmar la operación con Facturama: ${reason}`, {
        status: 502,
        uncertain,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  createCfdi(payload, apiMode = 'multi') {
    const endpoint = apiMode === 'web' ? '/3/cfdis' : '/api-lite/3/cfdis';
    return this.request(endpoint, { method: 'POST', body: payload });
  }

  getCfdi(id, apiMode = 'multi') {
    return apiMode === 'web'
      ? this.request(`/api/cfdi/${encodeURIComponent(id)}?type=issued`)
      : this.request(`/api-lite/cfdis/${encodeURIComponent(id)}`);
  }

  downloadCfdi(id, format, apiMode = 'multi') {
    const safeFormat = format === 'xml' ? 'xml' : 'pdf';
    const type = apiMode === 'web' ? 'issued' : 'issuedLite';
    return this.request(`/cfdi/${safeFormat}/${type}/${encodeURIComponent(id)}`);
  }

  cancelCfdi(id, motive = '02', uuidReplacement = '', apiMode = 'multi') {
    const query = new URLSearchParams({ motive });
    if (uuidReplacement) query.set('uuidReplacement', uuidReplacement);
    if (apiMode === 'web') {
      query.set('type', 'issued');
      return this.request(`/api/cfdi/${encodeURIComponent(id)}?${query}`, { method: 'DELETE' });
    }
    return this.request(`/api-lite/cfdis/${encodeURIComponent(id)}?${query}`, { method: 'DELETE' });
  }

  uploadCsd({ rfc, certificate, privateKey, privateKeyPassword }) {
    return this.request('/api-lite/csds', {
      method: 'POST',
      body: { Rfc: rfc, Certificate: certificate, PrivateKey: privateKey, PrivateKeyPassword: privateKeyPassword },
    });
  }
}

module.exports = { FacturamaClient, FacturamaError, flattenProviderError };
