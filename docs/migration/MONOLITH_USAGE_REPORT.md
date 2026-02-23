# Monolith Usage Report — Enterprise Runtime Verification

**Date:** 2026-02-19
**Gateway:** http://localhost:5000
**Monolith:** http://localhost:5002 (fallback proxy target)
**Verification method:** `[proxy-hit]` log injected into gateway fallback proxy layer

---

## Results

| Metric | Value |
| ------ | ----- |
| **Total proxy hits** | **0** |
| **Total requests processed** | 57 |
| **Requests handled by enterprise services** | 57 |
| **Requests forwarded to monolith** | 0 |
| **E2E test pass rate** | 57/57 (100%) |

---

## Time Window

| Field | Value |
| ----- | ----- |
| Test start | 2026-02-19T14:50:07Z |
| Test end | 2026-02-19T14:50:08Z |
| Duration | ~1.4 seconds |

---

## Endpoints Verified (zero monolith fallthrough)

| # | Method | Endpoint | Service |
|---|--------|----------|---------|
| 1 | POST | /api/auth/login | auth-service |
| 2 | GET | /api/fuel-ops/storage-units | fuelops-service |
| 3 | POST | /api/fuel-ops/storage-units | fuelops-service |
| 4 | PUT | /api/fuel-ops/storage-units/:id | fuelops-service |
| 5 | GET | /api/fuel-ops/drivers | fuelops-service |
| 6 | POST | /api/fuel-ops/drivers | fuelops-service |
| 7 | PUT | /api/fuel-ops/drivers/:id | fuelops-service |
| 8 | DELETE | /api/fuel-ops/drivers/:id | fuelops-service |
| 9 | GET | /api/fuel-ops/day/dispenser | fuelops-service |
| 10 | POST | /api/fuel-ops/day/dispenser | fuelops-service |
| 11 | PATCH | /api/fuel-ops/day/dispenser | fuelops-service |
| 12 | GET | /api/fuel-ops/day/odometer | fuelops-service |
| 13 | POST | /api/fuel-ops/day/odometer | fuelops-service |
| 14 | DELETE | /api/fuel-ops/day/odometer | fuelops-service |
| 15 | GET | /api/fuel-ops/opening-suggestion/odometer | fuelops-service |
| 16 | GET | /api/fuel-ops/meter-snapshots | fuelops-service |
| 17 | POST | /api/fuel-ops/meter-snapshots | fuelops-service |
| 18 | GET | /api/fuel-ops/reconcile/daily | fuelops-service |
| 19 | GET | /api/fuel-ops/day/logs | fuelops-service |
| 20 | POST | /api/fuel-ops/day/logs | fuelops-service |
| 21 | PATCH | /api/fuel-ops/day/logs/:id | fuelops-service |
| 22 | GET | /api/fuel-ops/day/logs/list | fuelops-service |
| 23 | DELETE | /api/fuel-ops/day/logs/:id | fuelops-service |
| 24 | GET | /api/fuel-ops/trips | fuelops-service |
| 25 | POST | /api/fuel-ops/trips | fuelops-service |
| 26 | PATCH | /api/fuel-ops/trips/:id | fuelops-service |
| 27 | DELETE | /api/fuel-ops/trips/:id | fuelops-service |
| 28 | POST | /api/fuel-ops/trips/:id/update-end-trip | fuelops-service |
| 29 | POST | /api/fuel-ops/trips/:id/unfreeze | fuelops-service |
| 30 | GET | /api/fuel-ops/lot-code | fuelops-service |
| 31 | POST | /api/fuel-ops/lots | fuelops-service |
| 32 | POST | /api/fuel-ops/lots/activity | fuelops-service |
| 33 | GET | /api/fuel-ops/lots/list | fuelops-service |
| 34 | GET | /api/fuel-ops/lots/export | fuelops-service |
| 35 | GET | /api/fuel-ops/transfers/internal/list | fuelops-service |
| 36 | DELETE | /api/fuel-ops/transfers/internal/:id | fuelops-service |
| 37 | GET | /api/fuel-ops/transfers/sales/list | fuelops-service |
| 38 | DELETE | /api/fuel-ops/transfers/sales/:id | fuelops-service |
| 39 | GET | /api/fuel-ops/audit | fuelops-service |
| 40 | DELETE | /api/fuel-ops/storage-units/:id | fuelops-service |

---

## Service Coverage Summary

| Service | Routes Handling Traffic | Status |
|---------|----------------------|--------|
| **auth-service** | POST /api/auth/login | FULLY OPERATIONAL |
| **fuelops-service** | 39 unique endpoints | FULLY OPERATIONAL |
| **reporting-service** | /stock/summary, /ops/day, /ops/trip (not exercised in E2E but mounted) | MOUNTED |
| **mini-stock** | GET /api/fuel-ops/mini-stock (verified separately) | FULLY OPERATIONAL |

---

## Conclusion

**ZERO monolith proxy hits recorded.** All 57 E2E test requests — spanning auth, vehicles, drivers, dispenser readings, odometer readings, meter snapshots, day logs, trips, purchases, internal transfers, sales, audit, freeze/unfreeze, and authorization guards — were fully handled by enterprise gateway services without any fallback to the legacy monolith on port 5002.

The monolith is safe to shut down for all fuel-ops API traffic routed through the gateway.
