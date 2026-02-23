-- PostgreSQL schema for Fuel Ops Website (Standalone)
-- Fuel Ops + Profile/User Control (minimal)
-- Safe to re-apply (idempotent)

-- If an older DB still has the legacy one-active-owner index, remove it.
DROP INDEX IF EXISTS public.uniq_active_owner;

-- Try to enable pgcrypto for gen_random_uuid(); ignore if not permitted
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
  EXCEPTION WHEN others THEN
    NULL;
  END;
END $$;

-- =============================
-- Users / Auth
-- =============================
CREATE TABLE IF NOT EXISTS public.users (
  id UUID PRIMARY KEY,
  email TEXT UNIQUE,
  username TEXT NOT NULL UNIQUE,
  full_name TEXT,
  role TEXT NOT NULL CHECK (role IN ('OWNER','ADMIN','EMPLOYEE')),
  password_hash TEXT NOT NULL,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  last_login TIMESTAMP WITHOUT TIME ZONE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  phone TEXT,
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  last_password_change_at TIMESTAMP WITHOUT TIME ZONE,
  joining_date DATE DEFAULT CURRENT_DATE,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
);

DO $$
BEGIN
  -- Enforce/check status values (best-effort; avoid failing on legacy data)
  BEGIN
    ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_status_check;
    ALTER TABLE public.users
      ADD CONSTRAINT users_status_check
      CHECK (status IN ('ACTIVE','INACTIVE','ON_LEAVE','SUSPENDED'));
  EXCEPTION WHEN others THEN NULL;
  END;
  BEGIN
    ALTER TABLE public.users ALTER COLUMN status SET DEFAULT 'ACTIVE';
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

CREATE INDEX IF NOT EXISTS idx_users_role ON public.users(role);
CREATE INDEX IF NOT EXISTS idx_users_active ON public.users(active);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='uniq_users_username_lower'
  ) THEN
    BEGIN
      EXECUTE 'CREATE UNIQUE INDEX uniq_users_username_lower ON public.users ((LOWER(username)))';
    EXCEPTION WHEN others THEN NULL;
    END;
  END IF;
END $$;

