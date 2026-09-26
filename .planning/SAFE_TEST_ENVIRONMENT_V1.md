# SAFE TEST ENVIRONMENT V1

**PHASE:** 12 — Safe Test Environment (per `MASTER_ROADMAP.md`)  
**STATUS:** **COMPLETE.** Backup/restore and reset/recreate were executed and verified in the local test environment.  
**PRODUCTION:** not touched. No SQL executed against it, no migration pushed, no data read or written, no environment variable changed, no remote command run.

This document records what was **actually executed**. Where something was prepared but not run, it says so.

---

## 1. Environment chosen

**Supabase local via the Supabase CLI (roadmap option A) — running.**

| | |
|---|---|
| Runtime | Supabase CLI `supabase start`, 12 containers under Docker Desktop |
| Postgres | PostgreSQL **17.6**, container `supabase_db_Claudio_app_Granja` |
| Connection | `postgresql://postgres:postgres@127.0.0.1:54322/postgres` |
| Supabase roles present | `anon`, `authenticated`, `service_role` — verified, count = 3 |
| Schemas present | `auth` and `storage` — verified, count = 2 |
| `public` baseline | 0 tables |
| Docker | 29.8.0, WSL2 backend, x86_64, overlayfs |
| CLI | 2.115.0 (not upgraded, per instruction) |

**Why option A and not a bare PostgreSQL.** The frozen model is not engine-generic: `current_app_role()` resolves the business role from `auth.uid()`, every RLS policy calls it, the MP policies test `auth.role() = 'service_role'`, and the privilege perimeter grants and revokes on `anon` / `authenticated` / `service_role`. The running environment reproduces all of that — the three roles and both schemas were verified present above. A bare PostgreSQL would need that hand-built, and a hand-built auth layer is what passes in test and fails in production.

**No cloud project was created.** The existing cloud project was never contacted.

---

## 2. Isolation proof

Isolation rests on facts, not on names. The guard ignores naming entirely.

| # | Fact | Evidence |
|---|---|---|
| 1 | The connection target is loopback on the CLI's own port | `postgresql://***@127.0.0.1:54322/postgres`, proven by the guard before every operation |
| 2 | The container maps Postgres to port 54322, matching the guarded target | `docker port supabase_db_… 5432/tcp` → `…:54322`; each proof script re-checks this mapping against the guarded port and aborts on mismatch |
| 3 | Production is cloud-only | `.env.local` points at an `*.supabase.co` host; the guard refuses every `supabase.co` / `pooler.supabase.*` host outright |
| 4 | Every reset reported acting locally | The CLI's own output: `{"target":"local","version":"","message":"Reset local database."}` — and the scripts fail if the output mentions a linked or remote project |
| 5 | The cloud link was never used | `supabase/.temp/project-ref` present and byte-identical throughout; `git status` shows 0 changes under `supabase/.temp/` |

### Correction to the previous revision

The earlier draft of this section claimed the endpoint is *"not routable off the machine"*. **That was wrong** and is corrected here.

Docker Desktop publishes the port as `0.0.0.0:54322`, not `127.0.0.1:54322`, so the test database **is reachable from the local network**. This was subsequently confirmed by execution, not merely inferred — see finding **F-12-2**, which also records that the exposure permits superuser authentication.

It does not weaken isolation *from production* — that rests on facts 3, 4 and 5, which concern a different host entirely — but the original wording overstated the containment and is retracted. The guard checks the **connection URL host**, which is loopback; it never checked the publish address, and it still does not.

---

## 3. Existing tooling discovered

