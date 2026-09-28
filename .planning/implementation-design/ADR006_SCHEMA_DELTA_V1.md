# ADR-006 SCHEMA DELTA V1

**Status:** implementation design; not implemented. No migration exists.
**Authority:**
- ADR-006 (ACCEPTED 2026-09-27, revision 3);
- ADR-003;
- POSTGRES_SCHEMA_SPEC_V1 Domains D and L;
- DATABASE_INVARIANTS_V1 (9, 21, 27);
- migrations 0039–0046 as built.

**Frozen documents are not modified.** Where this delta touches a Frozen object, it cites the ADR-006 section that authorizes it.

**Planned migrations:**

| File | Contents |
|---|---|
| `0047_mp_realtime_tables.sql` | 2 enums, 6 tables, 2 guard triggers |
| `0048_mp_realtime_core_rpcs.sql` | pre-V-2 functions: helpers, queue S1–S3 / S5, attribution C1–C7, report R1 / R3 / R4, RPC 40 `csv_import`-branch redefinition |
| `0049_mp_delivery_chargeback_payload_keys.sql` | Step 4: `chk_delivery_payload_keys` gains the V-1-documented chargeback keys `actions` and `data_payment_id` (chargeback deliveries only; owner decision 2026-09-28, which renumbered the later files) |
| `0050_mp_realtime_payment_rpcs.sql` | post-V-2: S4, RPC 40 `api_payment` / `api_refund` parsers, A1, RPC 41 guard, R2 |
| `0051_mp_realtime_privileges_rls.sql` | grants and policies |
| `0052_mp_realtime_views.sql` | the Phase 27 read views |

---

## 0. Implementation refinements (mechanics only; no ADR-006 decision changes)

These follow mechanically from the existing schema. Reviewers should confirm them.

