# 0130 — Revertir pago de un gasto sin proveedor (owner 2026-11-17)

Owner: «un gasto pagado puedo revertirlo a pendiente de pago». Scope chosen by the owner: **expenses without a registered supplier**
(21 paid at registration + 1 pending-expense payment in production). Supplier invoices keep their circuit (later delivery).

## Two cases, one RPC `reverse_expense_payment(p_purchase_id, p_payment_operation_id, p_reason, p_idempotency_key)`

| Case | Today | After the reversal |
|---|---|---|
| AT_REGISTRATION | current version `paid_operation_id = op` (register_casual_purchase) | new purchase version (`RECTIFY:<old>:v<n>`, copy of lines / attachments / freight_allocation, `paid_operation_id NULL`) + `expense_payable(root, amount = total)` → a normal pending expense |
| PAYABLE_PAYMENT | `expense_payable_payment(financial_operation_id = op)` | the payment is reversed: `expense_payable_paid()` excludes reversed payments |

Both: ADJUSTMENT operation `EXPENSE-PAYMENT-REVERSAL:<op>` on the ORIGINAL date, ONE posting `+amount` on the original account (the
money is back); `expense_payment_reversal` row (immutable, RLS ADMIN SELECT); audit_events `REVERSE_PAYMENT`. P&L untouched (accrual).

## Guards (before any write)
ADMIN · reason · idempotency key (same key → replay, other → ALREADY_REVERSED) · advisory lock per operation · current version, no
supplier, not annulled · the operation is that expense's payment (case decided by the data) · paying account CASH / BANK_ACCOUNT (Mercado
Pago never) · the payment posting not matched with a bank statement line (BANK_MATCHED) · PAYABLE_PAYMENT not linked to a payment-plan
item (PAYMENT_IN_PLAN) · period of the original date open (assert_period_open).

## Readers changed
- `expense_payable_paid(uuid)`: excludes reversed payments (every caller follows: views fin_expense_payables, pay_pending_expense,
  annul_expense, rectify_purchase_details, assign_payable_to_supplier).
- `fin_movement_class`: `EXPENSE-PAYMENT-REVERSAL:%` → kind PAGO, label «Reversión de pago».
- `fin_cash_flow`: the reversal is an EGRESO of the same expense (nets in its category, not «otros movimientos»).
- `expense_payable_supplier_link`: BEFORE INSERT guard refuses a payable with reversed payments (PAYMENT_REVERSED) — its
  paid_before copies payments.

## Frontend
«Revertir pago» in Todas las operaciones → Acciones, on the payment row of an expense without supplier paid in cash / bank;
confirmation with an optional reason (default «Revertir pago»).