| Capability | Present | Detail |
|---|---|---|
| Docker | **yes** | 29.8.0. Installed **per-user**: `%LOCALAPPDATA%\Programs\DockerDesktop\resources\bin\docker.exe`, therefore **not on the PATH of a fresh shell** and not under `Program Files`. Both proof scripts resolve it explicitly |
| WSL2 | **yes** | default distribution `docker-desktop`, version 2 |
| Supabase CLI | **yes** | 2.115.0, an npm global install |
| Supabase CLI real binary | **yes** | `%APPDATA%\npm\node_modules\supabase\node_modules\@supabase\cli-windows-x64\bin\supabase.exe`. The `supabase` and `supabase.cmd` shims cannot be spawned by Node without `shell: true`, which matters — see §5 |
| `pg_dump` / `psql` on Windows | **no** | Not installed, and not needed: both run inside the `supabase_db` container |
| `supabase/config.toml` | **created this phase** | `supabase init`; `[db] port = 54322` |
| Migrations in repo | 12 files, all MercadoPago | Contains duplicate version prefixes — finding **F-12-1** |
| Backup / restore / reset scripts | **created this phase** | `backup-restore-proof.mjs`, `reset-recreate-proof.mjs` |
| `.env.test` | ignored | added to `.gitignore` this phase, verified with `git check-ignore` |

---

## 4. Secrets and environment handling

No secret value appears in this document or in any script created by this phase. Only variable *names* were read.

| File | Tracked by git | Contents (names only) |
|---|---|---|
| `.env.example` | yes, correctly — a template | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` |
| `.env.local` | **no** — `.gitignore` line 14 | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_GOOGLE_CLIENT_ID`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ACCOUNT_ID`, `LOG_LEVEL` |
| `.env.test` | **no** — `.gitignore` line 15, added this phase | not created yet; the local stack's keys belong here when needed |

Verified:
- `git ls-files | grep .env` → only `.env.example`. **No credential is versioned.**
- `git check-ignore -v .env.test` → `.gitignore:15`, and a probe file was invisible to `git status`. The probe was deleted.
- `.env.local` was **not read for values, not modified, and not used by any operation**. `git status` shows 0 changes.
- Every destructive run was executed with `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ACCESS_TOKEN` and `SUPABASE_DB_PASSWORD` explicitly unset, which the guard requires.
- The backup artifact kept as evidence was scanned for JWT, `sb_secret`, `APP_USR-` and service-role patterns: **0 matches**.

The local stack prints its own dev keys on startup. Those are the standard Supabase local values, identical on every install, and they are deliberately **not reproduced here**.

---

## 5. Destructive-operation guardrails

### Mechanism

`scripts/test-env/guard.mjs` is the gate every destructive operation passes. It is fail-closed: an operation runs only if locality can be positively proven, and no flag disables it.

| Layer | Applies to | Refuses when |
|---|---|---|
| **1 — Target URL** | direct-URL operations | host not loopback · port not `54322` · database not `postgres` · host matches `supabase.co` / `pooler.supabase.*` · no explicit port · protocol not `postgres(ql)://` · unparseable · **nothing supplied** (there is no default) |
| **2 — Credentials** | everything | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ACCESS_TOKEN` or `SUPABASE_DB_PASSWORD` present and non-empty |
| **3 — CLI argv** | CLI-mediated operations | argv contains `--linked`, `--db-url`, `--project-ref`, `--project-id` (in either `--flag value` or `--flag=value` form, case-insensitively), or the subcommand `push`, `pull`, `link`, `remote` |
| **4 — Remote link** | callers that cannot otherwise prove locality | `supabase/.temp/project-ref` exists |

Port `5432` is refused even on loopback: it is the default of any Postgres, including one port-forwarded to production, so it cannot be proven to be the test instance.

### Change made this phase, stated plainly

The previous revision refused **every** destructive operation while `supabase/.temp/project-ref` existed. That check was **over-broad**: it conflated *"a link exists in the repository"* with *"this command follows the link"*. Those are different things.

- `pg_dump` and `psql` read the connection string they are handed and never read `supabase/.temp/`. For them a link contributes no risk, so refusing on it is a false positive.
- `supabase db reset` acts on the **local** database. Only `--linked`, `--db-url` or `--project-ref` makes a CLI command remote.

So layer 3 was added, inspecting argv directly, and the blanket link refusal was scoped to layer 4. **This is stronger, not weaker, for the actual threat**: the original check never looked at argv at all, so it would have permitted `supabase db reset --linked` the moment the repository was unlinked. Layer 3 refuses that regardless of link state. Layer 4 is retained and still refuses when a caller cannot prove locality any other way.

The link was **not** removed, per instruction. Nothing in this phase depended on removing it.

### Executed proof

```
$ node scripts/test-env/guard.test.mjs
── Layer 1: target URL validation ──────────────────────────────
  OK ALLOW  local supabase (legitimate)      :: postgresql://***@127.0.0.1:54322/postgres
  OK ALLOW  localhost:54322
  OK ALLOW  loopback IPv6
  OK REFUSE CLOUD production-shaped          :: The target is a Supabase CLOUD host.
  OK REFUSE CLOUD db.* host                  :: The target is a Supabase CLOUD host.
  OK REFUSE CLOUD pooler                     :: The target is a Supabase CLOUD host.
  OK REFUSE loopback port 5432 (tunnel risk) :: The target port is not the local Supabase Postgres port.
  OK REFUSE LAN host                         :: The target host is not loopback.
  OK REFUSE disallowed db name               :: The target database name is not allowed.
  OK REFUSE no explicit port                 :: The target has no explicit port.
  OK REFUSE non-postgres protocol            :: Unsupported protocol "mysql:".
  OK REFUSE unparseable string · empty (no default fallback) · undefined
