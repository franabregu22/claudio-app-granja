#!/usr/bin/env bash
# ADR-025 §18 — applies ONLY upgrade-003 (wa.duplicate_refs + "duplicates" in wa_propose / wa_correct) to the INSTALLED bot staging
# on AppGranja (aplbsutpzgemexayldct). Never upgrade-001 / 002 again. One transaction. Owner shell (password + typed phrase).
#   checks: forbidden refs · pinned file hash = build SHA256SUMS · control plane · DB fingerprint · 001/002 present, 003 absent
#   then: accounting snapshot → apply → independent READ-ONLY verification (verify-upgrade-003.sql) against that snapshot.
set -u
export MSYS_NO_PATHCONV=1
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -W)"
ROOT="$HERE/.."
REF=aplbsutpzgemexayldct
HOST=aws-0-us-east-2.pooler.supabase.com
CLIENT=supabase_db_Claudio_app_Granja
FILE="$ROOT/build/staging/upgrade-003-duplicate-refs.sql"
PINNED=e342f7556bff9d364a6258dd93f5961db7fc8e82a3445fb12c03b0a0efa9bde0
exec > >(tee -a "$HERE/apply-upgrade-003-output.txt") 2>&1
echo "######## run $(date '+%Y-%m-%d %H:%M:%S') — AppGranja staging upgrade-003 ONLY"
stop() { echo "STOP: $*"; unset PGPASSWORD; echo "== done (STOPPED)"; exit 2; }
case "$REF" in ycmkpnunhxluqqtecbyu|shdrztqgwpyyxclgfpdg) stop "forbidden project";; esac
GOT=$(sha256sum "$FILE" | cut -d' ' -f1); LISTED=$(grep ' staging/upgrade-003-duplicate-refs.sql$' "$ROOT/build/SHA256SUMS" | cut -d' ' -f1)
echo "file sha256: $GOT (pinned $PINNED, SHA256SUMS ${LISTED:-missing})"
[ "$GOT" = "$PINNED" ] && [ "$GOT" = "$LISTED" ] || stop "upgrade-003 differs from the reviewed build"
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
PRE=$(psqlc -c "SELECT (to_regprocedure('public.wa_context(bigint)') IS NOT NULL) || '|' || (SELECT count(*) FROM sim.expense_category WHERE id IN ('aaaaaaaa-0025-0000-0000-0000000000c4','aaaaaaaa-0025-0000-0000-0000000000c5','aaaaaaaa-0025-0000-0000-0000000000c6')) || '|' || (to_regprocedure('wa.duplicate_refs(jsonb, uuid)') IS NULL) || '|' || (SELECT state || ':v' || version FROM wa.draft WHERE short_code = 'W-0011')" | grep '|')
echo "preconditions (upgrade-001|upgrade-002 categories|003 absent|W-0011): ${PRE:-unavailable}"
[ "$PRE" = "true|3|true|DRAFT:v2" ] || stop "unexpected state (001/002 must be applied, 003 absent, W-0011 DRAFT v2) — nothing applied"
SNAP=$(psqlc -f - < "$HERE/snapshot-003.sql" | grep '^snap|' | cut -d'|' -f2-)
[ -n "$SNAP" ] || stop "snapshot failed"
printf '%s\n' "$SNAP" > "$HERE/upgrade-003-snapshot.txt"
echo "snapshot before: $SNAP"
echo "Escribí exactamente: UPGRADE-003 WA STAGING $REF"
read -r C; [ "$C" = "UPGRADE-003 WA STAGING $REF" ] || stop "confirmation phrase mismatch — nothing applied"
R=$({ echo '\set ON_ERROR_STOP 1'; echo 'BEGIN;'; cat "$FILE"; echo 'COMMIT;'; } | psqlc -f - | grep -E "GUARD|ERROR")
echo "upgrade-003: $R"
echo "$R" | grep -q ERROR && stop "upgrade-003 failed (rolled back)"
echo "== independent read-only verification"
OUT=$(psqlc -v pre="$SNAP" -f - < "$HERE/verify-upgrade-003.sql")
unset PGPASSWORD
echo "$OUT" | grep -E '^(check|info)[|]|ERROR'
verdict() { local g; g=$(echo "$OUT" | grep "^check|$1|"); [ -z "$g" ] && echo UNKNOWN && return
  echo "$g" | grep -q "|FAIL|" && echo FAIL && return; echo "$g" | grep -q "|UNKNOWN|" && echo UNKNOWN && return; echo PASS; }
for g in FUNCION API REFERENCIAS VISIBILIDAD SIN_CAMBIOS; do echo "$g: $(verdict $g)"; done
ALL=$(for g in FUNCION API REFERENCIAS VISIBILIDAD SIN_CAMBIOS; do verdict $g; done | sort -u | tr '\n' ' ')
echo "UPGRADE-003 APPGRANJA: $([ "$ALL" = "PASS " ] && echo PASS || echo FAIL)"
echo "== done"
