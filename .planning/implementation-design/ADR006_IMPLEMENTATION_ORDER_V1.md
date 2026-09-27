# ADR-006 IMPLEMENTATION ORDER V1

**Status:** implementation design. **Authority:** ADR-006 §11–§13 and the six ADR006_* design documents. Each step lists its gate; a step starts only when its predecessors' gates pass. Every database step runs **only** on the guarded local stack (Phase 12). Production is untouched until Phase 31.

---

## 1. Dependency sequence

| # | Step | Content | Depends on | Gate (must pass to proceed) |
|---|---|---|---|---|
| 0 | Baseline checkpoint | commit the ADR-006 design documents (explicit paths, secret scan), per the Phase 26 traceability note | owner authorization to commit | clean tree for the touched paths |
| 1 | Schema (field-agnostic) | `0047_mp_realtime_tables.sql`: 2 enums, 6 tables, CHECK / UNIQUE / FK, indexes, the 2 guard triggers (ADR006_SCHEMA_DELTA_V1 §1–§7). No object depends on MP payment field semantics | 0 | `apply.mjs` 0001–0047 on a fresh reset; the 14 existing suites still green |
| 2 | Pre-V-2 functions | `0048_mp_realtime_core_rpcs.sql`, containing:<br>• helpers `mp_is_auto_applicable`, `mp_v4_verified` (returns false);<br>• queue and delivery identity S1, S2, S3 (including the SIGNAL_RECORDED outcome), S5 (requeue), S6 (ADMIN re-fetch), S7 (chargeback signal resolution);<br>• attribution C1–C7;<br>• report R1, R3, R4;<br>• RPC 40 redefinition limited to the `csv_import` branch changes (the shared helper `mp_parse_report_row`, identity claim for Liberaciones yield / payout, `DEFERRED_V4` parking of payment rows). `api_payment` / `api_refund` remain `UNSUPPORTED_SOURCE_TYPE`, exactly as in 0042.<br>**No MP payment-resource field is read anywhere in this step** | 1 | W-2, W-2b, W-2c, W-10, F-11, F-12 (DB level); the C block, R-9 and R-11 (pre-A1 part) on **owner-inserted fixtures** (a movement, identity and reconciliation rows inserted as owner; no API payload); R-13 (ADMIN resolution); M-7, M-8; N-10; `mp.test.mjs` **amended exactly as in ADR006_TEST_MATRIX_V1 §P23** (the D1, D3, D8, D11, P1–P4 and `movement()` helper changes; B4 and D7 follow in step 9) and green; every other ADR-003 assertion unchanged |
| 3 | `verifySignature` module + topic table | **V-1 recheck** against the current official MP docs at code time: signature recipe; the payment **and chargeback** notification topics, body shapes and resource identifiers; the documented stable notification id per topic (it feeds the `'n:'` delivery key). Test vectors | — (parallel to 1–2) | verifySignature.test green, including tamper / stale / missing cases |
| 4 | `mp-webhook` Edge Function | ADR006_WEBHOOK_WORKER_DESIGN_V1 §2. It reads only notification fields (V-1 scope), never payment-resource fields | 2, 3 | W-1…W-10 against the local stack via `supabase functions serve` |
| 5 | **V-2 verification** (a hard gate for every consumer of payment fields) | read-only fetch of real payments of the owner's account, with no writes. A separate owner authorization is required, because it contacts MP production. It must establish the exact authoritative MP payment fields for:<br>• gross amount;<br>• fee amount and fee components;<br>• taxes and withholdings;<br>• the net arithmetic inputs;<br>• payer id;<br>• `external_reference`;<br>• approval date;<br>• `refunds[]` identifiers, amounts, transition dates and statuses;<br>• the chargeback / mediation status fields the real-time design consumes;<br>• the set of accepted MP `operation_type` / `status` **field values**.<br>Real-shaped fixtures are derived **with personal data removed** | 2 | a written V-2 evidence note is accepted; the fixtures are committed |
| 6 | Payment normalization (post-V-2) | `0049_mp_realtime_payment_rpcs.sql`: S4 `mp_ingest_api_snapshot`; the RPC 40 redefinition adding the `api_payment` and `api_refund` parsers, written directly against the V-2 fields (no placeholders) | 5 | N-1…N-9; F-13 at DB level |
| 7 | Atomic application (post-V-2) | same migration: A1 `mp_apply_transition` (application of the payment components carried by V-2-backed movements; OD-1 unwinding; applied-reversal bound) + RPC 41 redefinition with the `AUTO_APPLICATION_PENDING` guard; R2 `mp_normalize_report_fallback` with the internal helper `mp_claim_report_payment_fallback` | 6 | the complete T block (T-12 in the V-4 test branch); the C block and R-1…R-7, R-10, R-11 rerun on real-shaped movements; M-1…M-6b (M-1, M-5, M-6, M-6b in the V-4 test branch) |
| 8 | `mp-worker` Edge Function + `mpWorkerCore` | ADR006_WEBHOOK_WORKER_DESIGN_V1 §4–§5, with a mocked MP API serving the V-2 fixtures | 4, 7 | F-1, F-2, F-3a…F-3g, F-4…F-13; R-12, R-14 (chargeback signal path, §4a); the full crash table (ADR006_IDEMPOTENCY_AND_STATE_V1 §3) |
| 9 | RLS / grants | `0050_mp_realtime_privileges_rls.sql` (ADR006_RLS_AND_SECURITY_V1 §2–§3), including the narrowed `mp_source_service_insert` policy | 2, 6, 7 | S-1…S-7 (exact 60-name definer set, ADR006_RLS_AND_SECURITY_V1 §4); the §P23 B4 and D7 amendments of `mp.test.mjs` (service-role INSERT of webhook / api types now denied) green |
| 10 | Views | `0051_mp_realtime_views.sql` (`report_mp_receipt_status`, `report_mp_delivery_health`, `report_mp_report_exceptions`) | 9 | view rows for C-1, C-16, R-7, M-2, F-3a, F-5 match the derived-state tables (ADR006_IDEMPOTENCY_AND_STATE_V1 §2.3) |
| 11 | Scheduler | pg_cron + pg_net + Vault secret (local stack), plus the hourly credential probe | 8 | the worker is invoked every minute locally; S-8; F-3f |
| 12 | Audit and security sweep | A-1…A-3; the logging-policy review of both functions; secret scan | 2–11 | all pass |
| 13 | Integrated ADR-006 regression | the whole test matrix; the 13 other existing target-db suites unchanged; `mp.test.mjs` as amended (§P23); and the **current-target clean-cutover compatibility regression** CT-1…CT-5 (new harness `scripts/regression/clean-cutover-current-target.mjs`: all current migrations, historical plan and load reused read-only, a new current-schema validator without the historical C01 = 46, per-table digest equality with the historical Run 1 evidence). **No Phase 26 artefact is modified or re-run as if it had known 0047+** | 1–12 | green; **ADR-006 backend contract FROZEN** (recorded in MASTER_ROADMAP) |
| 14 | Phase 27 MP frontend contract | the Phase 27 MP screens consume the step-10 views and C1–C7 / R1 / R2 / S5 / S6 / S7 only. Labels follow the ADR-006 §6.4 terminology. No direct table writes. `register_collection` is never offered for an MP receipt | 13 | Phase 27 acceptance (Phase 27 scope) |
| 15 | **V-3: Account Money sample** | an owner action: one real export → layout analysis → **ADR-006 V-3 addendum** (parser contract with ADR-003 D1 rigour: keys, amounts, signs, identity, dates, transition mapping, coverage) | — (parallel; needs the owner file) | addendum accepted |
| 16 | Account Money parser | RPC 40 `account_money_csv` branch; transition kinds CHARGEBACK / ACCOUNT_TAX (+ others per the addendum); upload acceptance switched on | 15, 7 | M-block cases rerun on the real layout; R-8 |
| 17 | Report reconciliation tests on real layout | M-1…M-8 + R-8 with sanitized real rows | 16 | green |
| 18 | **V-4: equivalence evidence** | compare Liberaciones `SOURCE_ID` with the API payment ids obtained in step 5 over a sample; write the evidence note | 5 | proven (or refuted) |
| 19 | V-4 enablement | a migration redefines `mp_v4_verified()` → true; the worker re-runs RPC 40 on the `DEFERRED_V4` rows; MISSING_IN_REPORT is extended to payment transitions | 18 (proven), 7 | M-1, M-5, M-6, T-12 on real data, outside the test branch |
| 20 | Phase 31 gates | ADR-006 §11 gates added to the cutover checklist (already recorded in MASTER_ROADMAP) | 13, 17, 19 | evaluated at Phase 31 |

