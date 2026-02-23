-- Allow multiple OWNER accounts (limit enforced at API level).
-- Previously a partial unique index enforced a single active OWNER.

DROP INDEX IF EXISTS public.uniq_active_owner;
