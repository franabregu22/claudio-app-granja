# PHASE 14 — COMMERCIAL (SLICE 1)

**STATUS:** COMPLETE, from mechanical evidence (§18, §19). MASTER_ROADMAP.md was not changed; Phase 14 stays **CURRENT** there until the external review.
**DATE:** 2026-09-25
**ENVIRONMENT:** local Supabase only (`127.0.0.1:54322`, container `supabase_db_Claudio_app_Granja`, PostgreSQL 17.6)
**AUTHORITIES:** MASTER_ROADMAP.md (sequence), POSTGRES_SCHEMA_SPEC_V1, RPC_CONTRACTS_V1, RLS_IMPLEMENTATION_SPEC_V1, DATABASE_INVARIANTS_V1, IMPLEMENTATION_DEPENDENCY_ORDER_V1 (all FROZEN, none modified)

---

## 1. Scope implemented

The commercial vertical slice, end to end:

`CLIENT → PEDIDO → PEDIDO_LINEAS (snapshot) → DELIVERY → CLIENT_LEDGER → COLLECTION → FINANCIAL_OPERATION → FINANCIAL_POSTING → FINANCIAL_ACCOUNT`

- **New tables (6):** `pedidos`, `pedido_lineas`, `client_ledger`, `collections`, `financial_operation`, `financial_posting`.
- **New RPCs (4):** 1 `deliver_order`, 2 `rectify_delivered_order`, 3 `cancel_order`, 4 `register_collection`.
- **Reused Foundation objects (not duplicated):** `clients`, `products`, `price_history`, `financial_account`, `management_period`, `audit_events`, `perfiles`, `current_app_role()`, `assert_period_open()`.

Deliberately **not** created: a sales table (the sale is the delivered Pedido), `pedido_audit_events`, any stored client or account balance, double-entry accounting, allocation of collections to orders, purchase orders, instrument structures (Phase 16), and UI.

## 2. Migrations created

| Version | File | Content | sha256 |
|---|---|---|---|
| 0010 | `0010_commercial_tables.sql` | 6 tables, constraints, exclusion, 11 indexes | `36dc525d…c16e` |
| 0011 | `0011_commercial_rpcs.sql` | RPCs 1–4, ownership, EXECUTE perimeter | `21bada03…8fdb` |
| 0012 | `0012_commercial_privileges_rls.sql` | privilege reset + frozen grants, 10 policies | `6bc23728…935e` |
| 0013 | `0013_foundation_privilege_hardening.sql` | pre-closure fix: Foundation ACL reset + `postgres` default privileges in `public` hardened (see §9a) | `0f864256…63ac` |

- **Ordering:** tables, then functions, then privileges and policies. This follows the FK graph and the frozen rule that no policy is attached before `current_app_role()` exists (it exists since 0006).
- **Untouched:** 0001–0009 are unmodified; their checksums are verified by the runner on every run. The legacy `supabase/migrations/` directory is untouched.
- **Runner:** all three files were applied with `scripts/target-db/apply.mjs`, whose guarantees were not changed.

## 3. Tables / constraints / indexes

The DDL is materialised exactly as in POSTGRES_SCHEMA_SPEC_V1, with one technical stand-in described in §16.

- **Tables and RLS:** 6 tables exist, and RLS is enabled on all 6 (tests A1, A2).
- **Exclusion constraint:** `excl_pedido_lineas_single_current_version` is `EXCLUDE USING gist (pedido_id WITH =, version_seq WITH <>) WHERE (is_current)` (A3). It relies on `btree_gist` from 0001.
- **CHECK constraints (11, test A4):**
  - `chk_pedidos_delivered_coherent`
  - `chk_pedidos_cancelled_coherent`
  - `chk_collections_no_cheque`
  - `chk_collections_account_required`
  - `cantidad > 0`
  - `precio_unitario >= 0`
  - `client_ledger.signed_amount <> 0`
  - `financial_posting.signed_amount <> 0`
  - `collections.amount > 0`
  - the 2 deferred-FK stand-ins (§16)
