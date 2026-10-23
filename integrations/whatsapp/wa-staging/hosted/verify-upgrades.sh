#!/usr/bin/env bash
# ADR-025 §18 — READ-ONLY verification of upgrade-001 + upgrade-002 on AppGranja (aplbsutpzgemexayldct) ONLY. Owner shell.
# Does NOT re-apply anything: verify-upgrades.sql runs inside BEGIN READ ONLY ... ROLLBACK.
# SINCE = start of the upgrade run recorded in apply-upgrades-output.txt (2026-10-22 11:48:13 -03).
set -u
export MSYS_NO_PATHCONV=1
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -W)"
REF=aplbsutpzgemexayldct
HOST=aws-0-us-east-2.pooler.supabase.com
CLIENT=supabase_db_Claudio_app_Granja
SINCE="${1:-2026-10-22 11:48:00-03}"
exec > >(tee -a "$HERE/verify-upgrades-output.txt") 2>&1
echo "######## run $(date '+%Y-%m-%d %H:%M:%S') — verify upgrades 001 + 002 (read-only), since $SINCE"
stop() { echo "STOP: $*"; unset PGPASSWORD; echo "== done (STOPPED)"; exit 2; }
case "$REF" in ycmkpnunhxluqqtecbyu|shdrztqgwpyyxclgfpdg) stop "forbidden project";; esac
LINE=$(supabase projects list -o json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d.slice(d.search(/[\[{]/)));const p=j.find(x=>(x.ref||x.id)==='$REF');console.log(p?[p.ref||p.id,p.name,p.region,p.status].join('|'):'')}catch{console.log('')}})")
echo "control plane: ${LINE:-not found}"
[ "$LINE" = "$REF|AppGranja|us-east-2|ACTIVE_HEALTHY" ] || stop "$REF is not AppGranja / us-east-2 / ACTIVE_HEALTHY"
echo "Pegá la contraseña de la BASE de AppGranja (no se ve) y Enter:"
read -rs PGPASSWORD; echo; PGPASSWORD=$(printf '%s' "$PGPASSWORD" | tr -d '\r\n'); [ -n "$PGPASSWORD" ] || stop "empty password"
export PGPASSWORD PGHOST="$HOST" PGPORT=5432 PGUSER="postgres.$REF" PGDATABASE=postgres PGSSLMODE=require
psqlc() { docker exec -i -e PGHOST -e PGPORT -e PGUSER -e PGPASSWORD -e PGDATABASE -e PGSSLMODE "$CLIENT" psql -X -q -t -A "$@" 2>&1 | tr -d '\r' | sed 's/^psql:<stdin>:[0-9]*: //'; }
FP=$(psqlc -c "SELECT (to_regclass('migration_ledger.applied') IS NULL) || '|' || (to_regclass('public.perfiles') IS NULL) || '|' || (to_regnamespace('wa') IS NOT NULL) || '|' || (to_regnamespace('sim') IS NOT NULL)" | grep '|')
echo "database fingerprint (no_ledger|no_erp_perfiles|wa|sim): ${FP:-unavailable}"
[ "$FP" = "true|true|true|true" ] || stop "not the AppGranja bot-staging database"
OUT=$(psqlc -v since="$SINCE" -f - < "$HERE/verify-upgrades.sql")
unset PGPASSWORD
echo "$OUT" | grep -E "^(check|info)\||ERROR"
verdict() { local g; g=$(echo "$OUT" | grep "^check|$1|"); [ -z "$g" ] && echo UNKNOWN && return
  echo "$g" | grep -q "|FAIL|" && echo FAIL && return; echo "$g" | grep -q "|UNKNOWN|" && echo UNKNOWN && return; echo PASS; }
echo "RPC wa_context: $(verdict RPC)"
echo "CATEGORIAS SIM: $(verdict CATEGORIAS)"
echo "SIN CAMBIOS CONTABLES: $(verdict SIN_CAMBIOS)"
ALL=$(for g in RPC CATEGORIAS SIN_CAMBIOS; do verdict $g; done | sort -u | tr '\n' ' ')
echo "UPGRADE APPGRANJA: $([ "$ALL" = "PASS " ] && echo PASS || echo FAIL)"
echo "== done"
