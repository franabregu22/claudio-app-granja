# ADR-004 — P&L / Management contract

**STATUS:** **ACCEPTED** (owner, 2026-09-25, "PHASE 24 — OWNER DECISIONS RATIFIED / ADR-004 / RESUME CONSTRUCTION").

**Implemented by:**
- `0043_pnl_management_sources.sql`
- `0044_pnl_management_rpc.sql`
- `0045_pnl_views_privileges.sql`

**HISTORY:**
- Pre-construction review BLOCKED (PHASE_24_PNL.md, first version).
- Owner decisions and acceptance, 2026-09-25.

**DATE:** 2026-09-25

**AMENDS:**
- TARGET_ARCHITECTURE_V2_FROZEN.md: Part 19 (structure and rules), Part 8 ("Classification: direct/indirect per management needs"), Part 9 and invariant 22 ("when the purchase is consumed as cost"), Part 15 ("basis for monthly feed cost allocation").
- RPC_CONTRACTS_V1: §32 (WITHDRAWAL "below the operating result").
- POSTGRES_SCHEMA_SPEC_V1: Domain B (`expense_category`), and a new management source table.

As with ADR-001, ADR-002 and ADR-003, the FROZEN files are not rewritten. This ADR is the authoritative amendment.

---

## 1. Context

The Phase 24 pre-construction review found that these parts of the P&L had no deterministic source:
- Costos directos and indirectos;
- the cost-recognition timing;
- Retiros and Reservas internas;
- the fee, Mercado Pago, fiscal and yield treatments.

The owner resolved each one as follows.

## 2. Definitive P&L structure

```
Ventas netas devengadas
- Costos directos
- Costos indirectos
= Resultado operativo
+ Otros ingresos financieros            ← added by ADR-004
= Resultado antes de reinversión        ← added by ADR-004
- Reinversión
= Resultado post-reinversión
- Retiros
= Disponible post-retiros
- Reservas internas
= Post-reservas
- Inversiones
= Resultado post-inversiones
```

The P&L is derived and never stored. There is no manual results table, no stored subtotal, no materialised result and no editable result.

## 3. Decisions

**D1 — Sales authority.**
- Ventas netas devengadas come from `pedidos` with `estado = 'DELIVERED'` plus `pedido_lineas` where `is_current = true`.
- Amount: `SUM(subtotal)`. Date: `pedidos.delivered_date`.
- "Netas" means net of commercial rectifications and reversals, **not** net of IVA.
- Collections and financial postings create no revenue. `client_ledger` is not the revenue authority.

**D2 — Amount basis.** The V1 managerial P&L is gross of IVA:
- sales use the Pedido subtotals as recorded;
- purchases use `amount_total`;
- freight uses `freight.amount`.

This is managerial reporting, not statutory accounting.

**D3 — Operating cost recognition.**
- V1 implements **no** inventory accounting and **no** deferred COGS.
- An `OPERATING` purchase is recognised in full, at `amount_total`, on `economic_date`.
- The feed stock equation and the theoretical / real consumption figures remain productive controls. They never release that cost a second time.
- For V1, this resolves "purchases assigned to cost" and "when the purchase is consumed as cost".

**D4 — Direct / indirect classification.**
- New enum `expense_cost_class` (`DIRECT`, `INDIRECT`).
- New column `expense_category.pnl_cost_class`: **NOT NULL, no default**. Test fixtures set it explicitly, and real categories must be mapped explicitly before migration / cutover.
- What the class drives:
  - an OPERATING purchase takes the class of its category;
  - a Feria EXPENSE cash event takes the class of its category;
  - unallocated freight takes the class of its own category;
  - allocated freight follows the **destination purchase** (see D5).

**D5 — Freight.**
- Identity: `allocated + unallocated = freight.amount`.
- The allocated part follows the destination purchase:
  - OPERATING → the purchase category's DIRECT / INDIRECT class;
  - REINVESTMENT → Reinversión;
  - INVESTMENT → Inversiones.
- The unallocated part takes the freight category's class.
- Both parts are dated `freight.economic_date`; allocated freight is never backdated.
- Full freight and allocated freight are never counted together.

**D6 — Reinversión / Inversiones.**
- Current purchases only.
- `nature = 'REINVESTMENT'` → Reinversión; `nature = 'INVESTMENT'` → Inversiones.
- Amount `amount_total`, date `economic_date`, plus allocated freight per D5.
- A supplier payment is never counted.

**D7 — Retiros.**
- Feria `sales_session_cash_event` with `event_type = 'WITHDRAWAL'` → Retiros.
- `TRANSFER_OUT` and `OPENING_FUND` are not retiros.
- Outside Feria, the source is a `management_event` of type RETIRO (D9).

**D8 — Reservas internas.** The line is kept. Its source is a `management_event` of type RESERVA_INTERNA (D9). A reserve:
- affects the management result;
- moves no money;
- is not an expense, a fiscal fact or a Mercado Pago reserve.