- **Foreign keys:** exactly the 16 frozen FKs, all `ON DELETE RESTRICT` (A5, A6).
- **Indexes (11, A7):**
  - `idx_pedidos_cliente`, `idx_pedidos_delivered_date` (partial), `idx_pedidos_session` (partial)
  - `idx_pedido_lineas_current` (partial, **non-unique**, A8), `idx_pedido_lineas_version`
  - `idx_client_ledger_cliente_date`, `idx_client_ledger_source`
  - `idx_collections_cliente_date`
  - `idx_financial_operation_date`
  - `idx_financial_posting_account_date`, `idx_financial_posting_operation`
- **UNIQUE:** `pedidos.numero_pedido`, `collections.receipt_id`, `financial_operation.external_ref` (A9).
- **Subtotal:** `pedido_lineas.subtotal` is `GENERATED ALWAYS AS (cantidad * precio_unitario) STORED` (A10).

## 4. RPCs implemented

Each RPC transcribes the RPC_CONTRACTS_V1 pseudocode to PL/pgSQL in the same order, raises the same error codes and returns the same shape.

| RPC | Period determinant | client_ledger | Money | Audit |
|---|---|---|---|---|
| `deliver_order` | `delivered_date` (BA date of `p_delivered_at`) | `+total` SALE_DELIVERY | none | DELIVER |
| `rectify_delivered_order` | original `delivered_date` | `−current_total` REVERSAL, then `+new_total` SALE_DELIVERY (`reversal_of_id`) | none | RECTIFY_DELIVERED_ORDER |
| `cancel_order` | none (PENDING only) | none | none | CANCEL |
| `register_collection` | `effective_date` | `−amount` COLLECTION | 1 COLLECTION operation + 1 `+amount` posting | CREATE (collections) |

**Technical completions** (the contract behaviour is unchanged; each one is tested):

- `deliver_order` enforces the contract's stated validation "client `activo=true`". The pseudocode lists this validation but gives no error code, so the RPC raises the existing code `CLIENT_NOT_FOUND_OR_INACTIVE` (C12).
- `rectify_delivered_order` treats a NULL or non-array `p_new_lines` as `EMPTY_LINE_SET`. Otherwise `jsonb_array_length(NULL)` would be NULL and the check would silently pass.
- In `rectify_delivered_order`, NULL `cantidad`, `precio_unitario` or `producto_id` raise the corresponding contract error (D14).
- `register_collection` treats a NULL `p_amount` as `INVALID_AMOUNT`.

## 5. Pedido / versioning semantics

- **Sale semantics:**
  - PENDING is not a sale. DELIVERED is the sale. CANCELLED is not a sale.
  - There is no `monto_total`. The order total is always `SUM(subtotal) WHERE is_current` (C3, D12).
- **Snapshot:** each line snapshots `precio_unitario` and `producto_nombre`. A later price change or product rename does not alter the line (B3, B4). The delivered total uses the snapshot 1250.50, not the later 1400 (C3). No role holds UPDATE on `pedido_lineas` (B10).
- **Rectification order:** validate the full set, **retire** the current version, **then** insert version N+1, then advance `rectification_seq`.
- **Exclusion constraint:**
  - Rejects a second current version even for the table owner (D4) and rejects re-activating an old version (D5).
  - Allows N current lines within one version (D3: 3 current lines of version 1).
- **History is never lost:**
  - Retired rows keep their snapshot fields (D2).
  - After three passes, order B holds 7 lines across 4 versions with 1 current (D13).
  - Scenario S2 shows v0 with 3 retired lines, v1 with 2 retired lines, and v2 with 1 current line.

## 6. Client ledger semantics

