import { MasterEditor } from './MasterEditor';

/** Target `suppliers` (ADMIN master). */
export function ProveedoresAdmin() {
  return (
    <MasterEditor
      table="suppliers"
      title="Proveedores"
      fields={[
        { key: 'nombre', label: 'Nombre', required: true, placeholder: 'Nombre del proveedor' },
        { key: 'fiscal_id', label: 'CUIT', placeholder: 'CUIT (opcional)' },
        { key: 'contacto', label: 'Contacto', placeholder: 'Contacto (opcional)' },
      ]}
    />
  );
}
