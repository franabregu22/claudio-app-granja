import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useAuth } from '../../auth/useAuth';
import { Movimientos } from './Movimientos';
import { SolapaPagar, type SubPagar } from './SolapaPagar';
import { ExtractosBancarios } from './ExtractosBancarios';
import { CalendarioPagos } from './CalendarioPagos';
import { usePendingSummary } from './useMpActivity';
import { useBadgeSinClasificar } from './useUnclassified';
import { EventoGestionModal } from '../finanzas/EventoGestionModal';
import { NuevaCompraModal } from './Compras';

type Vista = 'movimientos' | 'pagar' | 'calendario' | 'extractos';
const VISTAS: { id: Vista; label: string }[] = [
  { id: 'movimientos', label: 'Movimientos' },   // balances, Por resolver and Todas las operaciones (expenses, invoices, transfers and their actions)
  { id: 'pagar', label: 'Cuentas a pagar' },   // Proveedores (debt per supplier, freight) and Cheques
  { id: 'calendario', label: 'Calendario' },   // Lote 3B (0110): every future commitment once; debited apart (was Vencimientos, 0104)
  { id: 'extractos', label: 'Extractos' },
];

/**
 * Caja (F27-D, ADMIN): treasury over the target. There is no free-form movement CRUD: money moves only through the
 * contract operations (collections in Cuentas corrientes; transfers, supplier payments, purchases / freight and instruments here),
 * and balances are read from report_balance_period. The monthly trend lives in Finanzas (F27-G). The general cash count (arqueo) is retired in V1 (P27-D1).
 */
export function CajaApp() {
  const { rol } = useAuth();
  const [vista, setVista] = useState<Vista>('movimientos');
  const [subPagar, setSubPagar] = useState<SubPagar>('proveedores');
  const [retiro, setRetiro] = useState(false);
  const [nuevoGasto, setNuevoGasto] = useState(false);
  const [foco, setFoco] = useState<string | null>(null);   // 0119: the row of a just-recorded operation in Todas las operaciones
  const [registrado, setRegistrado] = useState<{ texto: string; clave: string | null } | null>(null);
  const verOperacion = (clave: string | null) => { setFoco(clave ?? 'RECIENTES'); setRegistrado(null); setVista('movimientos'); };
  const sinClasificar = useBadgeSinClasificar();
  const mp = usePendingSummary();
  const porResolver = sinClasificar + (mp.data?.PENDING_CURRENT.count ?? 0);   // historical Mercado Pago rows and optional inflows are not an alert

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
      {/* min-w-0: the tab bar scrolls inside Caja (overflow-x-auto) instead of setting the page's minimum width */}
      <div className="w-full max-w-6xl min-w-0 bg-[#FAF6EE] min-h-screen flex flex-col">
        <header className="px-4 md:px-6 pt-6 pb-3 border-b border-[#E4DCC8]">
          <p className="text-xs font-semibold tracking-wide text-[#A8552E] uppercase">Granja Santo Tomás</p>
          <div className="flex items-start justify-between gap-2">
            <h1 className="text-2xl font-bold text-[#2C2419] mt-1">Caja & Tesorería</h1>
            <details className="relative text-sm mt-2">
              <summary className="cursor-pointer text-[#A8552E]">Más acciones</summary>
              <div className="absolute right-0 z-10 mt-1 bg-white border border-[#E4DCC8] rounded-lg shadow p-2 w-56">
                <button onClick={() => setRetiro(true)} className="w-full text-left px-2 py-1 rounded hover:bg-amber-50">Retiro de socios</button>
              </div>
            </details>
          </div>
          <nav className="flex gap-2 mt-4 overflow-x-auto">
            {VISTAS.map((v) => (
              <button key={v.id} onClick={() => setVista(v.id)}
                className={`whitespace-nowrap px-3 py-1.5 rounded-lg text-sm font-medium ${vista === v.id ? 'bg-[#A8552E] text-white' : 'bg-white text-[#6B5D45] border border-[#E4DCC8] hover:bg-stone-50'}`}>
                {v.label}
                {v.id === 'movimientos' && porResolver > 0 && <span className="ml-1.5 inline-block min-w-5 px-1.5 rounded-full bg-amber-500 text-white text-xs" aria-label={`${porResolver} por resolver`}>{porResolver}</span>}
              </button>
            ))}
          </nav>
        </header>
        <div className="flex-1 overflow-y-auto px-4 md:px-6 pt-6 pb-20">
          {registrado && (
            <div className="mb-4 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-900 flex flex-wrap items-center gap-2" role="status">
              <span>{registrado.texto}</span>
              <button type="button" className="underline font-semibold" onClick={() => verOperacion(registrado.clave)}>
                {registrado.clave ? 'Ver en Todas las operaciones' : 'Ver cargadas recientemente'}
              </button>
              <button type="button" className="ml-auto text-xs text-green-800 hover:underline" onClick={() => setRegistrado(null)}>Cerrar</button>
            </div>
          )}
          {vista === 'movimientos' && <Movimientos onIrAExtractos={() => setVista('extractos')} focus={foco} onFocus={setFoco} />}
          {vista === 'pagar' && <SolapaPagar sub={subPagar} onSub={setSubPagar} />}
          {vista === 'calendario' && <CalendarioPagos onImputar={() => setVista('movimientos')} />}
          {vista === 'extractos' && <ExtractosBancarios />}
        </div>
        {retiro && <EventoGestionModal tipo="RETIRO" onClose={() => setRetiro(false)} />}
        {/* Nuevo gasto: on every Caja tab, the existing purchase form (with or without invoice) */}
        <button type="button" onClick={() => setNuevoGasto(true)} title="Registrar un gasto"
          className="fixed bottom-6 right-4 md:right-8 z-40 flex items-center gap-1.5 bg-[#A8552E] text-white font-semibold pl-3 pr-4 py-3 rounded-full shadow-lg hover:bg-[#8B4423]">
          <Plus className="w-5 h-5" /> Nuevo gasto
        </button>
        {nuevoGasto && <NuevaCompraModal onClose={() => setNuevoGasto(false)}
          onRegistrado={(clave, texto) => { setNuevoGasto(false); setRegistrado({ texto, clave }); }} />}
      </div>
    </div>
  );
}
