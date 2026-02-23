# Monolith Decommission Report

**Date:** 2025-07-16  
**Phase:** Gateway promotion — auth & reporting migration  
**Status:** LIVE — ready to run

---

## Summary

| Metric | Value |
|--------|-------|
| **Monolith lines before** | 5,489 |
| **Monolith lines after** | 4,779 |
| **Lines removed** | 711 (13%) |
| **Routes removed** | 12 |
| **Routes remaining** | 64 |
| **Gateway routes (direct)** | 15 (auth: 10, reporting: 3, health: 2) |
| **Gateway routes (proxied → monolith)** | 64 |
| **Frontend proxy target** | `http://127.0.0.1:5000` (unchanged) |

---

## New Architecture

```
  Frontend (CRA dev server)
      │
      ▼  proxy → 127.0.0.1:5000
  ┌──────────────────────────────┐
  │   apps/gateway/index.js     │  PORT 5000 (PRIMARY)
  │                              │
  │  ├── auth-service            │  10 routes (register, login, users CRUD, ...)
  │  ├── reporting-service       │   3 routes (stock/summary, ops/day, ops/trip)
  │  ├── GET /  &  GET /healthz  │   2 health checks
  │  │                           │
  │  └── fallback proxy ────────────→  127.0.0.1:5002
  └──────────────────────────────┘
                                        │
                                        ▼
                               ┌──────────────────────────┐
                               │  backend/index.js        │  LEGACY_PORT 5002
                               │                          │
                               │  64 routes:               │
                               │  ├── fuel-ops CRUD (49)   │
                               │  ├── profile (6)          │
                               │  ├── permissions (2)      │
                               │  ├── admin (2)            │
                               │  ├── health checks (2)    │
                               │  ├── test-db (1)          │
                               │  └── schema / utilities   │
                               └──────────────────────────┘
```

---

## Routes Removed from Monolith

These 12 routes are now **exclusively served** by gateway services with full implementation parity.

### Auth Service (9 routes)

| Method | Path | Verified |
|--------|------|----------|
| POST | `/api/auth/register-initial` | ✅ COMPLETE |
| GET | `/api/auth/owner-exists` | ✅ COMPLETE |
| POST | `/api/auth/login` | ✅ COMPLETE |
| GET | `/api/auth/me` | ✅ COMPLETE |
| POST | `/api/auth/change-password` | ✅ COMPLETE |
| POST | `/api/users` | ✅ COMPLETE |
| GET | `/api/users` | ✅ COMPLETE |
| PATCH | `/api/users/:id` | ✅ COMPLETE |
| POST | `/api/users/:id/password-reset` | ✅ COMPLETE |

> The auth-service also exposes `GET /api/password-audit` — a **net-new** endpoint not previously in the monolith.

### Reporting Service (3 routes)

| Method | Path | Verified |
|--------|------|----------|
| GET | `/api/fuel-ops/stock/summary` | ✅ COMPLETE |
| GET | `/api/fuel-ops/ops/day` | ✅ COMPLETE |
| GET | `/api/fuel-ops/ops/trip` | ✅ COMPLETE |

---

## Routes Remaining in Monolith (proxied via gateway)

### Fuel Ops — Storage & Equipment (7 routes)

| Method | Path |
|--------|------|
| GET | `/api/fuel-ops/storage-units` |
| POST | `/api/fuel-ops/storage-units` |
| PUT | `/api/fuel-ops/storage-units/:id` |
| DELETE | `/api/fuel-ops/storage-units/:id` |
| DELETE | `/api/fuel-ops/vehicles/:id` |
| GET | `/api/fuel-ops/dispensers` |
| GET | `/api/fuel-ops/vehicles` |

### Fuel Ops — Drivers (4 routes)

| Method | Path |
|--------|------|
| GET | `/api/fuel-ops/drivers` |
| POST | `/api/fuel-ops/drivers` |
| PUT | `/api/fuel-ops/drivers/:id` |
| DELETE | `/api/fuel-ops/drivers/:id` |

