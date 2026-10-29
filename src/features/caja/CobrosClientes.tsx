import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import {
  COLLECTION_METHOD_LABEL, COLLECTION_ORIGIN_LABEL, COLLECTION_STATUS_LABEL, type CustomerCollectionRow, type CustomerCollectionStatus,
  filterLogicalCollections, groupCustomerCollections, listCustomerCollections,
} from '../../target/customerCollections';
import { errorMessage } from '../../target/messages';
import { formatearFechaLocal, getTodayDate } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';

const SELECT_CLS = 'text-sm border border-[#E4DCC8] rounded px-2 py-1 bg-white';
const ESTADO_ESTILO: Record<CustomerCollectionStatus, string> = {
  CORRECTED: 'bg-stone-200 text-stone-700', MANUAL_WITHOUT_SOURCE: 'bg-red-100 text-red-800', CONCILIATED: 'bg-green-100 text-green-800',
  PENDING_RECONCILIATION: 'bg-amber-100 text-amber-900', CASH: 'bg-stone-100 text-stone-700', ALLOCATED_TO_CUSTOMER: 'bg-sky-100 text-sky-900',
  ANNULLED: 'bg-stone-200 text-stone-700 line-through', RECTIFIED: 'bg-stone-200 text-stone-700',
};
const corto = (t: string | null, n = 60) => (t && t.length > n ? `${t.slice(0, n)}…` : t ?? '');

