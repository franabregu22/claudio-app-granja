# ADR-006 TEST MATRIX V1

**Status:** implementation design. The tests are specified, not written.

**Harnesses:**
- **DB:** `scripts/target-db/mp_realtime.test.mjs`, following the existing target-db suite pattern (guarded local stack at 127.0.0.1:54322; fixtures inserted as owner; RPC calls as `service_role` or as an ADMIN / OPERATOR JWT via `SET LOCAL ROLE` + `request.jwt.claims`). It runs after `mp.test.mjs`, which is **amended** as described in §P23. It is not claimed to be unchanged.
- **Worker and webhook:** `mpWorkerCore.test` and `verifySignature.test`, pure-module tests with injected mocks: MP API, clock, DB adapter against the local stack.
- **Never used:** real MP credentials or production.

**Common fixture:**
- MP account = the seeded "Mercado Pago" account;
- period 2026-10 OPEN;
- clients X and Y active; client Z inactive;
- ADMIN uid A; OPERATOR uid O;
- payment P1: gross 100.00, `fee_details` [5.00], tax 2.00, net 93.00 (expressed in the V-2-confirmed MP fields; tests that consume payment payloads — W-3, F, N, T, R — are written after V-2 from sanitized real-shaped fixtures. Before V-2, the C block and R-9 run on owner-inserted movements with no API payload), approval date 2026-10-05T12:00:00-03:00, collector = the fixture collector.

The "Assert" column lists exact row deltas. `Δ` means the change in row count.

---

## W — Webhook and delivery

| ID | Case | Setup / action | Assert |
|---|---|---|---|
| W-1 | Valid payment notification | signed request, notification id n1 (if V-1 documents one), `x-request-id` r1, `data.id` P1 | 200; Δ delivery = 1 (RECEIVED, `topic_class` payment, `delivery_key 'n:payment:n1'`, or `'h:<sha>'` when no documented id; `x_request_id = r1` stored, **not** the key; reduced payload keys ⊆ allowed); no other table changed |
| W-2 | Same notification retried with a **different** `x-request-id` | the W-1 body byte-identical, r2 | 200; Δ delivery = 0 (same key, same `notification_sha256`); proves `x-request-id` is not the identity |
| W-2b | Same notification retried with the **same** `x-request-id` | repeat W-1 exactly | 200; Δ delivery = 0 |
| W-2c | Same key, **different content** | forge a second notification with the same documented notification id but a different `action` / `resource_id` (valid signature in the test harness) | 200; Δ delivery = 1: a conflict row with `delivery_key` = `'conflict:' ‖ sha256(W-1 key ‖ ':' ‖ new hash)` (`length = 73`), `key_conflict_of` = the W-1 row; processed normally; the original row is unchanged; `report_mp_delivery_health.key_conflicts` = 1; never merged |
| W-2d | Conflicting notification replayed | repeat the W-2c notification | 200; Δ delivery = 0; S1 returns `{created: false, key_conflict: true}` with the W-2c row id; no unique violation |
| W-2e | Second, different conflicting content | a third notification with the W-1 key and yet another `action` | Δ delivery = 1 (a distinct conflict key); `key_conflict_of` = the **W-1** row (not the W-2c row); `key_conflicts` = 2 |
| W-2f | N-SHA determinism | the same fields submitted with the JSON payload keys in a different order / whitespace; `action` NULL vs `''` | same hash for the reordered payload; **different** hashes for NULL vs `''`; the hash equals an independent SQL evaluation of the N-SHA formula |
| W-2g | Key bound | an over-long / invalid documented notification id (> 120 chars) | falls back to the `'h:'` key; every stored `delivery_key` length ≤ 200 (a CHECK-style assertion over all rows) |
| W-3 | New notification for the same payment | a new notification id n2 (for example `payment.updated`), `data.id` P1 | 200; Δ delivery = 1; after the worker runs: Δ source = 0 (same hash) or 1 (changed version), Δ movement = 0, Δ operation = 0 |
| W-9 | Chargeback notification (topic per V-1) | a signed chargeback notification, chargeback id c1 | 200; Δ delivery = 1 with `topic_class` chargeback, status RECEIVED, **not** UNSUPPORTED; Δ source / movement / operation / posting / allocation = 0 |
| W-10 | Chargeback retried | repeat W-9 | Δ delivery = 0 |
| W-4 | Signature failure | tampered signature / missing header / stale ts | 401; Δ every table = 0; the log line holds no body or signature |
| W-5 | Foreign collector / `live_mode` false | valid signature, `user_id` ≠ config | 200; Δ = 0 |
| W-6 | Unsupported topic | `type = 'merchant_order'` | 200; Δ delivery = 1 with status UNSUPPORTED; the worker ignores it |
| W-7 | DB unavailable at insert | fault-inject the S1 failure | 500 (MP will retry); Δ = 0 |
| W-8 | Oversize / non-POST / non-JSON | — | 413 / 405 / 400; Δ = 0 |

## F — Fetch, retry and worker