### Fuel Ops — Lots (5 routes)

| Method | Path |
|--------|------|
| GET | `/api/fuel-ops/lot-code` |
| POST | `/api/fuel-ops/lots` |
| POST | `/api/fuel-ops/lots/activity` |
| GET | `/api/fuel-ops/lots/list` |
| GET | `/api/fuel-ops/lots/export` |

### Fuel Ops — Trips (5 routes)

| Method | Path |
|--------|------|
| GET | `/api/fuel-ops/trips` |
| POST | `/api/fuel-ops/trips` |
| PATCH | `/api/fuel-ops/trips/:id` |
| POST | `/api/fuel-ops/trips/:id/unfreeze` |
| POST | `/api/fuel-ops/trips/:id/update-end-trip` |
| DELETE | `/api/fuel-ops/trips/:id` |

### Fuel Ops — Day Operations (11 routes)

| Method | Path |
|--------|------|
| GET | `/api/fuel-ops/opening-suggestion/odometer` |
| GET | `/api/fuel-ops/day/dispenser` |
| POST | `/api/fuel-ops/day/dispenser` |
| PATCH | `/api/fuel-ops/day/dispenser` |
| GET | `/api/fuel-ops/day/logs` |
| GET | `/api/fuel-ops/day/logs/list` |
| POST | `/api/fuel-ops/day/logs` |
| PATCH | `/api/fuel-ops/day/logs/:id` |
| DELETE | `/api/fuel-ops/day/logs/:id` |
| GET | `/api/fuel-ops/day/odometer` |
| POST | `/api/fuel-ops/day/odometer` |
| PATCH | `/api/fuel-ops/day/odometer` |
| GET | `/api/fuel-ops/day/odometer/list` |
| DELETE | `/api/fuel-ops/day/odometer` |

### Fuel Ops — Meter & Reconciliation (3 routes)

| Method | Path |
|--------|------|
| POST | `/api/fuel-ops/meter-snapshots` |
| GET | `/api/fuel-ops/meter-snapshots` |
| GET | `/api/fuel-ops/reconcile/daily` |

### Fuel Ops — Audit (1 route)

| Method | Path |
|--------|------|
| GET | `/api/fuel-ops/audit` |

### Fuel Ops — Transfers (10 routes)

| Method | Path |
|--------|------|
| GET | `/api/fuel-ops/transfers/sales/export` |
| GET | `/api/fuel-ops/transfers/sales/list` |
| GET | `/api/fuel-ops/transfers/internal/list` |
| GET | `/api/fuel-ops/transfers/internal/export` |
| PATCH | `/api/fuel-ops/transfers/testing/:id` |
| DELETE | `/api/fuel-ops/transfers/testing/:id` |
| DELETE | `/api/fuel-ops/transfers/sales/:id` |
| PATCH | `/api/fuel-ops/transfers/sales/:id` |
| DELETE | `/api/fuel-ops/transfers/internal/:id` |
| PATCH | `/api/fuel-ops/transfers/internal/:id` |
| PUT | `/api/fuel-ops/transfers/internal/:id/full` |

### Profile, Permissions, Admin (10 routes)

| Method | Path |
|--------|------|
| GET | `/api/profile/me` |
| PUT | `/api/profile` |
| POST | `/api/profile/photo` |
| GET | `/api/profile/photo/me` |
| DELETE | `/api/profile/photo` |
| GET | `/api/profile/photo/:userId` |
| GET | `/api/users/:id/permissions` |
| PATCH | `/api/users/:id/permissions` |
| GET | `/api/admin/employee-profiles` |
| GET | `/api/admin/employee-profile/:userId` |

### Infrastructure (3 routes)

| Method | Path |
|--------|------|
| GET | `/` |
| GET | `/healthz` |
| GET | `/api/test-db` |

---

## fuelops-service — Disabled in Gateway

