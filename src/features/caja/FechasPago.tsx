import { useState } from 'react';
import { errorMessage } from '../../target/messages';
import type { PaymentDateKind } from '../../target/paymentCalendar';
import { formatearFechaLocal, isoAFechaBA } from '../../utils/dateUtils';
import { campo, etiqueta, Modal } from './Modal';
import { usePaymentDateHistory, useSetPaymentDates } from './usePaymentCalendar';

const TIPO_FECHA: Record<PaymentDateKind, string> = { DUE: 'Vencimiento', PLANNED: 'Fecha estimada de pago' };

/** The two dates of an obligation as small labels: the contractual due date and, apart, the internal estimated payment date. */
export function EtiquetasFechas({ due, planned, hoy }: { due: string | null; planned: string | null; hoy: string }) {
  return (
    <>
      {due ? <span className={`text-xs px-2 py-0.5 rounded ${due < hoy ? 'bg-red-100 text-red-800' : 'bg-amber-50 text-amber-900'}`}>vence {formatearFechaLocal(due)}</span>
        : <span className="text-xs text-[#8A7A5C]">sin vencimiento</span>}
      {planned && <span className="text-xs px-2 py-0.5 rounded bg-sky-50 text-sky-900">pago estimado {formatearFechaLocal(planned)}</span>}
    </>
  );
}

/**
 * Lote 3B (0110): the due date (contractual: changing one needs a reason) and the estimated payment date (internal planning,
 * editable or cleared) of ONE obligation, with their history. Neither date ever moves money.
 */
export function FechasPagoModal({ purchaseId, rootId, titulo, due, planned, onClose }: {
  purchaseId: string; rootId: string; titulo: string; due: string | null; planned: string | null; onClose: () => void;
}) {
  const [vence, setVence] = useState(due ?? '');
  const [estimada, setEstimada] = useState(planned ?? '');
  const [motivo, setMotivo] = useState('');
  const historial = usePaymentDateHistory(rootId);
  const guardar = useSetPaymentDates();
  const changes: { kind: PaymentDateKind; date: string | null }[] = [];
  if (vence !== (due ?? '')) changes.push({ kind: 'DUE', date: vence || null });
  if (estimada !== (planned ?? '')) changes.push({ kind: 'PLANNED', date: estimada || null });
  const cambiaVencimiento = due !== null && vence !== due;
  const puede = changes.length > 0 && !(due !== null && vence === '') && (!cambiaVencimiento || motivo.trim() !== '');

  return (
    <Modal titulo={`Fechas — ${titulo}`} onClose={onClose} puedeGuardar={puede} guardando={guardar.isPending} error={guardar.error}
      textoGuardar="Guardar fechas" onSubmit={() => guardar.mutate({ purchaseId, changes, reason: motivo }, { onSuccess: onClose })}>
      <p className="text-xs text-[#6B5D45]">Son fechas de planificación: ninguna registra un pago ni mueve Caja o Bancos.</p>
      <label className={etiqueta}>Vencimiento (obligación con el proveedor)
        <input type="date" value={vence} onChange={(e) => setVence(e.target.value)} className={campo} />
      </label>
      {due !== null && vence === '' && <p className="text-xs text-red-700">Un vencimiento cargado no se borra: corregilo con su motivo.</p>}
      <label className={etiqueta}>Fecha estimada de pago (planificación interna)
        <input type="date" value={estimada} onChange={(e) => setEstimada(e.target.value)} className={campo} />
      </label>
      {estimada && <button type="button" onClick={() => setEstimada('')} className="text-xs text-[#A8552E] hover:underline">Quitar fecha estimada</button>}
      <label className={etiqueta}>Motivo {cambiaVencimiento ? '(obligatorio: cambia un vencimiento)' : '(opcional)'}
        <input value={motivo} onChange={(e) => setMotivo(e.target.value)} maxLength={500} className={campo} />
      </label>
      <div>
        <p className="text-xs font-semibold text-[#6B5D45] mt-1">Historial</p>
        {historial.isLoading ? <p className="text-xs text-gray-500">Cargando…</p> : historial.error ? <p className="text-xs text-red-700">{errorMessage(historial.error)}</p>
          : (historial.data ?? []).length === 0 ? <p className="text-xs text-gray-500">Sin cambios registrados{due ? ` (vencimiento original ${formatearFechaLocal(due)})` : ''}.</p> : (
            <ul className="text-xs text-[#6B5D45] space-y-0.5 max-h-32 overflow-y-auto">
              {(historial.data ?? []).map((h) => (
                <li key={h.id}>{formatearFechaLocal(isoAFechaBA(h.created_at))} · {TIPO_FECHA[h.date_kind]}: {h.value ? formatearFechaLocal(h.value) : 'quitada'}{h.reason ? ` — ${h.reason}` : ''}</li>
              ))}
            </ul>
          )}
      </div>
    </Modal>
  );
}
