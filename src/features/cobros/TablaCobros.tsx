import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { allocationIdOf, canAnnulMpAllocation, listAllocationHistory, type CustomerCollectionRow } from '../../target/customerCollections';
import { formatearFechaLocal } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';
import { AnularCobroMpModal } from './AnularCobroMpModal';
import { NotaPopover } from './NotaPopover';

// same compact layout as the deliveries table (ListaSaldosClientes)
const TH = 'py-0.5 pr-3 text-left font-normal whitespace-nowrap';
const TD = 'py-0.5 pr-3 align-top whitespace-nowrap text-gray-700';
/** perfiles holds only e-mail: no person is shown, never an e-mail in their place. */
const SIN_DATO = 'No disponible';
const ORIGEN_REVERSION = { MANUAL_REVERSAL: 'Anulado', MP_REVERSAL: 'Devuelto en Mercado Pago' } as const;

/**
 * A client's collections (fin_customer_collections, counts_for_customer): Fecha | Monto | Cuenta | Quién registró | Nota.
 * A Mercado Pago allocation shows its original amount and every reversal (date, amount, reason) read from
 * mp_client_allocation; "Anular" is offered only while something is still reversible (canAnnulMpAllocation).
 */
export function TablaCobros({ cobros, clienteNombre }: { cobros: CustomerCollectionRow[]; clienteNombre: string }) {
  const [anulando, setAnulando] = useState<CustomerCollectionRow | null>(null);
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
            return (
              <Fragment key={p.row_id}>
                <tr className={revertido ? '' : 'border-b border-[#EFE8D6] last:border-0'}>
                  <td className={TD}>{formatearFechaLocal(p.business_date)}</td>
                  <td className={`${TD} text-right tabular-nums`}>
                    {revertido && p.amount === 0 ? <span className="line-through text-gray-400">{formatoPesos(h!.original)}</span> : formatoPesos(p.amount)}
                    {revertido && p.amount > 0 && <span className="block text-[10px] text-gray-400">de {formatoPesos(h!.original)}</span>}
                  </td>
                  <td className={TD}>
                    {p.account_name}
                    {canAnnulMpAllocation(p) && (
                      <button type="button" onClick={() => setAnulando(p)} className="ml-2 text-[11px] text-red-700 underline hover:text-red-900">Anular</button>
                    )}
                    {revertido && p.amount === 0 && <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-stone-200 text-stone-700">Anulado</span>}
                  </td>
                  <td className={`${TD} text-gray-400`}>{SIN_DATO}</td>
                  <td className="py-0.5 align-top"><NotaPopover nota={p.notes} /></td>
                </tr>
                {h?.reversals.map((r, i) => (
                  <tr key={r.id} className={i === h.reversals.length - 1 ? 'border-b border-[#EFE8D6]' : ''}>
                    <td className={`${TD} text-gray-500 pl-2`}>↳ {formatearFechaLocal(r.effective_date)}</td>
                    <td className={`${TD} text-right tabular-nums text-red-700`}>−{formatoPesos(r.amount)}</td>
                    <td className={`${TD} text-gray-500`}>{ORIGEN_REVERSION[r.origin]}</td>
                    <td className={`${TD} text-gray-400`}>{SIN_DATO}</td>
                    <td className="py-0.5 align-top"><NotaPopover nota={r.reason} /></td>
                  </tr>
                ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {anulando && <AnularCobroMpModal cobro={anulando} clienteNombre={clienteNombre} onClose={() => setAnulando(null)} />}
    </div>
  );
}
