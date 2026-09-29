# MASTER ROADMAP — Granja Santo Tomás V1

**AUTHORITY:** This document is the authority on **phase sequence and project state**.

It is **not** a technical authority. It does not define schema, contracts, security or invariants, and
it never overrides `TARGET_ARCHITECTURE_V2_FROZEN.md` or the five FROZEN documents of Fase 9. When this
document and a technical authority appear to disagree about *what* the system does, the technical
authority wins; this document only says *in what order* work happens and *where the project stands*.

**No dates. No durations. No effort estimates.** Phases advance on exit criteria, never on a calendar.

---

## CURRENT PROJECT STATE

| | |
|---|---|
| **Current phase** | **27 — Frontend V1 Integration** (PENDING start; its Mercado Pago screens wait for ADR-006 step 14, the frontend contract over the now-FROZEN ADR-006 backend) |
| **Last completed phase** | 26 — Migration Rehearsal |
| **Architecture** | FROZEN |
| **Physical design** | FROZEN |
| **Implementation design** | FROZEN |
| **Production implementation started** | **NO** |
| **ADR-006 (Mercado Pago real-time)** | Steps 0–13 of ADR006_IMPLEMENTATION_ORDER_V1 COMPLETE in the local test environment; **ADR-006 backend contract FROZEN** (as reached by steps 0–13: integrated regression and current-target clean-cutover compatibility CT-1…CT-5 passed). Step 14 (Phase 27 MP frontend contract) next; steps 15–20 keep their own gates (V-3 / V-4 not implemented, `mp_v4_verified()` = false, no Account Money parser). Production untouched |

Nothing has been created in the production Supabase project. Construction so far (Phases 13–25: Foundations, Commercial, Treasury, Cheques / eCheqs, Purchases / Suppliers, Production, Classification, Feed, Feria, Fiscal, Mercado Pago Definitive, P&L / Management, Dashboard / Reports) exists only in the local test environment of Phase 12. No data has been migrated. The
existing system remains the operating system of record and is untouched.

**Process note (traceability):** Repository history currently lacks committed baselines for Phases 10–25, so historical diffs across those phases are not fully reconstructable from git. From Phase 26 onward, preserve auditable checkpoints before materially changing existing artifacts.

---

## AUTHORITATIVE DOCUMENTS

| Document | Authority over | Status |
|---|---|---|
| `TARGET_ARCHITECTURE_V2_FROZEN.md` | **Architecture.** Domains, business rules, economic semantics, period rules, rejected designs. | FROZEN — changes require an ADR |
| `implementation-design/POSTGRES_SCHEMA_SPEC_V1.md` | **Physical schema.** 54 tables, 28 enums, keys, constraints, indexes. | FROZEN |
| `implementation-design/RPC_CONTRACTS_V1.md` | **Transactional contracts.** 42 RPCs (RPC 42 added by ADR-001): signatures, authorization, period guards, ledger consequences, idempotency. | FROZEN |
| `implementation-design/RLS_IMPLEMENTATION_SPEC_V1.md` | **Security model.** Role resolution, privilege perimeter, policies, safe views. | FROZEN |
| `implementation-design/DATABASE_INVARIANTS_V1.md` | **Invariants.** 28 guarantees with named enforcement mechanisms. | FROZEN |
| `implementation-design/IMPLEMENTATION_DEPENDENCY_ORDER_V1.md` | **Build order inside the schema.** Creation sequence of enums, tables, constraints, security, RPCs. | FROZEN |
| `ADR-006-MP-REALTIME-INGESTION-RECONCILIATION.md` | **Mercado Pago real-time ingestion and report reconciliation.** Amends ADR-003 (D1, D2, D3, D7, D8), RPC 41 (one guard), and the `client_ledger` COLLECTION provenance (RPC_CONTRACTS_V1 §4, schema Domain D). Frozen files are not rewritten; the ADR prevails where they differ. | ACCEPTED 2026-09-27 — **IN IMPLEMENTATION** (local test environment only): ADR006_IMPLEMENTATION_ORDER_V1 steps 0–13 complete (target migrations 0047–0056; implementation notes in `implementation-design/ADR006_IMPLEMENTATION_NOTES.md`; step-13 gate: `scripts/regression/clean-cutover-current-target.mjs`, `scripts/regression/adr006-matrix.test.mjs` and every target-db suite green). **Backend contract FROZEN** as reached by steps 0–13. V-2 verified; V-3 / V-4 evidence partial and not implemented (steps 16 / 19 pending; `mp_v4_verified()` = false). Step 14 next; steps 14–20 pending |
| `MASTER_ROADMAP.md` (this file) | **Phase sequence and project state.** | LIVE — updated as phases close |

