# PHASE 26 — MIGRATION REHEARSAL: PRE-RUN READINESS

**STATUS:** **BLOCKED** before migration execution. No realistic source copy exists yet. Read-only access (B), Block A and R1 are approved; scripts statically proven (§10c); Block A awaits execution by the owner (§10d).
**Nothing executed against any database:** no SQL, no migration, no data load, no test run. Production was not contacted. Baseline commit `061130f` created (§10).

**Exit criterion (MASTER_ROADMAP, verbatim):** "The migration runs end to end in the test environment against a realistic copy. Discrepancies explained, not silently reconciled. Repeatable."

| Part | Status |
|---|---|
| Runs end to end against a realistic copy | NOT DEMONSTRATED — no copy, no migration tool |
| Discrepancies explained | NOT DEMONSTRATED — no run |
| Repeatable | NOT DEMONSTRATED — contract defined in §9 only |

**Authorities read:** CLAUDE.md, MASTER_ROADMAP.md, MIGRATION_STRATEGY_V1.md, SAFE_TEST_ENVIRONMENT_V1.md, `physical-design/MIGRATION_RISK_REGISTER_V1.md`, target migrations 0001–0046, `scripts/test-env/*`, `scripts/target-db/apply.mjs`.
The handoff path `.planning/MIGRATION_RISK_REGISTER_V1.md` does not exist; the register is at `.planning/physical-design/MIGRATION_RISK_REGISTER_V1.md`.

---

## 1. Can a realistic copy be obtained safely?

| Option | What exists now | Usable as the realistic copy? |
|---|---|---|
| A. Local copy / dump of legacy data | **None.** `.netlify/db/pg_snapshots/` is empty. `.planning/phase12-evidence/phase12_backup.sql` is a dump of the **local test instance** (canary rows), not legacy data. `.planning/legacy-schema/` was never created. | No |
| B. Read-only production snapshot | **None.** `legacy-schema-snapshot.mjs` requires `LEGACY_READONLY_DATABASE_URL` and refuses loopback; it was never run. No read-only role exists (P-4 OPEN). `.env.local` holds only `SUPABASE_URL` and a **service-role API key**, which SAFE_TEST_ENVIRONMENT_V1 §10 excludes for this purpose. | Not without owner authorization and a new read-only credential |
| C. Exported files | **MP only.** `data/mercadopago/` holds the MP exports (`Liberaciones1–3`, monthly variants, `BASECSV`, `arch1–5`, `data11sept-23-sept`, `Reporte_movimientos…2026-09-04`). `outputs/mp-reconciliation/database-snapshot.json` (2026-09-12) is a partial JSON of the **legacy MP tables** only (4 348 movements, 441 sources, 159 links). `data/clientes.csv` (10 names) and `data/precios.csv` (5 rows) are seeds. **No operational table** (`clientes`, `pedidos`, `pedido_lineas`, `pagos`, `movimientos_caja`, `cuentas_caja`, `cheques`, `lotes`, `producciones`, `recuentos_lote`, `facturas`, `perfiles`, `productos`) has any export. | Partial — MP external evidence only |
| D. Synthetic approximation | Test fixtures in `scripts/target-db/*.test.mjs` | **No.** Not a realistic copy; not treated as one |

**What is missing:** the legacy operational schema (G-1) and all operational rows (G-2), plus `facturas` (G-3).

**Production read required:** **yes.** The only authoritative source of the operational legacy data is the live project.

**Prerequisites present:** tooling yes (`legacy-schema-snapshot.mjs`, `profiling/legacy-profile.sql`); credential **no**; owner authorization **no**.

**Conclusion:** stop condition "no realistic source copy" and "production read access would be needed but owner has not authorized it" both hold. Execution stops here.

---

## 2. Owner decisions OD-1 / OD-2 / OD-3 — evidence status

None can be profiled: every source table is in the live project. The profiling tool exists but was written in Phase 12 against column names inferred from application code (its own footer requires confirming them against the schema snapshot first). Against the Phase 26 request it is **partial**:

