#!/usr/bin/env bash
# ADR-025 B-4 / A — show the Auth EMAIL of each active ADMIN of PRODUCTION (granja-santo-tomas-v1) next to its 8-char id prefix,
# ON THE TERMINAL ONLY, so the owner can recognise the two pilot profiles. STRICTLY READ-ONLY (one READ ONLY transaction, rolled
# back). Nothing is written anywhere: no tee, no log file, no report; emails never leave this process' stdout.
# Then validate the two chosen prefixes with: b4-admin-candidates.sh <prefix1> <prefix2>
set -u
export MSYS_NO_PATHCONV=1
REF=ycmkpnunhxluqqtecbyu
HOST=aws-0-sa-east-1.pooler.supabase.com
CLIENT=supabase_db_Claudio_app_Granja
stop() { echo "STOP: $*"; unset PGPASSWORD; exit 2; }
case "$REF" in aplbsutpzgemexayldct|shdrztqgwpyyxclgfpdg) stop "not the production ERP";; esac
[ -t 1 ] || stop "stdout is not a terminal — refusing to send emails to a pipe or a file"
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
echo "== active ADMIN profiles (prefix | Auth email) — shown here only, not saved"
psqlc <<'SQL'
\set ON_ERROR_STOP 1
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT '  ' || left(p.id::text, 8) || ' | ' || CASE WHEN u.id IS NULL THEN '(no Auth user)' WHEN u.email IS NULL THEN '(Auth user without email)' ELSE u.email END
  FROM perfiles p LEFT JOIN auth.users u ON u.id = p.id
 WHERE p.activo AND p.rol_type::text = 'ADMIN' ORDER BY 1;
ROLLBACK;
SQL
unset PGPASSWORD
echo "== done (READ-ONLY, rolled back, nothing written). Next: b4-admin-candidates.sh <prefix1> <prefix2>"
