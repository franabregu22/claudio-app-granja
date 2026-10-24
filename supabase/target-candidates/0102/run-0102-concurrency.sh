#!/usr/bin/env bash
# 0102 concurrency / real-COMMIT checks on a DISPOSABLE clone of the local ERP (database erp0102_scratch inside the local
# docker container; created from a pg_dump of the local ERP, dropped at the end). Never touches the local ERP database itself.
set -u
C=supabase_db_Claudio_app_Granja
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDB=erp0102_scratch
A=bbbbbbbb-0102-0000-0000-00000000ad0a; B=bbbbbbbb-0102-0000-0000-00000000ad0b
G1=bbbbbbbb-0102-0000-0000-0000000000c1; G2=bbbbbbbb-0102-0000-0000-0000000000c2
q()  { docker exec -i $C psql -U postgres -d $SDB -X -q -t -A -c "$1" 2>&1; }
# one API session as ADMIN <uid>: BEGIN; <sql>; pg_sleep(<hold>); COMMIT  → prints the result (or the error)
api() { local uid=$1 sql=$2 hold=$3
  docker exec -i $C psql -U postgres -d $SDB -X -q -t -A 2>&1 <<SQL | grep -v '^$' | sed 's/^psql:<stdin>:[0-9]*: //'
SET ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"$uid","role":"authenticated"}', false) \g /dev/null
BEGIN;
$sql;
SELECT pg_sleep($hold) \g /dev/null
COMMIT;
SQL
}
check() { if [[ "$2" == $3 ]]; then echo "PASS $1"; P=$((P+1)); else echo "FAIL $1 :: got [$2] expected [$3]"; F=$((F+1)); fi; }
P=0; F=0

echo "== disposable clone"
docker exec $C bash -c "pg_dump -U postgres -d postgres -Fc -f /tmp/erp0102.dump && psql -U supabase_admin -d postgres -X -q -c 'DROP DATABASE IF EXISTS $SDB' -c 'CREATE DATABASE $SDB' \
  && pg_restore -U supabase_admin -d $SDB /tmp/erp0102.dump > /tmp/erp0102.restore.log 2>&1; rm -f /tmp/erp0102.dump;   psql -U supabase_admin -d $SDB -X -q -c 'GRANT ALL ON SCHEMA public TO postgres'; echo restore-errors: \$(grep -c 'error:' /tmp/erp0102.restore.log) '(pg_cron / 2 FK of unrelated tables: not used here)'"
q "SELECT 'clone: migrations ' || max(version) FROM migration_ledger.applied"
if ! { echo '\set ON_ERROR_STOP 1'; echo 'BEGIN;'; cat "$HERE/../../target-migrations/0101_unclassified_expenses.sql"; echo; echo 'COMMIT;'; } | docker exec -i $C psql -U postgres -d $SDB -X -q -t -A -f - 2>&1 | grep -E "ERROR"; then
  echo "candidate 0102 applied (committed) on the clone"
else echo "STOP: candidate failed on the clone"; docker exec $C psql -U supabase_admin -d postgres -X -q -c "DROP DATABASE $SDB"; exit 1; fi
q "INSERT INTO perfiles (id, email, rol_type) VALUES ('$A', 'c-admin-a@test.local', 'ADMIN'), ('$B', 'c-admin-b@test.local', 'ADMIN');
   INSERT INTO expense_category (id, nombre, pnl_cost_class, group_id) VALUES ('$G1', 'Gasoil 0102', 'DIRECT', (SELECT id FROM expense_category_group WHERE nombre = 'Combustible')),
          ('$G2', 'Nafta 0102', 'INDIRECT', (SELECT id FROM expense_category_group WHERE nombre = 'Combustible'))" >/dev/null
CAJA=$(q "SELECT id FROM financial_account WHERE nombre = 'Caja chica'")
REG="SELECT register_unclassified_expense('2026-10-20', 35000, 'combustible', '$CAJA'::uuid, 'CASH', 'WA:conc-1', NULL, 'WHATSAPP')::text"

echo "== CC-1 double confirmation, two sessions at the same time (same key)"
api $A "$REG" 2 > /tmp/cc1a.txt & sleep 0.5; api $A "$REG" 0 > /tmp/cc1b.txt; wait
r1=$(cat /tmp/cc1a.txt); r2=$(cat /tmp/cc1b.txt)
check "CC-1a first session registers" "$r1" '*"replayed": false*'
check "CC-1b second session waits, then replays the SAME pending" "$(echo "$r2" | grep -o '"pending_id": [0-9]*') $(echo "$r2" | grep -o '"replayed": [a-z]*')" "$(echo "$r1" | grep -o '"pending_id": [0-9]*') \"replayed\": true"
check "CC-1c one pending, one operation, one posting" "$(q "SELECT count(*) || '|' || (SELECT count(*) FROM financial_operation WHERE external_ref LIKE 'EXPENSE-PENDING:%') || '|' || (SELECT count(*) FROM financial_posting p JOIN financial_operation o ON o.id = p.financial_operation_id WHERE o.external_ref LIKE 'EXPENSE-PENDING:%') FROM expense_pending_classification")" '1|1|1'
PID=$(q "SELECT id FROM expense_pending_classification WHERE idempotency_key = 'WA:conc-1'")

