import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { errorMessage } from '../../target/messages';
import { listPayablePayments, listPayables, PAYABLE_STATUS_LABEL, payPendingExpense, type PayableRow } from '../../target/payables';
import { formatearFechaLocal, getTodayDate } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';
import { useFinancialAccounts } from '../pedidos/useCommercial';
import { Comprobantes } from './Comprobantes';
import { campo, etiqueta, Modal } from './Modal';
import { usePurchaseAttachments } from './useInvoicePayments';

export function usePayables(onlyOpen: boolean) {
  return useQuery({ queryKey: ['treasury', 'payables', onlyOpen], queryFn: () => listPayables(supabase, onlyOpen) });
}

/**
 * Gastos a pagar (ADR-026, 0106): expenses registered without paying them (WhatsApp "a pagar" or the ERP). They are already in the
 * P&L by their date and category; here only the obligation is paid, totally or partially — each payment is ONE real movement on a
 * cash / bank account (Mercado Pago outflows are classified from Pendientes MP).
 */
export function GastosAPagar() {
  const gastos = usePayables(true);
  const [pagando, setPagando] = useState<PayableRow | null>(null);
  const [abierto, setAbierto] = useState<string | null>(null);
  const filas = gastos.data ?? [];
  const adjuntos = usePurchaseAttachments(filas.map((g) => g.purchase_id));
  const hoy = getTodayDate();

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide">Gastos a pagar</p>
        {filas.length > 0 && <span className="text-sm">Total pendiente: <b className="text-red-600">{formatoPesos(filas.reduce((s, g) => s + g.pending, 0))}</b></span>}
      </div>
      <p className="text-xs text-[#8A7A5C]">Ya figuran en resultados desde su registro; pagarlos solo mueve Caja / Bancos.</p>
      {gastos.isLoading ? <p className="text-sm text-gray-500">Cargando gastos a pagar...</p>
        : gastos.error ? <p className="text-sm text-red-700">{errorMessage(gastos.error)}</p>
          : filas.length === 0 ? <p className="text-sm text-[#8A7A5C]">No hay gastos a pagar.</p> : (
            <div className="space-y-2">
              {filas.map((g) => (
                <div key={g.payable_id} className="bg-white rounded-lg border border-[#E4DCC8] p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-amber-900">{g.concept ?? g.category_name}</span>
                    <span className="text-[#8A7A5C]">{g.category_name} · {formatearFechaLocal(g.economic_date)}{g.counterparty_name ? ` · ${g.counterparty_name}` : ''}</span>
                    {g.due_date ? <span className={`text-xs px-2 py-0.5 rounded ${g.due_date < hoy ? 'bg-red-100 text-red-800' : 'bg-amber-50 text-amber-900'}`}>vence {formatearFechaLocal(g.due_date)}</span>
                      : <span className="text-xs text-[#8A7A5C]">sin vencimiento</span>}
                    <Comprobantes docs={adjuntos.data?.get(g.purchase_id)} compacto />
                    <span className="flex-1" />
                    <span className="text-xs px-2 py-0.5 rounded bg-stone-100">{PAYABLE_STATUS_LABEL[g.status]}</span>
                    <span className="font-bold text-red-600">{formatoPesos(g.pending)}</span>
                    <button type="button" onClick={() => setPagando(g)} className="text-sm px-3 py-1 bg-amber-600 text-white rounded-lg hover:bg-amber-700">Pagar</button>
                  </div>
                  {g.paid > 0 && (
                    <button type="button" onClick={() => setAbierto(abierto === g.payable_id ? null : g.payable_id)} className="text-xs text-[#A8552E] hover:underline mt-1">
                      Pagado {formatoPesos(g.paid)} de {formatoPesos(g.amount)} {abierto === g.payable_id ? '▲' : '▼'}
                    </button>
                  )}
                  {abierto === g.payable_id && <PagosDelGasto payableId={g.payable_id} />}
                </div>
              ))}
            </div>
          )}
      {pagando && <PagarGastoModal gasto={pagando} onClose={() => setPagando(null)} />}
    </section>
  );
}

function PagosDelGasto({ payableId }: { payableId: string }) {
  const pagos = useQuery({ queryKey: ['treasury', 'payables', 'payments', payableId], queryFn: () => listPayablePayments(supabase, payableId) });
  if (pagos.isLoading) return <p className="text-xs text-gray-500">Cargando pagos...</p>;
  if (pagos.error) return <p className="text-xs text-red-700">{errorMessage(pagos.error)}</p>;
  return (
    <ul className="text-xs text-[#6B5D45] mt-1 space-y-0.5">
      {(pagos.data ?? []).map((p) => <li key={p.payment_id}>{formatearFechaLocal(p.effective_date)} · {p.account_name} · {formatoPesos(p.amount)}</li>)}
    </ul>
  );
}

function PagarGastoModal({ gasto, onClose }: { gasto: PayableRow; onClose: () => void }) {
  const qc = useQueryClient();
  const cuentas = useFinancialAccounts();
  const habilitadas = (cuentas.data ?? []).filter((a) => a.account_type === 'CASH' || a.account_type === 'BANK_ACCOUNT');
  const [monto, setMonto] = useState(String(gasto.pending));
  const [fecha, setFecha] = useState(getTodayDate());
  const [cuentaId, setCuentaId] = useState('');
  const [clave] = useState(() => `PAYABLE-${crypto.randomUUID()}`);   // idempotency: one per opened form
  const cuenta = habilitadas.find((a) => a.id === cuentaId);
  const pagar = useMutation({
    mutationFn: () => payPendingExpense(supabase, { payableId: gasto.payable_id, amount: Number(monto), effectiveDate: fecha, accountId: cuentaId,
      method: cuenta?.account_type === 'CASH' ? 'CASH' : 'TRANSFER', idempotencyKey: clave }),
    onSuccess: () => Promise.all([['treasury'], ['commercial', 'balances'], ['pnl']].map((queryKey) => qc.invalidateQueries({ queryKey }))),
  });
  const puede = Number(monto) > 0 && Number(monto) <= gasto.pending + 0.005 && !!cuenta && fecha !== '';

  return (
    <Modal titulo={`Pagar — ${gasto.concept ?? gasto.category_name}`} onClose={onClose} puedeGuardar={puede} guardando={pagar.isPending}
      error={pagar.error ?? cuentas.error} textoGuardar="Registrar pago" onSubmit={() => pagar.mutate(undefined, { onSuccess: onClose })}>
      <p className="text-xs text-[#6B5D45]">Pendiente <b>{formatoPesos(gasto.pending)}</b> de {formatoPesos(gasto.amount)}. Registra solo la salida de dinero: el gasto ya está en resultados.</p>
      <label className={etiqueta}>Monto (total o parcial)<input type="number" min="0" step="0.01" value={monto} onChange={(e) => setMonto(e.target.value)} className={campo} /></label>
      <label className={etiqueta}>Fecha del pago<input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} className={campo} /></label>
      <label className={etiqueta}>Pagado desde
        <select value={cuentaId} onChange={(e) => setCuentaId(e.target.value)} className={campo}>
          <option value="">Elegir cuenta…</option>
          {habilitadas.map((a) => <option key={a.id} value={a.id}>{a.nombre}{a.account_type === 'CASH' ? ' (efectivo)' : ' (transferencia)'}</option>)}
        </select>
      </label>
      <p className="text-xs text-gray-500">Un pago por Mercado Pago se clasifica desde Pendientes de clasificar.</p>
    </Modal>
  );
}
