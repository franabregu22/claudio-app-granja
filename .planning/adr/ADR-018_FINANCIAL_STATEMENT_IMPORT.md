# ADR-018 — Financial statement import and reconciliation

**STATUS:** **ACCEPTED** (owner GO, 2026-10-10: "GO owner para ADR-018", with the `parser_version` NOT NULL correction incorporated). Not implemented: no migration, function, Edge Function, bucket or UI exists for it.
**DATE:** 2026-10-10
**AMENDED:** 2026-10-10 (owner decision) — G-1 (BNA) and G-2 (Patagonia) CLOSED on real official statements; adapters `BNA_MONTHLY_PDF_V1` and `PATAGONIA_STATEMENT_PDF_V1` frozen (§7.2, §7.3).
**AMENDED:** 2026-10-10 (owner decision) — `fin_statement_line.running_balance` and `fin_statement_cutover.opening_balance` declared external bank / cutover evidence and the only two exact exceptions to the DATABASE_INVARIANTS_V1 "no stored balance" textual check (Compatibility verification).
**AMENDED:** 2026-10-11 (owner decision) — the exception is extended to exactly four pairs, adding the untransformed projections `fin_statement_line_status.running_balance` / `.opening_balance`; read-model state `CUTOVER_AMBIGUOUS_DAY` documented (§6.6).
**AMENDED:** 2026-10-11 (owner decision) — invariant: every active `fin_statement_match` refers to a `POST_CUTOVER` line under the account's active cut; resolving or superseding a cut that would break it fails atomically, with no automatic reversal (§6.6, §8, §14, §16 #24, §17).
**AMENDED:** 2026-10-14 (owner decisions, MP NORMAL mode; implemented by migration 0079) — (1) a NORMAL `asset_management` (yield) row takes effect through the existing circuit only: RPC 40 claim `yield / YIELD` → A1 `mp_apply_transition` → `financial_operation` / `financial_posting`, the frozen ADR-006 auto-applicable pair (0052); no alternative path, no new ADR. (2) A NORMAL report run is fail closed as a whole: if any economic or structural row is invalid (unknown `DESCRIPTION`, malformed amount / date, invalid payment `SOURCE_ID`, duplicate identity, …) the run is `REJECTED`, nothing reaches `mp_source_record`, no back-fill and no financial effect; the appearances are kept as evidence. This refines the §9.2 rows "SOURCE_ID missing or not numeric" and "Unknown `DESCRIPTION`": such rows are rejected at ingestion instead of being recorded as RPC 40 `ERROR`. No partial processing.
**AMENDED:** 2026-10-14 (owner decision, "MP EMPTY DAILY REPORTS"; implemented by migration 0080, parser `mp-release-report-csv/1.1.0`) — a valid release report holding only CONTROL rows (opening balance / totals) and zero economic movements is a day without activity, not an error: NORMAL → `PARSED` (CONTROL rows `IGNORED`, 0 `NEW`, 0 back-fills, 0 effects); VALIDATION → `VALIDATED`. CONTROL rows must themselves be well-formed (canonical amounts, `DATE` empty or a timestamp, descriptive fields empty), otherwise `INVALID` → run `REJECTED`. Every other fail-closed rule is unchanged. Runs rejected `NO_MOVEMENT_ROWS` under parser 1.0.0 stay as evidence; a reprocess of the stored bytes with 1.1.0 creates a new run linked by `previous_run_id`.
**RAISED BY:** post-cutover gap (2026-10-04 ~20:36): a real transfer to the MP alias/CVU never reached the webhook, and the target has no report channel (L-1 removed the legacy `sync-mercadopago-releases` / `upload-settlement-csv`). Separately, the target has no way to ingest bank statements (BNA, Patagonia).
**NEW SCOPE (owner decision):** "Importación y conciliación de extractos financieros" is part of the ERP.

**AFFECTS (by explicit amendment / cross-reference only; FROZEN files are not rewritten):**
- ADR-006 §8 step 4 and ADR006_IMPLEMENTATION_ORDER_V1 (V-4 gate row and step 19): inbound report-payment back-fill moves outside the V-4 gate (§10).
- RPC_CONTRACTS_V1: new service-role and ADMIN functions; the inventory grows from 52 (exact count fixed at implementation).
- The SECURITY DEFINER set: grows from 69 (exact count fixed at implementation).
- POSTGRES_SCHEMA_SPEC_V1: new tables `fin_import_run`, `fin_import_run_line`, `fin_statement_line`, `fin_statement_match`, `fin_statement_cutover`.
- RLS_IMPLEMENTATION_SPEC_V1: new tables (ADMIN read) and a new Storage perimeter (bucket `financial-statements`).
- DATABASE_INVARIANTS_V1: new invariants (§16).

**NOT AFFECTED:**
- `financial_account`, `financial_operation`, `financial_posting` (no column, constraint or RPC change);
- RPC 40 `mp_normalize_source`, `mp_register_delivery`, S4 `mp_ingest_api_snapshot`, A1 `mp_apply_transition`, `mp_normalize_report_fallback`, `mp_v4_verified()` (stays false);
- the semantics of MP report-only classes (`yield` REPORT_ONLY; `payout` never auto-posted): unchanged;
- ADR-003 parser contract (Liberaciones, 15 keys), ADR-008 bucket `purchase-attachments`, ADR-011 `register_bank_tax`, ADR-017 `mp_cutover_boundary`;
- the webhook (`mp-webhook`) and the worker (`mp-worker`) contracts;
- the P&L; client ledger; OPERATOR permissions.

---

## 1. Context

| Fact | Evidence |
|---|---|
| The webhook does not deliver every balance-affecting event (e.g. a transfer to alias/CVU). | 2026-10-04 ~20:36 transfer, absent from `mp_webhook_delivery`. |
| ADR-006 §8 already defines reports as the completeness authority, loaded as `mp_source_record` `csv_import`, but nothing loads them in the target. | No ingestion function exists; `mp_source_record` `csv_import` inserts are service-role only (0054). |
| Report `payment` rows are parked `DEFERRED_V4` while `mp_v4_verified()` is false; the planned back-fill is inside the V-4 gate. | 0071 RPC 40 body; ADR006_IMPLEMENTATION_ORDER_V1 V-4 row, step 19. |
| `mp_register_delivery` refuses `origin = 'report_backfill'`. | 0048 RPC body (`origin must be webhook or chargeback_refresh`). |
| `mp_normalize_report_fallback` refuses while V-4 is false. | 0051 RPC body. |
| Banks: no statement table, importer or reconciliation exists; bank postings come only from manual RPCs (transfer, cheques, supplier payments, bank tax). | 0014, 0016, 0018, 0020, 0062. |
| A private-bucket pattern exists (ADMIN-only, owner folder). | ADR-008 / 0058. |

## 2. Decision

1. Add a **common financial import evidence model** (`fin_import_run`, `fin_import_run_line`) shared by bank statements and MP reports. A run is one processing attempt over one stored original file; a rejected or validation run may be followed by an explicit, audited reprocess of the same bytes (§6.1).
2. **Banks:** ADMIN uploads the original official bank statement file ("Importar extracto bancario"; no file extension is assumed — each bank format is handled by a server-side adapter, §7.1); the backend stores it, hashes it, validates, parses and persists unique bank facts (`fin_statement_line`). Lines are **evidence**, reconciled manually 1:1 against existing postings (`fin_statement_match`). **Importing a bank statement never creates money.**
3. **Mercado Pago:** a daily official report is the completeness/discovery path; the webhook remains an optional fast path.
   - **A report `payment` row never creates payment money directly in this phase.** It only triggers a back-fill `GET /v1/payments/{SOURCE_ID}`; payment money is created exclusively by the existing `api_payment` circuit.
   - Non-payment report classes (`yield`, `payout`) keep **exactly** their existing semantics (ADR-003 / ADR-006 / 0071): this ADR neither adds nor removes any effect for them.
   - The first real report is captured in **validation mode** (§9.3) before any normal processing.
4. A **minimal amendment of ADR-006** (§10) enables the inbound report-payment back-fill outside V-4. Everything else gated by V-4 stays gated.

## 3. Scope

In scope:
- the evidence model and its private Storage;
- bank statement ingestion (format-agnostic, one adapter per bank format) for accounts of type `BANK_ACCOUNT` (BNA, Patagonia), gated by real-file evidence (§21);
- explicit reprocess of rejected / validation runs;
- manual 1:1 bank reconciliation;
- MP daily Liberaciones report ingestion (validation mode first) + inbound payment back-fill;
- read-only health views (§15).

