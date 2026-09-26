# PHASE 23 — MERCADO PAGO DEFINITIVE

**STATUS:** COMPLETE on mechanical evidence (§25–§27, §31). MASTER_ROADMAP.md is unchanged, so Phase 23 stays **CURRENT** until external review.
**DATE:** 2026-09-25
**ENVIRONMENT:** local Supabase only (`127.0.0.1:54322`, container `supabase_db_Claudio_app_Granja`, PostgreSQL 17.6)
**AUTHORITIES:**

- MASTER_ROADMAP.md, for sequence
- TARGET_ARCHITECTURE_V2_FROZEN.md, Part 22
- POSTGRES_SCHEMA_SPEC_V1, Domain L
- RPC_CONTRACTS_V1, §40–§41
- RLS_IMPLEMENTATION_SPEC_V1, §9
- DATABASE_INVARIANTS_V1, §21
- **ADR-003** (`.planning/ADR-003-MP-DEFINITIVE-CONTRACT.md`), accepted 2026-09-25

The FROZEN documents are amended by ADR-001, ADR-002 and ADR-003. No FROZEN file was rewritten.

**HISTORY:**

1. The pre-construction review returned BLOCKED on five gaps (parser, status, idempotency, N:N, legacy).
2. The owner decided those points and the parser contract was discovered from repository evidence (2026-09-25).
3. ADR-003 was ratified.
4. The phase was built from migration 0039.
5. **Final bounded correction (2026-09-25), migration 0042 (ADR-003 §10):**
   - reserve rows are IGNORED only after every common validation, otherwise ERROR;
   - RPC 41 Mode 1 may only create MP-owned operation types.

---

## 1. Exact exit criterion

> Raw source immutable, normalization, amount-assigned reconciliation to internal operations. Legacy MP retired or left read-only.

## 2. Scope

**Built:**

- the tables `mp_source_record`, `mp_financial_movement` and `mp_reconciliation`;
- `mp_source_raw_guard()` and its trigger `trg_mp_source_raw_guard`;
- RPC 40 `mp_normalize_source`;
- RPC 41 `mp_reconcile_movement`, as amended by ADR-003.

**Reused:**

- tables `financial_account`, `financial_operation`, `financial_posting`, `perfiles`, `management_period` and `audit_events`;
- functions `current_app_role()` and `assert_period_open()`.

**Not built:**

- any parallel MP ledger or balance;
- webhook or API normalization (unsupported in V1 by ADR-003);
- P&L;
- frontend;
- RPC 23 / RPC 24;
- any production change.

## 3. Frozen pipeline

1. Raw immutable source (service_role INSERT).
2. RPC 40 normalizes it into a movement (gross, fee, tax and net), or marks it IGNORED or ERROR.
3. RPC 41 assigns amounts from the movement to internal operations (N:N).
4. The internal `financial_operation` and `financial_posting` rows are the only balance authority.

MP is not a general ledger.

## 4. Schema

| Migration | Content | sha256 |
|---|---|---|
| `0039_mp_tables_guard.sql` | the three tables (Domain L + two ADR-003 columns on `mp_reconciliation`), the raw guard function and trigger, and four indexes | `439b007f…f9cc` |
| `0040_mp_rpcs.sql` | RPC 40 and RPC 41, owner postgres, EXECUTE perimeter | `bccbddc0…7748` |
| `0041_mp_privileges_rls.sql` | explicit privilege reset, grants, and the 7 RLS §9 policies | `0ed1c215…7e4b` |
| `0042_mp_contract_hardening.sql` | RPC 40 and RPC 41 redefined (CREATE OR REPLACE, same signatures and grants): reserve validity, and the Mode 1 operation-type rule. 0040 is untouched. | `c98b9ef2…278b` |

**Structure, as tested:**

- The columns match Domain L exactly, plus `mp_reconciliation.financial_account_id` and `idempotency_key` from ADR-003 (A2).
- `source_type` and `movement_kind` stay free `VARCHAR`, as frozen (A2).
- Constraints (A3):
  - `UNIQUE(source_type, external_id)`;
  - `UNIQUE(source, movement_kind)`;
  - `UNIQUE(movement, operation)`;
  - `UNIQUE(idempotency_key)`;
  - `assigned_amount <> 0`.
