// Load environment variables from server/.env regardless of process CWD
try {
  const path = require('path');
  require('dotenv').config({ path: path.join(__dirname, '.env') });
} catch {}
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const hpp = require('hpp');
const app = express();
const { randomUUID } = require('crypto');
app.set('trust proxy', 1);
// Security and performance middlewares
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(hpp());
app.use(compression());

// CORS configuration with allowlist
// In production, restrict to FRONTEND_URL. In development, allow all origins.
const corsOptions = (() => {
  const frontendUrl = process.env.FRONTEND_URL;
  if (process.env.NODE_ENV === 'production' && frontendUrl) {
    // Parse comma-separated list of allowed origins (supports multiple frontends if needed)
    const allowedOrigins = frontendUrl.split(',').map(u => u.trim()).filter(Boolean);
    return {
      origin: (origin, callback) => {
        // Allow requests with no origin (server-to-server, Postman, etc.) or from allowlist
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error('Not allowed by CORS'));
        }
      },
      credentials: true,
    };
  }
  // Development: allow all origins
  return {};
})();
app.use(cors(corsOptions));

app.use(morgan('combined'));
// Basic rate limiting for all routes; sensitive routes can override if needed
const limiter = rateLimit({ windowMs: 60 * 1000, max: 600, standardHeaders: true, legacyHeaders: false });
app.use(limiter);
// Request timeout safeguard (per request)
app.use((req, res, next) => {
  // 25s soft timeout
  req.setTimeout(25_000, () => {});
  res.setTimeout(25_000, () => {});
  next();
});
// Increase JSON body limit to allow base64 images up to 5MB (base64 ~33% overhead)
app.use(express.json({ limit: '7mb' }));
app.use(express.urlencoded({ extended: true, limit: '7mb' }));

// UTF-8 response normalization — fixes mojibake (Â, â€™, etc.) at API layer
const { utf8ResponseMiddleware } = require('../packages/middleware/normalizeUtf8');
app.use(utf8ResponseMiddleware);

const { hashPassword, verifyPassword, signToken, requireAuth, requireRole, ownerExists } = require('./auth');
const { getUnitInstockMetrics, invalidateInstockMetricsCache, clearInstockMetricsCache } = require('./fuelOps/lotMetricsRepo');

// Ensure combined view for admin/owner employee profiles exists (idempotent)
async function ensureUserFullProfilesView(db) {
  try {
    await db.query(`
      CREATE OR REPLACE VIEW public.user_full_profiles AS
      SELECT 
        u.id AS user_id,
        u.full_name,
        u.username,
        u.email,
        u.phone,
        u.role,
        u.joining_date,
        u.status,
        p.date_of_birth,
        p.gender,
        p.emergency_contact_name,
        p.emergency_contact_phone,
        p.address,
        p.pan,
        p.pan_normalized,
        p.aadhaar,
        p.aadhaar_last4,
        p.updated_at
      FROM public.users u
      LEFT JOIN public.user_profiles p ON p.user_id = u.id;
    `);
  } catch (e) {
    // Do not crash server; endpoint callers can retry
    if (!process.env.SUPPRESS_DB_LOG) console.warn('[ensureUserFullProfilesView] warning:', e.message);
  }
}

// Self-healing minimal schema to guarantee new columns/tables exist in current DB
// PRODUCTION GUARD: Skip runtime schema changes in production for safety.
async function ensureMinimalSchema(db) {
  // In production mode, skip runtime schema modifications entirely.
  // Use explicit migrations via migrate.js for production deployments.
  if (process.env.NODE_ENV === 'production') {
    if (!process.env.SUPPRESS_DB_LOG) {
      console.log('[ensureMinimalSchema] Skipped in production mode -- use migrate.js for schema changes.');
    }
    return;
  }
  try {
    // Attempt pgcrypto enable; ignore if provider blocks extensions
    try { await db.query("CREATE EXTENSION IF NOT EXISTS pgcrypto"); }
    catch (e) { if (!process.env.SUPPRESS_DB_LOG) console.warn('[ensureMinimalSchema] pgcrypto warn:', e.message); }

    const safe = async (label, fn) => {
      try { await fn(); }
      catch (e) {
        if (!process.env.SUPPRESS_DB_LOG) console.warn(`[ensureMinimalSchema] ${label} warn:`, e.message);
      }
    };

    // -----------------------
    // Users / Profile / Permissions
    // -----------------------
    await safe('users table', async () => {
      await db.query(`
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
        )
      `);
      await db.query("CREATE INDEX IF NOT EXISTS idx_users_role ON public.users(role)");
      await db.query("CREATE INDEX IF NOT EXISTS idx_users_active ON public.users(active)");
      // Idempotent upgrades for existing DBs
      await db.query("ALTER TABLE public.users ADD COLUMN IF NOT EXISTS joining_date DATE DEFAULT CURRENT_DATE");
      await db.query("ALTER TABLE public.users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ACTIVE'");
      await db.query("ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_status_check");
      await db.query("ALTER TABLE public.users ADD CONSTRAINT users_status_check CHECK (status IN ('ACTIVE','INACTIVE','ON_LEAVE','SUSPENDED'))");
      // Best-effort NOT NULL for username (only when safe)
      try {
        const nn = await db.query("SELECT COUNT(*)::int AS c FROM public.users WHERE username IS NULL");
        if (nn.rows && nn.rows[0] && nn.rows[0].c === 0) {
          await db.query('ALTER TABLE public.users ALTER COLUMN username SET NOT NULL');
        }
      } catch {}
      // Case-insensitive unique index for username (best-effort)
      await db.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='uniq_users_username_lower') THEN BEGIN EXECUTE 'CREATE UNIQUE INDEX uniq_users_username_lower ON public.users ((LOWER(username))) WHERE username IS NOT NULL'; EXCEPTION WHEN others THEN NULL; END; END IF; END $$;");
    });

    await safe('users_password_audit', async () => {
      await db.query(`
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
        )
      `);
      await db.query('CREATE INDEX IF NOT EXISTS idx_upa_performed_at ON public.users_password_audit(performed_at DESC)');
      await db.query('CREATE INDEX IF NOT EXISTS idx_upa_target_user_id ON public.users_password_audit(target_user_id)');
      await db.query('CREATE INDEX IF NOT EXISTS idx_upa_changed_by_user_id ON public.users_password_audit(changed_by_user_id)');
    });

    await safe('user_profiles', async () => {
      await db.query(`
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
        )
      `);
      await db.query("CREATE INDEX IF NOT EXISTS idx_user_profiles_pan_norm ON public.user_profiles ((COALESCE(pan_normalized, ''))) ");
      await db.query(`
        CREATE OR REPLACE FUNCTION public.touch_user_profiles() RETURNS trigger AS $$
        BEGIN
          NEW.updated_at = NOW();
          RETURN NEW;
        END; $$ LANGUAGE plpgsql;
      `);
      await db.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_touch_user_profiles') THEN CREATE TRIGGER trg_touch_user_profiles BEFORE UPDATE ON public.user_profiles FOR EACH ROW EXECUTE FUNCTION public.touch_user_profiles(); END IF; END $$;");
    });

    await safe('user_photos', async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS public.user_photos (
          id BIGSERIAL PRIMARY KEY,
          user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
          mime_type TEXT NOT NULL,
          file_name TEXT,
          file_size_bytes INTEGER NOT NULL,
          data BYTEA NOT NULL,
          created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
          CONSTRAINT chk_user_photo_size CHECK (file_size_bytes >= 0 AND file_size_bytes <= 5*1024*1024)
        )
      `);
      await db.query('CREATE UNIQUE INDEX IF NOT EXISTS uniq_user_photos_user ON public.user_photos(user_id)');
      await db.query('CREATE INDEX IF NOT EXISTS idx_user_photos_created_at ON public.user_photos(created_at DESC)');
    });

    await safe('user_permissions', async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS public.user_permissions (
          user_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
          tabs JSONB NOT NULL DEFAULT '{}'::jsonb,
          actions JSONB NOT NULL DEFAULT '{}'::jsonb,
          updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
        )
      `);
      await db.query(`
        CREATE OR REPLACE FUNCTION public.touch_user_permissions() RETURNS trigger AS $$
        BEGIN
          NEW.updated_at = NOW();
          RETURN NEW;
        END; $$ LANGUAGE plpgsql;
      `);
      await db.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_touch_user_permissions') THEN CREATE TRIGGER trg_touch_user_permissions BEFORE UPDATE ON public.user_permissions FOR EACH ROW EXECUTE FUNCTION public.touch_user_permissions(); END IF; END $$;");
    });

    // -----------------------
    // Fuel Ops core tables
    // -----------------------
    await safe('storage_units', async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS public.storage_units (
          id SERIAL PRIMARY KEY,
          unit_type TEXT NOT NULL CHECK (unit_type IN ('TRUCK','DATUM','DISPENSER')),
          unit_code TEXT NOT NULL UNIQUE,
          capacity_liters INTEGER NOT NULL CHECK (capacity_liters > 0),
          active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
        )
      `);
      await db.query("CREATE INDEX IF NOT EXISTS idx_storage_units_type ON public.storage_units(unit_type)");
      await db.query("CREATE INDEX IF NOT EXISTS idx_storage_units_active ON public.storage_units(active) WHERE active = TRUE");
      await db.query('ALTER TABLE public.storage_units ADD COLUMN IF NOT EXISTS vehicle_number TEXT NULL');
      await db.query('CREATE UNIQUE INDEX IF NOT EXISTS uq_storage_units_vehicle_number ON public.storage_units(vehicle_number) WHERE vehicle_number IS NOT NULL');
    });

    await safe('drivers', async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS public.drivers (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          phone TEXT NULL,
          driver_id TEXT NOT NULL UNIQUE,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
        )
      `);
    });

    await safe('fuel_lots + helpers', async () => {
      await db.query(`
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
        )
      `);
      await db.query('CREATE INDEX IF NOT EXISTS idx_fuel_lots_date ON public.fuel_lots(load_date DESC)');
      await db.query('CREATE INDEX IF NOT EXISTS idx_fuel_lots_unit ON public.fuel_lots(unit_id)');
      await db.query('CREATE INDEX IF NOT EXISTS idx_fuel_lots_stock ON public.fuel_lots(stock_status)');
      await db.query("UPDATE public.fuel_lots SET load_type = 'PURCHASE' WHERE load_type IS NULL");
      await db.query("ALTER TABLE public.fuel_lots ALTER COLUMN load_type SET DEFAULT 'PURCHASE'");
      await db.query("ALTER TABLE public.fuel_lots ALTER COLUMN load_type SET NOT NULL");
      await db.query("ALTER TABLE public.fuel_lots DROP CONSTRAINT IF EXISTS chk_fuel_lots_load_type");
      await db.query("ALTER TABLE public.fuel_lots ADD CONSTRAINT chk_fuel_lots_load_type CHECK (load_type IN ('PURCHASE','EMPTY_TRANSFER'))");

      await db.query(`
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
      `);

      await db.query(`
        CREATE OR REPLACE FUNCTION public.gen_lot_code(
          p_unit_code TEXT,
          p_load_date DATE,
          p_seq_index INTEGER,
          p_loaded_liters NUMERIC(14,3)
        ) RETURNS TEXT LANGUAGE plpgsql AS $$
        DECLARE
          result TEXT;
        BEGIN
          IF p_unit_code IS NULL OR p_load_date IS NULL OR p_seq_index IS NULL OR p_loaded_liters IS NULL THEN
            RETURN NULL;
          END IF;
          result := 'LOT' || to_char(p_load_date, 'DDMONYY') || p_unit_code || public.seq_index_to_letters(p_seq_index)
                    || CAST(p_loaded_liters AS TEXT);
          IF result IS NULL THEN
            RAISE EXCEPTION 'gen_lot_code failed for unit_code=%, load_date=%, seq_index=%, loaded_liters=%',
              p_unit_code, p_load_date, p_seq_index, p_loaded_liters;
          END IF;
          RETURN result;
        END $$;
      `);

      await db.query(`
        CREATE OR REPLACE FUNCTION public.next_seq_index_for_date(p_date DATE)
        RETURNS INTEGER LANGUAGE sql AS $$
          SELECT COALESCE(MAX(seq_index), 0) + 1 FROM public.fuel_lots WHERE load_date = p_date;
        $$;
      `);

      await db.query(`
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
      `);

      await db.query(`
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
      `);
    });

    // Trips per truck per day (to support multiple depot trips in a day)
    await safe('truck_dispenser_trips', async () => {
      await db.query(`
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
        )
      `);
      await db.query('CREATE INDEX IF NOT EXISTS idx_trips_truck_date ON public.truck_dispenser_trips(truck_id, reading_date, trip_no)');

      // Freeze/unfreeze support (for locked edits after trip close)
      await db.query('ALTER TABLE public.truck_dispenser_trips ADD COLUMN IF NOT EXISTS is_frozen BOOLEAN NOT NULL DEFAULT FALSE');
      await db.query('ALTER TABLE public.truck_dispenser_trips ADD COLUMN IF NOT EXISTS frozen_at TIMESTAMP WITHOUT TIME ZONE NULL');
      await db.query('ALTER TABLE public.truck_dispenser_trips ADD COLUMN IF NOT EXISTS frozen_by TEXT NULL');
      await db.query('ALTER TABLE public.truck_dispenser_trips ADD COLUMN IF NOT EXISTS frozen_by_user_id UUID NULL');
      await db.query('ALTER TABLE public.truck_dispenser_trips ADD COLUMN IF NOT EXISTS frozen_reason TEXT NULL');
      await db.query('ALTER TABLE public.truck_dispenser_trips ADD COLUMN IF NOT EXISTS unfrozen_at TIMESTAMP WITHOUT TIME ZONE NULL');
      await db.query('ALTER TABLE public.truck_dispenser_trips ADD COLUMN IF NOT EXISTS unfrozen_by TEXT NULL');
      await db.query('ALTER TABLE public.truck_dispenser_trips ADD COLUMN IF NOT EXISTS unfrozen_by_user_id UUID NULL');
      await db.query('ALTER TABLE public.truck_dispenser_trips ADD COLUMN IF NOT EXISTS unfrozen_reason TEXT NULL');
      await db.query('CREATE INDEX IF NOT EXISTS idx_trips_frozen ON public.truck_dispenser_trips(truck_id, reading_date, trip_no, is_frozen)');
    });

    // Fuel Ops audit (idempotent) -- supports an Audit tab in the UI
    await safe('fuel_ops_audit', async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS public.fuel_ops_audit (
          id               BIGSERIAL PRIMARY KEY,
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
          reason           TEXT,
          created_at       TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
        )
      `);

      // Best-effort upgrades for existing DBs
      await db.query('ALTER TABLE public.fuel_ops_audit ADD COLUMN IF NOT EXISTS trip_id BIGINT');
      await db.query('ALTER TABLE public.fuel_ops_audit ADD COLUMN IF NOT EXISTS trip_no INTEGER');

      await db.query('CREATE INDEX IF NOT EXISTS idx_fuel_ops_audit_created_at ON public.fuel_ops_audit (created_at DESC)');
      await db.query('CREATE INDEX IF NOT EXISTS idx_fuel_ops_audit_tab_section ON public.fuel_ops_audit (tab, section, created_at DESC)');
      await db.query('CREATE INDEX IF NOT EXISTS idx_fuel_ops_audit_unit_date ON public.fuel_ops_audit (unit_id, op_date, created_at DESC)');
      await db.query('CREATE INDEX IF NOT EXISTS idx_fuel_ops_audit_entity_type ON public.fuel_ops_audit (entity_type, created_at DESC)');
      await db.query('CREATE INDEX IF NOT EXISTS idx_fuel_ops_audit_user ON public.fuel_ops_audit (user_id, created_at DESC)');
    });

    // Create new dispenser day reading logs table (lightweight audit of opening/closing readings)
    await safe('dispenser_day_reading_logs', async () => {
      await db.query(`
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
        )
      `);
      await db.query('CREATE INDEX IF NOT EXISTS idx_dispenser_day_truck_date ON public.dispenser_day_reading_logs(truck_id, reading_date)');
      await db.query('ALTER TABLE public.dispenser_day_reading_logs ADD COLUMN IF NOT EXISTS truck_code TEXT NULL');
      await db.query('CREATE INDEX IF NOT EXISTS idx_dispenser_day_truck_code ON public.dispenser_day_reading_logs(truck_code)');
      await db.query('UPDATE public.dispenser_day_reading_logs SET truck_code = (SELECT unit_code FROM public.storage_units su WHERE su.id = public.dispenser_day_reading_logs.truck_id) WHERE truck_code IS NULL');
    });

    await safe('truck_odometer_day_readings', async () => {
      await db.query(`
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
        )
      `);
      await db.query('CREATE INDEX IF NOT EXISTS idx_truck_odometer_day_truck_date ON public.truck_odometer_day_readings(truck_id, reading_date DESC)');
    });

    await safe('truck_dispenser_meter_snapshots', async () => {
      await db.query(`
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
        )
      `);
      await db.query('CREATE INDEX IF NOT EXISTS idx_tdm_snapshots_truck_ts ON public.truck_dispenser_meter_snapshots(truck_id, reading_at DESC)');
    });

    await safe('fuel_internal_transfers', async () => {
      await db.query(`
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
        )
      `);
      await db.query('CREATE INDEX IF NOT EXISTS idx_fit_from_lot ON public.fuel_internal_transfers(from_lot_id)');
      await db.query('CREATE INDEX IF NOT EXISTS idx_fit_to_lot ON public.fuel_internal_transfers(to_lot_id)');
      await db.query('CREATE INDEX IF NOT EXISTS idx_fit_when ON public.fuel_internal_transfers(transfer_date DESC, transfer_time DESC, id DESC)');
      await db.query('CREATE INDEX IF NOT EXISTS idx_fit_transfer_date ON public.fuel_internal_transfers(transfer_date DESC)');
      // Best-effort upgrades
      await db.query('ALTER TABLE public.fuel_internal_transfers ADD COLUMN IF NOT EXISTS trip integer');
      await db.query('CREATE INDEX IF NOT EXISTS idx_fit_from_unit_date_trip ON public.fuel_internal_transfers(from_unit_id, transfer_date DESC, trip)');
    });

    await safe('fuel_sale_transfers', async () => {
      await db.query(`
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
        )
      `);
      await db.query('CREATE INDEX IF NOT EXISTS idx_fst_lot ON public.fuel_sale_transfers(lot_id)');
      await db.query('CREATE INDEX IF NOT EXISTS idx_fst_time ON public.fuel_sale_transfers(performed_at DESC)');
      await db.query('CREATE INDEX IF NOT EXISTS idx_fst_sale_date ON public.fuel_sale_transfers(sale_date DESC)');
    });

    await safe('testing_self_transfers', async () => {
      await db.query(`
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
        )
      `);
      await db.query('CREATE INDEX IF NOT EXISTS idx_testing_self_from_unit ON public.testing_self_transfers(from_unit_id)');
      await db.query('CREATE INDEX IF NOT EXISTS idx_testing_self_performed_at ON public.testing_self_transfers(performed_at)');
    });

    // Best-effort upgrades for existing DBs: store all volumes as NUMERIC(14,3)
    await safe('volume column type upgrades', async () => {
      // fuel_lots
      await db.query(`ALTER TABLE public.fuel_lots ALTER COLUMN loaded_liters TYPE NUMERIC(14,3) USING loaded_liters::numeric`);
      await db.query(`ALTER TABLE public.fuel_lots ALTER COLUMN used_liters TYPE NUMERIC(14,3) USING used_liters::numeric`);
      await db.query(`ALTER TABLE public.fuel_lots ALTER COLUMN cumulative_testing_liters TYPE NUMERIC(14,3) USING cumulative_testing_liters::numeric`);

      // dispenser/trips
      await db.query(`ALTER TABLE public.dispenser_day_reading_logs ALTER COLUMN opening_liters TYPE NUMERIC(14,3) USING opening_liters::numeric`);
      await db.query(`ALTER TABLE public.dispenser_day_reading_logs ALTER COLUMN closing_liters TYPE NUMERIC(14,3) USING closing_liters::numeric`);
      await db.query(`ALTER TABLE public.truck_dispenser_trips ALTER COLUMN opening_liters TYPE NUMERIC(14,3) USING opening_liters::numeric`);
      await db.query(`ALTER TABLE public.truck_dispenser_trips ALTER COLUMN closing_liters TYPE NUMERIC(14,3) USING closing_liters::numeric`);

      // transfers/sales/testing
      await db.query(`ALTER TABLE public.fuel_internal_transfers ALTER COLUMN transfer_volume TYPE NUMERIC(14,3) USING transfer_volume::numeric`);
      await db.query(`ALTER TABLE public.fuel_internal_transfers ALTER COLUMN from_tanker_change TYPE NUMERIC(14,3) USING from_tanker_change::numeric`);
      await db.query(`ALTER TABLE public.fuel_internal_transfers ALTER COLUMN to_tanker_change TYPE NUMERIC(14,3) USING to_tanker_change::numeric`);
      await db.query(`ALTER TABLE public.fuel_internal_transfers ALTER COLUMN dispenser_reading_transfer_adjust TYPE NUMERIC(14,3) USING dispenser_reading_transfer_adjust::numeric`);
      await db.query(`ALTER TABLE public.fuel_sale_transfers ALTER COLUMN sale_volume_liters TYPE NUMERIC(14,3) USING sale_volume_liters::numeric`);
      await db.query(`ALTER TABLE public.testing_self_transfers ALTER COLUMN transfer_volume_liters TYPE NUMERIC(14,3) USING transfer_volume_liters::numeric`);

      // snapshots
      await db.query(`ALTER TABLE public.truck_dispenser_meter_snapshots ALTER COLUMN reading_liters TYPE NUMERIC(14,3) USING reading_liters::numeric`);
      await db.query(`ALTER TABLE public.truck_dispenser_meter_snapshots ALTER COLUMN reading_at TYPE TIMESTAMP WITHOUT TIME ZONE USING reading_at::timestamp`);
    });
  } catch (e) {
    console.warn('[ensureMinimalSchema] warning:', e.message);
  }
}
// Helper to derive a human-readable actor label for audit logs
function getActor(req) {
  if (req && req.user) {
    // Prefer username for display/canonical text, fall back to email
    return req.user.username || req.user.email || req.user.sub || 'user';
  }
  return 'user';
}

function isPrivileged(req) {
  const role = req && req.user ? String(req.user.role || '') : '';
  return role === 'OWNER' || role === 'ADMIN';
}

function getClientIp(req) {
  try {
    const ip = req && (req.headers['x-forwarded-for'] || req.ip || req.connection?.remoteAddress);
    if (!ip) return null;
    return String(Array.isArray(ip) ? ip[0] : ip).split(',')[0].trim();
  } catch { return null; }
}

async function insertFuelOpsAudit(client, row) {
  try {
    if (!client) return;
    const {
      user_id, username, tab, section, action, entity_type,
      unit_id = null,
      trip_id = null, trip_no = null,
      op_date = null,
      payload_old = null, payload_new = null, reason = null,
    } = row || {};
    await client.query(
        `INSERT INTO public.fuel_ops_audit (
         user_id, username, tab, section, action, entity_type,
         unit_id, trip_id, trip_no, op_date,
         payload_old, payload_new, reason
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        user_id || null,
        username || null,
        String(tab || 'At Depot'),
        String(section || 'ops'),
        String(action || 'UPDATE'),
        String(entity_type || 'unknown'),
        unit_id,
        trip_id,
        trip_no,
        op_date,
        payload_old,
        payload_new,
        reason,
      ]
    );
  } catch (e) {
    if (!process.env.SUPPRESS_DB_LOG) console.warn('[fuel_ops_audit] insert warn:', e.message);
  }
}

async function recomputeFuelLotUsedAndStatus(client, lotId) {
  if (!client || !lotId) return;
  const id = Number(lotId);
  if (!Number.isFinite(id) || id <= 0) return;
  const lotQ = await client.query(`SELECT id, loaded_liters FROM public.fuel_lots WHERE id=$1 FOR UPDATE`, [id]);
  if (!lotQ.rows.length) return;
  const lot = lotQ.rows[0];

  const inboundQ = await client.query(
      `SELECT COALESCE(SUM(fit.transfer_volume) FILTER (
              WHERE NOT (
                fit.transfer_to_empty = TRUE
                OR (fit.to_lot_code_change = fl.lot_code_created AND fit.transfer_volume = fl.loaded_liters)
                OR (COALESCE(fit.activity,'') = 'TESTING')
              )
            ),0) AS inbound_added
       FROM public.fuel_internal_transfers fit
       JOIN public.fuel_lots fl ON fl.id = fit.to_lot_id
        WHERE fit.to_lot_id=$1`,
    [id]
  );
  const inboundAdded = Number(inboundQ.rows[0]?.inbound_added || 0);

  const salesQ = await client.query(`SELECT COALESCE(SUM(sale_volume_liters),0) AS s FROM public.fuel_sale_transfers WHERE lot_id=$1`, [id]);
  const xfersQ = await client.query(`SELECT COALESCE(SUM(transfer_volume),0) AS t FROM public.fuel_internal_transfers WHERE from_lot_id=$1 AND COALESCE(activity,'') <> 'TESTING'`, [id]);
  const usedOut = Number(salesQ.rows[0]?.s || 0) + Number(xfersQ.rows[0]?.t || 0);
  const netRemaining = (Number(lot.loaded_liters || 0) + inboundAdded) - usedOut;
  const stock = netRemaining <= 0 ? 'SOLD' : 'INSTOCK';

  await client.query(
    `UPDATE public.fuel_lots
        SET used_liters=$2,
            stock_status=$3,
            updated_at=NOW()
      WHERE id=$1`,
    [id, usedOut, stock]
  );
}

async function recomputeFuelLotTestingLiters(client, lotId) {
  if (!client || !lotId) return;
  const id = Number(lotId);
  if (!Number.isFinite(id) || id <= 0) return;
  const q = await client.query(
    `SELECT COALESCE(SUM(transfer_volume_liters),0) AS t
       FROM public.testing_self_transfers
      WHERE lot_id=$1`,
    [id]
  );
  const t = Number(q.rows[0]?.t || 0);
  await client.query(
    `UPDATE public.fuel_lots
        SET cumulative_testing_liters=$2,
            updated_at=NOW()
      WHERE id=$1`,
    [id, t]
  );
}

async function getTripRowForOp(client, truckId, opDate, tripNo) {
  if (!client) return null;
  const tId = Number(truckId);
  const tNo = tripNo != null ? Number(tripNo) : null;
  const d = isoDateOnly(opDate);
  if (!Number.isFinite(tId) || tId <= 0 || !d || !Number.isFinite(tNo) || tNo <= 0) return null;
  const q = await client.query(
    `SELECT * FROM public.truck_dispenser_trips
      WHERE truck_id=$1 AND reading_date=$2::date AND trip_no=$3
      LIMIT 1`,
    [tId, d, tNo]
  );
  return q.rows[0] || null;
}

function isTripClosedRow(tripRow) {
  if (!tripRow) return false;
  if (tripRow.closing_at) return true;
  if (tripRow.closing_liters != null && Number(tripRow.closing_liters) !== 0) return true;
  return false;
}

function isUnfreezeWindow(tripRow) {
  if (!tripRow) return false;
  if (!isTripClosedRow(tripRow)) return false;
  if (tripRow.is_frozen) return false;
  return !!(tripRow.frozen_at && tripRow.unfrozen_at);
}

async function getTripReadingsSnapshot(client, tripRow) {
  if (!client || !tripRow) return null;
  const truckId = Number(tripRow.truck_id);
  const tripNo = Number(tripRow.trip_no);
  const dateStr = isoDateOnly(tripRow.reading_date);
  if (!Number.isFinite(truckId) || truckId <= 0 || !Number.isFinite(tripNo) || tripNo <= 0 || !dateStr) return null;

  const openingRaw = tripRow.opening_liters != null ? Number(tripRow.opening_liters) : 0;
  const opening = Number.isFinite(openingRaw) ? openingRaw : 0;

  const salesSumQ = await client.query(
    `SELECT COALESCE(SUM(sale_volume_liters),0) AS s
       FROM public.fuel_sale_transfers
      WHERE from_unit_id=$1
        AND trip=$2
        AND (
          sale_date = $3::date
          OR (sale_date IS NULL AND performed_at::date = $3::date)
        )`,
    [truckId, tripNo, dateStr]
  );
  const transfersOutSumQ = await client.query(
    `SELECT COALESCE(SUM(transfer_volume),0) AS t
       FROM public.fuel_internal_transfers
      WHERE from_unit_id=$1
        AND trip=$2
        AND transfer_date = $3::date`,
    [truckId, tripNo, dateStr]
  );

  let testingOut = 0;
  try {
    const testingQ = await client.query(
      `SELECT COALESCE(SUM(transfer_volume_liters),0) AS t
         FROM public.testing_self_transfers
        WHERE from_unit_id=$1
          AND trip=$2
          AND (
            sale_date = $3::date
            OR (sale_date IS NULL AND performed_at::date = $3::date)
          )`,
      [truckId, tripNo, dateStr]
    );
    testingOut = Number(testingQ.rows[0]?.t || 0);
  } catch (e) {
    // testing table may not exist in some minimal schemas; ignore
    testingOut = 0;
  }

  const salesOut = Number(salesSumQ.rows[0]?.s || 0);
  const transfersOut = Number(transfersOutSumQ.rows[0]?.t || 0);
  const totalOut = salesOut + transfersOut + (Number.isFinite(testingOut) ? testingOut : 0);
  const closing = round3(opening + totalOut);

  return {
    trip_opening_liters: round3(opening),
    trip_closing_liters: closing,
  };
}

async function assertOpEditableByTripState(client, tripRow, req) {
  // If we can't resolve a trip, treat as legacy/day-level op: restrict to privileged users only.
  if (!tripRow) {
    if (!isPrivileged(req)) {
      const e = new Error('Locked: trip not found for this record');
      e.status = 403;
      throw e;
    }
    return;
  }

  const closed = isTripClosedRow(tripRow);
  const frozen = !!tripRow.is_frozen;

  if (!closed) return; // open trip: editable per existing permissions

  if (!isPrivileged(req)) {
    const e = new Error('Locked: trip is closed');
    e.status = 403;
    throw e;
  }

  if (frozen) {
    const e = new Error('Locked: trip is frozen. Unfreeze to edit.');
    e.status = 409;
    throw e;
  }
}
// Normalize an assignee label to a canonical identifier (prefer email, else username, else full_name as last resort)

