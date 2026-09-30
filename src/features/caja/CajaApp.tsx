import { useState } from 'react';
import { useAuth } from '../../auth/useAuth';
import { Cheques } from './Cheques';
import { Compras } from './Compras';
import { CuentasAPagar } from './CuentasAPagar';
import { ResumenSaldos } from './ResumenSaldos';

type Vista = 'saldos' | 'pagar' | 'compras' | 'instrumentos';
const VISTAS: { id: Vista; label: string }[] = [
  { id: 'saldos', label: 'Saldos' },
  { id: 'pagar', label: 'Cuentas a pagar' },
  { id: 'compras', label: 'Compras y fletes' },
  { id: 'instrumentos', label: 'Cheques' },
];

/**
 * Caja (F27-D, ADMIN): treasury over the target. There is no free-form movement CRUD: money moves only through the
 * contract operations (collections in Cobros; transfers, supplier payments, purchases / freight and instruments here),
 * and balances are read from report_balance_period. The monthly trend lives in Finanzas (F27-G). The general cash count (arqueo) is retired in V1 (P27-D1).
 */
export function CajaApp() {
  const { rol } = useAuth();
  const [vista, setVista] = useState<Vista>('saldos');

  if (rol !== 'ADMIN') {
    return (
      <div className="min-h-screen bg-stone-100 flex items-center justify-center">
        <div className="bg-white p-8 rounded-lg text-center max-w-sm mx-4">
          <p className="text-lg font-semibold text-gray-800">Acceso restringido</p>
          <p className="text-gray-600 mt-2">Solo un administrador puede acceder a Caja.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-stone-100 flex justify-center relative">
      <div className="w-full max-w-6xl bg-[#FAF6EE] min-h-screen flex flex-col">
        <header className="px-4 md:px-6 pt-6 pb-3 border-b border-[#E4DCC8]">
          <p className="text-xs font-semibold tracking-wide text-[#A8552E] uppercase">Granja Santo Tomás</p>
          <h1 className="text-2xl font-bold text-[#2C2419] mt-1">Caja & Tesorería</h1>
          <nav className="flex gap-2 mt-4 overflow-x-auto">
            {VISTAS.map((v) => (
              <button key={v.id} onClick={() => setVista(v.id)}
                className={`whitespace-nowrap px-3 py-1.5 rounded-lg text-sm font-medium ${vista === v.id ? 'bg-[#A8552E] text-white' : 'bg-white text-[#6B5D45] border border-[#E4DCC8] hover:bg-stone-50'}`}>
                {v.label}
              </button>
            ))}
          </nav>
        </header>
        <div className="flex-1 overflow-y-auto px-4 md:px-6 pt-6 pb-20">
          {vista === 'saldos' && <ResumenSaldos />}
          {vista === 'pagar' && <CuentasAPagar />}
          {vista === 'compras' && <Compras />}
          {vista === 'instrumentos' && <Cheques />}
        </div>
      </div>
    </div>
  );
}
