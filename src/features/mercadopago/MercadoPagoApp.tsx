import { useState } from 'react';
import { useAuth } from '../../auth/useAuth';
import { CobrosMP } from './CobrosMP';
import { BannerSaludMP, ExcepcionesMP, PagadoresMP, SaludMP } from './OperacionesMP';

type Vista = 'cobros' | 'notificaciones' | 'excepciones' | 'pagadores';
const VISTAS: { id: Vista; label: string }[] = [
  { id: 'cobros', label: 'Cobros recibidos' },
  { id: 'notificaciones', label: 'Notificaciones' },
  { id: 'excepciones', label: 'Excepciones de reporte' },
  { id: 'pagadores', label: 'Pagadores' },
];

/**
 * Mercado Pago (F27-H, ADMIN) — the accepted Step-14 contract (ADR006_PHASE27_MP_FRONTEND_CONTRACT_V1).
 * State comes only from the three Step-10 views; the §5a lookups only supply identifiers for C3 / C7 / S7.
 * Axis A (conciliación con MP, tesorería) and axis B (atribución a cliente, opcional) are always separate.
 * Ingestion is backend-only (webhook + worker + scheduler): there is no sync, debug or raw-data screen here.
 */
export function MercadoPagoApp() {
  const { rol } = useAuth();
  const [vista, setVista] = useState<Vista>('cobros');

  if (rol !== 'ADMIN') {
    return (
      <div className="min-h-screen bg-stone-100 flex items-center justify-center">
        <div className="bg-white p-8 rounded-lg text-center max-w-sm mx-4">
          <p className="text-lg font-semibold text-gray-800">Sin acceso</p>
          <p className="text-gray-600 mt-2">Solo un administrador puede ver Mercado Pago.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-stone-100 flex justify-center relative">
      <div className="w-full max-w-6xl bg-[#FAF6EE] min-h-screen flex flex-col">
        <header className="px-4 md:px-6 pt-6 pb-3 border-b border-[#E4DCC8] space-y-3">
          <div>
            <p className="text-xs font-semibold tracking-wide text-[#A8552E] uppercase">Granja Santo Tomás</p>
            <h1 className="text-2xl font-bold text-[#2C2419] mt-1">Mercado Pago</h1>
            <p className="text-xs text-[#8A7A5C] mt-1">
              Cada cobro muestra dos estados independientes: la conciliación con Mercado Pago (tesorería) y la atribución a un cliente, que es opcional.
            </p>
          </div>
          <BannerSaludMP />
          <nav className="flex gap-2 overflow-x-auto">
            {VISTAS.map((v) => (
              <button key={v.id} onClick={() => setVista(v.id)}
                className={`whitespace-nowrap px-3 py-1.5 rounded-lg text-sm font-medium ${vista === v.id ? 'bg-[#A8552E] text-white' : 'bg-white text-[#6B5D45] border border-[#E4DCC8] hover:bg-stone-50'}`}>
                {v.label}
              </button>
            ))}
          </nav>
        </header>
        <div className="flex-1 overflow-y-auto px-4 md:px-6 pt-6 pb-20">
          {vista === 'cobros' && <CobrosMP />}
          {vista === 'notificaciones' && <SaludMP />}
          {vista === 'excepciones' && <ExcepcionesMP />}
          {vista === 'pagadores' && <PagadoresMP />}
        </div>
      </div>
    </div>
  );
}
