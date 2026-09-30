# RLS IMPLEMENTATION SPECIFICATION V1

**STATUS:** **FROZEN** — Fase 9 (Implementation Design) closed 2026-09-24. Implementation-ready security model.  
**AMENDMENTS:** ADR-001 (`.planning/adr/ADR-001_ISSUED_INSTRUMENT_CANCELLATION.md`, ACCEPTED 2026-09-25) — issued-instrument cancellation: RPC 42 `cancel_supplier_instrument`, `financial_instrument.cancelled_date`, `chk_instrument_cancelled_coherent`. Amended passages are marked **[ADR-001]**. Nothing else changed.  
**AMENDMENTS:** ADR-007 (`.planning/adr/ADR-007_FLOCK_LIFECYCLE.md`, ACCEPTED 2026-09-29) — V1 flock lifecycle: RPC 44 `register_flock`, RPC 45 `close_flock` (ADMIN, SECURITY DEFINER; the SECURITY DEFINER set 60 → 62) and invariant 29 (no dated flock activity after `flocks.exit_date`, enforced in RPCs 18–22, 29 and 45). No schema change. Amended sections are marked **[ADR-007]**.  
**AMENDMENTS:** ADR-008 (`.planning/adr/ADR-008_PURCHASE_ATTACHMENT_STORAGE.md`, ACCEPTED 2026-09-30) — purchase attachment objects: private Storage bucket `purchase-attachments` (10 MB, PDF / JPEG / PNG / WebP) with ADMIN-only SELECT / INSERT / DELETE policies on `storage.objects` (migration 0058). No public-schema change. Amended section is marked **[ADR-008]**.  
Changes from here require an explicit ADR, as with the target architecture.  
**DATE:** 2026-09-24  
**AUTHORITY:** TARGET_ARCHITECTURE_V2_FROZEN.md Part 2 (frozen)  
**SCOPE:** all 54 tables of `POSTGRES_SCHEMA_SPEC_V1.md`

**This document is the single source of truth for policies.** `POSTGRES_SCHEMA_SPEC_V1.md` declares
only that RLS is enabled and states the intent; it contains no `CREATE POLICY`. Nothing here is
duplicated there.

---

## 1. HOW ACCESS CONTROL IS ENFORCED

Three independent mechanisms, used for three different jobs. Confusing them is what produced the
earlier contradictions, so each is stated explicitly.

| Mechanism | Job | Where |
|---|---|---|
| **Table privileges** (`GRANT`/`REVOKE`) | decides whether a role may attempt a write at all | section 4 |
| **RLS policies** | decides which *rows* a role may read (and write, where writes are allowed) | sections 5–9 |
| **SECURITY DEFINER RPCs** | perform every period-sensitive write, after validating period, role and invariants | `RPC_CONTRACTS_V1.md` |

**PostgreSQL RLS is permissive by default: multiple policies for the same command are OR-ed.**
Two consequences drive this whole document:

1. A policy such as `USING (FALSE)` or `USING (role = 'OPERATOR' AND FALSE)` grants nothing and
   **denies nothing** — it is a no-op that reads like protection. **No such policy appears in this
   document.** Absence of a policy is the denial.
2. Therefore a broad `FOR ALL` policy must never coexist with an intended restriction on the same
   table, because the `FOR ALL` branch wins. Where immutability matters, the write privilege is
   revoked instead of being "denied" by a policy.

**Consequence for immutability:** append-only tables are protected by having **no write privilege
for any application role**, not by an `UPDATE USING FALSE` policy.

---

## 2. BUSINESS ROLE RESOLUTION (SINGLE MECHANISM)

The only source of a business role is `perfiles.rol_type`, resolved from `auth.uid()`.

`auth.jwt() ->> 'role'` is **never** used for business authorization anywhere in this project: a JWT
claim is deployment configuration, is not validated against `activo`, and can be shaped by whoever
mints the token.

```sql
CREATE OR REPLACE FUNCTION current_app_role()
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public                 -- fixed; no caller-controlled resolution
AS $$
DECLARE
  v_role TEXT;
  v_uid  UUID := auth.uid();             -- derived internally; never a parameter
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED';
  END IF;

  SELECT rol_type::TEXT INTO v_role
    FROM perfiles
   WHERE id = v_uid
     AND activo = true;

  IF v_role IS NULL THEN
    RAISE EXCEPTION 'USER_NOT_FOUND_OR_INACTIVE';
  END IF;

  RETURN v_role;                         -- 'ADMIN' or 'OPERATOR', nothing else
END;
$$;

REVOKE ALL     ON FUNCTION current_app_role() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION current_app_role() TO authenticated;
```

Properties, each of which is required:
- takes **no arguments** — a caller cannot ask about another user;
- derives the user from `auth.uid()` only;
- requires `activo = true`;
- returns exactly `ADMIN` or `OPERATOR`, and raises otherwise;
- `SET search_path = public` prevents search-path hijacking;
- `SECURITY DEFINER` is required so the function can read `perfiles` while `perfiles` itself stays
  locked down;
- PUBLIC execute revoked.

### No self-escalation

A user must not be able to promote themselves by editing their own `perfiles` row. `perfiles` grants
no `UPDATE` to `authenticated` (section 4), so `rol_type` can only be changed by an ADMIN through a
privileged path. The self-read policy in section 5 is `SELECT` only.

---

## 3. SERVICE_ROLE IS NOT A BUSINESS ROLE

`SERVICE_ROLE` is a Supabase **backend privilege**, not a value of `perfiles.rol_type`. It has no row
in `perfiles`, so `current_app_role()` raises `USER_NOT_FOUND_OR_INACTIVE` for it.

