# ADR-022 — Historical Mercado Pago reconstruction (01/02 → cutover) and replacement of the cutover opening

**STATUS:** **ACCEPTED** (owner approval, GO "ADR-022 + LOCAL IMPLEMENTATION OF FULL HISTORICAL MP RECONSTRUCTION", 2026-10-16).
**DATE:** 2026-10-16
**AMENDS (FROZEN):** ADR-017 / 0071 — "report and API rows before the cutover are IGNORED (PRE_CUTOVER_INCLUDED_IN_OPENING_BALANCE)"
— ONLY for the controlled reconstruction path defined here. The runtime ingestion, the worker, the cutover guard and every
other route keep ignoring pre-cutover rows. Complements ADR-021 (pending classification).
**NOT AFFECTED:** post-cutover history (Meta A, ADR-021, the 15/10 reconciliation, current classifications), `mp_v4_verified()`,
`assert_period_open` for every normal route, the global SOURCE_ID invariant (0091).

---

## 1. Evidence

Canonical timeline = Liberaciones1 (01/02–30/04) + Liberaciones2 (01/05–04/07) + Liberaciones3 (04/07–04/09 09:44:48) + the
16-column release report `reserve-release-1054315166-manual-2026-10-16-153213` (01/09 → 04/10). Identity
`<SOURCE_ID>:<DESCRIPTION>:<C|D>` (the production `csv_import` identity); overlaps (L2/L3 on 04/07, L3/new on 01–04/09: 34 rows,
identical) are deduplicated. Dry-run from 0.00 on 01/02: 0 continuity breaks; 30/04 2,463,349.92; 31/08 71,362.90; 04/09
09:44:48 172,814.62; 04/09 close 902,410.62; 30/09 close 0.00; last pre-cutover row 03/10 14:59:40 → **2,018,686.98 = the
`phase31_opening` of Mercado Pago, gap 0.00**. One row (181403811707, +49.70, 04/10 20:36 BA) is post-cutover production history
and is excluded. BASECSV is validation only, never financial truth.

## 2. Decision

1. **Staging (evidence).** `mp_historical_stage(file, sha256, rows)` (ADMIN) stores each canonical row once
   (`mp_historical_row`, immutable; a repeated identity must be byte-identical, else refused). Rows at/after the production cutover
   boundary (`mp_cutover_boundary.cutover_at`) are excluded and counted, never stored. A payout destination of a 16-column report
   is stored apart (`mp_historical_destination`, private, append-only): richer evidence never creates a second effect.
2. **Reconstruction.** `mp_historical_reconstruct(expected_total, reason)` (ADMIN) replays every staged row from 0.00 in canonical
   order in ONE transaction: each row's BALANCE_AMOUNT must equal the running balance (continuity), the final balance must equal
   the Mercado Pago `phase31_opening` AND the caller's expected total (exact, to the cent); otherwise the whole reconstruction
   aborts. Every real monetary row affects Mercado Pago exactly once, reconciled to its movement (0091 holds):
   - receipts (account money, cards, digital currency) → the A1 plan (MP_SETTLEMENT gross + tax ADJUSTMENT + fee FEE), unassigned
     (no client, no sales assumption);
   - yields → the A1 plan; financial income in the historical P&L exactly once (as every yield);
   - CVU / DEBIN inflows, outbound payments, payouts (third party, unknown destination, own-account candidates) → the ADR-021
     provisional (`MP-PENDING:<SOURCE_ID>`), pending classification, no P&L, no purchase, no withdrawal, no client allocation;
   - reserves → evidence only.
3. **Own-account payouts** (destination = an active own CBU): only the Mercado Pago debit, tagged
   OWN_ACCOUNT_TRANSFER_CANDIDATE; the bank side is NOT created (the banks have their own history / cutover).
4. **Opening replacement.** In the same transaction, an explicit, audited ADJUSTMENT `MP-HIST-OPENING-NEUTRALIZATION:<opening>`
   of −opening on the opening's date neutralizes the economic role of `phase31_opening` (never deleted nor modified), recorded as
   an audited source exception (kind OPENING_NEUTRALIZATION). Net effect on every Mercado Pago balance at/after the cutover: 0.00.
5. **Period close.** No period is reopened. The reconstruction function is the only, narrowly scoped exception: ADMIN, explicit,
   pre-cutover rows of staged evidence only, audited. `assert_period_open` is unchanged for every other route; classifying a
   historical pending movement into a closed period needs a future explicit historical-correction path.
6. **Idempotency.** Staging the same file again writes nothing; a reconstruction replay writes nothing (`replayed`).

## 3. Consequences

- The Mercado Pago account carries its full history from 01/02; balances from the cutover on are unchanged.
- ~4,900 historical movements; 1,124 pending classification (CVU 749, DEBIN 190, outbound 91, payouts 94 incl. 7 own-account
  candidates). Historical pendings block the close of their (historical) periods, as ADR-021 requires.
- A regenerated 16-column report for 01/02–04/09 may later enrich payout destinations (no balance change).
