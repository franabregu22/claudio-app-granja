#!/usr/bin/env bash
# ADR-025 — READ-ONLY diagnosis of a "Registrar sin clasif" draft (B-3 / T-1). AppGranja (aplbsutpzgemexayldct) ONLY. Owner shell.
# Usage: diag-w0015.sh [W-0015]. Nothing is written: diag-w0015.sql runs inside BEGIN READ ONLY ... ROLLBACK. Output also in
# diag-w0015-output.txt (ignored by git; flags, counts, staging catalog names and times only).
set -u
export MSYS_NO_PATHCONV=1
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -W)"
REF=aplbsutpzgemexayldct
HOST=aws-0-us-east-2.pooler.supabase.com
CLIENT=supabase_db_Claudio_app_Granja
CODE="${1:-W-0015}"
exec > >(tee -a "$HERE/diag-w0015-output.txt") 2>&1
echo "######## run $(date '+%Y-%m-%d %H:%M:%S') — diag $CODE (read-only)"
stop() { echo "STOP: $*"; unset PGPASSWORD; echo "== done (STOPPED)"; exit 2; }
[[ "$CODE" =~ ^W-[0-9]{4,}$ ]] || stop "draft code like W-0015"
case "$REF" in ycmkpnunhxluqqtecbyu|shdrztqgwpyyxclgfpdg) stop "forbidden project";; esac
LINE=$(supabase projects list -o json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d.slice(d.search(/[\[{]/)));const p=j.find(x=>(x.ref||x.id)==='$REF');console.log(p?[p.ref||p.id,p.name,p.region,p.status].join('|'):'')}catch{console.log('')}})")
echo "control plane: ${LINE:-not found}"
[ "$LINE" = "$REF|AppGranja|us-east-2|ACTIVE_HEALTHY" ] || stop "$REF is not AppGranja / us-east-2 / ACTIVE_HEALTHY"
echo "Pegá la contraseña de la BASE de AppGranja (no se ve) y Enter:"
read -rs PGPASSWORD; echo; PGPASSWORD=$(printf '%s' "$PGPASSWORD" | tr -d '\r\n'); [ -n "$PGPASSWORD" ] || stop "empty password"
export PGPASSWORD PGHOST="$HOST" PGPORT=5432 PGUSER="postgres.$REF" PGDATABASE=postgres PGSSLMODE=require
psqlc() { docker exec -i -e PGHOST -e PGPORT -e PGUSER -e PGPASSWORD -e PGDATABASE -e PGSSLMODE "$CLIENT" psql -X -q -t -A "$@" 2>&1 | tr -d '\r' | sed 's/^psql:<stdin>:[0-9]*: //'; }
FP=$(psqlc -c "SELECT (to_regclass('migration_ledger.applied') IS NULL) || '|' || (to_regclass('public.perfiles') IS NULL) || '|' || (to_regnamespace('sim') IS NOT NULL)" | grep '|')
[ "$FP" = "true|true|true" ] || stop "not the AppGranja bot-staging database"
psqlc -v code="$CODE" -f - < "$HERE/diag-w0015.sql" | grep -E "^diag\||ERROR"
unset PGPASSWORD
echo "== done"
