import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { errorMessage } from '../../target/messages';
import { listPayablePayments, listPayables, payPendingExpense, type PayableRow } from '../../target/payables';
import { formatearFechaLocal, getTodayDate } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';
import { useFinancialAccounts } from '../pedidos/useCommercial';
import { campo, etiqueta, Modal } from './Modal';
import { useAssignPayableToSupplier } from './usePaymentCalendar';
import { useSuppliers } from './useTreasury';

export function usePayables(onlyOpen: boolean) {
  return useQuery({ queryKey: ['treasury', 'payables', onlyOpen], queryFn: () => listPayables(supabase, onlyOpen) });
}

/** The payments of one pending expense (each one a real movement on a cash / bank account). */
export function PagosDelGasto({ payableId }: { payableId: string }) {
  const pagos = useQuery({ queryKey: ['treasury', 'payables', 'payments', payableId], queryFn: () => listPayablePayments(supabase, payableId) });
  if (pagos.isLoading) return <p className="text-xs text-gray-500">Cargando pagos...</p>;
  if (pagos.error) return <p className="text-xs text-red-700">{errorMessage(pagos.error)}</p>;
  return (
    <ul className="text-xs text-[#6B5D45] mt-1 space-y-0.5">
      {(pagos.data ?? []).map((p) => <li key={p.payment_id}>{formatearFechaLocal(p.effective_date)} · {p.account_name} · {formatoPesos(p.amount)}</li>)}
    </ul>
  );
}

/**
 * Pay a pending expense (ADR-026, 0106): totally or partially, ONE real movement on a cash / bank account per payment; the expense is
 * already in the P&L by its date and category. Mercado Pago outflows are classified from Pendientes MP.
 */
export function PagarGastoModal({ gasto, onClose }: { gasto: PayableRow; onClose: () => void }) {
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
      <p className="text-xs text-gray-500">Un pago por Mercado Pago se clasifica desde Caja → Movimientos → Por resolver → Pendientes de clasificar.</p>
    </Modal>
  );
}

/**
 * Lote 3B (0110): link a pending expense to an EXISTING supplier (never created here). One RPC: the expense keeps its date,
 * category, amounts and invoice (P&L and IVA unchanged); the payments already made stay as they were and are carried to the
 * supplier account; the pending balance becomes supplier debt. No money moves.
 */
export function VincularProveedorModal({ gasto, onClose }: { gasto: PayableRow; onClose: () => void }) {
  const proveedores = useSuppliers();
  const vincular = useAssignPayableToSupplier();
  const [proveedorId, setProveedorId] = useState('');
  const [factura, setFactura] = useState('');
  const [motivo, setMotivo] = useState('');
  const [clave] = useState(() => `PAYABLE-LINK-${crypto.randomUUID()}`);   // idempotency: one per opened form
  const puede = proveedorId !== '' && motivo.trim() !== '';

  return (
    <Modal titulo={`Vincular a proveedor — ${gasto.concept ?? gasto.category_name}`} onClose={onClose} puedeGuardar={puede} guardando={vincular.isPending}
      error={vincular.error ?? proveedores.error} textoGuardar="Vincular"
      onSubmit={() => vincular.mutate({ payableId: gasto.payable_id, supplierId: proveedorId, reason: motivo, idempotencyKey: clave, invoiceNumber: factura }, { onSuccess: onClose })}>
      <p className="text-xs text-[#6B5D45]">
        Total {formatoPesos(gasto.amount)} · pagado {formatoPesos(gasto.paid)} · pendiente <b>{formatoPesos(gasto.pending)}</b>.
        El pendiente pasa a la cuenta corriente del proveedor; lo ya pagado queda registrado como pago anterior.
        No mueve Caja ni Bancos y no crea otro gasto ni IVA.
      </p>
      <label className={etiqueta}>Proveedor
        <select value={proveedorId} onChange={(e) => setProveedorId(e.target.value)} className={campo}>
          <option value="">Elegir proveedor…</option>
          {(proveedores.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
        </select>
      </label>
      {(proveedores.data ?? []).length === 0 && !proveedores.isLoading && <p className="text-xs text-[#8A7A5C]">No hay proveedores activos: cargalo primero en Admin → Proveedores.</p>}
      <label className={etiqueta}>Número de factura (opcional; si el gasto ya tiene uno, se conserva)
        <input value={factura} onChange={(e) => setFactura(e.target.value)} maxLength={100} className={campo} />
      </label>
      <label className={etiqueta}>Motivo
        <input value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ej.: llegó la factura del proveedor" className={campo} />
      </label>
      <p className="text-xs text-gray-500">Después se paga desde Cuentas a pagar → el proveedor (efectivo, transferencia, cheque o eCheq). Es un paso único: no se deshace desde acá.</p>
    </Modal>
  );
}
