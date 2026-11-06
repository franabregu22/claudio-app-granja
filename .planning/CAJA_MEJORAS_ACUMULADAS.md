# Caja y Tesorería — mejoras acumuladas

Rama local `caja-mejoras-acumuladas`, desde `origin/main` e6c03eb (producción 117/0117). Sin push, deploy ni migraciones productivas.
Lo que necesite base se prueba en Docker local (producción en 0118; 0119 aplicada solo en local; siguiente: **0120**). Scripts de release: solo cuando el owner cierre la lista.

Modalidades de prueba (se indica antes de cada prueba; la conexión nunca se cambia sin avisar):
- **A — localhost → Supabase PRODUCCIÓN (0117):** solo cambios visuales compatibles con 0117. Lo que el owner cargue **queda en producción**. Nunca pruebas automatizadas.
- **B — localhost → Docker LOCAL (0118 + copia real):** migraciones, RPC nuevas o pruebas que escriben. Lo que el owner cargue **queda solo en local**.
- Con el código de esta rama en modalidad A, lo que depende de 0118 ("Cambiar fecha de pago") responde error y no escribe nada.

Estados: PENDIENTE → IMPLEMENTADA → PROBADA (local).

| # | Mejora (aprobada por el owner) | Estado | Notas |
|---|---|---|---|
| 1 | Editar la fecha de pago de cheques y eCheqs emitidos, antes de su débito | PUBLICADA | 0118 `reschedule_issued_instrument` (solo ISSUED, no antes de la emisión, motivo obligatorio). Botón "Cambiar fecha de pago" en Cheques, Calendario ("Fecha de pago") y detalle de factura. Sobre datos reales: 11/11 PASS (transacción revertida). |
| 2 | Auditoría de esa corrección: usuario, fecha, valor anterior, nuevo y motivo | PUBLICADA | `audit_events` RESCHEDULE_PAYMENT_DATE; el modal lista las correcciones anteriores. |
| 3 | "Vencimiento" → "Fecha de pago" en las pantallas correspondientes | PUBLICADA | Solo cheques / eCheqs: Cheques (fila y Recibir cheque), Pagar a proveedor con cheque, Emitir cheques de una factura, detalle de factura, ficha de proveedor (tabla de cheques), Calendario ("Fecha de pago pasada, sin debitar"). Se mantiene "Vencimiento" en facturas, gastos e impuestos (es la obligación, no el cheque). |
| 4 | "Rechazar" pasa a "Más acciones", sin perder su funcionalidad | PUBLICADA | Cheques (emitidos y recibidos) y detalle de factura; misma RPC. |
| 5 | "Anular" y "Marcar debitado" siguen como acciones principales | PUBLICADA | Sin cambios de comportamiento. |
| 6 | Rectificación de fecha visible (pedido del owner tras probar la 1) | PUBLICADA | Etiqueta "Fecha de pago corregida · antes …" en Cheques, Calendario y detalle de factura; en Cheques, además, cada corrección bajo la fila (anterior → nueva, cuándo, quién, motivo). Solo frontend sobre la auditoría de 0118. |
| 7 | Rediseño: «Todas las operaciones» reemplaza «Movimientos históricos» | IMPLEMENTADA (modalidad B, 0119 local) | `fin_operation_list` (operaciones + gastos y facturas pendientes + cheques sin factura + cheques recibidos + transferencias anticipadas, cada importe una vez), `pay_purchase_invoice` (pago de factura desde la fila), `fin_operation_timeline` (historial auditado). Pago desde la fila de gastos pendientes y facturas; confirmación tras «Nuevo gasto» con acceso a su fila; filtros y orden por carga. «Por resolver» abre su lista de resolución. 13/13 pruebas SQL sobre datos reales (revertidas), 651/651 unit. |

ERP local con datos reales (2026-11-06): backup de producción de las 10:35 (nivel 0116) restaurado con restore-rehearsal-0101.sh, convertido en la base `postgres` del Docker local (la sintética quedó como `erp_local_sintetico`), + 0117 + 0118. Cron locales desactivados, `wa.config.enabled = false`, Vault local vacío, sin Edge Functions locales. Frontend: `http://127.0.0.1:5199` con VITE_SUPABASE_URL=http://127.0.0.1:54321 (nunca .env.local). Usuario: el del owner, contraseña solo local. Los attachments de Storage no están en local (solo sus registros).

Restricciones fijas: no tocar el eCheq 039 real de Biotécnicas (el owner lo corrige desde la interfaz publicada); no alterar importes, proveedores, saldos ni movimientos al corregir fechas.
