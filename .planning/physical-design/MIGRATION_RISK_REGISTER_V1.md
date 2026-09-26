# MIGRATION RISK REGISTER V1

**STATUS:** Legacy issues separated from schema design  
**DATE:** 2026-09-24  
**PURPOSE:** Document data-quality issues that must be resolved BEFORE cutover, not before schema freeze

---

## EXECUTIVE SUMMARY

**Physical Database Design:** STABLE (no schema blockers)

**Migration readiness:** BLOCKED on 4 data prerequisites (not architectural).

**Critical distinction:**
- **Schema blockers** = target schema is unstable or impossible → freeze cannot proceed
- **Migration blockers** = target schema is fine, but legacy data unclean → cutover cannot proceed

**This register:** Migration blockers only. Schema is ready to freeze.

---

## RISK 1: forma_pago ENUM REDEFINITION UNRESOLVED

| Property | Value |
|---|---|
| **ID** | MR-001 |
| **Legacy source** | Migrations 019 and 045 |
| **Issue** | Enum redefined mid-project; potential double-definition in schema |
| **Evidence** | Migration 019: ('efectivo', 'mercadopago', 'echeq', 'cheque'); Migration 045: ('efectivo', 'mercadopago', 'transferencia') |
| **Target affected** | movimientos_caja → financial_operation (forma_pago classification) |
| **Validation required** | Verify migration 045 executed successfully; ensure no cheques remain in movimientos_caja with forma_pago='cheque' post-execution |
| **Owner involvement** | Validation task (no decision needed) |
| **Must resolve before migration?** | YES (data integrity) |
| **Must resolve before schema freeze?** | NO (schema itself is correct) |
| **Blocks Physical Schema Freeze?** | NO |

---

### Validation Procedure

**Query:** Check for orphaned cheques in movimientos_caja

```sql
SELECT COUNT(*) FROM movimientos_caja 
WHERE forma_pago IN ('cheque', 'echeq') AND (migrated = false OR migrated IS NULL);
```

**Expected result:** 0 rows

**If found:** Migrate to cheques table + financial_instrument before proceeding.

**Evidence log:** Document query result + timestamp + sign-off.

---

## RISK 2: DUPLICATE MORTANDAD DATA UNVALIDATED

| Property | Value |
|---|---|
| **ID** | MR-002 |
| **Legacy source** | producciones table |
| **Issue** | Multiple rows with same (lote_id, fecha) may have different mortandad values; frozen architecture cannot resolve truth |
| **Evidence** | No MORTALITY_CONFLICT state machine in frozen design; only one value per (flock, date) allowed |
| **Target affected** | population_events table (UNIQUE(flock_id, event_date) WHERE event_type='MORTALITY') |
| **Validation required** | Query producciones for duplicates; if found, owner must validate truth; cleanses data before extraction |
| **Owner involvement** | Sign-off on duplicate resolution |
| **Must resolve before migration?** | YES (data integrity + migration blocking) |
| **Must resolve before schema freeze?** | NO (schema itself handles uniqueness correctly) |
| **Blocks Physical Schema Freeze?** | NO |

---

### Validation Procedure

**Query:** Find duplicate mortandad records

```sql
SELECT lote_id, fecha, COUNT(*) as cnt, ARRAY_AGG(mortandad) as values
FROM producciones
WHERE mortandad IS NOT NULL
GROUP BY lote_id, fecha
HAVING COUNT(*) > 1;
```

**Expected result:** 0 rows

**If found:**
1. Document (lote_id, fecha, values)
2. Obtain owner review: which is truth?
3. Cleanses data (keep truth; delete/mark others as superseded)
4. Re-query to verify resolution

**Evidence log:** Original query result + owner notes + cleaned query result + sign-off date.

---

## RISK 3: CLIENT LEDGER OPENING BALANCE UNVALIDATED

| Property | Value |
|---|---|
| **ID** | MR-003 |
| **Legacy source** | pagos + pedidos (ad-hoc saldo calculation) |
| **Issue** | Current "saldo" calculation ambiguous; may diverge from movimientos_caja; no authoritative historical audit trail |
| **Evidence** | Saldo calculated as SUM(pagos) - SUM(pedidos.monto_total); lacks documented methodology; no owner reconciliation |
| **Target affected** | client_ledger (OPENING_BALANCE entries at cutover) |
| **Validation required** | Audit saldo calculation; validate against owner records (AR aging report, reconciliation records); create owner-signed opening balance |
| **Owner involvement** | **CRITICAL:** Review and sign-off on opening balance for each client |
| **Must resolve before migration?** | YES (data integrity + audit trail credibility) |
| **Must resolve before schema freeze?** | NO (schema supports opening balances correctly) |
| **Blocks Physical Schema Freeze?** | NO |

---

### Validation Procedure

**Step 1: Audit current calculation**

```sql
SELECT cliente_id,
  SUM(pagos.monto) as pago_sum,
  SUM(pedidos.monto_total WHERE estado='DELIVERED') as sale_sum,
  (sale_sum - pago_sum) as calculated_balance,
  (SELECT saldo FROM cliente_saldos WHERE cliente_id=clientes.id) as reported_saldo
FROM clientes
LEFT JOIN pagos ON pagos.cliente_id=clientes.id
LEFT JOIN pedidos ON pedidos.cliente_id=clientes.id AND pedidos.estado='DELIVERED'
GROUP BY cliente_id;
```

