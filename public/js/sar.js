// Panel de facturación para tenants cuyo país registrado es Honduras.
(() => {
  const $sar = (selector) => document.querySelector(selector);
  const value = (form, name) => form.elements.namedItem(name)?.value?.trim() || '';
  const formJson = (form) => Object.fromEntries(new FormData(form).entries());
  const fmt = (amount) => `L ${Number(amount || 0).toFixed(2)}`;
  const date = (raw) => raw ? String(raw).slice(0, 10).split('-').reverse().join('/') : '—';
  const timestampDate = (raw) => raw ? new Date(raw).toLocaleDateString('es-HN', { timeZone:'America/Tegucigalpa' }) : '—';
  const table = (headers, rows) => `<table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${headers.length}" class="hint">Sin registros</td></tr>`}</tbody></table>`;
  const sendJson = (url, body) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let lastReport = null;

  async function loadSar() {
    if (ME?.tenant?.phoneCountry !== 'HN' || ME?.role !== 'owner') return;
    if (!$sar('#sarReportTo').value) $sar('#sarReportTo').value = getLocalIsoDate();
    if (!$sar('#sarReportFrom').value) $sar('#sarReportFrom').value = `${getLocalIsoDate().slice(0,7)}-01`;
    if (!$sar('#sarFilingPeriod').value) $sar('#sarFilingPeriod').value = getLocalIsoDate().slice(0,7);
    const data = await api('/api/sar/overview');
    const profile = data.profile || {};
    const form = $sar('#sarProfileForm');
    for (const [input, key] of Object.entries({ rtn:'rtn', legalName:'legal_name', tradeName:'trade_name', address:'address', phone:'phone', deliveryTaxCategory:'delivery_tax_category' })) {
      const el = form.elements.namedItem(input);
      if (el && document.activeElement !== el) el.value = profile[key] || '';
    }
    $sar('#sarBranch').innerHTML = data.branches.map((b) => `<option value="${Number(b.id)}">${esc(b.name)}</option>`).join('');
    const usable = data.authorizations.filter((a) => a.status === 'active' && a.compatible && !a.expired && Number(a.remaining) > 0);
    const remaining = usable.filter((a) => a.document_type === '01').reduce((sum, a) => sum + Number(a.remaining), 0);
    const creditRemaining = usable.filter((a) => a.document_type === '07').reduce((sum, a) => sum + Number(a.remaining), 0);
    $sar('#sarSummary').innerHTML = `<b>${remaining} facturas y ${creditRemaining} notas de crédito disponibles</b>. ${remaining <= 50 ? '<b>Solicita un nuevo rango de facturas antes de agotarlo.</b> ' : ''}${creditRemaining <= 10 ? '<b>Revisa el rango de notas de crédito.</b> ' : ''}${Number(data.unclassified)} producto(s) activo(s) pendientes de clasificar. ${Number(data.report.issued_count)} factura(s) registradas; ${Number(data.report.annulled_count)} anulada(s).`;
    $sar('#sarRanges').innerHTML = table(['Sucursal','CAI','Serie','Rango','Siguiente','Disponibles','Vence','Estado','SAR-927'], data.authorizations.map((a) => `<tr><td>${esc(a.branch_name || '—')}</td><td>${esc(a.cai)}</td><td>${esc(a.establishment)}-${esc(a.emission_point)}-${esc(a.document_type)}</td><td>${a.range_start}–${a.range_end}</td><td>${a.next_number}</td><td><b>${a.remaining}</b></td><td>${date(a.expires_on)}</td><td>${a.status === 'invalid' ? 'Registro invalidado' : !a.compatible ? 'Emisor cambió' : a.expired ? 'Vencida' : a.remaining <= 0 ? 'Agotada' : esc(a.status)}</td><td>${a.source_name ? `<a href="/api/sar/authorizations/${a.id}/pdf" target="_blank">Descargar</a>` : '—'} ${a.status === 'active' && Number(a.next_number) === Number(a.range_start) ? `<button class="btn btn-ghost sar-invalidate" data-id="${a.id}" type="button">Corregir registro</button>` : ''}</td></tr>`).join(''));
    $sar('#sarSales').innerHTML = table(['Venta','Fecha','Sucursal','Total','Estado','Receptor / RTN','Acción'], data.sales.map((sale) => {
      let items = [];
      try { items = typeof sale.items === 'string' ? JSON.parse(sale.items || '[]') : sale.items || []; } catch { items = []; }
      const unclassified = items.filter((item) => !['exempt','tax15','tax18'].includes(item.sarTaxCategory || item.sar_tax_category)).length;
      const eligible = sale.payment_status === 'paid' || sale.payment_method === 'credit';
      const status = sale.sar_document_id && sale.sar_status === 'issued' ? `${esc(sale.sar_status)} · ${esc(sale.sar_document_number)}` : eligible ? (unclassified ? `${unclassified} producto(s) sin ISV` : 'Lista') : 'Pendiente de cobro';
      const action = sale.sar_status === 'issued' ? 'Emitida' : `<button type="button" class="btn btn-ghost sar-issue" data-order="${sale.id}" ${!eligible || unclassified ? 'disabled' : ''}>Emitir factura</button>`;
      const ex = sale.sarExoneration;
      return `<tr><td>#${sale.id}</td><td>${timestampDate(sale.created_at)}</td><td>${esc(sale.service_branch_name || '—')}</td><td>${fmt(sale.total)}</td><td>${status}${ex ? `<br>Exonerada · ${esc(ex.evidenceType)} ${esc(ex.evidenceNumber)}` : ''}</td><td><input class="sar-receiver-name" placeholder="Consumidor final" value="${esc(ex?.name || 'Consumidor final')}" aria-label="Nombre receptor"><input class="sar-receiver-rtn" placeholder="RTN opcional" maxlength="14" value="${esc(ex?.rtn || '')}" aria-label="RTN receptor"><input class="sar-receiver-id" placeholder="Identidad si aplica" maxlength="30" aria-label="Identidad receptor"></td><td>${ex && !sale.sar_exoneration_proof_name ? `<input class="sar-proof-file" type="file" accept="application/pdf" aria-label="Constancia PDF"><button type="button" class="btn btn-ghost sar-proof" data-order="${sale.id}">Adjuntar constancia</button>` : ex ? `<span>Constancia: ${esc(sale.sar_exoneration_proof_name)}</span><br>` : ''}${action}</td></tr>`;
    }).join(''));
    $sar('#sarDocuments').innerHTML = table(['Factura','Venta','Fecha','Total','Estado','Acciones'], data.documents.map((d) => `<tr><td>${esc(d.document_number)}</td><td>#${d.order_id}</td><td>${timestampDate(d.issued_at)}</td><td>${fmt(d.order_total)}</td><td>${esc(d.status)}</td><td><a class="btn btn-ghost" href="/api/sar/documents/${d.id}/print" target="_blank" rel="noopener">Imprimir</a> ${d.status === 'issued' ? `<button type="button" class="btn btn-ghost sar-credit-create" data-id="${d.id}">Nota de crédito</button> <button type="button" class="btn btn-ghost sar-annul" data-id="${d.id}">Anular</button>` : ''}</td></tr>`).join(''));
    $sar('#sarCreditNotes').innerHTML = table(['Nota','Factura','Fecha','Importe','Motivo','Devolución','Acciones'], data.creditNotes.map((n) => `<tr><td>${esc(n.document_number)}${n.status === 'annulled' ? ' · ANULADA' : ''}</td><td>#${n.order_id}</td><td>${timestampDate(n.issued_at)}</td><td>${fmt(n.totals?.total)}</td><td>${esc(n.reason)}</td><td>${n.refund_status === 'completed' ? `${esc(n.refund_method)}${n.restocked ? ' · Stock repuesto' : ''}` : n.status === 'issued' ? `<select class="sar-refund-method" aria-label="Medio de devolución">${n.payment_status === 'pending' && n.payment_method === 'credit' ? '<option value="credit_balance">Reducir crédito pendiente</option>' : '<option value="cash">Efectivo</option><option value="card">Tarjeta</option><option value="transfer">Transferencia</option>'}</select><input class="sar-refund-reference" placeholder="Referencia para tarjeta/transferencia" aria-label="Referencia devolución"><label><input type="checkbox" class="sar-refund-restock"> Reponer stock vendible</label>` : '—'}</td><td><a class="btn btn-ghost" href="/api/sar/credit-notes/${n.id}/print" target="_blank" rel="noopener">Imprimir</a>${n.status === 'issued' && n.refund_status === 'pending' ? ` <button type="button" class="btn btn-ghost sar-refund" data-id="${n.id}">Registrar devolución</button> <button type="button" class="btn btn-ghost sar-credit-annul" data-id="${n.id}">Anular</button>` : ''}</td></tr>`).join(''));
    $sar('#sarPurchases').innerHTML = table(['ID / tipo','Proveedor','RTN','Documento','Fecha','Total','Vínculo','Estado','PDF'], data.purchases.map((p) => `<tr><td>#${p.id} · ${p.document_type}</td><td>${esc(p.supplier_name)}</td><td>${esc(p.supplier_rtn)}</td><td>${esc(p.document_number)}</td><td>${date(p.issued_on)}</td><td>${p.document_type === '07' ? '− ' : ''}${fmt(p.total)}</td><td>${p.original_purchase_id ? `Factura #${p.original_purchase_id}` : p.purchase_order_id ? `Compra #${p.purchase_order_id}` : '—'}</td><td>${p.status === 'void' ? `Invalidada: ${esc(p.void_reason)}` : `<button type="button" class="btn btn-ghost sar-purchase-void" data-id="${p.id}">Corregir</button>`}</td><td>${p.source_name ? `<a href="/api/sar/purchases/${p.id}/pdf" target="_blank" rel="noopener">Descargar</a>` : '—'}</td></tr>`).join(''));
  }

  window.loadSar = loadSar;
  window.issueSarPosSale = async (orderId) => {
    const receiverName = window.prompt('Nombre del receptor (deja Consumidor final si no solicita RTN):', 'Consumidor final');
    if (receiverName === null) return;
    const receiverRtn = window.prompt('RTN del receptor (opcional, 14 dígitos):', '');
    if (receiverRtn === null) return;
    const receiverId = window.prompt('Número de identidad del receptor si aplica (obligatorio para facturas mayores de L 10,000 sin RTN):', '');
    if (receiverId === null) return;
    if (!await askConfirm('Emitir factura SAR', `Venta #${orderId} para ${receiverName || 'Consumidor final'}. Se consumirá el siguiente correlativo autorizado.`, { yesLabel:'Emitir factura' })) return;
    try {
      const result = await sendJson(`/api/sar/orders/${orderId}/issue`, { receiverName: receiverName || 'Consumidor final', receiverRtn, receiverId });
      toast(result.duplicate ? `La venta ya tenía la factura ${result.document_number}; revisa sus datos antes de entregarla` : `Factura ${result.document_number} emitida`);
      await loadPosSalesHistory(POS_SALES_PAGE);
      window.open(`/api/sar/documents/${result.id}/print`, '_blank', 'noopener');
    } catch (error) { toast(error.message, true); }
  };

  $sar('#sarProfileForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api('/api/sar/profile', { method: 'PUT', headers: { 'Content-Type':'application/json' }, body: JSON.stringify(formJson(event.currentTarget)) });
      toast('Emisor SAR guardado'); await loadSar();
    } catch (error) { toast(error.message, true); }
  });
  $sar('#sarCatalogLoad')?.addEventListener('click', async () => {
    try {
      const data=await api('/api/sar/catalog-tax');
      const rows=data.products.map((p)=>`<tr data-name="${esc(p.name.toLocaleLowerCase('es-HN'))}" data-category="${esc(p.sar_tax_category || '')}"><td><input type="checkbox" class="sar-catalog-check" value="${Number(p.id)}"></td><td>${esc(p.name)}</td><td>${esc(({exempt:'Exento',tax15:'15%',tax18:'18%'})[p.sar_tax_category] || 'Pendiente')}</td></tr>`).join('');
      $sar('#sarCatalogEditor').innerHTML=`<div class="row-2"><div class="field"><label>Buscar</label><input id="sarCatalogSearch" placeholder="Nombre del producto"></div><div class="field"><label>Mostrar</label><select id="sarCatalogFilter"><option value="">Sin clasificar</option><option value="all">Todos</option><option value="exempt">Exentos</option><option value="tax15">15%</option><option value="tax18">18%</option></select></div></div><button type="button" class="btn btn-ghost" id="sarCatalogSelectVisible">Seleccionar visibles</button><div class="table-wrap" style="max-height:360px;overflow:auto">${table(['','Producto','Tratamiento'],rows)}</div><div class="row-2"><div class="field"><label>Tratamiento para seleccionados</label><select id="sarCatalogCategory"><option value="">Selecciona</option><option value="exempt">Exento</option><option value="tax15">Gravado 15%</option><option value="tax18">Gravado 18%</option></select></div><div class="field"><label>&nbsp;</label><button type="button" class="btn btn-primary" id="sarCatalogSave">Aplicar a seleccionados</button></div></div>`;
      filterCatalog();
    } catch(error) { toast(error.message,true); }
  });
  function filterCatalog() {
    const term=($sar('#sarCatalogSearch')?.value || '').trim().toLocaleLowerCase('es-HN');
    const filter=$sar('#sarCatalogFilter')?.value || '';
    $sar('#sarCatalogEditor')?.querySelectorAll('tr[data-name]').forEach((row)=>{ row.hidden=!(row.dataset.name.includes(term) && (filter==='all' || row.dataset.category===filter)); });
  }
  $sar('#sarCatalogEditor')?.addEventListener('input',(event)=>{ if (event.target.id==='sarCatalogSearch') filterCatalog(); });
  $sar('#sarCatalogEditor')?.addEventListener('change',(event)=>{ if (event.target.id==='sarCatalogFilter') filterCatalog(); });
  $sar('#sarCatalogEditor')?.addEventListener('click',async(event)=>{
    if (event.target.closest('#sarCatalogSelectVisible')) { $sar('#sarCatalogEditor').querySelectorAll('tr[data-name]:not([hidden]) .sar-catalog-check').forEach((input)=>{ input.checked=true; }); return; }
    if (!event.target.closest('#sarCatalogSave')) return;
    const ids=[...$sar('#sarCatalogEditor').querySelectorAll('.sar-catalog-check:checked')].map((input)=>Number(input.value));
    const category=$sar('#sarCatalogCategory').value;
    if (!ids.length || !category) return toast('Selecciona productos y tratamiento ISV',true);
    if (!await askConfirm('Clasificar productos',`Aplicar ${category} a ${ids.length} producto(s). Confirma que tu contador revisó este tratamiento.`,{yesLabel:'Aplicar'})) return;
    try { await api('/api/sar/catalog-tax/bulk',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids,category})}); toast('Productos clasificados'); await loadSar(); $sar('#sarCatalogLoad').click(); }
    catch(error) { toast(error.message,true); }
  });
  $sar('#sarAuthorizationForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const start = value(form,'rangeStart'), end = value(form,'rangeEnd'), next = value(form,'nextNumber') || start;
    if (Number(next) > Number(end)) return toast('El siguiente correlativo supera el final del rango', true);
    if (!await askConfirm('Registrar autorización SAR', `Tipo ${value(form,'documentType')} · CAI ${value(form,'cai')} · rango ${start} a ${end} · siguiente ${next}. Verifica que coincide con el SAR-927.`, { yesLabel: 'Guardar autorización' })) return;
    const payload = new FormData(form);
    payload.set('nextNumber', next);
    try { await api('/api/sar/authorizations', { method:'POST', body:payload }); form.reset(); toast('Autorización cargada'); await loadSar(); }
    catch (error) { toast(error.message, true); }
  });
  $sar('#sarPurchaseForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try { await api('/api/sar/purchases', { method:'POST', body:new FormData(event.currentTarget) }); event.currentTarget.reset(); toast('Comprobante de proveedor registrado'); await loadSar(); }
    catch (error) { toast(error.message, true); }
  });
  $sar('#sarPurchaseForm')?.elements.namedItem('issuedOn')?.addEventListener('change', (event) => {
    const accounting = event.currentTarget.form.elements.namedItem('accountedOn');
    if (!accounting.value) accounting.value = event.currentTarget.value;
  });
  $sar('#sarPurchases')?.addEventListener('click', async (event) => {
    const button = event.target.closest('.sar-purchase-void');
    if (!button) return;
    const reason = window.prompt('Motivo para invalidar el registro de compra:');
    if (!reason) return;
    if (!await askConfirm('Corregir factura de proveedor', 'El registro se conservará para auditoría y quedará fuera de la conciliación.', { yesLabel:'Invalidar registro' })) return;
    try { await sendJson(`/api/sar/purchases/${button.dataset.id}/void`, { reason }); toast('Compra invalidada'); await loadSar(); }
    catch (error) { toast(error.message,true); }
  });
  $sar('#sarSales')?.addEventListener('click', async (event) => {
    const proofButton = event.target.closest('.sar-proof');
    if (proofButton) {
      const file = proofButton.closest('tr').querySelector('.sar-proof-file')?.files?.[0];
      if (!file) return toast('Selecciona la constancia u OCE en PDF', true);
      const body = new FormData(); body.append('pdf', file);
      try { await api(`/api/sar/orders/${proofButton.dataset.order}/exoneration-proof`, { method:'POST', body }); toast('Constancia adjuntada'); await loadSar(); }
      catch (error) { toast(error.message,true); }
      return;
    }
    const button = event.target.closest('.sar-issue');
    if (!button) return;
    const row = button.closest('tr');
    const receiverName = row.querySelector('.sar-receiver-name').value.trim() || 'Consumidor final';
    const receiverRtn = row.querySelector('.sar-receiver-rtn').value.trim();
    const receiverId = row.querySelector('.sar-receiver-id').value.trim();
    if (!await askConfirm('Emitir factura SAR', `Venta #${button.dataset.order} para ${receiverName}. Se consumirá el siguiente correlativo autorizado.`, { yesLabel:'Emitir factura' })) return;
    button.disabled = true;
    try { const result = await sendJson(`/api/sar/orders/${button.dataset.order}/issue`, { receiverName, receiverRtn, receiverId }); toast(result.duplicate ? `La venta ya tenía la factura ${result.document_number}; revisa sus datos antes de entregarla` : `Factura ${result.document_number} emitida`); await loadSar(); window.open(`/api/sar/documents/${result.id}/print`, '_blank', 'noopener'); }
    catch (error) { toast(error.message, true); button.disabled = false; }
  });
  $sar('#sarRanges')?.addEventListener('click', async (event) => {
    const button = event.target.closest('.sar-invalidate');
    if (!button) return;
    const reason = window.prompt('Motivo de corrección del registro CAI:');
    if (!reason) return;
    if (!await askConfirm('Corregir autorización', 'Se invalidará este registro local si no se ha usado. Podrás cargar los datos correctos del SAR-927.', { yesLabel:'Invalidar registro' })) return;
    try { await sendJson(`/api/sar/authorizations/${button.dataset.id}/invalidate`, { reason }); toast('Registro invalidado'); await loadSar(); }
    catch (error) { toast(error.message,true); }
  });
  $sar('#sarDocuments')?.addEventListener('click', async (event) => {
    const creditButton = event.target.closest('.sar-credit-create');
    if (creditButton) {
      try {
        const balance = await api(`/api/sar/documents/${creditButton.dataset.id}/credit-balance`);
        const fields = balance.lines.map((line,index) => `<div class="row-2"><div><b>${esc(line.name)}</b><div class="hint">Vendido ${line.quantity} · pendiente ${line.remaining} · ${fmt(line.gross)}</div></div><div class="field"><label>Cantidad a acreditar</label><input type="number" name="q${index}" min="0" max="${line.remaining}" step="any" value="0" required></div></div>`).join('');
        $sar('#sarCreditEditor').innerHTML = `<form id="sarCreditForm" data-document="${creditButton.dataset.id}"><h4>Nota de crédito sobre ${esc(balance.number)}</h4>${fields}<div class="field"><label>Motivo detallado</label><textarea name="reason" minlength="8" maxlength="300" required></textarea></div><button type="submit" class="btn btn-primary">Emitir nota de crédito</button> <button type="button" class="btn btn-ghost" id="sarCreditClose">Cerrar</button></form>`;
        $sar('#sarCreditEditor').scrollIntoView({behavior:'smooth',block:'nearest'});
      } catch (error) { toast(error.message,true); }
      return;
    }
    const button = event.target.closest('.sar-annul');
    if (!button) return;
    const reason = window.prompt('Motivo de anulación de la factura SAR:');
    if (!reason) return;
    if (!await askConfirm('Anular factura SAR', 'El correlativo permanecerá consumido y se conservará la factura en el historial.', { yesLabel:'Anular factura' })) return;
    try { await sendJson(`/api/sar/documents/${button.dataset.id}/annul`, { reason }); toast('Factura anulada'); await loadSar(); }
    catch (error) { toast(error.message, true); }
  });
  $sar('#sarCreditEditor')?.addEventListener('click', (event) => {
    if (event.target.closest('#sarCreditClose')) $sar('#sarCreditEditor').innerHTML = '';
  });
  $sar('#sarCreditEditor')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form=event.target, quantities=[...form.querySelectorAll('input[name^="q"]')].map((input)=>Number(input.value));
    if (!quantities.some((quantity)=>quantity>0)) return toast('Selecciona al menos una cantidad',true);
    if (!await askConfirm('Emitir nota de crédito SAR', 'Se consumirá el siguiente correlativo tipo 07. Revisa las cantidades y el motivo.', {yesLabel:'Emitir nota'})) return;
    try {
      const result=await sendJson(`/api/sar/documents/${form.dataset.document}/credit-notes`,{reason:value(form,'reason'),quantities});
      toast(`Nota ${result.document_number} emitida`); $sar('#sarCreditEditor').innerHTML=''; await loadSar();
      window.open(`/api/sar/credit-notes/${result.id}/print`,'_blank','noopener');
    } catch(error) { toast(error.message,true); }
  });
  $sar('#sarCreditNotes')?.addEventListener('click', async (event) => {
    const annul=event.target.closest('.sar-credit-annul');
    if (annul) {
      const reason=window.prompt('Motivo de anulación de la nota de crédito:');
      if (!reason || !await askConfirm('Anular nota de crédito','El correlativo permanecerá consumido.',{yesLabel:'Anular nota'})) return;
      try { await sendJson(`/api/sar/credit-notes/${annul.dataset.id}/annul`,{reason}); toast('Nota anulada'); await loadSar(); }
      catch(error) { toast(error.message,true); }
      return;
    }
    const refund=event.target.closest('.sar-refund');
    if (!refund) return;
    const row=refund.closest('tr');
    const method=row.querySelector('.sar-refund-method').value;
    const reference=row.querySelector('.sar-refund-reference').value.trim();
    const restock=row.querySelector('.sar-refund-restock').checked;
    if (['card','transfer'].includes(method) && !reference) return toast('Captura la referencia de la devolución',true);
    if (!await askConfirm('Registrar devolución','Este movimiento financiero se registra una sola vez. El efectivo se descuenta del corte de la sucursal.',{yesLabel:'Registrar devolución'})) return;
    try { await sendJson(`/api/sar/credit-notes/${refund.dataset.id}/refund`,{method,reference,restock}); toast('Devolución registrada'); await loadSar(); }
    catch(error) { toast(error.message,true); }
  });
  $sar('#sarReportLoad')?.addEventListener('click', async () => {
    try {
      const from = $sar('#sarReportFrom').value, to = $sar('#sarReportTo').value;
      const report = await api(`/api/sar/report?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      lastReport = report;
      $sar('#sarReportCsv').disabled = false;
      const sums = (obj) => `<p>Exento: ${fmt(obj.exempt)} · ${obj.exonerated === undefined ? `Exonerado 15%: ${fmt(obj.exonerated15)} · Exonerado 18%: ${fmt(obj.exonerated18)}` : `Exonerado: ${fmt(obj.exonerated)}`} · Base 15%: ${fmt(obj.taxable15)} · ISV 15%: ${fmt(obj.isv15)} · Base 18%: ${fmt(obj.taxable18)} · ISV 18%: ${fmt(obj.isv18)} · <b>Total: ${fmt(obj.total)}</b></p>`;
      $sar('#sarReportResult').innerHTML = `<h4>Ventas netas de notas de crédito</h4>${sums(report.salesTotals)}<h4>Notas de crédito vigentes (${report.creditNotes.filter((n) => n.status === 'issued').length})</h4>${sums(report.creditTotals)}<h4>Facturas de compra vigentes (${report.purchases.filter((p) => p.status === 'active').length})</h4>${sums(report.purchaseTotals)}<p>ISV acreditable: 15% ${fmt(report.purchaseTotals.creditableIsv15)} · 18% ${fmt(report.purchaseTotals.creditableIsv18)}</p><p class="hint">ISV neto indicativo: ${fmt(report.isv201.netIndicative)}. El contador debe considerar retenciones, saldos anteriores y ajustes en la declaración oficial.</p>`;
    } catch (error) { toast(error.message, true); }
  });
  ['#sarReportFrom','#sarReportTo'].forEach((selector) => $sar(selector)?.addEventListener('change', () => { lastReport = null; $sar('#sarReportCsv').disabled = true; }));
  $sar('#sarReportCsv')?.addEventListener('click', () => {
    if (!lastReport) return;
    const columns = ['tipo','fecha','numero','estado','contraparte','exento','exonerado_15','exonerado_18','base_15','isv_15','base_18','isv_18','total'];
    const row = (kind, day, number, status, counterparty, totals) => [kind,day,number,status,counterparty,totals.exempt,totals.exonerated15,totals.exonerated18,totals.taxable15,totals.isv15,totals.taxable18,totals.isv18,totals.total];
    const records = [columns,
      ...lastReport.documents.map((d) => row('venta',new Date(d.issuedAt).toLocaleDateString('sv-SE',{timeZone:'America/Tegucigalpa'}),d.number,d.status,'',d.totals || {})),
      ...lastReport.creditNotes.map((n) => row('nota_credito',new Date(n.issuedAt).toLocaleDateString('sv-SE',{timeZone:'America/Tegucigalpa'}),n.number,n.status,n.originalNumber,n.totals || {})),
      ...lastReport.purchases.map((p) => { const sign=p.document_type === '07' ? -1 : 1; return row(sign < 0 ? 'nota_credito_proveedor' : 'compra',String(p.issued_on).slice(0,10),p.document_number,p.status,p.supplier_name,{ exempt:sign*Number(p.exempt_amount),exonerated15:sign*Number(p.exonerated_amount),taxable15:sign*Number(p.taxable_15),isv15:sign*Number(p.isv_15),taxable18:sign*Number(p.taxable_18),isv18:sign*Number(p.isv_18),total:sign*Number(p.total) }); })];
    const cell = (value) => {
      const input = String(value ?? '');
      const safe = /^[=+@\-\t\r]/.test(input) && !/^-?\d+(?:\.\d+)?$/.test(input) ? `'${input}` : input;
      return `"${safe.replace(/"/g,'""')}"`;
    };
    const csv = `\uFEFF${records.map((cells) => cells.map(cell).join(';')).join('\r\n')}\r\n`;
    const url = URL.createObjectURL(new Blob([csv], { type:'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `sar-honduras-${lastReport.from}-${lastReport.to}.csv`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  async function loadFiling() {
    const period=$sar('#sarFilingPeriod').value;
    if (!period) return toast('Selecciona un período',true);
    const data=await api(`/api/sar/filings/${period}`), report=data.report;
    $sar('#sarFilingResult').innerHTML=`<h4>Resumen de trabajo ${esc(period)}</h4><p>Ventas netas: ${fmt(report.salesTotals.total)} · ISV débito: ${fmt(report.isv201.debit15 + report.isv201.debit18)} · ISV crédito en compras: ${fmt(report.isv201.credit15 + report.isv201.credit18)} · Otros créditos documentados: ${fmt(report.isv201.otherCredits)} · <b>Saldo indicativo: ${fmt(report.isv201.netAfterRecordedCredits)}</b></p><p>${report.purchases.filter((p)=>p.status==='active').length} comprobante(s) de compra para DMC. El archivo es una hoja de trabajo; transcribe o carga los datos en el formato vigente del SAR.</p><a class="btn btn-ghost" href="/api/sar/filings/${period}/workbook">Descargar libro de trabajo Excel</a> <a class="btn btn-ghost" href="https://oficinavirtual.sar.gob.hn/" target="_blank" rel="noopener noreferrer">Abrir Oficina Virtual SAR</a>`;
    const labels={prior_excess:'Excedente anterior',period_payment:'Pago',compensation:'Compensación',credit_transfer:'Cesión',retained_state:'Retención Estado',retained_agreement:'Retención acuerdo',retained_card:'Retención tarjeta'};
    $sar('#sarAdjustments').innerHTML=table(['Concepto','Importe','Referencia','Estado','Comprobante'],report.adjustments.map((a)=>`<tr><td>${esc(labels[a.adjustment_type] || a.adjustment_type)}</td><td>${fmt(a.amount)}</td><td>${esc(a.reference)}</td><td>${a.status==='active' ? `<button type="button" class="btn btn-ghost sar-adjustment-void" data-id="${a.id}">Corregir</button>` : `Invalidado: ${esc(a.void_reason)}`}</td><td><a href="/api/sar/filings/adjustments/${a.id}/pdf" target="_blank" rel="noopener">PDF</a></td></tr>`).join(''));
    $sar('#sarFilingHistory').innerHTML=table(['Declaración','Fecha','Acuse','Estado de datos','Archivo'],data.records.map((record)=>`<tr><td>${esc(record.filing_type)}</td><td>${date(record.filed_on)}</td><td>${esc(record.receipt_number)}</td><td>${record.status==='superseded' ? 'Sustituida' : record.needsReview ? 'Datos cambiaron tras presentación; revisar' : 'Datos coinciden con el expediente'}</td><td><a href="/api/sar/filings/receipts/${record.id}/pdf" target="_blank" rel="noopener">PDF SAR</a></td></tr>`).join(''));
  }
  $sar('#sarFilingLoad')?.addEventListener('click',()=>loadFiling().catch((error)=>toast(error.message,true)));
  $sar('#sarAdjustmentForm')?.addEventListener('submit',async(event)=>{
    event.preventDefault(); const period=$sar('#sarFilingPeriod').value;
    if (!period) return toast('Selecciona un período',true);
    try { await api(`/api/sar/filings/${period}/adjustments`,{method:'POST',body:new FormData(event.target)}); event.target.reset(); toast('Crédito documentado registrado'); await loadFiling(); }
    catch(error) { toast(error.message,true); }
  });
  $sar('#sarAdjustments')?.addEventListener('click',async(event)=>{
    const button=event.target.closest('.sar-adjustment-void'); if (!button) return;
    const reason=window.prompt('Motivo de corrección del crédito:'); if (!reason) return;
    try { await sendJson(`/api/sar/filings/adjustments/${button.dataset.id}/void`,{reason}); toast('Crédito invalidado'); await loadFiling(); }
    catch(error) { toast(error.message,true); }
  });
  $sar('#sarFilingReceiptForm')?.addEventListener('submit',async(event)=>{
    event.preventDefault();
    const period=$sar('#sarFilingPeriod').value;
    if (!period) return toast('Selecciona el período presentado',true);
    if (!await askConfirm('Registrar acuse del SAR',`Confirma que la declaración ${value(event.target,'filingType')} de ${period} ya se presentó en la Oficina Virtual.`,{yesLabel:'Registrar acuse'})) return;
    try { await api(`/api/sar/filings/${period}`,{method:'POST',body:new FormData(event.target)}); event.target.reset(); toast('Acuse registrado'); await loadFiling(); }
    catch(error) { toast(error.message,true); }
  });
})();
