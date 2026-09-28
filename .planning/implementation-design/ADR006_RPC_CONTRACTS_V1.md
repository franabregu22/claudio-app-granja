# ADR-006 RPC CONTRACTS V1

**Status:** implementation design; no SQL is written. **Authority:** ADR-006 (ACCEPTED, revision 3), ADR-003, RPC_CONTRACTS_V1 (§4, §40, §41), and the Frozen hardening pattern of RLS_IMPLEMENTATION_SPEC_V1 §2 and §10.

---

## 0. Conventions (all RPCs below)

**Function hardening:**
- `LANGUAGE plpgsql`, `SECURITY DEFINER`, `SET search_path = public`, `OWNER TO postgres`.
- `REVOKE ALL ... FROM PUBLIC, anon` (plus `authenticated` or `service_role` as stated), then the explicit `GRANT EXECUTE`.

**Actor resolution** (identical to 0042):
- Service role: `auth.role() = 'service_role'`; the actor uid is NULL and no user is fabricated.
- ADMIN: `current_app_role() = 'ADMIN'`; the actor is `auth.uid()`.
- A function never accepts an actor parameter.

**Global lock order.** It extends ADR-003 D4 ("movement → operation → source"). Every function takes locks only in this order, which rules out lock cycles:

```
L1 mp_webhook_delivery (row)                      -- only delivery functions
L2 mp_source_record (row)                         -- normalization
L3 mp_financial_movement: transition movement     -- the refund/chargeback or the movement being applied
L4 mp_source_record of that movement              -- status recomputation (ADR-003 D4)
L5 mp_financial_movement: APPROVAL movement       -- axis-B lock (allocations, OD-1 unwinding)
L6 management_period row (assert_period_open, FOR UPDATE)
```

- RPC 40 takes L2 only (plus L6 is not taken: RPC 40 has no period guard, frozen).
- `mp_apply_transition` takes L3 → L4 → L5 (refund/chargeback only) → L6.
- The allocation RPCs take L5 → L6.
- When the transition movement **is** the APPROVAL movement, L5 is the same row as L3 and is not locked twice.

**Common errors:**
- `FORBIDDEN` — wrong actor;
- `PERIOD_NOT_FOUND` / `PERIOD_CLOSED` — from `assert_period_open`;
- `MP_ACCOUNT_MISSING` — no active `financial_account` with `nombre = 'Mercado Pago'` and `account_type = 'EXTERNAL_SERVICE'`. This is the 0008 seed and is resolved inside the function, never passed in.

**Audit actions added:** `MP_DELIVERY_REGISTER`, `MP_DELIVERY_REQUEUE`, `MP_REFETCH_REQUEST`, `MP_CHARGEBACK_SIGNAL_RESOLVE`, `MP_SNAPSHOT_INGEST`, `NORMALIZE` (existing, extended detail), `MP_APPLY_TRANSITION`, `MP_CLIENT_ALLOCATION`, `MP_CLIENT_ALLOCATION_REVERSAL`, `MP_ATTRIBUTION_FLAG`, `MP_ATTRIBUTION_FLAG_CLEAR`, `MP_PAYER_MAP`, `MP_PAYER_UNMAP`, `MP_MATCH_RESOLVE`, `MP_REPORT_FALLBACK`, `MP_COVERAGE_CHECK`, `MP_BALANCE_CHECK`.

**Not audited:** delivery status transitions (`mp_delivery_transition`, `mp_claim_deliveries`) and claim leases. These are queue mechanics, not facts; the table itself is the record.

**Deterministic keys** (all ≤ 97 characters, the ADR-003 D5 limit):

| Key | Format |
|---|---|
| treasury component | `MPA:{transition_id}:SETTLE` / `:FEE` / `:TAX` → `financial_operation.external_ref = 'MP:' ‖ key` |
| AUTO allocation | `MPAUTO:{approval_transition_id}` |
| OD-1 unwinding | `MPREV:{allocation_id}:{reversal_transition_id}` |
| MANUAL allocation / reversal | caller key, 1–97 characters, prefix-free (it must not start with `MPA:`, `MPAUTO:` or `MPREV:`) |

---

## S1. `mp_register_delivery`

`mp_register_delivery(p_origin VARCHAR, p_topic VARCHAR, p_topic_class VARCHAR, p_action VARCHAR, p_resource_id VARCHAR, p_notification_id VARCHAR, p_x_request_id VARCHAR, p_notification_payload JSONB, p_signature_verified BOOLEAN, p_triggered_by_delivery_id UUID DEFAULT NULL) RETURNS JSONB`

- **Actor:** service role only.
- **Validations:**
  - the table CHECKs;
  - `p_origin ∈ ('webhook','chargeback_refresh')`. Back-fills are enqueued by RPC 40 only, and ADMIN re-fetches by S6 / S7;
  - `p_topic_class ∈ ('payment','chargeback','unsupported')`, taken from the V-1-verified topic mapping held by the webhook function.
- **Identity, computed in the database** (ADR006_SCHEMA_DELTA_V1 §2.1):
  - `notification_sha256` is computed by this RPC and by nothing else, using the **canonical formula N-SHA** (below). The Edge Function passes fields; it never supplies or chooses a hash;
  - `delivery_key` = `'n:' ‖ topic_class ‖ ':' ‖ p_notification_id` when a documented stable notification id is supplied **and** it matches `^[A-Za-z0-9._:-]{1,120}$` (max key length 2 + 11 + 1 + 120 = 134); otherwise `'h:' ‖ notification_sha256` (length 66);
  - for `chargeback_refresh`: `'cbrefresh:' ‖ p_triggered_by_delivery_id ‖ ':' ‖ p_resource_id`.
  - `x-request-id` is stored in `x_request_id` only.
