# ADR-006 — Mercado Pago real-time ingestion and report reconciliation

**STATUS:** **ACCEPTED** by the owner on 2026-09-27 ("ADR-006 revision 3 is ACCEPTED"). It is **not implemented**: no migration, RPC or function exists yet.
**RATIFIED DECISIONS:**
- **OD-1 ACCEPTED:** client CC reversals on refunds and chargebacks are compensating effects, limited to the actually reversed amount and to previously attributed value (§5d).
- **OD-2 ACCEPTED:** client attribution is optional. NONE is valid, including Feria and anonymous payments. AUTO is allowed only with deterministic evidence. MANUAL is used when the owner wants to settle a client CC (§5a, §5b).

**Phase 26** remains COMPLETE and unaffected.
**DATE:** 2026-09-26
**REVISION 2 (2026-09-26):** owner clarification "client attribution is OPTIONAL". This revision resolves OD-2, separates the treasury effect from client attribution, and removes mandatory identification (§2, §5, §5a, §6.4, §7, §9, §13).
**REVISION 3 (2026-09-26):** final external-review corrections, covering:
- atomic transition application in place of sequential RPC 41 calls (net cap, §5.1);
- the `MP_SETTLEMENT` semantic confirmation (§5.2);
- the client-ledger provenance amendment (§5c);
- OD-1 accepted (§5d, §13);
- the allocation invariant and locking (§5a);
- terminology (§6.4).

**EDITORIAL ALIGNMENT (2026-09-27):** stale implementation-detail wording was aligned with the accepted implementation design (`.planning/implementation-design/ADR006_*_V1.md`, commit `81e0a6a`). **No owner decision or business rule changed.** The alignment covers:
- the chargeback webhook signal path (§1.1, §5, §6.1, §10);
- 401 / 403 → `AUTH_CONFIGURATION_ERROR` / `CONFIG_BLOCKED` (§6.2, §10);
- the delivery identity (`n:` / `h:` keys, `x-request-id` for traceability only; §6.1, §7);
- the V-2 field and date boundary (§1.1, §6.2, §6.3);
- the report fallback without an RPC 40 override (§8, §9);
- the status lists (`SIGNAL_RECORDED`, `CONFIG_BLOCKED`; §6.4, §9);
- the attribution bound using applied reversals (§6.4, §7).

The design documents are the mechanical contract; this ADR stays at decision level.
**V-4 DIRECTION CORRECTION (2026-09-28, owner-directed):** V-4 proved that `SOURCE_ID == payment.id` also holds for payments **made by** the account. A payment is therefore an inbound receipt (`payment` / `APPROVAL`) **only when the account is proven to be the collector**. Outbound payments claim `OUTBOUND_PAYMENT`, are never auto-applied or attributed, and are resolved by the ADMIN through the owning domain RPC plus RPC 41 Mode 2 (§5, §8, §12). The contract is in `.planning/implementation-design/ADR006_V4_DIRECTION_CORRECTION.md`.
**SCOPE:** Domain L (Mercado Pago), RPC 40 `mp_normalize_source`, RPC 41 `mp_reconcile_movement`, and the MP entry points into Collections and Treasury.
**AMENDS (once accepted):**
- ADR-003 D1, D2, D3 and D8, as listed in §4;
- POSTGRES_SCHEMA_SPEC_V1 Domain L, by addition only;
- RPC_CONTRACTS_V1 §40, in behaviour; the signature is unchanged.

**PRESERVES:** Frozen Part 22, ADR-003 D4–D7 and ADR-004 D10 / D13.
The FROZEN files are not rewritten; this ADR is the amendment, following the ADR-001 to ADR-005 precedent.
**IMPLEMENTATION:** none in this ADR. No migration, code or configuration is changed by it.

---

## 1. Context

The owner's requirement (2026-09-26): *"I don't want a system that automatically downloads reports. I want something that updates with each new movement."*

ADR-003 D2 makes the Liberaciones CSV the only V1 source. The webhook and API paths are explicitly unsupported ("The Mercado Pago API is never fetched"). That meets correctness but not the operational requirement.

### 1.1 Mercado Pago capabilities this ADR relies on

| # | Capability | Source |
|---|---|---|
| F1 | Webhooks notify integration events such as payment creation and update. | Supplied by the owner (official MP documentation) |
| F2 | The origin of a webhook is authenticated with the `x-signature` header and the application's secret key. | Supplied by the owner |
| F3 | A payment notification carries a resource id. The authoritative resource is `GET /v1/payments/{id}`. | Supplied by the owner |
| F4 | MP documents **no** generic webhook for every movement that affects Account Money. | Supplied by the owner |
| F5 | The **Account Money report** lists the operations that affected account money: payments, money received, chargebacks, refunds and other balance-affecting events. | Supplied by the owner |

