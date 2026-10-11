# ADR-018 — Production deploy plan V1 (PLAN ONLY — nothing executed)

**Status:** PROPOSED, 2026-10-11. Gate 0 CLOSED by the incremental runner (`scripts/target-db/apply-incremental.mjs`). Nothing in this document has been run against production.
**Scope:** ship ADR-018 (bank statement import, reconciliation and cut) to the production target. The plan has three layers: DB 0073–0077, then the Edge Function `fin-statement-import`, then the frontend.
**Out of scope:** G-3 (the real bank cuts), MP reports, V4, any real conciliation.

---

## A. Production baseline (captured 2026-10-11, read-only)

| Item | Evidence | Source |
|---|---|---|
| Target project | `granja-santo-tomas-v1`, ref `ycmkpnunhxluqqtecbyu`, `sa-east-1`, ACTIVE_HEALTHY, PG 17.11 | `supabase projects list` (management API, read-only) |
| Legacy projects | `AppGranja` `aplbsutpzgemexayldct` us-east-2 **ACTIVE_HEALTHY**; `Farm ERP` `shdrztqgwpyyxclgfpdg` INACTIVE | same |
| **CLI link** | `supabase/.temp/project-ref` = `shdrztqgwpyyxclgfpdg` (Farm ERP), **not** the target | file |
| Target Edge Functions | exactly `mp-webhook` v2 and `mp-worker` v2, ACTIVE, `verify_jwt=false`; **no `fin-statement-import`** | `supabase functions list --project-ref ycmkpnunhxluqqtecbyu` |
| `fin-statement-import` endpoint | `OPTIONS` → 404 (not deployed) | curl |
| `mp-webhook` unsigned POST | 401 (alive, refuses unsigned calls) | curl |
| Netlify site | `santotomasapp`, production branch `main`, published deploy `main@f0e64ae` (2026-10-04T23:51Z, state ready) | `netlify api getSite` (read-only) |
| Frontend → target | `VITE_SUPABASE_URL` (production) = `https://ycmkpnunhxluqqtecbyu.supabase.co`. The published bundle contains the target host once, no legacy host, no `service_role`, and no ADR-018 UI string. | `netlify env:get`, public bundle |
| Legacy Netlify MP function | GET `/.netlify/functions/webhook-mercadopago` returns the SPA fallback (`text/html`); POST returns 404, so the function is gone | curl |
| `origin/main` | `f0e64ae` (= the published deploy). The local `main` is stale (`04b1859`): never push it. | git |

**Not capturable from this session (needs the production DB password, owner shell only):**
- the ledger;
- the absence of `fin_*` objects and of the bucket;
- definers;
- `BNA` / `Patagonia` rows;
- cron / worker health;
- legacy freeze.

These are Gate 1, below.

---

## B. Commit range

**Baseline:** `f0e64ae`, which is `origin/main` and the published deploy. **Deploy:** `6d818c8` (HEAD of `post-cutover-fixes-20261004`). `f0e64ae` is an ancestor, so this is a fast-forward of 17 commits, all ADR-018.

| Layer | Commits | Files |
|---|---|---|
| 1. DB migrations | `06e691d` 0073 · `df48efb` 0074 · `2531f96` 0075 · `5a707aa` 0076 · `6d818c8` 0077 | `supabase/target-migrations/0073…0077` |
| 2. Edge / shared | `67a2b29` parser · `072cbe8` Edge + `config.toml` | `supabase/functions/_shared/bank-statement/**` (7), `supabase/functions/fin-statement-import/{handler,index}.ts`, `supabase/config.toml` (`[functions.fin-statement-import] verify_jwt = true`) |
| 3. Frontend | `7e6783d` import UI · `ee60cdc` reconciliation UI · `6d818c8` 0077 mapping | `src/features/caja/{CajaApp,ExtractosBancarios,Conciliacion,useBankStatements,useReconciliation}.tsx/ts`, `src/target/{bankStatements,bankReconciliation,db,messages}.ts` |
| 4. Docs / tests only | `2b9f9d1` `866ab35` `9c8d583` `8165fd6` `55ac00c` `bf1c1db` `35435c4` `d3383a3` (+ the test parts of the above) | `.planning/adr/ADR-018…`, `scripts/adr018/**`, `scripts/target-db/*.test.mjs`, `tests/**` |

**Never part of a deploy:**
- the dirty `.planning/PHASE_26_MIGRATION_REHEARSAL.md` and `supabase/.temp/cli-latest`;
- the ~41 pre-existing untracked files.

A push carries commits only, so it cannot include them. The Edge deploy reads files from the working tree, so it is done from a clean checkout of `6d818c8` (G-4).

Migration digests (sha256, first 12):

