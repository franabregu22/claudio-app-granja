import { useState } from 'react';
import { errorMessage } from '../../target/messages';
import { isMercadoPagoAccount, type MpActivityRow, type MpPayoutMatch } from '../../target/mpActivity';
import {
  DESTINATION_STATUS_LABEL, HISTORICAL_ACTION, HISTORICAL_PENDING_NOTE, mandatoryPending, maskedAccount, PAGE_SIZE, PENDING_BALANCE_NOTE, PENDING_KIND_LABEL,
  type PendingRow, type PendingScope, TECHNICAL_ISSUE_LABEL, type TechnicalRow,
} from '../../target/pendingClassification';
import { formatearFechaLocal } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';
import { useFinancialAccounts } from '../pedidos/useCommercial';
import { ClasificarSalida, DestinoRetiro } from './CuentaDetalle';
import { useMpPayoutMatches, usePendingPage, usePendingSummary, useRetryProvisional, useTechnicalReview } from './useMpActivity';

const hora = (ts: string | null) => (ts ? new Date(ts).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' }) : '');

/** The Mercado Pago account id (the payout destination proposal is read for it). */
function useMpAccountId(): string {
  const cuentas = useFinancialAccounts();
  return (cuentas.data ?? []).find((a) => isMercadoPagoAccount(a))?.id ?? '';
}

/**
 * Caja → Saldos: the pending-classification card. Mandatory outflows only (ADR-023), counted by the server. The totals are NOT a
 * balance difference — the outflows are already in the balance (ADR-021). Unlinked inflows are informational, never an alert.
 */
export function TarjetaPendientes({ onAbrir }: { onAbrir: () => void }) {
  const resumen = usePendingSummary();
  if (resumen.isLoading || resumen.error || !resumen.data) return null;
  const s = mandatoryPending(resumen.data);
  const sinVincular = resumen.data.UNLINKED_CURRENT.count;
  if (s.count === 0) {
    return <div className="bg-green-50 border border-green-200 text-green-900 rounded-lg px-4 py-2 text-sm mb-3" role="status">Todo clasificado</div>;
  }
  return (
    <button type="button" onClick={onAbrir} className="w-full text-left bg-amber-50 border border-amber-300 rounded-lg px-4 py-3 mb-3 hover:bg-amber-100">
      <p className="font-semibold text-amber-900">Pendientes de clasificar: {s.count} · {formatoPesos(s.outgoing)}</p>
      <p className="text-xs text-amber-800 mt-0.5">
        Actuales {s.current} · Históricos {s.historical} — las salidas ya están incluidas en el saldo.
      </p>
      {sinVincular > 0 && <p className="text-xs text-[#8A7A5C] mt-0.5">Entradas sin vincular: {sinVincular} (opcional)</p>}
    </button>
  );
}

/**
 * Caja → Pendientes de clasificar (ADR-021 / ADR-023): mandatory outflows only, current and historical listed apart and
 * paginated (the historical volume can never hide a current pending). A current row is classified through the existing
 * server-side routes from its SOURCE_ID; a historical row shows its destination status and no action yet. Technical exceptions
 * are listed apart.
 */
export function PendientesClasificar() {
  const resumen = usePendingSummary();
  const tecnicos = useTechnicalReview();
  const mpId = useMpAccountId();
  const coincidencias = useMpPayoutMatches(mpId);
  const matches: ReadonlyMap<string, MpPayoutMatch> = coincidencias.data ?? new Map();
  return (
    <div className="space-y-6">
      <ListaPendientes scope="current" titulo="Pendientes actuales" nota={PENDING_BALANCE_NOTE} matches={matches}
        total={resumen.data?.PENDING_CURRENT} />
      <ListaPendientes scope="historical" titulo="Pendientes históricos (antes del corte)" nota={HISTORICAL_PENDING_NOTE} matches={matches}
        total={resumen.data?.PENDING_HISTORICAL} />
      <RevisionTecnica filas={tecnicos.data ?? []} cargando={tecnicos.isLoading} error={tecnicos.error} />
    </div>
  );
}

function ListaPendientes({ scope, titulo, nota, matches, total }: {
  scope: PendingScope; titulo: string; nota: string; matches: ReadonlyMap<string, MpPayoutMatch>; total?: { count: number; amount: number };
}) {
  const [pagina, setPagina] = useState(0);
  const q = usePendingPage(scope, pagina);
  const filas = q.data?.rows ?? [];
  const cantidad = q.data?.total ?? 0;
  const paginas = Math.max(1, Math.ceil(cantidad / PAGE_SIZE));
  return (
    <section className="space-y-2" aria-label={titulo}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold text-[#3D3424]">{titulo}{total ? `: ${total.count} · ${formatoPesos(Math.abs(total.amount))}` : ''}</p>
        <p className="text-xs text-[#6B5D45]">{nota}</p>
      </div>
      {q.isLoading ? <p className="text-sm text-gray-500">Cargando pendientes...</p>
        : q.error ? <p className="text-sm text-red-700">{errorMessage(q.error)}</p>
          : cantidad === 0 ? <p className="text-sm text-green-800">Todo clasificado.</p> : (
            <>
              <div className="overflow-x-auto bg-white rounded-lg border border-[#E4DCC8]">
                <table className="w-full text-sm" aria-label={titulo}>
                  <thead><tr className="text-left text-xs text-[#8A7A5C] border-b border-[#E4DCC8]">
                    <th className="px-3 py-2">Fecha</th><th className="px-3 py-2">Cuenta</th><th className="px-3 py-2 text-right">Importe</th>
                    <th className="px-3 py-2">Tipo</th><th className="px-3 py-2">Nº Mercado Pago</th><th className="px-3 py-2">Destino</th>
                    <th className="px-3 py-2">Estado</th><th className="px-3 py-2">Acción requerida</th>
                  </tr></thead>
                  <tbody>{filas.map((r) => <FilaPendiente key={r.pending_key} r={r} matches={matches} />)}</tbody>
                </table>
              </div>
              <Paginador pagina={pagina} paginas={paginas} total={cantidad} onCambiar={setPagina} />
            </>
          )}
    </section>
  );
}

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

function FilaPendiente({ r, matches }: { r: PendingRow; matches: ReadonlyMap<string, MpPayoutMatch> }) {
  const actividad = { description: r.description, source_id: r.source_id, coverage_status: 'PENDING_CLASSIFICATION' } as MpActivityRow;
  const destino = r.destination_status ? DESTINATION_STATUS_LABEL[r.destination_status] : null;
  const cuenta = r.matched_account_name ?? maskedAccount(r.destination_last4);
  return (
    <tr className="border-b border-stone-100 last:border-0 align-top">
      <td className="px-3 py-2 whitespace-nowrap">{formatearFechaLocal(r.business_date)} <span className="text-[#8A7A5C]">{hora(r.occurred_at)}</span></td>
      <td className="px-3 py-2 whitespace-nowrap">{r.account_name}</td>
      <td className="px-3 py-2 text-right whitespace-nowrap font-medium text-red-700">
        {formatoPesos(r.amount)}
        {r.charges_amount !== 0 && (
          <p className="text-[11px] text-[#8A7A5C] font-normal">{formatoPesos(r.economic_amount)} + impuesto {formatoPesos(Math.abs(r.charges_amount))}</p>
        )}
      </td>
      <td className="px-3 py-2 whitespace-nowrap">{PENDING_KIND_LABEL[r.kind]}{r.is_historical && <span className="text-[11px] text-[#8A7A5C]"> · histórico</span>}</td>
      <td className="px-3 py-2 whitespace-nowrap text-[#8A7A5C]">{r.source_id}</td>
      <td className="px-3 py-2">{destino ? <>{destino}{cuenta && <span className="text-[#8A7A5C]"> · {cuenta}</span>}</> : <span className="text-[#8A7A5C]">—</span>}</td>
      <td className="px-3 py-2">
        <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-900">Pendiente de clasificar</span>
        <p className="text-[11px] text-[#8A7A5C] mt-0.5">Ya incluido en el saldo</p>
      </td>
      <td className="px-3 py-2">
        {r.is_historical ? <span className="text-xs text-[#8A7A5C]">{HISTORICAL_ACTION}</span> : (
          <>
            {r.kind === 'OUTBOUND' && <ClasificarSalida sourceId={r.source_id} />}
            {r.kind === 'PAYOUT' && <DestinoRetiro r={actividad} matches={matches} />}
          </>
        )}
      </td>
    </tr>
  );
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
