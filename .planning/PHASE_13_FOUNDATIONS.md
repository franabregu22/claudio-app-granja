# PHASE 13 — FOUNDATIONS

**STATUS:** COMPLETE  
**TARGET:** local Supabase only — `postgresql://…@127.0.0.1:54322/postgres`, proven by the guard before every operation  
**PRODUCTION:** not contacted. No remote command, no `db push`, no `--linked`, no `unlink`, no legacy data.

Authorities materialised, not reinterpreted: `POSTGRES_SCHEMA_SPEC_V1.md` (structure), `IMPLEMENTATION_DEPENDENCY_ORDER_V1.md` (order), `RLS_IMPLEMENTATION_SPEC_V1.md` (roles, grants, RLS, SECURITY DEFINER), `DATABASE_INVARIANTS_V1.md` (invariants), `RPC_CONTRACTS_V1.md` (the period guard).

---

## 1. Scope implemented

| Group | Delivered |
|---|---|
| Extensions | `btree_gist` (dependency order Phase 0) |
| Enums | all 28, values verbatim from the schema spec |
| Identity | `perfiles` |
| Period control | `management_period` |
| Audit | `audit_events` |
| Authorization matrix | `operator_assignments` |
| Shared masters | `sheds`, `clients`, `products`, `suppliers`, `financial_account`, `expense_category`, `classification_grade`, `projects`, `feed_type`, `feed_ingredient`, `genetics_consumption_curve`, `price_history` |
| Minimal structural dependency | `flocks` — table only |
| Functions | `current_app_role()`, `assert_period_open(DATE)` |
| Privilege perimeter | table + sequence privileges, 55 RLS policies, RLS on all 17 tables |
| Seeds | period calendar, the four frozen accounts, the seven frozen grades, `CONSUMIDOR FINAL` |

**`flocks` — why it is here.** `operator_assignments.flock_id → flocks(id)` is a Foundations FK, so `flocks` must exist. The dependency order places it at step 2.8 immediately before `operator_assignments`; this is the minimal structural dependency the design provides for. **Only the table** was created: no `population_events`, no `daily_production`, no weighings, no temperature records, none of RPCs 18–24. `flocks.purchase_id` exists **without its FK**, exactly as step 2.8 prescribes, because the `flocks ↔ purchases` cycle is closed at step 3.6 in the phase that creates `purchases`.

**Deliberately excluded:** `feed_formula_version` and `feed_formula_line`. They are step 2.3 masters, but `feed_formula_line.unit_cost_snapshot` is cost data whose protection needs the cost-hiding machinery and the `feed_formula_line_safe` view that belong to the Feed phase. No Foundations object depends on them.

---

## 2. Migration strategy used

The problem: `supabase/migrations/` holds the 12 legacy MercadoPago migrations, **two numbered 009 and two numbered 010**. The CLI derives the version from the leading digits, so applying them violates the primary key of `supabase_migrations.schema_migrations` — finding F-12-1. Renaming them would desynchronise history with the linked cloud project, so they are an owner decision, not a local repair.

The separation, deterministic and documented:

| | Legacy | Target V1 |
|---|---|---|
| Directory | `supabase/migrations/` — **untouched** | `supabase/target-migrations/` |
| Applied by | nobody; disabled via `[db.migrations] enabled = false` | `scripts/target-db/apply.mjs` |
| Ledger | `supabase_migrations.schema_migrations` (unused) | `migration_ledger.applied`, in its own schema outside `public` |

The two histories never share a namespace, so neither can corrupt the other, and nothing about the legacy set was modified.

### Runner guarantees