| ID | Case | Setup / action | Assert |
|---|---|---|---|
| F-1 | API timeout | mock timeout | delivery FAILED_RETRYABLE, `attempts` 1, `next_attempt_at` = +1 min, code MP_UNAVAILABLE, `first_failed_at` set |
| F-2 | API 429 with Retry-After 120 | — | `next_attempt_at` = +120 s; code MP_RATE_LIMIT |
| F-3a | API 401 | mock 401 for P1 | delivery CONFIG_BLOCKED, `last_error_code` AUTH_CONFIGURATION_ERROR; Δ source / movement / operation / allocation / audit = 0; error log `MP_AUTH_CONFIGURATION_ERROR` without token or payload; `report_mp_delivery_health.auth_configuration_error = true`; axis A REVIEW_REQUIRED for P1 |
| F-3b | API 403 (forbidden / scope) | mock 403 | same as F-3a (detail `http 403`) |
| F-3c | Circuit breaker | 5 claimed deliveries; the 1st gets 401 | the 1st is CONFIG_BLOCKED; the other 4 are RELEASE → back to RECEIVED with `attempts` unchanged versus before the claim; the invocation stops; the MP mock received exactly 1 request |
| F-3d | No hot retry | after F-3a, run the worker 60 times (simulated 60 min) with the credential still broken | `mp_claim_deliveries` never returns the CONFIG_BLOCKED row; MP mock requests for P1 = 0 beyond the initial one (the hourly probe excepted: ≤ 1 per simulated hour); the row is still CONFIG_BLOCKED after a simulated 72 h (never FAILED_PERMANENT); Δ audit = 0 |
| F-3e | Configuration correction + safe requeue | fix the mock credential; ADMIN `mp_requeue_config_blocked('token rotated')` | the row becomes RECEIVED; the next worker pass gives FETCHED; exactly 1 source, 1 movement, 3 operations (T-1 totals); audit `MP_DELIVERY_REQUEUE` × 1; a second requeue call gives `{requeued: 0}` and Δ audit = 0 |
| F-3f | Automatic probe recovery | the credential fixed without an explicit requeue; advance 1 h | exactly 1 probe request; 200 → requeue (audit actor NULL, reason `auto: credential probe succeeded`); then as F-3e |
| F-3g | Repeated identical 401 after requeue | requeue while the credential is still broken | the row goes back to CONFIG_BLOCKED; `attempts` +1; Δ source / financial / audit (except the one requeue audit) = 0 |
| F-4 | 404 then 200 | first 404, then success | first RETRY; second pass FETCHED; exactly one source |
| F-5 | 48 h exhaustion | clock +49 h with repeated 5xx | FAILED_PERMANENT; the payment is REVIEW_REQUIRED (if known) |
| F-6 | 400 | — | FAILED_PERMANENT immediately, MP_BAD_REQUEST |
| F-7 | Collector mismatch in payload | — | FAILED_PERMANENT COLLECTOR_MISMATCH; Δ source = 0 |
| F-8 | Worker crash after the delivery claim | kill after S2 | the lease expires; a second worker re-claims; exactly one source, one movement, 3 operations |
| F-9 | Crash after the source insert | kill after S4 | the next pass runs RPC 40; totals as F-8 |
| F-10 | Crash after the financial posting | kill after A1 commits, before S3 | the next pass: A1 → ALREADY_APPLIED; Δ operation / posting / reconciliation / audit = 0; delivery FETCHED |
| F-11 | Concurrent worker claims | two workers call `mp_claim_deliveries(10, 120)` simultaneously on 10 due rows | disjoint claim sets; union = 10; no row is processed twice; each returned row has exactly the columns `delivery_id, claim_token, origin, topic_class, topic, resource_id, attempts` in that order, and `topic_class` equals the stored value |
| F-14 | Invalid link payment id | `mp_delivery_transition(d, t, 'SIGNAL_RECORDED', NULL, NULL, NULL, NULL, 'abc')` on a claimed chargeback delivery | INVALID_PAYMENT_ID; the row is still PROCESSING with its token; `signal_resolution` NULL; Δ `chargeback_refresh` deliveries = 0 |
| F-15 | Link id on an unrelated outcome | `mp_delivery_transition(d, t, 'FETCHED', src, NULL, NULL, NULL, '123')` | INVALID_ARGUMENT; no state change |
| F-12 | Stale worker after lease loss | worker 1 is slowed past the lease; worker 2 completes | worker 1's S3 → CLAIM_LOST; totals unchanged |
| F-13 | Out-of-order webhook | a `payment.updated` (refunded) delivery processed before `payment.created` | final state: APPROVAL movement + refund movement, each exactly once; the later "created" delivery → the same hash or an older state → Δ movement = 0 |

## N — Normalization and versions

| ID | Case | Assert |
|---|---|---|
| N-1 | Valid payment P1 | source api_payment NORMALIZED; 1 movement (payment, 100 / −5 / −2 / 93, occurred_date 2026-10-05); 1 identity ('payment', P1, 'APPROVAL', '') |
| N-2 | Duplicate same resource | identical payload → same `external_id`; Δ source = 0 |
| N-3 | Changed payment version | payload with a new `date_last_updated` / status → new source version; RPC 40 → IGNORED NO_NEW_TRANSITION; Δ movement = 0; the old version is byte-identical |
| N-4 | Pending / rejected payment | IGNORED NO_FINANCIAL_TRANSITION; Δ movement = 0 |
| N-5 | Arithmetic mismatch | **amended by the V-2 gate (tax is the documented residual, so "net 92.99" is now a valid payment with tax −2.01):** net exceeding gross + fee (positive residual tax, e.g. gross 100 / net 100.01) → ERROR `SIGN_INVALID`; > 2 decimals → `MALFORMED_AMOUNT`; malformed `fee_details` → `MALFORMED_FEE_DETAILS`; Δ movement = 0; view REVIEW_REQUIRED |
| N-6 | Unknown operation_type / currency USD | ERROR UNKNOWN_OPERATION_TYPE / UNSUPPORTED_CURRENCY |
| N-7 | Refund discovery | **DEFERRED** (V-2 §15.1: refund discovery disabled until real refund evidence). Retained: a snapshot with 2 approved refunds → 2 `api_refund` children created (PENDING); after normalization, 2 refund movements, 2 identities with the refund ids |
| N-8 | Refund exceeding the payment | **DEFERRED** (as N-7). Retained: ERROR REFUND_EXCEEDS_PAYMENT |
| N-11 | Refund evidence fails closed (V-2 §15.1) | each of: `refunds[]` non-empty; `transaction_amount_refunded ≠ 0`; `status = 'refunded'`; `approved` + `partially_refunded` → ERROR `REFUND_UNSUPPORTED`; Δ claim / movement / `api_refund` source = 0; an earlier APPROVAL movement is untouched |
| N-12 | Documented-only components (V-2 §15) | real-shaped V-2 fixtures (`adr006-v2-payments.json` A1–H1): fee = −Σ collector `fee_details` (0), tax = net − gross − fee, net = `net_received_amount`; changing `taxes_amount` or `charges_details` values in the payload changes **nothing** in the movement; payer-borne `processing_fee` (C1 / C2) does not affect fee |
| N-13 | Dispute without an approval | first snapshot `charged_back` (or `in_mediation`) with no APPROVAL identity → ERROR `DISPUTE_WITHOUT_APPROVAL`; Δ movement = 0; with an existing APPROVAL → IGNORED `NO_NEW_TRANSITION` plus the R-7 alert |
| N-14 | Operation type and status gates | inbound `money_transfer` / `account_fund` + `approved` / `accredited` → APPROVAL; `regular_payment` / `pos_payment` inbound → ERROR `UNKNOWN_OPERATION_TYPE`; `approved` with any `status_detail` other than `accredited` and no refund evidence → no APPROVAL, ERROR `UNKNOWN_STATUS` |
| N-9 | Direct forged api_payment insert | **Step 6:** a direct insert whose `external_id` / `occurred_at` do not equal the S4 derivation → RPC 40 ERROR `IDENTITY_MISMATCH` / `DATE_MISMATCH`, Δ movement = 0. **Step 9 (the RLS migration):** the service-role `INSERT` itself → RLS violation (R4), as B4 / D7 (§P23-T) |
| N-10 | Liberaciones regression | the amended `mp.test.mjs` (§P23) passes; unaffected ADR-003 assertions unchanged; payment rows → PENDING `DEFERRED_V4` with zero movement, identity, match, operation, posting, allocation and client-ledger rows |

## T — `mp_apply_transition` (critical path)

