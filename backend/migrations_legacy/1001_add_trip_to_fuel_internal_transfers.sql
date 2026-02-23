-- 1001_add_trip_to_fuel_internal_transfers.sql
-- Adds a nullable integer column `trip` to tag each internal transfer with the trip number

ALTER TABLE public.fuel_internal_transfers
  ADD COLUMN IF NOT EXISTS trip integer;

COMMENT ON COLUMN public.fuel_internal_transfers.trip IS 'Trip number for which this internal transfer was recorded (e.g., 1, 2, 3 …).';

-- Optional index to support quick filtering by trip within a day.
CREATE INDEX IF NOT EXISTS idx_fit_from_unit_date_trip
  ON public.fuel_internal_transfers(from_unit_id, transfer_date DESC, trip);
