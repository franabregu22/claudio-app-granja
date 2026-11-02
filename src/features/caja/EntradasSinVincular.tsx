import { useState } from 'react';
import { errorMessage } from '../../target/messages';
import {
  INFLOW_SUBTYPE_LABEL, inflowTitle, PAGE_SIZE, type UnlinkedFilter, type UnlinkedInflowRow, UNLINKED_NOTE,
} from '../../target/pendingClassification';
import { formatearFechaLocal } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';
import { Paginador } from './PendientesClasificar';
import { useClassifyMp, useOwnBankAccounts, usePendingSummary, useUnlinkedInflows } from './useMpActivity';

const campo = 'border border-[#E4DCC8] rounded px-2 py-1 text-sm bg-white';
const ALCANCE: { id: UnlinkedFilter['scope']; label: string }[] = [{ id: 'current', label: 'Actuales' }, { id: 'historical', label: 'Históricas' }, { id: 'all', label: 'Todas' }];

/**
 * Caja → Entradas sin vincular (ADR-023, ADMIN): Mercado Pago inflows already in the balance and not (fully) linked to a
 * customer. Informational — an unlinked inflow is a valid permanent state and never blocks the close. Server-side filters and
 * pagination (thousands of historical receipts are never downloaded). ADR-027: an inflow is no longer linked to a client (a
 * collection is declared in Cuentas corrientes, so a link would discount the client twice); the own-account origin stays.
 */