| ID | Case | Assert |
|---|---|---|
| T-1 | Gross / fee / tax atomicity | 3 operations (MP_SETTLEMENT +100, FEE −5, ADJUSTMENT −2), each with exactly 1 posting on the MP account; external_refs `MP:MPA:{t}:SETTLE/FEE/TAX`; Σ assigned 93; source RECONCILED; MP balance Δ +93; client_ledger Δ 0; collections Δ 0 |
| T-2 | No intermediate cap violation | the same data through sequential RPC 41 calls (+100 first) → OVER_ASSIGNMENT (documents the reason for A1); A1 succeeds |
| T-3 | Exact replay | a second A1 call → ALREADY_APPLIED; Δ every table = 0, audit included |
| T-4 | Mismatched replay | after T-1, the ADMIN makes an RPC 41 counter-assignment (FEE +1 / ADJUSTMENT −1 pair) → A1 → TRANSITION_ALREADY_ASSIGNED; Δ = 0; view REVIEW_REQUIRED only if the source is no longer RECONCILED |
| T-5 | Orphan external_ref | pre-insert an operation with `external_ref 'MP:MPA:{t}:FEE'` and no reconciliation → EXTERNAL_REF_CONFLICT; Δ = 0 |
| T-6 | Fault injection mid-apply | force a failure on the 3rd posting (test-only trigger) → Δ every table = 0 |
| T-7 | Closed management period | close 2026-10 → A1 → PERIOD_CLOSED; Δ = 0; RPC 41 on the movement → AUTO_APPLICATION_PENDING; reopen → the sweep applies; T-1 totals |
| T-8 | Zero components | fee 0, tax 0 → exactly 1 operation (SETTLE = net) |
| T-9 | Payout never auto-applied | a Liberaciones payout movement → A1 NOT_AUTO_APPLICABLE; RPC 41 Mode 2 to a transfer still works |
| T-10 | Yield | a Liberaciones yield row → claimed, REPORT_ONLY match, A1 → 1 MP_SETTLEMENT = net; P&L Otros ingresos financieros once |
| T-11 | RPC 41 guard | before A1, the ADMIN tries Mode 1 on the P1 movement → AUTO_APPLICATION_PENDING |
| T-12 | P&L fee exactly once | after T-1 plus a Liberaciones row for P1 (with V-4 enabled in a test-only branch) → `pnl_line_item` has exactly one MP fee line of −5 |

## C — Client attribution

| ID | Case | Assert |
|---|---|---|
| C-1 | Anonymous Feria receipt | after T-1, no allocation; axis A POSTED; axis B CLIENT_UNASSIGNED; not listed in any work view |
| C-2 | Manual allocation | ADMIN allocates 100 to X → client_ledger Δ 1 (COLLECTION −100, source `mp_client_allocation`/id); allocation Δ 1; operation / posting / collections Δ 0; audit Δ 1; axis B CLIENT_ASSIGNED |
| C-3 | Auto deterministic (payer map) | a map exists for the payer → the worker's C2 → AUTO allocation 100 to X, key `MPAUTO:{t}` |
| C-4 | Auto deterministic (external_reference) | `external_reference 'GST:C:<X>'` → AUTO to X |
| C-5 | No-evidence auto | no reference, no map → `{allocated: false, NO_EVIDENCE}`; Δ = 0 |
| C-6 | Ambiguous evidence | reference → X, map → Y → AMBIGUOUS_EVIDENCE; Δ = 0 |
| C-7 | Partial allocation | 40 to X → CLIENT_PARTIAL; active 40 |
| C-8 | Split across clients | 40 to X, 60 to Y → CLIENT_ASSIGNED; two ledger rows |
| C-9 | Concurrent allocations | two sessions each allocate 60 at once → exactly one succeeds; the other ALLOCATION_EXCEEDS_RECEIPT; active 60 |
| C-10 | Over-allocation | allocate 101 → ALLOCATION_EXCEEDS_RECEIPT; Δ = 0 |
| C-11 | Wrong allocation reversal | allocate 100 to X by mistake → reverse 100 → allocate 100 to Y; X's balance returns to its prior value; Y −100; 4 allocation rows, 3 ledger rows; nothing updated or deleted |
| C-12 | Reversal beyond the allocation | reverse 120 of 100 → REVERSAL_EXCEEDS_ALLOCATION |
| C-13 | Inactive client / date before the receipt / closed period | Z → CLIENT_NOT_FOUND_OR_INACTIVE; `effective_date` 2026-10-04 → EFFECTIVE_DATE_BEFORE_RECEIPT; a closed period → PERIOD_CLOSED |
| C-14 | Allocation before posting | allocate on a NORMALIZED (unapplied) movement → RECEIPT_NOT_POSTED |
| C-15 | Service role cannot pick a client | service role calls `mp_allocate_to_client` → FORBIDDEN; it has no parameterised path |
| C-16 | Flag lifecycle | flag → CLIENT_RESOLUTION_REQUESTED (the only work item); full allocation auto-clears it; `clear_reason` FULLY_ASSIGNED |
| C-17 | Duplicate MANUAL key | the same key again → DUPLICATE_ALLOCATION; Δ = 0 |

## R — Refunds, chargebacks, OD-1

**V-2 gate note (2026-09-28):** the API-refund cases (R-1…R-6, R-9…R-11) are **DEFERRED**. Refund discovery is disabled until a real refund is evidenced (V-2 §15.1). They are retained unchanged for that amendment. Chargeback cases R-7, R-12…R-14 stay active; R-8 stays blocked on a real report CHARGEBACK row.