**Canonical test:** `auth.role() = 'service_role'`.

`current_app_role() = 'SERVICE_ROLE'` is a contradiction — that string can never be returned — and
appears nowhere in this document. Backend access is granted only where section 9 says so (MP
ingestion/reconciliation), never to commercial or production data.

| Role | Identity source | Test in policies |
|---|---|---|
| ADMIN | `perfiles.rol_type = 'ADMIN'`, `activo = true` | `current_app_role() = 'ADMIN'` |
| OPERATOR | `perfiles.rol_type = 'OPERATOR'`, `activo = true` | `current_app_role() = 'OPERATOR'` |
| SERVICE_ROLE | Supabase service key | `auth.role() = 'service_role'` |

---

## 4. TABLE PRIVILEGES — THE WRITE PERIMETER

Applied once, before policies. This is what actually makes period-sensitive writes RPC-only.

```sql
-- Baseline: application roles may never write directly anywhere.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
GRANT  SELECT ON ALL TABLES IN SCHEMA public TO authenticated;   -- rows still filtered by RLS

-- Narrow, deliberate exceptions: master data that is not a period-sensitive fact.
GRANT INSERT, UPDATE ON clients, products, price_history, suppliers, sheds,
                        financial_account, expense_category, classification_grade,
                        projects, feed_type, feed_ingredient, genetics_consumption_curve,
                        feed_formula_version, feed_formula_line,
                        operator_assignments, purchase_attachment
      TO authenticated;                                          -- ADMIN-only via RLS policies

-- PENDING orders are edited freely (frozen Part 3); the DELIVERED transition is RPC-only.
GRANT INSERT, UPDATE ON pedidos       TO authenticated;
GRANT INSERT, DELETE ON pedido_lineas TO authenticated;          -- restricted to PENDING by RLS

-- Everything else keeps no write privilege for any application role:
-- client_ledger, collections, financial_operation, financial_posting,
-- financial_instrument, financial_instrument_event, supplier_ledger,
-- purchases, purchase_line, freight, freight_allocation,
-- population_events, daily_production, flock_weighing, temperature_record,
-- classification, classification_line, feed_manufacturing, feed_movement,
-- feed_inventory_count, flock_feed_assignment,
-- sales_session, sales_session_movement, sales_session_cash_event,
-- fiscal_document, fiscal_document_component, fiscal_obligation,
-- fiscal_obligation_installment, fiscal_payment,
-- management_period, audit_events, flocks,
-- mp_source_record, mp_financial_movement, mp_reconciliation.
-- These are written exclusively by SECURITY DEFINER RPCs.
```

**Why this is airtight rather than decorative:** the RPCs are owned by `postgres`, which holds
`BYPASSRLS`, so a SECURITY DEFINER function writes successfully while `authenticated` cannot even
attempt the statement. Period validation therefore cannot be bypassed: there is no path to those
tables that skips the RPC, and every RPC calls `ASSERT_PERIOD_OPEN` before writing.

```sql
-- RPC ownership and execution (applies to all 45 RPCs — RPC 42 by ADR-001, RPC 43 by ADR-004, RPCs 44 / 45 by ADR-007)
ALTER FUNCTION <rpc_name>(…) OWNER TO postgres;
REVOKE ALL     ON FUNCTION <rpc_name>(…) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION <rpc_name>(…) TO authenticated;   -- service_role for MP RPCs 40/41
```

---

## 5. IDENTITY, PERIODS, AUDIT

```sql
ALTER TABLE perfiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY perfiles_admin_select ON perfiles FOR SELECT
  USING (current_app_role() = 'ADMIN');

-- any authenticated user may read ONLY their own row (needed for UI bootstrapping)
CREATE POLICY perfiles_self_select ON perfiles FOR SELECT
  USING (id = auth.uid());

CREATE POLICY perfiles_admin_insert ON perfiles FOR INSERT
  WITH CHECK (current_app_role() = 'ADMIN');

CREATE POLICY perfiles_admin_update ON perfiles FOR UPDATE
  USING (current_app_role() = 'ADMIN')
  WITH CHECK (current_app_role() = 'ADMIN');
```
OPERATOR gets no policy beyond its own row, so user management is unreachable. No `UPDATE` privilege
is granted to `authenticated` for `perfiles` in section 4, so `rol_type` cannot be self-edited even
by an ADMIN-shaped JWT claim — only a real ADMIN row satisfies `current_app_role()`.

```sql
ALTER TABLE management_period ENABLE ROW LEVEL SECURITY;

CREATE POLICY management_period_read ON management_period FOR SELECT
  USING (current_app_role() IN ('ADMIN','OPERATOR'));
```
**SELECT only, deliberately.** There is no INSERT/UPDATE policy and no write privilege, so `status`
can change only through `close_management_period` / `reopen_management_period`. This is what makes
the audited closure trail unavoidable. Period rows themselves are created by the same privileged
path (a monthly `INSERT` performed by a SECURITY DEFINER maintenance function or migration).

```sql
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY audit_events_admin_select ON audit_events FOR SELECT
  USING (current_app_role() = 'ADMIN');

CREATE POLICY audit_events_operator_own ON audit_events FOR SELECT
  USING (
    current_app_role() = 'OPERATOR'
    AND performed_by = auth.uid()
    AND entity_type IN ('daily_production','population_events','classification',
                        'flock_weighing','temperature_record','feed_manufacturing',
                        'feed_inventory_count','sales_session_movement')
  );
```
No INSERT/UPDATE/DELETE policy and no privilege: audit rows are written only inside RPCs and can
never be altered afterwards.