| # | Refinement | Why | ADR-006 reference |
|---|---|---|---|
| R1 | A refund is ingested as its own **child source** `source_type = 'api_refund'`, created by RPC 40 from the `refunds[]` element of an authoritative `api_payment` snapshot. | `mp_financial_movement UNIQUE(mp_source_record_id, movement_kind)` (0039) allows one `refund` movement per source. A snapshot can reveal several refunds at once. A child source per refund keeps the constraint unchanged. | §6.3 (REFUND transition per refund id) |
| R2 | For `api_payment` sources, `occurred_at` = the **V-2-confirmed authoritative approval date** (expected candidate `date_approved`; for a not-yet-approved snapshot, the V-2-confirmed creation date, expected candidate `date_created`). For `api_refund` sources, `occurred_at` = the **V-2-confirmed authoritative refund transition date** (expected candidate: the refund's `date_created`). No field is frozen before V-2 proves it. `date_last_updated` is kept inside `event_data` only. | This keeps "movement `occurred_date` inherited from source" (0042 RPC 40) literally true, while the movement is dated by its transition, as ADR-006 §6.3 requires. | §6.2 wording ("`occurred_at = date_last_updated`") is refined, not changed in meaning |
| R3 | A chargeback is signalled in two ways, **neither of which carries a financial amount**: (a) the **chargeback webhook notification** (topic and identifiers per the V-1 documentation check), stored durably as a `chargeback` delivery ending in `SIGNAL_RECORDED`, which triggers a payment refresh when the payment id is known (§2, ADR006_WEBHOOK_WORKER_DESIGN_V1 §4a); (b) a payment snapshot whose V-2-confirmed status field shows a chargeback or mediation. Both are **derived** into REVIEW_REQUIRED (view `report_mp_receipt_status` / `report_mp_delivery_health`). Neither is stored as source `ERROR`. The treasury effect waits for an authoritative amount: the API only if V-2 proves a chargeback amount source, otherwise the V-3 report. | A snapshot can claim APPROVAL and show a chargeback at the same time, and `ERROR` would conflict with the movement's later `RECONCILED` recomputation. The webhook body is never financial truth (ADR-006 §6.1). | ADR-006 §5 chargeback row; §6.1 |
| R4 | Direct service-role INSERT into `mp_source_record` is narrowed to report source types. `api_payment` / `api_refund` rows are created only by RPCs that compute the identity in the database. | The content-hash identity must not be forgeable by a caller. | §7 layer 2 |
| R5 | The SECURITY DEFINER inventory is **41 → 60**: 41 existing, enumerated mechanically from migrations 0001–0046; 19 new, disjoint from those; union 60. Both sets are listed in ADR006_RLS_AND_SECURITY_V1 §4. The test asserts the **exact set**, not only the count. | Every new RPC follows the Frozen hardening pattern. The RLS spec text ("43") describes the frozen design count, not the implemented baseline; ADR-006 is the authority for the new expected set (ADR-001 precedent). | §9 |

---

## 1. New enum types

```
mp_delivery_status  = ('RECEIVED','PROCESSING','FETCHED','SIGNAL_RECORDED','FAILED_RETRYABLE','FAILED_PERMANENT','CONFIG_BLOCKED','UNSUPPORTED')
mp_match_outcome    = ('MATCHED','DISCREPANCY','REPORT_ONLY','MISSING_IN_REPORT','BALANCE_CHECK')
```

`mp_processing_status` is unchanged; no value is added (ADR-006 §9).

---

## 2. `mp_webhook_delivery` — inbox / work queue (not financial)

**Business meaning:** one authenticated notification, or one internal request, to refresh an MP resource. Origins are a webhook, a report back-fill, a chargeback-triggered payment refresh, or an ADMIN re-fetch. It never carries financial truth.

| Column | Type | Null | Default | Mutability |
|---|---|---|---|---|
| `id` | UUID | NOT NULL | `gen_random_uuid()` | immutable (PK) |
| `delivery_key` | VARCHAR(200) | NOT NULL | — | immutable, UNIQUE (§2.1) |
| `notification_sha256` | CHAR(64) | NOT NULL | — | immutable. Computed only by `mp_register_delivery` (or by the inserting RPC for internal origins) with the single canonical formula **N-SHA** (ADR006_RPC_CONTRACTS_V1 §S1): the hash of `jsonb_build_array(origin, topic_class, topic, action, resource_id, notification_payload)::text`, in that order, with NULL action / resource_id → JSON null and NULL payload → `{}` |
| `key_conflict_of` | UUID | NULL | — | immutable; FK → `mp_webhook_delivery(id)` RESTRICT. Set when this row was stored because its natural key collided with a row of **different** content (§2.1) |
| `origin` | VARCHAR(20) | NOT NULL | — | immutable |
| `topic` | VARCHAR(50) | NOT NULL | — | immutable (the raw MP topic / type string) |
| `topic_class` | VARCHAR(20) | NOT NULL | — | immutable: `payment` / `chargeback` / `unsupported`, from the V-1-verified topic mapping |
| `action` | VARCHAR(50) | NULL | — | immutable |
| `resource_id` | VARCHAR(100) | NULL | — | immutable (payment id for `payment`, chargeback id for `chargeback`) |
| `x_request_id` | VARCHAR(128) | NULL | — | immutable; signed request metadata, **stored for traceability, never used as the identity** |
| `notification_payload` | JSONB | NOT NULL | `'{}'` | immutable |
| `signature_verified` | BOOLEAN | NOT NULL | — | immutable |
| `report_source_id` | UUID | NULL | — | immutable; FK → `mp_source_record(id)` RESTRICT |
| `triggered_by_delivery_id` | UUID | NULL | — | immutable; FK → `mp_webhook_delivery(id)` RESTRICT (the chargeback signal that caused this payment refresh) |
| `received_at` | TIMESTAMPTZ | NOT NULL | `NOW()` | immutable |
| `signal_resolution` | VARCHAR(20) | NULL | — | set once: `LINKED` / `DISMISSED` (chargeback signals only) |
| `signal_resolution_reason` / `signal_resolved_by` / `signal_resolved_at` | TEXT / UUID / TIMESTAMPTZ | NULL | — | set once, together; `signal_resolved_by` FK → `perfiles` (NULL = automatic link by the service role) |
| `status` | mp_delivery_status | NOT NULL | `'RECEIVED'` | mutable via RPC only |
| `attempts` | INTEGER | NOT NULL | `0` | mutable via RPC only |
| `next_attempt_at` | TIMESTAMPTZ | NOT NULL | `NOW()` | mutable via RPC only |
| `first_failed_at` | TIMESTAMPTZ | NULL | — | mutable via RPC only (set once) |
| `lease_expires_at` | TIMESTAMPTZ | NULL | — | mutable via RPC only |
| `claim_token` | UUID | NULL | — | mutable via RPC only |
| `last_error_code` | VARCHAR(50) | NULL | — | mutable via RPC only |
| `last_error_detail` | VARCHAR(500) | NULL | — | mutable via RPC only (sanitized, never payload or secrets) |
| `source_record_id` | UUID | NULL | — | mutable via RPC only; FK → `mp_source_record(id)` RESTRICT |
| `updated_at` | TIMESTAMPTZ | NOT NULL | `NOW()` | mutable via RPC only |

**Constraints:**
- `chk_delivery_origin`: `origin IN ('webhook','report_backfill','chargeback_refresh','manual_refetch')`.
- `chk_delivery_signature`: `origin <> 'webhook' OR signature_verified`. Unverified webhooks are never stored (ADR-006 §6.1).
- `chk_delivery_topic_class`: `topic_class IN ('payment','chargeback','unsupported')`. Non-webhook origins are always `payment`.
- `chk_delivery_payment_resource`: `topic_class <> 'payment' OR resource_id ~ '^[0-9]{1,20}$'`.
- `chk_delivery_backfill_ref`: `(origin = 'report_backfill') = (report_source_id IS NOT NULL)`.
- `chk_delivery_trigger_ref`: `(origin = 'chargeback_refresh') = (triggered_by_delivery_id IS NOT NULL)`.
- `chk_delivery_payload_keys`: `(notification_payload - ARRAY['type','topic','action','data_id','live_mode','user_id','api_version','date_created','notification_id']) = '{}'::jsonb`. The reduced body only, with no payer data. Chargeback-specific keys are added only if V-1 documents them. V-1 documents them (ADR006_V1_WEBHOOK_EVIDENCE §6), so 0049 adds `actions` (a JSON array) and `data_payment_id` (a digit string, `^[0-9]{1,20}$`), allowed only when `topic_class = 'chargeback'`; they are envelope evidence, never financial truth.
- `chk_delivery_fetched`: `status <> 'FETCHED' OR source_record_id IS NOT NULL`.
- `chk_delivery_signal_status`: `status <> 'SIGNAL_RECORDED' OR topic_class = 'chargeback'`, and `topic_class <> 'chargeback' OR status <> 'FETCHED'`. A chargeback notification never produces a financial source; its successful end state is `SIGNAL_RECORDED`.
- `chk_delivery_signal_resolution`: the four signal-resolution columns are all NULL or all set (`signal_resolved_by` may be NULL for an automatic link); `signal_resolution IS NULL OR (topic_class = 'chargeback' AND signal_resolution IN ('LINKED','DISMISSED'))`.
- `chk_delivery_processing`: `(status = 'PROCESSING') = (claim_token IS NOT NULL AND lease_expires_at IS NOT NULL)`.
- `chk_delivery_attempts`: `attempts >= 0`.
- `chk_delivery_config_blocked`: `status <> 'CONFIG_BLOCKED' OR last_error_code = 'AUTH_CONFIGURATION_ERROR'`. A `CONFIG_BLOCKED` row is never selected by the claim; it leaves that state only through `mp_requeue_config_blocked`.

**Indexes:**
- `idx_mp_delivery_due ON (next_attempt_at) WHERE status IN ('RECEIVED','FAILED_RETRYABLE')`;
- `idx_mp_delivery_lease ON (lease_expires_at) WHERE status = 'PROCESSING'`;
- `idx_mp_delivery_config_blocked ON (updated_at) WHERE status = 'CONFIG_BLOCKED'`;
- `idx_mp_delivery_resource ON (topic, resource_id)`.

**Guard:** `trg_mp_delivery_immutable` (BEFORE UPDATE, SECURITY INVOKER function `mp_delivery_immutable_guard()`, same pattern as 0039). It raises if any immutable column changes, and it allows the signal-resolution columns only to go from NULL to a value, once.

**Actor:**
- INSERT only through:
  - `mp_register_delivery` (webhook, and the service role's automatic `chargeback_refresh`);
  - RPC 40 (back-fill);
  - `mp_request_refetch` (ADMIN `manual_refetch`);
  - `mp_resolve_chargeback_signal` (ADMIN link → `chargeback_refresh`).
- UPDATE only through `mp_claim_deliveries`, `mp_delivery_transition`, `mp_requeue_config_blocked`, and `mp_resolve_chargeback_signal` / `mp_delivery_transition(SIGNAL_RECORDED, link)` for the signal columns.

### 2.1 Delivery identity (not `x-request-id`)

`x-request-id` is stored in `x_request_id` for traceability only. Correctness never assumes that MP reuses it on retries.

| Case | `delivery_key` |
|---|---|
| webhook whose body carries a **documented, stable notification id** (V-1 establishes which field, per topic class) | `'n:' ‖ topic_class ‖ ':' ‖ notification_id` |
| webhook without such an id (or with an id outside `^[A-Za-z0-9._:-]{1,120}$`) | `'h:' ‖ notification_sha256`, where the hash is the N-SHA formula (origin, topic_class, topic, action, resource_id, reduced payload; no headers) |
| report back-fill | `'backfill:payment:' ‖ payment_id` |
| chargeback-triggered refresh | `'cbrefresh:' ‖ triggered_by_delivery_id ‖ ':' ‖ payment_id` |
| ADMIN re-fetch | `'refetch:' ‖ payment_id ‖ ':' ‖ request uuid` |

**Duplicate key handling** (`mp_register_delivery`):
- **Same key, same `notification_sha256`:** it is the same notification retried. No new row; `{created: false}`.
- **Same key, different `notification_sha256`:** it is **never** accepted as the same delivery. The new notification is stored as its own row:
  - `delivery_key = 'conflict:' ‖ encode(sha256(convert_to(original_delivery_key ‖ ':' ‖ notification_sha256, 'UTF8')), 'hex')`, which is always exactly 73 characters;
  - `key_conflict_of` = the original natural-key row.
  - The same conflicting notification replayed derives the same conflict key → no new row, no unique violation. A different conflicting content → a different conflict key → a distinct row.
  - It is processed normally, because fetching the authoritative resource is safe, and it is counted in `report_mp_delivery_health.key_conflicts` as a security / integration anomaly.
- **Key length bound:** every key form fits VARCHAR(200). The maxima are `n:` 134, `h:` 66, `conflict:` 73, `backfill:payment:` 37, `cbrefresh:` 67 and `refetch:` 65.
- **A new, distinct notification for an already-known payment** has a new key, so it is a new delivery. Both deliveries fetch the same authoritative resource, and identity layers 2–5 guarantee zero duplicate effect.

**Deletion:** none. No role holds DELETE. Retention and archiving are out of V1 scope.

**RLS:** ADMIN SELECT; service role SELECT; no other policy.

---

## 3. `mp_transition_identity` — normalized movement identity (the anti-double-count backstop)

**Business meaning:** "this economic transition of this MP resource has been recorded once, by this source, as this movement".

| Column | Type | Null | Default | Mutability |
|---|---|---|---|---|
| `id` | BIGSERIAL | NOT NULL | — | immutable (PK) |
| `resource_type` | VARCHAR(20) | NOT NULL | — | immutable |
| `resource_id` | VARCHAR(100) | NOT NULL | — | immutable |
| `transition` | VARCHAR(30) | NOT NULL | — | immutable |
| `transition_ref` | VARCHAR(100) | NOT NULL | `''` | immutable |
| `claimed_by_source_id` | UUID | NOT NULL | — | immutable; FK → `mp_source_record(id)` RESTRICT |
| `mp_financial_movement_id` | BIGINT | NOT NULL | — | immutable; FK → `mp_financial_movement(id)` RESTRICT; **UNIQUE** |
| `claimed_at` | TIMESTAMPTZ | NOT NULL | `NOW()` | immutable |

**Constraints:**
- `uq_mp_transition` UNIQUE `(resource_type, resource_id, transition, transition_ref)`.
- `chk_transition_resource_type`: `resource_type IN ('payment','report')`.
- `chk_transition_kind`: `transition IN ('APPROVAL','REFUND','CHARGEBACK','YIELD','PAYOUT','ACCOUNT_TAX')`. It is extended only by a later migration under an ADR-006 V-3 addendum.
- `chk_transition_ref`: `(transition = 'REFUND') = (transition_ref <> '')`.
- `chk_transition_payment_id`: `resource_type <> 'payment' OR resource_id ~ '^[0-9]{1,20}$'`.

**Indexes:** `idx_mp_transition_source ON (claimed_by_source_id)`; `idx_mp_transition_resource ON (resource_type, resource_id)`.

**Actor:** INSERT only by RPC 40 (and `mp_normalize_report_fallback`, which runs the same claim). **Append-only:** no UPDATE or DELETE for any role, so the table joins invariant 9.

**RLS:** ADMIN SELECT; service role SELECT.

---

## 4. `mp_report_match` — reconciliation evidence

**Business meaning:** the outcome of comparing report evidence with already-recorded MP transitions (axis A). It is evidence only; it has no financial effect.

| Column | Type | Null | Default | Mutability |
|---|---|---|---|---|
| `id` | UUID | NOT NULL | `gen_random_uuid()` | immutable (PK) |
| `outcome` | mp_match_outcome | NOT NULL | — | immutable |
| `report_source_id` | UUID | NULL | — | immutable; FK → `mp_source_record(id)` RESTRICT |
| `transition_id` | BIGINT | NULL | — | immutable; FK → `mp_transition_identity(id)` RESTRICT |
| `coverage_from` | DATE | NULL | — | immutable |
| `coverage_to` | DATE | NULL | — | immutable |
| `detail` | JSONB | NOT NULL | `'{}'` | immutable (field-level differences; for BALANCE_CHECK: reported vs computed evidence at check time) |
| `is_exception` | BOOLEAN | NOT NULL | — | immutable (set at insert: DISCREPANCY, MISSING_IN_REPORT, or a non-zero BALANCE_CHECK difference) |
| `created_at` | TIMESTAMPTZ | NOT NULL | `NOW()` | immutable |
| `resolution` | VARCHAR(20) | NULL | — | set once via `mp_resolve_match` |
| `resolution_reason` | TEXT | NULL | — | set once |
| `resolved_by` | UUID | NULL | — | set once; FK → `perfiles(id)` |
| `resolved_at` | TIMESTAMPTZ | NULL | — | set once |

**Constraints:**
- `chk_match_shape`:
  - MATCHED / DISCREPANCY: `report_source_id` and `transition_id` NOT NULL;
  - REPORT_ONLY: `report_source_id` and `transition_id` NOT NULL;
  - MISSING_IN_REPORT: `transition_id`, `coverage_from` and `coverage_to` NOT NULL, `report_source_id` NULL;
  - BALANCE_CHECK: `report_source_id` NOT NULL, `transition_id` NULL.
- `chk_match_exception`: `is_exception = (outcome IN ('DISCREPANCY','MISSING_IN_REPORT') OR (outcome = 'BALANCE_CHECK' AND (detail->>'difference')::NUMERIC <> 0))`.
- `chk_match_resolution_set`: resolution, resolution_reason, resolved_by and resolved_at are all NULL or all NOT NULL.
- `chk_match_resolution_value`: `resolution IS NULL OR resolution IN ('EXPLAINED','CORRECTED','SUPERSEDED')`.
- `chk_match_resolution_only_exception`: `resolution IS NULL OR is_exception`.
- `chk_match_coverage`: `coverage_from IS NULL OR coverage_from <= coverage_to`.
- `uq_match_report_outcome` UNIQUE `(report_source_id, outcome)`. NULLs are distinct, so MISSING rows are unaffected.
- `uq_match_missing` UNIQUE `(transition_id, coverage_from, coverage_to) WHERE outcome = 'MISSING_IN_REPORT'`.

**Guard:** `trg_mp_report_match_guard` (SECURITY INVOKER) makes every column immutable and lets the resolution columns change only from NULL to a value, once.

**Actor:**
- INSERT by RPC 40 (MATCHED, DISCREPANCY, REPORT_ONLY), `mp_check_report_coverage` (MISSING_IN_REPORT) and `mp_record_balance_check` (BALANCE_CHECK).
- Resolution only by `mp_resolve_match` (ADMIN).

**Deletion:** none.

**RLS:** ADMIN SELECT; service role SELECT.

---

## 5. `mp_client_allocation` — optional client attribution (axis B; no money)

**Business meaning:** "this part of an MP receipt settles this client's current account", or a compensating reversal of such a part.

| Column | Type | Null | Default | Mutability |
|---|---|---|---|---|
| `id` | UUID | NOT NULL | — (the RPC supplies it, so the ledger row can reference it) | immutable (PK) |
| `mp_financial_movement_id` | BIGINT | NOT NULL | — | immutable; FK → `mp_financial_movement(id)` RESTRICT. Always the **APPROVAL** movement |
| `cliente_id` | UUID | NOT NULL | — | immutable; FK → `clients(id)` RESTRICT |
| `amount` | NUMERIC(15,2) | NOT NULL | — | immutable |
| `origin` | VARCHAR(20) | NOT NULL | — | immutable |
| `mode` | VARCHAR(10) | NULL | — | immutable |
| `reversal_of_id` | UUID | NULL | — | immutable; FK → `mp_client_allocation(id)` RESTRICT |
| `mp_transition_id` | BIGINT | NULL | — | immutable; FK → `mp_transition_identity(id)` RESTRICT (the refund or chargeback that caused an MP_REVERSAL) |
| `effective_date` | DATE | NOT NULL | — | immutable (period determinant) |
| `evidence` | JSONB | NOT NULL | `'{}'` | immutable |
| `idempotency_key` | VARCHAR(100) | NOT NULL | — | immutable, UNIQUE |
| `client_ledger_id` | BIGINT | NOT NULL | — | immutable; FK → `client_ledger(id)` RESTRICT; **UNIQUE** |
| `reason` | TEXT | NULL | — | immutable |
| `created_at` | TIMESTAMPTZ | NOT NULL | `NOW()` | immutable |
| `created_by` | UUID | NULL | — | immutable; FK → `perfiles(id)`. NULL = service role; no user is fabricated, as in 0042 |

**Constraints:**
- `chk_alloc_amount_nonzero`: `amount <> 0`.
- `chk_alloc_origin`: `origin IN ('ALLOCATION','MANUAL_REVERSAL','MP_REVERSAL')`.
- `chk_alloc_sign`: `(origin = 'ALLOCATION') = (amount > 0)`.
- `chk_alloc_reversal_link`: `(origin = 'ALLOCATION') = (reversal_of_id IS NULL)`.
- `chk_alloc_mode`: `(origin = 'ALLOCATION') = (mode IS NOT NULL)` AND `(mode IS NULL OR mode IN ('AUTO','MANUAL'))`.
- `chk_alloc_mp_reversal`: `(origin = 'MP_REVERSAL') = (mp_transition_id IS NOT NULL)`.
- `chk_alloc_manual_reason`: `origin = 'MP_REVERSAL' OR mode = 'AUTO' OR (reason IS NOT NULL AND length(trim(reason)) > 0)`.

**Cross-row rules** (enforced by the RPCs under the movement lock and proven by tests, because a CHECK cannot express them):
- a reversal has the same `cliente_id` and `mp_financial_movement_id` as its `reversal_of_id`;
- the Σ reversals of an allocation are ≤ its amount;
- the movement invariant `0 ≤ Σ amount ≤ effective_applied_receipt`, where `effective_applied_receipt = gross − Σ │gross│ of the REFUND / CHARGEBACK movements successfully applied by mp_apply_transition` (ADR-006 §5a). It holds after every committed transaction, because the OD-1 unwinding and the reversal application commit atomically in A1.

**Indexes:** `(mp_financial_movement_id)`, `(cliente_id)`, `(reversal_of_id)`.

**Actor:** `mp_allocate_to_client`, `mp_auto_allocate`, `mp_reverse_client_allocation` and `mp_apply_transition` (MP_REVERSAL only). **Append-only; it joins invariant 9.**

**RLS:** ADMIN SELECT only. The service role has no SELECT; its access runs through SECURITY DEFINER functions. OPERATOR has nothing.

**Not a balance:** the table stores facts. Active attributed amounts are always derived as Σ `amount`.

---

## 6. `mp_payer_client_map` — explicit deterministic evidence for AUTO

**Business meaning:** "the MP payer with this id is this client". It is maintained by the ADMIN and stores no personal data.

| Column | Type | Null | Default | Mutability |
|---|---|---|---|---|
| `id` | UUID | NOT NULL | `gen_random_uuid()` | immutable (PK) |
| `mp_payer_id` | VARCHAR(50) | NOT NULL | — | immutable |
| `cliente_id` | UUID | NOT NULL | — | immutable; FK → `clients(id)` RESTRICT |
| `activo` | BOOLEAN | NOT NULL | `true` | true → false once, via RPC |
| `created_at` / `created_by` | TIMESTAMPTZ / UUID | NOT NULL | `NOW()` / — | immutable; `created_by` FK → `perfiles` |
| `deactivated_at` / `deactivated_by` / `deactivation_reason` | TIMESTAMPTZ / UUID / TEXT | NULL | — | set once, together with `activo = false` |

**Constraints:**
- `chk_payer_id_format`: `mp_payer_id ~ '^[0-9]{1,20}$'`. The source field is confirmed by V-2; the format is re-checked then.
- `chk_payer_deactivation`: `activo = (deactivated_at IS NULL)`, and the three deactivation columns are all NULL or all set.
- `uq_payer_active` UNIQUE `(mp_payer_id) WHERE activo`.

**Actor:** `mp_map_payer_to_client` and `mp_unmap_payer` (ADMIN). **Deletion:** none; a mapping is deactivated instead, which preserves the evidence behind past AUTO allocations.

**RLS:** ADMIN SELECT.

---

## 7. `mp_attribution_flag` — the ADMIN's explicit "needs a client" marker

| Column | Type | Null | Default | Mutability |
|---|---|---|---|---|
| `id` | UUID | NOT NULL | `gen_random_uuid()` | immutable (PK) |
| `mp_financial_movement_id` | BIGINT | NOT NULL | — | immutable; FK RESTRICT (APPROVAL movement) |
| `reason` | TEXT | NOT NULL | — | immutable |
| `requested_by` / `requested_at` | UUID / TIMESTAMPTZ | NOT NULL | — / `NOW()` | immutable |
| `cleared_by` / `cleared_at` / `clear_reason` | UUID / TIMESTAMPTZ / TEXT | NULL | — | set once via `mp_clear_attribution_flag` |

**Constraints:**
- `chk_flag_reason`: `length(trim(reason)) > 0`.
- `chk_flag_clear_set`: the three clear columns are all NULL or all set.
- `uq_flag_open` UNIQUE `(mp_financial_movement_id) WHERE cleared_at IS NULL`.

**Actor:** ADMIN RPCs only. A flag is also auto-cleared by the allocation RPCs when the receipt becomes fully assigned (`clear_reason = 'FULLY_ASSIGNED'`).

**Deletion:** none. **RLS:** ADMIN SELECT.

---

## 8. Existing tables

| Table | Change | Authority |
|---|---|---|
| `mp_source_record` | **No DDL.** New accepted `source_type` values: `'api_payment'`, `'api_refund'` (RPC-created only) and `'account_money_csv'` (V-3; not ingested until its parser is frozen). The service-role INSERT policy is narrowed to report types (R4). | ADR-006 §9 |
| `mp_financial_movement` | **No DDL.** New `movement_kind` values: `refund`, `chargeback` (report, V-3), and `account_tax` (report, V-3). `UNIQUE(mp_source_record_id, movement_kind)` is kept (R1). | ADR-006 §9 |
| `mp_reconciliation` | No DDL. The writer set is RPC 41 plus `mp_apply_transition`. | ADR-006 §4 D7 |
| `financial_operation`, `financial_posting` | No DDL. `external_ref` UNIQUE is reused (`'MP:MPA:{transition_id}:{SETTLE,FEE,TAX}'`). | ADR-006 §7 |
| `client_ledger` | No DDL. New `source_entity_type` value `'mp_client_allocation'` on `COLLECTION` / `REVERSAL` rows. | ADR-006 §5c |
| `collections` | **No change.** | ADR-006 §5a |
| `audit_events` | No DDL. New `action` values (ADR006_RPC_CONTRACTS_V1 §0). | — |

**No stored balances, no remaining amount and no attributed total are added anywhere** (invariant 27).

---

## 9. Views (0052), all `security_invoker = true`, ADMIN-filtered, granted SELECT to `authenticated` only

**`report_mp_receipt_status`:** one row per `payment` APPROVAL movement. All values are derived:
- movement fields;
- `axis_a_state` (NORMALIZED / POSTED / REPORT_CONFIRMED / REVIEW_REQUIRED);
- `review_reasons[]`, including the derived `CHARGEBACK_ALERT` and `MEDIATION_ALERT` (R3) when the latest snapshot status is `charged_back` / `in_mediation` and no CHARGEBACK transition has been claimed yet;
- `effective_applied_receipt = gross − Σ │gross│ of the REFUND / CHARGEBACK movements of the same payment that have been successfully applied (reconciliation key `MPA:{t}:SETTLE` exists)`; `unapplied_reversals` (count and amount) appear as a REVIEW_REQUIRED reason;
- `active_attributed = Σ mp_client_allocation.amount`;
- `axis_b_state` (CLIENT_UNASSIGNED / CLIENT_PARTIAL / CLIENT_ASSIGNED / CLIENT_RESOLUTION_REQUESTED);
- `open_flag`.

**`report_mp_delivery_health`:** counts per `mp_delivery_status`, the oldest due item, `FAILED_PERMANENT` rows with error codes, and the operational alert columns `auth_configuration_error` (true while any `CONFIG_BLOCKED` row exists), `config_blocked_count` and `config_blocked_oldest`; `key_conflicts` (rows with `key_conflict_of`); `unresolved_chargeback_signals` (SIGNAL_RECORDED chargeback deliveries with no `signal_resolution`, REVIEW_REQUIRED).

**`report_mp_report_exceptions`:** unresolved `mp_report_match` rows where `is_exception`.

The existing `report_mp_movement_status` (0046) remains valid and unchanged. The P&L view (0045) is unchanged. The identity register guarantees one movement per transition, so the MP fee is still counted once. See V-3 note N-1 in ADR006_IMPLEMENTATION_ORDER_V1 for fee refunds.
