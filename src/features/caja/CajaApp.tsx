import { useState } from 'react';
import { useAuth } from '../../auth/useAuth';
import { Cheques } from './Cheques';
import { CobrosClientes } from './CobrosClientes';
import { PendientesClasificar } from './PendientesClasificar';
import { GastosSinClasificar } from './GastosSinClasificar';
import { useBadgeSinClasificar } from './useUnclassified';
import { EntradasSinVincular } from './EntradasSinVincular';
import { Compras } from './Compras';
import { CuentasAPagar } from './CuentasAPagar';
import { ResumenSaldos } from './ResumenSaldos';
import { ExtractosBancarios } from './ExtractosBancarios';
import { PagosFacturas } from './PagosFacturas';
import { CalendarioPagos } from './CalendarioPagos';
import { EventoGestionModal } from '../finanzas/EventoGestionModal';

type Vista = 'saldos' | 'sinclasificar' | 'pendientes' | 'entradas' | 'cobros' | 'pagar' | 'compras' | 'pagosfactura' | 'vencimientos' | 'instrumentos' | 'extractos';
const VISTAS: { id: Vista; label: string }[] = [
  { id: 'saldos', label: 'Saldos' },
  { id: 'sinclasificar', label: 'Gastos sin clasificar' },   // ADR-025 (0101): paid expenses whose category is pending
  { id: 'pendientes', label: 'Pendientes de clasificar' },
  { id: 'entradas', label: 'Entradas sin vincular' },   // ADR-023: optional, never an alert
  { id: 'cobros', label: 'Cobros de clientes' },
  { id: 'pagar', label: 'Cuentas a pagar' },
  { id: 'compras', label: 'Compras y fletes' },
  { id: 'pagosfactura', label: 'Pagos de facturas' },   // ADR-025 stage 4 (0104): one invoice, several cheques / payments
  { id: 'vencimientos', label: 'Calendario de pagos' },   // Lote 3B (0110): every future commitment once; debited apart (was Vencimientos, 0104)
  { id: 'instrumentos', label: 'Cheques' },
  { id: 'extractos', label: 'Extractos bancarios' },
];

/**
 * Caja (F27-D, ADMIN): treasury over the target. There is no free-form movement CRUD: money moves only through the
 * contract operations (collections in Cobros; transfers, supplier payments, purchases / freight and instruments here),
 * and balances are read from report_balance_period. The monthly trend lives in Finanzas (F27-G). The general cash count (arqueo) is retired in V1 (P27-D1).
 */
export function CajaApp() {
  const { rol } = useAuth();
  const [vista, setVista] = useState<Vista>('saldos');
  const [retiro, setRetiro] = useState(false);
  const sinClasificar = useBadgeSinClasificar();

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
                {v.id === 'sinclasificar' && sinClasificar > 0 && <span className="ml-1.5 inline-block min-w-5 px-1.5 rounded-full bg-amber-500 text-white text-xs" aria-label={`${sinClasificar} pendientes`}>{sinClasificar}</span>}
              </button>
            ))}
          </nav>
        </header>
        <div className="flex-1 overflow-y-auto px-4 md:px-6 pt-6 pb-20">
          {vista === 'saldos' && <ResumenSaldos onVerPendientes={() => setVista('pendientes')} />}
          {vista === 'sinclasificar' && <GastosSinClasificar onVerPendientesMp={() => setVista('pendientes')} />}
          {vista === 'pendientes' && <PendientesClasificar />}
          {vista === 'entradas' && <EntradasSinVincular />}
          {vista === 'cobros' && <CobrosClientes />}
          {vista === 'pagar' && <CuentasAPagar />}
          {vista === 'compras' && <Compras />}
          {vista === 'pagosfactura' && <PagosFacturas />}
          {vista === 'vencimientos' && <CalendarioPagos onImputar={() => setVista('pagosfactura')} />}
          {vista === 'instrumentos' && <Cheques />}
          {vista === 'extractos' && <ExtractosBancarios />}
        </div>
        {retiro && <EventoGestionModal tipo="RETIRO" onClose={() => setRetiro(false)} />}
      </div>
    </div>
  );
}