Out of scope: §18.

## 4. Roles of the actors

| Actor | Does | Never does |
|---|---|---|
| Browser (ADMIN) | "Importar extracto bancario": selects account, selects the original statement file, uploads its bytes; requests a reprocess of a rejected/validation run; reconciles lines by choosing a posting | parse authoritatively, compute file hash or line identity, write Storage directly |
| Edge Function (bank import) | verifies ADMIN; stores bytes; computes sha256; validates format; parses to canonical fields; calls one DB function; on reprocess, re-reads the stored bytes and re-verifies the hash | create operations or postings |
| Edge Function (MP report ingest) | requests/downloads the report; stores bytes; in VALIDATION mode only captures and parses; in NORMAL mode loads rows into `mp_source_record` and requests back-fills | create movements, operations or postings itself. Any MP effect comes from the existing pipeline: RPC 40 / S4 / A1 for `api_payment`, and RPC 40's unchanged report-only logic for `yield` / `payout` |
| DB functions | re-verify the caller; compute line identity; persist transactionally | trust client-computed identity |

## 5. Existing architecture reused

| Element | Role in this ADR | Change |
|---|---|---|
| `financial_account` | the account a run and its lines belong to | none |
| `financial_operation` / `financial_posting` | the accounting facts a bank line is reconciled against; MP money | none |
| `mp_source_record` (`csv_import`) | MP report row (raw, immutable, unique `(source_type, external_id)`) | none |
| RPC 40 `mp_normalize_source` | normalizes report rows (payment → `DEFERRED_V4`; yield/payout → current logic) and `api_payment` snapshots | none |
| `mp_webhook_delivery` (`origin = 'report_backfill'`, `report_source_id`) | back-fill queue entry, already allowed by the table constraints | none to the table |
| worker, S4, `mp_transition_identity`, A1 `mp_apply_transition` | fetch → snapshot → claim → money | none |
| `mp_cutover_boundary` (ADR-017) | MP pre-cutover exclusion | none |
| pg_cron + pg_net + Vault pattern (0056) | scheduling of the daily report | pattern reused |
| ADR-008 private-bucket pattern | Storage perimeter | pattern reused, new bucket |

## 6. Financial import evidence model

Conceptual; column names are indicative, types and exact constraints are fixed at implementation.

### 6.1 `fin_import_run` — one processing attempt over one stored original file

| | |
|---|---|
| Fields | `id`; `source_kind` (`BANK_STATEMENT` \| `MP_RELEASE_REPORT`); `mode` (`NORMAL` \| `VALIDATION`); `financial_account_id`; `format_code` (the specific adapter/parser that recognised the file, e.g. `BNA_MONTHLY_PDF_V1`; NULL when no business format was recognised); `parser_version` (**NOT NULL**); `file_sha256`; `storage_path`; `file_name`; `byte_size`; `coverage_from` / `coverage_to`; `status` (`PARSED` \| `VALIDATED` \| `REJECTED`); `reject_reason`; counters (rows total / new / already known / ignored / invalid / captured); `previous_run_id`; MP metadata (report request id, report type) when `source_kind = 'MP_RELEASE_REPORT'`; `created_by` (NULL for the scheduler); `created_at` |
| PK | `id` |
| UNIQUE | `(financial_account_id, file_sha256)` among runs with `mode = 'NORMAL'` and `status <> 'REJECTED'`; `(financial_account_id, file_sha256, mode, parser_version)` for all runs |
| FK | `financial_account`; `perfiles`; `previous_run_id` → `fin_import_run` (must have the same account and `file_sha256`, and be `REJECTED` or `VALIDATED`) |
| Status by mode | `NORMAL` → `PARSED` \| `REJECTED`; `VALIDATION` → `VALIDATED` \| `REJECTED` |
| Represents | proof of which exact bytes were received for which account, and every attempt to process them: by whom, when, and with which parser version |

**`parser_version` is always NOT NULL.**
- Every `fin_import_run` records the version of the component that made the attempt, including when no business format was recognised.
- In that case the run records a stable version of the detector/importer that performed the attempt.
- The concrete detector/adapter names and versions are fixed when each adapter is implemented; this ADR freezes only the rule that the attempt's version is never NULL.
- `format_code` may be NULL when the format was not recognised; `parser_version` may not.
- The attempt idempotency `(financial_account_id, file_sha256, mode, parser_version)` depends on this rule: a NULL version would make repeated attempts indistinguishable from new ones.

**Reprocess (rejected or validation run).**
- An ADMIN may explicitly request a new run over the same stored bytes when every existing run for `(financial_account_id, file_sha256)` is `REJECTED` or `VALIDATED`.
- The new run reuses the same `storage_path`, re-verifies the sha256 of the stored object, and records `previous_run_id`, the new `parser_version`, `created_by` and `created_at`.
- The previous run is never modified.
- A run `PARSED` in `NORMAL` mode is never reprocessed through the normal flow.
- Repeating a request with an already-attempted `(mode, parser_version)` returns the existing run.

### 6.2 `fin_statement_line` — one unique bank fact (immutable)

| | |
|---|---|
| Fields | `id`; `financial_account_id`; `value_date`; `signed_amount`; `description_raw`; `description_norm`; `bank_reference` (if the format carries one); `running_balance` (if the format carries one); `fingerprint`; `first_run_id` (informative only); `created_at`. No cutover attribute is stored on the line (§6.6). |
| PK | `id` |
| UNIQUE | `(financial_account_id, fingerprint)` |
| FK | `financial_account`; `first_run_id` → `fin_import_run` |
| Represents | the economic fact as reported by the bank, once, regardless of how many files contain it |

**The fingerprint formula is frozen per adapter**, only after real official statements, validated against the full available history, show which fields are stable across overlapping or consecutive statements, whether a reference and a running balance exist, and how identical rows (same date, amount and description) appear. Frozen today: `BNA_MONTHLY_PDF_V1` (§7.2) and `PATAGONIA_STATEMENT_PDF_V1` (§7.3). Any other adapter's formula is TBD until its own evidence. No fingerprint includes a row ordinal, page, row number, `format_code` or `parser_version`.

MP report rows do **not** produce `fin_statement_line`; their fact is `mp_source_record`, and MP reconciliation stays in `mp_reconciliation` / `mp_report_match`.

### 6.3 `fin_import_run_line` — one row's appearance in one run

| | |
|---|---|
| Fields | `run_id`; `row_number`; `raw_row` (exact row content); `outcome` (`NEW` \| `ALREADY_KNOWN` \| `IGNORED` \| `INVALID` \| `CAPTURED`); `note`; `statement_line_id` (nullable); `mp_source_record_id` (nullable) |
| PK | `(run_id, row_number)` |
| FK | `fin_import_run`; `fin_statement_line`; `mp_source_record` |
| Destination rule | `NEW` / `ALREADY_KNOWN` → exactly one normalized destination, matching the run's `source_kind` (`BANK_STATEMENT` → `statement_line_id`; `MP_RELEASE_REPORT` → `mp_source_record_id`). `INVALID` → no destination required. `IGNORED` → destination present or absent according to the cause, recorded in `note`. `CAPTURED` (only in `VALIDATION` runs) → **no destination**. Never both destinations. |
| Represents | which file contained which row, verbatim. `run_id + row_number + raw_row` is always preserved, whatever the outcome or mode. |
| Appearance metadata | adapter-specific evidence of the row inside the file: page, physical row, balance-chain index, and secondary detail (e.g. Patagonia TRANSFERENCIAS RECIBIDAS, §7.3). It never changes the line's fingerprint and is never stored on `fin_statement_line`. |

### 6.4 `fin_statement_match` — manual, append-only bank reconciliation

| | |
|---|---|
| Fields | `id`; `statement_line_id`; `financial_operation_id`; `financial_posting_id`; `matched_by`; `matched_at`; `reason`; `reversed_by`; `reversed_at`; `reverse_reason` (the three reversal fields all NULL or all set) |
| PK | `id` |
| UNIQUE | one active (not reversed) match per `statement_line_id`; one active match per `financial_posting_id` |
| FK | `fin_statement_line`; `financial_operation`; `financial_posting`; `perfiles` |
| Represents | the full reconciliation history; rows are never deleted |

### 6.5 Overlapping statements (normative example)

