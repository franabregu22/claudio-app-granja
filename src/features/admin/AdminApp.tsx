import { useState } from 'react';
import { useAuth } from '../../auth/useAuth';
import { ClientesAdmin } from './ClientesAdmin';
import { PreciosAdmin } from './PreciosAdmin';

type Tab = 'clientes' | 'precios';

export function AdminApp() {
  const { rol } = useAuth();
  const [tab, setTab] = useState<Tab>('clientes');

  if (rol !== 'dueño') {
    return (
      <div className="min-h-screen bg-stone-100 flex items-center justify-center">
        <div className="bg-white p-8 rounded-lg text-center max-w-sm mx-4">
          <p className="text-lg font-semibold text-gray-800">Acceso restringido</p>
          <p className="text-gray-600 mt-2">Solo el dueño puede acceder al panel admin.</p>
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
          <p className="text-gray-600 text-sm mt-1">Gestiona clientes y precios</p>
        </div>

        {/* Tabs */}
        <div className="bg-[#FAF6EE] border-b border-amber-200 flex gap-0 px-6">
          <button
            onClick={() => setTab('clientes')}
            className={`px-4 py-3 font-medium border-b-2 transition ${
              tab === 'clientes'
                ? 'text-amber-900 border-amber-600'
                : 'text-gray-600 border-transparent hover:text-amber-900'
            }`}
          >
            Clientes
          </button>
          <button
            onClick={() => setTab('precios')}
            className={`px-4 py-3 font-medium border-b-2 transition ${
              tab === 'precios'
                ? 'text-amber-900 border-amber-600'
                : 'text-gray-600 border-transparent hover:text-amber-900'
            }`}
          >
            Precios
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {tab === 'clientes' && <ClientesAdmin />}
          {tab === 'precios' && <PreciosAdmin />}
        </div>
      </div>
    </div>
  );
}
