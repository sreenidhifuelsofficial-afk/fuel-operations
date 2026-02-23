-- Create audit table for Fuel Ops (At Depot, Day Logs)
-- Captures create/update/delete across sections with useful denormalized columns

-- Ensure UUID support
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.fuel_ops_audit (
  id               BIGSERIAL PRIMARY KEY,
  created_at       TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT now(),
  user_id          UUID,
  username         TEXT,
  tab              TEXT NOT NULL,
  section          TEXT NOT NULL,
  action           TEXT NOT NULL,
  entity_type      TEXT NOT NULL,
  unit_id          INTEGER,
  trip_id          BIGINT,
  trip_no          INTEGER,
  op_date          DATE,
  payload_old      JSONB,
  payload_new      JSONB,
  reason           TEXT
);

-- Best-effort upgrades for existing DBs
ALTER TABLE public.fuel_ops_audit ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITHOUT TIME ZONE;
ALTER TABLE public.fuel_ops_audit ALTER COLUMN created_at SET DEFAULT now();
UPDATE public.fuel_ops_audit SET created_at = now() WHERE created_at IS NULL;
ALTER TABLE public.fuel_ops_audit ALTER COLUMN created_at SET NOT NULL;

ALTER TABLE public.fuel_ops_audit ADD COLUMN IF NOT EXISTS trip_id BIGINT;
ALTER TABLE public.fuel_ops_audit ADD COLUMN IF NOT EXISTS trip_no INTEGER;

-- Useful indexes
CREATE INDEX IF NOT EXISTS idx_fuel_ops_audit_created_at        ON public.fuel_ops_audit (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fuel_ops_audit_tab_section       ON public.fuel_ops_audit (tab, section, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fuel_ops_audit_unit_date         ON public.fuel_ops_audit (unit_id, op_date, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fuel_ops_audit_entity_type       ON public.fuel_ops_audit (entity_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fuel_ops_audit_user              ON public.fuel_ops_audit (user_id, created_at DESC);

-- Optional: GIN index for JSON if heavy querying on payloads is expected
-- CREATE INDEX IF NOT EXISTS idx_fuel_ops_audit_payload_old_gin ON fuel_ops_audit USING GIN (payload_old);
-- CREATE INDEX IF NOT EXISTS idx_fuel_ops_audit_payload_new_gin ON fuel_ops_audit USING GIN (payload_new);
