#!/usr/bin/env bash
# ADR-025 / 0134 — LOCAL rehearsal of upgrade-006 (conversation memory: bot_reply, wa_note_reply, wa_context.history) on a
# DISPOSABLE database that reproduces the INSTALLED AppGranja bot staging (the compat-005 state + HEAD upgrade-005).
# Nothing remote is touched.  1 sandbox  2 install AppGranja state + suites  3 apply upgrade-006 (+ re-apply refused)
# 4 suites again (nothing broken) + memory checks as the gateway user  5 sandbox dropped
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$HERE/.."
C=supabase_db_Claudio_app_Granja
SB=wa_sandbox_compat006
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
(cd "$ROOT" && git show "$V2:integrations/whatsapp/wa-staging/build/staging/upgrade-004-catalog-rule.sql") > "$TMP/v2-upgrade-004.sql" || { echo "STOP: cannot read $V2 upgrade-004"; exit 2; }
suite() { { echo '\set ON_ERROR_STOP 1'; echo 'BEGIN;'; cat "$1"; echo 'ROLLBACK;'; } | $PG $VARS -f - 2>&1 | grep -E "^SUMMARY|FAIL |ERROR" | sed 's/^psql:<stdin>:[0-9]*: //'; }
tx() { { echo '\set ON_ERROR_STOP 1'; echo 'BEGIN;'; cat "$@"; echo 'COMMIT;'; } | $PG $VARS -f - 2>&1 | grep -E "GUARD|ERROR" | sed 's/^psql:<stdin>:[0-9]*: //'; }

echo "== 1 sandbox"
$ADM -c "DROP DATABASE IF EXISTS $SB" -c "CREATE DATABASE $SB OWNER postgres" >/dev/null
sed -n '/^\$ADMSB -v ON_ERROR_STOP=1/,/^SQL$/p' "$HERE/compat-004-sandbox.sh" | sed '1d;$d' | $ADMSB -v ON_ERROR_STOP=1 >/dev/null

echo "== 2 install the AppGranja state ($OLD + upgrade-002 + $V2 upgrade-004 + HEAD upgrade-005)"
tx "$TMP"/old-0{0,1,2,3}-*.sql | grep ERROR | head -3
tx "$TMP/old-upgrade-002-sim-categories.sql" | grep ERROR | head -3
tx "$TMP/v2-upgrade-004.sql" | grep ERROR | head -3
tx "$ROOT/build/staging/upgrade-005-method-pending.sql" | grep ERROR | head -3
echo "HEAD suite before upgrade-006: $(suite "$ROOT/build/staging/tests.sql" | tr '\n' ' ')"

echo "== 3 apply upgrade-006 (one transaction) + a second apply must be refused"
echo "  apply 1: $(tx "$ROOT/build/staging/upgrade-006-memoria-conversacion.sql" | tr '\n' ' ')"
echo "  apply 2: $(tx "$ROOT/build/staging/upgrade-006-memoria-conversacion.sql" | tr '\n' ' ')"

echo "== 4 suites after upgrade-006 + memory checks (gateway user, rolled back)"
echo "HEAD suite after upgrade-006: $(suite "$ROOT/build/staging/tests.sql" | tr '\n' ' ')"
cat > "$TMP/mem.sql" <<SQL
\set ON_ERROR_STOP 1
BEGIN;
INSERT INTO wa.inbound_message (wamid, phone_e164, sender_perfil_id, meta_ts, kind, text_body, raw_sha256, outcome)
  SELECT 'T006-' || g, s.phone_e164, s.perfil_id, now(), 'text', 'mensaje ' || g, md5(g::text), 'ACCEPTED' FROM wa.sender s, generate_series(1, 3) g WHERE s.activo ORDER BY s.perfil_id LIMIT 3;
SELECT set_config('request.jwt.claims', json_build_object('sub', (SELECT gateway_user_id FROM wa.config)::text, 'role', 'authenticated')::text, true);
CREATE TEMP TABLE ids AS SELECT min(id) lo, max(id) hi FROM wa.inbound_message WHERE wamid LIKE 'T006-%';
GRANT SELECT ON ids TO authenticated;
SET LOCAL ROLE authenticated;
SELECT 'note|' || wa_note_reply((SELECT lo FROM ids), '¿Qué compraste?')::text;
SELECT 'again|' || wa_note_reply((SELECT lo FROM ids), 'otra')::text;
SELECT 'history|' || jsonb_array_length(wa_context((SELECT hi FROM ids)) -> 'history')
  || '|' || ((wa_context((SELECT hi FROM ids)) -> 'history') @> '[{"bot": "¿Qué compraste?"}]')::text;
RESET ROLE;
ROLLBACK;
SQL
$PG -f - < "$TMP/mem.sql" 2>&1 | grep -E "^(note|again|history)\||ERROR"
echo "privileges: $($PG -c "SELECT prosecdef::text || '|' || pg_get_userbyid(proowner) || '|' || has_function_privilege('anon', oid, 'EXECUTE')::text FROM pg_proc WHERE oid = 'public.wa_note_reply(bigint,text)'::regprocedure")"

echo "== 5 sandbox dropped"
$ADM -c "DROP DATABASE IF EXISTS $SB" >/dev/null && echo "dropped $SB"
