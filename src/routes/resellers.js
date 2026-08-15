const express = require('express');
const bcrypt = require('bcryptjs');
const { pool, q } = require('../db');
const { decrypt } = require('../utils/crypto');
const { describeStoredPhone } = require('../utils/phone');
const { createRateLimiter } = require('../middleware/security');
const {
  signResellerToken,
  setResellerCookie,
  clearResellerCookie,
  requireReseller,
} = require('../middleware/reseller');

const router = express.Router();
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;
const USERNAME_RE = /^[a-z0-9._-]{3,60}$/;
const SALES_STAGES = new Set(['new', 'contacted', 'interested', 'potential', 'follow_up', 'won', 'not_interested', 'lost']);
const ACTIVITY_TYPES = new Set(['note', 'contact', 'follow_up', 'close_won', 'close_lost', 'stage_change']);
const loginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Demasiados intentos de acceso. Espera 15 minutos.',
});

function mapPhone(row) {
  const phone = describeStoredPhone(decrypt(row.phone_enc) || '', row.phone_country, row.phone_calling_code);
  return {
    ...row,
    phone: phone.international,
    phone_e164: phone.e164,
    phone_digits: phone.digits,
    phone_valid: phone.valid,
    phone_country: phone.country,
    phone_country_name: phone.countryName,
    phone_calling_code: phone.callingCode,
  };
}

function parseSubject(type, id) {
  const cleanType = String(type || '').trim().toLowerCase();
  const cleanId = Number(id);
  if (!['tenant', 'demo_lead'].includes(cleanType) || !Number.isInteger(cleanId) || cleanId <= 0) return null;
  return { type: cleanType, id: cleanId };
}

function subjectConfig(type) {
  return type === 'tenant'
    ? { table: 'tenants', key: 'tenant_id', label: 'business_name', extra: 'AND customer_since IS NULL' }
    : { table: 'demo_leads', key: 'demo_lead_id', label: 'contact_name', extra: '' };
}

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const slug = String(req.body?.slug || '').trim().toLowerCase();
    const username = String(req.body?.username || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!SLUG_RE.test(slug) || !USERNAME_RE.test(username) || !password || password.length > 128) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }
    const found = await q('SELECT * FROM resellers WHERE slug = $1 AND lower(username) = $2 LIMIT 1', [slug, username]);
    const reseller = found.rows[0];
    if (!reseller || !Number(reseller.active) || !(await bcrypt.compare(password, reseller.password_hash))) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }
    setResellerCookie(res, signResellerToken(reseller));
    res.json({ ok: true, redirect: '/resellers/panel' });
  } catch (error) {
    next(error);
  }
});

router.post('/logout', (req, res) => {
  clearResellerCookie(res);
  res.json({ ok: true });
});

router.get('/me', requireReseller, (req, res) => {
  res.json({
    id: req.reseller.id,
    slug: req.reseller.slug,
    displayName: req.reseller.display_name,
    username: req.reseller.username,
    contactName: req.reseller.contact_name,
    referralUrl: `/${req.reseller.slug}`,
    loginUrl: `/resellers/${req.reseller.slug}`,
  });
});

