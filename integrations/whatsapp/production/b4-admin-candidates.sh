#!/usr/bin/env bash
# ADR-025 B-4 / A — PRODUCTION pilot ADMIN candidates (granja-santo-tomas-v1, ycmkpnunhxluqqtecbyu), STRICTLY READ-ONLY. Owner shell.
#   guards: only this ref (staging / Farm ERP refused) · control plane name / region / status · DB fingerprint of the ERP
#   usage:  b4-admin-candidates.sh            → list the active ADMIN profiles (8-char id prefix + non-identifying hints)
#           b4-admin-candidates.sh P1 P2      → also validate the two chosen pilot prefixes (A-3, A-4)
# Nothing is created, changed or granted. The password is typed privately and never printed or stored.
set -u
export MSYS_NO_PATHCONV=1
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -W)"
REF=ycmkpnunhxluqqtecbyu
HOST=aws-0-sa-east-1.pooler.supabase.com
CLIENT=supabase_db_Claudio_app_Granja
P1="${1:-}"; P2="${2:-}"
for p in "$P1" "$P2"; do [ -z "$p" ] || [[ "$p" =~ ^[0-9a-f]{8}$ ]] || { echo "STOP: prefixes are 8 lowercase hex characters"; exit 2; }; done
exec > >(tee -a "$HERE/b4-admin-output.txt") 2>&1
echo "######## run $(date '+%Y-%m-%d %H:%M:%S') — ADR-025 B-4 pilot ADMIN candidates (READ-ONLY)"
stop() { echo "STOP: $*"; unset PGPASSWORD; echo "== done (STOPPED, nothing executed)"; exit 2; }
case "$REF" in aplbsutpzgemexayldct|shdrztqgwpyyxclgfpdg) stop "not the production ERP";; esac
LINE=$(supabase projects list -o json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d.slice(d.search(/[\[{]/)));const p=j.find(x=>(x.ref||x.id)==='$REF');console.log(p?[p.ref||p.id,p.name,p.region,p.status].join('|'):'')}catch{console.log('')}})")
echo "control plane: ${LINE:-not found}"
[ "$LINE" = "$REF|granja-santo-tomas-v1|sa-east-1|ACTIVE_HEALTHY" ] || stop "$REF is not granja-santo-tomas-v1 / sa-east-1 / ACTIVE_HEALTHY"
echo "Pegá la contraseña de la BASE de PRODUCCIÓN con Shift+Insert (no se ve) y Enter:"
read -rs PGPASSWORD; echo; PGPASSWORD=$(printf '%s' "$PGPASSWORD" | tr -d '\r\n'); [ -n "$PGPASSWORD" ] || stop "empty password"
export PGPASSWORD PGHOST="$HOST" PGPORT=5432 PGUSER="postgres.$REF" PGDATABASE=postgres PGSSLMODE=require
psqlc() { docker exec -i -e PGHOST -e PGPORT -e PGUSER -e PGPASSWORD -e PGDATABASE -e PGSSLMODE "$CLIENT" psql -X -q -t -A "$@" 2>&1 | tr -d '\r' | sed 's/^psql:<stdin>:[0-9]*: //'; }
FP=$(psqlc -c "SELECT (to_regclass('migration_ledger.applied') IS NOT NULL) || '|' || (to_regclass('public.perfiles') IS NOT NULL) || '|' || (to_regclass('public.purchases') IS NOT NULL) || '|' || (to_regnamespace('sim') IS NULL)" | grep '|')
echo "database fingerprint (ledger|perfiles|purchases|no_sim): ${FP:-unavailable}"
[ "$FP" = "true|true|true|true" ] || stop "not the production ERP database (or authentication failed)"
OUT=$(psqlc -v p1="$P1" -v p2="$P2" -f - < "$HERE/b4-admin-candidates.sql")
unset PGPASSWORD
echo "$OUT" | grep -E '^(check|cand)[|]|ERROR'
verdict() { local g; g=$(echo "$OUT" | grep "^check|$1|"); [ -z "$g" ] && echo UNKNOWN && return
  echo "$g" | grep -q "|FAIL|" && echo FAIL && return; echo "$g" | grep -q "|UNKNOWN|" && echo UNKNOWN && return; echo PASS; }
echo "6_ADMIN: $(verdict 6_ADMIN)"; [ -z "$P1" ] && echo "(list only: A-3 / A-4 need the two chosen prefixes)"
echo "== done (READ-ONLY, transaction rolled back, 0 writes)"
