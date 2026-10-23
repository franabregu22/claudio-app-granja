#!/usr/bin/env bash
# ADR-025 B-4 — PRODUCTION parity check (granja-santo-tomas-v1, ycmkpnunhxluqqtecbyu), STRICTLY READ-ONLY. Owner shell.
#   guards: only this ref (staging / Farm ERP refused) · control plane name / region / status · DB fingerprint of the ERP
#   then:   b4-parity-readonly.sql in ONE "REPEATABLE READ READ ONLY" transaction, rolled back; Edge function list (read-only).
# Nothing is created, changed or granted. The password is typed privately and never printed or stored.
set -u
export MSYS_NO_PATHCONV=1
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -W)"
REF=ycmkpnunhxluqqtecbyu
HOST=aws-0-sa-east-1.pooler.supabase.com
CLIENT=supabase_db_Claudio_app_Granja
exec > >(tee -a "$HERE/b4-parity-output.txt") 2>&1
echo "######## run $(date '+%Y-%m-%d %H:%M:%S') — ADR-025 B-4 production parity (READ-ONLY)"
stop() { echo "STOP: $*"; unset PGPASSWORD; echo "== done (STOPPED, nothing executed)"; exit 2; }
case "$REF" in aplbsutpzgemexayldct|shdrztqgwpyyxclgfpdg) stop "not the production ERP";; esac
LINE=$(supabase projects list -o json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d.slice(d.search(/[\[{]/)));const p=j.find(x=>(x.ref||x.id)==='$REF');console.log(p?[p.ref||p.id,p.name,p.region,p.status].join('|'):'')}catch{console.log('')}})")
echo "control plane: ${LINE:-not found}"
[ "$LINE" = "$REF|granja-santo-tomas-v1|sa-east-1|ACTIVE_HEALTHY" ] || stop "$REF is not granja-santo-tomas-v1 / sa-east-1 / ACTIVE_HEALTHY"
echo "Edge functions (read-only list):"
supabase functions list --project-ref "$REF" -o json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const a=JSON.parse(d.slice(d.search(/[\[{]/)));const f=(Array.isArray(a)?a:a.functions).map(x=>x.slug+':'+x.status).sort();console.log('  '+f.join(', '));console.log('check|8_SIN_WA|'+(f.some(s=>s.startsWith('wa-gateway:'))?'FAIL':'PASS')+'|W-3 no wa-gateway Edge Function deployed in production')}catch{console.log('check|8_SIN_WA|UNKNOWN|W-3 Edge function list unavailable')}})" | tee "$HERE/.b4-edge.txt"
echo "Pegá la contraseña de la BASE de PRODUCCIÓN con Shift+Insert (no se ve) y Enter:"
read -rs PGPASSWORD; echo; PGPASSWORD=$(printf '%s' "$PGPASSWORD" | tr -d '\r\n'); [ -n "$PGPASSWORD" ] || stop "empty password"
export PGPASSWORD PGHOST="$HOST" PGPORT=5432 PGUSER="postgres.$REF" PGDATABASE=postgres PGSSLMODE=require
psqlc() { docker exec -i -e PGHOST -e PGPORT -e PGUSER -e PGPASSWORD -e PGDATABASE -e PGSSLMODE "$CLIENT" psql -X -q -t -A "$@" 2>&1 | tr -d '\r' | sed 's/^psql:<stdin>:[0-9]*: //'; }
FP=$(psqlc -c "SELECT (to_regclass('migration_ledger.applied') IS NOT NULL) || '|' || (to_regclass('public.perfiles') IS NOT NULL) || '|' || (to_regclass('public.purchases') IS NOT NULL) || '|' || (to_regnamespace('sim') IS NULL)" | grep '|')
echo "database fingerprint (ledger|perfiles|purchases|no_sim): ${FP:-unavailable}"
[ "$FP" = "true|true|true|true" ] || stop "not the production ERP database (or authentication failed)"
OUT=$(psqlc -f - < "$HERE/b4-parity-readonly.sql")
unset PGPASSWORD
echo "$OUT" | grep -E '^(check|info)[|]|ERROR'
OUT="$OUT
$(grep '^check|' "$HERE/.b4-edge.txt")"; rm -f "$HERE/.b4-edge.txt"
verdict() { local g; g=$(echo "$OUT" | grep "^check|$1|"); [ -z "$g" ] && echo UNKNOWN && return
  echo "$g" | grep -q "|FAIL|" && echo FAIL && return; echo "$g" | grep -q "|UNKNOWN|" && echo UNKNOWN && return; echo PASS; }
for g in 1_IDENTIDAD 2_RPC 3_SEGURIDAD 4_CUENTAS 5_CATEGORIAS 6_ADMIN 7_METODOS 8_SIN_WA; do echo "$g: $(verdict $g)"; done
echo "== done (READ-ONLY, transaction rolled back, 0 writes)"
