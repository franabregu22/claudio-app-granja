#!/usr/bin/env bash
# ADR-025 — LOCAL rehearsal of upgrade-004 on a DISPOSABLE database that reproduces the INSTALLED AppGranja bot staging (the
# artifacts of commit 55aa19f: core with upgrades 001 / 003 + upgrade-002 categories). Nothing remote is touched.
#   1 sandbox (auth.uid, pgcrypto, Vault, Supabase default grants)   2 install 55aa19f + baseline 55aa19f suite (published V2 contract)
#   3 preflight-004 (read-only) + rollback file from snapshot-004 + accounting snapshot   4 apply HEAD upgrade-004 (+ idempotent re-apply)
#   5 verify-upgrade-004 (read-only)   6 55aa19f suite again (V2 compatibility) + HEAD suite (new behaviour)
#   7 rollback from the generated file → definitions identical to step 3, new objects gone, 55aa19f suite again   8 sandbox dropped
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$HERE/.."
C=supabase_db_Claudio_app_Granja
SB=wa_sandbox_compat004
OLD=55aa19f
ADM="docker exec -i $C psql -U supabase_admin -d postgres -X -q -t -A"
ADMSB="docker exec -i $C psql -U supabase_admin -d $SB -X -q -t -A"
PG="docker exec -i $C psql -U postgres -d $SB -X -q -t -A"
A=aaaaaaaa-0025-0000-0000-00000000ad0a; B=aaaaaaaa-0025-0000-0000-00000000ad0b; GW=aaaaaaaa-0025-0000-0000-00000000ad0f
VARS="-v admin_a=$A -v admin_b=$B -v oper=aaaaaaaa-0025-0000-0000-00000000ad0c -v gw=$GW -v phone_a=+5491100000001 -v phone_b=+5491100000002 -v phone_oper=+5491100000003"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
for f in 00-guard.sql 01-sim.sql 02-wa-core.sql 03-seed.sql tests.sql upgrade-002-sim-categories.sql; do
  (cd "$ROOT" && git show "$OLD:integrations/whatsapp/wa-staging/build/staging/$f") > "$TMP/old-$f" || { echo "STOP: cannot read $OLD:$f"; exit 2; }
done
suite() { { echo '\set ON_ERROR_STOP 1'; echo 'BEGIN;'; cat "$1"; echo 'ROLLBACK;'; } | $PG $VARS -f - 2>&1 | grep -E "^SUMMARY|FAIL |ERROR" | sed 's/^psql:<stdin>:[0-9]*: //'; }

echo "== 1 sandbox"
$ADM -c "DROP DATABASE IF EXISTS $SB" -c "CREATE DATABASE $SB OWNER postgres" >/dev/null
$ADMSB -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
GRANT USAGE ON SCHEMA auth TO postgres, anon, authenticated, service_role;
CREATE SCHEMA extensions; CREATE EXTENSION pgcrypto SCHEMA extensions;
GRANT USAGE ON SCHEMA extensions TO postgres, anon, authenticated, service_role;
CREATE EXTENSION supabase_vault;
GRANT USAGE ON SCHEMA vault TO postgres; GRANT SELECT, DELETE ON vault.secrets TO postgres; GRANT SELECT ON vault.decrypted_secrets TO postgres;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA vault TO postgres;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
SQL

echo "== 2 install $OLD (the installed AppGranja state) + baseline $OLD suite"
{ echo '\set ON_ERROR_STOP 1'; echo 'BEGIN;'; cat "$TMP"/old-0{0,1,2,3}-*.sql; echo 'COMMIT;'; } | $PG $VARS -f - 2>&1 | grep -E "ERROR" | head -3
{ echo '\set ON_ERROR_STOP 1'; echo 'BEGIN;'; cat "$TMP/old-upgrade-002-sim-categories.sql"; echo 'COMMIT;'; } | $PG -f - 2>&1 | grep -E "ERROR" | head -3
echo "baseline $OLD suite: $(suite "$TMP/old-tests.sql" | tr '\n' ' ')"

