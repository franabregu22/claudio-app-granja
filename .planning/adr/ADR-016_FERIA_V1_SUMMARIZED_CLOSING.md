# ADR-016 — Feria V1 summarized closing

**STATUS:** **ACCEPTED** (owner decisions D-FER-1…5, "OWNER DECISIONS — FERIA V1 SIMPLIFIED CLOSING", 2026-10-01). Implemented by migration `0070_feria_summary_closing.sql`; part of the "Phase 27 acceptance fixes". **The owner has not yet accepted the flow manually**, so CUTOVER_READY is not declared.
**DATE:** 2026-10-01
**RAISED BY:** the owner walkthrough. The product-line Feria flow (dispatch, returns, individual expenses, withdrawals, counts, product-line close) does not match how the Feria is actually run. The paper / spreadsheet worksheet is the detailed record, and the app should keep only the summarized closing.

**AFFECTS (FROZEN):**
- TARGET_ARCHITECTURE_V2_FROZEN Part 16 (amendment note);
- ADR-009 (the closing RPCs are ADMIN-only too);
- RPC_CONTRACTS_V1: the new RPC 51 `close_feria_summary` and RPC 52 `rectify_feria_closing`; the inventory grows 50 → 52;
- POSTGRES_SCHEMA_SPEC_V1:
  - the new table `sales_session_closing`;
  - `products.is_system`;
  - the seeded system product and expense category;
- RLS_IMPLEMENTATION_SPEC_V1: the ADMIN-only `sales_session_closing` and the bucket `feria-worksheets`;
- DATABASE_INVARIANTS_V1: new invariant 33;
- ADR-004 / PHASE_24 P&L: the "Gastos de Feria" source and the new line "Diferencia de caja";
- PHASE_25_REPORTING: the new view `report_feria_closing`;
- the SECURITY DEFINER set (+2, 67 → 69).

**NOT AFFECTED:**
- RPCs 30–33 and the three Feria tables: unchanged; their history stays readable.
- RPC 1 `deliver_order`, RPC 2 `rectify_delivered_order` and RPC 4 `register_collection`: unchanged; RPCs 51 and 52 call them.
- The ADR-006 Mercado Pago pipeline: unchanged. It stays the only authority for MP money.
- Identified wholesale orders: they remain normal commercial orders.

---

## 1. What is stored (D-FER-1 / D-FER-3 / D-FER-4)

`sales_session_closing` holds one row per closing version, with these inputs stored exactly as entered:

| Input | Notes |
|---|---|
| `cash_sales` | Ventas en efectivo; optional, default 0 |
| `mp_sales` | Ventas por Mercado Pago; optional, default 0 |
| `transfer_sales` | Ventas por transferencia bancaria; optional, default 0 |
| `opening_float` | "Fondo inicial"; default 0 |
| `expenses` | Gastos de Feria, one aggregate amount |
| `counted_cash` | Efectivo contado |
| `merma` | optional |
| `notes` | optional |
| `cash_account_id` | physical cash destination |
| `transfer_account_id` | required only when `transfer_sales > 0` |
| `expense_category_id` | always "Gastos de Feria" |
| worksheet metadata | optional |

**Derived values are never stored** (invariant 27). `report_feria_closing` and the P&L compute them, and RPC 51 / 52 compute them only for their own postings and return values:
- `total_sales = cash_sales + mp_sales + transfer_sales`
- `expected_cash = opening_float + cash_sales − expenses`
- `cash_difference = counted_cash − expected_cash` (negative = shortage, positive = overage)

React never computes any of these.

**No product detail.** The sale is one aggregated CONSUMIDOR FINAL pedido with one line:
- the line uses the internal system product **"Venta Feria (resumen)"** (`products.is_system = true`);
- quantity 1, price = `total_sales`;
- delivered on the Feria date through RPC 1.

The frontend filters `is_system` products out of every product list, so the owner never sees or picks the system product. If `total_sales = 0`, no pedido is created.

## 2. Effects of one closing version (RPC 51)

| Part | Effect |
|---|---|
| Sales | **VENTAS_NETAS once**, through the delivered pedido above |
| Cash | RPC 4 collection, CASH, of `cash_sales` into the selected physical destination |
| Transfer | RPC 4 collection, TRANSFER, of `transfer_sales` into the selected transfer account. It never goes through physical cash. |
| Mercado Pago | **No manual collection.** The MP part stays a CONSUMIDOR FINAL receivable, settled only by the ADR-006 allocation. No duplicate revenue and no duplicate money. |
| Expenses | One SESSION_CASH operation, −`expenses` on the physical destination. P&L: once, from the closing row, under its category's class ("Gastos de Feria" = INDIRECT). |
| Difference | One ADJUSTMENT operation, ±`cash_difference` on the physical destination (none when 0). P&L: once, on the dedicated line **"Diferencia de caja"**. It is never sales, an ordinary expense or a withdrawal. |
| Float | **No posting.** The float is taken from the physical destination and returned to it; it only enters `expected_cash` and is never revenue. |

**Net effect on the physical destination:**
- cash collection + expenses + difference = `cash_sales − expenses + cash_difference = counted_cash − opening_float`;
- with the float back in the account, it holds exactly the counted cash. **The counted cash is the authority.**

The destination account defaults to an active CASH account named "Caja Chica" when one exists, and is selectable. Mercado Pago is refused as a destination (`CASH_ACCOUNT_INVALID`).

**Guards:**

