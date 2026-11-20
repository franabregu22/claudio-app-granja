import { errorMessage } from '../../target/messages';
import { TECHNICAL_ISSUE_LABEL, type TechnicalRow } from '../../target/pendingClassification';
import { formatearFechaLocal } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';
import { useRetryProvisional, useTechnicalReview } from './useMpActivity';

export function Paginador({ pagina, paginas, total, onCambiar }: { pagina: number; paginas: number; total: number; onCambiar: (p: number) => void }) {
  if (paginas <= 1) return <p className="text-xs text-[#8A7A5C]">{total} en total</p>;
  return (
    <div className="flex items-center gap-2 text-xs text-[#6B5D45]" role="navigation" aria-label="Paginación">
      <button type="button" disabled={pagina === 0} onClick={() => onCambiar(pagina - 1)} className="px-2 py-0.5 rounded border border-[#E4DCC8] disabled:opacity-40">Anterior</button>
      <span>Página {pagina + 1} de {paginas} · {total} en total</span>
      <button type="button" disabled={pagina + 1 >= paginas} onClick={() => onCambiar(pagina + 1)} className="px-2 py-0.5 rounded border border-[#E4DCC8] disabled:opacity-40">Siguiente</button>
    </div>
  );
}

/** The technical exceptions of Pendientes de clasificar (owner 2026-11-20: the tray of BandejaPendientesMp shows them below the cards). */
export function RevisionTecnicaMp() {
  const tecnicos = useTechnicalReview();
  return <RevisionTecnica filas={tecnicos.data ?? []} cargando={tecnicos.isLoading} error={tecnicos.error} />;
}

/** Technical exceptions: an outflow whose provisional could not be posted (retry) or a report row in error. */
function RevisionTecnica({ filas, cargando, error }: { filas: TechnicalRow[]; cargando: boolean; error: unknown }) {
  const reintentar = useRetryProvisional();
  if (cargando) return null;
  if (error) return <p className="text-sm text-red-700">{errorMessage(error)}</p>;
  if (filas.length === 0) return null;
  return (
    <section className="space-y-2" aria-label="Revisión técnica">
      <p className="text-xs font-semibold text-red-800 uppercase tracking-wide">Revisión técnica ({filas.length})</p>
      <p className="text-xs text-[#8A7A5C]">Movimientos del reporte que no se pudieron registrar. Mientras existan, el día no figura como conciliado y el período no se puede cerrar.</p>
      <ul className="space-y-1">
        {filas.map((t) => (
          <li key={`${t.issue}:${t.source_id}:${t.description}`} className="bg-white border border-red-200 rounded-lg px-3 py-2 text-sm flex flex-wrap items-center gap-2">
            <span className="font-medium text-red-800">{TECHNICAL_ISSUE_LABEL[t.issue]}</span>
            <span>{formatearFechaLocal(t.business_date)}</span>
            <span className="text-[#8A7A5C]">{t.source_id}</span>
            {t.amount !== null && <span>{formatoPesos(t.amount)}</span>}
            {t.review_code && <span className="text-xs text-[#8A7A5C]">{t.review_code}</span>}
            {t.issue === 'UNPOSTED_OUTFLOW' && (
              <button type="button" disabled={reintentar.isPending} onClick={() => reintentar.mutate(t.source_id)}
                className="text-xs px-2 py-0.5 rounded border border-red-300 bg-white text-red-800 hover:bg-red-50 disabled:opacity-50">
                {reintentar.isPending ? 'Reintentando...' : 'Reintentar registro'}
              </button>
            )}
          </li>
        ))}
      </ul>
      {reintentar.error && <p className="text-xs text-red-700">{errorMessage(reintentar.error)}</p>}
    </section>
  );
}
