-- ============================================================================
-- PHASE 26 — BLOCK C: remove all temporary production access
--
-- Run by the owner in psql as `postgres`, ONLY after: dump succeeded, hashes
-- recorded, local restore succeeded, all 28 counts reconciled.
-- One transaction; it ends by asserting that nothing of the reader remains.
-- The role is cluster-wide: no other database of the production cluster may hold
-- objects or grants for it (the snapshot is restored in a different, local cluster).
-- Writes no business row. Drops only the reader's own policies and the role.
-- ============================================================================
\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE r record;
BEGIN
  -- Only policies Block B could have created: this exact name AND this role alone.
  FOR r IN SELECT n.nspname, c.relname
             FROM pg_policy p
             JOIN pg_class c     ON c.oid = p.polrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE p.polname = 'legacy_snapshot_reader_select'
              AND p.polroles = ARRAY[(SELECT oid FROM pg_roles WHERE rolname = 'legacy_snapshot_reader')]::oid[]
  LOOP
    EXECUTE format('DROP POLICY legacy_snapshot_reader_select ON %I.%I', r.nspname, r.relname);
  END LOOP;

  -- Any remaining policy with that name was not created by Block B: stop, touch nothing.
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'legacy_snapshot_reader_select') THEN
    RAISE EXCEPTION 'unexpected policy named legacy_snapshot_reader_select remains — stop';
  END IF;
END $$;

-- Explicit REVOKEs taken from the actual ACLs. DROP OWNED BY is NOT used: on
-- PostgreSQL 16+ a CREATEROLE non-superuser (Supabase `postgres`) holds only
-- ADMIN on the role it created, and DROP OWNED then fails with
-- "permission denied to drop objects" (proven in the static rehearsal).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.oid::regclass AS obj, c.relkind
             FROM pg_class c, aclexplode(c.relacl) a
            WHERE a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'legacy_snapshot_reader')
  LOOP
    EXECUTE format('REVOKE ALL ON %s %s FROM legacy_snapshot_reader',
                   CASE WHEN r.relkind = 'S' THEN 'SEQUENCE' ELSE 'TABLE' END, r.obj);
  END LOOP;
END $$;
REVOKE ALL ON SCHEMA public    FROM legacy_snapshot_reader;
REVOKE ALL ON DATABASE postgres FROM legacy_snapshot_reader;

-- DROP ROLE itself fails if any privilege or dependency on the role remains.
DROP ROLE legacy_snapshot_reader;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legacy_snapshot_reader') THEN
    RAISE EXCEPTION 'role still exists';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'legacy_snapshot_reader_select') THEN
    RAISE EXCEPTION 'reader policy still exists';
  END IF;
END $$;

COMMIT;

-- Post-check (expect 0 / 0 / 0):
SELECT count(*) AS reader_roles    FROM pg_roles    WHERE rolname = 'legacy_snapshot_reader';
SELECT count(*) AS reader_policies FROM pg_policy   WHERE polname = 'legacy_snapshot_reader_select';
SELECT count(*) AS reader_grants   FROM information_schema.role_table_grants
 WHERE grantee = 'legacy_snapshot_reader';
