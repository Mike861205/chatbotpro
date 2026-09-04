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
    this.branchOfficeCache = null;
    this.branchOfficeCacheAt = 0;
  }

  async webExpeditionPostalCode(preferred = '') {
    const now = Date.now();
    if (!this.branchOfficeCache || now - this.branchOfficeCacheAt > 5 * 60 * 1000) {
      const offices = await this.request('/api/BranchOffice');
      this.branchOfficeCache = Array.isArray(offices) ? offices : [];
      this.branchOfficeCacheAt = now;
    }
    const postalCodes = this.branchOfficeCache
      .map((office) => String(office?.Address?.ZipCode || '').trim())
      .filter((postalCode) => /^\d{5}$/.test(postalCode));
    const requested = String(preferred || '').trim();
    if (postalCodes.includes(requested)) return requested;
    if (postalCodes[0]) return postalCodes[0];
    throw new FacturamaError('Configura al menos un lugar de expedición en el perfil de Facturama', { status: 409 });
  }

  async ensureWebIssuanceContext(preferredPostalCode = '', preferredSeries = 'TEST') {
    await this.webExpeditionPostalCode(preferredPostalCode);
    const requestedPostalCode = String(preferredPostalCode || '').trim();
    const office = this.branchOfficeCache.find((item) => String(item?.Address?.ZipCode || '').trim() === requestedPostalCode)
      || this.branchOfficeCache.find((item) => /^\d{5}$/.test(String(item?.Address?.ZipCode || '').trim()));
    if (!office?.Id) throw new FacturamaError('Configura un lugar de expedición válido en Facturama', { status: 409 });
    const safeSeries = String(preferredSeries || 'TEST').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) || 'TEST';
    let series = await this.request(`/api/serie/${encodeURIComponent(office.Id)}`);
    series = Array.isArray(series) ? series : [];
    let selected = series.find((item) => String(item?.Name || '').toUpperCase() === safeSeries) || series[0];
    if (!selected) {
      selected = await this.request(`/api/serie/${encodeURIComponent(office.Id)}`, {
        method: 'POST',
        body: { IdBranchOffice: office.Id, Name: safeSeries, Description: 'ChatBotPro Sandbox', Folio: 1 },
      });
    }
    return {
      postalCode: String(office.Address.ZipCode).trim(),
      series: String(selected?.Name || safeSeries).trim(),
    };
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

  validateReceiver({ rfc, name, postalCode, fiscalRegime }) {
    return this.request('/customers/validate', {
      method: 'POST',
      body: {
        Rfc: String(rfc || '').trim().toUpperCase(),
        Name: String(name || '').trim().toUpperCase(),
        ZipCode: String(postalCode || '').trim(),
        FiscalRegime: String(fiscalRegime || '').trim(),
      },
    });
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

  downloadCancellationReceipt(id, format = 'pdf', apiMode = 'multi') {
    const safeFormat = ['pdf', 'html'].includes(format) ? format : 'pdf';
    const type = apiMode === 'web' ? 'issued' : 'issuedLite';
    return this.request(`/acuse/${safeFormat}/${type}/${encodeURIComponent(id)}`);
  }

  listIssuedCfdis({ folio = '', series = '', rfcIssuer = '', apiMode = 'multi' } = {}) {
    const query = new URLSearchParams({
      type: apiMode === 'web' ? 'issued' : 'issuedLite',
      status: 'all',
      page: '0',
    });
    if (folio) query.set('folio', String(folio));
    if (series) query.set('serie', String(series));
    if (rfcIssuer && apiMode !== 'web') query.set('rfcIssuer', String(rfcIssuer));
    return this.request(`/cfdi?${query}`);
  }

  async sendCfdiEmail(id, email, apiMode = 'multi', options = {}) {
    const query = new URLSearchParams({
      CfdiType: apiMode === 'web' ? 'issued' : 'issuedLite',
      CfdiId: String(id || ''),
      Email: String(email || ''),
    });
    if (options.subject) query.set('Subject', String(options.subject).slice(0, 180));
    if (options.comments) query.set('Comments', String(options.comments).slice(0, 500));
    if (options.issuerEmail) query.set('IssuerEmail', String(options.issuerEmail));
    query.set('IncludePayBtn', 'false');
    const response = await this.request(`/Cfdi?${query}`, { method: 'POST' });
    const success = response?.success ?? response?.Success;
    if (success === false) {
      throw new FacturamaError(String(response?.msj || response?.Message || 'Facturama no pudo enviar el CFDI'), {
        status: 422,
        details: response,
      });
    }
    return response;
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

function createConfiguredFacturamaClients() {
  return Object.freeze({
    sandbox: new FacturamaClient({
      username: config.FACTURAMA_SANDBOX_USERNAME,
      password: config.FACTURAMA_SANDBOX_PASSWORD,
      baseUrl: config.FACTURAMA_SANDBOX_BASE_URL,
    }),
    production: new FacturamaClient({
      username: config.FACTURAMA_PRODUCTION_USERNAME,
      password: config.FACTURAMA_PRODUCTION_PASSWORD,
      baseUrl: config.FACTURAMA_PRODUCTION_BASE_URL,
    }),
  });
}

module.exports = { FacturamaClient, FacturamaError, flattenProviderError, createConfiguredFacturamaClients };