- **Write:**
  - `INSERT … ON CONFLICT (delivery_key) DO NOTHING`. If nothing was inserted, the existing natural-key row E is read:
    - `E.notification_sha256` = the new hash → duplicate: `{created: false, delivery_id: E.id}`;
    - **different** → conflict key `CK = 'conflict:' ‖ encode(sha256(convert_to(E.delivery_key ‖ ':' ‖ new_hash, 'UTF8')), 'hex')`. It is always exactly 9 + 64 = **73** characters, well within VARCHAR(200). Then `INSERT (delivery_key = CK, key_conflict_of = E.id, notification_sha256 = new_hash, …) ON CONFLICT (delivery_key) DO NOTHING`:
      - inserted → `{created: true, key_conflict: true, delivery_id}`;
      - not inserted (the **same conflicting notification replayed**) → read the row C with `delivery_key = CK`. `C.notification_sha256` equals the new hash by construction (CK is derived from it), so the result is `{created: false, key_conflict: true, delivery_id: C.id}`. No new row and no unique violation. A mismatch here would be a sha256 collision and raises `DELIVERY_KEY_COLLISION`.
    - A different notification is never silently merged. Two different conflicting contents under the same natural key give two different CKs, so two distinct conflict rows, both with `key_conflict_of = E.id`. `key_conflict_of` always points to the **natural-key row E**, never to another conflict row.

**Canonical formula N-SHA (the single definition, used everywhere):**

```
notification_sha256 = encode(sha256(convert_to((
    jsonb_build_array(
      p_origin,                 -- 1  text, NOT NULL
      p_topic_class,            -- 2  text, NOT NULL
      p_topic,                  -- 3  text, NOT NULL
      p_action,                 -- 4  text, NULL → JSON null
      p_resource_id,            -- 5  text, NULL → JSON null
      p_notification_payload    -- 6  jsonb (the reduced payload, keys ⊆ chk_delivery_payload_keys), NULL → '{}'::jsonb
    ))::text, 'UTF8')), 'hex')
```

- **Field order** is the array order 1–6 and is fixed.
- **NULL handling:** NULL `action` / `resource_id` become JSON `null`, which is distinct from the empty string `""`. A NULL payload is normalized to `{}` before hashing and storing.
- **Canonicalization:** `jsonb` normalizes object key order and whitespace, so `jsonb::text` is deterministic for equal content. Numbers keep their JSON textual value as received.
- `x_request_id`, `notification_id`, `signature_verified`, `received_at` and all headers are **not** hash inputs.
  - Initial status: `topic_class = 'unsupported'` → `UNSUPPORTED`; otherwise `RECEIVED`. A `chargeback` notification is **never** `UNSUPPORTED`.
- **Idempotency:** a true duplicate is not an error; the Edge Function still returns 200.
- **Audit:** `MP_DELIVERY_REGISTER` only when a row is created (including conflict rows, with `key_conflict: true`).
- **Errors:** `FORBIDDEN`, `INVALID_DELIVERY` (a CHECK failure mapped to one code).

## S2. `mp_claim_deliveries`

`mp_claim_deliveries(p_limit INTEGER, p_lease_seconds INTEGER) RETURNS TABLE(delivery_id UUID, claim_token UUID, origin VARCHAR, topic_class VARCHAR, topic VARCHAR, resource_id VARCHAR, attempts INTEGER)`

- **Return column order is exactly as written:** `delivery_id, claim_token, origin, topic_class, topic, resource_id, attempts`.
- `topic_class` is returned so that the worker branches (`payment` / `chargeback` / `unsupported`) with **no additional database lookup**.

- **Actor:** service role.
- **Bounds:** `1 ≤ p_limit ≤ 50`; `30 ≤ p_lease_seconds ≤ 600`.
- **Selection:**
  - rows `WHERE (status IN ('RECEIVED','FAILED_RETRYABLE') AND next_attempt_at <= NOW()) OR (status = 'PROCESSING' AND lease_expires_at < NOW())`;
  - `ORDER BY next_attempt_at, received_at`;
  - `FOR UPDATE SKIP LOCKED LIMIT p_limit`.
- **Write:** each selected row gets `status = 'PROCESSING'`, a fresh `claim_token`, `lease_expires_at = NOW() + p_lease_seconds`, `attempts = attempts + 1`, `updated_at = NOW()`.
- **Guarantee:** two concurrent workers never receive the same row. A worker that dies loses its lease, and the row becomes claimable again after expiry.

## S3. `mp_delivery_transition`

`mp_delivery_transition(p_delivery_id UUID, p_claim_token UUID, p_outcome VARCHAR, p_source_record_id UUID DEFAULT NULL, p_error_code VARCHAR DEFAULT NULL, p_error_detail VARCHAR DEFAULT NULL, p_retry_after_seconds INTEGER DEFAULT NULL, p_link_payment_id VARCHAR DEFAULT NULL) RETURNS JSONB`

**Argument validation**, performed **before any write**. The function is one transaction, so any raise rolls back the whole transition, and the row stays `PROCESSING` under its lease:
- `p_link_payment_id` is accepted **only** with `p_outcome = 'SIGNAL_RECORDED'`. It must be NULL for every other outcome → `INVALID_ARGUMENT: p_link_payment_id only for SIGNAL_RECORDED`.
- When it is non-NULL it must match `^[0-9]{1,20}$` → `INVALID_PAYMENT_ID`. This is checked before the signal transition and before the `chargeback_refresh` insert, so an invalid value leaves no `SIGNAL_RECORDED` status, no resolution columns and no refresh row.
- `p_source_record_id` is accepted only with `FETCHED` → `INVALID_ARGUMENT`.
- `p_retry_after_seconds` is accepted only with `RETRY` → `INVALID_ARGUMENT`.

