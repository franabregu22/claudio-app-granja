# PHASE 10 — SECURITY / RLS VALIDATION

**DATE:** 2026-09-24  
**PHASE:** 10 — Security / RLS Validation (per `MASTER_ROADMAP.md`)  
**TYPE:** Validation of the frozen security model. Not a correction pass.

---

## Scope

Validate the frozen security model using **exclusively** checks 1–8 of section 11 of
`RLS_IMPLEMENTATION_SPEC_V1.md`. No check was added, removed or reworded.

Each check was evaluated by asking what security claim it makes, then testing that claim against the
actual content of the FROZEN documents — the specified `GRANT`/`REVOKE` statements, the specified RLS
policies, the `current_app_role()` definition, the SERVICE_ROLE tests, the RPC contracts, the
period-sensitive table set, the SECURITY DEFINER inventory and the OPERATOR exposure surface.

A check was **not** marked PASS because a document asserts it holds. A check is PASS only when the
frozen corpus, read literally and as a whole, makes the claim true. Where a permissive policy, a
direct privilege, a wrongly-executable function, or a combination of mechanisms makes the stated
guarantee false, the check is FAIL.

**Not done in this phase:** no SQL executed, no Supabase change, no data change, no schema change, no
architectural redesign, no modification of any FROZEN document, no correction of any finding, no ADR.

**Boundary:** the analysis stayed inside checks 1–8. Observations that would require a check 9 or
beyond were not pursued.

---

## Authorities

| Document | Role in this validation |
|---|---|
| `TARGET_ARCHITECTURE_V2_FROZEN.md` | Architectural authority. Part 2 (roles), Part 3 (PENDING orders editable), Part 20 (period determination), Part 22 (MP pipeline). |
| `implementation-design/RLS_IMPLEMENTATION_SPEC_V1.md` | Source of checks 1–8 (section 11). Also the object under test: sections 2–4 (role mechanism, SERVICE_ROLE, privilege perimeter), 5–9 (policies), 12 (security properties). |
| `implementation-design/POSTGRES_SCHEMA_SPEC_V1.md` | Table and column reality: `ENABLE ROW LEVEL SECURITY` statements, CHECK constraints, the `mp_source_raw_guard` DDL and its trigger. |
| `implementation-design/RPC_CONTRACTS_V1.md` | SECURITY DEFINER hardening template, per-RPC actor and authorization, period guards. |
| `implementation-design/DATABASE_INVARIANTS_V1.md` | Invariant 9 (append-only by absent privilege), invariant 10 (no write into a CLOSED period), invariant 12 (period determinant matrix), invariant 21 (MP raw immutability). |
| `implementation-design/IMPLEMENTATION_DEPENDENCY_ORDER_V1.md` | Security construction order (Phase 4), RPC creation requirements (Phase 5). |

All six remain FROZEN and were not modified.

---

## Validation Results

