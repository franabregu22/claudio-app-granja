import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { orderTotal, type ClientBalance, type OrderRow } from '../../target/commercial';
import { RESPONSABLE_NO_DISPONIBLE } from '../../target/masters';
import type { CustomerCollectionRow } from '../../target/customerCollections';
import { TablaCobros } from './TablaCobros';
import { formatearFechaLocal } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';

export type Variante = 'deudor' | 'finalizado' | 'credito';
/** "Quién entregó" = the delivery responsible of 0100 (delivered_by, the ADMIN who confirmed it — the same person Pedidos shows as
 * "Entregado por"), by name (0109); "No disponible" without one — never an e-mail, never updated_by / created_by. */
// compact tables: columns as wide as their content
const TH = 'py-0.5 pr-3 text-left font-normal whitespace-nowrap';
const TD = 'py-0.5 pr-3 align-top whitespace-nowrap text-gray-700';
const CABECERA = 'text-[#8A7A5C] border-b border-[#E4DCC8]';
const FILA = 'border-b border-[#EFE8D6] last:border-0';
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
 * balance (TablaCobros: date, amount, account, note, Mercado Pago reversals), as read (nothing is recomputed).
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
                {variante === 'finalizado' ? 'Al día' : `${variante === 'credito' ? 'A favor ' : ''}${formatoPesos(monto)}`}
              </span>
            </button>
            {abierto && (
              <div className="px-4 pb-4 border-t border-[#E4DCC8] bg-[#FAF6EE] space-y-4">
                <div>
                  <p className="text-xs font-semibold text-[#6B5D45] uppercase mt-3 mb-1">Entregas</p>
                  {pedidos.length === 0 ? <p className="text-xs text-gray-500">Sin entregas registradas</p> : (
                    <div className="overflow-x-auto">
                      <table className="text-xs">
                        <thead><tr className={CABECERA}><th className={TH}>Fecha</th><th className={TH}>N.º pedido</th><th className={`${TH} text-right`}>Monto total</th><th className={TH}>Quién entregó</th></tr></thead>
                        <tbody>
                          {pedidos.map((p) => (
                            <tr key={p.id} className={FILA}>
                              <td className={TD}>{p.delivered_date ? formatearFechaLocal(p.delivered_date) : '—'}</td>
                              <td className={TD}>{p.numero_pedido ?? '—'}</td>
                              <td className={`${TD} text-right tabular-nums`}>{formatoPesos(orderTotal(p))}</td>
                              <td className={`${TD} ${p.entregado_por_nombre ? '' : 'text-gray-400'}`}>{p.entregado_por_nombre ?? RESPONSABLE_NO_DISPONIBLE}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
                <div>
                  <p className="text-xs font-semibold text-[#6B5D45] uppercase mb-1">Cobros</p>
                  {pagos.length === 0 ? <p className="text-xs text-gray-500">Sin cobros registrados</p> : (
                    <TablaCobros cobros={pagos} clienteNombre={c.cliente_nombre} />
                  )}
                </div>
                {onRegistrarPago && (
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

