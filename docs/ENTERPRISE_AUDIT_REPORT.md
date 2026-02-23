# === ENTERPRISE AUDIT REPORT ===

**Date:** 2025-02-19  
**Scope:** Full repository audit — architecture, frontend, database, file structure, cleanup blueprint  
**Mode:** Analysis only — NO deletions performed

---

## Step 1: Architecture Scan

### ACTIVE ENTERPRISE (in use by gateway)

| Path | Role | Status |
|------|------|--------|
| `apps/gateway/index.js` | API gateway on :5000 | **ACTIVE** |
| `apps/auth-service/` | `/api/auth/*`, `/api/users/*`, `/api/password-audit` | **ACTIVE** |
| `apps/fuelops-service/` | `/api/fuel-ops/*` (51+ routes) | **ACTIVE** |
| `apps/reporting-service/` | stock/summary, ops/day, ops/trip, dashboard-snapshot | **ACTIVE** |
| `packages/db/` | Shared PostgreSQL pool | **ACTIVE** |
| `packages/middleware/` | Security, auth, CORS, rate limiting | **ACTIVE** |
| `packages/cache/` | Redis / in-memory cache | **ACTIVE** |
| `packages/query/` | Isolated read pool (max 5, 8s timeout) | **ACTIVE** |
| `packages/queue/` | Job queue (lot recompute) | **ACTIVE** |

### ACTIVE BACKEND DEPENDENCIES (imported by gateway/services)

| File | Imported By | Notes |
|------|------------|-------|
| `backend/fuelOps/lotMetricsRepo.js` | `apps/gateway/index.js` line 104 | **CRITICAL** — should migrate to packages |
| `backend/utils/cache.js` | `lotMetricsRepo.js` | **CRITICAL** — dependency of lotMetricsRepo |
| `backend/.env` | `apps/gateway/index.js` line 33 | dotenv config source |
| `backend/db.js` | Scripts only | Utility — standalone pool for maintenance scripts |
| `backend/schema.sql` | Manual deployment | Canonical schema (15 tables) |
| `backend/schema_minimal.sql` | Manual deployment | Minimal schema variant |
| `backend/migrate.js` | Manual execution | Migration runner |
| `backend/seed.js` | Manual execution | Seed runner |
| `backend/auth.js` | Scripts only | Standalone auth module |

### LEGACY MONOLITH (full duplicate — all routes served by gateway)

| Path | Size | Notes |
|------|------|-------|
| `backend/index.js` | ~260 KB (~5400 lines) | **ENTIRE FILE IS DUPLICATE** — contains only FuelOps + auth routes, zero CRM routes. All 20+ route groups already served by gateway services. |

### GATEWAY ISSUE: Legacy Proxy Fallback

Lines 177-228 of `apps/gateway/index.js` contain a catch-all proxy that forwards unmatched requests to a monolith on `:5002`. Since all routes have been migrated, this proxy will never match a valid route and should be **removed**.

```
app.use((req, res) => {
  // proxies to LEGACY_HOST:LEGACY_PORT (default 127.0.0.1:5002)
  ...
});
```

### LEGACY ARCHIVE (historical only)

| Path | Notes |
|------|-------|
| `legacy-monolith-backup/monolith-full-archive.js` | Single-file archive, execution guard prevents running |
| `legacy-monolith-backup/MANIFEST.md` | Archive manifest |
| `legacy-monolith-backup/backend/src/` | Archived source files |
| `legacy-monolith-backup/routes/archived_crm_code.js` | Archived CRM route code |
| `legacy-monolith-backup/routes/archived_unused_handlers.js` | Archived unused handlers |
| `scripts/build-monolith-archive.js` | Generator script (purpose fulfilled) |

### CRM REMNANTS IN BACKEND

| File | Type | Content |
|------|------|---------|
| `backend/utils/templates/meetingEmail.js` | Email template | CRM meeting notification HTML |
| `backend/utils/templates/remindersEmail.js` | Email template | CRM reminder notification HTML |
| `backend/utils/calendar.js` | Utility | Calendar utils (outer copy) |
| `backend/utils/mailer.js` | Utility | Email sending (outer copy) |
| `backend/utils/utils/calendar.js` | Utility | Calendar utils (nested duplicate) |
| `backend/utils/utils/mailer.js` | Utility | Email sending (nested duplicate) |
| `backend/utils/utils/audit.js` | Utility | FuelOps audit helper — used ONLY by monolith `backend/index.js`, NOT by enterprise services (they have `apps/fuelops-service/services/auditService.js`) |
| `backend/utils/utils/templates/meetingEmail.js` | Email template | Nested duplicate of CRM meeting template |
| `backend/utils/utils/templates/remindersEmail.js` | Email template | Nested duplicate of CRM reminder template |

