#!/usr/bin/env bash
# ADR-025 — LOCAL rehearsal of upgrade-005 (payment method never presumed) on a DISPOSABLE database that reproduces the INSTALLED
# AppGranja bot staging: commit 55aa19f (core with upgrades 001 / 003) + upgrade-002 categories + upgrade-004 of commit 0a54bdc.
# Nothing remote is touched.
#   1 sandbox   2 install the AppGranja state + baseline suites (55aa19f; 0a54bdc = the contract of the PUBLISHED V2)
#   3 preflight-005 (read-only) + rollback file from snapshot-005 + accounting snapshot   4 apply HEAD upgrade-005 (+ idempotent re-apply)
#   5 verify-upgrade-005 (read-only)   6 55aa19f + 0a54bdc suites (published V2 compatibility) + HEAD suite (new behaviour)
#   7 rollback from the generated file → definitions identical to step 3, 0a54bdc suite again   8 sandbox dropped
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$HERE/.."
C=supabase_db_Claudio_app_Granja
SB=wa_sandbox_compat005
OLD=55aa19f
V2=0a54bdc
ADM="docker exec -i $C psql -U supabase_admin -d postgres -X -q -t -A"
ADMSB="docker exec -i $C psql -U supabase_admin -d $SB -X -q -t -A"
PG="docker exec -i $C psql -U postgres -d $SB -X -q -t -A"
A=aaaaaaaa-0025-0000-0000-00000000ad0a; B=aaaaaaaa-0025-0000-0000-00000000ad0b; GW=aaaaaaaa-0025-0000-0000-00000000ad0f
VARS="-v admin_a=$A -v admin_b=$B -v oper=aaaaaaaa-0025-0000-0000-00000000ad0c -v gw=$GW -v phone_a=+5491100000001 -v phone_b=+5491100000002 -v phone_oper=+5491100000003"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
for f in 00-guard.sql 01-sim.sql 02-wa-core.sql 03-seed.sql tests.sql upgrade-002-sim-categories.sql; do
  (cd "$ROOT" && git show "$OLD:integrations/whatsapp/wa-staging/build/staging/$f") > "$TMP/old-$f" || { echo "STOP: cannot read $OLD:$f"; exit 2; }
done
for f in upgrade-004-catalog-rule.sql tests.sql; do
  (cd "$ROOT" && git show "$V2:integrations/whatsapp/wa-staging/build/staging/$f") > "$TMP/v2-$f" || { echo "STOP: cannot read $V2:$f"; exit 2; }
done
suite() { { echo '\set ON_ERROR_STOP 1'; echo 'BEGIN;'; cat "$1"; echo 'ROLLBACK;'; } | $PG $VARS -f - 2>&1 | grep -E "^SUMMARY|FAIL |ERROR" | sed 's/^psql:<stdin>:[0-9]*: //'; }
md5s() { $PG -c "SELECT md5(pg_get_functiondef('wa.validate_payload(text,jsonb)'::regprocedure)) || '|' || md5(pg_get_functiondef('public.wa_correct(bigint,uuid,integer,jsonb)'::regprocedure)) || '|' || md5(pg_get_functiondef('public.wa_confirm(bigint,uuid,integer)'::regprocedure))"; }
RBV() { grep -q 'ROLLBACK_GUARD' "$1" && [ "$(grep -c '^CREATE OR REPLACE FUNCTION ' "$1")" = 3 ] && grep -q '^COMMIT;$' "$1" && ! grep -qE '^(ERROR|FATAL|psql: error)' "$1"; }

echo "== 1 sandbox"
$ADM -c "DROP DATABASE IF EXISTS $SB" -c "CREATE DATABASE $SB OWNER postgres" >/dev/null
sed -n '/^\$ADMSB -v ON_ERROR_STOP=1/,/^SQL$/p' "$HERE/compat-004-sandbox.sh" | sed '1d;$d' | $ADMSB -v ON_ERROR_STOP=1 >/dev/null

