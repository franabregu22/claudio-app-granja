# ADR-002 — Bounded idempotency key for rectified purchase versions

**STATUS:** **ACCEPTED** (owner approval, 2026-09-25: D1 APPROVED, D2 APPROVED). Implemented by the FROZEN amendments in §8, marked **[ADR-002]**, and by migration `0022_purchase_rectification_version_key.sql`.  
**HISTORY:** PROPOSED 2026-09-25 → ACCEPTED 2026-09-25.
**DATE:** 2026-09-25
**RAISED BY:** external review of Phase 17. This is the only blocker for closing Phase 17.
**SCOPE:** versioning of `purchases` by RPC 14 `rectify_purchase` only.

It is **not** the transversal financial-operation idempotency carry-forward (PHASE_15_TREASURY.md §22), which concerns `financial_operation.external_ref` and is unaffected.

---

## 1. Context — the conflict

| Source | Text |
|---|---|
| `POSTGRES_SCHEMA_SPEC_V1.md` line 682 (`purchases`) | `idempotency_key VARCHAR(100) UNIQUE NOT NULL` |
| `RPC_CONTRACTS_V1.md` line 976 (§14 `rectify_purchase`) | new version key = `old.idempotency_key \|\| ':v' \|\| new_version` |
| `supabase/target-migrations/0020_purchase_supplier_rpcs.sql` line 277 | `v_old_key \|\| ':v' \|\| v_new_version` (faithful transcription) |
| `DATABASE_INVARIANTS_V1.md` §16 | "Rectification is set-versioned and **correct for N passes**", and `purchases` "uses the same discipline … (RPC 14)" |
| `PHASE_17_PURCHASES_SUPPLIERS.md` §11, §36 | "N-pass rectification … MET", evidenced with 3 passes |

**Why the frozen documents conflict:** the contract concatenates the **previous version's** key, so each rectification appends to an ever-growing string:

```
base → base:v1 → base:v1:v2 → base:v1:v2:v3 → …
```

After k passes, the length is `L + Σ_{i=1..k} (2 + digits(i))`, which grows without bound. The schema caps it at 100. As a result:

1. an initial key close to 100 characters makes the **first** rectification fail;
2. any key fails after enough passes;
3. invariant §16 ("correct for N passes") cannot hold for arbitrary N as frozen.

The Phase 17 evidence (3 passes) was true but did not cover the limit.

**Failure behaviour:** the RPC raises `value too long for type character varying(100)` at the insert of the new version. Because it is one transaction, it rolls back completely: no corruption, the old version stays current. The purchase simply cannot be rectified any more.

## 2. Mechanical evidence (current strategy)

The probe ran against the local test database only, inside one transaction that was **rolled back**: the before and after state were identical, and 0 migrations changed.

| Case | Result |
|---|---|
| A. initial key of exactly 100 characters | registered OK |
| B. first rectification of that purchase | **FAILED**: `value too long for type character varying(100)` |
| C. initial key of 36 characters, rectified repeatedly | passes 1–18 OK, **pass 19 FAILED** (same error) |

Computed limit for other initial lengths L (pass that fails): L=8 → 26, L=13 → 25, L=20 → 23, L=36 → 19 (matches the probe), L=50 → 15, L=80 → 7, L=97 → 2, L=98..100 → 1.

## 3. Decision drivers

**Must preserve:**

- `UNIQUE idempotency_key`
- `rectify_purchase` concurrency safety
- exactly one current version
- N-pass correctness for arbitrary N
- zero change to economics and to `supplier_ledger` semantics
- the retire-then-insert order
- invoice scoping
- attachment carry-forward and allocation re-pointing

**Must avoid:**

- recursive concatenation;
- truncation (it loses information and can collide);
- enlarging VARCHAR alone, which only moves the limit;
- inventing new structure when an existing stable identity suffices.

## 4. Options

| # | Option | Assessment |
|---|---|---|
| 1 | Keep the contract, enlarge `VARCHAR` | **Rejected.** The length is still unbounded in N; this only delays the failure. |
| 2 | Truncate / hash the concatenated key | **Rejected.** Truncation can collide or lose meaning. A hash adds opacity and still depends on the previous key. |
| 3 | `'RECTIFY:' \|\| <root purchase id> \|\| ':v' \|\| version` | **Rejected.** No stored column identifies the chain root. The root would have to be parsed out of the previous version's key string (fragile, format-coupled) or stored in a new `root_purchase_id` column (new structure the design does not need). |
| 4 | **`'RECTIFY:' \|\| <predecessor purchase id> \|\| ':v' \|\| new_version`** | **Recommended.** See §5. |

## 5. Proposed decision (D1)

For versions created by `rectify_purchase`:

```
new idempotency_key = 'RECTIFY:' || p_purchase_id::TEXT || ':v' || new_version
```

- `p_purchase_id` is the version being rectified: the row already locked `FOR UPDATE`, whose immutable UUID is the stable identity available.
- The user's `p_idempotency_key` is used **only** for the initial purchase (`register_purchase`, unchanged).
- There is no recursion and no truncation, and nothing new is stored.

**Why the predecessor id is sufficient and unique:**

- A purchase row can be rectified **at most once**: after a successful rectification it is `is_current = false`, and any further call raises `PURCHASE_SUPERSEDED`.
- So each predecessor id produces exactly one successor key.
- Keys of different chains differ because the UUIDs differ.
- The `:v<version>` suffix keeps the version readable and costs nothing.

