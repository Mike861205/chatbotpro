// Honduras: autoimpresor. El CAI y el rango se obtienen en la Oficina Virtual del SAR.
// Este módulo administra números autorizados; no representa una API de timbrado del SAR.
const express = require('express');
const crypto = require('node:crypto');
const multer = require('multer');
const XLSX = require('xlsx');
const { requireAuth, requireModules } = require('../middleware/auth');
const { encrypt, decrypt } = require('../utils/crypto');
const { restoreBranchSaleStock } = require('../utils/branchStock');
const { TAX_CATEGORIES, money, sarNumber, validRtn, validCai, parseDocumentNumber, calculateSarTotals, calculateSarCredit } = require('../utils/sar');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const actor = (req) => req.user.displayName || req.user.username;
const clean = (value, max = 200) => String(value ?? '').trim().slice(0, max);
const positiveId = (value) => { const id = Number(value); if (!Number.isSafeInteger(id) || id <= 0) throw fail(400, 'Identificador inválido'); return id; };
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const parseJson = (value) => { try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; } };
const safeMoney = (value) => { const num = Number(value); if (!Number.isFinite(num) || num < 0 || num > 999999999999) throw fail(400, 'Importe inválido'); return money(num); };
const validIsoDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0,10) === value;
const dateOnly = (value) => value instanceof Date ? value.toISOString().slice(0,10) : String(value || '').slice(0,10);
const isOwner = (req) => req.user.role === 'owner';
const emitterSignature = (p) => crypto.createHash('sha256').update(JSON.stringify([p.rtn,p.legal_name,p.trade_name,p.address,p.phone])).digest('hex');
const ownerOnly = (req, res, next) => isOwner(req) ? next() : res.status(403).json({ error: 'Sólo el propietario puede configurar SAR' });
const wrapped = (handler) => async (req, res, next) => { try { await handler(req, res); } catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ error: error.message }); next(error); } };

router.use(requireAuth, (req, res, next) => {
  if (req.tenant.phone_country !== 'HN') return res.status(404).json({ error: 'Módulo exclusivo para negocios registrados en Honduras' });
  next();
});

router.get('/checkout-config', requireModules('pos'), wrapped(async (req,res) => {
  const profile = await req.tdb.get('SELECT delivery_tax_category FROM {s}.sar_profiles WHERE id=1');
  res.json({ deliveryTaxCategory: profile?.delivery_tax_category || '' });
}));

router.get('/catalog-tax', ownerOnly, wrapped(async (req,res) => {
  const rows=await req.tdb.all('SELECT id,name,sar_tax_category FROM {s}.products WHERE active=1 ORDER BY name,id');
  res.json({products:rows});
}));

router.put('/catalog-tax/bulk', ownerOnly, wrapped(async (req,res) => {
  const ids=[...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number))];
  const category=clean(req.body?.category,20);
  if (!ids.length || ids.length>500 || ids.some((id)=>!Number.isSafeInteger(id) || id<1) || !TAX_CATEGORIES.has(category)) throw fail(400,'Selecciona productos y tratamiento ISV válido');
  await req.tdb.tx(async (tx) => {
    await tx.run('UPDATE {s}.products SET sar_tax_category=$1 WHERE id=ANY($2::int[]) AND active=1',[category,ids]);
    await tx.run("INSERT INTO {s}.sar_events(subject_type,subject_id,event_type,detail,actor) VALUES ('product',0,'tax_bulk_classified',$1,$2)",[`${category}: ${ids.join(',')}`,actor(req)]);
  });
  res.json({ok:true,count:ids.length});
}));

router.get('/overview', ownerOnly, wrapped(async (req, res) => {
  const [profile, authorizations, documents, purchases, sales, branches, unclassified, report, creditNotes] = await Promise.all([
    req.tdb.get('SELECT * FROM {s}.sar_profiles WHERE id=1'),
    req.tdb.all(`SELECT a.id,a.branch_id,b.name AS branch_name,a.cai,a.establishment,a.emission_point,a.document_type,a.emitter_signature,
      a.range_start,a.range_end,a.next_number,a.expires_on,a.status,a.source_name,a.created_at,
      GREATEST(0,a.range_end-a.next_number+1) AS remaining,
      (a.expires_on < (now() AT TIME ZONE 'America/Tegucigalpa')::date) AS expired
      FROM {s}.sar_authorizations a LEFT JOIN {s}.branches b ON b.id=a.branch_id ORDER BY a.created_at DESC`, []),
    req.tdb.all(`SELECT d.id,d.order_id,d.document_number,d.status,d.issued_at,d.annul_reason,
      o.total::float AS order_total,o.service_branch_name
      FROM {s}.sar_documents d JOIN {s}.orders o ON o.id=d.order_id ORDER BY d.issued_at DESC LIMIT 100`),
    req.tdb.all(`SELECT id,purchase_order_id,document_type,original_purchase_id,supplier_name,supplier_rtn,cai,document_number,issued_on,
      exempt_amount,exonerated_amount,taxable_15,isv_15,creditable_isv_15,taxable_18,isv_18,creditable_isv_18,
      total,accounted_on,oce_number,exemption_resolution,notes,source_name,status,void_reason,created_at
      FROM {s}.sar_purchase_documents ORDER BY issued_on DESC,id DESC LIMIT 100`),
    req.tdb.all(`SELECT o.id,o.created_at,o.total::float AS total,o.status,o.channel,o.payment_status,o.payment_method,o.service_branch_id,
      o.service_branch_name,o.items,o.sar_exoneration_enc,
      o.sar_exoneration_proof_name,d.id AS sar_document_id,d.document_number AS sar_document_number,d.status AS sar_status
      FROM {s}.orders o LEFT JOIN {s}.sar_documents d ON d.order_id=o.id AND d.status='issued'
      WHERE o.channel='pos' AND o.status<>'cancelado' ORDER BY o.created_at DESC LIMIT 100`),
    req.tdb.all('SELECT id,name FROM {s}.branches WHERE active=1 ORDER BY name'),
    req.tdb.get("SELECT COUNT(*)::int AS count FROM {s}.products WHERE active=1 AND sar_tax_category=''"),
    req.tdb.get(`SELECT COUNT(*)::int AS issued_count,
      COALESCE(SUM(o.total) FILTER (WHERE d.status='issued'),0)::float AS sales_total,
      COUNT(*) FILTER (WHERE d.status='annulled')::int AS annulled_count
      FROM {s}.sar_documents d JOIN {s}.orders o ON o.id=d.order_id`),
    req.tdb.all(`SELECT n.id,n.original_document_id,n.document_number,n.status,n.refund_status,n.refund_method,
      n.restocked,n.issued_at,n.reason,n.snapshot_enc,d.order_id,o.payment_status,o.payment_method
      FROM {s}.sar_credit_notes n JOIN {s}.sar_documents d ON d.id=n.original_document_id
      JOIN {s}.orders o ON o.id=d.order_id ORDER BY n.issued_at DESC LIMIT 100`),
  ]);
  const signature = profile ? emitterSignature(profile) : '';
  res.json({ profile, authorizations: authorizations.map(({ emitter_signature, ...a }) => ({ ...a, compatible: emitter_signature === signature })), documents, purchases,
    sales:sales.map(({sar_exoneration_enc,...sale}) => ({...sale,sarExoneration:sar_exoneration_enc ? parseJson(decrypt(sar_exoneration_enc)) : null})), branches, unclassified: unclassified.count, report,
    creditNotes:creditNotes.map(({snapshot_enc,...row}) => ({...row,totals:parseJson(decrypt(snapshot_enc))?.totals || {}})) });
}));