### Not authoritative

| Document | Why |
|---|---|
| `FASE_9_COMPLETION_PASS_3_REPORT.md` | Historical audit report. States "NOT READY" as of its own date. Superseded. |
| `FASE_9_INTEGRATED_CORRECTION_PASS_4_FINAL_REPORT.md` | Historical correction report. Its counts (29 RPCs, 35 tables) were superseded by the FROZEN documents (42 RPCs after ADR-001, 54 tables). |
| `TARGET_ARCHITECTURE_GAP_ANALYSIS.md`, `TARGET_ARCHITECTURE_REVIEW_ROUND_2.md`, `TARGET_ARCHITECTURE_REVIEW_ROUND_3_FINAL.md`, `PHYSICAL_DATABASE_DESIGN_ROUND_2_REVIEW.md` | Research and review passes that fed the frozen documents. Historical. |
| Any other report in `.planning/` | Point-in-time analysis. Read for context, never cited as a current rule. |

**Rule:** a historical report is evidence of what was thought at its date, never a statement of what
is true now. If a report contradicts a FROZEN document, the FROZEN document is correct.

---

## SCOPE SEPARATION — READ THIS BEFORE PHASE 13

`IMPLEMENTATION_DEPENDENCY_ORDER_V1.md` defines the **technical order of construction inside the
schema**: which enums precede which tables, which constraints follow, where the deferred cyclic FKs
go, and in what order the 42 RPCs are created. That is a dependency graph, **not** the project
roadmap.

The project is **not** delivered by creating 54 tables and only then testing everything. From phase 13
onward the system is built and validated in **vertical slices**: a slice takes one business flow end to
end — schema, RPCs, RLS, and verification of its real consequences — before the next slice starts.

The dependency order still governs *within* each slice: a slice never creates a table whose FK targets
do not yet exist, and it never attaches a policy before `current_app_role()` exists.

### Vertical slices

**Slice 1 — Commercial cycle (phase 14)**
`cliente → pedido → entrega → cuenta corriente → cobro → cuenta financiera`
Exercises: `clients`, `pedidos`, `pedido_lineas`, `client_ledger`, `collections`,
`financial_operation`, `financial_posting`; RPCs 1–4; the delivery/rectification period guard.

**Slice 2 — Supplier cycle (phase 17)**
`proveedor → compra → cuenta corriente proveedor → pago → cuenta financiera`
Exercises: `suppliers`, `purchases`, `purchase_line`, `purchase_attachment`, `supplier_ledger`,
`financial_operation`, `financial_posting`; RPCs 13–15; the required attachment and the
per-supplier invoice scoping.

**Slice 3 — Productive cycle (phase 18)**
`galpón → lote → producción → mortalidad → métricas`
Exercises: `sheds`, `flocks`, `operator_assignments`, `daily_production`, `population_events`;
RPCs 18–22; OPERATOR authorization and the one-current-mortality-per-date rule.

A slice is finished when its flow runs end to end, its ledger consequences reconcile, its invariants
hold, and its RLS behaves correctly for ADMIN and OPERATOR.

---

## PHASE SEQUENCE

Legend: **COMPLETE** — finished. **FROZEN** — finished and sealed; reopening requires an ADR.
**PENDING** — not started.

### Discovery and design — closed

| # | Phase | Status | Exit criteria (met) |
|---|---|---|---|
| 0 | Current System Audit | COMPLETE | Existing system, data and real operation documented. |
| 1 | Functional Discovery | COMPLETE | Business operation captured as it actually happens. |
| 2 | Functional Model | COMPLETE | Functional requirements modelled. |
| 3 | Conceptual Model | COMPLETE | Entities and relationships defined conceptually. |
| 4 | Logical Model | COMPLETE | Logical model derived, independent of engine. |
| 5 | Current → Target Mapping | COMPLETE | Every current concept mapped to a target concept or explicitly dropped. |
| 6 | Architectural Red Team | COMPLETE | Adversarial review executed; findings resolved or explicitly rejected. |
| 7 | Architecture Freeze V2 | **FROZEN** | `TARGET_ARCHITECTURE_V2_FROZEN.md` sealed. Zero open architectural blockers. |
| 8 | Physical Database Design | **FROZEN** | Engine-level design decided: key strategy, types, constraint strategy, RLS strategy, transaction boundaries. |
| 9 | Implementation Design | **FROZEN** | Five documents sealed: 54 tables, 28 enums, 41 RPCs, 28 invariants, build order. Cross-document consistency verified mechanically. |

### Pre-construction — current

