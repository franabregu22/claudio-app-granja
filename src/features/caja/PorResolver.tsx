import { mandatoryPending } from '../../target/pendingClassification';
import { EntradasSinVincular } from './EntradasSinVincular';
import { GastosSinClasificar } from './GastosSinClasificar';
import { PendientesClasificar } from './PendientesClasificar';
import { usePendingSummary } from './useMpActivity';
import { useUnclassifiedCount } from './useUnclassified';

export type PanelPorResolver = 'pendientes' | 'sinclasificar' | 'entradas';

/**
 * Caja → Movimientos → Por resolver: the three classification lists, kept whole and only moved here. Pendientes de clasificar is
 * mandatory (ADR-021 / ADR-023); Gastos sin clasificar is the ADR-025 list; Entradas sin vincular is optional and never an alert,
 * so its card has no warning tone. The counts are the server's; the card only opens its list.
 */
export function TarjetasPorResolver({ panel, onPanel }: { panel: PanelPorResolver | null; onPanel: (p: PanelPorResolver | null) => void }) {
  const resumen = usePendingSummary();
  const gastos = useUnclassifiedCount();
  const mp = resumen.data ? mandatoryPending(resumen.data) : null;
  const entradas = resumen.data?.UNLINKED_CURRENT.count;
  const tarjetas: { id: PanelPorResolver; titulo: string; cantidad: number | undefined; detalle: string; aviso: boolean }[] = [
    { id: 'pendientes', titulo: 'Pendientes de clasificar', cantidad: mp?.count, detalle: mp ? `Actuales: ${mp.current} · Históricos: ${mp.historical}` : 'Obligatorio', aviso: (mp?.current ?? 0) > 0 },
    { id: 'sinclasificar', titulo: 'Gastos sin clasificar', cantidad: gastos.data, detalle: 'Ya pagados', aviso: (gastos.data ?? 0) > 0 },
    { id: 'entradas', titulo: 'Entradas sin vincular', cantidad: entradas, detalle: 'Opcional', aviso: false },
  ];
  return (
    <section aria-label="Por resolver">
      <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide mb-2">Por resolver</p>
      <div role="tablist" aria-label="Por resolver" className="grid grid-cols-3 gap-2">
        {tarjetas.map((t) => {
          const activa = panel === t.id;
          return (
            <button key={t.id} role="tab" aria-selected={activa} onClick={() => onPanel(activa ? null : t.id)}
              className={`text-left rounded-lg border p-2 sm:p-3 min-w-0 transition ${activa ? 'bg-white border-amber-600 ring-1 ring-amber-600 shadow-sm' : 'bg-white/60 border-[#E4DCC8] hover:border-amber-400'}`}>
              <p className="text-xs sm:text-sm font-semibold text-[#6B5D45] leading-tight">{t.titulo}</p>
              <p className={`text-xl font-bold mt-1 ${t.aviso ? 'text-amber-700' : 'text-gray-900'}`}>{t.cantidad ?? '—'}</p>
              <p className="text-[11px] sm:text-xs text-[#8A7A5C] leading-tight">{t.detalle}</p>
            </button>
          );
        })}
      </div>
    </section>
  );
}

export function PanelResolver({ panel, onPanel }: { panel: PanelPorResolver; onPanel: (p: PanelPorResolver) => void }) {
  if (panel === 'pendientes') return <PendientesClasificar />;
  if (panel === 'entradas') return <EntradasSinVincular />;
  return <GastosSinClasificar onVerPendientesMp={() => onPanel('pendientes')} />;
}
