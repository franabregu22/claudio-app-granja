# PHASE 21 — FERIA

**STATUS:** COMPLETE on mechanical evidence (§28–§30, §35). MASTER_ROADMAP.md is unchanged; Phase 21 stays **CURRENT** until external review.

**DATE:** 2026-09-25

**ENVIRONMENT:** local Supabase only (`127.0.0.1:54322`, container `supabase_db_Claudio_app_Granja`, PostgreSQL 17.6).

**AUTHORITIES (all FROZEN, as amended by ADR-001 and ADR-002; none was modified):**
- MASTER_ROADMAP.md, for sequence.
- TARGET_ARCHITECTURE_V2_FROZEN.md, Parts 16, 19, 20 and 26.
- RPC_CONTRACTS_V1: §1 (`deliver_order`, reused) and §30–§33.
- POSTGRES_SCHEMA_SPEC_V1: Domains C, D, E and J.
- RLS_IMPLEMENTATION_SPEC_V1: §4, §5, §8 (Feria) and §10.
- DATABASE_INVARIANTS_V1: §12 and §28.
- IMPLEMENTATION_DEPENDENCY_ORDER_V1: step 3.6, cycle 1.

---

## 1. Exact exit criterion

> Sessions with physical movements and cash management; one aggregated retail Pedido per session; identified clients keep their own Pedidos; reconciliation surfaces variances without inventing correspondence.

## 2. Scope

**Built:**
- Tables `sales_session`, `sales_session_movement` and `sales_session_cash_event`.
- RPCs 30–33.
- The step 3.6 cycle-1 FKs.
- The collections session FK.
- The two backstops for invariant 28.

**Reused unchanged:**
- Tables: `pedidos`, `pedido_lineas`, `client_ledger`, `clients` (with the seeded CONSUMIDOR FINAL), `products`, `financial_account`, `financial_operation`, `financial_posting`, `expense_category`, `collections`, `audit_events`, `perfiles`, `management_period`.
- Functions: `current_app_role()`, `assert_period_open()` and `deliver_order()` (RPC 1).

**Not built:**
- Fiscal.
- MP reconciliation (`mp_reconcile_movement`, Phase 23).
- Frontend.
- Anonymous individual sale rows.
- A parallel sales ledger.
- Manual P&L.
- RPC 23/24.

## 3. Migrations

| Version | File | Content | sha256 |
|---|---|---|---|
| 0032 | `0032_feria_tables.sql` | 3 tables, CHECK/UNIQUE/FKs, 3 indexes; step 3.6 cycle 1 (`fk_pedidos_sales_session`, `fk_sales_session_aggregated_pedido`); `collections_sales_session_id_fkey`; drops the two 0010 stand-ins; invariant 28 backstops | `8048dff7…8103` |
| 0033 | `0033_feria_rpcs.sql` | RPCs 30–33, owner postgres, EXECUTE perimeter | `ecf27f26…0601` |
| 0034 | `0034_feria_privileges_rls.sql` | explicit reset, SELECT grant, 5 policies | `229c8778…74e1` |

Migrations 0001–0031 are unchanged: the runner verified their checksums, and 0029–0031 re-hash identically. Legacy migrations were not touched. No migration is empty.

The 0010 stand-ins (`CHECK sales_session_id IS NULL` on `pedidos` and `collections`) are replaced by the frozen FKs, as 0010 and the dependency order announced (A6).

## 4. Reused objects

**Pedido path:**
- The CONSUMIDOR FINAL client has been seeded since 0008 and is never created dynamically (E11).
- `deliver_order` keeps its signature and is the only path that delivers the aggregate (M4, E5).

**Money path:**
- Session cash is posted through `financial_operation` / `financial_posting` with type `SESSION_CASH` (D2–D4).

**New constraint on a reused table:** `pedidos` gains the invariant-28 backstops (§11).

## 5. Session model

