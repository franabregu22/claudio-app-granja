import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { orderTotal, type ClientBalance, type CollectionRow, type OrderRow } from '../../target/commercial';
import { formatearFechaLocal } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';

type Variante = 'deudor' | 'finalizado' | 'credito';
const METODO: Record<string, string> = { CASH: 'Efectivo', TRANSFER: 'Transferencia', MERCADOPAGO: 'MercadoPago', CHEQUE: 'Cheque' };
const TONO: Record<Variante, { nombre: string; monto: string }> = {
  deudor: { nombre: 'text-amber-900', monto: 'text-red-600' },
  finalizado: { nombre: 'text-amber-900', monto: 'text-[#6B7A4E]' },
  credito: { nombre: 'text-green-900', monto: 'text-green-700' },
};

interface Props {
  variante: Variante;
  clientes: ClientBalance[];
  entregas: OrderRow[];
  cobros: CollectionRow[];
  onRegistrarPago?: (cliente: ClientBalance) => void;
}

/**
 * Client balances (F27-C). The balance is the client-ledger closing balance from report_balance_period; the
 * expandable detail lists the client's delivered orders and collections as read (nothing is recomputed).
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
                  {pedidos.length === 0 ? <p className="text-xs text-gray-500">Sin entregas registradas</p> : pedidos.map((p) => (
                    <p key={p.id} className="text-xs text-gray-700">
                      {p.delivered_date ? formatearFechaLocal(p.delivered_date) : '—'} · {p.lineas.map((l) => `${l.cantidad} ${l.producto_nombre}`).join(', ')} · {formatoPesos(orderTotal(p))}
                    </p>
                  ))}
                </div>
                <div>
                  <p className="text-xs font-semibold text-[#6B5D45] uppercase mb-1">Cobros</p>
                  {pagos.length === 0 ? <p className="text-xs text-gray-500">Sin cobros registrados</p> : pagos.map((p) => (
                    <p key={p.id} className="text-xs text-gray-700">
                      {formatearFechaLocal(p.effective_date)} · {formatoPesos(p.amount)} · {METODO[p.payment_method] ?? p.payment_method} · {p.receipt_id}
                    </p>
                  ))}
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