1. **Atomic apply.** Each migration's SQL and its `migration_ledger.applied` INSERT are sent as **one script inside one PostgreSQL transaction** (`psql -1 -v ON_ERROR_STOP=1`). If either fails, both roll back: no objects without a ledger row, no ledger row without the objects. There is no window between "migration committed" and "ledger written".
2. **Precheck before any database work.** Every file name must match `NNNN_lowercase_words.sql`, and two files sharing a version prefix (e.g. `0010_a.sql` + `0010_b.sql`) abort the run with `DUPLICATE_VERSION` before anything is applied — before the ledger is even created.
3. **No transaction control inside files.** A top-level `BEGIN`/`COMMIT`/`ROLLBACK`/`END`/`SAVEPOINT` would end the wrapping transaction early and break guarantee 1, so such a file is rejected with `TXN_CONTROL`. The check runs on the top-level SQL only — dollar-quoted bodies, literals and comments are stripped first — so `BEGIN … END` inside a plpgsql function or DO block, as in `0006`, is accepted.
4. **Immutable history.** Each applied file is recorded with its sha256. Checksums of the whole set are verified before any new file runs; a changed applied file aborts with `CHECKSUM_CHANGED` and nothing else is applied in that run.
5. **No stale view, no double apply.** The ledger is re-read before each file; inside the transaction an advisory lock serialises concurrent runners and the version is re-checked; the ledger primary key makes a double apply impossible in any case.

Rule 4 was exercised for real during construction: the `service_role` grant gap (section 4) could not be fixed by editing `0007`, which was already applied, so it was appended as `0009`.

### Correction to the first version of the runner

The first runner committed each migration with `psql -1` and then wrote the ledger row in a **separate** connection. A crash between the two would leave objects committed without a ledger row, and the next run would try to re-apply them. It also loaded the ledger once before the loop and did not reject duplicate target version prefixes. All three were corrected in the runner only; migrations `0001`–`0009` were not modified.

### Runner tests — `scripts/target-db/apply.test.mjs`

Runs the real `apply.mjs` as a child process against temporary migration directories, with a separate ledger schema (`runner_ledger_test`) and object schema (`runner_test`), both dropped at the end. **27 passed, 0 failed.**

| Case | Proven |
|---|---|
| A. duplicate version | `0001_first.sql` + `0001_second.sql` → `DUPLICATE_VERSION` naming both; no object created; no ledger created |
| B. SQL fails mid-migration | `0002` creates a table then runs `SELECT 1/0` → table absent, **no ledger row for 0002**; `0001` before it committed normally |
| C. ledger INSERT fails | a CHECK on the test ledger rejects version `0003`; `0003`'s SQL was valid, yet **its table is absent** — the objects rolled back with the failed ledger row |
| D. checksum changed | edited `0001` → `CHECKSUM_CHANGED`; the pending `0004` in the same run was **not** applied; ledger unchanged |
| E. idempotent re-run | first run applies exactly `0004`; second run `applied 0 new`, exit 0, ledger identical |
| F. transaction control | file with top-level `COMMIT` rejected, nothing from it ran; plpgsql `BEGIN…END` in a function and a DO block accepted |
| isolation | real `migration_ledger` untouched (9 → 9); test schemas removed |

No change was made from Studio, and no SQL was run by hand that is not represented in a versioned file.

---

## 3. Objects created

Measured on the rebuilt database:

| Object | Count |
|---|---|
| Tables in `public` | **17** |
| Enum types | **28** |
| RLS policies | **55** |
| SECURITY DEFINER functions | **2** — `current_app_role`, `assert_period_open` |
| Indexes | 36 |
| Tables with RLS disabled | **0** |

Migrations: `0001_extensions`, `0002_enums`, `0003_identity_periods_audit`, `0004_masters`, `0005_flocks_operator_assignments`, `0006_functions`, `0007_privileges_rls`, `0008_seeds`, `0009_service_role_grants`.

Invariant 1 is enforced physically: `idx_flocks_shed_active` is a partial UNIQUE **index**, since PostgreSQL has no partial UNIQUE constraint.

**One faithful-to-spec choice worth naming:** `perfiles.id` is declared in the frozen spec as a plain `UUID PRIMARY KEY` with no `DEFAULT` and **no FK to `auth.users`**, only the comment "equals auth.users.id". No FK was added — the spec is materialised as written rather than improved. The linkage is proven behaviourally instead (test group 4).

---

## 4. Privilege perimeter