| ID | Case | Assert |
|---|---|---|
| R-1 | Partial refund with an allocation | P1 allocated 60 to X; refund 30 → MP_SETTLEMENT −30; X REVERSAL +30 (MP_REVERSAL row −30, key `MPREV:…`); active 30; effective receipt 70 |
| R-2 | Full refund | P1 allocated 40 X + 60 Y (Y newer); refund 100 → Y +60, then X +40 (newest first); active 0; MP −100 |
| R-3 | Refund beyond the attribution | allocated 20; refund 50 → restore 20 only; MP −50 |
| R-4 | Refund without an allocation | refund 30 → MP −30; client_ledger Δ 0 |
| R-5 | Single-allocation evidence | one active allocation → it is chosen regardless of age |
| R-6 | Refund replay | A1 again → ALREADY_APPLIED; client_ledger Δ 0 |
| R-7 | Chargeback via API | status `charged_back` → no movement; view REVIEW_REQUIRED with CHARGEBACK_ALERT; the MP balance is unchanged until the report (V-3) |
| R-8 | Chargeback via report | **V-3 + V-4 blocked**; specified now, enabled when the parser is frozen: movement −amount, OD-1 as R-1 |
| R-9 | Allocation after a refund | after R-1 (effective applied receipt 70, active 30), allocate 41 → ALLOCATION_EXCEEDS_RECEIPT; 40 → ok |
| R-10 | Unapplied reversal keeps the invariant | P1 gross 100 posted, attributed 100 to X; refund 30 normalized; period of the refund date CLOSED → A1 → PERIOD_CLOSED | after the failure: MP balance +93 (payment only; no −30); active attribution 100; effective applied receipt 100; `0 ≤ 100 ≤ 100` holds; axis A REVIEW_REQUIRED (unapplied reversal); X ledger unchanged. Reopen the period → A1 commits in one transaction: MP_SETTLEMENT −30, X REVERSAL +30, allocation −30 → effective applied receipt 70, active 70; the invariant holds after every commit |
| R-11 | Allocation while a reversal is unapplied | P1 attributed 50; refund 30 normalized but unapplied (closed period) | allocate 50 more → allowed (bound = applied receipt 100) → active 100; after A1: unwind min(30, 100) = 30 → active 70 ≤ 70 |
| R-12 | Chargeback signal linked automatically | W-9 with a V-1/V-2-documented payment reference P1; the worker calls `mp_delivery_transition(d, t, 'SIGNAL_RECORDED', NULL, NULL, NULL, NULL, '<P1>')` | the signal delivery SIGNAL_RECORDED, `signal_resolution` LINKED (actor NULL); Δ delivery +1 `chargeback_refresh` for P1 (key `cbrefresh:…`); after the refresh FETCHED with a chargeback status → REVIEW_REQUIRED (derived alert); Δ operation / posting / allocation / client_ledger = 0 |
| R-13 | Chargeback signal without a payment reference | W-9 where no documented reference exists | SIGNAL_RECORDED, unresolved; health view `unresolved_chargeback_signals` = 1 (REVIEW_REQUIRED); ADMIN `mp_resolve_chargeback_signal(LINKED, P1)` → refresh enqueued; a second resolve → ALREADY_RESOLVED; ADMIN DISMISSED on another signal → resolved with no financial effect |
| R-14 | Chargeback signal idempotency | W-9 twice, and the worker run twice | 1 signal delivery, ≤ 1 refresh delivery; Δ financial = 0 |

## M — Report reconciliation

| ID | Case | Assert |
|---|---|---|
| M-1 | Report MATCHED | (V-4 enabled in a test-only branch) a Liberaciones row equal to P1 → IGNORED MATCHED_TO_TRANSITION; match MATCHED; Δ movement / operation = 0 |
| M-2 | Report DISCREPANCY | a row with fee −6 → match DISCREPANCY `detail.fee {report −6, recorded −5}`; no financial write; view REVIEW_REQUIRED; resolve CORRECTED requires a later RPC 41 correction (NO_CORRECTION_FOUND otherwise) |
| M-3 | Report-only movement | a yield row → claim, movement, REPORT_ONLY, applied once |
| M-4 | Missing in report | an API transition dated in the window with no report row → `mp_check_report_coverage` → MISSING_IN_REPORT; a rerun gives Δ = 0. Report-only kinds only while V-4 is open |
| M-5 | Report before API (back-fill) | (V-4 enabled) a report payment row for unseen P2 → PENDING DEFERRED_BACKFILL + back-fill delivery; the worker fetches P2 → the APPROVAL claim by the API → the report row re-evaluated → MATCHED; exactly one movement |
| M-6b | Fallback path isolation | (V-4 test branch) normal RPC 40 on a DEFERRED_BACKFILL row → stays DEFERRED_BACKFILL (never claims); service_role / authenticated EXECUTE on `mp_claim_report_payment_fallback` → permission denied; `mp_normalize_report_fallback` with V-4 false → V4_NOT_VERIFIED; before the back-fill is exhausted → BACKFILL_NOT_EXHAUSTED; an API snapshot arriving between exhaustion and the fallback → the fallback returns ALREADY_CLAIMED, and the row becomes MATCHED / DISCREPANCY with 1 movement total |
| M-6 | API permanently unavailable | M-5 with the back-fill FAILED_PERMANENT → ADMIN `mp_normalize_report_fallback` → movement from the report; a later API snapshot → IGNORED NO_NEW_TRANSITION |
| M-7 | Balance check | a day-closing Liberaciones row with BALANCE_AMOUNT equal to Σ postings → BALANCE_CHECK `is_exception` false; different → true; `NOT_DAY_CLOSING_ROW` for others |
| M-8 | V-4 guard | with `mp_v4_verified()` = false, a Liberaciones payment row → PENDING DEFERRED_V4; no claim, no match, no movement |

## DIRECTION — Inbound vs outbound payment (V-4 direction correction, 2026-09-28)

These are requirements only. They are implemented with the direction-aware report parser (steps 16 / 19). The fixtures are real-shaped: `adr006-v3-account-money.json` (K1 / K2 / K3) and `adr006-v4-equivalence.json`. The authority is `ADR006_V4_DIRECTION_CORRECTION.md`.

| ID | Case | Setup / action | Assert |
|---|---|---|---|
| DIRECTION-1 | Inbound payment | report row direction C / K1 plus an API snapshot with collector = account for the same id | one identity `('payment', id, 'APPROVAL', '')`; movement `payment`; `mp_is_auto_applicable` = true; A1 applies it once; the report row becomes IGNORED + MATCHED |
| DIRECTION-2 | Outbound payment | report row direction D / K2 (account is the payer) | identity `('payment', id, 'OUTBOUND_PAYMENT', '')`, **no** APPROVAL identity; movement `payment` with negative amounts plus REPORT_ONLY; `mp_is_auto_applicable` = false and no `mp_apply_transition` effect (Δ operation / posting = 0); C1 / C2 → `NOT_A_RECEIPT` / no allocation; Δ back-fill delivery = 0; listed as REVIEW_REQUIRED (unassigned) |
| DIRECTION-2b | Outbound payment fetched by the API | an API snapshot whose collector is not the account (a back-fill or a webhook) | worker `FAILED_PERMANENT COLLECTOR_MISMATCH`; Δ source / movement / identity = 0; never APPROVAL |
| DIRECTION-3 | Outbound resolved as a supplier payment | after DIRECTION-2: ADMIN `pay_supplier(…, p_financial_account_id = MP account)`, then RPC 41 **Mode 2** linking the movement to that operation for the supplier amount, and Mode 1 `ADJUSTMENT` for the payer-side withholding | the supplier ledger is written only by `pay_supplier`; exactly one negative MP posting from `pay_supplier` plus one `ADJUSTMENT` posting; Mode 2 creates no operation or posting; Σ assigned = movement net; no automatic MP posting; a repeated link → `DUPLICATE_LINK` |
| DIRECTION-4 | Inbound `account_fund` | a DIRECTION-1 setup whose API `operation_type = 'account_fund'` (cvu) | treated exactly as DIRECTION-1 (inbound receipt, A1 applies); C2 `mp_auto_allocate` → `NO_EVIDENCE` (CLIENT_UNASSIGNED) unless deterministic evidence exists; `operation_type` is never read as client evidence |
| DIRECTION-5 | Account Money K3 (owner-verified yield, V-3 §15.1) | a K3 row matching the exact V-3 §13 structural shape | identity `('report', SOURCE_ID, 'YIELD', '')` (shared with Liberaciones `asset_management`, V-3 §16); movement `yield`; REPORT_ONLY; A1 applies a single `MP_SETTLEMENT` = net; no allocation; no payment claim. A variant that breaks any part of the shape (e.g. tax ≠ 0 or a payment method present) → ERROR, no YIELD |
| DIRECTION-8 | Account Money `PAYOUTS` (heterogeneous outflow, V-3 §15.2; identity revised by V-3 §16) | a K4 row and a K5 row | identity `('report', SOURCE_ID, 'PAYOUT', '')`, the same identity as the Liberaciones `payout`; movement `transfer`; REPORT_ONLY; `mp_is_auto_applicable` = false; no A1 effect; C1 → `NOT_A_RECEIPT`; REVIEW_REQUIRED until the ADMIN runs `pay_supplier` (K4 example) or `transfer_between_accounts` (K5 example) and links with RPC 41 Mode 2 (withholding through Mode 1 `ADJUSTMENT`), with exactly one domain MP posting |

