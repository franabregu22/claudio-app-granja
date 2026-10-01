# ADR-010 — Purchase attachments are optional

**STATUS:** **ACCEPTED** (owner decision D-WALK-5, 2026-09-30, Phase 27 manual walkthrough). Implemented by migration `0061_optional_purchase_attachments.sql` and by the FROZEN amendments in §4 (each marked **[ADR-010]**).
**DATE:** 2026-09-30
**RAISED BY:** the owner walkthrough of Phase 27. Not every real purchase has a receipt or document, and the "at least one attachment" rule blocked real operations.
**AFFECTS (FROZEN):**
- TARGET_ARCHITECTURE_V2_FROZEN Part 8 (amendment note);
- DATABASE_INVARIANTS_V1 invariant 23 (superseded);
- RPC_CONTRACTS_V1 RPC 13 `register_purchase` and RPC 14 `rectify_purchase`;
- ADR-008 (its "at least one receipt" wording).

**NOT AFFECTED:**
- the ADR-008 Storage perimeter: private bucket, ADMIN-only upload / read / delete, limits, generated keys, no public URL;
- `purchase_attachment` (columns, constraints, RLS, no DELETE);
- the purchase accounting authority (supplier ledger, P&L on `amount_total`, versioning, ADR-002 keys);
- the SECURITY DEFINER set.

---

## 1. Decision (owner, D-WALK-5)

1. A purchase MAY be registered with zero attachments.
2. Attachments remain supported, private and ADMIN-only (ADR-008) when a real document exists. Nothing is ever fabricated to satisfy a rule.
3. The UI labels the field **"Comprobante (opcional)"**.

## 2. Contract change (migration 0061)

Both functions are re-defined from 0022 with the same signatures; every other line is unchanged.

| RPC | Before | After |
|---|---|---|
| 13 `register_purchase` | `p_attachments` NULL / not an array / empty → `ATTACHMENT_REQUIRED` | NULL or `[]` → accepted with `attachment_count = 0`. A supplied value that is not a JSON array → `INVALID_ATTACHMENTS`. Each supplied attachment is still validated by `purchase_attachment`'s NOT NULL / CHECK / UNIQUE constraints (e.g. a missing `storage_path` rolls the whole purchase back). |
| 14 `rectify_purchase` | the current version must have ≥ 1 attachment → `ATTACHMENT_REQUIRED` | the new version carries forward whatever attachments exist, possibly none |

`ATTACHMENT_REQUIRED` is no longer raised by any RPC.

## 3. Frontend (F27-D "Nueva compra")

- **No file:** `register_purchase` is called directly with `p_attachments = []`.
- **One or more files:** the ADR-008 sequence is unchanged: validate → upload to the private bucket → `register_purchase` with the object metadata → compensation (delete the uploaded objects) if the RPC fails.

## 4. Amended FROZEN documents

| Document | Amendment **[ADR-010]** |
|---|---|
| `TARGET_ARCHITECTURE_V2_FROZEN.md` Part 8 | note after "Attachments per workflow defined.": attachments are optional for purchases |
| `DATABASE_INVARIANTS_V1.md` §23 and summary row 23 | the invariant is superseded; no purchase-attachment count invariant remains |
| `RPC_CONTRACTS_V1.md` RPC 13 / RPC 14 | the new validation, carry-forward and error lists |
| `adr/ADR-008_PURCHASE_ATTACHMENT_STORAGE.md` | the attachment is optional; the upload sequence applies only when a file is supplied |

## 5. Verification

- `scripts/target-db/purchases.test.mjs`, section C (amended):
  - non-array → `INVALID_ATTACHMENTS`, atomic;
  - NULL / `[]` → accepted with 0 attachments and the supplier debt booked;
  - a purchase without attachments is rectifiable;
  - a malformed supplied attachment still rolls back;
  - no direct purchase INSERT.
- K3 (amended): a current version without attachments is rectified; the new version carries none.
- `tests/unit/f27d-treasury.test.ts` and `tests/integration/f27d-treasury.test.ts`: zero attachments accepted; the with-file path unchanged.
- The ADR-008 Storage-API tests and the "Nueva compra" real-Storage end-to-end test stay **SKIPPED / PRE-CUTOVER REQUIRED** (plan §9b), now meaning "when a file is supplied".