router.get('/overview', requireReseller, async (req, res, next) => {
  try {
    const resellerId = req.reseller.id;
    const [tenantRows, leadRows] = await Promise.all([
      q(`SELECT t.id, t.slug, t.business_name, t.owner_name, t.phone_enc, t.phone_country,
                t.phone_calling_code, t.account_status, t.billing_status, t.plan_name,
                t.customer_since, t.sales_stage, t.next_follow_up_at, t.sales_updated_at,
                t.created_at, COALESCE(s.activity_count, 0)::int AS activity_count,
                s.last_activity_at, COALESCE(s.last_note, '') AS last_note
         FROM tenants t
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS activity_count, MAX(a.created_at) AS last_activity_at,
             (ARRAY_AGG(a.note ORDER BY a.created_at DESC) FILTER (WHERE a.note <> ''))[1] AS last_note
           FROM sales_followup_activities a WHERE a.tenant_id = t.id
         ) s ON true
         WHERE t.reseller_id = $1
         ORDER BY t.created_at DESC`, [resellerId]),
      q(`SELECT dl.id, dl.contact_name, dl.phone_enc, dl.phone_country, dl.phone_calling_code,
                dl.business_giro, dl.source_page, dl.demo_count, dl.first_seen_at, dl.last_seen_at,
                dl.sales_stage, dl.next_follow_up_at, dl.sales_updated_at,
                COALESCE(s.activity_count, 0)::int AS activity_count, s.last_activity_at,
                COALESCE(s.last_note, '') AS last_note
         FROM demo_leads dl
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS activity_count, MAX(a.created_at) AS last_activity_at,
             (ARRAY_AGG(a.note ORDER BY a.created_at DESC) FILTER (WHERE a.note <> ''))[1] AS last_note
           FROM sales_followup_activities a WHERE a.demo_lead_id = dl.id
         ) s ON true
         WHERE dl.reseller_id = $1
         ORDER BY dl.last_seen_at DESC, dl.id DESC`, [resellerId]),
    ]);

    const tenants = tenantRows.rows.map(mapPhone);
    const demoLeads = leadRows.rows.map(mapPhone);
    const prospects = tenants.filter((item) => !item.customer_since);
    const clients = tenants.filter((item) => Boolean(item.customer_since));
    const followUp = [
      ...prospects.map((item) => ({ ...item, entity_type: 'tenant', name: item.business_name, contact_name: item.owner_name })),
      ...demoLeads.map((item) => ({ ...item, entity_type: 'demo_lead', name: item.business_giro })),
    ].sort((a, b) => new Date(b.next_follow_up_at || b.sales_updated_at || b.created_at || 0) - new Date(a.next_follow_up_at || a.sales_updated_at || a.created_at || 0));

    res.json({
      prospects,
      clients,
      demoLeads,
      followUp,
      summary: {
        prospects: prospects.length,
        clients: clients.length,
        demoLeads: demoLeads.length,
        pendingFollowUp: followUp.filter((item) => item.next_follow_up_at && !['won', 'lost', 'not_interested'].includes(item.sales_stage)).length,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/follow-up/:type/:id/activities', requireReseller, async (req, res, next) => {
  try {
    const subject = parseSubject(req.params.type, req.params.id);
    if (!subject) return res.status(400).json({ error: 'Contacto inválido' });
    const cfg = subjectConfig(subject.type);
    const owner = await q(`SELECT id FROM ${cfg.table} WHERE id = $1 AND reseller_id = $2 ${cfg.extra}`, [subject.id, req.reseller.id]);
    if (!owner.rows[0]) return res.status(404).json({ error: 'Contacto no encontrado' });
    const activities = await q(
      `SELECT id, activity_type, note, stage_from, stage_to, follow_up_at, created_by, created_at
       FROM sales_followup_activities WHERE ${cfg.key} = $1 ORDER BY created_at DESC, id DESC`,
      [subject.id]
    );
    res.json({ activities: activities.rows });
  } catch (error) {
    next(error);
  }
});

router.patch('/follow-up/:type/:id', requireReseller, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const subject = parseSubject(req.params.type, req.params.id);
    if (!subject) return res.status(400).json({ error: 'Contacto inválido' });
    const cfg = subjectConfig(subject.type);
    const stageInput = String(req.body?.stage || '').trim().toLowerCase();
    const activityTypeInput = String(req.body?.activityType || 'note').trim().toLowerCase();
    if (!SALES_STAGES.has(stageInput)) return res.status(400).json({ error: 'Etapa comercial inválida' });
    if (!ACTIVITY_TYPES.has(activityTypeInput)) return res.status(400).json({ error: 'Tipo de gestión inválido' });
    const note = String(req.body?.note || '').trim().slice(0, 4000);
    let nextFollowUpAt = null;
    if (req.body?.nextFollowUpAt) {
      const parsed = new Date(req.body.nextFollowUpAt);
      if (Number.isNaN(parsed.getTime())) return res.status(400).json({ error: 'Fecha de seguimiento inválida' });
      nextFollowUpAt = parsed.toISOString();
    }
    let stage = activityTypeInput === 'close_won' ? 'won' : activityTypeInput === 'close_lost' ? 'lost' : stageInput;
    if (['won', 'lost', 'not_interested'].includes(stage)) nextFollowUpAt = null;

    await client.query('BEGIN');
    const found = await client.query(
      `SELECT id, sales_stage FROM ${cfg.table} WHERE id = $1 AND reseller_id = $2 ${cfg.extra} FOR UPDATE`,
      [subject.id, req.reseller.id]
    );
    const current = found.rows[0];
    if (!current) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Contacto no encontrado' });
    }
    await client.query(
      `UPDATE ${cfg.table} SET sales_stage = $1, next_follow_up_at = $2, sales_updated_at = now() WHERE id = $3`,
      [stage, nextFollowUpAt, subject.id]
    );
    await client.query(
      `INSERT INTO sales_followup_activities
        (${cfg.key}, activity_type, note, stage_from, stage_to, follow_up_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [subject.id, activityTypeInput, note, current.sales_stage, stage, nextFollowUpAt, `reseller:${req.reseller.username}`]
    );
    await client.query('COMMIT');
    res.json({ ok: true, stage, nextFollowUpAt });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    next(error);
  } finally {
    client.release();
  }
});

module.exports = router;