## CROSSREPORT — Same economic movement in two report products (V-3 §16, 2026-09-28)

These are requirements only (Step 16). The fixtures are sanitized real-shaped rows derived from the overlapping Liberaciones / Account Money exports. Every case asserts that no source record is deleted or collapsed.

| ID | Case | Setup / action | Assert |
|---|---|---|---|
| CROSSREPORT-1 | Same yield in both reports | upload a Liberaciones `asset_management` row and the Account Money K3 row with the same `SOURCE_ID` | 2 immutable source rows; exactly **one** identity `('report', SOURCE_ID, 'YIELD', '')` and one `yield` movement; the second row is IGNORED + MATCHED; A1 applies exactly one `MP_SETTLEMENT`; P&L Otros ingresos financieros once |
| CROSSREPORT-2 | Reverse upload order | CROSSREPORT-1 with Account Money first | the same identity, the same single movement (same `movement_kind`, amounts and occurred_date), the same single financial effect; now the Liberaciones row is the IGNORED + MATCHED one |
| CROSSREPORT-3 | Exact replay | re-upload either report, or re-run RPC 40 on both sources | Δ source (`ON CONFLICT DO NOTHING`) = 0; Δ identity / movement / operation / posting / match = 0; `ALREADY_PROCESSED` on re-normalization |
| CROSSREPORT-4 | Payout with reserves in both reports | Liberaciones `reserve_for_payout` (−X), `reserve_for_payout` (+X), `payout` (−X), and Account Money `PAYOUTS` (−X), all with the same `SOURCE_ID` | both reserves IGNORED (ADR-003), with no identity and no movement; exactly one identity `('report', SOURCE_ID, 'PAYOUT', '')` and one `transfer` movement; the other final row is IGNORED + MATCHED; no A1 effect (not auto-applicable); REVIEW_REQUIRED until the ADMIN domain resolution |
| CROSSREPORT-5 | Conflicting values under one `SOURCE_ID` | the Account Money row differs from the claimed Liberaciones movement (e.g. net differs by 0.01) | no second movement; the later row is IGNORED + **DISCREPANCY** (`is_exception = true`, field-by-field detail); REVIEW_REQUIRED; the first claim is never overwritten or merged |
| DIRECTION-6 | Direction conflict | a direction-C row whose back-fill returns a foreign collector | back-fill `FAILED_PERMANENT COLLECTOR_MISMATCH`; `mp_normalize_report_fallback` → `DIRECTION_CONFLICT`; no APPROVAL; the row stays PENDING / REVIEW_REQUIRED |
| DIRECTION-7 | Outbound across reports | the same outbound payment as a Liberaciones D row and an Account Money K2 row | one `OUTBOUND_PAYMENT` identity and one movement; the second row is IGNORED + MATCHED / DISCREPANCY; `mp_normalize_report_fallback` on an outbound row is refused with `NOT_DEFERRED` (outbound rows never reach `DEFERRED_BACKFILL`); `OUTBOUND_NOT_ELIGIBLE` is asserted on a crafted outbound row forced into `DEFERRED_BACKFILL` inside a rolled-back test transaction (defence in depth) |

## S — RLS and privilege abuse

| ID | Case | Assert |
|---|---|---|
| S-1 | anon | SELECT on each new table / view → permission denied; EXECUTE on every new function → permission denied |
| S-2 | OPERATOR | SELECT on each new table → 0 rows / denied; every ADMIN RPC → FORBIDDEN; views → 0 rows |
| S-3 | ADMIN | cannot call the service-only RPCs (FORBIDDEN); can call `mp_requeue_config_blocked`; OPERATOR and anon cannot (FORBIDDEN / permission denied); cannot INSERT / UPDATE / DELETE any new table directly |
| S-4 | service_role | no SELECT on allocation / map / flag; no INSERT on client_ledger; no UPDATE on any MP table; cannot insert api_* sources (N-9) |
| S-5 | Guards | UPDATE of an immutable delivery column / match column as owner through a test path → the trigger raises |
| S-6 | Evidence-only AUTO | a forged `external_reference` naming a client id that does not exist / an inactive client → no allocation |
| S-7 | Inventory | RLS spec checks 6 (0 rows), 7 (0 rows), 8 (1 row); 6b replaced by an **exact-set** assertion: `array_agg(proname ORDER BY proname) WHERE prosecdef AND pronamespace = 'public'` equals the 60-name literal (the 41 verified baseline names + the 19 ADR-006 names, ADR006_RLS_AND_SECURITY_V1 §4); the internal helpers `mp_parse_report_row` and `mp_claim_report_payment_fallback` are absent from the set (INVOKER) and not executable by authenticated / service_role / anon |
| S-8 | Worker invoke | a POST to `mp-worker` without / with the wrong invoke secret → 401; Δ = 0 |

## A — Audit completeness

| ID | Case | Assert |
|---|---|---|
| A-1 | One audit per fact | across T-1, C-2, C-11, R-1, C-16, M-2 resolution, M-6: audit rows = the number of facts, each with the expected `action` and `performed_by` (uid or NULL) |
| A-2 | No audit on no-ops | W-2, T-3, C-5, R-6 → Δ audit = 0 |
| A-3 | No sensitive data | a regex scan of `after_values` / `before_values` for tokens, emails, `x-signature`, or payer fields → 0 matches |

---

## P23 — ADR-authorized amendment of `scripts/target-db/mp.test.mjs` (Phase 23 suite)

ADR-006 intentionally changes two Phase 23 behaviours:
- (a) while V-4 is open, a Liberaciones **payment** row is validated and then parked **PENDING `DEFERRED_V4`, with no movement** (ADR-003 made it NORMALIZED);
- (b) the service-role INSERT policy on `mp_source_record` is narrowed to report source types (R4).

