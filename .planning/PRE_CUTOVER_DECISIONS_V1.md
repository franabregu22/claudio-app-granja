# PRE-CUTOVER OWNER DECISIONS V1 (D-PC-1…6)

**STATUS:** **ACCEPTED owner architecture.**
- D-PC-1…6 recorded 2026-10-01.
- The §3 amendment is **RATIFIED** (2026-10-01).
- D-PC-7…10 added (§6–§9).

Not complete: canonical validation, target project provisioning and cutover readiness all remain **pending execution / evidence**.
**Scope:** recording only. Nothing here was executed against production. No cutover, no deploy, Phase 28 not started.
**Related:** `PHASE_27_FRONTEND_INTEGRATION_PLAN.md` §9b / §9c, `MASTER_ROADMAP.md` (Phase 31 gate), `phase26-evidence/*`, `MIGRATION_STRATEGY_V1.md`.

---

## 1. Decisions

| Id | Decision |
|---|---|
| D-PC-1 | Windows Smart App Control is **not** disabled, weakened or bypassed. Canonical validation runs where the **official** Supabase CLI runs normally: preferably WSL2 / Linux on the same repository, otherwise an isolated Linux environment. Not allowed as substitutes: manual schema recreation, `docker run` replay, home-grown reset logic, copied database state. |
| D-PC-2 | The target V1 goes to a **NEW Supabase project**. It is never installed in place into the legacy production project. Target migrations 0001–0068 are **never** applied to the legacy project. |
| D-PC-3 | Conceptual cutover model (none of these steps is executed yet): 1. provision a clean target project; 2. apply the target migrations canonically from 0001; 3. validate the schema and invariants; 4. migrate business data through the approved Phase 26 process; 5. reconcile counts, balances and invariants; 6. configure the target secrets and services; 7. validate Auth / RLS / Storage / Edge / schedulers / MP; 8. build the current frontend; 9. switch the app environment to the new project; 10. deploy; 11. run production smoke checks; 12. keep the legacy project for a defined rollback period. |
| D-PC-4 | The legacy / target table-name collision (`mp_source_record`, `mp_financial_movement`, created by legacy `supabase/migrations/001–003`) is **resolved by architecture** (fresh project). Legacy tables are never renamed or dropped to make target migrations fit. **No operator may attempt an in-place migration.** |
| D-PC-5 | L-1: the legacy MP Netlify runtime stays **only until cutover**, with no new legacy path. It is removed in the same release boundary as the cutover (§4). L-1 stays OPEN until that removal is validated. |
| D-PC-6 | Feria stays **PARTIAL / DEFERRED**. The system is not CUTOVER_READY while Feria is partial, unless the owner later decides explicitly to launch V1 without target Feria. |

## 2. Architecture

- **Legacy Supabase project:** production and source of record until cutover. After cutover it is read-only (strategy §1 "hard cut"), kept for rollback / reference for a period the owner defines.
- **New target Supabase project:** a clean target schema from migrations 0001→; data loaded only by the approved migration process. It becomes the production authority after a successful cutover.
- **Rollback:** before the switch, the legacy project keeps serving. After the switch, rolling back means pointing the app back to the legacy project. Writes made in the target after the switch are not carried back (hard-cut rule). The rollback window and procedure are an owner decision (gap G-6).

## 3. Phase 26 compatibility with the fresh-project decision (PROPOSED AMENDMENT)