| Version | sha256 |
|---|---|
| 0071 | `c1758d8895ae` |
| 0072 | `b886fbfcf631` |
| 0073 | `f7d8c3ddc6c3` |
| 0074 | `f331debd7da2` |
| 0075 | `3cc2e2894d16` |
| 0076 | `6e7f7ece97ba` |
| 0077 | `e1f184987be2` |

---

## C. Deploy order (validated)

1. **DB 0073 → 0077.** The Edge Function calls `fin_import_bank_statement`, reads `fin_statement_account_config` / `fin_import_run`, and writes to the bucket created by 0074. The UI reads `fin_statement_line_status` (0076) and calls the 0075/0077 RPCs. Everything depends on the DB. All five files are additive:
   - new tables, view, functions, the bucket and one storage policy;
   - the only existing-object effects are FK references *from* the new tables and the storage policy, scoped by `bucket_id`.
   They are inert until called.
2. **Edge `fin-statement-import`.** It is only reachable by an ADMIN JWT; without a UI nobody calls it.
3. **Frontend.** This is the only layer that exposes the feature. It must not go out until DB and Edge pass their gates; otherwise the new screens would return 404 (Edge) or `relation does not exist` (DB).

This order means every intermediate state is safe. No user-visible change happens until Gate 6.

---

## D. Gate 0 — tooling (CLOSED: incremental runner)

The provisioning runner keeps its fresh-project protections unchanged. Its `preflight` / `apply` still refuse a populated target, and the E2E test proves it (NOT_FRESH). A **separate** runner applies an explicit range to an existing target:

`scripts/target-db/apply-incremental.mjs` — `--from 0072 --to 0077`.

| Guard | Behaviour |
|---|---|
| Connection | `MIGRATION_TARGET_DB_URL` from the owner's shell only. It becomes libpq env inside the client container, never argv or a log. The Supabase CLI link is never used, and `supabase link` is never run. |
| Project | `--production` requires:<br>• the connection's ref (`db.<ref>.supabase.co` or user `postgres.<ref>`) = `--expected-project-ref` = `--confirm-project`;<br>• `--forbidden-refs` (legacy) refused;<br>• a loopback host refused;<br>• `--confirm-from` / `--confirm-to` = `--from` / `--to`;<br>• `--migrations-dir` refused.<br>Without `--production`, only loopback is accepted. Every check runs before connecting. |
| Files | Same name pattern and the no-transaction-control rule as the existing runners. `--from` and `--to` must exist. **Any local file beyond `--to` aborts.** |
| Ledger | The whole `migration_ledger.applied` is read: every row must be a local file with the identical filename and sha256. The ledger must be **exactly** the files ≤ `--from` (apply) or exactly ≤ `--to` (no-op). An unknown remote version, a missing intermediate version, a different sha256 or a partial state all abort. |
| Pending | Exactly `--from < version ≤ --to`. The runner never applies "everything pending". |
| Lock | `pg_try_advisory_lock(hashtext('target_v1_migration_runner'))`, session-level: the same key `apply.mjs` / `provision-target.mjs` use, so no runner of any kind interleaves. A busy lock aborts (never waits); the dry-run takes it too. |
| Atomicity | One psql session: lock → ledger re-checked (no drift since the precheck) → per migration `BEGIN; SQL; ledger row; COMMIT`. A failure rolls back that migration with its ledger row; nothing later runs. |
| Timeouts | `lock_timeout` 5s, `statement_timeout` 120s, `idle_in_transaction_session_timeout` 60s (flags allow tightening). The 0073–0077 statements take milliseconds; their only waits are brief locks on `financial_account`, `perfiles`, `financial_operation`, `financial_posting` and `storage.objects`. A blocked lock fails instead of queueing production traffic. No session is terminated. |
| Dry-run | READ ONLY transaction: identity, ledger / sha, pending set and order; no SQL executed, nothing written. |
| Verify | `--verify-profile ADR018_POST_0077`, read-only:<br>• ledger 77;<br>• 6 tables and the view;<br>• the exact 73 application definers (+ the hosted `rls_auto_enable()`);<br>• no anon definer;<br>• the four functions' owner / EXECUTE matrix;<br>• the 0077 guard statements;<br>• exact table grants and RLS;<br>• the two configs equal to the 0074 literals (server-side set equality, nothing printed);<br>• the bucket and its single ADMIN SELECT policy.<br>`--deployment-check` adds the deployment-time **zero evidence** gate (not a schema invariant). |
| Output | Per migration `VERIFIED_APPLIED` / `PENDING` / `APPLYING` / `APPLIED` / `FAILED` with sha256[0..12]; starting / ending ledger, applied count, elapsed, result. Never a password, URL, token or bank identifier. |

