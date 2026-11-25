const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { Client } = require('pg');

function argument(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

async function connectNeon(envFile, applicationName) {
  const root = path.resolve(__dirname, '..');
  const base = path.join(root, '.env');
  const selected = path.resolve(root, envFile);
  const env = {
    ...(fs.existsSync(base) ? dotenv.parse(fs.readFileSync(base)) : {}),
    ...dotenv.parse(fs.readFileSync(selected)),
  };
  const url = new URL(env.DATABASE_URL);
  if (!url.hostname.endsWith('.neon.tech')) throw new Error('Expected a Neon endpoint');
  // Concurrent DDL and connection settings must stay on one physical session.
  url.hostname = url.hostname.replace('-pooler.', '.');
  url.searchParams.delete('channel_binding');
  url.searchParams.set('sslmode', env.PG_SSL_REJECT_UNAUTHORIZED === 'false' ? 'require' : 'verify-full');
  const client = new Client({ connectionString: url.toString(), application_name: applicationName, connectionTimeoutMillis: 10000 });
  await client.connect();
  return client;
}

module.exports = { argument, connectNeon };