The suite is therefore **amended, not kept unchanged**. This is an ADR-authorized regression update, not a regression failure. **Only** the assertions below change:

| mp.test.mjs check | Old (ADR-003) expectation | Amended (ADR-006) expectation |
|---|---|---|
| D1 | real payment row 144502568133 → NORMALIZED, 1 movement 1.00 / 0.00 / −0.01 / 0.99 | same row → full D1 validation passes → **PENDING**, note `DEFERRED_V4…`, `movements_created = 0`, no movement; raw byte-identical |
| D3 | outgoing payment 145781917504 → movement −20000.94 / 0.00 / −120.01 / −20120.95 | → PENDING `DEFERRED_V4`, no movement. The external_id direction-D assertion (ingestion) is **kept unchanged** |
| D8 | re-normalizing the processed payment source → ALREADY_PROCESSED | re-targeted to the processed **D4 yield source** (the same intent: ALREADY_PROCESSED, no duplicate movement). A second call on the deferred payment row stays PENDING `DEFERRED_V4`, Δ movement = 0, Δ audit = 0 |
| D11 | the NORMALIZE audit for the payment source reads `NORMALIZE|PENDING|NORMALIZED|1|NULL` | `NORMALIZE|PENDING|PENDING|0|NULL`, with note `DEFERRED_V4`, written once on the first deferral. The reserve half of D11 is **unchanged** |
| B4 (**Step 9 only**) | service-role INSERT of `source_type 'webhook'` succeeds | from Step 9 (0051) on, the same INSERT is **denied by RLS** (the narrowed `mp_source_service_insert`, R4) |
| D7 cases "unsupported source_type webhook" / "api" (**Step 9 only**) | service-role INSERT, then RPC 40 → ERROR `UNSUPPORTED_SOURCE_TYPE` | from Step 9 (0051) on, the service-role INSERT is denied (RLS). The RPC 40 `UNSUPPORTED_SOURCE_TYPE` branch is still covered by inserting the row **as owner**, then RPC 40 → ERROR `UNSUPPORTED_SOURCE_TYPE` (branch coverage preserved) |
| `movement()` fixture helper, used by E, F, G, H, J, K, L | builds a synthetic Liberaciones **payment** row → movement | the default DESCRIPTION becomes **`payout`** (movement kind `transfer`). It is still normalized by the unchanged ADR-003 parser, is not auto-applicable, and so remains owned by RPC 41 (ADR-003 D7). **Every E–L assertion is unchanged**: amounts, signs, caps, idempotency, N:N, capacity, RLS, periods, atomicity, concurrency |
| P1 | real row 145187899970 → NORMALIZED, movement 20.00 / 0.00 / −0.12 / 19.88 | → PENDING `DEFERRED_V4`, no movement, raw unchanged |
| P2–P4 | RPC 41 partial / final reconciliation of the P1 payment movement | re-targeted to the D5 **real payout** movement (non-auto-applicable), with amounts adjusted to that movement's net. The intent (partial → RECONCILED, postings only, raw byte-identical) is unchanged |
| J2, K1 (`kPending`, `kPending2`, `kPending3`), L1 — direct `ingest(synth(...))` fixtures (amendment 2026-09-28) | synthetic Liberaciones **payment** rows normalized by RPC 40 | **fixture retarget only**: the same minimal valid **payout** row the `movement()` helper uses (`synth({ desc: 'payout', ... })`: unique SOURCE_ID, the same date where relevant, valid credit/debit and gross + fee + tax = net under the unchanged ADR-003 parser, no V-2 field, no `api_payment`). These tests do not test the payment rule; their purposes are unchanged. **J2:** RPC 40 has no period guard, so a valid payout source dated 2026-03-20 normalizes while March is CLOSED (NORMALIZED + one movement carrying 2026-03-20; only the wording "payout source" changes). **K1:** RPC 40 atomicity under injected failure at the movement insert, the source metadata update and the NORMALIZE audit (rollback assertions unchanged). **K2:** RPC 41 atomicity unchanged; its failures were a cascade of K1's changed snapshot. **L1:** two concurrent RPC 40 calls on the same valid source serialize; exactly one movement; the second call observes `ALREADY_PROCESSED`. Expected error codes, period semantics, injected-failure semantics and concurrency semantics are unchanged |

**Coverage of the payment rule is preserved.** Payment → `DEFERRED_V4` with zero economic effect stays covered by D1, D3 and P1 above and by `mp_realtime.test.mjs` (N-10 / M-8). The generic RPC 40 / RPC 41 tests use the payout path. B4 and D7 keep their Step-9 timing (§P23-T).

**Preserved unchanged** (explicit list):
- A (structure);
- B1–B3, B5 (ingestion, duplicates, visibility);
- C (raw immutability);
- D2, D4, D5, D6, D7b, D7c, D9, D10, D12, and every other D7 ERROR case (validation order and codes of the ADR-003 D1 parser);
- E–L content (RPC 41 Mode 1 / Mode 2, sign, caps, idempotency, N:N, RLS, periods, atomicity, concurrency);
- M (security definer checks of the two MP RPCs);
- N (no parallel ledger).

**Added ADR-006 assertions** (in `mp_realtime.test.mjs`, N-10 / M-8): a `DEFERRED_V4` payment row produces **zero** movement, identity, match, operation, posting, allocation and client-ledger rows. Re-running RPC 40 on it adds nothing.

### P23-T — Timing of the B4 / D7 amendment (execution correction; the accepted implementation order is unchanged)

- B4 and the D7 service-role INSERT-denial expectations change **only at Step 9**, when `0051` narrows `mp_source_service_insert`.
- In Steps 1–8 the 0041 policy is still in force, so B4 and D7 keep their **pre-0051 expectations**: the service-role INSERT succeeds, and RPC 40 then returns ERROR `UNSUPPORTED_SOURCE_TYPE`.
- The RPC 40 `UNSUPPORTED_SOURCE_TYPE` branch may additionally be tested with **owner-inserted fixtures** at any step.
- The remaining §P23 changes (D1, D3, D8, D11, P1–P4, the `movement()` helper, M1 per §INV) apply at Step 2, together with 0048.
- This corrects the Steps 0–2 execution prompt, which listed B4 / D7 under Step 2. It does not change ADR006_IMPLEMENTATION_ORDER_V1.

---

## INV — Mechanical schema-inventory amendment of historical suites (not a behavioural relaxation)

ADR-006 adds legitimate schema objects. Historical suites that assert **exact global inventories** must therefore be extended mechanically, following the Phase 24 (ADR-004) precedent, where the same literals were extended in every suite.

**Only the classes below are authorized.** Each change adds the ADR-006 names or counts at the migration step that creates them, and nothing else.