Tests:
- `scripts/target-db/apply-incremental.test.mjs`: offline guards, no database.
- `scripts/target-db/apply-incremental.e2e.test.mjs`: a disposable project simulating production at 0072 with data.

## E. Gates

**Common setup (owner, WSL shell, repository root; secrets typed privately, never pasted into chat):**
```bash
export PGHOST=aws-0-sa-east-1.pooler.supabase.com PGPORT=5432 PGUSER=postgres.ycmkpnunhxluqqtecbyu PGDATABASE=postgres PGSSLMODE=require
read -rs PGPASSWORD && export PGPASSWORD
ro() { docker exec -i -e PGHOST -e PGPORT -e PGUSER -e PGPASSWORD -e PGDATABASE -e PGSSLMODE supabase_db_Claudio_app_Granja \
         psql -X -q -t -A -F' | ' -v ON_ERROR_STOP=1 -c 'SET default_transaction_read_only = on' -f - ; }
REF=ycmkpnunhxluqqtecbyu; LEGACY_REFS=aplbsutpzgemexayldct,shdrztqgwpyyxclgfpdg
# the incremental runner reads the same connection as one URL, built privately in this shell (never echoed):
export MIGRATION_TARGET_DB_URL="postgresql://$PGUSER:$(node -e 'process.stdout.write(encodeURIComponent(process.env.PGPASSWORD))')@$PGHOST:$PGPORT/$PGDATABASE?sslmode=require"
INC="node scripts/target-db/apply-incremental.mjs --from 0072 --to 0077 --client supabase_db_Claudio_app_Granja \
  --production --expected-project-ref $REF --forbidden-refs $LEGACY_REFS --confirm-project $REF --confirm-from 0072 --confirm-to 0077"
```

**Never** run `supabase link`, `supabase db push` or any `supabase` command without `--project-ref $REF`: the CLI is linked to `shdrztqgwpyyxclgfpdg`.

### GATE 1 — production baseline clean (read-only)
```sql
-- ro <<'SQL'
SELECT 'ledger', count(*), max(version) FROM migration_ledger.applied;
SELECT 'ledger_0072', left(sha256, 12) FROM migration_ledger.applied WHERE version = '0072';
SELECT 'fin_tables', count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'fin\_%';
SELECT 'fin_functions', count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'fin\_%';
SELECT 'fin_view', to_regclass('public.fin_statement_line_status') IS NULL;
SELECT 'bucket_absent', NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'financial-statements');
SELECT 'buckets', string_agg(id || ':' || public, ',' ORDER BY id) FROM storage.buckets;
SELECT 'definers_raw', count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosecdef;
SELECT 'storage_policies', count(*) FROM pg_policies WHERE schemaname = 'storage';
SELECT 'accounts', nombre, account_type, activo, count(*) OVER (PARTITION BY nombre) FROM financial_account WHERE nombre IN ('BNA', 'Patagonia');
SELECT 'cron', jobname, active FROM cron.job;
SELECT 'cron_24h', status, count(*) FROM cron.job_run_details WHERE start_time > now() - interval '24 hours' GROUP BY 2;
SELECT 'mp_deliveries_24h', status, count(*) FROM mp_webhook_delivery WHERE received_at > now() - interval '24 hours' GROUP BY 2;
SELECT 'mp_boundary_rows', count(*) FROM mp_cutover_boundary;
SELECT 'tz', current_setting('TimeZone');
-- SQL
```