── Layer 2: production credential detection ────────────────────
  OK ALLOW  clean environment
  OK REFUSE SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ACCESS_TOKEN / SUPABASE_DB_PASSWORD present
  OK ALLOW  each of the three as an empty string (blank treated as absent)
── Layer 3: CLI argv locality (what actually selects remote) ───
  OK ALLOW  db reset (local by default) · db reset --debug
  OK REFUSE db reset --linked                :: remote selector "--linked"
  OK REFUSE db reset --db-url  (and --db-url= form)
  OK REFUSE db push · db pull · link
  OK REFUSE db reset --project-ref           :: remote selector "--project-ref"
  OK REFUSE db reset --PROJECT-REF           :: uppercase still caught
  OK REFUSE argv not an array
── Layer 4: remote link detection (still available) ────────────
  OK ALLOW  link presence is reported        :: hasActiveRemoteLink() = true
  OK REFUSE strict link assertion still refuses while linked
── Secret leakage ─────────────────────────────────────────────
  OK no credential material appears in refusal output

  RESULT: 35 correct, 0 incorrect      exit=0
```

Re-run after both proofs: still **35/35**.

---

## 6. Legacy schema snapshot

Resolves **G-1** of `MIGRATION_STRATEGY_V1.md`: the operational legacy DDL is not versioned — only the 12 MercadoPago migrations are.

**Procedure created, NOT executed:** `scripts/test-env/legacy-schema-snapshot.mjs`.

| Property | Design |
|---|---|
| Read-only | `pg_dump --schema-only` issues catalog SELECTs only |
| No data | `--schema-only`; the script prints the `grep -cE "^(INSERT\|COPY) "` check to confirm zero data lines |
| No credentials in output | `--no-owner --no-privileges` |
| Scope | `--schema=public`; `auth` and `storage` are Supabase-managed |
| Target | requires `LEGACY_READONLY_DATABASE_URL` and **refuses loopback**, since snapshotting the empty local instance would be a false success |
| Output | `.planning/legacy-schema/legacy-schema-<UTC>.sql` |

**Why still not executed.** It targets production, and the phase rules forbid that without an authenticated, provably read-only connection. There is none: no read-only database credential exists, and `.env.local` holds an API service-role key rather than a database password. Blocked on **P-4**, not on tooling. Now that Docker is present, `pg_dump` is available inside the container if needed.

---

## 7. Data profiling

**Tooling created, NOT executed:** `scripts/test-env/profiling/legacy-profile.sql`.

Read-only verified mechanically: **58 `SELECT`/`WITH` statements, zero** occurrences of `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `TRUNCATE`, `CREATE TABLE`, `CREATE INDEX`, `GRANT`, `REVOKE`, `COPY … TO` or `SELECT … INTO` in effective code.