`sales_session` matches frozen Domain J exactly: columns (A2), `UNIQUE(idempotency_key)` (A3), FKs RESTRICT (A4) and `idx_sales_session_date` (A5).

- The session is the operational event.
- The Pedido is the economic fact.
- A second session with the same date and location but a different key is allowed (B10).
- No session total, balance or variance column exists (A9).

## 6. Physical movement model

`sales_session_movement` holds DISPATCH / RETURN / LOSS / ADJUSTMENT with `cantidad > 0` (A2, A3).

**Behaviour:**
- All four types persist exactly as recorded (C1).
- Writers are OPERATOR A, operator B (who has no flock assignment) and ADMIN.
- LOSS and ADJUSTMENT need a non-blank reason, else `REASON_REQUIRED` (C3).
- A movement has no economic effect: no operation, posting, ledger entry, collection or Pedido, and account balances do not change (C2).

## 7. Cash event model

`sales_session_cash_event` has five event types: OPENING_FUND / EXPENSE / WITHDRAWAL / TRANSFER_OUT / COUNT.

- `amount > 0`.
- `chk_session_expense_category` is enforced even for the owner (D9).
- No balance is stored; account balances are always `SUM(financial_posting.signed_amount)`.

## 8. RPCs 30–33

Line-by-line transcriptions of RPC_CONTRACTS_V1 with the exact frozen signatures (M3).

| RPC | Actor | Period determinant | Returns |
|---|---|---|---|
| 30 `open_sales_session` | ADMIN | `session_date` | `{session_id, estado}` |
| 31 `register_session_movement` | OPERATOR / ADMIN | session's `session_date` | `{movement_id}` |
| 32 `register_session_cash_event` | ADMIN | session's `session_date` | `{event_id, financial_operation_id}` |
| 33 `close_sales_session` | ADMIN | session's `session_date` | `{session_id, estado, aggregated_pedido_id, aggregated_total}` |

**Technical completions.** Contract behaviour is unchanged, and each completion is tested:
- **RPC 30:** a NULL or negative opening fund → `INVALID_AMOUNT` (B6). A concurrent duplicate → `DUPLICATE_SESSION` (J1).
- **RPC 31:** a NULL quantity → `INVALID_QUANTITY` (C3).
- **RPC 32:**
  - a NULL amount → `INVALID_AMOUNT`, and a NULL type → `INVALID_EVENT_TYPE`;
  - an `OPENING_FUND` through RPC 32 → `INVALID_EVENT_TYPE` (D7, D8b). This is confirmed by owner decision (§9, §34).
- **RPC 33:**
  - NULL or non-array lines → `INVALID_AGGREGATED_LINES`;
  - every line is validated before the first write, with the Commercial codes `INVALID_QUANTITY` / `INVALID_PRICE` / `PRODUCT_NOT_FOUND` (E10).
- **Frozen constraints** reject a NULL location or key (B7), a NULL date (`BUSINESS_DATE_REQUIRED`, B6) and a missing product (C4).

## 9. Opening fund

When `p_opening_fund > 0`, RPC 30 creates:
- one `SESSION_CASH` operation with `external_ref = 'SESSION_FUND:<session_id>'`, source `sales_session` / `<id>`, dated `session_date`;
- **zero postings**;
- an `OPENING_FUND` cash event on the cash account (B3).

The cash account balance is unchanged, and there is no client ledger entry and no collection (B4). The fund is a transfer into the session, **not income** and not an outflow.

**Owner decision (2026-09-25): OPENING_FUND.**
- `OPENING_FUND` represents **exclusively** the initial change fund when a feria opens.
- It is recorded **only** by RPC 30 `open_sales_session`.
- RPC 32 `register_session_cash_event` rejects `OPENING_FUND` with `INVALID_EVENT_TYPE`. That behaviour is accepted as is.
- There is **no top-up** of the opening fund during an open session.
- If cash ever needs to be added mid-session, it must be modelled as a separate, explicit concept and must never reuse `OPENING_FUND`.