| OD | Covered by `legacy-profile.sql` today | Requested for Phase 26 and **not** covered |
|---|---|---|
| OD-1 mortality | §7: per (lote, count interval) Σ `producciones.mortandad` vs `mortandad_esperada`, `diferencia`, `aves_contadas`; per-flock latest count vs `aves_iniciales_postura − Σ mortandad` | percentage divergence; per-month grouping; implied population **at every** count (not only the latest); missing production dates in an active flock; duplicate (lote, fecha) mortality rows *inside* the OD-1 output (§5 counts them separately) |
| OD-2 client ledger | §8: per client delivered-in-window / before-window counts, sales, payments, computable position; count of clients with pre-window activity | any legacy stored balance (existence unknown until G-1); orphan payments per client; orders in `pendiente` / uncertain economic status; `rectificado` orders per client; per-client duplicate risk; the DEMONSTRABLE / NOT_DEMONSTRABLE / INSUFFICIENT_DATA classification |
| OD-3 cheques | §9: id, numero, banco, monto, estado, fechas, girador, exact-name client hit, `movimiento_caja_id IS NOT NULL` | the `movimiento_caja_id` value itself; candidate direction from the linked `movimientos_caja.tipo` (ingreso/egreso); the three-way classification |

These additions are read-only SELECTs. They are **not** written now: the column names cannot be confirmed without G-1, and the instruction was not to change tooling before readiness.

**Classification rules, fixed now so they are not decided after seeing numbers:**

- **OD-2** per client: DEMONSTRABLE only if the client has no pre-window activity, every in-window order has a determinable economic status, and there are no orphan payments or uncertain rectifications. INSUFFICIENT_DATA if a required input is missing. NOT_DEMONSTRABLE otherwise. Where a legacy stored balance exists, a non-zero difference against the reconstructed balance makes the client NOT_DEMONSTRABLE. The owner decides A/B for the **whole set** (strategy §6, §15); a mixed set is not permitted by the strategy.
- **OD-3** per open cheque: STRUCTURALLY_UNAMBIGUOUS only if direction follows from the linked `movimientos_caja.tipo` **and** the counterparty follows from a structural FK (there is none in legacy, so this class is expected to be empty or near-empty). EXCLUDE_CANDIDATE if settled before 2026-01-01 or not open. Everything else OWNER_CLASSIFICATION_REQUIRED. A `girador` name hit is a candidate, never an assignment.
- **OD-1**: the profile is a decision table per (flock, count interval); numerical closeness is not used to pick a winner.

| OD | Evidence profiled | Owner decision ready |
|---|---|---|
| OD-1 | no | no |
| OD-2 | no | no |
| OD-3 | no (no inventory of open cheques) | no |

---

## 3. Opening balance plan

Principle (strategy §6): per account or counterparty, opening balance **or** migrated history for the same window, never both. No amount is stated here.

| Ledger | Source of validation | Opening date | History window | Double-count prevention | Owner evidence required | Ready |
|---|---|---|---|---|---|---|
| Clients | per-client statement confirmed by owner (OD-2 A) or demonstrated documents (OD-2 B) | zero point = cutover date (rehearsal: the snapshot date) | OD-2 A: none; OD-2 B: 2026-01-01 → zero point | V-2: exactly one opening row per client or zero with history, never both; instruments in portfolio netted before the opening (V-6) | OD-2 decision + per-client statement | no |
| Suppliers | owner-validated per-supplier statement | zero point | none (no legacy supplier account) | V-4: zero migrated `PURCHASE` movements | supplier list + statements (no legacy master exists) | no |
| Caja chica | physical cash count | zero point, or 2026-01-01 if postings migrated | either/or per account, recorded before load | V-1 + V-2 per account | count + choice | no |
| Mercado Pago | MP account position from MP (export / statement) | same rule | same rule | same; MP raw layer is not a posting source by itself | MP position at chosen date + choice | no |
| BNA | bank statement | same rule | same rule | same | statement + choice | no |
| Patagonia | bank statement | same rule | same rule | same | statement + choice | no |

