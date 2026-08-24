(() => {
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  const segments = location.pathname.split('/').filter(Boolean);
  const isInvoiceDomain = location.hostname.toLowerCase().startsWith('facturacion.');
  const slug = isInvoiceDomain ? segments[0] : segments.at(-1);
  const apiBase = `/api/invoicing/public/${encodeURIComponent(slug || '')}`;
  const steps = ['lookup', 'receiver', 'success'];
  let currentTicket = null;
  let currentInvoice = null;
  let currentPortal = null;
  let portalAvailable = false;

  function formatMoney(value) {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(Number(value || 0));
  }

  function formatDate(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }

  function setText(selector, value) {
    const element = $(selector);
    if (element) element.textContent = String(value || '');
  }

  function message(text = '', type = 'error') {
    const element = $('#portalMessage');
    element.replaceChildren();
    element.hidden = !text;
    element.classList.toggle('success-message', type === 'success');
    if (!text) return;
    const icon = document.createElement('i');
    icon.className = type === 'success' ? 'ph-bold ph-check-circle' : 'ph-bold ph-warning-circle';
    const content = document.createElement('span');
    content.textContent = text;
    element.append(icon, content);
  }

  async function request(path, options = {}) {
    const response = await fetch(`${apiBase}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'No se pudo completar la solicitud');
    return data;
  }

  function setBusy(form, busy) {
    if (!form) return;
    form.classList.toggle('is-busy', busy);
    const button = form.querySelector('button[type="submit"]');
    if (button) button.disabled = busy;
  }

  function showSection(section) {
    $('#lookupStep').hidden = section !== 'lookup';
    $('#receiverStep').hidden = section !== 'receiver';
    $('#successStep').hidden = section !== 'success';
    document.body.dataset.portalStep = section;
    const activeIndex = steps.indexOf(section);
    $$('[data-progress-step]').forEach((element) => {
      const index = steps.indexOf(element.dataset.progressStep);
      element.classList.toggle('active', index === activeIndex);
      element.classList.toggle('complete', index < activeIndex);
      const marker = element.querySelector(':scope > span');
      if (marker) marker.textContent = index < activeIndex ? '✓' : String(index + 1);
    });
  }

  function setLogo(imageSelector, fallbackSelector, source, businessName) {
    const image = $(imageSelector);
    const fallback = $(fallbackSelector);
    if (!source) {
      image.hidden = true;
      fallback.hidden = false;
      return;
    }
    image.alt = `Logo de ${businessName}`;
    image.onload = () => {
      image.hidden = false;
      fallback.hidden = true;
    };
    image.onerror = () => {
      image.hidden = true;
      fallback.hidden = false;
    };
    image.src = source;
  }

  function normalizeWhatsapp(value) {
    let digits = String(value || '').replace(/\D/g, '');
    if (digits.length === 10) digits = `52${digits}`;
    return digits.length >= 10 && digits.length <= 15 ? digits : '';
  }

  function formatInvoiceCode(value) {
    const raw = String(value || '').trim();
    if (/^[0-9a-f-]{36}$/i.test(raw)) return raw;
    const compact = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    return compact.length > 4 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : compact;
  }

  function applyBusiness(portal) {
    const business = portal.business || {};
    const name = business.name || 'Portal de facturación';
    const brand = /^#[0-9a-f]{6}$/i.test(business.primaryColor || '') ? business.primaryColor : '#6c47ff';
    setText('#businessName', name);
    setText('#mobileBusinessName', name);
    document.title = `Facturación · ${name}`;
    document.documentElement.style.setProperty('--brand', brand);
    const theme = $('meta[name="theme-color"]');
    if (theme) theme.content = brand;
    setLogo('#businessLogo', '#businessLogoFallback', business.logo, name);
    setLogo('#mobileBusinessLogo', '#mobileLogoFallback', business.logo, name);

    let hasDetails = false;
    if (portal.issuer) {
      setText('#issuerLegalName', portal.issuer.legalName || name);
      setText('#issuerRfc', [portal.issuer.rfc && `RFC ${portal.issuer.rfc}`, portal.issuer.postalCode && `CP ${portal.issuer.postalCode}`].filter(Boolean).join(' · '));
      $('#issuerDetail').hidden = false;
      hasDetails = true;
    }
    if (business.address) {
      setText('#businessAddress', business.address);
      $('#addressDetail').hidden = false;
      hasDetails = true;
    }
    if (business.hours) {
      setText('#businessHours', business.hours);
      $('#hoursDetail').hidden = false;
      hasDetails = true;
    }
    const whatsapp = normalizeWhatsapp(business.whatsapp);
    if (whatsapp) {
      const link = $('#businessWhatsapp');
      link.href = `https://wa.me/${whatsapp}?text=${encodeURIComponent(`Hola, necesito ayuda para facturar un ticket de ${name}.`)}`;
      link.hidden = false;
      hasDetails = true;
    }
    $('#businessDetails').hidden = !hasDetails;

    const badge = $('#environmentBadge');
    const sandbox = portal.environment === 'sandbox';
    badge.className = `environment ${sandbox ? 'sandbox' : 'production'}`;
    badge.replaceChildren();
    const icon = document.createElement('i');
    icon.className = sandbox ? 'ph-bold ph-flask' : 'ph-bold ph-seal-check';
    badge.append(icon, document.createTextNode(sandbox ? ' Ambiente de pruebas' : ' Facturación activa'));
  }

  function setUnavailable(text, blocking = true) {
    portalAvailable = false;
    $('#portalUnavailable').hidden = false;
    document.body.classList.toggle('portal-unavailable', blocking);
    const description = $('#portalUnavailable p');
    if (text && description) description.textContent = text;
    if (blocking) $$('#lookupForm input, #lookupForm button').forEach((element) => { element.disabled = true; });
  }

  function applyGenericReceiverDefaults() {
    if ($('#receiverRfc').value.trim().toUpperCase() !== 'XAXX010101000') return;
    $('#receiverName').value = 'PUBLICO EN GENERAL';
    $('#receiverRegime').value = '616';
    $('#receiverUse').value = 'S01';
    const expeditionPostalCode = currentTicket?.expeditionPostalCode || currentPortal?.issuer?.postalCode;
    if (expeditionPostalCode) $('#receiverPostal').value = expeditionPostalCode;
  }

  function renderTicketSummary(ticket) {
    const summary = $('#ticketSummary');
    summary.replaceChildren();

    const head = document.createElement('div');
    head.className = 'ticket-summary-head';
    const identity = document.createElement('div');
    const label = document.createElement('span');
    label.textContent = formatDate(ticket.createdAt) || 'Compra encontrada';
    const number = document.createElement('strong');
    number.textContent = `Ticket #${ticket.id}`;
    identity.append(label, number);
    const total = document.createElement('div');
    total.className = 'ticket-summary-total';
    total.textContent = formatMoney(ticket.total);
    head.append(identity, total);
    summary.append(head);

    const items = document.createElement('div');
    items.className = 'ticket-items';
    (ticket.items || []).forEach((item) => {
      const row = document.createElement('div');
      row.className = 'ticket-item';
      const quantity = document.createElement('b');
      quantity.textContent = `${Number(item.qty || 0)}×`;
      const name = document.createElement('span');
      name.textContent = item.name || 'Producto';
      const amount = document.createElement('span');
      amount.textContent = formatMoney(Number(item.qty || 0) * Number(item.price || 0));
      row.append(quantity, name, amount);
      items.append(row);
    });
    summary.append(items);
  }

  function invoiceDownloads(invoice, token) {
    currentInvoice = invoice;
    const suffix = `?code=${encodeURIComponent(token)}`;
    $('#downloadPdf').href = `${apiBase}/invoices/${invoice.id}/pdf${suffix}`;
    $('#downloadXml').href = `${apiBase}/invoices/${invoice.id}/xml${suffix}`;
    setText('#invoiceIdentity', invoice.uuid ? `UUID · ${invoice.uuid}` : `Serie ${invoice.series || '—'} · Folio ${invoice.folio || '—'}`);
    const receiverEmail = String($('#receiverEmail')?.value || invoice.receiver?.email || '').trim();
    $('#invoiceEmail').value = receiverEmail;
    const emailStatus = $('#invoiceEmailStatus');
    emailStatus.hidden = true;
    emailStatus.textContent = '';
    message('');
    showSection('success');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function lookup(ticket, token) {
    const data = await request('/lookup', { method: 'POST', body: JSON.stringify({ ticket, code: token }) });
    currentTicket = { ticket: Number(ticket), token, ...data.ticket };
    if (data.invoice?.status === 'active') {
      invoiceDownloads(data.invoice, token);
      return;
    }
    if (data.invoice?.status === 'global_active') throw new Error('Este ticket ya está incluido en una factura global del negocio. Comunícate con el establecimiento si necesitas una factura individual.');
    if (data.invoice?.status === 'global_pending') throw new Error('Este ticket está reservado en una factura global en proceso. Intenta nuevamente más tarde o comunícate con el negocio.');
    if (['pending', 'unknown'].includes(data.invoice?.status)) throw new Error('La factura de este ticket está en proceso de validación. Intenta nuevamente en unos minutos.');
    if (data.invoice?.status === 'cancel_pending') throw new Error('La factura de este ticket tiene una cancelación en proceso. Comunícate con el negocio.');
    if (data.invoice?.status === 'canceled') throw new Error('La factura asociada a este ticket fue cancelada. Comunícate con el negocio.');
    renderTicketSummary(data.ticket);
    applyGenericReceiverDefaults();
    showSection('receiver');
    $('#receiverStep').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function initialize() {
    try {
      const portal = await request('');
      currentPortal = portal;
      applyBusiness(portal);
      portalAvailable = Boolean(portal.available);
      if (!portalAvailable) {
        setUnavailable(portal.unavailableReason || '', false);
        portalAvailable = true;
      }
      const params = new URLSearchParams(location.search);
      if (params.get('ticket')) $('#ticket').value = params.get('ticket');
      const invoiceCode = params.get('code') || params.get('token');
      if (invoiceCode) $('#token').value = formatInvoiceCode(invoiceCode);
      if (params.get('ticket') && invoiceCode) {
        setBusy($('#lookupForm'), true);
        try { await lookup(params.get('ticket'), invoiceCode); }
        catch (error) { message(error.message); }
        finally { setBusy($('#lookupForm'), false); }
      }
    } catch (error) {
      setText('#businessName', 'Portal de facturación');
      setText('#mobileBusinessName', 'Portal de facturación');
      setUnavailable('No fue posible cargar la información del negocio. Verifica que el enlace sea correcto o intenta nuevamente más tarde.');
      message(error.message);
    }
  }

  document.addEventListener('DOMContentLoaded', initialize);

  $('#lookupForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!portalAvailable) return;
    message('');
    setBusy(form, true);
    try { await lookup($('#ticket').value, $('#token').value.trim()); }
    catch (error) { message(error.message); }
    finally { setBusy(form, false); }
  });

  $('#invoiceForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    message('');
    setBusy(form, true);
    try {
      if (!currentTicket) throw new Error('Busca primero tu ticket');
      const data = await request('/issue', {
        method: 'POST',
        body: JSON.stringify({
          ticket: currentTicket.ticket,
          code: currentTicket.token,
          conceptMode: form.elements.conceptMode.value,
          receiver: {
            rfc: $('#receiverRfc').value.trim().toUpperCase(),
            name: $('#receiverName').value.trim(),
            fiscalRegime: $('#receiverRegime').value,
            postalCode: $('#receiverPostal').value.trim(),
            cfdiUse: $('#receiverUse').value,
            email: $('#receiverEmail').value.trim(),
          },
        }),
      });
      if (data.invoice?.status !== 'active') throw new Error('El CFDI quedó en proceso de validación. Intenta consultar nuevamente este ticket en unos minutos.');
      invoiceDownloads(data.invoice, currentTicket.token);
    } catch (error) { message(error.message); }
    finally { setBusy(form, false); }
  });

  $('#receiverRfc').addEventListener('input', (event) => {
    event.currentTarget.value = event.currentTarget.value.toUpperCase().replace(/[^A-ZÑ&0-9]/g, '').slice(0, 13);
    applyGenericReceiverDefaults();
  });

  $('#receiverPostal').addEventListener('input', (event) => {
    event.currentTarget.value = event.currentTarget.value.replace(/\D/g, '').slice(0, 5);
  });

  $('#token').addEventListener('blur', (event) => {
    event.currentTarget.value = formatInvoiceCode(event.currentTarget.value);
  });

  $('#invoiceAnother').addEventListener('click', () => {
    currentTicket = null;
    currentInvoice = null;
    $('#lookupForm').reset();
    $('#invoiceForm').reset();
    message('');
    showSection('lookup');
    history.replaceState({}, '', location.pathname);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  $('#invoiceEmailForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const status = $('#invoiceEmailStatus');
    status.hidden = true;
    status.textContent = '';
    setBusy(form, true);
    try {
      if (!currentInvoice || !currentTicket) throw new Error('Primero genera o consulta tu factura');
      const data = await request(`/invoices/${currentInvoice.id}/email`, {
        method: 'POST',
        body: JSON.stringify({ code: currentTicket.token, email: $('#invoiceEmail').value.trim() }),
      });
      status.className = 'email-delivery-status success';
      status.textContent = data.message || 'Factura enviada correctamente';
      status.hidden = false;
    } catch (error) {
      status.className = 'email-delivery-status error';
      status.textContent = error.message;
      status.hidden = false;
    } finally {
      setBusy(form, false);
    }
  });

  $('#backToLookup').addEventListener('click', () => {
    message('');
    showSection('lookup');
    $('#ticket').focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
})();
