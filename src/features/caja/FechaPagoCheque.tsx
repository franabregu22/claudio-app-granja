import { useState } from 'react';
import { formatearFechaLocal } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';
import { campo, etiqueta, Modal } from './Modal';
import { useAllInstrumentDateChanges, useInstrumentDateChanges, useTreasuryMutations } from './useTreasury';
import { useProfileEmails } from './useUnclassified';

/** The cheque / eCheq fields this correction needs (InstrumentRow, a payment-calendar row and an invoice payment row all carry them). */
export interface ChequeFecha {
  id: string; tipo: string; numero: string | null; amount: number; maturity_date: string | null; issued_date?: string | null; destinatario?: string | null;
}

/**
 * 0118: corrects the payment date of an own cheque / eCheq not yet debited. Only that date changes: amount, supplier, account,
 * balances and movements stay as they are. Reason required; every correction is kept (user, when, date before and after, reason).
 */
export function FechaPagoChequeModal({ cheque, onClose }: { cheque: ChequeFecha; onClose: () => void }) {
  const { reschedule } = useTreasuryMutations();
  const historial = useInstrumentDateChanges(cheque.id);
  const emails = useProfileEmails();
  const [fecha, setFecha] = useState(cheque.maturity_date ?? '');
  const [motivo, setMotivo] = useState('');
  const antesDeEmision = !!cheque.issued_date && fecha !== '' && fecha < cheque.issued_date;
  const puede = fecha !== '' && fecha !== (cheque.maturity_date ?? '') && !antesDeEmision && motivo.trim() !== '';

  return (
    <Modal titulo={`Fecha de pago — ${cheque.tipo} ${cheque.numero ?? ''} (${formatoPesos(cheque.amount)})`} onClose={onClose}
      puedeGuardar={puede} guardando={reschedule.isPending} error={reschedule.error ?? historial.error} textoGuardar="Guardar fecha"
      onSubmit={() => reschedule.mutate({ instrumentId: cheque.id, maturityDate: fecha, reason: motivo.trim() }, { onSuccess: onClose })}>
      <p className="text-xs text-gray-600">
        {cheque.destinatario ? <>{cheque.destinatario} · </> : null}Fecha de pago actual: <b>{cheque.maturity_date ? formatearFechaLocal(cheque.maturity_date) : 'sin fecha'}</b>.
        Solo cambia la fecha: el importe, el proveedor, los saldos y los movimientos no cambian.
      </p>
      <label className={etiqueta}>Nueva fecha de pago
        <input type="date" value={fecha} min={cheque.issued_date ?? undefined} onChange={(e) => setFecha(e.target.value)} className={campo} />
      </label>
      {antesDeEmision && <p className="text-xs text-red-700">No puede ser anterior a la emisión ({formatearFechaLocal(cheque.issued_date!)}).</p>}
      <label className={etiqueta}>Motivo de la corrección
        <input type="text" value={motivo} onChange={(e) => setMotivo(e.target.value)} className={campo} />
      </label>
      <div>
        <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide mb-1">Correcciones anteriores</p>
        {historial.isLoading ? <p className="text-xs text-gray-500">Cargando…</p>
          : (historial.data ?? []).length === 0 ? <p className="text-xs text-gray-500">Sin correcciones.</p>
          : (
            <ul className="space-y-1">
              {(historial.data ?? []).map((h) => (
                <li key={h.id} className="text-xs bg-stone-50 rounded p-2">
                  {formatearFechaLocal(h.before_values?.maturity_date ?? '')} → <b>{formatearFechaLocal(h.after_values?.maturity_date ?? '')}</b>
                  <span className="text-[#8A7A5C]"> · {new Date(h.performed_at).toLocaleString('es-AR')} · {h.performed_by ? emails.data?.get(h.performed_by) ?? 'usuario' : 'sistema'}</span>
                  {h.reason && <span className="block">Motivo: {h.reason}</span>}
                </li>
              ))}
            </ul>
          )}
      </div>
    </Modal>
  );
}

type Correccion = NonNullable<ReturnType<typeof useAllInstrumentDateChanges>['data']> extends Map<string, infer V> ? V : never;

/** 0118: a visible mark on a cheque whose payment date was corrected (the original date and the last reason as a tooltip). */
export function EtiquetaFechaCorregida({ cambios }: { cambios: Correccion | undefined }) {
  if (!cambios || cambios.length === 0) return null;
  const primera = cambios[0];
  const ultima = cambios[cambios.length - 1];
  return (
    <span className="text-xs px-2 py-0.5 rounded bg-sky-100 text-sky-900" title={ultima.reason ? `Motivo: ${ultima.reason}` : undefined}>
      Fecha de pago corregida{cambios.length > 1 ? ` (${cambios.length} veces)` : ''} · antes {formatearFechaLocal(primera.before_values?.maturity_date ?? '')}
    </span>
  );
}

/** 0118: every correction of one cheque, one line each — what changed, when, who and why. */
export function DetalleCorreccionesFecha({ cambios }: { cambios: Correccion | undefined }) {
  const emails = useProfileEmails();
  if (!cambios || cambios.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1">
      {cambios.map((h) => (
        <li key={h.id} className="text-xs bg-sky-50 border border-sky-100 rounded px-2 py-1 text-sky-950">
          Fecha de pago corregida: {formatearFechaLocal(h.before_values?.maturity_date ?? '')} → <b>{formatearFechaLocal(h.after_values?.maturity_date ?? '')}</b>
          <span className="text-sky-800"> · {new Date(h.performed_at).toLocaleString('es-AR')} · {h.performed_by ? emails.data?.get(h.performed_by) ?? 'usuario' : 'sistema'}</span>
          {h.reason && <span className="block">Motivo: {h.reason}</span>}
        </li>
      ))}
    </ul>
  );
}