Sections 0–13 cover the table inventory and row counts (G-1, G-2), window coverage from 2026-01-01, enum-like distributions (G-9, G-10, G-11, G-14), null rates on target-mandatory columns (G-6, G-8), free-text references (G-7, G-8), duplicate candidate keys, orphan references across nine relationships, **OD-1 evidence** (daily mortality summed between physical counts vs `mortandad_esperada`, and derived population vs `aves_contadas`), **OD-2 evidence** (computable in-window position per client and the count with pre-window activity), **OD-3 evidence** (open instruments with `girador` and exact-match flags), order-line shapes (G-12), **G-4 evidence** (expenses by nature with category completeness), `facturas` structure (G-3), and MP coverage.

It reports distributions and decides nothing. **Not executed** for the same reason as §6: blocked on **P-4**.

---

## 8. Backup / restore proof

**EXECUTED AND VERIFIED.** Script: `scripts/test-env/backup-restore-proof.mjs`. Every step ran against the guarded local target; `pg_dump` and `psql` ran inside the stack's own container, so no global PostgreSQL install was needed.

```
── 1. Guard the target
   guard: note — a CLI link exists, but this is a direct-URL operation, which cannot follow it.
   guard: target proven local test → postgresql://***@127.0.0.1:54322/postgres
── 2. Resolve the local stack container
   container: supabase_db_Claudio_app_Granja
   port mapping confirms the guarded target: 5432/tcp -> …:54322
── 3. Create fixture and insert canary rows
   rows: 5   checksum: f6b2f68d6e9662fc9d11b6cae5bc3062
     1 canary-alpha 100.00 original
     2 canary-bravo 250.50 original
     3 canary-charlie 999.99 original
     4 canary-delta -42.25 original
     5 canary-echo 0.01 original
── 4. Take a real backup (pg_dump inside the container)
   dump written: /tmp/phase12_backup.sql   size: 1849 bytes
   dump references the fixture 9 times
   copied to host: .\.planning\phase12-evidence\phase12_backup.sql
── 5. Mutate the data destructively
   rows now: 3 (was 5)   checksum now: 6cb8977751fac8518163adf60f42f4df
     1 canary-alpha 0.00 TAMPERED
     3 canary-charlie 0.00 TAMPERED
     5 canary-echo 0.01 original
   mutation confirmed: both count and checksum differ from the original
── 6. Restore the backup
   psql applied the dump with ON_ERROR_STOP=1 and exited 0
── 7. Verify the canary data came back exactly
   rows: 5 (expected 5)
   checksum: f6b2f68d6e9662fc9d11b6cae5bc3062
   expected: f6b2f68d6e9662fc9d11b6cae5bc3062
     1 canary-alpha 100.00 original
     2 canary-bravo 250.50 original
     3 canary-charlie 999.99 original
     4 canary-delta -42.25 original
     5 canary-echo 0.01 original
   row count matches, checksum matches, content matches, zero tampered rows
── 8. Re-assert the target and drop the fixture
   target was: postgresql://***@127.0.0.1:54322/postgres
   fixture tables remaining: 0

  BACKUP / RESTORE PROOF: PASS      exit=0
```

What makes this a proof rather than a demonstration:

- The mutation is **verified to have changed something** before the restore runs. If count and checksum had not both moved, the script aborts — otherwise a restore that did nothing would look like success.
- Recovery is checked four ways: row count, an `md5` checksum over the ordered concatenation of every column, full row-by-row content equality, and an explicit count of surviving `TAMPERED` rows.
- The dump is confirmed to actually contain the fixture (9 references) before it is relied on.
- The container's port mapping is re-checked against the guarded port, so the container being operated on is the one that was proven.

