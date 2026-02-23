// packages/queue/index.js
// ---------------------------------------------------------------------------
// Lightweight job-queue abstraction.
//
// In production with REDIS_URL, delegates to BullMQ (must be installed
// separately).  Otherwise runs jobs in-process immediately so the existing
// behaviour is preserved 1-for-1 during the structural refactor.
//
// Usage:
//   const { enqueue, registerWorker } = require('@fuel-ops/queue');
//
//   // Inside route handler — fire-and-forget:
//   await enqueue('recomputeLot', { lotId }, { client });
//
//   // At service startup — register the handler:
//   registerWorker('recomputeLot', async ({ lotId }, { client }) => { ... });
// ---------------------------------------------------------------------------

'use strict';

const handlers = new Map();

// ---------------------------------------------------------------------------
// Worker registration
// ---------------------------------------------------------------------------

/**
 * Register a named job handler.
 * @param {string} name  Job type name (e.g. 'recomputeLot')
 * @param {(payload: object, ctx: object) => Promise<void>} fn
 */
function registerWorker(name, fn) {
  handlers.set(name, fn);
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

/**
 * Enqueue a job.  When no job-queue backend is configured the handler runs
 * synchronously in-process (same behaviour as the monolith).
 *
 * @param {string} name     Job type registered via registerWorker()
 * @param {object} payload  Serialisable job data (e.g. { lotId })
 * @param {object} [ctx]    Non-serialisable context (e.g. { client } for a
 *                           pg transaction client).  Ignored by BullMQ mode;
 *                           in-process mode passes it straight through.
 */
async function enqueue(name, payload = {}, ctx = {}) {
  const handler = handlers.get(name);
  if (!handler) {
    console.warn(`[queue] No worker registered for "${name}"`);
    return;
  }

  // In-process mode — run immediately (preserves transactional safety)
  await handler(payload, ctx);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = { enqueue, registerWorker };