**Lineage stays traceable** from existing data:

- each version's key names its predecessor;
- the `RECTIFY` audit row records `new_id` (RPC 14 step 10);
- walking the keys backwards reaches version 0, whose key is the user's original.

### Required analysis

| Item | Result |
|---|---|
| **A. initial key of 100 characters** | Unaffected. The initial purchase keeps the user's key (≤ 100 by the schema). |
| **B. first rectification** | Key `RECTIFY:<36-char uuid>:v1` = **48** characters, whatever the initial key length. |
| **C. multiple rectifications** | Each version: `RECTIFY:<uuid of previous version>:v<n>`, which is 48 characters for n ≤ 9, 49 for n ≤ 99, and so on. Length depends only on `digits(n)`, not on history. |
| **D. maximum resulting length** | 8 (`RECTIFY:`) + 36 (UUID) + 2 (`:v`) + 10 (`version_seq` is INTEGER, max 2147483647) = **56** ≤ 100. Headroom 44. N-pass is bounded only by INTEGER, the same as `version_seq` itself. |
| **E. determinism** | The key is a pure function of (predecessor id, new version), both fixed by the locked row. There is no clock and no randomness, and a retried call after a rollback computes the identical key. |
| **F. concurrency** | Unchanged: `SELECT … FOR UPDATE` on the predecessor serialises rectifications. The second caller waits, sees `is_current = false` and raises `PURCHASE_SUPERSEDED` *before* computing any key (Phase 17 test AA4). Even hypothetically, a second insert of the same key would be refused by `UNIQUE idempotency_key`, so the loser would roll back entirely. Exactly one current version is preserved. |

**Invariant check (unchanged by D1):**

- **Economics and ledger:** the REVERSAL (−current) and PURCHASE (+new) rows at the original `economic_date` are untouched, and so is `supplier_ledger`.
- **Version state:** `is_current` and `version_seq` behave as before, and the retire-then-insert order is unchanged.
- **Carry-forwards:** invoice scoping, attachment carry-forward and allocation re-pointing are unaffected.
- **Only change:** the text of the technical key on rectified versions.

## 6. Proposed decision (D2) — reserved prefix

**Residual risk:** a user could call `register_purchase` with a key that happens to equal a future `RECTIFY:<uuid>:v<n>` key. The later rectification would then fail on UNIQUE and roll back. That is safe, since nothing is corrupted, but the purchase could not be rectified.

**Proposal:** `register_purchase` rejects `p_idempotency_key` values that start with `RECTIFY:`, raising a new error code `RESERVED_IDEMPOTENCY_KEY`. This reserves the namespace for system-generated keys.

This adds a validation and an error code to RPC 13, so it is a contract change and requires owner approval. The alternative is to accept the residual risk as documented: failure is safe, but a collision blocks that purchase's rectification.

## 7. Consequences

- **N-pass:** correct for arbitrary N, bounded by `version_seq` INTEGER.
- **No schema change:** `VARCHAR(100)` and UNIQUE stay as they are.
- **Existing keys:** rows keep their keys. Versions already rectified under the old rule keep their concatenated keys, and new rectifications use the new rule. In the local target database no production data exists.
- **Scope:** the transversal financial idempotency carry-forward is not affected.

## 8. Implementation plan (executed after approval)

1. **Amend the FROZEN documents** under ADR-002, marking each change **[ADR-002]**:
   - `RPC_CONTRACTS_V1.md` §14: the key expression. If D2 is approved, also §13: the reserved-prefix check and `RESERVED_IDEMPOTENCY_KEY`.
   - `DATABASE_INVARIANTS_V1.md` §16: note that version keys are bounded and derived from the predecessor id.
   - `POSTGRES_SCHEMA_SPEC_V1.md`: a note on `purchases.idempotency_key` semantics. No DDL change.
2. **Migration `0022_purchase_rectification_version_key.sql`:** `CREATE OR REPLACE FUNCTION rectify_purchase`, plus `register_purchase` if D2 is approved. The owner and EXECUTE perimeter stay unchanged. 0019–0021 are not edited.
3. **Tests in `purchases.test.mjs`:**
   - a 100-character initial key, rectified successfully;
   - ≥ 30 sequential passes with exactly one current version and the ledger telescoping;
   - every key ≤ 56 and matching `^RECTIFY:<uuid>:v\d+$`;
   - determinism, i.e. the key equals the expected function of the predecessor id and version;
   - the concurrent-rectification test still passing;
   - if D2 is approved, the reserved prefix rejected.
   - I6 (key chain) is updated to the new format.
4. **Regression and clean rebuild** of all suites, then update PHASE_17_PURCHASES_SUPPLIERS.md.

## 9. Owner decisions — APPROVED 2026-09-25

- **D1 — APPROVED:** rectified versions use `'RECTIFY:' || p_purchase_id::TEXT || ':v' || new_version`, where `p_purchase_id` is the locked current version being rectified. This replaces the recursive concatenation.
- **D2 — APPROVED:** `register_purchase` rejects any `p_idempotency_key` that starts exactly with the ASCII prefix `RECTIFY:` (case-sensitive) with `RESERVED_IDEMPOTENCY_KEY`.
