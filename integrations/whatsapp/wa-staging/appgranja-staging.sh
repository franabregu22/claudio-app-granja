#!/usr/bin/env bash
# ADR-025 §18 — install / tear down the minimal bot staging on AppGranja (aplbsutpzgemexayldct) ONLY. Owner shell (Git Bash / mintty).
# NOT RUN without the owner's GO. Prerequisite: ../staging-adr025/03-staging-users.sh (creates the 4 synthetic Auth users and
# .staging-users.json with their ids). The Meta test app secret is NOT handled here (it goes to Vault with the gateway step).
#   --install   identity gate + typed phrase → ONE transaction: guard (empty staging DB) + sim + wa core (sim-first) + seed
#   --teardown  identity gate + typed phrase → teardown.sql (wa, sim, public.wa_*, wa_meta_app_secret) + residue line
# Test phones: STAGING_PHONE_A / STAGING_PHONE_B / STAGING_PHONE_OPER (E.164) in the environment. Production / Farm ERP refused.
set -u
export MSYS_NO_PATHCONV=1
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -W)"
REF=aplbsutpzgemexayldct
HOST=aws-0-us-east-2.pooler.supabase.com
CLIENT=supabase_db_Claudio_app_Granja
case "${1:-}" in --install) MODE=INSTALL;; --teardown) MODE=TEARDOWN;; *) echo "usage: $0 --install | --teardown"; exit 2;; esac
exec > >(tee -a "$HERE/appgranja-staging-output.txt") 2>&1
echo "######## run $(date '+%Y-%m-%d %H:%M:%S') — AppGranja bot staging, mode $MODE"
stop() { echo "STOP: $*"; unset PGPASSWORD; echo "== done (STOPPED)"; exit 2; }
case "$REF" in ycmkpnunhxluqqtecbyu|shdrztqgwpyyxclgfpdg) stop "forbidden project";; esac
(cd "$HERE/build" && sha256sum -c SHA256SUMS --quiet) || stop "build differs from the reviewed SHA256SUMS"
LINE=$(supabase projects list -o json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d.slice(d.search(/[\[{]/)));const p=j.find(x=>(x.ref||x.id)==='$REF');console.log(p?[p.ref||p.id,p.name,p.region,p.status].join('|'):'')}catch{console.log('')}})")
echo "control plane: ${LINE:-not found}"
[ "$LINE" = "$REF|AppGranja|us-east-2|ACTIVE_HEALTHY" ] || stop "$REF is not AppGranja / us-east-2 / ACTIVE_HEALTHY"
if [ "$MODE" = INSTALL ]; then
  U="$HERE/../staging-adr025/.staging-users.json"; [ -f "$U" ] || stop "missing .staging-users.json (run 03-staging-users.sh first)"
  IDS=$(node -e "const u=require(process.argv[1]);const g=e=>(u.find(x=>x.email===e+'@staging.invalid')||{}).id||'';console.log(['admin-a','admin-b','oper','wa-gateway'].map(g).join(' '))" "$U")
  set -- $IDS; [ $# = 4 ] || stop "the 4 synthetic user ids are not all in .staging-users.json"
  for p in "${STAGING_PHONE_A:-}" "${STAGING_PHONE_B:-}" "${STAGING_PHONE_OPER:-}"; do [[ "$p" =~ ^\+[1-9][0-9]{7,14}$ ]] || stop "STAGING_PHONE_A/B/OPER must be E.164"; done
  VARS=(-v admin_a="$1" -v admin_b="$2" -v oper="$3" -v gw="$4" -v phone_a="$STAGING_PHONE_A" -v phone_b="$STAGING_PHONE_B" -v phone_oper="$STAGING_PHONE_OPER")
fi
echo "Pegá la contraseña de la BASE de AppGranja (Shift+Insert; no se ve) y Enter:"
read -rs PGPASSWORD; echo; PGPASSWORD=$(printf '%s' "$PGPASSWORD" | tr -d '\r\n'); [ -n "$PGPASSWORD" ] || stop "empty password"
export PGPASSWORD PGHOST="$HOST" PGPORT=5432 PGUSER="postgres.$REF" PGDATABASE=postgres PGSSLMODE=require
psqlc() { docker exec -i -e PGHOST -e PGPORT -e PGUSER -e PGPASSWORD -e PGDATABASE -e PGSSLMODE "$CLIENT" psql -X -q -t -A "$@" 2>&1 | tr -d '\r' | sed 's/^psql:<stdin>:[0-9]*: //'; }
FP=$(psqlc -c "SELECT (to_regclass('migration_ledger.applied') IS NULL)::text || '|' || (to_regclass('public.perfiles') IS NULL)::text" | grep '|')
echo "database fingerprint (no_ledger|no_erp_perfiles): ${FP:-unavailable}"
[ "$FP" = "true|true" ] || stop "not the reset bot-staging database"
if [ "$MODE" = INSTALL ]; then   # the 4 ids of the local file must be exactly AppGranja's synthetic Auth users
  AU=$(psqlc -c "SELECT count(*) FILTER (WHERE (id::text, email) IN (('$1','admin-a@staging.invalid'),('$2','admin-b@staging.invalid'),('$3','oper@staging.invalid'),('$4','wa-gateway@staging.invalid'))) || '|' || count(*) FROM auth.users" | grep '|')
  echo "auth users (matching ids|total): ${AU:-unavailable}"
  [ "$AU" = "4|4" ] || stop "AppGranja Auth users do not match .staging-users.json (expected exactly the 4 synthetic users)"
fi
PHRASE="$MODE WA STAGING $REF"; echo "Escribí exactamente: $PHRASE"
read -r CONFIRM; [ "$CONFIRM" = "$PHRASE" ] || stop "confirmation phrase mismatch"
if [ "$MODE" = INSTALL ]; then
  RES=$({ echo '\set ON_ERROR_STOP 1'; echo 'BEGIN;'; cat "$HERE"/build/staging/0{0,1,2,3}-*.sql; echo 'COMMIT;'; } | psqlc "${VARS[@]}" -f - | grep -E "GUARD|ERROR|FATAL")
  echo "$RES"
  echo "$RES" | grep -qE "ERROR|FATAL" && stop "install failed — the transaction was rolled back; nothing was installed"
  echo "$RES" | grep -q "STAGING_GUARD: PASS" || stop "guard did not report PASS"
  psqlc -c "SELECT 'installed|wa_tables=' || (SELECT count(*) FROM pg_tables WHERE schemaname='wa') || ' sim_tables=' || (SELECT count(*) FROM pg_tables WHERE schemaname='sim') || ' public_wa_functions=' || (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'wa\_%') || ' senders=' || (SELECT count(*) FROM wa.sender) || ' enabled=' || (SELECT enabled FROM wa.config)"
else
  psqlc -f - < "$HERE/build/staging/teardown.sql" | grep -E "teardown|ERROR"
fi
unset PGPASSWORD
echo "== done ($MODE)"
