#!/usr/bin/env bash
# migration 0101 (unclassified expenses) + its suite on the LOCAL ERP (docker supabase_db_Claudio_app_Granja), ONE transaction, ROLLBACK — nothing persists.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB=supabase_db_Claudio_app_Granja
VARS=(-v admin_a=bbbbbbbb-0102-0000-0000-00000000ad0a -v admin_b=bbbbbbbb-0102-0000-0000-00000000ad0b -v oper=bbbbbbbb-0102-0000-0000-00000000ad0c
      -v nobody=bbbbbbbb-0102-0000-0000-00000000ad0f)
SNAP="SELECT (to_regclass('public.expense_pending_classification') IS NULL) || '|' || (SELECT count(*) FROM purchases) || '|' || (SELECT count(*) FROM financial_operation)
  || '|' || (SELECT count(*) FROM financial_posting) || '|' || (SELECT max(version) FROM migration_ledger.applied)"
before=$(docker exec -i $DB psql -U postgres -X -q -t -A -c "$SNAP")
{ echo '\set ON_ERROR_STOP 1'; echo 'BEGIN;'
  cat "$HERE/../../target-migrations/0101_unclassified_expenses.sql"; echo
  cat "$HERE/tests-0102.sql"; echo
  echo 'ROLLBACK;'; } | docker exec -i $DB psql -U postgres -X -q -t -A "${VARS[@]}" -f - 2>&1 | grep -E "PASS|FAIL|SUMMARY|ERROR" | sed 's/^psql:<stdin>:[0-9]*: //'
after=$(docker exec -i $DB psql -U postgres -X -q -t -A -c "$SNAP")
echo "residue|before=$before after=$after $( [ "$before" = "$after" ] && echo NONE || echo CHANGED)"
