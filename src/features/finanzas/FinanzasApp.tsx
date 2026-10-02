import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../auth/useAuth';
import { supabase } from '../../lib/supabase';
import { errorMessage } from '../../target/messages';
import {
  PNL_LINES, PNL_RESULT_LINES, listPnlLineItems, listPnlSummary, type ManagementEventRow,
} from '../../target/pnl';
import { getTodayDate } from '../../utils/dateUtils';
import { useExpenseCategories } from '../caja/useTreasury';
import { formatoPesos } from '../pedidos/helpers';
import { EVENTO_LABEL, EventoGestionModal, useManagementEvents } from './EventoGestionModal';
import { TendenciaMeses } from './TendenciaMeses';

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const mesCorto = (period: string) => `${MESES[Number(period.slice(5, 7)) - 1]}-${period.slice(2, 4)}`.toUpperCase();
/** First day of the month `n` months before the month of `date` (period selection only). */
const periodoAtras = (date: string, n: number) => {
  const d = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1 - n, 1));
  return d.toISOString().slice(0, 10);
};
const BUCKET: Record<string, string> = {
  VENTAS_NETAS: 'Ventas netas', COSTOS_DIRECTOS: 'Costos directos', COSTOS_INDIRECTOS: 'Costos indirectos', DIFERENCIA_CAJA: 'Diferencia de caja',
  OTROS_INGRESOS_FINANCIEROS: 'Otros ingresos financieros', REINVERSION: 'Reinversión', RETIROS: 'Retiros de socios',
  RESERVAS_INTERNAS: 'Reservas internas', INVERSIONES: 'Inversiones',
};
const PNL = ['pnl'];

/**
 * Finanzas (F27-G, ADMIN). The monthly P&L is pnl_summary exactly as reported (ADR-004 cascade); the drill-down lists
 * the month's pnl_line_item rows (never summed here: the bucket totals are the summary's columns). Management events
 * (retiros / reservas internas, ADR-004 D9) are registered only through register_management_event. The monthly trend
 * is the single TendenciaMeses presentation over pnl_summary (P27-D2); the legacy cash-flow formula is retired.
 */