**Implementation details are candidates, not frozen facts:**
- The signature construction (manifest, `ts`, `v1`), the notification topics (payment **and chargeback**), their body shapes, resource identifiers and any documented stable notification id are **re-verified against the current official documentation at code time (V-1)**. The legacy implementation (`netlify/functions/webhook-mercadopago.ts`) is a hint only.
- The external payment field mapping (amounts, fee components, taxes / withholdings, payer id, `external_reference`, statuses, `refunds[]`, and the **authoritative approval and refund transition dates**) is **fixed by V-2 before any code reads it**. Field names that appear in this ADR (for example `transaction_amount`, `fee_details[]`, `date_approved`, a refund's `date_created`) are expected candidates only.
- The mechanical contract lives in the accepted implementation design (`.planning/implementation-design/ADR006_*_V1.md`, frozen in commit `81e0a6a`). This ADR stays at decision level.
- No design decision depends on an unverified detail without a fail-closed fallback.

**Consequence of F4 and F5:**
- Webhooks plus the API are the **primary operational path for payments**.
- **Chargeback notifications** are accepted in real time as **signals only**: they carry no financial truth and never produce an amount.
- Payouts, yields, account-level taxes and withholdings, reserves, and chargeback **amounts** have **no documented real-time amount source**. They remain **report-sourced**, unless V-2 proves an authoritative API source for chargeback amounts.
- The Account Money report is the **completeness authority**.

## 2. Decision summary

1. **Receive:** an MP notification is authenticated, stored as a *delivery* in an inbox, and acknowledged. The delivery is never financial truth.
2. **Fetch:** a backend worker fetches `GET /v1/payments/{id}` server-side and stores the response as an immutable `mp_source_record` **snapshot** (new `source_type = 'api_payment'`).
3. **Normalize:** RPC 40 derives economic **transitions** from the snapshot: approval and each refund. A chargeback or mediation status is an **alert**, never a movement from the API. Each transition is claimed exactly once in a new identity register; only a newly claimed transition creates an `mp_financial_movement`.
4. **Treasury effect (automatic, never waits for a client):** every verified transition is applied by **one** atomic backend RPC, `mp_apply_transition` (§5.1).
   - It writes, in a single transaction, `MP_SETTLEMENT` +gross, `FEE` −│fee│ and `ADJUSTMENT` −│tax│ with their reconciliation rows.
   - It proves Σ assigned = net before commit.
   - The movement is then fully assigned (ADR-003 `RECONCILED`), and the Mercado Pago balance reflects it at once.
5. **Optional client attribution (a separate concept):** a receipt may later be attributed, fully or partially, to one or more clients to settle their current account (CC). Attribution writes **only** the client ledger, through the new `mp_client_allocation` register. It **never** creates an operation or a posting. An unattributed receipt is a valid, terminal state.
6. **Reconcile:**
   - Report rows are stored as immutable sources, exactly as ADR-003 does.
   - A report row whose transition is already claimed is **matched**, never normalized again.
   - Unclaimed report rows are either back-filled from the API (payments) or normalized under ADR-003 (report-only kinds).
   - Differences become explicit, reviewable discrepancies.

## 3. ADR-003 decisions preserved

| ADR-003 | Preserved as |
|---|---|
| Part 22 pipeline (immutable source → normalized movement → N:N reconciliation → operations and postings; MP is not a ledger) | unchanged; the API snapshot is one more immutable source |
| D1 Liberaciones parser (15 keys, composite external_id `SOURCE_ID:DESCRIPTION:C/D`, gross + fee + tax = net exactly, sign rules, validation order §10) | unchanged for every Liberaciones row; one step is added after validation (identity claim, §7) |
| D3 ERROR / IGNORED written only by RPC 40, after common validation; raw columns immutable; `NORMALIZE` audit | unchanged; the same statuses carry the new outcomes (§4) |
| D4 `RECONCILED` ⇔ Σ assigned = net for every movement of the source; `remaining_unassigned` derived | unchanged. Named "ASSIGNED" in the UX to avoid confusion with report matching (§9) |
| D5 RPC 41 `p_idempotency_key`, `external_ref = 'MP:' ‖ key`, `DUPLICATE_RECONCILIATION` | unchanged; the backend uses deterministic keys (§7) |
| D6 counter-assignments and per-request cap `abs(Σ + a) ≤ abs(net)` | unchanged inside RPC 41; the committed-state invariant `abs(Σ) ≤ abs(net)` holds for both writers (§5.1) |
| D7 Mode 1 limited to `MP_SETTLEMENT` / `FEE` / `ADJUSTMENT`; Mode 2 link-existing with per-(operation, account) capacity; cross-domain types owned by their RPCs | the type set is unchanged; `COLLECTION` stays owned by `register_collection`. The writer set is amended in §4 |
| ADR-004 D10 (fee → Costos indirectos from the movement, once; tax excluded; payment no revenue; yield → Otros ingresos financieros) and D13 | unchanged; the identity register (§7) guarantees each fee is counted once across API and report |

## 4. ADR-003 decisions amended

| ADR-003 | Amendment |
|---|---|
| **D2** "`webhook` and `api` are not normalized; the API is never fetched" | `api_payment` becomes a **supported** source type. Its parser is §6.3. The backend may fetch `GET /v1/payments/{id}` (and `/v1/payments/{id}/refunds` when `refunds[]` is truncated) server-side. **`webhook` stays unsupported as a financial source**: deliveries live in the inbox (§6.1) and never reach RPC 40. BASECSV and the settlement families remain unsupported. |
| **D2** (report layouts) | The **Account Money report** is designated the completeness authority (§8). Its parser is **not** specified here: it needs a real export sample (§12, V-3). Until it is specified, the Liberaciones report is the interim completeness source; BALANCE_AMOUNT and the observed release lag of 0 days (Phase 26 evidence, 4,034 payments) make it adequate for the owner's account. |
| **D1** (dispatch) | RPC 40 dispatches on `source_type` (`csv_import` → D1 parser; `api_payment` → §6.3). After validation, **both** parsers claim each transition in `mp_transition_identity` before creating a movement (§7). |
| **D3** (IGNORED) | IGNORED additionally covers two cases, both reached only after full validation, with a note and a `NORMALIZE` audit: (a) an `api_payment` snapshot that evidences no new transition (for example `pending`, `in_process`, `rejected`, `cancelled`, or a re-fetch of a known state); (b) a report row whose transition is already claimed, which records an `mp_report_match` row instead of a movement. Unknown `operation_type`, currency other than ARS, `live_mode = false`, a foreign `collector_id`, or broken arithmetic → **ERROR**, which is the REVIEW_REQUIRED state. |
| **D7** (writer of MP operations and of `mp_reconciliation`) | "RPC 41 only" becomes "RPC 41 **or** `mp_apply_transition`". `mp_apply_transition` may create only `MP_SETTLEMENT`, `FEE` and `ADJUSTMENT` operations, one posting each on the MP account, in one transaction with Σ = net proven before commit (§5.1). |
| **RPC 41** (RPC_CONTRACTS_V1 §41 as amended by ADR-003) | One new guard, and signature, modes and cap are unchanged: an auto-applicable movement (§5.1 step 3) with **no** reconciliation rows raises `AUTO_APPLICATION_PENDING`. Once it is applied, RPC 41 is used only for ADMIN corrections (D6) and Mode 2 links. |
| **Commercial** (RPC_CONTRACTS_V1 §4 `register_collection`; POSTGRES_SCHEMA_SPEC_V1 Domain D `client_ledger.source_entity_type`) | `client_ledger` `COLLECTION` / `REVERSAL` rows may also have provenance `'mp_client_allocation'`, with no `collections` row and no financial operation or posting (§5c). `register_collection` itself is unchanged. |
| **D8** carry-forward | It is extended: MP sends notifications to the URL configured on the application. At cutover (Phase 31) the configured webhook URL must move from the legacy Netlify function to the ADR-006 endpoint, **and** the legacy writer must be disabled in the same step (§11). |

## 5. Payment accounting (Frozen rule preserved)

### Three independent concepts (owner requirement, revision 2)

| # | Concept | Question it answers | Where it lives | Mandatory? |
|---|---|---|---|---|
| 1 | **MP external movement** | Did Mercado Pago move money? | `mp_source_record` → `mp_financial_movement` (+ `mp_transition_identity`) | yes, for every verified transition |
| 2 | **Treasury effect** | Did the Mercado Pago account change? | `financial_operation` / `financial_posting` on the MP account, linked by `mp_reconciliation` | yes, automatic, **never waits for a client** |
| 3 | **Client attribution** | Does this receipt settle a client's CC? | `mp_client_allocation` → `client_ledger` | **optional**; NONE is a valid terminal state |

### 5.1 Treasury effect: atomic transition application (automatic)

**Why RPC 41 is not called component by component.**
- RPC 41 enforces, on every request, `abs(Σ assigned before + p_assigned_amount) ≤ abs(net_amount)` (ADR-003 D6, 0042).
- For gross 100, fee −5, tax −2 (net 93), a first `+100` request raises `OVER_ASSIGNMENT` even though the final set (+100 −5 −2 = 93) is correct.
- Correctness must not depend on the order of calls. The treasury effect of a transition is therefore applied by **one dedicated backend RPC that owns the whole application in one transaction**.

**`mp_apply_transition(p_movement_id BIGINT) RETURNS JSONB`**
- SECURITY DEFINER, `SET search_path = public`, EXECUTE for `service_role` only. It is invoked by the worker right after RPC 40.
1. `auth.role() = 'service_role'`, else `FORBIDDEN`.
2. **Lock** the movement `FOR UPDATE`, then its source `FOR UPDATE` (the same lock order as RPC 41, ADR-003 D4).
3. The movement must be auto-applicable:
   - kind `payment` or `refund` from an `api_payment` source, or kind `yield`, account tax or chargeback from a report source;
   - its `mp_transition_identity` row must point to this movement;
   - otherwise `NOT_AUTO_APPLICABLE`. `transfer` (payout) is never auto-applied: its bank side belongs to `transfer_between_accounts`, ADR-003 D7.
4. `assert_period_open(movement.occurred_date)`. If the period is CLOSED the call fails, the movement stays NORMALIZED, and the state is REVIEW_REQUIRED `PERIOD_CLOSED` until the ADMIN reopens the period through the Frozen mechanism.
5. **Build the component set** from the movement, skipping any component equal to 0 (`financial_posting.signed_amount <> 0`):

   | Component | Operation type | Signed amount | Key (`mp_reconciliation.idempotency_key`; `external_ref = 'MP:' ‖ key`) |
   |---|---|---|---|
   | receipt leg | `MP_SETTLEMENT` | `gross_amount` (+ for payment, − for refund / chargeback, ± for yield / account tax as signed) | `MPA:{transition_id}:SETTLE` |
   | fee | `FEE` | `fee_amount` (≤ 0) | `MPA:{transition_id}:FEE` |
   | tax | `ADJUSTMENT` | `tax_amount` (≤ 0) | `MPA:{transition_id}:TAX` |

6. **Pre-existing assignments:**
   - If the movement already has reconciliation rows and they are **exactly** the planned set (same keys, operations, accounts and amounts), return `ALREADY_APPLIED` with no write. This is the idempotent re-run.
   - Any other pre-existing row raises `TRANSITION_ALREADY_ASSIGNED`, and nothing is written; this is REVIEW_REQUIRED.
7. **Prove before writing** that Σ components = `net_amount` exactly, else `APPLICATION_NET_MISMATCH`. The parser already guarantees gross + fee + tax = net, so this check is defence in depth.
8. **Write all components:** for each, one `financial_operation` (dated `movement.occurred_date`, `source_entity_type = 'mp_financial_movement'`), one `financial_posting` on the Mercado Pago account, and one `mp_reconciliation` row (`financial_account_id` = MP account, `reconciled_by` NULL).
9. Recompute the source status with the ADR-003 D4 equivalence. Σ assigned = net, so the source becomes `RECONCILED` when all its movements are complete.
10. OD-1 client-side unwinding for a `refund` or chargeback movement (§5d), in the same transaction.
11. One audit event `MP_APPLY_TRANSITION` with the components.
12. Any exception rolls back **everything**. No partial component set can ever be committed.

**Result for an approval** (gross G, fee F ≤ 0, tax T ≤ 0, net N):

| Effect | Operation / posting | Client ledger | P&L (ADR-004) |
|---|---|---|---|
| **Exactly one** MP treasury receipt of the gross | `MP_SETTLEMENT`, +G on Mercado Pago | untouched until optional attribution | none (D13) |
| MP fee | `FEE`, −│F│ on MP | untouched | Costos indirectos −│F│ from the **movement**, once (D10) |
| Taxes / withholdings of the payment | `ADJUSTMENT`, −│T│ on MP | untouched | excluded (D10) |
| Result | MP balance Δ = G − │F│ − │T│ = N; Σ assigned = N → **RECONCILED** | untouched | fee only |

The gross is never netted against the fee.

**Relation to RPC 41:**
- RPC 41's signature, modes and per-request cap are **unchanged**; the cap is never bypassed within RPC 41.
- ADR-006 amends two points:
  - (a) `mp_reconciliation` and the Mode 1 operation types may also be written by `mp_apply_transition`. The ADR-003 D7 ownership sentence becomes "RPC 41 **or** `mp_apply_transition`".
  - (b) RPC 41 gains one guard: for an auto-applicable movement that has **no** reconciliation rows yet, it raises `AUTO_APPLICATION_PENDING`. This stops a manual assignment from pre-empting the atomic application.
- After application, RPC 41 remains the tool for ADMIN corrections, using counter-assignments (D6) and Mode 2 links.
- **The committed-state invariant of D6, `abs(Σ assigned) ≤ abs(net)`, holds after every commit of both RPCs.** Intermediate states inside `mp_apply_transition` are never visible outside its transaction.

### 5.2 `MP_SETTLEMENT` semantics: confirmed, no new type

- In ADR-003 and Phase 23, `MP_SETTLEMENT` is the Mode 1 default: the operation that records **money of an MP external movement settling into the Mercado Pago account**.
  - In the Phase 23 acceptance test (PHASE_23_MP.md §11, E1/E2), a +1000 MP movement is assigned partly (+600) as one `MP_SETTLEMENT` operation with one posting on the MP account.
  - It is not reserved for payouts or internal balance moves: payouts are `TRANSFER`, and reserves are IGNORED.
- The gross receipt leg of an incoming MP payment is exactly that: the payment's amount entering the MP account.
  - ADR-003 V1 booked the Liberaciones payment row as `MP_SETTLEMENT` for its net.
  - ADR-006 books the same meaning for the gross and moves the fee and tax out into their own operations, which Part 22 ("preserve gross, fees, taxes, net") requires.
  - The meaning of the type does not change; only the fee and tax are separated.
- ADR-004 D13 already lists `MP_SETTLEMENT` as P&L-neutral, which is correct for a receipt (the sale is the Pedido).
- **Decision:** `MP_SETTLEMENT` is semantically correct for the receipt leg, and for refund and chargeback legs with a negative sign. `MP_RECEIPT` would be a naming preference with no semantic gain, so it is **not** introduced.

### 5a. Optional client attribution (current account settlement)

**Chosen design: a dedicated, audited allocation register.** Collections are not extended, and no new operation type is added.

| Alternative | Verdict |
|---|---|
| New `MP_RECEIPT` operation type | rejected: `MP_SETTLEMENT` already is the P&L-neutral MP receipt (§5.2); a new enum value adds nothing |
| Extend `collections` to reference an existing operation | rejected: `collections` + `register_collection` (RPC 4, Frozen) always create their own `COLLECTION` operation and posting. Making the posting optional would break the invariant "one collection = one money movement" for every other payment method, and changes a Frozen RPC. |
| **Dedicated `mp_client_allocation` + ADMIN RPC** | **chosen**: additive, touches no Frozen table or RPC, and creates no operation or posting **by construction** (the RPC has no code path that writes `financial_operation` or `financial_posting`) |

**`mp_client_allocation`** (append-only, RLS as 0041):
- `id`;
- `mp_financial_movement_id` (the APPROVAL movement);
- `cliente_id`;
- `amount <> 0`: an allocation is `+amount`; a compensating reversal row is `−amount` with `reversal_of_id` set;
- `origin` (`ALLOCATION`, `MANUAL_REVERSAL`, `MP_REVERSAL` for the OD-1 unwinding, with `mp_transition_id` of the refund or chargeback);
- `effective_date`;
- `mode` (`AUTO` or `MANUAL`);
- `evidence` (JSONB: for AUTO, the deterministic evidence; for MANUAL, the ADMIN reason);
- `idempotency_key` (UNIQUE);
- `client_ledger_id` (the `COLLECTION` row it wrote);
- `reversal_of_id` (NULL, or the allocation it reverses);
- `created_at`, `created_by`.

**`mp_allocate_to_client(p_movement_id, p_cliente_id, p_amount, p_effective_date, p_idempotency_key, p_reason)`**, SECURITY DEFINER:
- **Actor:** ADMIN for MANUAL mode.
- **Guards:**
  - the movement exists, is a `payment` APPROVAL, and its source is not ERROR;
  - the client is active;
  - `p_amount > 0`;
  - `p_effective_date ≥ movement.occurred_date`, with `ASSERT_PERIOD_OPEN(p_effective_date)`;
  - `DUPLICATE_ALLOCATION` on a repeated key.
- **Cap:** see the invariant below. The APPROVAL movement row is locked `FOR UPDATE` before the sum is read, else `ALLOCATION_EXCEEDS_RECEIPT`.
- **Writes:**
  - one `client_ledger` row: `COLLECTION`, `signed_amount = −p_amount`, the client name snapshot, `source_entity_type = 'mp_client_allocation'`, `source_entity_id = allocation id`;
  - one allocation row;
  - one audit event (`MP_CLIENT_ALLOCATION`).
- **It never writes `financial_operation` or `financial_posting`.** The money was already recorded once in §5.1.

**`mp_reverse_client_allocation(p_allocation_id, p_amount, p_reason)`**, ADMIN: corrects a wrong attribution, fully or partially.
- `p_amount` may not exceed the remaining active amount of that allocation.
- It writes a `client_ledger` `REVERSAL` (+`p_amount`, `reversal_of_id` = the original ledger row) and a `−p_amount` allocation row (`origin MANUAL_REVERSAL`, `reversal_of_id` set), under the same movement lock.
- Nothing is deleted or updated.

**Partial and split attribution — invariant (V1 supported):**

```
active_attributed(movement) = Σ mp_client_allocation.amount   -- allocations +, all reversals −
0 ≤ active_attributed ≤ gross_amount − Σ MP reversals of that receipt (refunds + chargebacks applied)
```

- It holds after every commit.
- Each allocation of `a` needs `active_attributed + a ≤` the upper bound.
- Each reversal of `r` needs `r ≤` the remaining active amount of the allocation it compensates. The total can therefore never go below 0.
- Two simultaneous allocations serialize on the `FOR UPDATE` lock of the APPROVAL movement. Every allocation RPC and the OD-1 unwinding take this lock before reading the sum.
- Several allocations, to one or several clients, are allowed as long as the invariant holds.
- The upper bound never exceeds the gross, so the owner's "at most the gross" rule is always met.
- OD-1 unwinding (§5d) keeps the invariant: after a reversal R, `max(0, Σ − R) ≤ gross − R` whenever `Σ ≤ gross`.

**Attribution modes (OD-2, accepted):**

| Mode | When | Who |
|---|---|---|
| **NONE** | anonymous or Feria receipt; also any receipt the owner never attributes | nobody. Valid terminal state; no pending work |
| **AUTO** | **only** with deterministic evidence: (a) `external_reference` in the app's own format (`GST:C:{client uuid}` or `GST:P:{pedido uuid}`), set on a link or QR created by the app; (b) an explicit ADMIN-maintained mapping `mp_payer_client_map(mp_payer_id → cliente_id)`, which stores only MP's payer id and no personal data | the worker calls `mp_auto_allocate(p_movement_id)` (SECURITY DEFINER, service role only). It takes **no client parameter**: it derives the client from the stored snapshot evidence, so the service role cannot choose one. It shares the guards and the cap of `mp_allocate_to_client`. Allocation is for the full gross, dated `movement.occurred_date`, with key `MPAUTO:{transition_id}`. Missing, unknown, inactive or ambiguous evidence, or a CLOSED period → **no allocation** (NONE) plus a note. It is never an error. |
| **MANUAL** | the ADMIN decides a receipt should settle a client's CC | ADMIN, any amount up to the cap |

**Never inferred** from amount, payer name, timing or any heuristic.

Allocation has no P&L effect (a CC settlement is not income; the sale is the Pedido, D10 and D13), and it has no treasury effect.

### 5c. Client-ledger provenance amendment

This amends RPC_CONTRACTS_V1 §4 (`register_collection`) as the sole writer of `client_ledger` `COLLECTION`, and POSTGRES_SCHEMA_SPEC_V1 Domain D (`client_ledger.source_entity_type` values).

A `client_ledger` row with `movement_type = 'COLLECTION'` may originate from exactly one of:

| Provenance | Written by | `source_entity_type` / `source_entity_id` | `collections` row | financial operation / posting |
|---|---|---|---|---|
| **Collection** (money and CC settlement recorded together) | `register_collection` (RPC 4, unchanged) | `'collections'` / collection id | yes | yes: its own `COLLECTION` operation and posting |
| **MP client allocation** (optional CC settlement of an MP receipt whose treasury effect already exists) | `mp_allocate_to_client`, `mp_auto_allocate` | `'mp_client_allocation'` / allocation id | **no** | **no**: the money is the `MP_SETTLEMENT` of §5.1, recorded once |

For the MP provenance:
- the audit event is mandatory: `MP_CLIENT_ALLOCATION`, or `MP_CLIENT_ALLOCATION_REVERSAL` for reversals;
- the compensating `REVERSAL` rows carry `source_entity_type = 'mp_client_allocation'` and the id of the reversal allocation row;
- `REVERSAL` provenance is extended the same way.

This fits the Frozen fact → consequence model (TARGET_ARCHITECTURE_V2_FROZEN §3 "Fact vs. Consequence": "Collection (fact) → client_ledger entry + financial_operation + posting"):
- the **MP movement** is the money fact, with the treasury as its consequence;
- the **allocation** is the attribution fact, with the client ledger as its consequence.

It is **a new provenance for the existing `client_ledger`, not a parallel ledger**. CC balances, statements and reports read `client_ledger` exactly as before.

Consequence for readers: any report that lists "collections" by joining `collections` must also read the `mp_client_allocation` provenance, or read `client_ledger` directly. Phase 25 views (0046) do not join `collections`, and Phase 27 must use `client_ledger`.

### 5d. OD-1 — client side of an MP refund or chargeback (ACCEPTED)

It is executed inside `mp_apply_transition` (§5.1 step 10) for a `refund` or chargeback movement whose APPROVAL movement carries active allocations. It uses the same transaction and the APPROVAL movement lock.

1. The **actual** reversed amount R is the refund or chargeback movement's │gross│, as evidenced by MP.
2. If the approval has **no** active attribution, the client ledger is untouched.
3. Restorable amount = `min(R, active_attributed)`. More attribution than exists is never reversed. A partial refund gives a partial restoration; a full refund or chargeback restores up to the full attributed amount.
4. **Which allocation:**
   - if deterministic evidence identifies it, that allocation is used first. Examples: an AUTO allocation whose `external_reference` evidence names the same order or client as the refund, or a receipt with exactly one active allocation;
   - otherwise allocations are unwound **newest first**, which is the deterministic fallback (`created_at DESC, id DESC`);
   - the last allocation touched may be unwound partially.
5. For each unwound part: a `−part` allocation row (`origin MP_REVERSAL`, `reversal_of_id`, `mp_transition_id`) plus a `client_ledger` `REVERSAL` +part (`reversal_of_id` = that allocation's ledger row, provenance `mp_client_allocation`) plus an audit event. These are compensating entries only; nothing is mutated or deleted.
6. The treasury side (`MP_SETTLEMENT` −R, and any fee or tax the evidence carries) is applied by the same RPC according to the MP evidence alone. It is independent of whether any client was attributed.
7. If the sale itself is cancelled, the ADMIN uses the existing order RPCs; this rule does not touch Pedidos.

The service role performs this unwinding without choosing anything: both the amount and the order are derived. It is covered by the same audited exception to Phase 23 I6 as `mp_auto_allocate` (§9).

### 5b. Feria flow

- MP transfers received during a Feria are ingested and posted exactly as in §5.1: the MP balance +G, fee and tax separate, fully reconciled. **No attribution is required.**
- Unattributed receipts stay in state `CLIENT_UNASSIGNED`, which is valid and terminal. They create no task, alert or REVIEW_REQUIRED.
- Frozen Phase 21 is unchanged. `close_sales_session` records the retail sale as a `SALE_DELIVERY` on CONSUMIDOR FINAL and moves no money (E6), and "nothing pairs it" (K4).
  - If the owner wants that aggregate debit settled, the ADMIN may attribute selected Feria receipts to CONSUMIDOR FINAL (MANUAL). This is optional and never required.
- An identified wholesale client paying at the Feria may be attributed (MANUAL or AUTO), exactly like any other receipt.

**Classification of every movement type** (a real-time path exists only where MP documents one):

| Type | Real-time source | Movement kind | Financial treatment |
|---|---|---|---|
| Payment approved **received by the account** (collector = account; any payer: client, Feria consumer, own funds, other) | webhook → `GET /v1/payments/{id}` | `payment` (`APPROVAL`) | §5.1 automatic; client attribution optional (§5a). `operation_type` (e.g. `account_fund`) never decides client identity |
| Payment approved **made by the account** (account is the payer; outbound) | **report only**; the API resource belongs to another collector (COLLECTOR_MISMATCH) | `payment`, identity `OUTBOUND_PAYMENT` (V-4 direction correction) | **no** automatic application and **no** attribution; REVIEW_REQUIRED until the ADMIN resolves it through the owning domain RPC (`pay_supplier`, `transfer_between_accounts`, `pay_fiscal_obligation`, …) on the MP account plus RPC 41 Mode 2 link; the payer-side withholding through Mode 1 `ADJUSTMENT` |
| Pending / in_process / rejected / cancelled | same | none (IGNORED) | none; shown as activity only |
| Refund (full or partial) | same (`refunds[]` of the payment) | `refund` (gross = −refund amount, fee 0, tax 0, net = gross) | `mp_apply_transition`: `MP_SETTLEMENT` −R, key `MPA:{refund transition_id}:SETTLE`. The client ledger is touched **only** if the refunded payment carries allocations (OD-1) |
| Fee returned by MP on a refund | **report only** (not in the refund object) | from the report | report discrepancy → ADMIN Mode 1 `FEE` counter-assignment (+) |
| Chargeback / dispute | a **chargeback webhook signal** (topic per V-1) and / or the payment's chargeback status (status values per V-2) | **no movement** from the signal or the API: a derived REVIEW_REQUIRED alert. A signal with a documented payment relation triggers a payment refresh; otherwise it waits for ADMIN link / dismiss | the amount comes from the Account Money report row, applied by `mp_apply_transition` as `MP_SETTLEMENT` −amount once the parser exists (V-3); client side per OD-1 (§5d) |
| Payout / withdrawal / transfer out (Liberaciones `payout` = Account Money `PAYOUTS`: the same movement by `SOURCE_ID`; owner-verified heterogeneous: supplier payments and own-account withdrawals, V-3 §15.2 / §16) | **report only** (F4) | `transfer` (ADR-003); identity `('report', SOURCE_ID, 'PAYOUT', '')` shared by both reports | never auto-applied or attributed; REVIEW_REQUIRED until the ADMIN resolves it through the owning domain RPC (`transfer_between_accounts`, `pay_supplier`, `pay_fiscal_obligation`, …) plus RPC 41 Mode 2 (ADR-003 D7) |
| Yield (Liberaciones `asset_management`; Account Money K3, owner-verified, V-3 §15.1) | **report only** | `yield` (ADR-003) | `mp_apply_transition`: `MP_SETTLEMENT`; P&L Otros ingresos financieros (D10) |
| Account-level tax / withholding not tied to one payment | **report only** | per the Account Money parser (V-3) | `mp_apply_transition`: single component (V-3 fixes whether it is `ADJUSTMENT`) |
| Reserves | **report only** | IGNORED (ADR-003) | none |
| Unknown movement type | — | ERROR (REVIEW_REQUIRED) | none until an amendment defines it |

## 6. Real-time data flow

### 6.1 Entry — `POST /api/integrations/mercadopago/webhook`

- **Hosting:** a Supabase Edge Function (`mp-webhook`, JWT verification disabled because MP cannot send one). `/api/integrations/mercadopago/webhook` on the app domain is a pass-through alias.
- The function holds the webhook secret and the service-role key as function secrets. It holds **no** database privilege of its own beyond the service role already authorized for MP ingestion (0041).

Request handling, in order:
1. **Parse** only the signature headers, `x-request-id` (stored for traceability only), the topic / type, `action`, the resource id, `live_mode`, `user_id`, and a documented notification id if V-1 establishes one. Maximum body size is 64 KB.
2. **Verify** the HMAC (constant-time compare). Also verify `ts` freshness (±15 min, V-1), `live_mode = true`, and that `user_id` equals the configured collector id.
   - On failure: respond **401**, write **nothing** to the database, and emit one log line: request id, failure reason, no body, no signature.
   - Because an unauthenticated caller cannot write to the database, a flood cannot fill storage.
3. **Classify and persist:** the V-1-verified topic table gives the class `payment` / `chargeback` / `unsupported`. The database RPC computes the durable delivery identity:
   - `n:{topic_class}:{notification_id}` for a documented stable notification id;
   - otherwise `h:{canonical notification sha256}`.
   - The same natural key with different content is stored as a bounded conflict row and never merged.
   - Correctness never depends on transport request-id reuse.
   - The body is stored reduced to the fields in step 1; no payer data is stored.
4. **Acknowledge** with **200** immediately after the insert commits. If the insert fails, respond 500 so that MP retries.
5. **Kick** the worker as a best-effort background call. The scheduled worker (pg_cron, every minute) guarantees progress when the kick is lost.

**Chargeback topic:** stored durably as a chargeback **signal**, which ends in `SIGNAL_RECORDED` and is never `UNSUPPORTED`.
- With a documented payment relation, it enqueues a payment refresh.
- Otherwise it stays REVIEW_REQUIRED until the ADMIN links it to a payment or dismisses it (`mp_resolve_chargeback_signal`).
- No amount, movement, posting or client effect ever comes from a signal.

**Unsupported topic** (any other topic): store it with status `UNSUPPORTED`, acknowledge 200, and do nothing else. Notifications stay observable, and MP stops retrying.

### 6.2 Fetch — worker (service role)

For each delivery in `RECEIVED` or `FAILED_RETRYABLE` whose `next_attempt_at ≤ now()`, claimed with `FOR UPDATE SKIP LOCKED`:
1. `GET /v1/payments/{resource_id}` with the Access Token from the function secrets. The token is never in the database, the frontend or logs.
2. Handle the response:
   - **200:** canonicalize the JSON (sorted keys; drop no field) and compute `content_sha256`. Then `INSERT INTO mp_source_record (source_type 'api_payment', external_id 'MPPAY:{id}:{sha256[0:32]}', event_data, occurred_at, occurred_date) ON CONFLICT (source_type, external_id) DO NOTHING`.
   - Identical content therefore maps to the **same** source (zero new rows), and changed content maps to a **new version**. Earlier versions are never mutated (raw guard, 0039).
   - `occurred_at` is the **V-2-confirmed authoritative approval date** (for a snapshot that is not approved yet, the V-2-confirmed creation date).
   - Refunds are ingested as their own child sources, dated by the **V-2-confirmed refund transition date**.
   - No date field is frozen before V-2.
3. Call RPC 40 `mp_normalize_source(source_id)` when the source is still `PENDING`.
4. Call `mp_apply_transition(movement_id)` for each new auto-applicable movement (§5.1: `SETTLE`, `FEE`, `TAX` in one transaction; `ALREADY_APPLIED` on re-run). Then run `mp_auto_allocate` when deterministic evidence exists (§5a). Without evidence, nothing is attributed and nothing is pending.
5. Mark the delivery `FETCHED` (link `source_record_id`) through `mp_delivery_transition`.

Errors:
- **404** (resource not yet readable), **429**, **5xx**, network error or timeout → transient: `FAILED_RETRYABLE` with exponential backoff (1 min doubling, capped at 1 h), up to 48 h. The horizon is our internal policy, not an MP guarantee.
- After that → `FAILED_PERMANENT`, shown for review. The report back-fill (§8) or an ADMIN re-fetch (`mp_request_refetch`) recovers the payment.
- **401 / 403** from MP → `AUTH_CONFIGURATION_ERROR`:
  - the delivery becomes `CONFIG_BLOCKED`, which is **excluded from the normal retry claims**;
  - an operational alert is raised;
  - nothing is marked processed and nothing is discarded;
  - after the configuration is corrected, an explicit requeue (`mp_requeue_config_blocked`) or a safe, rate-limited credential probe returns the deliveries to processing.

### 6.3 `api_payment` parser (RPC 40)

Validation (any failure → ERROR with a note):
- `currency_id = 'ARS'`;
- `collector_id` equals the configured account;
- `operation_type` is in the verified allowlist (V-2);
- amounts are numeric with 2 decimals;
- fee = −Σ `fee_details[].amount`;
- tax = −Σ of the tax / withholding charges (V-2);
- for an approved payment, `transaction_amount + fee + tax = transaction_details.net_received_amount` exactly.

Transitions evidenced by a snapshot, each **dated by its own MP timestamp** (the period determinant, in `America/Argentina/Buenos_Aires`, as in ADR-003):

| Transition | Evidence | occurred_date | Movement |
|---|---|---|---|
| `APPROVAL` | the V-2-confirmed approval evidence | the V-2-confirmed approval date | `payment`: gross, fee, tax, net from the V-2-confirmed fields |
| `REFUND:{refund_id}` | each approved refund element (V-2 fields) | the V-2-confirmed refund transition date | `refund`: gross = net = −amount |
| chargeback / mediation status | the V-2-confirmed status values | — | none: a derived REVIEW_REQUIRED alert (§5) |

Each transition is claimed in `mp_transition_identity` (§7). Only a **new** claim creates a movement, whose `occurred_date` is the transition date.

`mp_financial_movement.occurred_date` is documented as "inherited from source". ADR-006 amends it to "the transition date carried by the source". For every existing ADR-003 source, the two are identical.

A snapshot that yields no new claim is **IGNORED** ("no new transition"). This makes normalization **order-independent**: every snapshot is compared with the identity register, never with "the previous snapshot". Out-of-order, duplicated or stale notifications therefore cannot create, omit or reorder effects.

### 6.4 UX states

These are derived, not a new enum. They lie on **two independent axes**: the axes are never combined into one status, and the client axis never produces review work by itself.

**Terminology (binding for Phase 27 labels and for documentation):**
- **MP reconciliation** means external money completeness and the financial effect: axis A only.
- **Client attribution** means optional CC settlement: axis B only.
- The words "reconciled", "unreconciled" and "pending" are **never** used for axis B. A receipt without a client is "sin cliente asignado" (`CLIENT_UNASSIGNED`), never "no conciliado".

**Axis A — MP reconciliation** (did our records and treasury effects match Mercado Pago?):

| State | Source of truth |
|---|---|
| RECEIVED | `mp_webhook_delivery.status = RECEIVED` (the signature is verified before storage, so VERIFIED is the same state) |
| REJECTED | 401 response; nothing is stored |
| FAILED_RETRYABLE | delivery status (transient; retried automatically) |
| CONFIG_BLOCKED | delivery status after an MP 401 / 403: held, not retried, alerted, recoverable by requeue |
| SIGNAL_RECORDED | delivery status of a processed chargeback signal (signal metadata: link or dismissal, set once) |
| FETCHED | the delivery links a `mp_source_record` in `PENDING` |
| NORMALIZED | movement present, `mp_apply_transition` not yet committed (normally transient: seconds) |
| POSTED | source `RECONCILED` (ADR-003 D4): the treasury effect is complete (receipt, fee, tax), applied atomically |
| REPORT_CONFIRMED | POSTED plus `mp_report_match` = `MATCHED` |
| REVIEW_REQUIRED | **only** one of: source `ERROR` (unparseable, unknown type); a derived chargeback / mediation alert; an unresolved chargeback signal; delivery `FAILED_PERMANENT` or `CONFIG_BLOCKED`; a refund / chargeback movement that is claimed but not yet applied; an open `DISCREPANCY` / `MISSING_IN_REPORT`; `TRANSITION_ALREADY_ASSIGNED` / `APPLICATION_NET_MISMATCH` / `PERIOD_CLOSED` from `mp_apply_transition`; or a worker "already done" check that found a different row (§7) |

**Axis B — client attribution** (does this receipt settle a client's CC?), shown only for `payment` APPROVAL movements. The effective receipt is `gross − Σ` of the refund / chargeback movements **successfully applied to treasury** (§5a invariant):

| State | Definition | Work item? |
|---|---|---|
| CLIENT_UNASSIGNED | active_attributed = 0 | **no**; valid terminal state (Feria, anonymous, own funds) |
| CLIENT_PARTIAL | 0 < active_attributed < effective receipt | no |
| CLIENT_ASSIGNED | active_attributed = effective receipt | no |
| CLIENT_RESOLUTION_REQUESTED | the ADMIN explicitly flagged the receipt (`mp_flag_for_attribution`, audited) and it is not yet fully assigned | **yes**; this is the only attribution state that is a work item |

A receipt can be **REPORT_CONFIRMED + CLIENT_UNASSIGNED forever**: that is a fully valid terminal state, and it is fully reconciled.

The dashboard may show POSTED activity immediately, before report confirmation.

**The balances that are shown:**
- **MP account balance** = Σ postings, which is authoritative treasury. It includes every verified receipt, whether or not it is attributed.
- **Report balance** = the last report BALANCE_AMOUNT, labelled with its date.
- There is **no** "pending identification" balance: unattributed receipts are already in the MP balance.

"Real time" means event-driven and near real time: typically seconds, and at most about one worker cycle plus MP's delivery latency. It is not a zero-latency ledger.

## 7. Idempotency model

| Layer | Identity | Enforced by | Duplicate effect |
|---|---|---|---|
| 1. Webhook delivery | `n:{topic_class}:{notification_id}` for a documented stable notification id, else `h:{canonical notification sha256}`; `x-request-id` is stored for traceability only | `mp_webhook_delivery UNIQUE(delivery_key)` plus a content-hash comparison | same key and same content → no new row. The same key with different content → a bounded conflict row, never merged. Correctness never depends on this layer: a second delivery only causes a re-fetch. |
| 2. MP source resource / version | `(source_type 'api_payment', external_id 'MPPAY:{payment_id}:{content_sha256[0:32]}')`; report rows keep the ADR-003 composite | existing `mp_source_record UNIQUE(source_type, external_id)` plus the raw guard | same content → same row; changed content → new immutable version |
| 3. Normalized financial movement | `mp_transition_identity(resource_type, resource_id, transition, transition_ref)`, for example `('payment', 123, 'APPROVAL', '')` or `('payment', 123, 'REFUND', '987')` | **new** `UNIQUE` on those four columns; claimed by RPC 40 in the same transaction as the movement insert | the second source evidencing the transition (API re-fetch **or** report row) cannot create a movement. It is IGNORED plus matched. |
| 4. `financial_operation.external_ref` | `'MP:' ‖ key`, written by `mp_apply_transition` (and by RPC 41 for ADMIN corrections), with deterministic keys `MPA:{transition_id}:SETTLE` / `:FEE` / `:TAX` | existing `financial_operation.external_ref UNIQUE`, `mp_reconciliation.idempotency_key UNIQUE`, `UNIQUE(movement, operation)` | `DUPLICATE_RECONCILIATION` / `DUPLICATE_LINK`. The worker treats these as "already done" after checking that the existing row equals the intended one; a different row → REVIEW_REQUIRED. |
| 5. Client attribution | `mp_client_allocation.idempotency_key` (`MPAUTO:{transition_id}` for AUTO, caller key for MANUAL; `MPREV:{allocation_id}:{transition_id}` for the OD-1 unwinding); invariant `0 ≤ active_attributed ≤ gross − Σ applied MP reversals` under the APPROVAL movement lock (§5a) | new `UNIQUE(idempotency_key)` plus the capped, locked check | `DUPLICATE_ALLOCATION` / `ALLOCATION_EXCEEDS_RECEIPT`; **never** a posting, so attribution cannot double-count money |

`transition_id` is the BIGINT id of `mp_transition_identity`. The resulting keys are at most 40 characters, within the 97-character limit of ADR-003 D5.

## 8. Report reconciliation data flow

**Authority:**

| Question | Authoritative report |
|---|---|
| Is every balance-affecting event present, and does the MP balance agree? | **Account Money report** (F5), once its parser exists (V-3). Interim: Liberaciones with BALANCE_AMOUNT |
| Release-level fee / tax split of a payment (ADR-003 D1) | Liberaciones (unchanged) |
| Payouts, yields, reserves, account-level taxes | the report row itself, which is the only source (F4) |

**Flow** (manual upload or scheduled report download, both loading `mp_source_record` `csv_import` rows as ADR-003 does). For each report row, RPC 40:
1. Validates it exactly as D1 / D10.
2. Resolves its transition:
   - payment row, **inbound** direction (Liberaciones C / Account Money net > 0) → inbound candidate for `('payment', SOURCE_ID, 'APPROVAL', '')`;
   - payment row, **outbound** direction (Liberaciones D / Account Money net < 0) → `('payment', SOURCE_ID, 'OUTBOUND_PAYMENT', '')`: movement plus REPORT_ONLY; never auto-applied or attributed; no back-fill (V-4 direction correction);
   - refund row → `REFUND` with its refund id when the layout carries one (V-3);
   - payout / yield rows → `('report', SOURCE_ID, kind, '')`. The identity is **report-independent** (V-3 §16):
     - Liberaciones `asset_management` and Account Money K3 share the YIELD identity;
     - Liberaciones `payout` and Account Money `PAYOUTS` share the PAYOUT identity;
     - the second report is IGNORED + MATCHED / DISCREPANCY;
     - source records stay per report.
     Account-tax rows stay fail-closed until evidenced.
3. **Transition already claimed** (the API arrived first) → no movement. The source is IGNORED with the note `MATCHED`, and an `mp_report_match` row is written with outcome **MATCHED** when gross, fee, tax, net and date are equal, or **DISCREPANCY** with the field-by-field difference otherwise. **No financial effect is ever created here.**
4. **Inbound payment transition not claimed** → no movement yet. The source stays PENDING, and a back-fill request for `GET /v1/payments/{SOURCE_ID}` is enqueued in the inbox (`origin = 'report_backfill'`). Only inbound candidates are back-filled. A back-fill that returns a foreign collector is a direction conflict: FAILED_PERMANENT, the fallback is refused, and the row stays REVIEW_REQUIRED.
   - When the API snapshot claims the transition, the report row is re-evaluated and matched (step 3).
   - If the API is permanently unavailable for that id (V-4 / FAILED_PERMANENT), the ADMIN may authorize creating the movement **from the report** through `mp_normalize_report_fallback(source_id, reason)`.
     - It runs a private internal claim path.
     - RPC 40 stays service-role only and exposes no override.
     - The report row then claims the identity, and any later API snapshot is matched against it.
   - First claimant owns the movement in both directions, so double counting is impossible.
5. **Report-only kinds** (payout, yield, account tax) → claim the identity and normalize as ADR-003 does. **REPORT_ONLY** is recorded as the match outcome.
6. **Realtime transitions absent from a report that covers their date** → `mp_report_match` outcome **MISSING_IN_REPORT** (a periodic job over the covered range). The rows are reviewed and never auto-reversed.
7. **Balance check:** for each report with BALANCE_AMOUNT, compare it with Σ postings on the MP account up to that timestamp. Every verified receipt is already posted, attributed or not. The difference is recorded as `mp_balance_check` evidence (a row in `mp_report_match` with `resource_type = 'balance'`).

**Resolution of a DISCREPANCY:**
- a re-fetch that produces a newer snapshot version, then re-match; or
- a financial correction only through the existing RPC 41 (Mode 1 `FEE` / `ADJUSTMENT`, or counter-assignments, D6), followed by the ADMIN RPC `mp_resolve_match(match_id, resolution, reason)`, which is audited.

Matches are never deleted; the resolution is appended.

### 8a. MP reconciliation versus client attribution

| | A. MP reconciliation | B. Client attribution |
|---|---|---|
| Question | Do our external movements and treasury effects match Mercado Pago? | Does this receipt settle a particular client's CC? |
| Records | `mp_reconciliation` (movement ↔ operation), `mp_report_match` | `mp_client_allocation` → `client_ledger` |
| Money | treasury postings (§5.1) | **none**; client ledger only |
| Complete when | POSTED plus REPORT_CONFIRMED | never required. NONE is valid |
| Failure raises review | yes (ERROR, DISCREPANCY, MISSING_IN_REPORT) | only when the ADMIN explicitly requested resolution |

A can be fully complete while B is absent. No report-matching step reads or requires B, and no attribution step writes or changes A.

## 9. Target schema and RPC impact

**Remain valid, unchanged:**
- `mp_financial_movement`, `mp_reconciliation` (ADR-003 columns), `financial_operation`, `financial_posting`, `collections`, `client_ledger`;
- the raw guard and RLS 0041;
- RPC 41: signature, Mode 1 / Mode 2, per-request cap and idempotency. The one exception is the new `AUTO_APPLICATION_PENDING` guard (§4);
- `register_collection` (its provenance is no longer the only `COLLECTION` provenance, §5c);
- `mp_processing_status` (no new enum value).

**Remain valid, extended:**
- `mp_source_record`: new accepted `source_type` value `'api_payment'`. `source_type` is already `VARCHAR(50)`, so no DDL is needed. `occurred_at` is documented as "MP timestamp of the evidenced state".
- `mp_financial_movement.movement_kind`: adds `refund`. It is `VARCHAR`, so no DDL is needed.
- RPC 40 `mp_normalize_source(UUID)`: the signature is unchanged. Its behaviour adds the dispatch, the §6.3 parser, identity claims, report matching and the back-fill enqueue.
  - It stays service-role only.
  - The report fallback is a **separate** ADMIN RPC, `mp_normalize_report_fallback(source_id, reason)`, with a private internal claim path. It is not an override of RPC 40, whose privilege contract is untouched and which exposes no general bypass.

**New:** all tables have RLS and follow the 0041 pattern (ADMIN SELECT; service role SELECT plus the minimum write; OPERATOR nothing; anon nothing).

| Object | Purpose | Writers |
|---|---|---|
| `mp_webhook_delivery`, with:<br>• `delivery_key` UNIQUE (natural or bounded conflict key), content hash, conflict link, `x_request_id` for traceability;<br>• origin `webhook` / `report_backfill` / `chargeback_refresh` / `manual_refetch`;<br>• topic, topic class (`payment` / `chargeback` / `unsupported`), action, resource_id, reduced body;<br>• chargeback signal metadata (link / dismissal, set once);<br>• status `RECEIVED` / `PROCESSING` / `FETCHED` / `SIGNAL_RECORDED` / `FAILED_RETRYABLE` / `FAILED_PERMANENT` / `CONFIG_BLOCKED` / `UNSUPPORTED`;<br>• attempts, lease, last_error, source_record_id FK | inbox / queue; **not** financial | only through SECURITY DEFINER RPCs (register, claim, transition, requeue, re-fetch, chargeback-signal resolution; the complete list is in ADR006_RPC_CONTRACTS_V1) |
| `mp_transition_identity` (id BIGSERIAL, resource_type, resource_id, transition, transition_ref, UNIQUE(4 cols), mp_financial_movement_id UNIQUE NULL, claimed_by_source_id FK) | normalized movement identity; the anti-double-count backstop | RPC 40 only |
| `mp_report_match` (report_source_id FK, transition_id FK NULL, outcome `MATCHED` / `DISCREPANCY` / `REPORT_ONLY` / `MISSING_IN_REPORT` / `BALANCE_CHECK`, detail JSONB, resolution, resolved_by, resolved_at) | reconciliation evidence | RPC 40, the matching job (service role RPC), `mp_resolve_match` (ADMIN) |
| `mp_client_allocation` (§5a) | optional client attribution; **no money** | only the allocation RPCs below |
| `mp_payer_client_map` (`mp_payer_id` UNIQUE, `cliente_id`, activo, created_by / at) | explicit deterministic evidence for AUTO | ADMIN only (maintenance RPC, audited) |
| `mp_attribution_flag` (movement_id, reason, requested_by / at, cleared_by / at) | the ADMIN's explicit "this receipt needs a client" marker | `mp_flag_for_attribution` / `mp_clear_attribution_flag` (ADMIN) |
| RPC `mp_apply_transition(p_movement_id)` | the **only** automatic treasury writer: all components of a transition (`MP_SETTLEMENT` / `FEE` / `ADJUSTMENT`, their postings and `mp_reconciliation` rows) in one transaction, Σ = net proven, `ALREADY_APPLIED` on re-run, plus the OD-1 unwinding (§5.1, §5d) | service role |
| RPC `mp_allocate_to_client(p_movement_id, p_cliente_id, p_amount, p_effective_date, p_idempotency_key, p_reason)` | MANUAL attribution; §5a invariant under the movement lock; writes `client_ledger` `COLLECTION` −amount plus the allocation plus audit; **no operation, no posting** | ADMIN |
| RPC `mp_auto_allocate(p_movement_id)` | AUTO attribution from stored deterministic evidence only; no client parameter | service role |
| RPC `mp_reverse_client_allocation(p_allocation_id, p_amount, p_reason)` | corrects an attribution, fully or partially: `client_ledger` `REVERSAL` +amount plus a −amount allocation row, append-only | ADMIN |

**Collections are unchanged.** `collections` and `register_collection` (RPC 4) keep their Frozen meaning: a receipt that creates its own money movement (cash, transfer, or MP recorded manually outside this pipeline). An MP receipt ingested by ADR-006 is **never** also registered through `register_collection`. Doing so would post the money twice, so the Phase 27 UI routes MP client settlement exclusively to `mp_allocate_to_client`.

- **Service-role boundary:**
  - The service role gains exactly two client-side paths: `mp_auto_allocate` (OD-2) and the OD-1 unwinding inside `mp_apply_transition`.
  - In both, the client, the amount and the order are **derived** from stored evidence. The service role cannot choose a client, cannot read client data through a table grant, and cannot write the client ledger otherwise.
  - These are the only audited exceptions to Phase 23 I6, and both follow from accepted owner decisions (OD-1, OD-2).

**Does not exist in the target:** `mp_movement_source_link`, which the task lists, is a **legacy** table (Phase 26 evidence-only source list); the target has no such object. Its role (movement ↔ source traceability) is covered by `mp_financial_movement.mp_source_record_id` plus `mp_transition_identity.claimed_by_source_id` plus `mp_report_match`. **No parallel MP ledger is introduced**: money lives only in `financial_posting`.

**Security (I):**
- The webhook secret and the Access Token live only in the Edge Function secrets. Nothing is committed and nothing is placed in the frontend or the database.
- The public endpoint has no database privilege of its own; it uses the service role only for the two grants above.
- There is no `Access-Control-Allow-Origin: *`.
- Logs never contain the body, signature, manifest, HMAC (even a prefix), token or payer data. The legacy function does log the manifest and an HMAC prefix; that practice is prohibited.
- The service role gains no table access to clients or ledgers. Its only client-side capabilities are `mp_auto_allocate` and the OD-1 unwinding, both evidence-derived (§9).

## 10. Failure and retry model

| Failure | Behaviour | Why it is safe |
|---|---|---|
| Duplicate webhook | the delivery insert conflicts; 200 | layer 1 |
| Retried delivery after our 5xx | a new attempt inserts or conflicts | layers 1–2 |
| Out-of-order webhooks | each fetch reads the current resource; transitions are claimed against the register | §6.3 order independence |
| MP API temporarily failing / resource not yet readable (404) | `FAILED_RETRYABLE`, backoff, then `FAILED_PERMANENT` → review; the report back-fill recovers | no partial state is written before a 200 fetch |
| Signature failure | 401, nothing stored | §6.1 |
| Status update after the initial payment | new snapshot version (new content hash); only new transitions create movements | layers 2–3 |
| Refund after approval | `REFUND:{refund_id}` transition → `refund` movement | layer 3 per refund id; partial refunds are distinct |
| Chargeback | a durable signal (`SIGNAL_RECORDED`) and / or a derived status alert → REVIEW_REQUIRED; a payment refresh when a documented relation exists, otherwise ADMIN link / dismiss; the amount comes only from an authoritative source (API if V-2 proves one, otherwise the V-3 report) | no invented amount |
| Reconciliation disagreement | `DISCREPANCY`, reviewed; corrections only through RPC 41 | never auto-posted |
| Unknown movement type / operation_type | ERROR (REVIEW_REQUIRED) | fail closed |
| Worker crash after the raw insert, before RPC 40 | the source is left PENDING; the next cycle normalizes it | RPC 40 claims and inserts atomically |
| Worker crash after RPC 40, before `mp_apply_transition` | the movement has no reconciliation rows; the next cycle applies all components at once | layer 4; RPC 41 cannot pre-empt (`AUTO_APPLICATION_PENDING`) |
| Failure inside `mp_apply_transition` (any component, period closed, net mismatch, crash) | the whole transaction rolls back: no operation, posting, reconciliation, unwinding or audit | atomic; there is never a partial component set, so the RPC 41 net cap is never approached component by component |
| Worker crash during an attribution | allocation, ledger row and audit are one transaction; a retry with the same key → `DUPLICATE_ALLOCATION` | layer 5 |
| Attribution attempted twice or beyond the receipt | idempotency key plus the capped check under the movement lock | layer 5 |
| Worker crash after posting, before marking the delivery | re-run: the same content → no new source; `mp_apply_transition` → `ALREADY_APPLIED` (the exact planned set exists) → mark FETCHED | layer 4 |
| Refund or chargeback on an attributed receipt | treasury and OD-1 unwinding in the same transaction; restoration = min(R, active), never more | §5d, layer 5 |
| Concurrent workers on the same payment | `SKIP LOCKED` on the delivery; unique constraints on the source, identity and keys serialize the rest | layers 2–4 |
| Report arrives before the API | back-fill; first claimant owns | §8 step 4 |
| Webhook secret or token rotated | a wrong webhook secret causes 401 responses (MP retries after the fix); a wrong token → `AUTH_CONFIGURATION_ERROR`, deliveries `CONFIG_BLOCKED` with an alert, then an explicit or probe-driven requeue after the fix | no data loss; nothing processed or discarded while blocked |

## 11. Phase impact

- **Phase 26** clean cutover remains **COMPLETE and unchanged**. Historical MP data stays excluded (evidence only), and MP starts from the cutover opening balance (Phase 31 value).
- **ADR-006 must be accepted, and its schema/RPC contract frozen, before Phase 27 builds any MP screen.** Phase 27 may proceed on the non-MP scope in the meantime.
- **Phase 27** consumes, read-only:
  - the §6.4 states on two separate axes (reconciliation; client attribution);
  - the report-match status;
  - the ADMIN actions: `mp_allocate_to_client` (optional CC settlement), `mp_reverse_client_allocation`, `mp_flag_for_attribution`, `mp_resolve_match` and the report fallback.
  - Unattributed receipts must **not** appear as a to-do list. The only attribution work queue is receipts the ADMIN flagged.
- **Implementation phase:** the new objects of §9, the Edge Function and the worker, the regression suite extending `mp.test.mjs`, and the verification items V-1 to V-4. It is placed before Phase 27's MP screens; the roadmap slot is to be assigned when the ADR is accepted.
- **Phase 31 gates** (the cutover must refuse otherwise):
  1. the MP webhook URL is switched to the ADR-006 endpoint **and** the legacy writer and webhook are disabled in the same step (ADR-003 D8 extended);
  2. a signed end-to-end check: one real payment reaches `POSTED` (receipt, fee and tax) with no client attribution;
  3. the MP opening balance is owner-validated against the Account Money report at the boundary;
  4. no `FAILED_PERMANENT` delivery, no unresolved `DISCREPANCY` and no ERROR source after the boundary;
  5. the Account Money parser (V-3) is accepted, or the interim Liberaciones completeness is explicitly accepted by the owner for the first period.

## 12. Verification items (classification ratified 2026-09-27)

These are technical items, resolved mechanically during implementation. They are **not** owner decisions.

| # | Item | Resolution |
|---|---|---|
| V-1 | Exact signature manifest, `ts` unit and tolerance, retry timing and response deadline | **VERIFIED FOR ARCHITECTURE.** The exact integration-specific signature construction is rechecked against the current official Mercado Pago documentation during implementation, and encoded in tests. The fallback is fail-closed (reject). |
| V-2 | `operation_type` allowlist and the payment field that carries taxes / withholdings | **REQUIRED before implementing `api_payment` normalization.** Fetch real payments of the owner's account (read-only API) and compare with the matching Liberaciones rows; anything outside the list → ERROR |
| V-3 | Account Money report layout and parser | **REQUIRED before freezing its parser:** needs one real export file (an owner **action**, not a decision); specified by an ADR-006 addendum with the same rigour as ADR-003 D1 |
| V-4 | Liberaciones `SOURCE_ID` = MP payment id for `payment` rows | **ID EQUIVALENCE PROVEN** (2026-09-28, `ADR006_V4_EQUIVALENCE_EVIDENCE.md`) for payment-resource rows, both inbound and outbound. `mp_v4_verified()` may become true **only after** the report parser is direction-aware (`ADR006_V4_DIRECTION_CORRECTION.md` §9); outbound rows are never APPROVAL |

## 13. Owner decisions

1. **OD-1 — ACCEPTED (2026-09-26).** When an MP receipt carries client allocations and is later refunded or charged back:
   - client debt is restored only for the **actual** reversed amount;
   - more client attribution than exists is never reversed: a partial refund gives a partial restoration, and a full refund or chargeback restores up to the full attributed amount;
   - if no attribution exists, the client ledger is untouched;
   - deterministic evidence selects the affected allocation when it exists; otherwise allocations are unwound newest first;
   - only compensating ledger entries are used, never destructive mutation;
   - the treasury reversal stays independent and automatic, according to MP evidence.

   Implemented by §5d, inside `mp_apply_transition`.
2. **OD-2 — ACCEPTED (2026-09-26).** Client attribution is **optional**:
   - automatic attribution is allowed only when deterministic (the app's `external_reference`, an app-created QR or link, or the explicit payer mapping);
   - manual attribution is available when useful;
   - no attribution is a valid terminal state for anonymous or Feria receipts;
   - nothing is ever inferred from amount, payer name or timing.

   Implemented by §5a, §5b and §6.4.
3. **Partial attribution — decided technically (no owner decision needed):**
   - V1 **allows** partial and split attribution: several allocations, several clients, each up to the remaining amount.
   - Invariant `0 ≤ active_attributed ≤ gross − Σ MP reversals`, under the APPROVAL movement lock (§5a).
   - The only extra complexity is an amount parameter and this check, both of which are needed anyway to enforce the owner's cap.
   - Forbidding partial attribution would need a separate "full amount only" rule and would block real cases, such as one transfer covering two CCs or a partial CC payment.

No owner decision remains open.
