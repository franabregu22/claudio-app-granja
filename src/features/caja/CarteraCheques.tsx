import { useState } from 'react';
import { errorMessage } from '../../target/messages';
import { esChequeFila, etiquetaFila, fechaFila, type PayableDueRow } from '../../target/paymentPlan';
import type { InstrumentRow } from '../../target/treasury';
import { formatearFechaLocal, getTodayDate } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';
import { AccionModal } from './Cheques';
import { campo, etiqueta, Modal } from './Modal';
import { usePayablesDue, usePaymentPlanMutations } from './usePaymentPlan';
import { useInstruments } from './useTreasury';

const TIPO: Record<string, string> = { CHEQUE: 'Cheque', ECHEQ: 'eCheq' };
const ESTADO_FINAL: Record<string, string> = { CLEARED: 'Acreditado', ENDORSED: 'Endosado', REJECTED: 'Rechazado' };
const btnPrimario = 'text-sm px-3 py-1.5 rounded-lg bg-amber-600 text-white hover:bg-amber-700';
const btnSecundario = 'text-sm px-3 py-1.5 rounded-lg border border-[#E4DCC8] text-[#6B5D45] bg-white hover:bg-stone-50';
type Accion = { action: 'deposit' | 'clear' | 'reject'; inst: InstrumentRow };

/**
 * Caja → Cartera de cheques (0123, caja-mejoras-v2; design approved on the prototype): the client cheques you hold. They come in from
 * Cuentas corrientes → Registrar cobro → Cheque (receive_cheque) and leave by deposit → credit (deposit_cheque, clear_cheque) or by
 * endorsement to a supplier against ONE of its due items (endorse_cheque_to_payable): that debt goes down; what exceeds it stays as the
 * supplier's credit. Nothing moves money until the bank credits a deposited cheque. Every action is its RPC (AccionModal reused).
 */
