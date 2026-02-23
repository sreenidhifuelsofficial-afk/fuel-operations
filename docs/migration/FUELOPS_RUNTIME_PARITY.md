# Fuel-Ops Runtime Parity Report

**Date:** 2026-02-20  
**Gateway (fuelops-service):** `localhost:5000`  
**Monolith:** `localhost:5002`  
**Auth:** JWT with OWNER role (user `e8d4df98`, username `owner_e8d4df`)

---

## 1. Endpoint Comparison Summary

| # | Endpoint | Gateway | Monolith | JSON Match | Verdict |
|---|----------|---------|----------|------------|---------|
| 1 | `GET /api/fuel-ops/storage-units` | 200 | 200 | **IDENTICAL** (5 items, same keys/values/order) | ✅ PASS |
| 2 | `GET /api/fuel-ops/drivers` | 200 | 200 | **IDENTICAL** (4 items, same keys/values/order) | ✅ PASS |
| 3 | `GET /api/fuel-ops/trips?truck_id=40` | 200 | 200 | **IDENTICAL** (773 bytes, 2 trips, byte-for-byte) | ✅ PASS |
| 4 | `GET /api/fuel-ops/lots/list` | **500** | 200 | N/A — gateway throws error | ❌ FAIL |
| 5 | `GET /api/fuel-ops/lot-code?unit_id=40&load_date=2026-02-19&loaded_liters=1000` | 200 | 200 | **IDENTICAL** (`LOT19FEB263KB1000`, seq_index 2) | ✅ PASS |
| 6 | `GET /api/fuel-ops/day/dispenser?truck_id=40&date=2026-02-19` | 200 | 200 | **IDENTICAL** (`null`) | ✅ PASS |
| 7 | `GET /api/fuel-ops/day/logs?truck_id=40&date=2026-02-19` | 200 | 200 | **IDENTICAL** (`null`) | ✅ PASS |
| 8 | `GET /api/fuel-ops/day/odometer?truck_id=40&date=2026-02-19` | 200 | 200 | **IDENTICAL** (`null`) | ✅ PASS |
| 9 | `GET /api/fuel-ops/meter-snapshots?truck_id=40&date=2026-02-19` | 200 | 200 | **IDENTICAL** (`{"items":[]}`) | ✅ PASS |
| 10 | `GET /api/fuel-ops/audit` | 200 | 200 | **IDENTICAL** (31,138 bytes, byte-for-byte match) | ✅ PASS |

**Result: 9/10 endpoints PASS — 1 FAIL (`lots/list`)**

---

## 2. Failure Analysis: `GET /lots/list` → 500

### Error Message
```json
{"error":"resolveDateCol is not a function"}
```

### Root Cause

In `apps/fuelops-service/controllers/lotController.js` (line 26):
```js
const { resolveDateCol } = require('../repositories/fuelLotRepository');
```

The module `fuelLotRepository.js` exports `{ createFuelLotRepository }` — a factory function, **not** `resolveDateCol` directly. The destructured import resolves to `undefined`, causing `TypeError` when called on line ~292.

### Fix Required (not applied — analysis only)

**Option A — Instantiate the repository and use it:**
```js
const { createFuelLotRepository } = require('../repositories/fuelLotRepository');
const lotRepo = createFuelLotRepository(pool);
// then use: const dateCol = await lotRepo.resolveDateCol();
```

**Option B — Inline the resolution (matches monolith pattern):**
```js
// In the handler body (same as monolith's resolveFuelLotsDateCol):
let _dateCol = null;
async function resolveDateCol() {
  if (_dateCol) return _dateCol;
  const q = await pool.query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='fuel_lots'
      AND column_name IN ('load_date','loaded_date')
    ORDER BY CASE column_name WHEN 'load_date' THEN 1 ELSE 2 END LIMIT 1`);
  _dateCol = (q.rows[0] && q.rows[0].column_name) || 'loaded_date';
  return _dateCol;
}
```

### Affected Routes
- `GET /lots/list` — 500 error
- `GET /lots/export` — also uses `resolveDateCol` (line 331), will also 500
- `POST /lots` — uses `resolveDateCol` (line 80), will also 500
- `POST /lots/activity` — uses `resolveDateCol` in some branches

All 4 lot-related routes that call `resolveDateCol(pool)` will fail. The `GET /lot-code` route does **not** use `resolveDateCol`, so it works correctly.

---

## 3. `remaining_liters` Validation

The monolith `lots/list` SQL computes `remaining_liters` as:
```sql
CASE WHEN fl.stock_status='SOLD' THEN 0
     ELSE GREATEST(0, fl.loaded_liters - fl.used_liters)