- All FKs are `ON DELETE RESTRICT` (A4).
- The indexes cover source status, source date, movement date, and the reconciliation lookup by (operation, account) (A5).
- RLS is enabled on all three tables (A7).
- No balance, remaining or reconciled-amount column exists (A8).
- 0001–0038 are unchanged; the runner verified their checksums, and 0035–0038 re-hash identically. The legacy migrations were not touched.

## 5. Raw ingestion

Ingestion is a direct `service_role` INSERT, the path RLS §9 defines. No ingestion RPC was invented.

- **Accepted:** a verbatim Liberaciones row is stored as PENDING, with raw columns derived per ADR-003 (B1).
- **Refused:** ADMIN, OPERATOR and anon cannot ingest (B2).
- **Duplicates:** a duplicate `(source_type, external_id)` is rejected by the physical UNIQUE (B3); a concurrent duplicate is also rejected (L5).
- **Scoping:** the same external_id under another source_type is a different source (B4).
- **Visibility:** ADMIN and service_role can read; OPERATOR sees nothing; anon has no privilege (B5).

## 6. Raw immutability

The trigger and function are exactly as frozen. The function is SECURITY INVOKER, is not in the definer inventory, and application roles cannot execute it (A6).

**What is blocked:**

- each of the six raw columns, updated individually, even by the owner/postgres (C1);
- a `jsonb_set` rewrite of the raw JSON, and a multi-column edit mixing raw and metadata (C2).

In every blocked case the raw bytes stay identical.

**Privileges:** no UPDATE or DELETE for ADMIN or service_role (C3).

**Metadata:** processing metadata changes only through RPC 40/41. Raw data is byte-identical after normalization (D2), after ERROR or IGNORED (D6, D7), and after the full pipeline (P4).

## 7. Normalization contract

The parser (`parse_mp_payload`) is the Liberaciones csv_import contract ratified in ADR-003 D1–D3.

## 8. Parser specification status

**DETERMINISTIC AND TESTED.** The contract comes from the committed exports (4,528 distinct rows) and was ratified by the owner.

**Real rows copied verbatim from the exports:**

| Row | Source file | Result |
|---|---|---|
| payment 144502568133 | Liberaciones1.csv | NORMALIZED (D1) |
| outgoing payment 145781917504 | Liberaciones1.csv | NORMALIZED (D3) |
| asset_management 1743973531011 | Liberaciones2.csv | NORMALIZED as yield (D4) |
| payout 146231746361 | Liberaciones1.csv | NORMALIZED as transfer (D5) |
| reserve rows (payment and payout) | Liberaciones1.csv | IGNORED (D6) |

**14 error cases**, each giving ERROR with no movement, a note, and raw data unchanged (D7):

- unknown DESCRIPTION;
- malformed numeric;
- missing amount;
- credit and debit both non-zero;
- credit and debit both zero;
- arithmetic mismatch;
- positive fee;
- more than 2 decimals (no rounding tolerance);
- external_id that is not the ADR-003 composite;
- occurred_date not derived from DATE;
- non-string value;
- unsupported CSV layout (settlement report);
- unsupported source_type `webhook`;
- unsupported source_type `api`.

## 9. Normalized movements

Each supported source produces one movement, carrying `movement_kind` and signed gross, fee, tax and net. Its `occurred_date` is inherited from the source.

| Row | Kind | Gross | Fee | Tax | Net |
|---|---|---|---|---|---|
| payment (D1) | payment | 1.00 | 0.00 | −0.01 | 0.99 |
| outgoing payment (D3) | payment | −20000.94 | 0.00 | −120.01 | −20120.95 |
| asset_management (D4) | yield | — | — | — | +2337.10 |
| payout (D5) | transfer | — | — | — | −532415.53 |

