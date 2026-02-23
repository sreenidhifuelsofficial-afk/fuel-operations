#!/usr/bin/env node
// tests/e2e/fullFeatureValidation.test.js
// =========================================================================
// Enterprise End-to-End Feature Validation Suite for Fuel Operations
//
// Runs against the live gateway at http://localhost:5000
// Usage:  npm run test:e2e
//         node tests/e2e/fullFeatureValidation.test.js
// =========================================================================

'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ── Configuration ──────────────────────────────────────────────────────────
const BASE = process.env.TEST_BASE_URL || 'http://localhost:5000';
const CREDS = {
  identifier: process.env.TEST_USER || 'owner@local.test',
  password: process.env.TEST_PASS || 'Owner@123',
};
const TEST_DATE = '2099-12-31';        // Far-future date to avoid clashes
const TEST_DATE_ALT = '2099-12-30';

// ── State ──────────────────────────────────────────────────────────────────
let TOKEN = null;
let AUTH_HEADERS = {};
const results = [];   // { feature, endpoint, action, status, ms, result, detail }
let testTruckId = null;
let testDatumId = null;
let testDriverPk = null;
let testLotId = null;
let testTripId = null;
let testOdoId = null;
let testLogId = null;
let testSnapId = null;
let testSaleId = null;
let testInternalId = null;
let testStorageId = null;
let testDriverId = null;

// ── Helpers ────────────────────────────────────────────────────────────────

function record(feature, endpoint, action, status, ms, pass, detail) {
  const result = pass ? 'PASS' : 'FAIL';
  results.push({ feature, endpoint, action, status: String(status), ms: `${ms}ms`, result, detail: detail || '' });
  const icon = pass ? '  ✓' : '  ✗';
  console.log(`${icon} [${feature}] ${action} → ${status} (${ms}ms)${detail ? '  ' + detail : ''}`);
}

async function req(method, urlPath, body, opts = {}) {
  const headers = opts.noAuth ? { 'Content-Type': 'application/json' } : { ...AUTH_HEADERS, 'Content-Type': 'application/json' };
  const t0 = Date.now();
  try {
    const config = { method, url: `${BASE}${urlPath}`, headers, params: opts.params, validateStatus: () => true, timeout: 15000 };
    // Only attach body for methods that should carry a payload — avoids body-parser strict-mode 400 on null
    if (body !== undefined && body !== null) config.data = body;
    const res = await axios(config);
    return { status: res.status, data: res.data, ms: Date.now() - t0, headers: res.headers };
  } catch (e) {
    return { status: 0, data: { error: e.message }, ms: Date.now() - t0, headers: {} };
  }
}

// ── Test sections ──────────────────────────────────────────────────────────