Three mechanisms, never conflated: table privileges decide whether a write may be attempted, RLS decides which rows, SECURITY DEFINER functions perform period-sensitive writes.

Because RLS is permissive and policies for one command are OR-ed, **no `USING (FALSE)` or `AND FALSE` policy exists** — such a policy grants nothing and denies nothing, and would only look like protection. Absence of a policy is the denial, and immutability comes from absent privileges.

Verified state:

| Check | Result |
|---|---|
| Privileges held by `anon` | **0** |
| `authenticated` write privileges on `perfiles`, `management_period`, `audit_events`, `flocks` | **none** |
| `service_role` SELECT | `financial_account` only |
| ADMIN / OPERATOR | business roles resolved by `current_app_role()`, **not** PostgreSQL roles |
| Self-escalation | impossible: `perfiles` has no UPDATE privilege for any application role, so even a real ADMIN cannot change `rol_type` by direct DML |

### The one technical correction made

`RLS_IMPLEMENTATION_SPEC_V1.md` §4 grants `SELECT` to `authenticated` and revokes from `anon`, but says nothing about `service_role`. On this instance the Supabase default privileges for tables created by `postgres` in `public` grant anon/authenticated/service_role only `Dxtm` — TRUNCATE, REFERENCES, TRIGGER, MAINTAIN — and **no SELECT**. Observed directly:

```
clients grants → service_role : REFERENCES,TRIGGER,TRUNCATE
```

So the `financial_account_service_select` policy created in `0007` could never fire: `service_role` was refused at the privilege layer before RLS was reached. It does hold `rolbypassrls`, but bypassing RLS is not a table privilege.

`0009` grants exactly the read that §9 and the §10 coverage matrix already assign to `service_role` ("SELECT all — for MP reconciliation, backend only"), on `financial_account` only. This is not an escalation: the access was specified, only the GRANT that makes it reachable was missing. This is a gap **within one document** (§4 versus §9/§10), not a contradiction between two frozen documents, and it did not block Foundations.

---

## 5. Seeds

Only structural/configuration values that the frozen documents **enumerate**. Every statement is `ON CONFLICT DO NOTHING`, so a re-apply is a no-op.

| Seed | Value | Source |
|---|---|---|
| `management_period` | 12 rows, 2026-01-01 … 2026-12-01, all OPEN | frozen Part 20; `assert_period_open` raises `PERIOD_NOT_FOUND` for an unseeded month, and the migration window opens 2026-01-01 |
| `financial_account` | Caja chica, Mercado Pago, BNA, Patagonia | frozen Part 6 names exactly these four |
| `classification_grade` | XL, N1, N2, N3, Rotos, Sucios, Descarte | frozen Part 14 names exactly these seven |
| `clients` | `CONSUMIDOR FINAL` | frozen Part 16; `close_sales_session` raises `CONSUMIDOR_FINAL_MISSING` without it |

**Not seeded, deliberately:** `expense_category` — the frozen documents enumerate no categories, so seeding any would be inventing business data; Purchases is a later phase and will need them then. Also not seeded: `perfiles` (real users cannot be invented; tests create their own), and `sheds`, `products`, `suppliers`, `feed_type`, `projects`, `feed_ingredient`, `genetics_consumption_curve` (real business data).

No production data was copied. No client, balance, order, production record or movement was invented.

Three data classes stay separate: **structural seeds** live in `0008`; **test fixtures** are created and destroyed by the test suite; **real business data** does not exist yet.

---

## 6. Automated tests

`scripts/target-db/foundations.test.mjs` — **80 assertions, 80 passed, 0 failed**, across the 15 required groups.

Role-scoped cases simulate a real authenticated session the way Supabase does, because `auth.uid()` reads `request.jwt.claim.sub` / `request.jwt.claims->>'sub'`:

```sql
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub":"<uuid>","role":"authenticated"}';
…
```

