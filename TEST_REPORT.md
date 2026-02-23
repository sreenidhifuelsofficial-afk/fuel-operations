# Fuel-Ops E2E Feature Validation Report

**Date:** 2026-02-19
**Gateway:** http://localhost:5000
**Auth User:** owner@local.test

---

## Results

| Feature | Endpoint | Action | Status | Response Time | Result | Detail |
| ------- | -------- | ------ | ------ | ------------- | ------ | ------ |
| Auth | /api/auth/login | POST login | 200 | 340ms | ✅ PASS | role=OWNER |
| Vehicles | /api/fuel-ops/storage-units | GET all | 200 | 29ms | ✅ PASS | count=5 |
| Vehicles | /api/fuel-ops/storage-units | POST create | 201 | 16ms | ✅ PASS | id=50 |
| Vehicles | /storage-units/50 | PUT update capacity | 200 | 7ms | ✅ PASS |  |
| Vehicles | /api/fuel-ops/storage-units | GET re-fetch verify | 200 | 4ms | ✅ PASS | capacity=1234 confirmed |
| Drivers | /api/fuel-ops/drivers | GET all | 200 | 14ms | ✅ PASS | count=4 |
| Drivers | /api/fuel-ops/drivers | POST create | 201 | 11ms | ✅ PASS | id=27 |
| Drivers | /drivers/27 | PUT update | 200 | 6ms | ✅ PASS |  |
| Drivers | /api/fuel-ops/drivers | GET verify update | 200 | 6ms | ✅ PASS | name=E2E_UPDATED |
| Dispenser | /day/dispenser | GET | 200 | 15ms | ✅ PASS |  |
| Dispenser | /day/dispenser | POST create | 201 | 22ms | ✅ PASS |  |
| Dispenser | /day/dispenser | PATCH update | 200 | 19ms | ✅ PASS |  |
| Odometer | /day/odometer | GET | 200 | 87ms | ✅ PASS | none |
| Odometer | /day/odometer | POST create | 201 | 13ms | ✅ PASS | id=6 |
| Odometer | /day/odometer | GET verify | 200 | 4ms | ✅ PASS | opening_km=10000 |
| Odometer | /opening-suggestion/odometer | GET suggestion | 200 | 7ms | ✅ PASS |  |
| Meter | /meter-snapshots | GET | 200 | 32ms | ✅ PASS | count=12 |
| Meter | /meter-snapshots | POST create | 201 | 6ms | ✅ PASS | id=25 liters=7777 |
| Meter | /meter-snapshots | GET verify | 200 | 6ms | ✅ PASS | snapshot found |
| Meter | /reconcile/daily | GET reconcile | 200 | 44ms | ✅ PASS |  |
| DayLogs | /day/logs | GET | 200 | 5ms | ✅ PASS |  |
| DayLogs | /day/logs | POST create (dup) | 409 | 4ms | ✅ PASS | already exists |
| DayLogs | /day/logs/18 | PATCH update | 200 | 9ms | ✅ PASS |  |
| DayLogs | /day/logs/list | GET list | 200 | 7ms | ✅ PASS | count=3 |
| DayLogs | /day/logs/18 | DELETE | 200 | 6ms | ✅ PASS |  |
| Trips | /trips | GET | 200 | 21ms | ✅ PASS | items=0 |
| Trips | /trips | POST create | 201 | 8ms | ✅ PASS | trip_id=48 trip_no=1 |
| Trips | /trips/48 | PATCH update | 200 | 8ms | ✅ PASS |  |
| Purchase | /lot-code | GET preview | 200 | 54ms | ✅ PASS | code=LOT31DEC993KG1000 |
| Purchase | /lots | POST create | 201 | 117ms | ✅ PASS | lot_id=51 code=LOT31DEC993KG1000 |
| Purchase | /lots/list | GET list | 200 | 9ms | ✅ PASS | count=8 |
| Purchase | /lots/list | Verify remaining_liters | 200 | 9ms | ✅ PASS | remaining=1000 |
| Purchase | /lots/list | Verify JSON schema | 200 | 9ms | ✅ PASS | all keys present |
| Purchase | /lots/export | GET CSV export | 200 | 6ms | ✅ PASS | CSV |
| IntTransfer | /lots/activity | POST TANKER_TO_DATUM | 201 | 48ms | ✅ PASS | xfer_id=48 vol=100 |
| IntTransfer | /lots/list | Verify lot after transfer | 200 | 8ms | ✅ PASS | before=1000 after=1000 |
| IntTransfer | /transfers/internal/list | GET list | 200 | 8ms | ✅ PASS | count=10 |
| IntTransfer | /transfers/internal/48 | DELETE | 200 | 17ms | ✅ PASS |  |
| IntTransfer | /lots/list | Verify remaining restored | 200 | 7ms | ✅ PASS | restored=1000 original=1000 |
| Sales | /lots/activity | POST sale | 201 | 16ms | ✅ PASS | sale_id=63 |
| Sales | /lots/list | Verify lot after sale | 200 | 8ms | ✅ PASS | status=INSTOCK remaining=950 |
| Sales | /transfers/sales/list | GET list | 200 | 10ms | ✅ PASS | count=10 |
| Sales | /transfers/sales/63 | DELETE sale | 200 | 11ms | ✅ PASS |  |
| Audit | /audit | GET list | 200 | 99ms | ✅ PASS | count=20 |
| Audit | /audit | Verify schema | 200 | 99ms | ✅ PASS | all keys present |
| Audit | /audit | Confirm audit entries exist | 200 | 99ms | ✅ PASS | entries=20 |
| Freeze | /trips/48/update-end-trip | POST freeze | 409 | 6ms | ✅ PASS | Locked: trip is frozen. Unfreeze to update end trip. |
| Freeze | /trips/48/unfreeze | POST unfreeze | 200 | 13ms | ✅ PASS | unfrozen |
| Freeze | /trips/48 | PATCH after unfreeze | 200 | 6ms | ✅ PASS |  |
| AuthGuard | /api/fuel-ops/storage-units | GET no-token → 401 | 401 | 2ms | ✅ PASS |  |
| AuthGuard | /api/fuel-ops/drivers | GET no-token → 401 | 401 | 3ms | ✅ PASS |  |
| AuthGuard | /api/fuel-ops/trips?truck_id=1 | GET no-token → 401 | 401 | 3ms | ✅ PASS |  |
| AuthGuard | /api/fuel-ops/lots/list | GET no-token → 401 | 401 | 2ms | ✅ PASS |  |
| AuthGuard | /api/fuel-ops/day/logs?truck_id=1&date=2026-01-01 | GET no-token → 401 | 401 | 2ms | ✅ PASS |  |
| AuthGuard | /api/fuel-ops/audit | GET no-token → 401 | 401 | 2ms | ✅ PASS |  |
| AuthGuard | /api/fuel-ops/lots | POST no-token → 401 | 401 | 3ms | ✅ PASS |  |
| AuthGuard | /api/fuel-ops/drivers | POST no-token → 401 | 401 | 2ms | ✅ PASS |  |

---

## Summary

| Metric | Count |
| ------ | ----- |
| **TOTAL TESTS** | 57 |
| **PASSED** | 57 |
| **FAILED** | 0 |
| **Pass Rate** | 100.0% |

---

## Tab Coverage

- **Auth**: 1/1 passed
- **Vehicles**: 4/4 passed
- **Drivers**: 4/4 passed
- **Dispenser**: 3/3 passed
- **Odometer**: 4/4 passed
- **Meter**: 4/4 passed
- **DayLogs**: 5/5 passed
- **Trips**: 3/3 passed
- **Purchase**: 6/6 passed
- **IntTransfer**: 5/5 passed
- **Sales**: 4/4 passed
- **Audit**: 3/3 passed
- **Freeze**: 3/3 passed
- **AuthGuard**: 8/8 passed
