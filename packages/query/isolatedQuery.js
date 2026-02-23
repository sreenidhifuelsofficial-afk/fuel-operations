// packages/query/isolatedQuery.js
// ---------------------------------------------------------------------------
// Wrapper around the read pool that provides lightweight timing logs.
// Logs: "[isolated-query] <ms>"
// ---------------------------------------------------------------------------

'use strict';

const readPool = require('./readPool');

const QUERY_TIMEOUT_MS = Number(process.env.PG_READ_QUERY_TIMEOUT || 8000);
const SLOW_QUERY_THRESHOLD_MS = 300;

async function isolatedQuery(text, params) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), QUERY_TIMEOUT_MS);
  const start = Date.now();
  let aborted = false;
  try {
    return await readPool.query({ text, values: params, signal: controller.signal });
  } catch (err) {
    const ms = Date.now() - start;
    if (err && err.name === 'AbortError') {
      aborted = true;
      console.warn(`[isolated-query-timeout] ${ms}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    const ms = Date.now() - start;
    if (!process.env.SUPPRESS_DB_LOG) {
      console.log(`[isolated-query] ${ms}ms`);
    }
    if (!aborted && ms > SLOW_QUERY_THRESHOLD_MS) {
      console.warn(`[slow-query] ${ms}ms`);
    }
  }
}

module.exports = isolatedQuery;