Evidence kept: `.planning/phase12-evidence/phase12_backup.sql`, 1 849 bytes, 9 fixture references, **0 secret-pattern matches**. The fixture was dropped; `public` is back to 0 tables.

---

## 9. Reset / recreate proof

**EXECUTED AND VERIFIED, twice.** Script: `scripts/test-env/reset-recreate-proof.mjs`.

Locality here is proven by **argv**, not by a connection string, because `supabase db reset` is CLI-mediated and argv is what selects local versus remote.

```
── 1. Guard the target and the command
   guard: target proven local test → postgresql://***@127.0.0.1:54322/postgres
   guard: cli argv proven local-only → supabase db reset
── 3. Record the baseline before any reset
   baseline: public tables=0 auth+storage schemas=2 supabase roles=3 pg=17.6
   endpoint still 127.0.0.1:54322 (mapping: 0.0.0.0:54322)

── Cycle 1 ──
   marker table present=1 rows=3
   guard: cli argv proven local-only → supabase db reset
     {"target":"local","version":"","message":"Reset local database."}
     Resetting local database... Recreating database... Initialising schema...
     Seeding globals from roles.sql...
   marker table after reset: 0 (expected 0)
   after reset: public tables=0 auth+storage schemas=2 supabase roles=3 pg=17.6
   baseline matches on every dimension
   endpoint still 127.0.0.1:54322

── Cycle 2 ── identical: marker created (3 rows) → reset → marker gone → baseline matches

── Confirm no remote project was involved
   supabase/.temp/project-ref still present and untouched: true
   every reset ran as `supabase db reset` with no --linked / --db-url / --project-ref

  RESET / RECREATE PROOF: PASS (2 cycles)      exit=0
```

What makes this a proof:

- A **marker table with rows** is created before each reset and verified present. If it were missing, the reset would prove nothing, and the script aborts.
- Destruction is verified by the marker being **gone** afterwards.
- Return to a known state is verified on four dimensions — `public` table count, `auth`+`storage` schema count, Supabase role count, server version — and any drift fails the proof.
- The CLI's own output states `"target":"local"`, and the script fails if the output mentions a linked or remote project.
- The endpoint is re-verified after every cycle.
- Two cycles, so the disposability is repeatable rather than a one-off.

**No target table was built.** `public` holds 0 tables. Phase 13 has not started.

---

## 10. Pending external prerequisites

| # | Prerequisite | Status |
|---|---|---|
| P-1 | Container runtime | **RESOLVED** — Docker Desktop 29.8.0 with WSL2, installed per-user by the owner |
| P-2 | PostgreSQL client tools | **RESOLVED differently** — not installed on Windows and not needed; `pg_dump` and `psql` run inside the `supabase_db` container |
| P-3 | `supabase unlink`, or confirm the link may stay | **OPEN, and no longer blocking.** The link is untouched. Guard layer 3 makes it safe by inspecting argv, so local work proceeds while linked. Still an owner decision before any intentional remote operation |
| P-4 | A **read-only** database role plus `LEGACY_READONLY_DATABASE_URL` | **OPEN.** Blocks execution of §6 and §7 only. Must not be the application service-role credential |
| P-5 | `.env.test` in `.gitignore` | **RESOLVED** — added and verified with `git check-ignore` |

### Findings raised by execution

**F-12-1 — duplicate migration version prefixes (owner decision).**
`supabase/migrations/` contains two files numbered `009` and two numbered `010`:

```
009_fix_raw_only_counting.sql        010_add_fingerprint_column.sql
009_reconciliation_v3_2_final.sql    010_fix_import_v2_classifications.sql
```

The CLI derives the version from the leading digits, so applying them fails:

```
ERROR: duplicate key value violates unique constraint "schema_migrations_pkey"
Key (version)=(009) already exists.
```

This aborted the first `supabase start` and would equally abort any `db reset` or `db push` with migrations enabled.