### CRM-RELATED SCRIPTS

| File | Content | Safe to Remove? |
|------|---------|----------------|
| `backend/scripts/backfill_business_events.js` | **Empty file** (0 bytes) | YES |
| `backend/scripts/check_expenses_audit.js` | Queries CRM `expenses_audit` table | YES |
| `backend/scripts/check_targets_exists.js` | Queries CRM `targets` table | YES |
| `backend/scripts/normalize_assignees.js` | CRM meetings assignee normalization | YES |
| `backend/scripts/preview_emails.js` | CRM meeting/reminder email preview | YES |
| `backend/scripts/test_email_preview.js` | CRM meeting email test endpoint | YES |
| `backend/scripts/test_email_send.js` | CRM email send test | YES |

---

## Step 2: Frontend Routing Audit

### Navigation Architecture

- **Pattern:** State-based tab switching via `useState` (NOT React Router)
- **Tab persistence:** `localStorage.getItem('fuelops:lastTab')`
- **Permission gating:** `EMPLOYEE` role checks `permissions.tabs` object
- **Idle auto-logout:** 10-minute inactivity timer with 30s polling
- **Default tab:** `FuelOps`

### Active Tabs (3)

| Tab Key | Component | Visible To |
|---------|-----------|------------|
| `FuelOps` | `<FuelOps>` | All users (gated by permissions for EMPLOYEE) |
| `Profile` | `<Profile>` | All authenticated users |
| `EmployeeControl` | `<EmployeeControl>` | OWNER and ADMIN only |

### Active Components (6 files)

| File | Role | Status |
|------|------|--------|
| `frontend/src/components/Login.js` | Authentication form | **ACTIVE** |
| `frontend/src/components/FuelOps.js` | Main fuel operations UI with sub-tabs | **ACTIVE** |
| `frontend/src/components/Profile.js` | User profile management | **ACTIVE** |
| `frontend/src/components/EmployeeControl.js` | User/employee admin panel | **ACTIVE** |
| `frontend/src/components/SortIcon.js` | Reusable sort indicator (imported by FuelOps) | **ACTIVE** |
| `frontend/src/components/FuelOps.sales.test.js` | Sales test file | **ACTIVE** |

### Frontend Utilities (6 files)

| File | Purpose | Status |
|------|---------|--------|
| `frontend/src/utils/auth.js` | Auth helpers | **ACTIVE** |
| `frontend/src/utils/autofill.js` | Form autofill | **ACTIVE** |
| `frontend/src/utils/fuelQuizQuestions.js` | Quiz data | **ACTIVE** |
| `frontend/src/utils/useDebouncedValue.js` | Debounce hook | **ACTIVE** |
| `frontend/src/utils/useValidation.js` | Validation hook | **ACTIVE** |
| `frontend/src/utils/validators.js` | Validation functions | **ACTIVE** |

### Stray File (ANOMALY)

| File | Issue |
|------|-------|
| `frontend/src/import React, { useEffect, useState } fr.ts` | **Malformed filename** — appears to be an accidental file creation from a clipboard paste. Not importable, not referenced. |

### CRA Boilerplate (can optionally clean)

| File | Notes |
|------|-------|
| `frontend/src/App.test.js` | Default CRA test (likely untouched) |
| `frontend/src/logo.svg` | Default CRA logo |
| `frontend/src/reportWebVitals.js` | Performance reporting |
| `frontend/src/setupTests.js` | Test setup |

---

## Step 3: Database & Schema Audit

### Tables (15 — ALL FuelOps/Auth, ZERO CRM)

| # | Table | Domain |
|---|-------|--------|
| 1 | `users` | Auth |
| 2 | `users_password_audit` | Auth |
| 3 | `user_profiles` | Auth |
| 4 | `user_photos` | Auth |
| 5 | `user_permissions` | Auth |
| 6 | `storage_units` | FuelOps |
| 7 | `drivers` | FuelOps |
| 8 | `fuel_lots` | FuelOps |
| 9 | `dispenser_day_reading_logs` | FuelOps |
| 10 | `truck_dispenser_trips` | FuelOps |
| 11 | `truck_dispenser_meter_snapshots` | FuelOps |
| 12 | `truck_odometer_day_readings` | FuelOps |
| 13 | `fuel_internal_transfers` | FuelOps |
| 14 | `fuel_sale_transfers` | FuelOps |
| 15 | `testing_self_transfers` | FuelOps |