function primerDiaMesAnterior(hoy: string): string {
  const [y, m] = hoy.split('-').map(Number);
  return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`;
}

/**
 * Caja → Cobros de clientes (0092, ADMIN, read-only): every client collection from fin_customer_collections. A corrected
 * manual Mercado Pago collection is shown once, with the parts that replace it (real Mercado Pago payment / cash).
 * No CBU / CVU is ever read; the reference is the Mercado Pago operation number (SOURCE_ID).
 */
export function CobrosClientes() {
  const hoy = getTodayDate();
  const [desde, setDesde] = useState(primerDiaMesAnterior(hoy));
  const [hasta, setHasta] = useState(hoy);
  const [cliente, setCliente] = useState('');
  const [cuenta, setCuenta] = useState('');
  const [metodo, setMetodo] = useState('');
  const [estado, setEstado] = useState<CustomerCollectionStatus | ''>('');
  const q = useQuery({ queryKey: ['customer-collections', desde, hasta], enabled: desde !== '' && hasta !== '',
    queryFn: () => listCustomerCollections(supabase, { from: desde, to: hasta }) });
  const filas = q.data ?? [];
  const clientes = [...new Map(filas.map((r) => [r.cliente_id, r.client_name])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const cuentas = [...new Set(filas.map((r) => r.account_name))].sort();
  const metodos = [...new Set(filas.map((r) => r.payment_method))].sort();
  const items = filterLogicalCollections(groupCustomerCollections(filas), { clienteId: cliente, account: cuenta, method: metodo, status: estado });
  // 0108: an annulled / rectified original is shown as evidence but is no longer money (its replacement is its own row)
  const total = items.reduce((s, i) => s + (i.main.reversal_kind ? 0 : i.amount), 0);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2" role="group" aria-label="Filtros de cobros">
        <label className="text-xs text-[#8A7A5C]">Desde<br /><input type="date" className={SELECT_CLS} value={desde} onChange={(e) => setDesde(e.target.value)} /></label>
        <label className="text-xs text-[#8A7A5C]">Hasta<br /><input type="date" className={SELECT_CLS} value={hasta} onChange={(e) => setHasta(e.target.value)} /></label>
        <select aria-label="Cliente" className={SELECT_CLS} value={cliente} onChange={(e) => setCliente(e.target.value)}>
          <option value="">Todos los clientes</option>
          {clientes.map(([id, nombre]) => <option key={id} value={id}>{nombre}</option>)}
        </select>
        <select aria-label="Cuenta" className={SELECT_CLS} value={cuenta} onChange={(e) => setCuenta(e.target.value)}>
          <option value="">Todas las cuentas</option>
          {cuentas.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select aria-label="Método" className={SELECT_CLS} value={metodo} onChange={(e) => setMetodo(e.target.value)}>
          <option value="">Todos los métodos</option>
          {metodos.map((m) => <option key={m} value={m}>{COLLECTION_METHOD_LABEL[m] ?? m}</option>)}
        </select>
        <select aria-label="Estado" className={SELECT_CLS} value={estado} onChange={(e) => setEstado(e.target.value as CustomerCollectionStatus | '')}>
          <option value="">Todos los estados</option>
          {(Object.keys(COLLECTION_STATUS_LABEL) as CustomerCollectionStatus[]).map((s) => <option key={s} value={s}>{COLLECTION_STATUS_LABEL[s]}</option>)}
        </select>
      </div>
      {q.isLoading ? <p className="text-sm text-gray-500">Cargando cobros...</p>
        : q.error ? <p className="text-sm text-red-700">{errorMessage(q.error)}</p>
          : items.length === 0 ? <p className="text-sm text-[#8A7A5C]">No hay cobros de clientes en el período.</p> : (
            <div className="overflow-x-auto bg-white rounded-lg border border-[#E4DCC8]">
              <table className="w-full text-sm" aria-label="Cobros de clientes">
                <thead><tr className="text-left text-xs text-[#8A7A5C] border-b border-[#E4DCC8]">
                  <th className="px-3 py-2">Fecha</th><th className="px-3 py-2">Cliente</th><th className="px-3 py-2 text-right">Importe</th>
                  <th className="px-3 py-2">Cuenta</th><th className="px-3 py-2">Método</th><th className="px-3 py-2">Notas</th>
                  <th className="px-3 py-2">Operación</th><th className="px-3 py-2">Nº Mercado Pago</th><th className="px-3 py-2">Origen</th><th className="px-3 py-2">Estado</th>
                </tr></thead>
                <tbody>
                  {items.map((i) => (
                    <FilasCobro key={i.key} main={i.main} parts={i.parts} importe={i.amount} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
      {items.length > 0 && <p className="text-xs text-[#8A7A5C]">{items.length} cobro(s) · total para clientes {formatoPesos(total)}. Un cobro corregido se muestra una vez, con las partes que lo reemplazan.</p>}
    </div>
  );
}

function FilasCobro({ main, parts, importe }: { main: CustomerCollectionRow; parts: CustomerCollectionRow[]; importe: number }) {
  return (
    <>
      <Fila r={main} importe={importe} />
      {parts.map((p) => <Fila key={p.row_id} r={p} importe={p.amount} parte />)}
    </>
  );
}

function Fila({ r, importe, parte = false }: { r: CustomerCollectionRow; importe: number; parte?: boolean }) {
  return (
    <tr className={`border-b border-stone-100 last:border-0 ${parte ? 'bg-stone-50 text-[#6B5D45]' : ''}`}>
      <td className="px-3 py-2 whitespace-nowrap">{parte ? '' : formatearFechaLocal(r.business_date)}</td>
      <td className="px-3 py-2 whitespace-nowrap">{parte ? <span className="pl-3">↳ parte</span> : r.client_name}</td>
      <td className={`px-3 py-2 text-right whitespace-nowrap ${parte ? '' : 'font-medium'} ${r.correction_role === 'CORRECTED_ORIGINAL' ? 'line-through text-stone-500' : ''}`}>{formatoPesos(importe)}</td>
      <td className="px-3 py-2 whitespace-nowrap">{r.account_name}</td>
      <td className="px-3 py-2 whitespace-nowrap">{COLLECTION_METHOD_LABEL[r.payment_method] ?? r.payment_method}</td>
      <td className="px-3 py-2 text-[#8A7A5C]" title={r.notes ?? undefined}>{corto(r.notes)}</td>
      <td className="px-3 py-2 whitespace-nowrap text-[#8A7A5C]">{r.financial_operation_id ?? '—'}</td>
      <td className="px-3 py-2 whitespace-nowrap text-[#8A7A5C]">{r.source_id ?? '—'}</td>
      <td className="px-3 py-2 whitespace-nowrap">{COLLECTION_ORIGIN_LABEL[r.origin]}</td>
      <td className="px-3 py-2 whitespace-nowrap"><span className={`text-xs px-2 py-0.5 rounded ${ESTADO_ESTILO[r.status]}`}>{COLLECTION_STATUS_LABEL[r.status]}</span></td>
    </tr>
  );
}
