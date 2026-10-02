# ADR-017 — Mercado Pago cutover boundary (G-7)

**STATUS:** **ACCEPTED** (owner decision, Phase 31 Step 1, 2026-10-02: "implement a BACKEND cutover boundary; an ADMIN operational control is not the primary solution"). Implemented by migration `0071_mp_cutover_boundary.sql`.
**DATE:** 2026-10-02
**RAISED BY:** Phase 31 Step 0, gap G-7 (`PHASE_31_CUTOVER_RUNBOOK_V1.md` §0A).

**AFFECTS:**
- ADR-006 (by explicit amendment / cross-reference only; its frozen contract is not rewritten): RPC 40 `mp_normalize_source` gains one guard before its branches; §11 Phase 31 gate 4 ("after the boundary") now has an enforced boundary.
- RPC_CONTRACTS_V1: RPC 40 amendment line.
- POSTGRES_SCHEMA_SPEC_V1: new table `mp_cutover_boundary`.
- RLS_IMPLEMENTATION_SPEC_V1: the table is owner-only (no API role privilege).
- DATABASE_INVARIANTS_V1: invariant 34.

**NOT AFFECTED:**
- the SECURITY DEFINER set: 69 (no new function, trigger or grant);
- S4 `mp_ingest_api_snapshot`, A1 `mp_apply_transition`, the chargeback signal path, the report-completeness authority (ADR-006 §8), and the views.

---

## 1. Problem

- The target MP account starts from an **owner-validated opening balance at the cutover instant** (Phase 26 clean cutover; ADR-006 §11 gate 3).
- That opening already contains every economic event before the instant.
- After the webhook switch, Mercado Pago can still deliver a notification, retry one, or re-deliver a resource for a payment approved **before** the cutover. A Liberaciones report uploaded after the switch can also contain pre-cutover rows.
- Applying any of them in the target would count the same money twice: once inside the opening, once as a new receipt.

## 2. Decision

### 2.1 Cutover authority

`mp_cutover_boundary` is a **singleton** table: `singleton BOOLEAN PK CHECK (singleton)`, plus `cutover_at TIMESTAMPTZ NOT NULL` with **no default**, `import_batch`, `evidence_ref` and `recorded_at`.

**Written once**, by the Phase 31 cutover procedure, as the database owner:
- the command is `scripts/phase31/migrate-cutover.mjs load`;
- `cutover_at` comes from the owner's cutover config (`cutover_boundary.cutover_at`, an explicit ISO-8601 timestamp **with offset**);
- the runner refuses a timestamp without an offset;
- the write is audited as `PHASE31_BOUNDARY`.

**Not configurable by the application.** No API role (`anon`, `authenticated`, `service_role`) has any privilege on the table: the worker reads it only through the SECURITY DEFINER RPC 40, and there is no UI, RPC or default.

**Never changed after it is set.** The runner only inserts, and fails on a different existing value. Changing it means a rollback / reprovision of the target (§6).

### 2.2 Missing boundary → fail safe

- RPC 40 raises `CUTOVER_BOUNDARY_MISSING` before any branch.
- The webhook delivery and the immutable API snapshot (S4) are kept, and the source stays `PENDING`.
- No movement and no posting is created. The worker's retry processes it once the boundary exists.
- Local test stacks record a synthetic boundary in the far past (`2000-01-01Z`, batch `LOCAL-TEST-FIXTURE`, `scripts/test-env/mp-boundary-fixture.mjs`). The cutover runner **refuses** a target that carries it.

### 2.3 Timestamp authority (no invented field)

| Source | Field compared | Notes |
|---|---|---|
| `api_payment` (webhook / worker path) | the snapshot's `date_approved` | Mercado Pago payment resource, V-2 §15 field set (`ADR006_V2_PAYMENT_FIELD_EVIDENCE.md`). It is the same authority 0050 already uses for `mp_source_record.occurred_at` of an approved + accredited payment, and RPC 40 already requires it to be valid (`DATE_MISMATCH` otherwise). Format: ISO-8601 with offset (`c_ts` pattern of 0050), parsed as `timestamptz`, so the comparison is instant-to-instant, timezone-independent. A well-shaped but impossible value is never classified. |
| `csv_import` (Liberaciones report rows) | `mp_source_record.occurred_at` | set at ingest by the existing report parser (ADR-003 / 0048) |

- **Never used:** webhook delivery time, `date_created` of an approved payment, `money_release_date`, processing time.

### 2.4 Pre-cutover rule (C2)

The guard classifies a source as included in the opening **only** when all of these hold:

