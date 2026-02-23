# SAFE_TO_REMOVE_ROUTES.md

**Generated:** 2025-02-19  
**Methodology:** Frontend fetch() scan → Gateway active-route catalog → Monolith extraction → Set-difference analysis  
**Backup:** `legacy-monolith-backup/routes/archived_unused_handlers.js` (all handler code preserved)

---

## Summary

| Category | Count |
|---|---|
| Total monolith routes scanned | ~145 |
| Frontend-called routes (fetch) | 68 |
| Gateway-served routes | 23 |
| **Archived (proven unused)** | **21** |
| Needs review (ops/diagnostics) | 9 |

---

## Archived Routes (21) — PROVEN UNUSED

Every route below has **zero** `fetch()` calls in `frontend/src/` and is **not** mounted in the gateway. Handlers have been replaced with tombstone comments in `backend/index.js` and the full implementation preserved in the backup file.

### Fuel Ops — Stale/Superseded Endpoints

| # | Method | Path | Reason |
|---|--------|------|--------|
| 1 | GET | `/api/fuel-ops/opening-suggestion/dispenser` | Dead helper; no frontend caller |
| 2 | GET | `/api/fuel-ops/day/dispenser/list` | Superseded by `/day/unit/list` |
| 3 | POST | `/api/fuel-ops/trips/:id/freeze` | Already a 410 stub ("removed") |
| 4 | GET | `/api/fuel-ops/offhours` | Complex meter/transfer query; never wired to UI |
| 5 | GET | `/api/fuel-ops/transfers/sales` (bare) | Frontend uses `/sales/list`, `/sales/export`, `/sales/:id` only |

### Readings — Legacy 410 Stubs

| # | Method | Path | Reason |
|---|--------|------|--------|
| 6 | GET | `/api/readings/odometer` | 410 stub ("moved to /api/fuel-ops/…") |
| 7 | GET | `/api/readings/meter` | 410 stub |
| 8 | POST | `/api/readings/odometer` | 410 stub |
| 9 | POST | `/api/readings/meter` | 410 stub |

### Status History — Legacy Path

| # | Method | Path | Reason |
|---|--------|------|--------|
| 10 | GET | `/api/status_history` | Legacy; frontend uses `/api/history` |
| 11 | POST | `/api/status_history` | Legacy; frontend uses `/api/history` |

### Audit — Superseded by Bulk Endpoints

| # | Method | Path | Reason |
|---|--------|------|--------|
| 12 | GET | `/api/meetings-audit` (v1) | Superseded by `/api/meetings-audit-v2` |
| 13 | GET | `/api/meetings/:id/audit-v2` | Per-item; frontend uses bulk `/api/meetings-audit-v2` |
| 14 | GET | `/api/meetings/:id/email-audit` | Per-item; frontend uses bulk `/api/meetings-audit-v2` |
| 15 | GET | `/api/reminders/:id/audit-v2` | Per-item; frontend uses bulk `/api/reminders-audit-v2` |
| 16 | GET | `/api/reminders/:id/email-audit` | Per-item; no frontend caller |
| 17 | GET | `/api/reminders/:id/call-audit` | Per-item; no frontend caller |

### Employee Overview

| # | Method | Path | Reason |
|---|--------|------|--------|
| 18 | GET | `/api/employee-overview` | UI label exists but no fetch() to this path |

### Opportunities — Unused Stage-Transition API

| # | Method | Path | Reason |
|---|--------|------|--------|
| 19 | GET | `/api/opportunities/:id/stage-history` | Never called by frontend |
| 20 | GET | `/api/opportunities/:id/allowed-transitions` | Never called by frontend |
| 21 | POST | `/api/opportunities/:id/stage` | Never called by frontend; stage changes go through PUT `/api/opportunities/:id` |

---

## Needs Review — NOT Archived (9)

These routes have no frontend `fetch()` but may serve ops tooling, health checks, calendar integrations, or developer diagnostics. They were intentionally **kept active**.

| Method | Path | Why Kept |
|--------|------|----------|
| GET | `/api/diagnostics/pool` | Ops monitoring |
| GET | `/api/diagnostics/env-check` | Ops monitoring |
| GET | `/api/diagnostics/schema-version` | Ops monitoring |
| GET | `/api/diagnostics/timezone` | Ops monitoring |
| GET | `/api/diagnostics/columns/:table` | Ops monitoring |
| GET | `/api/test-db` | Health check |
| GET | `/api/ensure-schema` | Schema bootstrap |
| GET | `/api/meetings/:id/ics` | Calendar .ics download (browser link, not fetch) |
| GET | `/api/reminders/ics` | Calendar .ics feed (browser link, not fetch) |

---

## Gateway Integrity

The API gateway (`apps/gateway/index.js`) mounts three services:

- **auth-service** → `/api/auth/*`, `/api/users/*`, `/api/password-audit`
- **reporting-service** → `/api/fuel-ops/stock/summary`, `/api/fuel-ops/ops/day`, `/api/fuel-ops/ops/trip`
- **fuelops-service** → `/api/fuel-ops/*` (storage units, drivers, transfers, lots, etc.)

**No overlap** exists between the 21 archived routes and the gateway's active routes. Gateway functionality is fully intact.

---

## Restoration

To restore any archived handler:

1. Open `legacy-monolith-backup/routes/archived_unused_handlers.js`
2. Find the numbered section (e.g., `// ── #18: GET /api/employee-overview`)
3. Copy the handler code from the block comment
4. Replace the tombstone comment in `backend/index.js` with the copied code
5. Verify the route works with a manual test

Each tombstone in `backend/index.js` follows the format:
```
// [ARCHIVED 2025-02-19] METHOD /path — moved to legacy-monolith-backup/routes/archived_unused_handlers.js
```

---

## Methodology

1. **Frontend scan:** Searched all `frontend/src/**/*.{js,jsx}` for `fetch(` calls; extracted 68 unique API endpoint paths
2. **Gateway catalog:** Read all controller files under `apps/` to enumerate 23 gateway-served routes
3. **Monolith extraction:** Used regex on `backend/index.js` for `app.(get|post|put|patch|delete)` patterns; found ~145 unique method+path combinations
4. **Set difference:** `UNUSED = MONOLITH − FRONTEND − GATEWAY` → 21 definitely unused + 9 needs-review
5. **Triple verification:** Each of the 21 routes was individually grep-verified to confirm zero `fetch()` references
6. **Backup first:** All 21 handler implementations were copied to the backup file before any tombstoning
7. **Gateway check:** Confirmed zero overlap between archived routes and gateway-mounted routes