| # | Phase | Status | Exit criteria |
|---|---|---|---|
| 10 | Security / RLS Validation | **COMPLETE** | Closed with 8/8 checks PASS — see `PHASE_10_SECURITY_RLS_VALIDATION.md`. Validated: one business-role mechanism, SERVICE_ROLE separated from business roles, no period-sensitive fact table writable outside an RPC, no privilege-escalation path, cost data unreachable by OPERATOR, every SECURITY DEFINER function hardened. Two documentary contradictions (F-1, F-2) were found and resolved without changing behaviour, permissions or data authority; no ADR was required. |
| 11 | Migration Strategy | **COMPLETE** | Closed with `MIGRATION_STRATEGY_V1.md` as the artefact. Per-entity strategy defined for every target entity with an explicit method; opening balances specified for client ledger, supplier ledger and the four financial accounts, with the either-opening-or-history rule that prevents double counting; lineage defined as `(source_system, source_entity, source_id, import_batch)` plus the frozen idempotency keys; idempotency and rerun rules defined; gaps and validation checks enumerated. No data was migrated and Supabase was not modified. OD-1, OD-2 and OD-3 remain decisions required **before a migration run** — they do not block the closure of the strategy. |
| 12 | Safe Test Environment | **COMPLETE** | Closed with `SAFE_TEST_ENVIRONMENT_V1.md` as the artefact. A disposable Supabase local environment was started and verified (PostgreSQL 17.6 on `127.0.0.1:54322`, with the `auth`/`storage` schemas and the `anon`/`authenticated`/`service_role` roles the frozen model needs). Fail-closed guardrails executed 35/35. A real `pg_dump` backup was taken, the data destroyed, and a real `psql` restore recovered the canary rows exactly. `supabase db reset` destroyed and rebuilt the environment twice, each time returning to the verified baseline. Production was not contacted and the remote project-ref was not used. Tooling exists for the legacy schema snapshot and for read-only profiling, both pending P-4. F-12-2 is MITIGATED as local hardening, not as demonstrated LAN isolation; F-12-1 is DEFERRED. Neither affects isolation from production, which is this phase's exit criterion. |

### Construction — vertical slices

Each phase in this block builds its own tables, RPCs and policies, then validates its flow end to end.
No phase in this block may start before 10, 11 and 12 are closed.

| # | Phase | Status | Exit criteria |
|---|---|---|---|
| 13 | Foundations | **COMPLETE** | Enums, identity (`perfiles`), `management_period`, `audit_events`, `operator_assignments`, the shared masters, `current_app_role()`, the privilege perimeter, and the seed data listed in the dependency order. Period guard demonstrably blocks a write into a CLOSED period. |
| 14 | Commercial | **COMPLETE** | **Slice 1** runs end to end. Order total derives from current lines. Delivery creates the client ledger movement and no posting. Rectification reverses the *current* version and is correct across repeated passes. |
| 15 | Treasury | **COMPLETE** | `financial_account`, `financial_operation`, `financial_posting`, transfers. Account balance equals the sum of postings. A transfer posts exactly twice with opposite signs, atomically, and does not affect results. |
| 16 | Cheques / eCheqs | **COMPLETE** | Received and issued lifecycles complete. Reception reduces client debt without touching the bank; only clearing credits it; endorsement reduces supplier debt and leaves the client paid; every rejection path compensates according to the stage actually reached. |
| 17 | Purchases / Suppliers | **COMPLETE** | **Slice 2** runs end to end. Liability recognised at `economic_date` on the global supplier account. Attachment mandatory. Payments unallocated to invoices. Freight recognised once and allocated without double counting; landed cost derives correctly. |
| 18 | Production | **COMPLETE** | **Slice 3** runs end to end. Population derives from initial population plus current events. One current mortality per flock per date, with rectification. OPERATOR limited to assigned flocks and to correcting its own production. |
| 19 | Classification | **COMPLETE** | Sessions with graded lines, multiple sessions per day, no flock reference and no invented traceability. |
| 20 | Feed | **COMPLETE** | Formula versions immutable once used; manufacturing references the exact version; consumo interno derives from the stock equation; consumo teórico derives from the curve. No per-flock real consumption is stored. |
| 21 | Feria | **COMPLETE** | Sessions with physical movements and cash management; one aggregated retail Pedido per session; identified clients keep their own Pedidos; reconciliation surfaces variances without inventing correspondence. |
| 22 | Fiscal | **COMPLETE** | Fiscal documents with tax components at snapshotted rates, obligations, installments and payments — without duplicating any economic operation. |
| 23 | Mercado Pago Definitive | **COMPLETE** | Raw source immutable, normalization, amount-assigned reconciliation to internal operations. Legacy MP retired or left read-only. |
| 24 | P&L / Management | **COMPLETE** | Results derived from authoritative source facts, never stored. Financial movements are not income/expense by themselves. Transfers are excluded from results. Costs are not double-counted against purchases. Drill-down reaches source facts. |
| 25 | Dashboard / Reports | **COMPLETE** | Reporting reads derived values only, respects RLS, and exposes no cost data to OPERATOR. |