Evidence:
- B3: RPC 30 accepts the fund.
- D7: RPC 32 rejects `OPENING_FUND`.
- D8b: RPC 32 rejects a top-up on an open session that already has its RPC 30 fund. No operation and no additional posting are created, and the session still has exactly one `OPENING_FUND` event.

Other rules:
- A fund greater than 0 needs an account (`ACCOUNT_REQUIRED`).
- A fund of 0 creates nothing (B2).
- The fund is audited inside the OPEN audit (B9).

## 10. Physical / economic separation

- Physical movements never create economic facts (C2).
- The only economic sale is the Pedido delivered by `deliver_order` (E5, F1).
- Closing a session moves no money. The retail sale is a SALE_DELIVERY debit on CONSUMIDOR FINAL, and no operation, posting or collection is invented (E6).
- **E2E:** DISPATCH 100 / RETURN 10 / LOSS 2 / ADJUSTMENT 1 stay physical facts. No "sold = dispatch − return − loss ± adj" is derived or forced to match the Pedido lines (O4). The FROZEN set defines no such metric.

## 11. Anonymous aggregation

When a session is closed with a non-empty line set, it produces **exactly one** aggregated Pedido:
- client CONSUMIDOR FINAL, `is_aggregated_retail = true`, `sales_session_id = session` (E2);
- delivered through `deliver_order` at `session_date 23:59 America/Argentina/Buenos_Aires`, so `delivered_date = session_date` (E5).

**Itemisation is preserved.** The same product at different prices stays as separate lines: XL 10 @ 100 and XL 5 @ 120 are two lines, with price and name snapshots (E3).

**Closing twice** → `SESSION_ALREADY_CLOSED`, and there is never a second aggregate (E8, J5).

**Invariant 28 at schema level (0032):**
- `chk_pedidos_aggregated_has_session`: an aggregated Pedido outside a session is impossible (L3).
- `idx_pedidos_one_aggregate_per_session` (UNIQUE partial): a second aggregate for one session is impossible (L4).

Both close the ADMIN PENDING-order path (`pedidos` INSERT/UPDATE policies), which could otherwise bypass RPC 33. The frozen invariant query 28 returns 0 rows (L2). No individual anonymous sale table exists (L1).

## 12. Identified clients

An identified client uses the existing Commercial path (F1):
1. ADMIN creates a normal Pedido carrying `sales_session_id`.
2. ADMIN adds its lines.
3. `deliver_order` delivers it; the client's own ledger shows +18000.

When the session closes, a **separate** CONSUMIDOR FINAL aggregate is created (30000). The identified Pedido keeps its client, stays non-aggregated and is not folded into the aggregate (F2).

The session then holds exactly one identified Pedido and one aggregate (F3). A Pedido cannot reference a nonexistent session (`fk_pedidos_sales_session`, F4).

## 13. Consumidor Final

- The master is looked up with `nombre = 'CONSUMIDOR FINAL' AND activo`.
- If it is missing or inactive and lines are present → `CONSUMIDOR_FINAL_MISSING`, with full rollback; the master is never created (E11, E12).
- With an empty aggregate, the session closes without needing the master (E13).

## 14. Aggregated total

`aggregated_total = SUM(current pedido_lineas.subtotal)` of the aggregate, computed after delivery.
- Test case: 10·100 + 5·120 + 3·50 = **1750**; E2E: 66150 (E4, O2).
- The total is 0 when there is no aggregate (E1).
- No session total is stored.

## 15. Cash management (RPC 32, ADMIN only)

| Event | Operation | Postings |
|---|---|---|
| EXPENSE (category and account required) | 1 `SESSION_CASH` | −amount on the source account (D2) |
| WITHDRAWAL (account required) | 1 | −amount; a distribution, not an operating expense, so no category (D3) |
| TRANSFER_OUT (account and destination required) | 1 | −amount source, +amount destination: both legs under **one** operation (D4) |
| COUNT | none | none (D5) |

