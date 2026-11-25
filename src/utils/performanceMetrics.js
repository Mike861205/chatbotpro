const LIMITS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

function createMetrics() {
  let startedAt = new Date().toISOString();
  let counters = new Map();
  return {
    record(name, elapsedMs, failed = false) {
      if (!counters.has(name) && counters.size >= 150) name = 'other';
      let item = counters.get(name);
      if (!item) { item = { count: 0, errors: 0, total_ms: 0, max_ms: 0, buckets: Array(LIMITS.length + 1).fill(0) }; counters.set(name, item); }
      item.count++;
      item.errors += failed ? 1 : 0;
      item.total_ms += elapsedMs;
      item.max_ms = Math.max(item.max_ms, elapsedMs);
      const index = LIMITS.findIndex((limit) => elapsedMs <= limit);
      item.buckets[index < 0 ? LIMITS.length : index]++;
    },
    snapshot(reset = false) {
      const summary = Object.fromEntries([...counters].map(([name, item]) => {
        const percentile = (fraction) => {
          let total = 0;
          const index = item.buckets.findIndex((count) => { total += count; return total >= item.count * fraction; });
          return LIMITS[index] ?? item.max_ms;
        };
        return [name, { count: item.count, errors: item.errors, total_ms: Math.round(item.total_ms), max_ms: Math.round(item.max_ms), p50_ms_upper: percentile(0.50), p95_ms_upper: percentile(0.95), p99_ms_upper: percentile(0.99) }];
      }));
      const result = { from: startedAt, to: new Date().toISOString(), counters: summary };
      if (reset) { counters = new Map(); startedAt = result.to; }
      return result;
    },
  };
}

const metrics = createMetrics();
const enabled = process.env.NODE_ENV === 'production';

async function measuredQuery(target, sql, params) {
  if (!enabled) return target.query(sql, params);
  const start = performance.now();
  let failed = false;
  try { return await target.query(sql, params); }
  catch (error) { failed = true; throw error; }
  finally { metrics.record('database', performance.now() - start, failed); }
}

function measureRequest(req, res, next) {
  if (!enabled) return next();
  const start = performance.now();
  res.once('finish', () => {
    const modulePath = req.originalUrl.split('?')[0].split('/').slice(0, 3).join('/');
    const route = typeof req.route?.path === 'string' ? req.route.path : 'unmatched';
    metrics.record(`${req.method} ${modulePath} ${route}`, performance.now() - start, res.statusCode >= 500);
  });
  next();
}

function startPerformanceLogging(pool) {
  if (!enabled) return;
  // Logging is entirely in memory: this timer never queries or wakes Neon.
  const timer = setInterval(() => {
    console.log('[compute-metrics] ' + JSON.stringify({ ...metrics.snapshot(true), pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount } }));
  }, 60 * 60 * 1000);
  timer.unref();
}

module.exports = { createMetrics, metrics, measuredQuery, measureRequest, startPerformanceLogging };