### Transition to production

| # | Phase | Status | Exit criteria |
|---|---|---|---|
| 26 | Migration Rehearsal | **COMPLETE** | The migration runs end to end in the test environment against a realistic copy. Discrepancies explained, not silently reconciled. Repeatable. |
| 27 | Frontend V1 Integration | PENDING | Frontend operates against the target schema for the V1 business flows and reporting surfaces, respects ADMIN/OPERATOR permissions, and contains no duplicated business/accounting authority. *(Inserted by ADR-005.)* Mercado Pago screens wait until the ADR-006 backend contract is implemented and frozen; they consume its two status axes (MP reconciliation; optional client attribution). |
| 28 | Integral QA | PENDING | All slices exercised together. Invariant queries return their expected results. No cross-domain contradiction. |
| 29 | UAT | PENDING | The owner validates real operation against real expectations, on migrated data, in the test environment. |
| 30 | Cutover Rehearsal | PENDING | The full cutover sequence rehearsed, including rollback. Rollback proven, not assumed. |
| 31 | Cutover | PENDING | Pre-cutover validation checklist below fully passed, then the switch. |
| 32 | Hypercare | PENDING | Live operation monitored; incidents resolved; balances re-verified after real use. |
| 33 | V1 Project Close | PENDING | Hypercare closed with no open critical issues. V1 delivered. |

---

## PRE-CUTOVER VALIDATION CHECKLIST (PHASE 31 GATE)

Cutover does not proceed until every item is validated. This is a minimum, not a maximum.

- [ ] **Financial account balances** — each account's balance equals the sum of its postings and matches the real-world balance.
- [ ] **Client current accounts** — each client's balance equals the sum of its ledger movements and matches the validated opening balance plus subsequent movement.
- [ ] **Supplier current accounts** — same, per supplier.
- [ ] **Cheques / eCheqs, issued and received** — every instrument in a state consistent with its real situation; portfolio and pending debits reconcile.
- [ ] **Flock population** — derived population matches the real count per flock.
- [ ] **Productive data** — production, mortality, weighings and temperature records complete for the migrated window.
- [ ] **Mercado Pago** — raw source complete, normalized, and reconciled to internal operations without invented correspondence. ADR-006 §11 cutover gates pass (webhook URL switched with the legacy writer disabled in the same step; end-to-end real payment POSTED; MP opening balance validated against the Account Money report; no open FAILED_PERMANENT, DISCREPANCY or ERROR after the boundary; Account Money parser accepted or interim Liberaciones completeness accepted by the owner).
- [ ] **Pending orders** — every open Pedido carried over correctly, with its lines and prices.
- [ ] **RLS / permissions** — ADMIN, OPERATOR and SERVICE_ROLE behave as specified against real data; no period-sensitive table writable outside an RPC.
- [ ] **Backup and restore** — a backup taken and restored successfully, verified by reading real data back.

---

## AFTER CUTOVER

The previous system becomes **read-only**. It is retained as historical evidence and is never written
to again. No dual-write period, no partial operation across both systems.

---

## RULES

1. **Exit criteria, not calendar.** A phase closes when its criteria are met. There are no dates or
   durations in this document and none should be added.
2. **FROZEN means frozen.** A frozen phase reopens only on a real contradiction that blocks progress,
   and only through an explicit ADR. Convenience, simplification and hindsight are not reasons.
3. **No production implementation before its prerequisites close.** No table is created in production
   before phases 10, 11 and 12 are closed and the owning slice's phase has begun.
4. **Vertical slices, not a big-bang schema.** Build and validate one business flow at a time. Never
   create the full schema and defer validation to the end.
5. **The dependency order is internal.** `IMPLEMENTATION_DEPENDENCY_ORDER_V1.md` orders objects inside
   the schema; it does not define, reorder or replace project phases.
6. **Only one authority per question.** Architecture → the frozen architecture. Physical and
   implementation detail → the five frozen Fase 9 documents. Sequence and state → this file.
7. **This file is updated when a phase closes,** by changing its status and the CURRENT PROJECT STATE
   block. Phase content is not rewritten to match what happened.

---

**PHASE SEQUENCE AUTHORITY — 34 PHASES (0–33) · CURRENT: 27 — FRONTEND V1 INTEGRATION (PENDING START)**