echo "== CC-2 two ADMINs classify the same pending at the same time with DIFFERENT categories"
api $A "SELECT classify_pending_expense($PID, '$G1'::uuid, 'OPERATING')::text" 2 > /tmp/cc2a.txt & sleep 0.5
api $B "SELECT classify_pending_expense($PID, '$G2'::uuid, 'OPERATING')::text" 0 > /tmp/cc2b.txt; wait
check "CC-2a the first classification wins" "$(cat /tmp/cc2a.txt)" '*"status": "CLASIFICADO"*"replayed": false*'
check "CC-2b the second waits on the pending row, then ALREADY_CLASSIFIED" "$(cat /tmp/cc2b.txt)" '*ALREADY_CLASSIFIED*'
check "CC-2c exactly one purchase on the payment, one resolution, category of the winner" "$(q "SELECT count(*) || '|' || (SELECT count(*) FROM expense_pending_resolution WHERE pending_id = $PID) || '|' || min(expense_category_id::text) FROM purchases WHERE paid_operation_id = (SELECT payment_operation_id FROM expense_pending_classification WHERE id = $PID)")" "1|1|$G1"

echo "== CC-3 same classification twice at the same time → one writes, the other replays"
api $A "SELECT register_unclassified_expense('2026-10-20', 1200, 'x', '$CAJA'::uuid, 'CASH', 'WA:conc-3')::text" 0 >/dev/null
PID3=$(q "SELECT id FROM expense_pending_classification WHERE idempotency_key = 'WA:conc-3'")
api $A "SELECT classify_pending_expense($PID3, '$G1'::uuid, 'OPERATING')::text" 2 > /tmp/cc3a.txt & sleep 0.5
api $B "SELECT classify_pending_expense($PID3, '$G1'::uuid, 'OPERATING')::text" 0 > /tmp/cc3b.txt; wait
check "CC-3 first writes, second replays; one purchase" "$(grep -o '"replayed": [a-z]*' /tmp/cc3a.txt)|$(grep -o '"replayed": [a-z]*' /tmp/cc3b.txt)|$(q "SELECT count(*) FROM purchases WHERE paid_operation_id = (SELECT payment_operation_id FROM expense_pending_classification WHERE id = $PID3)")" '"replayed": false|"replayed": true|1'

echo "== CC-4 different keys at the same time are independent (no false serialization)"
api $A "SELECT register_unclassified_expense('2026-10-20', 100, 'x', '$CAJA'::uuid, 'CASH', 'WA:conc-4a')::text" 2 > /tmp/cc4a.txt & sleep 0.5
api $B "SELECT register_unclassified_expense('2026-10-20', 200, 'y', '$CAJA'::uuid, 'CASH', 'WA:conc-4b')::text" 0 > /tmp/cc4b.txt; wait
check "CC-4 both registered" "$(cat /tmp/cc4a.txt /tmp/cc4b.txt | grep -c '"replayed": false')" '2'

echo "== CC-5 the caller's transaction fails after the register (e.g. the WhatsApp confirmation aborts) → nothing remains"
before=$(q "SELECT (SELECT count(*) FROM expense_pending_classification) || '|' || (SELECT count(*) FROM financial_operation) || '|' || (SELECT count(*) FROM financial_posting)")
r5=$(docker exec -i $C psql -U postgres -d $SDB -X -q -t -A 2>&1 <<SQL
SET ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"$A","role":"authenticated"}', false) \g /dev/null
BEGIN;
SELECT register_unclassified_expense('2026-10-20', 777, 'x', '$CAJA'::uuid, 'CASH', 'WA:conc-5')::text;
SELECT 1/0;
COMMIT;
SQL
)
check "CC-5a the register itself succeeded inside the transaction, then the caller failed" "$(echo "$r5" | grep -c SIN_CLASIFICAR)|$(echo "$r5" | grep -c 'division by zero')" '1|1'
check "CC-5 no pending, no operation, no posting after the failed transaction" "$(q "SELECT (SELECT count(*) FROM expense_pending_classification) || '|' || (SELECT count(*) FROM financial_operation) || '|' || (SELECT count(*) FROM financial_posting)")" "$before"

echo "== CC-6 real COMMIT: an orphan EXPENSE-PENDING operation / a purchase on a pending payment are refused by the deferred triggers"
r=$(docker exec -i $C psql -U postgres -d $SDB -X -q -t -A 2>&1 <<SQL
BEGIN;
INSERT INTO financial_operation (operation_type, effective_date, external_ref) VALUES ('PURCHASE_PAYMENT', '2026-10-20', 'EXPENSE-PENDING:888888');
COMMIT;
SQL
)
check "CC-6a orphan operation: COMMIT fails" "$r" '*EXPENSE_PENDING_INTEGRITY*'
OP4=$(q "SELECT payment_operation_id FROM expense_pending_classification WHERE idempotency_key = 'WA:conc-4a'")
r=$(docker exec -i $C psql -U postgres -d $SDB -X -q -t -A 2>&1 <<SQL
BEGIN;
INSERT INTO purchases (supplier_id, economic_date, amount_net, amount_total, expense_category_id, subcategory, nature, paid_operation_id, is_current, version_seq, idempotency_key)
VALUES (NULL, '2026-10-20', 100, 100, '$G1', 'x', 'OPERATING', $OP4, true, 0, 'bypass-conc');
COMMIT;
SQL
)
check "CC-6b purchase without classification: COMMIT fails" "$r" '*EXPENSE_PENDING_INTEGRITY*'
check "CC-6c nothing persisted by the refused commits" "$(q "SELECT (SELECT count(*) FROM financial_operation WHERE external_ref = 'EXPENSE-PENDING:888888') || '|' || (SELECT count(*) FROM purchases WHERE idempotency_key = 'bypass-conc')")" '0|0'

echo "== drop the disposable clone"
docker exec $C psql -U supabase_admin -d postgres -X -q -c "DROP DATABASE $SDB" && echo "dropped $SDB"
echo "SUMMARY|$P|$F"