Rehearsal note: in Phase 26 the opening figures may be the owner's figures at the **snapshot** date; they are rehearsal inputs, not cutover authority.

---

## 4. Migration gaps (strategy §15)

| Gap | Deterministic mapping | Reference data | Owner input | Source | Safe exclusion rule | Phase 26 now |
|---|---|---|---|---|---|---|
| G-1 legacy DDL | — | — | P-4 | **absent** | — | blocked |
| G-2 row quality | — | — | P-4 | **absent** | — | blocked |
| G-3 `facturas` | no (structure unknown) | — | — | absent | yes: fiscal starts empty | not blocking |
| G-4 expenses → purchases | criterion yes; value maps no | expense categories, suppliers | supplier master | absent | yes: evidence-only + cash kept | needs profile |
| G-5 `eggs_dirty` | yes (0, "sin dato") | — | — | n/a | — | ready |
| G-6 null `lote_id` production | yes (excluded) | — | — | absent | yes | needs profile |
| G-7 `galpon` text | rule yes, map no | sheds | — | absent | unresolved → excluded | needs profile |
| G-8 account text | rule yes, map no | 4 accounts | — | absent | unresolved → excluded | needs profile |
| G-9 non-purchase natures | yes | — | — | absent | — | needs profile |
| G-10 payment methods (7→4; `tarjeta`, `otro`) | **no** — cheque/echeq rule yes; `tarjeta`/`otro` rule "decided from distribution" | — | possibly (if distribution does not decide it) | absent | — | blocked on profile |
| G-11 rectified order history | yes (current state, v0; loss recorded) | — | — | absent | — | ready as rule |
| G-12 three line shapes | rule yes; reader not built | — | — | absent | — | needs profile + tool |
| G-13 feed | yes (empty) | — | spreadsheets if any | **absent** | yes: feed starts empty | not blocking |
| G-14 planned flocks | yes (excluded) | — | — | absent | yes | ready as rule |
| G-15 management periods | yes (create OPEN for window, close after validation) | — | — | n/a | — | ready as rule |
| Open instruments | OD-3 | — | OD-3 | absent | EXCLUDE_CANDIDATE class | blocked |
| Mercado Pago | yes (§8) | MP account | — | **exports present locally**; legacy MP tables need P-4 or the 2026-09-12 JSON (partial, stale) | unreconciled is valid | partial |
| perfiles 3→2 roles | no | — | per-user confirmation | absent | — | blocked |
| products VENDIBLE/INPUT/BOTH | rule not written | — | possibly | absent | — | needs profile |

Risk register items 1–4 (`forma_pago`, duplicate mortality, client opening, orphan `movimientos_caja`) map to G-10, OD-1, OD-2 and G-8 respectively and share their status.

---

## 5. Lineage

- **No data-migration tool exists.** The only runner is `scripts/target-db/apply.mjs`, which applies schema migrations; nothing implements `(source_system, source_entity, source_id, import_batch)` or the three resolution maps.
- **Target keys verified in migrations:** `receipt_id` and `external_ref` (0010, 0015); `idempotency_key` (0019, 0026, 0029, 0032, 0035, 0039, 0043); `source_entity_type` / `source_entity_id` (0010, 0015); `mp_source_record.external_id` (0039); `OPENING_BALANCE` in both ledger movement enums (0002).
- **Tables with no in-target identity** (`population_events`, `financial_posting`, and `daily_production` beyond its natural key) depend entirely on the external mapping store for lineage. The store must exist before the first load.
- The mapping store is migration tooling in a **separate staging schema/database**, not a target table (strategy §12).

## 6. Idempotency / rerun semantics (proposed)