// ------------ Validators: PAN and Aadhaar -------------
function normalizePan(pan) {
  if (!pan) return null;
  const s = String(pan).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s || null;
}
function isValidPan(pan) {
  const s = normalizePan(pan);
  if (!s) return false;
  // Basic PAN pattern: 5 letters, 4 digits, 1 letter
  return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(s);
}
// Aadhaar Verhoeff validation (no hashing per requirement)
const verhoeffD = [
  [0,1,2,3,4,5,6,7,8,9],
  [1,2,3,4,0,6,7,8,9,5],
  [2,3,4,0,1,7,8,9,5,6],
  [3,4,0,1,2,8,9,5,6,7],
  [4,0,1,2,3,9,5,6,7,8],
  [5,9,8,7,6,0,4,3,2,1],
  [6,5,9,8,7,1,0,4,3,2],
  [7,6,5,9,8,2,1,0,4,3],
  [8,7,6,5,9,3,2,1,0,4],
  [9,8,7,6,5,4,3,2,1,0]
];
const verhoeffP = [
  [0,1,2,3,4,5,6,7,8,9],
  [1,5,7,6,2,8,3,0,9,4],
  [5,8,0,3,7,9,6,1,4,2],
  [8,9,1,6,0,4,3,5,2,7],
  [9,4,5,3,1,2,6,8,7,0],
  [4,2,8,6,5,7,3,9,0,1],
  [2,7,9,3,8,0,6,4,1,5],
  [7,0,4,6,9,1,3,2,5,8]
];
function isValidAadhaar(a) {
  if (!a) return false;
  const s = String(a).replace(/\s+/g, '');
  if (!/^[0-9]{12}$/.test(s)) return false;
  let c = 0;
  const arr = s.split('').map(Number).reverse();
  for (let i = 0; i < arr.length; i++) {
    const pi = verhoeffP[i % 8][arr[i]];
    c = verhoeffD[c][pi];
  }
  return c === 0;
}
function last4(s) {
  const str = String(s || '');
  return str.length >= 4 ? str.slice(-4) : str;
}

// Phone helpers: accept '+91XXXXXXXXXX' or 10-digit starting 6-9; normalize to +91XXXXXXXXXX
function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D+/g, '');
  if (/^[6-9]\d{9}$/.test(digits)) return '+91' + digits;
  if (/^91[6-9]\d{9}$/.test(digits)) return '+' + digits;
  if (/^\+91[6-9]\d{9}$/.test(String(phone))) return String(phone);
  return null; // invalid
}

