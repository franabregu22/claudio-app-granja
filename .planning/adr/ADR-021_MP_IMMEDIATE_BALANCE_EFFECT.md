# ADR-021 — A real Mercado Pago outflow affects the balance immediately; classification only gives it its meaning

**STATUS:** **ACCEPTED** (owner approval, GO "ADR-021 + IMPLEMENT MP IMMEDIATE BALANCE IMPACT + PENDING CLASSIFICATION UX",
2026-10-16).
**DATE:** 2026-10-16
**AMENDS (FROZEN):** ADR-006 §5.1 / V-4 / 0052 — "transfer / PAYOUT and outbound payments are never applied" — and ADR-020
§2.2 ("the outbound movement is created only inside a classification transaction"). Complements ADR-018 §15 and ADR-020.
**NOT AFFECTED:** `mp_v4_verified()` stays false (no report ↔ API payment equivalence is claimed); inbound report payment rows
stay parked (DEFERRED_V4); the automatic application A1 (approved payments, yields) is unchanged; ADR-020's tax / fee split is
unchanged; the global SOURCE_ID invariant (0091) holds for every new operation.

---

## 1. Problem

A payout or an outbound payment is real money that already left Mercado Pago: the official release report states its
SOURCE_ID, direction and total debit. Until now the ERP posted it only when a person classified it, so the ERP Mercado
Pago balance stayed above the official one in the meantime (15/10: ERP 255,245.86 vs official 32,590.90; the 222,654.96
gap is exactly the three unclassified debits 183240248717, 184280177388, 184327472972).

## 2. Decision

1. **Rule.** A confirmed real Mercado Pago monetary movement — unique SOURCE_ID, known direction, known total debit, report
   evidence — affects the Mercado Pago account balance immediately. Human classification decides its economic meaning later
   and never moves Mercado Pago a second time.
2. **Provisional effect (outflows).** When the release report is processed, every unposted monetary outflow — a `payout`
   (`<SOURCE_ID>:payout:D`, PAYOUT) or an outbound `payment` (`<SOURCE_ID>:payment:D`, OUTBOUND) — gets ONE provisional
   operation: `ADJUSTMENT`, external_ref `MP-PENDING:<SOURCE_ID>`, one posting of the report's **net** debit on Mercado
   Pago, reconciled to the movement in the same transaction (0091 holds). It is recorded once in `mp_pending_outflow`
   (one row per SOURCE_ID, immutable). It creates no purchase, no supplier debt, no withdrawal, no credit on any other
   account and no P&L line; it guesses nothing. User-facing label: **"Pendiente de clasificar"**.
3. **Classification.** Every route that classifies or confirms the outflow — Compra / gasto (casual purchase, purchase with a
   registered supplier, payment of a supplier debt), Retiro de socios, own-account transfer confirmation — in ONE transaction:
   (a) releases the provisional with its explicit reversal (`ADJUSTMENT`, `MP-PENDING-RELEASE:<SOURCE_ID>`, +net on
   Mercado Pago, reconciled to the movement) and records the resolution (`mp_pending_outflow_resolution`, immutable, audited);
   (b) writes the normal classified effect exactly as before (ADR-020: economic `|gross|` + tax ADJUSTMENT + fee FEE, or the
   transfer of `|net|` to the own account). Net result on Mercado Pago: the report's net debit, once. P&L: the economic
   amount once. Replays write nothing. Pending state = a provisional without a resolution (append-only; no UPDATE).
4. **No double effect, enforced.** A new reconciliation of a movement whose provisional is unresolved is refused
   (`MP_PENDING_NOT_RELEASED`) by a guard on `mp_reconciliation`; only the provisional / its release may link it. A route
   that forgot to release cannot debit twice.
5. **Non-monetary rows** (RESERVE, CONTROL, pre-cutover / ignored, ERROR) never post and never become pending.
6. **Ingest failure.** The provisional is attempted per row inside the report ingestion, isolated in a subtransaction (the
   same boundary already used for yields): the report evidence and every other row are kept; a failing row gets the
   appearance review code `PROVISIONAL_NOT_POSTED` and stays an **unposted outflow** — a technical exception
   (`fin_mp_technical_review`) — and its report day is not reconciled (`fin_mp_report_day_status` = INCOMPLETE). Recovery:
   `mp_post_pending_outflow(SOURCE_ID)` (ADMIN / service), idempotent; a later report repeating the row retries it too.
7. **Period close.** A management period cannot be closed while it holds unresolved monetary classification pendings
   (provisional outflows, and inflows awaiting classification): the close is refused (`PENDING_CLASSIFICATION`) with the
   count and the outgoing / incoming totals. Classifying into a closed period is not a normal path.
8. **Pending classification** (`fin_mp_pending_classification`, ADMIN): unresolved provisional outflows + inflows from an own
   account awaiting classification (CLASSIFY_INFLOW). Applied receipts without an assigned client ("Cobros sin cliente")
   are NOT pending classification: their money is already classified as a collection.

## 3. Consequences

- The ERP Mercado Pago balance equals the official balance as soon as the report is processed, before any classification.
- Classification routes keep their names, signatures and business effects; the only addition is the release step.
- Existing classified history is untouched (it has no provisional). Backfill is SOURCE_ID-based and idempotent (the three
  15/10 debits): expected ERP 15/10 close 32,590.90 = official.
- **Known limit (explicit follow-up):** an inflow from an own account (account_fund + DEBIN, CLASSIFY_INFLOW, 0086) still
  reaches the balance only when classified — it comes through the payment API path, not the report, and changing A1 is out
  of this decision. It is counted as pending classification and blocks the period close; its immediate effect is a separate
  decision.