| Class | Authorized change | Affected assertions (at the time of writing) | Applies from |
|---|---|---|---|
| A. Enum inventory | the expected public enum count grows by exactly the 2 ADR-006 enums (`mp_delivery_status`, `mp_match_outcome`), and the comment names them | `foundations.test.mjs` (the enum count: 28 frozen + 2 ADR-004 → + 2 ADR-006) | 0047 |
| B. Table inventory | global base-table counts and later-phase allow-lists gain exactly the 6 ADR-006 tables (`mp_webhook_delivery`, `mp_transition_identity`, `mp_report_match`, `mp_client_allocation`, `mp_payer_client_map`, `mp_attribution_flag`) | `foundations.test.mjs` `LATER_PHASE_TABLES`; `treasury.test.mjs` `LATER_PHASE_TABLES` (A2); `reporting.test.mjs` A4 (the base-table count grows by 6) | 0047 |
| B'. Feria K5 | K5 no longer asserts the absence of every `mp_*` table. It keeps its real Phase 21 invariant: **Feria creates no reconciliation / variance / arqueo authority and no invented MP correspondence.** Concretely, the allow-list gains exactly the 6 ADR-006 tables, and the `(reconcil|variance|arqueo)` part of the pattern and the Feria-specific assertions (no Feria column or object pairs sessions with MP) stay as they are | `feria.test.mjs` K5 | 0047 |
| C. Reporting N2 | N2 keeps forbidding stored reporting authorities (tables named report / kpi / dashboard / snapshot / balance / saldo / laying). `mp_report_match` is added as the **single named exception**, because it is reconciliation evidence (ADR006_SCHEMA_DELTA_V1 §4), not a stored report, KPI, dashboard or balance. No pattern is removed and no other exception is added | `reporting.test.mjs` N2 | 0047 |
| D. SECURITY DEFINER inventories | every historical exact definer list (`ALL_DEFINERS` literals, the `commercial.test.mjs` inline list, `foundations.test.mjs` `LATER_PHASE_DEFINERS`, the `reporting.test.mjs` A5 wording "unchanged (41)") is extended **by name** with the definers actually added at that step. The assertions keep comparing the **exact name set**, never only a count | `classification`, `commercial`, `feed`, `feria`, `fiscal`, `foundations`, `instruments`, `mp` (M1), `pnl`, `production`, `purchases`, `reporting`, `treasury` | 0048 and 0050 |
| E. Phase 23 M1 | `mp.test.mjs` M1 is included in class D (it is a definer-inventory literal, not a §P23 functional change) | `mp.test.mjs` M1 | 0048 and 0050 |

**Definer checkpoints (by enumeration, not arithmetic):**
- **Before ADR-006:** the 41 names enumerated in ADR006_RLS_AND_SECURITY_V1 §4.
- **After 0048:** the baseline ∪ exactly the Step-2 definers created by 0048. By design these are S1 `mp_register_delivery`, S2 `mp_claim_deliveries`, S3 `mp_delivery_transition`, S5 `mp_requeue_config_blocked`, S6 `mp_request_refetch`, S7 `mp_resolve_chargeback_signal`, C1 `mp_allocate_to_client`, C2 `mp_auto_allocate`, C3 `mp_reverse_client_allocation`, C4 `mp_flag_for_attribution`, C5 `mp_clear_attribution_flag`, C6 `mp_map_payer_to_client`, C7 `mp_unmap_payer`, R1 `mp_resolve_match`, R3 `mp_check_report_coverage`, R4 `mp_record_balance_check`. After 0048 applies, the **actual** set is enumerated from `pg_proc` and must equal this list exactly. The literal in the suites is written from that enumeration.
- **After 0050 (Step 6, implemented):** the Step-2 set ∪ exactly S4 `mp_ingest_api_snapshot` (58 definers), enumerated by name in every historical inventory and in `mp_realtime.test.mjs` Z1. `mp_realtime.test.mjs` N6 is re-targeted: its api_payment half now asserts the Step-6 parser's fail-closed `IDENTITY_MISMATCH` on the malformed owner fixture; its api_refund half is unchanged (`UNSUPPORTED_SOURCE_TYPE`).
- **After 0051 (Step 7, implemented):** the set after 0050 ∪ exactly A1 `mp_apply_transition` and R2 `mp_normalize_report_fallback` (60 definers); the helper `mp_claim_report_payment_fallback` is SECURITY INVOKER and not in the inventory. Enumerated by name in every historical inventory and in `mp_realtime.test.mjs` Z1.
- **Final accepted set (was "after the Step-7 migration"):** the final accepted set of ADR006_RLS_AND_SECURITY_V1 §4 (adds S4 `mp_ingest_api_snapshot`, A1 `mp_apply_transition`, R2 `mp_normalize_report_fallback`). It is again enumerated and compared by exact set.
- No count (such as 57 or 60) is hard-coded unless the enumeration at that checkpoint proves it.
- SECURITY INVOKER helpers and trigger functions (`mp_is_auto_applicable`, `mp_v4_verified`, `mp_parse_report_row`, `mp_claim_report_payment_fallback`, `mp_delivery_immutable_guard`, `mp_report_match_guard`) are **not** definers and never enter these lists.

**Preservation rule:**
- No functional assertion changes except those already listed in §P23 (with the §P23-T timing).
- Classes A–E change only inventory literals, counts, allow-lists and the named N2 exception.
- **Nothing** here weakens raw immutability, amount arithmetic, idempotency, RLS intent, period guards, concurrency, append-only behaviour, the absence of stored balances, Feria business semantics or reporting derivation semantics.
- If any other historical assertion fails after 0047 or 0048, the step stops as **BLOCKED** for review. It is not edited.

---

## HRN — Remaining test-harness adaptations (authorized 2026-09-27 after the Step-1 blocker report)

These are **test-harness maintenance only**. They do **not** change:
- ADR-006 `DEFERRED_V4` behaviour, or RPC 40 business semantics;
- P&L or reporting semantics, or Phase-18 production semantics;
- amount arithmetic, RLS intent, period guards, idempotency or concurrency;
- append-only production behaviour or the stored-balance rules.

Any other functional assertion failure remains **BLOCKED**.

**HRN-1 — `production.test.mjs` A11: named exception.**
- The column name `mp_webhook_delivery.key_conflict_of` (ADR006_SCHEMA_DELTA_V1 §2) is accepted and **not renamed**.
- A11's column query is over-broad: it matches every public column containing "conflict", while the Frozen Part 26 rule it protects is specifically the rejection of **mortality-conflict tracking**.
- A11 stays an exact negative assertion, with the regex kept, and adds exactly one exclusion: `AND NOT (table_name = 'mp_webhook_delivery' AND column_name = 'key_conflict_of')`. The result must still be 0.
- Preserved unchanged:
  - no mortality-conflict table;
  - no conflict flag on population or daily-production facts;
  - no `conflicting_event_id` mechanism;
  - `population_event_type` exactly `MORTALITY, COUNT_ADJUSTMENT`, with no `MORTALITY_CONFLICT`.