END AS remaining_liters
```

The fuelops-service `lotController.js` uses the **identical** SQL expression (verified via code comparison).

### Spot-Check Against Monolith Data

| Lot ID | loaded | used | remaining | status | Expected | Correct? |
|--------|--------|------|-----------|--------|----------|----------|
| 44 | 5,000 | 0 | 5,000 | INSTOCK | max(0, 5000-0) = 5,000 | ✅ |
| 43 | 5,500 | 12,427.42 | 0 | INSTOCK | max(0, 5500-12427.42) = 0 | ✅ |
| 42 | 2,500 | 2,250 | 250 | INSTOCK | max(0, 2500-2250) = 250 | ✅ |
| 41 | 6,000 | 11,300 | 0 | INSTOCK | max(0, 6000-11300) = 0 | ✅ |
| 40 | 25,000 | 19,000 | 6,000 | INSTOCK | max(0, 25000-19000) = 6,000 | ✅ |

All 5 lots have correct `remaining_liters`. The formula correctly clamps to 0 when `used_liters > loaded_liters` (lots 41 and 43 where inbound transfers inflated the used counter).

**Note:** The fuelops-service cannot currently be verified for `remaining_liters` because the `lots/list` route 500s. Once the `resolveDateCol` import is fixed, the SQL is identical and will produce the same result.

---

## 4. Audit Logging

### Read Path (GET /audit)
- Both gateway and monolith returned **200** with **31,138 bytes** of audit data.
- **Byte-for-byte identical** — confirms both services read from the same `fuel_ops_audit` table.

### Write Path (insertFuelOpsAudit)
- **Monolith** (`backend/index.js:701-734`): Inserts 13 columns.
- **Fuelops-service** (`apps/fuelops-service/services/auditService.js:15-57`): Inserts the **same 13 columns** in the same order.
- Both are wrapped in try/catch with `console.warn` on failure (non-throwing).
- The fuelops-service version destructures a few extra fields (`entity_id`, `amount_liters`, `ip_addr`) that are not written — harmless dead code.

**Verdict: Audit read-path PASS. Write-path code is structurally identical (not tested with a live write in this session — would require executing a state-changing operation).**

---

## 5. JSON Structure Comparison Detail

### `/storage-units` Response Schema
```json
{ "id": number, "unit_type": string, "unit_code": string, "capacity_liters": number, "active": boolean }
```
Both return array of objects with identical keys. No extra or missing fields.

### `/drivers` Response Schema
```json
{ "id": number, "name": string, "phone": string|null, "driver_id": string, "active": boolean }
```
Both return array of objects with identical keys.

### `/trips` Response Schema
```json
{
  "id": string, "truck_id": number, "reading_date": string, "trip_no": number,
  "opening_liters": number, "closing_liters": number, "opening_at": string, "closing_at": string|null,
  "note": string|null, "driver_name": string, "driver_code": string,
  "is_frozen": boolean, "frozen_at": string|null, "frozen_by": string|null,
  "frozen_reason": string|null, "unfrozen_at": string|null,
  "unfrozen_by": string|null, "unfrozen_reason": string|null
}
```
Both return `{ items: [...] }` with identical structure. All 18 fields present.

### `/audit` Response Schema
Identical `{ items: [...] }` wrapper. Each audit row contains `id`, `created_at`, `user_id`, `performed_by`, `tab`, `section`, `action`, `entity_type`, `unit_id`, `unit_code`, `trip_id`, `trip_no`, `op_date`, `reason`, `payload_old`, `payload_new`.

---

## 6. Summary & Recommendations

### What Works
- **9 of 10 tested endpoints** return identical responses from both gateway and monolith.
- Storage, drivers, trips, day-ops, odometer, meter-snapshots, lot-code, and audit are all fully functional.
- The `remaining_liters` SQL formula is identical in both codebases.
- Audit logging (read path) returns byte-for-byte identical data.

### What's Broken
- **1 bug** in `lotController.js`: incorrect import of `resolveDateCol` from `fuelLotRepository.js`.
- Affects **4 lot routes**: `POST /lots`, `POST /lots/activity`, `GET /lots/list`, `GET /lots/export`.
- `GET /lot-code` is unaffected (does not use `resolveDateCol`).

### Next Steps
1. **Fix the `resolveDateCol` import** in `lotController.js` (use Option A or B above).
2. Re-run parity check on `/lots/list` to confirm identical responses.
3. Test one write operation (e.g., create a lot or record a transfer) and verify audit row appears identically.
4. Once all endpoints pass, proceed with monolith decommission.