- **Model:** a signed, append-only ledger. `+` raises client debt and `−` lowers it. The balance is `SUM(signed_amount)` and nothing is stored (G1, G4).
- **Entries per operation:**
  - Delivery writes exactly one `SALE_DELIVERY +total` at `delivered_date`, with a `ledger_client_name` snapshot, source `pedido`, and the actor (C4).
  - Rectification always reverses the **current** version:
    - pass 1: −20606
    - pass 2: −19105 (not −20606)
    - pass 3: −8000
  - After rectification the ledger nets to the current total (D6, D7, D11, D12, S2.3).
- **Global account:** the client account is global. There is no allocation of collections to orders (F11: `collections` has no pedido column). Prepayment is allowed: collecting 9000 on a 5000 debt leaves a −4000.00 credit (F12).
- **Writers:** only the RPCs write to the ledger. UPDATE, DELETE and TRUNCATE are denied (H6, H11).

## 7. Collection / financial semantics

- **What a collection writes:** one `collections` row, a `COLLECTION −amount` ledger entry, one `COLLECTION` `financial_operation` (`external_ref = receipt_id`, source `collections`), and exactly one `+amount` posting on the receiving account (F8, F9).
- **Methods:**
  - CASH moves Caja chica (F1, F2).
  - TRANSFER moves BNA (F3, F4).
  - MERCADOPAGO moves the Mercado Pago account by the **gross** amount, with no netting (F5, F6). An account not involved in a collection is untouched (F7).
  - CHEQUE is rejected with `USE_RECEIVE_CHEQUE`. It is owned by `receive_cheque` (Phase 16), and the schema also blocks it through `chk_collections_no_cheque`.
- **Not double-entry:** there is no zero-sum rule and no Accounts Receivable posting. The account balance is `SUM(financial_posting.signed_amount)` (G3).
- **No money from deliveries:** every posting in the database belongs to a collection. Postings equal collections in both count and sum (L5, S1.10).

## 8. Period control

Every period-sensitive RPC calls the Foundation guard `public.assert_period_open(business_date)` before its first write.

- **Blocked with PERIOD_CLOSED:**
  - delivery (C9)
  - rectification, using the original delivery date (D16)
  - collection (F13)
- **Atomicity:** each rejection leaves the global state fingerprint unchanged (C10, D17, F14).
- **`created_at` never decides the period:**
  - An order created in CLOSED March and delivered in OPEN April is accepted (K1).
  - An order created now and delivered in CLOSED March is rejected (K2).
- **Buenos Aires timezone:**
  - `2026-04-01 02:00 UTC` is BA date 2026-03-31, so it is rejected (K3).
  - `03:30 UTC` is BA date 2026-04-01, so it is accepted (K4).
  - `2026-04-10 23:30 -03` is recorded as 2026-04-10 (C2).
- **Other checks:**
  - A date with no period raises `PERIOD_NOT_FOUND` (C11).
  - Once a period is reopened, the guard accepts writes again (K6).
  - `cancel_order` has no period determinant under the contract, so it is allowed with a date in a CLOSED month (E7).

## 9. RLS / privilege perimeter

**Why 0012 resets privileges first:** Supabase's default privileges for tables that `postgres` creates in `public` give anon, authenticated and service_role `TRUNCATE, REFERENCES, TRIGGER, MAINTAIN`, plus sequence UPDATE. The Phase 13 baseline only covered tables that existed at that time. TRUNCATE is not subject to RLS. For that reason 0012 first runs `REVOKE ALL … FROM PUBLIC, anon, authenticated, service_role` on the 6 tables and 3 sequences, then grants exactly the frozen set.

**Resulting ACLs (verified):**

| Table | authenticated |
|---|---|
| `client_ledger`, `collections`, `financial_operation`, `financial_posting` | `SELECT` |
| `pedidos` | `SELECT, INSERT, UPDATE` |
| `pedido_lineas` | `SELECT, INSERT, DELETE` |

anon and service_role hold nothing on any of the 6 tables.

**Policies (10, exactly RLS spec §7):**