| # | Group | Representative assertions |
|---|---|---|
| 1 | Schema from scratch | 17 tables present by name; RLS enabled on every one |
| 2 | Enums | 28 types; `rol_type = ADMIN,OPERATOR`; `management_period_status = OPEN,CLOSED`; `instrument_estado` has 8 values |
| 3 | Constraints reject bad data | non-month-start period rejected by `chk_periodo_fecha_is_month_start`; duplicate email rejected; **second ACTIVE flock in one shed rejected by `idx_flocks_shed_active`**; negative `initial_population` rejected |
| 4 | auth.users ↔ perfiles | all three profiles join to `auth.users`; `auth.uid()` returns the caller inside the session |
| 5 | `current_app_role()` | ADMIN profile → `ADMIN`; OPERATOR profile → `OPERATOR` |
| 6 | No business role without a valid profile | `activo=false` → `USER_NOT_FOUND_OR_INACTIVE`; missing profile → same; no `sub` claim → `NOT_AUTHENTICATED`; inactive user reading `clients` is rejected, not silently allowed |
| 7 | ADMIN vs OPERATOR | ADMIN reads clients and the 4 accounts; OPERATOR reads 0 clients and 0 accounts; OPERATOR reads the 7 grades |
| 8 | RLS row scoping | OPERATOR sees only its assigned flock (1 of 2); ADMIN sees both; OPERATOR sees only its own `perfiles` row, ADMIN sees all 3 |
| 9 | Writes forbidden where forbidden | OPERATOR refused on `audit_events`, `management_period`, `flocks`, and on self-escalation; **even ADMIN refused UPDATE on `perfiles`**; ADMIN *can* write `sheds`, proving the perimeter is not blanket-deny; OPERATOR cannot write `sheds` despite the privilege, because it has no policy |
| 10 | service_role separation | no business role (refused EXECUTE on `current_app_role`); `auth.role() = 'service_role'`; reads `financial_account` via its own policy; **no access to `clients`**; zero policies test `current_app_role() = 'SERVICE_ROLE'`; zero policies use a JWT claim |
| 11 | SECURITY DEFINER hardening | every definer pins `search_path=public`; inventory is exactly `assert_period_open,current_app_role`; none executable by PUBLIC |
| 12 | audit_events | exactly the frozen columns; no application role holds INSERT/UPDATE/DELETE; OPERATOR cannot read a `perfiles` audit row; ADMIN can; DELETE refused |
| 13 | OPEN period | 12 OPEN periods; `assert_period_open` succeeds for an OPEN month and raises `PERIOD_NOT_FOUND` for an unseeded one; **protected write succeeds** and the row really landed |
| 14 | CLOSED period | see section 7 |
| 15 | Cleanup | `test_harness` schema dropped; `public` still holds exactly 17 tables |

Two harness defects were found and fixed during the run, neither in Foundations: psql was echoing command tags (`BEGIN`, `SET`, `COMMIT`, `INSERT 0 1`) into stdout alongside values, so equality assertions compared against noise — fixed with `-q`; and two `service_role` assertions expected "returns 0 rows" where the perimeter actually produces the stronger "permission denied", so they now accept either.

---

## 7. CLOSED-period proof

The requirement is a **real protected write**, not a bare call to the guard function.

The fixture lives in schema `test_harness`, deliberately outside `public`, is created by the test suite and dropped at the end, and is never part of the target schema. It mirrors the frozen RPC pattern — authorize, guard the period, then write:

```sql
CREATE FUNCTION test_harness.record_guarded_fact(p_business_date DATE, p_note TEXT)
RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF current_app_role() NOT IN ('ADMIN','OPERATOR') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  PERFORM public.assert_period_open(p_business_date);      -- the Foundation guard
  INSERT INTO test_harness.guarded_fact (business_date, note, created_by)
  VALUES (p_business_date, p_note, auth.uid()) RETURNING id INTO v_id;
  RETURN v_id;
END; $$;
-- EXECUTE to authenticated; NO table privileges on guarded_fact
```

Sequence executed, as an authenticated ADMIN:

