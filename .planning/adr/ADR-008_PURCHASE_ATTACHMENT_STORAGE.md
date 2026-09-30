# ADR-008 — Purchase attachment storage (private bucket `purchase-attachments`)

**STATUS:** **ACCEPTED** (owner decision D-F27D-1, 2026-09-30). It is implemented by migration `0058_purchase_attachment_storage.sql` and by the FROZEN amendments listed in §7 (each marked **[ADR-008]**).
**DATE:** 2026-09-30
**RAISED BY:** Phase 27 slice F27-D. The frontend could not offer "Nueva compra": `register_purchase` requires at least one attachment, whose `storage_path` is a Supabase Storage object, and the target defined no Storage location or access rule.
**AFFECTS (FROZEN):** RLS_IMPLEMENTATION_SPEC_V1 (new Storage perimeter), RPC_CONTRACTS_V1 (RPC 13 caller sequencing), POSTGRES_SCHEMA_SPEC_V1 (`purchase_attachment.storage_path` refers to the bucket).
**NOT AFFECTED:** purchases and their accounting authority (`register_purchase` / `rectify_purchase` unchanged, `ATTACHMENT_REQUIRED` unchanged, invariant 23 unchanged); no public table, column, function or grant; the SECURITY DEFINER set stays at 62; DATABASE_INVARIANTS_V1; IMPLEMENTATION_DEPENDENCY_ORDER_V1; TARGET_ARCHITECTURE_V2_FROZEN.

---

## 1. Context — the gap

| Source | Text |
|---|---|
| `POSTGRES_SCHEMA_SPEC_V1.md` `purchase_attachment` | `storage_path TEXT NOT NULL -- Supabase Storage object path`, `file_name`, `content_type`, `byte_size`; at least one per purchase. |
| `RPC_CONTRACTS_V1.md` RPC 13 | `p_attachments JSONB -- [{storage_path, file_name, content_type, byte_size}] — at least one REQUIRED`; `ATTACHMENT_REQUIRED` otherwise. |
| `RLS_IMPLEMENTATION_SPEC_V1.md` §7 | `purchase_attachment` rows: ADMIN SELECT / INSERT. Nothing about the objects themselves. |

No migration created a bucket or a `storage.objects` policy, and no frozen document named the location, its visibility or who may read it. Without that, no purchase can be registered from the application.

## 2. Decisions (ACCEPTED, D-F27D-1)

| Id | Decision |
|---|---|
| S-1 | Purchase attachments live in the Supabase Storage bucket **`purchase-attachments`**, which is **private** (`public = false`). No public URL is used anywhere; an ADMIN views an object through a short-lived signed URL or an authenticated download. |
| S-2 | **Only authenticated ADMIN** may upload, read / download and delete objects of the bucket. OPERATOR and anon have no access. The role comes from the single existing authority `current_app_role()` (RLS spec §2); no second role system. |
| S-3 | **Limits:** 10 MB per object (`file_size_limit = 10485760`); **MIME allowlist:** `application/pdf`, `image/jpeg`, `image/png`, `image/webp`. Everything else is refused by Storage. The frontend repeats the check for UX only. |
| S-4 | **Object key:** generated, collision-safe `<auth-user-id>/<uuid>.<ext>` (`ext` from the MIME type). The user's original file name is never the key; it is kept only in the existing `purchase_attachment.file_name` column. No new column. The INSERT policy requires the first path segment to be the uploader's `auth.uid()`. |
| S-5 | **No UPDATE policy:** an uploaded object is never overwritten or moved. |

## 3. Storage perimeter (migration 0058)

```sql
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('purchase-attachments', 'purchase-attachments', false, 10485760,
        ARRAY['application/pdf','image/jpeg','image/png','image/webp']);

-- storage.objects, TO authenticated, confined to the bucket:
--   SELECT / DELETE  USING      (CASE WHEN bucket_id = 'purchase-attachments' THEN current_app_role() = 'ADMIN' ELSE false END)
--   INSERT           WITH CHECK (CASE WHEN bucket_id = 'purchase-attachments'
--                                     THEN current_app_role() = 'ADMIN' AND (storage.foldername(name))[1] = auth.uid()::TEXT
--                                     ELSE false END)
```