*Handled locally, not fixed:* `[db.migrations] enabled = false` in `supabase/config.toml`, with the reason written in the file. This is local-only configuration and affects no remote. Renaming the files would desynchronise migration history with the linked cloud project, which is why it is an **owner decision** rather than a local repair. It does not hold Phase 12 back: the legacy MP migrations are not part of the target schema — `MIGRATION_STRATEGY_V1.md` classifies most of those tables as HISTORICAL_EVIDENCE_ONLY — so a clean Supabase baseline is the more useful starting point for Phase 13.

**F-12-2 — the test ports are published on `0.0.0.0`, not loopback. MITIGATED by a Windows Firewall rule; external blocking not verifiable from this machine.**

### Observed exposure, and a correction to the previous revision

| Check | Result |
|---|---|
| `docker port` for 54321/54322/54323/54324/54327 | all `0.0.0.0:<port>` — **unchanged, and it did not change** |
| OS listeners on 54322 (`Get-NetTCPConnection`) | `::1` (wslrelay) and `::` wildcard (`com.docker.backend`) |
| Machine interfaces | `192.168.1.71` on **Wi-Fi** (physical), plus the WSL adapter `172.17.32.1` |
| Inbound firewall allow rules | Docker Desktop installed **Allow** rules for `com.docker.backend.exe` |
| Connection from a throwaway container to `192.168.1.71:54322` | `psql -U postgres` succeeded with the default password |

**Correction.** The previous revision read that last row as proof that *any host on the Wi-Fi network* could authenticate as superuser. **That claim was overstated and is retracted.**

Re-running the same test while capturing the server's view of the client shows why:

```
select inet_client_addr(), inet_server_addr();  →  172.18.0.1 | 172.18.0.2
```

The connection arrives from **`172.18.0.1`, the Docker bridge gateway** — not from a LAN address. Docker Desktop's port proxy intercepts the connection to `192.168.1.71:54322` from inside the WSL2 fabric and forwards it internally, so it never traverses the Windows inbound filter. The test proved that **a container on this machine** can reach the ports. It did not prove a real LAN peer can.

That residual is real and remains: anything running in Docker on this machine reaches the test ports regardless of the Defender rule, because WSL2 traffic is governed by a separate **Hyper-V firewall** (128 rules present) rather than by Windows Defender Firewall rules.

### Options investigated, against the tooling actually installed

| Option | Verdict | Evidence |
|---|---|---|
| A Supabase CLI `config.toml` bind/host key | **does not exist** | The `[db]` block of the generated `config.toml` supports exactly `port`, `shadow_port`, `health_timeout`, `major_version`. Nothing matching `bind`, `host`, `listen`, `interface` or `ip` appears anywhere for `[db]`. No key was invented or guessed |
| Docker Engine daemon `"ip": "127.0.0.1"` in `~/.docker/daemon.json` | **ineffective on Docker Desktop for Windows** — tested, then reverted | The key was added, Docker Desktop was restarted via `docker desktop restart`, and a throwaway container published a port with no explicit host IP. It still bound `0.0.0.0:55999`. On Docker Desktop for Windows, publishing is performed by `com.docker.backend`, which does not honour the Linux daemon's default-publish IP. `daemon.json` was restored byte-identical to its backup, verified with `diff`, and the backup was then removed |
| A Docker Desktop CLI setting | **none exists** | `docker desktop` exposes only `enable`, `disable`, `engine`, `kubernetes`, `diagnose`, `logs`, `restart`, `start`, `status`, `update`, `version`. `docker desktop enable` offers a single feature, `model-runner`. Nothing network related |
| A Docker Desktop settings key | **none present** | `%APPDATA%\Docker\settings-store.json` holds 5 keys, none matching bind / localhost / host / expose / network / port / ip. Probing undocumented keys would be guessing, which the brief rules out |
| **Windows Firewall rule** | **cannot be applied from this session** | The session is **not elevated**. `New-NetFirewallRule` returns `Acceso denegado`. This is the correct fix but it requires administrator rights |