| Step | Result |
|---|---|
| 2026-05 is OPEN → write `2026-05-17` | **succeeded**, and `count(*) = 1` confirms the row landed |
| `UPDATE management_period SET status='CLOSED'` for 2026-05 | status is `CLOSED` |
| write `2026-05-17` again | **rejected** |
| the error | `PERIOD_CLOSED` — the rejection comes from the period guard, not from something else |
| row count after rejection | still **1** — nothing was written |
| write `2026-06-17`, a still-OPEN month | **succeeded** — so it is the period that blocks, not a broken function |
| direct `INSERT INTO test_harness.guarded_fact` as an application role | **refused**, `permission denied` — no bypass |
| row count after the bypass attempt | still **1** |

The period is restored to OPEN afterwards so the suite is re-runnable.

---

## 8. Clean rebuild proof

Executed end to end, with the guard proving locality at each destructive step:

```
before                → public tables=17, ledger=9
guard (CLI argv)      → cli argv proven local-only → supabase db reset
supabase db reset     → {"target":"local","message":"Reset local database."}
after destruction     → public tables=0, migration_ledger schema=0, enums=0
rebuild               → 9 files, 0 already applied → +0001 … +0009 → ledger holds 9
tests on rebuilt db   → 80 passed, 0 failed  (exit 0)
```

Re-executed with the **corrected runner**:

```
guard suite           → 35 correct, 0 incorrect
supabase db reset     → {"target":"local","message":"Reset local database."}
after destruction     → public=0, ledger_schema=0
rebuild               → 9 files, 0 already applied → +0001 … +0009 → ledger holds 9
foundations tests     → 80 passed, 0 failed
re-run apply.mjs      → applied 0 new migration(s); ledger now holds 9
runner tests          → 27 passed, 0 failed; real ledger 9 -> 9
```

The rebuild used **only versioned artifacts**. No manual step, no Studio change, and no ad-hoc SQL was needed, which is what makes the result independent of anything done earlier in the session.

---

## 9. Production isolation

| Check | Result |
|---|---|
| Commands run | `supabase start`, `supabase db reset`, `supabase stop` — all local; each reset reported `"target":"local"` |
| `db push` / `--linked` / `unlink` | never run; guard layer 3 refuses those argv forms |
| `supabase/.temp/project-ref` | present and untouched, 0 git changes |
| `supabase/migrations/` (legacy) | 0 git changes; never applied |
| `.env.local` | not read for values, not modified |
| Guard suite | 35/35 before the work |
| Legacy data | none migrated |

Environment left **STOPPED**, which also removes the F-12-2 network surface while idle.

---

## 10. Deferred items

| Item | Why |
|---|---|
| `feed_formula_version`, `feed_formula_line` | Cost protection and the `feed_formula_line_safe` view belong to the Feed phase; no Foundations object depends on them |
| `expense_category` seed values | The frozen documents enumerate none; inventing them would be inventing business data. Needed by Purchases |
| `perfiles` real rows | Real users cannot be invented |
| All later-phase domains | Commercial, Treasury, Instruments, Purchases, Freight, Production behaviour, Classification, Feed, Feria, Fiscal, MP — not started |
| `service_role` grants on MP tables | Those tables do not exist yet; the MP phase applies them |
| Cycle-2 FK `flocks.purchase_id → purchases` | Dependency order step 3.6, in the phase that creates `purchases` |
| **F-12-1** | Duplicate legacy migration prefixes 009/010. Still an owner decision; legacy migrations stay disabled locally. The target history is fully separated (section 2), so this does not block construction |
| **F-12-2** | LAN exposure of local ports, MITIGATED by the owner's firewall rule; external blocking still unverified from this machine |
| **P-3 / P-4** | `unlink` not executed; read-only production credential still pending, needed only for the legacy snapshot and profiling |

---

## 11. Exit criteria