- `pedidos`: `admin_select`, `admin_insert` (PENDING only), `admin_update_pending` (PENDING before and after).
- `pedido_lineas`: `admin_select`, `admin_insert` and `admin_delete`, only while the parent is PENDING.
- ADMIN SELECT only on `client_ledger`, `collections`, `financial_operation`, `financial_posting`.
- No policy grants OPERATOR anything, and there is no `USING (FALSE)` policy.

**Behaviour proven:**

- OPERATOR reads 0 rows from each of the 8 tables `clients`, `pedidos`, `pedido_lineas`, `client_ledger`, `collections`, `financial_operation`, `financial_posting`, `financial_account` (H1).
- OPERATOR cannot write (H2–H4) and gets `FORBIDDEN` from all 4 RPCs (H5).
- ADMIN cannot insert directly into the ledger, operations, postings or collections (H6–H8).
- ADMIN cannot directly alter a delivered sale or delete its lines; these statements match 0 rows (H9, H10).
- ADMIN cannot directly insert a DELIVERED order or move PENDING to DELIVERED (B8, B9).
- A CANCELLED order cannot be revived (E8).
- Ledger UPDATE, DELETE and TRUNCATE are denied (H11).
- Inactive and missing profiles gain no authority (H12, H13). A forged JWT role claim grants nothing (H14).
- anon has no SELECT and no EXECUTE (H15).
- service_role has no privilege on these tables (H16).

## 9a. Foundation privilege finding — RESOLVED by 0013

During the Phase 14 build and external review, a gap was found in the Foundation objects from before 0012. They still held Supabase's default privileges:

| Role | Leftover privileges |
|---|---|
| `authenticated` | `REFERENCES, TRIGGER, MAINTAIN` on the 17 Foundation tables |
| `service_role` | `TRUNCATE, REFERENCES, TRIGGER, MAINTAIN` on the 17 Foundation tables |
| `service_role` | `UPDATE` on the 2 Foundation sequences |

The `postgres` default privileges in `public` would also have given every future table and sequence the same broad grants.

**Migration `0013_foundation_privilege_hardening.sql`** fixes this without editing 0001–0012 and without changing any RLS policy:

- **Tables:** resets the 17 Foundation tables for PUBLIC, anon, authenticated and service_role, then rebuilds exactly the frozen grants:
  - `authenticated`: SELECT on all 17, plus INSERT/UPDATE on the 13 masters;
  - `service_role`: SELECT on `financial_account` only;
  - `anon`: nothing.
- **Sequences:** revokes everything on the 2 Foundation sequences.
- **Default privileges:** removes the application-role grants from the `postgres` default privileges in `public`, for both tables and sequences. New objects are born owner-only, and every later phase grants its frozen set explicitly.
- **Not touched:** the `supabase_admin` and `storage` default ACLs (Supabase internals) and every role definition.

**Evidence** is in `foundations.test.mjs` group 15 (15 assertions over the real catalog ACLs):

- authenticated has an exact ACL map with no TRUNCATE, REFERENCES, TRIGGER, MAINTAIN or DELETE;
- anon and PUBLIC have no privileges;
- service_role holds exactly `financial_account:SELECT` and is refused on `clients` and on every write or TRUNCATE;
- no sequence grants anything to PUBLIC, anon, authenticated or service_role;
- the narrow ADMIN grants still work and OPERATOR is still refused by RLS;
- `pg_default_acl` is clean, and a rolled-back probe table and sequence are born owner-only.

`supabase db reset` recreates Supabase's broad defaults, and the rebuild confirms that 0013 removes them on every build.

## 10. SECURITY DEFINER hardening

- **Inventory:** the public SECURITY DEFINER set is exactly `assert_period_open, cancel_order, current_app_role, deliver_order, rectify_delivered_order, register_collection` (I1).
- **Hardening of the 4 RPCs:**
  - owner `postgres` (BYPASSRLS)
  - `SET search_path = public` (I2)
  - explicit ACL with no PUBLIC entry (I3)
  - EXECUTE for authenticated only; anon has none (I4)