- Applies from 0047.

**HRN-2 — `pnl.test.mjs`: payment fixture retarget.**
- The suite is not the authority for the Liberaciones payment parser. After 0048, a `payment` Liberaciones row correctly parks as `DEFERRED_V4`.
- **Only the payment fixture construction changes.** The same economic movement is created as **OWNER**, with the minimum internal rows the current schema requires:
  - a `mp_source_record` row (`csv_import`, the same row data, **no** `api_payment`, no V-2 field);
  - the `mp_financial_movement` row (`payment`, gross 1000, fee −12, tax −8, net 980, the same `occurred_date`);
  - where the schema requires it, the `mp_transition_identity` linkage (`report` resource, the source's external_id, `APPROVAL`);
  - the source status `NORMALIZED`, which is what RPC 40 wrote before 0048.
- The yield and payout fixtures stay on the real `csv_import` → RPC 40 path.
- M1–M4 expectations, and the P&L views under test, are unchanged.
- Applies from 0048.

**HRN-3 — `reporting.test.mjs`: payment fixture retarget.**
- The same approach as HRN-2 for the single MP payment fixture: gross 1000, fee −12, tax −8, net 980, 2026-06-12, created as OWNER, with no `api_payment`, no V-2 field and no webhook.
- The later RPC 41 reconciliation calls, and every report view assertion, are unchanged. No stored reporting result is introduced.
- Applies from 0048.

**HRN-5 — `pnl.test.mjs` / `reporting.test.mjs`: no transition identity on the owner payment fixtures (Step 7). — ACCEPTED (owner, 2026-09-28).** These fixtures exercise manual reconciliation, not ADR-006 automatic application, so they intentionally carry no APPROVAL transition identity.
- The HRN-2 / HRN-3 fixtures added a `('report', external_id, 'APPROVAL')` identity only "where the schema requires it"; the schema never requires one.
- With the RPC 41 `AUTO_APPLICATION_PENDING` guard (0051) a payment/APPROVAL identity makes the fixture auto-applicable, so the suites' manual RPC 41 reconciliations would be refused.
- The identity row is therefore not created. The movement, amounts, source status and every assertion are unchanged. Applies from 0051.

**Step-7 deferrals (explicit):** T-12 (the Liberaciones-row half), M-1, M-2 (payment form), M-5 need the report ↔ API matching path of RPC 40 (currently `V4_PATH_NOT_IMPLEMENTED` under V-4) and run at Step 19. M-6 / M-6b run now: M-6 in the V-4 test branch (`mp_v4_verified()` redefined inside a rolled-back transaction; the `DEFERRED_BACKFILL` state is built as OWNER). R-1…R-6, R-9…R-11 stay deferred (refunds, V-2 §15.1).

**HRN-4 — FK-safe teardown** in exactly `mp.test.mjs`, `pnl.test.mjs` and `reporting.test.mjs`.
- 0047 adds RESTRICT references to `mp_source_record` and `mp_financial_movement`, so each suite's owner-only cleanup first deletes its rows in the dependent ADR-006 tables, in actual FK order (derived from 0047):
  1. `mp_client_allocation` (reversal rows before their originals: `reversal_of_id` self-reference);
  2. `mp_attribution_flag`;
  3. `mp_report_match`;
  4. `mp_webhook_delivery` (conflict and refresh rows before their referenced rows: `key_conflict_of` / `triggered_by_delivery_id` self-references; `report_source_id` / `source_record_id` → `mp_source_record`);
  5. `mp_transition_identity`;
  6. then the existing deletes of `mp_reconciliation`, `mp_financial_movement` and `mp_source_record`.
- `mp_payer_client_map` references only `clients` / `perfiles`, so it needs no teardown in these suites.
- Each suite deletes only the minimum subset it can create. The teardown is owner-only and re-runnable. It uses no TRUNCATE … CASCADE, no disabled FKs, no dropped constraints and no privilege change.
- Every raw-immutability and append-only assertion keeps testing application roles, exactly as before.
- Applies from 0048 (and 0047, where harmless).

---

## CT — Current-target clean-cutover compatibility regression (replaces "rerun the Phase 26 rehearsal unchanged")

Phase 26 is COMPLETE. Its artefacts are historical evidence, and **none is modified or re-run as if it had known migrations 0047+**. That includes the runner, the config (`expected_migrations = 46`), `validate-clean-cutover.sql` (C01 = 46), the rehearsal digests and the PASS summary.

The new harness `scripts/regression/clean-cutover-current-target.mjs` (a new file; it imports nothing mutable from `scripts/phase26/`):

| ID | Case | Assert |
|---|---|---|
| CT-1 | Fresh current target | a guarded reset + `apply.mjs` with **all current migrations** (0001–0052); the ledger count equals the number of migration files present (derived at run time, not hard-coded) |
| CT-2 | Load the historical clean-cutover plan | re-extract from the local `granja-legacy-copy` with the historical Phase 26 config (read-only; manifest and fingerprint checks as in Phase 26), or read the historical Run 1 `plan.json` read-only; its SHA-256 must equal the recorded plan hash. The load is performed by invoking the historical runner's `load` command unchanged (its `load` step does not check the migration count), **never** its `rebuild` or `validate` commands |
| CT-3 | Current-schema business validation | the new `validate-current-target.sql` (read-only) carries every historical check **except** C01. C01 is replaced by "ledger = migration files present". C16 is extended with the ADR-006 tables (`mp_webhook_delivery`, `mp_transition_identity`, `mp_report_match`, `mp_client_allocation`, `mp_payer_client_map`, `mp_attribution_flag` = 0 rows, because the clean cutover loads no MP history) |
| CT-4 | Business-state equality with historical evidence | the DIGEST lines produced by CT-3 (same canonical digest query as Phase 26) equal the historical Run 1 `state-digest.txt` **per table**, read-only from the Phase 26 run directory. Any difference fails. The historical file is never rewritten |
| CT-5 | Idempotent rerun on the current target | the Phase 26 zero-write fingerprint procedure, re-implemented in the new harness: pre = post |

**Optional separate proposal (not part of this change):** a reusable validation helper that parameterises the expected migration count could be generalised for future schema growth, as its own reviewed task. Historical Phase 26 files stay as they are.


**Exit criterion:**
- every row above passes, except R-8, which stays pending on V-3 + V-4;
- the rows marked "V-4 enabled in a test-only branch" pass with `mp_v4_verified()` redefined to `true` only inside a test transaction that is rolled back (DDL is transactional in PostgreSQL);
- the 13 other existing target-db suites pass with **only** the §INV mechanical inventory updates, and `mp.test.mjs` passes as amended in §P23 / §P23-T plus §INV (class E). No other assertion changes;
- CT-1…CT-5 pass (the current-target clean-cutover compatibility regression), with no historical Phase 26 artefact modified.
