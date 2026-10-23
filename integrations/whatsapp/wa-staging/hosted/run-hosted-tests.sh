#!/usr/bin/env bash
# ADR-025 §18 — FIRST HOSTED verification of the minimal bot staging on AppGranja (aplbsutpzgemexayldct) ONLY.
# Owner shell. NOT RUN without the owner's specific GO. Steps:
#   0 gates: refs, build checksums, control plane, users file, AppGranja anon key (CLI; never printed)
#   1 database (AppGranja password, typed): fingerprint, the 4 Auth users, READ-ONLY catalog / privilege checks (K-1..K-17)
#   2 a RANDOM per-run Meta secret into Vault (only if none exists) — removed again in step 4 (also on any failure)
#   3 REAL Supabase Auth + PostgREST tests as the 4 synthetic users (H, S, I, D, C, M)
#   4 post checks (effects only in sim, actors = draft owners, no outbound HTTP) + cleanup of this run's rows + residue line
# No Edge Function, Meta, n8n, Mercado Pago, bank or production credential is used. Passwords / keys / secret never printed.
set -u
export MSYS_NO_PATHCONV=1
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -W)"
ROOT="$HERE/.."
REF=aplbsutpzgemexayldct
HOST=aws-0-us-east-2.pooler.supabase.com
CLIENT=supabase_db_Claudio_app_Granja
USERS="$ROOT/../staging-adr025/.staging-users.json"
exec > >(tee -a "$HERE/hosted-output.txt") 2>&1
echo "######## run $(date '+%Y-%m-%d %H:%M:%S') — AppGranja hosted verification"
SECRET_SET=0
cleanup_on_exit() {
  if [ "$SECRET_SET" = 1 ]; then
    echo "== cleanup after failure: this run's rows and the temporary secret"
    psqlc -v t0="$T0" -v gw="$GWID" -v admin_a="$AID" -v admin_b="$BID" -v expected_purchases=5 -f - < "$HERE/post-and-cleanup.sql" | grep -E "^residue|ERROR"
  fi
  unset PGPASSWORD WA_ANON WA_RUN_SECRET
}
trap cleanup_on_exit EXIT
stop() { echo "STOP: $*"; echo "== done (STOPPED)"; exit 2; }
case "$REF" in ycmkpnunhxluqqtecbyu|shdrztqgwpyyxclgfpdg) stop "forbidden project";; esac

echo "== 0 gates"
(cd "$ROOT/build" && sha256sum -c SHA256SUMS --quiet) || stop "build differs from the reviewed SHA256SUMS"
LINE=$(supabase projects list -o json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d.slice(d.search(/[\[{]/)));const p=j.find(x=>(x.ref||x.id)==='$REF');console.log(p?[p.ref||p.id,p.name,p.region,p.status].join('|'):'')}catch{console.log('')}})")
echo "control plane: ${LINE:-not found}"
[ "$LINE" = "$REF|AppGranja|us-east-2|ACTIVE_HEALTHY" ] || stop "$REF is not AppGranja / us-east-2 / ACTIVE_HEALTHY"
[ -f "$USERS" ] || stop "missing .staging-users.json"
read -r AID BID OID GWID < <(node -e "const u=require(process.argv[1]);const g=e=>{const x=u.find(x=>x.email===e+'@staging.invalid')||{};return x.id&&x.password?x.id:'-'};console.log(['admin-a','admin-b','oper','wa-gateway'].map(g).join(' '))" "$USERS")
for x in "$AID" "$BID" "$OID" "$GWID"; do [[ "$x" =~ ^[0-9a-f-]{36}$ ]] || stop "the 4 users (id + password) are not all in .staging-users.json"; done
WA_ANON=$(supabase projects api-keys --project-ref "$REF" -o json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d.slice(d.search(/[\[{]/)));const k=j.find(k=>k.name==='anon');const p=JSON.parse(Buffer.from(k.api_key.split('.')[1],'base64url'));console.log(p.ref==='$REF'&&p.role==='anon'?k.api_key:'')}catch{console.log('')}})")
[ -n "$WA_ANON" ] || stop "AppGranja anon key not obtained (or not anon / not AppGranja)"
echo "anon key: AppGranja, role anon (not printed)"