| Case | Rule |
|---|---|
| First run | New `import_batch`. Every source row gets a mapping-store row before its target write; the target write and the mapping row commit in the same transaction per entity batch. |
| Identical rerun (same snapshot) | Each source row resolves to its existing mapping; its idempotency key collides; the write is skipped. Row counts unchanged (V-22). |
| Changed source row | Not possible inside a rehearsal: the snapshot is immutable (§8). Against a **new** snapshot identity, the run starts on a fresh target; a changed row is reported as a source difference, never an in-place mutation of an append-only row. |
| Partial failure | The failed entity batch rolls back whole; earlier committed batches stay; the batch is marked FAILED in the store. |
| Resumed batch | Same `import_batch`, same snapshot identity; resumes at the first entity not marked COMPLETE; already-mapped rows are skipped by key. |

No DELETE-and-reload of target facts. A reload means destroying the whole disposable target (§9), which keeps the mapping store's history intact.

## 7. Realistic-copy isolation (design)

```
production (never written)
   │  read-only role, LEGACY_READONLY_DATABASE_URL — owner-created, owner-authorized
   ▼  pg_dump (schema + data, read-only)
immutable snapshot file  ── sha256 recorded as SOURCE SNAPSHOT IDENTITY
   ▼  restored into a SEPARATE local database/schema (legacy_copy), read-only role for the tool
migration tool  ── writes only to: staging mapping store + target
   ▼
disposable target (local Supabase 127.0.0.1:54322, guard.mjs fail-closed)
```

Requirements and how each is met: production never writable (read-only role; tool never holds a production write credential; guard refuses remote targets); source immutable (file hash checked before and after each run; restored copy owned by a role the tool cannot write with); target disposable (`supabase db reset` + `apply.mjs`, proven in Phase 12); credentials separated (read-only URL used only by the snapshot step; the service-role key in `.env.local` is never used); no dual-write (tool has no production path); snapshot identity (sha256 + UTC timestamp stored in the mapping store and in this file).

**Stops before connection:** creating the read-only role and running the snapshot touch production and need explicit owner authorization.

## 8. Rehearsal acceptance matrix (defined before the run)

Values are filled only from a run. Every discrepancy is EXPLAINED or BLOCKER.

| Domain | Source count / value | Target count / value | Expected exclusions | Expected transforms | Check |
|---|---|---|---|---|---|
| clients | active `clientes` | `clients` | none, or inactive per rule | CONSUMIDOR FINAL added (+1) | V-16 |
| suppliers | none (no master) | owner list | — | NEW | V-4 |
| products | `productos` | `products` | — | type mapping | V-16, V-17 |
| sheds | distinct normalized `galpon` | `sheds` | — | normalization map | V-17 |
| flocks | `lotes` 2026+ or ACTIVE | `flocks` | `Planificado` (G-14) | state map | V-16 |
| population | `aves_contadas` per count | derived population | per OD-1 | per OD-1 | V-7, V-8 |
| production | Σ eggs per flock-month | Σ `eggs_total` / `eggs_broken` | null `lote_id` (G-6) | mediodía+tarde; dirty = 0 | V-9 |
| classification | none | 0 rows | — | NEW | — |
| feed | none present | 0 rows | — | NEW | — |
| pedidos | 2026+ by estado; Σ `monto_total` | count; Σ line subtotals | pre-2026 | int→UUID; 3 line shapes | V-10, V-11, V-12 |
| client ledger | per OD-2 | Σ signed_amount per client | — | opening or history | V-2, V-3 |
| supplier ledger | owner statements | Σ per supplier | — | opening only | V-2, V-4 |
| financial accounts | owner real balances ×4 | Σ postings ×4 | unresolved account text (G-8) | opening/history per account | V-1, V-2 |
| cheques / eCheqs | open legacy cheques | `financial_instrument` | EXCLUDE_CANDIDATE, OD-3 B | direction/counterparty per OD-3 | V-5, V-6 |
| Feria | none | 0 rows | — | NEW | — |
| fiscal | `facturas` (unprofiled) | 0 rows | all (G-3) | — | — |
| Mercado Pago | export rows per month; `SOURCE_ID` set | `mp_source_record` per month | pre-2026 | normalization gross/fee/tax/net | V-13, V-14, V-15 |
| all | — | invariants, RLS, periods | — | — | V-18, V-19, V-20 |

## 9. Repeatability contract

