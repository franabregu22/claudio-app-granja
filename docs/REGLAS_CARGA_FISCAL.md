# Reglas operativas — carga fiscal de facturas de proveedores

Reglas del owner para registrar compras con comprobante fiscal (Compras → registrar compra → Datos fiscales). No cambian el diseño (ADR-015) ni el código: dicen qué valores cargar en los campos existentes.

## 1. Período fiscal

**Regla general:** el período fiscal de una factura es el mes y año de su fecha de emisión, salvo una excepción indicada expresamente por el owner.

- Ejemplo: factura del 25/08/2026 → período 08/2026; factura del 21/09/2026 → período 09/2026.
- Una excepción se registra junto a la carga, con el motivo y la decisión del owner.
- Decidida el 2026-11-04 (owner).

## 2. Importes — tratamiento acordado para las facturas BNA de septiembre / agosto 2026

Estas pautas documentan el tratamiento que el owner aprobó el 2026-11-04 para las cuatro facturas pagadas con los eCheqs 29–34
(Transportes Vesprini, Acondicionadora Chavez, Fridevi, Biotécnicas Argentina). **No son una regla contable general:** otra factura
con conceptos distintos se resuelve con decisión del owner antes de cargarla.

- **Total de la compra** = total del comprobante.
- **Neto de gestión de la compra** = neto gravado + conceptos no gravados. No incluye IVA ni percepciones.
- **Neto del comprobante** (datos fiscales) = neto gravado.
- **Componentes**: un renglón por cada impuesto que figura en el comprobante (IVA por alícuota, percepciones), con la base, la alícuota y el importe impresos o respaldados por el comprobante. No se calculan ni se redondean.
- **No gravado**: el comprobante fiscal no tiene campo propio. Queda como diferencia exacta entre el total y neto + componentes, y como línea separada de la compra ("No gravado"). Nunca se carga como impuesto "Otro".
- **Percepción de Ingresos Brutos**: componente de tipo IIBB, separado del IVA.
- Las facturas se cargan una sola vez: la base rechaza el mismo número de comprobante para el mismo proveedor.
