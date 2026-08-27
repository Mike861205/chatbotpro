(() => {
  const $ = (selector) => document.querySelector(selector);
  const parts = location.pathname.split('/').filter(Boolean);
  const slug = parts[1] || '';
  const token = parts[2] || '';
  const apiBase = `/api/self-service/public/${encodeURIComponent(slug)}/${encodeURIComponent(token)}`;
  let data = null;
  let category = 'all';
  let cart = [];
  let selectedProduct = null;
  let selectedVariantId = null;
  let selectedOptions = new Map();
  let selectedQty = 1;
  let currentOrder = null;
  let currentCustomerName = '';
  let statusTimer = null;
  let idleTimer = null;
  let lastPaidSale = null;

  const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  const money = (value) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: data?.business?.currency || 'MXN' }).format(Number(value || 0));
  const media = (path) => path ? (String(path).startsWith('/') ? path : `/${path}`) : '';
  const notify = (message) => {
    const toast = $('#kioskToast'); toast.textContent = message; toast.classList.add('show');
    clearTimeout(toast._timer); toast._timer = setTimeout(() => toast.classList.remove('show'), 2600);
  };
  const speak = (message) => {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(message);
    utterance.lang = 'es-MX'; utterance.rate = 0.92; utterance.pitch = 1;
    window.speechSynthesis.speak(utterance);
  };
  const resetIdle = () => {
    clearTimeout(idleTimer);
    if (!currentOrder) idleTimer = setTimeout(() => resetOrder(true), 3 * 60 * 1000);
  };

  function productPrice(product) {
    const variants = product.variants || [];
    if (variants.length) return Math.min(...variants.map((item) => Number(item.price)));
    return Number(product.price || 0);
  }

  function renderCategories() {
    $('#kioskCategories').innerHTML = [
      `<button type="button" class="${category === 'all' ? 'active' : ''}" data-category="all">Todo</button>`,
      ...(data.categories || []).map((item) => `<button type="button" class="${category === String(item.id) ? 'active' : ''}" data-category="${item.id}">${esc(item.name)}</button>`),
    ].join('');
    document.querySelectorAll('[data-category]').forEach((button) => button.addEventListener('click', () => {
      category = button.dataset.category; renderCategories(); renderProducts(); resetIdle();
    }));
  }

  function renderProducts() {
    const products = (data.products || []).filter((item) => category === 'all' || String(item.category_id || '') === category);
    $('#kioskProducts').innerHTML = products.length ? products.map((product) => {
      const image = media(product.image);
      const variants = product.variants || [];
      return `<button class="kiosk-product" type="button" data-product="${product.id}">
        <div class="kiosk-product-media">${image ? `<img src="${esc(image)}" alt="${esc(product.name)}" />` : '<i class="ph ph-hamburger"></i>'}</div>
        <div class="kiosk-product-body"><small>${esc(product.category_name || 'Menú')}</small><b>${esc(product.name)}</b><p>${esc(product.description || 'Toca para agregar a tu pedido')}</p><div class="kiosk-product-price"><span>${variants.length ? 'Desde ' : ''}${money(productPrice(product))}</span><i class="ph ph-plus"></i></div></div>
      </button>`;
    }).join('') : '<div class="kiosk-cart-empty"><i class="ph ph-bowl-food"></i><b>No hay productos en esta categoría</b></div>';
    document.querySelectorAll('[data-product]').forEach((button) => button.addEventListener('click', () => openProduct(Number(button.dataset.product))));
  }

  function cartTotal() { return cart.reduce((sum, item) => sum + item.price * item.qty, 0); }
  function renderCart() {
    const count = cart.reduce((sum, item) => sum + item.qty, 0);
    $('#kioskCartCount').textContent = String(count);
    $('#kioskTotal').textContent = money(cartTotal());
    $('#kioskCheckout').disabled = !cart.length;
    $('#kioskCartItems').innerHTML = cart.length ? cart.map((item) => `<article class="kiosk-cart-item">
      <div><b>${esc(item.name)}</b>${item.modifiersLabel ? `<small>${esc(item.modifiersLabel)}</small>` : ''}<small>${money(item.price)} c/u</small></div>
      <div><strong>${money(item.price * item.qty)}</strong><div class="kiosk-cart-qty"><button type="button" data-cart-down="${esc(item.key)}"><i class="ph ph-minus"></i></button><b>${item.qty}</b><button type="button" data-cart-up="${esc(item.key)}"><i class="ph ph-plus"></i></button></div></div>
    </article>`).join('') : '<div class="kiosk-cart-empty"><i class="ph ph-shopping-cart-simple"></i><b>Tu pedido está vacío</b><span>Toca un producto para comenzar</span></div>';
    document.querySelectorAll('[data-cart-down]').forEach((button) => button.addEventListener('click', () => changeCartQty(button.dataset.cartDown, -1)));
    document.querySelectorAll('[data-cart-up]').forEach((button) => button.addEventListener('click', () => changeCartQty(button.dataset.cartUp, 1)));
  }

  function changeCartQty(key, delta) {
    const item = cart.find((row) => row.key === key); if (!item) return;
    item.qty += delta; if (item.qty <= 0) cart = cart.filter((row) => row.key !== key);
    if (delta > 0) speak(`${item.name} agregado. Ahora tienes ${item.qty} en tu pedido.`);
    renderCart(); resetIdle();
  }

  function optionPrice() {
    const product = selectedProduct;
    const variant = (product?.variants || []).find((item) => Number(item.id) === Number(selectedVariantId));
    let price = Number(variant?.price ?? product?.price ?? 0);
    for (const ids of selectedOptions.values()) for (const id of ids) {
      for (const group of product.modifierGroups || []) {
        const option = (group.options || []).find((item) => Number(item.id) === Number(id));
        if (option) price += Number(option.extra_price || 0);
      }
    }
    return Number(price.toFixed(2));
  }

  function selectionsValid() {
    if ((selectedProduct?.variants || []).length > 1 && !selectedVariantId) return false;
    return (selectedProduct?.modifierGroups || []).every((group) => {
      const size = (selectedOptions.get(Number(group.id)) || []).length;
      return size >= Number(group.min_selections || 0) && (!Number(group.max_selections || 0) || size <= Number(group.max_selections));
    });
  }

  function renderProductOptions() {
    const product = selectedProduct; if (!product) return;
    let html = '';
    if ((product.variants || []).length > 1) html += `<section class="kiosk-option-group"><div class="kiosk-option-title"><b>Elige una opción</b><span>Requerido</span></div><div class="kiosk-option-grid">${product.variants.map((item) => `<button class="kiosk-option ${Number(selectedVariantId) === Number(item.id) ? 'selected' : ''}" type="button" data-variant="${item.id}"><b>${esc(item.name)}</b><small>${money(item.price)}</small></button>`).join('')}</div></section>`;
    for (const group of product.modifierGroups || []) {
      const selected = selectedOptions.get(Number(group.id)) || [];
      const min = Number(group.min_selections || 0); const max = Number(group.max_selections || 0);
      const hint = min ? `Elige ${min}${max > min ? ` a ${max}` : ''}` : (max ? `Hasta ${max}` : 'Opcional');
      html += `<section class="kiosk-option-group"><div class="kiosk-option-title"><b>${esc(group.name)}</b><span>${hint}</span></div><div class="kiosk-option-grid">${(group.options || []).map((option) => `<button class="kiosk-option ${selected.includes(Number(option.id)) ? 'selected' : ''}" type="button" data-option="${option.id}" data-group="${group.id}"><b>${esc(option.name)}</b><small>${Number(option.extra_price || 0) ? `+ ${money(option.extra_price)}` : 'Incluido'}</small></button>`).join('')}</div></section>`;
    }
    $('#kioskProductOptions').innerHTML = html;
    $('#kioskAddPrice').textContent = money(optionPrice() * selectedQty);
    $('#kioskAddProduct').disabled = !selectionsValid();
    document.querySelectorAll('[data-variant]').forEach((button) => button.addEventListener('click', () => { selectedVariantId = Number(button.dataset.variant); renderProductOptions(); }));
    document.querySelectorAll('[data-option]').forEach((button) => button.addEventListener('click', () => toggleOption(Number(button.dataset.group), Number(button.dataset.option))));
  }

  function toggleOption(groupId, optionId) {
    const group = (selectedProduct.modifierGroups || []).find((item) => Number(item.id) === groupId); if (!group) return;
    let selected = [...(selectedOptions.get(groupId) || [])];
    if (selected.includes(optionId)) selected = selected.filter((id) => id !== optionId);
    else {
      const max = Number(group.max_selections || 0);
      if (max === 1) selected = [optionId];
      else if (!max || selected.length < max) selected.push(optionId);
      else return notify(`Puedes elegir hasta ${max} en ${group.name}`);
    }
    selectedOptions.set(groupId, selected); renderProductOptions();
  }

  function openProduct(id) {
    selectedProduct = data.products.find((item) => Number(item.id) === id); if (!selectedProduct) return;
    selectedVariantId = (selectedProduct.variants || []).length === 1 ? Number(selectedProduct.variants[0].id) : null;
    selectedOptions = new Map(); selectedQty = 1;
    $('#kioskModalName').textContent = selectedProduct.name;
    $('#kioskModalCategory').textContent = selectedProduct.category_name || 'Menú';
    $('#kioskModalDescription').textContent = selectedProduct.description || 'Personaliza tu producto.';
    $('#kioskModalImage').innerHTML = selectedProduct.image ? `<img src="${esc(media(selectedProduct.image))}" alt="" />` : '<i class="ph ph-hamburger"></i>';
    $('#kioskQty').textContent = '1'; renderProductOptions(); $('#kioskProductModal').hidden = false; resetIdle();
  }

  function addSelectedProduct() {
    if (!selectionsValid()) return notify('Completa las opciones requeridas');
    const variant = (selectedProduct.variants || []).find((item) => Number(item.id) === Number(selectedVariantId));
    const optionIds = [...selectedOptions.values()].flat();
    const optionNames = [];
    for (const group of selectedProduct.modifierGroups || []) for (const option of group.options || []) if (optionIds.includes(Number(option.id))) optionNames.push(option.name);
    const key = `${selectedProduct.id}:${selectedVariantId || 0}:${[...optionIds].sort((a, b) => a - b).join(',')}`;
    const existing = cart.find((item) => item.key === key);
    if (existing) existing.qty += selectedQty;
    else cart.push({ key, productId: Number(selectedProduct.id), name: `${selectedProduct.name}${variant ? ` · ${variant.name}` : ''}`, price: optionPrice(), qty: selectedQty, variantId: variant ? Number(variant.id) : null, modifierOptionIds: optionIds, modifiersLabel: optionNames.join(', ') });
    const spokenName = `${selectedProduct.name}${variant ? `, ${variant.name}` : ''}`;
    $('#kioskProductModal').hidden = true; renderCart(); notify('Producto agregado');
    speak(`${selectedQty === 1 ? '' : `${selectedQty} `}${spokenName} agregado a tu pedido.`); resetIdle();
  }

  function renderPaymentOptions() {
    const options = data?.business?.paymentMethods || [];
    const icons = { cash: 'ph-money', debit: 'ph-credit-card', credit: 'ph-credit-card', transfer: 'ph-bank' };
    $('#kioskPaymentOptions').innerHTML = options.map((option, index) => {
      const pointUnavailable = option.method === 'card' && !data?.business?.point?.configured;
      return `<label class="kiosk-payment-option"><input type="radio" name="kioskPayment" value="${esc(option.id)}" ${index === 0 ? 'checked' : ''} ${pointUnavailable ? 'disabled' : ''} required /><span><i class="ph ${icons[option.id] || 'ph-wallet'}"></i>${esc(option.label)}${option.method === 'card' ? `<small>${pointUnavailable ? 'No disponible' : 'Paga en la terminal'}</small>` : ''}</span></label>`;
    }).join('');
  }

  function selectedPayment() {
    const id = document.querySelector('input[name="kioskPayment"]:checked')?.value || '';
    return (data?.business?.paymentMethods || []).find((option) => option.id === id) || null;
  }

  function openCustomerCheckout() {
    if (!cart.length || $('#kioskCheckout').disabled) return;
    renderPaymentOptions();
    $('#kioskCustomerModal').hidden = false;
    setTimeout(() => $('#kioskCustomerName').focus(), 50);
    resetIdle();
  }

  function printKioskTicket(order, finalSale = false) {
    if ((!data?.business?.autoPrint && !finalSale) || !order) return;
    const items = (order.items || []).map((item) => `<div class="item"><span>${Number(item.qty || 0)} × ${esc(item.name || 'Producto')}</span><b>${money(Number(item.price || 0) * Number(item.qty || 0))}</b></div>`).join('');
    const branchName = order.branchName || order.serviceBranchName || data.branch.name;
    const cardType = order.paymentBreakdown?.cardType === 'credit' ? 'Tarjeta de crédito' : 'Tarjeta de débito';
    const paymentReference = order.paymentReference || order.paymentBreakdown?.paymentReference || '';
    $('#kioskPrintTicket').innerHTML = finalSale
      ? `<h1>${esc(data.business.name)}</h1><p>${esc(branchName)}</p><div class="sep"></div><p>TICKET DE VENTA · AUTOSERVICIO</p><h2>${esc(order.folio || `#${order.id}`)}</h2><p class="name">A nombre de ${esc(order.customerName || currentCustomerName)}</p><div class="sep"></div>${items}<div class="sep"></div><div class="total"><span>TOTAL PAGADO</span><b>${money(order.total)}</b></div><p><b>Pago:</b> ${esc(cardType)} · Mercado Pago Point</p>${paymentReference ? `<p><b>Autorización:</b> ${esc(paymentReference)}</p>` : ''}${order.notes ? `<p class="note"><b>Indicaciones:</b> ${esc(order.notes)}</p>` : ''}<div class="sep"></div><p class="footer">PAGO APROBADO · Conserva este ticket.</p>`
      : `<h1>${esc(data.business.name)}</h1><p>${esc(branchName)}</p><div class="sep"></div><p>PEDIDO DE AUTOSERVICIO</p><h2>${esc(order.folio)}</h2><p class="name">A nombre de ${esc(order.customerName)}</p><p><b>PENDIENTE DE COBRO · NO ES TICKET DE VENTA</b></p><div class="sep"></div>${items}<div class="sep"></div><div class="total"><span>TOTAL</span><b>${money(order.total)}</b></div><p><b>Pago indicado:</b> ${esc(order.paymentLabel)}</p>${order.notes ? `<p class="note"><b>Indicaciones:</b> ${esc(order.notes)}</p>` : ''}<div class="sep"></div><p class="footer">Entrega este comprobante al cajero. El ticket final se imprime después de confirmar el pago en el POS.</p>`;
    setTimeout(() => window.print(), 250);
  }

  function showPointFailure(message) {
    clearInterval(statusTimer);
    const waiting = $('#kioskWaiting'); waiting.className = 'kiosk-waiting failed'; waiting.innerHTML = '<i class="ph ph-warning-circle"></i> Pago no aprobado';
    $('#kioskSuccessMessage').textContent = message || 'No se pudo aprobar el pago. Puedes intentarlo nuevamente.';
    $('#kioskRetryPayment').hidden = false;
    speak('El pago no fue aprobado. Intenta nuevamente o solicita ayuda al personal.');
  }

  function finishPointPayment(sale) {
    clearInterval(statusTimer); lastPaidSale = sale;
    const waiting = $('#kioskWaiting'); waiting.className = 'kiosk-waiting paid'; waiting.innerHTML = '<i class="ph-fill ph-check-circle"></i> Pago aprobado · pedido enviado a cocina';
    $('#kioskSuccessMessage').textContent = 'Gracias. Toma tu ticket; tu pedido ya está en preparación.';
    $('#kioskRetryPayment').hidden = true; $('#kioskPrintSale').hidden = false;
    speak(`Pago aprobado. Tu pedido ${String(sale.folio || currentOrder?.folio || '').replace('-', ' ')} fue enviado a preparación. No olvides tomar tu ticket.`);
    printKioskTicket(sale, true);
  }

  async function pollPointPayment() {
    if (!currentOrder) return;
    try {
      const response = await fetch(`${apiBase}/orders/${currentOrder.id}/point`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'No se pudo consultar el pago');
      if (result.payment?.paid && result.sale) return finishPointPayment(result.sale);
      if (result.payment?.final && !result.payment?.paid) return showPointFailure(result.payment.statusDetail);
      const waiting = $('#kioskWaiting'); waiting.className = 'kiosk-waiting'; waiting.innerHTML = '<i class="ph ph-spinner-gap"></i> Sigue las instrucciones de la terminal';
    } catch (error) { notify(error.message); }
  }

  async function startPointPayment() {
    if (!currentOrder) return;
    $('#kioskRetryPayment').hidden = true;
    const waiting = $('#kioskWaiting'); waiting.className = 'kiosk-waiting'; waiting.innerHTML = '<i class="ph ph-spinner-gap"></i> Preparando terminal Mercado Pago';
    $('#kioskSuccessMessage').textContent = `Total a pagar ${money(currentOrder.total)}. Sigue las instrucciones de la terminal.`;
    try {
      const response = await fetch(`${apiBase}/orders/${currentOrder.id}/point`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'No se pudo iniciar el pago');
      if (result.payment?.paid && result.sale) return finishPointPayment(result.sale);
      clearInterval(statusTimer); statusTimer = setInterval(pollPointPayment, 2000); setTimeout(pollPointPayment, 700);
    } catch (error) { showPointFailure(error.message); }
  }

  async function checkout(customerName, customerPhone, payment) {
    if (!cart.length || $('#kioskCheckout').disabled) return;
    const submitButton = $('#kioskCustomerSubmit'); submitButton.disabled = true;
    const button = $('#kioskCheckout'); button.disabled = true; button.innerHTML = '<i class="ph ph-spinner-gap"></i> Enviando…';
    try {
      const response = await fetch(`${apiBase}/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: cart.map((item) => ({ productId: item.productId, qty: item.qty, variantId: item.variantId, modifierOptionIds: item.modifierOptionIds })), notes: $('#kioskNotes').value, customerName, customerPhone, phoneCountry: 'MX', paymentChoice: payment.id }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || 'No se pudo enviar el pedido');
      currentOrder = result; currentCustomerName = result.customerName; clearTimeout(idleTimer); $('#kioskFolio').textContent = result.folio;
      const successTitle = $('.kiosk-success-card h2'); if (successTitle) successTitle.textContent = 'Pedido a nombre de';
      let successName = $('#kioskSuccessName');
      if (!successName) { successName = document.createElement('h3'); successName.id = 'kioskSuccessName'; successName.className = 'kiosk-success-name'; $('#kioskFolio').insertAdjacentElement('afterend', successName); }
      successName.textContent = result.customerName; $('#kioskCustomerModal').hidden = true; $('#kioskSuccess').hidden = false;
      $('#kioskPrintSale').hidden = true; $('#kioskRetryPayment').hidden = true;
      if (result.paymentMethod === 'card') {
        speak(`Pedido ${String(result.folio).replace('-', ' ')}, a nombre de ${result.customerName}. Tu total es ${money(result.total)}. Sigue las instrucciones para pagar con tarjeta.`);
        startPointPayment();
      } else {
        $('#kioskWaiting').className = 'kiosk-waiting'; $('#kioskWaiting').innerHTML = '<i class="ph ph-spinner-gap"></i> Esperando confirmación de caja';
        $('#kioskSuccessMessage').textContent = `Pasa a caja con tu folio. Total ${money(result.total)} · ${result.paymentLabel}.`;
        speak(`Pedido ${String(result.folio).replace('-', ' ')}, a nombre de ${result.customerName}. Forma de pago, ${result.paymentLabel}. Tu total es ${money(result.total)}. Pasa a caja con tu comprobante.`);
        printKioskTicket(result);
        startStatusPolling();
      }
    } catch (error) { notify(error.message); button.disabled = false; }
    finally { button.innerHTML = '<span>Confirmar pedido</span><i class="ph-fill ph-arrow-right"></i>'; submitButton.disabled = false; }
  }

  function startStatusPolling() {
    clearInterval(statusTimer);
    statusTimer = setInterval(async () => {
      if (!currentOrder) return;
      try {
        const response = await fetch(`${apiBase}/orders/${currentOrder.id}`); if (!response.ok) return;
        const status = await response.json();
        if (status.status === 'confirmado' || status.status === 'preparando') {
          clearInterval(statusTimer); const waiting = $('#kioskWaiting'); waiting.className = 'kiosk-waiting paid'; waiting.innerHTML = '<i class="ph-fill ph-check-circle"></i> Pago confirmado · pedido enviado a cocina';
          $('#kioskSuccessMessage').textContent = 'Gracias. Tu pedido ya fue enviado a preparación.';
          speak(`Pago confirmado. Tu pedido ${String(status.folio).replace('-', ' ')} fue enviado a preparación. Gracias.`);
        } else if (status.status === 'cancelado') {
          clearInterval(statusTimer); $('#kioskWaiting').innerHTML = '<i class="ph ph-warning-circle"></i> Pedido cancelado en caja';
        }
      } catch {}
    }, 3000);
  }

  function resetOrder(silent = false) {
    clearInterval(statusTimer); currentOrder = null; currentCustomerName = ''; lastPaidSale = null; cart = []; selectedProduct = null; $('#kioskNotes').value = ''; $('#kioskCustomerName').value = ''; $('#kioskCustomerPhone').value = ''; $('#kioskSuccess').hidden = true; $('#kioskProductModal').hidden = true; $('#kioskCustomerModal').hidden = true; $('#kioskPrintSale').hidden = true; $('#kioskRetryPayment').hidden = true; renderCart(); resetIdle();
    if (!silent) speak('Puedes comenzar un nuevo pedido.');
  }

  async function boot() {
    try {
      const response = await fetch(apiBase); const result = await response.json();
      if (!response.ok) {
        const failure = new Error(result.error || 'Autoservicio no disponible');
        failure.detail = result.detail || '';
        throw failure;
      }
      data = result; document.documentElement.style.setProperty('--brand', data.business.primaryColor || '#ff6b35');
      const dark = data.business.primaryColor || '#d94816'; document.documentElement.style.setProperty('--brand-dark', dark);
      $('#kioskBusiness').textContent = data.business.name; $('#kioskBranch').textContent = data.branch.name; $('#kioskWelcome').textContent = data.business.welcomeMessage;
      if (data.business.logo) $('#kioskLogo').innerHTML = `<img src="${esc(media(data.business.logo))}" alt="" />`;
      document.title = `Autoservicio · ${data.business.name}`; renderCategories(); renderProducts(); renderCart(); $('#kioskApp').hidden = false; $('#kioskLoading').remove(); resetIdle();
    } catch (error) { $('#kioskLoading').innerHTML = `<i class="ph ph-warning-circle" style="font-size:58px;color:#dc2626"></i><b>${esc(error.message)}</b><span>${esc(error.detail || 'Solicita ayuda al personal.')}</span>`; }
  }

  $('#kioskProductClose').addEventListener('click', () => { $('#kioskProductModal').hidden = true; });
  $('#kioskQtyDown').addEventListener('click', () => { selectedQty = Math.max(1, selectedQty - 1); $('#kioskQty').textContent = selectedQty; renderProductOptions(); });
  $('#kioskQtyUp').addEventListener('click', () => { selectedQty = Math.min(99, selectedQty + 1); $('#kioskQty').textContent = selectedQty; renderProductOptions(); });
  $('#kioskAddProduct').addEventListener('click', addSelectedProduct); $('#kioskCheckout').addEventListener('click', openCustomerCheckout);
  $('#kioskCustomerClose').addEventListener('click', () => { $('#kioskCustomerModal').hidden = true; });
  $('#kioskCustomerForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const customerName = $('#kioskCustomerName').value.trim().replace(/\s+/g, ' ');
    if (customerName.length < 2) return notify('Escribe el nombre para tu pedido');
    const payment = selectedPayment();
    if (!payment) return notify('Selecciona cómo pagarás en caja');
    checkout(customerName, $('#kioskCustomerPhone').value.trim(), payment);
  });
  $('#kioskReset').addEventListener('click', () => resetOrder()); $('#kioskNewOrder').addEventListener('click', () => resetOrder());
  $('#kioskRetryPayment').addEventListener('click', startPointPayment);
  $('#kioskPrintSale').addEventListener('click', () => printKioskTicket(lastPaidSale, true));
  ['pointerdown', 'keydown'].forEach((eventName) => document.addEventListener(eventName, resetIdle, { passive: true }));
  boot();
})();