- **Run 1:** fresh target (`supabase db reset` → `apply.mjs` 0001–0046) → migrate snapshot S → validate V-1…V-22 → record results R1.
- **Run 2:** destroy target → rebuild the same 46 migrations (checksums equal) → migrate the **same** S with the **same** configuration → validate → R2.
- **Pass requires R1 = R2 on:** snapshot identity (sha256); configuration hash (maps, rules, opening inputs); row count per target table; derived balances per client, supplier and account; derived population per flock; exclusion count per reason; mapping-store cardinality per entity; zero duplicate facts per idempotency key.
- **Plus V-22** inside one run: a second pass over the loaded target writes nothing.

## 10. Git baseline

**COMMITTED** (owner authorization A): `061130f` — `phase-25-baseline-before-migration-rehearsal`, parent `7f085f2`. 115 files, staged by explicit path (no `git add .`). No history rewritten.
Secret check before commit: no staged path under `.env*`, `.temp/`, `data/`, `outputs/`, no dump or key file; pattern scan found only the public local-stack credential `postgres:postgres@127.0.0.1:54322`, guard-test fixtures and `***` placeholders; zero hits for the production project ref, the service-role key or the anon key.
Also excluded: `.planning/phase12-evidence/phase12_backup.sql` (a dump), `.claude/settings.json`, `supabase/.temp/cli-latest`, and the ad-hoc root and `scripts/*` legacy MP files. This evidence file and `phase26-evidence/` postdate the commit.

The original proposal, as authorized:

- `supabase/target-migrations/` (0001–0046)
- `scripts/target-db/` (runner and 14 suites)
- `scripts/test-env/` (guard, snapshot, profiling, proofs)
- `supabase/config.toml`, `supabase/.gitignore`
- `.planning/MASTER_ROADMAP.md`, `.planning/MIGRATION_STRATEGY_V1.md`, `.planning/SAFE_TEST_ENVIRONMENT_V1.md`, `.planning/TARGET_ARCHITECTURE_V2_FROZEN.md`, `.planning/implementation-design/*` (5 modified), `.planning/ADR-003…005`, `.planning/adr/`, `.planning/PHASE_10…26*.md`, `.planning/physical-design/`, `.planning/phase12-evidence/`
- `CLAUDE.md` / `AGENTS.md`

Excluded: `supabase/.temp/`, `.env*`, ad-hoc root and `scripts/check-*` legacy MP scripts, `data/`, `outputs/` (production-derived data; they must not enter git without an owner decision).

---

## 10b. Read-only legacy access — design (owner authorization B; nothing executed)

**Production contact status:** not contacted. Read access is authorized; writes are not.

**Legacy source inventory (28 tables).** Derived from `MIGRATION_STRATEGY_V1` §3/§8 and confirmed against the application's `.from('…')` calls; the operational DDL is still unversioned (G-1), so the grant block aborts if any name is wrong.
- Operational (18): `perfiles, clientes, productos, precios_historial, pedidos, pedido_lineas, pagos, pago_en_caja, movimientos_caja, cuentas_caja, arqueos_caja, categorias_finanzas, cheques, comisiones, facturas, lotes, producciones, recuentos_lote`. Legacy order-line shapes 2 and 3 live inside `pedidos.lineas`, so they are covered.
- Mercado Pago source and coverage evidence (10): `mercadopago_raw, mercadopago_movements, mercadopago_settlement, mp_source_record, mp_financial_movement, mp_movement_source_link, mp_source_link_resolution, monthly_reconciliation, reconciliation_snapshot, import_period_coverage`.
- Excluded: `precios_actuales` (derived, F), `ledger_entry, account_balance, mp_financial_cycle, mp_import_exception, period_flow_observation, sync_metadata` (evidence kept in the old system, not needed as source), `login_attempts, webhook_events` (security/infrastructure), every non-`public` schema (`auth`, `storage`, `realtime`, `extensions`, `supabase_*`, `vault`, …).
- No legacy Feria or fiscal tables exist beyond the `clientes.categoria` tag and `facturas`.