- A second RPC 40 call gives `ALREADY_PROCESSED` and creates no duplicate movement (D8, L1).
- A missing source gives `SOURCE_NOT_FOUND` (D9).
- Ingestion and normalization create no operation and no posting (D12).

## 10. Processing-status lifecycle

| Path | Tests |
|---|---|
| PENDING → NORMALIZED | D1 |
| PENDING → IGNORED (valid events only) | D6, D7b |
| PENDING → ERROR | D7 |
| NORMALIZED ↔ RECONCILED | F, E8 |

**RECONCILED holds iff every movement of the source is fully assigned** (signed):

| Situation | Status | Test |
|---|---|---|
| partial assignment | NORMALIZED | F1 |
| single movement fully assigned | RECONCILED | F2 |
| first movement complete, sibling unmatched | NORMALIZED | F3 |
| all siblings complete | RECONCILED | F4 |
| sibling completions concurrently | RECONCILED; the transition is not missed | L6 |
| later correction on a RECONCILED source | back to NORMALIZED, per the equivalence | E8 |

The V1 parser always yields one movement per source. The sibling movement in the multi-movement tests is an owner fixture, which the frozen schema permits (one row per kind).

## 11. Reconciliation (Mode 1: create)

**Operation-type ownership (0042).** Mode 1 may create only `MP_SETTLEMENT`, `FEE` or `ADJUSTMENT` operations, each with exactly one posting (E15).

Any other type raises `INVALID_MP_OPERATION_TYPE` before any write: no operation, posting, reconciliation or audit (E16). The rejected types tested are `TRANSFER`, `COLLECTION`, `FISCAL_PAYMENT`, `SESSION_CASH`, `SUPPLIER_PAYMENT` and `CHEQUE_CLEAR`, all owned by other RPCs.

**Mode 2 is unchanged** (H9): it creates no operation, so `p_operation_type` is ignored. It is neither validated nor applied, and the existing operation keeps its own type.

- **ADMIN assigns +600 of +1000.** The RPC returns `{reconciliation_id, financial_operation_id, remaining_unassigned: 400}` (E1). It creates:
  - one `MP_SETTLEMENT` operation, with `external_ref` = `MP:<key>`, dated `occurred_date`, sourced from `mp_financial_movement`, with **one** posting of +600 (E2);
  - a reconciliation row recording movement, operation, account, amount, key and actor (E3).
- **service_role assigns the remaining +400.** The movement is complete and the source becomes RECONCILED. `reconciled_by` and `created_by` are NULL; no user is fabricated (E4).
- **+1 more** gives `OVER_ASSIGNMENT` and writes nothing (E5).

**IGNORED requires a valid event (0042).**

- A valid synthetic reserve row → IGNORED (D7b).
- Reserve rows with any of these faults → **ERROR**, not IGNORED, with no movement and raw data unchanged (D7c):
  - malformed amount;
  - missing amount;
  - credit and debit both non-zero;
  - invalid arithmetic;
  - bad external_id;
  - malformed DATE;
  - occurred_date not derived from DATE.
- The real reserve rows from the exports still pass every validation and are IGNORED (D6).

## 12. Amount assignment

| Case | Steps | Result |
|---|---|---|
| positive movement, net +1000 | +600 → +400 → +1 | remaining 400 → 0 → `OVER_ASSIGNMENT` (E1–E5) |
| negative movement, net −250 | −100 → −150 | remaining −150 → 0, RECONCILED (E6) |

- The input guards (E10) are: `INVALID_AMOUNT` (0 or NULL), `INVALID_IDEMPOTENCY_KEY` (NULL, empty, or 98 characters), `ACCOUNT_REQUIRED`, `MOVEMENT_NOT_FOUND`, and `FORBIDDEN` for OPERATOR. Each rejection writes nothing.
- A 97-character key is accepted, and the external_ref fits in 100 characters (E12).

## 13. Sign semantics

Opposite-sign assignments are allowed (ADR-003 D6).

