# Caja y Tesorería — mejoras acumuladas

Rama local `caja-mejoras-acumuladas`, desde `origin/main` e6c03eb (producción 117/0117). Sin push, deploy ni migraciones productivas.
Lo que necesite base se prueba en Docker local (0118 aplicada solo en local; siguiente: **0119**). Scripts de release: solo cuando el owner cierre la lista.

Estados: PENDIENTE → IMPLEMENTADA → PROBADA (local).

| # | Mejora (aprobada por el owner) | Estado | Notas |
|---|---|---|---|
| 1 | Editar la fecha de pago de cheques y eCheqs emitidos, antes de su débito | PROBADA (local) | 0118 `reschedule_issued_instrument` (solo ISSUED, no antes de la emisión, motivo obligatorio). Botón "Cambiar fecha de pago" en Cheques, Calendario ("Fecha de pago") y detalle de factura. Sobre datos reales: 11/11 PASS (transacción revertida). |
| 2 | Auditoría de esa corrección: usuario, fecha, valor anterior, nuevo y motivo | PROBADA (local) | `audit_events` RESCHEDULE_PAYMENT_DATE; el modal lista las correcciones anteriores. |
| 3 | "Vencimiento" → "Fecha de pago" en las pantallas correspondientes | IMPLEMENTADA | Solo cheques / eCheqs: Cheques (fila y Recibir cheque), Pagar a proveedor con cheque, Emitir cheques de una factura, detalle de factura, ficha de proveedor (tabla de cheques), Calendario ("Fecha de pago pasada, sin debitar"). Se mantiene "Vencimiento" en facturas, gastos e impuestos (es la obligación, no el cheque). |
| 4 | "Rechazar" pasa a "Más acciones", sin perder su funcionalidad | IMPLEMENTADA | Cheques (emitidos y recibidos) y detalle de factura; misma RPC. |
| 5 | "Anular" y "Marcar debitado" siguen como acciones principales | IMPLEMENTADA | Sin cambios de comportamiento. |

ERP local con datos reales (2026-11-06): backup de producción de las 10:35 (nivel 0116) restaurado con restore-rehearsal-0101.sh, convertido en la base `postgres` del Docker local (la sintética quedó como `erp_local_sintetico`), + 0117 + 0118. Cron locales desactivados, `wa.config.enabled = false`, Vault local vacío, sin Edge Functions locales. Frontend: `http://127.0.0.1:5199` con VITE_SUPABASE_URL=http://127.0.0.1:54321 (nunca .env.local). Usuario: el del owner, contraseña solo local. Los attachments de Storage no están en local (solo sus registros).

Restricciones fijas: no tocar el eCheq 039 real de Biotécnicas (el owner lo corrige desde la interfaz publicada); no alterar importes, proveedores, saldos ni movimientos al corregir fechas.
