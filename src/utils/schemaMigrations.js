async function migrateTenantSchemas(query, tenants, versionFor, migrate) {
  await query(`CREATE TABLE IF NOT EXISTS tenant_schema_versions (
    schema_name TEXT PRIMARY KEY, version TEXT NOT NULL,
    migrated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const versions = new Map((await query('SELECT schema_name,version FROM tenant_schema_versions')).rows.map((row) => [row.schema_name, row.version]));
  let migrated = 0;
  for (const tenant of tenants) {
    const { schema, version } = versionFor(tenant);
    if (versions.get(schema) === version) continue;
    await migrate(tenant);
    // Mark only after every step succeeds. Failed migrations retry on restart.
    await query(`INSERT INTO tenant_schema_versions(schema_name,version) VALUES($1,$2)
      ON CONFLICT(schema_name) DO UPDATE SET version=EXCLUDED.version,migrated_at=now()`, [schema, version]);
    migrated++;
  }
  return { migrated, skipped: tenants.length - migrated };
}

module.exports = { migrateTenantSchemas };