**D9 — Management source events (RPC 43 `register_management_event`).**
- Stored in `management_event`: append-only source **decisions**, never calculated results.
- Columns: type (`RETIRO` or `RESERVA_INTERNA`), `effective_date` (the period determinant), `amount > 0`, `reason` (mandatory), `idempotency_key` (unique), and actor.
- Access: ADMIN only, period guarded, audited.
- A **RETIRO** carries a `financial_account_id` and creates **exactly one** treasury operation of the new type **`OWNER_WITHDRAWAL`**, with one posting: −amount for an original event, +amount for a compensation (money returned). Its `external_ref` is `'MGMT:' || key`, so keys are 1–95 characters.
- A **RESERVA_INTERNA** has no account, operation or posting.
- **Corrections and releases** are compensating events (`compensates_event_id`). History is never updated or deleted. A compensation must:
  - point to an existing original that is not itself a compensation;
  - have the same type;
  - keep cumulative compensations ≤ the original amount (`COMPENSATION_EXCEEDS_ORIGINAL`);
  - for a RETIRO, return money to the original's account (`ACCOUNT_MISMATCH` otherwise).
- **P&L authority:** the `management_event` row, never the OWNER_WITHDRAWAL operation.
- **Signs:** an original contributes −amount and a compensation +amount.

**D10 — Mercado Pago.** The authority for MP-specific components is `mp_financial_movement`.

| Component | P&L treatment |
|---|---|
| `payment` | no revenue; the sale is the Pedido |
| `payout` / `transfer` | no result |
| `fee_amount` | Costos indirectos, contribution −abs(fee_amount), dated `occurred_date`, once. A `FEE` financial operation is never counted. |
| `tax_amount` | excluded in V1 |
| `yield` (asset_management) | Otros ingresos financieros, contribution `net_amount`, dated `occurred_date` |
| `ADJUSTMENT` operations | excluded, unless a future ADR defines them |

**D11 — Fiscal.** The fiscal layer (`fiscal_document`, `fiscal_document_component`, `fiscal_obligation`, `fiscal_payment`) contributes **zero** direct P&L rows in V1. This covers IVA and every other tax kind.

**D12 — Session cash.**

| Event | P&L treatment |
|---|---|
| OPENING_FUND | nothing |
| TRANSFER_OUT | nothing |
| COUNT | nothing (observation) |
| EXPENSE | DIRECT or INDIRECT, by its category |
| WITHDRAWAL | Retiros |

**D13 — Financial operation matrix.** P&L is never derived from `operation_type`.
- No P&L effect: TRANSFER, COLLECTION, CHEQUE_CLEAR, CHEQUE_REJECTION, SUPPLIER_PAYMENT, INSTRUMENT_DEBIT, INSTRUMENT_DEBIT_REVERSAL, FREIGHT_PAYMENT, FISCAL_PAYMENT, MP_SETTLEMENT.
- FEE: not an authority; the MP fee component is.
- SESSION_CASH: its meaning comes from the cash-event subtype.
- ADJUSTMENT: no automatic meaning.
- OWNER_WITHDRAWAL: a treasury consequence only; the authority is the management event.

**D14 — Derived views and security.**
- `pnl_line_item`: one row per source-fact contribution.
- `pnl_summary`: every subtotal derived from `pnl_line_item`.
- Both views are `security_invoker = true`, filtered to ADMIN only, and granted to authenticated only. OPERATOR sees zero rows; anon and service_role have no grant.
- There is no SECURITY DEFINER reporting function.
- Signed contributions: income buckets are positive and deduction buckets negative.

## 4. Schema and RPC consequences

- New enums: `expense_cost_class`, `management_event_type`.
- New `financial_operation_type` value: `OWNER_WITHDRAWAL`.
- New column: `expense_category.pnl_cost_class` (NOT NULL).
- New table: `management_event` (RLS; ADMIN SELECT; RPC 43 is the only writer).
- New RPC 43 `register_management_event`. RPCs 23 and 24 remain UNASSIGNED.
- New views: `pnl_line_item`, `pnl_summary`.

## 5. Evidence

PHASE_24_PNL.md, and `scripts/target-db/pnl.test.mjs` (84 assertions).

## 6. Owner clarification — Phase 24 exit criterion (2026-09-25)

The original MASTER_ROADMAP wording ("Results derived from ledgers and postings") drifted from decision D1: the P&L is derived from the authoritative source facts (sales, purchases, freight, Feria, MP, management events), not from treasury postings, which are movements of money and not income or expense by themselves.

The owner ratified this exit criterion, which replaces only the Phase 24 criterion in MASTER_ROADMAP.md:

> Results derived from authoritative source facts, never stored. Financial movements are not income/expense by themselves. Transfers are excluded from results. Costs are not double-counted against purchases. Drill-down reaches source facts.

Nothing else changes: the phase status, order and every other criterion stay as they were.
