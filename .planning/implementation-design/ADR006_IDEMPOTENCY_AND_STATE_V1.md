# ADR-006 IDEMPOTENCY AND STATE MODEL V1

**Status:** implementation design. **Authority:** ADR-006 §6.4, §7 and §10; ADR006_SCHEMA_DELTA_V1; ADR006_RPC_CONTRACTS_V1.

---

## 1. Identities

| # | Entity | Stable identity | Enforced by | Duplicate, same content | Duplicate, different content |
|---|---|---|---|---|---|
| 1 | Webhook / queue delivery | computed in the database: `'n:'‖topic_class‖':'‖notification_id` (a documented stable notification id, per V-1), else `'h:'‖notification_sha256`; the hash is the single N-SHA formula (ADR006_RPC_CONTRACTS_V1 §S1: `jsonb_build_array(origin, topic_class, topic, action, resource_id, reduced payload)`), computed only in the database. Back-fill `'backfill:payment:'‖id`; chargeback refresh `'cbrefresh:'‖signal‖':'‖payment`; ADMIN re-fetch `'refetch:'‖id‖':'‖uuid`. `x-request-id` is stored, **never** the identity | `UNIQUE(delivery_key)` plus the `notification_sha256` comparison | same key and same hash → `created: false`; 200 to MP; no new work | same key, **different hash** → a separate conflict row with the bounded key `'conflict:'‖sha256(original_key‖':'‖hash)` (73 characters) and `key_conflict_of` = the natural-key row. It is processed normally and counted as an anomaly, never merged. The same conflicting notification replayed → the same conflict key → `created: false`, no new row. A genuinely new notification for a known payment has a new key → a new delivery, which is harmless because processing is resource-keyed |
| 2 | API source version | `('api_payment', 'MPPAY:'‖payment_id‖':'‖sha256(event_data::jsonb::text)[0:32])` | `UNIQUE(source_type, external_id)` plus the raw guard | `ON CONFLICT DO NOTHING` → same source id; no normalization repeat | a different hash is a **new version** row. Older versions are untouched. Only transitions new to the register create movements |
| 2b | API refund source | `('api_refund', 'MPREF:'‖payment_id‖':'‖refund_id)` | same | `ON CONFLICT DO NOTHING` | a refund object that differs later (for example a status change) cannot create a second source under the same key. Its first approved form is the one recorded. A different amount under the same refund id is detected by R3/R4 report checks as DISCREPANCY |
| 2c | Report source | ADR-003 composite for Liberaciones; the V-3 key for Account Money | same | `ON CONFLICT DO NOTHING` at upload | a re-exported row with changed values but the same key is **not** re-ingested. The first import is authoritative evidence, and the change surfaces as a BALANCE_CHECK or coverage exception |
| 3 | Transition | `(resource_type, resource_id, transition, transition_ref)`. `resource_id` is the payment id for `payment` identities and the stable external `SOURCE_ID` for report-only identities (YIELD, PAYOUT). It is **never** a report-specific `external_id`, so the same economic movement in two report products is one transition (V-3 §16; Step 16) | `uq_mp_transition` | the second claimant gets IGNORED `NO_NEW_TRANSITION` (API) or MATCHED (report) | the second claimant gets DISCREPANCY (report) or IGNORED (API re-fetch; a changed amount on an already-claimed APPROVAL is recorded as a new version, and the difference is surfaced by the report). The first claim is never overwritten |
| 4 | Normalized movement | 1:1 with the transition (`mp_transition_identity.mp_financial_movement_id UNIQUE`), plus 0039 `UNIQUE(source, kind)` | both constraints | no second movement possible | same |
| 5 | Financial operation | `external_ref = 'MP:MPA:{t}:{SETTLE,FEE,TAX}'`; reconciliation `idempotency_key = 'MPA:{t}:…'` | `financial_operation.external_ref UNIQUE`, `mp_reconciliation.idempotency_key UNIQUE`, `UNIQUE(movement, operation)` | A1 → `ALREADY_APPLIED`; zero writes | A1 → `TRANSITION_ALREADY_ASSIGNED` or `EXTERNAL_REF_CONFLICT`; hard stop; review |
| 6 | Report match | `(report_source_id, outcome)`; MISSING: `(transition_id, coverage_from, coverage_to)` | `uq_match_report_outcome`, `uq_match_missing` | `ON CONFLICT DO NOTHING` | a re-evaluation with a different outcome inserts a new outcome row. The superseded exception is resolved `SUPERSEDED` by the ADMIN. Nothing is rewritten |
| 7 | Client allocation | `idempotency_key`: MANUAL caller key; AUTO `MPAUTO:{t}`; OD-1 `MPREV:{alloc}:{t}` | `UNIQUE(idempotency_key)`; movement lock plus the invariant | MANUAL → `DUPLICATE_ALLOCATION` (the client retries safely by checking the key); AUTO → `ALREADY_ALLOCATED` no-op; OD-1 → part of A1 `ALREADY_APPLIED` | MANUAL with the same key but other values → `DUPLICATE_ALLOCATION`. The caller must use a new key only for a genuinely new allocation |

---

## 2. State machines

### 2.1 Delivery (`mp_webhook_delivery.status`)

