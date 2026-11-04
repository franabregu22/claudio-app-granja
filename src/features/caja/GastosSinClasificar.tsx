import { useState } from 'react';
import { normalizeDbError } from '../../target/db';
import { errorMessage } from '../../target/messages';
import type { PurchaseNatureValue } from '../../target/masters';
import { classifyReady, originText, type PendingExpenseRow, UNCLASSIFIED_BALANCE_NOTE } from '../../target/unclassifiedExpenses';
import { NATURE_LABEL } from '../../target/expenseCategories';
import { formatearFechaLocal } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';
import { campo, etiqueta, Modal } from './Modal';
import { SelectorCategoria } from './SelectorCategoria';
import { useClassifyPendingExpense, usePendingExpenseOne, useProfileEmails } from './useUnclassified';
import { Comprobantes } from './Comprobantes';
import { useDocumentLinks } from './useInvoicePayments';


/** ALREADY_CLASSIFIED is the Mercado Pago text in the shared catalogue; here it is a pending expense. */
const mensajeError = (e: unknown) => (normalizeDbError(e).code === 'ALREADY_CLASSIFIED'
  ? 'Ese gasto ya fue clasificado (otra persona o una pestaña anterior). Se actualizó la lista.' : errorMessage(e));

/**
 * Caja → Movimientos → Por resolver → Gastos sin clasificar (ADR-025, ERP 0101; 0116: a filter of the movement list). An expense ALREADY
 * paid (the balance already dropped) whose category was doubtful when it was confirmed — e.g. from WhatsApp "Registrar sin clasif".
 * The row action: classifying only adds its purchase on the same payment (classify_pending_expense): no new operation, posting or payment.
 */
export function AccionGastoSinClasificar({ pendingId, paymentOperationId }: { pendingId?: number; paymentOperationId?: number }) {
  const q = usePendingExpenseOne(pendingId !== undefined ? { pendingId } : paymentOperationId !== undefined ? { paymentOperationId } : null);
  const emails = useProfileEmails();
  const docs = useDocumentLinks('EXPENSE_PENDING', q.data ? [String(q.data.pending_id)] : []);   // ADR-025 stage 4: the WhatsApp receipt
  const [abierto, setAbierto] = useState(false);
  const r = q.data;
  if (q.isLoading) return <p className="text-xs text-gray-500">Buscando el gasto...</p>;
  if (q.error) return <p className="text-xs text-red-700">{errorMessage(q.error)}</p>;
  if (!r) return null;
  const autor = (id: string | null) => (id ? emails.data?.get(id) ?? '—' : '—');
  const doc = docs.data?.get(String(r.pending_id));
  return (
    <div className="space-y-1 text-sm" aria-label="Gasto sin clasificar">
      <p>{r.concept}{r.counterparty_name && <span className="text-[#8A7A5C]"> · {r.counterparty_name}</span>} <span className="text-[#8A7A5C]">· {originText(r)} · registró {autor(r.created_by)}</span></p>
      {doc && <Comprobantes docs={doc} />}
      {r.status === 'SIN_CLASIFICAR' ? (
        <>
          <p className="text-xs text-[#8A7A5C]">{UNCLASSIFIED_BALANCE_NOTE}</p>
          <button type="button" onClick={() => setAbierto(true)} className="text-xs px-2 py-1 rounded bg-[#A8552E] text-white hover:bg-[#8E4626]">Clasificar</button>
        </>
      ) : (
        <p className="text-xs text-green-900">Clasificado: {r.category_name}{r.nature ? ` · ${NATURE_LABEL[r.nature]}` : ''} · {autor(r.classified_by)}</p>
      )}
      {abierto && <ClasificarGasto r={r} onClose={() => setAbierto(false)} />}
    </div>
  );
}

/** The classification form: category → subcategory (only selectable ones: active, in an active category), nature, concept, counterparty. */
export function ClasificarGasto({ r, onClose }: { r: PendingExpenseRow; onClose: () => void }) {
  const [subcategoria, setSubcategoria] = useState('');
  const [naturaleza, setNaturaleza] = useState<PurchaseNatureValue>('OPERATING');
  const [concepto, setConcepto] = useState(r.concept);
  const [contraparte, setContraparte] = useState(r.counterparty_name ?? '');
  const [motivo, setMotivo] = useState('');
  const clasificar = useClassifyPendingExpense();
  const listo = classifyReady({ expenseCategoryId: subcategoria, nature: naturaleza, concept: concepto });
  const guardar = () => clasificar.mutate({
    pendingId: r.pending_id, expenseCategoryId: subcategoria, nature: naturaleza,
    concept: concepto.trim() === r.concept ? null : concepto,
    counterpartyName: contraparte.trim() === (r.counterparty_name ?? '') ? null : contraparte,
    reason: motivo || null,
  }, { onSuccess: onClose });
  return (
    <Modal titulo={`Clasificar gasto de ${formatoPesos(r.amount)}`} onClose={onClose} onSubmit={guardar} puedeGuardar={listo} guardando={clasificar.isPending}
      textoGuardar="Clasificar">
      <p className="text-xs text-[#6B5D45] bg-amber-50 border border-amber-200 rounded px-2 py-1">
        {formatearFechaLocal(r.economic_date)} · {r.account_name} · {originText(r)}. El egreso ya está registrado: clasificar no genera otro movimiento ni cambia el saldo.
      </p>
      <SelectorCategoria campo={campo} etiqueta={etiqueta} subcategoriaId={subcategoria} onSubcategoria={setSubcategoria} naturaleza={naturaleza} onNaturaleza={setNaturaleza} />
      <label className={etiqueta}>Concepto
        <input className={campo} maxLength={100} value={concepto} onChange={(e) => setConcepto(e.target.value)} />
      </label>
      <label className={etiqueta}>Comercio / contraparte (opcional)
        <input className={campo} maxLength={120} value={contraparte} onChange={(e) => setContraparte(e.target.value)} />
      </label>
      <label className={etiqueta}>Nota (opcional, queda en la auditoría)
        <input className={campo} maxLength={200} value={motivo} onChange={(e) => setMotivo(e.target.value)} />
      </label>
      {clasificar.error ? <div className="bg-red-100 border border-red-300 text-red-800 px-3 py-2 rounded-lg text-sm" role="alert">{mensajeError(clasificar.error)}</div> : null}
    </Modal>
  );
}