**SQL (split per block so each runs alone):** [`A_CREATE`](phase26-evidence/LEGACY_SNAPSHOT_READER_A_CREATE.sql) (approved), [`B_R1_POLICIES`](phase26-evidence/LEGACY_SNAPSHOT_READER_B_R1_POLICIES.sql) (R1 approved), [`C_TEARDOWN`](phase26-evidence/LEGACY_SNAPSHOT_READER_C_TEARDOWN.sql), and [`VERIFY`](phase26-evidence/LEGACY_SNAPSHOT_READER_VERIFY.sql) (fail-closed proof run as the reader). The earlier combined `LEGACY_SNAPSHOT_READER_ROLE.sql` is superseded and removed.

**Privilege model (Block A):** `LOGIN`, `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`, no memberships, `CONNECTION LIMIT 2`, `VALID UNTIL 2026-10-31`; `CONNECT` on `postgres`; `USAGE` on `public` only; `SELECT` on the 28 tables and on their owned sequences only. No password in SQL: set with psql `\password` and kept only in git-ignored `.env.test`. `default_transaction_read_only = on`, statement and idle timeouts, as defence in depth.

**Limits that cannot be removed per role without a production-wide change (disclosed, not hidden):**
- `TEMP` on the database and `EXECUTE` on functions are granted to `PUBLIC` by PostgreSQL default; a per-role REVOKE cannot cancel a PUBLIC grant. TEMP objects are session-local and never persist. The EXECUTE exposure is checked by VERIFY 1.7: if any SECURITY DEFINER business write function (e.g. `marcar_pedido_entregado`) is executable, the process STOPS.

**BLOCKER — RLS versus a restricted reader.** Legacy tables have RLS enabled (`sql/*.sql`: perfiles, clientes, pedidos, pagos, movimientos_caja, cheques, lotes, recuentos_lote). For a role without `BYPASSRLS`, `pg_dump` either **fails** (default `row_security = off`) or dumps **only policy-visible rows** (`--enable-row-security`), which would be a silently partial copy. Per the instruction, privileges are not broadened silently. Owner options:
- **R1** — Block B: add one `FOR SELECT TO legacy_snapshot_reader USING (true)` policy on each RLS table, dump with `--enable-row-security`, remove it in Block C. A reversible administrative change to table security metadata; no data or column change.
- **R2** — give the reader `BYPASSRLS`. Currently forbidden by the owner's instruction.
- **R3** — the owner produces the full dump with the owner's own credential (or a managed Supabase backup) and hands over the file. No reader role; the snapshot identity is the file hash.

**Snapshot procedure (R1; revised after the rehearsal in §10c).** Client: `pg_dump` 17.6 inside a container of the cached image `supabase/postgres:17.6.1.155`, which matches the production server version (`supabase/.temp/postgres-version` = 17.6.1.155). The URL comes from `.env.test` into the environment, never onto a command line.
1. **Holder session** (reader): `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT pg_export_snapshot();` then the per-table `count(*)` of the 28 tables — these are the SOURCE_VISIBLE counts, taken **inside the same snapshot** the dump uses. The session stays open until step 3 ends.
2. **Data dump** (reader, second connection — connection limit 2):
   `pg_dump "$URL" --snapshot=<id> --format=custom --compress=6 --no-owner --no-privileges --no-publications --no-subscriptions --enable-row-security --table=public.<each of the 28> -f legacy-data.dump`
3. **Schema dump:** `pg_dump "$URL" --snapshot=<id> --schema-only --no-owner --no-privileges --table=public.<each of the 28> -f legacy-schema.sql`; then `COMMIT` the holder.
4. **Restore** into a separate local database `legacy_copy`, as the local `postgres`, never as the reader: `pg_restore -l` → drop only the `POLICY … legacy_snapshot_reader_select` TOC entries (that role will not exist locally) → `pg_restore --no-owner --no-privileges --exit-on-error -L <list>`.
5. **Reconcile:** RESTORED count per table must equal the step-1 count for all 28; any difference invalidates the snapshot.

