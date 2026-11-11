/**
 * Adelantos de nómina.
 *
 * Un gasto cuya categoría es de nómina (NOMINA, Nomina, Nómina…) se liga a un
 * empleado del reloj checador. El adelanto queda pendiente y el siguiente
 * periodo de nómina que lo abarque lo descuenta como deducción.
 */
const { money } = require('./costing');

function normalizeText(value) {
  return String(value || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function isPayrollCategoryName(name) {
  return /\bnominas?\b/.test(normalizeText(name));
}

/** Empleados activos del checador; con `branchId` incluye también a los que no tienen sucursal. */
async function listAdvanceEmployees(t, { branchId = 0 } = {}) {
  const params = [];
  let branchClause = '';
  if (Number(branchId) > 0) {
    params.push(Number(branchId));
    branchClause = 'AND (e.branch_id = $1 OR e.branch_id IS NULL)';
  }
  const rows = await t.all(
    `SELECT e.id, e.name, e.emp_code, e.branch_id, b.name AS branch_name
     FROM {s}.employees e
     LEFT JOIN {s}.branches b ON b.id = e.branch_id
     WHERE e.active = 1 AND e.clock_enabled = 1 ${branchClause}
     ORDER BY e.name ASC`,
    params
  );
  return rows.map((row) => ({
    id: Number(row.id), name: row.name, emp_code: row.emp_code || '',
    branch_id: row.branch_id ? Number(row.branch_id) : null, branch_name: row.branch_name || '',
  }));
}

/**
 * Valida el empleado elegido para un gasto de nómina.
 * Devuelve `{ employee }` (null si el negocio aún no tiene empleados en el checador)
 * o `{ error }` con el mensaje para el usuario.
 */
async function resolveAdvanceEmployee(t, employeeId, { branchId = 0 } = {}) {
  const employees = await listAdvanceEmployees(t, { branchId });
  if (!employees.length) return { employee: null };
  const employee = employees.find((row) => row.id === Number(employeeId));
  if (!employee) return { error: 'Selecciona al empleado que recibe el adelanto de nómina' };
  return { employee };
}

function advanceConcept(employee, text, max) {
  const base = String(text || '').trim() || 'Adelanto de nómina';
  const full = base.toLowerCase().includes(employee.name.toLowerCase()) ? base : `${base} · ${employee.name}`;
  return full.slice(0, max);
}

async function recordAdvance(t, { employee, amount, date, timezone, branchId, branchName, source, sourceId, note, createdBy }) {
  await t.run(
    `INSERT INTO {s}.payroll_advances
       (employee_id, employee_name, amount, advance_date, branch_id, branch_name, source, source_id, note, created_by)
     VALUES ($1, $2, $3, COALESCE($4::date, (now() AT TIME ZONE $5)::date), $6, $7, $8, $9, $10, $11)`,
    [employee.id, employee.name, money(amount), date || null, timezone, branchId || null, branchName || '',
      source, sourceId, String(note || '').slice(0, 240), createdBy || '']
  );
}

/**
 * Borra el adelanto ligado a un gasto que se está revirtiendo.
 * Si ya fue descontado en una nómina, el gasto no se puede borrar hasta quitar ese descuento.
 */
async function releaseAdvance(t, source, sourceId) {
  const row = await t.get(
    `SELECT a.id, a.period_id, p.name AS period_name
     FROM {s}.payroll_advances a
     LEFT JOIN {s}.payroll_periods p ON p.id = a.period_id
     WHERE a.source = $1 AND a.source_id = $2
     FOR UPDATE OF a`,
    [source, sourceId]
  );
  if (!row) return;
  if (row.period_id) {
    throw Object.assign(
      new Error(`Este adelanto ya se descontó en la nómina "${row.period_name || row.period_id}". Quita el descuento en la nómina antes de borrar el gasto.`),
      { statusCode: 409 }
    );
  }
  await t.run('DELETE FROM {s}.payroll_advances WHERE id = $1', [row.id]);
}

/** Adelantos aún no descontados con fecha hasta `to`, agrupados por empleado como ajustes de nómina. */
async function pendingAdvanceAdjustments(t, to) {
  const rows = await t.all(
    `SELECT id, employee_id, amount::float AS amount, to_char(advance_date, 'DD/MM/YYYY') AS day, note
     FROM {s}.payroll_advances
     WHERE period_id IS NULL AND advance_date <= $1::date
     ORDER BY advance_date ASC, id ASC`,
    [to]
  );
  const map = new Map();
  for (const row of rows) {
    const key = Number(row.employee_id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({
      id: null, advance_id: Number(row.id), kind: 'deduction', advance: true,
      concept: `Adelanto de nómina (${row.day})`, amount: row.amount, notes: row.note || '',
    });
  }
  return map;
}

module.exports = {
  isPayrollCategoryName, listAdvanceEmployees, resolveAdvanceEmployee, advanceConcept,
  recordAdvance, releaseAdvance, pendingAdvanceAdjustments,
};
