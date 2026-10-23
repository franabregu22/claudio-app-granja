#!/usr/bin/env bash
# ADR-025 §18 — the STAGING build on a LOCAL disposable database that mimics the reset AppGranja
# (auth.uid(), pgcrypto in extensions, Vault, Supabase default grants, empty public). Nothing remote is touched.
#   1 sandbox create   2 guard + sim + wa core + seed (committed)   3 suite (ROLLBACK)   4 concurrency (committed, 3 races)
#   5 teardown + residue proof   6 sandbox dropped
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
C=supabase_db_Claudio_app_Granja
SB=wa_sandbox_adr025
ADM="docker exec -i $C psql -U supabase_admin -d postgres -X -q -t -A"
ADMSB="docker exec -i $C psql -U supabase_admin -d $SB -X -q -t -A"
PG="docker exec -i $C psql -U postgres -d $SB -X -q -t -A"
A=aaaaaaaa-0025-0000-0000-00000000ad0a; B=aaaaaaaa-0025-0000-0000-00000000ad0b; GW=aaaaaaaa-0025-0000-0000-00000000ad0f
VARS="-v admin_a=$A -v admin_b=$B -v oper=aaaaaaaa-0025-0000-0000-00000000ad0c -v gw=$GW -v phone_a=+5491100000001 -v phone_b=+5491100000002 -v phone_oper=+5491100000003"
TMP="$HERE/.sandbox-tmp"; rm -rf "$TMP"; mkdir -p "$TMP"

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
echo "sandbox $SB: $($PG -c "SELECT 'auth.uid=' || (to_regprocedure('auth.uid()') IS NOT NULL) || ' vault=' || (to_regclass('vault.decrypted_secrets') IS NOT NULL) || ' public_tables=' || (SELECT count(*) FROM information_schema.tables WHERE table_schema='public')")"

echo "== 2 install (guard + sim + wa core + seed), committed"
{ echo '\set ON_ERROR_STOP 1'; echo 'BEGIN;'; cat "$HERE"/build/staging/0{0,1,2,3}-*.sql; echo 'COMMIT;'; } | $PG $VARS -f - 2>&1 | grep -E "GUARD|ERROR" | sed 's/^psql:<stdin>:[0-9]*: //'
echo "guard re-run on the installed database (must refuse): $($PG -f - < "$HERE/build/staging/00-guard.sql" 2>&1 | grep -o 'STAGING_GUARD: [a-z].*' | head -1)"
echo "ERP-refusal: the staging guard on the local ERP → $(docker exec -i $C psql -U postgres -X -q -t -A -f - < "$HERE/build/staging/00-guard.sql" 2>&1 | grep -o 'STAGING_GUARD: .*' | cut -c1-90)"

echo "== 2b staging upgrades on the installed database (idempotent re-application)"
for u in upgrade-001-wa-context upgrade-002-sim-categories upgrade-003-duplicate-refs upgrade-004-catalog-rule; do { echo '\set ON_ERROR_STOP 1'; echo 'BEGIN;'; cat "$HERE/build/staging/$u.sql"; echo 'COMMIT;'; } | $PG -f - 2>&1 | grep -E "GUARD|ERROR" | sed "s/^/  $u: /"; done
echo "after upgrades: $($PG -c "SELECT 'public_wa_functions=' || (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'wa\_%') || ' selectable_sim_categories=' || (SELECT count(*) FROM sim.expense_category c JOIN sim.expense_category_group g ON g.id=c.group_id WHERE c.activo AND NOT c.fiscal_reserved AND g.kind='EXPENSE')")"
echo "== 3 suite (one transaction, ROLLBACK)"
{ echo '\set ON_ERROR_STOP 1'; echo 'BEGIN;'; cat "$HERE/build/staging/tests.sql"; echo 'ROLLBACK;'; } | $PG $VARS -f - 2>&1 | grep -E "FAIL|SUMMARY|ERROR" | sed 's/^psql:<stdin>:[0-9]*: //'

