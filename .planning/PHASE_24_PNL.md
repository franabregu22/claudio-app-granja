# PHASE 24 — P&L / MANAGEMENT

**STATUS:** COMPLETE on mechanical evidence (§5–§7, §12–13). MASTER_ROADMAP.md was modified only in the wording of the Phase 24 exit criterion (aligned with ADR-004 §6); Phase 24 stayed **CURRENT** until external review, and no other criterion, order or status was changed in that adjustment.
**DATE:** 2026-09-25
**ENVIRONMENT:** local Supabase only (`127.0.0.1:54322`, PostgreSQL 17.6).
**AUTHORITIES:**

- TARGET_ARCHITECTURE_V2_FROZEN Part 19 (with Parts 8, 9, 15, 16, 18 and 22), as amended by **ADR-004** (`.planning/ADR-004-PNL-MANAGEMENT-CONTRACT.md`, accepted 2026-09-25).
- ADR-001, ADR-002 and ADR-003.

No FROZEN file was rewritten.

**HISTORY:**

1. The pre-construction contract review was BLOCKED. Costos directos and indirectos, the recognition timing, Retiros, Reservas internas, and the MP, fiscal and fee treatments had no deterministic source.
2. The owner took decisions D1–D14, recorded in ADR-004.
3. Construction started from migration 0043.

---

## 1. Exit criterion

> Results derived from authoritative source facts, never stored. Financial movements are not income/expense by themselves. Transfers are excluded from results. Costs are not double-counted against purchases. Drill-down reaches source facts.

The wording was aligned with ADR-004 §6 (owner clarification). The original text said "derived from ledgers and postings", which drifted from D1.

## 2. Owner decisions (ADR-004)

| # | Decision |
|---|---|
| D1 | Sales authority: DELIVERED Pedidos plus current `pedido_lineas`. Amount is `SUM(subtotal)`, dated `delivered_date`. "Netas" means net of rectifications, not of IVA. |
| D2 | Gross-of-IVA managerial basis: Pedido subtotals, `purchases.amount_total`, `freight.amount`. |
| D3 | OPERATING purchase recognised in full at `economic_date`. No inventory accounting and no deferred COGS. Feed consumption never releases cost again. |
| D4 | New `expense_category.pnl_cost_class` (DIRECT / INDIRECT), mandatory, with no default. |
| D5 | Freight: the allocated part follows the destination purchase's line; the unallocated part uses the freight's own class; both are dated `freight.economic_date`. |
| D6 | REINVESTMENT purchases go to Reinversión and INVESTMENT purchases to Inversiones, current version only, at `amount_total` and `economic_date`. |
| D7 | Retiros: Feria WITHDRAWAL, plus management RETIRO events. TRANSFER_OUT and OPENING_FUND are not retiros. |
| D8 | Reservas internas: management RESERVA_INTERNA events. They move no money. |
| D9 | `management_event` plus RPC 43 `register_management_event`. RETIRO creates one OWNER_WITHDRAWAL operation. Corrections are compensating events. |
| D10 | MP: the fee component goes to Costos indirectos (`abs`) and the yield to Otros ingresos financieros. Tax, payment and payout are excluded. A FEE operation is never counted. |
| D11 | The fiscal layer contributes zero P&L rows. |
| D12 | Session cash: EXPENSE uses its category class; WITHDRAWAL goes to Retiros; all other subtypes contribute nothing. |
| D13 | No P&L derived from `financial_operation_type`. |
| D14 | Derived views only. `security_invoker`, ADMIN only. |

## 3. Migrations

| Migration | Content | sha256 |
|---|---|---|
| `0043_pnl_management_sources.sql` | enum `expense_cost_class` and `expense_category.pnl_cost_class` NOT NULL; `financial_operation_type` + `OWNER_WITHDRAWAL`; enum `management_event_type`; table `management_event` | `523517a4…1fe0` |
| `0044_pnl_management_rpc.sql` | RPC 43 `register_management_event` | `93f5a6aa…d706` |
| `0045_pnl_views_privileges.sql` | `management_event` perimeter and policy; views `pnl_line_item` and `pnl_summary`; grants | `0628c2ab…e21d` |

