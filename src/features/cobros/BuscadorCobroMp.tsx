import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { filterMpReceipts, MP_SOURCE_MISSING_MESSAGE, type MpReceiptCandidate } from '../../target/mpActivity';
import { listPayerNames } from '../../target/pendingClassification';
import { formatearFechaLocal } from '../../utils/dateUtils';
import { BloqueoMp } from '../caja/MovimientoMp';
import { formatoPesos } from '../pedidos/helpers';

/** Payer display names of the offered receipts (0097); a receipt without a name in Mercado Pago's data has none. */
function useNombresPagadorMp(candidatos: readonly MpReceiptCandidate[]) {
  const ids = candidatos.map((c) => c.movementId).sort((a, b) => a - b);
  const q = useQuery({ queryKey: ['mp', 'payer-names', ids], enabled: ids.length > 0, queryFn: () => listPayerNames(supabase, ids) });
  return q.data ?? new Map<number, string>();
}

/**
 * Searchable list of the Mercado Pago receipts with something left to assign. Never pre-filtered by the client (anyone may
 * pay on the client's behalf); the search matches payer name, date, amount or MP reference. Without receipts → blocked.
 */
export function BuscadorCobroMp({ candidatos, cargando, value, onChange }: {
  candidatos: readonly MpReceiptCandidate[]; cargando: boolean; value: string; onChange: (sourceId: string) => void;
}) {
  const [busqueda, setBusqueda] = useState('');
  const nombres = useNombresPagadorMp(candidatos);
  if (cargando) return <p className="text-sm text-gray-500">Buscando movimientos de Mercado Pago…</p>;
  if (candidatos.length === 0) return <BloqueoMp mensaje={MP_SOURCE_MISSING_MESSAGE} />;
  const visibles = filterMpReceipts(candidatos, busqueda, (c) => nombres.get(c.movementId) ?? null);

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-gray-700">Cobro en Mercado Pago</p>
      <div className="relative">
        <Search size={16} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
        <input type="search" aria-label="Buscar movimiento de Mercado Pago" value={busqueda} onChange={(e) => setBusqueda(e.target.value)}
          placeholder="Nombre, importe, fecha o referencia" className="w-full border border-gray-300 rounded-lg pl-8 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-600" />
      </div>
      <ul role="listbox" aria-label="Movimientos de Mercado Pago" className="max-h-64 overflow-y-auto space-y-1.5 pr-0.5">
        {visibles.length === 0 && <li className="text-xs text-gray-500 px-1 py-2">Sin coincidencias.</li>}
        {visibles.map((c) => {
          const elegido = c.sourceId === value;
          const nombre = nombres.get(c.movementId);
          return (
            <li key={c.sourceId} role="option" aria-selected={elegido}>
              <button type="button" onClick={() => onChange(elegido ? '' : c.sourceId)}
                className={`w-full text-left rounded-lg border px-3 py-2 transition ${elegido ? 'border-amber-600 bg-amber-50 ring-1 ring-amber-600' : 'border-gray-200 bg-white hover:border-amber-400'}`}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className={`text-sm font-semibold truncate ${nombre ? 'text-gray-900' : 'text-gray-400 font-normal italic'}`}>{nombre ?? 'Pagador no disponible'}</span>
                  <span className="text-xs text-gray-500 shrink-0">{formatearFechaLocal(c.date)}</span>
                </div>
                <div className="flex items-baseline justify-between gap-2 mt-0.5 text-xs">
                  <span className="text-gray-600">Importe {formatoPesos(c.original)}</span>
                  <span className="font-semibold text-green-700">Disponible {formatoPesos(c.amount)}</span>
                </div>
                {c.assigned > 0 && <p className="text-[11px] text-amber-800 mt-0.5">Parcialmente asignado: {formatoPesos(c.assigned)} ya imputado</p>}
                <p className="text-[11px] text-gray-400 mt-0.5">Ref. MP {c.sourceId}</p>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
