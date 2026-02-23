# FuelOps — Side Project Description

## Project Overview

**FuelOps** is an enterprise-grade fuel operations management platform built to digitize the day-to-day workflows of a fuel distribution business. It replaces manual record-keeping across fuel purchases, internal transfers, sales, vehicle tracking, dispenser readings, and stock reconciliation with a centralized, role-based web application.

The platform is designed for a team of operators — from the business owner to field employees — where each user has scoped access to exactly the features they need.

---

## Problem Statement

Fuel distribution operations generate high volumes of daily transactional data: purchase lots arriving at depots, internal transfers between storage units and trucks, sales dispatched to customers, odometer and dispenser readings, and real-time stock levels across distributed units.

Without a centralized system, these operations rely on paper logs and spreadsheets, leading to:

- **Data fragmentation** — Records scattered across notebooks, WhatsApp messages, and Excel files
- **Stock discrepancies** — No real-time visibility into remaining fuel per unit
- **Audit gaps** — No traceable history of who recorded what and when
- **Coordination overhead** — Managers manually reconciling numbers reported by field staff

FuelOps addresses these problems by providing a single platform where all fuel movement is recorded, computed, and surfaced in real time.

---

## Key Architecture Decisions

### 1. Monolith-to-Gateway Migration (Incremental)

The project started as a single Express.js monolith (~5,500 lines). As complexity grew, the backend was incrementally decomposed into a **gateway + microservice architecture**:

- **Gateway** (`apps/gateway/`) — Single HTTP entry point. Applies shared middleware (auth, rate-limiting, CORS, compression), mounts service routers, and provides health/readiness endpoints.
- **Auth Service** (`apps/auth-service/`) — Handles registration, login, JWT issuance, role/permission management, password audit, and user profiles.
- **FuelOps Service** (`apps/fuelops-service/`) — Core domain service with 52 routes across 7 controllers. Follows a **Controller → Service → Repository** layered pattern for clean separation of concerns.
- **Reporting Service** (`apps/reporting-service/`) — Aggregation and read-optimized endpoints for stock summaries, daily ops, and trip-level reporting.

The legacy monolith can still run in parallel for routes not yet migrated, ensuring zero-downtime transition.

### 2. Dependency Injection via Factory Functions

Every service exports a factory function (e.g., `createFuelOpsRouter({ pool, requireAuth, requireRole })`) rather than importing shared state directly. This makes services independently testable and removes hidden coupling between modules.

### 3. Query Isolation

Database queries use an `isolatedQuery` pattern — each query checks out a dedicated client from the pool, executes, and releases. This prevents connection leaks and avoids holding connections during cache misses or slow computations.

### 4. Snapshot Caching with Redis Upgrade Path

A `packages/cache` abstraction provides TTL-based caching (in-memory Map by default, Redis via `ioredis` when `REDIS_URL` is configured). Stock metrics use a 10-second cache window to avoid redundant heavy CTE queries on every request.

### 5. Background Job Queue

A lightweight job queue (`packages/queue`) abstracts background work. In development, jobs run in-process immediately. In production with Redis, it delegates to BullMQ. Used primarily for asynchronous lot recomputation after transfers.

### 6. Role-Based + Permission-Based Access Control

Three roles (OWNER > ADMIN > EMPLOYEE) with configurable limits. Employee users have granular, tab-level permissions (e.g., `FuelOps.view_readings`, `FuelOps.manage_sales`) that gate both API access and UI visibility.

---

## Technologies Used

| Layer | Technology |
|---|---|
| Frontend | React 19, React Router 7, CSS (responsive) |
| API Gateway | Express.js (Node.js) |
| Microservices | Express Router factories (Node.js) |
| Database | PostgreSQL (Neon-compatible, SSL) |
| Auth | bcrypt, JWT (12h expiry), Bearer tokens |
| Caching | In-memory Map / Redis (ioredis) |
| Job Queue | In-process / BullMQ |
| Security | Helmet, CORS allowlist, HPP, rate-limiting (600 req/min) |
| Monitoring | Morgan request logging, Sentry (frontend) |
| Deployment (planned) | AWS Lightsail |

---

## Development Approach — AI-Assisted Engineering

This project was developed iteratively with an AI assistant as a thinking partner. The AI was used for:

- **Architecture reasoning** — Evaluating tradeoffs between monolith refactor vs. full rewrite; deciding on the gateway pattern
- **Code generation with review** — Generating service scaffolding, then reviewing and adjusting for consistency
- **Schema design iteration** — Working through 31+ database migrations, handling column renames, view creation, and constraint evolution
- **Debugging** — Diagnosing route-mounting order issues, pool exhaustion, and CORS misconfigurations
- **Responsive UI refactoring** — Converting desktop-first layouts to mobile-responsive designs with slide-out drawers and adaptive navigation
- **Documentation** — Producing architecture documents and deployment checklists

The AI did not write the project autonomously. Every suggestion was evaluated, modified where needed, and integrated with an understanding of the overall system design.

---

## Current Status

| Area | Status |
|---|---|
| Core CRUD operations | Complete |
| Auth + permissions system | Complete |
| Gateway + 3 services extracted | Complete |
| Frontend (10 operational tabs) | Complete |
| Real-time stock indicators | Complete |
| Database migrations (31+) | Complete |
| Responsive mobile UI | Complete |
| Deployment to AWS Lightsail | In progress |
| Public GitHub repository | To be published |

---

## Links

- **GitHub Repository:** *(to be published)*
- **Hosted Demo:** Deployment in progress (AWS Lightsail planned)
