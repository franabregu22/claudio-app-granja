import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { allocationIdOf, canAnnulMpAllocation, canReverseManualCollection, listAllocationHistory, type CustomerCollectionRow } from '../../target/customerCollections';
import { formatearFechaLocal } from '../../utils/dateUtils';
import { RESPONSABLE_NO_DISPONIBLE } from '../../target/masters';
import { formatoPesos } from '../pedidos/helpers';
import { useProfileDisplayNames } from '../pedidos/useCommercial';
import { AnularCobroModal } from './AnularCobroModal';
import { AnularCobroMpModal } from './AnularCobroMpModal';
import { NotaPopover } from './NotaPopover';
import { RectificarCobroModal } from './RectificarCobroModal';

// same compact layout as the deliveries table (ListaSaldosClientes)
const TH = 'py-0.5 pr-3 text-left font-normal whitespace-nowrap';
const TD = 'py-0.5 pr-3 align-top whitespace-nowrap text-gray-700';
/** A responsible person: the stored user id by name (0109), "No disponible" without one — never an e-mail. */
const Persona = ({ id, names }: { id: string | null | undefined; names: ReadonlyMap<string, string> }) => {
  const n = id ? names.get(id) : undefined;
  return <td className={`${TD} ${n ? '' : 'text-gray-400'}`}>{n ?? RESPONSABLE_NO_DISPONIBLE}</td>;
};
const ORIGEN_REVERSION = { MANUAL_REVERSAL: 'Anulado', MP_REVERSAL: 'Devuelto en Mercado Pago' } as const;
const REVERSION_MANUAL = { ANNUL: 'Anulado', RECTIFY: 'Rectificado' } as const;
const ENLACE = 'ml-2 text-[11px] underline';

/**
 * A client's collections (fin_customer_collections, counts_for_customer): Fecha | Monto | Cuenta | Quién registró | Nota.
 * A Mercado Pago allocation shows its original amount and every reversal (date, amount, reason) read from
 * mp_client_allocation; "Anular" is offered only while something is still reversible (canAnnulMpAllocation).
 * A cash / bank collection (0108) offers "Anular" / "Rectificar" (canReverseManualCollection); an annulled / rectified original
 * stays listed as evidence (struck through, not counted) with its reversal line, and a replacement is tagged "Rectificación".
 */
export function TablaCobros({ cobros, clienteNombre }: { cobros: CustomerCollectionRow[]; clienteNombre: string }) {
  const [anulando, setAnulando] = useState<CustomerCollectionRow | null>(null);
  const nombres = useProfileDisplayNames().data ?? new Map<string, string>();
  const [accion, setAccion] = useState<{ tipo: 'anular' | 'rectificar'; cobro: CustomerCollectionRow } | null>(null);
  const ids = cobros.map(allocationIdOf).filter((x): x is string => x !== null).sort();
  const historial = useQuery({ queryKey: ['customer-collections', 'allocation-history', ids], enabled: ids.length > 0,
    queryFn: () => listAllocationHistory(supabase, ids) });

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[#8A7A5C] border-b border-[#E4DCC8]">
            <th className={TH}>Fecha</th><th className={`${TH} text-right`}>Monto</th><th className={TH}>Cuenta</th><th className={TH}>Quién registró</th>
            <th className="py-0.5 text-left font-normal w-full">Nota</th>
          </tr>
        </thead>
        <tbody>
          {cobros.map((p) => {
            const alloc = allocationIdOf(p);
            const h = alloc ? historial.data?.get(alloc) : undefined;
            const revertido = h ? h.reversals.length > 0 : false;
            const manual = p.reversal_kind;   // 0108: annulled / rectified cash or bank original (evidence, not counted)
            return (
              <Fragment key={p.row_id}>
                <tr className={revertido || manual ? '' : 'border-b border-[#EFE8D6] last:border-0'}>
                  <td className={TD}>{formatearFechaLocal(p.business_date)}</td>
                  <td className={`${TD} text-right tabular-nums`}>
                    {(revertido && p.amount === 0) || manual
                      ? <span className="line-through text-gray-400">{formatoPesos(manual ? p.amount : h!.original)}</span> : formatoPesos(p.amount)}
                    {revertido && p.amount > 0 && <span className="block text-[10px] text-gray-400">de {formatoPesos(h!.original)}</span>}
                  </td>
                  <td className={TD}>
                    {p.account_name}
                    {canAnnulMpAllocation(p) && (
                      <button type="button" onClick={() => setAnulando(p)} className="ml-2 text-[11px] text-red-700 underline hover:text-red-900">Anular</button>
                    )}
                    {canReverseManualCollection(p) && <>
                      <button type="button" onClick={() => setAccion({ tipo: 'anular', cobro: p })} className={`${ENLACE} text-red-700 hover:text-red-900`}>Anular</button>
                      <button type="button" onClick={() => setAccion({ tipo: 'rectificar', cobro: p })} className={`${ENLACE} text-amber-800 hover:text-amber-950`}>Rectificar</button>
                    </>}
                    {((revertido && p.amount === 0) || manual) && (
                      <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-stone-200 text-stone-700">{manual ? REVERSION_MANUAL[manual] : 'Anulado'}</span>
                    )}
                    {p.replacement_of && <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-900">Rectificación</span>}
                  </td>
                  <Persona id={p.registered_by} names={nombres} />
                  <td className="py-0.5 align-top"><NotaPopover nota={p.notes} /></td>
                </tr>
                {manual && (
                  <tr className="border-b border-[#EFE8D6]">
                    <td className={`${TD} text-gray-500 pl-2`}>↳ {p.reversal_at ? formatearFechaLocal(p.reversal_at.slice(0, 10)) : '—'}</td>
                    <td className={`${TD} text-right tabular-nums text-red-700`}>−{formatoPesos(p.amount)}</td>
                    <td className={`${TD} text-gray-500`}>{manual === 'RECTIFY' ? 'Rectificado (ver cobro correcto)' : 'Anulado'}</td>
                    <Persona id={p.reversal_by} names={nombres} />
                    <td className="py-0.5 align-top"><NotaPopover nota={p.reversal_reason} /></td>
                  </tr>
                )}
                {h?.reversals.map((r, i) => (
                  <tr key={r.id} className={i === h.reversals.length - 1 ? 'border-b border-[#EFE8D6]' : ''}>
                    <td className={`${TD} text-gray-500 pl-2`}>↳ {formatearFechaLocal(r.effective_date)}</td>
                    <td className={`${TD} text-right tabular-nums text-red-700`}>−{formatoPesos(r.amount)}</td>
                    <td className={`${TD} text-gray-500`}>{ORIGEN_REVERSION[r.origin]}</td>
                    <Persona id={r.created_by} names={nombres} />
                    <td className="py-0.5 align-top"><NotaPopover nota={r.reason} /></td>
                  </tr>
                ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {anulando && <AnularCobroMpModal cobro={anulando} clienteNombre={clienteNombre} onClose={() => setAnulando(null)} />}
      {accion?.tipo === 'anular' && <AnularCobroModal cobro={accion.cobro} clienteNombre={clienteNombre} onClose={() => setAccion(null)} />}
      {accion?.tipo === 'rectificar' && <RectificarCobroModal cobro={accion.cobro} clienteNombre={clienteNombre} onClose={() => setAccion(null)} />}
    </div>
  );
}