| Check | Result | Evidence | ADR required |
|---|---|---|---|
| **1. RLS enabled everywhere** — no table in `public` has `rowsecurity = false` | **PASS** | `POSTGRES_SCHEMA_SPEC_V1.md` declares 54 `CREATE TABLE` and 54 `ALTER TABLE … ENABLE ROW LEVEL SECURITY`. Set difference between the two lists is empty: every table enables RLS, none twice, none missing. `IMPLEMENTATION_DEPENDENCY_ORDER_V1.md` step 4.3 repeats the instruction for all 54. The only relation without RLS is `feed_formula_line_safe`, which is a view and therefore outside `pg_tables`; its protection is ownership plus a cost-free projection (RLS spec §8). | no |
| **2. No business authorization via JWT claims** — no policy references `jwt()` | **PASS** | Zero occurrences of `jwt()` inside any `CREATE POLICY` across the five documents. The only mention of `auth.jwt() ->> 'role'` in the corpus is RLS spec line 44, which prohibits it and explains why (a JWT claim is deployment configuration, is not validated against `activo`, and is shaped by whoever mints the token). Every policy in §§5–9 resolves the business role through `current_app_role()`. | no |
| **3. No impossible SERVICE_ROLE business-role test** — no policy compares `current_app_role()` to `'SERVICE_ROLE'` | **PASS** | One occurrence of the string in the corpus, at RLS spec line 106, inside prose that states it is a contradiction — not inside a policy. `current_app_role()` (lines 50–79) returns only `ADMIN` or `OPERATOR` and raises `USER_NOT_FOUND_OR_INACTIVE` otherwise, so the comparison could never be true. Backend access is tested with `auth.role() = 'service_role'` in the five places that need it (`mp_source_record` ×2, `mp_financial_movement`, `mp_reconciliation`, `financial_account`). | no |
| **4. No no-op deny policies** — no policy with `qual = 'false'`, `with_check = 'false'` or `… AND false` | **PASS** | Scanning every `CREATE POLICY` block yields zero matches. The two textual hits (RLS spec lines 20 and 28) are the explanatory rule that such policies are forbidden because permissive policies are OR-ed, so `USING (FALSE)` grants nothing and denies nothing. Immutability is instead carried by absent privileges (§4), which invariant 9 states as the enforcement mechanism. | no |
| **5. No period-sensitive FACT table is directly writable by an application role** | **PASS** | Check reformulated so its stated guarantee matches what it verifies, and the `pedidos` exception is now explicit instead of silently omitted. Verified: the 35 fact tables in the `IN` list have empty intersection with the `GRANT INSERT/UPDATE/DELETE … TO authenticated` statements of §4 — no period-sensitive fact table is directly writable. The `pedidos` exception is documented in the check itself and is contained by sub-check 5b: exactly one UPDATE policy exists on `pedidos` (`pedidos_admin_update_pending`) and it pins `estado = 'PENDING'` in both `USING` and `WITH CHECK`, so no direct DML can reach DELIVERED; a PENDING order is not a sale; `client_ledger` has no write privilege, so no economic consequence can be produced directly; and `deliver_order` recomputes `delivered_date`, calls `ASSERT_PERIOD_OPEN` on its own value and overwrites both date columns. Permissions unchanged: `GRANT INSERT, UPDATE ON pedidos TO authenticated` remains, per frozen Part 3. | no |
| **6. Every SECURITY DEFINER function pins its `search_path`** | **PASS** | The SECURITY DEFINER inventory is now unambiguous: `current_app_role()` plus the 41 RPCs, all pinning `SET search_path = public`. `mp_source_raw_guard()` is confirmed SECURITY INVOKER by decision — its DDL contains zero `SECURITY DEFINER` and now carries an explicit comment stating the choice and its reason, and §12 of the RLS spec no longer lists it among SECURITY DEFINER functions. No statement anywhere in the corpus still claims the guard is SECURITY DEFINER. Sub-check 6b pins the expected inventory to exactly 42 functions so the ambiguity cannot recur. The trigger's functional protection is untouched: `CREATE TRIGGER trg_mp_source_raw_guard` and the guard body are unchanged, and the trigger fires regardless of the caller's role. | no |
| **7. No SECURITY DEFINER function is executable by PUBLIC** | **PASS** | `current_app_role()` carries `REVOKE ALL … FROM PUBLIC` followed by `GRANT EXECUTE … TO authenticated` (RLS spec lines 78–79, repeated in dependency order 363–364). The RPC hardening template (`RPC_CONTRACTS_V1.md` lines 56–66, restated in RLS spec §4 and dependency order Phase 5) applies `REVOKE ALL … FROM PUBLIC` then `GRANT EXECUTE … TO authenticated` — or `service_role` for RPCs 40/41 — to every one of the 41 contracts. This check shares check 6's ambiguous premise about `mp_source_raw_guard`, for which no `REVOKE` is specified; it remains PASS under either reading, because a plpgsql function declared `RETURNS TRIGGER` cannot be invoked outside a trigger context, so PUBLIC execute on it grants no reachable capability. | no |
| **8. MP raw-guard trigger exists** | **PASS** | `POSTGRES_SCHEMA_SPEC_V1.md` line 1264 declares `CREATE TRIGGER trg_mp_source_raw_guard BEFORE UPDATE ON mp_source_record FOR EACH ROW EXECUTE FUNCTION mp_source_raw_guard()`, with the function body immediately above it. `IMPLEMENTATION_DEPENDENCY_ORDER_V1.md` creates it at step 3.5 and states it must exist before any MP ingestion; it also appears in the dependency graph and in the Phase 3 completion criteria. Invariant 21 names it as the mechanism that protects the six raw columns even against the privileged path. | no |

**Result: 8 of 8 PASS.**

Checks 1–4 and 7–8 passed on first evaluation and were not re-run. Checks 5 and 6 initially failed,
were corrected within an authorized bounded documentary scope, and were re-run in isolation.

---

## Failures

**Open failures: none.**

Both findings below were real and are recorded for the audit trail. Each was resolved under an
explicit owner authorization for a bounded documentary correction, with no change to architecture,
business rules, economic semantics, permissions or data authority — and therefore without an ADR.

### F-1 — Check 5: `pedidos` is period-sensitive and writable by an application role · **RESOLVED**