```sql
ALTER TABLE operator_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY operator_assignments_admin_select ON operator_assignments FOR SELECT
  USING (current_app_role() = 'ADMIN');
CREATE POLICY operator_assignments_admin_insert ON operator_assignments FOR INSERT
  WITH CHECK (current_app_role() = 'ADMIN');
CREATE POLICY operator_assignments_admin_update ON operator_assignments FOR UPDATE
  USING (current_app_role() = 'ADMIN') WITH CHECK (current_app_role() = 'ADMIN');

CREATE POLICY operator_assignments_operator_own ON operator_assignments FOR SELECT
  USING (current_app_role() = 'OPERATOR' AND operator_id = auth.uid());
```

---

## 6. MASTERS

ADMIN reads and writes; OPERATOR reads only what it needs to do production work. Commercial and
cost masters stay invisible to OPERATOR.

```sql
-- sheds, feed_type, feed_ingredient, classification_grade, genetics_consumption_curve:
-- ADMIN full, OPERATOR read-only on active rows.
ALTER TABLE sheds ENABLE ROW LEVEL SECURITY;
CREATE POLICY sheds_admin_all ON sheds FOR SELECT USING (current_app_role() = 'ADMIN');
CREATE POLICY sheds_admin_insert ON sheds FOR INSERT WITH CHECK (current_app_role() = 'ADMIN');
CREATE POLICY sheds_admin_update ON sheds FOR UPDATE
  USING (current_app_role() = 'ADMIN') WITH CHECK (current_app_role() = 'ADMIN');
CREATE POLICY sheds_operator_select ON sheds FOR SELECT
  USING (current_app_role() = 'OPERATOR' AND activo = true);

-- identical shape for: feed_type, feed_ingredient, classification_grade,
-- genetics_consumption_curve   (ADMIN select/insert/update + OPERATOR select WHERE activo)
```

```sql
-- clients, products, price_history, suppliers, financial_account, expense_category, projects:
-- ADMIN only. OPERATOR receives NO policy, therefore NO access (frozen Part 2).
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
CREATE POLICY clients_admin_select ON clients FOR SELECT USING (current_app_role() = 'ADMIN');
CREATE POLICY clients_admin_insert ON clients FOR INSERT WITH CHECK (current_app_role() = 'ADMIN');
CREATE POLICY clients_admin_update ON clients FOR UPDATE
  USING (current_app_role() = 'ADMIN') WITH CHECK (current_app_role() = 'ADMIN');

-- identical shape for: products, price_history, suppliers, financial_account,
--                      expense_category, projects
```
`products` is an exception worth naming: OPERATOR needs no product catalogue in V1, since production
capture uses flocks and grades, not products. It therefore gets no policy.

```sql
ALTER TABLE flocks ENABLE ROW LEVEL SECURITY;

CREATE POLICY flocks_admin_select ON flocks FOR SELECT USING (current_app_role() = 'ADMIN');

CREATE POLICY flocks_operator_assigned ON flocks FOR SELECT
  USING (
    current_app_role() = 'OPERATOR'
    AND id IN (SELECT flock_id FROM operator_assignments
               WHERE operator_id = auth.uid() AND activo = true)
  );
```
`flocks` has no write privilege in section 4: creating or retiring a flock is an ADMIN action through
a privileged path, which keeps the one-ACTIVE-flock-per-shed index safe from races.
**[ADR-007]** That privileged path is RPC 44 `register_flock` and RPC 45 `close_flock` (ADMIN, SECURITY DEFINER).
`flocks` still has no write privilege for any API role. Closing a flock deactivates its operator assignments,
so it leaves the OPERATOR working set through the policy above.

---

## 7. COMMERCIAL, LEDGERS, TREASURY, PURCHASES — OPERATOR HAS NO ACCESS

Every table in this section grants **no policy at all** to OPERATOR. Frozen Part 2 forbids OPERATOR
access to clients, orders, sales, prices, collections, client ledger, purchases, supplier accounts,
financial accounts, costs and P&L. Absence of policy is the enforcement.

```sql
ALTER TABLE pedidos ENABLE ROW LEVEL SECURITY;

CREATE POLICY pedidos_admin_select ON pedidos FOR SELECT
  USING (current_app_role() = 'ADMIN');

CREATE POLICY pedidos_admin_insert ON pedidos FOR INSERT
  WITH CHECK (current_app_role() = 'ADMIN' AND estado = 'PENDING');

-- PENDING orders are editable; the row must stay PENDING both before and after.
-- Transitions to DELIVERED/CANCELLED are impossible here and happen only in RPCs 1–3.
CREATE POLICY pedidos_admin_update_pending ON pedidos FOR UPDATE
  USING (current_app_role() = 'ADMIN' AND estado = 'PENDING')
  WITH CHECK (current_app_role() = 'ADMIN' AND estado = 'PENDING');
```
There is exactly one UPDATE policy, so no OR-ed branch can widen it. A DELIVERED order is
untouchable: `USING` already excludes it.

```sql
ALTER TABLE pedido_lineas ENABLE ROW LEVEL SECURITY;

CREATE POLICY pedido_lineas_admin_select ON pedido_lineas FOR SELECT
  USING (current_app_role() = 'ADMIN');

-- lines may be added/removed only while the parent order is PENDING
CREATE POLICY pedido_lineas_admin_insert ON pedido_lineas FOR INSERT
  WITH CHECK (
    current_app_role() = 'ADMIN'
    AND EXISTS (SELECT 1 FROM pedidos p WHERE p.id = pedido_id AND p.estado = 'PENDING')
  );

CREATE POLICY pedido_lineas_admin_delete ON pedido_lineas FOR DELETE
  USING (
    current_app_role() = 'ADMIN'
    AND EXISTS (SELECT 1 FROM pedidos p WHERE p.id = pedido_id AND p.estado = 'PENDING')
  );
```
**No UPDATE policy and no UPDATE privilege.** Once an order is delivered its lines are frozen;
`is_current` / `version_seq` are flipped only by `rectify_delivered_order`. The snapshot columns
`precio_unitario` and `producto_nombre` are therefore immutable by construction.

