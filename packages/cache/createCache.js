// packages/cache/createCache.js
// Simple in-memory TTL cache utility for performance optimization.
// Safe to deploy alongside existing behavior – callers that don't use this still work unchanged.

'use strict';

/**
 * Creates a simple in-memory cache with configurable TTL.
 * @param {number} ttlMs - Time-to-live in milliseconds before entries expire
 * @returns {Object} Cache interface with get/set/invalidate/clear methods
 */
function createCache(ttlMs = 10_000) {
  const store = new Map();

  return {
    /**
     * Get cached value if exists and not expired.
     * @param {string|number} key
     * @returns {*} Cached value or undefined
     */
    get(key) {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (Date.now() > entry.expiresAt) {
        store.delete(key);
        return undefined;
      }
      return entry.value;
    },

    /**
     * Store value with TTL.
     * @param {string|number} key
     * @param {*} value
     */
    set(key, value) {
      store.set(key, {
        value,
        expiresAt: Date.now() + ttlMs,
      });
    },

    /**
     * Invalidate a specific key.
     * @param {string|number} key
     */
    invalidate(key) {
      store.delete(key);
    },

    /**
     * Clear all cached entries.
     */
    clear() {
      store.clear();
    },

    /**
     * Current cache size (including possibly expired entries).
     */
    size() {
      return store.size;
    },
  };
}

module.exports = { createCache };