- 0001–0042 are unchanged.
- No migration is empty.

## 4. Bucket sources

Each bucket has a deterministic source.

| Bucket | Source (authority) | Amount / sign | Date |
|---|---|---|---|
| VENTAS_NETAS | DELIVERED `pedidos` + current `pedido_lineas` | +SUM(subtotal) | `delivered_date` |
| COSTOS_DIRECTOS / COSTOS_INDIRECTOS | OPERATING current `purchases` (by category class) | −amount_total | `economic_date` |
|  | `freight_allocation` to an OPERATING purchase (by the purchase's class) | −allocated_amount | `freight.economic_date` |
|  | unallocated `freight` (by its own class) | −(amount − allocated) | `freight.economic_date` |
|  | Feria EXPENSE cash event (by its category class) | −amount | `event_date` |
|  | MP movement fee (INDIRECT) | −abs(fee_amount) | `occurred_date` |
| OTROS_INGRESOS_FINANCIEROS | MP movement of kind `yield` | +net_amount | `occurred_date` |
| REINVERSION | REINVESTMENT current purchases, plus freight allocated to them | −amount | `economic_date` / `freight.economic_date` |
| RETIROS | Feria WITHDRAWAL; `management_event` RETIRO | −amount (a compensation +amount) | `event_date` / `effective_date` |
| RESERVAS_INTERNAS | `management_event` RESERVA_INTERNA | −amount (a release +amount) | `effective_date` |
| INVERSIONES | INVESTMENT current purchases, plus freight allocated to them | −amount | as for REINVERSION |

**Never read by the views** (A8 definition scan):

- `financial_operation` and `financial_posting`, so transfers are excluded;
- `client_ledger`, `supplier_ledger` and `collections`;
- `fiscal_*`;
- MP `tax_amount`, `payment` and `transfer`.

## 5. Tests

`scripts/target-db/pnl.test.mjs` has **84 assertions**.

**How the scenario is built:** one synthetic 2026-08 scenario uses only the real RPCs of Phases 14–23 and RPC 43. The only direct insert is the frozen ADMIN PENDING-order path. Every expected figure is computed by hand in the file.

| Group | Assertions | What is proven |
|---|---|---|
| A structure | 8 | pnl_cost_class NOT NULL with no default, and a class-less category is rejected; OWNER_WITHDRAWAL exists; management_event shape and CHECKs; no result, subtotal or balance table and no materialized view; the views are `security_invoker`; the drill-down columns; the view never reads treasury, ledgers, collections or fiscal tables |
| B scenario | 1 | built through the real RPCs |
| S sales | 4 | a delivered sale is counted once at its current rectified value (1600, not 2000); one row per Pedido; the Feria aggregate is counted once (1000); a collection adds zero (sales = 2600) |
| P purchases | 3 | DIRECT purchase −1452 at its current version only (the old version is absent); INDIRECT −605; a payment adds zero |
| F freight | 6 | allocated to OPERATING DIRECT → −100 dated the freight date (not backdated), carried forward to the rectified purchase; REINVESTMENT −80; INVESTMENT −70; the unallocated part (own class) −50; a fully unallocated DIRECT freight −40; **each freight peso once:** F1 contributions sum to exactly −300 = −freight.amount |
| R reinvestment / investment | 2 | −5000 −80 = −5080; −20000 −70 = −20070 |
| E Feria | 3 | EXPENSE INDIRECT −150 and DIRECT −70; WITHDRAWAL → Retiros −300; OPENING_FUND, TRANSFER_OUT and COUNT contribute nothing |
| M Mercado Pago | 4 | the payment gives no revenue, only its fee −12 once; yield +45.50; payout and taxes (−8, −30) excluded; a Mode 1 FEE operation leaves the P&L unchanged |
| T treasury / fiscal | 2 | a fiscal document, components, obligation and payment change nothing; a transfer changes nothing |
| G management events | 21 | RETIRO −800 and its compensation +300, with drill-down; exactly one OWNER_WITHDRAWAL operation and posting per event (−800 / +300); RESERVA −1000 and release +400 with no operation or posting; 14 rejections that write nothing (listed below); CLOSED period; release capped at the original; audit CREATE / COMPENSATE; append-only (no direct DML) |
| C concurrency | 4 | independent PostgreSQL sessions (A holds its transaction, B is observed in `pg_stat_activity` waiting on a Lock) — C1 reserve releases 600 + 600 on a 1000 reserve: B waits on the ORIGINAL row lock (`FOR UPDATE` before the SUM), then COMPENSATION_EXCEEDS_ORIGINAL; one release of 600 and one audit; C2 RETIRO compensations 600 + 600 on a 1000 retiro: the same, and exactly 2 OWNER_WITHDRAWAL postings (−1000, +600), so money returned (600) ≤ withdrawal; C3 the same idempotency key concurrently (RETIRO): B → DUPLICATE_MANAGEMENT_EVENT, and exactly 1 event / 1 operation / 1 posting / 1 audit; C4 the same for RESERVA_INTERNA: 1 event, no treasury row, 1 audit. The facts are dated 2026-09, so the 2026-08 scenario stays exact. No SQL change was needed: 0044 already locks the original first. |
| SUM | 15 | exact arithmetic through every subtotal (below), plus the result equal to the running bucket sum |
| D drill-down | 3 | 0 orphan line items; allocated freight carries the destination purchase's category and nature; the period holds exactly 22 scenario items |
| X security / no storage | 6 | ADMIN sees; OPERATOR sees zero in both views and in management_event; anon and service_role are denied on views, table and RPC 43; definer inventory = 40 + RPC 43; RPC 43 hardening; exact grants |
| Z cleanup | 2 | everything removed; periods reopened |

**The 14 G rejections**, each with nothing written:

- DUPLICATE_MANAGEMENT_EVENT;
- FORBIDDEN (OPERATOR);
- INVALID_AMOUNT (0 or negative);
- REASON_REQUIRED;
- INVALID_IDEMPOTENCY_KEY (96 characters);
- ACCOUNT_REQUIRED;
- ACCOUNT_NOT_ALLOWED;
- COMPENSATION_EXCEEDS_ORIGINAL;
- COMPENSATION_TYPE_MISMATCH;
- INVALID_COMPENSATION_TARGET;
- ACCOUNT_MISMATCH;
- EVENT_NOT_FOUND;
- PERIOD_NOT_FOUND.

**Exact summary for 2026-08** (SUM):

| Line | Amount |
|---|---|
| Ventas netas devengadas (1600 + 1000) | 2 600.00 |
| − Costos directos (1452 + 100 + 40 + 70) | −1 662.00 |
| − Costos indirectos (605 + 50 + 150 + 12) | −817.00 |
| **= Resultado operativo** | **121.00** |
| + Otros ingresos financieros | 45.50 |
| **= Resultado antes de reinversión** | **166.50** |
| − Reinversión | −5 080.00 |
| **= Resultado post-reinversión** | **−4 913.50** |
| − Retiros (300 + 800 − 300) | −800.00 |
| **= Disponible post-retiros** | **−5 713.50** |
| − Reservas internas (1000 − 400 + 10 − 600) | −10.00 |
| **= Post-reservas** | **−5 723.50** |
| − Inversiones | −20 070.00 |
| **= Resultado post-inversiones** | **−25 793.50** |

## 6. Regression

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
| `feria.test.mjs` | 142 / 0 |
| `fiscal.test.mjs` | 132 / 0 |
| `mp.test.mjs` | 143 / 0 |
| `pnl.test.mjs` | 84 / 0 (twice; the concurrency group was added in the final bounded closure) |
| `guard.test.mjs` | 35 / 0 |

**Foundations enum inventory:** 28 frozen types + 2 ADR-004 types (`expense_cost_class`, `management_event_type`) = 30.

The first regression run, before this inventory was updated, showed exactly that one foundations failure (28 → 30). Nothing else failed.

Earlier suites were changed only in exact structural inventories and fixtures. No behavioural assertion was weakened.

- **Definer inventory:** + `register_management_event` in commercial, treasury, instruments, purchases, production, classification, feed, feria, fiscal and mp. Foundations adds it to its later-phase list.
- **Later-phase tables:** + `management_event` in foundations and treasury.
- **Foundations enum count:** 28 → 30.
- **Fixtures:** the `expense_category` inserts in purchases, feria and fiscal now set `pnl_cost_class` explicitly, as ADR-004 D4 requires ("test fixtures must provide it explicitly").

## 7. Clean rebuild

```
before              → public tables=53, ledger=45
guard               → target proven local; cli argv proven local-only → supabase db reset (stack freshly started)
supabase db reset   → {"target":"local","message":"Reset local database."}
after destruction   → tables=0, migration_ledger schema=0, enums=0, public functions=0, views=0
rebuild             → 45 files, 0 already applied → +0001 … +0045 → ledger holds 45; public tables = 53
re-run apply.mjs    → applied 0 new migration(s); ledger now holds 45 (0001..0045)
suites              → runner 27/27, foundations 96/96, commercial 147/147, treasury 107/107, instruments 200/200,
                      purchases 216/216, production 149/149, classification 75/75, feed 176/176, feria 142/142,
                      fiscal 132/132, mp 143/143, pnl 80/80 (twice), guard 35/35
checksums           → 0039–0042 unchanged (439b007f…f9cc, bccbddc0…7748, 0ed1c215…7e4b, c98b9ef2…278b); legacy untouched
```

No manual step and no Studio action were needed. Supabase local was stopped at the end.

**Final bounded closure:** only the tests changed (the C group), and no migration was added, so no new clean rebuild was required. pnl was run twice (84/84) and the full regression was rerun on the same ledger (45 migrations); the results are in §6.

## 8. Production isolation

- Production was not contacted, and the remote project-ref was not used.
- `db push`, `--linked`, `link` and `unlink` were never run.
- All SQL went to the guarded loopback target.
- Production credentials were unset, and no secret was printed.

## 9. RPC 23/24

**UNASSIGNED.** They were not implemented and Phase 18 was not edited. The new management RPC is **RPC 43**.

## 10. Deferred / carry-forwards

- Real `expense_category` rows must be mapped to DIRECT / INDIRECT explicitly before migration / cutover (ADR-004 D4).
- The MP cutover carry-forward (ADR-003 D8) is unchanged.
- Phase 25 (Dashboard / Reports) consumes `pnl_line_item` and `pnl_summary`.
- Also unchanged: frontend, the transversal financial idempotency key, and `source_collection_id`.

## 11. Frozen contradictions

None open. Every earlier gap is resolved by ADR-004 (§2).

## 12–13. Exit criterion evidence

| Requirement | Status | Evidence |
|---|---|---|
| Every bucket has a deterministic source | **MET** | §4, S, P, F, R, E, M, G |
| Results derived, never stored | **MET** | A5, A6, X6 (views only; no table or materialized view) |
| Transfers excluded | **MET** | A8, T2 |
| No purchase / payment double counting | **MET** | P1, P3, S4 |
| Freight counted once (mathematically) | **MET** | F1–F6 |
| Fiscal layer excluded | **MET** | T1, A8 |
| MP fee / yield deterministic | **MET** | M1–M4 |
| Management retiro / reserve facts exist | **MET** | G1–G8 |
| Drill-down reaches source facts | **MET** | D1–D3 |
| Financial movements are not income / expense by themselves | **MET** | M1, T1, T2, P3, S4, A8 |
| Management compensations are capped and idempotent under concurrency | **MET** | C1–C4 |
| OPERATOR cannot see cost / result data | **MET** | X2, X3 |
| Full regression and clean rebuild pass; production untouched | **MET** | §6–§8 |

## 14–16. Status

**PHASE 24 — P&L / MANAGEMENT: COMPLETE.**

MASTER_ROADMAP.md was modified only in the wording of the Phase 24 exit criterion (ADR-004 §6). Phase 24 stayed **CURRENT** until external review; no other criterion, order or status was changed in that adjustment. Phase 25 was not started.
