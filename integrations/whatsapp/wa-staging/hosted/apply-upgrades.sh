#!/usr/bin/env bash
# ADR-025 — STAGE 2 (NOT RUN without the owner's GO): upgrades of the INSTALLED bot staging on AppGranja ONLY.
#   upgrade-001  public.wa_context (read-only RPC for the interpreter; gated to the gateway user; EXECUTE authenticated only)
#   upgrade-002  sim categories Combustible / Limpieza / Mantenimiento (sim only; the ERP catalog is never touched)
# Each upgrade: one transaction, guard (installed staging, never the ERP), reviewed build checksums, typed phrase.
set -u
export MSYS_NO_PATHCONV=1
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -W)"
ROOT="$HERE/.."
REF=aplbsutpzgemexayldct
HOST=aws-0-us-east-2.pooler.supabase.com
CLIENT=supabase_db_Claudio_app_Granja
exec > >(tee -a "$HERE/apply-upgrades-output.txt") 2>&1
echo "######## run $(date '+%Y-%m-%d %H:%M:%S') — AppGranja staging upgrades 001 + 002"
stop() { echo "STOP: $*"; unset PGPASSWORD; echo "== done (STOPPED)"; exit 2; }
case "$REF" in ycmkpnunhxluqqtecbyu|shdrztqgwpyyxclgfpdg) stop "forbidden project";; esac
(cd "$ROOT/build" && sha256sum -c SHA256SUMS --quiet) || stop "build differs from the reviewed SHA256SUMS"
LINE=$(supabase projects list -o json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d.slice(d.search(/[\[{]/)));const p=j.find(x=>(x.ref||x.id)==='$REF');console.log(p?[p.ref||p.id,p.name,p.region,p.status].join('|'):'')}catch{console.log('')}})")
echo "control plane: ${LINE:-not found}"
[ "$LINE" = "$REF|AppGranja|us-east-2|ACTIVE_HEALTHY" ] || stop "$REF is not AppGranja / us-east-2 / ACTIVE_HEALTHY"
echo "Pegá la contraseña de la BASE de AppGranja (no se ve) y Enter:"
read -rs PGPASSWORD; echo; PGPASSWORD=$(printf '%s' "$PGPASSWORD" | tr -d '\r\n'); [ -n "$PGPASSWORD" ] || stop "empty password"
export PGPASSWORD PGHOST="$HOST" PGPORT=5432 PGUSER="postgres.$REF" PGDATABASE=postgres PGSSLMODE=require
psqlc() { docker exec -i -e PGHOST -e PGPORT -e PGUSER -e PGPASSWORD -e PGDATABASE -e PGSSLMODE "$CLIENT" psql -X -q -t -A "$@" 2>&1 | tr -d '\r' | sed 's/^psql:<stdin>:[0-9]*: //'; }
FP=$(psqlc -c "SELECT (to_regclass('migration_ledger.applied') IS NULL) || '|' || (to_regclass('public.perfiles') IS NULL) || '|' || (to_regnamespace('wa') IS NOT NULL) || '|' || (to_regnamespace('sim') IS NOT NULL)" | grep '|')
echo "database fingerprint (no_ledger|no_erp_perfiles|wa|sim): ${FP:-unavailable}"
[ "$FP" = "true|true|true|true" ] || stop "not the installed AppGranja bot staging"
echo "Escribí exactamente: UPGRADE WA STAGING $REF"
read -r C; [ "$C" = "UPGRADE WA STAGING $REF" ] || stop "confirmation phrase mismatch"
for u in upgrade-001-wa-context upgrade-002-sim-categories; do
  R=$({ echo '\set ON_ERROR_STOP 1'; echo 'BEGIN;'; cat "$ROOT/build/staging/$u.sql"; echo 'COMMIT;'; } | psqlc -f - | grep -E "GUARD|ERROR")
  echo "$u: $R"
  echo "$R" | grep -q ERROR && stop "$u failed (rolled back)"
done
psqlc -c "SELECT 'verify|wa_context=' || (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'wa_context' AND p.prosecdef
            AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
            AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0))
          || ' public_wa_functions=' || (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'wa\_%')
          || ' sim_categories=' || (SELECT string_agg(c.nombre, ',' ORDER BY c.nombre) FROM sim.expense_category c JOIN sim.expense_category_group g ON g.id = c.group_id
                                     WHERE c.activo AND NOT c.fiscal_reserved AND g.kind = 'EXPENSE')"
unset PGPASSWORD
echo "PASS when: verify|wa_context=1 public_wa_functions=8 sim_categories=Combustible,Insumos,Limpieza,Mantenimiento"
echo "== done"