echo "== 3 preflight-004 (read-only) + rollback file + accounting snapshot"
$PG -f - < "$HERE/preflight-004.sql" | grep '^pre|'
$PG -f - < "$HERE/snapshot-004.sql" > "$TMP/rollback-004.sql"
MD5PRE=$($PG -c "SELECT md5(pg_get_functiondef('wa.validate_payload(text,jsonb)'::regprocedure)) || '|' || md5(pg_get_functiondef('public.wa_confirm(bigint,uuid,integer)'::regprocedure)) || '|' || md5(pg_get_functiondef('public.wa_context(bigint)'::regprocedure))")
ACCT=$($PG -f - < "$HERE/acct-004.sql" | grep '^acct|' | cut -d'|' -f2-)
echo "rollback file: $(grep -c . "$TMP/rollback-004.sql") lines · accounting: $ACCT"
RBV() { grep -q 'ROLLBACK_GUARD' "$1" && [ "$(grep -c '^CREATE OR REPLACE FUNCTION ' "$1")" = 3 ] && grep -q '^COMMIT;$' "$1" && ! grep -qE '^(ERROR|FATAL|psql: error)' "$1"; }
echo "rollback file accepted by the apply / rollback checks: $(RBV "$TMP/rollback-004.sql" && echo yes || echo NO)"
{ cat "$TMP/rollback-004.sql"; echo 'ERROR:  simulated failure'; } > "$TMP/rb-bad.sql"
echo "corrupted rollback file refused: $(RBV "$TMP/rb-bad.sql" && echo NO || echo yes)"

echo "== 4 apply HEAD upgrade-004 (one transaction) + idempotent re-apply"
for i in 1 2; do { echo '\set ON_ERROR_STOP 1'; echo 'BEGIN;'; cat "$ROOT/build/staging/upgrade-004-catalog-rule.sql"; echo 'COMMIT;'; } | $PG -f - 2>&1 | grep -E "GUARD|ERROR" | sed "s/^/  apply $i: /"; done

echo "== 5 verify-upgrade-004 (read-only)"
$PG -v pre="$ACCT" -f - < "$HERE/verify-upgrade-004.sql" | grep '^check|'

echo "== 6 V2 compatibility ($OLD suite on the upgraded schema) + new behaviour (HEAD suite)"
echo "$OLD suite after upgrade-004: $(suite "$TMP/old-tests.sql" | tr '\n' ' ')"
echo "HEAD suite after upgrade-004: $(suite "$ROOT/build/staging/tests.sql" | tr '\n' ' ')"

echo "== 7 rollback (generated file) → definitions identical to step 3, new objects gone, $OLD suite"
$PG -f - < "$TMP/rollback-004.sql" 2>&1 | grep -E "^rollback\||ERROR|ROLLBACK_KEPT" | sed 's/^psql:<stdin>:[0-9]*: //'
MD5POST=$($PG -c "SELECT md5(pg_get_functiondef('wa.validate_payload(text,jsonb)'::regprocedure)) || '|' || md5(pg_get_functiondef('public.wa_confirm(bigint,uuid,integer)'::regprocedure)) || '|' || md5(pg_get_functiondef('public.wa_context(bigint)'::regprocedure))")
echo "definitions restored: $([ "$MD5PRE" = "$MD5POST" ] && echo IDENTICAL || echo DIFFERENT)"
echo "preflight after rollback: $($PG -f - < "$HERE/preflight-004.sql" | grep '^pre|upgrade-004 absent' )"
echo "$OLD suite after rollback: $(suite "$TMP/old-tests.sql" | tr '\n' ' ')"
echo "accounting after rollback: $($PG -f - < "$HERE/acct-004.sql" | grep '^acct|' | cut -d'|' -f2-) (before: $ACCT)"

echo "== 8 drop sandbox"
$ADM -c "DROP DATABASE $SB" >/dev/null && echo "sandbox dropped: $($ADM -c "SELECT count(*) FROM pg_database WHERE datname = '$SB'") remaining"
