# ADR-006 IMPLEMENTATION NOTES

**Status:** LIVE. Implementation traceability for ADR-006. It records where the implemented mechanism differs from the wording of an accepted design document, and the owner decisions taken during implementation.

It is **not** a design authority. The accepted ADR-006 design documents are not rewritten; where a note applies, it says why the business or security rule is unchanged.

---

## N-1 — R4: the direct-insert boundary on `mp_source_record` (Step 9, migration 0054)

**Design wording.** ADR006_RLS_AND_SECURITY_V1 §2 (R4) and ADR006_TEST_MATRIX_V1 (N-9, B4, D7) express the restriction as RLS: the narrowed policy `mp_source_service_insert` lets `service_role` insert only the report source types `csv_import` and `account_money_csv`, so a direct `api_payment` / `api_refund` insert is "denied by RLS".

**Platform fact.** On Supabase, `service_role` has `BYPASSRLS`, so no RLS policy can restrict it.

**Implementation (0054):**
- The narrowed policy is kept exactly as designed. It remains the declared rule and serves as defence in depth.
- The effective enforcement is the SECURITY INVOKER trigger `trg_mp_source_insert_guard` (function `mp_source_insert_guard`, owner-only EXECUTE). It rejects a direct insert by `service_role`, `authenticated` or `anon` of any `source_type` other than `csv_import` / `account_money_csv`.
- **Contractual error:** `SOURCE_TYPE_NOT_INSERTABLE`.
- SECURITY DEFINER RPCs such as S4 `mp_ingest_api_snapshot` run as the owner, so they are unaffected.

**Unchanged.** The business and security rule is the same: API sources are created only by the definer RPCs, and report rows only by the narrowed insert. Permissions, scope and accounting do not change, and no frozen document is reopened.

**Evidence:** `mp.test.mjs` B4 / D7; `mp_privileges.test.mjs` S-4d / S-4f; `mp_audit_security.test.mjs` P-4.

---

## N-2 — pg_net platform grants (Step 11, migration 0056) — OWNER DECISION: accepted residual risk

**Platform fact.** Installing `pg_net` runs Supabase's event trigger `grant_pg_net_access` as `supabase_admin`, which grants:
- EXECUTE on `net.http_get` / `net.http_post` to `anon`, `authenticated` and `service_role`;
- USAGE on schema `net` to the same roles.

Those grants belong to `supabase_admin`, and the project's migration role (`postgres`) cannot revoke them. 0056 does not try to, and it grants nothing itself.

**Owner decision (2026-09-29).** The owner accepts these grants as a **residual platform risk**, **conditional on the current perimeter**:
- the grants are made by `supabase_admin`, not by this project;
- Step 11 adds no grant of its own;
- `net` and `cron` are not exposed by PostgREST (exposed schemas: `public`, `graphql_public`);
- no `public` function wraps `net`, `cron` or `vault`;
- `anon`, `authenticated` and `service_role` cannot schedule cron jobs (no USAGE on schema `cron`);
- Vault is not exposed to `anon` or `authenticated`;
- the SECURITY DEFINER set stays exactly 60.

**Revalidation trigger.** The risk must be re-assessed if `net` (or `cron` / `vault`) is ever exposed through the API, if a `public` wrapper around them appears, or if any of the conditions above stops holding.

**Evidence:** `mp_scheduler.test.mjs` P-1…P-9; `mp_audit_security.test.mjs` P-5 / P-6.