```sql
-- client_ledger, collections, financial_operation, financial_posting,
-- financial_instrument, financial_instrument_event, supplier_ledger,
-- purchases, purchase_line, freight, freight_allocation:
-- ADMIN SELECT only. No write policy, no write privilege — RPC-written.

ALTER TABLE client_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY client_ledger_admin_select ON client_ledger FOR SELECT
  USING (current_app_role() = 'ADMIN');

-- identical single-policy shape for:
--   collections, financial_operation, financial_posting,
--   financial_instrument, financial_instrument_event, supplier_ledger,
--   purchases, purchase_line, freight, freight_allocation
```

```sql
ALTER TABLE purchase_attachment ENABLE ROW LEVEL SECURITY;

CREATE POLICY purchase_attachment_admin_select ON purchase_attachment FOR SELECT
  USING (current_app_role() = 'ADMIN');
CREATE POLICY purchase_attachment_admin_insert ON purchase_attachment FOR INSERT
  WITH CHECK (current_app_role() = 'ADMIN');
```
Additional attachments may be added to an existing purchase. There is no DELETE policy: the
mandatory attachment cannot be removed, so a purchase can never become attachment-less after
`register_purchase` created it with at least one.

### Purchase attachment objects (Storage) **[ADR-008]**

The objects that `purchase_attachment.storage_path` points to live in the **private** bucket
`purchase-attachments` (`public = false`, `file_size_limit` 10 MB, `allowed_mime_types` =
`application/pdf`, `image/jpeg`, `image/png`, `image/webp`). The Storage service runs object queries as the
caller's role, so these policies are the access authority (migration 0058):

```sql
-- storage.objects, TO authenticated only; nothing for anon; no UPDATE policy (no overwrite / move)
CREATE POLICY purchase_attachments_admin_select ON storage.objects FOR SELECT TO authenticated
  USING (CASE WHEN bucket_id = 'purchase-attachments' THEN public.current_app_role() = 'ADMIN' ELSE false END);
CREATE POLICY purchase_attachments_admin_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (CASE WHEN bucket_id = 'purchase-attachments'
                   THEN public.current_app_role() = 'ADMIN' AND (storage.foldername(name))[1] = auth.uid()::TEXT
                   ELSE false END);
CREATE POLICY purchase_attachments_admin_delete ON storage.objects FOR DELETE TO authenticated
  USING (CASE WHEN bucket_id = 'purchase-attachments' THEN public.current_app_role() = 'ADMIN' ELSE false END);
```

The `CASE` resolves the role only for rows of this bucket (`current_app_role()` raises for a caller without an
active profile), so no other bucket is opened or affected. Object keys are generated as
`<auth-user-id>/<uuid>.<ext>`; no public URL is used (signed URLs only). OPERATOR has no access.

---

## 8. PRODUCTION, CLASSIFICATION, FEED, FERIA — OPERATOR WORKING SET

Reads are scoped by `operator_assignments`. All writes go through RPCs 18–33.

```sql
ALTER TABLE daily_production ENABLE ROW LEVEL SECURITY;

CREATE POLICY daily_production_admin_select ON daily_production FOR SELECT
  USING (current_app_role() = 'ADMIN');

CREATE POLICY daily_production_operator_select ON daily_production FOR SELECT
  USING (
    current_app_role() = 'OPERATOR'
    AND flock_id IN (SELECT flock_id FROM operator_assignments
                     WHERE operator_id = auth.uid() AND activo = true)
  );
```
No INSERT/UPDATE/DELETE policy and no privilege → `register_daily_production` and
`rectify_daily_production` are the only writers, and both validate the period.

`rectify_daily_production` (RPC 19) is executable by OPERATOR as well as ADMIN, which is why the
ownership test lives *inside* the function rather than in a policy: an OPERATOR may rectify only a row
whose `created_by = auth.uid()` on a flock still assigned to it, while ADMIN may rectify any current
row. A policy could not express this, because the table grants no UPDATE privilege to begin with — the
SECURITY DEFINER function is the only writer, so it owns the authorization decision. This grants
OPERATOR no additional table access: reads remain scoped to assigned flocks by the policy above.

```sql
ALTER TABLE population_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY population_events_admin_select ON population_events FOR SELECT
  USING (current_app_role() = 'ADMIN');

CREATE POLICY population_events_operator_select ON population_events FOR SELECT
  USING (
    current_app_role() = 'OPERATOR'
    AND flock_id IN (SELECT flock_id FROM operator_assignments
                     WHERE operator_id = auth.uid() AND activo = true)
  );
```

```sql
ALTER TABLE flock_weighing ENABLE ROW LEVEL SECURITY;
-- same two SELECT policies as population_events (ADMIN all; OPERATOR assigned flocks)

ALTER TABLE temperature_record ENABLE ROW LEVEL SECURITY;
CREATE POLICY temperature_record_admin_select ON temperature_record FOR SELECT
  USING (current_app_role() = 'ADMIN');
CREATE POLICY temperature_record_operator_select ON temperature_record FOR SELECT
  USING (
    current_app_role() = 'OPERATOR'
    AND shed_id IN (SELECT f.shed_id FROM flocks f
                    JOIN operator_assignments oa ON oa.flock_id = f.id
                    WHERE oa.operator_id = auth.uid() AND oa.activo = true)
  );
```