| Rejected case | Error |
|---|---|
| Caller is not ADMIN | `FORBIDDEN` |
| Session is not OPEN | `SESSION_ALREADY_CLOSED` |
| Session already has granular cash events (never mix the two modes) | `LEGACY_CASH_EVENTS_PRESENT` |
| Negative amounts, or more than 2 decimals | `INVALID_AMOUNT` |
| `transfer_sales > 0` without an account | `TRANSFER_ACCOUNT_REQUIRED` |
| Invalid worksheet metadata | `INVALID_WORKSHEET` |
| Closed period | `assert_period_open` |

The audit is written as `sales_session_closing CLOSE`.

In the UI, "Cierre de Feria" for a new date opens the session with RPC 30 (no opening-fund event, because the float is a closing input) and then calls RPC 51. A retry with the same form key reuses the session that a failed attempt opened.

## 3. Rectification (RPC 52)

- ADMIN only, mandatory reason, open period, only the current version.
- **Original immutable.** The previous row only stops being current. The new row (`version_seq + 1`, `supersedes_id`, `rectification_reason`) becomes effective.

Treasury is compensated by the backend, never by deleting or updating rows:

| Previous effect | Compensation |
|---|---|
| Each collection | a `client_ledger` REVERSAL (with `reversal_of_id`), plus an ADJUSTMENT posting of the opposite amount on its account |
| The expense | an opposite ADJUSTMENT posting |
| The difference | an opposite ADJUSTMENT posting |

After the compensation, the new values are applied exactly as in RPC 51.

Sales are corrected through RPC 2 `rectify_delivered_order`: one system line with the new total, used only when the total changed. If the previous total was 0, a pedido is created and delivered.

P&L and reports read **current versions only**, so nothing is counted twice.

**Worksheet:**
- every version keeps its own worksheet metadata, so the previous file stays as history;
- `p_keep_worksheet` (default true) carries the previous file forward when no new one is given.

## 4. Worksheet (D-FER-5)

The worksheet is optional, strongly recommended in the UI, and never blocks a closing. There is no OCR.

Private bucket `feria-worksheets`, following the ADR-008 pattern:

| Rule | Value |
|---|---|
| `public` | false |
| Size limit | 10 MB |
| Allowed types | PDF / JPEG / PNG / WebP |
| Policies on `storage.objects` | 3, all `TO authenticated` and ADMIN-only through `current_app_role()`: SELECT, INSERT (only in the caller's own `auth.uid()` folder), DELETE |
| Access | signed URL only; no public URL; no UPDATE policy |

Files are **never** stored in `purchase-attachments`.

The client (`src/target/feriaWorksheet.ts`):
1. uploads under `<uid>/<uuid>.<ext>`;
2. calls RPC 51 / 52 with the metadata;
3. if the call fails, deletes the uploaded object and rethrows the original error. A failed cleanup is reported with the object key only.

## 5. P&L ("Gastos de Feria", "Diferencia de caja")

`pnl_line_item` gains two sources, both reading the current `sales_session_closing` version:
- the aggregate expense, under its category's class, described as "Gastos de Feria";
- the bucket `DIFERENCIA_CAJA` (`counted − expected`; no row when 0).

`pnl_summary` keeps every column name and its order, appends the column `diferencia_caja`, and includes it in `resultado_operativo` and every subtotal after it. The cascade becomes:

```
Ventas netas devengadas − Costos directos − Costos indirectos ± Diferencia de caja = Resultado operativo …
```

The float has no P&L effect. MP revenue comes only from the summarized pedido, and an ADR-006 allocation adds no revenue.

## 6. Primary UI (V1)

**"Cierre de Feria" form:**

| Group | Fields |
|---|---|
| Main | Fecha, Ventas en efectivo, Ventas Mercado Pago, Ventas por transferencia, Gastos de Feria, Efectivo contado, Destino del efectivo |
| Conditional | Cuenta de las transferencias (only when transfer > 0) |
| Attachment | Planilla (optional) |
| "Más datos" | Fondo inicial (default 0), Merma, Notas; plus Lugar for a new date |

After a successful submit, the screen shows the **backend-returned** total sales, expected cash and cash difference, plus the counted cash entered.

**History** comes from `report_feria_closing`. For each closing it shows:
- the date and every amount;
- expected, counted and difference;
- the destinations, merma and notes;
- whether a worksheet is attached (opened by signed link);
- the status and version, previous versions, and the reason.

**Hidden from the primary UI:**
- dispatch / return / loss / adjustment;
- individual expenses, withdrawals and transfers;
- the opening-fund event;
- the standalone count;
- the product-line closing form.

RPCs 30–33 and their data remain. Sessions closed with the detailed flow are listed read-only.

## 7. Verification

- **`scripts/target-db/feria_summary.test.mjs` (45 checks).** Every scenario runs in one rolled-back transaction.
  - inventory;
  - closing variants: cash-only, MP-only, transfer-only, mixed, float 0 / non-zero, expenses, exact count, shortage, overage, treasury = counted, selectable destination, all-zero, merma / notes / worksheet;
  - validation;
  - rectification: original preserved, reason, superseded, compensation, P&L effective values, report versions, from zero, worksheet history, ledger reversals;
  - P&L summary;
  - security: OPERATOR / anon / direct write;
  - Storage: bucket, policies, folder isolation, OPERATOR;
  - legacy readability.
- **`tests/integration/adr016-feria.test.ts`**, against the local stack and the real Storage API:
  - close with worksheet;
  - signed URL;
  - public URL, anon and OPERATOR refused;
  - compensation;
  - MIME and size limits;
  - OPERATOR refused;
  - rectification with treasury compensation and worksheet history;
  - P&L delta.
- **`tests/unit/adr016-feria-summary.test.ts`**:
  - contract arguments;
  - no derived value sent;
  - idempotent retry;
  - system product filter;
  - worksheet validation and compensation;
  - signed access;
  - no arithmetic in the UI;
  - granular actions absent.