- **Actor and role:** no parameter can name the actor or the role (I5). The actor is always `auth.uid()` and the role is always `current_app_role()`.

## 11. Audit behavior

- **Table:** only the transversal `audit_events` table is used. No parallel audit table exists (J5).
- **Rows written:** DELIVER, RECTIFY_DELIVERED_ORDER, CANCEL, and CREATE on `collections`, each carrying the real actor and a timestamp (J1, J3).
- **One row per successful operation:** 1 delivery, 3 rectifications and 4 collections for the fixtures checked (J2).
- **Rectification detail:** the RECTIFY_DELIVERED_ORDER row holds before and after `{version, total, line_count}` plus the reason, actor and time (D10). The CANCEL row holds the PENDING → CANCELLED transition plus the reason (E4).
- **Failed calls:** failed calls write no audit, because audit is part of the snapshot fingerprint.
- **Tamper protection:** audit UPDATE, DELETE and TRUNCATE are denied to application roles (J4).

## 12. Automated tests

`scripts/target-db/commercial.test.mjs` contains **147 assertions** in groups A–L plus S1, S2 and Z:

- A schema: 11
- B pending: 10
- C delivery: 12
- D rectification: 17
- E cancellation: 10
- F collection: 19
- G balances: 5
- H security: 24
- I definer: 5
- J audit: 5
- K period: 6
- L atomicity: 5
- S1: 10
- S2: 6
- Z cleanup: 2

**How the suite runs:**

- Every role-scoped call simulates a real Supabase session (`SET LOCAL ROLE` + `request.jwt.claims`).
- All fixtures use the `P14-TEST` prefix and are synthetic. The suite removes them at start and at end, and reopens the periods it closed.
- It was re-run twice on the same database with identical results.

**Suites run on the rebuilt database:**

| Suite | Result |
|---|---|
| `apply.test.mjs` (runner) | 27 passed, 0 failed |
| `foundations.test.mjs` | 96 passed, 0 failed (81 + 15 ACL assertions from 0013) |
| `commercial.test.mjs` | 147 passed, 0 failed |
| `guard.test.mjs` | 35 correct, 0 incorrect |

**Changes to `foundations.test.mjs` (a test file, not a migration):**

- The fixed "17 public tables" assertion now means "the 17 Foundation tables exist, and no table outside Foundation plus the built later-phase list exists". One more assertion was added, so the count went from 80 to 81.
- The fixed definer inventory now expects Foundation's two functions plus the 4 Phase 14 RPCs.
- A pre-clean of the suite's own fixtures was added, because the suite failed when re-run on a database it had already exercised (duplicate ACTIVE flock).

## 13. End-to-end scenario

**S1** (client "P14-TEST E2E"; products Maple 4500 and Docena 1800; order 10 × 4500 + 6 × 1800):

| Step | Client debt | BNA |
|---|---|---|
| PENDING order, 2 lines at the configured prices | 0.00 | baseline |
| deliver | 55800.00 | unchanged (and posting count unchanged) |
| TRANSFER 20000 | 35800.00 | +20000.00 |
| TRANSFER 35800 | 0.00 | +55800.00 |

Exactly 2 postings exist in the scenario, both from collections and none from the delivery (S1.10).

**S2** (rectification scenario):

1. Deliver 41900.00.
2. Rectify to 36000.00.
3. Rectify to 18000.00.

Results:

- Line history v0 has 3 retired lines, v1 has 2 retired lines, and v2 has 1 current line.
- Exactly one version is current.
- The client account is 18000.00, reached through `+41900, −41900, +36000, −36000, +18000`.
- All 4 account balances are unchanged through the delivery and both rectifications.
- A CASH collection of 18000 then moves Caja chica by +18000.00 and brings the client account to 0.00.

## 14. Clean rebuild