Statement A (01–10 Oct) and statement B (01 Oct–01 Nov) both contain movement X:
- runs: 2 (`fin_import_run` A, B — different bytes);
- facts: **1** `fin_statement_line` X;
- appearances: **2** `fin_import_run_line` (A: `NEW`, B: `ALREADY_KNOWN`), both pointing to X.

Storing only `first_run_id` is insufficient and is not the evidence model.

### 6.6 `fin_statement_cutover` — owner decision fixing the opening cut of one bank account

Whether a bank line was absorbed by the opening balance is a property of **our cutover**, not of the bank movement; it is therefore never stored on `fin_statement_line`.

| | |
|---|---|
| Fields | `id`; `financial_account_id`; `opening_balance`; `cutoff_statement_line_id` (the last bank line absorbed by the opening balance); `resolved_by`; `resolved_at`; `evidence_note`; supersession fields (`superseded_by`, `superseded_at`, `supersede_reason`) |
| PK | `id` |
| UNIQUE | one active (not superseded) row per `financial_account_id` |
| FK | `financial_account`; `cutoff_statement_line_id` → `fin_statement_line` (must belong to the same `financial_account_id`); `perfiles` |
| Rules | written by ADMIN through a dedicated, audited function (`audit_events`), recording the owner decision and its evidence; never edited in place (a correction supersedes the active row); `cutover_at` 2026-10-04 19:00 -03:00 is **not** assumed to be the bank cut; known opening balances: BNA 335 713, Patagonia 1 994 |
| Represents | the evidence-backed anchor separating lines included in the opening balance from lines the target must reconcile |

**Anchor balance rule (owner, K-4):**
- `opening_balance` must equal exactly the `running_balance` of `cutoff_statement_line_id`.
- A line with `running_balance` NULL cannot be the anchor.
- If no line carries the required opening balance, no anchor is registered, the global `cutover_at` is never used as a fallback, and G-3 stays OPEN pending further evidence.
- `opening_balance` and the line's `running_balance` are external / decision evidence, not ERP balances; together with their untransformed projections in `fin_statement_line_status` they are the only four exact exceptions to the DATABASE_INVARIANTS_V1 "no stored balance" textual check (see Compatibility verification).

**Derived classification** (view/query; never mutates `fin_statement_line`):

| Condition | Classification |
|---|---|
| no active `fin_statement_cutover` for the account | `CUTOVER_UNRESOLVED` |
| line is the anchor or before it, per the adapter's frozen ordering rule | `PRE_CUTOVER` |
| line is after the anchor, per the same rule | `POST_CUTOVER` |
| Patagonia only: the line shares the anchor's `value_date` (and is not the anchor), so its same-day order cannot be proven | `CUTOVER_AMBIGUOUS_DAY` |

**Read-model states (owner decision, 2026-10-11).** The status view `fin_statement_line_status` exposes exactly these four states. `CUTOVER_AMBIGUOUS_DAY` is **not reconcilable**: it mirrors the write model, where `fin_match_statement_line` refuses the same case (`CUTOVER_AMBIGUOUS_DAY`); it never counts as `POST_CUTOVER` and does not change any write rule. Only `POST_CUTOVER` is reconcilable. Structurally impossible or indeterminate states (order data missing, account without configuration) are reported as NULL — fail closed, never as `POST_CUTOVER` — and the write model refuses them as well.

**Active matches and cut changes (owner decision, 2026-10-11).** Every active `fin_statement_match` must refer to a statement line that is `POST_CUTOVER` under the active cutover for its financial account. Resolving or superseding a cut is evaluated against the **proposed** anchor: if any line of the account with an active match (not reversed) would not be exactly `POST_CUTOVER` under it — `PRE_CUTOVER`, `CUTOVER_AMBIGUOUS_DAY`, unresolved or indeterminate — the whole operation is refused (`CUTOVER_ACTIVE_MATCH_CONFLICT`) and nothing is written: no partial supersession, no automatic reversal, no history edit. The same check applies to a first cut. The ADMIN reverses the affected matches first, changes the cut, then reconciles again the lines that are `POST_CUTOVER` under the new cut. Reason: a `PRE_CUTOVER` line is already absorbed by the opening balance, so keeping an active match between it and a `financial_posting` would count that money twice (once in the opening balance, once through the matched posting); an ambiguous or indeterminate line cannot keep a match the write model would refuse today. Cut changes and new matches on the same account are serialised, so neither can slip past the other's check.

**The ordering rule is frozen per adapter** after real-file evidence: `BNA_MONTHLY_PDF_V1` in §7.2, `PATAGONIA_STATEMENT_PDF_V1` in §7.3. For any other adapter it is TBD until its own evidence. The position data an ordering rule uses (page, physical row, chain index) lives on the appearance (`fin_import_run_line`), never on `fin_statement_line`.

## 7. Bank statement ingestion

1. ADMIN uses "Importar extracto bancario" in Tesorería: selects a `BANK_ACCOUNT` and the original official bank statement file (no extension assumed); the browser sends account + original bytes to the bank-import Edge Function.
2. The Edge Function verifies the caller is an active ADMIN (fails `FORBIDDEN` otherwise).
3. It computes `file_sha256` over the exact bytes and stores them in `financial-statements` with the service role, under a path derived from account and hash.
4. It runs the detector/importer registered for that account's bank, which yields a non-null `parser_version` in every case, and a `format_code` only when a business format is recognised. Unknown or malformed → see step 5.
5. It parses rows to canonical fields and calls **one** DB function (service role) that, in a single transaction:
   - re-verifies the initiating ADMIN identity passed by the Edge Function;
   - refuses a NULL `parser_version`;
   - if a `NORMAL` run for `(financial_account_id, file_sha256)` that is not `REJECTED` already exists → returns it; writes nothing;
   - if a run with the same `(financial_account_id, file_sha256, mode, parser_version)` exists → returns it; writes nothing;
   - if no business format is recognised → creates a `REJECTED` run with `format_code` NULL, the detector's `parser_version` and `reject_reason`; no line is created;
   - otherwise creates the run (`PARSED`), and for each row computes the fingerprint (DB-side, per the frozen per-format formula) and:
     - fingerprint known for the account → appearance `ALREADY_KNOWN` → existing line;
     - unknown → new `fin_statement_line` + appearance `NEW`;
     - unparseable row → appearance `INVALID` with `raw_row`, no line;
   - sets the counters. No cutover attribute is computed or stored (§6.6).
6. The response reports counters. Import does **not** depend on the account's cut (G-3): lines may be imported while the account is `CUTOVER_UNRESOLVED`. Lines whose derived classification is `POST_CUTOVER` and that have no active match are **pending reconciliation**.
7. Reprocess: the ADMIN selects a `REJECTED` (or `VALIDATED`) run and requests a reprocess. The Edge Function reads the stored object, re-verifies its sha256, and invokes step 5 with the current `parser_version` and `previous_run_id`. The original upload is not repeated.

Distinctions:

| Concept | Identity | Effect of repetition |
|---|---|---|
| File hash | `(financial_account_id, file_sha256)` | same file again after a `PARSED` run → same run, nothing new |
| Processing attempt | `(financial_account_id, file_sha256, mode, parser_version)`, `parser_version` NOT NULL | same attempt again → same run |
| Reprocess | new run with `previous_run_id` | allowed only over `REJECTED` / `VALIDATED` runs, by explicit ADMIN request |
| Line fingerprint | `(financial_account_id, fingerprint)` | same movement in another file → new appearance, same fact |

**No bank adapter (parser + fingerprint) is implemented before the real-file evidence for that bank is frozen (§21).**

### 7.1 Statement formats and adapters

- The abstraction is `BANK_STATEMENT`. The model does not assume CSV, PDF or any other file type; each concrete bank format is handled by one server-side adapter, identified by `format_code` and versioned by `parser_version`.
- **PDF is a valid, first-class statement format.**
- Adapters evidenced today (current examples, not a closed list):

| Adapter (`format_code`) | Official source | Fields observed |
|---|---|---|
| `BNA_MONTHLY_PDF_V1` | BNA monthly statement (PDF) | FECHA, MOVIMIENTOS, COMPROB., DEBITOS, CREDITOS, SALDO; the closing balance carries over as the next period's opening balance |
| `PATAGONIA_STATEMENT_PDF_V1` | Banco Patagonia statement (PDF); periods may span several months | FECHA, CONCEPTO, REFER., FECHA VALOR, DEBITOS, CREDITOS, SALDO; some transfers add a secondary TRANSFERENCIAS RECIBIDAS section |

