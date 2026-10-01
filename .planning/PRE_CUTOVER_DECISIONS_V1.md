# PRE-CUTOVER OWNER DECISIONS V1 (D-PC-1…6)

**STATUS:** owner decisions RECORDED 2026-10-01; the amendment in §3 is **PROPOSED, pending owner ratification**.
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

**Proposed amendment (to ratify):**
1. Phase 31 targets a new Supabase project.
2. The Phase 26 runner's cutover-mode target is that project.
3. G-1…G-6 must be closed by owner decisions or a runbook before Phase 31 executes.
4. G-2 (Auth) is blocking.

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