```sql
ALTER TABLE classification ENABLE ROW LEVEL SECURITY;

CREATE POLICY classification_admin_select ON classification FOR SELECT
  USING (current_app_role() = 'ADMIN');

CREATE POLICY classification_operator_select ON classification FOR SELECT
  USING (current_app_role() = 'OPERATOR' AND created_by = auth.uid());

ALTER TABLE classification_line ENABLE ROW LEVEL SECURITY;

CREATE POLICY classification_line_admin_select ON classification_line FOR SELECT
  USING (current_app_role() = 'ADMIN');

CREATE POLICY classification_line_operator_select ON classification_line FOR SELECT
  USING (
    current_app_role() = 'OPERATOR'
    AND classification_id IN (SELECT id FROM classification WHERE created_by = auth.uid())
  );
```
**Resolved contradiction:** an earlier revision granted OPERATOR a direct `INSERT` on
`classification` while `register_classification` also existed. Classification is period-sensitive,
so the direct INSERT is gone — there is no INSERT policy and no privilege. RPC 25 is the only writer.

```sql
-- feed_manufacturing, feed_movement, feed_inventory_count, flock_feed_assignment:
-- RPC-written (RPCs 26–29). Reads differ because cost visibility differs.

ALTER TABLE feed_manufacturing ENABLE ROW LEVEL SECURITY;
CREATE POLICY feed_manufacturing_admin_select ON feed_manufacturing FOR SELECT
  USING (current_app_role() = 'ADMIN');
CREATE POLICY feed_manufacturing_operator_select ON feed_manufacturing FOR SELECT
  USING (current_app_role() = 'OPERATOR');          -- operational facts only; no cost columns exist here

ALTER TABLE feed_inventory_count ENABLE ROW LEVEL SECURITY;
CREATE POLICY feed_inventory_count_admin_select ON feed_inventory_count FOR SELECT
  USING (current_app_role() = 'ADMIN');
CREATE POLICY feed_inventory_count_operator_select ON feed_inventory_count FOR SELECT
  USING (current_app_role() = 'OPERATOR');          -- operators perform the physical counts

ALTER TABLE feed_movement ENABLE ROW LEVEL SECURITY;
CREATE POLICY feed_movement_admin_select ON feed_movement FOR SELECT
  USING (current_app_role() = 'ADMIN');

ALTER TABLE flock_feed_assignment ENABLE ROW LEVEL SECURITY;
CREATE POLICY flock_feed_assignment_admin_select ON flock_feed_assignment FOR SELECT
  USING (current_app_role() = 'ADMIN');
CREATE POLICY flock_feed_assignment_operator_select ON flock_feed_assignment FOR SELECT
  USING (
    current_app_role() = 'OPERATOR'
    AND flock_id IN (SELECT flock_id FROM operator_assignments
                     WHERE operator_id = auth.uid() AND activo = true)
  );
```

### Cost protection (three layers)

```sql
ALTER TABLE feed_formula_version ENABLE ROW LEVEL SECURITY;
CREATE POLICY feed_formula_version_admin_select ON feed_formula_version FOR SELECT
  USING (current_app_role() = 'ADMIN');
CREATE POLICY feed_formula_version_admin_insert ON feed_formula_version FOR INSERT
  WITH CHECK (current_app_role() = 'ADMIN');
CREATE POLICY feed_formula_version_operator_select ON feed_formula_version FOR SELECT
  USING (
    current_app_role() = 'OPERATOR'
    AND effective_from <= CURRENT_DATE
    AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
  );

ALTER TABLE feed_formula_line ENABLE ROW LEVEL SECURITY;
-- ADMIN only: this table carries unit_cost_snapshot. OPERATOR gets NO policy.
CREATE POLICY feed_formula_line_admin_select ON feed_formula_line FOR SELECT
  USING (current_app_role() = 'ADMIN');
CREATE POLICY feed_formula_line_admin_insert ON feed_formula_line FOR INSERT
  WITH CHECK (current_app_role() = 'ADMIN');
```
Layer 1 — cost lives in `feed_formula_line.unit_cost_snapshot`, a table OPERATOR cannot read.
Layer 2 — a safe view exposes composition without cost:

```sql
CREATE VIEW feed_formula_line_safe
WITH (security_invoker = false)          -- runs as the view owner, bypassing the base-table policy
AS
  SELECT ffl.formula_version_id,
         ffl.ingredient_id,
         fi.nombre AS ingredient_name,
         ffl.quantity_kg
    FROM feed_formula_line ffl
    JOIN feed_ingredient   fi ON fi.id = ffl.ingredient_id;
-- unit_cost_snapshot is deliberately absent from the projection

ALTER VIEW feed_formula_line_safe OWNER TO postgres;
REVOKE ALL  ON feed_formula_line_safe FROM PUBLIC;
GRANT SELECT ON feed_formula_line_safe TO authenticated;
```
`security_invoker = false` is required: with invoker semantics the view would re-apply the ADMIN-only
base policy and return nothing to OPERATOR. Ownership by `postgres` plus a cost-free projection is
what makes the view safe rather than a leak.
Layer 3 — no write privilege on either table for any application role.

### Feria