| Criterion | Status | Evidence |
|---|---|---|
| Foundations scope implemented | **MET** | §1, §3 — 17 tables, 28 enums, 55 policies, 2 functions |
| Artifacts versioned | **MET** | 9 files in `supabase/target-migrations/`, ledger with sha256, no manual changes; runner applies SQL + ledger atomically (27/27 runner tests) |
| Clean rebuild demonstrated | **MET** | §8 — destroyed to 0 tables, rebuilt from files, 80/80 |
| Foundation tests PASS | **MET** | 80 assertions, 0 failures |
| `current_app_role()` proven | **MET** | groups 5, 6 — ADMIN, OPERATOR, inactive, missing profile, missing claim |
| Privilege perimeter proven | **MET** | group 9 — including that even ADMIN cannot UPDATE `perfiles` |
| RLS Foundation proven | **MET** | groups 7, 8 — row scoping by assignment and by ownership |
| SECURITY DEFINER hardening proven | **MET** | group 11 — pinned `search_path`, exact inventory, no PUBLIC execute |
| Audit Foundation proven | **MET** | group 12 — columns, absent privileges, read scoping, DELETE refused |
| OPEN period proven | **MET** | group 13 — guard passes and a protected write lands |
| CLOSED period blocks a protected write | **MET** | §7 — rejected with `PERIOD_CLOSED`, no row written, no bypass |
| No manual change needed to rebuild | **MET** | §8 |
| Production never contacted | **MET** | §9 |

---

## 12. Phase status

**PHASE 13 STATUS: COMPLETE**

Foundations is implemented, versioned, reproducible from zero, and proven by 80 behavioural assertions. The period guard demonstrably blocks a real protected write into a CLOSED period, and no application role can bypass it.

**Frozen contradictions: none.** One technical gap was found and corrected within scope — §4 of the RLS spec omits the `service_role` table grant that §9 and §10 rely on (section 4 above). It sits within a single document, not between two, and `0009` closes it by granting exactly the access already specified.

`MASTER_ROADMAP.md` was not updated, per instruction.

---

## 13. Post-closure hardening (recorded 2026-09-25, during Phase 14 review)

The Phase 14 review found that §4 above was incomplete. `0007` revoked `INSERT/UPDATE/DELETE/TRUNCATE` from `authenticated` and `ALL` from `anon`, but it never addressed the rest of Supabase's default privileges on the Foundation objects.

**Privileges that remained on the 17 Foundation tables and their sequences:**

| Role | Leftover privileges |
|---|---|
| `authenticated` | `REFERENCES, TRIGGER, MAINTAIN` on all 17 tables |
| `service_role` | `TRUNCATE, REFERENCES, TRIGGER, MAINTAIN` on all 17 tables |
| `service_role` | `UPDATE` on `management_period_id_seq` and `audit_events_id_seq` |

None of these privileges is part of the frozen perimeter. TRUNCATE is not subject to RLS.

**Fix: migration `0013_foundation_privilege_hardening.sql`.** Migrations 0001–0012 were left unchanged. 0013 does three things:

1. **Tables:** resets the 17 Foundation tables to zero for PUBLIC, anon, authenticated and service_role, then rebuilds exactly the frozen grants:
   - `authenticated`: SELECT on all 17, plus INSERT/UPDATE on the 13 masters (the same list as 0007);
   - `service_role`: SELECT on `financial_account` (the same grant as 0009);
   - `anon`: nothing.
2. **Sequences:** revokes everything on the Foundation sequences.
3. **Default privileges:** removes the `postgres` default privileges in `public` that gave application roles `Dxtm` on new tables and `w` on new sequences. Later phases are therefore born owner-only.

**Scope limits:**

- The `supabase_admin` and `storage` default ACLs are Supabase internals and were not touched. No role was altered, and no RLS policy changed.
- `supabase db reset` recreates Supabase's broad defaults. 0013 is what removes them on every build.

**Evidence:**

- `foundations.test.mjs` group 15 has 15 new assertions that inspect the real catalog ACLs (`aclexplode`), `pg_default_acl`, and a rolled-back table/sequence probe. The suite now has 96 assertions.
- Clean rebuild 0001→0013: runner 27/27, foundations 96/96, commercial 147/147. Ledger = 13.

The Phase 13 status above (COMPLETE) is unchanged. This section keeps the historical evidence accurate.