- **Actor:** service role.
- **Precondition:** the row is `PROCESSING` with a matching `claim_token`, else `CLAIM_LOST`. The worker then abandons without side effects; any source it inserted is idempotent.
- **Outcomes:**
  - `FETCHED`: requires `p_source_record_id` and `topic_class = 'payment'`. Clears the lease and token.
  - `SIGNAL_RECORDED`: only for `topic_class = 'chargeback'`. Clears the lease and token. When the worker has established the related payment id from V-1/V-2-documented fields (ADR006_WEBHOOK_WORKER_DESIGN_V1 §4a), it passes `p_link_payment_id`. The same transaction then inserts the `chargeback_refresh` payment delivery (key `'cbrefresh:' ‖ id ‖ ':' ‖ payment_id`, `ON CONFLICT DO NOTHING`) and sets `signal_resolution = 'LINKED'` (`signal_resolved_by` NULL, reason `auto: documented payment reference`). Otherwise the signal stays unresolved: REVIEW_REQUIRED until an ADMIN resolves it through S7. **No financial write in either case.** (`p_link_payment_id` is the last parameter of the canonical signature above.)
  - `RETRY` (transient classes only: `MP_NOT_FOUND`, `MP_RATE_LIMIT`, `MP_UNAVAILABLE`; any other code → `INVALID_OUTCOME`): → `FAILED_RETRYABLE`; `first_failed_at = COALESCE(first_failed_at, NOW())`; `next_attempt_at` from the schedule (ADR006_WEBHOOK_WORKER_DESIGN_V1 §5), or `p_retry_after_seconds` when MP sent `Retry-After` (clamped to 60 s–3600 s).
    - If `NOW() − first_failed_at > 48 h` (an internal policy, not an MP guarantee), the outcome becomes `FAILED_PERMANENT`.
  - `CONFIG_BLOCKED` (requires `p_error_code = 'AUTH_CONFIGURATION_ERROR'`): → `CONFIG_BLOCKED`, clearing the lease and token. `next_attempt_at` is untouched and irrelevant, because the claim never selects this status.
    - No audit row (queue mechanics).
    - Repeated 401 / 403 after a requeue changes only this row's `attempts`, `last_error_*` and `updated_at`.
  - `RELEASE` (circuit breaker, unprocessed claim): → back to `RECEIVED` if `first_failed_at IS NULL`, else `FAILED_RETRYABLE`. `attempts = attempts − 1` (the claim never ran), and the lease and token are cleared.
  - `PERMANENT`: → `FAILED_PERMANENT`.
- **Always:** stores `last_error_code` and the sanitized `last_error_detail` (≤ 500 characters, never payload, token or signature).
- **Idempotency:** the token check makes a replayed call a no-op error (`CLAIM_LOST`).

## S5. `mp_requeue_config_blocked`

`mp_requeue_config_blocked(p_reason TEXT) RETURNS JSONB`

- **Actor:** ADMIN **or** service role. The service role uses it only from the hourly credential-probe sweep, after a successful probe.
- **Validation:** a reason is required → `REASON_REQUIRED`.
- **Write:** every `CONFIG_BLOCKED` delivery → `RECEIVED` with `next_attempt_at = NOW()`, lease and token cleared, and `last_error_*` kept for history.
  - Rows are locked `FOR UPDATE SKIP LOCKED` (a concurrent requeue is harmless).
- **Idempotency:** with no `CONFIG_BLOCKED` rows it is a no-op, `{requeued: 0}`, with **no audit**.
- **Audit:** `MP_DELIVERY_REQUEUE` once per call with `requeued > 0` (count, reason, actor).
- **Financial effect:** none. Downstream processing is the normal idempotent path.

## S6. `mp_request_refetch` (ADMIN)

`mp_request_refetch(p_payment_id VARCHAR, p_reason TEXT) RETURNS JSONB`

- **Actor:** ADMIN.
- **Validations:** `p_payment_id ~ '^[0-9]{1,20}$'`; a reason is required.
- **Write:** one delivery (`origin 'manual_refetch'`, `topic_class 'payment'`, key `'refetch:' ‖ payment_id ‖ ':' ‖ gen_random_uuid()`, status `RECEIVED`).
- **Audit:** `MP_REFETCH_REQUEST`.
- **Financial effect:** none. The fetch follows the normal idempotent path.
- **Purpose:** recover a `FAILED_PERMANENT` payment after its cause is fixed, or refresh a payment on ADMIN request.

## S7. `mp_resolve_chargeback_signal` (ADMIN)

`mp_resolve_chargeback_signal(p_delivery_id UUID, p_resolution VARCHAR, p_payment_id VARCHAR DEFAULT NULL, p_reason TEXT DEFAULT NULL) RETURNS JSONB`

- **Actor:** ADMIN.
- **Validations:**
  - the delivery exists with `topic_class = 'chargeback'` and status `SIGNAL_RECORDED` → `NOT_A_CHARGEBACK_SIGNAL`;
  - it is unresolved → `ALREADY_RESOLVED`;
  - `p_resolution ∈ ('LINKED','DISMISSED')`;
  - a reason is required;
  - `LINKED` requires a valid `p_payment_id`.
- **Write:**
  - `LINKED`: insert the `chargeback_refresh` delivery for that payment (as S3), and set the signal-resolution columns (`signal_resolved_by` = uid).
  - `DISMISSED`: set the signal-resolution columns only. It is used when the ADMIN has evidence that no money moved (for example a dispute won before any debit); it creates no financial effect, and a later report chargeback row would still be ingested and reviewed normally.
- **Audit:** `MP_CHARGEBACK_SIGNAL_RESOLVE`.

## S4. `mp_ingest_api_snapshot`

`mp_ingest_api_snapshot(p_delivery_id UUID, p_claim_token UUID, p_payment_id VARCHAR, p_payload JSONB) RETURNS JSONB`

- **Actor:** service role.
- **Validations:**
  - the claim is valid (as S3);
  - `p_payment_id ~ '^[0-9]{1,20}$'`;
  - `p_payload->>'id' = p_payment_id`, else `PAYLOAD_ID_MISMATCH`;
  - `jsonb_typeof(p_payload) = 'object'`.
- **Identity (computed in the database, R4):** `external_id = 'MPPAY:' ‖ p_payment_id ‖ ':' ‖ left(encode(sha256(convert_to(p_payload::text, 'UTF8')), 'hex'), 32)`.
  - `jsonb::text` is canonical: keys are ordered and whitespace is normalized.
  - The length is at most 6 + 20 + 1 + 32 = 59, within VARCHAR(100).
- **Raw columns:**
  - `source_type = 'api_payment'`;
  - `event_data = p_payload`, verbatim;
  - `occurred_at` = the **V-2-confirmed authoritative approval date** of the payload, or for a not-yet-approved snapshot the V-2-confirmed creation date (R2; expected candidates `date_approved` / `date_created`, which V-2 must prove before code). A missing or malformed value → `PAYLOAD_DATE_INVALID`;
  - `occurred_date = (occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE`.
- **Write:** `INSERT … ON CONFLICT (source_type, external_id) DO NOTHING`, returning the new or existing id.
- **Result:** `{source_record_id, created: bool, processing_status}`.
- **Audit:** `MP_SNAPSHOT_INGEST` when created. It records the source id and payment id only, never the payload.
- The collector, currency and `live_mode` checks happen in the worker before this call and again in RPC 40 (§40).

---

