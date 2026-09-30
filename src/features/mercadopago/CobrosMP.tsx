import { useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { errorMessage } from '../../target/messages';
import {
  AXIS_A_LABELS, AXIS_B_LABELS, OUTCOME_LABELS, REVIEW_REASON_LABELS, allocateToClient, canAllocate, clearAttributionFlag, flagForAttribution,
  requestRefetch, reverseAllocation, uiIdempotencyKey, type ReceiptDetail,
} from '../../target/mp';
import { shiftDate } from '../../target/production';
import { getTodayDate } from '../../utils/dateUtils';
import { campo, etiqueta, Modal } from '../caja/Modal';
import { useClients } from '../caja/useTreasury';
import { formatoPesos } from '../pedidos/helpers';
import { useAllocationLookup, useMPAction, useReceipt, useReceipts } from './useMP';

/** Axis A and axis B are always two separate badges (§1.4); neither is derived from the other. */
export function AxisBadges({ a, b, reasons }: { a: string; b: string; reasons?: string[] }) {
  const aTone = a === 'REVIEW_REQUIRED' ? 'bg-red-100 text-red-800' : a === 'NORMALIZED' ? 'bg-stone-200 text-stone-700' : 'bg-green-100 text-green-800';
  const bTone = b === 'CLIENT_RESOLUTION_REQUESTED' ? 'bg-amber-100 text-amber-900' : 'bg-blue-50 text-blue-800';
  return (
    <span className="inline-flex flex-wrap gap-1">
      <span className={`text-xs px-2 py-0.5 rounded ${aTone}`} title="Conciliación con Mercado Pago (tesorería)">{AXIS_A_LABELS[a] ?? a}</span>
      <span className={`text-xs px-2 py-0.5 rounded ${bTone}`} title="Atribución a cliente (opcional)">{AXIS_B_LABELS[b] ?? b}</span>
      {(reasons ?? []).map((r) => <span key={r} className="text-xs px-2 py-0.5 rounded bg-red-50 text-red-700">{REVIEW_REASON_LABELS[r] ?? r}</span>)}
    </span>
  );
}

/**
 * S-A (list) and S-B (detail) over report_mp_receipt_status, filtered server-side. Work items are only axis A
 * REVIEW_REQUIRED and axis B CLIENT_RESOLUTION_REQUESTED; CLIENT_UNASSIGNED / PARTIAL / ASSIGNED are valid, never
 * pending. There is no "registrar cobro" for an MP receipt: attribution is only C1.
 */
export function CobrosMP() {
  const hoy = getTodayDate();
  const [desde, setDesde] = useState(shiftDate(hoy, -30));
  const [hasta, setHasta] = useState(hoy);
  const [axisA, setAxisA] = useState<string | null>(null);
  const [axisB, setAxisB] = useState<string | null>(null);
  const [abierto, setAbierto] = useState<number | null>(null);
  const cobros = useReceipts({ from: desde, to: hasta, axisA, axisB });

  if (abierto !== null) return <DetalleCobro movementId={abierto} onBack={() => setAbierto(null)} />;
  const filtro = 'border border-[#E4DCC8] rounded-lg px-2 py-1.5 text-sm bg-white';
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 items-end text-sm">
        <label>Desde<input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} className={`${filtro} ml-1`} /></label>
        <label>Hasta<input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} className={`${filtro} ml-1`} /></label>
        <select value={axisA ?? ''} onChange={(e) => setAxisA(e.target.value || null)} className={filtro}>
          <option value="">Conciliación: todas</option>
          {Object.entries(AXIS_A_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <select value={axisB ?? ''} onChange={(e) => setAxisB(e.target.value || null)} className={filtro}>
          <option value="">Cliente: todos</option>
          {Object.entries(AXIS_B_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <button onClick={() => { setAxisA('REVIEW_REQUIRED'); setAxisB(null); }} className="px-2 py-1.5 rounded-lg bg-red-50 text-red-700">Requiere revisión</button>
        <button onClick={() => { setAxisB('CLIENT_RESOLUTION_REQUESTED'); setAxisA(null); }} className="px-2 py-1.5 rounded-lg bg-amber-50 text-amber-900">Solicitudes de asignación</button>
      </div>
      {cobros.isLoading ? <p className="text-sm text-gray-500">Cargando cobros…</p> : cobros.error ? <p className="text-sm text-red-700">{errorMessage(cobros.error)}</p>
        : (cobros.data ?? []).length === 0 ? <p className="text-sm text-[#8A7A5C]">No hay cobros de Mercado Pago en el período</p> : (
          <div className="bg-white rounded-lg border border-amber-200 overflow-x-auto">
            <table className="w-full text-xs md:text-sm">
              <thead className="bg-amber-50 border-b border-amber-200 text-amber-900">
                <tr><th className="px-3 py-2 text-left">Fecha</th><th className="px-3 py-2 text-left">Pago</th><th className="px-3 py-2 text-right">Bruto</th>
                  <th className="hidden md:table-cell px-3 py-2 text-right">Comisión</th><th className="px-3 py-2 text-right">Neto</th><th className="px-3 py-2 text-left">Estado</th></tr>
              </thead>
              <tbody>
                {(cobros.data ?? []).map((c) => (
                  <tr key={c.mp_financial_movement_id} onClick={() => setAbierto(c.mp_financial_movement_id)} className="border-b border-amber-100 hover:bg-amber-50 cursor-pointer">
                    <td className="px-3 py-2">{c.occurred_date}</td>
                    <td className="px-3 py-2">{c.payment_id ?? '—'}</td>
                    <td className="px-3 py-2 text-right">{formatoPesos(c.gross_amount)}</td>
                    <td className="hidden md:table-cell px-3 py-2 text-right">{formatoPesos(c.fee_amount)}</td>
                    <td className="px-3 py-2 text-right font-semibold">{formatoPesos(c.net_amount)}</td>
                    <td className="px-3 py-2"><AxisBadges a={c.axis_a_state} b={c.axis_b_state} reasons={c.review_reasons} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}

type Accion = 'asignar' | 'revertir' | 'solicitar' | 'cerrar' | 'reconsultar' | null;

function DetalleCobro({ movementId, onBack }: { movementId: number; onBack: () => void }) {
  const detalle = useReceipt(movementId);
  const asignaciones = useAllocationLookup(movementId);
  const clientes = useClients();
  const [accion, setAccion] = useState<Accion>(null);
  const r = detalle.data?.receipt;
  const nombre = (id: string) => (clientes.data ?? []).find((c) => c.id === id)?.nombre ?? '—';
  const boton = 'text-sm px-3 py-1.5 rounded-lg bg-amber-100 text-amber-900 hover:bg-amber-200';

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="flex items-center gap-1 text-sm text-[#A8552E]"><ChevronLeft className="w-4 h-4" /> Volver a cobros</button>
      {detalle.isLoading ? <p className="text-sm text-gray-500">Cargando…</p> : detalle.error ? <p className="text-sm text-red-700">{errorMessage(detalle.error)}</p> : !r ? (
        <p className="text-sm text-[#8A7A5C]">Cobro no encontrado</p>
      ) : (
        <>
          <div className="bg-white rounded-lg border border-[#E4DCC8] p-4 space-y-2 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-semibold text-amber-900">Pago {r.payment_id ?? '—'} · {r.occurred_date}</p>
              <AxisBadges a={r.axis_a_state} b={r.axis_b_state} reasons={r.review_reasons} />
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
              <p>Bruto <b>{formatoPesos(r.gross_amount)}</b></p><p>Comisión <b>{formatoPesos(r.fee_amount)}</b></p>
              <p>Impuestos <b>{formatoPesos(r.tax_amount)}</b></p><p>Neto <b>{formatoPesos(r.net_amount)}</b></p>
              <p>Cobro aplicado <b>{formatoPesos(r.effective_applied_receipt)}</b></p><p>Asignado a clientes <b>{formatoPesos(r.active_attributed)}</b></p>
              <p>Confirmado por reporte <b>{r.report_matched ? 'sí' : 'no'}</b></p>
              {r.unapplied_reversal_count > 0 && <p className="text-red-700">Devoluciones sin aplicar <b>{r.unapplied_reversal_count} · {formatoPesos(r.unapplied_reversal_amount)}</b></p>}
            </div>
          </div>
          {(detalle.data?.exceptions ?? []).length > 0 && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm">
              <p className="font-semibold text-red-800 mb-1">Excepciones de reporte abiertas</p>
              {(detalle.data?.exceptions ?? []).map((e) => <p key={e.match_id} className="text-xs text-red-800">{OUTCOME_LABELS[e.outcome] ?? e.outcome} · {e.created_at.slice(0, 10)}</p>)}
            </div>
          )}
          {(asignaciones.data ?? []).length > 0 && (
            <div className="bg-white rounded-lg border border-[#E4DCC8] p-3 text-sm">
              <p className="text-xs font-semibold text-[#6B5D45] uppercase mb-1">Asignaciones registradas</p>
              {(asignaciones.data ?? []).map((a) => <p key={a.id} className="text-xs text-gray-700">{a.effective_date} · {nombre(a.cliente_id)} · {formatoPesos(a.amount)} · {a.mode}</p>)}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {canAllocate(r) && <button onClick={() => setAccion('asignar')} className={boton}>Asignar a cliente</button>}
            {(asignaciones.data ?? []).length > 0 && <button onClick={() => setAccion('revertir')} className={boton}>Revertir asignación</button>}
            {r.open_flag ? <button onClick={() => setAccion('cerrar')} className={boton}>Cerrar solicitud</button>
              : <button onClick={() => setAccion('solicitar')} className={boton}>Solicitar asignación</button>}
            {r.payment_id && <button onClick={() => setAccion('reconsultar')} className={boton}>Volver a consultar el pago</button>}
          </div>
          {accion === 'asignar' && <AsignarModal r={r} onClose={() => setAccion(null)} />}
          {accion === 'revertir' && <RevertirModal movementId={movementId} onClose={() => setAccion(null)} />}
          {accion === 'solicitar' && <MotivoModal titulo="Solicitar asignación" fn={flagForAttribution} params={{ movementId }} onClose={() => setAccion(null)} />}
          {accion === 'cerrar' && r.open_flag_id && <MotivoModal titulo="Cerrar solicitud" fn={clearAttributionFlag} params={{ flagId: r.open_flag_id }} onClose={() => setAccion(null)} />}
          {accion === 'reconsultar' && r.payment_id && <MotivoModal titulo="Volver a consultar el pago" fn={requestRefetch} params={{ paymentId: r.payment_id }} onClose={() => setAccion(null)} />}
        </>
      )}
    </div>
  );
}

/** An action whose only input is the ADMIN's reason (C4, C5, S6 from S-B, S5, C7). */
export function MotivoModal<P extends object>({ titulo, fn, params, onClose, nota }: {
  titulo: string; fn: (c: never, p: P & { reason: string }) => Promise<unknown>; params: P; onClose: () => void; nota?: string;
}) {
  const accion = useMPAction((c, p: P & { reason: string }) => (fn as unknown as (c2: typeof c, p2: typeof p) => Promise<unknown>)(c, p));
  const [motivo, setMotivo] = useState('');
  return (
    <Modal titulo={titulo} onClose={onClose} puedeGuardar={motivo.trim() !== ''} guardando={accion.isPending} error={accion.error} textoGuardar="Confirmar"
      onSubmit={() => accion.mutate({ ...params, reason: motivo.trim() }, { onSuccess: onClose })}>
      {nota && <p className="text-sm text-gray-600">{nota}</p>}
      <label className={etiqueta}>Motivo<input type="text" value={motivo} onChange={(e) => setMotivo(e.target.value)} className={campo} /></label>
    </Modal>
  );
}

function AsignarModal({ r, onClose }: { r: ReceiptDetail; onClose: () => void }) {
  const accion = useMPAction(allocateToClient);
  const clientes = useClients();
  const [clienteId, setClienteId] = useState('');
  const [monto, setMonto] = useState('');
  const [fecha, setFecha] = useState(r.occurred_date);
  const [motivo, setMotivo] = useState('');
  const [clave, setClave] = useState(() => uiIdempotencyKey());   // one per submission; a retry reuses it
  return (
    <Modal titulo="Asignar a cliente" onClose={onClose} puedeGuardar={clienteId !== '' && Number(monto) > 0 && fecha !== '' && motivo.trim() !== ''}
      guardando={accion.isPending} error={accion.error ?? clientes.error} textoGuardar="Asignar"
      onSubmit={() => accion.mutate({ movementId: r.mp_financial_movement_id, clienteId, amount: Number(monto), effectiveDate: fecha, idempotencyKey: clave, reason: motivo.trim() },
        { onSuccess: () => { setClave(uiIdempotencyKey()); onClose(); } })}>
      <label className={etiqueta}>Cliente
        <select value={clienteId} onChange={(e) => setClienteId(e.target.value)} className={campo}>
          <option value="">Elegir cliente…</option>
          {(clientes.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
        </select>
      </label>
      <label className={etiqueta}>Monto<input type="number" min="0" step="0.01" value={monto} onChange={(e) => setMonto(e.target.value)} className={campo} /></label>
      <p className="text-xs text-gray-500">Cobro aplicado {formatoPesos(r.effective_applied_receipt)} · ya asignado {formatoPesos(r.active_attributed)}. El tope lo controla el sistema.</p>
      <label className={etiqueta}>Fecha (desde {r.occurred_date})<input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} className={campo} /></label>
      <label className={etiqueta}>Motivo<input type="text" value={motivo} onChange={(e) => setMotivo(e.target.value)} className={campo} /></label>
    </Modal>
  );
}

function RevertirModal({ movementId, onClose }: { movementId: number; onClose: () => void }) {
  const accion = useMPAction(reverseAllocation);
  const asignaciones = useAllocationLookup(movementId);
  const clientes = useClients();
  const [allocationId, setAllocationId] = useState('');
  const [monto, setMonto] = useState('');
  const [motivo, setMotivo] = useState('');
  const [clave, setClave] = useState(() => uiIdempotencyKey());
  const nombre = (id: string) => (clientes.data ?? []).find((c) => c.id === id)?.nombre ?? '—';
  return (
    <Modal titulo="Revertir asignación" onClose={onClose} puedeGuardar={allocationId !== '' && Number(monto) > 0 && motivo.trim() !== ''}
      guardando={accion.isPending} error={accion.error ?? asignaciones.error} textoGuardar="Revertir"
      onSubmit={() => accion.mutate({ allocationId, amount: Number(monto), idempotencyKey: clave, reason: motivo.trim() },
        { onSuccess: () => { setClave(uiIdempotencyKey()); onClose(); } })}>
      <label className={etiqueta}>Asignación
        <select value={allocationId} onChange={(e) => setAllocationId(e.target.value)} className={campo}>
          <option value="">Elegir…</option>
          {(asignaciones.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.effective_date} · {nombre(a.cliente_id)} · {formatoPesos(a.amount)}</option>)}
        </select>
      </label>
      <label className={etiqueta}>Monto a revertir<input type="number" min="0" step="0.01" value={monto} onChange={(e) => setMonto(e.target.value)} className={campo} /></label>
      <label className={etiqueta}>Motivo<input type="text" value={motivo} onChange={(e) => setMotivo(e.target.value)} className={campo} /></label>
    </Modal>
  );
}
