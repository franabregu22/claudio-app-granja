# ADR-009 — Feria is ADMIN-only in V1 (including reads)

**STATUS:** **ACCEPTED** (owner decision D-F27F-1, 2026-09-30). Implemented by migrations `0059_feria_admin_only.sql` (writes) and `0060_feria_admin_only_reads.sql` (reads, owner follow-up) and by the FROZEN amendments listed in §5 (each marked **[ADR-009]**).
**DATE:** 2026-09-30
**RAISED BY:** Phase 27 slice F27-F. The frozen contracts let OPERATOR record Feria goods movements (RPC 31 `register_session_movement`), while the frozen RLS gives OPERATOR no product catalogue (RLS §6: "OPERATOR needs no product catalogue in V1"). An OPERATOR movement was therefore accepted by the database but could not be offered by any screen.
**AFFECTS (FROZEN):** RPC_CONTRACTS_V1 (RPC 31 actor and body, inventory row 31), RLS_IMPLEMENTATION_SPEC_V1 (§8 Feria). The Phase 21 backend suite checks that encoded the OPERATOR permission.
**NOT AFFECTED:** RPCs 30, 32, 33 (already ADMIN-only); `products` and `price_history` RLS (unchanged: OPERATOR still has no product catalogue); every table, column and grant; every policy outside Feria (0060 only drops the two OPERATOR Feria read policies and removes the Feria entity from the OPERATOR audit policy); the SECURITY DEFINER set (62); the general ADMIN / OPERATOR role model.

---

## 1. Decision (owner, D-F27F-1)

1. **Feria is completely ADMIN-only in V1, including reads.** Opening a session, recording goods movements, cash events, the Feria cash count / reconciliation and closing are ADMIN actions, and only ADMIN reads Feria sessions, movements, cash events, Feria audit rows and the Feria reconciliation (`report_feria_session_cash`).
2. **OPERATOR has no Feria capability in V1**: no Feria screen, no Feria mutation and no Feria read. It performs no fiscal action either (fiscal was already ADMIN-only).
3. **The OPERATOR permission on RPC 31 is superseded.** RPC 31 now starts with the standard guard `IF current_app_role() <> 'ADMIN' THEN RAISE 'FORBIDDEN: ADMIN required'`, like RPCs 30 / 32 / 33. It is enforced in the backend, not only hidden in the frontend.
4. **No OPERATOR product-catalogue access is required**, and none is granted. The option of an OPERATOR `products` SELECT policy was rejected.
5. **A dedicated Feria role** (for example a Feria manager) may be designed later. It is not part of V1.

## 2. Audit of the Feria write perimeter (before 0059)

| Function | Writes | Role check before 0059 | After 0059 |
|---|---|---|---|
| RPC 30 `open_sales_session` | `sales_session`, opening-fund cash event and operation | ADMIN | ADMIN |
| RPC 31 `register_session_movement` | `sales_session_movement` | any active role | **ADMIN** |
| RPC 32 `register_session_cash_event` | `sales_session_cash_event`, operation, postings | ADMIN | ADMIN |
| RPC 33 `close_sales_session` | `sales_session`, aggregated `pedidos` / `pedido_lineas` (via RPC 1) | ADMIN | ADMIN |

No other function writes `sales_session`, `sales_session_movement` or `sales_session_cash_event`. The audit was verified mechanically against the live catalogue: every function whose definition inserts into or updates those tables.

## 3. Migration 0059 (minimal)

`CREATE OR REPLACE FUNCTION register_session_movement(...)` with the body of 0033 and a single behavioural change: the ADMIN guard is the first statement, replacing the plain `current_app_role()` lookup. Owner and EXECUTE grants are kept by `CREATE OR REPLACE`. There is no schema, table, grant or policy change.

## 4. Feria read surfaces (owner follow-up: migration 0060)

The first version of this ADR kept the frozen OPERATOR SELECT policies on OPEN sessions and their movements. The owner then required that Feria be ADMIN-only for reads too. Audit of every Feria read surface exposed to API roles, and the final visibility:

| Surface | Before 0060 (OPERATOR) | Change in 0060 | Final ADMIN | Final OPERATOR |
|---|---|---|---|---|
| `sales_session` | OPEN sessions (`sales_session_operator_select`) | policy dropped | all | none |
| `sales_session_movement` | movements of OPEN sessions (`sales_session_movement_operator_select`) | policy dropped | all | none |
| `sales_session_cash_event` | none | — | all | none |
| `report_feria_session_cash` (`security_invoker` view) | none in practice (reads through the tables above) | follows the tables | all | none |
| `audit_events` rows of entity `sales_session_movement` | its own rows (`audit_events_operator_own`) | entity removed from the policy (re-created with the same name; other entity types unchanged) | all | none |
| `report_sales_line`, `pnl_line_item` (reference `sales_session`) | none (ADMIN-only via pedidos / P&L RLS) | — | all | none |

Unchanged: `authenticated` keeps SELECT privilege on the three Feria tables (RLS returns no row to OPERATOR). `products` / `price_history` RLS is unchanged, as is every policy outside Feria (public and storage policies compared before and after 0060).

## 5. Amended FROZEN documents

| Document | Amendment **[ADR-009]** |
|---|---|
| `RPC_CONTRACTS_V1.md` | header amendment line; RPC 31 actor (ADMIN) and the guard in its body; inventory row 31 actor ADMIN. |
| `RLS_IMPLEMENTATION_SPEC_V1.md` | header amendment line; §5 `audit_events_operator_own` without the Feria entity; §8 Feria: OPERATOR read policies dropped, the paragraph states "completely ADMIN-only, including reads"; §10 coverage matrix rows for `sales_session` / `sales_session_movement`. |

## 6. Verification

- `scripts/target-db/feria.test.mjs` (Phase 21 suite, amended):
  - C0: OPERATOR, assigned or not, is refused by RPC 31 and nothing is written;
  - C1–C7: ADMIN movements;
  - C3: OPERATOR with a valid call is refused;
  - G9: OPERATOR reads no Feria audit;
  - H2: OPERATOR is refused before the period check;
  - J2 / J3: the concurrency races run between two ADMIN sessions.
- `scripts/target-db/feria.test.mjs` after 0060: G1 / G2 OPERATOR sees no session and no movement; G3b `report_feria_session_cash` returns no row to OPERATOR; G6 exact Feria policies (ADMIN only); G9b the OPERATOR audit policy lists no Feria entity; O1 ADMIN-only visibility during the session.
- `tests/integration/f27f-feria-fiscal.test.ts`: ADMIN opens, moves goods, records cash events, counts and closes. OPERATOR is refused on RPCs 30–33 and on every fiscal RPC, and reads no session, movement or reconciliation row. OPERATOR still reads no product and no price.
- `tests/unit/f27f-feria-fiscal.test.ts` and `target-foundation.test.ts`: the Feria and Fiscal modules are not exposed to OPERATOR.