## 40. `mp_normalize_source` — AMENDMENT (signature unchanged: `(p_source_record_id UUID) RETURNS JSONB`)

**Unchanged:**
- service role only;
- `FOR UPDATE` on the source (L2);
- `SOURCE_NOT_FOUND`;
- raw columns never written;
- the NORMALIZE audit;
- no period guard;
- the complete ADR-003 D1 Liberaciones parser and its validation order (0042) for `csv_import`.

**Changed precondition:** none. `ALREADY_PROCESSED` is raised when the status is not `PENDING`, exactly as before. Report rows parked in `PENDING` with note prefix `DEFERRED_BACKFILL:` or `DEFERRED_V4:` are still PENDING, so they may be re-evaluated. Only `processing_note` changes while a row is parked; it is controlled metadata under invariant 21.

**Dispatch by `source_type`:**

| source_type | Parser | Movement kinds |
|---|---|---|
| `csv_import` | ADR-003 D1, unchanged in content; implemented as the shared internal helper `mp_parse_report_row` (also used by the R2 fallback) | payment, yield, transfer (reserve → IGNORED) |
| `api_payment` | §40.2 | payment (APPROVAL) |
| `api_refund` | §40.3 | refund |
| `account_money_csv` | **V-3 blocked.** Until its parser is frozen these rows are **not ingested** (the worker and upload refuse them), so RPC 40 never sees them. A defensive branch → ERROR `UNSUPPORTED_CSV_FORMAT` |
| any other | ERROR `UNSUPPORTED_SOURCE_TYPE` (unchanged) |

### 40.1 Claim step (all parsers, after validation passes)

Inputs: `(resource_type, resource_id, transition, transition_ref)` and the movement values.

```
IF identity exists:
   → no movement; see the per-type outcome below
ELSE:
   in a subtransaction:
     INSERT the movement
     INSERT mp_transition_identity (…, claimed_by_source_id, mp_financial_movement_id)
   on unique_violation of uq_mp_transition (concurrent claimer):
     roll back the subtransaction; treat as "identity exists"
```

Transition resolution:
- `csv_import` payment row: **direction first** (`ADR006_V4_DIRECTION_CORRECTION.md` §3).
  - **Inbound** (direction C) → inbound candidate for `('payment', SOURCE_ID, 'APPROVAL', '')`.
  - **Outbound** (direction D, a payment made by the account) → `('payment', SOURCE_ID, 'OUTBOUND_PAYMENT', '')`:
    - movement `payment` with the exported negative amounts;
    - `mp_report_match` REPORT_ONLY;
    - not auto-applicable, not attributable (`NOT_A_RECEIPT`), no back-fill;
    - REVIEW_REQUIRED until the ADMIN links it (owning domain RPC plus RPC 41 Mode 2, payer-side tax through Mode 1 `ADJUSTMENT`).
    - Needs `'OUTBOUND_PAYMENT'` in `chk_transition_kind` (a later migration). An outbound row is **never** claimed as `APPROVAL`.
  - The same direction rule applies to the Account Money branch: K1 (net > 0) inbound, K2 (net < 0) outbound.
  - **This is the V-4 rule.** Until V-4 is proven, the equivalence `SOURCE_ID = payment id` is behind a helper `mp_v4_verified() RETURNS BOOLEAN` (SQL, IMMUTABLE, SECURITY INVOKER, owner-only EXECUTE), which returns `false` until a migration redefines it.
  - While false, a Liberaciones payment row is validated but **never claimed and never normalized**.
  - It stays `PENDING` with note `DEFERRED_V4: payment/API equivalence unverified`, and **creates no movement and no match**.
  - It remains usable only as balance evidence (§R4).
  - As a result, **no report row can create a payment movement while V-4 is open**, and double counting against API payments is impossible.
  - When V-4 is verified, a migration redefines the helper to return `true`. The worker then re-runs RPC 40 on those PENDING rows, and they follow §40.4. The helper may be redefined **only after** the direction-aware claim above is implemented (V-4 direction correction §9).
  - `mp_normalize_report_fallback` also requires V-4 (§R2).
- `csv_import` yield row → `('report', external_id, 'YIELD', '')`.
- `csv_import` payout row → `('report', external_id, 'PAYOUT', '')`.

### 40.2 `api_payment` parser

This parser is **implemented only after V-2** (implementation order step 6), directly against the V-2-confirmed MP fields. No placeholder field accessors are written before V-2. The steps below are fixed; the MP field names shown are the expected ones, and the V-2 evidence confirms or replaces them before any code is written. Validation order (the first failure decides; the outcome is ERROR with the note code):

1. `event_data` is an object with a numeric-string `id` equal to the id embedded in `external_id` → `IDENTITY_MISMATCH`.
2. `currency_id = 'ARS'` → `UNSUPPORTED_CURRENCY`.
3. `collector_id` present → `MISSING_COLLECTOR`. Equality with the configured account is enforced by the worker (the database stores no account identity).
4. `live_mode = true` → `NOT_LIVE_MODE`.
5. The MP payment field `operation_type` (an **external MP value**, not the internal `financial_operation_type`) is in the V-2-established set → `UNKNOWN_OPERATION_TYPE`. **V-2.**
6. `status` is one of the known values → `UNKNOWN_STATUS`.
7. If the V-2-confirmed approval date is present (expected candidate `date_approved`):
   - `transaction_amount`, `transaction_details.net_received_amount`, `fee_details[].amount` and the tax field (**V-2**) are numeric with ≤ 2 decimals → `MALFORMED_AMOUNT`;
   - gross = `transaction_amount` > 0 → `SIGN_INVALID`;
   - fee = −Σ `fee_details[].amount` (≤ 0);
   - tax = −Σ tax charges (**V-2**, ≤ 0);
   - net = `net_received_amount`;
   - gross + fee + tax = net exactly → `ARITHMETIC_MISMATCH`.
8. `occurred_at` / `occurred_date` equal the R2 derivation → `DATE_MISMATCH`.

Classification:
- no V-2-confirmed approval date (expected statuses: pending, in_process, rejected, cancelled — values per V-2) → **IGNORED** `NO_FINANCIAL_TRANSITION: status <s>`.
- Otherwise claim `('payment', id, 'APPROVAL', '')`:
  - **new** → movement `payment` (gross, fee, tax, net, occurred_date) → **NORMALIZED**;
  - **exists** → no movement → **IGNORED** `NO_NEW_TRANSITION`.