- **`api_payment`:**
  - the 0050 identity derivation matches, the currency is ARS and the collector is present (so no integrity error is hidden);
  - `status = approved` and `status_detail = accredited`;
  - `date_approved` is valid;
  - there is **no refund evidence**: `refunds` empty or absent, and `transaction_amount_refunded = 0`;
  - `date_approved < cutover_at`.
- **`csv_import`:** `occurred_at < cutover_at`.

**Result:**
- `processing_status = IGNORED` (terminal, existing state);
- `processing_note = 'PRE_CUTOVER_INCLUDED_IN_OPENING_BALANCE: <ts> < cutover <cutover_at>'` (UTC);
- **no movement**, no transition identity, no posting, no collection, no client allocation;
- the audit `NORMALIZE` row records the classification;
- the RPC returns `pre_cutover: true`.

The delivery, the snapshot and the source record stay as evidence. Nothing is dropped.

### 2.5 Exact boundary (C5)

| Condition | Treatment |
|---|---|
| `economic_timestamp < cutover_at` | included in the opening balance; not reapplied |
| `economic_timestamp >= cutover_at` | normal ADR-006 processing |

A payment approved **exactly** at `cutover_at` belongs to the target. Tested to the millisecond (G3 / G4).

### 2.6 Refunds and chargebacks (C4)

The guard is **not** "ignore everything about a pre-cutover payment":
- a payment snapshot carrying refund evidence (full or partial) is never classified as pre-cutover. The unchanged ADR-006 logic decides, and it stays fail-closed (`REFUND_UNSUPPORTED` / `IGNORED` per 0050);
- chargeback / dispute notifications follow the ADR-006 signal path (`mp_register_delivery` → signal; financial application fail-closed pending evidence). The boundary does not touch them, so a post-cutover adverse event for a pre-cutover payment is recorded and surfaced, never discarded.

### 2.7 Retries and idempotency

- **A retry of a pre-cutover payment:**
  - the new delivery is recorded;
  - S4 resolves the identical payload to the same snapshot (no second source);
  - the source is already `IGNORED`, so there is no reprocessing and still 0 movement.
- **A retry of a post-cutover payment:** the unchanged ADR-006 idempotency applies (one snapshot, one movement, applied once).

## 3. Operational requirement on the MP opening (owner)

- The target posts an approved payment on its approval (ADR-006 §5).
- So the **Mercado Pago opening balance** entered in the cutover config must be measured on the same basis: it must include every payment **approved before** `cutover_at`, including any not yet released by Mercado Pago, and exclude everything approved at or after it.
- The owner validates the value against the Account Money report at the boundary (ADR-006 §11 gate 3) with that basis stated in the evidence reference.

## 4. Amendment to ADR-006 (cross-reference)

> **Amendment [ADR-017]** (2026-10-02, migration 0071):
> - RPC 40 `mp_normalize_source` first requires the Phase 31 cutover boundary (`CUTOVER_BOUNDARY_MISSING` otherwise).
> - It classifies pre-cutover approved payments (no refund evidence) and pre-cutover report rows as `IGNORED / PRE_CUTOVER_INCLUDED_IN_OPENING_BALANCE` with no movement.
> - Every other path is byte-for-byte the 0050 logic.
> - §11 gate 4's "after the boundary" refers to `mp_cutover_boundary.cutover_at`.

## 5. Verification

- **`scripts/target-db/mp_cutover_boundary.test.mjs`** (16 checks). Every scenario runs in one rolled-back transaction through delivery → S4 → RPC 40 → A1.
  - Authority:
    - B1 no API privilege, no default, definers 69;
    - B2 singleton;
    - B3 the worker cannot write.
  - G-7 matrix:
    - G1 pre-cutover payment;
    - G2 retried after the switch;
    - G3 exactly at the boundary;
    - G4 1 ms after;
    - G5 duplicate retry, pre-cutover;
    - G6 duplicate retry, post-cutover;
    - G7 chargeback signal;
    - G8 refund evidence, full and partial;
    - G9 / G9b missing boundary;
    - G10 / G10b malformed or impossible timestamp;
    - G11 report rows before / after.
- **The existing MP suites and the ADR-006 matrix:** unchanged behaviour, with the local test boundary fixture.

## 6. Rollback implications

| Rollback case | Effect |
|---|---|
| A (pre-switch) | the target is discarded together with its boundary |
| B (post-switch, no real writes) | the legacy project is untouched by this ADR. MP notifications go back to the legacy URL. |
| Re-run of a cutover on a fresh target | a new boundary (a new config / batch) |
| Changing the boundary of a **live** target | **not supported.** It would re-qualify money already applied or excluded; it needs a new ADR. |