Exact account effects: Caja −3300, BNA +2000. The opening fund and the COUNT moved nothing (D6).

Operations and postings are dated `session_date`, with source `sales_session` (D2).

**Validation codes:** `CATEGORY_REQUIRED`, `ACCOUNT_REQUIRED`, `DESTINATION_REQUIRED`, `INVALID_AMOUNT`, `SESSION_NOT_FOUND`. Rejections are atomic (D7, D8).

OPERATOR gets `FORBIDDEN` (D1).

## 16. COUNT observation

A COUNT is a physical observation:
- `financial_operation_id` is NULL;
- no operation and no posting (D5, K1);
- it stays exactly as registered, with no automatic correction (K3).

## 17. Reconciliation / variance

The model keeps every fact reconciliation needs and invents none.

**Session K:** fund 5000, EXPENSE 300, WITHDRAWAL 1000, COUNT 4100, retail aggregate 1000.

- **Expectation:** a read-only query over the session's cash events gives 5000 − 300 − 1000 = **3700**. The variance of **+400** stays visible and is not forced to 0 (K2).
- **No auto-correction:** there is no ADJUSTMENT operation, no posting and no collection for the variance or for the retail sale (K3).
- **No invented match:** the aggregate stays an open CONSUMIDOR FINAL debit, and nothing pairs it with the count (K4).
- **Nothing stored:** there is no variance or reconciliation table, and no MP object (Phase 23) (K5).
- **E2E:** COUNT 5000 against an expectation of 2800 stays a visible variance (O5).

Per the frozen invariant, three reconciliations remain:
- cash: COUNT against postings;
- MP: later, through `mp_reconcile_movement`;
- CC: through the identified clients' own Pedidos.

## 18. State lifecycle

OPEN → CLOSED.

**A CLOSED session rejects:**
- movements → `SESSION_CLOSED`;
- cash events → `SESSION_CLOSED`;
- a second close → `SESSION_ALREADY_CLOSED`.

(E8, E9)

**Visibility after close:** operators no longer see the session or its movements; ADMIN keeps full visibility (G1, G2, O6).

**Close records:** `closed_at`, `closed_by` and `aggregated_pedido_id` (E7).

## 19. Periods

All four RPCs take their period from the session's `session_date`.

| Case | Result |
|---|---|
| RPC 30 in a CLOSED month | `PERIOD_CLOSED` (H1) |
| RPC 30 in a month with no period | `PERIOD_NOT_FOUND` (H4) |
| Session opened while March was OPEN, March then CLOSED | RPC 31 (OPERATOR and ADMIN), RPC 32 and RPC 33 → `PERIOD_CLOSED`; nothing written; session still OPEN (H2, H3) |
| Current month CLOSED, session dated in OPEN May | open, move, cash and close all accepted; delivered_date is May (H5) |

`created_at`, `opened_at` and `closed_at` never decide the period.

## 20. Idempotency

| RPC | Mechanism | Sequential | Concurrent |
|---|---|---|---|
| 30 | `idempotency_key UNIQUE` | `DUPLICATE_SESSION`, nothing written (B6, B8) | one session survives (J1) |
| 33 | state guard | `SESSION_ALREADY_CLOSED` (E8) | one aggregate only (J5) |

## 21. Atomicity

Test-only triggers in schema `p21_harness` inject real failures (I).

| RPC | Failure points | Result |
|---|---|---|
| 30 | after the session insert; at the fund operation; at the OPENING_FUND event; at the audit | nothing written (I1) |
| 31 | at the movement insert; at the audit | full rollback (I2) |
| 32 | after the operation, at the first posting; TRANSFER_OUT after the first leg, at the second posting; after both postings, at the cash event; at the audit | full rollback (I2) |
| 33 | after the aggregate insert, at the first line; at a later line; inside `deliver_order` (client ledger); after delivery, at the CLOSE update; at the CLOSE audit | no half Pedido, no delivered orphan, no ledger entry; the session stays OPEN without an aggregate (I3) |