No fragile workaround was attempted: no generated container was edited, no compose file was patched, no undocumented key was set.

### Mitigation applied by the owner

A Windows Firewall rule was created by the owner from an elevated PowerShell. Verified read-only, not modified by this phase:

| Property | Value |
|---|---|
| DisplayName | `Supabase Local - Bloquear acceso LAN` |
| Enabled | **True** |
| Direction / Action | Inbound / **Block** |
| Protocol | TCP |
| LocalPort | `54321,54322,54323,54324,54327` |
| RemoteAddress | Any |
| Profile | Any — and Domain, Private and Public are all `Enabled=True` |

The rule covers every published port of the stack, not just Postgres.

### What this does and does not change

**Docker still publishes on `0.0.0.0`.** The bind address did not change and was never changed — no supported setting exists to change it (see the options table above). The mitigation works at a different layer: Docker continues to publish on the wildcard address, and Windows Defender Firewall drops non-local inbound traffic to those ports.

**Local access is unaffected**, which is the requirement. Verified with the stack running:

| Check | Result |
|---|---|
| `Test-NetConnection 127.0.0.1` on 54321/54322/54323/54324/54327 | all **reachable** |
| Real query inside the stack | `select 'local-ok', current_user, …` → `local-ok\|postgres\|0` |
| TCP handshake to `127.0.0.1:54322` through the published forward | established |
| guard suite | 35/35 |
| backup/restore and reset/recreate | unaffected by a firewall rule; both had already been re-run and passed after a full Docker restart |

Loopback traffic is not filtered by Windows Firewall, which is precisely why a blanket inbound Block rule can coexist with working local development.

### Verification gap — stated rather than glossed

**Whether the rule blocks a genuine external LAN peer could not be verified from this machine.** Both probes available here bypass the path the rule filters:

| Probe | Why it is not a valid proxy for an external host |
|---|---|
| Container → `192.168.1.71:54322` | Intercepted by Docker Desktop's port proxy inside the WSL2 fabric. Proven by `inet_client_addr() = 172.18.0.1`. Governed by the Hyper-V firewall, not by Defender rules. Still reachable, as expected |
| Host → its own `192.168.1.71` | Short-circuited by the local network stack; it does not traverse the inbound filter. Still reachable, unchanged from before the rule |

So "still reachable" in both probes is **not** evidence that the rule fails. It is evidence that neither probe tests the rule.

**The one-minute check that would close this**, run from a second device on the same Wi-Fi network — a phone or another laptop:

```
# from the other device, expect a connection failure / timeout on each:
nc -vz 192.168.1.71 54322
nc -vz 192.168.1.71 54321
```

Or from another machine with PowerShell:

```powershell
Test-NetConnection -ComputerName 192.168.1.71 -Port 54322 -InformationLevel Quiet   # expect False
```

Until that runs, the rule's configuration is correct for the intent and local access is proven intact, but external blocking is **unproven** rather than proven.

### Security depends on the rule staying enabled

The mitigation is entirely external to the repository. Nothing in this project enforces it, and no guard checks it. If the rule is disabled, deleted, or scoped to a profile that is not active, the ports return to being reachable from the network with the default local development password — and nothing in the tooling will notice. Anyone rebuilding this environment on another machine gets **no** protection unless they create the rule too.

The residual noted above also stands: containers on this machine reach the ports regardless of the rule.

### Why this does not gate Phase 12

Exit criterion 2 is *isolation from production*, which rests on production being a different host entirely, on the CLI reporting `"target":"local"`, and on the cloud link never being used. F-12-2 is **LAN hardening of the test environment**, a different property. The database holds only disposable fixtures and is stopped when idle. It is recorded as open, escalated in severity, and carries a ready-to-run remediation — but it changes none of the ten criteria.

---