export function CarteraCheques() {
  const hoy = getTodayDate();
  const instrumentos = useInstruments();
  const [accion, setAccion] = useState<Accion | null>(null);
  const [endosando, setEndosando] = useState<InstrumentRow | null>(null);
  if (instrumentos.isLoading) return <p className="text-sm text-gray-500">Cargando cheques...</p>;
  if (instrumentos.error) return <p className="text-sm text-red-700">{errorMessage(instrumentos.error)}</p>;
  const recibidos = (instrumentos.data ?? []).filter((i) => i.direction === 'RECEIVED');
  const enCartera = recibidos.filter((i) => i.estado === 'RECEIVED').sort((a, b) => (a.maturity_date ?? '').localeCompare(b.maturity_date ?? ''));
  const depositados = recibidos.filter((i) => i.estado === 'DEPOSITED');
  const historial = recibidos.filter((i) => i.estado in ESTADO_FINAL).slice(0, 30);
  const total = (xs: InstrumentRow[]) => xs.reduce((t, x) => t + x.amount, 0);
  const fila = (x: InstrumentRow, acciones: React.ReactNode) => (
    <li key={x.id} className="px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-1">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-[#2C2419]">{x.cliente_nombre ?? 'Cliente'}</p>
        <p className="text-xs text-[#8A7A5C]">
          {TIPO[x.instrument_type] ?? x.instrument_type} N° {x.cheque_number ?? '—'} · {x.maturity_date ? (x.maturity_date <= hoy ? 'ya se puede cobrar' : `se cobra desde el ${formatearFechaLocal(x.maturity_date)}`) : 'sin fecha'}
          {x.estado === 'DEPOSITED' && x.deposited_date ? ` · depositado el ${formatearFechaLocal(x.deposited_date)}` : ''}
        </p>
      </div>
      <span className="font-semibold tabular-nums">{formatoPesos(x.amount)}</span>
      {acciones}
    </li>
  );

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-lg border border-[#E4DCC8] px-3 py-2 flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm text-[#6B5D45]">Cheques de clientes en tu poder. Entran desde <b>Cuentas corrientes → Registrar cobro → Cheque</b>.</p>
        <p className="text-sm">En cartera: <b>{formatoPesos(total(enCartera))}</b> · {enCartera.length} cheque{enCartera.length === 1 ? '' : 's'}</p>
      </div>
      <section aria-label="En cartera">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[#8A6A2E] mb-1">En cartera</h3>
        {enCartera.length === 0 ? <p className="text-sm text-[#8A7A5C]">No hay cheques en cartera.</p> : (
          <ul className="bg-white rounded-lg border border-[#E4DCC8] divide-y divide-[#F0EADC]">
            {enCartera.map((x) => fila(x, <>
              <button type="button" onClick={() => setAccion({ action: 'deposit', inst: x })} className={btnSecundario}>Depositar</button>
              <button type="button" onClick={() => setEndosando(x)} className={btnPrimario}>Endosar a proveedor</button>
            </>))}
          </ul>
        )}
      </section>
      {depositados.length > 0 && (
        <section aria-label="Depositados">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-[#8A6A2E] mb-1">Depositados, sin acreditar · {formatoPesos(total(depositados))}</h3>
          <ul className="bg-white rounded-lg border border-[#E4DCC8] divide-y divide-[#F0EADC]">
            {depositados.map((x) => fila(x, <>
              <button type="button" onClick={() => setAccion({ action: 'reject', inst: x })} className={btnSecundario}>Rechazado</button>
              <button type="button" onClick={() => setAccion({ action: 'clear', inst: x })} className={btnPrimario}>Acreditado</button>
            </>))}
          </ul>
        </section>
      )}
      {historial.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-[#8A6A2E]">Historial ({historial.length})</summary>
          <ul className="mt-1 text-xs text-[#6B5D45] space-y-1">
            {historial.map((x) => (
              <li key={x.id}>{x.cliente_nombre ?? 'Cliente'} · N° {x.cheque_number} · {formatoPesos(x.amount)} · {ESTADO_FINAL[x.estado]}
                {x.estado === 'ENDORSED' && x.endosado_nombre ? ` a ${x.endosado_nombre}` : ''}</li>
            ))}
          </ul>
        </details>
      )}
      {accion && <AccionModal action={accion.action} inst={accion.inst} onClose={() => setAccion(null)} />}
      {endosando && <EndosarModal cheque={endosando} onClose={() => setEndosando(null)} />}
    </div>
  );
}

/** Endorse against ONE due item of a supplier (an invoice, or one of its instalments); a pending expense without supplier never shows. */
function EndosarModal({ cheque, onClose }: { cheque: InstrumentRow; onClose: () => void }) {
  const due = usePayablesDue();
  const { endorse } = usePaymentPlanMutations();
  const [rowKey, setRowKey] = useState('');
  const [fecha, setFecha] = useState(getTodayDate());
  const [motivo, setMotivo] = useState('');
  const [clave] = useState(() => `ENDOSO-${crypto.randomUUID()}`);
  const opciones = (due.data ?? []).filter((r) => r.supplier_id && r.obligation_kind === 'FACTURA' && !esChequeFila(r) && r.row_kind !== 'DIFERENCIA')
    .sort((a, b) => (a.supplier_name ?? '').localeCompare(b.supplier_name ?? '') || (fechaFila(a) ?? '9999').localeCompare(fechaFila(b) ?? '9999'));
  const r: PayableDueRow | undefined = opciones.find((x) => x.row_key === rowKey);
  const dif = r ? cheque.amount - r.amount : 0;
  return (
    <Modal titulo={`Endosar ${TIPO[cheque.instrument_type] ?? 'cheque'} ${cheque.cheque_number ?? ''}`} onClose={onClose} puedeGuardar={!!r && fecha !== ''}
      guardando={endorse.isPending} error={endorse.error ?? due.error} textoGuardar="Endosar"
      onSubmit={() => { if (r) endorse.mutateAsync({ instrumentId: cheque.id, purchaseId: r.purchase_id!, itemId: r.item_id, date: fecha, idempotencyKey: clave, reason: motivo }).then(onClose).catch(() => {}); }}>
      <p className="text-sm">{cheque.cliente_nombre ?? 'Cliente'} · <b>{formatoPesos(cheque.amount)}</b></p>
      <label className={etiqueta}>¿Qué deuda paga?
        <select value={rowKey} onChange={(e) => setRowKey(e.target.value)} className={campo}>
          <option value="">{due.isLoading ? 'Cargando…' : 'Elegí proveedor y vencimiento'}</option>
          {opciones.map((x) => (
            <option key={x.row_key} value={x.row_key}>
              {x.supplier_name} · {x.concept ?? x.document_number ?? 'Factura'} · {etiquetaFila(x)} · {fechaFila(x) ? formatearFechaLocal(fechaFila(x)!) : 'sin fecha'} · {formatoPesos(x.amount)}
            </option>
          ))}
        </select>
      </label>
      {r && <p className="text-xs text-[#8A7A5C]">{dif > 0 ? `Cancela el vencimiento y quedan ${formatoPesos(dif)} a favor de ${r.supplier_name}.` : dif < 0 ? `Pago parcial: en ese vencimiento quedan ${formatoPesos(-dif)}.` : 'Cancela exactamente el vencimiento.'}</p>}
      <label className={etiqueta}>Fecha del endoso<input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} className={campo} /></label>
      <label className={etiqueta}>Nota (opcional)<input value={motivo} onChange={(e) => setMotivo(e.target.value)} className={campo} /></label>
      <p className="text-xs text-[#8A7A5C]">No mueve dinero de tus cuentas: baja la deuda con el proveedor.</p>
    </Modal>
  );
}