export function EntradasSinVincular() {
  const [filtro, setFiltro] = useState<UnlinkedFilter>({ scope: 'current' });
  const [borrador, setBorrador] = useState({ from: '', to: '', min: '', max: '', search: '' });
  const [pagina, setPagina] = useState(0);
  const q = useUnlinkedInflows(filtro, pagina);
  const resumen = usePendingSummary();
  const filas = q.data?.rows ?? [];
  const total = q.data?.total ?? 0;
  const aplicar = (scope: UnlinkedFilter['scope'] = filtro.scope) => {
    const n = (v: string) => (v.trim() === '' ? undefined : Number(v));
    setFiltro({ scope, from: borrador.from || undefined, to: borrador.to || undefined, min: n(borrador.min), max: n(borrador.max), search: borrador.search || undefined });
    setPagina(0);
  };
  return (
    <section className="space-y-3" aria-label="Entradas sin vincular">
      <p className="text-sm text-[#6B5D45]">{UNLINKED_NOTE}</p>
      {resumen.data && (
        <p className="text-xs text-[#8A7A5C]">
          Actuales {resumen.data.UNLINKED_CURRENT.count} · {formatoPesos(resumen.data.UNLINKED_CURRENT.amount)} — Históricas {resumen.data.UNLINKED_HISTORICAL.count} · {formatoPesos(resumen.data.UNLINKED_HISTORICAL.amount)}
        </p>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex gap-1" role="group" aria-label="Alcance">
          {ALCANCE.map((a) => (
            <button key={a.id} type="button" onClick={() => aplicar(a.id)}
              className={`text-xs px-2 py-1 rounded border ${filtro.scope === a.id ? 'bg-[#3D3424] text-white border-[#3D3424]' : 'bg-white border-[#E4DCC8]'}`}>{a.label}</button>
          ))}
        </div>
        <label className="text-xs text-[#6B5D45]">Desde <input type="date" className={campo} value={borrador.from} onChange={(e) => setBorrador({ ...borrador, from: e.target.value })} /></label>
        <label className="text-xs text-[#6B5D45]">Hasta <input type="date" className={campo} value={borrador.to} onChange={(e) => setBorrador({ ...borrador, to: e.target.value })} /></label>
        <label className="text-xs text-[#6B5D45]">Monto mín. <input type="number" min="0" step="0.01" className={`${campo} w-24`} value={borrador.min} onChange={(e) => setBorrador({ ...borrador, min: e.target.value })} /></label>
        <label className="text-xs text-[#6B5D45]">Monto máx. <input type="number" min="0" step="0.01" className={`${campo} w-24`} value={borrador.max} onChange={(e) => setBorrador({ ...borrador, max: e.target.value })} /></label>
        <label className="text-xs text-[#6B5D45]">Buscar <input type="search" placeholder="Nº Mercado Pago o descripción" className={campo} value={borrador.search} onChange={(e) => setBorrador({ ...borrador, search: e.target.value })} /></label>
        <button type="button" onClick={() => aplicar()} className="text-xs px-3 py-1 rounded border border-[#3D3424] bg-white">Filtrar</button>
      </div>
      {q.isLoading ? <p className="text-sm text-gray-500">Cargando entradas...</p>
        : q.error ? <p className="text-sm text-red-700">{errorMessage(q.error)}</p>
          : total === 0 ? <p className="text-sm text-[#6B5D45]">No hay entradas sin vincular con estos filtros.</p> : (
            <>
              <div className="overflow-x-auto bg-white rounded-lg border border-[#E4DCC8]">
                <table className="w-full text-sm" aria-label="Entradas sin vincular">
                  <thead><tr className="text-left text-xs text-[#8A7A5C] border-b border-[#E4DCC8]">
                    <th className="px-3 py-2">Fecha</th><th className="px-3 py-2 text-right">Importe</th><th className="px-3 py-2">Tipo</th>
                    <th className="px-3 py-2">Descripción</th><th className="px-3 py-2">Nº Mercado Pago</th><th className="px-3 py-2 text-right">Sin vincular</th>
                    <th className="px-3 py-2">Acción (opcional)</th>
                  </tr></thead>
                  <tbody>{filas.map((r) => <FilaEntrada key={r.movement_id} r={r} />)}</tbody>
                </table>
              </div>
              <Paginador pagina={pagina} paginas={Math.max(1, Math.ceil(total / PAGE_SIZE))} total={total} onCambiar={setPagina} />
            </>
          )}
    </section>
  );
}

function FilaEntrada({ r }: { r: UnlinkedInflowRow }) {
  const [accion, setAccion] = useState<'none' | 'propia' | 'ignorada'>('none');
  return (
    <tr className="border-b border-stone-100 last:border-0 align-top">
      <td className="px-3 py-2 whitespace-nowrap">{formatearFechaLocal(r.business_date)}{r.is_historical && <span className="text-[11px] text-[#8A7A5C]"> · histórica</span>}</td>
      <td className="px-3 py-2 text-right whitespace-nowrap font-medium text-green-800">{formatoPesos(r.amount)}</td>
      <td className="px-3 py-2">
        <p className="font-medium">{inflowTitle(r)}</p>
        {r.payer_display_name && <p className="text-[11px] text-[#8A7A5C]">{INFLOW_SUBTYPE_LABEL[r.inflow_subtype]}</p>}
        {r.mapped_client_name && <p className="text-[11px] text-green-800">Cliente asociado: {r.mapped_client_name}</p>}
      </td>
      <td className="px-3 py-2">{r.description ?? <span className="text-[#8A7A5C]">—</span>}</td>
      <td className="px-3 py-2 whitespace-nowrap text-[#8A7A5C]">{r.source_id}</td>
      <td className="px-3 py-2 text-right whitespace-nowrap">
        {formatoPesos(r.remaining_amount)}
        {r.allocated_amount > 0 && <p className="text-[11px] text-[#8A7A5C]">vinculado {formatoPesos(r.allocated_amount)}</p>}
      </td>
      <td className="px-3 py-2">
        {accion === 'none' && (
          <div className="flex flex-wrap gap-1">
            <button type="button" onClick={() => setAccion('ignorada')} className="text-xs px-2 py-0.5 rounded border border-[#E4DCC8] bg-white hover:bg-stone-50">Ignorar</button>
            {r.account_fund && !r.is_historical && r.allocated_amount === 0 && (
              <button type="button" onClick={() => setAccion('propia')} className="text-xs px-2 py-0.5 rounded border border-[#E4DCC8] bg-white hover:bg-stone-50">Transferencia desde cuenta propia</button>
            )}
          </div>
        )}
        {accion === 'ignorada' && <p className="text-[11px] text-[#8A7A5C]">Queda sin vincular (es un estado válido).</p>}
        {accion === 'propia' && <TransferenciaPropia r={r} onCerrar={() => setAccion('none')} />}
      </td>
    </tr>
  );
}

/** Optional own-account origin (0086, live account_fund only): Mercado Pago is not moved again; the bank line is matched later. */
function TransferenciaPropia({ r, onCerrar }: { r: UnlinkedInflowRow; onCerrar: () => void }) {
  const cuentas = useOwnBankAccounts();
  const { ownTransfer } = useClassifyMp();
  const [origen, setOrigen] = useState('');
  return (
    <div className="space-y-1 text-xs">
      <select aria-label="Cuenta propia de origen" className={campo} value={origen} onChange={(e) => setOrigen(e.target.value)}>
        <option value="">Cuenta de origen…</option>
        {(cuentas.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.nombre}</option>)}
      </select>
      <div className="flex gap-1">
        <button type="button" disabled={origen === '' || ownTransfer.isPending} onClick={() => ownTransfer.mutate({ paymentId: r.source_id, fromAccountId: origen }, { onSuccess: onCerrar })}
          className="px-2 py-0.5 rounded border border-[#3D3424] bg-white disabled:opacity-40">{ownTransfer.isPending ? 'Guardando...' : 'Confirmar'}</button>
        <button type="button" onClick={onCerrar} className="px-2 py-0.5 rounded border border-[#E4DCC8] bg-white">Cancelar</button>
      </div>
      {ownTransfer.error && <p className="text-red-700">{errorMessage(ownTransfer.error)}</p>}
    </div>
  );
}