```
RECEIVED ──claim──▶ PROCESSING ──FETCHED──▶ FETCHED (terminal)
   ▲                    │ ├──RETRY──▶ FAILED_RETRYABLE ──(due)──claim──▶ PROCESSING
   │                    │ └──PERMANENT / 48 h──▶ FAILED_PERMANENT (terminal; dead letter)
   │               lease expired ──claim──▶ PROCESSING (same row, new token)
UNSUPPORTED (terminal, at insert)
PROCESSING ──401/403──▶ CONFIG_BLOCKED (recoverable hold; never claimed; no retry loop) ──mp_requeue_config_blocked──▶ RECEIVED
PROCESSING ──RELEASE (circuit breaker)──▶ RECEIVED | FAILED_RETRYABLE (attempt not counted)
chargeback: RECEIVED ──claim──▶ PROCESSING ──SIGNAL_RECORDED──▶ SIGNAL_RECORDED (terminal for the queue; signal_resolution NULL → LINKED | DISMISSED, set once)
            [a LINKED signal owns a child chargeback_refresh payment delivery; no financial state ever]
```

### 2.2 Source (`mp_source_record.processing_status`, unchanged enum)

```
PENDING ──RPC 40──▶ NORMALIZED ──A1 / RPC 41 (Σ = net for all movements)──▶ RECONCILED
   │                    ▲──── RPC 41 counter-assignment (ADR-003 D4 equivalence) ────┘
   ├──RPC 40──▶ IGNORED   (no financial transition | no new transition | MATCHED report row | reserve)
   ├──RPC 40──▶ ERROR     (validation failure; REVIEW_REQUIRED)
   └──RPC 40──▶ PENDING   (report row parked: DEFERRED_V4 / DEFERRED_BACKFILL; note only)
```

### 2.3 Derived UX axes (`report_mp_receipt_status`; no stored status)

**Axis A — MP reconciliation**, per APPROVAL, refund or report-only movement:

| State | Condition (evaluated in this order; the first true wins) |
|---|---|
| REVIEW_REQUIRED | the source is ERROR; **or** a delivery for the payment is FAILED_PERMANENT or CONFIG_BLOCKED with no later FETCHED; **or** an unresolved `mp_report_match.is_exception` for the transition; **or** the movement is auto-applicable with no reconciliation and older than 15 min (stuck: covers PERIOD_CLOSED, TRANSITION_ALREADY_ASSIGNED and similar); **or** the derived CHARGEBACK / MEDIATION alert (the V-2-confirmed snapshot status); **or** a `chargeback` signal linked to the payment whose refresh has not yet been FETCHED (after the refresh, the snapshot status decides: a chargeback that is still active remains REVIEW_REQUIRED through the derived alert until the CHARGEBACK transition is applied; a dispute resolved in favour clears it); **or** a REFUND / CHARGEBACK movement of the payment that is claimed but not yet applied by A1 (the "unapplied reversal" reason) |
| REPORT_CONFIRMED | Σ assigned = net **and** a MATCHED match exists |
| POSTED | Σ assigned = net |
| NORMALIZED | movement exists, Σ assigned ≠ net |

RECEIVED, FETCHED and FAILED_RETRYABLE are delivery states shown in `report_mp_delivery_health`. No movement exists yet at those stages. **Unresolved chargeback signals** (no payment link) are REVIEW_REQUIRED in that health view, until they are LINKED or DISMISSED by the ADMIN.

**Axis B — client attribution**, APPROVAL movements only, independent of axis A:

| State | Condition |
|---|---|
| CLIENT_RESOLUTION_REQUESTED | an open flag and active < effective receipt |
| CLIENT_ASSIGNED | active = effective receipt > 0 |
| CLIENT_PARTIAL | 0 < active < effective receipt |
| CLIENT_UNASSIGNED | active = 0 (**valid terminal state; never a work item**) |

where `active = Σ mp_client_allocation.amount` and `effective_applied_receipt = gross − Σ│gross│` of the REFUND / CHARGEBACK movements of the same payment that have been **successfully applied** by `mp_apply_transition` (a reconciliation row with key `MPA:{t}:SETTLE` exists). Claimed or normalized but unapplied reversals do **not** count. The table's "effective receipt" means this applied amount. **Invariant after every committed transaction: 0 ≤ active ≤ effective_applied_receipt.** An unapplied reversal makes axis A REVIEW_REQUIRED (stuck-movement rule) and leaves axis B unchanged until A1 commits.

**A fully refunded receipt** has effective receipt 0 and active 0 → CLIENT_UNASSIGNED. It is correct and is not a work item.

**Terminology rule:** axis B is never labelled with "conciliado", "no conciliado" or "pendiente" (ADR-006 §6.4).

---

## 3. Crash and replay table (end to end)

| Crash point | Durable state | Next run | Net effect |
|---|---|---|---|
| after S1 insert, before the 200 | delivery RECEIVED | MP retries → S1 duplicate → 200; the worker processes it once | one delivery |
| after S2 claim | PROCESSING with lease | the lease expires → re-claim | refetch; same hash → same source |
| after S4, before RPC 40 | source PENDING | the worker's step f or the daily sweep | one movement |
| inside RPC 40 | rolled back | re-run | one movement |
| after RPC 40, before A1 | movement, no reconciliation | step h or the sweep; RPC 41 is blocked meanwhile (`AUTO_APPLICATION_PENDING`) | one application |
| inside A1 | rolled back entirely | re-run | one application |
| after A1, before C2 | POSTED, unattributed | step i or the sweep | ≤ one AUTO allocation |
| after A1/C2, before S3 FETCHED | all financial rows present | re-claim → same hash → A1 `ALREADY_APPLIED` → C2 `ALREADY_ALLOCATED`/NONE → FETCHED | zero new rows |
| stale worker finishes after its lease was re-claimed | — | its S3 call gets `CLAIM_LOST`; every RPC it already ran was idempotent | zero duplicates |
