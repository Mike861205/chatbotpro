// A single tenant-scoped read; values are never cached across requests.
async function getSettings(t, defaults) {
  const keys = Object.keys(defaults);
  if (!keys.length) return {};
  const values = { ...defaults };
  const rows = await t.all('SELECT key, value FROM {s}.settings WHERE key = ANY($1::text[])', [keys]);
  for (const row of rows) {
    if (Object.hasOwn(defaults, row.key)) values[row.key] = row.value;
  }
  return values;
}

module.exports = { getSettings };