### Functions (7 — ALL FuelOps)

| Function | Purpose |
|----------|---------|
| `touch_user_profiles()` | Trigger — update timestamp |
| `touch_user_permissions()` | Trigger — update timestamp |
| `seq_index_to_letters()` | Lot code generation helper |
| `gen_lot_code()` | Generate lot code |
| `next_seq_index_for_date()` | Sequence index for date |
| `preview_next_lot_code()` | Preview next lot code |
| `create_fuel_lot()` | Create fuel lot with auto-code |

### Views: NONE

### CRM Tables in Schema: NONE

> The word "target" appears in `users_password_audit.target_user_id` — this is an auth column tracking *which user* had their password changed. It is NOT a CRM targets table.

### Legacy Migrations Classification

**CRM-ONLY migrations** (safe to archive/remove — the tables they create/modify don't exist in current schema):

| Migration | Content |
|-----------|---------|
| `001_add_opportunity_business_events.sql` | CRM opportunities |
| `002_create_targets.sql` | CRM targets |
| `008_create_reminders_audit_v2.sql` | CRM reminders |
| `009_create_reminder_email_selected_audit.sql` | CRM reminders |
| `024_add_meeting_link_to_meetings.sql` | CRM meetings |
| `034_add_reminders_perf_indexes.sql` | CRM reminders |
| `035_create_reminder_overview_cache.sql` | CRM reminders |
| `036_create_reminder_bucket_cache.sql` | CRM reminders |

**FuelOps migrations** (003-007 are auth/users, 010-043+ are FuelOps — all active):

Migrations 003-007 (users setup), 010-023 (drivers, lots, readings, meters), 025-033 (schema refinements), 037-043 (audit, indexes, freeze), 097-1001 (cleanup/additions) are all FuelOps/auth and should be retained.

---

## Step 4: File Structure Validation

### Enterprise Layout ✅

```
apps/
  gateway/index.js          ✅ Entry point
  auth-service/             ✅ Auth routes
  fuelops-service/          ✅ FuelOps CRUD (51+ routes)
  reporting-service/        ✅ Heavy reads + dashboard
packages/
  db/                       ✅ Shared pool
  middleware/               ✅ Security stack
  cache/                    ✅ Cache layer
  query/                    ✅ Isolated read pool
  queue/                    ✅ Job queue
tests/
  e2e/                      ✅ 57/57 passing
docs/
  migration/                ✅ Organized documentation
frontend/
  src/components/           ✅ 6 active files (0 CRM)
  src/utils/                ✅ 6 utility files
```

### Structural Anomalies

| Issue | Path | Details |
|-------|------|---------|
| **Nested duplicate: scripts** | `backend/scripts/scripts/` | 25 files — all are duplicates of files in `backend/scripts/` (which has 31 files including 6 extras: `cleanup_orphan_empty_transfer_lots.js`, `debug_datum_stock.js`, `debug_units_stock.js`, `prune_to_minimal.js`, `recompute_lots.js`, `smoke-check.ps1`) |
| **Nested duplicate: utils** | `backend/utils/utils/` | Contains `audit.js`, `calendar.js`, `mailer.js`, `templates/` — duplicates of parent `backend/utils/` files |
| **Misplaced active code** | `backend/fuelOps/lotMetricsRepo.js` | Actively imported by gateway — should migrate to `packages/` |
| **Misplaced active code** | `backend/utils/cache.js` | Dependency of lotMetricsRepo — should migrate to `packages/cache/` or alongside lotMetricsRepo |
| **Stray file** | `frontend/src/import React, { useEffect, useState } fr.ts` | Malformed filename, 0 references |

---

## Step 5: Permanent Cleanup Blueprint

### Priority 1 — SAFE IMMEDIATE DELETION (zero risk)

These files have no imports, no references, and serve no purpose:

| Action | Target | Reason |
|--------|--------|--------|
| DELETE | `frontend/src/import React, { useEffect, useState } fr.ts` | Malformed stray file |
| DELETE | `backend/scripts/backfill_business_events.js` | Empty file (0 bytes) |
| DELETE | `backend/scripts/scripts/` (entire directory) | Full duplicate of parent `backend/scripts/` |
| DELETE | `backend/utils/utils/` (entire directory) | Full duplicate of parent `backend/utils/` |

### Priority 2 — CRM REMNANT REMOVAL (no enterprise references)

| Action | Target | Reason |
|--------|--------|--------|
| DELETE | `backend/utils/templates/meetingEmail.js` | CRM meeting email template |
| DELETE | `backend/utils/templates/remindersEmail.js` | CRM reminder email template |
| DELETE | `backend/utils/calendar.js` | CRM calendar utilities |
| DELETE | `backend/utils/mailer.js` | CRM email sending |
| DELETE | `backend/scripts/check_expenses_audit.js` | Queries non-existent CRM table |
| DELETE | `backend/scripts/check_targets_exists.js` | Queries non-existent CRM table |
| DELETE | `backend/scripts/normalize_assignees.js` | CRM meetings script |
| DELETE | `backend/scripts/preview_emails.js` | CRM email preview |
| DELETE | `backend/scripts/test_email_preview.js` | CRM email test |
| DELETE | `backend/scripts/test_email_send.js` | CRM email test |

After these deletions, `backend/utils/templates/` will be empty and should be removed.

### Priority 3 — CRM MIGRATION CLEANUP

| Action | Target | Reason |
|--------|--------|--------|
| DELETE | `backend/migrations_legacy/001_add_opportunity_business_events.sql` | CRM opportunities |
| DELETE | `backend/migrations_legacy/002_create_targets.sql` | CRM targets |
| DELETE | `backend/migrations_legacy/008_create_reminders_audit_v2.sql` | CRM reminders |
| DELETE | `backend/migrations_legacy/009_create_reminder_email_selected_audit.sql` | CRM reminders |
| DELETE | `backend/migrations_legacy/024_add_meeting_link_to_meetings.sql` | CRM meetings |
| DELETE | `backend/migrations_legacy/034_add_reminders_perf_indexes.sql` | CRM reminders |
| DELETE | `backend/migrations_legacy/035_create_reminder_overview_cache.sql` | CRM reminders |
| DELETE | `backend/migrations_legacy/036_create_reminder_bucket_cache.sql` | CRM reminders |

### Priority 4 — MONOLITH REMOVAL (requires verification first)

| Action | Target | Pre-check |
|--------|--------|-----------|
| DELETE | `backend/index.js` (~260 KB) | Confirm gateway handles 100% of traffic. E2E: 57/57 PASS already verified. |
| REMOVE | Gateway proxy fallback (lines 177-228 of `apps/gateway/index.js`) | Remove catch-all proxy to `:5002`. Replace with a 404 handler. |
| DELETE | `legacy-monolith-backup/` (entire directory) | Historical archive — purpose fulfilled. |
| DELETE | `scripts/build-monolith-archive.js` | Archive generator — purpose fulfilled. |

### Priority 5 — CODE MIGRATION (refactor, not deletion)

| Action | From | To | Reason |
|--------|------|----|--------|
| MOVE | `backend/fuelOps/lotMetricsRepo.js` | `packages/metrics/lotMetricsRepo.js` | Actively imported by gateway — should live in packages |
| MOVE | `backend/utils/cache.js` | `packages/cache/createCache.js` (or merge) | Dependency of lotMetricsRepo |
| UPDATE | `apps/gateway/index.js` line 104 | New import path | After moving lotMetricsRepo |

### Priority 6 — OPTIONAL CLEANUP

| Action | Target | Notes |
|--------|--------|-------|
| DELETE | `frontend/src/App.test.js` | Default CRA boilerplate (if unused) |
| DELETE | `frontend/src/logo.svg` | Default CRA logo (if unused) |
| REVIEW | `backend/package.json` | May contain CRM-only dependencies |
| RENAME | `backend/migrations_legacy/` → `backend/migrations/` | After CRM migrations removed, cleaner name |

---

## Summary Metrics

| Category | Count |
|----------|-------|
| Active enterprise service files | ~40+ across apps/ and packages/ |
| Active frontend components | 6 |
| Active database tables | 15 |
| Active database functions | 7 |
| E2E tests passing | 57/57 |
| Files safe for immediate deletion | 4 targets (stray file, empty file, 2 duplicate directories) |
| CRM remnant files to remove | 10 files + 8 migrations |
| Monolith files to remove | 3 targets (index.js, archive directory, archive script) |
| Gateway code to remove | 1 block (proxy fallback, ~50 lines) |
| Code to migrate | 2 files (lotMetricsRepo + cache) |
| **Total cleanup items** | **28 actions** |

---

> **Verdict:** The repository is architecturally sound. The enterprise gateway + micro-services pattern is fully operational with 100% route parity. The remaining cleanup is purely housekeeping — removing legacy duplicates, CRM remnants, and the now-redundant monolith. No functional risk from any deletion in Priorities 1-3. Priority 4 (monolith removal) is also safe given the 57/57 E2E validation, but warrants a final gateway-only deployment test before permanent deletion.
