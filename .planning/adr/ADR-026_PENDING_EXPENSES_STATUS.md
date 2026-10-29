# ADR-026 — Gastos pendientes: estado de cierre técnico

Estado: **validado funcionalmente en producción** (owner, 2026-10-29).

Decisión del owner: un gasto pendiente figura en resultados en su categoría desde el registro y no mueve Caja / Bancos hasta pagarse;
el pago (total o parcial) es un único movimiento real. Sin cheques / eCheqs desde WhatsApp; sin crear proveedores.

## Producción

| Migración | Contenido | Ledger |
|---|---|---|
| 0106 `0106_pending_expenses.sql` | `expense_payable` / `expense_payable_payment`, `register_pending_expense`, `pay_pending_expense`, regla "pagada O pendiente", borradores WhatsApp `PENDING_EXPENSE` | 106 / 0106 |
| 0107 `0107_pending_expense_commit_check.sql` | la verificación diferida de la regla corre como su dueño (fix W-0003: `USER_NOT_FOUND_OR_INACTIVE` al confirmar desde WhatsApp) | 107 / 0107 |

Validación productiva: W-0004 (Factura A 0002-00006527, $177.023, IVA $30.723) — una compra, una factura, una obligación sin pagos,
comprobante vinculado, ningún movimiento de Caja / Bancos, sin duplicados. W-0003 cancelado sin registros.

## Observación pendiente (decisión separada, NO corregida)

La compra registrada guarda `amount_net` = $177.023 (igual al total) mientras el neto gravado de la factura es $146.300.
Mismo comportamiento que el circuito de gastos pagados (`wa.dispatch_0102`: `coalesce(net, total)` cuando el borrador no trae neto);
`pnl_line_item` toma `amount_total` de la compra. Definir si el Estado de Resultados debe reflejar el neto (con el IVA solo como crédito
fiscal) requiere una decisión sobre el modelo de IVA y Estado de Resultados antes de cambiar código o datos.