**Expected:** calculated_balance ≈ reported_saldo (within tolerance)

**If divergence found:** Investigate cause (missing transaction? dual-entry error? commission not captured?)

**Step 2: Obtain owner validation**

- Owner reviews aging report as of cutover date
- Owner provides signed reconciliation document (PDF or email)
- Owner confirms balance for each client (or notes discrepancies)

**Step 3: Create OPENING_BALANCE entries**

```sql
INSERT INTO client_ledger (
  cliente_id,
  movement_type='OPENING_BALANCE',
  signed_amount=owner_validated_balance,
  effective_date=cutover_date,
  created_by=SYSTEM,
  ledger_client_name=cliente.nombre
);
```

**Evidence log:** Owner reconciliation document + query results + INSERT statement executed + timestamp + sign-off.

---

## RISK 4: ORPHANED MOVIMIENTOS_CAJA REFERENCES

| Property | Value |
|---|---|
| **ID** | MR-004 |
| **Legacy source** | movimientos_caja table |
| **Issue** | Possible references to non-existent clients, suppliers, or accounts; cannot migrate without FK errors |
| **Evidence** | No documented referential integrity enforcement in legacy schema |
| **Target affected** | financial_operation classification + financial_posting account references |
| **Validation required** | Query for orphans; owner review (fix or mark as historical); cleanses data before classification |
| **Owner involvement** | Sign-off on orphan disposition |
| **Must resolve before migration?** | YES (migration will fail on FK constraint) |
| **Must resolve before schema freeze?** | NO (schema constraints are correct) |
| **Blocks Physical Schema Freeze?** | NO |

---

### Validation Procedure

**Query: Orphaned client references**

```sql
SELECT COUNT(*) FROM movimientos_caja m
WHERE tipo IN ('ingreso', 'egreso') 
AND cliente_id IS NOT NULL
AND cliente_id NOT IN (SELECT id FROM clientes);
```

**Expected:** 0 rows

**If found:** Owner review + decision (fix cliente_id or mark as un-classifiable).

---

**Query: Orphaned supplier references**

```sql
SELECT COUNT(*) FROM movimientos_caja m
WHERE tipo='gasto_proveedores' 
AND supplier_id IS NOT NULL
AND supplier_id NOT IN (SELECT id FROM (legacy suppliers list));
```

**Expected:** 0 rows

**If found:** Owner review + decision.

---

**Query: Ambiguous classification**

```sql
SELECT COUNT(*) FROM movimientos_caja m
WHERE tipo='ingreso' AND forma_pago='cheque' AND cheque_number IS NULL
-- Cheque income without cheque number cannot be classified
```

**Expected:** 0 rows (or very few explainable exceptions)

**If found:** Owner review + documentation.

---

**Evidence log:** Query results + owner notes on each orphan/ambiguity + cleaned query results + sign-off.

---

## RISK SUMMARY TABLE

| ID | Risk | Severity | Validation owner | Estimated effort | Evidence required | Blocker before cutover? |
|---|---|---|---|---|---|---|
| MR-001 | forma_pago enum conflict | MEDIUM | Tech (DBA) | 1-2 hours | Migration 045 execution log + verification query | YES |
| MR-002 | Duplicate mortandad | HIGH | Owner (Operations) | 2-8 hours | Owner review notes + cleaned query result | YES |
| MR-003 | Opening balance validation | CRITICAL | Owner (Finance) | 4-8 hours | Owner reconciliation document + query results + INSERT log | YES |
| MR-004 | Orphaned references | MEDIUM | Owner (Operations) + Tech | 2-4 hours | Query results + owner disposition + cleaned data log | YES |

---

## RESOLUTION TIMELINE

**Recommended sequence:**

1. **Day 1:** Tech resolves MR-001 (forma_pago validation; 1-2 hours)
2. **Day 1-2:** Tech queries MR-002, MR-004; owner reviews
3. **Day 2-3:** Owner sign-off on MR-002 (mortandad truth), MR-004 (orphan disposition)
4. **Day 3-4:** Finance validates opening balance (MR-003); provides reconciliation document
5. **Day 4:** All prerequisites satisfied; migration can proceed

**Total effort:** 3-4 days (mostly async owner review/sign-off time)

---

## NO SCHEMA CHANGES REQUIRED

These are **data issues**, not schema issues.

Physical Database Design V2 correctly handles:
- ✓ Unique mortandad records (UNIQUE constraint is correct)
- ✓ Opening balances (OPENING_BALANCE entry type is correct)
- ✓ Enum validation (forma_pago will be correct post-migration 045)
- ✓ Referential integrity (FK constraints will catch orphans at migration)

**Target schema is READY FOR FREEZE.**

Migration prerequisites are data-quality tasks, not architectural changes.

---

## NEXT STEPS

1. **Immediate:** Spawn data validation queries (tech)
2. **Day 1:** Owner review of MR-002, MR-004 findings
3. **Day 2-3:** Owner sign-off + data cleanup
4. **Day 4:** Finance reconciliation complete
5. **After:** Physical Database Design FINAL FREEZE → Proceed to Physical Schema Implementation

---

**END OF MIGRATION RISK REGISTER**

This document does NOT block Physical Database Design V2 Freeze.
All identified issues are pre-cutover data-quality tasks, not architectural blockers.
