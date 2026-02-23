-- Cleanup: Drop the old lot_code_initial column (already migrated to lot_code_created in migration 030)
BEGIN;

-- Drop the old lot_code_initial column that's no longer used
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='fuel_lots' AND column_name='lot_code_initial'
  ) THEN
    EXECUTE 'ALTER TABLE public.fuel_lots DROP COLUMN lot_code_initial';
    RAISE NOTICE 'Dropped lot_code_initial column';
  ELSE
    RAISE NOTICE 'Column lot_code_initial does not exist, skipping';
  END IF;
END $$;

-- Drop old unique index if it exists
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='uq_fuel_lots_initial_code'
  ) THEN
    EXECUTE 'DROP INDEX IF EXISTS public.uq_fuel_lots_initial_code';
    RAISE NOTICE 'Dropped uq_fuel_lots_initial_code index';
  END IF;
END $$;

-- Ensure the new unique index exists on lot_code_created
CREATE UNIQUE INDEX IF NOT EXISTS uq_fuel_lots_created_code ON public.fuel_lots(lot_code_created);

COMMIT;