- Future adapters (for example a CSV export) may be added without changing the conceptual model; each one is frozen with its own real-file evidence.
- **OCR is not a requirement.** The reviewed PDFs contain extractable structured text. A file that would require OCR, or that the frozen adapter cannot parse, fails closed: run `REJECTED`, original bytes kept as evidence, and no ad-hoc parser is improvised.
- Both adapters are frozen (§7.2, §7.3; G-1 and G-2 CLOSED).

**Common canonicalisation (both adapters):**
- `value_date_iso`: `YYYY-MM-DD` (two-digit years read as 20YY; a one-digit day is accepted where the adapter says so).
- `description_norm`: NFKD → ASCII → uppercase → collapse whitespace → trim, exactly as defined below.
- `bank_reference`: preserved as printed text (no zero-stripping); empty string when absent. It must consist only of printable ASCII (U+0020–U+007E) and must have no leading or trailing U+0020; otherwise the row is unclassifiable.
- Amounts and balances: canonical decimal with exactly 2 decimals, `.` as decimal separator, leading `-` for negatives, no thousands separator. Source format: `1.234,56`, with a trailing `-` for negatives; a separate `$` token is ignored.
- Debit → `signed_amount < 0`; credit → `signed_amount > 0`; exactly one of DEBITOS / CREDITOS per economic row, non-zero, unsigned in its column.
- Fingerprint = `sha256` of the fields joined with `\x1f`, in the order the adapter defines. It contains no ordinal, page, row number, `format_code` or `parser_version`.
- Duplicate fingerprint inside the same statement → run `REJECTED` (adapter-specific code below). No ordinal is ever added and no row is chosen arbitrarily.

**Row-level `INVALID` vs adapter contract (precedence).** The generic outcome `INVALID` (§6.3, §17) applies only to adapters whose frozen contract expressly allows it. `BNA_MONTHLY_PDF_V1` and `PATAGONIA_STATEMENT_PDF_V1` do not: any economic or non-control row they cannot classify rejects the whole run (`REJECTED`). `INVALID` remains available to future adapters that allow it explicitly.

**Exact `description_norm`.** The single production authority is the PostgreSQL function `fin_norm_description`; any other implementation (parser, tooling, tests) is non-authoritative and must match it byte for byte. `unaccent` is not used.
1. Apply Unicode NFKD.
2. After NFKD, if any code point in U+0000–U+0008, U+000E–U+001F or U+007F (DEL) is present → the row is unclassifiable (`DESCRIPTION_CONTROL_CHAR`). The only whitespace allowed is U+0009 TAB, U+000A LF, U+000B VT, U+000C FF, U+000D CR and U+0020 SPACE.
3. Remove every code point above U+007F.
4. Map `a`–`z` to `A`–`Z` (ASCII only, locale-independent).
5. Replace every run of the allowed whitespace (U+0009, U+000A, U+000B, U+000C, U+000D, U+0020) with one U+0020 SPACE.
6. Remove leading and trailing U+0020.

**Fingerprint hashing.** PostgreSQL built-in `sha256(bytea)` over the UTF-8 bytes of the canonical string, hex-encoded (lowercase). The canonical string joins the adapter's fields with U+001F; dates as `YYYY-MM-DD`; amounts and balances as `NUMERIC(15,2)` text (2 decimals, `.`, leading `-`); absent values as the empty string. The fingerprint is computed by the database, never by the browser or the parser.

### 7.2 `BNA_MONTHLY_PDF_V1` (frozen — G-1)

Evidence: 12 consecutive official monthly statements (OCT-25 … SEP-26, 314 economic lines) plus 8 re-downloads of 7 of those periods (different bytes, identical content and order): 0 invalid rows, 0 balance-chain errors, 0 fingerprint collisions, closing → next opening continuity on all 11 transitions.

- **Detection (all required):** "BANCO DE LA" + "NACION ARGENTINA"; "RESUMEN DE CUENTA"; `PERIODO: dd/mm/aaaa AL dd/mm/aaaa`; "CUENTA CORRIENTE - PESOS"; account number and 22-digit CBU matching the identifiers expected for the selected `financial_account` (§7.4); column header `FECHA MOVIMIENTOS COMPROB. DEBITOS CREDITOS SALDO` on every page with movements; exactly one `SALDO ANTERIOR` and one `SALDO FINAL`; `<--- FIN DE RESUMEN`.
- **Columns:** assigned by word position relative to the column headers (amount columns by right edge). `bank_reference` = COMPROB.
- **Economic rows:** rows starting with FECHA (`dd/mm/aa`) carrying exactly one amount plus SALDO.
- **Control rows (never economic facts):** `SALDO ANTERIOR`, `SALDO FINAL`, `TRANSPORTE`, `TOTAL GRAV. LEY 25413 …` totals, headers, page/sheet markers and legal text.
- **Fingerprint:**
  `sha256(value_date_iso \x1f description_norm \x1f bank_reference \x1f signed_amount_canonical \x1f running_balance_canonical)`
  - `bank_reference` alone is **not** identity (COMPROB. is shared by a movement and its tax line, and reused across dates).
  - `running_balance` is part of the identity (printed on every line, stable across re-downloads, verified by the chain).
- **Balance chain (mandatory):** `SALDO ANTERIOR + Σ signed_amount` must equal each line's `running_balance`; the last balance must equal `SALDO FINAL`; every `TRANSPORTE` must equal the adjacent balance.
- **Ordering:** the physical order of the PDF defines the intra-day order and is valid only because the balance chain verifies it. Across statements: by period, with continuity `period_from = previous period_to` and `SALDO ANTERIOR = previous SALDO FINAL`. A line is at or before an anchor if its statement is earlier, or it is in the same statement with a chain index ≤ the anchor's. Page, row and chain index are appearance metadata (§6.3).
- **Fail closed (run `REJECTED`):** any detection signal missing; account/CBU mismatch; text not extractable; any unclassifiable row; chain mismatch; last balance ≠ `SALDO FINAL`; `TRANSPORTE` mismatch; a date outside `(period_from, period_to]`; duplicate fingerprint inside the statement; **`REISSUE_SUSPECTED`**: a NEW line equal to an existing line of the account in `(value_date, description_norm, bank_reference, signed_amount)` but with a different `running_balance`.

### 7.3 `PATAGONIA_STATEMENT_PDF_V1` (frozen — G-2, deliberately narrow)

Evidence: 4 official statements (cuts 28/11/25, 27/02/26, 30/06/26, 30/09/26; 6 economic lines) plus 1 re-download (different bytes, identical content): 0 invalid rows, chain closed at every printed balance and at `SALDO ACTUAL`, continuity on all 3 transitions (`SALDO ANTERIOR` date = previous cut date). V1 is limited to this observed shape; a future V2 may widen it only with new evidence.

- **Detection (all required):** Banco Patagonia identification; `ESTADO DE CUENTAS UNIFICADO CLIENTE N°: <n> AL dd/mm/aa <statement id>`; `CUENTA CORRIENTE EN PESOS <account> SUBCTA <s> SUC <branch> CBU: <8> <14>` matching the identifiers expected for the selected `financial_account` (§7.4); header `FECHA CONCEPTO REFER. FECHA VALOR DEBITOS CREDITOS SALDO`; one `SALDO ANTERIOR` (dated `0/00/00` on the first statement) and one `SALDO ACTUAL`.
- **Fields:** FECHA (one-digit day accepted), CONCEPTO → `description_*`, REFER. optional → `bank_reference` or empty, FECHA VALOR optional → date or empty, DEBITOS / CREDITOS, SALDO optional (`running_balance` may be NULL: the bank prints it on the last line of each day only).
- **Control rows:** `SALDO ANTERIOR`, `SALDO ACTUAL`, the account summary table, headers, notices and legal text.
- **Fingerprint:**
  `sha256(value_date_iso \x1f description_norm \x1f bank_reference_or_empty \x1f fecha_valor_iso_or_empty \x1f signed_amount_canonical \x1f running_balance_canonical_or_empty)`