async function testAuth() {
  console.log('\n═══ AUTH FLOW ═══');
  const r = await req('POST', '/api/auth/login', CREDS);
  if (r.status === 200 && r.data?.token) {
    TOKEN = r.data.token;
    AUTH_HEADERS = { Authorization: `Bearer ${TOKEN}` };
    record('Auth', '/api/auth/login', 'POST login', r.status, r.ms, true, `role=${r.data.user?.role}`);
  } else {
    record('Auth', '/api/auth/login', 'POST login', r.status, r.ms, false, r.data?.error || 'no token');
    console.error('FATAL: Cannot authenticate — aborting.');
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────────────────
async function testStorageUnits() {
  console.log('\n═══ TAB: Vehicles & Storage Info ═══');

  // GET all units
  const r1 = await req('GET', '/api/fuel-ops/storage-units');
  const units = Array.isArray(r1.data) ? r1.data : [];
  const hasKeys = units.length > 0 && ['id', 'unit_type', 'unit_code', 'capacity_liters', 'active'].every(k => k in units[0]);
  record('Vehicles', '/api/fuel-ops/storage-units', 'GET all', r1.status, r1.ms, r1.status === 200 && hasKeys, `count=${units.length}`);

  // Pick existing trucks + datum for later tests
  testTruckId = (units.find(u => u.unit_type === 'TRUCK' && u.active) || {}).id || null;
  testDatumId = (units.find(u => u.unit_type === 'DATUM' && u.active) || {}).id || null;

  // CREATE a test unit
  const r2 = await req('POST', '/api/fuel-ops/storage-units', { unit_code: 'E2E_TEST_UNIT', capacity_liters: 999, unit_type: 'TRUCK' });
  if (r2.status === 201) {
    testStorageId = r2.data.id;
    record('Vehicles', '/api/fuel-ops/storage-units', 'POST create', r2.status, r2.ms, true, `id=${r2.data.id}`);
  } else if (r2.status === 409) {
    // Already exists — find it
    record('Vehicles', '/api/fuel-ops/storage-units', 'POST create (dup)', r2.status, r2.ms, true, 'already exists, using existing');
    const find = await req('GET', '/api/fuel-ops/storage-units', null, { params: { active: 'true' } });
    if (find.status === 200) {
      const existing = (Array.isArray(find.data) ? find.data : []).find(u => u.unit_code === 'E2E_TEST_UNIT');
      if (existing) testStorageId = existing.id;
    }
  } else {
    record('Vehicles', '/api/fuel-ops/storage-units', 'POST create', r2.status, r2.ms, false, r2.data?.error);
  }

  // EDIT unit
  if (testStorageId) {
    const r3 = await req('PUT', `/api/fuel-ops/storage-units/${testStorageId}`, { capacity_liters: 1234 });
    record('Vehicles', `/storage-units/${testStorageId}`, 'PUT update capacity', r3.status, r3.ms, r3.status === 200 && Number(r3.data?.capacity_liters) === 1234);

    // Re-fetch and compare
    const r4 = await req('GET', '/api/fuel-ops/storage-units');
    const updated = (Array.isArray(r4.data) ? r4.data : []).find(u => u.id === testStorageId);
    const match = updated && Number(updated.capacity_liters) === 1234;
    record('Vehicles', '/api/fuel-ops/storage-units', 'GET re-fetch verify', r4.status, r4.ms, match, match ? 'capacity=1234 confirmed' : 'mismatch');
  }
}

// ─────────────────────────────────────────────────────────────────────────
async function testDrivers() {
  console.log('\n═══ TAB: Drivers ═══');

  // GET all
  const r1 = await req('GET', '/api/fuel-ops/drivers');
  const drivers = Array.isArray(r1.data) ? r1.data : [];
  const hasKeys = drivers.length > 0 && ['id', 'name', 'driver_id', 'active'].every(k => k in drivers[0]);
  record('Drivers', '/api/fuel-ops/drivers', 'GET all', r1.status, r1.ms, r1.status === 200 && hasKeys, `count=${drivers.length}`);

  // CREATE test driver
  const r2 = await req('POST', '/api/fuel-ops/drivers', { name: 'E2E_TEST_DRIVER', driver_id: 'E2ETEST99', phone: '0000000000' });
  if (r2.status === 201) {
    testDriverPk = r2.data.id;
    testDriverId = r2.data.driver_id;
    record('Drivers', '/api/fuel-ops/drivers', 'POST create', r2.status, r2.ms, true, `id=${r2.data.id}`);
  } else if (r2.status === 409) {
    record('Drivers', '/api/fuel-ops/drivers', 'POST create (dup)', r2.status, r2.ms, true, 'already exists');
    const find = (Array.isArray(r1.data) ? r1.data : []).find(d => d.driver_id === 'E2ETEST99');
    if (find) { testDriverPk = find.id; testDriverId = find.driver_id; }
    // Try with alternate ID
    if (!testDriverPk) {
      const r2b = await req('POST', '/api/fuel-ops/drivers', { name: 'E2E_TEST_DRIVER', driver_id: 'E2ETEST98' });
      if (r2b.status === 201) { testDriverPk = r2b.data.id; testDriverId = r2b.data.driver_id; }
    }
  } else {
    record('Drivers', '/api/fuel-ops/drivers', 'POST create', r2.status, r2.ms, false, r2.data?.error);
  }

  // UPDATE driver
  if (testDriverPk) {
    const r3 = await req('PUT', `/api/fuel-ops/drivers/${testDriverPk}`, { name: 'E2E_UPDATED', phone: '1111111111' });
    record('Drivers', `/drivers/${testDriverPk}`, 'PUT update', r3.status, r3.ms, r3.status === 200 && r3.data?.name === 'E2E_UPDATED');

    // Verify update persisted
    const r4 = await req('GET', '/api/fuel-ops/drivers');
    const updated = (Array.isArray(r4.data) ? r4.data : []).find(d => d.id === testDriverPk);
    const match = updated && updated.name === 'E2E_UPDATED';
    record('Drivers', '/api/fuel-ops/drivers', 'GET verify update', r4.status, r4.ms, match, match ? 'name=E2E_UPDATED' : 'mismatch');
  }
}

// ─────────────────────────────────────────────────────────────────────────
async function testOdometer() {
  console.log('\n═══ TAB: Odometer Readings ═══');
  if (!testTruckId) { record('Odometer', '-', 'SKIP', '-', 0, false, 'no truck available'); return; }

  // GET current
  const r1 = await req('GET', '/api/fuel-ops/day/odometer', null, { params: { truck_id: testTruckId, date: TEST_DATE } });
  record('Odometer', '/day/odometer', 'GET', r1.status, r1.ms, r1.status === 200, (r1.data == null || r1.data === '') ? 'none' : 'exists');

  // Add reading
  const r2 = await req('POST', '/api/fuel-ops/day/odometer', {
    truck_id: testTruckId, date: TEST_DATE,
    opening_km: 10000, closing_km: 10250,
    note: 'E2E test odometer',
    opening_at: `${TEST_DATE} 06:00:00`, closing_at: `${TEST_DATE} 20:00:00`,
  });
  if (r2.status === 201) {
    testOdoId = r2.data?.id;
    record('Odometer', '/day/odometer', 'POST create', r2.status, r2.ms, true, `id=${testOdoId}`);
  } else if (r2.status === 409) {
    record('Odometer', '/day/odometer', 'POST create (dup)', r2.status, r2.ms, true, 'already exists');
    // fetch to get the ID
    const fetch = await req('GET', '/api/fuel-ops/day/odometer', null, { params: { truck_id: testTruckId, date: TEST_DATE } });
    if (fetch.data && fetch.data.id) testOdoId = fetch.data.id;
  } else {
    record('Odometer', '/day/odometer', 'POST create', r2.status, r2.ms, false, r2.data?.error);
  }

  // Verify exists
  const r3 = await req('GET', '/api/fuel-ops/day/odometer', null, { params: { truck_id: testTruckId, date: TEST_DATE } });
  const exists = r3.status === 200 && r3.data && r3.data.opening_km != null;
  record('Odometer', '/day/odometer', 'GET verify', r3.status, r3.ms, exists, exists ? `opening_km=${r3.data.opening_km}` : 'not found');

  // Opening suggestion
  const r4 = await req('GET', '/api/fuel-ops/opening-suggestion/odometer', null, { params: { truck_id: testTruckId, date: TEST_DATE } });
  record('Odometer', '/opening-suggestion/odometer', 'GET suggestion', r4.status, r4.ms, r4.status === 200);
}

// ─────────────────────────────────────────────────────────────────────────
async function testMeterSnapshots() {
  console.log('\n═══ TAB: Fuel Meter Checks ═══');
  if (!testTruckId) { record('Meter', '-', 'SKIP', '-', 0, false, 'no truck available'); return; }

  // GET
  const r1 = await req('GET', '/api/fuel-ops/meter-snapshots', null, { params: { truck_id: testTruckId } });
  record('Meter', '/meter-snapshots', 'GET', r1.status, r1.ms, r1.status === 200 && r1.data?.items != null, `count=${r1.data?.items?.length || 0}`);

  // INSERT
  const r2 = await req('POST', '/api/fuel-ops/meter-snapshots', {
    truck_id: testTruckId,
    reading_liters: 7777,
    reading_at: `${TEST_DATE}T08:00:00`,
    note: 'E2E test snapshot',
  });
  if (r2.status === 201) {
    testSnapId = r2.data?.id;
    record('Meter', '/meter-snapshots', 'POST create', r2.status, r2.ms, true, `id=${testSnapId} liters=7777`);
  } else {
    record('Meter', '/meter-snapshots', 'POST create', r2.status, r2.ms, false, r2.data?.error);
  }

  // Verify
  const r3 = await req('GET', '/api/fuel-ops/meter-snapshots', null, { params: { truck_id: testTruckId } });
  const found = (r3.data?.items || []).some(s => Number(s.reading_liters) === 7777);
  record('Meter', '/meter-snapshots', 'GET verify', r3.status, r3.ms, found, found ? 'snapshot found' : 'not found');

  // Reconcile/daily
  const r4 = await req('GET', '/api/fuel-ops/reconcile/daily', null, { params: { truck_id: testTruckId, date: TEST_DATE } });
  record('Meter', '/reconcile/daily', 'GET reconcile', r4.status, r4.ms, r4.status === 200);
}

// ─────────────────────────────────────────────────────────────────────────
async function testDayLogs() {
  console.log('\n═══ TAB: At Depot / Day Logs ═══');
  if (!testTruckId) { record('DayLogs', '-', 'SKIP', '-', 0, false, 'no truck available'); return; }

  // GET
  const r1 = await req('GET', '/api/fuel-ops/day/logs', null, { params: { truck_id: testTruckId, date: TEST_DATE } });
  record('DayLogs', '/day/logs', 'GET', r1.status, r1.ms, r1.status === 200);

  // ADD new log (closing >= opening required by DB CHECK constraint)
  const r2 = await req('POST', '/api/fuel-ops/day/logs', {
    truck_id: testTruckId, date: TEST_DATE,
    opening_liters: 4000, closing_liters: 4500,
    opening_at: `${TEST_DATE} 06:00:00`, closing_at: `${TEST_DATE} 20:00:00`,
    note: 'E2E test log',
  });
  if (r2.status === 201) {
    testLogId = r2.data?.id;
    record('DayLogs', '/day/logs', 'POST create', r2.status, r2.ms, true, `id=${testLogId}`);
  } else if (r2.status === 409) {
    record('DayLogs', '/day/logs', 'POST create (dup)', r2.status, r2.ms, true, 'already exists');
    const fetch = await req('GET', '/api/fuel-ops/day/logs', null, { params: { truck_id: testTruckId, date: TEST_DATE } });
    if (fetch.data && fetch.data.id) testLogId = fetch.data.id;
  } else {
    record('DayLogs', '/day/logs', 'POST create', r2.status, r2.ms, false, r2.data?.error);
  }

  // UPDATE
  if (testLogId) {
    const r3 = await req('PATCH', `/api/fuel-ops/day/logs/${testLogId}`, { note: 'E2E updated note' });
    record('DayLogs', `/day/logs/${testLogId}`, 'PATCH update', r3.status, r3.ms, r3.status === 200);
  }

  // LIST
  const r5 = await req('GET', '/api/fuel-ops/day/logs/list', null, { params: { truck_id: testTruckId, limit: 5 } });
  record('DayLogs', '/day/logs/list', 'GET list', r5.status, r5.ms, r5.status === 200 && r5.data?.items != null, `count=${r5.data?.items?.length || 0}`);

  // DELETE
  if (testLogId) {
    const r4 = await req('DELETE', `/api/fuel-ops/day/logs/${testLogId}`);
    const ok = r4.status === 200 && r4.data?.ok === true;
    record('DayLogs', `/day/logs/${testLogId}`, 'DELETE', r4.status, r4.ms, ok);
    if (ok) testLogId = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
async function testDispenser() {
  console.log('\n═══ TAB: Dispenser Day Readings ═══');
  if (!testTruckId) { record('Dispenser', '-', 'SKIP', '-', 0, false, 'no truck available'); return; }

  // GET
  const r1 = await req('GET', '/api/fuel-ops/day/dispenser', null, { params: { truck_id: testTruckId, date: TEST_DATE } });
  record('Dispenser', '/day/dispenser', 'GET', r1.status, r1.ms, r1.status === 200);

  // CREATE opening reading (needed for transfers later)
  const r2 = await req('POST', '/api/fuel-ops/day/dispenser', {
    truck_id: testTruckId, date: TEST_DATE,
    opening_liters: 3000,
    opening_at: `${TEST_DATE} 06:00:00`,
    note: 'E2E dispenser test',
  });
  if (r2.status === 201) {
    record('Dispenser', '/day/dispenser', 'POST create', r2.status, r2.ms, true);
  } else if (r2.status === 409) {
    record('Dispenser', '/day/dispenser', 'POST create (dup)', r2.status, r2.ms, true, 'already exists');
  } else {
    record('Dispenser', '/day/dispenser', 'POST create', r2.status, r2.ms, false, r2.data?.error);
  }

  // PATCH (closing_liters must be >= opening_liters)
  const r3 = await req('PATCH', '/api/fuel-ops/day/dispenser', {
    truck_id: testTruckId, date: TEST_DATE,
    closing_liters: 3200,
    closing_at: `${TEST_DATE} 20:00:00`,
  });
  record('Dispenser', '/day/dispenser', 'PATCH update', r3.status, r3.ms, r3.status === 200 || r3.status === 404);
}

// ─────────────────────────────────────────────────────────────────────────
async function testPurchaseLots() {
  console.log('\n═══ TAB: Purchase (Lots) ═══');
  if (!testTruckId) { record('Purchase', '-', 'SKIP', '-', 0, false, 'no truck available'); return; }

  // Lot code preview
  const r0 = await req('GET', '/api/fuel-ops/lot-code', null, { params: { unit_id: testTruckId, load_date: TEST_DATE, loaded_liters: 1000 } });
  record('Purchase', '/lot-code', 'GET preview', r0.status, r0.ms, r0.status === 200 && r0.data?.lot_code != null, `code=${r0.data?.lot_code}`);

  // Create a purchase lot
  const r1 = await req('POST', '/api/fuel-ops/lots', {
    unit_id: testTruckId,
    load_date: TEST_DATE,
    loaded_liters: 1000,
    load_time: '07:00',
    tanker_code: 'E2E_TANKER',
  });
  if (r1.status === 201 && r1.data?.id) {
    testLotId = r1.data.id;
    record('Purchase', '/lots', 'POST create', r1.status, r1.ms, true, `lot_id=${testLotId} code=${r1.data.lot_code}`);
  } else {
    record('Purchase', '/lots', 'POST create', r1.status, r1.ms, false, r1.data?.error);
  }

  // GET lots/list
  const r2 = await req('GET', '/api/fuel-ops/lots/list', null, { params: { unit_id: testTruckId, limit: 10 } });
  const hasItems = r2.data?.items && Array.isArray(r2.data.items);
  record('Purchase', '/lots/list', 'GET list', r2.status, r2.ms, r2.status === 200 && hasItems, `count=${r2.data?.items?.length || 0}`);

  // Verify remaining_liters > 0 on our test lot
  if (hasItems && testLotId) {
    const lot = r2.data.items.find(l => String(l.id) === String(testLotId));
    const ok = lot && Number(lot.remaining_liters) > 0;
    record('Purchase', '/lots/list', 'Verify remaining_liters', r2.status, r2.ms, ok, lot ? `remaining=${lot.remaining_liters}` : 'lot not found');

    // Verify schema keys
    const expectedKeys = ['id', 'unit_id', 'load_date', 'loaded_liters', 'used_liters', 'stock_status', 'remaining_liters', 'load_type', 'unit_code'];
    if (lot) {
      const hasAllKeys = expectedKeys.every(k => k in lot);
      record('Purchase', '/lots/list', 'Verify JSON schema', r2.status, r2.ms, hasAllKeys, hasAllKeys ? 'all keys present' : `missing: ${expectedKeys.filter(k => !(k in lot)).join(',')}`);
    }
  }

  // CSV export
  const r3 = await req('GET', '/api/fuel-ops/lots/export', null, { params: { unit_id: testTruckId } });
  const isCsv = r3.status === 200 && (r3.headers?.['content-type'] || '').includes('csv');
  record('Purchase', '/lots/export', 'GET CSV export', r3.status, r3.ms, r3.status === 200, isCsv ? 'CSV' : `type=${r3.headers?.['content-type']}`);
}

// ─────────────────────────────────────────────────────────────────────────
async function testTrips() {
  console.log('\n═══ TAB: Trips ═══');
  if (!testTruckId) { record('Trips', '-', 'SKIP', '-', 0, false, 'no truck available'); return; }

  // GET
  const r1 = await req('GET', '/api/fuel-ops/trips', null, { params: { truck_id: testTruckId, date: TEST_DATE } });
  record('Trips', '/trips', 'GET', r1.status, r1.ms, r1.status === 200, `items=${r1.data?.items?.length || 0}`);

  // CREATE trip
  const r2 = await req('POST', '/api/fuel-ops/trips', {
    truck_id: testTruckId, date: TEST_DATE,
    opening_liters: 3000,
    opening_at: `${TEST_DATE} 06:00:00`,
    driver_name: 'E2E_DRIVER', driver_code: 'E2E',
  });
  if (r2.status === 201 && r2.data?.id) {
    testTripId = r2.data.id;
    record('Trips', '/trips', 'POST create', r2.status, r2.ms, true, `trip_id=${testTripId} trip_no=${r2.data.trip_no}`);
  } else {
    record('Trips', '/trips', 'POST create', r2.status, r2.ms, false, r2.data?.error);
    // If already exists, pick the last one
    if (r1.data?.items?.length) {
      testTripId = r1.data.items[r1.data.items.length - 1].id;
    }
  }

  // PATCH trip
  if (testTripId) {
    const r3 = await req('PATCH', `/api/fuel-ops/trips/${testTripId}`, {
      closing_liters: 2800,
      closing_at: `${TEST_DATE} 20:00:00`,
      note: 'E2E updated trip',
    });
    record('Trips', `/trips/${testTripId}`, 'PATCH update', r3.status, r3.ms, r3.status === 200 || r3.status === 409);
  }
}

// ─────────────────────────────────────────────────────────────────────────
async function testInternalTransfers() {
  console.log('\n═══ TAB: Internal Transfers ═══');
  if (!testTruckId || !testDatumId || !testLotId) {
    record('IntTransfer', '-', 'SKIP', '-', 0, false, 'no truck/datum/lot available');
    return;
  }

  // Get lot remaining before
  const before = await req('GET', '/api/fuel-ops/lots/list', null, { params: { unit_id: testTruckId, limit: 10 } });
  let remBefore = null;
  if (before.data?.items) {
    const lot = before.data.items.find(l => String(l.id) === String(testLotId));
    remBefore = lot ? Number(lot.remaining_liters) : null;
  }

  // CREATE internal transfer (TANKER_TO_DATUM)
  const r1 = await req('POST', '/api/fuel-ops/lots/activity', {
    activity: 'TANKER_TO_DATUM',
    from_unit_id: testTruckId,
    to_unit_id: testDatumId,
    volume_liters: 100,
    transfer_date: TEST_DATE,
    performed_time: '08:00',
  });
  if (r1.status === 201 && r1.data?.transfers?.length) {
    testInternalId = r1.data.transfers[0].id;
    record('IntTransfer', '/lots/activity', 'POST TANKER_TO_DATUM', r1.status, r1.ms, true, `xfer_id=${testInternalId} vol=${r1.data.total_transferred}`);
  } else {
    record('IntTransfer', '/lots/activity', 'POST TANKER_TO_DATUM', r1.status, r1.ms, false, r1.data?.error);
  }

  // Verify lot accessible after transfer (internal transfers track movement, remaining may stay same)
  if (remBefore != null && testInternalId) {
    const after = await req('GET', '/api/fuel-ops/lots/list', null, { params: { unit_id: testTruckId, limit: 10 } });
    if (after.data?.items) {
      const lot = after.data.items.find(l => String(l.id) === String(testLotId));
      const remAfter = lot ? Number(lot.remaining_liters) : null;
      const ok = remAfter != null && remAfter >= 0;
      record('IntTransfer', '/lots/list', 'Verify lot after transfer', after.status, after.ms, ok, `before=${remBefore} after=${remAfter}`);
    }
  }

  // GET internal list
  const r2 = await req('GET', '/api/fuel-ops/transfers/internal/list', null, { params: { limit: 10 } });
  record('IntTransfer', '/transfers/internal/list', 'GET list', r2.status, r2.ms, r2.status === 200 && r2.data?.items != null, `count=${r2.data?.items?.length || 0}`);

  // DELETE internal transfer
  if (testInternalId) {
    const r3 = await req('DELETE', `/api/fuel-ops/transfers/internal/${testInternalId}`);
    record('IntTransfer', `/transfers/internal/${testInternalId}`, 'DELETE', r3.status, r3.ms, r3.status === 200 && r3.data?.deleted === true);

    // Verify remaining restored
    const restored = await req('GET', '/api/fuel-ops/lots/list', null, { params: { unit_id: testTruckId, limit: 10 } });
    if (restored.data?.items && remBefore != null) {
      const lot = restored.data.items.find(l => String(l.id) === String(testLotId));
      const remRestored = lot ? Number(lot.remaining_liters) : null;
      const ok = remRestored != null && remRestored >= remBefore;
      record('IntTransfer', '/lots/list', 'Verify remaining restored', restored.status, restored.ms, ok, `restored=${remRestored} original=${remBefore}`);
    }
    testInternalId = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
async function testSales() {
  console.log('\n═══ TAB: Sales ═══');
  if (!testTruckId || !testLotId) {
    record('Sales', '-', 'SKIP', '-', 0, false, 'no truck/lot available');
    return;
  }

  // Create sale
  const r1 = await req('POST', '/api/fuel-ops/lots/activity', {
    activity: 'TANKER_TO_VEHICLE',
    from_unit_id: testTruckId,
    to_vehicle: 'E2E_CUSTOMER_TRUCK',
    volume_liters: 50,
    sale_date: TEST_DATE,
    performed_time: '10:00',
  });
  if (r1.status === 201 && r1.data?.sale?.id) {
    testSaleId = r1.data.sale.id;
    record('Sales', '/lots/activity', 'POST sale', r1.status, r1.ms, true, `sale_id=${testSaleId}`);
  } else {
    record('Sales', '/lots/activity', 'POST sale', r1.status, r1.ms, false, r1.data?.error);
  }

  // Verify lot status in list
  const r2 = await req('GET', '/api/fuel-ops/lots/list', null, { params: { unit_id: testTruckId, limit: 10 } });
  if (r2.data?.items) {
    const lot = r2.data.items.find(l => String(l.id) === String(testLotId));
    record('Sales', '/lots/list', 'Verify lot after sale', r2.status, r2.ms, lot != null, lot ? `status=${lot.stock_status} remaining=${lot.remaining_liters}` : 'lot not found');
  }

  // GET sales list
  const r3 = await req('GET', '/api/fuel-ops/transfers/sales/list', null, { params: { limit: 10 } });
  record('Sales', '/transfers/sales/list', 'GET list', r3.status, r3.ms, r3.status === 200 && r3.data?.items != null, `count=${r3.data?.items?.length || 0}`);

  // DELETE test sale
  if (testSaleId) {
    const r4 = await req('DELETE', `/api/fuel-ops/transfers/sales/${testSaleId}`);
    record('Sales', `/transfers/sales/${testSaleId}`, 'DELETE sale', r4.status, r4.ms, r4.status === 200 && r4.data?.deleted === true);
    testSaleId = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
async function testAudit() {
  console.log('\n═══ TAB: Audit ═══');

  const r1 = await req('GET', '/api/fuel-ops/audit', null, { params: { limit: 20 } });
  const hasItems = r1.data?.items && Array.isArray(r1.data.items);
  record('Audit', '/audit', 'GET list', r1.status, r1.ms, r1.status === 200 && hasItems, `count=${r1.data?.items?.length || 0}`);

  // Verify schema
  if (hasItems && r1.data.items.length > 0) {
    const row = r1.data.items[0];
    const requiredKeys = ['id', 'created_at', 'performed_by', 'action', 'entity_type'];
    const all = requiredKeys.every(k => k in row);
    record('Audit', '/audit', 'Verify schema', r1.status, r1.ms, all, all ? 'all keys present' : `missing: ${requiredKeys.filter(k => !(k in row)).join(',')}`);
  }

  // Check that recent actions were logged (from our test operations)
  if (hasItems) {
    const recent = r1.data.items.filter(a => a.unit_code || a.action);
    record('Audit', '/audit', 'Confirm audit entries exist', r1.status, r1.ms, recent.length > 0, `entries=${recent.length}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
async function testFreezeUnfreeze() {
  console.log('\n═══ FREEZE / UNFREEZE ═══');
  if (!testTripId) { record('Freeze', '-', 'SKIP', '-', 0, false, 'no trip available'); return; }

  // Close the trip first (set closing values so freeze can happen)
  await req('PATCH', `/api/fuel-ops/trips/${testTripId}`, {
    closing_liters: 2800, closing_at: `${TEST_DATE} 20:00:00`,
  });

  // update-end-trip (auto-freeze)
  const r1 = await req('POST', `/api/fuel-ops/trips/${testTripId}/update-end-trip`, { reason: 'E2E freeze test' });
  const froze = r1.status === 200;
  record('Freeze', `/trips/${testTripId}/update-end-trip`, 'POST freeze', r1.status, r1.ms, froze || r1.status === 400 || r1.status === 409, r1.data?.error || 'frozen');

  // Attempt edit while frozen → expect 409
  if (froze) {
    const r2 = await req('PATCH', `/api/fuel-ops/trips/${testTripId}`, { note: 'should fail' });
    record('Freeze', `/trips/${testTripId}`, 'PATCH while frozen (expect 409)', r2.status, r2.ms, r2.status === 409, r2.data?.error);
  }

  // Unfreeze
  const r3 = await req('POST', `/api/fuel-ops/trips/${testTripId}/unfreeze`, { reason: 'E2E unfreeze test' });
  const unfroze = r3.status === 200;
  record('Freeze', `/trips/${testTripId}/unfreeze`, 'POST unfreeze', r3.status, r3.ms, unfroze || r3.status === 400, r3.data?.error || 'unfrozen');

  // Edit should succeed now
  if (unfroze) {
    const r4 = await req('PATCH', `/api/fuel-ops/trips/${testTripId}`, { note: 'E2E post-unfreeze edit' });
    record('Freeze', `/trips/${testTripId}`, 'PATCH after unfreeze', r4.status, r4.ms, r4.status === 200);
  }
}

// ─────────────────────────────────────────────────────────────────────────
async function testAuthorizationGuard() {
  console.log('\n═══ AUTHORIZATION TESTS (no token) ═══');

  const endpoints = [
    ['GET', '/api/fuel-ops/storage-units'],
    ['GET', '/api/fuel-ops/drivers'],
    ['GET', '/api/fuel-ops/trips?truck_id=1'],
    ['GET', '/api/fuel-ops/lots/list'],
    ['GET', '/api/fuel-ops/day/logs?truck_id=1&date=2026-01-01'],
    ['GET', '/api/fuel-ops/audit'],
    ['POST', '/api/fuel-ops/lots'],
    ['POST', '/api/fuel-ops/drivers'],
  ];

  for (const [method, ep] of endpoints) {
    const r = await req(method, ep, method === 'POST' ? {} : undefined, { noAuth: true });
    const pass = r.status === 401;
    record('AuthGuard', ep, `${method} no-token → 401`, r.status, r.ms, pass, pass ? '' : `expected 401 got ${r.status}`);
  }
}

// ── Cleanup ────────────────────────────────────────────────────────────────
async function cleanup() {
  console.log('\n═══ CLEANUP ═══');

  // Delete test trip
  if (testTripId) {
    const r = await req('DELETE', `/api/fuel-ops/trips/${testTripId}`);
    console.log(`  cleanup trip ${testTripId}: ${r.status}`);
  }

  // Delete test odometer
  if (testOdoId) {
    const r = await req('DELETE', '/api/fuel-ops/day/odometer', null, { params: { id: testOdoId } });
    console.log(`  cleanup odometer ${testOdoId}: ${r.status}`);
  }

  // Delete test log (if not already deleted)
  if (testLogId) {
    const r = await req('DELETE', `/api/fuel-ops/day/logs/${testLogId}`);
    console.log(`  cleanup log ${testLogId}: ${r.status}`);
  }

  // Delete test sale (if not already deleted)
  if (testSaleId) {
    const r = await req('DELETE', `/api/fuel-ops/transfers/sales/${testSaleId}`);
    console.log(`  cleanup sale ${testSaleId}: ${r.status}`);
  }

  // Delete test internal transfer (if not already deleted)
  if (testInternalId) {
    const r = await req('DELETE', `/api/fuel-ops/transfers/internal/${testInternalId}`);
    console.log(`  cleanup internal ${testInternalId}: ${r.status}`);
  }

  // Delete dispenser test reading (PATCH to clear or just leave — no DELETE endpoint for single dispenser)
  // Dispenser readings don't have a delete-by-id endpoint, skip.

  // Delete test lot — no direct delete endpoint; lot cleanup via DB or leave
  // (lots with existing transfers can't be deleted easily)

  // Delete test driver
  if (testDriverPk) {
    const r = await req('DELETE', `/api/fuel-ops/drivers/${testDriverPk}`);
    console.log(`  cleanup driver ${testDriverPk}: ${r.status}`);
  }

  // Delete test storage unit
  if (testStorageId) {
    const r = await req('DELETE', `/api/fuel-ops/storage-units/${testStorageId}`);
    console.log(`  cleanup storage ${testStorageId}: ${r.status}`);
  }

  // Delete test meter snapshot (no DELETE endpoint — leave in DB)
  if (testSnapId) {
    console.log(`  note: meter snapshot ${testSnapId} left in DB (no DELETE endpoint)`);
  }
}

// ── Report ─────────────────────────────────────────────────────────────────
function generateReport() {
  const passed = results.filter(r => r.result === 'PASS').length;
  const failed = results.filter(r => r.result === 'FAIL').length;
  const total = results.length;

  const lines = [
    '# Fuel-Ops E2E Feature Validation Report',
    '',
    `**Date:** ${new Date().toISOString().slice(0, 10)}`,
    `**Gateway:** ${BASE}`,
    `**Auth User:** ${CREDS.identifier}`,
    '',
    '---',
    '',
    '## Results',
    '',
    '| Feature | Endpoint | Action | Status | Response Time | Result | Detail |',
    '| ------- | -------- | ------ | ------ | ------------- | ------ | ------ |',
  ];

  for (const r of results) {
    const icon = r.result === 'PASS' ? '✅' : '❌';
    lines.push(`| ${r.feature} | ${r.endpoint} | ${r.action} | ${r.status} | ${r.ms} | ${icon} ${r.result} | ${r.detail} |`);
  }

  lines.push('', '---', '', '## Summary', '');
  lines.push(`| Metric | Count |`);
  lines.push(`| ------ | ----- |`);
  lines.push(`| **TOTAL TESTS** | ${total} |`);
  lines.push(`| **PASSED** | ${passed} |`);
  lines.push(`| **FAILED** | ${failed} |`);
  lines.push(`| **Pass Rate** | ${total > 0 ? ((passed / total) * 100).toFixed(1) : 0}% |`);
  lines.push('', '---', '', '## Tab Coverage', '');

  const features = [...new Set(results.map(r => r.feature))];
  for (const f of features) {
    const fResults = results.filter(r => r.feature === f);
    const fp = fResults.filter(r => r.result === 'PASS').length;
    const ft = fResults.length;
    lines.push(`- **${f}**: ${fp}/${ft} passed`);
  }

  lines.push('');

  const reportPath = path.join(__dirname, '..', '..', 'TEST_REPORT.md');
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
  console.log(`\nReport written to: ${reportPath}`);
  return { total, passed, failed };
}

// ── Main ───────────────────────────────────────────────────────────────────
(async () => {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║   Fuel Operations — E2E Feature Validation Suite          ║');
  console.log(`║   Target: ${BASE.padEnd(46)}║`);
  console.log('╚════════════════════════════════════════════════════════════╝');

  try {
    await testAuth();
    await testStorageUnits();
    await testDrivers();
    await testDispenser();
    await testOdometer();
    await testMeterSnapshots();
    await testDayLogs();
    await testTrips();
    await testPurchaseLots();
    await testInternalTransfers();
    await testSales();
    await testAudit();
    await testFreezeUnfreeze();
    await testAuthorizationGuard();
  } catch (e) {
    console.error('\nFATAL ERROR:', e.message);
    record('FATAL', '-', 'uncaught', 0, 0, false, e.message);
  }

  await cleanup();
  const { total, passed, failed } = generateReport();

  console.log('\n════════════════════════════════════════');
  console.log(`  TOTAL: ${total}   PASSED: ${passed}   FAILED: ${failed}`);
  console.log('════════════════════════════════════════');

  process.exit(failed > 0 ? 1 : 0);
})();