```sql
ALTER TABLE sales_session ENABLE ROW LEVEL SECURITY;
CREATE POLICY sales_session_admin_select ON sales_session FOR SELECT
  USING (current_app_role() = 'ADMIN');
CREATE POLICY sales_session_operator_select ON sales_session FOR SELECT
  USING (current_app_role() = 'OPERATOR' AND estado = 'OPEN');

ALTER TABLE sales_session_movement ENABLE ROW LEVEL SECURITY;
CREATE POLICY sales_session_movement_admin_select ON sales_session_movement FOR SELECT
  USING (current_app_role() = 'ADMIN');
CREATE POLICY sales_session_movement_operator_select ON sales_session_movement FOR SELECT
  USING (
    current_app_role() = 'OPERATOR'
    AND sales_session_id IN (SELECT id FROM sales_session WHERE estado = 'OPEN')
  );

ALTER TABLE sales_session_cash_event ENABLE ROW LEVEL SECURITY;
-- cash is financial: ADMIN only.
CREATE POLICY sales_session_cash_event_admin_select ON sales_session_cash_event FOR SELECT
  USING (current_app_role() = 'ADMIN');
```
OPERATOR may record physical movements in an open session (through RPC 31) and see them, but never
the session's cash events.

---

## 9. FISCAL AND MERCADO PAGO

```sql
-- fiscal_document, fiscal_document_component, fiscal_obligation,
-- fiscal_obligation_installment, fiscal_payment: ADMIN SELECT only; RPC-written (34–36).

ALTER TABLE fiscal_document ENABLE ROW LEVEL SECURITY;
CREATE POLICY fiscal_document_admin_select ON fiscal_document FOR SELECT
  USING (current_app_role() = 'ADMIN');

-- identical single-policy shape for: fiscal_document_component, fiscal_obligation,
--                                    fiscal_obligation_installment, fiscal_payment
```

```sql
ALTER TABLE mp_source_record ENABLE ROW LEVEL SECURITY;

-- backend ingestion: INSERT only. No UPDATE policy: metadata changes go through RPCs 40/41.
CREATE POLICY mp_source_service_insert ON mp_source_record FOR INSERT
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY mp_source_service_select ON mp_source_record FOR SELECT
  USING (auth.role() = 'service_role');

-- ADMIN may audit raw MP data read-only
CREATE POLICY mp_source_admin_select ON mp_source_record FOR SELECT
  USING (current_app_role() = 'ADMIN');
```

**MP immutability, stated without contradiction:**

| Columns | Status | Who may change them |
|---|---|---|
| `source_type, external_id, event_data, occurred_at, occurred_date, ingested_at` | **raw — immutable forever** | nobody; the `trg_mp_source_raw_guard` trigger raises on any change |
| `processing_status, processed_at, processing_note` | **controlled mutable metadata** | only `mp_normalize_source` / `mp_reconcile_movement` (SECURITY DEFINER, owner `postgres`) |

There is deliberately **no** `UPDATE USING FALSE` policy here: that would be a no-op, and it would
also contradict the fact that `processing_status` must advance. Instead no application or service
role holds `UPDATE`, and the trigger protects the raw columns even against the privileged path. The
earlier "UPDATE DENY plus mutable processing_status" contradiction is resolved by this split.

```sql
ALTER TABLE mp_financial_movement ENABLE ROW LEVEL SECURITY;
CREATE POLICY mp_movement_service_select ON mp_financial_movement FOR SELECT
  USING (auth.role() = 'service_role');
CREATE POLICY mp_movement_admin_select ON mp_financial_movement FOR SELECT
  USING (current_app_role() = 'ADMIN');

ALTER TABLE mp_reconciliation ENABLE ROW LEVEL SECURITY;
CREATE POLICY mp_reconciliation_service_select ON mp_reconciliation FOR SELECT
  USING (auth.role() = 'service_role');
CREATE POLICY mp_reconciliation_admin_select ON mp_reconciliation FOR SELECT
  USING (current_app_role() = 'ADMIN');
```
SERVICE_ROLE reaches MP tables and the RPCs that bridge them to `financial_operation` /
`financial_posting`. It gets no policy on clients, orders, ledgers or production.

---

## 10. COVERAGE MATRIX (ALL 54 TABLES)

`—` means no policy, which means no access for that role.