- **Owner rule for ambiguous identity:** two economic lines of the same statement producing the same fingerprint → run `REJECTED` with **`DUPLICATE_CONTENT_IN_STATEMENT`**. No ordinal is added and no row is chosen.
- **Balance chain:** `SALDO ANTERIOR + Σ signed_amount` must equal every printed balance and `SALDO ACTUAL`; `SALDO ANTERIOR` date must equal the previous statement's cut date when that statement exists.
- **TRANSFERENCIAS RECIBIDAS:**
  - never creates a second `fin_statement_line` and never changes the fingerprint;
  - association: same date, `IMP.ORIGINAL` = the main line's positive `signed_amount`, and exactly one candidate on each side;
  - the detail (NOMBRE ORIG, DOC.ORIG., SERVICIO, REFERENCIA, CBU ORIGEN, BANCO, SUC, IMP.ORIGINAL, TI, MON, SUC) belongs to the **appearance** (`fin_import_run_line`), with its raw evidence kept;
  - association not unambiguous → the detail row is kept as an appearance (`IGNORED`, raw detail preserved, no destination) with an explicit review warning **`TRANSFER_DETAIL_UNMATCHED`**; it is never silently discarded. This alone does not reject the statement when the main economic lines are valid and the chain closes.
- **Ordering:** between dates, `value_date`. Within one day the physical order is kept as appearance evidence but is **not** asserted as a verifiable economic order. If a bank cut would need to fall between two movements of the same day and no evidence determines their order, resolution of the cut fails closed. This never blocks import.
- **Fail closed (run `REJECTED`):** any detection signal missing; account/CBU mismatch; text not extractable; any structure not supported by V1 (another account or product section with movements, movement table across pages, unclassifiable row, FECHA VALOR not a date); chain mismatch; `DUPLICATE_CONTENT_IN_STATEMENT`.

### 7.4 Expected bank identifiers (decided — K-1)

Both adapters validate the account number / CBU printed on the statement against identifiers expected for the selected `financial_account`. The real schema of `financial_account` has no field for them (`id`, `nombre`, `account_type`, `activo`, `created_at`), so `financial_account` is not altered.

**Decision (owner, K-1):** identifiers live in a new table `fin_statement_account_config`, one row per bank `financial_account` (`format_code`, `expected_account_number`, `expected_cbu`, `expected_extra`), seeded by migration with these owner-approved values:

| Account | `format_code` | `expected_account_number` | `expected_cbu` | `expected_extra` |
|---|---|---|---|---|
| BNA | `BNA_MONTHLY_PDF_V1` | `5460109893` | `0110546920054601098937` | — |
| Patagonia | `PATAGONIA_STATEMENT_PDF_V1` | `299038195` | `0340299500299038195002` | `subcta = "0"`, `suc = "299"` |

Adapters receive these values as configuration of the selected account and contain none of them.

### 7.5 Implementation gates — PDF extraction and fixtures

- **PDF library:** `unpdf`, pinned to an exact version, subject to a mandatory local parity spike **before** the production parsers are written. The spike runs over every available real statement and must reproduce: BNA 314 and Patagonia 6 economic lines, the same canonical fields, balance chains, fingerprints, and expected rejections / warnings. Without parity, only the text / position reconstruction may be adjusted — never the fingerprint or the frozen contract; if robust parity cannot be reached → STOP.
- **No OCR.**
- **Initial implementation limits** (operational, not part of any fingerprint or contract): 10 MB per file, 20 pages, 10 s extraction timeout. Exceeding a limit → run `REJECTED`.
- **Fixtures:** real bank PDFs are never versioned. Versioned fixtures are only sanitized extracted text items with positions (CUIT, account, CBU, names and other identifiers replaced; geometry and structure preserved). Parity tests over real PDFs run only locally, from a path outside git.

**Gate result (2026-10-11): GO.** Approved library: **`unpdf` 1.8.1** (npm, published 2026-08-13; integrity `sha512-xkURhy2SoGpOIH0a1gLHNkASPIQYonadDJs2AQwPEfUakafeD9EA1WTWWsaR++gfTCXJpV27W7tU1nXuk82UKQ==`; bundles PDF.js 6.1.200; MIT; no dependencies), pinned exactly. Spike: `scripts/adr018/unpdf-parity-spike.mjs` with the synthetic fixtures `scripts/adr018/fixtures/unpdf-synthetic-statements.json`.
- Extraction: text items with position and width (no OCR). Both banks print in a monospaced font, so words are recovered from each item by its own per-character advance; rows are grouped by baseline; columns are assigned relative to the column headers (amounts by the nearest header right edge). Node 24 and Deno 2.9 (the Edge runtime family) produce byte-identical extractions.
- BNA: 20 files (12 monthly OCT-25 … SEP-26 + 8 re-downloads) → 314 economic lines, 0 rejected, balance chains and 12-period continuity exact, re-downloads fingerprint-identical, `description_raw` and every canonical field equal to the frozen G-1 corpus, JS ↔ PostgreSQL `fin_norm_description` / `fin_statement_fingerprint` byte-for-byte.
- Patagonia: 5 files (4 statements + 1 re-download) → 6 economic lines, continuity 0 → 497 → 994 → 1494 → 1994, 4 TRANSFERENCIAS RECIBIDAS details all uniquely associated, none creating a line; same parity results.
- Fail closed: truncated PDF, non-PDF, over size / page limits, unrelated PDFs, wrong adapter and wrong account are rejected.
- Observed maxima: 293 KB, 5 pages, 121 ms extraction, 3.3 ms reconstruction — far inside 10 MB / 20 pages / 10 s.
- Clarification of the BNA control rows (§7.2, no rule change): the economic table ends at `SALDO FINAL`; the statement totals block that follows (`TOTAL …` lines and their continuation lines such as `- INTERESES $ …` or `REINTEGRO GRAV. LEY 25413 … $ …`) is control. A date-led, economic-shaped row after `SALDO FINAL` is unclassifiable and rejects the run.

## 8. Bank reconciliation

- Cardinality: **1 `fin_statement_line` ↔ 1 active `financial_posting`.**
- Integrity (enforced by the DB function):
  - the posting belongs to the chosen `financial_operation`;
  - the posting's `financial_account_id` equals the line's;
  - `posting.signed_amount = line.signed_amount` exactly;
  - the account has an active `fin_statement_cutover` and the line's derived classification is `POST_CUTOVER` (`PRE_CUTOVER` and `CUTOVER_UNRESOLVED` lines are not reconcilable);
  - neither the line nor the posting has another active match.
- Dates are **not** an integrity rule. The UI may propose candidates within a date window; that window is a search aid only.
- An active match is valid only while its line is `POST_CUTOVER` under the account's active cut; a cut change that would break this is refused (§6.6), never resolved by reversing matches automatically.
- Reversal: ADMIN, with mandatory reason; sets the reversal fields; the line becomes pending again. Nothing is deleted; the original line is never mutated.
- A line with no existing operation stays pending. This ADR creates no operation from a bank line; any operation is registered through the existing RPCs (transfer, cheques, supplier payment, `register_bank_tax`, …) and then matched.

## 9. Mercado Pago completeness flow

### 9.1 Flow (NORMAL mode, only after G-4)

1. The scheduler invokes the MP report-ingest Edge Function daily for the previous Buenos Aires day.
2. It requests/downloads the official Liberaciones report, stores the bytes in `financial-statements`, and creates `fin_import_run` (`MP_RELEASE_REPORT`, `mode = 'NORMAL'`, hash, coverage, non-null `parser_version`). If a non-rejected `NORMAL` run with the same hash exists for the MP account → no-op. If the same bytes were previously captured in `VALIDATION` mode, the new run links to it through `previous_run_id`.
3. Each row is inserted as `mp_source_record` `csv_import` (existing uniqueness deduplicates overlaps) and recorded as `fin_import_run_line` (`NEW` / `ALREADY_KNOWN`).
4. RPC 40 processes each row with its **current** logic (unchanged).
5. For each row that is `DESCRIPTION = 'payment'`, **inbound** (direction C in the `SOURCE_ID:DESCRIPTION:direction` identity), with a valid numeric `SOURCE_ID`, not IGNORED by ADR-017, and whose `('payment', SOURCE_ID, 'APPROVAL', '')` is **not yet claimed**, the ingest calls the new service-role back-fill function, which registers one `mp_webhook_delivery` with `origin = 'report_backfill'`, `report_source_id` = that row, and a deterministic key per `SOURCE_ID`.
6. The worker fetches `GET /v1/payments/{SOURCE_ID}` → S4 `api_payment` snapshot → RPC 40 → `mp_transition_identity` → A1 `mp_apply_transition` → `financial_operation` + `financial_posting` + `mp_reconciliation`. Unchanged.

