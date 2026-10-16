import { errorMessage } from '../../target/messages';
import { isMercadoPagoAccount, type MpActivityRow, type MpPayoutMatch } from '../../target/mpActivity';
import {
  PENDING_BALANCE_NOTE, PENDING_INFLOW_NOTE, PENDING_KIND_LABEL, type PendingRow, summarizePending, TECHNICAL_ISSUE_LABEL, type TechnicalRow,
} from '../../target/pendingClassification';
import { formatearFechaLocal } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';
import { useFinancialAccounts } from '../pedidos/useCommercial';
import { ClasificarIngreso, ClasificarSalida, DestinoRetiro } from './CuentaDetalle';
import { useMpPayoutMatches, usePendingClassification, useRetryProvisional, useTechnicalReview } from './useMpActivity';

const hora = (ts: string | null) => (ts ? new Date(ts).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' }) : '');

/** The Mercado Pago account id (the payout destination proposal is read for it). */
function useMpAccountId(): string {
  const cuentas = useFinancialAccounts();
  return (cuentas.data ?? []).find((a) => isMercadoPagoAccount(a))?.id ?? '';
}

/**
 * Caja → Saldos: the pending-classification card. The totals are NOT a balance difference — the outflows are already in
 * the balance (ADR-021); they only say what is left to classify.
 */
export function TarjetaPendientes({ onAbrir }: { onAbrir: () => void }) {
  const pendientes = usePendingClassification();
  if (pendientes.isLoading || pendientes.error) return null;
  const s = summarizePending(pendientes.data ?? []);
  if (s.count === 0) {
    return <div className="bg-green-50 border border-green-200 text-green-900 rounded-lg px-4 py-2 text-sm mb-3" role="status">Todo clasificado</div>;
  }
  return (
    <button type="button" onClick={onAbrir} className="w-full text-left bg-amber-50 border border-amber-300 rounded-lg px-4 py-3 mb-3 hover:bg-amber-100">
      <p className="font-semibold text-amber-900">Pendientes de clasificar: {s.count}</p>
      <p className="text-sm text-amber-900">
        {s.outgoing > 0 && <>Salidas {formatoPesos(s.outgoing)}</>}
        {s.outgoing > 0 && s.incoming > 0 && ' · '}
        {s.incoming > 0 && <>Entradas {formatoPesos(s.incoming)}</>}
      </p>
      {s.outgoing > 0 && <p className="text-xs text-amber-800 mt-0.5">Las salidas ya están incluidas en el saldo.</p>}
    </button>
  );
}

/**
 * Caja → Pendientes de clasificar (ADR-021): only what needs a person. Each row is classified through the existing
 * server-side routes from its SOURCE_ID (amount, date and account are never sent). Technical exceptions are listed apart.
 */
export function PendientesClasificar() {
  const pendientes = usePendingClassification();
  const tecnicos = useTechnicalReview();
  const mpId = useMpAccountId();
  const coincidencias = useMpPayoutMatches(mpId);
  const matches: ReadonlyMap<string, MpPayoutMatch> = coincidencias.data ?? new Map();
  const filas = pendientes.data ?? [];
  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <p className="text-sm text-[#6B5D45]">{PENDING_BALANCE_NOTE}</p>
        {pendientes.isLoading ? <p className="text-sm text-gray-500">Cargando pendientes...</p>
          : pendientes.error ? <p className="text-sm text-red-700">{errorMessage(pendientes.error)}</p>
            : filas.length === 0 ? <p className="text-sm text-green-800">Todo clasificado.</p> : (
              <div className="overflow-x-auto bg-white rounded-lg border border-[#E4DCC8]">
                <table className="w-full text-sm" aria-label="Pendientes de clasificar">
                  <thead><tr className="text-left text-xs text-[#8A7A5C] border-b border-[#E4DCC8]">
                    <th className="px-3 py-2">Fecha</th><th className="px-3 py-2">Cuenta</th><th className="px-3 py-2 text-right">Importe</th>
                    <th className="px-3 py-2">Dirección</th><th className="px-3 py-2">Tipo</th><th className="px-3 py-2">Nº Mercado Pago</th>
                    <th className="px-3 py-2">Estado</th><th className="px-3 py-2">Acción requerida</th>
                  </tr></thead>
                  <tbody>{filas.map((r) => <FilaPendiente key={r.pending_key} r={r} matches={matches} />)}</tbody>
                </table>
              </div>
            )}
      </section>
      <RevisionTecnica filas={tecnicos.data ?? []} cargando={tecnicos.isLoading} error={tecnicos.error} />
    </div>
  );
}

function FilaPendiente({ r, matches }: { r: PendingRow; matches: ReadonlyMap<string, MpPayoutMatch> }) {
  const actividad = { description: r.description, source_id: r.source_id, coverage_status: 'PENDING_CLASSIFICATION' } as MpActivityRow;
  return (
    <tr className="border-b border-stone-100 last:border-0 align-top">
      <td className="px-3 py-2 whitespace-nowrap">{formatearFechaLocal(r.business_date)} <span className="text-[#8A7A5C]">{hora(r.occurred_at)}</span></td>
      <td className="px-3 py-2 whitespace-nowrap">{r.account_name}</td>
      <td className={`px-3 py-2 text-right whitespace-nowrap font-medium ${r.amount < 0 ? 'text-red-700' : 'text-green-800'}`}>
        {formatoPesos(r.amount)}
        {r.direction === 'OUT' && r.charges_amount !== 0 && (
          <p className="text-[11px] text-[#8A7A5C] font-normal">{formatoPesos(r.economic_amount)} + impuesto {formatoPesos(Math.abs(r.charges_amount))}</p>
        )}
      </td>
      <td className="px-3 py-2 whitespace-nowrap">{r.direction === 'OUT' ? 'Salida' : 'Entrada'}</td>
      <td className="px-3 py-2 whitespace-nowrap">{PENDING_KIND_LABEL[r.kind]}</td>
      <td className="px-3 py-2 whitespace-nowrap text-[#8A7A5C]">{r.source_id}</td>
      <td className="px-3 py-2">
        <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-900">Pendiente de clasificar</span>
        <p className="text-[11px] text-[#8A7A5C] mt-0.5">{r.already_posted ? 'Ya incluido en el saldo' : PENDING_INFLOW_NOTE}</p>
      </td>
      <td className="px-3 py-2">
        {r.kind === 'OUTBOUND' && <ClasificarSalida sourceId={r.source_id} />}
        {r.kind === 'PAYOUT' && <DestinoRetiro r={actividad} matches={matches} />}
        {r.kind === 'CLASSIFY_INFLOW' && <ClasificarIngreso paymentId={r.source_id} />}
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