echo "== 4 concurrency (two sessions per race, committed in the sandbox)"
HELP="$TMP/helpers.sql"; sed '/^-- ── A\. API surface/q' "$HERE/build/staging/tests.sql" > "$HELP"
setup() { { echo '\set ON_ERROR_STOP 1'; echo 'BEGIN;'; cat "$HELP"; cat; echo 'COMMIT;'; } | $PG $VARS -f - 2>&1 | grep -E "^fx\||ERROR"; }
fx() { grep "^fx|$1|" "$TMP/fx.txt" | tail -1 | cut -d'|' -f3; }
race() {  # race NAME SQL1 SQL2 — S2 starts 0.5 s after S1; S1 holds its transaction 2 s after its call
  local s
  for s in 1 2; do
    local q; [ $s = 1 ] && q="$2" || q="$3"
    { echo "BEGIN; SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claims', '{\"sub\":\"$GW\",\"role\":\"authenticated\"}', true) \\g /dev/null"
      echo "SELECT 'r|S$s|start|' || to_char(clock_timestamp(), 'HH24:MI:SS.MS');"
      echo "SELECT 'r|S$s|result|' || ($q);"
      echo "SELECT 'r|S$s|end|' || to_char(clock_timestamp(), 'HH24:MI:SS.MS');"
      [ $s = 1 ] && echo "SELECT pg_sleep(2) \\g /dev/null"; echo "COMMIT;"; } > "$TMP/$1-S$s.sql"
  done
  $PG -f - < "$TMP/$1-S1.sql" > "$TMP/$1-S1.out" 2>&1 & local p1=$!
  sleep 0.5
  $PG -f - < "$TMP/$1-S2.sql" > "$TMP/$1-S2.out" 2>&1 & local p2=$!
  wait $p1 $p2
  sed 's/^psql:<stdin>:[0-9]*: //' "$TMP/$1-S1.out" "$TMP/$1-S2.out" | grep -E "^r\||ERROR" | cut -c1-230 | sed "s/^/  $1 /"
}
# race 1 — two different "SÍ" messages for the same draft
setup > "$TMP/fx.txt" <<'SQL'
SELECT pg_temp.put('dA', pg_temp.did(pg_temp.propose(pg_temp.msg(pg_temp.v('phone_a'), 'conc A'), 'CASUAL_EXPENSE', pg_temp.cash(700)))) \g /dev/null
SELECT 'fx|dA|' || pg_temp.get('dA');
SELECT 'fx|m1|' || pg_temp.btn(pg_temp.v('phone_a'), pg_temp.get('dA'), 1);
SELECT 'fx|m2|' || pg_temp.btn(pg_temp.v('phone_a'), pg_temp.get('dA'), 1);
SQL
race R1 "SELECT public.wa_confirm($(fx m1), '$(fx dA)', 1)::text" "SELECT public.wa_confirm($(fx m2), '$(fx dA)', 1)::text"
# race 2 — admin A and admin B confirm their own drafts at the same time (no identity leakage between sessions)
setup >> "$TMP/fx.txt" <<'SQL'
SELECT pg_temp.put('dA2', pg_temp.did(pg_temp.propose(pg_temp.msg(pg_temp.v('phone_a'), 'conc A2'), 'CASUAL_EXPENSE', pg_temp.cash(710)))) \g /dev/null
SELECT pg_temp.put('dB', pg_temp.did(pg_temp.propose(pg_temp.msg(pg_temp.v('phone_b'), 'conc B'), 'CASUAL_EXPENSE', pg_temp.cash(720)))) \g /dev/null
SELECT 'fx|dA2|' || pg_temp.get('dA2'); SELECT 'fx|dB|' || pg_temp.get('dB');
SELECT 'fx|mA2|' || pg_temp.btn(pg_temp.v('phone_a'), pg_temp.get('dA2'), 1); SELECT 'fx|mB|' || pg_temp.btn(pg_temp.v('phone_b'), pg_temp.get('dB'), 1);
SQL
race R2 "SELECT public.wa_confirm($(fx mA2), '$(fx dA2)', 1)::text || ' uid_after=' || auth.uid()" "SELECT public.wa_confirm($(fx mB), '$(fx dB)', 1)::text || ' uid_after=' || auth.uid()"
# race 3 — A and B link their WAITING_MP drafts to the SAME Mercado Pago outflow
setup >> "$TMP/fx.txt" <<'SQL'
SELECT pg_temp.put('wA', pg_temp.did(pg_temp.propose(pg_temp.msg(pg_temp.v('phone_a'), 'mp A'), 'CASUAL_EXPENSE', pg_temp.mp(2500)))) \g /dev/null
SELECT pg_temp.put('wB', pg_temp.did(pg_temp.propose(pg_temp.msg(pg_temp.v('phone_b'), 'mp B'), 'CASUAL_EXPENSE', pg_temp.mp(2500)))) \g /dev/null
SELECT 'fx|wA|' || pg_temp.get('wA'); SELECT 'fx|wB|' || pg_temp.get('wB');
SELECT 'fx|lA|' || pg_temp.msg(pg_temp.v('phone_a'), 'es el 25002'); SELECT 'fx|lB|' || pg_temp.msg(pg_temp.v('phone_b'), 'es el 25002');
SQL
race R3 "SELECT public.wa_link_mp($(fx lA), '$(fx wA)', 1, '930000025002')::text" "SELECT public.wa_link_mp($(fx lB), '$(fx wB)', 1, '930000025002')::text"
# race 4 — two proposals of the same sender at the same time (one open draft per sender)
setup >> "$TMP/fx.txt" <<'SQL'
SELECT 'fx|p1|' || pg_temp.msg(pg_temp.v('phone_b'), 'gasto uno'); SELECT 'fx|p2|' || pg_temp.msg(pg_temp.v('phone_b'), 'gasto dos');
SQL
ACC=$($PG -c "SELECT id FROM sim.financial_account WHERE nombre='Caja chica'")
CASH="jsonb_build_object('date','2026-10-20','total',90,'category_id','aaaaaaaa-0025-0000-0000-0000000000c1','nature','OPERATING','concept','conc','account_id','$ACC','method','CASH')"
race R4 "SELECT public.wa_propose($(fx p1), 'CASUAL_EXPENSE', $CASH)::text" "SELECT public.wa_propose($(fx p2), 'CASUAL_EXPENSE', $CASH)::text"
grep -E "ERROR" "$TMP/fx.txt" | head -3
echo "== 4 verdicts"
$PG <<SQL
SELECT 'R1|purchases_for_draft=' || (SELECT count(*) FROM sim.purchases WHERE idempotency_key LIKE 'WA:$(fx dA):%') || ' confirmations=' || (SELECT count(*) FROM wa.confirmation WHERE draft_id = '$(fx dA)')
       || ' state=' || (SELECT state FROM wa.draft WHERE id = '$(fx dA)');
SELECT 'R2|A_actor_ok=' || (SELECT created_by = '$A' FROM sim.purchases WHERE idempotency_key = 'WA:$(fx dA2):v1') || ' B_actor_ok=' || (SELECT created_by = '$B' FROM sim.purchases WHERE idempotency_key = 'WA:$(fx dB):v1');
SELECT 'R3|drafts_holding_25002=' || (SELECT count(*) FROM wa.draft WHERE payload ->> 'mp_source_id' = '930000025002');
SELECT 'R4|open_drafts_of_B=' || (SELECT count(*) FROM wa.draft WHERE owner_perfil_id = '$B' AND state IN ('DRAFT', 'CONFIRMING'));
SQL

echo "== 5 teardown"
$PG -f - < "$HERE/build/staging/teardown.sql" 2>&1 | grep -E "teardown|ERROR"
echo "== 6 drop sandbox"
$ADM -c "DROP DATABASE $SB" >/dev/null && echo "sandbox dropped: $($ADM -c "SELECT count(*) FROM pg_database WHERE datname = '$SB'") remaining"
rm -rf "$TMP"