**Expected:**
- `ledger` = 72 / `0072`, and `ledger_0072` = `b886fbfcf631` (the runner's dry-run verifies all 72 digests);
- `fin_tables` 0, `fin_functions` 0, `fin_view` t, `bucket_absent` t;
- buckets = `feria-worksheets:false, purchase-attachments:false`;
- `definers_raw` = 70: 69 application definers plus the hosted `rls_auto_enable()` (runbook S4);
- `storage_policies` = 6;
- exactly one `BNA` row and one `Patagonia` row, both `BANK_ACCOUNT`, `activo = t`, count 1 each;
- `mp_worker_every_minute` active; the 24 h cron runs `succeeded`;
- deliveries show no `FAILED_PERMANENT` growth;
- boundary = 1;
- TZ = UTC.

Also:
- **runner dry-run (mandatory):** `$INC --dry-run`. Expected:
  - 0001…0072 `VERIFIED_APPLIED`, every sha256 verified;
  - 0073…0077 `PENDING`, in the order 0073 → 0077;
  - `DRY-RUN OK`, no SQL executed.
  Any `LEDGER_*`, `FILES`, `PROJECT`, `CONFIRM` or `LOCK_BUSY` → STOP;
- `supabase functions list --project-ref $REF` returns exactly `mp-webhook` and `mp-worker`;
- `git fetch && git rev-parse origin/main` = `f0e64ae…`.

**STOP if:**
- the ledger is not 72 or the 0072 digest differs;
- any `fin_*` object or the bucket exists;
- `BNA` / `Patagonia` are missing, duplicated, not `BANK_ACCOUNT` or inactive — 0074's seed would then insert nothing or fail;
- cron or the worker is failing;
- `origin/main` moved.

**Rollback:** none (read-only).

**Legacy freeze (optional, owner):** a read-only `max(updated_at)` / row count on the legacy `AppGranja` business tables, compared with the post-cutover snapshot. The legacy project is still ACTIVE_HEALTHY; the owner decides whether to pause it. That is not part of this deploy.

**Backup (before Gate 2):**
- Confirm in the dashboard that today's daily backup / PITR exists for `$REF` (Database → Backups), and record its timestamp.
- Optional read-only schema evidence:
  ```bash
  docker exec -i -e PGHOST -e PGPORT -e PGUSER -e PGPASSWORD -e PGDATABASE -e PGSSLMODE supabase_db_Claudio_app_Granja pg_dump --schema-only -n public -n storage > ~/granja-private/adr018-pre-schema.sql
  ```
  The file goes outside the repository.

### GATE 2 — DB apply (owner GO)

Prerequisites:
- Gate 1 PASS, including the dry-run;
- the backup timestamp recorded;
- a low-traffic window.

```bash
$INC --dry-run                                                                     # repeat immediately before: still exactly 0072, 0073–0077 PENDING
$INC --verify-profile ADR018_POST_0077 --deployment-check                          # apply + read-only post-verify
```

**Expected:**
- `0073 … 0077  APPLIED`;
- `starting ledger: 72 · ending ledger: 77`;
- every profile line `OK`, including `DEPLOYMENT CHECK: zero evidence rows`;
- `RESULT: APPLIED 0072→0077`.

**STOP if:**
- **`LOCK_BUSY`:** another runner is active. Investigate; never force.
- **`FAILED` on a version:** that file and its ledger row were rolled back together; no later file ran. The output gives the error.
- **`lock_timeout`:** a production session held a conflicting lock. Retry later, never kill sessions.
- **`VERIFY` (schema already applied):** treat as Gate 3 failure (H-2).

After any STOP, do not retry blindly and do not edit files: a fix is a new migration. A rerun after a failure aborts with `LEDGER_STATE` (partial state) until the owner reviews it and chooses a new `--from`.

**Idempotent re-check:** running `$INC --verify-profile ADR018_POST_0077` again returns `RESULT: NO-OP` with the profile PASS.

**Rollback:** see H-1 / H-2.

**Timing:** a low-traffic window. The DDL takes brief locks on `financial_account`, `perfiles`, `financial_operation` and `financial_posting`, because the new FKs reference them, and on `storage.objects` for the new policy. `lock_timeout` 5s bounds every wait.

### GATE 3 — DB verification (read-only, immediately after Gate 2)

The runner's `ADR018_POST_0077` profile already ran in Gate 2. This manual read-only query is the independent second check (same expectations).
```sql
-- ro <<'SQL'
SELECT 'ledger', count(*), string_agg(version || ':' || left(sha256, 12), ',' ORDER BY version) FILTER (WHERE version >= '0073') FROM migration_ledger.applied;
SELECT 'tables', string_agg(table_name, ',' ORDER BY table_name) FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'fin\_%' AND table_type = 'BASE TABLE';
SELECT 'view', to_regclass('public.fin_statement_line_status') IS NOT NULL;
SELECT 'definers_app_fin', string_agg(p.oid::regprocedure::text || ':' || pg_get_userbyid(proowner), ',' ORDER BY 1) FROM pg_proc p WHERE pronamespace = 'public'::regnamespace AND prosecdef AND proname LIKE 'fin\_%';
SELECT 'definers_raw', count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosecdef;
SELECT 'exec', proname, has_function_privilege('anon', p.oid, 'EXECUTE'), has_function_privilege('authenticated', p.oid, 'EXECUTE'), has_function_privilege('service_role', p.oid, 'EXECUTE')
  FROM pg_proc p WHERE pronamespace = 'public'::regnamespace AND proname IN ('fin_import_bank_statement','fin_match_statement_line','fin_reverse_statement_match','fin_resolve_statement_cutover') ORDER BY 2;
SELECT 'guard_0077', proname, prosrc ~ 'RAISE EXCEPTION ''CUTOVER_ACTIVE_MATCH_CONFLICT', prosrc ~ 'FROM financial_account WHERE id = p_account_id FOR NO KEY UPDATE',
       prosrc ~ 'FROM financial_account WHERE id = v_line\.financial_account_id FOR SHARE'
  FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('fin_match_statement_line','fin_resolve_statement_cutover') ORDER BY 2;
SELECT 'grants', table_name, grantee, string_agg(privilege_type, '+' ORDER BY privilege_type) FROM information_schema.role_table_grants
  WHERE table_schema = 'public' AND (table_name LIKE 'fin\_%') AND grantee IN ('anon','authenticated','service_role') GROUP BY 2, 3 ORDER BY 2, 3;
SELECT 'rls', count(*) FILTER (WHERE NOT c.relrowsecurity) FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname LIKE 'fin\_%';
SELECT 'config_rows', count(*) FILTER (WHERE c.activo), string_agg(a.nombre || ':' || c.format_code, ',' ORDER BY a.nombre) FROM fin_statement_account_config c JOIN financial_account a ON a.id = c.financial_account_id;
SELECT 'config_digest', md5(string_agg(a.nombre || '|' || c.format_code || '|' || c.expected_account_number || '|' || c.expected_cbu || '|' || c.expected_extra::text, ';' ORDER BY a.nombre))
  FROM fin_statement_account_config c JOIN financial_account a ON a.id = c.financial_account_id WHERE c.activo;
SELECT 'bucket', id, public, file_size_limit, array_to_string(allowed_mime_types, ',') FROM storage.buckets WHERE id = 'financial-statements';
SELECT 'bucket_policies', policyname, cmd, roles::text FROM pg_policies WHERE schemaname = 'storage' AND qual ~ 'financial-statements';
SELECT 'storage_policies', count(*) FROM pg_policies WHERE schemaname = 'storage';
SELECT 'evidence_rows', (SELECT count(*) FROM fin_import_run), (SELECT count(*) FROM fin_statement_line), (SELECT count(*) FROM fin_statement_cutover), (SELECT count(*) FROM fin_statement_match);
-- SQL
```

**Expected:**
- **Ledger:** 77, with digests 0073 `f7d8c3ddc6c3`, 0074 `f331debd7da2`, 0075 `3cc2e2894d16`, 0076 `6e7f7ece97ba`, 0077 `e1f184987be2`.
- **Tables and view:** the 6 `fin_*` tables, and the view present.
- **Definers:**
  - the 4 `fin_*` functions are definers owned by `postgres`;
  - `definers_raw` = 74, i.e. 73 application definers plus `rls_auto_enable`.
- **EXECUTE grants:**
  - `fin_import_bank_statement`: anon f, authenticated f, service_role t;
  - the other three: anon f, authenticated t, service_role f.
- **0077 guard:** `guard_0077` shows f/f/t for match and t/t/f for resolve. The patterns match the exact statements, so comments do not count; the guard row is the evidence of 0077.
- **Table grants:**
  - authenticated: SELECT only, on all six and on the view `fin_statement_line_status`;
  - service_role: SELECT only, and only on `fin_import_run` and `fin_statement_account_config`;
  - anon: no row;
  - nobody has INSERT / UPDATE / DELETE.
- **RLS:** 0 tables without RLS.
- **Config:** `config_rows` 2 = `BNA:BNA_MONTHLY_PDF_V1`, `Patagonia:PATAGONIA_STATEMENT_PDF_V1`, and `config_digest` = `f539f337b683e9cd71ef776348db9fcf`. That digest is the K-1 approved values of 0074, computed on the local DB that ran the same migration, so a match means the exact values with none printed.
- **Bucket:** `financial-statements`, public f, 10485760, `application/pdf`. Exactly one bucket policy, `SELECT` for `authenticated` (ADMIN expression). `storage_policies` = 7.
- **Evidence rows:** 0 / 0 / 0 / 0.

**Policies and the view:** the ADMIN / OPERATOR / anon behaviour of the policies and of the view was proven by the `fin_statement*` suites (178 / 50 / 41). In production it is checked through the API at Gate 5 and Gate 7, with no business write.

**STOP if** any line differs.

**Rollback:** H-2. Leave the DB installed; it is inert. Fix forward.

### GATE 4 — Edge deploy (owner GO)

Run from a **clean checkout of `6d818c8`** (`git worktree add ../granja-deploy 6d818c8`), so no dirty or untracked file is bundled.

Local, before deploying:
```bash
deno check --node-modules-dir=none supabase/functions/fin-statement-import/index.ts
deno lint supabase/functions/fin-statement-import supabase/functions/_shared/bank-statement
deno test --node-modules-dir=none --allow-read scripts/adr018/bank-statement.test.ts scripts/adr018/fin-statement-import-handler.test.ts   # 37/0
grep -n '^verify_jwt' -B1 supabase/config.toml | grep -A1 'fin-statement-import'                                                         # verify_jwt = true
grep -n "npm:unpdf@1.8.1" supabase/functions/_shared/bank-statement/index.ts                                                             # exact pin
```

Deploy:
```bash
supabase functions deploy fin-statement-import --project-ref ycmkpnunhxluqqtecbyu      # NO --no-verify-jwt
supabase functions list --project-ref ycmkpnunhxluqqtecbyu                            # mp-webhook v2, mp-worker v2 unchanged; fin-statement-import verify_jwt=true
```

**Secrets:** none to set. The function reads only the platform-injected `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`. The existing `MP_*` / `WORKER_INVOKE_SECRET` secrets are untouched.

**STOP if:**
- the bundle fails, for example `npm:unpdf` resolution;
- `verify_jwt` is false;
- the `mp-*` versions changed.

**Rollback:** H-3.

### GATE 5 — Edge verification (no evidence written)

Decision: **option B** — no synthetic import in production. A synthetic import would create immutable rows and a stored object, plus a synthetic account and configuration. The smoke below proves deployment, configuration, gateway JWT, identity, role and the service-role reads, without reaching the Storage upload or the RPC.

```bash
F=https://ycmkpnunhxluqqtecbyu.supabase.co/functions/v1/fin-statement-import
read -rs ANON && export ANON          # public anon key
curl -s -o /dev/null -w '%{http_code}\n' -X OPTIONS $F                                              # 204
curl -s -o /dev/null -w '%{http_code}\n' -X POST $F -H "apikey: $ANON"                              # 401 (gateway: no JWT)
curl -s -X POST $F -H "apikey: $ANON" -H "authorization: Bearer $ANON" -F financial_account_id=x    # {"error":"NOT_AUTHENTICATED"} (function booted; 503 NOT_CONFIGURED = env missing → STOP)
# ADMIN session JWT (the owner logs in on the production site; copy the access token from the browser privately):
read -rs JWT && export JWT
curl -s -X POST $F -H "apikey: $ANON" -H "authorization: Bearer $JWT" -F financial_account_id=not-a-uuid -F file=@/dev/null   # {"error":"INVALID_ACCOUNT_ID"}
curl -s -X POST $F -H "apikey: $ANON" -H "authorization: Bearer $JWT" -H 'content-type: application/json' \
     -d '{"action":"reprocess","previous_run_id":"00000000-0000-4000-8000-000000000000"}'                                      # {"error":"RUN_NOT_FOUND"} (service-role read OK)
printf 'not a pdf' > /tmp/x.txt
curl -s -X POST $F -H "apikey: $ANON" -H "authorization: Bearer $JWT" -F financial_account_id=<BNA id from Gate 1> -F 'file=@/tmp/x.txt;type=application/pdf'   # {"error":"NOT_A_PDF"} (account+config read OK; nothing stored)
```

An OPERATOR JWT, if an operator can log in for the test, gives `{"error":"ADMIN_REQUIRED"}`.

Then confirm nothing was stored (`ro`):
```sql
SELECT (SELECT count(*) FROM fin_import_run), (SELECT count(*) FROM storage.objects WHERE bucket_id = 'financial-statements');   -- 0 | 0
```

**Logs:** dashboard → Edge Functions → `fin-statement-import` → Logs. Every line is `{"fn":"fin-statement-import","event":"refused",…}`, with no account number, CBU, JWT or bytes.

**STOP if:**
- any status differs from the expected one, especially a 503;
- any object or run exists.

**Rollback:** H-3.

### GATE 6 — Frontend deploy (owner GO; this is the push)
```bash
git fetch origin && test "$(git rev-parse origin/main)" = "$(git rev-parse f0e64ae)"     # main has not moved
git merge-base --is-ancestor origin/main 6d818c8                                          # fast-forward only
npm run build && node scripts/regression/phase27-frontend-static.check.mjs                # local gate (C-1 needs the local stack at 0077)
grep -rl "service_role\|SERVICE_ROLE" dist/ | wc -l                                        # 0
git push origin 6d818c8:refs/heads/main                                                   # Netlify builds main automatically
npx netlify api listSiteDeploys --data '{"site_id":"<site id>"}' | head                   # new deploy for 6d818c8 → state ready
```

**Before the push, record the currently published deploy id** (`main@f0e64ae`) for rollback.

**STOP if:**
- `origin/main` moved;
- it is not a fast-forward;
- the build or the static gate fails;
- `service_role` appears in `dist`.

**Rollback:** H-4.

### GATE 7 — Frontend verification (no PDF import)

On the production site:

**As ADMIN:**
- Caja → Extractos bancarios shows the **Importaciones** and **Conciliación** tabs.
- The account list shows exactly `BNA` and `Patagonia`.
- History: "Todavía no se importó ningún extracto".
- Conciliación → choose BNA: "Corte pendiente"; "No hay líneas con esos filtros".
- Console without errors.
- DevTools → Network: only `rest/v1/fin_statement_account_config`, `financial_account`, `fin_import_run`, `fin_statement_line_status`, `fin_statement_cutover`. No `rpc/fin_*` call unless an action is taken.

**As OPERATOR** (if available): no Caja module.

Public bundle (the deploy is verified from outside):
```bash
JS=$(curl -s https://santotomasapp.netlify.app/ | grep -o 'src="/assets/[^"]*\.js"' | head -1 | cut -d'"' -f2)
curl -s https://santotomasapp.netlify.app$JS | grep -c 'Extractos bancarios'   # ≥1
curl -s https://santotomasapp.netlify.app$JS | grep -c 'service_role'          # 0
curl -s https://santotomasapp.netlify.app$JS | grep -o 'ycmkpnunhxluqqtecbyu' | wc -l   # ≥1; no legacy host
```

**STOP if:**
- the UI errors;
- an OPERATOR sees the module;
- any RPC fires without an action.

**Rollback:** H-4.

---

## H. Rollback (by layer — evidence is never destroyed)

| # | Situation | Action |
|---|---|---|
| H-1 | A migration fails during Gate 2 | Automatic: that file's SQL and its ledger row are one transaction (`psql -1`) and roll back together. Earlier files stay applied and are inert. Stop; diagnose; fix with a **new** migration. Never edit an applied file: the checksum guard refuses it. |
| H-2 | DB applied, a later gate fails | Leave 0073–0077 installed. They are inert: no UI, no Edge, no cron, and nothing in the existing flows calls them. Do not drop objects. If a definer had to be disabled urgently, a forward migration can `REVOKE EXECUTE … FROM authenticated` on the 3 ADMIN RPCs. That is reversible and keeps the data. |
| H-3 | Edge deployed but faulty | `supabase functions delete fin-statement-import --project-ref $REF` (there is no previous version to roll back to). Deleting the function removes no evidence: Storage and DB stay. With the frontend not yet deployed, nobody can reach it. Redeploy after the fix. |
| H-4 | Frontend faulty | Netlify → Deploys → publish the recorded `main@f0e64ae` deploy (instant; or `netlify api restoreSiteDeploy`). Then revert on `main` only if the bug needs code: `git revert` the UI commits, never force-push. DB + Edge stay; without the UI they are unreachable. |
| H-5 | Critical problem after real imports | (1) frontend rollback first (H-4), which closes access; (2) if needed, delete the Edge Function (H-3) so no more uploads arrive; (3) keep `fin_*` tables, appearances, cuts, matches and the `financial-statements` objects. Bank evidence is never dropped or deleted. Fix forward. |

There is no "down migration" in this repository (immutable ledger), and none is proposed.

---

## I. Post-deploy verification summary

Gate 3 (DB), Gate 5 (Edge, no writes) and Gate 7 (UI, no imports). After Gate 7: 0 runs, 0 lines and 0 objects in production.

## J. Real-PDF smoke (separate; requires an additional owner GO)

After Gate 7, only with a new GO. **It creates real, permanent evidence.**

1. ADMIN uploads one known BNA PDF (local corpus, e.g. `SEP-26 BNA.pdf`, sha `1589dec6dc56…`). Expected: PARSED, rows_total 59, lines_new 52, ignored 7. These values were measured locally on 2026-10-11 with the same code.
2. Upload the same file again → replay: same run, 1 object, 52 lines.
3. One Patagonia PDF (e.g. `resumen (1).pdf`, sha `24d260ee2447…`). Expected: PARSED, rows_total 5, lines_new 2, ignored 3, with the TRANSFERENCIAS RECIBIDAS detail associated (date, original amount, NOMBRE ORIG).
4. Storage: objects at `bank/<account>/<sha>.pdf`, exactly one per file.
5. Fingerprints: compare the production `fin_statement_line.fingerprint` set with the local production-parser + reference fingerprints. The local helper writes them to a private file; only hashes are compared.
6. **No cut and no reconciliation** (G-3).

## K. G-3 status — NOT part of this deploy

**Deploying ADR-018 does not resolve G-3.** No `fin_statement_cutover` is created in production during or after the deploy without a separate owner decision.

| Account | Evidence | State |
|---|---|---|
| BNA | the SEP-26 statement closes at 738 024.01; the expected production opening balance is 335 713 | **OPEN**: an anchor needs statement evidence after 30/09 (the line whose running balance is exactly the opening balance, K-4). |
| Patagonia | the SEP-26 statement closes at 1 994 = the expected opening balance | **candidate exists**. Still to prove: no movement between that line and the bank cut. A lone-day anchor is required (ANCHOR_AMBIGUOUS_DAY). |

Until G-3 is closed, every production line is `CUTOVER_UNRESOLVED` and not reconcilable. That is safe and by design.

## L. Observability — first hours (no new automation)

| Signal | Where | Watch for |
|---|---|---|
| Edge errors | Dashboard → Edge Functions → `fin-statement-import` → Logs / Invocations | `event:error`, 5xx, 503 `NOT_CONFIGURED` |
| Refusals | same logs, `event:refused` with `code` | spikes of `ADMIN_REQUIRED` / `NOT_AUTHENTICATED` (abnormal auth), `ACCOUNT_NOT_FOUND_OR_NOT_BANK`, `STATEMENT_CONFIG_MISSING` |
| Rejected runs | `SELECT reject_reason, count(*) FROM fin_import_run WHERE status='REJECTED' GROUP BY 1` | unexpected `ACCOUNT_MISMATCH`, `FORMAT_NOT_RECOGNISED`, `REISSUE_SUSPECTED`, `DUPLICATE_CONTENT_IN_STATEMENT` on known-good files |
| Storage | Dashboard → Storage → `financial-statements`; API logs for 4xx/5xx on `storage/v1/object/financial-statements` | upload errors, objects without a run |
| RPC errors | Dashboard → Logs → PostgREST / Postgres, filter `fin_` | `MATCH_CONFLICT`, `CUTOVER_*`, `permission denied` |
| MP unchanged | `cron.job_run_details`, `mp_webhook_delivery` status counts (Gate 1 queries) | any change after the deploy (it must be none) |
| Frontend | Netlify deploy log; browser console during Gate 7 | build failures, runtime errors |

## M. GO / NO-GO checklist

| Gate | GO when | NO-GO / STOP | Rollback |
|---|---|---|---|
| 0 Tooling | CLOSED: `apply-incremental.mjs` + profile `ADR018_POST_0077`; offline and E2E tests green (commit of this tooling) | — | — |
| 1 Baseline | all Gate 1 expectations; backup timestamp recorded | any deviation | — |
| 2 DB apply | `$INC --verify-profile ADR018_POST_0077 --deployment-check` → APPLIED 0072→0077, profile all OK | LOCK_BUSY / FAILED / lock_timeout / VERIFY | H-1 |
| 3 DB verify | every Gate 3 line exact | any difference | H-2 |
| 4 Edge deploy | deployed, `verify_jwt=true`, `mp-*` unchanged | bundle / flag / version issue | H-3 |
| 5 Edge verify | 204 / 401 / NOT_AUTHENTICATED / INVALID_ACCOUNT_ID / RUN_NOT_FOUND / NOT_A_PDF; 0 runs, 0 objects | any other status; any write | H-3 |
| 6 Frontend deploy | FF push of `6d818c8`; Netlify deploy ready | main moved; non-FF; build / static gate / bundle check fails | H-4 |
| 7 Frontend verify | the UI as described; no console errors; OPERATOR without the module | any issue | H-4 |
| (J) Real smoke | separate owner GO | — | H-5 |

## N. Risks

1. **Runner for a non-fresh target** (Gate 0): resolved by `apply-incremental.mjs`, proven on a disposable project at 0072 with data. Residual risk: first use against hosted Postgres; mitigated by the mandatory dry-run and by `lock_timeout`.
2. **CLI linked to the inactive `Farm ERP` project.** Mitigation: `--project-ref` on every command; never `link` / `db push`.
3. **Stale local `main`** (`04b1859` vs `origin/main` `f0e64ae`). Mitigation: push `6d818c8:refs/heads/main` after the FF check; never push local `main`.
4. **Hosted Edge runtime differences:**
   - `npm:unpdf@1.8.1` bundling;
   - the injected `SUPABASE_ANON_KEY` (legacy JWT keys).
   Mitigation: Gate 5 detects both (bundle failure / 503) with no writes.
5. **First-call cold start.** A local fresh container returned 503 once on the first import (worker boot). Mitigation: Gate 5 warms the function; Gate J starts after it.
6. **0074 seed depends on exact account names.** Mitigation: Gate 1 accounts check plus the Gate 3 config digest.
7. **Legacy `AppGranja` still ACTIVE_HEALTHY.** Out of scope; the owner decides whether to pause it. The MP webhook and frontend already point at the target.
8. **Brief DDL locks** on FK-referenced tables during Gate 2. Mitigation: a low-traffic window.
9. **The real smoke creates permanent evidence.** Mitigation: a separate GO; no cut / no reconciliation until G-3.