`current_app_role()` raises for a caller without an active profile. The `CASE` evaluates the bucket test first, so the role is resolved only for rows of this bucket: other buckets get `false` and are neither opened nor broken by these policies. There is no policy for `anon` and none for UPDATE.

## 4. Sequencing: upload → `register_purchase`

1. ADMIN fills the purchase and selects at least one receipt (the form cannot be submitted without one).
2. The frontend validates type and size (UX), generates each key (S-4) and uploads each file to the bucket.
3. The frontend calls RPC 13 `register_purchase` with `p_attachments = [{storage_path, file_name, content_type, byte_size}]` for the uploaded objects. The RPC remains the only authority for the purchase row, lines, attachment rows, supplier ledger and audit. It does not read Storage.
4. Success: the objects are kept; the purchase screens refresh.

**Upload failure:** `register_purchase` is not called. Objects already uploaded by this attempt are deleted. The user gets `ATTACHMENT_UPLOAD_FAILED`.

**Compensation when `register_purchase` fails after upload:** the frontend deletes the objects this attempt uploaded, then surfaces the ORIGINAL purchase error (e.g. `DUPLICATE_PURCHASE`, `SUPPLIER_NOT_FOUND_OR_INACTIVE`). If the cleanup itself fails, the original error is still what the user sees, and the failure is reported safely (object keys only, no token or payload). The orphaned object is inert: it is private, ADMIN-only and referenced by no purchase.

`rectify_purchase` carries the attachment rows forward (unchanged, invariant 23); it uploads nothing.

## 5. Consequences

- "Nueva compra" becomes available in V1 without weakening `ATTACHMENT_REQUIRED`.
- Storage enforces the MIME and size limits in its service; the access rules are RLS on `storage.objects`, executed by the Storage service with the caller's role and JWT claims.
- Orphans are possible only when both the purchase and the cleanup fail. They are harmless and can be listed by comparing `storage.objects` in the bucket with `purchase_attachment.storage_path`.

## 6. Verification

- `tests/integration/f27d-storage.test.ts`:
  - bucket configuration and the exact three policies;
  - the RLS perimeter executed as `authenticated` (ADMIN / OPERATOR / no profile) and `anon`: ADMIN create / read / delete; OPERATOR and anon no read, create or delete; no write outside the uploader's folder; no UPDATE; an unrelated bucket stays closed and does not error;
  - Storage-API layer (MIME, 10 MB, signed and public URLs, real upload), which requires the local Storage service.
- `tests/integration/f27d-treasury.test.ts`: "Nueva compra" end to end (requires the local Storage service).
- `tests/unit/f27d-treasury.test.ts`: sequencing and compensation.

**Verification status (owner decision on E-F27D-2, 2026-09-30):**
- Accepted for Phase 27 F27-D: migration 0058 applied locally, the bucket configuration and the RLS perimeter verified in the database, and the upload / cleanup sequencing covered by unit tests.
- The Storage-API layer and the end-to-end "Nueva compra" tests are **SKIPPED / PRE-CUTOVER REQUIRED**: the local stack runs without the Storage service. They are deferred, not waived, and must run green on the canonical local stack before cutover.

## 7. Amended FROZEN documents

| Document | Amendment **[ADR-008]** |
|---|---|
| `RLS_IMPLEMENTATION_SPEC_V1.md` | header amendment line; §7 "Purchase attachment objects (Storage)". |
| `RPC_CONTRACTS_V1.md` | header amendment line; RPC 13 note: attachment objects are uploaded to `purchase-attachments` before the call, and removed by the caller if the call fails. |
| `POSTGRES_SCHEMA_SPEC_V1.md` | header amendment line; `purchase_attachment.storage_path` = object key in the private bucket `purchase-attachments`. |
