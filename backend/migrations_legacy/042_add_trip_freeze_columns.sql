-- Add freeze/unfreeze columns to truck_dispenser_trips

ALTER TABLE public.truck_dispenser_trips
  ADD COLUMN IF NOT EXISTS is_frozen BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.truck_dispenser_trips
  ADD COLUMN IF NOT EXISTS frozen_at TIMESTAMP WITHOUT TIME ZONE NULL,
  ADD COLUMN IF NOT EXISTS frozen_by TEXT NULL,
  ADD COLUMN IF NOT EXISTS frozen_by_user_id UUID NULL,
  ADD COLUMN IF NOT EXISTS frozen_reason TEXT NULL,
  ADD COLUMN IF NOT EXISTS unfrozen_at TIMESTAMP WITHOUT TIME ZONE NULL,
  ADD COLUMN IF NOT EXISTS unfrozen_by TEXT NULL,
  ADD COLUMN IF NOT EXISTS unfrozen_by_user_id UUID NULL,
  ADD COLUMN IF NOT EXISTS unfrozen_reason TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_trips_frozen
  ON public.truck_dispenser_trips(truck_id, reading_date, trip_no, is_frozen);