- **Valid counter-assignment:** +600, −100, +500 on a +1000 movement totals 1000 and the source becomes RECONCILED. No row is deleted (E7).
- **Correction after full reconciliation:** −100 on a RECONCILED source is allowed within the cap and returns the source to NORMALIZED (E8).
- **Beyond the cap:** abs(900 − 2000) > 1000 gives `OVER_ASSIGNMENT` (E9).

## 14. N:N semantics (true N:N — Mode 2)

- **One movement → two operations:** movement A is linked to op1 (Mode 1, +400) and to op2 (Mode 2, +600) (H1).
- **Two movements → one operation:** movement B is linked to the same op2 (+900). op2's MP posting capacity is then exactly used: 600 + 900 = 1500 (H2).
- **Link mode moves no money:** it creates no operation and no posting (H3).

**Mode 2 rejections**, each writing nothing (H4):

| Situation | Error |
|---|---|
| over the operation's capacity (1500 + 1) | `OPERATION_OVER_ASSIGNMENT` |
| same pair (movement, operation) again | `DUPLICATE_LINK` |
| missing operation | `OPERATION_NOT_FOUND` |
| no posting on the given account | `OPERATION_ACCOUNT_POSTING_NOT_FOUND` |
| two postings on the given account | `OPERATION_ACCOUNT_POSTING_AMBIGUOUS` |
| over the movement's net | `OVER_ASSIGNMENT` (the movement cap still applies) |

**Capacity is per (operation, account).** op2's Caja posting (−1500) is a separate capacity from its MP posting (H5).

**Corrections within both caps:**

- a −100 link on op2 brings the linked total to 1400 of 1500 and leaves 100 of 300 on the movement (H6);
- the capacity can then be filled exactly again (H7).

**No automatic matching:** every Mode 2 row references exactly the operation the caller supplied (H8).

**Account traceability:** ADR-003 adds `financial_account_id`, because without it a cap on a multi-posting operation would be ambiguous (ADR-003 §8).

## 15. Financial bridge

- Only RPC 41 Mode 1 creates an operation and a posting. The posting `signed_amount` equals the assigned amount, dated the movement's `occurred_date` (E2).
- The MP account balance moves exactly by the Mode 1 assignments, only through `SUM(financial_posting)` (E14, P3).
- Every MP-created operation traces to a reconciliation (N3).

## 16. Periods

The period determinant is MP's `occurred_date`, inherited by the movement.

| Case | Result | Test |
|---|---|---|
| reconcile a movement in a CLOSED month (Mode 1 or Mode 2) | `PERIOD_CLOSED`, nothing written | J1 |
| normalize a source in a CLOSED month | allowed, because frozen RPC 40 has no period guard; the movement carries its date | J2 |
| reconcile a movement dated in a month with no period | `PERIOD_NOT_FOUND` | J3 |
| reconcile a May movement while the current month is CLOSED | allowed; operation and posting dated 2026-05-31 (local date of 23:30 −03:00) | J4 |

`reconciled_at` and `processed_at` never decide the period (J4).

## 17. RLS

The seven policies match RLS §9 exactly (I5). Operator-level access:

| Role | mp_source_record | mp_financial_movement | mp_reconciliation |
|---|---|---|---|
| service_role | SELECT, INSERT | SELECT | SELECT |
| ADMIN | SELECT | SELECT | SELECT |
| OPERATOR | nothing | nothing | nothing |
| anon | nothing | nothing | nothing |

Tests: I1, I2.

## 18. service_role

- **RPC 40:** EXECUTE for service_role only. ADMIN, OPERATOR and anon are refused (D10, I7).
- **RPC 41:** service_role or ADMIN. For service_role the check reads `auth.role()` first, so `current_app_role()` is never consulted for a role that has no `perfiles` row (E4, L3, L4).
- **Boundary:** service_role has no access to clients, Pedidos, the client or supplier ledgers, production or purchases (I6).
- **ACLs:** authenticated has SELECT. service_role has SELECT, plus INSERT on `mp_source_record` only (I4).
- **Direct DML:** refused for ADMIN, service_role and OPERATOR beyond the raw INSERT (I3).

## 19. Audit