```
before                → public tables=23, ledger=13
guard                 → target proven local (127.0.0.1:54322); cli argv proven local-only → supabase db reset
supabase db reset     → {"target":"local","message":"Reset local database."}
after destruction     → public tables=0, migration_ledger schema=0, enums=0
                        (postgres default ACL in public back to Supabase's Dxtm / w — removed again by 0013)
rebuild (apply.mjs)   → 13 files, 0 already applied → +0001 … +0013 → ledger holds 13
re-run apply.mjs      → applied 0 new migration(s); ledger now holds 13
ledger                → 0001,0002,…,0013 ; public tables = 23
suites                → runner 27/27, foundations 96/96, commercial 147/147 (guard 35/35)

(First Phase 14 rebuild, before 0013: 0001→0012, ledger 12, runner 27/27, foundations 81/81, commercial 147/147.)
```

No manual step, Studio action or ad-hoc SQL was needed. At the end, Supabase local was stopped.

## 15. Production isolation

- **Production:** not contacted.
- **Remote project-ref:** not used.
- **Commands never run:** `db push`, `--linked`, `link` and `unlink`.
- **Existing CLI link:** `supabase/.temp/project-ref` exists (P-3, still an open owner decision). The guard refuses any argv that could follow it, and every SQL operation was direct-URL against the loopback target.
- **Credentials:** `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ACCESS_TOKEN` and `SUPABASE_DB_PASSWORD` were unset before every run. No secret was printed.
- **Other constraints:** the firewall rule was not touched, and no production data was copied.

## 16. Deferred items

- **`sales_session` foreign keys:**
  - The frozen dependency order defers `pedidos.sales_session_id → sales_session` (cycle 1).
  - `collections.sales_session_id → sales_session` cannot exist yet, because `sales_session` belongs to Phase 21 (Feria).
  - Both columns exist as plain `UUID`. Each carries a stand-in `CHECK (sales_session_id IS NULL)`: `chk_pedidos_sales_session_fk_deferred` and `chk_collections_sales_session_fk_deferred`.
  - This is exactly what an FK to an empty `sales_session` would enforce. It prevents dangling references until the real FK exists (F18).
  - **The Feria migration must drop both CHECKs and add the frozen FKs.**
- **Out of scope for Phase 14:** `receive_cheque` and the instrument lifecycle belong to Phase 16. Transfers between accounts belong to Phase 15.

## 17. Frozen contradictions

None blocking.

`deliver_order` lists "client `activo=true`" as a validation but gives no error code for it. The existing contract code `CLIENT_NOT_FOUND_OR_INACTIVE` was used (§4). This is a technical completion, not a change of domain.

## 18. Exit criteria

The exact roadmap text is: "**Slice 1** runs end to end. Order total derives from current lines. Delivery creates the client ledger movement and no posting. Rectification reverses the *current* version and is correct across repeated passes."

| Criterion | Status | Evidence |
|---|---|---|
| Slice 1 runs end to end | **MET** | S1 (client → order → delivery → CC → 2 collections → account), all 10 checks |
| Order total derives from current lines | **MET** | no total column (G4); C3, D12, S1.2 |
| Delivery creates the client ledger movement and no posting | **MET** | C4, C5, S1.5, L5 |
| Rectification reverses the *current* version, correct across repeated passes | **MET** | D6, D11 (−19105 not −20606), D12 (3 passes net to current total), L4, S2.3 |
| All tests pass | **MET** | runner 27 / foundations 96 / commercial 147 |
| Clean rebuild passes | **MET** | §14 |
| Foundations and runner still pass | **MET** | 96/96, 27/27 |
| No blocking frozen contradiction | **MET** | §17 |
| Foundation privilege finding resolved | **MET** | §9a — 0013, ACL assertions 15/15 |
| Production not contacted | **MET** | §15 |

## 19. Phase status

**PHASE 14 — COMMERCIAL: COMPLETE** (evidence in §12–§14 and §18).

MASTER_ROADMAP.md was deliberately left with Phase 14 = **CURRENT**. The administrative closure will follow the external review. Phase 15 was not started.
