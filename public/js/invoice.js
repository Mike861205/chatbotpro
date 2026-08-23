(() => {
  const $ = (selector) => document.querySelector(selector);
  const segments = location.pathname.split('/').filter(Boolean);
  const slug = location.hostname.toLowerCase().startsWith('facturacion.') ? segments[0] : segments.at(-1);
  const apiBase = `/api/invoicing/public/${encodeURIComponent(slug || '')}`;
  let currentTicket = null;

  function message(text = '') {
    const el = $('#portalMessage');
    el.textContent = text;
    el.hidden = !text;
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
    const button = form.querySelector('button[type="submit"]');
    if (button) button.disabled = busy;
  }
  function invoiceDownloads(invoice, token) {
    const suffix = `?token=${encodeURIComponent(token)}`;
    $('#downloadPdf').href = `${apiBase}/invoices/${invoice.id}/pdf${suffix}`;
    $('#downloadXml').href = `${apiBase}/invoices/${invoice.id}/xml${suffix}`;
    $('#invoiceIdentity').textContent = invoice.uuid ? `UUID: ${invoice.uuid}` : `Serie ${invoice.series || ''} · Folio ${invoice.folio || ''}`;
    $('#lookupStep').hidden = true;
    $('#receiverStep').hidden = true;
    $('#successStep').hidden = false;
  }
  async function lookup(ticket, token) {
    const data = await request('/lookup', { method: 'POST', body: JSON.stringify({ ticket, token }) });
    currentTicket = { ticket: Number(ticket), token, ...data.ticket };
    if (data.invoice && ['active', 'canceled', 'cancel_pending'].includes(data.invoice.status)) {
      invoiceDownloads(data.invoice, token);
      return;
    }
    const names = (data.ticket.items || []).map((item) => `${item.qty}× ${item.name}`).join(', ');
    $('#ticketSummary').innerHTML = `<span class="total">$${Number(data.ticket.total).toFixed(2)}</span><b>Ticket #${data.ticket.id}</b><br>${names}`;
    $('#receiverStep').hidden = false;
    $('#receiverStep').scrollIntoView({ behavior: 'smooth' });
  }

  document.addEventListener('DOMContentLoaded', async () => {
    try {
      const portal = await request('');
      if (!portal.available) throw new Error('Este negocio todavía no ha activado su facturación electrónica.');
      $('#businessName').textContent = portal.business.name;
      document.title = `Facturación · ${portal.business.name}`;
      document.documentElement.style.setProperty('--brand', portal.business.primaryColor || '#6c47ff');
      $('#environmentBadge').textContent = portal.environment === 'sandbox' ? 'Pruebas SAT' : 'Producción';
      if (portal.business.logo) {
        $('#businessLogo').src = portal.business.logo;
        $('#businessLogo').hidden = false;
        $('.logo-wrap i').hidden = true;
      }
      const params = new URLSearchParams(location.search);
      if (params.get('ticket')) $('#ticket').value = params.get('ticket');
      if (params.get('token')) $('#token').value = params.get('token');
      if (params.get('ticket') && params.get('token')) await lookup(params.get('ticket'), params.get('token'));
    } catch (error) { message(error.message); }
  });

  $('#lookupForm').addEventListener('submit', async (event) => {
    event.preventDefault(); message(''); setBusy(event.currentTarget, true);
    try { await lookup($('#ticket').value, $('#token').value.trim()); }
    catch (error) { message(error.message); }
    finally { setBusy(event.currentTarget, false); }
  });
  $('#invoiceForm').addEventListener('submit', async (event) => {
    event.preventDefault(); message(''); setBusy(event.currentTarget, true);
    try {
      if (!currentTicket) throw new Error('Busca primero tu ticket');
      const data = await request('/issue', {
        method: 'POST',
        body: JSON.stringify({
          ticket: currentTicket.ticket,
          token: currentTicket.token,
          receiver: {
            rfc: $('#receiverRfc').value,
            name: $('#receiverName').value,
            fiscalRegime: $('#receiverRegime').value,
            postalCode: $('#receiverPostal').value,
            cfdiUse: $('#receiverUse').value,
            email: $('#receiverEmail').value,
          },
        }),
      });
      invoiceDownloads(data.invoice, currentTicket.token);
    } catch (error) { message(error.message); }
    finally { setBusy(event.currentTarget, false); }
  });
})();
