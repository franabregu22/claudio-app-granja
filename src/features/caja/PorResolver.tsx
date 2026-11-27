import { mandatoryPending } from '../../target/pendingClassification';
import type { PendingFilter } from '../../target/movementHistory';
import { usePendingSummary } from './useMpActivity';
import { useUnclassifiedCount } from './useUnclassified';

/**
 * Caja → Movimientos → Por resolver (0116): the three indicators, each a filter of the same movement list (no list of its own).
 * Pendientes de clasificar and Gastos sin clasificar need action (ADR-021 / ADR-023 / ADR-025); Entradas sin vincular is optional and
 * never an alert, so its card has no warning tone. The counts are the server's; touching an active card removes its filter.
 */
export function TarjetasPorResolver({ activo, onFiltro }: { activo: PendingFilter | null; onFiltro: (p: PendingFilter | null) => void }) {
  const resumen = usePendingSummary();
  const gastos = useUnclassifiedCount();
  const mp = resumen.data ? mandatoryPending(resumen.data) : null;
  // owner 2026-11-27: the number is what needs action (current); the historical ones (before the 01/12 cutover) are optional
  const tarjetas: { id: PendingFilter; titulo: string; cantidad: number | undefined; detalle: string; aviso: boolean; requerido: boolean }[] = [
    { id: 'MP_CLASIFICAR', titulo: 'Pendientes de clasificar', cantidad: mp?.current, detalle: mp ? (mp.historical > 0 ? `Requiere acción · además ${mp.historical} históricos (antes del corte, opcionales)` : 'Requiere acción') : 'Requiere acción', aviso: (mp?.current ?? 0) > 0, requerido: true },
    { id: 'GASTO_SIN_CLASIFICAR', titulo: 'Gastos sin clasificar', cantidad: gastos.data, detalle: 'Ya pagados · requiere acción', aviso: (gastos.data ?? 0) > 0, requerido: true },
    // owner 2026-11-25: «Entradas sin vincular» is not a card any more (optional, never reviewed): only what requires action
  ];
  return (
    <section aria-label="Por resolver">
      <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide mb-2">Por resolver</p>
      <div role="group" aria-label="Filtros por resolver" className="grid grid-cols-2 gap-2">
        {tarjetas.map((t) => {
          const elegida = activo === t.id;
          return (
            <button key={t.id} type="button" aria-pressed={elegida} onClick={() => onFiltro(elegida ? null : t.id)}
              title={elegida ? 'Quitar el filtro' : 'Mostrar solo estos movimientos'}
              className={`text-left rounded-lg border p-2 sm:p-3 min-w-0 transition ${elegida ? 'bg-white border-amber-600 ring-1 ring-amber-600 shadow-sm' : 'bg-white/60 border-[#E4DCC8] hover:border-amber-400'}`}>
              <p className="text-xs sm:text-sm font-semibold text-[#6B5D45] leading-tight">{t.titulo}</p>
              <p className={`text-xl font-bold mt-1 ${t.aviso ? 'text-amber-700' : 'text-gray-900'}`}>{t.cantidad ?? '—'}</p>
              <p className={`text-[11px] sm:text-xs leading-tight ${t.requerido ? 'text-[#8A7A5C]' : 'text-sky-800'}`}>{t.detalle}</p>
            </button>
          );
        })}
      </div>
      {/* the optional list stays reachable, without a count */}
      <button type="button" onClick={() => onFiltro(activo === 'ENTRADA_SIN_VINCULAR' ? null : 'ENTRADA_SIN_VINCULAR')} className="mt-1 text-[11px] text-[#8A7A5C] hover:underline">
        {activo === 'ENTRADA_SIN_VINCULAR' ? 'Ocultar entradas de Mercado Pago sin vincular' : 'Ver entradas de Mercado Pago sin vincular (opcional)'}</button>
    </section>
  );
}