app.get('/', (req, res) => {
  res.send('Backend is working!');
});
// Health check endpoint for uptime monitors and load balancers
app.get('/healthz', async (req, res) => {
  try {
    const pool = require('./db');
    await pool.query('SELECT 1');
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
const pool = require('./db');
// Boot: ensure minimal schema and profile views
ensureMinimalSchema(pool)
  .then(() => ensureUserFullProfilesView(pool))
  .then(() => {
    if (!process.env.SUPPRESS_DB_LOG) {
      console.log('[Schema] Bootstrap complete');
    }
  })
  .catch(() => {});

// ----------------------- Fuel Ops APIs -----------------------

// ----------------------- Fuel Ops APIs -----------------------
// List storage units (optionally by type), requires auth
app.get('/api/fuel-ops/storage-units', requireAuth, async (req, res) => {
  try {
    const type = (req.query.type || '').toString().toUpperCase();
    const onlyActive = String(req.query.active || 'true').toLowerCase() !== 'false';
    const params = [];
  let sql = `SELECT id, unit_type, unit_code, capacity_liters, active
               FROM public.storage_units`;
    const where = [];
    if (type && ['TRUCK','DATUM','DISPENSER'].includes(type)) {
      params.push(type);
      where.push(`unit_type = $${params.length}`);
    }
    if (onlyActive) {
      where.push('active = TRUE');
    }
    if (where.length) {
      sql += ' WHERE ' + where.join(' AND ');
    }
    sql += ' ORDER BY unit_type, unit_code';
    const r = await pool.query(sql, params);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update a storage unit (vehicle/datum/dispenser) - OWNER/ADMIN
app.put('/api/fuel-ops/storage-units/:id', requireAuth, requireRole('OWNER','ADMIN'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
    const cur = await pool.query(`SELECT * FROM public.storage_units WHERE id=$1`, [id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
  const { unit_code, capacity_liters, vehicle_number, active } = req.body || {};
    const code = unit_code !== undefined ? String(unit_code || '').trim() : cur.rows[0].unit_code;
    const cap = capacity_liters !== undefined ? parseInt(capacity_liters,10) : cur.rows[0].capacity_liters;
    const veh = vehicle_number !== undefined ? (vehicle_number || null) : cur.rows[0].vehicle_number;
  const act = active !== undefined ? !!active : cur.rows[0].active;
    if (!code) return res.status(400).json({ error: 'unit_code required' });
    if (!Number.isFinite(cap) || cap <= 0) return res.status(400).json({ error: 'capacity_liters must be > 0' });
    // enforce unit_code uniqueness when changed
    if (code !== cur.rows[0].unit_code) {
      const exists = await pool.query(`SELECT 1 FROM public.storage_units WHERE unit_code=$1 AND id<>$2`, [code, id]);
      if (exists.rowCount) return res.status(409).json({ error: 'unit_code already exists' });
    }
    const r = await pool.query(`
      UPDATE public.storage_units
         SET unit_code=$1, capacity_liters=$2, vehicle_number=$3, active=$4, updated_at=NOW()
       WHERE id=$5
       RETURNING id, unit_type, unit_code, capacity_liters, active, vehicle_number
    `, [code, cap, veh, act, id]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete a storage unit (hard delete when safe; otherwise soft-delete by marking inactive)
app.delete('/api/fuel-ops/storage-units/:id', requireAuth, requireRole('OWNER','ADMIN'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
  try {
    const del = await pool.query('DELETE FROM public.storage_units WHERE id=$1 RETURNING id', [id]);
    if (del.rowCount) return res.json({ ok: true, id });
    return res.status(404).json({ error: 'Not found' });
  } catch (e) {
    // FK violation -> soft-delete
    const msg = String(e && e.message ? e.message : '');
    const isFkViolation = (e && (e.code === '23503' || e.code === '2BP01')) || /foreign\s+key\s+constraint/i.test(msg) || /violates\s+RESTRICT\s+setting\s+of\s+foreign\s+key\s+constraint/i.test(msg);
    if (isFkViolation) {
      const upd = await pool.query(
        `UPDATE public.storage_units SET active=FALSE, updated_at=NOW() WHERE id=$1
         RETURNING id, unit_type, unit_code, capacity_liters, active, vehicle_number`,
        [id]
      );
      if (!upd.rowCount) return res.status(404).json({ error: 'Not found' });
      return res.json({ ok: true, id, soft_deleted: true, unit: upd.rows[0] });
    }
    return res.status(500).json({ error: e.message });
  }
});

// Vehicles delete alias (vehicles are storage_units of type TRUCK/DATUM)
app.delete('/api/fuel-ops/vehicles/:id', requireAuth, requireRole('OWNER','ADMIN'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
  try {
    const del = await pool.query('DELETE FROM public.storage_units WHERE id=$1 RETURNING id', [id]);
    if (del.rowCount) return res.json({ ok: true, id });
    return res.status(404).json({ error: 'Not found' });
  } catch (e) {
    const msg = String(e && e.message ? e.message : '');
    const isFkViolation = (e && (e.code === '23503' || e.code === '2BP01')) || /foreign\s+key\s+constraint/i.test(msg) || /violates\s+RESTRICT\s+setting\s+of\s+foreign\s+key\s+constraint/i.test(msg);
    if (isFkViolation) {
      const upd = await pool.query(
        `UPDATE public.storage_units SET active=FALSE, updated_at=NOW() WHERE id=$1
         RETURNING id, unit_type, unit_code, capacity_liters, active, vehicle_number`,
        [id]
      );
      if (!upd.rowCount) return res.status(404).json({ error: 'Not found' });
      return res.json({ ok: true, id, soft_deleted: true, unit: upd.rows[0] });
    }
    return res.status(500).json({ error: e.message });
  }
});

// Shortcut to list dispensers only
app.get('/api/fuel-ops/dispensers', requireAuth, async (req, res) => {
  try {
  const r = await pool.query(`SELECT id, unit_type, unit_code, capacity_liters, active
                                FROM public.storage_units
                                WHERE unit_type='DISPENSER' AND active=TRUE
                                ORDER BY unit_code`);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Drivers CRUD-lite
app.get('/api/fuel-ops/drivers', requireAuth, async (req, res) => {
  try {
    const onlyActive = String(req.query.active || 'true').toLowerCase() !== 'false';
    const r = await pool.query(`SELECT id, name, phone, driver_id, active FROM public.drivers ${onlyActive ? 'WHERE active=TRUE' : ''} ORDER BY name`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/fuel-ops/drivers', requireAuth, requireRole('OWNER','ADMIN'), async (req, res) => {
  try {
    const { name, phone, driver_id, active } = req.body || {};
    const nm = String(name || '').trim();
    const code = String(driver_id || '').trim().toUpperCase();
    if (!nm) return res.status(400).json({ error: 'name required' });
    if (!code) return res.status(400).json({ error: 'driver_id required' });
    const r = await pool.query(`
      INSERT INTO public.drivers (name, phone, driver_id, active)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (driver_id) DO NOTHING
      RETURNING id, name, phone, driver_id, active
    `, [nm, phone || null, code, active === false ? false : true]);
    if (!r.rows.length) return res.status(409).json({ error: 'driver_id already exists' });
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/fuel-ops/drivers/:id', requireAuth, requireRole('OWNER','ADMIN'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
    const cur = await pool.query(`SELECT * FROM public.drivers WHERE id=$1`, [id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
    const { name, phone, driver_id, active } = req.body || {};
    const nm = name !== undefined ? String(name || '').trim() : cur.rows[0].name;
    const code = driver_id !== undefined ? String(driver_id || '').trim().toUpperCase() : cur.rows[0].driver_id;
    const ph = phone !== undefined ? (phone || null) : cur.rows[0].phone;
    const act = active !== undefined ? !!active : cur.rows[0].active;
    if (!nm) return res.status(400).json({ error: 'name required' });
    if (!code) return res.status(400).json({ error: 'driver_id required' });
    if (code !== cur.rows[0].driver_id) {
      const d = await pool.query(`SELECT 1 FROM public.drivers WHERE driver_id=$1 AND id<>$2`, [code, id]);
      if (d.rowCount) return res.status(409).json({ error: 'driver_id already exists' });
    }
    const r = await pool.query(`
      UPDATE public.drivers
         SET name=$1, phone=$2, driver_id=$3, active=$4, updated_at=NOW()
       WHERE id=$5
       RETURNING id, name, phone, driver_id, active
    `, [nm, ph, code, act, id]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete a driver (hard delete when safe; otherwise soft-delete by marking inactive)
app.delete('/api/fuel-ops/drivers/:id', requireAuth, requireRole('OWNER','ADMIN'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
  try {
    const del = await pool.query('DELETE FROM public.drivers WHERE id=$1 RETURNING id', [id]);
    if (del.rowCount) return res.json({ ok: true, id });
    return res.status(404).json({ error: 'Not found' });
  } catch (e) {
    const msg = String(e && e.message ? e.message : '');
    const isFkViolation = (e && (e.code === '23503' || e.code === '2BP01')) || /foreign\s+key\s+constraint/i.test(msg) || /violates\s+RESTRICT\s+setting\s+of\s+foreign\s+key\s+constraint/i.test(msg);
    if (isFkViolation) {
      const upd = await pool.query(
        `UPDATE public.drivers SET active=FALSE, updated_at=NOW() WHERE id=$1
         RETURNING id, name, phone, driver_id, active`,
        [id]
      );
      if (!upd.rowCount) return res.status(404).json({ error: 'Not found' });
      return res.json({ ok: true, id, soft_deleted: true, driver: upd.rows[0] });
    }
    return res.status(500).json({ error: e.message });
  }
});

// Preview next lot code for a unit and date (no insert)
app.get('/api/fuel-ops/lot-code', requireAuth, async (req, res) => {
  try {
    const unitId = parseInt(req.query.unit_id, 10);
    const loadDate = req.query.load_date ? new Date(String(req.query.load_date)) : new Date();
    const liters = parseLiters3(req.query.loaded_liters);
    if (!Number.isFinite(unitId) || unitId <= 0) return res.status(400).json({ error: 'unit_id required' });
    if (!(loadDate instanceof Date) || isNaN(loadDate.getTime())) return res.status(400).json({ error: 'load_date invalid' });
    if (!Number.isFinite(liters) || liters <= 0) return res.status(400).json({ error: 'loaded_liters must be > 0' });
    const dstr = `${loadDate.getFullYear()}-${String(loadDate.getMonth()+1).padStart(2,'0')}-${String(loadDate.getDate()).padStart(2,'0')}`;
    const r = await pool.query(`SELECT * FROM public.preview_next_lot_code($1::int, $2::date, $3::numeric)`, [unitId, dstr, liters]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ lot_code: r.rows[0].lot_code, seq_index: r.rows[0].seq_index });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create a fuel lot (inserts a row, returns lot)
app.post('/api/fuel-ops/lots', requireAuth, async (req, res) => {
  const actor = getActor(req);
  try {
  const { unit_id, load_date, loaded_liters, performed_time, load_time, tanker_code } = req.body || {};
    const unitId = parseInt(unit_id, 10);
    const liters = parseLiters3(loaded_liters);
    if (!Number.isFinite(unitId) || unitId <= 0) return res.status(400).json({ error: 'unit_id required' });
    if (!Number.isFinite(liters) || liters <= 0) return res.status(400).json({ error: 'loaded_liters must be > 0' });
    let d = load_date ? new Date(String(load_date)) : new Date();
    if (!(d instanceof Date) || isNaN(d.getTime())) return res.status(400).json({ error: 'load_date invalid' });
    const dstr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    // Validate capacity before insert
    const su = await pool.query(`SELECT id, unit_code, capacity_liters FROM public.storage_units WHERE id=$1`, [unitId]);
    if (!su.rows.length) return res.status(400).json({ error: 'Unknown storage unit' });
    if (liters > su.rows[0].capacity_liters) return res.status(400).json({ error: `loaded_liters cannot exceed capacity ${su.rows[0].capacity_liters}` });
    // Use SQL function with advisory lock to create row safely
    const r = await pool.query(`SELECT * FROM public.create_fuel_lot($1::int, $2::date, $3::numeric)`, [unitId, dstr, liters]);
    const row = r.rows && r.rows[0];

    // Ensure purchase lots are tagged properly for list filters.
    // Some legacy schemas allow NULL load_type; treat these as PURCHASE.
    try {
      if (row && row.id) {
        await pool.query(
          `UPDATE public.fuel_lots
              SET load_type = 'PURCHASE', updated_at = NOW()
            WHERE id = $1
              AND (load_type IS NULL OR load_type <> 'PURCHASE')`,
          [row.id]
        );
      }
    } catch (e) {
      if (!process.env.SUPPRESS_DB_LOG) console.warn('[warn] set purchase load_type failed', e.message);
    }
    // If caller provided an external tanker identifier, persist it on the created lot
    try {
      if (tanker_code && row && row.id) {
        await pool.query(`UPDATE public.fuel_lots SET tanker_code = $1 WHERE id=$2`, [String(tanker_code).trim(), row.id]);
      }
    } catch (e) { if (!process.env.SUPPRESS_DB_LOG) console.warn('[warn] set tanker_code failed', e.message); }
    // Store original load time separately (do not alter created_at)
    try {
      let finalLoadTs = null;
      const hhmm = (load_time || performed_time || '').trim();
      if (/^\d{2}:\d{2}$/.test(hhmm)) {
        finalLoadTs = `${dstr} ${hhmm}:00`;
      } else if (load_time && /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(load_time)) {
        // Full timestamp string already
        finalLoadTs = load_time.length === 16 ? load_time+':00' : load_time;
      }
      if (finalLoadTs) {
        await pool.query(`UPDATE public.fuel_lots SET load_time = $1::timestamp WHERE id=$2`, [finalLoadTs, row.id]);
      }
    } catch {}
    // Persist actor on the created lot (best-effort)
    try {
      await pool.query(`UPDATE public.fuel_lots SET created_by=$1 WHERE id=$2`, [actor, row.id]);
    } catch {}
    // Reload with load_time field if set. Use runtime-resolved date column and expose as load_date
    let full = row;
    try {
      const dateCol = await resolveFuelLotsDateCol();
      const q2 = await pool.query(`SELECT id, unit_id, tanker_code, ${dateCol} AS load_date, tanker_capacity, loaded_liters, seq_index, seq_letters, lot_code_created, created_at, load_time, load_time_hhmm FROM public.fuel_lots WHERE id=$1`, [row.id]);
      if (q2.rows.length) full = q2.rows[0];
    } catch {}
    res.status(201).json({
      id: full.id,
      unit_id: full.unit_id,
      tanker_code: full.tanker_code,
      load_date: full.load_date,
      tanker_capacity: full.tanker_capacity,
      loaded_liters: full.loaded_liters,
      seq_index: full.seq_index,
      seq_letters: full.seq_letters,
      lot_code: full.lot_code_created,
      created_at: full.created_at,
      load_time: full.load_time || null,
      created_by: actor
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Record a lot activity (transfer/sale) and update lot counters
// Record a lot activity (transfer/sale/testing) and update lot counters
app.post('/api/fuel-ops/lots/activity', requireAuth, async (req, res) => {
  const actor = getActor(req);
  try {
    const { activity, from_unit_id, to_unit_id, to_vehicle, volume_liters, driver_id, transfer_to_empty, transfer_date, sale_date, performed_time, trip } = req.body || {};
    const act = String(activity || '').toUpperCase();
    // Allow TESTING (net-zero meter usage that should not decrement remaining lot liters)
    const allowed = new Set(['TANKER_TO_TANKER','TANKER_TO_DATUM','TANKER_TO_VEHICLE','DATUM_TO_VEHICLE','TESTING']);
    if (!allowed.has(act)) return res.status(400).json({ error: 'invalid activity' });
    const fromId = parseInt(from_unit_id, 10);
    if (!Number.isFinite(fromId) || fromId <= 0) return res.status(400).json({ error: 'from_unit_id required' });
    const toId = to_unit_id != null ? parseInt(to_unit_id, 10) : null;
    const vol = parseLiters3(volume_liters);
    if (!Number.isFinite(vol) || vol <= 0) return res.status(400).json({ error: 'volume_liters must be > 0' });

    // Resolve driver (optional)
    let drow = null;
    if (driver_id != null) {
      const dr = await pool.query(`SELECT id, name, driver_id FROM public.drivers WHERE id=$1`, [parseInt(driver_id,10)]);
      drow = dr.rows[0] || null;
    }

    // Helper to compute cumulative inbound added liters for a lot
    async function getInboundAddedLiters(lotId) {
      // Exclude seeding transfers explicitly: flagged transfer_to_empty OR where to_lot_code_after equals the initial lot code and volume equals lot.loaded_liters
      const q = await pool.query(
        `SELECT COALESCE(SUM(fit.transfer_volume),0) AS added
           FROM public.fuel_internal_transfers fit
           JOIN public.fuel_lots fl ON fl.id = fit.to_lot_id
          WHERE fit.to_lot_id=$1
            AND NOT (
              fit.transfer_to_empty = TRUE
              OR (fit.to_lot_code_change = fl.lot_code_created AND fit.transfer_volume = fl.loaded_liters)
              OR (COALESCE(fit.activity,'') = 'TESTING')
            )`,
        [lotId]
      );
      return Number(q.rows[0]?.added || 0);
    }
    // Helper to compute cumulative USED liters for a lot from all outbound ops (sales + internal transfers)
    async function getOutboundUsedLiters(lotId) {
      const sales = await pool.query(`SELECT COALESCE(SUM(sale_volume_liters),0) AS s FROM public.fuel_sale_transfers WHERE lot_id=$1`, [lotId]);
  const xfers = await pool.query(`SELECT COALESCE(SUM(transfer_volume),0) AS t FROM public.fuel_internal_transfers WHERE from_lot_id=$1 AND COALESCE(activity,'') <> 'TESTING'`, [lotId]);
      return Number(sales.rows[0]?.s || 0) + Number(xfers.rows[0]?.t || 0);
    }

    // Find latest in-stock lot for source unit
    const lotQ = await pool.query(`
      SELECT * FROM public.fuel_lots
       WHERE unit_id=$1 AND stock_status='INSTOCK'
       ORDER BY created_at DESC, id DESC
       LIMIT 1
    `, [fromId]);
    if (!lotQ.rows.length) return res.status(400).json({ error: 'No in-stock lot found for source unit' });
    const lot = lotQ.rows[0];
    const lotId = lot.id;
    // Compute authoritative current state from logs: remaining = loaded + inboundAdds - outboundUsed
    const addedIn = await getInboundAddedLiters(lot.id);
    const usedOutBefore = await getOutboundUsedLiters(lot.id);
    const remaining = Math.max(0, Number(lot.loaded_liters) + addedIn - usedOutBefore);
    // For internal transfers, we validate against aggregate remaining across all lots later (FIFO split),
    // so do not block here on single-lot remaining.
    if (vol > remaining && !(act === 'TANKER_TO_TANKER' || act === 'TANKER_TO_DATUM')) {
      return res.status(400).json({ error: `insufficient volume in lot; remaining ${remaining}` });
    }

    // Fetch unit codes and metadata for from/to
    const fromUnit = await pool.query(`SELECT id, unit_code FROM public.storage_units WHERE id=$1`, [fromId]);
    if (!fromUnit.rows.length) return res.status(400).json({ error: 'Invalid from_unit_id' });
    let toUnit = { rows: [] };
    if (toId) toUnit = await pool.query(`SELECT id, unit_code, unit_type, capacity_liters FROM public.storage_units WHERE id=$1`, [toId]);

    // --- TESTING activity (net-zero; only logs testing volume and increments cumulative_testing_liters) ---
    if (act === 'TESTING') {
      // Optional performed_at timestamp logic (use transfer_date/sale_date semantics consistent with other branches)
      const dateOnly = transfer_date ? isoDateOnly(transfer_date) : (sale_date ? isoDateOnly(sale_date) : isoDateOnly(new Date()));
      let tsSql = null;
      const hhmm = (performed_time || '').trim();
      if (dateOnly && /^\d{2}:\d{2}$/.test(hhmm)) {
        tsSql = `${dateOnly} ${hhmm}:00`;
      } else if (dateOnly) {
        tsSql = `${dateOnly} 00:00:00`;
      }
      // Historically we recorded TESTING activities in `fuel_lot_activities`.
      // That table has been deprecated/removed; rely on `testing_self_transfers` and
      // `fuel_lots.cumulative_testing_liters` for audit and aggregates instead.
      let actRow = null;
      // Increment cumulative_testing_liters (best-effort). Do NOT change used_liters or stock_status.
      let updLot = null;
      try {
        const upd = await pool.query(`
          UPDATE public.fuel_lots
             SET cumulative_testing_liters = COALESCE(cumulative_testing_liters,0) + $2,
                 updated_at = NOW()
           WHERE id=$1
           RETURNING *
        `, [lot.id, vol]);
        updLot = upd.rows[0];
      } catch (e) {
        if (!process.env.SUPPRESS_DB_LOG) console.warn('[TESTING lot update warn]', e.message);
        // Return original lot if update failed
        updLot = lot;
      }
      // Also insert a record into internal transfers for audit/visibility.
      // Note: activity='TESTING' entries are excluded from stock aggregates (see helpers above),
      // so this will not affect used_liters or stock_status.
      try {
        const fromUnitCode = fromUnit.rows[0].unit_code;
        const performedAtSql = (tsSql || null);
        const tripVal = (Number.isFinite(parseInt(trip,10)) && parseInt(trip,10) > 0) ? parseInt(trip,10) : null;

        // Enforce trip lock (closed/frozen)
        const tripRow = await getTripRowForOp(pool, fromId, dateOnly, tripVal);
        await assertOpEditableByTripState(pool, tripRow, req);

        const ins = await pool.query(`
          INSERT INTO public.testing_self_transfers (
            lot_id, activity, from_unit_id, from_unit_code, to_vehicle,
            transfer_volume_liters, lot_code, driver_id, driver_name, performed_by,
            performed_at, updated_by, sale_date, trip
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, COALESCE($11::timestamp, NOW()), $12, COALESCE($13::date, NULL), $14)
          RETURNING *
        `, [
          lot.id, act, fromId, fromUnitCode, fromUnitCode,
          vol, lot.lot_code_created || null, drow ? drow.id : null, drow ? drow.name : null, actor,
          performedAtSql, actor, dateOnly, tripVal
        ]);
        if (!process.env.SUPPRESS_DB_LOG) console.info('[TESTING self transfer inserted]', ins.rows[0]);
      } catch (e) {
        if (!process.env.SUPPRESS_DB_LOG) console.warn('[TESTING self insert warn]', e.message);
      }
      return res.status(201).json({ testing: actRow, lot: updLot });
    }

    // Branch to new tables
    const isInternal = act === 'TANKER_TO_TANKER' || act === 'TANKER_TO_DATUM';
    if (isInternal) {
      if (!toId) return res.status(400).json({ error: 'to_unit_id required for internal transfer' });
      // Enforce: Opening reading must be recorded for the source tanker on the transfer date; closing is NOT required here
      try {
        const dateOnly = transfer_date ? isoDateOnly(transfer_date) : isoDateOnly(new Date());
        // First check day dispenser readings
        const openQ = await pool.query(
          `SELECT opening_liters FROM public.dispenser_day_reading_logs WHERE truck_id=$1 AND reading_date=$2`,
          [fromId, dateOnly]
        );
        let hasOpening = false;
        if (openQ.rows.length && openQ.rows[0].opening_liters != null) {
          hasOpening = true;
        } else {
          // Fallback: accept trip opening (opening_liters or opening_at) created under trips for the same date
          try {
            const tripQ = await pool.query(
              `SELECT opening_at, opening_liters FROM public.truck_dispenser_trips WHERE truck_id=$1 AND reading_date=$2 AND (opening_at IS NOT NULL OR opening_liters IS NOT NULL) LIMIT 1`,
              [fromId, dateOnly]
            );
            if (tripQ.rows.length) hasOpening = true;
          } catch (e) {
            // ignore trip lookup errors
          }
        }
        if (!hasOpening) {
          return res.status(400).json({ error: 'Opening reading missing for this tanker on the selected date. Please record opening before transfers.' });
        }
      } catch (e) { /* if table missing, skip enforcement */ }
      // Find latest in-stock lot for destination unit
      let lotToQ = await pool.query(`
        SELECT * FROM public.fuel_lots
         WHERE unit_id=$1 AND stock_status='INSTOCK'
         ORDER BY created_at DESC, id DESC
         LIMIT 1
      `, [toId]);
      // If destination is a DATUM and has no lot yet, auto-create a lot seeded with this transfer's volume
      let createdNewDestLot = false;
      if (!lotToQ.rows.length) {
        const tRow = toUnit.rows[0];
        // Allow seeding for empty destination DATUM or TRUCK (tanker) using transfer volume as initial loaded_liters
        if (tRow && (tRow.unit_type === 'DATUM' || tRow.unit_type === 'TRUCK')) {
          const toUnitCap = tRow.capacity_liters;
          if (vol > toUnitCap) {
            return res.status(400).json({ error: `destination capacity exceeded: would be ${vol}/${toUnitCap}` });
          }
          // Create a new lot on the destination unit seeded with this transfer volume
          try {
            // Use the same load date as the transfer (or today if not provided)
            const createDate = transfer_date ? isoDateOnly(transfer_date) : isoDateOnly(new Date());
            const created = await pool.query(`SELECT * FROM public.create_fuel_lot($1::int, $2::date, $3::numeric)`, [toId, createDate, vol]);
            if (created.rows && created.rows[0]) {
              lotToQ = { rows: [created.rows[0]] };
              createdNewDestLot = true;
            }
          } catch (e) {
            if (!process.env.SUPPRESS_DB_LOG) console.warn('[WARN] failed to create destination lot for empty unit', e.message);
          }
        }
      }
      // If we created a destination lot by seeding from this transfer, mark its load_type as EMPTY_TRANSFER
      try {
        if (createdNewDestLot && lotToQ.rows[0] && lotToQ.rows[0].id) {
          await pool.query(`UPDATE public.fuel_lots SET load_type = 'EMPTY_TRANSFER' WHERE id = $1`, [lotToQ.rows[0].id]);
          // refresh lotTo with updated row
          const ref = await pool.query(`SELECT * FROM public.fuel_lots WHERE id = $1`, [lotToQ.rows[0].id]);
          if (ref.rows && ref.rows[0]) lotToQ.rows[0] = ref.rows[0];
        }
      } catch (e) {
        if (!process.env.SUPPRESS_DB_LOG) console.warn('[WARN] failed to mark created lot load_type EMPTY_TRANSFER', e.message);
      }
      // Ensure lotTo reference exists for later code
      const lotTo = (lotToQ.rows && lotToQ.rows[0]) ? lotToQ.rows[0] : null;
      if (!lotTo) return res.status(400).json({ error: 'No in-stock lot found for destination unit' });
      const sales = await pool.query(`SELECT COALESCE(SUM(sale_volume_liters),0) AS s FROM public.fuel_sale_transfers WHERE lot_id=$1`, [lotId]);
      const xfers = await pool.query(`SELECT COALESCE(SUM(transfer_volume),0) AS t FROM public.fuel_internal_transfers WHERE from_lot_id=$1 AND COALESCE(activity,'') <> 'TESTING'`, [lotId]);
      // Unit codes
      const fromUnitCode = fromUnit.rows[0].unit_code;
      const toUnitCode = (toUnit.rows[0] || {}).unit_code;

      // Collect all in-stock source lots (FIFO by creation)
      const sourceLotsQ = await pool.query(`
        SELECT * FROM public.fuel_lots
         WHERE unit_id=$1 AND stock_status='INSTOCK'
         ORDER BY created_at ASC, id ASC
      `, [fromId]);
      if (!sourceLotsQ.rows.length) return res.status(400).json({ error: 'No in-stock lot found for source unit' });
      // Compute aggregate remaining across all source lots
      const lotRemaining = [];
      let totalRemaining = 0;
      for (const L of sourceLotsQ.rows) {
        const added = await getInboundAddedLiters(L.id);
        const used = await getOutboundUsedLiters(L.id);
        const rem = Math.max(0, Number(L.loaded_liters) + added - used);
        lotRemaining.push({ lot: L, inbound: added, usedOut: used, remaining: rem });
        totalRemaining += rem;
      }
      if (vol > totalRemaining) {
        return res.status(400).json({ error: `insufficient volume in lot; remaining ${totalRemaining}` });
      }

      // Capacity guard: destination net after transfer must be <= capacity
      const toAddedBefore = createdNewDestLot ? 0 : await getInboundAddedLiters(lotTo.id);
      const toUsedOutBefore = createdNewDestLot ? 0 : await getOutboundUsedLiters(lotTo.id);
      const destCap = Number((toUnit.rows[0] || {}).capacity_liters || 0);
      if (destCap > 0) {
        const toCurrentNet = (createdNewDestLot ? 0 : (Number(lotTo.loaded_liters) + toAddedBefore - toUsedOutBefore));
        const toNetAfter = toCurrentNet + vol;
        if (toNetAfter > destCap) {
          return res.status(400).json({ error: `destination capacity exceeded: would be ${toNetAfter}/${destCap}` });
        }
      }

      // Determine timestamp/date for the transfer (allow HH:mm override)
      const dateOnly = transfer_date ? isoDateOnly(transfer_date) : null;
      let tsSql = null;
      const hhmm = (performed_time || '').trim();
      if (dateOnly && /^\d{2}:\d{2}$/.test(hhmm)) tsSql = `${dateOnly} ${hhmm}:00`;

      const tripVal = (Number.isFinite(parseInt(trip, 10)) && parseInt(trip, 10) > 0) ? parseInt(trip, 10) : null;

      // Enforce trip lock (closed/frozen)
      const tripRow = await getTripRowForOp(pool, fromId, dateOnly || isoDateOnly(new Date()), tripVal);
      await assertOpEditableByTripState(pool, tripRow, req);

      const shouldAudit = isUnfreezeWindow(tripRow);

      // Ensure destination lot load_time set when we created it via EMPTY_TRANSFER
      try { if (createdNewDestLot && tsSql) await pool.query(`UPDATE public.fuel_lots SET load_time=$1::timestamp WHERE id=$2`, [tsSql, lotTo.id]); } catch (e) { if (!process.env.SUPPRESS_DB_LOG) console.warn('[warn] set load_time for EMPTY_TRANSFER lot failed', e.message); }

      // Running dispenser adjust based on previous max
      const prevAdjQ = await pool.query(`
        SELECT COALESCE(MAX(dispenser_reading_transfer_adjust), 0) AS prev
          FROM public.fuel_internal_transfers
         WHERE from_unit_id = $1
      `, [fromId]);
      let runningAdjust = prevAdjQ.rows[0] ? Number(prevAdjQ.rows[0].prev) : 0;

      const xferRows = [];
      let remainingToTransfer = vol;
      for (const entry of lotRemaining) {
        if (remainingToTransfer <= 0) break;
        const take = Math.min(entry.remaining, remainingToTransfer);
        if (take <= 0) continue;

        const tripSnapBefore = shouldAudit ? (tripRow ? await getTripReadingsSnapshot(pool, tripRow) : null) : null;

        // Compose from/to lot codes for this chunk
        const fromUsedNow = await getOutboundUsedLiters(entry.lot.id);
        const fromUsedAfter = fromUsedNow + take;
        const fromSuffix = `-${fromUsedAfter}` + (entry.inbound > 0 ? `+(${entry.inbound})` : '');
        const fromLotCodeAfter = `${entry.lot.lot_code_created}${fromSuffix}`;

        const toAddedAfter = createdNewDestLot ? 0 : (toAddedBefore + xferRows.reduce((a,r)=>a+r.transfer_volume,0) + take);
        // Destination lot code suffix should reflect authoritative USED (outbound) + inbound-added, not the cached lotTo.used_liters.
        const toSuffix = createdNewDestLot ? '' : (`-${toUsedOutBefore}` + (toAddedAfter > 0 ? `+(${toAddedAfter})` : ''));
        const toLotCodeAfter = `${lotTo.lot_code_created}${toSuffix}`;

        runningAdjust += take;
        const ins = await pool.query(`
          INSERT INTO public.fuel_internal_transfers (
            from_lot_id, to_lot_id, activity,
            from_unit_id, from_unit_code, to_unit_id, to_unit_code,
            transfer_volume, from_tanker_change, from_lot_code_change, to_tanker_change, to_lot_code_change,
            transfer_to_empty, driver_name, performed_by,
            dispenser_reading_transfer_adjust, transfer_date, transfer_time,
            trip
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, COALESCE($17::date, CURRENT_DATE), $18::time, $19)
          RETURNING *
        `, [
          entry.lot.id, lotTo.id, act,
          fromId, fromUnitCode, toId, toUnitCode,
          take, -take, fromLotCodeAfter, take, toLotCodeAfter,
          (createdNewDestLot ? true : !!transfer_to_empty), drow ? drow.name : null, actor,
          runningAdjust, dateOnly, (hhmm && /^\d{2}:\d{2}$/.test(hhmm) ? hhmm : '00:00'),
          tripVal
        ]);
        xferRows.push(ins.rows[0]);

        if (shouldAudit) {
          const tripSnapAfter = tripRow ? await getTripReadingsSnapshot(pool, tripRow) : null;
          await insertFuelOpsAudit(pool, {
            user_id: req.user?.sub || null,
            username: actor,
            tab: 'At Depot',
            section: 'Sales & Transfers',
            action: 'CREATE',
            entity_type: 'INTERNAL_TRANSFER',
            entity_id: ins.rows[0]?.id || null,
            unit_id: fromId,
            unit_type: 'TRUCK',
            trip_id: tripRow?.id || null,
            trip_no: tripRow?.trip_no || null,
            op_date: dateOnly,
            performed_time: null, // show audit time via created_at in UI
            amount_liters: take,
            payload_old: (tripSnapBefore ? { ...tripSnapBefore } : null),
            payload_new: (ins.rows[0] ? (tripSnapAfter ? { ...ins.rows[0], ...tripSnapAfter } : ins.rows[0]) : (tripSnapAfter ? { ...tripSnapAfter } : null)),
            reason: null,
            request_id: req.headers['x-request-id'] || null,
            ip_addr: getClientIp(req),
          });
        }

        // Update source lot used and status
        const fromNetRemaining = (Number(entry.lot.loaded_liters) + entry.inbound) - fromUsedAfter;
        const fromStock = fromNetRemaining <= 0 ? 'SOLD' : 'INSTOCK';
        await pool.query(`UPDATE public.fuel_lots SET used_liters=$1, stock_status=$2, updated_at=NOW() WHERE id=$3`, [fromUsedAfter, fromStock, entry.lot.id]);
        remainingToTransfer -= take;
      }

      // Update destination lot used/stock status using authoritative aggregates.
      // This avoids incorrectly marking a destination lot SOLD when its cached used_liters is stale.
      const toAddedCum = createdNewDestLot ? 0 : await getInboundAddedLiters(lotTo.id);
      const toUsedNow = await getOutboundUsedLiters(lotTo.id);
      const toNetRemaining = (Number(lotTo.loaded_liters) + toAddedCum) - toUsedNow;
      const toStock = toNetRemaining <= 0 ? 'SOLD' : 'INSTOCK';
      await pool.query(
        `UPDATE public.fuel_lots SET used_liters=$1, stock_status=$2, updated_at=NOW() WHERE id=$3`,
        [toUsedNow, toStock, lotTo.id]
      );

      // Ensure load_type is set to EMPTY_TRANSFER for lots we seeded from an empty destination.
      try {
        if (createdNewDestLot && lotTo.id) {
          await pool.query(`UPDATE public.fuel_lots SET load_type = 'EMPTY_TRANSFER', updated_at=NOW() WHERE id = $1`, [lotTo.id]);
        }
      } catch (e) {
        if (!process.env.SUPPRESS_DB_LOG) console.warn('[WARN] failed to persist EMPTY_TRANSFER load_type on lot', e.message);
      }

      // Basic lot summary for backwards compatibility (last consumed lot)
      const last = lotRemaining.find(l => l.remaining > 0 && l.remaining >= 0) ? lotRemaining.filter(l=>l.remaining>0).slice(-1)[0] : lotRemaining[lotRemaining.length-1];
      const lastUsedNow = await getOutboundUsedLiters(last.lot.id);
      const lastSuffix = `-${lastUsedNow}` + (last.inbound>0?`+(${last.inbound})`:'');
      const lotSummary = { lot_code_initial: last.lot.lot_code_created, used_liters: lastUsedNow, loaded_liters: last.lot.loaded_liters, lot_code_by_transfer: `${last.lot.lot_code_created}${lastSuffix}` };
      return res.status(201).json({ transfers: xferRows, lot: lotSummary, total_transferred: xferRows.reduce((a,r)=>a+Number(r.transfer_volume||0),0) });
    } else {
      // Sale transfer to vehicle
      if (!to_vehicle) return res.status(400).json({ error: 'to_vehicle required' });

    const fromUnitCode = fromUnit.rows[0].unit_code;
    const inboundAdded = await getInboundAddedLiters(lot.id);
    const usedBefore = await getOutboundUsedLiters(lot.id);
    const usedAfter = usedBefore + vol;
    const suffix = `-${usedAfter}`;
  const lotCodeAfter = `${lot.lot_code_created}${suffix}`;

      const baseSaleDate = sale_date ? isoDateOnly(sale_date) : null;
      // For performed_at: only set when HH:mm is provided; else allow NOW() so records fall within the active trip window
      let saleDateOnly = null;
      const hhmmSale = (performed_time || '').trim();
      if (baseSaleDate && /^\d{2}:\d{2}$/.test(hhmmSale)) {
        saleDateOnly = `${baseSaleDate} ${hhmmSale}:00`;
      }

      // Enforce trip lock (closed/frozen) BEFORE creating the record
      const tripVal = (Number.isFinite(parseInt(trip,10)) && parseInt(trip,10) > 0) ? parseInt(trip,10) : null;
      const opDate = (sale_date ? isoDateOnly(sale_date) : (saleDateOnly ? isoDateOnly(saleDateOnly) : isoDateOnly(new Date())));
      const tripRow = await getTripRowForOp(pool, fromId, opDate, tripVal);
      await assertOpEditableByTripState(pool, tripRow, req);

      const tripSnapBefore = tripRow ? await getTripReadingsSnapshot(pool, tripRow) : null;

      const sale = await pool.query(`
        INSERT INTO public.fuel_sale_transfers (
          lot_id, from_unit_id, from_unit_code, to_vehicle, sale_volume_liters, lot_code_after,
          driver_id, driver_name, performed_by, activity,
          performed_at, sale_date, trip
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, COALESCE($11::timestamp, NOW()), COALESCE($12::date, CURRENT_DATE), $13)
        RETURNING *
      `, [
        lot.id, fromId, fromUnitCode, to_vehicle, vol, lotCodeAfter,
        drow ? drow.id : null, drow ? drow.name : null, actor, act,
        saleDateOnly, sale_date ? isoDateOnly(sale_date) : null, tripVal
      ]);

      if (isUnfreezeWindow(tripRow)) {
        const tripSnapAfter = tripRow ? await getTripReadingsSnapshot(pool, tripRow) : null;
        await insertFuelOpsAudit(pool, {
          user_id: req.user?.sub || null,
          username: actor,
          tab: 'At Depot',
          section: 'Sales & Transfers',
          action: 'CREATE',
          entity_type: 'SALE',
          entity_id: sale.rows[0]?.id || null,
          unit_id: fromId,
          unit_type: 'TRUCK',
          driver_id: drow ? drow.id : null,
          trip_id: tripRow?.id || null,
          trip_no: tripRow?.trip_no || null,
          op_date: opDate,
          performed_time: null, // show audit time via created_at in UI
          amount_liters: vol,
          payload_old: (tripSnapBefore ? { ...tripSnapBefore } : null),
          payload_new: (sale.rows[0] ? (tripSnapAfter ? { ...sale.rows[0], ...tripSnapAfter } : sale.rows[0]) : (tripSnapAfter ? { ...tripSnapAfter } : null)),
          reason: null,
          request_id: req.headers['x-request-id'] || null,
          ip_addr: getClientIp(req),
        });
      }

      const netRemaining = (Number(lot.loaded_liters) + inboundAdded) - usedAfter;
      const stock = netRemaining <= 0 ? 'SOLD' : 'INSTOCK';
      const upd = await pool.query(`UPDATE public.fuel_lots SET used_liters=$1, stock_status=$2, updated_at=NOW() WHERE id=$3 RETURNING *`, [usedAfter, stock, lot.id]);

      return res.status(201).json({ sale: sale.rows[0], lot: upd.rows[0] });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Mini stock summary for active TRUCK and DATUM units
// Returns per-unit capacity and current in-stock liters aggregated across ALL in-stock lots for that unit
app.get('/api/fuel-ops/stock/summary', requireAuth, async (req, res) => {
  try {
    const rows = await pool.query(`
      WITH units AS (
        SELECT id, unit_code, unit_type, capacity_liters, vehicle_number
          FROM public.storage_units
         WHERE active=TRUE AND unit_type IN ('TRUCK','DATUM')
      ),
      lots AS (
        SELECT id AS lot_id, unit_id, loaded_liters, lot_code_created, created_at
          FROM public.fuel_lots
         WHERE stock_status='INSTOCK'
      ),
      latest AS (
        SELECT DISTINCT ON (unit_id) lot_id, unit_id, lot_code_created, created_at
          FROM lots
         ORDER BY unit_id, created_at DESC, lot_id DESC
      ),
      snaps AS (
        SELECT truck_id AS unit_id, reading_at, reading_liters,
               ROW_NUMBER() OVER (PARTITION BY truck_id ORDER BY reading_at DESC) AS rn
          FROM public.truck_dispenser_meter_snapshots
      ),
      inbound AS (
        SELECT fit.to_lot_id AS lot_id,
               COALESCE(SUM(fit.transfer_volume) FILTER (
                 WHERE NOT (
                   fit.transfer_to_empty = TRUE
                   OR (fit.to_lot_code_change = fl.lot_code_created AND fit.transfer_volume = fl.loaded_liters)
                   OR (COALESCE(fit.activity,'') = 'TESTING')
                 )
               ),0) AS inbound_added
          FROM public.fuel_internal_transfers fit
          JOIN public.fuel_lots fl ON fl.id = fit.to_lot_id
         GROUP BY fit.to_lot_id
      ),
      sale_unit AS (
        SELECT fst.from_unit_id AS unit_id,
               COALESCE(SUM(
                 CASE
                   WHEN sn.reading_at IS NOT NULL THEN CASE WHEN COALESCE(fst.performed_at, fst.sale_date::timestamp) >= sn.reading_at THEN fst.sale_volume_liters ELSE 0 END
                   ELSE fst.sale_volume_liters
                 END
               ),0) AS sale_out_since,
               MAX(COALESCE(fst.performed_at, fst.sale_date::timestamp)) AS last_sale_at
          FROM public.fuel_sale_transfers fst
          LEFT JOIN (SELECT unit_id, reading_at FROM snaps WHERE rn=1) sn ON sn.unit_id = fst.from_unit_id
         GROUP BY fst.from_unit_id
      ),
      sales AS (
        SELECT lot_id, COALESCE(SUM(sale_volume_liters),0) AS sale_only
          FROM public.fuel_sale_transfers
         GROUP BY lot_id
      ),
      xfer_unit AS (
        SELECT fit.from_unit_id AS unit_id,
               COALESCE(SUM(
                 CASE
                   WHEN sn.reading_at IS NOT NULL THEN CASE WHEN (fit.transfer_date::timestamp + fit.transfer_time) >= sn.reading_at THEN fit.transfer_volume ELSE 0 END
                   ELSE fit.transfer_volume
                 END
               ),0) AS xfer_out_since,
               MAX(fit.transfer_date::timestamp + fit.transfer_time) AS last_xfer_at
          FROM public.fuel_internal_transfers fit
          LEFT JOIN (SELECT unit_id, reading_at FROM snaps WHERE rn=1) sn ON sn.unit_id = fit.from_unit_id
         WHERE COALESCE(fit.activity,'') <> 'TESTING'
         GROUP BY fit.from_unit_id
      ),
      testing_unit AS (
        SELECT tst.from_unit_id AS unit_id,
               COALESCE(SUM(
                 CASE
                   WHEN sn.reading_at IS NOT NULL THEN CASE WHEN COALESCE(tst.performed_at, tst.sale_date::timestamp) >= sn.reading_at THEN tst.transfer_volume_liters ELSE 0 END
                   ELSE tst.transfer_volume_liters
                 END
               ),0) AS test_out_since,
               MAX(COALESCE(tst.performed_at, tst.sale_date::timestamp)) AS last_test_at
          FROM public.testing_self_transfers tst
          LEFT JOIN (SELECT unit_id, reading_at FROM snaps WHERE rn=1) sn ON sn.unit_id = tst.from_unit_id
         GROUP BY tst.from_unit_id
      ),
      outbound_x AS (
        SELECT from_lot_id AS lot_id, COALESCE(SUM(transfer_volume),0) AS outbound_transfers
          FROM public.fuel_internal_transfers
         WHERE COALESCE(activity,'') <> 'TESTING'
         GROUP BY from_lot_id
      ),
      per_lot AS (
        SELECT l.unit_id, l.lot_id, l.lot_code_created, l.created_at,
               COALESCE((SELECT fl.loaded_liters FROM public.fuel_lots fl WHERE fl.id=l.lot_id),0) AS loaded_liters,
               GREATEST(0,
                 COALESCE((SELECT fl.loaded_liters FROM public.fuel_lots fl WHERE fl.id=l.lot_id),0)
                 + COALESCE(i.inbound_added,0)
                 - (COALESCE(o.outbound_transfers,0) + COALESCE(s.sale_only,0))
               ) AS remaining
          FROM lots l
          LEFT JOIN inbound i ON i.lot_id = l.lot_id
          LEFT JOIN sales s ON s.lot_id = l.lot_id
          LEFT JOIN outbound_x o ON o.lot_id = l.lot_id
      ),
      agg AS (
        SELECT unit_id, COALESCE(SUM(remaining),0) AS instock_liters
          FROM per_lot
         GROUP BY unit_id
      )
  SELECT u.id, u.unit_code, u.unit_type, u.capacity_liters, u.vehicle_number,
             lt.lot_id, lt.lot_code_created,
             COALESCE(a.instock_liters,0) AS instock_liters,
             COALESCE(s.sale_only,0) AS sale_only_liters,
             COALESCE(sn.reading_liters, NULL) AS latest_snapshot_liters,
             COALESCE(to_char(sn.reading_at, 'YYYY-MM-DD"T"HH24:MI:SS'), NULL) AS latest_snapshot_at,
               COALESCE(su.sale_out_since,0) AS sale_out_since,
               COALESCE(xu.xfer_out_since,0) AS xfer_out_since,
               COALESCE(tu.test_out_since,0) AS test_out_since,
               to_char(
                 GREATEST(
                   COALESCE(su.last_sale_at, '1970-01-01'::timestamp),
                   COALESCE(xu.last_xfer_at, '1970-01-01'::timestamp),
                   COALESCE(tu.last_test_at, '1970-01-01'::timestamp)
                 ),
                 'YYYY-MM-DD"T"HH24:MI:SS'
               ) AS last_outbound_at,
             to_char(COALESCE(su.last_sale_at, '1970-01-01'::timestamp), 'YYYY-MM-DD"T"HH24:MI:SS') AS last_sale_at
        FROM units u
        LEFT JOIN latest lt ON lt.unit_id = u.id
        LEFT JOIN sales s ON s.lot_id = lt.lot_id
        LEFT JOIN agg a ON a.unit_id = u.id
        LEFT JOIN snaps sn ON sn.unit_id = u.id AND sn.rn = 1
        LEFT JOIN sale_unit su ON su.unit_id = u.id
        LEFT JOIN xfer_unit xu ON xu.unit_id = u.id
        LEFT JOIN testing_unit tu ON tu.unit_id = u.id
       ORDER BY u.unit_type, u.unit_code
    `);
    const items = rows.rows.map(r => ({
      id: r.id,
      unit_code: r.unit_code,
      unit_type: r.unit_type,
      capacity_liters: Number(r.capacity_liters || 0),
      vehicle_number: r.vehicle_number || null,
  lot_id: r.lot_id || null,
  lot_code_initial: r.lot_code_created || null,
      instock_liters: Number(r.instock_liters || 0),
      sale_only_liters: Number(r.sale_only_liters || 0),
      meter_reading_liters: (() => {
        const snap = r.latest_snapshot_liters != null ? Number(r.latest_snapshot_liters) : null;
        const outSince = Number(r.sale_out_since || 0) + Number(r.xfer_out_since || 0) + Number(r.test_out_since || 0);
        if (snap == null) return outSince;
        return snap + outSince;
      })(),
      latest_snapshot_liters: r.latest_snapshot_liters != null ? Number(r.latest_snapshot_liters) : null,
      latest_snapshot_at: r.latest_snapshot_at || null,
      last_sale_at: r.last_sale_at || null,
      last_outbound_at: r.last_outbound_at || null
    }));
    res.json({ items, generatedAt: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create a storage unit (tanker). Restricted to OWNER/ADMIN.
app.post('/api/fuel-ops/storage-units', requireAuth, requireRole('OWNER','ADMIN'), async (req, res) => {
  try {
    const { unit_code, capacity_liters, unit_type, vehicle_number } = req.body || {};
    const rawType = String(unit_type || 'TRUCK').toUpperCase();
    // Accept 'STORAGE' from UI and normalize to 'DATUM'
    const type = rawType === 'STORAGE' ? 'DATUM' : rawType;
    if (!['TRUCK','DATUM','DISPENSER'].includes(type)) return res.status(400).json({ error: 'unit_type invalid' });
    const code = (unit_code || '').toString().trim();
    const cap = parseInt(capacity_liters, 10);
    if (!code) return res.status(400).json({ error: 'unit_code required' });
    if (!Number.isFinite(cap) || cap <= 0) return res.status(400).json({ error: 'capacity_liters must be > 0' });
    const r = await pool.query(
      `INSERT INTO public.storage_units (unit_type, unit_code, capacity_liters, active, vehicle_number)
       VALUES ($1,$2,$3,TRUE,$4)
       ON CONFLICT (unit_code) DO NOTHING
       RETURNING id, unit_type, unit_code, capacity_liters, active, vehicle_number`,
      [type, code, cap, vehicle_number || null]
    );
    if (!r.rows.length) return res.status(409).json({ error: 'unit_code already exists' });
    res.status(201).json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Vehicles list shortcut (TRUCK/DATUM)
app.get('/api/fuel-ops/vehicles', requireAuth, async (req, res) => {
  try {
    const type = (req.query.type || '').toString().toUpperCase();
    if (!['TRUCK','DATUM'].includes(type)) return res.status(400).json({ error: 'type must be TRUCK or DATUM' });
  const r = await pool.query(`SELECT id, unit_type, unit_code, vehicle_number, capacity_liters, active
                                 FROM public.storage_units
                                 WHERE unit_type=$1 AND active=TRUE
                                 ORDER BY unit_code`, [type]);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Opening suggestions & daily upsert for dispenser and odometer (by truck) ---
function round3(n) {
  if (!Number.isFinite(n)) return n;
  return Math.round(n * 1000) / 1000;
}

function parseLiters3(value) {
  if (value === undefined || value === null) return NaN;
  const s = String(value).trim();
  if (!s) return NaN;
  const n = Number(s);
  if (!Number.isFinite(n)) return NaN;
  return round3(n);
}

function isoDateOnly(s) {
  if (!s) return null;
  if (s instanceof Date) {
    if (Number.isNaN(s.getTime())) return null;
    const y = s.getFullYear();
    const m = String(s.getMonth() + 1).padStart(2, '0');
    const d = String(s.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  const str = String(s).trim();
  // ISO date (YYYY-MM-DD)
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;

  // Support YYYY/MM/DD
  let m = str.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const day = Number(m[3]);
    if (y >= 1900 && mo >= 1 && mo <= 12 && day >= 1 && day <= 31) {
      return `${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // Support DD/MM/YYYY or DD-MM-YYYY
  m = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) {
    const day = Number(m[1]);
    const mo = Number(m[2]);
    const y = Number(m[3]);
    if (y >= 1900 && mo >= 1 && mo <= 12 && day >= 1 && day <= 31) {
      return `${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // Support D-M-YY (assume DD-MM-YY for this app)
  m = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})$/);
  if (m) {
    const day = Number(m[1]);
    const mo = Number(m[2]);
    const yy = Number(m[3]);
    const y = 2000 + yy;
    if (mo >= 1 && mo <= 12 && day >= 1 && day <= 31) {
      return `${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  return null;
}

// Format a JS Date to SQL timestamp string in local time (no timezone conversion)
function toSqlLocalTs(dt) {
  if (!dt) return null;
  const d = new Date(dt);
  if (isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  const hh = String(d.getHours()).padStart(2,'0');
  const mm = String(d.getMinutes()).padStart(2,'0');
  const ss = String(d.getSeconds()).padStart(2,'0');
  return `${y}-${m}-${day} ${hh}:${mm}:${ss}`;
}

// Get opening suggestion for dispenser liters
// [ARCHIVED 2026-02-19] GET /api/fuel-ops/opening-suggestion/dispenser -- moved to legacy-monolith-backup/routes/archived_unused_handlers.js

// Get opening suggestion for odometer km
app.get('/api/fuel-ops/opening-suggestion/odometer', requireAuth, async (req, res) => {
  try {
    const truckId = parseInt(req.query.truck_id, 10);
    const dateStr = isoDateOnly(req.query.date || new Date());
    if (!Number.isFinite(truckId) || truckId <= 0) return res.status(400).json({ error: 'truck_id required' });
    const r = await pool.query(
      `SELECT closing_km, reading_date FROM public.truck_odometer_day_readings
        WHERE truck_id=$1 AND reading_date < $2::date
        ORDER BY reading_date DESC LIMIT 1`, [truckId, dateStr]
    );
    if (r.rows.length) return res.json({ opening: r.rows[0].closing_km, source: 'yesterday', date: r.rows[0].reading_date });
    res.json({ opening: null, source: 'first' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get existing daily dispenser record (proxy to day reading logs)
app.get('/api/fuel-ops/day/dispenser', requireAuth, async (req, res) => {
  try {
    const truckId = parseInt(req.query.truck_id, 10);
    const dateStr = isoDateOnly(req.query.date || new Date());
    const r = await pool.query(`SELECT * FROM public.dispenser_day_reading_logs WHERE truck_id=$1 AND reading_date=$2`, [truckId, dateStr]);
    res.json(r.rows[0] || null);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// [ARCHIVED 2026-02-19] GET /api/fuel-ops/day/dispenser/list -- moved to legacy-monolith-backup/routes/archived_unused_handlers.js

// Trips CRUD-lite: list/create/edit for multiple trips per day
app.get('/api/fuel-ops/trips', requireAuth, async (req, res) => {
  try {
    const truckId = parseInt(req.query.truck_id, 10);
    const dateStr = isoDateOnly(req.query.date || new Date());
  if (!Number.isFinite(truckId) || truckId <= 0) return res.status(400).json({ error: 'truck_id required' });
  if (!dateStr) return res.status(400).json({ error: 'date invalid' });
    const r = await pool.query(
      `SELECT id, truck_id, reading_date, trip_no, opening_liters, closing_liters, opening_at, closing_at, note, driver_name, driver_code
              , is_frozen, frozen_at, frozen_by, frozen_reason, unfrozen_at, unfrozen_by, unfrozen_reason
         FROM public.truck_dispenser_trips
        WHERE truck_id=$1 AND reading_date=$2
        ORDER BY trip_no ASC`,
      [truckId, dateStr]
    );
    res.json({ items: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/fuel-ops/trips', requireAuth, async (req, res) => {
  try {
    const { truck_id, date, opening_liters, opening_at, note, driver_name, driver_code } = req.body || {};
    const truckId = parseInt(truck_id, 10);
    const dateStr = isoDateOnly(date || new Date());
    if (!Number.isFinite(truckId) || truckId <= 0) return res.status(400).json({ error: 'truck_id required' });
    if (!dateStr) return res.status(400).json({ error: 'date invalid' });
    // Determine next trip number for the given truck and date
    const nextQ = await pool.query(
      `SELECT COALESCE(MAX(trip_no),0)+1 AS next
         FROM public.truck_dispenser_trips
        WHERE truck_id=$1 AND reading_date=$2`,
      [truckId, dateStr]
    );
    const nextNo = Number(nextQ.rows[0]?.next || 1);
    // Preserve wall-clock time exactly as provided (avoid any UTC conversion)
    let openingTsSql = null;
    if (opening_at && isValidDateTimeString(String(opening_at))) {
      openingTsSql = coerceLocalSqlTimestamp(String(opening_at)) || String(opening_at).replace('T', ' ').slice(0, 19);
    }
    const r = await pool.query(
      `INSERT INTO public.truck_dispenser_trips (truck_id, reading_date, trip_no, opening_liters, opening_at, note, driver_name, driver_code, created_by, created_by_user_id)
       VALUES ($1,$2,$3,COALESCE($4,0),$5,$6,$7,$8,$9,$10)
       RETURNING *`,
  [truckId, dateStr, nextNo, (opening_liters!=null? parseLiters3(opening_liters): null), openingTsSql, note || null, driver_name || null, driver_code || null, getActor(req), req.user?.sub || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/fuel-ops/trips/:id', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });

    const existingQ = await client.query(`SELECT * FROM public.truck_dispenser_trips WHERE id=$1 FOR UPDATE`, [id]);
    if (!existingQ.rows.length) return res.status(404).json({ error: 'not found' });
    const existing = existingQ.rows[0];

    const { opening_liters, closing_liters, opening_at, closing_at, note, driver_name, driver_code } = req.body || {};
    const parts = [];
    const vals = [];
    let idx = 1;
    if (opening_liters != null) { parts.push(`opening_liters=$${idx++}`); vals.push(parseLiters3(opening_liters)); }
    if (closing_liters != null) { parts.push(`closing_liters=$${idx++}`); vals.push(parseLiters3(closing_liters)); }
    if (opening_at) {
      parts.push(`opening_at=$${idx++}`);
      vals.push(coerceLocalSqlTimestamp(String(opening_at)) || String(opening_at).replace('T', ' ').slice(0, 19));
    }
    if (closing_at) {
      parts.push(`closing_at=$${idx++}`);
      vals.push(coerceLocalSqlTimestamp(String(closing_at)) || String(closing_at).replace('T', ' ').slice(0, 19));
    }
    if (note !== undefined) { parts.push(`note=$${idx++}`); vals.push(note || null); }
    if (driver_name !== undefined) { parts.push(`driver_name=$${idx++}`); vals.push(driver_name || null); }
    if (driver_code !== undefined) { parts.push(`driver_code=$${idx++}`); vals.push(driver_code || null); }
    if (!parts.length) return res.status(400).json({ error: 'no fields to update' });

    // Locking rules
    if (isTripClosedRow(existing) && !isPrivileged(req)) {
      return res.status(403).json({ error: 'Locked: trip is closed' });
    }
    if (existing.is_frozen) {
      return res.status(409).json({ error: 'Locked: trip is frozen. Unfreeze to edit.' });
    }

    const willClose = (closing_at || closing_liters != null);
    const wasClosed = isTripClosedRow(existing);

    // Auto-freeze when closing a trip (End Trip)
    if (willClose && !wasClosed) {
      parts.push(`is_frozen=TRUE`);
      parts.push(`frozen_at=COALESCE(frozen_at, NOW())`);
      parts.push(`frozen_by=$${idx++}`); vals.push(getActor(req));
      parts.push(`frozen_by_user_id=$${idx++}`); vals.push(req.user?.sub || null);
      parts.push(`frozen_reason=COALESCE(frozen_reason,'Trip closed')`);
    }

    parts.push(`updated_at=NOW()`);
    vals.push(id);
    const r = await client.query(`UPDATE public.truck_dispenser_trips SET ${parts.join(', ')} WHERE id=$${idx} RETURNING *`, vals);

    // Audit only changes made after a trip is unfrozen ("unfreeze window"), and only
    // for the requested sections: Opening Reading / Closing Reading.
    const didEditOpening = (opening_liters != null) || Boolean(opening_at);
    const didEditClosing = (closing_liters != null) || Boolean(closing_at);
    const updatedTrip = r.rows[0] || null;
    if (isUnfreezeWindow(existing) && (didEditOpening || didEditClosing)) {
      const baseAudit = {
        user_id: req.user?.sub || null,
        username: getActor(req),
        tab: 'At Depot',
        action: 'UPDATE',
        entity_type: 'TRIP',
        entity_id: id,
        unit_id: updatedTrip?.truck_id || existing.truck_id || null,
        unit_type: 'TRUCK',
        trip_id: id,
        trip_no: updatedTrip?.trip_no || existing.trip_no || null,
        op_date: updatedTrip?.reading_date || existing.reading_date || null,
        performed_time: null, // show audit time via created_at in UI
        reason: null,
        request_id: req.headers['x-request-id'] || null,
        ip_addr: getClientIp(req),
      };

      if (didEditOpening) {
        await insertFuelOpsAudit(client, {
          ...baseAudit,
          section: 'Opening Reading',
          payload_old: {
            opening_liters: existing.opening_liters ?? null,
            opening_at: existing.opening_at ?? null,
          },
          payload_new: {
            opening_liters: updatedTrip?.opening_liters ?? null,
            opening_at: updatedTrip?.opening_at ?? null,
          },
        });
      }

      if (didEditClosing) {
        await insertFuelOpsAudit(client, {
          ...baseAudit,
          section: 'Closing Reading',
          payload_old: {
            closing_liters: existing.closing_liters ?? null,
            closing_at: existing.closing_at ?? null,
          },
          payload_new: {
            closing_liters: updatedTrip?.closing_liters ?? null,
            closing_at: updatedTrip?.closing_at ?? null,
          },
        });
      }
    }

    await client.query('COMMIT');
    res.json(r.rows[0]);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    res.status(e.status || 500).json({ error: e.message });
  } finally { client.release(); }
});

// [ARCHIVED 2026-02-19] POST /api/fuel-ops/trips/:id/freeze -- moved to legacy-monolith-backup/routes/archived_unused_handlers.js

app.post('/api/fuel-ops/trips/:id/unfreeze', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!isPrivileged(req)) return res.status(403).json({ error: 'Forbidden' });
    await client.query('BEGIN');
    const id = parseInt(req.params.id, 10);
    const reason = (req.body && req.body.reason) ? String(req.body.reason) : null;
    const q = await client.query(`SELECT * FROM public.truck_dispenser_trips WHERE id=$1 FOR UPDATE`, [id]);
    if (!q.rows.length) return res.status(404).json({ error: 'not found' });
    const oldRow = q.rows[0];
    const r = await client.query(
      `UPDATE public.truck_dispenser_trips
          SET is_frozen=FALSE,
              unfrozen_at=NOW(),
              unfrozen_by=$2,
              unfrozen_by_user_id=$3,
              unfrozen_reason=COALESCE($4, unfrozen_reason, 'Manual unfreeze'),
              updated_at=NOW()
        WHERE id=$1
        RETURNING *`,
      [id, getActor(req), req.user?.sub || null, reason]
    );
    await insertFuelOpsAudit(client, {
      user_id: req.user?.sub || null,
      username: getActor(req),
      tab: 'At Depot',
      section: 'Freeze',
      action: 'UNFREEZE',
      entity_type: 'TRIP',
      entity_id: id,
      unit_id: r.rows[0]?.truck_id || null,
      unit_type: 'TRUCK',
      trip_id: id,
      trip_no: r.rows[0]?.trip_no || null,
      op_date: r.rows[0]?.reading_date || null,
      performed_time: null,
      payload_old: oldRow,
      payload_new: r.rows[0] || null,
      reason,
      request_id: req.headers['x-request-id'] || null,
      ip_addr: getClientIp(req),
    });
    await client.query('COMMIT');
    res.json(r.rows[0]);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// Recalculate trip closing based on trip-linked operations; re-freezes the trip (OWNER/ADMIN only)
app.post('/api/fuel-ops/trips/:id/update-end-trip', requireAuth, requireRole('OWNER','ADMIN'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
    const reason = (req.body && req.body.reason) ? String(req.body.reason) : null;

    const q = await client.query(`SELECT * FROM public.truck_dispenser_trips WHERE id=$1 FOR UPDATE`, [id]);
    if (!q.rows.length) return res.status(404).json({ error: 'not found' });
    const oldRow = q.rows[0];
    if (!isTripClosedRow(oldRow)) return res.status(400).json({ error: 'Trip is not closed yet' });
    if (oldRow.is_frozen) return res.status(409).json({ error: 'Locked: trip is frozen. Unfreeze to update end trip.' });

    const truckId = Number(oldRow.truck_id);
    const tripNo = Number(oldRow.trip_no);
    const dateStr = isoDateOnly(oldRow.reading_date);
    const opening = Number(oldRow.opening_liters || 0);

    async function getTripOutSums(truckId, tripNo, dateStr) {
      const salesSumQ = await client.query(
      `SELECT COALESCE(SUM(sale_volume_liters),0) AS s,
              MAX(performed_at) AS max_ts
         FROM public.fuel_sale_transfers
        WHERE from_unit_id=$1
          AND trip=$2
          AND (
            sale_date = $3::date
            OR (sale_date IS NULL AND performed_at::date = $3::date)
          )`,
        [truckId, tripNo, dateStr]
      );
      const transfersOutSumQ = await client.query(
      `SELECT COALESCE(SUM(transfer_volume),0) AS t,
              MAX(transfer_date::timestamp + transfer_time) AS max_ts
         FROM public.fuel_internal_transfers
        WHERE from_unit_id=$1
          AND trip=$2
          AND transfer_date = $3::date`,
        [truckId, tripNo, dateStr]
      );
      let testingSumQ = { rows: [{ t: 0, max_ts: null }] };
      try {
        testingSumQ = await client.query(
          `SELECT COALESCE(SUM(transfer_volume_liters),0) AS t,
                  MAX(performed_at) AS max_ts
             FROM public.testing_self_transfers
            WHERE from_unit_id=$1
              AND trip=$2
              AND (
                sale_date = $3::date
                OR (sale_date IS NULL AND performed_at::date = $3::date)
              )`,
          [truckId, tripNo, dateStr]
        );
      } catch (e) {
        if (!process.env.SUPPRESS_DB_LOG) console.warn('[update-end-trip testing warn]', e.message);
      }
      const salesOut = Number(salesSumQ.rows[0]?.s || 0);
      const transfersOut = Number(transfersOutSumQ.rows[0]?.t || 0);
      const testingOut = Number(testingSumQ.rows[0]?.t || 0);
      const latestCandidates = [];
      if (salesSumQ.rows[0]?.max_ts) latestCandidates.push(salesSumQ.rows[0].max_ts);
      if (transfersOutSumQ.rows[0]?.max_ts) latestCandidates.push(transfersOutSumQ.rows[0].max_ts);
      if (testingSumQ.rows[0]?.max_ts) latestCandidates.push(testingSumQ.rows[0].max_ts);
      let latestTs = null;
      if (latestCandidates.length) {
        latestTs = latestCandidates[0];
        for (const t of latestCandidates) {
          try {
            if (t && latestTs && new Date(t).getTime() > new Date(latestTs).getTime()) latestTs = t;
          } catch {}
        }
      }
      return {
        salesOut,
        transfersOut,
        testingOut,
        latestTs,
        totalOut: salesOut + transfersOut + testingOut,
      };
    }

    const sums = await getTripOutSums(truckId, tripNo, dateStr);
    const newClosing = round3(opening + sums.totalOut);

    const tsCandidates = [];
    if (oldRow.closing_at) tsCandidates.push(oldRow.closing_at);
    if (sums.latestTs) tsCandidates.push(sums.latestTs);

    let newClosingAt = oldRow.closing_at || null;
    if (tsCandidates.length) {
      let latest = tsCandidates[0];
      for (const t of tsCandidates) {
        try {
          if (t && latest && new Date(t).getTime() > new Date(latest).getTime()) latest = t;
        } catch {}
      }
      newClosingAt = latest || newClosingAt;
    }

    const upd = await client.query(
      `UPDATE public.truck_dispenser_trips
          SET closing_liters=$2,
              closing_at=COALESCE($3, closing_at),
              is_frozen=TRUE,
              frozen_at=NOW(),
              frozen_by=$4,
              frozen_by_user_id=$5,
              frozen_reason=COALESCE($6,'Update End Trip'),
              updated_at=NOW()
        WHERE id=$1
        RETURNING *`,
      [id, newClosing, newClosingAt ? coerceLocalSqlTimestamp(String(newClosingAt)) || String(newClosingAt).replace('T',' ').slice(0,19) : null, getActor(req), req.user?.sub || null, reason]
    );

    const cascaded = [];
    // Cascade forward: later trips should have opening equal to previous trip closing,
    // and closed trips should have closing recomputed from their (new) opening + trip-linked operations.
    let prevClosing = Number(upd.rows[0]?.closing_liters || newClosing || 0);
    const laterTripsQ = await client.query(
      `SELECT * FROM public.truck_dispenser_trips
        WHERE truck_id=$1
          AND (reading_date > $2::date OR (reading_date = $2::date AND trip_no > $3))
        ORDER BY reading_date ASC, trip_no ASC
        FOR UPDATE`,
      [truckId, dateStr, tripNo]
    );

    for (const t of laterTripsQ.rows) {
      const tDate = isoDateOnly(t.reading_date);
      const tNo = Number(t.trip_no);
      const openingSaved = !!(t.opening_at || (t.opening_liters != null && Number(t.opening_liters) !== 0));
      const oldOpening = t.opening_liters != null ? Number(t.opening_liters) : null;
      const oldClosing = t.closing_liters != null ? Number(t.closing_liters) : null;

      let newOpening = oldOpening;
      if (openingSaved) {
        newOpening = round3(prevClosing);
      }

      let newClose = oldClosing;
      const closed = isTripClosedRow(t);
      if (closed && openingSaved) {
        const sums2 = await getTripOutSums(truckId, tNo, tDate);
        newClose = round3(Number(newOpening || 0) + Number(sums2.totalOut || 0));
      }

      const openingChanged = openingSaved && (newOpening != null) && (oldOpening == null || round3(oldOpening) !== round3(newOpening));
      const closingChanged = closed && openingSaved && (newClose != null) && (oldClosing == null || round3(oldClosing) !== round3(newClose));

      if (openingChanged || closingChanged) {
        const updParts = [];
        const updVals = [];
        let idx = 1;
        if (openingChanged) { updParts.push(`opening_liters=$${idx++}`); updVals.push(newOpening); }
        if (closingChanged) { updParts.push(`closing_liters=$${idx++}`); updVals.push(newClose); }
        updParts.push(`updated_at=NOW()`);
        updVals.push(t.id);
        const updatedTripQ = await client.query(
          `UPDATE public.truck_dispenser_trips SET ${updParts.join(', ')} WHERE id=$${idx} RETURNING *`,
          updVals
        );
        cascaded.push({
          id: t.id,
          reading_date: tDate,
          trip_no: tNo,
          opening_old: oldOpening,
          opening_new: openingChanged ? newOpening : oldOpening,
          closing_old: oldClosing,
          closing_new: closingChanged ? newClose : oldClosing,
        });
        const updatedTrip = updatedTripQ.rows[0] || t;
        if (isTripClosedRow(updatedTrip) && updatedTrip.closing_liters != null) {
          prevClosing = Number(updatedTrip.closing_liters);
        } else {
          break;
        }
      } else {
        // Carry forward using existing closing liters for continuity.
        if (isTripClosedRow(t) && t.closing_liters != null) {
          prevClosing = Number(t.closing_liters);
        } else {
          break;
        }
      }
    }

    await client.query('COMMIT');
    res.json({
      trip: upd.rows[0],
      computed: {
        opening_liters: opening,
        sales_out_liters: round3(sums.salesOut),
        transfers_out_liters: round3(sums.transfersOut),
        testing_out_liters: round3(sums.testingOut),
        closing_liters: newClosing,
      }
    });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    res.status(e.status || 500).json({ error: e.message });
  } finally { client.release(); }
});

// Fuel Ops audit (admin/owner)
app.get('/api/fuel-ops/audit', requireAuth, requireRole('OWNER','ADMIN'), async (req, res) => {
  try {
    const unitId = req.query.unit_id != null && req.query.unit_id !== '' ? parseInt(req.query.unit_id, 10) : null;
    const tab = req.query.tab ? String(req.query.tab) : null;
    const section = req.query.section ? String(req.query.section) : null;
    const action = req.query.action ? String(req.query.action) : null;
    const entityType = req.query.entity_type ? String(req.query.entity_type) : null;
    const opFrom = req.query.op_from ? isoDateOnly(req.query.op_from) : null;
    const opTo = req.query.op_to ? isoDateOnly(req.query.op_to) : null;
    // Default to including payloads because the Audit UI summarizes changes.
    const includePayload = String(req.query.include_payload || 'true').toLowerCase() === 'true';
    const limit = Math.min(Math.max(parseInt(req.query.limit || '200', 10), 1), 1000);
    const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);

    const where = [];
    const vals = [];
    let idx = 1;

    // This audit view is intentionally scoped to post-unfreeze edits only.
    // Keep the API focused on the sections the UI needs.
    const allowedSections = ['Freeze', 'Opening Reading', 'Closing Reading', 'Sales & Transfers'];
    where.push(`a.section = ANY($${idx++}::text[])`);
    vals.push(allowedSections);

    if (Number.isFinite(unitId) && unitId > 0) { where.push(`a.unit_id=$${idx++}`); vals.push(unitId); }
    if (tab) { where.push(`a.tab=$${idx++}`); vals.push(tab); }
    if (section) { where.push(`a.section=$${idx++}`); vals.push(section); }
    if (action) { where.push(`a.action=$${idx++}`); vals.push(action); }
    if (entityType) { where.push(`a.entity_type=$${idx++}`); vals.push(entityType); }
    if (opFrom) { where.push(`a.op_date >= $${idx++}::date`); vals.push(opFrom); }
    if (opTo) { where.push(`a.op_date <= $${idx++}::date`); vals.push(opTo); }

    const payloadCols = includePayload ? ', a.payload_old, a.payload_new' : '';
    vals.push(limit);
    vals.push(offset);
    const sql = `
      SELECT a.id,
             a.created_at,
             a.user_id,
             a.username AS performed_by,
             a.tab,
             a.section,
             a.action,
             a.entity_type,
             a.unit_id,
             su.unit_code AS unit_code,
             a.trip_id,
             a.trip_no,
             a.op_date,
             a.reason
             ${payloadCols}
        FROM public.fuel_ops_audit a
        LEFT JOIN public.storage_units su ON su.id = a.unit_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY a.created_at DESC
       LIMIT $${idx++} OFFSET $${idx++}
    `;
    const r = await pool.query(sql, vals);
    res.json({ items: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete a trip. Safety: allow deletion ONLY for the last trip of the day to avoid gaps.
app.delete('/api/fuel-ops/trips/:id', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
    const q = await client.query(`SELECT * FROM public.truck_dispenser_trips WHERE id=$1 FOR UPDATE`, [id]);
    if (!q.rows.length) return res.status(404).json({ error: 'not found' });
    const row = q.rows[0];
    if (isTripClosedRow(row) && !isPrivileged(req)) return res.status(403).json({ error: 'Locked: trip is closed' });
    if (row.is_frozen) return res.status(409).json({ error: 'Locked: trip is frozen. Unfreeze to delete.' });

    const m = await client.query(`SELECT MAX(trip_no) AS max_no FROM public.truck_dispenser_trips WHERE truck_id=$1 AND reading_date=$2`, [row.truck_id, row.reading_date]);
    const maxNo = Number(m.rows[0]?.max_no || 0);
    if (row.trip_no !== maxNo) return res.status(400).json({ error: 'only the last trip for the day can be deleted' });

    await client.query(`DELETE FROM public.truck_dispenser_trips WHERE id=$1`, [id]);
    await client.query('COMMIT');
    res.json({ ok: true, deleted_id: id });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    res.status(e.status || 500).json({ error: e.message });
  } finally { client.release(); }
});
// Upsert daily dispenser record
// Upsert daily dispenser record (migrated to use dispenser_day_reading_logs)
// This endpoint will create a day log entry and also create opening/closing meter snapshots.
app.post('/api/fuel-ops/day/dispenser', requireAuth, async (req, res) => {
  try {
    const { truck_id, date, opening_liters, closing_liters, opening_at, closing_at, note, driver_name, driver_code } = req.body || {};
    const truckId = parseInt(truck_id, 10);
    const dateStr = isoDateOnly(date || new Date());
    const open = Number(opening_liters);
    const close = (closing_liters == null) ? null : Number(closing_liters);
    if (!Number.isFinite(truckId) || truckId <= 0) return res.status(400).json({ error: 'truck_id required' });
    if (!Number.isFinite(open) || open < 0) return res.status(400).json({ error: 'opening_liters invalid' });
    if (close != null && (!Number.isFinite(close) || close < open)) return res.status(400).json({ error: 'closing_liters must be >= opening' });
    // Reject if record for same date exists (create-only)
    const exists = await pool.query(`SELECT 1 FROM public.dispenser_day_reading_logs WHERE truck_id=$1 AND reading_date=$2`, [truckId, dateStr]);
    if (exists.rowCount > 0) {
      const [y,m,d] = dateStr.split('-');
      return res.status(409).json({ error: `readings are submitted for ${d}/${m}/${y}. to edit go to edit button.` });
    }
    // Normalize timestamps (keep local wall clock as-entered)
    const openingSql = (opening_at && isValidDateTimeString(String(opening_at)))
      ? (coerceLocalSqlTimestamp(String(opening_at)) || String(opening_at).replace('T', ' ').slice(0, 19))
      : `${dateStr} 00:00:00`;
    const closingSql = (close != null && closing_at && isValidDateTimeString(String(closing_at)))
      ? (coerceLocalSqlTimestamp(String(closing_at)) || String(closing_at).replace('T', ' ').slice(0, 19))
      : null;
    const su = await pool.query(`SELECT unit_code FROM public.storage_units WHERE id=$1`, [truckId]);
    const truckCode = su.rows.length ? su.rows[0].unit_code : null;
    const r = await pool.query(
      `INSERT INTO public.dispenser_day_reading_logs (truck_id, truck_code, reading_date, opening_liters, closing_liters, opening_at, closing_at, note, driver_name, driver_code, created_by, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [truckId, truckCode, dateStr, open, close, openingSql, closingSql, note || null, driver_name || null, driver_code || null, getActor(req), req.user?.sub || null]
    );
    // Also create opening/closing snapshots if closing provided
    try {
      await pool.query(`INSERT INTO public.truck_dispenser_meter_snapshots (truck_id, reading_at, reading_liters, source, note, created_by, created_by_user_id) VALUES ($1,$2,$3,'OPENING',$4,$5,$6)`, [truckId, openingSql, open, 'Opening snapshot', getActor(req), req.user?.sub || null]);
      if (closingSql) await pool.query(`INSERT INTO public.truck_dispenser_meter_snapshots (truck_id, reading_at, reading_liters, source, note, created_by, created_by_user_id) VALUES ($1,$2,$3,'CLOSING',$4,$5,$6)`, [truckId, closingSql, close, 'Closing snapshot', getActor(req), req.user?.sub || null]);
    } catch (e) { if (!process.env.SUPPRESS_DB_LOG) console.warn('[snapshots insert warn]', e.message); }
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// New: Day reading logs CRUD for dispenser_day_reading_logs
app.get('/api/fuel-ops/day/logs', requireAuth, async (req, res) => {
  try {
    const truckId = parseInt(req.query.truck_id, 10);
    const dateStr = isoDateOnly(req.query.date || new Date());
    if (!Number.isFinite(truckId) || truckId <= 0) return res.status(400).json({ error: 'truck_id required' });
    if (!dateStr) return res.status(400).json({ error: 'invalid date' });
    const r = await pool.query(
      `SELECT id,
              truck_id,
              reading_date,
              opening_liters,
              closing_liters,
              opening_at::text AS opening_at,
              closing_at::text AS closing_at,
              note,
              driver_name,
              driver_code,
              created_by,
              created_by_user_id,
              created_at::text AS created_at,
              updated_at::text AS updated_at
         FROM public.dispenser_day_reading_logs
        WHERE truck_id=$1 AND reading_date=$2`,
      [truckId, dateStr]
    );
    res.json(r.rows[0] || null);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/fuel-ops/day/logs/list', requireAuth, async (req, res) => {
  try {
    const truckId = parseInt(req.query.truck_id, 10);
    if (!Number.isFinite(truckId) || truckId <= 0) return res.status(400).json({ error: 'truck_id required' });
    const limitRaw = (req.query.limit != null && req.query.limit !== '') ? parseInt(req.query.limit, 10) : null;
    const limit = (Number.isFinite(limitRaw) && limitRaw > 0) ? Math.min(limitRaw, 1000) : null;

    const sql = `SELECT id,
              truck_id,
              reading_date,
              opening_liters,
              closing_liters,
              opening_at::text AS opening_at,
              closing_at::text AS closing_at,
              note,
              driver_name,
              driver_code,
              created_by,
              created_by_user_id,
              created_at::text AS created_at,
              updated_at::text AS updated_at
         FROM public.dispenser_day_reading_logs
        WHERE truck_id=$1
        ORDER BY reading_date DESC${limit ? ' LIMIT $2' : ''}`;

    const r = await pool.query(sql, limit ? [truckId, limit] : [truckId]);
    res.json({ items: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/fuel-ops/day/logs', requireAuth, async (req, res) => {
  try {
    const { truck_id, date, opening_liters, closing_liters, opening_at, closing_at, note, driver_name, driver_code } = req.body || {};
    const truckId = parseInt(truck_id, 10);
    const dateStr = isoDateOnly(date || new Date());
    const open = Number(opening_liters);
    const close = (closing_liters == null) ? null : Number(closing_liters);
    if (!Number.isFinite(truckId) || truckId <= 0) return res.status(400).json({ error: 'truck_id required' });
    if (!Number.isFinite(open) || open < 0) return res.status(400).json({ error: 'opening_liters invalid' });
    if (close != null && (!Number.isFinite(close) || close < open)) return res.status(400).json({ error: 'closing_liters must be >= opening' });
    // Reject if record for same date exists (create-only)
    const exists = await pool.query(`SELECT 1 FROM public.dispenser_day_reading_logs WHERE truck_id=$1 AND reading_date=$2`, [truckId, dateStr]);
    if (exists.rowCount > 0) return res.status(409).json({ error: 'readings already submitted for this date' });
    // Normalize timestamps: coerce user-entered values to local SQL timestamp strings
    let openingSql = null;
    let closingSql = null;
    // Resolve truck_code for easier lookups and to store denormalized code
    let truckCode = null;
    try {
      const su = await pool.query(`SELECT unit_code FROM public.storage_units WHERE id=$1`, [truckId]);
      truckCode = su.rows.length ? su.rows[0].unit_code : null;
    } catch (e) { if (!process.env.SUPPRESS_DB_LOG) console.warn('[day/logs truck_code lookup warn]', e.message); }
    if (opening_at) openingSql = coerceLocalSqlTimestamp(String(opening_at));
    if (!openingSql) openingSql = `${dateStr} 00:00:00`;
    if (closing_at) closingSql = coerceLocalSqlTimestamp(String(closing_at));
    // closingSql may remain null if no closing provided
    const r = await pool.query(
      `INSERT INTO public.dispenser_day_reading_logs (truck_id, truck_code, reading_date, opening_liters, closing_liters, opening_at, closing_at, note, driver_name, driver_code, created_by, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id,
                 truck_id,
                 reading_date,
                 opening_liters,
                 closing_liters,
                 opening_at::text AS opening_at,
                 closing_at::text AS closing_at,
                 note,
                 driver_name,
                 driver_code,
                 created_by,
                 created_by_user_id,
                 created_at::text AS created_at,
                 updated_at::text AS updated_at`,
      [truckId, truckCode, dateStr, open, close, openingSql, closingSql, note || null, driver_name || null, driver_code || null, getActor(req), req.user?.sub || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/fuel-ops/day/logs/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
    const { opening_liters, closing_liters, opening_at, closing_at, note } = req.body || {};

    const oldQ = await pool.query(
      `SELECT id,
              truck_id,
              reading_date,
              opening_liters,
              closing_liters,
              opening_at::text AS opening_at,
              closing_at::text AS closing_at,
              note,
              driver_name,
              driver_code,
              created_by,
              created_by_user_id,
              created_at::text AS created_at,
              updated_at::text AS updated_at
         FROM public.dispenser_day_reading_logs
        WHERE id=$1`,
      [id]
    );
    if (!oldQ.rows.length) return res.status(404).json({ error: 'not found' });
    const oldRow = oldQ.rows[0];

    const parts = [];
    const vals = [];
    let idx = 1;
    if (opening_liters != null) {
      const v = parseLiters3(opening_liters);
      if (!Number.isFinite(v)) return res.status(400).json({ error: 'invalid opening_liters' });
      parts.push(`opening_liters=$${idx++}`);
      vals.push(v);
    }
    if (closing_liters != null) {
      const v = parseLiters3(closing_liters);
      if (!Number.isFinite(v)) return res.status(400).json({ error: 'invalid closing_liters' });
      parts.push(`closing_liters=$${idx++}`);
      vals.push(v);
    }
    if (opening_at) {
      const coerced = coerceLocalSqlTimestamp(String(opening_at));
      parts.push(`opening_at=$${idx++}`);
      vals.push(coerced || String(opening_at).replace('T',' ').slice(0,19));
    }
    if (closing_at) {
      const coerced = coerceLocalSqlTimestamp(String(closing_at));
      parts.push(`closing_at=$${idx++}`);
      vals.push(coerced || String(closing_at).replace('T',' ').slice(0,19));
    }
    if (note !== undefined) { parts.push(`note=$${idx++}`); vals.push(note || null); }
    if (!parts.length) return res.status(400).json({ error: 'no fields to update' });
    parts.push(`updated_at=NOW()`);
    vals.push(id);
    const r = await pool.query(
      `UPDATE public.dispenser_day_reading_logs
          SET ${parts.join(', ')}
        WHERE id=$${idx}
    RETURNING id,
              truck_id,
              reading_date,
              opening_liters,
              closing_liters,
              opening_at::text AS opening_at,
              closing_at::text AS closing_at,
              note,
              driver_name,
              driver_code,
              created_by,
              created_by_user_id,
              created_at::text AS created_at,
              updated_at::text AS updated_at`,
      vals
    );
    if (!r.rows.length) return res.status(404).json({ error: 'not found' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete a day reading log by id
app.delete('/api/fuel-ops/day/logs/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
    const del = await pool.query(
      `DELETE FROM public.dispenser_day_reading_logs
        WHERE id=$1
    RETURNING id,
              truck_id,
              reading_date,
              opening_liters,
              closing_liters,
              opening_at::text AS opening_at,
              closing_at::text AS closing_at,
              note,
              driver_name,
              driver_code,
              created_by,
              created_by_user_id,
              created_at::text AS created_at,
              updated_at::text AS updated_at`,
      [id]
    );
    if (!del.rows.length) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, deleted_id: del.rows[0].id, truck_id: del.rows[0].truck_id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Edit daily dispenser record (allow updating closing liters, times, testing, note, driver fields)
// Edit daily dispenser record (migrated to operate on dispenser_day_reading_logs)
app.patch('/api/fuel-ops/day/dispenser', requireAuth, async (req, res) => {
  try {
    const { truck_id, date, opening_liters, closing_liters, opening_at, closing_at, note, driver_name, driver_code } = req.body || {};
    const truckId = parseInt(truck_id, 10);
    const dateStr = isoDateOnly(date || new Date());
    if (!Number.isFinite(truckId) || truckId <= 0) return res.status(400).json({ error: 'truck_id required' });
    const existingQ = await pool.query(`SELECT * FROM public.dispenser_day_reading_logs WHERE truck_id=$1 AND reading_date=$2`, [truckId, dateStr]);
    if (!existingQ.rows.length) return res.status(404).json({ error: 'day reading not found' });
    const existing = existingQ.rows[0];
    const open = opening_liters != null ? Number(opening_liters) : Number(existing.opening_liters);
    const close = closing_liters != null ? Number(closing_liters) : Number(existing.closing_liters);
    if (!Number.isFinite(open) || open < 0) return res.status(400).json({ error: 'opening_liters invalid' });
    if (close != null && (!Number.isFinite(close) || close < open)) return res.status(400).json({ error: 'closing_liters must be >= opening' });
    // Parse/normalize timestamps (optional updates) without timezone conversion
    const resolvedOpeningAt = opening_at != null ? String(opening_at) : (existing.opening_at ? String(existing.opening_at) : `${dateStr} 00:00:00`);
    const resolvedClosingAt = closing_at != null ? String(closing_at) : (existing.closing_at ? String(existing.closing_at) : null);
    const openingSql = coerceLocalSqlTimestamp(resolvedOpeningAt) || resolvedOpeningAt.replace('T', ' ').slice(0, 19);
    const closingSql = resolvedClosingAt ? (coerceLocalSqlTimestamp(resolvedClosingAt) || resolvedClosingAt.replace('T', ' ').slice(0, 19)) : null;
    const parts = [];
    const vals = [];
    let idx = 1;
    parts.push(`opening_liters=$${idx++}`); vals.push(open);
    parts.push(`closing_liters=$${idx++}`); vals.push(close != null ? close : null);
    parts.push(`opening_at=$${idx++}`); vals.push(openingSql);
    parts.push(`closing_at=$${idx++}`); vals.push(closingSql);
    parts.push(`note=$${idx++}`); vals.push(note != null ? note : existing.note);
    parts.push(`driver_name=$${idx++}`); vals.push(driver_name != null ? driver_name : existing.driver_name);
    parts.push(`driver_code=$${idx++}`); vals.push(driver_code != null ? driver_code : existing.driver_code);
    parts.push(`updated_at=NOW()`);
    vals.push(truckId); vals.push(dateStr);
    const upd = await pool.query(`UPDATE public.dispenser_day_reading_logs SET ${parts.join(', ')} WHERE truck_id=$${idx++} AND reading_date=$${idx} RETURNING *`, vals);
    if (!upd.rows.length) return res.status(404).json({ error: 'not found' });
    // Optionally create adjustment snapshots when opening/closing changed
    try {
      const changedOpening = open !== Number(existing.opening_liters);
      const changedClosing = (close != null && close !== Number(existing.closing_liters));
      if (changedOpening) {
        await pool.query(`INSERT INTO public.truck_dispenser_meter_snapshots (truck_id, reading_at, reading_liters, source, note, created_by, created_by_user_id) VALUES ($1,$2,$3,'OPENING_EDIT',$4,$5,$6)`, [truckId, openingSql, open, 'Edited opening liters', getActor(req), req.user?.sub || null]);
      }
      if (changedClosing) {
        await pool.query(`INSERT INTO public.truck_dispenser_meter_snapshots (truck_id, reading_at, reading_liters, source, note, created_by, created_by_user_id) VALUES ($1,$2,$3,'CLOSING_EDIT',$4,$5,$6)`, [truckId, closingSql, close, 'Edited closing liters', getActor(req), req.user?.sub || null]);
      }
    } catch (e) { if (!process.env.SUPPRESS_DB_LOG) console.warn('[edit snapshots warn]', e.message); }
    res.json(upd.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function csvEscape(value) {
  if (value == null) return '';
  const s = String(value);
  if (/[\r\n,"]/g.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// Truck dispenser meter snapshots: create & list
app.post('/api/fuel-ops/meter-snapshots', requireAuth, async (req, res) => {
  try {
    const { truck_id, reading_liters, reading_at, note } = req.body || {};
    const tid = parseInt(truck_id, 10);
    const val = round3(Number(reading_liters));
    if (!Number.isFinite(tid) || tid <= 0) return res.status(400).json({ error: 'truck_id required' });
    if (!Number.isFinite(val) || val < 0) return res.status(400).json({ error: 'reading_liters must be >= 0' });
    // Preserve user-entered local date/time exactly as a wall-clock timestamp (no UTC shift)
    let tsSql = null;
    if (reading_at) {
      if (!isValidDateTimeString(String(reading_at))) return res.status(400).json({ error: 'reading_at invalid' });
      tsSql = coerceLocalSqlTimestamp(String(reading_at));
      if (!tsSql) return res.status(400).json({ error: 'reading_at invalid' });
    } else {
      tsSql = fmtSqlTsLocal(new Date());
    }
    const su = await pool.query(`SELECT id, unit_type FROM public.storage_units WHERE id=$1`, [tid]);
    if (!su.rows.length) return res.status(400).json({ error: 'Unknown storage unit' });
    if (!['TRUCK','DATUM'].includes(su.rows[0].unit_type)) {
      return res.status(400).json({ error: 'Unsupported unit type for meter snapshot' });
    }
    const r = await pool.query(`
      INSERT INTO public.truck_dispenser_meter_snapshots (truck_id, reading_at, reading_liters, source, note, created_by, created_by_user_id)
      VALUES ($1,$2,$3,'SNAPSHOT',$4,$5,$6)
      RETURNING id,
                truck_id,
                to_char(reading_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS reading_at,
                reading_liters,
                source,
                note,
                to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS created_at
    `, [tid, tsSql, val, note || null, getActor(req), req.user?.sub || null]);
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/fuel-ops/meter-snapshots', requireAuth, async (req, res) => {
  try {
    const tid = parseInt(req.query.truck_id, 10);
    const fromStr = req.query.from ? String(req.query.from) : null;
    const toStr = req.query.to ? String(req.query.to) : null;
    const limit = Math.max(1, Math.min(1000, parseInt(req.query.limit || '200', 10) || 200));
    if (!Number.isFinite(tid) || tid <= 0) return res.status(400).json({ error: 'truck_id required' });
    const params = [tid];
    let where = ' WHERE truck_id = $1';
    if (fromStr && isValidDateTimeString(fromStr)) {
      const fSql = coerceLocalSqlTimestamp(fromStr);
      if (fSql) { params.push(fSql); where += ` AND reading_at >= $${params.length}`; }
    }
    if (toStr && isValidDateTimeString(toStr)) {
      const tSql = coerceLocalSqlTimestamp(toStr);
      if (tSql) { params.push(tSql); where += ` AND reading_at <= $${params.length}`; }
    }
    const sql = `SELECT id,
              truck_id,
              to_char(reading_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS reading_at,
              reading_liters,
              source,
              note,
              to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS created_at
                   FROM public.truck_dispenser_meter_snapshots
                   ${where}
                   ORDER BY reading_at DESC
                   LIMIT ${limit}`;
    const r = await pool.query(sql, params);
    res.json({ items: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Daily reconciliation for a truck and date
app.get('/api/fuel-ops/reconcile/daily', requireAuth, async (req, res) => {
  try {
    const truckId = parseInt(req.query.truck_id, 10);
    const dateStr = isoDateOnly(req.query.date || new Date());
    if (!Number.isFinite(truckId) || truckId <= 0) return res.status(400).json({ error: 'truck_id required' });
    if (!dateStr) return res.status(400).json({ error: 'date invalid' });

    // We'll prefer sources in this order:
    // 1) dispenser_day_reading_logs (authoritative operator-entered logs)
    // 2) truck_dispenser_meter_snapshots (preferred local snapshot near day bounds)
    // 3) trip-level readings (earliest opening_at and latest closing_at recorded for trips on that date)
    // 4) fallback to day bounds (00:00:00 / 23:59:59)

    // Use dispenser_day_reading_logs as the authoritative source for opening/closing readings.
    // The legacy `truck_dispenser_day_readings` table is no longer required for reconciliation.
    let O = 0, C = 0; // opening and closing meter liters
    let openSQL = null, closeSQL = null; // SQL-local timestamp window strings
    let meterDeltaAvailable = false;

    let Lrow = null;
    try {
      const logsQ = await pool.query(`SELECT * FROM public.dispenser_day_reading_logs WHERE truck_id=$1 AND reading_date=$2`, [truckId, dateStr]);
      if (logsQ.rows.length) {
        Lrow = logsQ.rows[0];
        O = Number(Lrow.opening_liters || 0);
        C = Number(Lrow.closing_liters || 0);
        meterDeltaAvailable = (Lrow.opening_liters != null && Lrow.closing_liters != null);
        openSQL = Lrow.opening_at ? toSqlLocalTs(Lrow.opening_at) : `${dateStr} 00:00:00`;
        closeSQL = Lrow.closing_at ? toSqlLocalTs(Lrow.closing_at) : `${dateStr} 23:59:59`;
      }
    } catch (e) {
      if (!process.env.SUPPRESS_DB_LOG) console.warn('[reconcile logs lookup warn]', e.message);
      // leave O/C as 0 and fall through to day bounds fallback below
    }

    // Helper day bounds
    const dayStart = `${dateStr} 00:00:00`;
    const dayEnd = `${dateStr} 23:59:59`;

    // If logs didn't provide timestamps/values, we'll fall back to day bounds below and leave
    // meterDeltaAvailable=false which signals the UI that meter-derived delta is unavailable.

    // Final fallback: if openSQL/closeSQL still missing, use day bounds
    if (!openSQL) openSQL = dayStart;
    if (!closeSQL) closeSQL = dayEnd;
    // Sales within window
    const salesQ = await pool.query(`
      SELECT COALESCE(SUM(sale_volume_liters),0)::numeric AS s
        FROM public.fuel_sale_transfers
       WHERE from_unit_id=$1 AND performed_at >= $2::timestamp AND performed_at <= $3::timestamp
    `, [truckId, openSQL, closeSQL]);
    const S = Number(salesQ.rows[0]?.s || 0);
    // Internal transfers out/in
    const toutQ = await pool.query(`
      SELECT COALESCE(SUM(transfer_volume),0)::numeric AS t
        FROM public.fuel_internal_transfers
       WHERE from_unit_id=$1 AND COALESCE(activity,'') <> 'TESTING' AND (transfer_date::timestamp + transfer_time) >= $2::timestamp AND (transfer_date::timestamp + transfer_time) <= $3::timestamp
    `, [truckId, openSQL, closeSQL]);
    const tinQ = await pool.query(`
      SELECT COALESCE(SUM(transfer_volume),0)::numeric AS t
        FROM public.fuel_internal_transfers
       WHERE to_unit_id=$1 AND COALESCE(activity,'') <> 'TESTING' AND (transfer_date::timestamp + transfer_time) >= $2::timestamp AND (transfer_date::timestamp + transfer_time) <= $3::timestamp
    `, [truckId, openSQL, closeSQL]);
    const T_out = Number(toutQ.rows[0]?.t || 0);
    const T_in = Number(tinQ.rows[0]?.t || 0);
    // Include any testing transfers logged as internal transfers for this truck in the same window
    const testingTransfersQ = await pool.query(
      `SELECT COALESCE((SELECT SUM(transfer_volume_liters) FROM public.testing_self_transfers WHERE from_unit_id=$1 AND performed_at >= $2::timestamp AND performed_at <= $3::timestamp),0) AS t`,
      [truckId, openSQL, closeSQL]
    );
    const T_test = (Lrow ? Number(Lrow.testing_used_liters || 0) : 0) + Number(testingTransfersQ.rows[0]?.t || 0);
    const deltaM = meterDeltaAvailable ? Number((C - O).toFixed(3)) : null;
    // Dispenser meters only increase on outflow (sales, transfers out, testing). Transfer-in does not affect the meter.
    const deltaE = Number((S + T_out + T_test).toFixed(3));
    const delta = (deltaM == null) ? null : Number((deltaM - deltaE).toFixed(3));
    // Human-readable note about discrepancy
    let note = null;
    if (delta == null) {
      note = 'Meter delta unavailable (no day reading or insufficient snapshots)';
    } else if (delta > 0) {
      note = `Meter reading is more by ${Math.abs(delta)} than transfers and sales`;
    } else if (delta < 0) {
      note = `Meter reading is less by ${Math.abs(delta)} than transfers and sales`;
    } else {
      note = 'Meter matches transfers and sales';
    }
    res.json({
      truck_id: truckId,
      date: dateStr,
      opening: O,
      opening_at: openSQL,
      closing: C,
      closing_at: closeSQL,
      sales: S,
      transfers_out: T_out,
      transfers_in: T_in,
      testing_used_liters: T_test,
      delta_meter: deltaM,
      delta_expected: deltaE,
      delta_difference: delta,
      note
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Off-hours summary between two timestamps for a truck
// [ARCHIVED 2026-02-19] GET /api/fuel-ops/offhours -- moved to legacy-monolith-backup/routes/archived_unused_handlers.js

// Get existing daily odometer record
app.get('/api/fuel-ops/day/odometer', requireAuth, async (req, res) => {
  try {
    const truckId = parseInt(req.query.truck_id, 10);
    const dateStr = isoDateOnly(req.query.date || new Date());
    const r = await pool.query(`SELECT * FROM public.truck_odometer_day_readings WHERE truck_id=$1 AND reading_date=$2`, [truckId, dateStr]);
    res.json(r.rows[0] || null);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Upsert daily odometer record
app.post('/api/fuel-ops/day/odometer', requireAuth, async (req, res) => {
  try {
    const { truck_id, date, opening_km, closing_km, note, driver_name, driver_code, opening_time, closing_time, opening_at, closing_at } = req.body || {};
    const truckId = parseInt(truck_id, 10);
    const dateStr = isoDateOnly(date || new Date());
    const open = Number(opening_km);
    const close = Number(closing_km);
    if (!Number.isFinite(truckId) || truckId <= 0) return res.status(400).json({ error: 'truck_id required' });
    if (!Number.isFinite(open) || open < 0) return res.status(400).json({ error: 'opening_km invalid' });
    if (!Number.isFinite(close) || close < open) return res.status(400).json({ error: 'closing_km must be >= opening' });
    const exists = await pool.query(`SELECT 1 FROM public.truck_odometer_day_readings WHERE truck_id=$1 AND reading_date=$2`, [truckId, dateStr]);
    if (exists.rowCount > 0) {
      const [y,m,d] = dateStr.split('-');
      return res.status(409).json({ error: `readings are submitted for ${d}/${m}/${y}. to edit go to edit button.` });
    }
    // derive opening_at/closing_at from HH:mm or full timestamp
    function buildTs(hhmm, overrideTs) {
      try {
        if (overrideTs) return new Date(overrideTs);
        const t = (hhmm || '').toString().trim();
        if (!t) return null;
        const [hh, mm] = t.split(':');
        if (hh == null || mm == null) return null;
        return new Date(`${dateStr}T${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:00`);
      } catch { return null; }
    }
    const openingAtTs = buildTs(opening_time, opening_at);
    const closingAtTs = buildTs(closing_time, closing_at);
    const r = await pool.query(
      `INSERT INTO public.truck_odometer_day_readings (truck_id, reading_date, opening_km, closing_km, note, driver_name, driver_code, opening_at, closing_at, created_by, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [truckId, dateStr, open, close, note || null, driver_name || null, driver_code || null, openingAtTs, closingAtTs, getActor(req), req.user?.sub || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Edit daily odometer record
app.patch('/api/fuel-ops/day/odometer', requireAuth, async (req, res) => {
  try {
    const { truck_id, date, opening_km, closing_km, note, driver_name, driver_code, opening_time, closing_time, opening_at, closing_at } = req.body || {};
    const truckId = parseInt(truck_id, 10);
    const dateStr = isoDateOnly(date || new Date());
    if (!Number.isFinite(truckId) || truckId <= 0) return res.status(400).json({ error: 'truck_id required' });
    const existingQ = await pool.query(`SELECT * FROM public.truck_odometer_day_readings WHERE truck_id=$1 AND reading_date=$2`, [truckId, dateStr]);
    if (!existingQ.rows.length) return res.status(404).json({ error: 'day reading not found' });
    const existing = existingQ.rows[0];
    const open = opening_km != null ? Number(opening_km) : Number(existing.opening_km);
    const close = closing_km != null ? Number(closing_km) : Number(existing.closing_km);
    if (!Number.isFinite(open) || open < 0) return res.status(400).json({ error: 'opening_km invalid' });
    if (!Number.isFinite(close) || close < open) return res.status(400).json({ error: 'closing_km must be >= opening' });
    function buildTs(hhmm, overrideTs, fallback) {
      try {
        if (overrideTs != null) return new Date(overrideTs);
        const t = (hhmm || '').toString().trim();
        if (!t) return fallback;
        const [hh, mm] = t.split(':');
        if (hh == null || mm == null) return fallback;
        return new Date(`${dateStr}T${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:00`);
      } catch { return fallback; }
    }
    const openingAtTs = buildTs(opening_time, opening_at, existing.opening_at || null);
    const closingAtTs = buildTs(closing_time, closing_at, existing.closing_at || null);
    const upd = await pool.query(`
      UPDATE public.truck_odometer_day_readings
         SET opening_km=$3,
             closing_km=$4,
             note=$5,
             driver_name=$6,
             driver_code=$7,
             opening_at=$8,
             closing_at=$9,
             updated_at=NOW()
       WHERE truck_id=$1 AND reading_date=$2
       RETURNING *
    `, [truckId, dateStr, open, close, note != null ? note : existing.note, driver_name != null ? driver_name : existing.driver_name, driver_code != null ? driver_code : existing.driver_code, openingAtTs, closingAtTs]);
    res.json(upd.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// List daily odometer records for a truck (descending by date)
app.get('/api/fuel-ops/day/odometer/list', requireAuth, async (req, res) => {
  try {
    const truckId = parseInt(req.query.truck_id, 10);
    const limit = Math.max(1, Math.min(365, parseInt(req.query.limit || '90', 10) || 90));
    if (!Number.isFinite(truckId) || truckId <= 0) return res.status(400).json({ error: 'truck_id required' });
    const r = await pool.query(`SELECT id, truck_id, reading_date, opening_km, closing_km, opening_at, closing_at, note, driver_name, driver_code, created_at, updated_at
                                  FROM public.truck_odometer_day_readings
                                 WHERE truck_id=$1
                                 ORDER BY reading_date DESC
                                 LIMIT $2`, [truckId, limit]);
    res.json({ items: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete a daily odometer record (by id or truck/date)
app.delete('/api/fuel-ops/day/odometer', requireAuth, async (req, res) => {
  try {
    const idRaw = req.query.id;
    if (idRaw) {
      const id = parseInt(idRaw, 10);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
      const del = await pool.query(`DELETE FROM public.truck_odometer_day_readings WHERE id=$1 RETURNING id`, [id]);
      if (!del.rows.length) return res.status(404).json({ error: 'not found' });
      return res.json({ ok: true, deleted_id: id });
    }
    const truckId = parseInt(req.query.truck_id, 10);
    const dateStr = isoDateOnly(req.query.date || new Date());
    if (!Number.isFinite(truckId) || truckId <= 0) return res.status(400).json({ error: 'truck_id required' });
    const del = await pool.query(`DELETE FROM public.truck_odometer_day_readings WHERE truck_id=$1 AND reading_date=$2 RETURNING id`, [truckId, dateStr]);
    if (!del.rows.length) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, deleted_id: del.rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =========================
// Listing endpoints for Loads subtabs
// =========================

// Determine fuel_lots date column name at runtime (supports load_date vs loaded_date)
let FUEL_LOTS_DATE_COL = null;
async function resolveFuelLotsDateCol() {
  if (FUEL_LOTS_DATE_COL) return FUEL_LOTS_DATE_COL;
  try {
    const q = await pool.query(
      `SELECT column_name FROM information_schema.columns
         WHERE table_schema='public' AND table_name='fuel_lots'
           AND column_name IN ('load_date','loaded_date')
         ORDER BY CASE column_name WHEN 'load_date' THEN 1 ELSE 2 END LIMIT 1`
    );
    FUEL_LOTS_DATE_COL = (q.rows[0] && q.rows[0].column_name) || 'loaded_date';
  } catch { FUEL_LOTS_DATE_COL = 'loaded_date'; }
  return FUEL_LOTS_DATE_COL;
}

// Recent lots for a unit (tanker or datum)
app.get('/api/fuel-ops/lots/list', requireAuth, async (req, res) => {
  try {
    const dateCol = await resolveFuelLotsDateCol();
    const unitIdRaw = req.query.unit_id;
    const unitId = unitIdRaw != null ? parseInt(unitIdRaw, 10) : null;
    const from = req.query.from ? isoDateOnly(req.query.from) : null;
    const to = req.query.to ? isoDateOnly(req.query.to) : null;
    if (req.query.from && !from) return res.status(400).json({ error: 'from invalid' });
    if (req.query.to && !to) return res.status(400).json({ error: 'to invalid' });
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit || '50', 10) || 50));
    const loadType = (req.query.load_type || '').toString().toUpperCase(); // PURCHASE | EMPTY_TRANSFER
    const unitType = (req.query.unit_type || '').toString().toUpperCase(); // TRUCK | DATUM
    // When unit_id omitted, return recent lots across all TRUCK/DATUM units (active only)
    let params = [];
    let sqlBase = `FROM public.fuel_lots fl
                   JOIN public.storage_units su ON su.id = fl.unit_id
                  WHERE su.active=TRUE`;
    if (unitType && ['TRUCK','DATUM'].includes(unitType)) {
      params.push(unitType);
      sqlBase += ` AND su.unit_type = $${params.length}`;
    } else {
      sqlBase += ` AND su.unit_type IN ('TRUCK','DATUM')`;
    }
    if (loadType && ['PURCHASE','EMPTY_TRANSFER'].includes(loadType)) {
      params.push(loadType);
      sqlBase += ` AND COALESCE(fl.load_type, 'PURCHASE') = $${params.length}`;
    }
    // Extended computed columns for purchase display:
    // remaining_liters: clamp to 0 when SOLD else loaded - used (no inbound adds considered here; UI wants purchase perspective)
    // transfer_volume_liters: when SOLD and used > loaded (indicates tanker-to-tanker transfers increasing used counter beyond initial load)
    // transfer_to_unit_codes: list of distinct destination tanker codes this lot transferred to
  // Use the detected date column and expose as load_date for the UI.
  const selectCols = `SELECT fl.id, fl.unit_id,
                 fl.${dateCol}::date AS load_date,
                 fl.loaded_liters, fl.used_liters, fl.stock_status,
                 fl.lot_code_created AS lot_code_initial, fl.created_at::text AS created_at, fl.load_time::text AS load_time,
                 COALESCE(fl.load_type, 'PURCHASE') AS load_type,
                 su.unit_code, su.unit_type,
                               CASE WHEN fl.stock_status='SOLD' THEN 0 ELSE GREATEST(0, fl.loaded_liters - fl.used_liters) END AS remaining_liters,
                               (
                                 SELECT COALESCE(SUM(fit.transfer_volume) FILTER (WHERE COALESCE(fit.activity,'') <> 'TESTING'),0)
                                   FROM public.fuel_internal_transfers fit
                                  WHERE fit.to_lot_id = fl.id
                               ) AS transfer_volume_liters,
                               (
                                 SELECT string_agg(DISTINCT fit.to_unit_code, ',')
                                   FROM public.fuel_internal_transfers fit
                                 WHERE fit.from_lot_id = fl.id AND fit.to_unit_code IS NOT NULL
                               ) AS transfer_to_unit_codes`;
    if (Number.isFinite(unitId) && unitId > 0) {
      // Reset params for clarity per-branch
      const p = [unitId];
      let where = ' WHERE fl.unit_id=$1';
      if (loadType && ['PURCHASE','EMPTY_TRANSFER'].includes(loadType)) {
        p.push(loadType); where += ` AND COALESCE(fl.load_type, 'PURCHASE') = $${p.length}`;
      }
      if (from) { p.push(from); where += ` AND fl.${dateCol}::date >= $${p.length}::date`; }
      if (to) { p.push(to); where += ` AND fl.${dateCol}::date <= $${p.length}::date`; }
  const sql = `${selectCols}
       FROM public.fuel_lots fl
       JOIN public.storage_units su ON su.id = fl.unit_id
       ${where}
       ORDER BY COALESCE(fl.load_time, fl.created_at) DESC, fl.id DESC
       LIMIT ${limit}`;
      const r = await pool.query(sql, p);
      return res.json({ items: r.rows });
    }
    // All units path
    if (from) { params.push(from); sqlBase += ` AND fl.${dateCol}::date >= $${params.length}::date`; }
    if (to) { params.push(to); sqlBase += ` AND fl.${dateCol}::date <= $${params.length}::date`; }
  const sql = `${selectCols}
         ${sqlBase}
         ORDER BY COALESCE(fl.load_time, fl.created_at) DESC, fl.id DESC
         LIMIT ${limit}`;
    const r = await pool.query(sql, params);
    return res.json({ items: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Export lots list to CSV (same filters as /lots/list)
app.get('/api/fuel-ops/lots/export', requireAuth, async (req, res) => {
  try {
    const dateCol = await resolveFuelLotsDateCol();
    const unitId = req.query.unit_id ? parseInt(req.query.unit_id, 10) : null;
    if (req.query.unit_id && (!Number.isFinite(unitId) || unitId <= 0)) return res.status(400).send('unit_id invalid');
    const from = req.query.from ? isoDateOnly(req.query.from) : null;
    const to = req.query.to ? isoDateOnly(req.query.to) : null;
    if (req.query.from && !from) return res.status(400).send('from invalid');
    if (req.query.to && !to) return res.status(400).send('to invalid');
    const loadType = (req.query.load_type || '').toString().toUpperCase();
    const unitType = (req.query.unit_type || '').toString().toUpperCase();

    const params = [];
    const where = [];
    let idx = 1;

    // active units only
    where.push('su.active=TRUE');
    if (unitType && ['TRUCK', 'DATUM'].includes(unitType)) {
      where.push(`su.unit_type = $${idx++}`);
      params.push(unitType);
    } else {
      where.push("su.unit_type IN ('TRUCK','DATUM')");
    }
    if (loadType && ['PURCHASE', 'EMPTY_TRANSFER'].includes(loadType)) {
      where.push(`COALESCE(fl.load_type, 'PURCHASE') = $${idx++}`);
      params.push(loadType);
    }
    if (Number.isFinite(unitId) && unitId > 0) {
      where.push(`fl.unit_id = $${idx++}::int`);
      params.push(unitId);
    }
    if (from) {
      where.push(`fl.${dateCol}::date >= $${idx++}::date`);
      params.push(from);
    }
    if (to) {
      where.push(`fl.${dateCol}::date <= $${idx++}::date`);
      params.push(to);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const q = await pool.query(
      `
      SELECT fl.id,
             fl.lot_code_created AS lot_code,
             su.unit_code,
             fl.${dateCol}::date AS load_date,
             fl.load_time::text AS load_time,
             fl.loaded_liters,
             fl.used_liters,
             CASE WHEN fl.stock_status='SOLD' THEN 0 ELSE GREATEST(0, fl.loaded_liters - fl.used_liters) END AS remaining_liters,
             fl.stock_status,
             COALESCE(fl.load_type, 'PURCHASE') AS load_type,
             (
               SELECT string_agg(DISTINCT fit.to_unit_code, ',')
                 FROM public.fuel_internal_transfers fit
                WHERE fit.from_lot_id = fl.id AND fit.to_unit_code IS NOT NULL
             ) AS transferred_to,
             fl.created_at::text AS created_at
        FROM public.fuel_lots fl
        JOIN public.storage_units su ON su.id = fl.unit_id
        ${whereSql}
       ORDER BY COALESCE(fl.load_time, fl.created_at) DESC, fl.id DESC
      `,
      params
    );

    const filename = `lots_${from || 'all'}_${to || 'all'}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const header = [
      'Lot Code',
      'Unit Code',
      'Load Date',
      'Load Time',
      'Loaded (L)',
      'Used (L)',
      'Remaining (L)',
      'Stock Status',
      'Transferred To',
      'Load Type',
      'Created At'
    ].join(',');
    const lines = [header];
    for (const r of q.rows) {
      lines.push([
        csvEscape(r.lot_code),
        csvEscape(r.unit_code),
        csvEscape(r.load_date),
        csvEscape(r.load_time ? String(r.load_time).slice(0, 5) : ''),
        csvEscape(r.loaded_liters),
        csvEscape(r.used_liters),
        csvEscape(r.remaining_liters),
        csvEscape(r.stock_status),
        csvEscape(r.transferred_to),
        csvEscape(r.load_type),
        csvEscape(r.created_at),
      ].join(','));
    }
    res.send(lines.join('\n'));
  } catch (e) {
    res.status(500).send(e.message || String(e));
  }
});

// Internal transfers for a unit (as source or destination)
// NOTE: Removed Internal Transfers listing endpoint as per requirement

// Sale transfers for a source unit
// [ARCHIVED 2026-02-19] GET /api/fuel-ops/transfers/sales (bare) -- moved to legacy-monolith-backup/routes/archived_unused_handlers.js

// Export sales list to CSV (same filters as /sales/list)
app.get('/api/fuel-ops/transfers/sales/export', requireAuth, async (req, res) => {
  try {
    const from = req.query.from ? isoDateOnly(req.query.from) : null;
    const to = req.query.to ? isoDateOnly(req.query.to) : null;
    const unitId = req.query.unit_id ? parseInt(req.query.unit_id, 10) : null;
    if (req.query.unit_id && (!Number.isFinite(unitId) || unitId <= 0)) return res.status(400).send('unit_id invalid');

    const params = [];
    let idx = 1;
    const where = [];
    if (from) { where.push(`date_key >= $${idx++}::date`); params.push(from); }
    if (to) { where.push(`date_key <= $${idx++}::date`); params.push(to); }
    if (Number.isFinite(unitId) && unitId > 0) { where.push(`from_unit_id = $${idx++}::int`); params.push(unitId); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const q = await pool.query(
      `
      WITH t AS (
        SELECT fst.id, fst.from_unit_id, fst.from_unit_code, fst.to_vehicle,
               fst.sale_volume_liters, fst.lot_code_after, fst.driver_name, fst.performed_by, fst.activity, fst.trip,
               COALESCE(fst.sale_date, (fst.performed_at::date)) AS sale_date,
               fst.performed_at,
               COALESCE(fst.sale_date, (fst.performed_at::date)) AS date_key
          FROM public.fuel_sale_transfers fst
        UNION ALL
        SELECT tst.id, tst.from_unit_id,
               COALESCE(su.unit_code, tst.from_unit_code, '') AS from_unit_code,
               tst.to_vehicle,
               tst.transfer_volume_liters AS sale_volume_liters,
               tst.lot_code AS lot_code_after,
               tst.driver_name,
               tst.performed_by,
               tst.activity,
               tst.trip::int AS trip,
               COALESCE(tst.sale_date, (tst.performed_at::date)) AS sale_date,
               tst.performed_at,
               COALESCE(tst.sale_date, (tst.performed_at::date)) AS date_key
          FROM public.testing_self_transfers tst
          LEFT JOIN public.storage_units su ON su.id = tst.from_unit_id
        UNION ALL
        SELECT fl.id AS id,
               fl.unit_id AS from_unit_id,
               COALESCE(fl.tanker_code, su.unit_code, '') AS from_unit_code,
               NULL::text AS to_vehicle,
               fl.loaded_liters AS sale_volume_liters,
               fl.lot_code_created AS lot_code_after,
               NULL::text AS driver_name,
               NULL::text AS performed_by,
               'LOADED'::text AS activity,
               NULL::int AS trip,
           fl.load_date AS sale_date,
           COALESCE(fl.load_time, fl.created_at) AS performed_at,
           fl.load_date AS date_key
          FROM public.fuel_lots fl
          JOIN public.storage_units su ON su.id = fl.unit_id
      )
      SELECT id,
             from_unit_code,
             to_vehicle,
             sale_volume_liters,
             lot_code_after,
             driver_name,
             performed_by,
             activity,
             trip,
             sale_date::text AS sale_date,
             performed_at::text AS performed_at
        FROM t
        ${whereSql}
       ORDER BY date_key DESC, performed_at DESC NULLS LAST, id DESC
      `,
      params
    );

    const fromName = from || 'all';
    const toName = to || 'all';
    const filename = `sales_${fromName}_${toName}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const header = [
      'Date',
      'From Unit Code',
      'To Vehicle',
      'Sale Volume (L)',
      'Lot Code After',
      'Driver Name',
      'Performed By',
      'Trip',
      'Performed At',
      'Activity'
    ].join(',');
    const lines = [header];
    for (const r of q.rows) {
      lines.push([
        csvEscape(r.sale_date),
        csvEscape(r.from_unit_code),
        csvEscape(r.to_vehicle),
        csvEscape(r.sale_volume_liters),
        csvEscape(r.lot_code_after),
        csvEscape(r.driver_name),
        csvEscape(r.performed_by),
        csvEscape(r.trip),
        csvEscape(r.performed_at),
        csvEscape(r.activity),
      ].join(','));
    }
    res.send(lines.join('\n'));
  } catch (e) {
    res.status(500).send(e.message || String(e));
  }
});

// Simple sales transfers list (no filtering) for display
app.get('/api/fuel-ops/transfers/sales/list', requireAuth, async (req, res) => {
  try {
    const from = req.query.from ? isoDateOnly(req.query.from) : null;
    const to = req.query.to ? isoDateOnly(req.query.to) : null;
    const unitId = req.query.unit_id ? parseInt(req.query.unit_id, 10) : null;
    const limit = Math.max(1, Math.min(1000, parseInt(req.query.limit || '100', 10) || 100));
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10) || 0);
    if (req.query.unit_id && (!Number.isFinite(unitId) || unitId <= 0)) return res.status(400).json({ error: 'unit_id invalid' });

    const params = [];
    let idx = 1;
    const where = [];
    if (from) { where.push(`date_key >= $${idx++}::date`); params.push(from); }
    if (to) { where.push(`date_key <= $${idx++}::date`); params.push(to); }
    if (Number.isFinite(unitId) && unitId > 0) { where.push(`from_unit_id = $${idx++}::int`); params.push(unitId); }
    params.push(limit); const limitIdx = idx++;
    params.push(offset); const offsetIdx = idx++;
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const r = await pool.query(
      `
      WITH t AS (
        SELECT fst.id, fst.from_unit_id, fst.from_unit_code, fst.to_vehicle,
               fst.performed_at, COALESCE(fst.sale_date, (fst.performed_at::date)) AS sale_date,
               fst.sale_volume_liters, fst.lot_code_after, fst.driver_name, fst.performed_by, fst.activity, fst.trip,
               COALESCE(fst.sale_date, (fst.performed_at::date)) AS date_key
          FROM public.fuel_sale_transfers fst
        UNION ALL
        SELECT tst.id AS id, tst.from_unit_id,
               COALESCE(su.unit_code, tst.from_unit_code, '') AS from_unit_code,
               tst.to_vehicle AS to_vehicle,
               tst.performed_at AS performed_at,
               COALESCE(tst.sale_date, (tst.performed_at::date)) AS sale_date,
               tst.transfer_volume_liters AS sale_volume_liters,
               tst.lot_code AS lot_code_after,
               tst.driver_name AS driver_name,
               tst.performed_by AS performed_by,
               tst.activity AS activity,
               tst.trip::int AS trip,
               COALESCE(tst.sale_date, (tst.performed_at::date)) AS date_key
          FROM public.testing_self_transfers tst
          LEFT JOIN public.storage_units su ON su.id = tst.from_unit_id
        UNION ALL
        SELECT fl.id AS id, fl.unit_id AS from_unit_id,
               COALESCE(fl.tanker_code, su.unit_code, '') AS from_unit_code,
               NULL::text AS to_vehicle,
               COALESCE(fl.load_time, fl.created_at) AS performed_at,
            fl.load_date AS sale_date,
               fl.loaded_liters AS sale_volume_liters,
               fl.lot_code_created AS lot_code_after,
               NULL::text AS driver_name,
               NULL::text AS performed_by,
               'LOADED'::text AS activity,
               NULL::int AS trip,
            fl.load_date AS date_key
          FROM public.fuel_lots fl
          JOIN public.storage_units su ON su.id = fl.unit_id
      )
      SELECT id,
             from_unit_code,
             to_vehicle,
             performed_at::text AS performed_at,
             sale_date::text AS sale_date,
             sale_volume_liters,
             lot_code_after,
             driver_name,
             performed_by,
             activity,
             trip
        FROM t
        ${whereSql}
          ORDER BY date_key DESC, performed_at DESC NULLS LAST, id DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}
      `,
      params
    );
    res.json({ items: r.rows, limit, offset });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Simple list of internal transfers (no complex filters) for display purposes
app.get('/api/fuel-ops/transfers/internal/list', requireAuth, async (req, res) => {
  try {
    const from = req.query.from ? isoDateOnly(req.query.from) : null;
    const to = req.query.to ? isoDateOnly(req.query.to) : null;
    if (req.query.from && !from) return res.status(400).json({ error: 'from invalid' });
    if (req.query.to && !to) return res.status(400).json({ error: 'to invalid' });
    const activity = (req.query.activity || '').toString().toUpperCase();
    const limit = Math.max(1, Math.min(1000, parseInt(req.query.limit || '100', 10) || 100));

    const params = [];
    const where = [];
    let idx = 1;
    if (from) { where.push(`transfer_date >= $${idx++}::date`); params.push(from); }
    if (to) { where.push(`transfer_date <= $${idx++}::date`); params.push(to); }
    if (activity && activity !== 'ALL') { where.push(`UPPER(COALESCE(activity,'')) = $${idx++}`); params.push(activity); }
    params.push(limit); const limitIdx = idx++;
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const r = await pool.query(
      `SELECT id,
              from_unit_code,
              to_unit_code,
              transfer_date::text AS transfer_date,
              transfer_time::text AS transfer_time,
              transfer_volume,
              from_lot_code_change,
              to_lot_code_change,
              transfer_to_empty,
              driver_name,
              performed_by,
              activity,
              created_at::text AS created_at
         FROM public.fuel_internal_transfers
        ${whereSql}
        ORDER BY transfer_date DESC, COALESCE(transfer_time, '00:00'::time) DESC, id DESC
        LIMIT $${limitIdx}`,
      params
    );
    res.json({ items: r.rows, limit });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Export internal transfers list to CSV (same filters as /internal/list)
app.get('/api/fuel-ops/transfers/internal/export', requireAuth, async (req, res) => {
  try {
    const from = req.query.from ? isoDateOnly(req.query.from) : null;
    const to = req.query.to ? isoDateOnly(req.query.to) : null;
    if (req.query.from && !from) return res.status(400).send('from invalid');
    if (req.query.to && !to) return res.status(400).send('to invalid');
    const activity = (req.query.activity || '').toString().toUpperCase();

    const params = [];
    const where = [];
    let idx = 1;
    if (from) { where.push(`transfer_date >= $${idx++}::date`); params.push(from); }
    if (to) { where.push(`transfer_date <= $${idx++}::date`); params.push(to); }
    if (activity && activity !== 'ALL') { where.push(`UPPER(COALESCE(activity,'')) = $${idx++}`); params.push(activity); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const q = await pool.query(
      `SELECT id,
              transfer_date::text AS transfer_date,
              transfer_time::text AS transfer_time,
              from_unit_code,
              to_unit_code,
              transfer_volume,
              from_lot_code_change,
              to_lot_code_change,
              transfer_to_empty,
              driver_name,
              performed_by,
              activity
         FROM public.fuel_internal_transfers
        ${whereSql}
        ORDER BY transfer_date DESC, COALESCE(transfer_time, '00:00'::time) DESC, id DESC`,
      params
    );

    const filename = `internal_transfers_${from || 'all'}_${to || 'all'}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const header = [
      'Date',
      'Time',
      'From Unit Code',
      'To Unit Code',
      'Transfer Volume (L)',
      'From Lot Code Change',
      'To Lot Code Change',
      'Transfer To Empty',
      'Driver Name',
      'Performed By',
      'Activity'
    ].join(',');
    const lines = [header];
    for (const r of q.rows) {
      lines.push([
        csvEscape(r.transfer_date),
        csvEscape(r.transfer_time ? String(r.transfer_time).slice(0, 5) : ''),
        csvEscape(r.from_unit_code),
        csvEscape(r.to_unit_code),
        csvEscape(r.transfer_volume),
        csvEscape(r.from_lot_code_change),
        csvEscape(r.to_lot_code_change),
        csvEscape(r.transfer_to_empty ? 'Yes' : 'No'),
        csvEscape(r.driver_name),
        csvEscape(r.performed_by),
        csvEscape(r.activity),
      ].join(','));
    }
    res.send(lines.join('\n'));
  } catch (e) {
    res.status(500).send(e.message || String(e));
  }
});

// (route removed: there is a newer PATCH handler below with validations)

// Edit a testing_self_transfers record (allow editing volume and performed_at/time)
app.patch('/api/fuel-ops/transfers/testing/:id', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
    const { transfer_volume_liters, transfer_volume, performed_time, sale_date } = req.body || {};
    const existingQ = await client.query(`SELECT * FROM public.testing_self_transfers WHERE id=$1 FOR UPDATE`, [id]);
    if (!existingQ.rows.length) return res.status(404).json({ error: 'not found' });
    const existing = existingQ.rows[0];

    const opDate = existing.sale_date ? isoDateOnly(existing.sale_date) : (existing.performed_at ? isoDateOnly(existing.performed_at) : null);
    const tripRow = await getTripRowForOp(client, existing.from_unit_id, opDate, existing.trip);
    await assertOpEditableByTripState(client, tripRow, req);

    const parts = [];
    const vals = [];
    let idx = 1;
    if (transfer_volume != null) {
      const v = parseLiters3(transfer_volume);
      if (!Number.isFinite(v) || v <= 0) return res.status(400).json({ error: 'invalid transfer_volume_liters' });
      parts.push(`transfer_volume_liters=$${idx++}`);
      vals.push(v);
    } else if (transfer_volume_liters != null) {
      const v = parseLiters3(transfer_volume_liters);
      if (!Number.isFinite(v) || v <= 0) return res.status(400).json({ error: 'invalid transfer_volume_liters' });
      parts.push(`transfer_volume_liters=$${idx++}`);
      vals.push(v);
    }
    if (performed_time != null) {
      const hhmm = String(performed_time).trim();
      if (/^\d{2}:\d{2}$/.test(hhmm)) {
        const baseDate = sale_date ? isoDateOnly(sale_date)
          : (existing.sale_date ? isoDateOnly(existing.sale_date) : (existing.performed_at ? isoDateOnly(existing.performed_at) : isoDateOnly(new Date())));
        if (baseDate) {
          parts.push(`performed_at=$${idx++}`);
          vals.push(`${baseDate} ${hhmm}:00`);
        }
      }
    }
    if (sale_date != null && performed_time == null) {
      const baseDate = isoDateOnly(sale_date);
      if (baseDate) {
        const timePart = existing.performed_at ? String(existing.performed_at).slice(11,19) : '00:00:00';
        parts.push(`performed_at=$${idx++}`);
        vals.push(`${baseDate} ${timePart}`);
        parts.push(`sale_date=$${idx++}`);
        vals.push(baseDate);
      }
    }
    if (!parts.length) return res.status(400).json({ error: 'no fields to update' });
    parts.push(`updated_at=NOW()`);
    vals.push(id);
    const q = await client.query(`UPDATE public.testing_self_transfers SET ${parts.join(', ')} WHERE id=$${idx} RETURNING *`, vals);
    if (!q.rows.length) return res.status(404).json({ error: 'not found' });

    await recomputeFuelLotTestingLiters(client, existing.lot_id);

    await client.query('COMMIT');
    res.json(q.rows[0]);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    res.status(e.status || 500).json({ error: e.message });
  } finally { client.release(); }
});

// Delete a testing_self_transfers record
app.delete('/api/fuel-ops/transfers/testing/:id', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
    const existingQ = await client.query(`SELECT * FROM public.testing_self_transfers WHERE id=$1 FOR UPDATE`, [id]);
    if (!existingQ.rows.length) return res.status(404).json({ error: 'not found' });
    const existing = existingQ.rows[0];

    const opDate = existing.sale_date ? isoDateOnly(existing.sale_date) : (existing.performed_at ? isoDateOnly(existing.performed_at) : null);
    const tripRow = await getTripRowForOp(client, existing.from_unit_id, opDate, existing.trip);
    await assertOpEditableByTripState(client, tripRow, req);

    const del = await client.query(`DELETE FROM public.testing_self_transfers WHERE id=$1 RETURNING *`, [id]);
    const deleted = del.rows[0];
    await recomputeFuelLotTestingLiters(client, existing.lot_id);

    await client.query('COMMIT');
    res.json({ deleted: true, row: deleted });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    res.status(e.status || 500).json({ error: e.message });
  } finally { client.release(); }
});

// Consolidated per-day operations for a truck (sales, transfers in/out, loads, totals, remaining liters)
app.get('/api/fuel-ops/ops/day', requireAuth, async (req, res) => {
  try {
    const truckId = parseInt(req.query.truck_id, 10);
    const dateStrRaw = req.query.date || new Date();
    const dateStr = isoDateOnly(dateStrRaw);
    if (!Number.isFinite(truckId) || truckId <= 0) return res.status(400).json({ error: 'truck_id required' });
    if (!dateStr) return res.status(400).json({ error: 'invalid date' });

    // Current in-stock lot + remaining liters (centralized; avoids N+1 and aligns domain logic)
    let lotInfo = null; let remainingLiters = null;
    try {
      const m = await getUnitInstockMetrics(pool, truckId);
      if (m.latest_lot) {
        lotInfo = {
          id: m.latest_lot.id,
          lot_code_initial: m.latest_lot.lot_code_initial,
          loaded_liters: m.latest_lot.loaded_liters,
          used_liters: m.latest_lot.used_liters,
          inbound_adds_liters: m.latest_lot.inbound_adds_liters,
          outbound_used_liters: m.latest_lot.outbound_used_liters,
          remaining_liters: m.latest_lot.remaining_liters_clamped,
        };
        remainingLiters = m.latest_lot.remaining_liters_clamped;
      }
    } catch (e) {
      if (!process.env.SUPPRESS_DB_LOG) console.warn('[ops/day metrics warn]', e.message);
    }

    // Day-filtered operations
    const salesQ = await pool.query(
      `SELECT id, from_unit_id, from_unit_code, to_vehicle, sale_volume_liters, lot_code_after, driver_name, performed_at, 
              TO_CHAR(performed_at, 'HH24:MI') AS performed_time, sale_date, activity
         FROM public.fuel_sale_transfers
        WHERE from_unit_id=$1 AND COALESCE(sale_date, performed_at::date) = $2::date
        ORDER BY COALESCE(performed_at, sale_date) ASC, id ASC`,
      [truckId, dateStr]
    );
    const transfersOutQ = await pool.query(
      `SELECT id, from_unit_id, from_unit_code, to_unit_id, to_unit_code, transfer_volume, from_lot_code_change, to_lot_code_change, transfer_to_empty, driver_name, transfer_date, transfer_time, activity, trip
         FROM public.fuel_internal_transfers
        WHERE from_unit_id=$1 AND transfer_date = $2::date
        ORDER BY transfer_date ASC, transfer_time ASC, id ASC`,
      [truckId, dateStr]
    );
    const transfersInQ = await pool.query(
      `SELECT id, from_unit_id, from_unit_code, to_unit_id, to_unit_code, transfer_volume, from_lot_code_change, to_lot_code_change, transfer_to_empty, driver_name, transfer_date, transfer_time, activity, trip
         FROM public.fuel_internal_transfers
        WHERE to_unit_id=$1 AND transfer_date = $2::date
        ORDER BY transfer_date ASC, transfer_time ASC, id ASC`,
      [truckId, dateStr]
    );
    const dateCol = await resolveFuelLotsDateCol();
    const loadsQ = await pool.query(
      `SELECT id, lot_code_created AS lot_code_initial, loaded_liters, ${dateCol} AS load_date, created_at, load_time, seq_index, load_type
         FROM public.fuel_lots
        WHERE unit_id=$1 AND ${dateCol} = $2::date
        ORDER BY COALESCE(load_time, created_at) ASC, id ASC`,
      [truckId, dateStr]
    );
    // Testing activities for the day (only from testing_self_transfers)
    let testingQ = { rows: [] };
    try {
      testingQ = await pool.query(`
        SELECT id, lot_id, from_unit_id, transfer_volume_liters AS testing_volume_liters, performed_at, activity
          FROM public.testing_self_transfers
         WHERE from_unit_id=$1 AND performed_at::date = $2::date
         ORDER BY performed_at ASC, id ASC
      `, [truckId, dateStr]);
    } catch (e) { if (!process.env.SUPPRESS_DB_LOG) console.warn('[ops/day testing warn]', e.message); }

    // Totals for the day
    const totals = {
      sales_liters: salesQ.rows.reduce((a,r)=> a + Number(r.sale_volume_liters||0), 0),
  transfers_out_liters: transfersOutQ.rows.reduce((a,r)=> a + Number(r.transfer_volume||0), 0),
  transfers_in_liters: transfersInQ.rows.reduce((a,r)=> a + Number(r.transfer_volume||0), 0),
      loaded_liters: loadsQ.rows.reduce((a,r)=> a + Number(r.loaded_liters||0), 0),
      testing_liters: testingQ.rows.reduce((a,r)=> a + Number(r.testing_volume_liters||0), 0)
    };

    res.json({
      truck_id: truckId,
      date: dateStr,
      lot: lotInfo,
      remaining_liters: remainingLiters,
      totals,
      sales: salesQ.rows,
      transfers_out: transfersOutQ.rows,
      transfers_in: transfersInQ.rows,
      loads: loadsQ.rows,
      testing: testingQ.rows
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Consolidated per-trip operations filtered by opening/closing window
app.get('/api/fuel-ops/ops/trip', requireAuth, async (req, res) => {
  try {
    const truckId = parseInt(req.query.truck_id, 10);
    const dateStr = isoDateOnly(req.query.date || new Date());
    const tripNo = parseInt(req.query.trip_no, 10);
    if (!Number.isFinite(truckId) || truckId <= 0) return res.status(400).json({ error: 'truck_id required' });
    if (!dateStr) return res.status(400).json({ error: 'invalid date' });
    if (!Number.isFinite(tripNo) || tripNo <= 0) return res.status(400).json({ error: 'trip_no required' });

    const tripQ = await pool.query(
      `SELECT * FROM public.truck_dispenser_trips WHERE truck_id=$1 AND reading_date=$2 AND trip_no=$3`,
      [truckId, dateStr, tripNo]
    );
    if (!tripQ.rows.length) return res.status(404).json({ error: 'trip not found' });
    const trip = tripQ.rows[0];
    const dateCol = await resolveFuelLotsDateCol();
    // Next trip opening to bound upper window if closing_at is null
    const nextQ = await pool.query(
      `SELECT opening_at FROM public.truck_dispenser_trips
        WHERE truck_id=$1 AND reading_date=$2 AND trip_no > $3
        ORDER BY trip_no ASC
        LIMIT 1`,
      [truckId, dateStr, tripNo]
    );
    const defaultStart = `${dateStr} 00:00:00`;
    const defaultEnd = `${dateStr} 23:59:59`;
    // Guard: if opening is not saved yet, this trip has no window; return empty ops for clarity
    if (!trip.opening_at) {
      const loadsQ = await pool.query(
        `SELECT id, lot_code_created AS lot_code_initial, loaded_liters, ${dateCol} AS load_date, created_at, load_time, seq_index, load_type
           FROM public.fuel_lots
          WHERE unit_id=$1 AND ${dateCol} = $2::date
          ORDER BY COALESCE(load_time, created_at) ASC, id ASC`,
        [truckId, dateStr]
      );
      return res.json({
        truck_id: truckId,
        date: dateStr,
        trip_no: tripNo,
        trip,
        totals: { sales_liters: 0, transfers_out_liters: 0, transfers_in_liters: 0, loaded_liters: loadsQ.rows.reduce((a,r)=>a+Number(r.loaded_liters||0),0), testing_liters: 0 },
        sales: [], transfers_out: [], transfers_in: [], loads: loadsQ.rows, testing: []
      });
    }
    // IMPORTANT: Use DB timestamps as-is (no toISOString UTC conversion) to avoid timezone shifts.
    const startSQL = toSqlLocalTs(trip.opening_at) || defaultStart;
    const endSQL = trip.closing_at
      ? (toSqlLocalTs(trip.closing_at) || defaultEnd)
      : (nextQ.rows.length && nextQ.rows[0].opening_at
          ? (toSqlLocalTs(nextQ.rows[0].opening_at) || defaultEnd)
          : defaultEnd);

    // Sales within window
    const salesQ = await pool.query(
      `SELECT id, from_unit_id, from_unit_code, to_vehicle, sale_volume_liters, lot_code_after, driver_name, performed_at, sale_date, activity
         FROM public.fuel_sale_transfers
        WHERE from_unit_id=$1 AND performed_at >= $2::timestamp AND performed_at < $3::timestamp
        ORDER BY COALESCE(performed_at, sale_date) ASC, id ASC`,
      [truckId, startSQL, endSQL]
    );
    const transfersOutQ = await pool.query(
      `SELECT id, from_unit_id, from_unit_code, to_unit_id, to_unit_code, transfer_volume, from_lot_code_change, to_lot_code_change, transfer_to_empty, driver_name, transfer_date, transfer_time, activity, trip
         FROM public.fuel_internal_transfers
        WHERE from_unit_id=$1 AND (transfer_date::timestamp + transfer_time) >= $2::timestamp AND (transfer_date::timestamp + transfer_time) < $3::timestamp
        ORDER BY transfer_date ASC, transfer_time ASC, id ASC`,
      [truckId, startSQL, endSQL]
    );
    const transfersInQ = await pool.query(
      `SELECT id, from_unit_id, from_unit_code, to_unit_id, to_unit_code, transfer_volume, from_lot_code_change, to_lot_code_change, transfer_to_empty, driver_name, transfer_date, transfer_time, activity, trip
         FROM public.fuel_internal_transfers
        WHERE to_unit_id=$1 AND (transfer_date::timestamp + transfer_time) >= $2::timestamp AND (transfer_date::timestamp + transfer_time) < $3::timestamp
        ORDER BY transfer_date ASC, transfer_time ASC, id ASC`,
      [truckId, startSQL, endSQL]
    );
    // Testing within trip window (performed_at between start and end). Only from testing_self_transfers.
    let testingQ = { rows: [] };
    try {
      testingQ = await pool.query(`
        SELECT id, lot_id, from_unit_id, transfer_volume_liters AS testing_volume_liters, performed_at, activity
          FROM public.testing_self_transfers
         WHERE from_unit_id=$1 AND performed_at >= $2::timestamp AND performed_at < $3::timestamp
         ORDER BY performed_at ASC, id ASC
      `, [truckId, startSQL, endSQL]);
    } catch (e) { if (!process.env.SUPPRESS_DB_LOG) console.warn('[ops/trip testing warn]', e.message); }
    // loads are day-level; keep separate for UI reuse
    const loadsQ = await pool.query(
      `SELECT id, lot_code_created AS lot_code_initial, loaded_liters, ${dateCol} AS load_date, created_at, load_time, seq_index, load_type
         FROM public.fuel_lots
        WHERE unit_id=$1 AND ${dateCol} = $2::date
        ORDER BY COALESCE(load_time, created_at) ASC, id ASC`,
      [truckId, dateStr]
    );

    // Determine current in-stock lots for the truck and compute aggregate remaining liters (no N+1)
    let lotInfo = null; let remainingLiters = null;
    try {
      const m = await getUnitInstockMetrics(pool, truckId);
      remainingLiters = m.total_remaining_clamped_liters;
      if (m.latest_lot) {
        lotInfo = {
          id: m.latest_lot.id,
          lot_code_initial: m.latest_lot.lot_code_initial,
          loaded_liters: m.latest_lot.loaded_liters,
          used_liters: m.latest_lot.used_liters,
          inbound_adds_liters: m.latest_lot.inbound_adds_liters,
          outbound_used_liters: m.latest_lot.outbound_used_liters,
          remaining_liters: m.latest_lot.remaining_liters_clamped,
        };
      }
    } catch (e) {
      if (!process.env.SUPPRESS_DB_LOG) console.warn('[ops/trip metrics warn]', e.message);
    }

    const totals = {
      sales_liters: salesQ.rows.reduce((a,r)=> a + Number(r.sale_volume_liters||0), 0),
  transfers_out_liters: transfersOutQ.rows.reduce((a,r)=> a + Number(r.transfer_volume||0), 0),
  transfers_in_liters: transfersInQ.rows.reduce((a,r)=> a + Number(r.transfer_volume||0), 0),
      loaded_liters: loadsQ.rows.reduce((a,r)=> a + Number(r.loaded_liters||0), 0),
      testing_liters: testingQ.rows.reduce((a,r)=> a + Number(r.testing_volume_liters||0), 0)
    };

    res.json({
      truck_id: truckId,
      date: dateStr,
      trip_no: tripNo,
      trip,
      totals,
      lot: lotInfo,
      remaining_liters: remainingLiters,
      sales: salesQ.rows,
      transfers_out: transfersOutQ.rows,
      transfers_in: transfersInQ.rows,
      loads: loadsQ.rows,
      testing: testingQ.rows
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Edit/Delete endpoints for transfers (minimal fields; remaining liters computed from sums, so no counter updates here)
app.delete('/api/fuel-ops/transfers/sales/:id', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });

    const existingQ = await client.query(`SELECT * FROM public.fuel_sale_transfers WHERE id=$1 FOR UPDATE`, [id]);
    if (!existingQ.rows.length) return res.status(404).json({ error: 'not found' });
    const existing = existingQ.rows[0];
    const opDate = existing.sale_date ? isoDateOnly(existing.sale_date) : (existing.performed_at ? isoDateOnly(existing.performed_at) : null);
    const tripRow = await getTripRowForOp(client, existing.from_unit_id, opDate, existing.trip);
    await assertOpEditableByTripState(client, tripRow, req);

    const tripSnapBefore = tripRow ? await getTripReadingsSnapshot(client, tripRow) : null;

    const del = await client.query(`DELETE FROM public.fuel_sale_transfers WHERE id=$1 RETURNING *`, [id]);
    const deleted = del.rows[0];

    await recomputeFuelLotUsedAndStatus(client, deleted.lot_id);
    if (isUnfreezeWindow(tripRow)) {
      const tripSnapAfter = tripRow ? await getTripReadingsSnapshot(client, tripRow) : null;
      await insertFuelOpsAudit(client, {
        user_id: req.user?.sub || null,
        username: getActor(req),
        tab: 'At Depot',
        section: 'Sales & Transfers',
        action: 'DELETE',
        entity_type: 'SALE',
        entity_id: id,
        unit_id: existing.from_unit_id || null,
        unit_type: 'TRUCK',
        driver_id: existing.driver_id || null,
        trip_id: tripRow?.id || null,
        trip_no: tripRow?.trip_no || null,
        op_date: opDate,
        performed_time: null, // show audit time via created_at in UI
        amount_liters: existing.sale_volume_liters || null,
        payload_old: (tripSnapBefore ? { ...existing, ...tripSnapBefore } : existing),
        payload_new: (tripSnapAfter ? { ...tripSnapAfter } : {}),
        reason: null,
        request_id: req.headers['x-request-id'] || null,
        ip_addr: getClientIp(req),
      });
    }

    await client.query('COMMIT');
    res.json({ deleted: true, row: deleted });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    res.status(e.status || 500).json({ error: e.message });
  } finally { client.release(); }
});

app.patch('/api/fuel-ops/transfers/sales/:id', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
    const { sale_volume_liters, to_vehicle, sale_date, performed_time } = req.body || {};

    const existingQ = await client.query(`SELECT * FROM public.fuel_sale_transfers WHERE id=$1 FOR UPDATE`, [id]);
    if (!existingQ.rows.length) return res.status(404).json({ error: 'not found' });
    const existing = existingQ.rows[0];
    const oldOpDate = existing.sale_date ? isoDateOnly(existing.sale_date) : (existing.performed_at ? isoDateOnly(existing.performed_at) : null);
    const tripRow = await getTripRowForOp(client, existing.from_unit_id, oldOpDate, existing.trip);
    await assertOpEditableByTripState(client, tripRow, req);

    const tripSnapBefore = tripRow ? await getTripReadingsSnapshot(client, tripRow) : null;

    const parts = [];
    const vals = [];
    let idx = 1;
    if (sale_volume_liters != null) {
      const v = parseLiters3(sale_volume_liters);
      if (!Number.isFinite(v)) return res.status(400).json({ error: 'invalid sale_volume_liters' });
      parts.push(`sale_volume_liters=$${idx++}`);
      vals.push(v);
    }
    if (to_vehicle != null) { parts.push(`to_vehicle=$${idx++}`); vals.push(String(to_vehicle)); }
    if (sale_date != null) { parts.push(`sale_date=$${idx++}`); vals.push(isoDateOnly(sale_date)); }
    if (performed_time != null) {
      const hhmm = String(performed_time).trim();
      if (/^\d{2}:\d{2}$/.test(hhmm)) {
        const baseDate = sale_date ? isoDateOnly(sale_date)
          : (existing.sale_date ? isoDateOnly(existing.sale_date) : (existing.performed_at ? isoDateOnly(existing.performed_at) : isoDateOnly(new Date())));
        if (baseDate) {
          parts.push(`performed_at=$${idx++}`);
          vals.push(`${baseDate} ${hhmm}:00`);
        }
      }
    }
    if (!parts.length) return res.status(400).json({ error: 'no fields to update' });
    parts.push(`updated_at=NOW()`);
    vals.push(id);
    const q = await client.query(`UPDATE public.fuel_sale_transfers SET ${parts.join(', ')} WHERE id=$${idx} RETURNING *`, vals);
    if (!q.rows.length) return res.status(404).json({ error: 'not found' });

    await recomputeFuelLotUsedAndStatus(client, existing.lot_id);
    if (isUnfreezeWindow(tripRow)) {
      const tripSnapAfter = tripRow ? await getTripReadingsSnapshot(client, tripRow) : null;
      await insertFuelOpsAudit(client, {
        user_id: req.user?.sub || null,
        username: getActor(req),
        tab: 'At Depot',
        section: 'Sales & Transfers',
        action: 'UPDATE',
        entity_type: 'SALE',
        entity_id: id,
        unit_id: existing.from_unit_id || null,
        unit_type: 'TRUCK',
        driver_id: existing.driver_id || null,
        trip_id: tripRow?.id || null,
        trip_no: tripRow?.trip_no || null,
        op_date: oldOpDate,
        performed_time: null, // show audit time via created_at in UI
        amount_liters: (q.rows[0]?.sale_volume_liters != null ? q.rows[0].sale_volume_liters : existing.sale_volume_liters) || null,
        payload_old: (tripSnapBefore ? { ...existing, ...tripSnapBefore } : existing),
        payload_new: (q.rows[0] ? (tripSnapAfter ? { ...q.rows[0], ...tripSnapAfter } : q.rows[0]) : (tripSnapAfter ? { ...tripSnapAfter } : null)),
        reason: null,
        request_id: req.headers['x-request-id'] || null,
        ip_addr: getClientIp(req),
      });
    }

    await client.query('COMMIT');
    res.json(q.rows[0]);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    res.status(e.status || 500).json({ error: e.message });
  } finally { client.release(); }
});

app.delete('/api/fuel-ops/transfers/internal/:id', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });

    await client.query('BEGIN');
    const existingQ = await client.query(`SELECT * FROM public.fuel_internal_transfers WHERE id=$1 FOR UPDATE`, [id]);
    if (!existingQ.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not found' }); }
    const existing = existingQ.rows[0];

    // Enforce trip lock (closed/frozen)
    const opDate = existing.transfer_date ? isoDateOnly(existing.transfer_date) : null;
    const tripRow = await getTripRowForOp(client, existing.from_unit_id, opDate, existing.trip);
    await assertOpEditableByTripState(client, tripRow, req);

    const tripSnapBefore = tripRow ? await getTripReadingsSnapshot(client, tripRow) : null;

    // Delete the transfer row
    const del = await client.query(`DELETE FROM public.fuel_internal_transfers WHERE id=$1 RETURNING *`, [id]);
    const deleted = del.rows[0];

    // Helper: inbound added (exclude seeding + testing) for a lot
    async function getInboundAddedLiters(c, lotId) {
      const q = await c.query(
        `SELECT COALESCE(SUM(fit.transfer_volume) FILTER (
                 WHERE NOT (
                   fit.transfer_to_empty = TRUE
                   OR (fit.to_lot_code_change = fl.lot_code_created AND fit.transfer_volume = fl.loaded_liters)
                   OR (COALESCE(fit.activity,'') = 'TESTING')
                 )
               ),0) AS inbound_added
           FROM public.fuel_internal_transfers fit
           JOIN public.fuel_lots fl ON fl.id = fit.to_lot_id
          WHERE fit.to_lot_id=$1`,
        [lotId]
      );
      return Number(q.rows[0]?.inbound_added || 0);
    }
    // Helper: outbound used (sales + internal transfers) for a lot
    async function getOutboundUsedLiters(c, lotId) {
      const sales = await c.query(`SELECT COALESCE(SUM(sale_volume_liters),0) AS s FROM public.fuel_sale_transfers WHERE lot_id=$1`, [lotId]);
      const xfers = await c.query(`SELECT COALESCE(SUM(transfer_volume),0) AS t FROM public.fuel_internal_transfers WHERE from_lot_id=$1 AND COALESCE(activity,'') <> 'TESTING'`, [lotId]);
      return Number(sales.rows[0]?.s || 0) + Number(xfers.rows[0]?.t || 0);
    }

    const fromLotId = deleted.from_lot_id != null ? Number(deleted.from_lot_id) : null;
    const toLotId = deleted.to_lot_id != null ? Number(deleted.to_lot_id) : null;
    const vol = deleted.transfer_volume != null ? Number(deleted.transfer_volume) : null;

    // If this transfer seeded an EMPTY_TRANSFER lot, undo the seeding.
    // We cannot set loaded_liters to 0 (schema enforces loaded_liters > 0), so the safest reversal is:
    // - if the destination lot has no remaining references, delete the lot;
    // - otherwise, block the delete to avoid leaving inconsistent stock history.
    // Note: older rows may have transfer_to_empty=false even though they seeded (to_lot_code_change == lot_code_created).
    let toLotDeleted = false;
    if (toLotId && vol != null) {
      const toLotQ = await client.query(
        `SELECT id, load_type, lot_code_created FROM public.fuel_lots WHERE id=$1 FOR UPDATE`,
        [toLotId]
      );
      const toLot = toLotQ.rows[0];
      const seededByFlag = deleted.transfer_to_empty === true;
      const seededByCode =
        toLot &&
        String(toLot.load_type || '') === 'EMPTY_TRANSFER' &&
        String(deleted.to_lot_code_change || '') === String(toLot.lot_code_created || '');

      if (seededByFlag || seededByCode) {
        const refQ = await client.query(
          `SELECT
             (SELECT COUNT(*)::int FROM public.fuel_internal_transfers WHERE to_lot_id=$1 OR from_lot_id=$1) AS xfers,
             (SELECT COUNT(*)::int FROM public.fuel_sale_transfers WHERE lot_id=$1) AS sales,
             (SELECT COUNT(*)::int FROM public.testing_self_transfers WHERE lot_id=$1) AS testing`,
          [toLotId]
        );
        const refs = refQ.rows[0] || { xfers: 0, sales: 0, testing: 0 };
        const hasRefs = Number(refs.xfers || 0) > 0 || Number(refs.sales || 0) > 0 || Number(refs.testing || 0) > 0;

        if (hasRefs) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: 'cannot delete transfer: destination lot has dependent records',
            details: { toLotId, refs },
          });
        }

        await client.query(`DELETE FROM public.fuel_lots WHERE id=$1`, [toLotId]);
        toLotDeleted = true;
      }
    }

    // Recompute and update from/to lots so stock_status and used_liters stay consistent.
    async function recomputeLot(c, lotId) {
      if (!lotId) return;
      const lotQ = await c.query(`SELECT * FROM public.fuel_lots WHERE id=$1 FOR UPDATE`, [lotId]);
      if (!lotQ.rows.length) return;
      const lot = lotQ.rows[0];
      const inboundAdded = await getInboundAddedLiters(c, lotId);
      const usedOut = await getOutboundUsedLiters(c, lotId);
      const netRemaining = (Number(lot.loaded_liters || 0) + inboundAdded) - usedOut;
      const stock = netRemaining <= 0 ? 'SOLD' : 'INSTOCK';
      await c.query(
        `UPDATE public.fuel_lots
            SET used_liters=$2,
                stock_status=$3,
                updated_at=NOW()
          WHERE id=$1`,
        [lotId, usedOut, stock]
      );
    }

    await recomputeLot(client, fromLotId);
    if (!toLotDeleted) await recomputeLot(client, toLotId);

    if (isUnfreezeWindow(tripRow)) {
      const tripSnapAfter = tripRow ? await getTripReadingsSnapshot(client, tripRow) : null;
      await insertFuelOpsAudit(client, {
        user_id: req.user?.sub || null,
        username: getActor(req),
        tab: 'At Depot',
        section: 'Sales & Transfers',
        action: 'DELETE',
        entity_type: 'INTERNAL_TRANSFER',
        entity_id: id,
        unit_id: existing.from_unit_id || null,
        unit_type: 'TRUCK',
        trip_id: tripRow?.id || null,
        trip_no: tripRow?.trip_no || null,
        op_date: opDate,
        performed_time: null, // show audit time via created_at in UI
        amount_liters: existing.transfer_volume || null,
        payload_old: (tripSnapBefore ? { ...existing, ...tripSnapBefore } : existing),
        payload_new: (tripSnapAfter ? { ...tripSnapAfter } : {}),
        reason: null,
        request_id: req.headers['x-request-id'] || null,
        ip_addr: getClientIp(req),
      });
    }

    await client.query('COMMIT');
    res.json({ deleted: true, row: deleted });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    res.status(e.status || 500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.patch('/api/fuel-ops/transfers/internal/:id', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
    const { transfer_volume_liters, transfer_volume, performed_time, transfer_date } = req.body || {};

    await client.query('BEGIN');

    // Lock existing row so concurrent edits can't race stock validations
    const existingQ = await client.query(
      `SELECT * FROM public.fuel_internal_transfers WHERE id=$1 FOR UPDATE`,
      [id]
    );
    if (!existingQ.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not found' });
    }
    const existing = existingQ.rows[0];

    // Enforce trip lock (closed/frozen)
    const opDate = existing.transfer_date ? isoDateOnly(existing.transfer_date) : null;
    const tripRow = await getTripRowForOp(client, existing.from_unit_id, opDate, existing.trip);
    await assertOpEditableByTripState(client, tripRow, req);

    const tripSnapBefore = tripRow ? await getTripReadingsSnapshot(client, tripRow) : null;

    const oldVol = Number(existing.transfer_volume || 0);
    let newVol = oldVol;
    const volInput = transfer_volume != null ? transfer_volume : transfer_volume_liters;
    if (volInput != null) {
      const v = parseLiters3(volInput);
      if (!Number.isFinite(v) || v <= 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'invalid transfer_volume_liters' });
      }
      newVol = v;
    }

    // Only validate when volume is changing.
    if (newVol !== oldVol) {
      const fromUnitId = Number(existing.from_unit_id || 0);
      const toUnitId = Number(existing.to_unit_id || 0);
      if (!Number.isFinite(fromUnitId) || fromUnitId <= 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'invalid from_unit_id on existing transfer' });
      }
      if (!Number.isFinite(toUnitId) || toUnitId <= 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'invalid to_unit_id on existing transfer' });
      }

      // Compute current in-stock liters for these units (as used by mini stock indicators)
      const unitIds = [fromUnitId, toUnitId];
      const stockQ = await client.query(
        `WITH units AS (
          SELECT id, capacity_liters
            FROM public.storage_units
           WHERE id = ANY($1::int[])
        ),
        lots AS (
          SELECT id AS lot_id, unit_id
            FROM public.fuel_lots
           WHERE stock_status='INSTOCK' AND unit_id = ANY($1::int[])
        ),
        inbound AS (
          SELECT fit.to_lot_id AS lot_id,
                 COALESCE(SUM(fit.transfer_volume) FILTER (
                   WHERE NOT (
                     fit.transfer_to_empty = TRUE
                     OR (fit.to_lot_code_change = fl.lot_code_created AND fit.transfer_volume = fl.loaded_liters)
                     OR (COALESCE(fit.activity,'') = 'TESTING')
                   )
                 ),0) AS inbound_added
            FROM public.fuel_internal_transfers fit
            JOIN public.fuel_lots fl ON fl.id = fit.to_lot_id
           WHERE fl.unit_id = ANY($1::int[])
           GROUP BY fit.to_lot_id
        ),
        sales AS (
          SELECT lot_id, COALESCE(SUM(sale_volume_liters),0) AS sale_only
            FROM public.fuel_sale_transfers
           WHERE from_unit_id = ANY($1::int[])
           GROUP BY lot_id
        ),
        outbound_x AS (
          SELECT from_lot_id AS lot_id, COALESCE(SUM(transfer_volume),0) AS outbound_transfers
            FROM public.fuel_internal_transfers
           WHERE from_unit_id = ANY($1::int[]) AND COALESCE(activity,'') <> 'TESTING'
           GROUP BY from_lot_id
        ),
        per_lot AS (
          SELECT l.unit_id,
                 GREATEST(0,
                   COALESCE((SELECT fl.loaded_liters FROM public.fuel_lots fl WHERE fl.id=l.lot_id),0)
                   + COALESCE(i.inbound_added,0)
                   - (COALESCE(o.outbound_transfers,0) + COALESCE(s.sale_only,0))
                 ) AS remaining
            FROM lots l
            LEFT JOIN inbound i ON i.lot_id = l.lot_id
            LEFT JOIN sales s ON s.lot_id = l.lot_id
            LEFT JOIN outbound_x o ON o.lot_id = l.lot_id
        ),
        agg AS (
          SELECT unit_id, COALESCE(SUM(remaining),0) AS instock_liters
            FROM per_lot
           GROUP BY unit_id
        )
        SELECT u.id AS unit_id,
               COALESCE(u.capacity_liters,0) AS capacity_liters,
               COALESCE(a.instock_liters,0) AS instock_liters
          FROM units u
          LEFT JOIN agg a ON a.unit_id = u.id`,
        [unitIds]
      );

      const byUnit = new Map(stockQ.rows.map(r => [Number(r.unit_id), {
        instock: Number(r.instock_liters || 0),
        capacity: Number(r.capacity_liters || 0)
      }]));

      const fromNow = byUnit.get(fromUnitId) || { instock: 0, capacity: 0 };
      const toNow = byUnit.get(toUnitId) || { instock: 0, capacity: 0 };
      const delta = round3(newVol - oldVol);

      const fromAfter = round3(fromNow.instock - delta);
      const toAfter = round3(toNow.instock + delta);

      if (fromAfter < 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `Insufficient stock in source unit for this edit (available ${fromNow.instock} L, would become ${fromAfter} L).`
        });
      }
      if (toNow.capacity > 0 && toAfter > toNow.capacity) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `Destination capacity exceeded by this edit (capacity ${toNow.capacity} L, would become ${toAfter} L).`
        });
      }
      if (toAfter < 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Destination stock would become negative' });
      }
    }

    const parts = [];
    const vals = [];
    let idx = 1;
    if (volInput != null) {
      parts.push(`transfer_volume=$${idx++}`);
      vals.push(newVol);
    }
    if (transfer_date != null) {
      const dOnly = isoDateOnly(transfer_date);
      if (!dOnly) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'invalid transfer_date' });
      }
      parts.push(`transfer_date=$${idx++}`);
      vals.push(dOnly);
    }
    if (performed_time != null) {
      const hhmm = String(performed_time).trim();
      if (/^\d{2}:\d{2}$/.test(hhmm)) {
        parts.push(`transfer_time=$${idx++}`);
        vals.push(`${hhmm}:00`);
      } else if (hhmm) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'invalid performed_time' });
      }
    }
    if (!parts.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'no fields to update' });
    }
    parts.push(`updated_at=NOW()`);
    vals.push(id);

    const q = await client.query(
      `UPDATE public.fuel_internal_transfers SET ${parts.join(', ')} WHERE id=$${idx} RETURNING *`,
      vals
    );

    // Keep fuel_lots.used_liters/stock_status consistent with append-only logic.
    async function getInboundAddedLiters(c, lotId) {
      const q = await c.query(
        `SELECT COALESCE(SUM(fit.transfer_volume),0) AS added
           FROM public.fuel_internal_transfers fit
           JOIN public.fuel_lots fl ON fl.id = fit.to_lot_id
          WHERE fit.to_lot_id=$1
            AND NOT (
              fit.transfer_to_empty = TRUE
              OR (fit.to_lot_code_change = fl.lot_code_created AND fit.transfer_volume = fl.loaded_liters)
              OR (COALESCE(fit.activity,'') = 'TESTING')
            )`,
        [lotId]
      );
      return Number(q.rows[0]?.added || 0);
    }
    async function getOutboundUsedLiters(c, lotId) {
      const sales = await c.query(`SELECT COALESCE(SUM(sale_volume_liters),0) AS s FROM public.fuel_sale_transfers WHERE lot_id=$1`, [lotId]);
      const xfers = await c.query(`SELECT COALESCE(SUM(transfer_volume),0) AS x FROM public.fuel_internal_transfers WHERE from_lot_id=$1 AND COALESCE(activity,'') <> 'TESTING'`, [lotId]);
      return Number(sales.rows[0]?.s || 0) + Number(xfers.rows[0]?.x || 0);
    }
    async function recomputeLot(c, lotId) {
      if (!lotId) return;
      const lotQ = await c.query(`SELECT * FROM public.fuel_lots WHERE id=$1 FOR UPDATE`, [lotId]);
      if (!lotQ.rows.length) return;
      const lot = lotQ.rows[0];
      const inboundAdded = await getInboundAddedLiters(c, lotId);
      const usedOut = await getOutboundUsedLiters(c, lotId);
      const netRemaining = (Number(lot.loaded_liters || 0) + inboundAdded) - usedOut;
      const stock = netRemaining <= 0 ? 'SOLD' : 'INSTOCK';
      await c.query(
        `UPDATE public.fuel_lots
            SET used_liters=$2,
                stock_status=$3,
                updated_at=NOW()
          WHERE id=$1`,
        [lotId, usedOut, stock]
      );
    }

    await recomputeLot(client, existing.from_lot_id);
    await recomputeLot(client, existing.to_lot_id);

    if (isUnfreezeWindow(tripRow)) {
      const tripSnapAfter = tripRow ? await getTripReadingsSnapshot(client, tripRow) : null;
      await insertFuelOpsAudit(client, {
        user_id: req.user?.sub || null,
        username: getActor(req),
        tab: 'At Depot',
        section: 'Sales & Transfers',
        action: 'UPDATE',
        entity_type: 'INTERNAL_TRANSFER',
        entity_id: id,
        unit_id: existing.from_unit_id || null,
        unit_type: 'TRUCK',
        trip_id: tripRow?.id || null,
        trip_no: tripRow?.trip_no || null,
        op_date: opDate,
        performed_time: null, // show audit time via created_at in UI
        amount_liters: q.rows[0]?.transfer_volume || null,
        payload_old: (tripSnapBefore ? { ...existing, ...tripSnapBefore } : existing),
        payload_new: (q.rows[0] ? (tripSnapAfter ? { ...q.rows[0], ...tripSnapAfter } : q.rows[0]) : (tripSnapAfter ? { ...tripSnapAfter } : null)),
        reason: null,
        request_id: req.headers['x-request-id'] || null,
        ip_addr: getClientIp(req),
      });
    }

    await client.query('COMMIT');
    if (!q.rows.length) return res.status(404).json({ error: 'not found' });
    res.json(q.rows[0]);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    res.status(e.status || 500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// Full update of an internal transfer, including activity, date/time, from/to units, volume, and driver
// Recomputes lot pointers and lot statuses to remain consistent with append-only sums logic
app.put('/api/fuel-ops/transfers/internal/:id/full', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
    const { activity, from_unit_id, to_unit_id, volume_liters, driver_id, transfer_date, performed_time } = req.body || {};
    const act = String(activity || '').toUpperCase();
    if (!new Set(['TANKER_TO_TANKER','TANKER_TO_DATUM']).has(act)) return res.status(400).json({ error: 'invalid activity' });
    const fromId = parseInt(from_unit_id, 10);
    const toId = parseInt(to_unit_id, 10);
    const vol = parseLiters3(volume_liters);
    if (!Number.isFinite(fromId) || fromId <= 0) return res.status(400).json({ error: 'from_unit_id required' });
    if (!Number.isFinite(toId) || toId <= 0) return res.status(400).json({ error: 'to_unit_id required' });
    if (!Number.isFinite(vol) || vol <= 0) return res.status(400).json({ error: 'volume_liters must be > 0' });

    await client.query('BEGIN');
    const existingQ = await client.query(`SELECT * FROM public.fuel_internal_transfers WHERE id=$1 FOR UPDATE`, [id]);
    if (!existingQ.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not found' }); }
    const existing = existingQ.rows[0];

    // Enforce trip lock (closed/frozen)
    const existingOpDate = existing.transfer_date ? isoDateOnly(existing.transfer_date) : null;
    const tripRow = await getTripRowForOp(client, existing.from_unit_id, existingOpDate, existing.trip);
    await assertOpEditableByTripState(client, tripRow, req);

    const tripSnapBefore = tripRow ? await getTripReadingsSnapshot(client, tripRow) : null;

    // Resolve driver (optional)
    let drow = null;
    if (driver_id != null) {
      const dr = await client.query(`SELECT id, name, driver_id FROM public.drivers WHERE id=$1`, [parseInt(driver_id,10)]);
      drow = dr.rows[0] || null;
    }

    // Determine date-only and timestamp
    const dateOnly = transfer_date ? isoDateOnly(transfer_date) : (existing.transfer_date ? isoDateOnly(existing.transfer_date) : isoDateOnly(new Date()));
    const hhmm = (performed_time || '').trim();
    const tsSql = (/^\d{2}:\d{2}$/.test(hhmm) && dateOnly) ? `${dateOnly} ${hhmm}:00` : (dateOnly ? `${dateOnly} 00:00:00` : null);

    // Helper: inbound added (exclude seeding) for a lot
    async function getInboundAddedLiters(c, lotId) {
      const q = await c.query(
        `SELECT COALESCE(SUM(fit.transfer_volume),0) AS added
           FROM public.fuel_internal_transfers fit
           JOIN public.fuel_lots fl ON fl.id = fit.to_lot_id
          WHERE fit.to_lot_id=$1
            AND NOT (
              fit.transfer_to_empty = TRUE
                   OR (fit.to_lot_code_change = fl.lot_code_created AND fit.transfer_volume = fl.loaded_liters)
                   OR (COALESCE(fit.activity,'') = 'TESTING')
            )`,
        [lotId]
      );
      return Number(q.rows[0]?.added || 0);
    }
    // Helper: outbound used (sales + internal transfers) for a lot
    async function getOutboundUsedLiters(c, lotId) {
      const sales = await c.query(`SELECT COALESCE(SUM(sale_volume_liters),0) AS s FROM public.fuel_sale_transfers WHERE lot_id=$1`, [lotId]);
  const xfers = await c.query(`SELECT COALESCE(SUM(transfer_volume),0) AS t FROM public.fuel_internal_transfers WHERE from_lot_id=$1 AND COALESCE(activity,'') <> 'TESTING'`, [lotId]);
      return Number(sales.rows[0]?.s || 0) + Number(xfers.rows[0]?.t || 0);
    }

    // Resolve unit codes and lots
    const fromUnit = await client.query(`SELECT id, unit_code, unit_type, capacity_liters FROM public.storage_units WHERE id=$1`, [fromId]);
    const toUnit = await client.query(`SELECT id, unit_code, unit_type, capacity_liters FROM public.storage_units WHERE id=$1`, [toId]);
    if (!fromUnit.rows.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'invalid from_unit_id' }); }
    if (!toUnit.rows.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'invalid to_unit_id' }); }
    const fromCode = fromUnit.rows[0].unit_code;
    const toCode = toUnit.rows[0].unit_code;

    // Find in-stock lots for from/to; if to has none, create EMPTY_TRANSFER lot seeded with this transfer volume
    const lotFromQ = await client.query(`SELECT * FROM public.fuel_lots WHERE unit_id=$1 AND stock_status='INSTOCK' ORDER BY created_at DESC, id DESC LIMIT 1`, [fromId]);
    if (!lotFromQ.rows.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'No in-stock lot for source unit' }); }
    const lotFrom = lotFromQ.rows[0];

  let lotToQ = await client.query(`SELECT * FROM public.fuel_lots WHERE unit_id=$1 AND stock_status='INSTOCK' ORDER BY created_at DESC, id DESC LIMIT 1`, [toId]);
    let createdNewDestLot = false;
    if (!lotToQ.rows.length) {
      const tRow = toUnit.rows[0];
      if (tRow && (tRow.unit_type === 'DATUM' || tRow.unit_type === 'TRUCK')) {
        // capacity guard
        const cap = Number(tRow.capacity_liters || 0);
        if (cap > 0 && vol > cap) { await client.query('ROLLBACK'); return res.status(400).json({ error: `destination capacity exceeded: would be ${vol}/${cap}` }); }
        const dateCol = await resolveFuelLotsDateCol();
        const created = await client.query(`
          WITH seq AS (
            SELECT COALESCE(MAX(seq_index),0)+1 AS next
              FROM public.fuel_lots
             WHERE unit_id=$1 AND ${dateCol} = CURRENT_DATE
          )
          INSERT INTO public.fuel_lots (
            unit_id, tanker_code, tanker_capacity, ${dateCol}, seq_index, seq_letters,
            loaded_liters, lot_code_created, stock_status, used_liters, updated_at, load_type
          )
          SELECT $1, $2, $3, CURRENT_DATE, s.next, public.seq_index_to_letters(s.next),
                 $4, public.gen_lot_code($2, CURRENT_DATE, s.next, $4), 'INSTOCK', 0, NOW(), 'EMPTY_TRANSFER'
            FROM seq s
            RETURNING *
        `, [toId, toCode, toUnit.rows[0].capacity_liters, vol]);
        lotToQ = created; createdNewDestLot = true;
      }
    }
    if (!lotToQ.rows.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'No in-stock lot for destination unit' }); }
    const lotTo = lotToQ.rows[0];

    // Capacity guard for destination with current net
    const destCap = Number(toUnit.rows[0].capacity_liters || 0);
    if (destCap > 0) {
      const toAddedBefore = createdNewDestLot ? 0 : await getInboundAddedLiters(client, lotTo.id);
      const toUsedBefore = createdNewDestLot ? 0 : await getOutboundUsedLiters(client, lotTo.id);
      const toCurrentNet = (createdNewDestLot ? 0 : (Number(lotTo.loaded_liters) + toAddedBefore - toUsedBefore));
      const toNetAfter = toCurrentNet + vol;
      if (toNetAfter > destCap) { await client.query('ROLLBACK'); return res.status(400).json({ error: `destination capacity exceeded: would be ${toNetAfter}/${destCap}` }); }
    }

    // Update transfer row core fields first (lot pointers, units, volume, activity, driver, timestamps, date)
   const upd1 = await client.query(`
    UPDATE public.fuel_internal_transfers
      SET from_lot_id=$2, to_lot_id=$3,
         from_unit_id=$4, to_unit_id=$5,
         from_unit_code=$6, to_unit_code=$7,
         transfer_volume=$8,
         activity=$9,
         driver_name=$10,
         transfer_time=COALESCE($11::time, transfer_time),
         transfer_date=COALESCE($12::date, transfer_date),
         updated_at=NOW()
     WHERE id=$1
     RETURNING *
   `, [id, lotFrom.id, lotTo.id, fromId, toId, fromCode, toCode, vol, act, drow ? drow.name : null, (tsSql ? hhmm : null), dateOnly]);
    if (!upd1.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not found after update' }); }

    // Recompute used/inbound to build after codes and adjust lot stock and used
    const fromAddedCum = await getInboundAddedLiters(client, lotFrom.id);
    const fromUsedNow = await getOutboundUsedLiters(client, lotFrom.id);
    const fromSuffix = `-${fromUsedNow}` + (fromAddedCum > 0 ? `+(${fromAddedCum})` : '');
  const fromLotCodeAfter = `${lotFrom.lot_code_created}${fromSuffix}`;

    const toAddedAfter = createdNewDestLot ? 0 : await getInboundAddedLiters(client, lotTo.id);
    const toUsedOut = createdNewDestLot ? 0 : await getOutboundUsedLiters(client, lotTo.id);
    // Use authoritative outbound-used for suffix; cached lotTo.used_liters may be stale.
    const toSuffix = createdNewDestLot ? '' : (`-${toUsedOut}` + (toAddedAfter > 0 ? `+(${toAddedAfter})` : ''));
  const toLotCodeAfter = `${lotTo.lot_code_created}${toSuffix}`;

  await client.query(`UPDATE public.fuel_internal_transfers SET from_lot_code_change=$2, to_lot_code_change=$3 WHERE id=$1`, [id, fromLotCodeAfter, toLotCodeAfter]);

    // Ensure destination lot reflects the actual purchase time when it represents an EMPTY_TRANSFER seed.
    // Case 1: Lot got created in this update (createdNewDestLot) and we have a performed_time -> set load_time.
    // Case 2: Lot was created earlier without time and user edited performed_time later -> also set load_time
    //         as long as the destination lot is an EMPTY_TRANSFER lot.
    try {
      if (tsSql) {
        const shouldStampLoadTime = createdNewDestLot || (lotTo && String(lotTo.load_type).toUpperCase() === 'EMPTY_TRANSFER');
        if (shouldStampLoadTime) {
          await client.query(`UPDATE public.fuel_lots SET load_time=$1::timestamp WHERE id=$2`, [tsSql, lotTo.id]);
        }
      }
    } catch (e) { if (!process.env.SUPPRESS_DB_LOG) console.warn('[warn] full update set load_time failed', e.message); }

    await recomputeFuelLotUsedAndStatus(client, lotFrom.id);
    await recomputeFuelLotUsedAndStatus(client, lotTo.id);

    if (isUnfreezeWindow(tripRow)) {
      const tripSnapAfter = tripRow ? await getTripReadingsSnapshot(client, tripRow) : null;
      await insertFuelOpsAudit(client, {
        user_id: req.user?.sub || null,
        username: getActor(req),
        tab: 'At Depot',
        section: 'Sales & Transfers',
        action: 'UPDATE',
        entity_type: 'INTERNAL_TRANSFER',
        entity_id: id,
        unit_id: existing.from_unit_id || null,
        unit_type: 'TRUCK',
        trip_id: tripRow?.id || null,
        trip_no: tripRow?.trip_no || null,
        op_date: dateOnly,
        performed_time: null, // show audit time via created_at in UI
        amount_liters: vol,
        payload_old: (tripSnapBefore ? { ...existing, ...tripSnapBefore } : existing),
        payload_new: (upd1.rows[0] ? (tripSnapAfter ? { ...upd1.rows[0], ...tripSnapAfter } : upd1.rows[0]) : (tripSnapAfter ? { ...tripSnapAfter } : null)),
        reason: null,
        request_id: req.headers['x-request-id'] || null,
        ip_addr: getClientIp(req),
      });
    }

    await client.query('COMMIT');
    const finalQ = await pool.query(`SELECT * FROM public.fuel_internal_transfers WHERE id=$1`, [id]);
    res.json(finalQ.rows[0]);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// [ARCHIVED 2026-02-19] readings/* endpoints (4 routes) -- moved to legacy-monolith-backup/routes/archived_unused_handlers.js

function isValidDateTimeString(s) {
  if (!s || typeof s !== 'string') return false;
  // Accept YYYY-MM-DD HH:mm[:ss] or ISO-like
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s)) return true;
  // Accept DD-MM-YYYY HH:mm[:ss]
  if (/^\d{2}-\d{2}-\d{4}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/.test(s)) return true;
  // Accept a parseable ISO as a fallback
  const d = new Date(s);
  return !isNaN(d.getTime());
}
// Format a Date as local-time SQL timestamp (YYYY-MM-DD HH:mm:ss) without TZ conversion
function fmtSqlTsLocal(d) {
  const x = new Date(d);
  const pad = n => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${pad(x.getMonth()+1)}-${pad(x.getDate())} ${pad(x.getHours())}:${pad(x.getMinutes())}:${pad(x.getSeconds())}`;
}
// Coerce various user-entered date/time strings into a local SQL timestamp string.
// Rules:
// - If input is 'YYYY-MM-DD HH:mm[:ss]' or 'YYYY-MM-DDTHH:mm[:ss]', keep the local wall clock time as-entered.
// - If input is 'DD-MM-YYYY HH:mm[:ss]' (or with 'T'), convert to YYYY-MM-DD and keep local time.
// - If input contains explicit TZ (Z/+hh:mm), parse and then format as local wall time.
function coerceLocalSqlTimestamp(input) {
  if (!input) return null;
  let s = String(input).trim();
  if (!s) return null;
  // Normalize T to space for simple patterns
  s = s.replace('T', ' ');
  // DD-MM-YYYY [HH:mm[:ss]]
  let m = s.match(/^(\d{2})-(\d{2})-(\d{4})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const [, dd, mm, yyyy, HH='00', MM='00', SS='00'] = m;
    return `${yyyy}-${mm}-${dd} ${HH}:${MM}:${SS}`;
  }
  // YYYY-MM-DD [HH:mm[:ss]] (no timezone) -> keep local wall time
  m = s.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const [, yyyy, mm, dd, HH, MM, SS='00'] = m;
    return `${yyyy}-${mm}-${dd} ${HH}:${MM}:${SS}`;
  }
  // If string contains explicit timezone (Z or +hh:mm), parse and render in local
  if (/Z|[+-]\d{2}:\d{2}$/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return fmtSqlTsLocal(d);
  }
  // Fallback: try Date parse and render as local
  const d = new Date(s);
  if (!isNaN(d.getTime())) return fmtSqlTsLocal(d);
  return null;
}
// Example route to test DB connection
// Remove or modify as needed
app.get('/api/test-db', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ time: result.rows[0].now });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Optional: auto-run schema migration at boot when enabled via env
async function autoMigrateIfEnabled() {
  const flag = String(process.env.AUTO_MIGRATE || process.env.MIGRATE_ON_START || '').toLowerCase();
  const enabled = flag === '1' || flag === 'true' || flag === 'yes' || flag === 'on';
  if (!enabled) return;
  try {
    const fs = require('fs');
    const path = require('path');
    const pool = require('./db');
    const schemaPath = path.join(__dirname, 'schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
      console.log('[auto-migrate] schema.sql applied successfully');
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('[auto-migrate] failed:', e.message);
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('[auto-migrate] error:', e.message);
  }
}

let server;
(async () => {
  await autoMigrateIfEnabled();
  const port = Number(process.env.PORT || 5002);
  // On some Windows setups Node binds to IPv6-only by default, which breaks CRA proxy
  // when it resolves localhost -> 127.0.0.1. Default to IPv4-friendly binding.
  const host = '0.0.0.0';
  server = app.listen(port, host, () => {
    console.log(`Server running on http://localhost:${port}`);
  });
})();
// Graceful shutdown to avoid data loss
function shutdown(signal) {
  console.log(`\n[${signal}] Shutting down gracefully...`);
  server.close(() => {
    try { require('./db').end && require('./db').end(); } catch {}
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
// Global error handler
// Note: keep last
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[UnhandledError]', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal server error' });
});

// ===========================
// Auth Endpoints (Phase 1)
// ===========================
// Register initial OWNER (only allowed if no owner exists)
app.post('/api/auth/register-initial', async (req, res) => {
  try {
    const { email, password, full_name } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    if (await ownerExists()) return res.status(400).json({ error: 'Owner already exists' });
    const pwHash = await hashPassword(password);
    const newId = randomUUID();
    const uname = String(email).toLowerCase().split('@')[0];
    const r = await pool.query(
      'INSERT INTO public.users (id, email, username, full_name, role, password_hash, must_change_password) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, email, username, full_name, role, created_at',
      [newId, String(email).toLowerCase(), uname, full_name || null, 'OWNER', pwHash, false]
    );
    const user = r.rows[0];
    const token = signToken(user);
    res.status(201).json({ user, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Owner exists check
app.get('/api/auth/owner-exists', async (req, res) => {
  try {
    const exists = await ownerExists();
    res.json({ exists });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Login (identifier = username or email)
app.post('/api/auth/login', async (req, res) => {
  try {
    const { identifier, email, password } = req.body || {};
    const idOrEmail = identifier || email;
    if (!idOrEmail || !password) return res.status(400).json({ error: 'identifier/email and password required' });
    // Single flexible lookup: accept either username OR email in one query (case-insensitive)
    const val = String(idOrEmail).trim();
    let r = await pool.query(
      'SELECT * FROM public.users WHERE active=TRUE AND (LOWER(username)=LOWER($1) OR LOWER(email)=LOWER($1))',
      [val]
    );
    // Optional: if still not found and identifier looks like a full name, try exact case-insensitive full_name match when unique
    if (r.rows.length === 0 && /\s/.test(val)) {
      const rf = await pool.query('SELECT * FROM public.users WHERE active=TRUE AND LOWER(full_name)=LOWER($1)', [val]);
      if (rf.rows.length === 1) {
        r = rf;
      }
    }
    if (r.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
    const user = r.rows[0];
    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    await pool.query('UPDATE public.users SET last_login=NOW() WHERE id=$1', [user.id]);
    const pub = { id: user.id, email: user.email, username: user.username, phone: user.phone, full_name: user.full_name, role: user.role, must_change_password: user.must_change_password };
    const token = signToken(pub);
    res.json({ user: pub, token, requirePasswordChange: !!user.must_change_password });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Current user
app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
  const r = await pool.query('SELECT id, email, username, phone, full_name, role, must_change_password, created_at, last_login, active, joining_date, status FROM public.users WHERE id=$1', [req.user.sub]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Change password (requires auth); supports first-login change and regular change
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  try {
    const userId = req.user.sub;
    const { currentPassword, newPassword } = req.body || {};
    if (!newPassword) return res.status(400).json({ error: 'newPassword required' });
  const r = await pool.query('SELECT id, password_hash, must_change_password FROM public.users WHERE id=$1 AND active=TRUE', [userId]);
    if (!r.rows.length) return res.status(404).json({ error: 'User not found' });
    const row = r.rows[0];
    // If not first login, require currentPassword
    if (!row.must_change_password) {
      if (!currentPassword) return res.status(400).json({ error: 'currentPassword required' });
      const ok = await verifyPassword(currentPassword, row.password_hash);
      if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });
    }
    const hash = await hashPassword(newPassword);
  await pool.query('UPDATE public.users SET password_hash=$1, must_change_password=FALSE, last_password_change_at=NOW() WHERE id=$2', [hash, userId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Create user (OWNER or ADMIN). Role creation rules depend on creator role.
const ROLE_LIMITS = Object.freeze({
  ADMIN: Math.max(parseInt(process.env.MAX_ADMINS || '10', 10) || 10, 0),
  OWNER: Math.max(parseInt(process.env.MAX_OWNERS || '6', 10) || 6, 0),
  EMPLOYEE: Math.max(parseInt(process.env.MAX_EMPLOYEES || '100', 10) || 100, 0),
});

async function assertRoleLimit(role, { excludeUserId } = {}) {
  const cap = ROLE_LIMITS[role];
  if (!cap || cap <= 0) return; // treat 0/undefined as unlimited
  const params = [role];
  let sql = 'SELECT COUNT(*)::int AS c FROM public.users WHERE active=TRUE AND role=$1';
  if (excludeUserId) {
    params.push(excludeUserId);
    sql += ` AND id<>$${params.length}`;
  }
  const r = await pool.query(sql, params);
  const count = (r.rows[0] && r.rows[0].c) || 0;
  if (count >= cap) {
    const label = role === 'EMPLOYEE' ? 'employee' : role.toLowerCase();
    const plural = cap === 1 ? '' : 's';
    throw new Error(`Account limit reached: max ${cap} active ${label}${plural}`);
  }
}

app.post('/api/users', requireAuth, requireRole('OWNER','ADMIN'), async (req, res) => {
  try {
    const { email, username, phone, password, role, full_name, joining_date, status } = req.body || {};
    // Enforce username mandatory (email optional)
    if (!username || !password || !role) return res.status(400).json({ error: 'username, password, role required' });
    const rRole = role.toUpperCase();
    // Creator-based role constraints
    const creator = req.user; // { sub, role }
    if (creator.role === 'OWNER') {
      // As requested: OWNER may create OWNER or EMPLOYEE only (no ADMIN)
      if (!['OWNER','EMPLOYEE'].includes(rRole)) return res.status(400).json({ error: 'OWNER can create only OWNER or EMPLOYEE' });
    } else if (creator.role === 'ADMIN') {
      // ADMIN may create OWNER, ADMIN, or EMPLOYEE
      if (!['OWNER','ADMIN','EMPLOYEE'].includes(rRole)) return res.status(400).json({ error: 'Invalid role' });
    } else {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Enforce role caps (active accounts). Admin/Owner bypass UI gating but not hard limits.
    await assertRoleLimit(rRole);

    // Uniqueness checks (email and username if provided)
    if (email) {
      const exists = await pool.query('SELECT 1 FROM public.users WHERE email=$1', [String(email).toLowerCase()]);
      if (exists.rows.length) return res.status(409).json({ error: 'Email already in use' });
    }
    if (username) {
      const existsU = await pool.query('SELECT 1 FROM public.users WHERE LOWER(username)=LOWER($1)', [String(username)]);
      if (existsU.rows.length) return res.status(409).json({ error: 'Username already in use' });
    }
    const pwHash = await hashPassword(password);
    const newId = randomUUID();
    const ins = await pool.query(
      'INSERT INTO public.users (id, email, username, phone, full_name, role, password_hash, must_change_password, joining_date, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, email, username, phone, full_name, role, created_at, joining_date, status',
      [newId, email ? String(email).toLowerCase() : null, username || null, phone || null, full_name || null, rRole, pwHash, true, joining_date || null, status || 'ACTIVE']
    );
    res.status(201).json(ins.rows[0]);
  } catch (err) {
    console.error(err);
    // Friendly message for legacy DBs that still have the one-owner constraint
    const msg = String(err && err.message ? err.message : '');
    if ((err && err.code === '23505' && String(err.constraint || '').toLowerCase().includes('uniq_active_owner')) || msg.includes('uniq_active_owner')) {
      return res.status(400).json({ error: 'This database is configured to allow only one active OWNER. Run migrations to remove uniq_active_owner, or change the owner limit configuration.' });
    }
    res.status(500).json({ error: err.message });
  }
});

// List users (OWNER or ADMIN). ADMIN can see all users, including OWNER.
app.get('/api/users', requireAuth, requireRole('OWNER','ADMIN'), async (req, res) => {
  try {
    const r = await pool.query('SELECT id, email, username, phone, full_name, role, active, created_at, last_login, joining_date, status FROM public.users ORDER BY role, COALESCE(username,email)');
    res.json(r.rows);
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
});

// Update user fields (Owner/Admin)
// Supports: status, joining_date, full_name, email, phone, username, role (with creator-role constraints)
app.patch('/api/users/:id', requireAuth, requireRole('OWNER','ADMIN'), async (req, res) => {
  try {
    const id = req.params.id;
    let { status, joining_date, full_name, email, phone, username, role } = req.body || {};

    const current = await pool.query('SELECT id, role, active FROM public.users WHERE id=$1', [id]);
    if (!current.rows.length) return res.status(404).json({ error: 'User not found' });
    const currentRole = current.rows[0].role;
    const isActive = !!current.rows[0].active;

    // Validate status (optional)
    const allowedStatus = new Set(['ACTIVE','INACTIVE','ON_LEAVE','SUSPENDED']);
    if (status !== undefined) {
      status = String(status).toUpperCase();
      if (!allowedStatus.has(status)) return res.status(400).json({ error: 'Invalid status' });
    }

    // Validate joining_date (optional) - must be YYYY-MM-DD
    if (joining_date !== undefined && joining_date !== null) {
      const s = String(joining_date);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        return res.status(400).json({ error: 'joining_date must be YYYY-MM-DD' });
      }
    }

    // Normalize email/username (optional)
    if (email !== undefined && email !== null) email = String(email).toLowerCase();
    if (username !== undefined && username !== null) username = String(username);

    // Role change rules follow creator constraints used in create
    if (role !== undefined && role !== null) {
      const newRole = String(role).toUpperCase();
      if (req.user.role === 'OWNER') {
        if (!['OWNER','EMPLOYEE'].includes(newRole)) return res.status(400).json({ error: 'OWNER can set role only to OWNER or EMPLOYEE' });
      } else if (req.user.role === 'ADMIN') {
        if (!['OWNER','ADMIN','EMPLOYEE'].includes(newRole)) return res.status(400).json({ error: 'Invalid role' });
      }
      role = newRole;

      // Enforce caps when changing roles for active accounts
      if (isActive && role !== currentRole) {
        await assertRoleLimit(role, { excludeUserId: id });
      }
    }

    // Build dynamic update
    const sets = [];
    const params = [];
    const add = (sqlFragment, val) => { params.push(val); sets.push(sqlFragment.replace('$idx', `$${params.length}`)); };
    if (status !== undefined) add('status=$idx', status);
    if (joining_date !== undefined) add('joining_date=$idx', joining_date || null);
    if (full_name !== undefined) add('full_name=$idx', full_name || null);
    if (email !== undefined) {
      // Uniqueness check for email
      if (email) {
        const e = await pool.query('SELECT 1 FROM public.users WHERE email=$1 AND id<>$2', [email, id]);
        if (e.rows.length) return res.status(409).json({ error: 'Email already in use' });
      }
      add('email=$idx', email || null);
    }
    if (phone !== undefined) add('phone=$idx', phone || null);
    if (username !== undefined) {
      if (username) {
        const u = await pool.query('SELECT 1 FROM public.users WHERE LOWER(username)=LOWER($1) AND id<>$2', [username, id]);
        if (u.rows.length) return res.status(409).json({ error: 'Username already in use' });
      }
      add('username=$idx', username || null);
    }
    if (role !== undefined) add('role=$idx', role);

    if (!sets.length) return res.status(400).json({ error: 'No updatable fields provided' });
    params.push(id);
    const sql = `UPDATE public.users SET ${sets.join(', ')} WHERE id=$${params.length} RETURNING id, email, username, phone, full_name, role, active, created_at, last_login, joining_date, status`;
    const r = await pool.query(sql, params);
    if (!r.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
});

// Reset password for a specific user (ADMIN: can reset OWNER/ADMIN/EMPLOYEE; OWNER: can reset OWNER/EMPLOYEE)
app.post('/api/users/:id/password-reset', requireAuth, requireRole('OWNER','ADMIN'), async (req, res) => {
  try {
    const id = req.params.id;
    const { newPassword } = req.body || {};
    if (!newPassword || String(newPassword).length < 6) {
      return res.status(400).json({ error: 'newPassword must be at least 6 characters' });
    }
    const ru = await pool.query('SELECT id, role, active, email, username, full_name FROM public.users WHERE id=$1', [id]);
    if (!ru.rows.length) return res.status(404).json({ error: 'User not found' });
    const target = ru.rows[0];
    if (!target.active) return res.status(400).json({ error: 'User is inactive' });
    // Owner cannot reset Admin passwords
    if (req.user.role === 'OWNER' && target.role === 'ADMIN') {
      return res.status(403).json({ error: 'OWNER cannot reset ADMIN password' });
    }
    const hash = await hashPassword(String(newPassword));
    await pool.query('UPDATE public.users SET password_hash=$1, must_change_password=FALSE, last_password_change_at=NOW() WHERE id=$2', [hash, id]);
    // Audit log (non-fatal on failure)
    try {
      const actorId = req.user && req.user.sub;
      const actorRole = req.user && req.user.role;
      // Username-first policy for audit actor label
      const actor = (req.user && (req.user.username || req.user.full_name || req.user.email)) || getActor(req);
      await pool.query(
        `INSERT INTO public.users_password_audit (
           target_user_id, target_email, target_username, target_full_name, target_role,
           changed_by_user_id, changed_by, changed_by_role, performed_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())`,
        [target.id, target.email || null, target.username || null, target.full_name || null, target.role || null,
         actorId || null, actor || null, actorRole || null]
      );
    } catch (e) {
      console.warn('users_password_audit insert failed:', e.message);
    }
    return res.json({ success: true });
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
});

// =============================
// Profile APIs
// =============================
// Get my profile (combines users + user_profiles)
app.get('/api/profile/me', requireAuth, async (req, res) => {
  try {
    const userId = req.user.sub;
    const ur = await pool.query('SELECT id, email, username, phone, full_name, role, joining_date, status FROM public.users WHERE id=$1', [userId]);
    if (!ur.rows.length) return res.status(404).json({ error: 'User not found' });
    const pr = await pool.query('SELECT date_of_birth, gender, emergency_contact_name, emergency_contact_phone, address, pan, aadhaar, aadhaar_last4, updated_at FROM public.user_profiles WHERE user_id=$1', [userId]);
    const base = ur.rows[0];
    const prof = pr.rows[0] || null;
    res.json({ user: base, profile: prof });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Update my profile
app.put('/api/profile', requireAuth, async (req, res) => {
  try {
    const userId = req.user.sub;
    const { full_name, phone, email, date_of_birth, gender, emergency_contact_name, emergency_contact_phone, address, pan, aadhaar } = req.body || {};
    let panNorm = null;
    if (pan) { if (!isValidPan(pan)) return res.status(400).json({ error: 'Invalid PAN format' }); panNorm = normalizePan(pan); }
    if (aadhaar) { if (!isValidAadhaar(aadhaar)) return res.status(400).json({ error: 'Invalid Aadhaar number' }); }
    // Phone normalization: return 400 if provided but invalid
    let phoneNorm = undefined;
    if (phone !== undefined) {
      if (phone === null || String(phone).trim()==='') phoneNorm = null; else {
        const n = normalizePhone(phone);
        if (!n) return res.status(400).json({ error: 'Invalid phone' });
        phoneNorm = n;
      }
    }

    if (full_name !== undefined || phone !== undefined || email !== undefined) {
      const r = await pool.query('UPDATE public.users SET full_name=COALESCE($1, full_name), phone=COALESCE($2, phone), email=COALESCE($3, email) WHERE id=$4 RETURNING id', [full_name ?? null, phoneNorm ?? null, email ? String(email).toLowerCase() : null, userId]);
      if (!r.rows.length) return res.status(404).json({ error: 'User not found' });
    }

    const existing = await pool.query('SELECT 1 FROM public.user_profiles WHERE user_id=$1', [userId]);
    const aadhaarLast4 = aadhaar ? last4(aadhaar) : undefined;
    if (existing.rows.length) {
      const up = await pool.query(
        `UPDATE public.user_profiles SET date_of_birth=$1, gender=$2, emergency_contact_name=$3, emergency_contact_phone=$4, address=$5, pan=$6, pan_normalized=$7, aadhaar=$8, aadhaar_last4=COALESCE($9, aadhaar_last4) WHERE user_id=$10 RETURNING date_of_birth, gender, emergency_contact_name, emergency_contact_phone, address, pan, aadhaar, aadhaar_last4, updated_at`,
        [date_of_birth || null, gender || null, emergency_contact_name || null, emergency_contact_phone || null, address || null, pan || null, panNorm || null, aadhaar || null, aadhaarLast4 || null, userId]
      );
      return res.json({ ok: true, profile: up.rows[0] });
    } else {
      const ins = await pool.query(
        `INSERT INTO public.user_profiles (user_id, date_of_birth, gender, emergency_contact_name, emergency_contact_phone, address, pan, pan_normalized, aadhaar, aadhaar_last4) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING date_of_birth, gender, emergency_contact_name, emergency_contact_phone, address, pan, aadhaar, aadhaar_last4, updated_at`,
        [userId, date_of_birth || null, gender || null, emergency_contact_name || null, emergency_contact_phone || null, address || null, pan || null, panNorm || null, aadhaar || null, aadhaarLast4 || null]
      );
      return res.json({ ok: true, profile: ins.rows[0] });
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Upload or replace my photo
app.post('/api/profile/photo', requireAuth, async (req, res) => {
  try {
    const userId = req.user.sub;
    const { dataUrl } = req.body || {};
    if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return res.status(400).json({ error: 'dataUrl required' });
    const m = /^data:(.*?);base64,(.*)$/.exec(dataUrl);
    if (!m) return res.status(400).json({ error: 'Invalid dataUrl' });
    const mime = m[1];
    const b64 = m[2];
    const buf = Buffer.from(b64, 'base64');
    if (!/^image\/(png|jpeg|jpg|webp)$/.test(mime)) return res.status(400).json({ error: 'Only PNG/JPEG/WEBP allowed' });
    if (buf.length > 5 * 1024 * 1024) return res.status(400).json({ error: 'Image too large' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM public.user_photos WHERE user_id=$1', [userId]);
      const ins = await client.query('INSERT INTO public.user_photos (user_id, mime_type, file_name, file_size_bytes, data) VALUES ($1,$2,$3,$4,$5) RETURNING id', [userId, mime, 'profile.' + (mime.split('/')[1] || 'png'), buf.length, buf]);
      await client.query('COMMIT');
      res.json({ ok: true, id: ins.rows[0].id });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Get my photo
app.get('/api/profile/photo/me', requireAuth, async (req, res) => {
  try {
    const userId = req.user.sub;
    const r = await pool.query('SELECT mime_type, data FROM public.user_photos WHERE user_id=$1 LIMIT 1', [userId]);
    if (!r.rows.length) return res.status(404).end();
    res.setHeader('Content-Type', r.rows[0].mime_type);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(r.rows[0].data);
  } catch (e) {
    console.error(e);
    res.status(500).end();
  }
});

// Delete my photo
app.delete('/api/profile/photo', requireAuth, async (req, res) => {
  try {
    const userId = req.user.sub;
    await pool.query('DELETE FROM public.user_photos WHERE user_id=$1', [userId]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Get a specific user's photo (Admin/Owner only, or self)
app.get('/api/profile/photo/:userId', requireAuth, async (req, res) => {
  try {
    const targetId = req.params.userId;
    if (!(req.user.sub === targetId || req.user.role === 'OWNER' || req.user.role === 'ADMIN')) {
      return res.status(403).end();
    }
    const r = await pool.query('SELECT mime_type, data FROM public.user_photos WHERE user_id=$1 LIMIT 1', [targetId]);
    if (!r.rows.length) return res.status(404).end();
    res.setHeader('Content-Type', r.rows[0].mime_type);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(r.rows[0].data);
  } catch (e) { console.error(e); res.status(500).end(); }
});
// Get user permissions (OWNER, ADMIN, or the user themselves)
app.get('/api/users/:id/permissions', requireAuth, async (req, res) => {
  try {
    const id = req.params.id;
    if (req.user.role === 'OWNER' || req.user.role === 'ADMIN' || req.user.sub === id) {
      // ok
    } else {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const r = await pool.query('SELECT user_id, tabs, actions FROM public.user_permissions WHERE user_id=$1', [id]);
    if (!r.rows.length) return res.json({ user_id: id, tabs: {}, actions: {} });
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
});

// Update user permissions (OWNER or ADMIN). Admin can overwrite Owner and Employee permissions.
app.patch('/api/users/:id/permissions', requireAuth, requireRole('OWNER','ADMIN'), async (req, res) => {
  try {
    const id = req.params.id;
    let { tabs, actions, merge } = req.body || {};
    tabs = tabs && typeof tabs === 'object' ? tabs : {};
    actions = actions && typeof actions === 'object' ? actions : {};
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
  const existing = await client.query('SELECT * FROM public.user_permissions WHERE user_id=$1 FOR UPDATE', [id]);
      if (existing.rows.length) {
        if (merge) {
          tabs = { ...existing.rows[0].tabs, ...tabs };
          actions = { ...existing.rows[0].actions, ...actions };
        }
        const upd = await client.query('UPDATE public.user_permissions SET tabs=$1, actions=$2 WHERE user_id=$3 RETURNING user_id, tabs, actions', [tabs, actions, id]);
        await client.query('COMMIT');
        return res.json(upd.rows[0]);
      } else {
        const ins = await client.query('INSERT INTO public.user_permissions (user_id, tabs, actions) VALUES ($1,$2,$3) RETURNING user_id, tabs, actions', [id, tabs, actions]);
        await client.query('COMMIT');
        return res.status(201).json(ins.rows[0]);
      }
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
});

// Read-only combined user profiles (Admin/Owner only). Data source: public.user_full_profiles view
app.get('/api/admin/employee-profiles', requireAuth, requireRole('OWNER','ADMIN'), async (req, res) => {
  try {
    await ensureUserFullProfilesView(pool);
    let { role, q, page = 1, pageSize = 20 } = req.query || {};
    const p = Math.max(parseInt(page, 10) || 1, 1);
    const s = Math.min(Math.max(parseInt(pageSize, 10) || 20, 1), 100);
    const offset = (p - 1) * s;
    const params = [];
    const filters = [];
    if (role) {
      const allowed = ['OWNER','ADMIN','EMPLOYEE'];
      const roles = String(role).split(',').map(x => x.trim().toUpperCase()).filter(r => allowed.includes(r));
      if (roles.length) {
        const ph = roles.map((_, i) => `$${params.length + i + 1}`).join(',');
        params.push(...roles);
        filters.push(`v.role IN (${ph})`);
      }
    }
    if (q) {
      const like = `%${String(q).toLowerCase()}%`;
      params.push(like, like, like, like);
      const b = params.length;
      filters.push(`(
        LOWER(COALESCE(v.full_name,'')) LIKE $${b-3} OR
        LOWER(COALESCE(v.username,'')) LIKE $${b-2} OR
        LOWER(COALESCE(v.email,'')) LIKE $${b-1} OR
        LOWER(COALESCE(v.phone,'')) LIKE $${b}
      )`);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const order = 'ORDER BY v.role, COALESCE(v.full_name, v.username, v.email)';
    const dataSql = `SELECT v.* FROM public.user_full_profiles v ${where} ${order} LIMIT ${s} OFFSET ${offset}`;
    const countSql = `SELECT COUNT(*)::int AS total FROM public.user_full_profiles v ${where}`;
    const [r, c] = await Promise.all([
      pool.query(dataSql, params),
      pool.query(countSql, params)
    ]);
    res.json({ items: r.rows, page: p, pageSize: s, total: c.rows[0]?.total || 0 });
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
});

// Single employee profile by id (Admin/Owner only)
app.get('/api/admin/employee-profile/:userId', requireAuth, requireRole('OWNER','ADMIN'), async (req, res) => {
  try {
    await ensureUserFullProfilesView(pool);
    const id = req.params.userId;
    const r = await pool.query('SELECT * FROM public.user_full_profiles WHERE user_id=$1', [id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});



