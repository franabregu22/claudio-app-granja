import { useState } from 'react';
import { useAuth } from '../../auth/useAuth';
import { ClientesAdmin } from './ClientesAdmin';
import { PreciosAdmin } from './PreciosAdmin';
import { LotesAdmin } from './LotesAdmin';
import { CategoriasAdmin } from './CategoriasAdmin';
import { ProveedoresAdmin } from './ProveedoresAdmin';
import { CuentasAdmin } from './CuentasAdmin';
import { AsignacionesAdmin } from './AsignacionesAdmin';
import { ProyectosAdmin } from './ProyectosAdmin';

type Tab = 'client' | 'product' | 'shed' | 'expense' | 'supplier' | 'account' | 'assignment' | 'project';

const TABS: { id: Tab; label: string }[] = [
  { id: 'client', label: 'Clientes' },
  { id: 'product', label: 'Productos y precios' },
  { id: 'shed', label: 'Galpones y lotes' },
  { id: 'expense', label: 'Categorías de gasto' },
  { id: 'supplier', label: 'Proveedores' },
  { id: 'account', label: 'Cuentas' },
  { id: 'assignment', label: 'Asignaciones' },
  { id: 'project', label: 'Proyectos' },
];

/** Master data (F27-B). The visibility check is UX only: RLS makes every master ADMIN-only in the database. */
export function AdminApp() {
  const { rol } = useAuth();
  const [tab, setTab] = useState<Tab>('client');

  if (rol !== 'ADMIN') {
    return (
      <div className="min-h-screen bg-stone-100 flex items-center justify-center">
        <div className="bg-white p-8 rounded-lg text-center max-w-sm mx-4">
          <p className="text-lg font-semibold text-gray-800">Acceso restringido</p>
          <p className="text-gray-600 mt-2">Solo un administrador puede acceder al panel admin.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-stone-100 flex justify-center">
      <div className="w-full max-w-2xl bg-[#FAF6EE] min-h-screen flex flex-col">
        {/* Header */}
        <div className="p-6 border-b border-amber-200">
          <h1 className="text-2xl font-bold text-amber-900">Panel Admin</h1>
          <p className="text-gray-600 text-sm mt-1">Datos maestros</p>
        </div>

        {/* Tabs */}
        <div className="bg-[#FAF6EE] border-b border-amber-200 flex gap-0 px-4 md:px-6 overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-4 py-3 font-medium border-b-2 transition whitespace-nowrap ${
                tab === t.id ? 'text-amber-900 border-amber-600' : 'text-gray-600 border-transparent hover:text-amber-900'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {tab === 'client' && <ClientesAdmin />}
          {tab === 'product' && <PreciosAdmin />}
          {tab === 'shed' && <LotesAdmin />}
          {tab === 'expense' && <CategoriasAdmin />}
          {tab === 'supplier' && <ProveedoresAdmin />}
          {tab === 'account' && <CuentasAdmin />}
          {tab === 'assignment' && <AsignacionesAdmin />}
          {tab === 'project' && <ProyectosAdmin />}
        </div>
      </div>
    </div>
  );
}
