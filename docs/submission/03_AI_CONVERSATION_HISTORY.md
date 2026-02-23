# FuelOps — AI Conversation History Summary

**Purpose:** Document how an engineer used AI-assisted development to evolve the FuelOps platform from a monolithic backend to a gateway-based microservice architecture.

---

## 1) Moving from Monolith to Gateway

- Started with a single Express monolith that grew large and hard to change safely.
- AI-assisted decision: avoid a full rewrite; use incremental extraction behind a gateway.
- Key requirement: keep API paths stable so the React frontend doesn’t need changes.
- Outcome: gateway becomes the composition root and single entry point.

## 2) Extracting Services with Dependency Injection

- Auth extracted first because it’s the most self-contained domain.
- Services implemented as router factories (e.g., `createAuthRouter({ pool, requireAuth, ... })`).
- AI-assisted reasoning: factory DI avoids global singletons and makes services testable and portable.
- Outcome: auth, reporting, and fuelops services mount cleanly under the gateway.

## 3) Fixing Routing and Mount Order

- Issue: reporting and fuelops share the same base prefix (`/api/fuel-ops`).
- AI-assisted diagnosis: Express router mounting order controls precedence.
- Fix: mount reporting router before fuelops router so specific reporting routes resolve correctly.

## 4) Query Isolation and Snapshot Caching

- Issue: stock summary queries are heavy; UI polling can overload Postgres.
- AI-assisted design:
  - Use `isolatedQuery` to ensure every query checks out/releases a client reliably.
  - Use a short TTL cache for computed stock metrics; add explicit invalidation on writes.
- Outcome: predictable DB pool behavior and reduced read amplification.

## 5) Responsive UI Refactor

- Problem: desktop-first layout didn’t work for field operators on mobile.
- AI-assisted approach:
  - convert fixed sidebar widgets into mobile-friendly drawer patterns
  - tighten tab navigation for narrow viewports
  - simplify forms into single-column layouts at small breakpoints
- Outcome: the operations dashboard remains usable on phones while preserving desktop efficiency.

## 6) Preparing for Deployment

- AI-assisted checklist:
  - fail-fast env validation (`DATABASE_URL`, `JWT_SECRET`, `PORT`)
  - production-safe CORS configuration
  - rate limiting on gateway
  - health endpoints (`/health`, `/healthz`) for liveness/readiness
  - graceful shutdown to close the DB pool
- Deployment target: AWS Lightsail (planned) with Nginx + PM2, optional Redis.

---

**GitHub Repository:** *(to be published)*  
**Hosted Demo:** Deployment in progress (AWS Lightsail planned)
