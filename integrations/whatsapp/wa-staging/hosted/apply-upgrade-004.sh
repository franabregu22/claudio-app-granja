#!/usr/bin/env bash
# ADR-025 — applies ONLY upgrade-004 (D-1 live categories, D-3 live accounts, "Registrar sin clasif", fin_mp_whatsapp_notes) to the
# INSTALLED bot staging on AppGranja (aplbsutpzgemexayldct). One transaction. Owner shell (password + typed phrase). NOT RUN without GO.
#   checks: forbidden refs · pinned file hash = build SHA256SUMS · control plane · read-only preflight-004 (every PASS, no FAIL)
#   then: rollback file generated FROM THIS DATABASE (snapshot-004) · accounting snapshot · phrase · apply · read-only verify-upgrade-004
#   rehearsed locally by compat-004-sandbox.sh (55aa19f state → upgrade → verify → V2 suite → rollback → identical definitions)
set -u
export MSYS_NO_PATHCONV=1
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -W)"
ROOT="$HERE/.."
REF=aplbsutpzgemexayldct
HOST=aws-0-us-east-2.pooler.supabase.com
CLIENT=supabase_db_Claudio_app_Granja
FILE="$ROOT/build/staging/upgrade-004-catalog-rule.sql"
PINNED=eceab9af020c83287ed4d57d758e74606e0683de718a05bcc8394ef8fca6e44d
TS=$(date '+%Y%m%dT%H%M%S')
exec > >(tee -a "$HERE/apply-upgrade-004-output.txt") 2>&1
echo "######## run $(date '+%Y-%m-%d %H:%M:%S') — AppGranja staging upgrade-004 ONLY"
stop() { echo "STOP: $*"; unset PGPASSWORD; echo "== done (STOPPED)"; exit 2; }
case "$REF" in ycmkpnunhxluqqtecbyu|shdrztqgwpyyxclgfpdg) stop "forbidden project";; esac
GOT=$(sha256sum "$FILE" | cut -d' ' -f1); LISTED=$(grep ' staging/upgrade-004-catalog-rule.sql$' "$ROOT/build/SHA256SUMS" | cut -d' ' -f1)
echo "file sha256: $GOT (pinned $PINNED, SHA256SUMS ${LISTED:-missing})"
[ "$GOT" = "$PINNED" ] && [ "$GOT" = "$LISTED" ] || stop "upgrade-004 differs from the reviewed build"
LINE=$(supabase projects list -o json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d.slice(d.search(/[\[{]/)));const p=j.find(x=>(x.ref||x.id)==='$REF');console.log(p?[p.ref||p.id,p.name,p.region,p.status].join('|'):'')}catch{console.log('')}})")
echo "control plane: ${LINE:-not found}"
[ "$LINE" = "$REF|AppGranja|us-east-2|ACTIVE_HEALTHY" ] || stop "$REF is not AppGranja / us-east-2 / ACTIVE_HEALTHY"
echo "Pegá la contraseña de la BASE de AppGranja (no se ve) y Enter:"
read -rs PGPASSWORD; echo; PGPASSWORD=$(printf '%s' "$PGPASSWORD" | tr -d '\r\n'); [ -n "$PGPASSWORD" ] || stop "empty password"
export PGPASSWORD PGHOST="$HOST" PGPORT=5432 PGUSER="postgres.$REF" PGDATABASE=postgres PGSSLMODE=require
psqlc() { docker exec -i -e PGHOST -e PGPORT -e PGUSER -e PGPASSWORD -e PGDATABASE -e PGSSLMODE "$CLIENT" psql -X -q -t -A "$@" 2>&1 | tr -d '\r' | sed 's/^psql:<stdin>:[0-9]*: //'; }
echo "== preflight (read-only)"
PRE=$(psqlc -f - < "$HERE/preflight-004.sql" | grep '^pre|'); echo "$PRE"
[ -n "$PRE" ] || stop "preflight produced nothing"
echo "$PRE" | grep -q '|FAIL$' && stop "preflight FAIL — nothing applied"
[ "$(echo "$PRE" | grep -c '|PASS$')" = 7 ] || stop "preflight incomplete — nothing applied"
echo "== rollback file generated from this database (read-only) + accounting snapshot"
RB="$HERE/rollback-004-$TS.sql"
psqlc -f - < "$HERE/snapshot-004.sql" > "$RB"
[ "$(grep -c '^CREATE OR REPLACE FUNCTION ' "$RB")" = 3 ] && grep -q 'CREATE OR REPLACE FUNCTION public.wa_confirm' "$RB" && grep -q '^COMMIT;$' "$RB"   && ! grep -qE '^(ERROR|FATAL|psql: error)' "$RB" || stop "rollback file incomplete — nothing applied"
echo "rollback file: $RB ($(grep -c . "$RB") lines)"
ACCT=$(psqlc -f - < "$HERE/acct-004.sql" | grep '^acct|' | cut -d'|' -f2-); [ -n "$ACCT" ] || stop "accounting snapshot failed"
echo "accounting before: $ACCT"
echo "Escribí exactamente: UPGRADE-004 WA STAGING $REF"
read -r C; [ "$C" = "UPGRADE-004 WA STAGING $REF" ] || stop "confirmation phrase mismatch — nothing applied"
R=$({ echo '\set ON_ERROR_STOP 1'; echo 'BEGIN;'; cat "$FILE"; echo 'COMMIT;'; } | psqlc -f - | grep -E "GUARD|ERROR")
echo "upgrade-004: $R"
echo "$R" | grep -q ERROR && stop "upgrade-004 failed (rolled back; nothing changed)"
echo "== independent read-only verification"
OUT=$(psqlc -v pre="$ACCT" -f - < "$HERE/verify-upgrade-004.sql" | grep '^check|')
unset PGPASSWORD
echo "$OUT"
echo "UPGRADE-004 APPGRANJA: $([ -n "$OUT" ] && ! echo "$OUT" | grep -q '|FAIL$' && echo PASS || echo "FAIL — run rollback-upgrade-004.sh $RB")"
echo "== done"
