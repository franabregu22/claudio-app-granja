#!/usr/bin/env bash
# ADR-025 — READ-ONLY "Registrar sin clasif" test on AppGranja (aplbsutpzgemexayldct) ONLY (cash, simulator). Owner shell.
#   verify-unclassified-004.sh before          → snapshot of purchases / confirmations / MP pending rows / pending rows / payment ops
#   (send the WhatsApp message, check the summary, tap "Registrar sin clasif" (a second tap is optional: informative))
#   verify-unclassified-004.sh after [W-XXXX]   → one pending outflow, no purchase, no duplicate, snapshot +1 / unchanged
set -u
export MSYS_NO_PATHCONV=1
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -W)"
REF=aplbsutpzgemexayldct
HOST=aws-0-us-east-2.pooler.supabase.com
CLIENT=supabase_db_Claudio_app_Granja
PHASE="${1:-}"; CODE="${2:-}"; TOTAL=4170; WORD=operaci
SNAPF="$HERE/unclassified-004-snapshot.txt"
stop() { echo "STOP: $*"; unset PGPASSWORD; exit 2; }
[ "$PHASE" = before ] || [ "$PHASE" = after ] || stop "usage: verify-unclassified-004.sh before | after [W-XXXX]"
[ -z "$CODE" ] || [[ "$CODE" =~ ^W-[0-9]{4,}$ ]] || stop "draft code like W-0008"
[ "$PHASE" = before ] || [ -s "$SNAPF" ] || stop "no snapshot: run 'before' first"
case "$REF" in ycmkpnunhxluqqtecbyu|shdrztqgwpyyxclgfpdg) stop "forbidden project";; esac
LINE=$(supabase projects list -o json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d.slice(d.search(/[\[{]/)));const p=j.find(x=>(x.ref||x.id)==='$REF');console.log(p?[p.ref||p.id,p.name,p.region,p.status].join('|'):'')}catch{console.log('')}})")
echo "control plane: ${LINE:-not found}"
[ "$LINE" = "$REF|AppGranja|us-east-2|ACTIVE_HEALTHY" ] || stop "$REF is not AppGranja / us-east-2 / ACTIVE_HEALTHY"
echo "Pegá la contraseña de la BASE de AppGranja (no se ve) y Enter:"
read -rs PGPASSWORD; echo; PGPASSWORD=$(printf '%s' "$PGPASSWORD" | tr -d '\r\n'); [ -n "$PGPASSWORD" ] || stop "empty password"
export PGPASSWORD PGHOST="$HOST" PGPORT=5432 PGUSER="postgres.$REF" PGDATABASE=postgres PGSSLMODE=require
psqlc() { docker exec -i -e PGHOST -e PGPORT -e PGUSER -e PGPASSWORD -e PGDATABASE -e PGSSLMODE "$CLIENT" psql -X -q -t -A "$@" 2>&1 | tr -d '\r' | sed 's/^psql:<stdin>:[0-9]*: //'; }
FP=$(psqlc -c "SELECT (to_regclass('migration_ledger.applied') IS NULL) || '|' || (to_regclass('public.perfiles') IS NULL) || '|' || (to_regnamespace('sim') IS NOT NULL) || '|' || (to_regprocedure('wa.selectable_categories()') IS NOT NULL)" | grep '|')
echo "database fingerprint (no_ledger|no_erp_perfiles|sim|upgrade-004): ${FP:-unavailable}"
[ "$FP" = "true|true|true|true" ] || stop "not the AppGranja bot staging with upgrade-004"
SNAP=$([ "$PHASE" = after ] && cut -d'|' -f2- "$SNAPF" || echo '')
OUT=$(psqlc -v phase="$PHASE" -v snap="$SNAP" -v code="$CODE" -v total="$TOTAL" -v word="$WORD" -f - < "$HERE/verify-unclassified-004.sql")
unset PGPASSWORD
if [ "$PHASE" = before ]; then
  S=$(echo "$OUT" | grep '^snap|'); [ -n "$S" ] || { echo "$OUT" | head -5; stop "snapshot failed"; }
  echo "$S" > "$SNAPF"; echo "snapshot saved (counts and md5 only): $S"; echo "== done"; exit 0
fi
echo "$OUT" | grep -E "^(check|info|draft)\||ERROR"
G=$(echo "$OUT" | grep '^check|')
echo "VEREDICTO: $([ "$(echo "$G" | grep -c .)" = 16 ] && ! echo "$G" | grep -qE '\|(FAIL|UNKNOWN)\|' && echo PASS || echo FAIL)"
echo "== done"