| Table | ADMIN | OPERATOR | SERVICE_ROLE | Writes |
|---|---|---|---|---|
| perfiles | S,I,U | own row S | — | ADMIN (privileged) |
| management_period | S | S | — | RPC 37/38 only |
| audit_events | S | own S | — | RPC only |
| operator_assignments | S,I,U | own S | — | ADMIN |
| sheds | S,I,U | S active | — | ADMIN |
| clients | S,I,U | — | — | ADMIN |
| products | S,I,U | — | — | ADMIN |
| price_history | S,I,U | — | — | ADMIN |
| suppliers | S,I,U | — | — | ADMIN |
| financial_account | S,I,U | — | — | ADMIN |
| expense_category | S,I,U | — | — | ADMIN |
| classification_grade | S,I,U | S active | — | ADMIN |
| projects | S,I,U | — | — | ADMIN |
| feed_type | S,I,U | S active | — | ADMIN |
| feed_ingredient | S,I,U | S active | — | ADMIN |
| genetics_consumption_curve | S,I,U | S | — | ADMIN |
| pedidos | S,I,U(PENDING) | — | — | ADMIN while PENDING; RPC 1–3 for transitions |
| pedido_lineas | S,I,D(PENDING) | — | — | ADMIN while PENDING; RPC 2 for versions |
| client_ledger | S | — | — | RPC only |
| collections | S | — | — | RPC 4 only |
| financial_operation | S | — | — | RPC only |
| financial_posting | S | — | — | RPC only |
| financial_instrument | S | — | — | RPC 5–12, 42 only **[ADR-001]** |
| financial_instrument_event | S | — | — | RPC 5–12, 42 only **[ADR-001]** |
| supplier_ledger | S | — | — | RPC only (incl. 8, 9, 10, 12, 42 **[ADR-001]**) |
| purchases | S | — | — | RPC 13/14 only |
| purchase_line | S | — | — | RPC 13/14 only |
| purchase_attachment | S,I | — | — | RPC 13 + ADMIN adds |
| freight | S | — | — | RPC 16 only |
| freight_allocation | S | — | — | RPC 17 only |
| flocks | S | S assigned | — | RPC 44 / 45 only **[ADR-007]** |
| population_events | S | S assigned | — | RPC 20–22 only |
| daily_production | S | S assigned | — | RPC 18/19 only |
| flock_weighing | S | S assigned | — | RPC 23 only |
| temperature_record | S | S assigned sheds | — | RPC 24 only |
| classification | S | own S | — | RPC 25 only |
| classification_line | S | own S | — | RPC 25 only |
| feed_formula_version | S,I | S effective | — | ADMIN |
| feed_formula_line | S,I | — (safe view) | — | ADMIN |
| feed_manufacturing | S | S | — | RPC 26 only |
| feed_movement | S | — | — | RPC 28 only |
| feed_inventory_count | S | S | — | RPC 27 only |
| flock_feed_assignment | S | S assigned | — | RPC 29 only |
| sales_session | S | S open | — | RPC 30/33 only |
| sales_session_movement | S | S open | — | RPC 31 only |
| sales_session_cash_event | S | — | — | RPC 32 only |
| fiscal_document | S | — | — | RPC 34 only |
| fiscal_document_component | S | — | — | RPC 34 only |
| fiscal_obligation | S | — | — | RPC 35/36 only |
| fiscal_obligation_installment | S | — | — | RPC 35 only |
| fiscal_payment | S | — | — | RPC 36 only |
| mp_source_record | S | — | S,I | RPC 40/41 for metadata; raw immutable |
| mp_financial_movement | S | — | S | RPC 40 only |
| mp_reconciliation | S | — | S | RPC 41 only |

54 rows. S = SELECT, I = INSERT, U = UPDATE, D = DELETE.

---

## 11. VERIFICATION

Mechanical checks to run after deployment.

```sql
-- 1. RLS enabled everywhere (expect 0 rows)
SELECT tablename FROM pg_tables
 WHERE schemaname = 'public' AND rowsecurity = false;

-- 2. No business authorization via JWT claims (expect 0 rows)
SELECT polname, tablename FROM pg_policies
 WHERE schemaname = 'public'
   AND (qual LIKE '%jwt()%' OR with_check LIKE '%jwt()%');

-- 3. No impossible SERVICE_ROLE business-role test (expect 0 rows)
SELECT polname, tablename FROM pg_policies
 WHERE schemaname = 'public'
   AND (qual LIKE '%current_app_role() = ''SERVICE_ROLE''%'
     OR with_check LIKE '%current_app_role() = ''SERVICE_ROLE''%');

-- 4. No no-op deny policies (expect 0 rows)
SELECT polname, tablename FROM pg_policies
 WHERE schemaname = 'public'
   AND (qual ILIKE '%and false%' OR qual = 'false' OR with_check = 'false');

-- 5. No period-sensitive FACT table is directly writable by an application role (expect 0 rows)
--
--    Guarantee verified: a table that can create or alter an economic, financial, productive,
--    fiscal or cost fact holds no INSERT/UPDATE/DELETE privilege for 'authenticated' or 'anon';
--    it is written only by a SECURITY DEFINER RPC that calls ASSERT_PERIOD_OPEN first.
--
--    `pedidos` is an EXPLICIT, DELIBERATE EXCEPTION and is therefore absent from the list below.
--    Frozen Part 3 makes PENDING orders freely editable, so §4 grants INSERT, UPDATE ON pedidos
--    to authenticated on purpose. That grant is contained and creates no fact:
--      · policy pedidos_admin_update_pending requires estado='PENDING' in USING and in WITH CHECK,
--        so a row cannot transition to DELIVERED by direct DML — only deliver_order (RPC 1) can;
--      · a PENDING order is not a sale (frozen Part 3), so it is not yet an economic fact;
--      · no client_ledger row can be written directly — that table has no write privilege at all,
--        so no economic consequence is produced in any period;
--      · deliver_order recomputes delivered_date from its own p_delivered_at parameter, calls
--        ASSERT_PERIOD_OPEN on that value, and overwrites both delivered_at and delivered_date,
--        so any value written directly while PENDING cannot steer the period of the eventual sale.
--    Consequence: while PENDING, pedidos.delivered_date may hold an arbitrary value with no
--    economic effect. Check 5 does not claim otherwise. The order becomes a period-sensitive fact
--    only at delivery, and that transition is RPC-only.
--
SELECT table_name, privilege_type FROM information_schema.role_table_grants
 WHERE grantee IN ('authenticated','anon')
   AND privilege_type IN ('INSERT','UPDATE','DELETE')
   AND table_name IN ('client_ledger','collections','financial_operation','financial_posting',
                      'financial_instrument','financial_instrument_event','supplier_ledger',
                      'purchases','purchase_line','freight','freight_allocation',
                      'population_events','daily_production','flock_weighing',
                      'temperature_record','classification','classification_line',
                      'feed_manufacturing','feed_movement','feed_inventory_count',
                      'flock_feed_assignment','sales_session','sales_session_movement',
                      'sales_session_cash_event','fiscal_document','fiscal_document_component',
                      'fiscal_obligation','fiscal_obligation_installment','fiscal_payment',
                      'management_period','audit_events','flocks',
                      'mp_source_record','mp_financial_movement','mp_reconciliation');

-- 5b. The pedidos exception stays contained: exactly one UPDATE policy, and it pins estado
--     to 'PENDING' on both sides (expect 1 row, with both quals containing estado = 'PENDING')
SELECT polname, cmd, qual, with_check FROM pg_policies
 WHERE schemaname = 'public' AND tablename = 'pedidos' AND cmd = 'UPDATE';

-- 6. Every SECURITY DEFINER function pins its search_path (expect 0 rows)
--
--    Scope: the SECURITY DEFINER inventory is exactly current_app_role() plus the 45 RPCs [ADR-001] [ADR-004] [ADR-007].
--    mp_source_raw_guard() is deliberately NOT in it — it is SECURITY INVOKER (see 6b), so it is
--    correctly excluded by the prosecdef filter rather than by an exception clause.
SELECT proname FROM pg_proc
 WHERE prosecdef = true
   AND pronamespace = 'public'::regnamespace
   AND NOT (COALESCE(proconfig, '{}') @> ARRAY['search_path=public']);

-- 6b. The SECURITY DEFINER inventory contains only what it should (expect exactly 46:
--     current_app_role + 45 RPCs [ADR-001] [ADR-004] [ADR-007]; mp_source_raw_guard and assert_flock_activity_date must NOT appear)
SELECT proname FROM pg_proc
 WHERE prosecdef = true AND pronamespace = 'public'::regnamespace
 ORDER BY proname;

-- 7. No SECURITY DEFINER function is executable by PUBLIC (expect 0 rows)
SELECT p.proname FROM pg_proc p
 WHERE p.prosecdef = true
   AND p.pronamespace = 'public'::regnamespace
   AND has_function_privilege('public', p.oid, 'EXECUTE');

-- 8. MP raw-guard trigger exists (expect 1 row)
SELECT tgname FROM pg_trigger WHERE tgname = 'trg_mp_source_raw_guard';
```