### 9.2 Cases

| Case | Behaviour |
|---|---|
| APPROVAL already claimed (webhook/API first) | no back-fill; report row stays `DEFERRED_V4` as evidence; no effect |
| GET fails temporarily | normal worker retry policy |
| GET fails permanently (404, foreign collector, …) | delivery `FAILED_PERMANENT`; exception visible (§15); **no report fallback** |
| Pre-cutover payment | the API snapshot's `date_approved < cutover_at` → IGNORED by ADR-017; a row with report `DATE` < `cutover_at` is already IGNORED and never back-filled |
| Outbound payment (direction D) | parked `DEFERRED_V4`; no back-fill |
| `SOURCE_ID` missing or not numeric | RPC 40 records ERROR (identity); no back-fill; review |
| Unknown `DESCRIPTION` | RPC 40 records `ERROR UNKNOWN_DESCRIPTION`; fail closed; review |
| `yield` | current REPORT_ONLY behaviour, unchanged |
| `payout` | current behaviour, never auto-posted, unchanged |

### 9.3 MP report validation mode and rollout

**Validation mode** (`fin_import_run.mode = 'VALIDATION'`) implements CAPTURE EVIDENCE → VERIFY → CHANGE. It:
- downloads/captures the real official report;
- keeps the original bytes in `financial-statements` and records the hash;
- validates format and parser, producing a `VALIDATED` or `REJECTED` run with a non-null `parser_version`;
- records every row as `fin_import_run_line` `CAPTURED` (or `INVALID`) with its exact `raw_row`, so `DESCRIPTION` values and structure can be inspected.

Validation mode does **not**:
- insert `mp_source_record`;
- execute RPC 40;
- normalize movements;
- enqueue back-fills;
- claim any transition;
- create `financial_operation` or `financial_posting`;
- produce any financial effect.

It is invoked on demand only (never by the scheduler).

**Rollout:**
1. Capture one real report in validation mode.
2. The owner reviews the observed `DESCRIPTION` values and the structure against the current parser.
3. Only after the owner's GO:
   - that same report may be processed in `NORMAL` mode (a new run over the stored bytes, `previous_run_id` = the validation run, no re-download);
   - the production scheduler may be enabled.

## 10. ADR-006 amendment (minimal)

| Clause | Current text / state | Amended by ADR-018 |
|---|---|---|
| ADR-006 §8 "Flow" step 4 | RPC 40 enqueues the back-fill for an inbound unclaimed payment row | The back-fill is enqueued by the **report ingestion** through a **new function callable only by `service_role`**. RPC 40 is not modified and keeps parking payment rows `DEFERRED_V4`. |
| ADR006_IMPLEMENTATION_ORDER_V1, V-4 gate row ("back-fill" listed as gated) and step 19 ("inbound-only back-fill") | back-fill opens only with V-4 | **Only** the back-fill of **inbound** report `payment` rows is enabled outside V-4. It creates no money: it only requests the API snapshot. |

Still gated by V-4 (unchanged):
- `mp_normalize_report_fallback` for payment rows;
- the report ↔ API payment match (MATCHED / DISCREPANCY for payments);
- MISSING_IN_REPORT for payments;
- any money created directly from a report `payment` row.

`mp_v4_verified()` stays false; V-4 is not enabled by this ADR.

`mp_register_delivery` is **not** widened to accept `report_backfill`; a dedicated function is used so the origin, the `report_source_id` link, the inbound check and the "not yet claimed" check live in one place.

Safety argument: the back-fill only produces an `api_payment` snapshot; the transition is claimed once in `mp_transition_identity` (first claimant wins), so a report-triggered fetch can never duplicate a webhook-triggered one.

## 11. Security and permissions

- Upload statements, request a reprocess, and capture an MP report in validation mode: **ADMIN only**. Reconcile / reverse: **ADMIN only**. Register / supersede a bank cut (`fin_statement_cutover`): **ADMIN only**, audited. OPERATOR: no change, no new grant, no read access to the new tables or bucket.
- Authorization is checked twice: in the Edge Function, and again in the DB function that performs the sensitive write.
- New DB functions are `SECURITY DEFINER`, owned by `postgres`, `REVOKE ALL FROM PUBLIC, anon`; the import and back-fill functions are granted to `service_role` only; the reconciliation functions to `authenticated` and refuse non-ADMIN.
- Tables: RLS enabled; SELECT for ADMIN; no direct INSERT/UPDATE/DELETE for any API role; writes only through the functions.
- Bucket `financial-statements`: private; **no INSERT/UPDATE/DELETE policy for `authenticated`**; writes by `service_role` only; ADMIN reads via signed URL. Separate from ADR-008's `purchase-attachments`.
- The MP access token and the scheduler invoke secret stay in Edge Function secrets / Vault, as in 0056; never in migrations, git or logs.

## 12. Idempotency

| Level | Key | Guarantee |
|---|---|---|
| File | `(financial_account_id, file_sha256)` among non-rejected `NORMAL` runs | the same bytes are effectively processed at most once; a `PARSED` run is never reprocessed |
| Attempt | `(financial_account_id, file_sha256, mode, parser_version)`, with `parser_version` NOT NULL (also for unrecognised formats) | repeating the same attempt returns the existing run |
| Reprocess | `previous_run_id` → `REJECTED` / `VALIDATED` run of the same hash | explicit, ADMIN-initiated, auditable; previous runs untouched |
| Bank fact | `(financial_account_id, fingerprint)` | overlapping files never duplicate a fact |
| Appearance | `(run_id, row_number)` | each row of each run recorded once |
| MP report row | `mp_source_record (source_type, external_id)` | unchanged |
| MP back-fill | deterministic delivery key per `SOURCE_ID` + "APPROVAL not claimed" check | at most one back-fill request per payment |
| MP money | `mp_transition_identity` + `financial_operation.external_ref` | unchanged; first claimant wins |
| Reconciliation | one active match per line and per posting | no double reconciliation |

## 13. Evidence retention and immutability

- Original bytes are kept in `financial-statements` for the life of the system; the normal flow never deletes them. A reprocess reuses the stored object and never overwrites it.
- Every `fin_import_run` is immutable once its transaction commits, including `REJECTED` and `VALIDATED` runs. `fin_import_run_line` and `fin_statement_line` are immutable after their import transaction (guard triggers, following `mp_source_record`).
- The history of attempts over the same bytes is the chain of `previous_run_id`.
- `fin_statement_match` is append-only; only the reversal fields may be set, once.
- `fin_statement_cutover` is never edited in place; a correction supersedes the active row, and both remain.
- No cutover decision, before or after it is taken, mutates `fin_statement_line`.

## 14. Cutover rules

- **MP:** unchanged; `mp_cutover_boundary` (ADR-017) is the only authority.
- **Banks:** `cutover_at` (2026-10-04 19:00 -03:00) is **not** assumed to define which bank lines are included in the opening balances. The per-account bank cut is resolved from the statements used to build the opening balances (BNA 335 713; Patagonia 1 994), identifying the last line included in each, recorded as `fin_statement_cutover.cutoff_statement_line_id` (§6.6).
- The cut does **not** gate import: statements may be imported as evidence first, precisely to identify that last line.
- Until the cut of an account is resolved (§21 G-3), its lines are `CUTOVER_UNRESOLVED` and **not reconcilable**. Once resolved, the derived classification (`PRE_CUTOVER` / `POST_CUTOVER`) follows the adapter's frozen ordering rule (G-1 / G-2); only `POST_CUTOVER` lines are reconcilable.
- Changing a resolved cut never invalidates an existing reconciliation silently: if a line with an active match would stop being `POST_CUTOVER` under the proposed anchor, the change is refused (§6.6); the matches are reversed explicitly first.

## 15. Observability

Read-only views/queries (no change to the MP state machine):
- runs by account, mode and status, with counters, reject reasons, parser version and the `previous_run_id` chain;
- bank lines by account and derived cutover classification (`CUTOVER_UNRESOLVED` / `PRE_CUTOVER` / `POST_CUTOVER`), and pending (`POST_CUTOVER`, unmatched) lines by age;
- the active `fin_statement_cutover` per account and its supersession history;
- appearances flagged for review, including `TRANSFER_DETAIL_UNMATCHED`, and runs rejected with `REISSUE_SUSPECTED` or `DUPLICATE_CONTENT_IN_STATEMENT`;
- bank statement closing balance (when the format carries one) vs Σ postings on the account (information, not a rule);
- MP report payment coverage, classifying each inbound report `payment` row:

