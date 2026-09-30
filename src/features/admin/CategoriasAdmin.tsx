import { MasterEditor } from './MasterEditor';

/**
 * Target `expense_category` (ADMIN master). `pnl_cost_class` (ADR-004 D4, mandatory) is set on creation and not
 * edited afterwards: the P&L views read the category's class, so changing it would re-classify posted purchases,
 * and the category is a purchase-time fact with no retroactive re-classification. No deletion (deactivate instead).
 */
export function CategoriasAdmin() {
  return (
    <MasterEditor
      table="expense_category"
      title="Categorías de gasto"
      fields={[
        { key: 'nombre', label: 'Nombre', required: true, placeholder: 'Ej: Maíz' },
        { key: 'description', label: 'Descripción', placeholder: 'Descripción (opcional)' },
        {
          key: 'pnl_cost_class', label: 'Clase de costo (P&L)', type: 'select', editable: false,
          options: [{ value: 'DIRECT', label: 'Costo directo' }, { value: 'INDIRECT', label: 'Costo indirecto' }],
        },
      ]}
    />
  );
}
