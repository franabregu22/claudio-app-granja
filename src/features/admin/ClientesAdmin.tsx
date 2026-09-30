import { MasterEditor } from './MasterEditor';

/** Target `clients` (ADMIN master): name, fiscal id, contact; deactivation instead of deletion. */
export function ClientesAdmin() {
  return (
    <MasterEditor
      table="clients"
      title="Clientes"
      fields={[
        { key: 'nombre', label: 'Nombre', required: true, placeholder: 'Nombre del cliente' },
        { key: 'fiscal_id', label: 'CUIT / DNI', placeholder: 'CUIT / DNI (opcional)' },
        { key: 'contacto', label: 'Contacto', placeholder: 'Contacto (opcional)' },
      ]}
    />
  );
}
