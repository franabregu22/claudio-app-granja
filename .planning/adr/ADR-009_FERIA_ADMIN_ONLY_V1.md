# ADR-009 — Feria is ADMIN-only in V1

**STATUS:** **ACCEPTED** (owner decision D-F27F-1, 2026-09-30). Implemented by migration `0059_feria_admin_only.sql` and by the FROZEN amendments listed in §5 (each marked **[ADR-009]**).
**DATE:** 2026-09-30
**RAISED BY:** Phase 27 slice F27-F. The frozen contracts let OPERATOR record Feria goods movements (RPC 31 `register_session_movement`), while the frozen RLS gives OPERATOR no product catalogue (RLS §6: "OPERATOR needs no product catalogue in V1"). An OPERATOR movement was therefore accepted by the database but could not be offered by any screen.
**AFFECTS (FROZEN):** RPC_CONTRACTS_V1 (RPC 31 actor and body, inventory row 31), RLS_IMPLEMENTATION_SPEC_V1 (§8 Feria). The Phase 21 backend suite checks that encoded the OPERATOR permission.
**NOT AFFECTED:** RPCs 30, 32, 33 (already ADMIN-only); `products` and `price_history` RLS (unchanged: OPERATOR still has no product catalogue); every table, column, grant and policy; the SECURITY DEFINER set (62); the general ADMIN / OPERATOR role model.

---

## 1. Decision (owner, D-F27F-1)

1. **Feria is ADMIN-only in V1.** Opening a session, recording goods movements, cash events, the Feria cash count / reconciliation and closing are ADMIN actions.
2. **OPERATOR has no Feria capability in V1.** No Feria screen and no Feria mutation. It performs no fiscal action either (fiscal was already ADMIN-only).
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

## 4. What stays as frozen (deliberately not changed by 0059)

- The OPERATOR SELECT policies on `sales_session` (OPEN sessions) and `sales_session_movement` (movements of OPEN sessions), RLS §8. The owner restricted the migration to RPC 31 ("do not grant or revoke unrelated table access"). They give OPERATOR no mutation. The V1 frontend exposes no Feria screen to OPERATOR.
- `products` / `price_history` RLS: unchanged. The policy definitions were compared before and after 0059.

## 5. Amended FROZEN documents

| Document | Amendment **[ADR-009]** |
|---|---|
| `RPC_CONTRACTS_V1.md` | header amendment line; RPC 31 actor (ADMIN) and the guard in its body; inventory row 31 actor ADMIN. |
| `RLS_IMPLEMENTATION_SPEC_V1.md` | header amendment line; §8 Feria paragraph: OPERATOR records no Feria movement in V1. |

## 6. Verification

- `scripts/target-db/feria.test.mjs` (Phase 21 suite, amended):
  - C0: OPERATOR, assigned or not, is refused by RPC 31 and nothing is written;
  - C1–C7: ADMIN movements;
  - C3: OPERATOR with a valid call is refused;
  - G9: OPERATOR reads no Feria audit;
  - H2: OPERATOR is refused before the period check;
  - J2 / J3: the concurrency races run between two ADMIN sessions.
- `tests/integration/f27f-feria-fiscal.test.ts`: ADMIN opens, moves goods, records cash events, counts and closes. OPERATOR is refused on RPCs 30–33 and on every fiscal RPC. OPERATOR still reads no product and no price.
- `tests/unit/f27f-feria-fiscal.test.ts` and `target-foundation.test.ts`: the Feria and Fiscal modules are not exposed to OPERATOR.
