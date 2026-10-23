#!/usr/bin/env bash
# ADR-025 §18.4 — candidate migration + suite on the LOCAL full ERP (docker supabase_db_Claudio_app_Granja), ONE transaction, ROLLBACK.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB=supabase_db_Claudio_app_Granja
VARS=(-v admin_a=aaaaaaaa-0025-0000-0000-00000000ad0a -v admin_b=aaaaaaaa-0025-0000-0000-00000000ad0b -v oper=aaaaaaaa-0025-0000-0000-00000000ad0c
      -v gw=aaaaaaaa-0025-0000-0000-00000000ad0f -v phone_a=+5491100000001 -v phone_b=+5491100000002 -v phone_oper=+5491100000003)
before=$(docker exec -i $DB psql -U postgres -X -q -t -A -c "SELECT (to_regnamespace('wa') IS NULL) || '|' || (SELECT count(*) FROM purchases) || '|' || (SELECT count(*) FROM vault.secrets) || '|' || (SELECT max(version) FROM migration_ledger.applied)")
{ echo '\set ON_ERROR_STOP 1'; echo 'BEGIN;'
  cat "$HERE/build/candidate/0101_wa_whatsapp_gateway.candidate.sql"; echo
  cat "$HERE/build/candidate/fixtures.sql"; echo
  cat "$HERE/build/candidate/tests.sql"; echo
  echo 'ROLLBACK;'; } | docker exec -i $DB psql -U postgres -X -q -t -A "${VARS[@]}" -f - 2>&1 | grep -E "PASS|FAIL|SUMMARY|ERROR|GUARD" | sed 's/^psql:<stdin>:[0-9]*: //'
after=$(docker exec -i $DB psql -U postgres -X -q -t -A -c "SELECT (to_regnamespace('wa') IS NULL) || '|' || (SELECT count(*) FROM purchases) || '|' || (SELECT count(*) FROM vault.secrets) || '|' || (SELECT max(version) FROM migration_ledger.applied)")
echo "residue|before=$before after=$after $( [ "$before" = "$after" ] && echo NONE || echo CHANGED)"