echo "== 2 install the AppGranja state ($OLD + upgrade-002 + $V2 upgrade-004) + baseline suites"
{ echo '\set ON_ERROR_STOP 1'; echo 'BEGIN;'; cat "$TMP"/old-0{0,1,2,3}-*.sql; echo 'COMMIT;'; } | $PG $VARS -f - 2>&1 | grep -E "ERROR" | head -3
{ echo '\set ON_ERROR_STOP 1'; echo 'BEGIN;'; cat "$TMP/old-upgrade-002-sim-categories.sql"; echo 'COMMIT;'; } | $PG -f - 2>&1 | grep -E "ERROR" | head -3
{ echo '\set ON_ERROR_STOP 1'; echo 'BEGIN;'; cat "$TMP/v2-upgrade-004-catalog-rule.sql"; echo 'COMMIT;'; } | $PG -f - 2>&1 | grep -E "ERROR" | head -3
echo "baseline $OLD suite: $(suite "$TMP/old-tests.sql" | tr '\n' ' ')"
echo "baseline $V2 suite (published V2 contract): $(suite "$TMP/v2-tests.sql" | tr '\n' ' ')"

echo "== 3 preflight-005 (read-only) + rollback file + accounting snapshot"
$PG -f - < "$HERE/preflight-005.sql" | grep '^pre|'
$PG -f - < "$HERE/snapshot-005.sql" > "$TMP/rollback-005.sql"
echo "rollback file accepted by the apply / rollback checks: $(RBV "$TMP/rollback-005.sql" && echo yes || echo NO)"
MD5PRE=$(md5s)
ACCT=$($PG -f - < "$HERE/acct-004.sql" | grep '^acct|' | cut -d'|' -f2-)
echo "rollback file: $(grep -c . "$TMP/rollback-005.sql") lines · accounting: $ACCT"

echo "== 4 apply HEAD upgrade-005 (one transaction) + idempotent re-apply"
for i in 1 2; do { echo '\set ON_ERROR_STOP 1'; echo 'BEGIN;'; cat "$ROOT/build/staging/upgrade-005-method-pending.sql"; echo 'COMMIT;'; } | $PG -f - 2>&1 | grep -E "GUARD|ERROR" | sed "s/^/  apply $i: /"; done

echo "== 5 verify-upgrade-005 (read-only)"
$PG -v pre="$ACCT" -f - < "$HERE/verify-upgrade-005.sql" | grep '^check|'

echo "== 6 published V2 compatibility ($OLD and $V2 suites on the upgraded schema) + new behaviour (HEAD suite)"
echo "$OLD suite after upgrade-005: $(suite "$TMP/old-tests.sql" | tr '\n' ' ')"
echo "$V2 suite after upgrade-005: $(suite "$TMP/v2-tests.sql" | tr '\n' ' ')"
echo "HEAD suite after upgrade-005: $(suite "$ROOT/build/staging/tests.sql" | tr '\n' ' ')"

echo "== 7 rollback (generated file) → definitions identical to step 3, $V2 suite"
$PG -f - < "$TMP/rollback-005.sql" 2>&1 | grep -E "^rollback\||ERROR" | sed 's/^psql:<stdin>:[0-9]*: //'
echo "definitions restored: $([ "$MD5PRE" = "$(md5s)" ] && echo IDENTICAL || echo DIFFERENT)"
echo "preflight after rollback: $($PG -f - < "$HERE/preflight-005.sql" | grep '^pre|upgrade-005 absent')"
echo "$V2 suite after rollback: $(suite "$TMP/v2-tests.sql" | tr '\n' ' ')"
echo "accounting after rollback: $($PG -f - < "$HERE/acct-004.sql" | grep '^acct|' | cut -d'|' -f2-) (before: $ACCT)"

echo "== 8 drop sandbox"
$ADM -c "DROP DATABASE $SB" >/dev/null && echo "sandbox dropped: $($ADM -c "SELECT count(*) FROM pg_database WHERE datname = '$SB'") remaining"