### Behavioural tests

**As OPERATOR** (a `perfiles` row with `rol_type='OPERATOR'`, `activo=true`, assigned to flock F):
```sql
SELECT * FROM daily_production;                     -- returns rows for flock F only
SELECT * FROM feed_formula_line_safe;               -- composition, no cost column
SELECT current_app_role();                          -- 'OPERATOR'

INSERT INTO daily_production (…);                   -- FAILS: no privilege (use RPC 18)
SELECT * FROM clients;                              -- returns 0 rows (no policy)
SELECT * FROM financial_posting;                    -- returns 0 rows (no policy)
SELECT * FROM feed_formula_line;                    -- returns 0 rows (cost hidden)
UPDATE perfiles SET rol_type='ADMIN' WHERE id=auth.uid();  -- FAILS: no privilege
SELECT rpc.register_daily_production(F, '2026-09-24', 1200);  -- SUCCEEDS if period OPEN
SELECT rpc.register_daily_production(F, '2026-01-15', 1200);  -- FAILS PERIOD_CLOSED if closed
```
The third-from-last line is the corrected expectation: an earlier revision documented a direct
`INSERT INTO daily_production` as succeeding, which contradicted RPC-only enforcement.

**As ADMIN:**
```sql
SELECT * FROM clients;                              -- all rows
UPDATE pedidos SET numero_pedido = 5 WHERE estado='PENDING';   -- SUCCEEDS
UPDATE pedidos SET estado='DELIVERED' WHERE id=…;              -- FAILS (policy excludes it)
INSERT INTO client_ledger (…);                                 -- FAILS: no privilege
UPDATE management_period SET status='CLOSED' WHERE id=…;        -- FAILS: no privilege
SELECT close_management_period(…);                             -- SUCCEEDS, and is audited
```

**As SERVICE_ROLE:**
```sql
INSERT INTO mp_source_record (…);                   -- SUCCEEDS
SELECT mp_normalize_source(…);                      -- SUCCEEDS
UPDATE mp_source_record SET event_data='{}';        -- FAILS: no privilege (and trigger would block)
SELECT * FROM clients;                              -- returns 0 rows (no policy)
SELECT current_app_role();                          -- RAISES USER_NOT_FOUND_OR_INACTIVE
```
The last line is the point of section 3: SERVICE_ROLE has no business role, by design.

---

## 12. SECURITY PROPERTIES

- One business-role mechanism: `perfiles.rol_type` via `current_app_role()`. Zero JWT-claim
  authorization.
- SERVICE_ROLE is a backend privilege tested with `auth.role()`, never a business role.
- Period bypass is impossible: application roles hold no write privilege on any period-sensitive
  table, and all 38 period-sensitive RPCs call `ASSERT_PERIOD_OPEN` before writing.
- Immutability comes from absent privileges, not from no-op `USING FALSE` policies.
- Cost data is unreachable by OPERATOR: separate column, ADMIN-only table, cost-free safe view.
- No self-escalation: `perfiles` is not writable by `authenticated`.
- SECURITY DEFINER is required and used deliberately, and only where elevation is actually needed:
  `current_app_role()` and the 45 RPCs **[ADR-001]** **[ADR-004]** **[ADR-007]**. Each pins `search_path`, derives the actor internally, and
  revokes PUBLIC execute. `mp_source_raw_guard()` is **not** in that inventory: it stays
  SECURITY INVOKER because it only compares `OLD` against `NEW` and needs to cross neither RLS nor
  any privilege, so making it SECURITY DEFINER would add privilege for nothing. Its protection of the
  raw MP columns is unchanged — the trigger fires regardless of the caller's role.
- Audit is unforgeable: `audit_events` has no write policy and no privilege for any role.

---

**STATUS: FROZEN — SECURITY MODEL SPECIFIED FOR 54 TABLES**