Why `--snapshot` and not "count immediately before the dump": production keeps receiving writes, so a count taken outside the dump's snapshot can differ from the dump without the dump being wrong. Counting inside the exported snapshot makes equality exact. `--serializable-deferrable` is dropped in favour of `--snapshot`.

**COPY FROM and RLS:** PostgreSQL's warning that restoring with `COPY FROM` under row security can fail or be partial applies to the **restoring** role on the **target** database. The restore runs locally as `postgres`, the table owner, so it is not restricted. That warning is no reason to give the production reader `BYPASSRLS`.

Connection: the Supabase **session** pooler URI copied from the project's Connect dialog (not built by hand), user `legacy_snapshot_reader.<PROJECT_REF>`, port 5432; never the transaction pooler (exported snapshots need a stable session). Recorded command: identical with the URL shown as `postgresql://legacy_snapshot_reader.<REDACTED>@<REDACTED>:5432/postgres`.

**Output location:** outside the repository, `C:\Users\Franabregu\GranjaSnapshots\phase26\<UTC-timestamp>\` holding `legacy-data.dump`, `legacy-schema.sql`, `SHA256SUMS`, `manifest.json` (no credentials). Files set read-only after hashing.

**Hash / identity plan:** SHA-256 of `legacy-data.dump` and of `legacy-schema.sql` recorded in `SHA256SUMS`, in `manifest.json` and in this file. Manifest also holds: UTC timestamp, project ref (redacted in git), `server_version`, the 28 included tables, the excluded list, the redacted command, and the row count per table measured **on the local restore of the dump** (so counts belong to the same snapshot, not to a later live read). Before every profiling or migration run the hashes are re-checked; a mismatch stops the run.

## 10c. Pre-execution static check (owner step C) — executed on a throwaway container

**Environment:** a standalone container of `supabase/postgres:17.6.1.155` (the production server image), `--network none`, no ports, removed afterwards. As in production, `postgres` there is **not** a superuser and has CREATEROLE. The stub schema had the 28 tables with 5 rows each, RLS plus an existing app policy on the 8 legacy RLS tables, serial sequences on the 4 integer-PK tables, and a `SECURITY DEFINER` stand-in `marcar_pedido_entregado`. Production was not involved.

| # | Requirement | Test | Result |
|---|---|---|---|
| 1 | every policy B creates is removed by C | B → C: 8 created, 0 left | PASS |
| 2 | a name collision fails, never merges | same-name policy pre-created → B raises, 0 reader policies created; C raises and rolls back instead of dropping a foreign policy | PASS (B's guard added in this pass) |
| 3 | A fails atomically if a table is absent | `facturas` hidden → ERROR, 0 roles | PASS |
| 4 | B fails atomically | collision → whole block rolled back | PASS |
| 5 | C removes every reader policy, then the role | 0 roles, 0 policies, 0 grants, 0 `pg_shdepend` rows; the 8 app policies are intact | PASS **after fix** |
| 6 | no statement can mutate business rows | A/B/C hold only role, GRANT/REVOKE and POLICY statements; the VERIFY write probes use `WHERE false` or are rolled back, and each ended in `permission denied` / `must be owner` | PASS |
| 7 | no object other than role, grants and temporary SELECT policies | inspected: `CREATE ROLE`, `ALTER ROLE … SET`, `GRANT`, `CREATE POLICY` only | PASS |

**Fixes made before any production contact:**
- **C** used `DROP OWNED BY`, which fails on PostgreSQL 16+ for a non-superuser creator (`permission denied to drop objects`); the block rolled back cleanly. It now revokes explicitly from the real ACLs and then runs `DROP ROLE`, which itself fails if anything remains. Re-run: PASS.
- **B** now refuses to run if a policy named `legacy_snapshot_reader_select` exists anywhere. **C** drops only policies with that name **and** exactly the reader as role, and raises if another remains.
- **A**: `\set ON_ERROR_STOP on`; the `\password` text was reworded (owner correction A): no password in any file; it is set interactively and kept only in `.env.test`.
- **Restore:** the dump carries the reader's policies, and that role will not exist in the local cluster. The restore now filters those TOC entries (proven: filtered restore OK, counts identical).

**Behaviour proven on the rehearsal:**
- VERIFY as the reader: no privileged attribute, no membership, SELECT only on the 28 tables, no write privilege anywhere, no CREATE, TEMP inherited from PUBLIC. **1.7 lists the PUBLIC-executable SECURITY DEFINER stand-in**, so VERIFY does detect the exposure.
- `row_security = off` → `query would be affected by row-level security policy`. `pg_dump` without `--enable-row-security` fails the same way (fail-closed).
- With R1: counts seen by the reader equal the owner's counts for all 28 tables.
- 50 rows inserted concurrently during the dump: the counts taken in the exported snapshot equal the restored counts for all 28 tables, and the concurrent rows are excluded from both.

**STATIC SECURITY CHECK: PASS** (after the fixes above).

## 10d. Execution status and owner runbook

**Not executed against production in this pass.** Block A needs (1) the administrative `postgres` database credential and (2) an **interactive** psql session for `\password`. Neither is available in this non-interactive session. `.env.local` holds only API keys, which are not database credentials and are excluded by the owner's rule. Production was therefore not contacted.

**Anticipated stop at VERIFY 1.7.** PostgreSQL grants `EXECUTE` on every new function to `PUBLIC` by default. If `marcar_pedido_entregado` (the one legacy RPC the app calls) or any other business-write function is `SECURITY DEFINER` and still executable by `PUBLIC`, the reader inherits it and the instruction is to STOP before R1. Resolving it (for example `REVOKE EXECUTE … FROM PUBLIC` after confirming the app role keeps its explicit grant) is a production change that needs its own owner decision. It is not pre-authorized.

**Runbook (owner = O, Claude = C):**
1. **O** — opens an interactive psql to production as `postgres`, using the session-pooler URI from the Connect dialog: `docker run --rm -it public.ecr.aws/supabase/postgres:17.6.1.155 psql "<URI>"`. Runs `\i` of the A file (or pastes it), then `\password legacy_snapshot_reader` with a generated password.
2. **O** — writes `LEGACY_READONLY_DATABASE_URL=<session-pooler URI with user legacy_snapshot_reader.<ref> and that password>` into `.env.test` (git-ignored), and prints it nowhere.
3. **C** — runs VERIFY parts 1–2 as the reader. It stops at any failure, including 1.7.
4. **O** — runs B (clean case only).
5. **C** — runs VERIFY part 3 and the R1 completeness check, then the snapshot procedure of §10b, hashes, manifest, read-only files, local restore, and reconciliation of all 28 counts.
6. **O** — runs C only after C reports all 28 counts reconciled. **C** then confirms 0 roles, 0 policies and 0 grants through the post-check output O pastes back.
7. **C** — profiles `legacy_copy` only. No further production contact.

## 11. Blockers

1. **No realistic source copy** of the legacy operational data (A, B, C all absent except MP exports).
2. **P-4 open:** Block A and R1 are approved and statically proven (§10c), but Block A was not executed: it needs the owner's administrative credential and an interactive `\password` session (§10d, runbook step 1).
3. OD-1, OD-2, OD-3 evidence not profiled (consequence of 1–2).
4. No data-migration tool or mapping store exists.
5. Opening balances have no owner evidence yet.

## 12. Owner decisions required now

1. ~~Authorize a read-only production snapshot~~ — authorized (B).
2. ~~Authorize the git baseline commit~~ — authorized (A), committed `061130f`.
3. ~~Approve Block A~~ — approved. ~~Choose R1/R2/R3~~ — R1 approved, R2 rejected, R3 fallback only.
4. **Execute runbook steps 1–2** (§10d): create the reader and store its URL in `.env.test`.
5. **Possibly required:** a decision on any PUBLIC-executable SECURITY DEFINER business function that VERIFY 1.7 finds.

OD-1, OD-2 and OD-3 are **not** asked now: they are decided only after their evidence is profiled.

**MIGRATION RUN READY: no.**
