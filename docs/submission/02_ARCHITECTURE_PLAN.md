# FuelOps — Architecture Plan

**Version:** 1.0  
**Date:** February 2026  
**Author:** Engineering (AI-assisted)

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Service Diagram](#2-service-diagram)
3. [Request Flow](#3-request-flow)
4. [Frontend Structure](#4-frontend-structure)
5. [Gateway Responsibilities](#5-gateway-responsibilities)
6. [Data Layer Design](#6-data-layer-design)
7. [Deployment Plan](#7-deployment-plan)
8. [Engineering Tradeoffs](#8-engineering-tradeoffs)

---

## 1. System Overview

FuelOps is a multi-service web application for managing fuel distribution operations. The system handles fuel purchases, internal transfers between storage units and trucks, customer sales, vehicle telemetry (odometer/dispenser readings), driver management, and real-time stock reconciliation.

### Architecture Style

The system follows a **gateway-routed microservice** pattern:

- A single Express.js gateway receives all HTTP requests
- The gateway mounts three domain-specific service routers as middleware
- Each service owns its controllers, services, and repositories
- All services share a single PostgreSQL database (no per-service DB isolation at this stage)
- Shared infrastructure concerns (caching, query isolation, auth, job queue) are extracted into internal packages

### Design Principles

| Principle | Implementation |
|---|---|
| Dependency injection | Factory functions accept `{ pool, requireAuth, ... }` — no global imports |
| Layered architecture | Controller → Service → Repository in domain services |
| Fail-fast startup | Gateway validates `DATABASE_URL`, `JWT_SECRET`, `PORT` before binding |
| Incremental migration | Legacy monolith runs in parallel; services are extracted one domain at a time |
| Environment parity | Cache and queue abstractions swap between in-process (dev) and Redis/BullMQ (prod) |

---

## 2. Service Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                          CLIENTS                                    │
│                  Browser (React SPA)                                │
│                  Port 3000 (dev) → proxy → 5000                     │
└────────────────────────────┬────────────────────────────────────────┘
                             │ HTTP
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     API GATEWAY (Express)                           │
│                     Port 5000                                       │
│                                                                     │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────┐  ┌────────────┐ │
│  │   Helmet     │  │   CORS       │  │ Rate-Limit│  │ Compression│ │
│  └─────────────┘  └──────────────┘  └───────────┘  └────────────┘ │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────┐                  │
│  │   HPP        │  │   Morgan     │  │ UTF-8 Norm│                  │
│  └─────────────┘  └──────────────┘  └───────────┘                  │
│                                                                     │
│  Route Mounting Order:                                              │
│  1. Health checks   ( / , /health , /healthz )                      │
│  2. Auth Service    ( /api/auth/* , /api/users/* , /api/profile/* ) │
│  3. Reporting Svc   ( /api/fuel-ops/stock/* , /api/fuel-ops/ops/* ) │
│  4. FuelOps Service ( /api/fuel-ops/* — 52 routes )                 │
│  5. Mini-stock      ( /api/fuel-ops/mini-stock )                    │
│  6. 404 handler + global error handler                              │
└────────────────────────────┬────────────────────────────────────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
┌──────────────────┐ ┌──────────────┐ ┌──────────────────┐
│  AUTH SERVICE     │ │  REPORTING   │ │  FUELOPS SERVICE  │
│                   │ │  SERVICE     │ │                   │
│  20 endpoints     │ │  3+ endpoints│ │  52 endpoints     │
│                   │ │              │ │                   │
│  • Registration   │ │  • Stock     │ │  7 Controllers:   │
│  • Login / JWT    │ │    summary   │ │  • Storage        │
│  • Role mgmt     │ │  • Day ops   │ │  • Drivers        │
│  • Permissions    │ │  • Trip ops  │ │  • Transfers      │
│  • Profile/Photo  │ │  • Dashboard │ │  • Lots           │
│  • Password audit │ │              │ │  • Trips          │
│                   │ │              │ │  • Day Ops        │
│                   │ │              │ │  • Meters         │
└────────┬─────────┘ └──────┬───────┘ └────────┬──────────┘
         │                  │                   │
         └──────────────────┼───────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     SHARED PACKAGES                                 │
│                                                                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐           │
│  │ @fuel-ops│  │ @fuel-ops│  │ @fuel-ops│  │ @fuel-ops│           │
│  │ /db      │  │ /cache   │  │ /query   │  │ /queue   │           │
│  │          │  │          │  │          │  │          │           │
│  │ PG Pool  │  │ Map/Redis│  │ Isolated │  │ In-proc/ │           │
│  │ SSL      │  │ TTL cache│  │ queries  │  │ BullMQ   │           │
│  │ Backoff  │  │          │  │ Read pool│  │          │           │
│  └────┬─────┘  └──────────┘  └──────────┘  └──────────┘           │
│       │                                                             │
│  ┌────┴─────┐  ┌──────────┐                                        │
│  │ @fuel-ops│  │ @fuel-ops│                                        │
│  │ /metrics │  │/middleware│                                        │
│  │          │  │          │                                        │
│  │ Lot stock│  │ Auth fns │                                        │
│  │ CTE query│  │ Helmet   │                                        │
│  │ 10s cache│  │ CORS     │                                        │
│  └──────────┘  └──────────┘                                        │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     POSTGRESQL                                      │
│                     (Neon-compatible, SSL)                           │
│                                                                     │
│  Core Tables:                                                       │
│  users · user_profiles · user_permissions · users_password_audit    │
│  storage_units · drivers                                            │
│  fuel_lots · fuel_internal_transfers · fuel_sale_transfers          │
│  truck_dispenser_day_readings · truck_odometer_day_readings         │
│  truck_dispenser_meter_snapshots                                    │
│                                                                     │
│  Views: user_full_profiles · fuel_lots (admin)                      │
│  Migrations: 31+ sequential SQL files                               │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. Request Flow

### Authenticated API Request

```
Browser                Gateway              Auth Middleware         Service Layer         Database
  │                      │                       │                      │                    │
  │  POST /api/fuel-ops  │                       │                      │                    │
  │  /lots               │                       │                      │                    │
  │  Authorization:      │                       │                      │                    │
  │  Bearer <jwt>        │                       │                      │                    │
  │─────────────────────>│                       │                      │                    │
  │                      │  Parse token          │                      │                    │
  │                      │─────────────────────> │                      │                    │
  │                      │                       │  Verify JWT          │                    │
  │                      │                       │  Attach req.user     │                    │
  │                      │  <─────────────────── │                      │                    │
  │                      │                       │                      │                    │
  │                      │  Route to FuelOps     │                      │                    │
  │                      │  lotController.create │                      │                    │
  │                      │─────────────────────────────────────────────>│                    │
  │                      │                       │                      │  lotService        │
  │                      │                       │                      │  .createLot()      │
  │                      │                       │                      │───────────────────>│
  │                      │                       │                      │  INSERT fuel_lots  │
  │                      │                       │                      │<───────────────────│
  │                      │                       │                      │                    │
  │                      │                       │                      │  Enqueue:          │
  │                      │                       │                      │  recomputeLot      │
  │                      │                       │                      │                    │
  │                      │                       │                      │  Invalidate        │
  │                      │                       │                      │  metrics cache     │
  │                      │<─────────────────────────────────────────────│                    │
  │  201 { lot }         │                       │                      │                    │
  │<─────────────────────│                       │                      │                    │
```

### Stock Metrics Query (Cached Path)

```
Browser                Gateway              Cache                  Metrics Repo          Database
  │                      │                    │                       │                     │
  │  GET /api/fuel-ops   │                    │                       │                     │
  │  /mini-stock         │                    │                       │                     │
  │─────────────────────>│                    │                       │                     │
  │                      │  cache.get(key)    │                       │                     │
  │                      │──────────────────> │                       │                     │
  │                      │                    │                       │                     │
  │                      │  HIT (within 10s)  │                       │                     │
  │                      │<────────────────── │                       │                     │
  │  200 { metrics }     │                    │                       │                     │
  │<─────────────────────│                    │                       │                     │
  │                      │                    │                       │                     │
  │  --- CACHE MISS ---  │                    │                       │                     │
  │                      │  cache.get(key)    │                       │                     │
  │                      │──────────────────> │                       │                     │
  │                      │  MISS              │                       │                     │
  │                      │<────────────────── │                       │                     │
  │                      │                    │                       │                     │
  │                      │  isolatedQuery()   │                       │                     │
  │                      │──────────────────────────────────────────> │                     │
  │                      │                    │                       │  CTE: compute       │
  │                      │                    │                       │  per-unit remaining  │
  │                      │                    │                       │  liters              │
  │                      │                    │                       │────────────────────> │
  │                      │                    │                       │<──────────────────── │
  │                      │                    │                       │                     │
  │                      │  cache.set(key,    │                       │                     │
  │                      │    result, 10s)    │                       │                     │
  │                      │──────────────────> │                       │                     │
  │  200 { metrics }     │                    │                       │                     │
  │<─────────────────────│                    │                       │                     │
```

---

## 4. Frontend Structure

### Technology Stack

- **React 19.2** with functional components and hooks
- **React Router DOM 7** for client-side routing
- **Create React App** build toolchain
- **Sentry** for error tracking
- **CSS** (custom, responsive — no UI framework dependency)

### Route Map

```
/                           → Redirect to /fuelops
/fuelops                    → FuelOps (main operations dashboard)
  /fuelops/odometer         → OdometerTab          — Daily odometer readings
  /fuelops/meter-checks     → FuelMeterChecksTab   — Fuel meter check records
  /fuelops/at-depot         → AtDepotTab           — At-depot operations
  /fuelops/day-logs         → DayLogsTab           — Consolidated daily logs
  /fuelops/vehicles         → VehiclesStorageTab   — Vehicle & storage unit mgmt
  /fuelops/drivers          → DriversTab           — Driver management
  /fuelops/purchase         → PurchaseTab          — Create fuel lots (purchases)
  /fuelops/internal-transfers → InternalTransfersTab — Internal fuel transfers
  /fuelops/sales            → SalesTab             — Fuel sale records
  /fuelops/audit            → AuditTab             — Audit trail
/profile                    → Profile              — User profile management
/employee-control           → EmployeeControl      — Admin user management (OWNER/ADMIN only)
```

### Authentication Flow

1. On app load, check `localStorage` for `authToken`
2. Validate token via `GET /api/auth/me`
3. If invalid/missing → render `<Login>` component
4. On success → store token, load user object, fetch permissions (for EMPLOYEE role)
5. 10-minute idle timer (mouse/keyboard/scroll activity) triggers auto-logout

### UI Patterns

- **Tab-based navigation** — FuelOps sub-routes render as horizontal tabs (desktop) or collapsible navigation (mobile)
- **MiniStockCard** — Persistent sidebar widget showing real-time fuel levels per storage unit, auto-refreshing every 45 seconds
- **Mobile responsive** — Slide-out drawer for stock indicators on narrow viewports
- **Permission gating** — Tabs hidden from UI and routes blocked for users without corresponding permissions
- **Lot code preview** — Purchase form shows a live-generated lot code via API before submission

---

## 5. Gateway Responsibilities

The gateway (`apps/gateway/index.js`) is the sole HTTP entry point for the platform. Its responsibilities are strictly limited to cross-cutting concerns:

### What the Gateway Does

| Responsibility | Detail |
|---|---|
| **Environment validation** | Fails fast if `DATABASE_URL`, `JWT_SECRET`, or `PORT` are missing |
| **Shared middleware** | Helmet, CORS, compression, rate-limiting (600 req/min), HPP, Morgan logging |
| **Request logging** | Logs timestamp, method, route, status code, and elapsed time for every request |
| **UTF-8 normalization** | Ensures all JSON responses use consistent character encoding |
| **Service mounting** | Mounts auth, reporting, and fuelops routers in correct precedence order |
| **Health endpoints** | `GET /` (basic), `GET /health` (liveness), `GET /healthz` (DB-aware readiness) |
| **Error handling** | 404 catch-all, global error handler (stack traces suppressed in production) |
| **Graceful shutdown** | Listens for SIGTERM/SIGINT, closes DB pool, then exits |

### What the Gateway Does NOT Do

- No business logic
- No direct database queries (except healthz readiness check)
- No session state
- No request transformation or response mapping

### Route Mounting Order

Mounting order matters because reporting and fuelops both bind under `/api/fuel-ops`:

1. **Auth Service** — mounted at root (no path prefix collision)
2. **Reporting Service** — mounted at `/api/fuel-ops` first, for more-specific routes like `/stock/summary` and `/ops/day`
3. **FuelOps Service** — mounted at `/api/fuel-ops` second, catches all remaining 52 CRUD routes
4. **Mini-stock** — inline handler for `/api/fuel-ops/mini-stock` (lightweight aggregate)

---

## 6. Data Layer Design

### Database

- **Engine:** PostgreSQL
- **Hosting:** Neon (cloud-native Postgres, SSL connections)
- **Pool configuration:** Max 15 connections, idle timeout 30s, connection timeout 5s
- **Client settings:** UTF-8 encoding, statement timeout, idle-in-transaction timeout
- **Type handling:** NUMERIC → float, timestamps preserved as ISO strings

### Schema Overview

(See service diagram section for the entity map.)

### Query Isolation Pattern

All database queries use `isolatedQuery` from `@fuel-ops/query`.

### Caching Strategy

Stock metrics use a 10-second TTL cache plus explicit invalidation on write operations.

### Migration System

- 31+ sequential SQL migration files in `backend/migrations_legacy/`
- Naming convention: `NNN_description.sql`
- Dev-mode `ensureMinimalSchema()` exists in the legacy monolith to bootstrap fresh environments

---

## 7. Deployment Plan

### Current State (Development)

- Frontend: `localhost:3000` (CRA dev server, proxy → `localhost:5000`)
- Gateway: `localhost:5000` (Express)
- Database: Neon PostgreSQL (SSL)

### Target State (AWS Lightsail)

- Nginx serves React static build and reverse proxies `/api/*` to the gateway
- Node.js process managed by PM2
- Redis added for cache + BullMQ queue (optional, already supported)
- Database remains Neon (external Postgres)

**GitHub Repository:** *(to be published)*  
**Hosted Demo:** Deployment in progress (AWS Lightsail planned)
