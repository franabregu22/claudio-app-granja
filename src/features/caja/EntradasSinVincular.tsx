import { useState } from 'react';
import { errorMessage } from '../../target/messages';
import { INFLOW_SUBTYPE_LABEL, inflowTitle, type UnlinkedInflowRow } from '../../target/pendingClassification';
import { formatoPesos } from '../pedidos/helpers';
import { isMercadoPagoAccount } from '../../target/mpActivity';
import { formatearFechaLocal } from '../../utils/dateUtils';
import { useFinancialAccounts } from '../pedidos/useCommercial';
import { ClasificarIngreso } from './AccionesMp';
import { useClassifyMp, useMpActivity, useOwnBankAccounts, useUnlinkedByMovement } from './useMpActivity';

const campo = 'border border-[#E4DCC8] rounded px-2 py-1 text-sm bg-white';

/**
 * Caja → Movimientos → Por resolver → Entradas sin vincular (ADR-023, ADMIN; 0116: a filter of the movement list). A Mercado Pago inflow
 * already in the balance and not (fully) linked to a customer. Optional: an unlinked inflow is a valid permanent state and never
 * blocks the close. ADR-027: an inflow is not linked to a client here (a collection is declared in Cuentas corrientes); the own-account
 * origin stays (0086, live account_fund only).
 */
export function AccionEntrada({ movementId }: { movementId: number }) {
  const q = useUnlinkedByMovement(movementId);
  const [accion, setAccion] = useState<'none' | 'propia' | 'ignorada'>('none');
  const r = q.data;
  if (q.isLoading) return <p className="text-xs text-gray-500">Buscando la entrada...</p>;
  if (q.error) return <p className="text-xs text-red-700">{errorMessage(q.error)}</p>;
  if (!r) return <p className="text-xs text-green-800">Ya vinculada.</p>;
  return (
    <div className="space-y-1 text-sm" aria-label="Entrada sin vincular">
      <p>
        <span className="font-medium">{inflowTitle(r)}</span>
        {r.payer_display_name && <span className="text-[#8A7A5C]"> · {INFLOW_SUBTYPE_LABEL[r.inflow_subtype]}</span>}
        <span className="text-[#8A7A5C]"> · Nº Mercado Pago {r.source_id}{r.is_historical ? ' · histórica' : ''}</span>
      </p>
      {r.description && <p className="text-xs text-[#6B5D45]">{r.description}</p>}
      {r.mapped_client_name && <p className="text-xs text-green-800">Cliente asociado: {r.mapped_client_name}</p>}
      <p className="text-xs text-[#6B5D45]">Sin vincular {formatoPesos(r.remaining_amount)}{r.allocated_amount > 0 ? ` · vinculado ${formatoPesos(r.allocated_amount)}` : ''}. Opcional: no bloquea el cierre.</p>
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
    </div>
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

/**
 * 0089 / 0116 — Mercado Pago inflows from an account_fund + DEBIN left unapplied (CLASSIFY_INFLOW): not money in the ERP yet, so
 * they are not a movement row. Shown under Entradas sin vincular with their classification (own account or client receipt without a
 * client, ADR-027); classifying applies them through the existing routes.
 */
export function IngresosSinAplicar() {
  const cuentas = useFinancialAccounts();
  const mpId = (cuentas.data ?? []).find((a) => isMercadoPagoAccount(a))?.id ?? '';
  const actividad = useMpActivity(mpId);
  const filas = (actividad.data ?? []).filter((r) => r.coverage_status === 'CLASSIFY_INFLOW' && r.source_id);
  if (actividad.isLoading || filas.length === 0) return null;
  return (
    <section className="bg-white border border-amber-200 rounded-lg p-3 space-y-1" aria-label="Ingresos de Mercado Pago sin aplicar">
      <p className="text-sm font-medium text-[#3D3424]">Ingresos de Mercado Pago sin aplicar ({filas.length})</p>
      <p className="text-xs text-[#8A7A5C]">Todavía no están en el saldo: al clasificarlos (cuenta propia o cobro de cliente) se registran una sola vez.</p>
      <ul className="space-y-1">
        {filas.map((r) => (
          <li key={`${r.run_id}:${r.row_number}`} className="text-sm flex flex-wrap items-center gap-2">
            <span>{formatearFechaLocal(r.business_date)} · Nº {r.source_id} · {formatoPesos(r.gross_amount ?? r.net_amount ?? 0)}</span>
            <ClasificarIngreso paymentId={r.source_id as string} />
          </li>
        ))}
      </ul>
    </section>
  );
}