**NORMALIZE** (D11):

- the before status is PENDING;
- the after values carry the resulting status, the movement count and the note;
- `performed_by` is NULL (backend);
- for IGNORED and ERROR, the reason carries the note.

**RECONCILE** (E13) records: movement, amount, operation, account, mode, resulting source status, reason and actor (NULL for service_role).

Failed calls leave no audit (K).

## 20. Idempotency

| Layer | Mechanism | Tests |
|---|---|---|
| Source | `UNIQUE(source_type, external_id)` | B3, L5 |
| Normalization | status guard + `UNIQUE(source, kind)` | D8, L1 |
| Reconciliation request | `p_idempotency_key` (ADR-003) | G1, L4 |

**Reconciliation request details:**

- A repeated key, on the same or another movement, gives `DUPLICATE_RECONCILIATION`. No second operation, posting, reconciliation, status change or audit is written (G1).
- A concurrent repeat leaves exactly 1 reconciliation, 1 operation and 1 posting (L4).
- +600, −600, +600 all succeed with 3 distinct external_refs, so the cumulative collision of the frozen text is gone (G2).

## 21. Atomicity

Test-only triggers (schema `p23_harness`) inject real failures:

- **RPC 40** fails at the movement insert, at the metadata update, and at the audit. Each time the source stays PENDING, raw is untouched, and no movement or audit exists (K1).
- **RPC 41, Mode 1,** fails at the operation, at the posting, at the reconciliation, at the source-status update (final assignment), and at the audit.
- **RPC 41, Mode 2,** fails at the reconciliation and at the audit.

Every RPC 41 case rolls back fully (K2):

- no posting exists without a reconciliation, and no reconciliation without a posting;
- no source is left RECONCILED after a failed write.

The harness is removed afterwards (K3).

## 22. Concurrency

Real independent PostgreSQL sessions:

| Test | Race | Outcome |
|---|---|---|
| L1 | normalize the same source twice | B waited, then `ALREADY_PROCESSED`; one movement |
| L2 | 600 + 600 on a 1000 movement | B got `OVER_ASSIGNMENT`; 600 assigned |
| L3 | two valid final assignments | both applied in order → RECONCILED |
| L4 | same idempotency key | B got `DUPLICATE_RECONCILIATION`; 1 / 1 / 1 |
| L5 | duplicate ingestion | B waited on the UNIQUE, then was rejected |
| L6 | siblings completed concurrently | B waited on the source lock → RECONCILED |
| L7 | two movements linking one operation (700 + 700 > 1000) | B waited on the operation lock, then `OPERATION_OVER_ASSIGNMENT` |

## 23. Legacy MP inventory (repo facts)

| Component | Location | Status |
|---|---|---|
| Legacy schema: `mercadopago_raw`, `mercadopago_movements`, `mercadopago_settlement`, `ledger_entry`, `account_balance`, `sync_metadata`, `monthly_reconciliation`, `reconciliation_snapshot`, `period_flow_observation`, `import_period_coverage`, `mp_financial_cycle`, `mp_import_exception`, `mp_source_link_resolution`, `mp_movement_source_link`, and an experimental legacy-shape `mp_source_record` / `mp_financial_movement` | `supabase/migrations/001–010` | **Target:** not present (N1); the migration ledger contains only target files (N2). **Production:** exists and is writable. |
| Webhook `webhook-mercadopago` (notification → `GET /v1/payments/{id}` → legacy tables) | `netlify/functions/webhook-mercadopago.ts` | Production: live and writable |
| Poller `sync-mercadopago` (`/v1/payments/search` → `mercadopago_raw`) | `supabase/functions/sync-mercadopago/index.ts` | Production: writable |
| Legacy UI and API over MP, caja and balances | `src/api/mercadopago*`, `src/features/mercadopago/*`, `src/features/caja/*` | Production app, reading the legacy model |
| Import and repair scripts | `scripts/` (`import_liberaciones.py`, `rebuild_mercadopago_2026.py`, `import-csv-mp.mjs`, `sync-mp-direct.mjs`, …) | Migration and rehearsal tooling |
| MP exports | `data/mercadopago/` (`Liberaciones*`, `BASECSV`, settlement reports) | Migration source evidence; Liberaciones is the V1 parser's source |

