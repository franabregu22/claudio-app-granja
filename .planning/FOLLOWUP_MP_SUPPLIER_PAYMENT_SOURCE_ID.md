# FOLLOW-UP — Mercado Pago supplier payments without SOURCE_ID linkage

**STATUS:** OPEN — must be resolved (or explicitly accepted by the owner) before META A is declared fully closed.
**RAISED:** 2026-10-15, ADR-019 §10 / owner GO "IMPLEMENT ADR-019 + MP CLASSIFICATION 0088/0089" item 13.
**OWNER OF THE DECISION:** owner (it changes how supplier payments by Mercado Pago are entered).

## Risk

`pay_supplier` (Cuentas a pagar → Pagar proveedor, method MERCADOPAGO, account Mercado Pago) creates a `SUPPLIER_PAYMENT`
operation with a posting on the Mercado Pago account **without** referencing the MP payout / outflow SOURCE_ID that
evidences the money leaving Mercado Pago.

The same outflow can later appear in Caja → Saldos → Mercado Pago → Actividad Mercado Pago as an unclassified payout
("Clasificar salida") and be classified again (Compra / gasto, Retiro de socios, transfer). Result: the Mercado Pago
balance is lowered twice for one real outflow, and the expense / payment may be counted twice.

ADR-019 closes this gap for casual purchases only: `register_casual_purchase` refuses Mercado Pago money without a
SOURCE_ID and classifies the SOURCE_ID exactly once (`mp_outflow_classification`, `mp_reconciliation`). Supplier payments
by Mercado Pago from Cuentas a pagar are NOT covered.

## Proposed direction (not implemented)

Apply the same single gateway to supplier payments paid from the Mercado Pago account:
- either `pay_supplier` with the Mercado Pago account requires the payout SOURCE_ID (and reconciles / classifies it as
  `SUPPLIER_PAYMENT` in `mp_outflow_classification`),
- or supplier payments by Mercado Pago are entered only from Actividad Mercado Pago ("Compra / gasto" → supplier →
  "Aplicar a la deuda existente"), and Cuentas a pagar stops offering the Mercado Pago account.

Until then: pay suppliers from Mercado Pago through Actividad Mercado Pago, not through Cuentas a pagar.