The `fuelops-service` mount has been **commented out** in the gateway because the majority of its routes have **partial implementation parity** with the monolith. Enabling it would silently change behavior for these routes:

| Route | Gap |
|-------|-----|
| `GET /storage-units` | Missing `?type=` and `?active=` query filters |
| `PUT /storage-units/:id` | Missing `active` field handling, unit_code uniqueness check |
| `DELETE /storage-units/:id` | Always soft-deletes (monolith tries hard-delete first, falls back to soft) |
| `DELETE /vehicles/:id` | Same hard-delete fallback gap |
| `GET /drivers` | Different column names (`driver_name` vs `name`), no `driver_id`, no `?active=` filter |
| `POST /drivers` | Schema mismatch — different required fields, no `driver_id` ON CONFLICT |
| `PUT /drivers/:id` | Schema mismatch — different merge fields |
| `DELETE /drivers/:id` | Always soft-deletes (same gap as storage) |
| `PATCH /transfers/sales/:id` | Missing `updated_at=NOW()`, returns 200 instead of 400 when no fields |
| `DELETE /transfers/internal/:id` | **CRITICAL** — Missing EMPTY_TRANSFER lot undo logic, no 409 guard for dependent records, no audit logging |

### To re-enable fuelops-service:

1. Fix all PARTIAL implementations above to match monolith logic exactly
2. Add missing routes (`PATCH /transfers/internal/:id`, `PUT /transfers/internal/:id/full`, `PATCH /transfers/testing/:id`, transfer list/export endpoints)
3. Verify driver table schema matches controller column names
4. Uncomment the mount block in `apps/gateway/index.js`

---

## Files Modified

| File | Change |
|------|--------|
| `backend/index.js` | Removed 12 route handlers (711 lines). Changed port default from 5000 → 5002 via `LEGACY_PORT` env. |
| `apps/gateway/index.js` | Disabled fuelops-service mount. Added HTTP proxy fallback targeting `127.0.0.1:5002`. |
| `.vscode/tasks.json` | Renamed tasks. Gateway is now "Start Gateway (localhost:5000)" (PRIMARY). Monolith is now "Start Legacy Monolith (localhost:5002)". |

---

## How to Run

### Development (both processes required)

```bash
# Terminal 1 — Gateway (primary entry point)
node apps/gateway/index.js
# → Listening on http://localhost:5000

# Terminal 2 — Legacy monolith (proxied)
npm --prefix backend start
# → Listening on http://localhost:5002

# Terminal 3 — Frontend
npm --prefix frontend start
# → http://localhost:3000 → proxy → localhost:5000
```

Or use the VS Code tasks:
1. **Start Gateway (localhost:5000)**
2. **Start Legacy Monolith (localhost:5002)**
3. **Start Frontend (localhost)**

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `5000` | Gateway port |
| `LEGACY_PORT` | `5002` | Monolith port |
| `LEGACY_HOST` | `127.0.0.1` | Monolith host (used by gateway proxy) |

---

## Migration Roadmap (Next Steps)

| Priority | Task | Routes affected |
|----------|------|-----------------|
| 🔴 HIGH | Fix `DELETE /transfers/internal/:id` in fuelops-service (EMPTY_TRANSFER logic) | 1 |
| 🟡 MED | Align driver schema in fuelops-service controller with actual DB columns | 4 |
| 🟡 MED | Add missing transfer CRUD routes to fuelops-service | 5 |
| 🟢 LOW | Add `?type=` / `?active=` filters to storage GET in fuelops-service | 1 |
| 🟢 LOW | Create profile-service for `/api/profile/*` routes | 6 |
| 🟢 LOW | Create permissions-service for `/api/users/:id/permissions` routes | 2 |
| 🟢 LOW | Create admin-service for `/api/admin/*` routes | 2 |
| 🟢 LOW | Migrate remaining fuel-ops day/lot/trip/audit/meter/reconcile routes | ~30 |

**Target:** Once all 64 monolith routes are migrated with COMPLETE parity, the legacy monolith can be fully decommissioned.