**Critical path:** 1 → 2 → **5 (V-2)** → 6 → 7 → 8 → 9 → 10 → 13 → 14.

- Steps 3–4 (V-1 and the webhook) run in parallel with 1–2.
- Steps 15 (V-3) and 18 (V-4) run in parallel and gate only their own consumers.
- **No step before 5 implements or reads any Mercado Pago payment-resource field.** `api_payment` normalization, snapshot ingestion and the `mp_apply_transition` application of payment components are implemented only in steps 6–7, after the V-2 evidence is accepted.
- Internal `financial_operation_type` values are **not** a V-2 matter. ADR-003 D7 already fixes `MP_SETTLEMENT` / `FEE` / `ADJUSTMENT` for MP-owned Mode 1 effects. V-2 concerns only the external Mercado Pago field mapping.

---

## 2. Blocked items (they block only what is listed)

| Item | Classification (ratified 2026-09-27) | Blocks | Does NOT block |
|---|---|---|---|
| **V-1** | VERIFIED FOR ARCHITECTURE; the exact recipe is rechecked at code time | step 3: the signature test vectors, and the topic table (payment and chargeback topics, body fields, resource identifiers, stable notification id) that feeds `topic_class` and the `'n:'` delivery key | schema, RPCs, worker structure. Until the topic table is filled, no webhook is accepted in any environment (fail-closed) |
| **V-2** | required before API-payment normalization implementation | steps 6–8 and everything after them that consumes payment fields: `mp_ingest_api_snapshot`, the `api_payment` / `api_refund` parsers, `mp_apply_transition` on payment movements, the worker, and AUTO evidence from payer id / `external_reference`. It concerns only the external MP payment field mapping (gross, fee components, taxes / withholdings, net inputs, payer id, `external_reference`, approval date, `refunds[]` ids / amounts / **authoritative transition dates** / statuses, chargeback / mediation status fields, and, if one exists, a read-only chargeback resource's payment-reference field). No date field (for example `date_approved`, or a refund's `date_created`) is frozen before V-2 proves it | schema (step 1); queue / delivery identity, attribution and report RPCs on owner fixtures (step 2); webhook (steps 3–4). Internal operation types are fixed by ADR-003 D7 and are not a V-2 item |
| **V-3** | a real Account Money export is required before freezing its parser | steps 15–17; chargeback and account-tax amounts from the report (R-8); the MISSING_IN_REPORT coverage definition for Account Money | everything else. Liberaciones (ADR-003) stays the interim completeness source |
| **V-4** | the Liberaciones `SOURCE_ID` ↔ payment-id equivalence still requires evidence | the report ↔ API payment match (MATCHED / DISCREPANCY for payments), back-fill, report fallback, payment MISSING_IN_REPORT (steps 18–19) | real-time payments, A1, attribution, report-only kinds, balance checks. While V-4 is open, report payment rows are parked `DEFERRED_V4`, so no duplicate effect is possible |

---

## 3. Notes for reviewers

- **N-1, a potential future ADR-004 clarification, contingent on V-3.**
  - If the Account Money report shows **fee refunds** (MP returning part of a fee on a refund), the correct P&L effect is a reduction of cost.
  - The current P&L view uses `−abs(fee_amount)` (0045, ADR-004 D10), which cannot represent a positive fee.
  - Until V-3 shows such rows, a fee refund is handled on the treasury only, as an RPC 41 FEE counter-assignment, and the P&L keeps the original fee.
  - If V-3 confirms fee refunds exist, a short ADR-004 D10 clarification ("fee contribution = fee_amount, signed") is needed. That changes economic meaning, so it is an **owner decision at that time**, not now.
- **N-2.** Implementation refinements R1–R5 (ADR006_SCHEMA_DELTA_V1 §0) are mechanical consequences of the existing schema and do not change any ADR-006 decision. Reviewers are asked to confirm them.
- **N-3.** Any change to the SECURITY DEFINER inventory (60) or to invariant 9's append-only list is recorded with ADR-006 as authority. The Frozen specs are not edited.
