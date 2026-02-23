-- 043_slim_fuel_ops_audit.sql
-- Drop unused columns from fuel_ops_audit to keep only what the Audit UI displays/filters.

DO $$
BEGIN
  -- Drop legacy/unused columns (safe if already removed)
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='fuel_ops_audit' AND column_name='entity_id') THEN
    EXECUTE 'ALTER TABLE public.fuel_ops_audit DROP COLUMN entity_id';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='fuel_ops_audit' AND column_name='unit_type') THEN
    EXECUTE 'ALTER TABLE public.fuel_ops_audit DROP COLUMN unit_type';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='fuel_ops_audit' AND column_name='driver_id') THEN
    EXECUTE 'ALTER TABLE public.fuel_ops_audit DROP COLUMN driver_id';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='fuel_ops_audit' AND column_name='performed_time') THEN
    EXECUTE 'ALTER TABLE public.fuel_ops_audit DROP COLUMN performed_time';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='fuel_ops_audit' AND column_name='amount_liters') THEN
    EXECUTE 'ALTER TABLE public.fuel_ops_audit DROP COLUMN amount_liters';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='fuel_ops_audit' AND column_name='meter_reading') THEN
    EXECUTE 'ALTER TABLE public.fuel_ops_audit DROP COLUMN meter_reading';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='fuel_ops_audit' AND column_name='request_id') THEN
    EXECUTE 'ALTER TABLE public.fuel_ops_audit DROP COLUMN request_id';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='fuel_ops_audit' AND column_name='ip_addr') THEN
    EXECUTE 'ALTER TABLE public.fuel_ops_audit DROP COLUMN ip_addr';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='fuel_ops_audit' AND column_name='updated_at') THEN
    EXECUTE 'ALTER TABLE public.fuel_ops_audit DROP COLUMN updated_at';
  END IF;
END $$;

-- Index cleanup/replacement
DROP INDEX IF EXISTS idx_fuel_ops_audit_entity;
CREATE INDEX IF NOT EXISTS idx_fuel_ops_audit_entity_type ON public.fuel_ops_audit (entity_type, created_at DESC);