| Report row | Condition | Classification |
|---|---|---|
| `DEFERRED_V4` | APPROVAL claimed (webhook or back-fill) | **COVERED** (OK) |
| `DEFERRED_V4` | not claimed, back-fill pending/retrying | **IN_PROGRESS** |
| `DEFERRED_V4` | not claimed, back-fill `FAILED_PERMANENT` | **EXCEPTION** |
| `IGNORED` (ADR-017) | — | **PRE_CUTOVER** |
| `ERROR` | — | **EXCEPTION** |

`DEFERRED_V4` by itself is **not** an operational error.

## 16. Invariants

1. Importing a **bank** statement never creates money.
2. A Mercado Pago report `payment` row never creates payment money directly in this phase; payment money is created only from `api_payment`.
3. Non-payment MP report classes (`yield`, `payout`) keep exactly their existing semantics; this ADR adds no effect to them and removes none.
4. A bank statement line is evidence, not an accounting operation.
5. No report payment fallback while V-4 is false (`mp_v4_verified()` stays false).
6. Original files are immutable evidence.
7. Re-importing the same file is idempotent.
8. Overlapping statements preserve multiple appearances without duplicating the economic fact.
9. Bank reconciliation does not mutate the original line.
10. Reconciliation history is not deleted.
11. OPERATOR receives no new financial permissions.
12. Unknown formats/descriptions fail closed.
13. No implementation of a bank adapter before real-file evidence is frozen.
14. Line identity is computed server-side; the browser is never an authority for parsing or identity.
15. A match links a line to exactly one posting of the same account with an exactly equal signed amount.
16. RPC 40 and `mp_register_delivery` are unchanged by this ADR.
17. A run in `VALIDATION` mode produces no `mp_source_record`, no RPC 40 execution, no back-fill, no claim, no operation, no posting and no other financial effect.
18. A `REJECTED` or `VALIDATED` run is never modified; a reprocess creates a new run over the same stored bytes, and a `NORMAL` `PARSED` run is never reprocessed.
19. Every `fin_import_run` has a non-null `parser_version`, including runs where no business format was recognised (`format_code` NULL); attempt idempotency depends on it.
20. Whether a bank line is pre- or post-cutover is never stored on `fin_statement_line`; it is derived from the account's active `fin_statement_cutover` and the adapter's frozen ordering rule.
21. Only `POST_CUTOVER` lines are reconcilable; `PRE_CUTOVER` and `CUTOVER_UNRESOLVED` lines are not. An unresolved cut never blocks import.
22. `fin_statement_cutover.cutoff_statement_line_id` belongs to the same `financial_account`; at most one active cut per account; cut decisions are audited and superseded, never edited.
23. No bank fingerprint contains a row ordinal, page or row number; two economic lines of one statement with the same fingerprint reject the run. Page, row, chain index and secondary detail are appearance metadata, never `fin_statement_line` data.
24. Every active `fin_statement_match` refers to a statement line that is `POST_CUTOVER` under the active cutover for its financial account. Resolving or superseding a cut that would break this fails atomically (`CUTOVER_ACTIVE_MATCH_CONFLICT`); matches are never reversed automatically.

## 17. Failure handling (fail closed)