The harness is removed afterwards (I4).

## 22. Concurrency

Tested with genuinely independent PostgreSQL sessions. Every RPC locks the session row first, then the period row.

| Test | Race | Outcome |
|---|---|---|
| J1 | same key | B waited, then `DUPLICATE_SESSION`; one session, A's |
| J2 | close first, then a movement | the movement waited on the session lock, then `SESSION_CLOSED`; no movement |
| J3 | movement first, then close | the close waited, then closed; the movement stays, one aggregate |
| J4 | close first, then a cash event | the cash event waited, then `SESSION_CLOSED`; no operation or posting |
| J5 | close vs close | B waited, then `SESSION_ALREADY_CLOSED`; exactly one aggregate (A's, total 400) |

## 23. RLS

Exactly as in RLS §8 Feria: five policies (G6).

| Table | ADMIN | OPERATOR |
|---|---|---|
| `sales_session` | S all | S where `estado = 'OPEN'` (G1) |
| `sales_session_movement` | S all | S of OPEN sessions (G2) |
| `sales_session_cash_event` | S all | — (G3) |

Operators read the audit of their own movements, under the frozen audit policy, but no session or cash audit (G9).

## 24. Privileges

- `authenticated` has SELECT only (G5).
- No direct INSERT / UPDATE / DELETE / TRUNCATE for OPERATOR or ADMIN (G4).
- Sequences grant nothing (G7).
- `anon` and `service_role` have no SELECT and no EXECUTE (G8).

## 25. SECURITY DEFINER

- Inventory: 35 functions, the previous 31 plus RPCs 30–33 (M1).
- Each is DEFINER with `search_path=public`, owned by postgres, with no PUBLIC access and EXECUTE for authenticated only (M2).
- Signatures are exact, with no actor parameters (M3).

## 26. Audit

| Entity | Action | after_values |
|---|---|---|
| sales_session | OPEN | session_date, location, opening_fund (B9) |
| sales_session_movement | CREATE | session_id, movement_type, producto_id, cantidad (C7) |
| sales_session_cash_event | CREATE | session_id, event_type, amount (D10) |
| sales_session | CLOSE | before OPEN / after CLOSED + aggregated_pedido_id (E7) |
| pedido | DELIVER | via `deliver_order` (E5) |

Every audit row records the reason and the real actor. Failed calls leave no audit (I). The E2E day's full trail is checked by count (O7).

## 27. E2E

"Feria Plaza Central", 2026-05-23.

1. Open with fund 3000.
2. Operator A records DISPATCH 100 / RETURN 10 / LOSS 2 / ADJUSTMENT 1.
3. EXPENSE 200.
4. The identified wholesale client gets its own Pedido (20 × 900 = 18000), delivered.
5. COUNT 5000.
6. During the session, operator A sees the session and its 4 movements but no cash event (O1).
7. Close with Maple 50 @ 1000 and 17 @ 950: one CONSUMIDOR FINAL aggregate, total **66150**, delivered on 2026-05-23 (O2).
8. The session holds exactly two Pedidos: Mayorista (own) and CONSUMIDOR FINAL (aggregate) (O3).
9. The physical facts are unchanged and not inferred into sales (O4).
10. Only the expense moved money (Caja −200). COUNT 5000 against an expectation of 2800 stays a visible variance (O5).
11. After close, the operator sees nothing of the session; ADMIN sees everything (O6).
12. Audit trail: OPEN, 4 movements, 2 cash audits, CLOSE and 2 DELIVER (O7).

## 28. Automated tests

`scripts/target-db/feria.test.mjs`: **142 assertions**.

| Group | Assertions |
|---|---|
| A structure | 9 |
| B open | 14 |
| C movements | 13 |
| D cash (incl. D8b owner decision) | 21 |
| E close | 19 |
| F identified | 4 |
| G RLS/privileges | 9 |
| H periods | 8 |
| I atomicity | 16 |
| J concurrency | 5 |
| K reconciliation | 5 |
| L invariants | 5 |
| M definer | 4 |
| O E2E | 7 |
| N economic | 1 |
| Z cleanup | 2 |

- Passes on re-run: two consecutive runs gave 141/0 and 141/0 in the rebuild, then 142/0 and 142/0 after the D8b owner-decision assertion was added.
- Fixtures: sessions use keys `P21-TEST:…`, and masters are named `P21-TEST …`.
- The seeded CONSUMIDOR FINAL is reused. It is deactivated in one test and always restored (Z2).
- Operator B (`88888888…`) is a Phase 21 fixture and is deleted afterwards.

## 29. Regression

| Suite | Result |
|---|---|
| `apply.test.mjs` | 27 / 0 |
| `foundations.test.mjs` | 96 / 0 |
| `commercial.test.mjs` | 147 / 0 |
| `treasury.test.mjs` | 107 / 0 |
| `instruments.test.mjs` | 200 / 0 |
| `purchases.test.mjs` | 216 / 0 |
| `production.test.mjs` | 149 / 0 |
| `classification.test.mjs` | 75 / 0 |
| `feed.test.mjs` | 176 / 0 |
| `feria.test.mjs` | 141 / 0 (twice) at the rebuild; 142 / 0 (twice) after D8b, same ledger 0001..0034, no SQL change |
| `guard.test.mjs` | 35 / 0 |

Earlier suites were changed only in exact structural inventories. No behavioural assertion was weakened.

- **Definer inventory (35):** commercial, treasury, instruments, purchases, production, classification, feed. Foundations also gets `LATER_PHASE_DEFINERS` +4.
- **Later-phase tables (+3):** foundations and treasury.
- **commercial:**
  - A4: the two deferred-FK stand-ins were replaced by the Phase 21 backstop check.
  - A5: +2 frozen `sales_session` FKs.
  - A7: +1 backstop index.
  - F18: the same behaviour (a dangling `sales_session_id` is rejected with full rollback) is now asserted through the real frozen FK `collections_sales_session_id_fkey`.
- **purchases A10:** cycle 1 is now present.
- **treasury A9** (no parallel money ledger): its name pattern also matched `sales_session_movement` and `sales_session_cash_event`. These are frozen Domain J tables, not a parallel ledger, because session money posts through `financial_operation` / `financial_posting`. They are excluded by exact name, alongside Phase 20's `feed_movement`.

## 30. Clean rebuild

```
before              → public tables=44, ledger=34
guard               → target proven local; cli argv proven local-only → supabase db reset
supabase db reset   → {"target":"local","message":"Reset local database."}
after destruction   → tables=0, migration_ledger schema=0, enums=0, public functions=0, views=0
rebuild             → 34 files, 0 already applied → +0001 … +0034 → ledger holds 34; public tables = 44
re-run apply.mjs    → applied 0 new migration(s); ledger now holds 34 (0001..0034)
suites              → runner 27/27, foundations 96/96, commercial 147/147, treasury 107/107, instruments 200/200,
                      purchases 216/216, production 149/149, classification 75/75, feed 176/176,
                      feria 141/141 (twice), guard 35/35
checksums           → 0029–0031 unchanged (dbf7c09e…42f0, 34195efb…259d, 1e359fbd…ee50); legacy untouched
```

A first rebuild attempt is **not** counted as evidence. Its `supabase db reset` returned `LegacyDbSetupError` (CLI container setup; the stack had been left running from the development runs), and the suites after the runner aborted without results. The stack was restarted cleanly and the whole rebuild was repeated. The block above is that complete, successful run.

No manual step and no Studio action. Supabase local was stopped at the end.

## 31. Production isolation

- Production was not contacted, and the remote project-ref was not used.
- No `db push`, `--linked`, `link` or `unlink` was run.
- All SQL went direct-URL to the guarded loopback target, and the reset passed the CLI argv guard.
- Production credentials were unset, and no secret was printed.
- No production data was used.

## 32. RPC 23/24 deferred

RPC 23 `register_flock_weighing` and RPC 24 `register_temperature_record` remain **UNASSIGNED**. They were not implemented, not assigned to Feria, and Phase 18 was not edited.

## 33. Other deferred

- **Phase 22 Fiscal:** Fiscal documents for feria sales.
- **Phase 23 MP:** reconciliation (`mp_reconcile_movement`).
- **Reporting:** a reporting-layer view of the cash expectation and variance. It exists here only as the read-only query in K2/O5.
- **Carry-forwards:** frontend, real-data migration, the cross-cutting financial idempotency key, and `source_collection_id`.

## 34. Frozen contradictions

None that blocks the exit criterion.

**1. RPC 30 opening fund vs the "1..N postings" note.**
- Schema Domain E describes `financial_operation` as the "parent of 1..N postings".
- RPC 30 explicitly creates the `SESSION_FUND` operation with **no** posting ("a transfer into the session, not income").
- No DB constraint enforces the note, so RPC 30 was implemented literally, as the more specific text. The domain is consistent: no money leaves or enters any account.
- Recommended: align the Domain E note in a future documentation pass. FROZEN documents were not touched.

**2. OPENING_FUND through RPC 32: RESOLVED by owner decision (2026-09-25).**
- The RPC 32 signature accepts any `session_cash_event_type`, and its generic non-COUNT branch would post −amount on the account for an `OPENING_FUND`. It would also skip the account check, so it fails on NOT NULL without an account.
- That contradicts RPC 30's frozen meaning of the opening fund, which has no posting.
- Implemented choice: RPC 32 rejects `OPENING_FUND` with `INVALID_EVENT_TYPE`, keeping the opening fund single-sourced in RPC 30 (D7).
- **Owner decision:** `OPENING_FUND` is exclusively the change fund at opening. It is recorded only through RPC 30, and RPC 32's `INVALID_EVENT_TYPE` rejection is accepted. There is no mid-session top-up; any future mid-session cash addition must be a separate, explicit concept (§9).
- **No change to SQL or the FROZEN documents:** 0033 already implements the rule (checksum unchanged, `ecf27f26…0601`). Evidence: B3, D7, D8b.

**3. Invariant 28 backstops.** The frozen invariant names RPC 33 as the enforcer. The ADMIN PENDING-order policies would otherwise allow an aggregated Pedido outside, or a second one inside, a session. The CHECK and the unique partial index enforce the frozen rule without changing any policy text (§11).

## 35. Exit criterion evidence

| Requirement | Status | Evidence |
|---|---|---|
| Session lifecycle works | **MET** | B, E1, E7–E9, G1 |
| Physical movements stay physical | **MET** | C1, C2, O4 |
| Cash events work | **MET** | D2–D6, D10 |
| COUNT is observation only | **MET** | D5, K1, K3 |
| At most one aggregated Pedido per session | **MET** | E2, E8, J5, L2–L4 |
| Aggregate goes through the normal delivery path | **MET** | E5, M4 |
| Identified clients keep their own Pedidos | **MET** | F1–F3, O3 |
| No individual anonymous sale rows | **MET** | L1, L3, O3 |
| Cash, physical and Pedido facts stay separate | **MET** | C2, E6, O4, O5 |
| Variance survives without invented reconciliation | **MET** | K1–K5, O5 |
| RLS | **MET** | G1–G3, G6, G9, O1, O6 |
| Periods | **MET** | H |
| Atomicity | **MET** | I |
| Concurrency | **MET** | J |
| Regression, clean rebuild, production untouched | **MET** | §29–§31 |

## 36. Status

**PHASE 21 — FERIA: COMPLETE** (§28–§30, §35).

MASTER_ROADMAP.md was deliberately left unchanged: Phase 21 = **CURRENT** until external review. Phase 22 was not started.