The legacy `mp_source_record` / `mp_financial_movement` share names with the frozen tables but have a different shape. They are not compatible, and nothing is silently mapped between them.

## 24. Legacy authority / read-only state

Per owner decision and ADR-003 D8:

- The target MP model is the definitive V1 architecture.
- No legacy table exists or is authoritative in the target DB, and no target feature depends on `ledger_entry` / `account_balance` (N1, N2).
- Legacy MP stays the migration and historical source.
- Production legacy is **not** claimed to be read-only. It stays live because the current app depends on it.

**Cutover carry-forward:** "At Cutover, disable legacy MP writers/webhook path or make legacy MP read-only after the new ingestion path is activated and validated."

## 25. Tests

`scripts/target-db/mp.test.mjs` has **143 assertions**: 127 at the first build, plus 16 for the 0042 correction (D7b, D7c×7, E15, E16×6, H9).

| Group | Assertions |
|---|---|
| A structure | 8 |
| B ingestion | 5 |
| C immutability | 8 |
| D parser / normalization | 33 |
| E reconciliation / amounts / sign / operation type | 28 |
| F source status | 4 |
| G idempotency | 2 |
| H N:N / Mode 2 | 14 |
| I RLS / service_role | 7 |
| J periods | 4 |
| K atomicity | 11 |
| L concurrency | 7 |
| M definer | 3 |
| N no parallel ledger / legacy | 3 |
| P end-to-end | 4 |
| Z cleanup | 2 |

It passes on re-run: two consecutive runs in the final rebuild gave 143/0 and 143/0. The MP tables are written only by this suite in the local test DB, and cleanup removes every MP row and the operations and postings it created.

## 26. Regression

| Suite | Result |
|---|---|
| `apply.test.mjs` | 27 / 0 |
| `foundations.test.mjs` | 96 / 0 |
| `commercial.test.mjs` | 147 / 0 |
| `treasury.test.mjs` | 107 / 0 |
| `instruments.test.mjs` | 200 / 0 |
| `purchases.test.mjs` | 216 / 0 |
| `production.test.mjs` | 149 / 0 |
| `classification.test.mjs` | 75 / 0 |
| `feed.test.mjs` | 176 / 0 |
| `feria.test.mjs` | 142 / 0 |
| `fiscal.test.mjs` | 132 / 0 |
| `mp.test.mjs` | 143 / 0 (twice) |
| `guard.test.mjs` | 35 / 0 |

Earlier suites were changed only in exact structural inventories. No behavioural assertion was weakened.

- **Definer inventory (40):** updated in commercial, treasury, instruments, purchases, production, classification, feed, feria and fiscal. Foundations also adds 2 later-phase definers.
- **Later-phase tables (+3):** updated in foundations and treasury.
- **treasury A9** (no parallel money ledger): the `movement` name pattern matched `mp_financial_movement`, the frozen Domain L normalized external movement. It is excluded by exact name, like `feed_movement` and the Feria tables.
- **feria K5** ("no stored variance / reconciliation object … and no MP object is built in this phase"): the frozen MP tables now legitimately exist. The check keeps its intent (no cash variance or arqueo object) and excludes exactly the 3 Domain L tables.

## 27. Rebuild

```
before              → public tables=52, ledger=42
guard               → target proven local; cli argv proven local-only → supabase db reset (stack freshly started)
supabase db reset   → {"target":"local","message":"Reset local database."}
after destruction   → tables=0, migration_ledger schema=0, enums=0, public functions=0, views=0
rebuild             → 42 files, 0 already applied → +0001 … +0042 → ledger holds 42; public tables = 52
re-run apply.mjs    → applied 0 new migration(s); ledger now holds 42 (0001..0042)
suites              → runner 27/27, foundations 96/96, commercial 147/147, treasury 107/107, instruments 200/200,
                      purchases 216/216, production 149/149, classification 75/75, feed 176/176, feria 142/142,
                      fiscal 132/132, mp 143/143 (twice), guard 35/35
checksums           → 0035–0041 unchanged (0039 439b007f…f9cc, 0040 bccbddc0…7748, 0041 0ed1c215…7e4b); 0042 c98b9ef2…278b; legacy untouched
```

