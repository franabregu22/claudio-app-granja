# Caja y Tesorería — mejoras acumuladas

Rama local `caja-mejoras-acumuladas`, desde `origin/main` e6c03eb (producción 117/0117). Sin push, deploy ni migraciones productivas.
Lo que necesite base se prueba en Docker local (migración local siguiente: **0118**). Scripts de release: solo cuando el owner cierre la lista.

Estados: PENDIENTE → IMPLEMENTADA → PROBADA (local).

| # | Mejora (aprobada por el owner) | Estado | Notas |
|---|---|---|---|
| 1 | Editar la fecha de pago de cheques y eCheqs emitidos, antes de su débito | PENDIENTE | No existe RPC: 0118 local. Solo emitidos (`ISSUED`) aún no debitados. No cambia importe, proveedor, saldo ni movimiento. |
| 2 | Auditoría de esa corrección: usuario, fecha, valor anterior, nuevo y motivo | PENDIENTE | Motivo obligatorio; `audit_events`. Va con la 1. |
| 3 | "Vencimiento" → "Fecha de pago" en las pantallas correspondientes | PENDIENTE | Cheques, Calendario, Cuentas a pagar, Ficha de proveedor, Pagos de facturas, Fechas de pago (revisar cada uso: solo cheques / eCheqs y pagos). |
| 4 | "Rechazar" pasa a "Más acciones", sin perder su funcionalidad | PENDIENTE | `Cheques.tsx`. |
| 5 | "Anular" y "Marcar debitado" siguen como acciones principales | PENDIENTE | `Cheques.tsx`, `CalendarioPagos.tsx`. |

Restricciones fijas: no tocar el eCheq 039 real de Biotécnicas (el owner lo corrige desde la interfaz publicada); no alterar importes, proveedores, saldos ni movimientos al corregir fechas.
