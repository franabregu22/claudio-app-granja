#!/usr/bin/env bash
# ADR-025 — READ-ONLY verification of one WhatsApp expense on AppGranja (aplbsutpzgemexayldct) ONLY. Owner shell.
# Usage: verify-draft.sh [W-0007]   (expected values below are those reported for W-0007)
set -u
export MSYS_NO_PATHCONV=1
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -W)"
REF=aplbsutpzgemexayldct
HOST=aws-0-us-east-2.pooler.supabase.com
CLIENT=supabase_db_Claudio_app_Granja
CODE="${1:-W-0007}"
[[ "$CODE" =~ ^W-[0-9]{4,}$ ]] || { echo "STOP: draft code like W-0007"; exit 2; }
stop() { echo "STOP: $*"; unset PGPASSWORD; exit 2; }
case "$REF" in ycmkpnunhxluqqtecbyu|shdrztqgwpyyxclgfpdg) stop "forbidden project";; esac
LINE=$(supabase projects list -o json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d.slice(d.search(/[\[{]/)));const p=j.find(x=>(x.ref||x.id)==='$REF');console.log(p?[p.ref||p.id,p.name,p.region,p.status].join('|'):'')}catch{console.log('')}})")
echo "control plane: ${LINE:-not found}"
[ "$LINE" = "$REF|AppGranja|us-east-2|ACTIVE_HEALTHY" ] || stop "$REF is not AppGranja / us-east-2 / ACTIVE_HEALTHY"
echo "Pegá la contraseña de la BASE de AppGranja (no se ve) y Enter:"
read -rs PGPASSWORD; echo; PGPASSWORD=$(printf '%s' "$PGPASSWORD" | tr -d '\r\n'); [ -n "$PGPASSWORD" ] || stop "empty password"
export PGPASSWORD PGHOST="$HOST" PGPORT=5432 PGUSER="postgres.$REF" PGDATABASE=postgres PGSSLMODE=require
psqlc() { docker exec -i -e PGHOST -e PGPORT -e PGUSER -e PGPASSWORD -e PGDATABASE -e PGSSLMODE "$CLIENT" psql -X -q -t -A "$@" 2>&1 | tr -d '\r' | sed 's/^psql:<stdin>:[0-9]*: //'; }
FP=$(psqlc -c "SELECT (to_regclass('migration_ledger.applied') IS NULL) || '|' || (to_regclass('public.perfiles') IS NULL) || '|' || (to_regnamespace('sim') IS NOT NULL)" | grep '|')
echo "database fingerprint (no_ledger|no_erp_perfiles|sim): ${FP:-unavailable}"
[ "$FP" = "true|true|true" ] || stop "not the AppGranja bot-staging database"
OUT=$(psqlc -v code="$CODE" -v total=15000.00 -v concept='Alimento y' -v category=Insumos -v method=CASH -v account='Caja chica' -v date=2026-10-22 -f - < "$HERE/verify-draft.sql")
unset PGPASSWORD
echo "$OUT" | grep -E "^(check|info)\||ERROR"
verdict() { local g; g=$(echo "$OUT" | grep "^check|$1|"); [ -z "$g" ] && echo UNKNOWN && return
  echo "$g" | grep -q "|FAIL|" && echo FAIL && return; echo "$g" | grep -q "|UNKNOWN|" && echo UNKNOWN && return; echo PASS; }
echo "GASTO REGISTRADO: $(verdict GASTO)"
echo "IMPORTE Y CAMPOS: $(verdict CAMPOS)"
echo "SIN DUPLICADOS: $(verdict DUPLICADOS)"
echo "BORRADOR CONFIRMADO: $(verdict BORRADOR)"
echo "AUDITORIA: $(verdict AUDITORIA)"
ALL=$(for g in GASTO CAMPOS DUPLICADOS BORRADOR AUDITORIA; do verdict $g; done | sort -u | tr '\n' ' ')
echo "VEREDICTO FINAL: $([ "$ALL" = "PASS " ] && echo PASS || echo FAIL)"