| Failure | Behaviour |
|---|---|
| caller not ADMIN | `FORBIDDEN`; nothing stored |
| unknown bank format / header mismatch | run `REJECTED` with reason, `format_code` NULL and the detector's non-null `parser_version`; bytes kept; no lines; reprocessable when a compatible parser exists |
| `parser_version` missing | refused; no run written |
| single row unparseable | adapters whose contract allows it: appearance `INVALID` with `raw_row`, other rows proceed, the run surfaces the count; `BNA_MONTHLY_PDF_V1` / `PATAGONIA_STATEMENT_PDF_V1`: run `REJECTED` (§7.1–§7.3) |
| description with a forbidden control character after NFKD (`DESCRIPTION_CONTROL_CHAR`) or `bank_reference` not printable ASCII | row unclassifiable → handled as the row above |
| anchor whose `running_balance` is NULL or differs from `opening_balance` | cut registration refused; G-3 stays OPEN |
| file for the wrong bank (format not registered for the account's bank) | `REJECTED` |
| DB function fails mid-import | the whole transaction rolls back (no run, lines or appearances); stored bytes are re-used on retry (same hash path) |
| reprocess requested over a `PARSED` `NORMAL` run | refused (`ALREADY_PROCESSED`) |
| reprocess: stored object's sha256 differs from the run's | refused (`EVIDENCE_INTEGRITY`); nothing written; escalated |
| reprocess with an already-attempted `(mode, parser_version)` | returns the existing run |
| bank cut unresolved for the account | import allowed as evidence; lines `CUTOVER_UNRESOLVED`; reconciliation refused (`CUTOVER_UNRESOLVED`) |
| reconciliation of a `PRE_CUTOVER` line | refused (`PRE_CUTOVER_LINE`) |
| cut anchor on a line of another account, or a second active cut for the account | refused; nothing written |
| balance chain does not reconcile (BNA, Patagonia) | run `REJECTED` |
| BNA line equal on `(value_date, description_norm, bank_reference, signed_amount)` to an existing line but with a different balance | run `REJECTED` (`REISSUE_SUSPECTED`) |
| duplicate fingerprint inside one statement | run `REJECTED` (Patagonia: `DUPLICATE_CONTENT_IN_STATEMENT`) |
| Patagonia structure not supported by V1 | run `REJECTED` |
| Patagonia transfer detail not unambiguously associated | appearance `IGNORED` with raw detail and review warning `TRANSFER_DETAIL_UNMATCHED`; the run is not rejected for this alone |
| bank cut would fall between same-day Patagonia movements of unverifiable order | cut resolution refused; import unaffected |
| proposed cut (first or superseding) under which a line with an active match would not be `POST_CUTOVER` | refused (`CUTOVER_ACTIVE_MATCH_CONFLICT`); nothing written; the active cut and the matches stay as they were |
| MP report download fails | no run; retried on next schedule; surfaced in health |
| unknown MP `DESCRIPTION` / missing `SOURCE_ID` | RPC 40 ERROR; no back-fill; review |
| MP back-fill permanent failure | `FAILED_PERMANENT`; EXCEPTION in §15; no fallback |
| reconciliation integrity violation (account, amount, operation, duplicate active match) | refused with a specific error; nothing written |

## 18. Explicit non-goals

- V-4 enablement; `mp_v4_verified()` stays false.
- Account Money report (V-3).
- Report fallback for payment rows.
- N:M reconciliation.
- Automatic rules for bank tax, fees or commissions.
- Automatic creation of `financial_operation` from bank lines.
- Smart/automatic matching.
- Retiring or disabling the webhook.
- Any change to `yield` / `payout` semantics.
- Redesign of Tesorería.

## 19. Conceptual implementation dependency order

```
ADR-018 ACCEPTED
 → core evidence model (fin_import_run, fin_import_run_line, fin_statement_line, fin_statement_match, fin_statement_cutover + immutability guards)
 → security & storage (RLS, grants, bucket financial-statements)
 ├→ bank branch: G-1/G-2 CLOSED (adapters frozen, §7.2/§7.3); identifiers in fin_statement_account_config (§7.4); parsers only after the unpdf parity spike (§7.5)
 │    → bank import DB function + Edge Function (detector/parser, versioned) + reprocess   [not gated by G-3]
 │    → cutover classification view + cut-registration function
 │    → G-3 per account: owner registers fin_statement_cutover from the imported evidence
 │    → reconciliation functions (POST_CUTOVER only) + health views
 │    → UI: Tesorería "Extractos" (upload, runs, reprocess, pending lines, match/reverse)
 └→ MP branch: report-ingest Edge Function (VALIDATION mode first)
      → G-4 validation run on one real report, owner GO
      → NORMAL mode + back-fill function (service role) + coverage view → scheduler
 → validation (§20) → owner GO per branch
```

Migration numbers are assigned at implementation; no step modifies an applied migration.

## 20. Validation requirements

- Offline/test-branch tests for each invariant in §16, including:
  - the same file twice → one run;
  - overlapping files → one fact, two appearances;
  - an `INVALID` row keeps `raw_row` and has no destination;
  - a non-ADMIN caller is refused at the Edge Function and at the DB function;
  - OPERATOR has no access to the tables or the bucket;
  - a match is refused on a wrong account, an unequal amount, a posting outside the chosen operation, or a second active match;
  - reversal keeps the history.
- Bank cut:
  - an import into an account without a cut succeeds and its lines read `CUTOVER_UNRESOLVED`;
  - reconciliation of `CUTOVER_UNRESOLVED` and `PRE_CUTOVER` lines is refused;
  - registering or superseding a cut changes no `fin_statement_line` row;
  - a cut anchored on another account's line, or a second active cut, is refused;
  - the cut decision is audited.
- Attempt identity:
  - a run without `parser_version` is refused;
  - an unrecognised file is recorded `REJECTED` with `format_code` NULL and a non-null `parser_version`;
  - repeating that attempt returns the same run.
- Reprocess:
  - a `REJECTED` run followed by a new parser version → a new run with `previous_run_id`; the rejected run is unchanged and the lines are created once;
  - a repeated reprocess with the same parser version → the same run;
  - a reprocess over a `PARSED` run → refused;
  - a tampered stored object → `EVIDENCE_INTEGRITY`.
- MP:
  - an inbound unclaimed payment row → exactly one `report_backfill` delivery;
  - already claimed → none; outbound → none; pre-cutover → none;
  - repeated ingestion → no new delivery;
  - a permanent failure → EXCEPTION, no money;
  - `mp_v4_verified()` remains false.
- MP validation mode:
  - after a validation run there are zero new rows (counted before and after) in `mp_source_record`, `mp_webhook_delivery`, `mp_transition_identity`, `mp_financial_movement`, `financial_operation` and `financial_posting`;
  - `CAPTURED` lines carry `raw_row`;
  - a later `NORMAL` run over the same bytes links to it through `previous_run_id`.
- Per bank: parser and fingerprint tested on the sanitized real files of G-1/G-2, including the overlap case and re-downloads (same content, different bytes → `ALREADY_KNOWN`); BNA: `REISSUE_SUSPECTED` and in-statement duplicate rejection; Patagonia: `DUPLICATE_CONTENT_IN_STATEMENT`, `TRANSFER_DETAIL_UNMATCHED` kept with raw detail, unsupported structure rejected.
- Production: read-only verification first; writes only with the owner's GO.

## 21. STOP / rollout gates

| Gate | Blocks | Evidence required |
|---|---|---|
| **G-1 BNA statements** — **CLOSED** (2026-10-10) | — (adapter `BNA_MONTHLY_PDF_V1` frozen, §7.2: format, parser contract, fingerprint, ordering rule, control rows, fail-closed rules) | 12 official monthly statements OCT-25 … SEP-26 + 8 re-downloads; 314 lines, 0 chain errors, 0 collisions, full continuity |
| **G-2 Patagonia statements** — **CLOSED** (2026-10-10, narrow V1) | — (adapter `PATAGONIA_STATEMENT_PDF_V1` frozen, §7.3, limited to the observed shape; anything else fails closed) | 4 official statements (cuts 28/11/25 … 30/09/26) + 1 re-download; 6 lines, chain and continuity closed; owner rule `DUPLICATE_CONTENT_IN_STATEMENT` |
| **G-3 Bank cut per account** — **OPEN** (both accounts) | the `fin_statement_cutover` decision and, therefore, `PRE_CUTOVER` / `POST_CUTOVER` classification and reconciliation for that account. **Does not block import.** | **BNA:** SEP-26 closing = 738 024,01 vs opening target 335 713; no anchor line exists yet; requires official evidence after 30/09/26. **Patagonia:** last available statement closes at 1 994 = opening target 1 994; anchor candidate = the last economic line of 01/09/26 leaving balance 1 994; not closed until it is officially shown that no movement occurred after it up to the bank cut. Owner decision in both cases. |
| **G-4 MP report rollout** | `NORMAL` processing of MP reports and the production scheduler | one real official report captured in **validation mode** (§9.3) with zero financial effect verified; observed `DESCRIPTION` values and structure confirmed against the parser; owner GO |

This ADR is accepted with these gates open; only the dependent parts are blocked.

## 22. Consequences / tradeoffs

- **Positive:** MP completeness without trusting report amounts for payments; bank evidence with full lineage; no change to frozen money paths; overlap-safe, idempotent ingestion; rejected files recoverable without losing their history.
- **Cost:** report `payment` rows remain `DEFERRED_V4` indefinitely; completeness is read from the coverage view, not from `mp_report_match`, until V-4.
- **Cost:** reconciliation is manual and 1:1; combined debits (one bank line for several operations) stay pending until N:M is decided.
- **Cost:** a run is an attempt, not a file; the file's identity is the hash plus its `previous_run_id` chain. Two columns (`mode`, `previous_run_id`) avoid a separate file/attempt table.
- **Risk:** bank statement formats may change. This is mitigated by the non-null `parser_version`, fail-closed validation, reprocess and the preserved original bytes.
- **Growth:** the RPC inventory and the SECURITY DEFINER set both grow; this ADR declares the growth explicitly.

---

## Compatibility verification

**Real conflicts amended explicitly by this ADR:**
- ADR-006 §8 step 4: the enqueuer of the back-fill changes from RPC 40 to the report ingestion via a new service-role function (§10).
- ADR006_IMPLEMENTATION_ORDER_V1, V-4 gate row and step 19: the inbound report-payment back-fill moves outside V-4. Fallback, the payment match and payment MISSING_IN_REPORT stay gated (§10).
- RPC_CONTRACTS_V1 (inventory 52) and the SECURITY DEFINER set (69): they grow by the new functions, declared as with ADR-011 … ADR-016.
- DATABASE_INVARIANTS_V1 invariants 5 / 6 / 7 / 27 ("no stored balance"; "derived values are never stored"): their textual verification rejects any public column named like a balance. Owner decisions (2026-10-10, extended 2026-10-11): exactly four (relation, column) pairs are explicit, narrow compatibility exceptions to that textual check — see "External bank balance evidence" below. DATABASE_INVARIANTS_V1 stays FROZEN and is not edited.

**External bank balance evidence (owner decision, 2026-10-10):**
- `public.fin_statement_line.running_balance` is immutable **external evidence**: the balance printed by the bank on the statement line (§6.2, §7.2, §7.3). It is not the computed balance of any `financial_account` and is never used as an authoritative ERP balance.
- `public.fin_statement_cutover.opening_balance` is **evidence of the owner's cutover decision**; by K-4 (§6.6) it must equal the anchor line's `running_balance`. It does not replace or take part in the ordinary computation of any ERP balance.
- The authoritative, operational balance of every `financial_account` remains derived exclusively from `financial_posting` (DATABASE_INVARIANTS_V1 invariant 6), unchanged.
- Read-model projections (owner decision, 2026-10-11): `public.fin_statement_line_status.running_balance` is the untransformed projection of `fin_statement_line.running_balance`, and `public.fin_statement_line_status.opening_balance` is the untransformed projection of the active `fin_statement_cutover.opening_balance`. The view stores nothing; these columns are not new derived or stored values.
- The exception is exact per relation and column, limited to these four pairs: (`fin_statement_line`, `running_balance`), (`fin_statement_cutover`, `opening_balance`), (`fin_statement_line_status`, `running_balance`), (`fin_statement_line_status`, `opening_balance`). No other column — named `balance`, `running_balance`, `opening_balance`, `saldo` or anything else matching the check, on any other table or view, belonging to a `fin_*` relation, introduced by this ADR, or holding any other evidence — is exempted; any such column still fails the invariant check.

**Compatible without change:**
- **ADR-006:** all other clauses, including §5.1 atomic application (payout is never auto-applied), §6 real-time flow, §7 idempotency, §8 steps 1–3 and 5–7, and `yield` REPORT_ONLY.
- **ADR-003:** Liberaciones remains the only report layout; D1 parser unchanged.
- **ADR-008:** `purchase-attachments` is untouched; the new bucket has its own perimeter.
- **ADR-011:** `register_bank_tax` is unchanged; bank-tax lines are reconciled against its operations, never auto-created.
- **ADR-017:** `mp_cutover_boundary` is the only MP authority; RPC 40's guard is unchanged; validation mode inserts no `mp_source_record`, so the guard is not exercised; banks do not reuse `cutover_at` as their cut.
- **ADR006_V4_DIRECTION_CORRECTION:** back-fill is restricted to inbound rows; outbound rows never back-fill.
