const { createSingleFlight } = require('./singleFlight');

// For deterministic reads only (no now(), sequences, or external state).
// PostgreSQL snapshots change when the set of visible transactions changes,
// so committed sales/cancellations from any process invalidate these results.
// https://www.postgresql.org/docs/18/functions-info.html
function createVersionedRead({ maxEntries = 100, ttlMs = 60000 } = {}) {
  const entries = new Map();
  const share = createSingleFlight();
  return async function versionedRead(t, name, loader) {
    // A transaction may see its own writes without its snapshot changing.
    if (!t.schema || t.inTransaction) return loader();
    const version = (await t.get('SELECT pg_current_snapshot()::text AS version'))?.version;
    if (!version) return loader();
    const key = JSON.stringify([t.schema, name]);
    const cached = entries.get(key);
    if (cached?.version === version && Date.now() - cached.createdAt < ttlMs) return structuredClone(cached.value);
    const value = await share(JSON.stringify([key, version]), async () => {
      const result = await loader();
      entries.delete(key);
      if (entries.size >= maxEntries) entries.delete(entries.keys().next().value);
      entries.set(key, { version, createdAt: Date.now(), value: structuredClone(result) });
      return result;
    });
    return structuredClone(value);
  };
}

module.exports = { createVersionedRead };
