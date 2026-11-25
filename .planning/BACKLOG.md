# Backlog — cambios futuros del ERP

Ideas que el owner aprobó para más adelante, todavía no programadas. Cuando un ítem se hace, se borra de acá y se nombra el commit o la
release en su lugar. Cada ítem dice qué es, de dónde salió y qué hay que tener en cuenta.

## Propuestos por el owner

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

### 6. Número del cheque en la fila de su débito (Todas las operaciones)
- **Origen:** owner, 2026-11-25. Hoy el débito del eCheq 035 (04/11) aparece como «[Cheque debitado] Expeller de Soja», sin el
  número (commit `435121a`).
- **Qué:** que el débito de un cheque o eCheq propio asociado a un gasto se lea «eCheq 035 · Expeller de Soja». Así queda igual que
  los cheques sin gasto, que ya dicen «Cheque 250 · proveedor».
- **Cómo:** en `fin_operation_list`, cuando la operación es un `INSTRUMENT_DEBIT`, anteponer el tipo y el número del instrumento al
  concepto del gasto. Hoy ese concepto lo toma de `cur.subcategory` antes que del instrumento.
- **Alcance estimado:** migración que redefine la función, con la misma identidad, más su test y su perfil de verificación. Lleva una
  release completa: backup, ensayo, aplicación y post. Conviene sumarlo al próximo lote que toque la base.

## Detectados durante el trabajo (no pedidos todavía)

### 2. Nombre del insumo cuando se renombra su subcategoría
- **Origen:** retiro de Administración → Alimento (2026-11-25, commit `cc58418`).
- **Qué pasa:** el nombre del ingrediente se fija al marcar la subcategoría como insumo. Si después se renombra la subcategoría:
  - Recetas muestra el nombre nuevo;
  - Alimento → Compras y los reportes de costo siguen mostrando el viejo (`feed_ingredient.nombre`).
  Antes se corregía desde la sección que se sacó.
- **Opciones:**
  - que renombrar una subcategoría de insumo renombre también su ingrediente;
  - o que los reportes muestren el nombre de la subcategoría.

### 3. Facturas A de ventas en la columna «Factura / comprobante»
- **Origen:** release 0137 (2026-11-24).
- **Qué pasa:** la columna de Todas las operaciones muestra el número y los archivos de los gastos, pero no la Factura A emitida en un
  cobro o venta.

## Pendientes ya conocidos (decisiones anteriores del owner)

### 4. Cartones: al estado de resultados por consumo, como el alimento
- **Origen:** decisión del owner sobre el alimento (P&L por consumo, 0126): «cartones igual más adelante».

### 5. Nombres de pagadores de Mercado Pago (Lote 5)
- **Origen:** en pausa por el owner. La migración que estaba preparada como 0112 nunca se aplicó y ese número ya lo usa otra
  migración, así que hay que rehacerla con el número que siga.
- **Qué:** tomar `PAYER_NAME` del reporte de movimientos de Mercado Pago.