| Area | What the current documents say | Compatible? | Gap |
|---|---|---|---|
| Data migration | The Phase 26 runner reads a **restored legacy snapshot** (`granja-legacy-copy`, read-only, hashed manifest) and loads a **separate target** built from `target-migrations` (`MIGRATION_RUNNER_DESIGN_V1` §1). Source and target are always different databases. | **Yes**: the design is already a separate-target model; a fresh project fits it. | **G-1** The cutover target (the new project) is not yet named or provisioned, and `MIGRATION_REHEARSAL_CONFIG_V1.json` targets only the local stack. Cutover mode is disabled by design until Phase 31. |
| Auth users | `perfiles.id` must equal `auth.uid()` (strategy §9, never remapped). The runner writes rehearsal `auth.users` scaffold rows and says "**at cutover the real auth users exist**" (runner design §7.2), which assumes the users already live in the target project. | **No**: in a fresh project the real auth users do **not** exist. | **G-2 (blocking)** No method is defined to recreate the legacy Auth users (5 profiles) in the new project with the **same UUIDs**, their credentials / login method, and real emails (the B-5 email policy is `REAL` at cutover). Not invented here: it needs an owner decision. Options to evaluate, none chosen: Supabase-supported Auth user export / import that preserves ids; or new invitations, which would break the "keep id" rule and therefore need an ADR. |
| Storage | Purchase attachments: bucket `purchase-attachments` created by migration 0058; clean cutover migrates no historical purchases or attachments (strategy §5, attachments NEW). | **Yes** for the target bucket (created by migration). | **G-3** Confirm that no legacy Storage object must be carried over. None is listed in the clean-cutover scope; to be ratified. |
| Secrets / configuration | Edge Function secrets (`MP_WEBHOOK_SECRET`, `MP_COLLECTOR_ID`, the worker's invoke secret, MP access configuration) and the Vault entries `mp_worker_url` / `mp_worker_invoke_secret` (migration 0056) are environment configuration. | **Partially**: they are set per environment by design. | **G-4** There is no written cutover runbook listing every secret / Vault entry / env var for the new project, nor the frontend `VITE_SUPABASE_URL` / anon key switch. |
| Edge Functions / schedulers | Target functions `mp-webhook` and `mp-worker` (`supabase/functions`); scheduler `mp_worker_every_minute` (pg_cron, 0056, fail-closed until Vault is set). ADR-006 §11 gates: webhook URL switched with the legacy writer disabled in the same step. | **Yes**: deploy them to the new project. | **G-5** The deployment steps of the functions to the new project, and the MP webhook URL switch to the **new** project's function, are not written. The legacy `supabase/functions/sync-mercadopago` and `check-rate-limit` must be classified (target or legacy) before cutover. |
| Rollback | Strategy §1: hard cut, legacy read-only afterwards. | **Yes** | **G-6** Rollback window, criteria and procedure (switching back the env vars) are not defined. |

**Amendment — RATIFIED by the owner (2026-10-01):**
1. Phase 31 targets a new Supabase project.
2. The Phase 26 runner's cutover-mode target is that project.
3. G-1…G-6 must be closed by owner decisions or a runbook before Phase 31 executes.
4. G-2 (Auth) is resolved in principle by D-PC-7 (§6); it is closed only by the rehearsal evidence listed there.
5. G-3 is treated by D-PC-8 (§7), G-5 by D-PC-9 (§8) and G-6 by D-PC-10 (§9).

## 4. L-1: legacy MP Netlify runtime, kept until cutover (read from code; production not contacted)

| Function | Perimeter in code | Purpose |
|---|---|---|
| `webhook-mercadopago.ts` | MP `x-signature` HMAC-SHA256, `timingSafeEqual`; fails closed without secret | legacy webhook receiver (writes with the server Supabase key) |
| `sync-mercadopago-movements.ts` | `POST` only; `Authorization: Bearer` = `SYNC_MERCADOPAGO_TOKEN`, else 401 | legacy movements sync (service role key) |
| `sync-mercadopago-releases-status.ts` | `POST` only; same bearer check, else 401 | legacy releases status sync (service role key); imports `src/lib/mercadopago-calculations.ts` |
| `sync-mercadopago-releases.ts` | scheduled (`netlify.toml`, `0 2 * * *`); calls MP with the MP token and the status function with the sync token; writes only if `MP_SYNC_WRITE_ENABLED` | legacy nightly sync |
| `compare-mercadopago.ts` | **no authentication** in code; reads with the public anon key (RLS-bound) | legacy comparison report |
| `upload-settlement-csv.ts` | **no authentication** in code; `POST` only; parses the CSV body | legacy settlement CSV parsing |
| `lib/mp-release-identity.ts` | helper | legacy |

**Removal at cutover, in the same release:**
- the 6 functions above and `lib/mp-release-identity.ts`;
- the `[[scheduled_functions]] sync-mercadopago-releases` entry and the legacy `functions` entry in `netlify.toml`;
- `src/lib/mercadopago-calculations.ts` and `tests/mercadopago-calculations.test.mjs`;
- `scripts/consolidate-mp-duplicates.mjs`, `scripts/repair-mp-balance-cache.mjs`, `scripts/verify-mp-api.mjs`;
- `.netlify/functions-serve`;
- `supabase/functions/sync-mercadopago` (and `check-rate-limit`) once classified as legacy (G-5).

The two unauthenticated functions are noted for the owner. They remain OPEN under L-1 until cutover.

## 5. Canonical validation environment (D-PC-1)

**Host state (2026-10-01, read-only checks):**
- WSL2 is present, but the only distribution is `docker-desktop`: Docker Desktop's internal distribution, not a general-purpose environment;
- no Ubuntu / Linux distribution is installed;
- Docker Desktop 29.8.0 runs (WSL2 backend);
- the Windows Supabase CLI is blocked by Smart App Control;
- the repository is at `C:\Users\Franabregu\Desktop\Claudio app Granja`, reachable from WSL as `/mnt/c/Users/Franabregu/Desktop/Claudio app Granja`.

**Minimum owner steps (interactive; not done by Claude):**
1. `wsl --install -d Ubuntu` (PowerShell as administrator), then create the Linux user.
2. Docker Desktop → Settings → Resources → WSL Integration → enable **Ubuntu**.
3. In Ubuntu: install Node.js 20+ and the official Supabase CLI (the CLI's own documented Linux install), then `supabase --version`.
4. Stop the Windows-side local stack before starting it from Linux: same project id and ports, so one stack at a time.
5. Make sure no `MP_ACCESS_TOKEN` is exported in the Linux shell (the suites refuse it).

**Exact canonical validation sequence (local only, from the repository root in Ubuntu):**
```bash
supabase start                                    # full stack, including storage (config.toml [storage] enabled)
supabase status                                   # expect db, auth, rest, storage, edge runtime, kong
export TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
node scripts/test-env/reset-recreate-proof.mjs    # canonical `supabase db reset` (legacy migrations disabled in config.toml) — proves reset
node scripts/target-db/apply.mjs                  # 0001 → 0068; ledger must hold 68, each sha256 = file
node scripts/regression/clean-cutover-current-target.mjs   # CT-1…CT-5 (guarded reset + all migrations + historical load)
supabase db reset && node scripts/target-db/apply.mjs      # clean again before the suites
for f in scripts/target-db/*.test.mjs; do node "$f"; done   # ALL suites in series, incl. mp_audit_security, mp_scheduler, mp_webhook, mp_worker_http
node scripts/regression/adr006-matrix.test.mjs   # incl. X-7
node scripts/regression/adr006-frontend-contract.check.mjs
node scripts/regression/phase27-frontend-static.check.mjs
npm test && npm run test:integration             # Storage tests un-skip when /storage/v1 answers (f27d-storage, f27d-treasury Nueva compra with file)
for i in 1 2 3; do npm run test:integration; done   # stability reruns (JWT first-request, MP parallel)
npx tsc -b && node scripts/regression/phase27-safe-build.mjs
# only when everything above is green: regenerate dist (npm run build) and scan it
```

- **Expected services:** db, auth, rest (PostgREST), storage, edge runtime, kong, plus realtime / studio as configured.
- **Tests this enables:**
  - the canonical reset;
  - ADR-008 Storage API (upload / read / delete, MIME, > 10 MB, signed URL, no public URL) and "Nueva compra" with a real file;
  - `mp_audit_security`, `mp_scheduler`, `mp_webhook`, `mp_worker_http`;
  - ADR-006 X-7.

  Mercado Pago real is never called: the suites use local fixtures only.

---

## 6. D-PC-7: Auth migration to the fresh target project (ACCEPTED)

**Decision:**
- The production Auth users are moved by an **Auth DATA migration** with Supabase's supported project-to-project mechanism.
- **Not allowed:** `auth.admin.createUser` for production users, new UUIDs, or changing `perfiles.id`.
- **Preserved:** `auth.users` ids, identities, password hashes, confirmation state, and the Auth rows these users need to authenticate.

**Official basis** (Supabase docs, read 2026-10-01: "Migrating auth users between projects"; "Backup and restore using the CLI"):
- Auth users move by migrating Auth schema data, from a dashboard backup or a CLI SQL export / import (`pg_dump` / `supabase db dump` + `psql`).
- User IDs and hashed passwords are preserved, so users do not reset their passwords.
- If the JWT secrets differ, existing tokens become invalid and users must log in again.
- The data restore runs with `SET session_replication_role = replica`, so triggers do not fire.
- Supabase provides no ready-made "auth only" script: the exact command is **fixed during the rehearsal**, against the official CLI help, never from memory.

**JWT / sessions (hard-cut security boundary, accepted):**
- The target project keeps **its own** JWT signing configuration. The legacy secret is not reused.
- Legacy access and refresh sessions are invalid after cutover, and every user logs in again on the target. Passwords keep working.
- Session-bearing Auth rows (`auth.sessions`, `auth.refresh_tokens`, and any one-time / flow-state tokens) are **not** carried over. This keeps an old browser refresh token from being exchanged against the new project. The exact excluded table list is fixed in the rehearsal against the target Auth version.

**Scope found (no production contact; nothing printed):**
- **Profiles:** the Phase 26 snapshot (`20260926T150949Z`) contains **no Auth data**. It holds 26 `public` tables only, with `perfiles` = 5 rows (4 `dueño` → ADMIN, 1 `colaborador` → OPERATOR). The expected migrated users are therefore at least those 5 ids.
- **Login methods in code** (legacy `main` and the target frontend): **email + password only** (`signInWithPassword`). No OAuth, magic link, OTP, phone or MFA call exists in the code.
- **Auth metadata:** not application-significant. No code reads `user_metadata` / `app_metadata`. The legacy trigger `handle_new_user` (on legacy `auth.users`) created a `perfiles` row on sign-up. The target has no such trigger, by design.
- **Narrow additional export required** before the rehearsal (owner-run, read-only, legacy project), returning **counts only**: `auth.users` rows, rows per `auth.identities.provider`, unconfirmed users, MFA factors, and users without a `perfiles` row. The decision on any extra users (not in `perfiles`) is the owner's.

**Mechanical ordering** (target schema inspected 2026-10-01):
- the target has **no trigger** on `auth.users` (0) or `auth.identities` (0);
- **no public FK** references `auth.users` (`perfiles.id` is a plain UUID PK by the frozen spec, 0003);
- so Auth data and `perfiles` do not constrain each other's order. The order chosen:

1. Provision the fresh target project.
2. Apply `target-migrations` 0001 → 0068 canonically. Ledger = files, each sha256 = file.
3. Restore the **Auth data only** (users, identities and the rows needed to authenticate; sessions / refresh tokens excluded) with `session_replication_role = replica`, in one transaction.
4. Run the Phase 26 runner in **cutover mode**: `perfiles` and business data from the approved snapshot process. It must **not** write `auth.users` scaffold rows in cutover mode (runner change, below).
5. Verify:
   - every `perfiles.id` has an `auth.users.id`;
   - every intended V1 auth user has a `perfiles` row;
   - zero `@example.invalid` emails.
6. Verify the role mapping (`current_app_role()` per user: 4 ADMIN, 1 OPERATOR, or the owner's final list).
7. Each intended V1 user signs in against the target project (email + password).
8. Hard cut: legacy sessions are ignored and the app is pointed only at the target.

**Phase 26 changes required (to implement before Phase 31; not done now):**
- the runner's cutover mode must skip the rehearsal `auth.users` scaffold and instead **verify** that the migrated Auth users exist (fail closed otherwise);
- the config email policy is `REAL`, with emails coming from the migrated Auth users;
- a rehearsal of step 3 on a local or staging stack with a copy of legacy Auth data (handled as sensitive; never committed).

**Unresolved:**
- the exact dump / restore command and excluded Auth tables (fixed in the rehearsal);
- the counts export above;
- any Auth version mismatch between the legacy and the new project (rehearsal evidence).

## 7. D-PC-8: legacy Storage content

**Classification: D (cannot determine without a production inventory), with strong evidence toward B.**
- **Legacy code** (`main`, `src/api/caja.ts` `subirFactura`) uploaded invoices to a **public** bucket `facturas` and stored the public URL in `movimientos_caja.url_factura`. A Drive link was used for eCheq receipts.
- **Snapshot** `20260926T150949Z`: in `movimientos_caja` (800 rows), **0** values reference `/storage/v1/object/public/facturas/` and 0 reference Drive. No business row points to a Storage object. The legacy schema has no `storage.*` objects (the dump excludes the `storage` schema).
- **Clean cutover:** `movimientos_caja` is **evidence only**, and no historical purchase or attachment is migrated. If any objects exist in the legacy `facturas` bucket, they are **not migrated** (class B) and stay in the legacy project for its retention period.
- **To close D:** an owner-run, read-only inventory of the legacy buckets (names, object counts, public flag), counts only. The target `purchase-attachments` bucket stays new (migration 0058); no historical attachment is invented.

## 8. D-PC-9: Edge Functions and target services

| Function | Class | Evidence |
|---|---|---|
| `supabase/functions/sync-mercadopago` | **LEGACY, REMOVE AT CUTOVER** | writes `mercadopago_raw` (a legacy table absent from the target); no reference from the target frontend; the static gate forbids `sync-mercadopago` in `src` |
| `supabase/functions/check-rate-limit` | **LEGACY, REMOVE AT CUTOVER** | writes `login_attempts` (absent from the target); its frontend use was removed in F27-A (`04b1859`); no reference in `src`. After removal, login brute-force protection relies on Supabase Auth's built-in rate limits (owner awareness). |

**Target services the fresh project requires:**
- **Edge Functions:**
  - `mp-webhook` and `mp-worker` (`config.toml`: `verify_jwt = false` for both, by ADR-006 design).
  - Secret names (values never in the repository):
    - `mp-webhook`: `MP_WEBHOOK_SECRET`, `MP_COLLECTOR_ID`, `WORKER_INVOKE_SECRET`, plus the platform-provided `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`;
    - `mp-worker`: `MP_ACCESS_TOKEN`, `MP_API_BASE_URL`, `MP_COLLECTOR_ID`, `WORKER_INVOKE_SECRET`, plus the platform-provided values.
- **Scheduler:** pg_cron job `mp_worker_every_minute` (migration 0056). It is created by the migration and stays fail-closed until Vault is set.
- **Vault:** `mp_worker_url` (the new project's mp-worker endpoint) and `mp_worker_invoke_secret` (= `WORKER_INVOKE_SECRET`).
- **Storage:** bucket `purchase-attachments` (0058).
- **Frontend environment:** the new project's URL and anon key (build-time `VITE_*`).
- **MP:** the webhook URL is switched to the new project's `mp-webhook` with the legacy writer disabled in the same step (ADR-006 §11).

## 9. D-PC-10: rollback model (PROPOSED runbook, not effective)

| Case | When | Procedure | Data |
|---|---|---|---|
| A. Pre-cutover abort | before the app environment is switched | stop; the legacy project keeps serving untouched; the target project is discarded or kept for a new rehearsal | no loss: legacy was never written by the target |
| B. Immediate post-cutover rollback | after the switch, **before meaningful target writes** (smoke checks only, operations not yet registered) | repoint the app environment to the legacy project and redeploy; re-enable the legacy MP writer / webhook URL; users log in to legacy again (their legacy passwords are unchanged) | lossless only if the target writes are none or test-only; check the target write log before declaring it lossless |
| C. Rollback after target writes | target business writes exist (orders, collections, purchases, MP receipts…) | repointing the environment variables is **not** lossless. There is **no** reverse synchronization from target to legacy. It requires an explicit **data reconciliation**: export the target writes after the switch, owner review, and manual re-entry or a purpose-built migration into legacy | reconciliation **required**; not claimed lossless |

**Proposed stabilization window (for owner approval; not effective):**
- the legacy project stays intact and read-only for **at least 30 days** after cutover;
- the **B-window** (rollback by repointing) closes at the first day-end after cutover, or at the first real business write, whichever comes first;
- after that, only case C applies.

**Owner decisions still required:** the window length, the B-window close criterion, and who authorizes a rollback.

## 10. Canonical validation in WSL

**Status:** waiting for the owner to install Ubuntu and enable the Docker Desktop WSL integration (§5). After the owner confirms:
1. prepare Node.js (official LTS supported by the repository) and the official Supabase CLI inside Ubuntu;
2. confirm the Windows-started local stack is stopped (one stack per project / ports);
3. confirm `MP_ACCESS_TOKEN` is absent from the Linux environment;
4. run the §5 sequence.

## Status update — 2026-10-01

D-PC-6 resolved: Feria was redesigned (ADR-016) and the owner accepted it manually (**FERIA MANUAL ACCEPTANCE: PASS**). "Gastos de Feria" is INDIRECT for V1. With the final MP suite rerun green (`mp_worker_http` 17/0, `mp_scheduler` 33/0), the pre-cutover status is **CUTOVER_READY**. The meaning and the remaining Phase 31 execution items are listed in PHASE_27 §10.7. Production has not been touched.