No manual step and no Studio action were needed. Supabase local was stopped at the end.

During development, 0040's first apply failed on a PL/pgSQL parse error: an `IF` condition that contains a `CASE … THEN` must be parenthesised. The runner rolled the file and its ledger row back together, so nothing was recorded, and the corrected file was applied. The checksum above is that of the final file.

## 28. Production isolation

- Production was not contacted, and the remote project-ref was not used.
- `db push`, `--linked`, `link` and `unlink` were never run.
- All SQL went direct-URL to the guarded loopback target, and the reset passed the CLI argv guard.
- Production credentials were unset, and no secret was printed.
- The legacy inventory was read from repo files only.
- No production data was used; the parser fixtures are rows of the committed local exports.
- The Mercado Pago API was never called.

## 29. RPC 23/24

RPC 23 and RPC 24 remain **UNASSIGNED**. They were not implemented, not assigned to MP, and Phase 18 was not edited.

## 30. Frozen contradictions / owner decisions

All are resolved by owner decision in ADR-003:

| Issue | Resolution |
|---|---|
| parse_mp_payload undefined | Liberaciones contract (D1); unsupported sources (D2); ERROR / IGNORED (D3) |
| RECONCILED after any assignment | RECONCILED iff every movement is fully assigned (D4) |
| RPC 41 not request-idempotent; cumulative `external_ref` collision | mandatory key, `idempotency_key` column, `external_ref = 'MP:' || key` (D5) |
| Counter-assignments | allowed within the abs cap (D6) |
| N:N was only 1:N | Mode 2 link-existing; operation-side capacity per (operation, account) via the added `financial_account_id` (D7) |
| Legacy retirement needs production | cutover carry-forward (D8) |

Two further points are kept as documented behaviour:

- RPC 40 has no period guard. This is the literal frozen text; the movement carries its period.
- The V1 parser yields one movement per source. Multi-movement status is proven with a schema-permitted owner fixture.

## 31. Exit evidence

| Requirement | Status | Evidence |
|---|---|---|
| Parser deterministic and tested | **MET** | D1–D7, P1 |
| Raw source immutable | **MET** | A6, C1–C3, D2, D6, D7, P4 |
| ERROR / IGNORED deterministic (IGNORED only for valid events) | **MET** | D6, D7, D7b, D7c, D11 |
| Mode 1 creates only MP-owned operation types | **MET** | E15, E16, H9 |
| Normalization | **MET** | D1–D12, L1 |
| Status semantics correct | **MET** | F1–F4, E4, E8, L6 |
| Request idempotency | **MET** | G1, G2, L4 |
| True N:N | **MET** | H1–H8 |
| Movement-side cap | **MET** | E5, E9, H4, L2 |
| Operation-side cap | **MET** | H2, H4, H5, H7, L7 |
| No invented matches | **MET** | H8, and no auto-match path exists |
| Postings are the sole balance authority | **MET** | A8, D12, E14, N3, P3 |
| Amount-assigned reconciliation to internal operations | **MET** | E, H, P |
| RLS / service_role | **MET** | I1–I7, D10 |
| Periods | **MET** | J1–J4 |
| Atomicity / concurrency | **MET** | K, L |
| Legacy MP: target has no legacy path; production retirement is a documented cutover carry-forward | **MET** (per owner decision) | N1, N2, §23–§24 |
| Regression, clean rebuild, production untouched | **MET** | §26–§28 |

## 32. Status

**PHASE 23 — MERCADO PAGO DEFINITIVE: COMPLETE** (§25–§27, §31).

MASTER_ROADMAP.md was deliberately left unchanged: Phase 23 stays **CURRENT** until external review. Phase 24 was not started.