export function FinanzasApp() {
  const { rol } = useAuth();
  const hoy = getTodayDate();
  const [meses, setMeses] = useState(6);
  const desde = periodoAtras(hoy, meses - 1);
  const hasta = periodoAtras(hoy, 0);
  const resumen = useQuery({ queryKey: [...PNL, 'summary', desde, hasta], queryFn: () => listPnlSummary(supabase, desde, hasta), enabled: rol === 'ADMIN' });
  const eventos = useManagementEvents();
  const [detalle, setDetalle] = useState<string | null>(null);
  const [nuevoEvento, setNuevoEvento] = useState(false);

  if (rol !== 'ADMIN') {
    return (
      <div className="min-h-screen bg-stone-100 flex items-center justify-center">
        <div className="bg-white p-8 rounded-lg text-center max-w-sm mx-4">
          <p className="text-lg font-semibold text-gray-800">Acceso restringido</p>
          <p className="text-gray-600 mt-2">Solo un administrador puede acceder a Finanzas.</p>
        </div>
      </div>
    );
  }
  const filas = resumen.data ?? [];
  const error = resumen.error ?? eventos.error;

  return (
    <div className="min-h-screen bg-stone-100 flex justify-center relative">
      <div className="w-full max-w-6xl bg-[#FAF6EE] min-h-screen flex flex-col">
        <header className="px-4 md:px-6 pt-6 pb-4 border-b border-[#E4DCC8] flex items-end justify-between gap-2">
          <div>
            <p className="text-xs font-semibold tracking-wide text-[#A8552E] uppercase">Granja Santo Tomás</p>
            <h1 className="text-2xl font-bold text-[#2C2419] mt-1">Finanzas</h1>
          </div>
          <select value={meses} onChange={(e) => setMeses(Number(e.target.value))} className="border border-[#E4DCC8] rounded-lg px-3 py-1.5 text-sm bg-white">
            {[3, 6, 12].map((n) => <option key={n} value={n}>Últimos {n} meses</option>)}
          </select>
        </header>

        <div className="flex-1 overflow-y-auto px-4 md:px-6 pt-6 pb-20 space-y-8">
          {error ? <div className="bg-red-100 border border-red-300 text-red-800 px-3 py-2 rounded text-sm">{errorMessage(error)}</div> : null}

          <section>
            <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide mb-3">Estado de resultados (devengado)</p>
            {resumen.isLoading ? <p className="text-sm text-gray-500">Cargando…</p> : filas.length === 0 ? (
              <p className="text-sm text-[#8A7A5C]">No hay períodos con resultados en el rango elegido.</p>
            ) : (
              <div className="bg-white rounded-lg border border-amber-200 overflow-x-auto">
                <table className="w-full text-xs md:text-sm">
                  <thead className="bg-amber-50 border-b border-amber-200 text-amber-900">
                    <tr>
                      <th className="px-3 py-2 text-left">Concepto</th>
                      {filas.map((f) => (
                        <th key={f.period} className="px-3 py-2 text-right">
                          <button onClick={() => setDetalle(detalle === f.period ? null : f.period)} className="underline decoration-dotted" title="Ver detalle del mes">
                            {mesCorto(f.period)}
                          </button>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {PNL_LINES.map(([col, label]) => {
                      const resultado = PNL_RESULT_LINES.includes(col);
                      return (
                        <tr key={col} className={`border-b border-amber-100 ${resultado ? 'bg-amber-50 font-semibold' : ''}`}>
                          <td className="px-3 py-2 text-left whitespace-nowrap">{label}</td>
                          {filas.map((f) => (
                            <td key={f.period} className={`px-3 py-2 text-right whitespace-nowrap ${resultado && f[col] < 0 ? 'text-red-700' : ''}`}>{formatoPesos(f[col])}</td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {detalle && <DetalleMes period={detalle} onClose={() => setDetalle(null)} />}
          </section>

          <section>
            <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide mb-3">Tendencia meses</p>
            <TendenciaMeses />
          </section>

          <section>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide">Retiros de socios y reservas internas</p>
              <details className="relative text-sm">
                <summary className="cursor-pointer text-[#A8552E]">Más acciones</summary>
                <div className="absolute right-0 z-10 mt-1 bg-white border border-[#E4DCC8] rounded-lg shadow p-2 w-56">
                  <button onClick={() => setNuevoEvento(true)} className="w-full text-left px-2 py-1 rounded hover:bg-amber-50">Registrar reserva interna</button>
                  <p className="px-2 pt-1 text-xs text-gray-500">Los retiros de socios se registran en Caja → Más acciones.</p>
                </div>
              </details>
            </div>
            <ListaEventos eventos={eventos.data ?? []} />
          </section>
        </div>
      </div>
      {nuevoEvento && <EventoGestionModal tipo="RESERVA_INTERNA" onClose={() => setNuevoEvento(false)} />}
    </div>
  );
}

function DetalleMes({ period, onClose }: { period: string; onClose: () => void }) {
  const items = useQuery({ queryKey: [...PNL, 'items', period], queryFn: () => listPnlLineItems(supabase, period) });
  const categorias = useExpenseCategories();
  const nombreCat = (id: string | null) => (id ? (categorias.data ?? []).find((c) => c.id === id)?.nombre ?? '—' : null);
  const buckets = [...new Set((items.data ?? []).map((i) => i.bucket))];
  return (
    <div className="mt-3 bg-white rounded-lg border border-[#E4DCC8] p-4 text-sm">
      <div className="flex items-center justify-between mb-2">
        <p className="font-semibold text-amber-900">Detalle {mesCorto(period)}</p>
        <button onClick={onClose} className="text-xs text-[#A8552E] hover:underline">Cerrar</button>
      </div>
      {items.isLoading ? <p className="text-gray-500">Cargando…</p> : items.error ? <p className="text-red-700">{errorMessage(items.error)}</p> : buckets.length === 0 ? (
        <p className="text-[#8A7A5C]">Sin movimientos en el mes.</p>
      ) : buckets.map((b) => (
        <div key={b} className="mb-3">
          <p className="text-xs font-semibold text-[#6B5D45] uppercase">{BUCKET[b] ?? b}</p>
          {(items.data ?? []).filter((i) => i.bucket === b).map((i) => (
            <p key={`${i.source_entity_type}-${i.source_entity_id}-${i.business_date}`} className="text-xs text-gray-700">
              {i.business_date} · {i.description ?? i.source_entity_type}{nombreCat(i.expense_category_id) ? ` · ${nombreCat(i.expense_category_id)}` : ''} · {formatoPesos(i.signed_amount)}
            </p>
          ))}
        </div>
      ))}
    </div>
  );
}

function ListaEventos({ eventos }: { eventos: ManagementEventRow[] }) {
  if (eventos.length === 0) return <p className="text-sm text-[#8A7A5C]">Sin retiros de socios ni reservas registrados.</p>;
  return (
    <div className="space-y-1 text-sm">
      {eventos.map((e) => (
        <p key={e.id} className="text-gray-700">
          {e.effective_date} · <b>{EVENTO_LABEL[e.event_type]}</b>{e.compensates_event_id ? ' (compensación)' : ''} · {formatoPesos(e.amount)}{e.reason ? ` · ${e.reason}` : ''}
        </p>
      ))}
    </div>
  );
}
