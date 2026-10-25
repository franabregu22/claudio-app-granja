#!/usr/bin/env bash
# ADR-025 stage 4 — the candidate suite + the 0103 / 0104 suite on a LOCAL ERP database at 0104, ONE transaction, ROLLBACK.
#   bash supabase/target-candidates/0103/run-0103-local.sh <local database at 0104>
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CAND="$HERE/../../../integrations/whatsapp/wa-staging/build/candidate"
DB_NAME="${1:-}"; [[ "$DB_NAME" =~ ^[a-z0-9_]+$ ]] || { echo "usage: $0 <local database at 0104>"; exit 2; }
VARS=(-v admin_a=aaaaaaaa-0025-0000-0000-00000000ad0a -v admin_b=aaaaaaaa-0025-0000-0000-00000000ad0b -v oper=aaaaaaaa-0025-0000-0000-00000000ad0c
      -v gw=aaaaaaaa-0025-0000-0000-00000000ad0f -v phone_a=+5491100000001 -v phone_b=+5491100000002 -v phone_oper=+5491100000003)
{ echo '\set ON_ERROR_STOP 1'; echo 'BEGIN;'; cat "$CAND/fixtures.sql"; echo; cat "$CAND/tests.sql"; echo; cat "$HERE/tests-0103-0104.sql"; echo; echo 'ROLLBACK;'; } \
  | docker exec -i supabase_db_Claudio_app_Granja psql -U postgres -d "$DB_NAME" -X -q -t -A "${VARS[@]}" -f - 2>&1 \
  | grep -E "FAIL|SUMMARY|ERROR" | sed 's/^psql:<stdin>:[0-9]*: //'
