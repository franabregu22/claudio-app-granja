# ADR-020 — Mercado Pago outbound payments are classifiable movements

**STATUS:** **ACCEPTED** (owner approval, GO "META A FINAL CLOSURE IMPLEMENTATION", 2026-10-15).
**DATE:** 2026-10-15
**AMENDS (FROZEN):** ADR-006 §5.1 / 0051 header — "transfer/PAYOUT and OUTBOUND_PAYMENT are never applied" — ONLY for
OUTBOUND_PAYMENT, and ONLY through an explicit user classification. Payouts were already made classifiable by 0087 / 0089.
**NOT AFFECTED:** `mp_v4_verified()` stays false; the V-4 report↔API payment equivalence is NOT claimed; inbound report
payment rows stay parked (DEFERRED_V4); automatic application (A1) is unchanged; no category is inferred automatically.

---

## 1. Problem

Money the account pays from its Mercado Pago balance — QR / in-store purchases, transfers to third-party CVU / CBU — appears
in the official release report as a `payment` row with a DEBIT (`<SOURCE_ID>:payment:D`). Today such a row is parked
(`PENDING`, `DEFERRED_V4`) and has no `mp_financial_movement`, so it can never be applied: the ERP Mercado Pago balance stays
above the official balance by the sum of these payments (566,446.70 between 06/10 and 13/10).

## 2. Decision

1. An outbound payment becomes a **classifiable outflow**, exactly like a payout. Its external identity is the report
   SOURCE_ID; its movement identity is `('report', '<SOURCE_ID>:payment:D', 'OUTBOUND', '')`, one per SOURCE_ID.
2. The movement (`movement_kind = 'outbound'`, gross / fee / tax / net from the report row, parsed by the frozen
   `mp_parse_report_row`) is created **only inside a classification transaction** (never stuck, never automatic). The
   evidence (source record, report lines) is never modified; the source record's processing status becomes RECONCILED
   when the movement is fully assigned.
3. The user classifies it through the SAME routes as a payout (0088 / 0089): Compra / gasto (registered supplier, debt
   payment, casual purchase), Retiro de socios. `mp_classify_payout_outflow` and `register_casual_purchase` keep their
   names and signatures and resolve either kind through `mp_outflow_resolve`.
4. **Tax / fee split:** the economic route receives the economic amount `|gross|` (purchase, supplier payment, withdrawal);
   the debit / credit tax (`TAXES_AMOUNT`, ley 25.413, 0.6%) is a separate ADJUSTMENT operation and any payer fee a FEE
   operation — the same semantics the automatic application already uses for inbound payments. The Mercado Pago account
   goes down exactly once by the report's net debit; the P&L carries the purchase only (as for inbound taxes, the MP tax
   operation is not a P&L line). Example: 102,803.00 purchase + 616.82 tax = −103,419.82 on Mercado Pago.
5. Outbound payments carry no destination CBU evidence: the own-account check of payouts does not apply; the user decides.
   Own-account transfers by outbound payment are out of scope (none observed).
6. One SOURCE_ID → at most one economic classification (`mp_outflow_classification`), whatever the entry point.

## 3. Consequences

- The ERP Mercado Pago balance converges to the official balance once every outbound payment is classified.
- 0090 implements this; 0091 adds the global invariant that every NEW operation moving the Mercado Pago account is linked
  to an MP movement (or to an explicit, audited ADMIN exception).