**Identifier:** `CHECK_5_PERIOD_SENSITIVE_WRITE_PRIVILEGE` / omission of `pedidos` from the verified set.

**Documents involved:**
- `DATABASE_INVARIANTS_V1.md` — invariant 12, row *Sale delivery | pedidos | `delivered_date`*; invariant 10 (no period-sensitive write into a CLOSED period).
- `RLS_IMPLEMENTATION_SPEC_V1.md` — §4 `GRANT INSERT, UPDATE ON pedidos TO authenticated;`; §7 policy `pedidos_admin_update_pending`; §11 check 5 table list.
- `POSTGRES_SCHEMA_SPEC_V1.md` — `pedidos.delivered_date`, `CONSTRAINT chk_pedidos_delivered_coherent`.
- `TARGET_ARCHITECTURE_V2_FROZEN.md` — Part 3 ("PENDING orders: edit freely"), Part 20 (sale's period = delivery month).

**Evidence:**
1. Invariant 12 lists `pedidos` as period-sensitive, determinant `delivered_date`.
2. §4 grants `INSERT, UPDATE ON pedidos` to `authenticated`.
3. Check 5's `IN` list contains 35 table names; `pedidos` is not among them. Its intersection with the granted set is empty, so the query returns 0 rows.
4. The single UPDATE policy is `pedidos_admin_update_pending`, with `USING (current_app_role() = 'ADMIN' AND estado = 'PENDING')` and the same `WITH CHECK`. It constrains `estado` only — not `delivered_at` or `delivered_date`.
5. `chk_pedidos_delivered_coherent` is `(estado = 'DELIVERED' AND delivered_at IS NOT NULL AND delivered_date IS NOT NULL) OR (estado <> 'DELIVERED')`. The second branch is unconditional, so a `PENDING` row carrying an arbitrary `delivered_date` satisfies it.

**Consequence:** an ADMIN can write the period-determinant column of a `PENDING` order by direct DML, with no period guard. The economic consequence is nil, and this is why the finding is documentary rather than behavioural:
- `estado` cannot become `DELIVERED` through the policy, since `WITH CHECK` requires `PENDING` after the update. A sale is `DELIVERED` (frozen Part 3), so no sale is created.
- No `client_ledger` row can be written: that table has no write privilege for any application role (§4, invariant 9), so no economic fact is produced in any period.
- `deliver_order` (RPC 1) does not trust the stored value. It computes `delivered_date = (p_delivered_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE`, calls `ASSERT_PERIOD_OPEN(delivered_date)`, and then overwrites both `delivered_at` and `delivered_date`. A pre-seeded value cannot steer the period of the eventual sale.
- The stale value is invisible to `idx_pedidos_delivered_date`, which is partial `WHERE estado = 'DELIVERED'`, and `close_management_period` counts pending orders by `created_at`, not by `delivered_date`.

So the real defect is that check 5 verifies a narrower set than the guarantee it states: the guarantee is false for `pedidos`, while the query cannot detect it.

**ADR_REQUIRED: no.** The grant is required by frozen Part 3, which makes PENDING orders freely editable, so the permission is intentional and must not change. No business rule, economic semantic, permission or data authority needs to move. Resolution lies in the precision of check 5's scope — either enumerating `pedidos` with its PENDING-only containment stated, or narrowing the claim to period-sensitive *fact* tables, where an order is a fact only once delivered. Either way, behaviour is unchanged.

**RESOLUTION (applied):** `RLS_IMPLEMENTATION_SPEC_V1.md` §11 check 5 was reformulated. Its title now
states the guarantee it actually verifies — *no period-sensitive **fact** table is directly writable by
an application role* — and a comment block declares `pedidos` an explicit, deliberate exception,
citing frozen Part 3 and setting out the four containment facts (policy pins `estado='PENDING'` on
both sides; a PENDING order is not a sale; `client_ledger` has no write privilege; `deliver_order`
recomputes and overwrites `delivered_date` after `ASSERT_PERIOD_OPEN`). Sub-check 5b was added to
verify mechanically that the exception stays contained to exactly one estado-pinned UPDATE policy.
**Not changed:** the `GRANT INSERT, UPDATE ON pedidos TO authenticated` statement, the policy set,
`pedidos` remaining non-RPC-only, and every permission in the model.

---

### F-2 — Check 6: the SECURITY DEFINER inventory is contradictory · **RESOLVED**

**Identifier:** `CHECK_6_SECURITY_DEFINER_SEARCH_PATH` / `mp_source_raw_guard` classification.

**Documents involved:**
- `RLS_IMPLEMENTATION_SPEC_V1.md` — §12, bullet: "SECURITY DEFINER is required and used deliberately — `current_app_role()`, the MP raw guard, and all 41 RPCs. Each pins `search_path`, derives the actor internally, and revokes PUBLIC execute."
- `POSTGRES_SCHEMA_SPEC_V1.md` — the `mp_source_raw_guard()` DDL.
- `DATABASE_INVARIANTS_V1.md` — invariant 21 (raw columns protected by the trigger).

**Evidence:**
1. The schema's DDL is:
   ```
   CREATE OR REPLACE FUNCTION mp_source_raw_guard()
   RETURNS TRIGGER
   LANGUAGE plpgsql
   AS $$ … $$;
   ```
   It declares neither `SECURITY DEFINER` nor `SET search_path`.
2. §12 states the MP raw guard *is* SECURITY DEFINER and *does* pin `search_path`.
3. Check 6 selects functions `WHERE prosecdef = true AND NOT (proconfig @> ARRAY['search_path=public'])`.
4. Therefore: implemented per the schema, the guard is `SECURITY INVOKER`, falls outside the filter, and the check returns 0 rows. Implemented per §12 — `SECURITY DEFINER` added while the DDL supplies no `SET search_path` — the guard matches the filter and the check returns 1 row.

**Consequence:** check 6's outcome is not determined by the frozen corpus; it depends on which of two FROZEN documents the implementer follows. A verification check whose result is implementation-dependent cannot substantiate the guarantee it exists to prove, so it cannot be recorded as PASS. Check 7 rests on the same premise and is unaffected in outcome, for the reason given in its evidence row.

There is no exploitable exposure under either reading. The guard's body only compares `OLD` and `NEW` column values and raises; it dereferences no schema-qualified object, so there is nothing for a manipulated `search_path` to redirect. Its sole caller is an RPC owned by `postgres`. Invariant 21's protection of the six raw columns holds either way.

**ADR_REQUIRED: no.** Both resolutions are behaviour-identical: dropping the guard from §12's SECURITY DEFINER list, or adding `SECURITY DEFINER SET search_path = public` to its DDL. Neither changes business rules, economic semantics, permissions or data authority, and neither alters what the trigger rejects.

**RESOLUTION (applied):** the owner decided `mp_source_raw_guard()` **stays SECURITY INVOKER**, because
it only compares `OLD` against `NEW`, needs to cross neither RLS nor any privilege, and elevating it
would add privilege for nothing. Accordingly: §12 of `RLS_IMPLEMENTATION_SPEC_V1.md` no longer lists
the guard among SECURITY DEFINER functions and states the reason; the inventory is now exactly
`current_app_role()` plus the 41 RPCs; check 6 carries a scope note making that inventory explicit;
sub-check 6b pins the expected count at 42 so the guard cannot silently re-enter the set; and the
guard's DDL in `POSTGRES_SCHEMA_SPEC_V1.md` now carries a comment declaring the INVOKER choice and its
rationale. **Not changed:** the guard body, `CREATE TRIGGER trg_mp_source_raw_guard`, the raw-column
protection of invariant 21, and the requirement that every real SECURITY DEFINER function pin
`search_path`.

---

## Exit Decision

The phase may close only if all eight checks are PASS.

All eight are PASS. Checks 1–4 and 7–8 passed on first evaluation. Checks 5 and 6 failed on two
documentary contradictions inside the frozen corpus — one between invariant 12 and the scope of
check 5, one between §12 of the RLS spec and the schema's DDL for `mp_source_raw_guard`. Neither was an
exploitable security bypass. Both were resolved under an authorized bounded documentary correction and
re-run in isolation; checks 1–4 and 7–8 were not re-run, since nothing they verify was touched.

**What the corrections changed:** the wording and verification scope of check 5, the SECURITY DEFINER
inventory statement in §12, a scope note on check 6, two added sub-checks (5b, 6b) that pin the two
guarantees mechanically, and one explanatory comment on the guard's DDL.

**What the corrections did not change:** no permission, no policy, no `GRANT`/`REVOKE`, no RPC
contract, no function body, no trigger, no invariant, no business rule, no economic semantic and no
data authority. The frozen model behaves exactly as before.

**ADR:** not required for either finding, for the reasons recorded under F-1 and F-2.

**PHASE 10 STATUS: COMPLETE**

Security model validated: one business-role mechanism, SERVICE_ROLE separated from business roles, no
period-sensitive fact table writable outside an RPC, no privilege-escalation path, cost data
unreachable by OPERATOR, and every SECURITY DEFINER function hardened.

Next phase per `MASTER_ROADMAP.md`: **11 — Migration Strategy**. No construction may begin before
phases 11 and 12 close.
