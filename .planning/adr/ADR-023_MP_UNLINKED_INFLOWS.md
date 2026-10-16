# ADR-023 — Mercado Pago inflows: "Entradas sin vincular" (optional enrichment, never a mandatory classification)

**STATUS:** **ACCEPTED** (owner approval, GO "ADR-023 + 0095 + FRONTEND FIXES", 2026-10-16).
**DATE:** 2026-10-16
**AMENDS (FROZEN):**
- ADR-021 / 0093 — an inflow from an own account (account_fund + DEBIN) "reaches the balance when classified" and counts as a
  pending classification that blocks the period close → replaced by §2.1–§2.3.
- ADR-022 / 0094 — historical CVU / DEBIN inflows are "pending classification" (kind INFLOW) → they are optional unlinked
  inflows (§2.4). The immutable ADR-022 evidence (`mp_pending_outflow` rows of kind INFLOW, provisionals) is NOT deleted nor
  modified; only the workflow / view semantics change.
- 0086 §4 — `mp_is_auto_applicable` no longer excludes account_fund + debin_transfer.

**NOT AFFECTED:** outflow classification (ADR-019 / ADR-020 / ADR-021: payouts and outbound payments stay mandatory and keep
blocking the close), the ADR-022 balances, the global SOURCE_ID invariant (0091), `mp_v4_verified()`, `assert_period_open`.

---

## 1. Context

Most Mercado Pago inflows are ordinary customer payments (e.g. one maple for 7,500). Requiring the owner to classify hundreds of
them one by one is not operationally viable, and an unclassified inflow is not an accounting gap: the money is in Mercado Pago.
What an inflow does NOT prove by itself is the customer, the sale or an own-account origin — commercial recognition stays with
orders / deliveries (unchanged: no Mercado Pago movement creates revenue).

## 2. Decision

1. **A real inflow affects the Mercado Pago balance immediately** — live payments (unchanged), live account_fund + DEBIN (new:
   applied by the A1 plan like any approved payment), historical CVU / DEBIN / receipts (already posted by ADR-022).
2. **"Entrada sin vincular" is a valid permanent state.** An unlinked inflow does not require classification, does not appear in
   "Pendientes de clasificar", does not block the period close and creates no P&L.
3. **Optional enrichment only:**
   - *Vincular a cliente*: `mp_allocate_to_client` (extended to `payment` AND `inflow` APPROVAL movements). It never posts Mercado
     Pago again, never creates P&L, cannot exceed the unallocated amount, one allocation per idempotency key; reversal through
     `mp_reverse_client_allocation` (unchanged).
   - *Transferencia desde cuenta propia*: the existing 0086 route for account_fund inflows (MP balance unchanged; the bank line is
     matched to the transfer's source posting — never a second bank movement).
   - *Dejar sin vincular*: no action.
   Suggestions (amount / date / receivable) are hints only; only the existing deterministic payer → client mapping may allocate
   automatically (0053, unchanged). Historical inflows are never auto-allocated.
4. **Historical ADR-022 inflows** (CVU 749 / 12,305,080.80, DEBIN 190 / 1,843,373.00, receipts 3,650 / 72,961,861.70) are
   unlinked inflows. The historical mandatory pendings are only the outflows: OUTBOUND 91, PAYOUT 101.
5. **Period close** is blocked only by unresolved real outflows (OUTBOUND, PAYOUT) and by real outflows that could not be posted
   (MP_UNPOSTED_OUTFLOWS). Inflows of any kind never block it.
6. **Closed-period linking (owner decision).** When `mp_allocate_to_client` is called without an explicit date, the allocation
   date is the movement's date if that month is OPEN, otherwise the current Buenos Aires business date (a closed or missing
   period is never reopened nor backdated). The allocation records the source SOURCE_ID, the source date and the rule applied;
   the UI shows "Movimiento recibido: <fecha original>" / "Vinculado al cliente: <fecha efectiva>". An explicit date keeps the
   previous contract (≥ movement date, period open).
7. **Security.** No API role can read a full payout account number: `mp_historical_row.raw_row` is not readable by any API role
   (column privileges), and the historical source records whose evidence holds `PAYOUT_BANK_ACCOUNT_NUMBER` are hidden from the
   ADMIN policy of `mp_source_record` (service role and SECURITY DEFINER functions keep server-side access; the private
   `mp_historical_destination` is unchanged). Curated views expose at most the last 4 digits.
8. **Pending dashboard.** Counts and totals come from a server-side aggregate (`fin_mp_pending_summary`), never from downloading
   rows; lists are paginated and current pendings are queried apart from historical ones.

## 3. Consequences

- 0095: `mp_is_auto_applicable`, `mp_pending_classification_totals` (outflows only), `fin_mp_pending_classification` (outflows
  only; current / historical flag, payout destination status, masked last 4), `fin_mp_unlinked_inflows`,
  `fin_mp_pending_summary`, `mp_allocate_to_client`, the raw-evidence privileges. No financial backfill: ADR-022 inflows are
  already in the balance.
- Account_fund + DEBIN payments left unapplied before 0095 (CLASSIFY_INFLOW) keep their legacy routes; a production gate must
  STOP and report them before any backfill decision.
- Caja: "Pendientes de clasificar" (mandatory outflows only) / "Entradas sin vincular" (optional, paginated, filters) / "Cobros
  vinculados".