- In both approved cases, **refund discovery** (R1) follows: for each `refunds[]` element with `status = 'approved'` (field names **V-2**) whose identity `('payment', id, 'REFUND', refund_id)` is not claimed:
  - `INSERT mp_source_record` (`source_type = 'api_refund'`, `external_id = 'MPREF:' ‖ payment_id ‖ ':' ‖ refund_id`);
  - `event_data = {"payment_id", "refund": <element verbatim>, "parent_source_id"}`;
  - `occurred_at` = the **V-2-confirmed authoritative refund transition date** (expected candidate: the refund element's `date_created`; V-2 must prove it before code);
  - `ON CONFLICT DO NOTHING`;
  - children are left PENDING for the worker.
- a chargeback / mediation status (the V-2-confirmed status values; expected candidates `charged_back` / `in_mediation`) does not change the source status. The alert is derived by the view (R3). No amount is taken from it.

Result JSON: `{source_record_id, processing_status, movements_created, transition_id, children_created}`.

### 40.3 `api_refund` parser

1. `event_data` has exactly the keys `payment_id`, `refund`, `parent_source_id`, and the parent source exists with `source_type = 'api_payment'` → `MALFORMED_EVENT_DATA`.
2. The parent APPROVAL identity exists for `payment_id` → `REFUND_WITHOUT_APPROVAL`, an ERROR that is REVIEW_REQUIRED.
3. `refund.amount` is numeric, > 0, ≤ 2 decimals → `MALFORMED_AMOUNT`.
4. Σ of all claimed refund amounts for the payment plus this one ≤ the APPROVAL gross → `REFUND_EXCEEDS_PAYMENT`.
5. Claim `('payment', payment_id, 'REFUND', refund_id)`:
   - new → movement `refund` (gross = net = −amount, fee 0, tax 0) → **NORMALIZED**;
   - exists → **IGNORED** `NO_NEW_TRANSITION`.

### 40.4 Report rows — outcome when the identity already exists

For a report source (`csv_import`, later `account_money_csv`) whose transition was already claimed by another source:
- the status becomes **IGNORED**, with note `MATCHED_TO_TRANSITION <id>`;
- an `mp_report_match` row is inserted: **MATCHED** when gross, fee, tax, net and occurred_date are equal to the claimed movement's, otherwise **DISCREPANCY** with `detail = {field: {report, recorded}}`;
- **no movement and no financial write.**

For a report row whose transition is new and **report-only** (YIELD, PAYOUT, ACCOUNT_TAX, CHARGEBACK):
- claim → movement → NORMALIZED;
- plus `mp_report_match` **REPORT_ONLY**.

For a report **inbound** payment row (direction C) whose `('payment', …, 'APPROVAL', '')` identity does not exist (only possible once V-4 is verified). Outbound rows never enter this path; they claim `OUTBOUND_PAYMENT` as above:
- no movement;
- the status stays PENDING, with note `DEFERRED_BACKFILL: awaiting API payment <id>`;
- `INSERT mp_webhook_delivery (origin 'report_backfill', delivery_key 'backfill:payment:<id>', topic 'payment', resource_id <id>, report_source_id <this>) ON CONFLICT DO NOTHING`.
- When the API snapshot later claims the APPROVAL, the worker calls RPC 40 again on every PENDING report row that references that payment id, and the row becomes MATCHED or DISCREPANCY.

---

## A1. `mp_apply_transition` — the only automatic treasury writer

`mp_apply_transition(p_movement_id BIGINT) RETURNS JSONB`

- **Actor:** service role only (`FORBIDDEN` otherwise). EXECUTE is granted to `service_role` only.
- **Period determinant:** `movement.occurred_date`.

**Steps** (a single transaction; any exception rolls back everything):

1. **L3:** `SELECT … FROM mp_financial_movement WHERE id = p_movement_id FOR UPDATE` → `MOVEMENT_NOT_FOUND`.
2. **Auto-applicable check** (`mp_is_auto_applicable(movement)`, a SECURITY INVOKER helper also used by RPC 41):
   - an identity row exists with `mp_financial_movement_id = p_movement_id`;
   - the kind/transition pair is one of: payment/APPROVAL, refund/REFUND, chargeback/CHARGEBACK (V-3), yield/YIELD, account_tax/ACCOUNT_TAX (V-3);
   - `transfer`/PAYOUT is **never** applicable, because its bank side belongs to `transfer_between_accounts` (ADR-003 D7).
   - Otherwise → `NOT_AUTO_APPLICABLE`.
3. **L4:** lock the movement's source `FOR UPDATE`. A source in `ERROR` or `IGNORED` → `SOURCE_NOT_APPLICABLE`.
4. Resolve the MP account → `MP_ACCOUNT_MISSING`.
5. **Build the plan P.** For each component with a non-zero amount (a zero component is omitted, because `signed_amount <> 0`):

   | Component | op type | amount | key |
   |---|---|---|---|
   | SETTLE | `MP_SETTLEMENT` | `gross_amount` (yield / account_tax: `net_amount`, because those rows carry the whole effect in net; V-3 confirms account_tax) | `MPA:{t}:SETTLE` |
   | FEE | `FEE` | `fee_amount` | `MPA:{t}:FEE` |
   | TAX | `ADJUSTMENT` | `tax_amount` | `MPA:{t}:TAX` |

   `t` is the transition id. Each component carries `(key, op_type, account = MP, amount, effective_date = occurred_date, source_entity = ('mp_financial_movement', movement id))`.
6. **Prove** Σ(P.amount) = `net_amount` exactly → `APPLICATION_NET_MISMATCH`. For yield / account_tax, SETTLE = net, so this holds trivially.
7. **Existing-row equivalence.** Load E = every `mp_reconciliation` row of the movement, joined to its operation and to that operation's postings.
   - E is empty → go to step 8.
   - E ≡ P → return `{status: 'ALREADY_APPLIED', …}` with **no write and no audit**. "≡" means same cardinality, and for every key k in P an E row with `idempotency_key = k` whose:
     - operation has `operation_type`, `external_ref = 'MP:' ‖ k`, `effective_date`, `source_entity_type = 'mp_financial_movement'`, `source_entity_id = movement id`;
     - operation has exactly one posting, on the MP account, with `signed_amount` = the component amount;
     - reconciliation has `assigned_amount` = the component amount and `financial_account_id` = the MP account.
   - Any other E → `TRANSITION_ALREADY_ASSIGNED`. This is a hard stop and REVIEW_REQUIRED, reported through the view.
   - Also, if any `financial_operation.external_ref` in P exists **without** a matching reconciliation → `EXTERNAL_REF_CONFLICT`, a hard stop.
8. **L5**, for refund / chargeback only: lock the APPROVAL movement of the same payment (identity `('payment', resource_id, 'APPROVAL', '')`) → `APPROVAL_NOT_FOUND`.
9. **L6:** `assert_period_open(movement.occurred_date)` → `PERIOD_CLOSED` / `PERIOD_NOT_FOUND`.
10. **Write** each component: `financial_operation` (type, `effective_date`, `external_ref`, `source_entity_type`, `source_entity_id`, reason `'ADR-006 auto-apply'`, `created_by` NULL), then `financial_posting` (MP account, amount, `effective_date`, `created_by` NULL), then `mp_reconciliation` (movement, operation, MP account, amount, key, `reconciled_by` NULL).
    - The per-request cap of RPC 41 is **not** evaluated per component. Instead step 6 guarantees the committed Σ = net, so the committed-state invariant `abs(Σ) ≤ abs(net)` (ADR-003 D6) holds after commit.
11. **Status:** recompute the source with the ADR-003 D4 equivalence, using the same expression as 0042. The result is RECONCILED when every movement of the source is fully assigned.
12. **OD-1 unwinding** (refund / chargeback only; ADR-006 §5d), under L5:
    - R = │movement.gross_amount│;
    - A = the active allocations of the APPROVAL movement, where active = allocation amount − Σ of its reversals > 0;
    - restore = min(R, Σ A.active). If restore = 0, the client ledger is untouched;
    - Order: first the allocations identified by deterministic evidence (V1: when exactly one active allocation exists, it is the one; an AUTO allocation whose `evidence.external_reference` equals the refund's `external_reference`, if V-2 shows that field on refunds), then the rest by `created_at DESC, id DESC`.
    - For each part p (the last may be partial), with a new allocation id:
      - `client_ledger` REVERSAL +p (the client, `effective_date = movement.occurred_date`, `ledger_client_name` snapshot, `source_entity_type = 'mp_client_allocation'`, `source_entity_id = new id`, `reversal_of_id` = the original allocation's `client_ledger_id`);
      - `mp_client_allocation` (−p, `origin = 'MP_REVERSAL'`, `reversal_of_id`, `mp_transition_id = t`, key `MPREV:{alloc}:{t}`);
      - audit `MP_CLIENT_ALLOCATION_REVERSAL`.
13. **Audit** `MP_APPLY_TRANSITION` (entity `mp_financial_movement`, id; after = components, operation ids, source status, restored amount).
14. Return `{status: 'APPLIED', movement_id, transition_id, operations: [...], source_status, client_restored}`.

**Never written:** `collections`, a `client_ledger` COLLECTION entry, `register_collection`, or any operation type other than MP_SETTLEMENT / FEE / ADJUSTMENT.

### A1 worked example: payment gross 100, fee −5, tax −2, net 93 (transition t = 41)

| # | financial_operation | external_ref | posting (MP account) | mp_reconciliation.assigned | key |
|---|---|---|---|---|---|
| 1 | MP_SETTLEMENT | `MP:MPA:41:SETTLE` | +100.00 | +100.00 | `MPA:41:SETTLE` |
| 2 | FEE | `MP:MPA:41:FEE` | −5.00 | −5.00 | `MPA:41:FEE` |
| 3 | ADJUSTMENT | `MP:MPA:41:TAX` | −2.00 | −2.00 | `MPA:41:TAX` |

- The MP balance changes by +93.00.
- Σ assigned is 93.00 = net, so the source is RECONCILED.
- `client_ledger`: 0 rows. `collections`: 0 rows.
- The state +100 is never committed alone.
- P&L (0045): Costos indirectos −5 from the movement; the tax is excluded; MP_SETTLEMENT / FEE / ADJUSTMENT operations contribute nothing (ADR-004 D10 / D13).

**Replay:** returns `ALREADY_APPLIED` with zero writes.

**Replay after a manual change**, for example an ADMIN RPC 41 counter-assignment made after application: E ≠ P → `TRANSITION_ALREADY_ASSIGNED`. The worker then treats the movement as already handled and routes it to review. It never rewrites.

### A1 refund example: partial refund 30 of that payment (refund transition t = 57), with active allocation 60 to client X

- Treasury: MP_SETTLEMENT −30.00 (key `MPA:57:SETTLE`); MP balance −30.
- OD-1: restore = min(30, 60) = 30. X's ledger gets REVERSAL +30; an allocation row −30 is written (MP_REVERSAL); active attribution goes from 60 to 30.
- The effective receipt goes from 100 to 70; the invariant 0 ≤ 30 ≤ 70 holds.

### A1 chargeback

- **API:** no movement. It is a derived alert only (R3).
- **Report row (V-3):**
  - it needs the Account Money parser (V-3) **and** the V-4 equivalence to reference the payment id;
  - the claim is `('payment', payment_id, 'CHARGEBACK', '')`;
  - until both are verified, chargeback rows are not ingested (V-3). The derived API alert (R3) keeps the case in REVIEW_REQUIRED.
- The movement `chargeback` (gross = net = −amount per the report) is applied as above: MP_SETTLEMENT −amount, plus OD-1 with R = amount.

---

## 41. `mp_reconcile_movement` — AMENDMENT (signature, modes and cap unchanged)

- One guard is inserted **after** the movement lock and **before** the per-request cap check: if `mp_is_auto_applicable(movement)` and the movement has zero `mp_reconciliation` rows → `AUTO_APPLICATION_PENDING`.
- Everything else is exactly 0042.
- After application, RPC 41 remains available to the ADMIN (and the service role) for:
  - counter-assignments (D6), for example a fee refund discovered by the report: Mode 1 `FEE` +x paired with an opposite component, keeping the per-request cap;
  - Mode 2 links, for example a payout to `transfer_between_accounts`.

---

## C1. `mp_allocate_to_client` (MANUAL)

`mp_allocate_to_client(p_movement_id BIGINT, p_cliente_id UUID, p_amount NUMERIC, p_effective_date DATE, p_idempotency_key VARCHAR, p_reason TEXT) RETURNS JSONB`

- **Actor:** ADMIN (`authenticated` EXECUTE; the body checks ADMIN).
- **Validations, in order:**
  1. `p_amount > 0` with ≤ 2 decimals → `INVALID_AMOUNT`.
  2. The key is 1–97 characters with none of the reserved prefixes → `INVALID_IDEMPOTENCY_KEY`.
  3. The reason is non-empty → `REASON_REQUIRED`.
  4. `EXISTS allocation with key` → `DUPLICATE_ALLOCATION`.
  5. **L5:** lock the movement; it must be a `payment` movement whose identity is APPROVAL → `NOT_A_RECEIPT`.
  6. The source is not ERROR, and the movement is fully applied (Σ assigned = net) → `RECEIPT_NOT_POSTED`. Money must exist before attribution.
  7. The client exists and is active → `CLIENT_NOT_FOUND_OR_INACTIVE`.
  8. `p_effective_date ≥ movement.occurred_date` → `EFFECTIVE_DATE_BEFORE_RECEIPT`.
  9. **L6:** `assert_period_open(p_effective_date)`.
  10. **Cap:** `active = Σ allocation.amount` (movement); `bound = effective_applied_receipt` = gross − Σ │gross│ of the REFUND / CHARGEBACK movements of the payment that are **successfully applied** (reconciliation key `MPA:{t}:SETTLE` exists; claimed-but-unapplied reversals are excluded, because their OD-1 unwinding has not happened yet); `active + p_amount ≤ bound` → `ALLOCATION_EXCEEDS_RECEIPT`.
- **Writes:**
  - `client_ledger` (COLLECTION, −p_amount, `effective_date`, name snapshot, `'mp_client_allocation'` / new id, reason, `created_by` = uid);
  - `mp_client_allocation` (ALLOCATION, MANUAL, evidence `{"reason": …}`);
  - an open `mp_attribution_flag` is cleared if the new active total = bound;
  - audit `MP_CLIENT_ALLOCATION`.
- **Never:** `financial_operation`, `financial_posting`, `collections`.
- **Returns** `{allocation_id, client_ledger_id, active_attributed, effective_receipt}`.

## C2. `mp_auto_allocate` (AUTO; deterministic evidence only)

`mp_auto_allocate(p_movement_id BIGINT) RETURNS JSONB`

- **Actor:** service role only. **No client parameter.**
- Steps 5–6 of C1 (L5, RECEIPT_NOT_POSTED).

**Evidence derivation** from the claiming `api_payment` snapshot of the APPROVAL:
- (a) `external_reference ~ '^GST:C:<uuid>$'` → that client; `'^GST:P:<uuid>$'` → `pedidos.cliente_id` of that pedido.
- (b) payer id (field **V-2**) → the active `mp_payer_client_map` row.

**Decision:**
- The candidate set is the distinct client ids from (a) and (b).
- `|set| ≠ 1`, a client that is not active, `active ≠ 0` (a MANUAL allocation already exists), or a CLOSED period for `movement.occurred_date` → return `{allocated: false, reason: <code>}` with **no write and no error** (NONE state). The code is one of `NO_EVIDENCE`, `AMBIGUOUS_EVIDENCE`, `CLIENT_INACTIVE`, `ALREADY_ATTRIBUTED`, `PERIOD_CLOSED`.
- Otherwise allocate `amount = bound` (the effective receipt), `effective_date = movement.occurred_date`, key `MPAUTO:{approval transition id}`, `mode = 'AUTO'`, `evidence = {"external_reference" | "payer_map_id", …}`.

**Duplicate key** → `{allocated: false, reason: 'ALREADY_ALLOCATED'}`, a no-op. Writes and audit are as in C1 with `created_by` NULL.

## C3. `mp_reverse_client_allocation` (MANUAL correction)

`mp_reverse_client_allocation(p_allocation_id UUID, p_amount NUMERIC, p_idempotency_key VARCHAR, p_reason TEXT) RETURNS JSONB`

- **Actor:** ADMIN.
- **Validations:**
  - the allocation exists with `origin = 'ALLOCATION'` → `ALLOCATION_NOT_FOUND`;
  - **L5** on its movement;
  - `0 < p_amount ≤ remaining = amount − Σ reversals of it` → `REVERSAL_EXCEEDS_ALLOCATION`;
  - a reason is present;
  - the key is valid and unused → `DUPLICATE_ALLOCATION`;
  - **L6:** `assert_period_open(CURRENT_DATE in America/Argentina/Buenos_Aires)`. A correction is dated when it is made; the original fact is never rewritten.
- **Writes:** `client_ledger` REVERSAL +p (`reversal_of_id` = the original ledger row); allocation −p (`MANUAL_REVERSAL`); audit `MP_CLIENT_ALLOCATION_REVERSAL`.

## C4. `mp_flag_for_attribution` / C5. `mp_clear_attribution_flag`

- `mp_flag_for_attribution(p_movement_id BIGINT, p_reason TEXT) RETURNS JSONB`
  - ADMIN; APPROVAL movement → `NOT_A_RECEIPT`; reason required.
  - An existing open flag → `FLAG_ALREADY_OPEN`.
  - Audit `MP_ATTRIBUTION_FLAG`.
- `mp_clear_attribution_flag(p_flag_id UUID, p_reason TEXT) RETURNS JSONB`
  - ADMIN; the flag must be open → `FLAG_NOT_OPEN`; reason required.
  - Sets `cleared_*`. Audit `MP_ATTRIBUTION_FLAG_CLEAR`.

No period guard: a flag is a work marker, not a business fact.

## C6. `mp_map_payer_to_client` / C7. `mp_unmap_payer`

- `mp_map_payer_to_client(p_mp_payer_id VARCHAR, p_cliente_id UUID, p_reason TEXT) RETURNS JSONB`
  - ADMIN; format check; active client.
  - An active mapping for the payer → `PAYER_ALREADY_MAPPED` (unmap first).
  - Audit `MP_PAYER_MAP`.
  - It does **not** attribute past receipts retroactively. Only receipts processed afterwards, or re-offered through `mp_auto_allocate` by the worker's daily sweep of unattributed POSTED receipts from the last 30 days, can use it.
- `mp_unmap_payer(p_mapping_id UUID, p_reason TEXT) RETURNS JSONB`
  - ADMIN; the mapping must be active.
  - Sets `activo = false` and the `deactivated_*` columns. Existing allocations are unaffected.
  - Audit `MP_PAYER_UNMAP`.

---

## R1. `mp_resolve_match`

`mp_resolve_match(p_match_id UUID, p_resolution VARCHAR, p_reason TEXT) RETURNS JSONB`

- **Actor:** ADMIN.
- **Validations:**
  - the match exists → `MATCH_NOT_FOUND`;
  - `is_exception` → `NOT_AN_EXCEPTION`;
  - unresolved → `ALREADY_RESOLVED`;
  - `p_resolution ∈ ('EXPLAINED','CORRECTED','SUPERSEDED')`;
  - a reason is required.
- For `CORRECTED`: the RPC checks that at least one RPC 41 reconciliation or `mp_apply_transition` operation was created for the transition after `match.created_at` → `NO_CORRECTION_FOUND`. It does **not** create one; financial corrections go only through RPC 41.
- **Writes:** the resolution columns and audit `MP_MATCH_RESOLVE`. No financial write.

## R2. `mp_normalize_report_fallback` (still required)

`mp_normalize_report_fallback(p_source_record_id UUID, p_reason TEXT) RETURNS JSONB`

- **Actor:** ADMIN.
- **Purpose:** the API payment is permanently unavailable, so the ADMIN authorizes creating the movement **from the report row** (ADR-006 §8 step 4).
- **Preconditions, checked in order:**
  1. ADMIN → `FORBIDDEN`.
  2. `mp_v4_verified()` is true → `V4_NOT_VERIFIED`.
  3. A reason is present → `REASON_REQUIRED`.
  4. **L2:** lock the source `FOR UPDATE`. It must be a report type (`csv_import`, later `account_money_csv`) in `PENDING` with note `DEFERRED_BACKFILL:` → `NOT_DEFERRED`.
  5. Its back-fill delivery (`report_source_id` = this source) is `FAILED_PERMANENT` → `BACKFILL_NOT_EXHAUSTED`.
  6. The row is an inbound candidate (direction C / Account Money net > 0) → `OUTBOUND_NOT_ELIGIBLE`. This is defence in depth: outbound rows never reach `DEFERRED_BACKFILL`, so check 4 normally refuses them first.
  7. Its back-fill did not fail with `COLLECTOR_MISMATCH` → `DIRECTION_CONFLICT`. The report and the API disagree on direction, and the row stays REVIEW_REQUIRED (V-4 direction correction §3).

**Why it cannot reuse the public RPC 40 path:** for a report payment row with no claimed API transition, RPC 40's normal outcome **is** `DEFERRED_BACKFILL`. Calling it again would only defer again. The fallback therefore uses a **separate internal claim path**.

**Internal helpers** (SECURITY INVOKER; `REVOKE ALL … FROM PUBLIC, anon, authenticated, service_role`; executable only by the owner, i.e. only from inside owner-run definer functions; **not** in the definer inventory):
- `mp_parse_report_row(p_source mp_source_record) RETURNS record`: the pure ADR-003 D1 / V-3 row validation and value extraction. It is shared **verbatim** by RPC 40 and the fallback, so the validation is identical by construction. It never writes.
- `mp_claim_report_payment_fallback(p_source_id UUID, p_actor UUID, p_reason TEXT) RETURNS JSONB`:
  - calls `mp_parse_report_row`; a failure means the fallback is refused with that validation code. The source is **not** moved to ERROR, because the ADMIN's action must not alter the normal path's state;
  - claims `('payment', SOURCE_ID, 'APPROVAL', '')` through the same claim subtransaction as §40.1. If the identity already exists (an API snapshot arrived meanwhile), there is no movement: the row is treated exactly like §40.4 "identity exists" (IGNORED + MATCHED / DISCREPANCY), and it returns `ALREADY_CLAIMED`;
  - otherwise it inserts the movement and identity, sets the source to `NORMALIZED` with note `REPORT_FALLBACK`, inserts `mp_report_match` REPORT_ONLY with `detail.fallback = true`, and writes audit `MP_REPORT_FALLBACK` (actor = ADMIN, reason).
- RPC 40 **never** calls `mp_claim_report_payment_fallback`, so normal report imports cannot skip API-first behaviour. The only caller is `mp_normalize_report_fallback`. This is asserted by test M-6b through `pg_depend` / source inspection, and by the absence of EXECUTE grants.

**After the fallback:**
- The worker applies the transition (A1).
- A later API snapshot for that payment finds the identity claimed → IGNORED `NO_NEW_TRANSITION`. First claimant wins, so there is no double count.
- There is no user-facing technical choice: the ADMIN action is "create from report", and it is available only when the back-fill is exhausted.

## R3. `mp_check_report_coverage`

`mp_check_report_coverage(p_report_type VARCHAR, p_from DATE, p_to DATE) RETURNS JSONB`

- **Actor:** service role (scheduled after each report import).
- For every claimed transition with `movement.occurred_date` in `[p_from, p_to]`, of a type that the named report covers (V-3 defines the coverage per report type), that has no MATCHED / DISCREPANCY match from a report source of that type:
  - `INSERT mp_report_match MISSING_IN_REPORT (transition_id, coverage_from, coverage_to) ON CONFLICT DO NOTHING`.
- Audit `MP_COVERAGE_CHECK` with counts.
- **Idempotent:** re-running the same window adds nothing.

## R4. `mp_record_balance_check`

`mp_record_balance_check(p_report_source_id UUID) RETURNS JSONB`

- **Actor:** service role.
- The report row must carry a balance field: `BALANCE_AMOUNT` for Liberaciones, the V-3 field for Account Money.
- Compare with `Σ financial_posting.signed_amount` on the MP account where `effective_date ≤ occurred_date` of the row, **only for the last report row of that day** (day granularity, because postings are dated, not timed). For another row of that day → `NOT_DAY_CLOSING_ROW`.
- Insert BALANCE_CHECK with `detail = {reported, computed, difference, as_of_date}` and `is_exception = (difference ≠ 0)`. `ON CONFLICT (report_source_id, outcome) DO NOTHING`.
- The computed value is evidence at check time, never an authoritative balance.