echo "== 1 database"
echo "Pegá la contraseña de la BASE de AppGranja (no se ve) y Enter:"
read -rs PGPASSWORD; echo; PGPASSWORD=$(printf '%s' "$PGPASSWORD" | tr -d '\r\n'); [ -n "$PGPASSWORD" ] || stop "empty password"
export PGPASSWORD PGHOST="$HOST" PGPORT=5432 PGUSER="postgres.$REF" PGDATABASE=postgres PGSSLMODE=require
psqlc() { docker exec -i -e PGHOST -e PGPORT -e PGUSER -e PGPASSWORD -e PGDATABASE -e PGSSLMODE -e WA_RUN_SECRET "$CLIENT" psql -X -q -t -A "$@" 2>&1 | tr -d '\r' | sed 's/^psql:<stdin>:[0-9]*: //'; }
FP=$(psqlc -c "SELECT (to_regclass('migration_ledger.applied') IS NULL) || '|' || (to_regclass('public.perfiles') IS NULL) || '|' || (to_regnamespace('wa') IS NOT NULL)" | grep '|')
echo "database fingerprint (no_ledger|no_erp_perfiles|wa_installed): ${FP:-unavailable}"
[ "$FP" = "true|true|true" ] || stop "not the installed bot-staging database"
AU=$(psqlc -c "SELECT count(*) FILTER (WHERE (id::text, email) IN (('$AID','admin-a@staging.invalid'),('$BID','admin-b@staging.invalid'),('$OID','oper@staging.invalid'),('$GWID','wa-gateway@staging.invalid'))) || '|' || count(*) FROM auth.users" | grep '|')
echo "auth users (matching ids|total): ${AU:-unavailable}"
[ "$AU" = "4|4" ] || stop "AppGranja Auth users do not match .staging-users.json"
CAT=$(psqlc -v gw="$GWID" -f - < "$HERE/catalog.sql" | grep -E "^catalog\||ERROR")
echo "$CAT"
echo "$CAT" | grep -qE "FAIL|ERROR" && stop "catalog / privilege checks failed — no test data written"
[ "$(echo "$CAT" | grep -c '^catalog|PASS')" = 17 ] || stop "expected 17 catalog PASS lines"
# phones and account ids for the requests (read here, passed by environment, never printed)
read -r WA_PHONE_A WA_PHONE_B WA_PHONE_OPER WA_ACC_CASH WA_ACC_MP < <(psqlc -c "SELECT (SELECT phone_e164 FROM wa.sender WHERE perfil_id = '$AID') || ' ' || (SELECT phone_e164 FROM wa.sender WHERE perfil_id = '$BID') || ' ' || (SELECT phone_e164 FROM wa.sender WHERE perfil_id = '$OID') || ' ' || (SELECT id FROM sim.financial_account WHERE nombre = 'Caja chica') || ' ' || (SELECT id FROM sim.financial_account WHERE nombre = 'Mercado Pago')")
[[ "$WA_PHONE_A" =~ ^\+[0-9]{8,15}$ && "$WA_PHONE_B" =~ ^\+[0-9]{8,15}$ && "$WA_PHONE_OPER" =~ ^\+[0-9]{8,15}$ && "$WA_ACC_MP" =~ ^[0-9a-f-]{36}$ ]] || stop "senders / accounts not readable"
[ "$WA_PHONE_A" != "+5491100000000" ] && [ "$WA_PHONE_B" != "+5491100000000" ] && [ "$WA_PHONE_OPER" != "+5491100000000" ] || stop "a sender uses the reserved unknown-phone number"

echo "Escribí exactamente: HOSTED TEST $REF"
read -r CONFIRM; [ "$CONFIRM" = "HOSTED TEST $REF" ] || stop "confirmation phrase mismatch"

echo "== 2 temporary Meta secret (random, this run only)"
export WA_RUN_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
T0=$(psqlc -c "SELECT now()" | head -1)
SEC=$(printf '%s\n' '\getenv run_secret WA_RUN_SECRET' "SELECT 'secret|' || count(*) FROM (SELECT vault.create_secret(:'run_secret', 'wa_meta_app_secret', 'ADR-025 hosted test run (temporary)') WHERE NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'wa_meta_app_secret')) x;" | psqlc -f - | grep -E "^secret\||ERROR")
echo "${SEC:-secret|unavailable}"
[ "$SEC" = "secret|1" ] || stop "temporary secret not created (a wa_meta_app_secret already exists, or Vault refused)"
SECRET_SET=1

echo "== 3 Supabase Auth + PostgREST"
WA_REF="$REF" WA_ANON="$WA_ANON" WA_USERS="$USERS" WA_PHONE_A="$WA_PHONE_A" WA_PHONE_B="$WA_PHONE_B" WA_PHONE_OPER="$WA_PHONE_OPER" \
  WA_ACC_CASH="$WA_ACC_CASH" WA_ACC_MP="$WA_ACC_MP" node "$HERE/http-tests.mjs"
HTTP_RC=$?

echo "== 4 post checks + cleanup of this run"
POST=$(psqlc -v t0="$T0" -v gw="$GWID" -v admin_a="$AID" -v admin_b="$BID" -v expected_purchases=5 -f - < "$HERE/post-and-cleanup.sql" | grep -E "^(post|residue)\||ERROR")
SECRET_SET=0
echo "$POST"
RES_OK=0; echo "$POST" | grep -q "^residue|wa_rows=0 sim_purchases=0 outflows_pending=2 secret=0 senders=3 enabled=true$" && RES_OK=1
if [ "$HTTP_RC" = 0 ] && ! echo "$POST" | grep -qE "FAIL|ERROR" && [ "$RES_OK" = 1 ]; then
  echo "HOSTED RESULT: PASS"
else
  echo "HOSTED RESULT: FAIL (http_rc=$HTTP_RC, residue_ok=$RES_OK)"
fi
echo "== done"