router.put('/profile', ownerOnly, wrapped(async (req, res) => {
  const rtn = clean(req.body?.rtn, 20).replace(/[-\s]/g, '');
  const legalName = clean(req.body?.legalName, 180);
  const tradeName = clean(req.body?.tradeName, 180);
  const address = clean(req.body?.address, 350);
  const phone = clean(req.body?.phone, 40);
  const deliveryCategory = clean(req.body?.deliveryTaxCategory, 20);
  if (!validRtn(rtn) || !legalName || !address) throw fail(400, 'Registra RTN de 14 dígitos, razón social y domicilio fiscal');
  if (deliveryCategory && !TAX_CATEGORIES.has(deliveryCategory)) throw fail(400, 'Categoría ISV de entrega inválida');
  const profile = await req.tdb.get(`INSERT INTO {s}.sar_profiles(id,rtn,legal_name,trade_name,address,phone,delivery_tax_category)
    VALUES (1,$1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO UPDATE SET rtn=$1,legal_name=$2,trade_name=$3,
    address=$4,phone=$5,delivery_tax_category=$6,updated_at=now() RETURNING *`,
  [rtn, legalName, tradeName, address, phone, deliveryCategory]);
  res.json({ ok: true, profile });
}));

router.post('/authorizations', ownerOnly, upload.single('pdf'), wrapped(async (req, res) => {
  const body = req.body || {};
  const cai = clean(body.cai, 40).toUpperCase();
  const establishment = clean(body.establishment, 3);
  const emissionPoint = clean(body.emissionPoint, 3);
  const rangeStart = Number(body.rangeStart), rangeEnd = Number(body.rangeEnd), nextNumber = Number(body.nextNumber || body.rangeStart);
  const branchId = positiveId(body.branchId);
  const expiresOn = clean(body.expiresOn, 10);
  const documentType = clean(body.documentType || '01', 2);
  if (!['01','07'].includes(documentType)) throw fail(400, 'Selecciona Factura (01) o Nota de crédito (07) según el SAR-927');
  if (!validCai(cai) || !/^\d{3}$/.test(establishment) || !/^\d{3}$/.test(emissionPoint)) throw fail(400, 'Revisa el CAI y el establecimiento/punto de emisión del SAR-927');
  if (![rangeStart, rangeEnd, nextNumber].every(Number.isSafeInteger) || rangeStart < 1 || rangeEnd > 99999999 || rangeEnd < rangeStart || nextNumber < rangeStart || nextNumber > rangeEnd + 1) throw fail(400, 'Rango o siguiente correlativo inválido');
  if (!validIsoDate(expiresOn)) throw fail(400, 'Fecha límite inválida');
  if (!req.file || req.file.buffer.subarray(0, 5).toString() !== '%PDF-') throw fail(400, 'Adjunta el SAR-927 en PDF');
  const result = await req.tdb.tx(async (tx) => {
    const profile = await tx.get('SELECT * FROM {s}.sar_profiles WHERE id=1 FOR UPDATE');
    if (!profile) throw fail(409, 'Configura primero el emisor SAR');
    const branch = await tx.get('SELECT id FROM {s}.branches WHERE id=$1 AND active=1', [branchId]);
    if (!branch) throw fail(400, 'Selecciona una sucursal activa');
    const overlapping = await tx.get(`SELECT id FROM {s}.sar_authorizations WHERE establishment=$1 AND emission_point=$2
      AND document_type=$5 AND status<>'invalid' AND range_start<=$4 AND range_end>=$3 LIMIT 1`, [establishment, emissionPoint, rangeStart, rangeEnd,documentType]);
    if (overlapping) throw fail(409, 'Ese rango se cruza con una autorización ya registrada');
    const row = await tx.get(`INSERT INTO {s}.sar_authorizations
      (branch_id,cai,establishment,emission_point,emitter_signature,document_type,range_start,range_end,next_number,expires_on,source_name,source_pdf,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [branchId, cai, establishment, emissionPoint, emitterSignature(profile), documentType, rangeStart, rangeEnd, nextNumber, expiresOn, clean(req.file?.originalname, 180), req.file?.buffer || null, actor(req)]);
    await tx.run("INSERT INTO {s}.sar_events(subject_type,subject_id,event_type,detail,actor) VALUES ('authorization',$1,'loaded',$2,$3)", [row.id, `Tipo ${documentType}; CAI ${cai}; rango ${rangeStart}-${rangeEnd}; siguiente ${nextNumber}`, actor(req)]);
    return row;
  });
  res.status(201).json({ ok: true, id: result.id });
}));

router.get('/authorizations/:id/pdf', ownerOnly, wrapped(async (req, res) => {
  const row = await req.tdb.get('SELECT source_name,source_pdf FROM {s}.sar_authorizations WHERE id=$1', [positiveId(req.params.id)]);
  if (!row?.source_pdf) throw fail(404, 'Esta autorización no tiene PDF adjunto');
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `attachment; filename="sar-927-${positiveId(req.params.id)}.pdf"`);
  res.send(row.source_pdf);
}));

router.post('/authorizations/:id/invalidate', ownerOnly, wrapped(async (req, res) => {
  const id = positiveId(req.params.id);
  const reason = clean(req.body?.reason, 300);
  if (reason.length < 8) throw fail(400, 'Explica por qué se invalida el registro local');
  await req.tdb.tx(async (tx) => {
    const auth = await tx.get('SELECT id,status FROM {s}.sar_authorizations WHERE id=$1 FOR UPDATE', [id]);
    if (!auth) throw fail(404, 'Autorización no encontrada');
    if (auth.status === 'invalid') throw fail(409, 'Ya fue invalidada');
    if (await tx.get('SELECT id FROM {s}.sar_documents WHERE authorization_id=$1 LIMIT 1', [id]) || await tx.get('SELECT id FROM {s}.sar_credit_notes WHERE authorization_id=$1 LIMIT 1', [id])) throw fail(409, 'Este rango ya emitió documentos; consulta a tu contador antes de corregirlo');
    await tx.run("UPDATE {s}.sar_authorizations SET status='invalid' WHERE id=$1", [id]);
    await tx.run("INSERT INTO {s}.sar_events(subject_type,subject_id,event_type,detail,actor) VALUES ('authorization',$1,'invalidated',$2,$3)", [id,reason,actor(req)]);
  });
  res.json({ ok:true });
}));

router.post('/orders/:id/exoneration-proof', requireModules('pos'), upload.single('pdf'), wrapped(async (req,res) => {
  const id = positiveId(req.params.id);
  if (!req.file || req.file.buffer.subarray(0,5).toString() !== '%PDF-') throw fail(400, 'Adjunta la constancia u OCE en PDF');
  await req.tdb.tx(async (tx) => {
    const order = await tx.get('SELECT id,channel,service_branch_id,sar_exoneration_enc FROM {s}.orders WHERE id=$1 FOR UPDATE', [id]);
    if (!order || order.channel !== 'pos' || !order.sar_exoneration_enc) throw fail(404, 'Venta exonerada no encontrada');
    if (!isOwner(req) && Number(req.user.branchId) !== Number(order.service_branch_id)) throw fail(403, 'Venta de otra sucursal');
    if (await tx.get('SELECT id FROM {s}.sar_documents WHERE order_id=$1 AND status=$2', [id,'issued'])) throw fail(409, 'La factura ya fue emitida');
    await tx.run('UPDATE {s}.orders SET sar_exoneration_proof_name=$1,sar_exoneration_proof_pdf=$2 WHERE id=$3', [clean(req.file.originalname,180),req.file.buffer,id]);
    await tx.run("INSERT INTO {s}.sar_events(subject_type,subject_id,event_type,detail,actor) VALUES ('order',$1,'exoneration_proof_loaded',$2,$3)", [id,clean(req.file.originalname,180),actor(req)]);
  });
  res.json({ok:true});
}));

router.get('/orders/:id/exoneration-proof', ownerOnly, wrapped(async (req,res) => {
  const row = await req.tdb.get('SELECT sar_exoneration_proof_pdf FROM {s}.orders WHERE id=$1', [positiveId(req.params.id)]);
  if (!row?.sar_exoneration_proof_pdf) throw fail(404,'Sin constancia adjunta');
  res.type('pdf').send(row.sar_exoneration_proof_pdf);
}));

router.post('/orders/:id/issue', requireModules('pos'), wrapped(async (req, res) => {
  const orderId = positiveId(req.params.id);
  const receiverName = clean(req.body?.receiverName || 'Consumidor final', 180);
  const receiverRtn = clean(req.body?.receiverRtn, 20).replace(/[-\s]/g, '');
  const receiverId = clean(req.body?.receiverId, 30);
  if (!receiverName || (receiverRtn && !validRtn(receiverRtn))) throw fail(400, 'Revisa el nombre y RTN del receptor');
  if (receiverRtn && receiverName.toLocaleLowerCase('es-HN') === 'consumidor final') throw fail(400, 'Escribe el nombre fiscal del receptor cuando captures su RTN');
  const document = await req.tdb.tx(async (tx) => {
    const order = await tx.get(`SELECT id,items,total::float AS total,delivery_fee::float AS delivery_fee,
      channel,status,payment_status,payment_method,service_branch_id,service_branch_name,created_at,
      sar_exoneration_enc,sar_exoneration_proof_name,sar_delivery_exonerated
      FROM {s}.orders WHERE id=$1 FOR UPDATE`, [orderId]);
    if (!order || order.channel !== 'pos') throw fail(404, 'Venta POS no encontrada');
    if (order.status === 'cancelado' || (order.payment_status !== 'paid' && order.payment_method !== 'credit')) throw fail(409, 'La venta debe estar confirmada, cobrada o registrada a crédito');
    if (!isOwner(req) && Number(req.user.branchId) !== Number(order.service_branch_id)) throw fail(403, 'La venta pertenece a otra sucursal');
    const existing = await tx.get("SELECT id,document_number FROM {s}.sar_documents WHERE order_id=$1 AND status='issued'", [orderId]);
    if (existing) return { ...existing, duplicate: true };
    const profile = await tx.get('SELECT * FROM {s}.sar_profiles WHERE id=1');
    if (!profile || !validRtn(profile.rtn) || !profile.legal_name || !profile.address) throw fail(409, 'Completa los datos fiscales del emisor');
    const items = parseJson(order.items);
    if (!Array.isArray(items) || !items.length) throw fail(409, 'La venta no contiene partidas válidas');
    if (items.some((item) => item.taxEnabled)) throw fail(409, 'Esta venta usó el impuesto genérico de productos. Desactívalo para Honduras y revisa la venta antes de emitir SAR');
    const exoneration = order.sar_exoneration_enc ? parseJson(decrypt(order.sar_exoneration_enc)) : null;
    if (exoneration && (!order.sar_exoneration_proof_name || receiverName !== exoneration.name || receiverRtn !== exoneration.rtn)) throw fail(409, 'Adjunta la constancia de exoneración y usa el nombre/RTN registrados al cobrar');
    const calculation = calculateSarTotals(items, order.delivery_fee, profile.delivery_tax_category, order.sar_delivery_exonerated);
    if (Math.abs(calculation.totals.total - Number(order.total)) > 0.01) throw fail(409, 'El total fiscal no coincide con la venta; revisa precios, descuentos e ISV');
    if (calculation.totals.total > 10000 && (receiverName.toLocaleLowerCase('es-HN') === 'consumidor final' || (!receiverRtn && !receiverId))) throw fail(400, 'Indica nombre e identidad o RTN del comprador en facturas mayores de L 10,000');
    const auth = await tx.get(`SELECT * FROM {s}.sar_authorizations
      WHERE branch_id=$1 AND emitter_signature=$2 AND document_type='01' AND status='active' AND next_number<=range_end
      AND expires_on >= (now() AT TIME ZONE 'America/Tegucigalpa')::date
      ORDER BY expires_on,range_start,id LIMIT 1 FOR UPDATE`, [order.service_branch_id, emitterSignature(profile)]);
    if (!auth) throw fail(409, 'No hay folios SAR vigentes para esta sucursal y estos datos de emisor. Solicita una autorización en la Oficina Virtual y carga su SAR-927');
    const number = sarNumber(auth.establishment, auth.emission_point, auth.document_type, auth.next_number);
    const receiver = { name: receiverName, rtn: receiverRtn, identity: receiverId, exoneration };
    const snapshot = { issuer: { rtn: profile.rtn, legalName: profile.legal_name, tradeName: profile.trade_name, address: profile.address, phone: profile.phone },
      authorization: { cai: auth.cai, establishment: auth.establishment, emissionPoint: auth.emission_point, rangeStart: auth.range_start, rangeEnd: auth.range_end, expiresOn: auth.expires_on },
      order: { id: order.id, branch: order.service_branch_name, paymentMethod: order.payment_method, createdAt: order.created_at },
      lines: calculation.lines, totals: calculation.totals };
    const row = await tx.get(`INSERT INTO {s}.sar_documents(order_id,authorization_id,document_number,sequential,receiver_enc,snapshot_enc,issued_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id,document_number`, [orderId, auth.id, number, auth.next_number, encrypt(JSON.stringify(receiver)), encrypt(JSON.stringify(snapshot)), actor(req)]);
    await tx.run('UPDATE {s}.sar_authorizations SET next_number=next_number+1 WHERE id=$1', [auth.id]);
    await tx.run("INSERT INTO {s}.sar_events(subject_type,subject_id,event_type,detail,actor) VALUES ('document',$1,'issued',$2,$3)", [row.id, number, actor(req)]);
    return row;
  });
  res.status(document.duplicate ? 200 : 201).json({ ok: true, ...document });
}));

async function fullDocument(req, id) {
  const row = await req.tdb.get(`SELECT d.id,d.order_id,d.document_number,d.status,d.issued_at,d.annul_reason,d.annulled_at,
    d.receiver_enc,d.snapshot_enc,o.service_branch_id FROM {s}.sar_documents d JOIN {s}.orders o ON o.id=d.order_id WHERE d.id=$1`, [id]);
  if (!row) throw fail(404, 'Comprobante no encontrado');
  if (!isOwner(req) && Number(req.user.branchId) !== Number(row.service_branch_id)) throw fail(403, 'La factura pertenece a otra sucursal');
  return { id: row.id, orderId: row.order_id, documentNumber: row.document_number, status: row.status, issuedAt: row.issued_at,
    annulReason: row.annul_reason, annulledAt: row.annulled_at, receiver: parseJson(decrypt(row.receiver_enc)), snapshot: parseJson(decrypt(row.snapshot_enc)) };
}

router.get('/documents/:id', requireModules('pos'), wrapped(async (req, res) => res.json(await fullDocument(req, positiveId(req.params.id)))));
router.get('/documents/:id/print', requireModules('pos'), wrapped(async (req, res) => {
  const doc = await fullDocument(req, positiveId(req.params.id));
  const s = doc.snapshot || {}, t = s.totals || {}, a = s.authorization || {}, i = s.issuer || {};
  const fmt = (v) => `L ${Number(v || 0).toFixed(2)}`;
  const fmtUnit=(v)=>`L ${Number(v || 0).toFixed(Number(v) === money(v) ? 2 : 4)}`;
  const rows = (s.lines || []).map((line) => `<tr><td>${esc(line.name)}<br><small>${esc(line.quantity)} × ${fmtUnit(line.unitPrice)} · ${esc(line.exonerated ? `Exonerado ${line.category === 'tax18' ? '18' : '15'}%` : ({exempt:'Exento',tax15:'ISV 15%',tax18:'ISV 18%'})[line.category] || '')}</small></td><td>${fmt(line.gross)}</td></tr>`).join('');
  const html = `<!doctype html><html lang="es"><meta charset="utf-8"><title>Factura ${esc(doc.documentNumber)}</title>
    <style>body{font:12px Arial,sans-serif;max-width:76mm;margin:auto;color:#111}h2{text-align:center;margin:8px 0}p{margin:4px 0}table{width:100%;border-collapse:collapse;margin:9px 0}td{padding:4px 0;border-bottom:1px dashed #aaa}td:last-child{text-align:right;white-space:nowrap}.center{text-align:center}.total{font-size:16px;font-weight:bold}small{font-size:10px}@media print{button{display:none}}</style>
    <body><h2>${esc(i.tradeName || i.legalName)}</h2><p class="center">${esc(i.legalName)}<br>RTN: ${esc(i.rtn)}<br>${esc(i.address)}<br>${esc(i.phone)}</p>
    <hr><p class="center"><b>FACTURA</b><br>No. ${esc(doc.documentNumber)}</p><p>Fecha: ${esc(new Date(doc.issuedAt).toLocaleString('es-HN',{timeZone:'America/Tegucigalpa'}))}<br>Cliente: ${esc(doc.receiver?.name)}<br>RTN cliente: ${esc(doc.receiver?.rtn || '')}<br>Identidad: ${esc(doc.receiver?.identity || '')}</p>
    ${doc.receiver?.exoneration ? `<p>Exoneración ${esc(doc.receiver.exoneration.evidenceType)}: ${esc(doc.receiver.exoneration.evidenceNumber)}</p>` : ''}
    <table>${rows}</table><p>Exento: ${fmt(t.exempt)}<br>Exonerado 15%: ${fmt(t.exonerated15)}<br>Exonerado 18%: ${fmt(t.exonerated18)}<br>Base gravada 15%: ${fmt(t.taxable15)}<br>ISV 15%: ${fmt(t.isv15)}<br>Base gravada 18%: ${fmt(t.taxable18)}<br>ISV 18%: ${fmt(t.isv18)}</p>
    <p class="total">TOTAL: ${fmt(t.total)}</p><p>Forma de pago: ${esc(s.order?.paymentMethod || '')}<br>Sucursal: ${esc(s.order?.branch || '')}<br>Venta interna: #${esc(s.order?.id || '')}</p><hr><p>CAI: ${esc(a.cai)}<br>Rango autorizado: ${esc(sarNumber(a.establishment,a.emissionPoint,'01',a.rangeStart))} al ${esc(sarNumber(a.establishment,a.emissionPoint,'01',a.rangeEnd))}<br>Fecha límite de emisión: ${esc(String(a.expiresOn).slice(0,10))}</p>
    <p class="center">${doc.status === 'annulled' ? '<b>ANULADA</b>' : 'Original cliente · Copia emisor'}</p><button onclick="window.print()">Imprimir</button></body></html>`;
  res.type('html').send(html);
}));

router.post('/documents/:id/annul', ownerOnly, wrapped(async (req, res) => {
  const reason = clean(req.body?.reason, 300);
  if (reason.length < 8) throw fail(400, 'Explica el motivo de anulación (mínimo 8 caracteres)');
  const id = positiveId(req.params.id);
  const row = await req.tdb.tx(async (tx) => {
    const doc = await tx.get('SELECT id,status FROM {s}.sar_documents WHERE id=$1 FOR UPDATE', [id]);
    if (!doc) throw fail(404, 'Comprobante no encontrado');
    if (doc.status !== 'issued') throw fail(409, 'El comprobante ya está anulado');
    if (await tx.get("SELECT id FROM {s}.sar_credit_notes WHERE original_document_id=$1 AND status='issued' LIMIT 1",[id])) throw fail(409,'La factura tiene notas de crédito vigentes; revisa la corrección con tu contador');
    await tx.run("UPDATE {s}.sar_documents SET status='annulled',annul_reason=$1,annulled_by=$2,annulled_at=now() WHERE id=$3", [reason, actor(req), id]);
    await tx.run("INSERT INTO {s}.sar_events(subject_type,subject_id,event_type,detail,actor) VALUES ('document',$1,'annulled',$2,$3)", [id, reason, actor(req)]);
    return doc;
  });
  res.json({ ok: true, id: row.id });
}));

router.post('/documents/:id/credit-notes', ownerOnly, wrapped(async (req,res) => {
  const documentId = positiveId(req.params.id);
  const reason = clean(req.body?.reason,300);
  if (reason.length < 8) throw fail(400,'Describe la devolución o ajuste con al menos 8 caracteres');
  const result = await req.tdb.tx(async (tx) => {
    const original = await tx.get(`SELECT d.*,o.service_branch_id,o.service_branch_name,o.branch_stock_applied
      FROM {s}.sar_documents d JOIN {s}.orders o ON o.id=d.order_id WHERE d.id=$1 FOR UPDATE OF d`,[documentId]);
    if (!original) throw fail(404,'Factura original no encontrada');
    if (original.status !== 'issued') throw fail(409,'La factura original está anulada');
    const source = parseJson(decrypt(original.snapshot_enc));
    const receiver = parseJson(decrypt(original.receiver_enc));
    if (!source?.lines?.length) throw fail(409,'La factura original no tiene partidas válidas');
    const previous = await tx.all("SELECT snapshot_enc FROM {s}.sar_credit_notes WHERE original_document_id=$1 AND status='issued' FOR UPDATE",[documentId]);
    const credits = previous.map((row) => parseJson(decrypt(row.snapshot_enc))).filter(Boolean);
    const calculation = calculateSarCredit(source.lines,credits,req.body?.quantities);
    const profile = await tx.get('SELECT * FROM {s}.sar_profiles WHERE id=1');
    if (!profile || emitterSignature(profile) !== (await tx.get('SELECT emitter_signature FROM {s}.sar_authorizations WHERE id=$1',[original.authorization_id]))?.emitter_signature) throw fail(409,'El emisor cambió; revisa el documento original antes de acreditar');
    const auth = await tx.get(`SELECT * FROM {s}.sar_authorizations WHERE branch_id=$1 AND emitter_signature=$2
      AND document_type='07' AND status='active' AND next_number<=range_end
      AND expires_on >= (now() AT TIME ZONE 'America/Tegucigalpa')::date
      ORDER BY expires_on,range_start,id LIMIT 1 FOR UPDATE`,[original.service_branch_id,emitterSignature(profile)]);
    if (!auth) throw fail(409,'Carga la autorización SAR-927 de Nota de Crédito (tipo 07) para esta sucursal');
    const number = sarNumber(auth.establishment,auth.emission_point,'07',auth.next_number);
    const snapshot = { issuer:source.issuer, receiver, original: { number:original.document_number, cai:source.authorization.cai, issuedAt:original.issued_at, documentId },
      authorization:{ cai:auth.cai,establishment:auth.establishment,emissionPoint:auth.emission_point,rangeStart:auth.range_start,rangeEnd:auth.range_end,expiresOn:auth.expires_on },
      branch:original.service_branch_name, lines:calculation.lines, totals:calculation.totals, reason };
    const row = await tx.get(`INSERT INTO {s}.sar_credit_notes(original_document_id,authorization_id,document_number,sequential,reason,snapshot_enc,issued_by)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,document_number`,[documentId,auth.id,number,auth.next_number,reason,encrypt(JSON.stringify(snapshot)),actor(req)]);
    await tx.run('UPDATE {s}.sar_authorizations SET next_number=next_number+1 WHERE id=$1',[auth.id]);
    await tx.run("INSERT INTO {s}.sar_events(subject_type,subject_id,event_type,detail,actor) VALUES ('credit_note',$1,'issued',$2,$3)",[row.id,`Original ${original.document_number}; ${reason}`,actor(req)]);
    return row;
  });
  res.status(201).json({ok:true,...result});
}));

router.get('/documents/:id/credit-balance', ownerOnly, wrapped(async (req,res) => {
  const id=positiveId(req.params.id);
  const doc=await req.tdb.get('SELECT status,document_number,snapshot_enc FROM {s}.sar_documents WHERE id=$1',[id]);
  if (!doc) throw fail(404,'Factura no encontrada');
  const original=parseJson(decrypt(doc.snapshot_enc)) || {};
  const credits=await req.tdb.all("SELECT snapshot_enc FROM {s}.sar_credit_notes WHERE original_document_id=$1 AND status='issued'",[id]);
  const snapshots=credits.map((row)=>parseJson(decrypt(row.snapshot_enc))).filter(Boolean);
  res.json({status:doc.status,number:doc.document_number,lines:(original.lines || []).map((line,index) => ({...line,
    remaining:money(Number(line.quantity)-snapshots.reduce((sum,note)=>sum+Number(note.lines?.find((entry)=>Number(entry.originalLineIndex)===index)?.quantity || 0),0))}))});
}));

router.get('/credit-notes/:id/print', requireModules('pos'), wrapped(async (req,res) => {
  const row = await req.tdb.get(`SELECT n.*,o.service_branch_id FROM {s}.sar_credit_notes n
    JOIN {s}.sar_documents d ON d.id=n.original_document_id JOIN {s}.orders o ON o.id=d.order_id WHERE n.id=$1`,[positiveId(req.params.id)]);
  if (!row) throw fail(404,'Nota de crédito no encontrada');
  if (!isOwner(req) && Number(req.user.branchId) !== Number(row.service_branch_id)) throw fail(403,'Nota de otra sucursal');
  const s = parseJson(decrypt(row.snapshot_enc)) || {};
  const a = s.authorization || {},t=s.totals || {},i=s.issuer || {},r=s.receiver || {},o=s.original || {};
  const fmt = (value) => `L ${Number(value || 0).toFixed(2)}`;
  const fmtUnit=(value)=>`L ${Number(value || 0).toFixed(Number(value) === money(value) ? 2 : 4)}`;
  const lines = (s.lines || []).map((line) => `<tr><td>${esc(line.name)}<br>${esc(line.quantity)} × ${fmtUnit(line.unitPrice)}</td><td>${fmt(line.gross)}</td></tr>`).join('');
  res.type('html').send(`<!doctype html><html lang="es"><meta charset="utf-8"><title>Nota de crédito ${esc(row.document_number)}</title>
    <style>body{font:12px Arial;max-width:76mm;margin:auto}h2{text-align:center}table{width:100%;border-collapse:collapse}td{border-bottom:1px dashed #aaa;padding:5px}td:last-child{text-align:right}b.total{font-size:16px}@media print{button{display:none}}</style>
    <body><h2>${esc(i.tradeName || i.legalName)}</h2><p>${esc(i.legalName)}<br>RTN ${esc(i.rtn)}<br>${esc(i.address)}</p><hr><h2>NOTA DE CRÉDITO</h2>
    <p>No. ${esc(row.document_number)}<br>Fecha: ${esc(new Date(row.issued_at).toLocaleString('es-HN',{timeZone:'America/Tegucigalpa'}))}<br>Cliente: ${esc(r.name)}<br>RTN: ${esc(r.rtn)}<br>Identidad: ${esc(r.identity)}<br>Factura original: ${esc(o.number)}<br>Fecha factura: ${esc(String(o.issuedAt).slice(0,10))}<br>CAI factura: ${esc(o.cai)}<br>Motivo: ${esc(s.reason)}</p>
    <table>${lines}</table><p>Exento: ${fmt(t.exempt)}<br>Exonerado 15%: ${fmt(t.exonerated15)}<br>Exonerado 18%: ${fmt(t.exonerated18)}<br>Base 15%: ${fmt(t.taxable15)}<br>ISV 15%: ${fmt(t.isv15)}<br>Base 18%: ${fmt(t.taxable18)}<br>ISV 18%: ${fmt(t.isv18)}</p>
    <p><b class="total">TOTAL ACREDITADO: ${fmt(t.total)}</b></p><p>Firma de recibido: ____________________<br>No. identidad: ____________________</p><hr><p>CAI: ${esc(a.cai)}<br>Rango: ${esc(sarNumber(a.establishment,a.emissionPoint,'07',a.rangeStart))} al ${esc(sarNumber(a.establishment,a.emissionPoint,'07',a.rangeEnd))}<br>Fecha límite: ${esc(String(a.expiresOn).slice(0,10))}</p><p>${row.status === 'annulled' ? '<b>ANULADA</b>' : 'Original cliente · Copia emisor'}</p><button onclick="window.print()">Imprimir</button></body></html>`);
}));

router.post('/credit-notes/:id/annul', ownerOnly, wrapped(async (req,res) => {
  const id = positiveId(req.params.id), reason=clean(req.body?.reason,300);
  if (reason.length < 8) throw fail(400,'Explica el motivo de anulación');
  await req.tdb.tx(async (tx) => {
    const note=await tx.get('SELECT status,refund_status FROM {s}.sar_credit_notes WHERE id=$1 FOR UPDATE',[id]);
    if (!note) throw fail(404,'Nota de crédito no encontrada');
    if (note.status !== 'issued') throw fail(409,'La nota ya fue anulada');
    if (note.refund_status === 'completed') throw fail(409,'Esta nota ya tiene una devolución registrada; concilia el dinero antes de anularla');
    await tx.run("UPDATE {s}.sar_credit_notes SET status='annulled',annul_reason=$1,annulled_by=$2,annulled_at=now() WHERE id=$3",[reason,actor(req),id]);
    await tx.run("INSERT INTO {s}.sar_events(subject_type,subject_id,event_type,detail,actor) VALUES ('credit_note',$1,'annulled',$2,$3)",[id,reason,actor(req)]);
  });
  res.json({ok:true});
}));

router.post('/credit-notes/:id/refund', ownerOnly, wrapped(async (req,res) => {
  const id=positiveId(req.params.id), method=clean(req.body?.method,20), reference=clean(req.body?.reference,120);
  const restock=req.body?.restock === true;
  if (!['cash','card','transfer','credit_balance'].includes(method) || (['card','transfer'].includes(method) && !reference)) throw fail(400,'Indica medio de devolución y referencia para tarjeta o transferencia');
  await req.tdb.tx(async (tx) => {
    const row=await tx.get(`SELECT n.*,d.order_id,o.service_branch_id,o.branch_stock_applied,
      o.total::float AS order_total,o.payment_status,o.payment_method,o.sar_credit_adjustment_total::float AS credit_adjustment_total
      FROM {s}.sar_credit_notes n JOIN {s}.sar_documents d ON d.id=n.original_document_id
      JOIN {s}.orders o ON o.id=d.order_id WHERE n.id=$1 FOR UPDATE OF n,o`,[id]);
    if (!row) throw fail(404,'Nota de crédito no encontrada');
    if (row.status !== 'issued' || row.refund_status !== 'pending') throw fail(409,'La nota no está pendiente de devolución');
    const snapshot=parseJson(decrypt(row.snapshot_enc));
    const pendingCredit=row.payment_status === 'pending' && row.payment_method === 'credit';
    if (pendingCredit && method !== 'credit_balance') throw fail(409,'La venta aún no se ha cobrado; aplica la nota al saldo del crédito');
    if (!pendingCredit && method === 'credit_balance') throw fail(409,'La venta ya fue cobrada; registra la devolución por el medio usado');
    let movementId=null;
    if (method === 'cash') {
      const session=await tx.get("SELECT id FROM {s}.pos_sessions WHERE branch_id=$1 AND status='open' ORDER BY id DESC LIMIT 1 FOR UPDATE",[row.service_branch_id]);
      if (!session) throw fail(409,'Abre la caja de la sucursal antes de devolver efectivo');
      const movement=await tx.get(`INSERT INTO {s}.pos_cash_movements(session_id,kind,amount,note,created_by)
        VALUES($1,'withdrawal',$2,$3,$4) RETURNING id`,[session.id,snapshot.totals.total,`Devolución nota SAR ${row.document_number}`,actor(req)]);
      movementId=movement.id;
    }
    if (restock) {
      if (!Number(row.branch_stock_applied)) throw fail(409,'La venta no descontó stock de sucursal; ajusta inventario manualmente');
      const items=snapshot.lines.filter((line) => Number(line.productId)>0).map((line) => ({id:line.productId,qty:line.quantity}));
      if (items.length && !(await restoreBranchSaleStock(tx,row.service_branch_id,items))) throw fail(409,'No se pudo reponer stock de la sucursal');
    }
    if (method === 'credit_balance') {
      const remaining=money(Number(row.order_total)-Number(row.credit_adjustment_total || 0));
      if (Number(snapshot.totals.total) > remaining+0.01) throw fail(409,'La nota supera el saldo pendiente del crédito');
      await tx.run(`UPDATE {s}.orders SET sar_credit_adjustment_total=sar_credit_adjustment_total+$1,
        payment_status=CASE WHEN total-sar_credit_adjustment_total-$1<=0.01 THEN 'paid' ELSE payment_status END,
        sar_credit_adjusted_at=CASE WHEN total-sar_credit_adjustment_total-$1<=0.01 THEN now() ELSE sar_credit_adjusted_at END,
        sar_credit_adjusted_by=$3
        WHERE id=$2`,[snapshot.totals.total,row.order_id,actor(req)]);
    }
    await tx.run(`UPDATE {s}.sar_credit_notes SET refund_status='completed',refund_method=$1,refund_reference=$2,
      refund_at=now(),cash_movement_id=$3,restocked=$4 WHERE id=$5`,[method,reference,movementId,restock,id]);
    await tx.run("INSERT INTO {s}.sar_events(subject_type,subject_id,event_type,detail,actor) VALUES ('credit_note',$1,'refunded',$2,$3)",[id,`${method}; ${reference}; restock=${restock}`,actor(req)]);
  });
  res.json({ok:true});
}));

router.post('/purchases', ownerOnly, upload.single('pdf'), wrapped(async (req, res) => {
  const b = req.body || {};
  const supplierName = clean(b.supplierName, 180), supplierRtn = clean(b.supplierRtn, 20).replace(/[-\s]/g, '');
  const cai = clean(b.cai, 40).toUpperCase(), documentNumber = clean(b.documentNumber, 24);
  const documentType=clean(b.documentType || '01',2);
  const issuedOn = clean(b.issuedOn, 10), accountedOn = clean(b.accountedOn || issuedOn,10);
  if (req.file && req.file.buffer.subarray(0, 5).toString() !== '%PDF-') throw fail(400, 'El comprobante adjunto debe ser PDF');
  if (!['01','07'].includes(documentType) || !supplierName || !validRtn(supplierRtn) || !validCai(cai) || parseDocumentNumber(documentNumber)?.documentType !== documentType || !validIsoDate(issuedOn) || !validIsoDate(accountedOn) || accountedOn < issuedOn) throw fail(400, 'Revisa tipo, proveedor, RTN, CAI, número y fechas de emisión/contabilización');
  const amounts = ['exemptAmount','taxable15','isv15','taxable18','isv18','total'].map((key) => safeMoney(b[key]));
  const exoneratedAmount=safeMoney(b.exoneratedAmount || 0), creditable15=safeMoney(b.creditableIsv15 || 0), creditable18=safeMoney(b.creditableIsv18 || 0);
  if (creditable15 > amounts[2] || creditable18 > amounts[4]) throw fail(400,'El ISV acreditable no puede superar el ISV de la factura');
  if (Math.abs(money(amounts.slice(0,5).reduce((sum,value) => sum + value, exoneratedAmount)) - amounts[5]) > 0.01) throw fail(400, 'El total no coincide con bases e ISV');
  const oceNumber=clean(b.oceNumber,100), exemptionResolution=clean(b.exemptionResolution,100);
  if (exoneratedAmount > 0 && !oceNumber && !exemptionResolution) throw fail(400,'La compra exonerada requiere OCE o resolución');
  const originalPurchaseId=documentType === '07' ? positiveId(b.originalPurchaseId) : null;
  if (documentType === '07' && clean(b.notes,300).length < 8) throw fail(400,'Describe el motivo de la nota del proveedor');
  const purchaseOrderId = b.purchaseOrderId ? positiveId(b.purchaseOrderId) : null;
  if (purchaseOrderId) {
    const po = await req.tdb.get(`SELECT po.id,s.tax_id FROM {s}.purchase_orders po
      LEFT JOIN {s}.suppliers s ON s.id=po.supplier_id WHERE po.id=$1`, [purchaseOrderId]);
    if (!po) throw fail(404, 'Orden de compra no encontrada');
    if (po.tax_id && String(po.tax_id).replace(/\D/g,'') !== supplierRtn) throw fail(409, 'El RTN no coincide con el proveedor de la orden de compra');
  }
  try {
    const row = await req.tdb.tx(async (tx) => {
      if (originalPurchaseId) {
        const original=await tx.get('SELECT * FROM {s}.sar_purchase_documents WHERE id=$1 FOR UPDATE',[originalPurchaseId]);
        if (!original || original.status !== 'active' || original.document_type !== '01' || original.supplier_rtn !== supplierRtn) throw fail(409,'La factura original de compra no coincide con el proveedor');
        if (issuedOn < dateOnly(original.issued_on)) throw fail(409,'La nota del proveedor no puede anteceder a la factura original');
        const prior=await tx.all("SELECT * FROM {s}.sar_purchase_documents WHERE original_purchase_id=$1 AND status='active' FOR UPDATE",[originalPurchaseId]);
        const fields={exempt_amount:amounts[0],taxable_15:amounts[1],isv_15:amounts[2],taxable_18:amounts[3],isv_18:amounts[4],total:amounts[5],exonerated_amount:exoneratedAmount,creditable_isv_15:creditable15,creditable_isv_18:creditable18};
        for (const [key,value] of Object.entries(fields)) if (money(value+prior.reduce((sum,note)=>sum+Number(note[key] || 0),0)) > Number(original[key] || 0)+0.01) throw fail(409,`La nota supera el importe pendiente de la factura original (${key})`);
      }
      return tx.get(`INSERT INTO {s}.sar_purchase_documents(purchase_order_id,supplier_name,supplier_rtn,cai,document_number,issued_on,
      exempt_amount,taxable_15,isv_15,taxable_18,isv_18,total,notes,source_name,source_pdf,created_by,
      accounted_on,exonerated_amount,creditable_isv_15,creditable_isv_18,oce_number,exemption_resolution,document_type,original_purchase_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING id`,
      [purchaseOrderId,supplierName,supplierRtn,cai,documentNumber,issuedOn,...amounts,clean(b.notes,300),clean(req.file?.originalname,180),req.file?.buffer || null,actor(req),accountedOn,exoneratedAmount,creditable15,creditable18,oceNumber,exemptionResolution,documentType,originalPurchaseId]);
    });
    res.status(201).json({ ok: true, id: row.id });
  } catch (error) { if (error.code === '23505') throw fail(409, 'Ese comprobante de proveedor ya está registrado'); throw error; }
}));

router.get('/purchases/:id/pdf', ownerOnly, wrapped(async (req,res) => {
  const id = positiveId(req.params.id);
  const row = await req.tdb.get('SELECT source_pdf FROM {s}.sar_purchase_documents WHERE id=$1', [id]);
  if (!row?.source_pdf) throw fail(404, 'Esta compra no tiene PDF adjunto');
  res.set('Content-Type','application/pdf');
  res.set('Content-Disposition',`attachment; filename="compra-sar-${id}.pdf"`);
  res.send(row.source_pdf);
}));

router.post('/purchases/:id/void', ownerOnly, wrapped(async (req,res) => {
  const id = positiveId(req.params.id);
  const reason = clean(req.body?.reason, 300);
  if (reason.length < 8) throw fail(400, 'Explica el motivo de corrección de la compra');
  await req.tdb.tx(async (tx) => {
    const purchase = await tx.get('SELECT id,status FROM {s}.sar_purchase_documents WHERE id=$1 FOR UPDATE', [id]);
    if (!purchase) throw fail(404, 'Factura de compra no encontrada');
    if (purchase.status !== 'active') throw fail(409, 'La compra ya fue invalidada');
    if (await tx.get("SELECT id FROM {s}.sar_purchase_documents WHERE original_purchase_id=$1 AND status='active' LIMIT 1",[id])) throw fail(409,'Invalida primero las notas vigentes del proveedor');
    await tx.run("UPDATE {s}.sar_purchase_documents SET status='void',void_reason=$1,voided_at=now(),voided_by=$2 WHERE id=$3", [reason,actor(req),id]);
    await tx.run("INSERT INTO {s}.sar_events(subject_type,subject_id,event_type,detail,actor) VALUES ('purchase',$1,'voided',$2,$3)", [id,reason,actor(req)]);
  });
  res.json({ ok:true });
}));

const emptyTotals = () => ({ exempt:0,exonerated15:0,exonerated18:0,taxable15:0,isv15:0,taxable18:0,isv18:0,total:0 });
const addTotals = (target,source,sign=1) => { for (const key of Object.keys(target)) target[key]=money(target[key]+sign*Number(source?.[key] || 0)); };

async function buildReport(tdb,from,to) {
  const [docs, notes, purchases] = await Promise.all([
    tdb.all(`SELECT id,order_id,document_number,status,issued_at,snapshot_enc FROM {s}.sar_documents
      WHERE (issued_at AT TIME ZONE 'America/Tegucigalpa')::date BETWEEN $1::date AND $2::date ORDER BY issued_at,id`,[from,to]),
    tdb.all(`SELECT id,original_document_id,document_number,status,refund_status,issued_at,snapshot_enc FROM {s}.sar_credit_notes
      WHERE (issued_at AT TIME ZONE 'America/Tegucigalpa')::date BETWEEN $1::date AND $2::date ORDER BY issued_at,id`,[from,to]),
    tdb.all(`SELECT id,purchase_order_id,document_type,original_purchase_id,supplier_name,supplier_rtn,cai,document_number,issued_on,accounted_on,
      exempt_amount,exonerated_amount,taxable_15,isv_15,creditable_isv_15,taxable_18,isv_18,creditable_isv_18,
      total,oce_number,exemption_resolution,notes,source_name,status,void_reason,created_at
      FROM {s}.sar_purchase_documents WHERE COALESCE(accounted_on,issued_on) BETWEEN $1::date AND $2::date ORDER BY accounted_on,issued_on,id`,[from,to]),
  ]);
  const grossSalesTotals=emptyTotals(),creditTotals=emptyTotals(),purchaseTotals={...emptyTotals(),exonerated:0,creditableIsv15:0,creditableIsv18:0};
  const documents=docs.map((row) => {
    const snapshot=parseJson(decrypt(row.snapshot_enc)) || {};
    if (row.status === 'issued') addTotals(grossSalesTotals,snapshot.totals);
    return {id:row.id,orderId:row.order_id,number:row.document_number,status:row.status,issuedAt:row.issued_at,
      totals:snapshot.totals || {},receiver:snapshot.receiver || null};
  });
  const creditNotes=notes.map((row) => {
    const snapshot=parseJson(decrypt(row.snapshot_enc)) || {};
    if (row.status === 'issued') addTotals(creditTotals,snapshot.totals);
    return {id:row.id,originalDocumentId:row.original_document_id,number:row.document_number,status:row.status,
      refundStatus:row.refund_status,issuedAt:row.issued_at,totals:snapshot.totals || {},originalNumber:snapshot.original?.number || ''};
  });
  for (const row of purchases.filter((item) => item.status === 'active')) {
    const sign=row.document_type === '07' ? -1 : 1;
    addTotals(purchaseTotals,{exempt:row.exempt_amount,taxable15:row.taxable_15,isv15:row.isv_15,
      taxable18:row.taxable_18,isv18:row.isv_18,total:row.total},sign);
    purchaseTotals.exonerated=money(purchaseTotals.exonerated+sign*Number(row.exonerated_amount || 0));
    purchaseTotals.creditableIsv15=money(purchaseTotals.creditableIsv15+sign*Number(row.creditable_isv_15 || 0));
    purchaseTotals.creditableIsv18=money(purchaseTotals.creditableIsv18+sign*Number(row.creditable_isv_18 || 0));
  }
  const salesTotals={...grossSalesTotals}; addTotals(salesTotals,creditTotals,-1);
  const isv201={ debit15:salesTotals.isv15,debit18:salesTotals.isv18,credit15:purchaseTotals.creditableIsv15,
    credit18:purchaseTotals.creditableIsv18,netIndicative:money(salesTotals.isv15+salesTotals.isv18-purchaseTotals.creditableIsv15-purchaseTotals.creditableIsv18) };
  const fiscalSource={
    documents:documents.map(({id,number,status,issuedAt,totals})=>({id,number,status,issuedAt,totals})),
    creditNotes:creditNotes.map(({id,number,status,issuedAt,totals,originalNumber})=>({id,number,status,issuedAt,totals,originalNumber})),
    purchases:purchases.map((p)=>({id:p.id,documentType:p.document_type,number:p.document_number,status:p.status,
      issuedOn:p.issued_on,accountedOn:p.accounted_on,exempt:p.exempt_amount,exonerated:p.exonerated_amount,
      taxable15:p.taxable_15,isv15:p.isv_15,creditable15:p.creditable_isv_15,taxable18:p.taxable_18,isv18:p.isv_18,
      creditable18:p.creditable_isv_18,total:p.total})),
  };
  const sourceHash=crypto.createHash('sha256').update(JSON.stringify(fiscalSource)).digest('hex');
  return {from,to,documents,creditNotes,purchases,grossSalesTotals,creditTotals,salesTotals,purchaseTotals,isv201,sourceHash};
}

router.get('/report', ownerOnly, wrapped(async (req,res) => {
  const from=clean(req.query.from,10),to=clean(req.query.to,10);
  if (!validIsoDate(from) || !validIsoDate(to) || from>to) throw fail(400,'Selecciona un período válido');
  res.json(await buildReport(req.tdb,from,to));
}));

const periodDates=(value) => {
  const period=clean(value,7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw fail(400,'Período AAAA-MM inválido');
  const [year,month]=period.split('-').map(Number);
  return {period,from:`${period}-01`,to:`${period}-${String(new Date(Date.UTC(year,month,0)).getUTCDate()).padStart(2,'0')}`};
};

async function buildFilingPackage(tdb,period,from,to) {
  const [report,adjustments]=await Promise.all([buildReport(tdb,from,to),
    tdb.all('SELECT id,adjustment_type,amount,reference,proof_name,status,void_reason,created_at FROM {s}.sar_period_adjustments WHERE period=$1 ORDER BY id',[period])]);
  const active=adjustments.filter((entry)=>entry.status==='active');
  const credits=money(active.reduce((sum,entry)=>sum+Number(entry.amount),0));
  report.adjustments=adjustments;
  report.isv201.otherCredits=credits;
  report.isv201.netAfterRecordedCredits=money(report.isv201.netIndicative-credits);
  report.hashes={
    ISV201:crypto.createHash('sha256').update(JSON.stringify({reportHash:report.sourceHash,
      adjustments:active.map(({id,adjustment_type,amount,reference})=>({id,adjustment_type,amount,reference}))})).digest('hex'),
    DMC:crypto.createHash('sha256').update(JSON.stringify(report.purchases.map((p)=>({id:p.id,type:p.document_type,number:p.document_number,
      status:p.status,issuedOn:p.issued_on,accountedOn:p.accounted_on,exempt:p.exempt_amount,exonerated:p.exonerated_amount,
      taxable15:p.taxable_15,isv15:p.isv_15,creditable15:p.creditable_isv_15,taxable18:p.taxable_18,isv18:p.isv_18,
      creditable18:p.creditable_isv_18,total:p.total})))).digest('hex'),
  };
  return report;
}

router.post('/filings/:period/adjustments', ownerOnly, upload.single('proof'), wrapped(async (req,res) => {
  const {period}=periodDates(req.params.period);
  const adjustmentType=clean(req.body?.adjustmentType,30),amount=safeMoney(req.body?.amount),reference=clean(req.body?.reference,150);
  if (!['prior_excess','period_payment','compensation','credit_transfer','retained_state','retained_agreement','retained_card'].includes(adjustmentType) || amount<=0 || !reference) throw fail(400,'Indica tipo, importe y referencia del crédito');
  if (!req.file || req.file.buffer.subarray(0,5).toString() !== '%PDF-') throw fail(400,'Adjunta comprobante PDF del ajuste');
  const row=await req.tdb.get(`INSERT INTO {s}.sar_period_adjustments(period,adjustment_type,amount,reference,proof_name,proof_pdf,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,[period,adjustmentType,amount,reference,clean(req.file.originalname,180),req.file.buffer,actor(req)]);
  res.status(201).json({ok:true,id:row.id});
}));

router.post('/filings/adjustments/:id/void', ownerOnly, wrapped(async (req,res) => {
  const id=positiveId(req.params.id),reason=clean(req.body?.reason,300);
  if (reason.length<8) throw fail(400,'Explica la corrección del crédito');
  await req.tdb.tx(async (tx)=>{
    const row=await tx.get('SELECT status FROM {s}.sar_period_adjustments WHERE id=$1 FOR UPDATE',[id]);
    if (!row || row.status!=='active') throw fail(404,'Ajuste activo no encontrado');
    await tx.run("UPDATE {s}.sar_period_adjustments SET status='void',void_reason=$1,voided_by=$2,voided_at=now() WHERE id=$3",[reason,actor(req),id]);
    await tx.run("INSERT INTO {s}.sar_events(subject_type,subject_id,event_type,detail,actor) VALUES ('adjustment',$1,'voided',$2,$3)",[id,reason,actor(req)]);
  });
  res.json({ok:true});
}));

router.get('/filings/adjustments/:id/pdf', ownerOnly, wrapped(async (req,res) => {
  const row=await req.tdb.get('SELECT proof_pdf FROM {s}.sar_period_adjustments WHERE id=$1',[positiveId(req.params.id)]);
  if (!row) throw fail(404,'Comprobante no encontrado');
  res.type('pdf').send(row.proof_pdf);
}));

router.get('/filings/:period/workbook', ownerOnly, wrapped(async (req,res) => {
  const {period,from,to}=periodDates(req.params.period);
  const report=await buildFilingPackage(req.tdb,period,from,to);
  const book=XLSX.utils.book_new();
  const sheet=(name,headers,rows) => XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([headers,...rows]),name);
  sheet('ISV 201 trabajo',['Concepto','Lempiras'],[
    ['Ventas exentas',report.salesTotals.exempt],['Ventas exoneradas 15%',report.salesTotals.exonerated15],
    ['Ventas exoneradas 18%',report.salesTotals.exonerated18],['Base gravada 15%',report.salesTotals.taxable15],
    ['ISV débito 15%',report.isv201.debit15],['Base gravada 18%',report.salesTotals.taxable18],
    ['ISV débito 18%',report.isv201.debit18],['ISV crédito 15% declarado por compras',report.isv201.credit15],
    ['ISV crédito 18% registrado en compras',report.isv201.credit18],['ISV neto antes de otros créditos',report.isv201.netIndicative],
    ['Otros créditos registrados con comprobante',report.isv201.otherCredits],['Saldo indicativo después de créditos registrados',report.isv201.netAfterRecordedCredits],
  ]);
  sheet('Créditos ISV',['Tipo','Importe','Referencia','Estado'],report.adjustments.map((a)=>[a.adjustment_type,Number(a.amount),a.reference,a.status]));
  sheet('Ventas',['Fecha','Número','Estado','Exento','Exonerado 15','Exonerado 18','Base 15','ISV 15','Base 18','ISV 18','Total'],
    report.documents.map((d)=>[String(d.issuedAt).slice(0,10),d.number,d.status,...['exempt','exonerated15','exonerated18','taxable15','isv15','taxable18','isv18','total'].map((key)=>Number(d.totals?.[key] || 0))]));
  sheet('Notas crédito',['Fecha','Número','Factura original','Estado','Exento','Exonerado 15','Exonerado 18','Base 15','ISV 15','Base 18','ISV 18','Total'],
    report.creditNotes.map((n)=>[String(n.issuedAt).slice(0,10),n.number,n.originalNumber,n.status,...['exempt','exonerated15','exonerated18','taxable15','isv15','taxable18','isv18','total'].map((key)=>Number(n.totals?.[key] || 0))]));
  sheet('DMC compras trabajo',['Tipo','Factura original ID','RTN proveedor','Proveedor','CAI','Documento','Fecha emisión','Fecha contabilización','Exento','Exonerado','Base 15','ISV 15','Crédito ISV 15','Base 18','ISV 18','Crédito ISV 18','Total','OCE','Resolución','Estado'],
    report.purchases.map((p)=>[p.document_type,p.original_purchase_id || '',p.supplier_rtn,p.supplier_name,p.cai,String(p.document_number).replace(/-/g,'/'),dateOnly(p.issued_on),dateOnly(p.accounted_on || p.issued_on),
      ...['exempt_amount','exonerated_amount','taxable_15','isv_15','creditable_isv_15','taxable_18','isv_18','creditable_isv_18','total'].map((key)=>Number(p[key] || 0)),p.oce_number,p.exemption_resolution,p.status]));
  const output=XLSX.write(book,{type:'buffer',bookType:'xlsx'});
  res.set('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition',`attachment; filename="SAR-trabajo-${period}.xlsx"`);
  res.send(output);
}));

router.get('/filings/:period', ownerOnly, wrapped(async (req,res) => {
  const {period,from,to}=periodDates(req.params.period);
  const [report,records]=await Promise.all([buildFilingPackage(req.tdb,period,from,to),
    req.tdb.all('SELECT id,filing_type,status,source_hash,receipt_number,filed_on,receipt_name,notes,created_at FROM {s}.sar_filings WHERE period=$1 ORDER BY created_at DESC,id DESC',[period])]);
  res.json({period,report,records:records.map((row) => ({...row,needsReview:row.source_hash !== report.hashes[row.filing_type]}))});
}));

router.post('/filings/:period', ownerOnly, upload.single('receipt'), wrapped(async (req,res) => {
  const {period,from,to}=periodDates(req.params.period);
  const filingType=clean(req.body?.filingType,10),receiptNumber=clean(req.body?.receiptNumber,100),filedOn=clean(req.body?.filedOn,10);
  if (!['ISV201','DMC'].includes(filingType) || !receiptNumber || !validIsoDate(filedOn)) throw fail(400,'Indica declaración, fecha y número de acuse del SAR');
  if (!req.file || req.file.buffer.subarray(0,5).toString() !== '%PDF-') throw fail(400,'Adjunta el acuse oficial del SAR en PDF');
  const report=await buildFilingPackage(req.tdb,period,from,to);
  const row=await req.tdb.tx(async (tx) => {
    await tx.run("UPDATE {s}.sar_filings SET status='superseded' WHERE period=$1 AND filing_type=$2 AND status='filed'",[period,filingType]);
    const saved=await tx.get(`INSERT INTO {s}.sar_filings(period,filing_type,source_hash,receipt_number,filed_on,receipt_name,receipt_pdf,notes,filed_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,[period,filingType,report.hashes[filingType],receiptNumber,filedOn,clean(req.file.originalname,180),req.file.buffer,clean(req.body?.notes,300),actor(req)]);
    await tx.run("INSERT INTO {s}.sar_events(subject_type,subject_id,event_type,detail,actor) VALUES ('filing',$1,'receipt_loaded',$2,$3)",[saved.id,`${filingType} ${period}: ${receiptNumber}`,actor(req)]);
    return saved;
  });
  res.status(201).json({ok:true,id:row.id});
}));

router.get('/filings/receipts/:id/pdf', ownerOnly, wrapped(async (req,res) => {
  const row=await req.tdb.get('SELECT receipt_pdf FROM {s}.sar_filings WHERE id=$1',[positiveId(req.params.id)]);
  if (!row) throw fail(404,'Acuse no encontrado');
  res.type('pdf').send(row.receipt_pdf);
}));

module.exports = router;
