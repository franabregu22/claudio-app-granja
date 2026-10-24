#!/usr/bin/env bash
# ADR-025 — applies ONLY upgrade-005 (payment method NEVER presumed: pending method, WA_METHOD_REQUIRED, METHOD buttons) to the
# INSTALLED bot staging (upgrade-004 required) on AppGranja (aplbsutpzgemexayldct). One transaction. Owner shell (password + typed phrase). NOT RUN without GO.
#   checks: forbidden refs · pinned file hash = build SHA256SUMS · control plane · read-only preflight-005 (every PASS, no FAIL)
#   then: rollback file generated FROM THIS DATABASE (snapshot-005) · accounting snapshot · phrase · apply · read-only verify-upgrade-005
#   rehearsed locally by compat-005-sandbox.sh (AppGranja state → upgrade → verify → published V2 suites → rollback → identical definitions)
set -u
export MSYS_NO_PATHCONV=1
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -W)"
ROOT="$HERE/.."
REF=aplbsutpzgemexayldct
HOST=aws-0-us-east-2.pooler.supabase.com
CLIENT=supabase_db_Claudio_app_Granja
FILE="$ROOT/build/staging/upgrade-005-method-pending.sql"
PINNED=057fe3d2d070443a9371eed85c5c07904f59382e04dade5cc6d08470e121cb2c
TS=$(date '+%Y%m%dT%H%M%S')
exec > >(tee -a "$HERE/apply-upgrade-005-output.txt") 2>&1
echo "######## run $(date '+%Y-%m-%d %H:%M:%S') — AppGranja staging upgrade-005 ONLY"
stop() { echo "STOP: $*"; unset PGPASSWORD; echo "== done (STOPPED)"; exit 2; }
case "$REF" in ycmkpnunhxluqqtecbyu|shdrztqgwpyyxclgfpdg) stop "forbidden project";; esac
GOT=$(sha256sum "$FILE" | cut -d' ' -f1); LISTED=$(grep ' staging/upgrade-005-method-pending.sql$' "$ROOT/build/SHA256SUMS" | cut -d' ' -f1)
echo "file sha256: $GOT (pinned $PINNED, SHA256SUMS ${LISTED:-missing})"
[ "$GOT" = "$PINNED" ] && [ "$GOT" = "$LISTED" ] || stop "upgrade-005 differs from the reviewed build"
LINE=$(supabase projects list -o json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d.slice(d.search(/[\[{]/)));const p=j.find(x=>(x.ref||x.id)==='$REF');console.log(p?[p.ref||p.id,p.name,p.region,p.status].join('|'):'')}catch{console.log('')}})")
echo "control plane: ${LINE:-not found}"
[ "$LINE" = "$REF|AppGranja|us-east-2|ACTIVE_HEALTHY" ] || stop "$REF is not AppGranja / us-east-2 / ACTIVE_HEALTHY"
echo "Pegá la contraseña de la BASE de AppGranja (no se ve) y Enter:"
read -rs PGPASSWORD; echo; PGPASSWORD=$(printf '%s' "$PGPASSWORD" | tr -d '\r\n'); [ -n "$PGPASSWORD" ] || stop "empty password"
export PGPASSWORD PGHOST="$HOST" PGPORT=5432 PGUSER="postgres.$REF" PGDATABASE=postgres PGSSLMODE=require
psqlc() { docker exec -i -e PGHOST -e PGPORT -e PGUSER -e PGPASSWORD -e PGDATABASE -e PGSSLMODE "$CLIENT" psql -X -q -t -A "$@" 2>&1 | tr -d '\r' | sed 's/^psql:<stdin>:[0-9]*: //'; }
echo "== preflight (read-only)"
PRE=$(psqlc -f - < "$HERE/preflight-005.sql" | grep '^pre|'); echo "$PRE"
[ -n "$PRE" ] || stop "preflight produced nothing"
echo "$PRE" | grep -q '|FAIL$' && stop "preflight FAIL — nothing applied"
[ "$(echo "$PRE" | grep -c '|PASS$')" = 5 ] || stop "preflight incomplete — nothing applied"
echo "== rollback file generated from this database (read-only) + accounting snapshot"
RB="$HERE/rollback-005-$TS.sql"
psqlc -f - < "$HERE/snapshot-005.sql" > "$RB"
[ "$(grep -c '^CREATE OR REPLACE FUNCTION ' "$RB")" = 3 ] && grep -q 'CREATE OR REPLACE FUNCTION public.wa_correct' "$RB" && grep -q 'CREATE OR REPLACE FUNCTION public.wa_confirm' "$RB" && grep -q '^COMMIT;$' "$RB"   && ! grep -qE '^(ERROR|FATAL|psql: error)' "$RB" || stop "rollback file incomplete — nothing applied"
echo "rollback file: $RB ($(grep -c . "$RB") lines)"
ACCT=$(psqlc -f - < "$HERE/acct-004.sql" | grep '^acct|' | cut -d'|' -f2-); [ -n "$ACCT" ] || stop "accounting snapshot failed"
echo "accounting before: $ACCT"
echo "Escribí exactamente: UPGRADE-005 WA STAGING $REF"
read -r C; [ "$C" = "UPGRADE-005 WA STAGING $REF" ] || stop "confirmation phrase mismatch — nothing applied"
R=$({ echo '\set ON_ERROR_STOP 1'; echo 'BEGIN;'; cat "$FILE"; echo 'COMMIT;'; } | psqlc -f - | grep -E "GUARD|ERROR")
echo "upgrade-005: $R"
echo "$R" | grep -q ERROR && stop "upgrade-005 failed (rolled back; nothing changed)"
echo "== independent read-only verification"
OUT=$(psqlc -v pre="$ACCT" -f - < "$HERE/verify-upgrade-005.sql" | grep '^check|')
unset PGPASSWORD
echo "$OUT"
echo "UPGRADE-005 APPGRANJA: $([ -n "$OUT" ] && ! echo "$OUT" | grep -q '|FAIL$' && echo PASS || echo "FAIL — run rollback-upgrade-005.sh $RB")"
echo "== done"