-- Password audit
CREATE TABLE IF NOT EXISTS public.users_password_audit (
  id SERIAL PRIMARY KEY,
  target_user_id UUID NOT NULL,
  target_email TEXT,
  target_username TEXT,
  target_full_name TEXT,
  target_role TEXT,
  changed_by_user_id UUID,
  changed_by TEXT,
  changed_by_role TEXT,
  performed_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_upa_performed_at ON public.users_password_audit(performed_at DESC);
CREATE INDEX IF NOT EXISTS idx_upa_target_user_id ON public.users_password_audit(target_user_id);
CREATE INDEX IF NOT EXISTS idx_upa_changed_by_user_id ON public.users_password_audit(changed_by_user_id);

-- User profile details
CREATE TABLE IF NOT EXISTS public.user_profiles (
  user_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  date_of_birth DATE,
  gender TEXT CHECK (gender IN ('MALE','FEMALE','OTHER','PREFER_NOT_TO_SAY')),
  emergency_contact_name TEXT,
  emergency_contact_phone TEXT,
  address TEXT,
  pan TEXT,
  pan_normalized TEXT,
  aadhaar TEXT,
  aadhaar_last4 TEXT,
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_profiles_pan_norm ON public.user_profiles ((COALESCE(pan_normalized, '')));

CREATE OR REPLACE FUNCTION public.touch_user_profiles() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_touch_user_profiles') THEN
    CREATE TRIGGER trg_touch_user_profiles
      BEFORE UPDATE ON public.user_profiles
      FOR EACH ROW EXECUTE FUNCTION public.touch_user_profiles();
  END IF;
END $$;

-- User photos (single current photo per user)
CREATE TABLE IF NOT EXISTS public.user_photos (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  mime_type TEXT NOT NULL,
  file_name TEXT,
  file_size_bytes INTEGER NOT NULL,
  data BYTEA NOT NULL,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_user_photo_size CHECK (file_size_bytes >= 0 AND file_size_bytes <= 5*1024*1024)
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_user_photos_user ON public.user_photos(user_id);
CREATE INDEX IF NOT EXISTS idx_user_photos_created_at ON public.user_photos(created_at DESC);

-- User permissions
CREATE TABLE IF NOT EXISTS public.user_permissions (
  user_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  tabs JSONB NOT NULL DEFAULT '{}'::jsonb,
  actions JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION public.touch_user_permissions() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_touch_user_permissions') THEN
    CREATE TRIGGER trg_touch_user_permissions
      BEFORE UPDATE ON public.user_permissions
      FOR EACH ROW EXECUTE FUNCTION public.touch_user_permissions();
  END IF;
END $$;

-- =============================
-- Fuel Ops
-- =============================
CREATE TABLE IF NOT EXISTS public.storage_units (
  id SERIAL PRIMARY KEY,
  unit_type TEXT NOT NULL CHECK (unit_type IN ('TRUCK','DATUM','DISPENSER')),
  unit_code TEXT NOT NULL UNIQUE,
  capacity_liters INTEGER NOT NULL CHECK (capacity_liters > 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  vehicle_number TEXT NULL,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_storage_units_type ON public.storage_units(unit_type);
CREATE INDEX IF NOT EXISTS idx_storage_units_active ON public.storage_units(active) WHERE active=TRUE;
CREATE UNIQUE INDEX IF NOT EXISTS uq_storage_units_vehicle_number ON public.storage_units(vehicle_number) WHERE vehicle_number IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.drivers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NULL,
  driver_id TEXT NOT NULL UNIQUE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.fuel_lots (
  id BIGSERIAL PRIMARY KEY,
  unit_id INTEGER NOT NULL REFERENCES public.storage_units(id) ON DELETE RESTRICT,
  tanker_code TEXT NOT NULL,
  tanker_capacity INTEGER NOT NULL CHECK (tanker_capacity > 0),
  load_date DATE NOT NULL,
  seq_index INTEGER NOT NULL CHECK (seq_index > 0),
  seq_letters TEXT NOT NULL,
  loaded_liters NUMERIC(14,3) NOT NULL CHECK (loaded_liters > 0),
  lot_code_created TEXT NOT NULL UNIQUE,
  stock_status TEXT NOT NULL DEFAULT 'INSTOCK' CHECK (stock_status IN ('SOLD','INSTOCK')),
  used_liters NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (used_liters >= 0),
  load_type TEXT NOT NULL DEFAULT 'PURCHASE',
  load_time TIMESTAMP WITHOUT TIME ZONE NULL,
  load_time_hhmm TEXT NULL,
  cumulative_testing_liters NUMERIC(14,3) NOT NULL DEFAULT 0,
  created_by TEXT NULL,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT uniq_fuel_lots_per_unit_day_seq UNIQUE (unit_id, load_date, seq_index),
  CONSTRAINT chk_fuel_lots_load_type CHECK (load_type IN ('PURCHASE','EMPTY_TRANSFER'))
);
CREATE INDEX IF NOT EXISTS idx_fuel_lots_date ON public.fuel_lots(load_date DESC);
CREATE INDEX IF NOT EXISTS idx_fuel_lots_unit ON public.fuel_lots(unit_id);
CREATE INDEX IF NOT EXISTS idx_fuel_lots_stock ON public.fuel_lots(stock_status);
CREATE INDEX IF NOT EXISTS idx_fuel_lots_unit_stock_created ON public.fuel_lots(unit_id, stock_status, created_at DESC, id DESC);

-- Lot code helpers
CREATE OR REPLACE FUNCTION public.seq_index_to_letters(idx INTEGER)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  n INTEGER := idx;
  result TEXT := '';
  rem INTEGER;
BEGIN
  IF n IS NULL OR n < 1 THEN
    RETURN '';
  END IF;
  WHILE n > 0 LOOP
    rem := (n - 1) % 26;
    result := chr(65 + rem) || result;
    n := (n - 1) / 26;
  END LOOP;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.gen_lot_code(
  p_unit_code TEXT,
  p_load_date DATE,
  p_seq_index INTEGER,
  p_loaded_liters NUMERIC(14,3)
) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  result TEXT;
  liters_key TEXT;
BEGIN
  IF p_unit_code IS NULL OR p_load_date IS NULL OR p_seq_index IS NULL OR p_loaded_liters IS NULL THEN
    RETURN NULL;
  END IF;
  -- Stable compact string for lot code suffix: 50.000 -> 50, 1.234 -> 1.234
  liters_key := trim(trailing '.' from trim(trailing '0' from (p_loaded_liters::text)));
  result := 'LOT' || to_char(p_load_date, 'DDMONYY') || p_unit_code || public.seq_index_to_letters(p_seq_index)
            || liters_key;
  IF result IS NULL THEN
    RAISE EXCEPTION 'gen_lot_code failed for unit_code=%, load_date=%, seq_index=%, loaded_liters=%',
      p_unit_code, p_load_date, p_seq_index, p_loaded_liters;
  END IF;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.next_seq_index_for_date(p_date DATE)
RETURNS INTEGER LANGUAGE sql AS $$
  SELECT COALESCE(MAX(seq_index), 0) + 1 FROM public.fuel_lots WHERE load_date = p_date;
$$;

CREATE OR REPLACE FUNCTION public.preview_next_lot_code(
  p_unit_id INTEGER,
  p_load_date DATE,
  p_loaded_liters NUMERIC(14,3)
) RETURNS TABLE(lot_code TEXT, seq_index INTEGER) LANGUAGE plpgsql AS $$
DECLARE
  v_unit_code TEXT;
  v_cap INTEGER;
  v_seq INTEGER;
BEGIN
  SELECT unit_code, capacity_liters INTO v_unit_code, v_cap
    FROM public.storage_units WHERE id = p_unit_id;
  IF v_unit_code IS NULL THEN
    RAISE EXCEPTION 'Unknown storage unit id %', p_unit_id USING ERRCODE = '22P02';
  END IF;
  v_seq := public.next_seq_index_for_date(p_load_date);
  RETURN QUERY SELECT public.gen_lot_code(v_unit_code, p_load_date, v_seq, p_loaded_liters), v_seq;
END $$;

CREATE OR REPLACE FUNCTION public.create_fuel_lot(
  p_unit_id INTEGER,
  p_load_date DATE,
  p_loaded_liters NUMERIC(14,3)
) RETURNS public.fuel_lots LANGUAGE plpgsql AS $$
DECLARE
  v_unit public.storage_units%ROWTYPE;
  v_seq INTEGER;
  v_letters TEXT;
  v_initial_code TEXT;
  v_row public.fuel_lots%ROWTYPE;
  v_key BIGINT;
BEGIN
  SELECT * INTO v_unit FROM public.storage_units WHERE id = p_unit_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown storage unit id %', p_unit_id USING ERRCODE = '22P02';
  END IF;
  IF p_loaded_liters <= 0 OR p_loaded_liters > v_unit.capacity_liters THEN
    RAISE EXCEPTION 'Loaded liters % must be >0 and <= capacity %', p_loaded_liters, v_unit.capacity_liters USING ERRCODE = '22000';
  END IF;
  v_key := CAST(to_char(p_load_date, 'YYYYMMDD') AS BIGINT);
  PERFORM pg_advisory_xact_lock(v_key);
  v_seq := COALESCE((SELECT MAX(seq_index) FROM public.fuel_lots WHERE load_date = p_load_date), 0) + 1;
  v_letters := public.seq_index_to_letters(v_seq);
  v_initial_code := public.gen_lot_code(v_unit.unit_code, p_load_date, v_seq, p_loaded_liters);

  INSERT INTO public.fuel_lots (
    unit_id, tanker_code, tanker_capacity, load_date, seq_index, seq_letters,
    loaded_liters, lot_code_created, stock_status, used_liters, load_type
  ) VALUES (
    v_unit.id, v_unit.unit_code, v_unit.capacity_liters, p_load_date, v_seq, v_letters,
    p_loaded_liters, v_initial_code, 'INSTOCK', 0, 'PURCHASE'
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END $$;

-- Daily dispenser logs (authoritative opening/closing readings)
CREATE TABLE IF NOT EXISTS public.dispenser_day_reading_logs (
  id BIGSERIAL PRIMARY KEY,
  truck_id INTEGER NOT NULL REFERENCES public.storage_units(id) ON DELETE CASCADE,
  truck_code TEXT NULL,
  reading_date DATE NOT NULL,
  opening_liters NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (opening_liters >= 0),
  opening_at TIMESTAMP WITHOUT TIME ZONE NULL,
  closing_liters NUMERIC(14,3) NULL,
  closing_at TIMESTAMP WITHOUT TIME ZONE NULL,
  note TEXT,
  driver_name TEXT,
  driver_code TEXT,
  created_by TEXT,
  created_by_user_id UUID,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_dispenser_day_unique UNIQUE (truck_id, reading_date)
);
CREATE INDEX IF NOT EXISTS idx_dispenser_day_truck_date ON public.dispenser_day_reading_logs(truck_id, reading_date);
CREATE INDEX IF NOT EXISTS idx_dispenser_day_truck_code ON public.dispenser_day_reading_logs(truck_code);

-- Trips per truck per day
CREATE TABLE IF NOT EXISTS public.truck_dispenser_trips (
  id BIGSERIAL PRIMARY KEY,
  truck_id INTEGER NOT NULL REFERENCES public.storage_units(id) ON DELETE CASCADE,
  reading_date DATE NOT NULL,
  trip_no INTEGER NOT NULL CHECK (trip_no > 0),
  opening_liters NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (opening_liters >= 0),
  closing_liters NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (closing_liters >= 0),
  opening_at TIMESTAMP WITHOUT TIME ZONE NULL,
  closing_at TIMESTAMP WITHOUT TIME ZONE NULL,
  note TEXT,
  driver_name TEXT,
  driver_code TEXT,
  created_by TEXT,
  created_by_user_id UUID,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_trips_per_day UNIQUE (truck_id, reading_date, trip_no)
);
CREATE INDEX IF NOT EXISTS idx_trips_truck_date ON public.truck_dispenser_trips(truck_id, reading_date, trip_no);

-- Meter snapshots
CREATE TABLE IF NOT EXISTS public.truck_dispenser_meter_snapshots (
  id BIGSERIAL PRIMARY KEY,
  truck_id INTEGER NOT NULL REFERENCES public.storage_units(id) ON DELETE RESTRICT,
  reading_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  reading_liters NUMERIC(14,3) NOT NULL CHECK (reading_liters >= 0),
  source TEXT NOT NULL DEFAULT 'SNAPSHOT',
  note TEXT NULL,
  created_by TEXT NULL,
  created_by_user_id UUID NULL,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tdm_snapshots_truck_ts ON public.truck_dispenser_meter_snapshots(truck_id, reading_at DESC);

-- Odometer per-day readings
CREATE TABLE IF NOT EXISTS public.truck_odometer_day_readings (
  id BIGSERIAL PRIMARY KEY,
  truck_id INTEGER NOT NULL REFERENCES public.storage_units(id) ON DELETE RESTRICT,
  reading_date DATE NOT NULL,
  opening_km NUMERIC(14,3) NOT NULL CHECK (opening_km >= 0),
  closing_km NUMERIC(14,3) NOT NULL CHECK (closing_km >= opening_km),
  opening_at TIMESTAMP WITHOUT TIME ZONE NULL,
  closing_at TIMESTAMP WITHOUT TIME ZONE NULL,
  note TEXT,
  driver_name TEXT,
  driver_code TEXT,
  created_by TEXT,
  created_by_user_id UUID,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT uniq_truck_odometer_day UNIQUE (truck_id, reading_date)
);
CREATE INDEX IF NOT EXISTS idx_truck_odometer_day_truck_date ON public.truck_odometer_day_readings(truck_id, reading_date DESC);

-- Transfer tables
CREATE TABLE IF NOT EXISTS public.fuel_internal_transfers (
  id BIGSERIAL PRIMARY KEY,
  from_lot_id BIGINT NOT NULL REFERENCES public.fuel_lots(id) ON DELETE CASCADE,
  to_lot_id   BIGINT NOT NULL REFERENCES public.fuel_lots(id) ON DELETE CASCADE,
  activity TEXT NOT NULL,
  from_unit_id INTEGER NOT NULL REFERENCES public.storage_units(id) ON DELETE RESTRICT,
  to_unit_id   INTEGER NOT NULL REFERENCES public.storage_units(id) ON DELETE RESTRICT,
  from_unit_code TEXT NOT NULL,
  to_unit_code   TEXT NOT NULL,
  transfer_volume NUMERIC(14,3) NOT NULL CHECK (transfer_volume > 0),
  from_tanker_change NUMERIC(14,3) NOT NULL,
  to_tanker_change   NUMERIC(14,3) NOT NULL,
  from_lot_code_change TEXT NOT NULL,
  to_lot_code_change   TEXT NOT NULL,
  transfer_to_empty BOOLEAN NOT NULL DEFAULT FALSE,
  driver_name TEXT NULL,
  performed_by TEXT NULL,
  dispenser_reading_transfer_adjust NUMERIC(14,3) NOT NULL DEFAULT 0,
  transfer_date DATE NOT NULL DEFAULT CURRENT_DATE,
  transfer_time TIME WITHOUT TIME ZONE NOT NULL DEFAULT TIME '00:00',
  trip INTEGER NULL,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fit_from_lot ON public.fuel_internal_transfers(from_lot_id);
CREATE INDEX IF NOT EXISTS idx_fit_to_lot   ON public.fuel_internal_transfers(to_lot_id);
CREATE INDEX IF NOT EXISTS idx_fit_transfer_date ON public.fuel_internal_transfers(transfer_date DESC);
CREATE INDEX IF NOT EXISTS idx_fit_when ON public.fuel_internal_transfers(transfer_date DESC, transfer_time DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_fit_from_unit_adjust ON public.fuel_internal_transfers(from_unit_id, dispenser_reading_transfer_adjust);
CREATE INDEX IF NOT EXISTS idx_fit_from_unit_date_trip ON public.fuel_internal_transfers(from_unit_id, transfer_date DESC, trip);
CREATE INDEX IF NOT EXISTS idx_fit_to_unit_date_trip ON public.fuel_internal_transfers(to_unit_id, transfer_date DESC, trip);
-- Performance indexes for lot metrics queries (activity filtering)
CREATE INDEX IF NOT EXISTS idx_fit_to_lot_activity ON public.fuel_internal_transfers(to_lot_id, activity);
CREATE INDEX IF NOT EXISTS idx_fit_from_lot_activity ON public.fuel_internal_transfers(from_lot_id, activity);

CREATE TABLE IF NOT EXISTS public.fuel_sale_transfers (
  id BIGSERIAL PRIMARY KEY,
  lot_id BIGINT NOT NULL REFERENCES public.fuel_lots(id) ON DELETE CASCADE,
  from_unit_id INTEGER NOT NULL REFERENCES public.storage_units(id) ON DELETE RESTRICT,
  from_unit_code TEXT NOT NULL,
  to_vehicle TEXT NOT NULL,
  sale_volume_liters NUMERIC(14,3) NOT NULL CHECK (sale_volume_liters > 0),
  lot_code_after TEXT NOT NULL,
  driver_id INTEGER NULL REFERENCES public.drivers(id) ON DELETE SET NULL,
  driver_name TEXT NULL,
  performed_by TEXT NULL,
  activity TEXT NOT NULL,
  performed_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  sale_date DATE NULL,
  trip INTEGER NULL,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fst_lot ON public.fuel_sale_transfers(lot_id);
-- Requested explicit index name for lot_id lookups (may be redundant with idx_fst_lot)
CREATE INDEX IF NOT EXISTS idx_fst_lot_id ON public.fuel_sale_transfers(lot_id);
CREATE INDEX IF NOT EXISTS idx_fst_time ON public.fuel_sale_transfers(performed_at DESC);
CREATE INDEX IF NOT EXISTS idx_fst_sale_date ON public.fuel_sale_transfers(sale_date DESC);
CREATE INDEX IF NOT EXISTS idx_fst_from_unit_time ON public.fuel_sale_transfers(from_unit_id, performed_at DESC);
CREATE INDEX IF NOT EXISTS idx_fst_from_unit_sale_date ON public.fuel_sale_transfers(from_unit_id, sale_date DESC);

CREATE TABLE IF NOT EXISTS public.testing_self_transfers (
  id BIGSERIAL PRIMARY KEY,
  lot_id INTEGER REFERENCES public.fuel_lots(id) ON DELETE SET NULL,
  activity TEXT NOT NULL DEFAULT 'TESTING',
  from_unit_id INTEGER REFERENCES public.storage_units(id) ON DELETE SET NULL,
  from_unit_code TEXT,
  to_vehicle TEXT,
  transfer_volume_liters NUMERIC(14,3) NOT NULL,
  lot_code TEXT,
  driver_id INTEGER,
  driver_name TEXT,
  performed_by TEXT,
  performed_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  updated_by TEXT,
  sale_date DATE,
  trip INTEGER,
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_testing_self_from_unit ON public.testing_self_transfers(from_unit_id);
CREATE INDEX IF NOT EXISTS idx_testing_self_performed_at ON public.testing_self_transfers(performed_at);
CREATE INDEX IF NOT EXISTS idx_testing_self_from_unit_performed_at ON public.testing_self_transfers(from_unit_id, performed_at DESC);

