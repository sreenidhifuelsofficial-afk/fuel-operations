// packages/cache/index.js
// Cache abstraction layer.
//
// When REDIS_URL is set, uses a Redis client for distributed caching across
// service instances.  Otherwise falls back to a local in-memory Map (safe for
// single-process deployments).
//
// The public API is identical regardless of backend:
//   const cache = require('@fuel-ops/cache');
//   const client = cache.createCache(10_000);
//   client.set('key', value);
//   const v = await client.get('key');   // always async-safe
//   client.invalidate('key');
//   client.clear();

'use strict';

// ---------------------------------------------------------------------------
// In-memory fallback (same Map-based implementation as existing cache.js)
// ---------------------------------------------------------------------------
function createMemoryCache(ttlMs) {
  const store = new Map();
  return {
    async get(key) {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (Date.now() > entry.expiresAt) { store.delete(key); return undefined; }
      return entry.value;
    },
    async set(key, value) {
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
    },
    async invalidate(key) { store.delete(key); },
    async clear() { store.clear(); },
    size() { return store.size; },
    type: 'memory',
  };
}

// ---------------------------------------------------------------------------
// Redis-backed cache (requires ioredis or redis npm package)
// ---------------------------------------------------------------------------
function createRedisCache(ttlMs) {
  // Lazy-require so projects without Redis dependency don't crash
  let Redis;
  try { Redis = require('ioredis'); } catch {
    try { Redis = require('redis'); } catch {
      console.warn('[cache] REDIS_URL set but no redis client package found; falling back to memory cache');
      return createMemoryCache(ttlMs);
    }
  }

  const client = new Redis(process.env.REDIS_URL);
  const prefix = process.env.CACHE_PREFIX || 'fuelops:';
  const ttlSec = Math.max(1, Math.ceil(ttlMs / 1000));

  client.on('error', (err) => {
    if (!process.env.SUPPRESS_DB_LOG) console.warn('[cache:redis] error:', err.message);
  });

  return {
    async get(key) {
      try {
        const raw = await client.get(`${prefix}${key}`);
        if (raw === null || raw === undefined) return undefined;
        return JSON.parse(raw);
      } catch { return undefined; }
    },
    async set(key, value) {
      try {
        await client.set(`${prefix}${key}`, JSON.stringify(value), 'EX', ttlSec);
      } catch {}
    },
    async invalidate(key) {
      try { await client.del(`${prefix}${key}`); } catch {}
    },
    async clear() {
      try {
        // Scan and delete only our prefixed keys
        let cursor = '0';
        do {
          const [next, keys] = await client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100);
          cursor = next;
          if (keys.length) await client.del(...keys);
        } while (cursor !== '0');
      } catch {}
    },
    size() { return -1; /* Redis doesn't expose cheap size */ },
    type: 'redis',
    /** Expose underlying client for health checks */
    _client: client,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
function createCache(ttlMs = 10_000) {
  if (process.env.REDIS_URL) {
    return createRedisCache(ttlMs);
  }
  return createMemoryCache(ttlMs);
}

module.exports = { createCache };
