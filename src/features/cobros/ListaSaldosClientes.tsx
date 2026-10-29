import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { orderTotal, type ClientBalance, type OrderRow } from '../../target/commercial';
import type { CustomerCollectionRow } from '../../target/customerCollections';
import { formatearFechaLocal } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';

type Variante = 'deudor' | 'finalizado' | 'credito';
/** perfiles holds only e-mail (no first / last name) and pedidos records only who CONFIRMED the delivery (delivered_by), not
 * who delivered it: neither person is shown, never an e-mail in their place. */
const SIN_DATO = 'No disponible';
const GRILLA = 'grid grid-cols-[5.5rem_1fr_1fr_1fr] gap-x-2 text-xs';
const TONO: Record<Variante, { nombre: string; monto: string }> = {
  deudor: { nombre: 'text-amber-900', monto: 'text-red-600' },
  finalizado: { nombre: 'text-amber-900', monto: 'text-[#6B7A4E]' },
  credito: { nombre: 'text-green-900', monto: 'text-green-700' },
};

interface Props {
  variante: Variante;
  clientes: ClientBalance[];
  entregas: OrderRow[];
  cobros: CustomerCollectionRow[];
  onRegistrarPago?: (cliente: ClientBalance) => void;
}

/**
 * Client balances (F27-C). The balance is the client-ledger closing balance from report_balance_period; the
 * expandable detail lists the client's delivered orders (date, number, total) and the collections that count for the
 * balance (date, amount, account, comment), as read (nothing is recomputed).
 */
export function ListaSaldosClientes({ variante, clientes, entregas, cobros, onRegistrarPago }: Props) {
  const [expandido, setExpandido] = useState<string | null>(null);
  if (clientes.length === 0) return <p className="text-sm text-[#8A7A5C] px-5 py-6">No hay clientes en esta situación.</p>;

  return (
    <div className="px-5 py-4 space-y-2">
      {clientes.map((c) => {
        const abierto = expandido === c.cliente_id;
        const pedidos = entregas.filter((p) => p.cliente_id === c.cliente_id);
        const pagos = cobros.filter((p) => p.cliente_id === c.cliente_id);
        const monto = variante === 'credito' ? Math.abs(c.balance) : c.balance;
        return (
          <div key={c.cliente_id} className="bg-white rounded-lg border border-[#E4DCC8] overflow-hidden">
            <button onClick={() => setExpandido(abierto ? null : c.cliente_id)} className="w-full flex items-center justify-between gap-2 p-4 text-left">
              <div className="flex items-center gap-2">
                <ChevronDown className={`w-4 h-4 transition ${abierto ? 'rotate-180' : ''}`} />
                <span className={`font-semibold ${TONO[variante].nombre}`}>{c.cliente_nombre}</span>
              </div>
              <span className={`font-bold ${TONO[variante].monto}`}>
                {variante === 'finalizado' ? 'Saldo cero' : `${variante === 'credito' ? 'Crédito ' : ''}${formatoPesos(monto)}`}
              </span>
            </button>
            {abierto && (
              <div className="px-4 pb-4 border-t border-[#E4DCC8] bg-[#FAF6EE] space-y-4">
                <div>
                  <p className="text-xs font-semibold text-[#6B5D45] uppercase mt-3 mb-1">Entregas</p>
                  {pedidos.length === 0 ? <p className="text-xs text-gray-500">Sin entregas registradas</p> : (
                    <div className="space-y-0.5">
                      <div className={`${GRILLA} text-[#8A7A5C]`}><span>Fecha</span><span>N.º pedido</span><span className="text-right">Monto total</span><span>Quién entregó</span></div>
                      {pedidos.map((p) => (
                        <div key={p.id} className={`${GRILLA} text-gray-700`}>
                          <span>{p.delivered_date ? formatearFechaLocal(p.delivered_date) : '—'}</span>
                          <span>{p.numero_pedido ?? '—'}</span>
                          <span className="text-right">{formatoPesos(orderTotal(p))}</span>
                          <span className="text-gray-400">{SIN_DATO}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div>
                  <p className="text-xs font-semibold text-[#6B5D45] uppercase mb-1">Cobros</p>
                  {pagos.length === 0 ? <p className="text-xs text-gray-500">Sin cobros registrados</p> : (
                    <div className="space-y-0.5">
                      <div className={`${GRILLA} text-[#8A7A5C]`}><span>Fecha</span><span className="text-right">Monto</span><span>Cuenta</span><span>Quién registró</span></div>
                      {pagos.map((p) => (
                        <div key={p.row_id}>
                          <div className={`${GRILLA} text-gray-700`}>
                            <span>{formatearFechaLocal(p.business_date)}</span>
                            <span className="text-right">{formatoPesos(p.amount)}</span>
                            <span>{p.account_name}</span>
                            <span className="text-gray-400">{SIN_DATO}</span>
                          </div>
                          {p.notes && p.notes.trim() !== '' && <p className="text-xs text-gray-500 italic pl-[5.5rem] break-words">{p.notes}</p>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                {variante === 'deudor' && onRegistrarPago && (
                  <button onClick={() => onRegistrarPago(c)} className="w-full bg-amber-600 hover:bg-amber-700 text-white font-medium py-2 rounded-lg text-sm">
                    Registrar cobro
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