## 11. Exit criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | An isolated, disposable environment exists | **MET** | 12 containers running; PostgreSQL 17.6 on `127.0.0.1:54322`; destroyed and rebuilt twice (§9) |
| 2 | It is proven not to be production | **MET** | Five independent facts in §2, including the CLI's own `"target":"local"` and an untouched `project-ref` |
| 3 | Secrets and credentials are not versioned | **MET** | Only `.env.example` tracked; `.env.local` and `.env.test` ignored, the latter proven with `git check-ignore`; 0 secret patterns in the evidence artifact (§4) |
| 4 | Destructive operations have fail-closed guardrails | **MET** | Four layers; **35/35** executed cases (§5) |
| 5 | A safe procedure exists to obtain the real legacy schema | **MET** | `legacy-schema-snapshot.mjs` — schema-only, no data, no privileges, refuses loopback (§6) |
| 6 | Read-only profiling tooling exists | **MET** | `legacy-profile.sql` — 58 SELECT/WITH, zero mutating statements, covers G-1…G-15 and OD-1/2/3 (§7) |
| 7 | Backup + restore **executed and verified in test** | **MET** | Canary data recovered exactly: checksum `f6b2f68d…` restored, 5/5 rows, 0 tampered survivors (§8) |
| 8 | Reset / recreate **executed and verified in test** | **MET** | Two cycles; marker destroyed each time; baseline matched on four dimensions (§9) |
| 9 | No operation modified production | **MET** | 0 git changes under `supabase/migrations/`, `supabase/.temp/`, `.env.local`; no remote command run; every reset reported `"target":"local"` |
| 10 | Remaining production profiling needing external read-only access is stated | **MET** | P-4 in §10, with the requirement that it not be the service-role credential |

**10 of 10 met.**

---

## 12. Phase status

**PHASE 12 STATUS: COMPLETE**

A disposable, isolated Supabase local environment exists and has been proven disposable by execution: a real `pg_dump` backup was taken, the data was destroyed, a real `psql` restore brought it back byte-for-byte, and the whole database was destroyed and rebuilt to a verified known baseline twice. Guardrails are fail-closed with 35/35 executed cases, and production was never contacted.

Three items carry forward, none of which changes the ten criteria:

- **F-12-2** — **MITIGATED** by an owner-created Windows Firewall rule (`Supabase Local - Bloquear acceso LAN`, Inbound/Block/TCP on 54321, 54322, 54323, 54324, 54327, all profiles, Enabled). Docker still publishes on `0.0.0.0`; the bind address did not change, because no supported setting exists to change it. Local access is verified intact. Two caveats stand: blocking of a genuine external LAN peer is **unverified from this machine** — both available probes bypass the filtered path — and containers on this machine still reach the ports, since WSL2 traffic is governed by the separate Hyper-V firewall. Security depends on that rule staying enabled, which nothing in this repository enforces.
- **P-4** — a read-only production credential, needed to execute the legacy schema snapshot (§6) and the profiling suite (§7). Those close gaps G-1, G-2 and G-3 of `MIGRATION_STRATEGY_V1.md` and supply the evidence for OD-1, OD-2 and OD-3.
- **F-12-1** — the duplicate migration version prefixes (`009` ×2, `010` ×2) are **deferred as technical debt**, to be resolved when those migrations actually need to run. They stay disabled locally via `config.toml`; renaming them would desynchronise history with the cloud project, so it remains an owner decision.

**P-3 stands: `supabase unlink` was not executed.** The link remains, and guard layer 3 continues to refuse every remote selector.

### Environment state at the end of this phase

Stopped, by choice. `supabase start` brings it back; the guard, backup/restore and reset/recreate proofs were all re-run after a full Docker restart and a stack restart, and all passed — 35/35, checksum `f6b2f68d…` recovered exactly, and two reset cycles with the baseline matching on four dimensions. The environment is reproducible, not a one-time success.

`MASTER_ROADMAP.md` was not updated, per instruction.
