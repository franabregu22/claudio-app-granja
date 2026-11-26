# Backlog — cambios futuros del ERP

Ideas que el owner aprobó para más adelante, todavía no programadas. Cuando un ítem se hace, se borra de acá y se nombra el commit o la
release en su lugar. Cada ítem dice qué es, de dónde salió y qué hay que tener en cuenta.

## Propuestos por el owner

_Hechos: #2 nombre del insumo y #6 número de cheque en su débito → release 0139 (2026-11-25)._

### 1. Lectura automática de la factura en el formulario del gasto
- **Origen:** owner, 2026-11-25 («es difícil hacer que lo reconozca el sistema con la factura que subo?»). Se decidió dejarlo para más adelante.
- **Qué:** al elegir la foto o el PDF en «Factura o comprobante» del gasto (Nuevo gasto / Editar gasto), el sistema lee la factura y completa
  solos estos campos; el owner revisa y guarda:
  - número;
  - fecha;
  - importe total;
  - tipo (Factura A / otra);
  - neto, IVA (alícuota e importe) y percepciones;
  - proveedor, si reconoce el CUIT.
- **Cómo:** una función del servidor (Edge Function) que llama a la IA con la imagen, con las mismas reglas que ya usa el bot de
  WhatsApp:
  - `integrations/whatsapp/wa-gateway/n8n/receipt.js`;
  - el CUIT del emisor sacado de facturas anteriores;
  - el neto = total − impuestos cuando no cierra.
  Se conecta al bloque de factura de `src/features/caja/Compras.tsx`.
- **Alcance estimado:** sin cambios en la base; función nueva más pantalla. Uno o dos días de trabajo, más el despliegue de la función.
  Cada lectura tiene un costo chico de IA, como el del bot.

## Detectados durante el trabajo (no pedidos todavía)

### 3. Facturas A de ventas en la columna «Factura / comprobante» — a definir
- **Origen:** release 0137 (2026-11-24). El owner lo eligió para la 0139 el 2026-11-25.
- **Por qué no entró:** «Todas las operaciones» lista solo movimientos de dinero. Un pedido entregado (donde se emite la Factura A) no
  es una fila, y un cobro no está atado a una factura o pedido (`collections` no tiene vínculo con `pedidos`). No hay en qué fila
  mostrarla sin definir antes una regla.
- **Opciones para decidir con el owner:**
  - mostrar la Factura A en Pedidos / Cuentas corrientes de clientes (donde sí existe el pedido);
  - o vincular cada cobro con las facturas que cancela, un cambio de dominio más grande.

### 7. Filtrar por cualquier insumo de una factura con varios insumos
- **Origen:** owner 2026-11-26, insumos desde Caja (opción A). Quedó fuera de alcance porque necesita una migración.
- **Qué:** en Todas las operaciones, al filtrar por Subcategoría «Soja» tiene que aparecer también la factura «Maíz + Soja».
  Hoy el filtro se resuelve en `fin_operation_list` con la categoría del gasto. Hay que sumarle `feed_purchase_part`.

### 8. Cobros de Mercado Pago: caída desde el 09/11/2026
- **Origen:** detectado el 26/11 al armar «Cobros MP a facturar» (0143). No se investigó.
- **Qué:** los cobros de Mercado Pago pasaron de ~100 por semana (oct) a 80, 4, 17 y 4 desde la semana del 09/11. Hay que ver si es
  un cambio real en las ventas o una falta de sincronización (reporte diario / webhooks).

## Pendientes ya conocidos (decisiones anteriores del owner)

### 4. Cartones: al estado de resultados por consumo, como el alimento
- **Origen:** decisión del owner sobre el alimento (P&L por consumo, 0126): «cartones igual más adelante».

### 5. Nombres de pagadores de Mercado Pago (Lote 5)
- **Origen:** en pausa por el owner. La migración que estaba preparada como 0112 nunca se aplicó y ese número ya lo usa otra
  migración, así que hay que rehacerla con el número que siga.
- **Qué:** tomar `PAYER_NAME` del reporte de movimientos de Mercado Pago.
