import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useAuth } from '../../auth/useAuth';
import { ATTACHMENT_TYPES } from '../../target/attachments';
import type { PurchasePaymentDetailRow, PurchasePaymentStatusRow } from '../../target/invoicePayments';
import { errorMessage } from '../../target/messages';
import { INSTRUMENT_TYPES, type InstrumentType } from '../../target/treasury';
import { formatearFechaLocal, getTodayDate } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';
import { useFinancialAccounts } from '../pedidos/useCommercial';
import { AccionModal, ACCION, ESTADO, TIPO } from './Cheques';
import { Comprobantes } from './Comprobantes';
import { campo, etiqueta, Modal } from './Modal';
import type { InstrumentAction } from './useTreasury';
import { useUnallocatedPayments } from './usePaymentCalendar';
import {
  useAllocatePurchasePayment, useAttachInstrumentDocument, useDocumentLinks, useInvoicePaymentDetail, useInvoicePaymentStatus,
  useIssuePurchaseInstruments, usePurchaseAttachments,
} from './useInvoicePayments';

const ACEPTA = Object.keys(ATTACHMENT_TYPES).join(',');

/**
 * Pagos de facturas (ADR-025 stage 4, 0104). One supplier invoice (registered once, with its IVA, from Compras or WhatsApp)
 * paid with one or several own cheques / eCheqs and / or payments already registered. A cheque is a SCHEDULED payment (no
 * bank movement until "Marcar debitado" on the effective date: then it is REAL). Every figure is the backend's
 * (fin_purchase_payment_status / _detail); rejected / cancelled cheques stay in the history and can be replaced.
 */
export function PagosFacturas() {
  const [soloPendientes, setSoloPendientes] = useState(true);
  const facturas = useInvoicePaymentStatus(soloPendientes);
  const [abierta, setAbierta] = useState<string | null>(null);
  const [emitir, setEmitir] = useState<{ f: PurchasePaymentStatusRow; reemplaza?: PurchasePaymentDetailRow } | null>(null);
  const [imputar, setImputar] = useState<PurchasePaymentStatusRow | null>(null);
  const filas = facturas.data ?? [];
  const adjuntos = usePurchaseAttachments(filas.map((f) => f.purchase_id));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide">Facturas de proveedores y sus pagos</p>
        <label className="text-sm text-[#6B5D45] flex items-center gap-2">
          <input type="checkbox" checked={soloPendientes} onChange={(e) => setSoloPendientes(e.target.checked)} /> Solo con saldo pendiente
        </label>
      </div>
      <p className="text-xs text-[#8A7A5C]">
        La factura y su IVA se registran una sola vez (Compras o WhatsApp). Un cheque emitido es un pago <b>programado</b>: no mueve el banco hasta
        que se marca debitado (pago <b>real</b>, en la fecha efectiva).
      </p>
      {facturas.isLoading ? <p className="text-sm text-gray-500">Cargando facturas...</p>
        : facturas.error ? <p className="text-sm text-red-700">{errorMessage(facturas.error)}</p>
          : filas.length === 0 ? <p className="text-sm text-green-800">No hay facturas {soloPendientes ? 'con saldo pendiente' : 'de proveedores'}.</p> : (
            <div className="space-y-2">
              {filas.map((f) => (
                <div key={f.purchase_id} className="bg-white rounded-lg border border-[#E4DCC8]">
                  <button type="button" onClick={() => setAbierta(abierta === f.purchase_root_id ? null : f.purchase_root_id)}
                    className="w-full grid grid-cols-2 md:grid-cols-6 gap-2 p-3 text-left text-sm items-center">
                    <span className="flex items-center gap-2 md:col-span-2">
                      <ChevronDown className={`w-4 h-4 shrink-0 transition ${abierta === f.purchase_root_id ? 'rotate-180' : ''}`} />
                      <span>
                        <span className="font-semibold text-amber-900">{f.supplier_name}</span>
                        <span className="block text-xs text-[#8A7A5C]">{formatearFechaLocal(f.economic_date)}{f.supplier_invoice_number ? ` · Factura ${f.supplier_invoice_number}` : ''}</span>
                      </span>
                    </span>
                    <span className="text-right"><span className="block text-[11px] text-[#8A7A5C]">Total</span>{formatoPesos(f.amount_total)}</span>
                    <span className="text-right"><span className="block text-[11px] text-[#8A7A5C]">Programado</span>{formatoPesos(f.scheduled)}</span>
                    <span className="text-right"><span className="block text-[11px] text-[#8A7A5C]">Pagado</span>{formatoPesos(f.debited + f.other_payments)}</span>
                    <span className="text-right font-bold"><span className="block text-[11px] font-normal text-[#8A7A5C]">Pendiente</span>
                      <span className={f.pending > 0 ? 'text-red-700' : 'text-green-800'}>{formatoPesos(f.pending)}</span></span>
                  </button>
                  {abierta === f.purchase_root_id && (
                    <DetalleFactura f={f} docs={adjuntos.data?.get(f.purchase_id)} onEmitir={(reemplaza) => setEmitir({ f, reemplaza })} onImputar={() => setImputar(f)} />
                  )}
                </div>
              ))}
            </div>
          )}
      {emitir && <EmitirChequesModal f={emitir.f} reemplaza={emitir.reemplaza} onClose={() => setEmitir(null)} />}
      {imputar && <ImputarPagoModal f={imputar} onClose={() => setImputar(null)} />}
    </div>
  );
}

function DetalleFactura({ f, docs, onEmitir, onImputar }: {
  f: PurchasePaymentStatusRow; docs: Parameters<typeof Comprobantes>[0]['docs']; onEmitir: (reemplaza?: PurchasePaymentDetailRow) => void; onImputar: () => void;
}) {
  const { user } = useAuth();
  const detalle = useInvoicePaymentDetail(f.purchase_root_id);
  const filas = detalle.data ?? [];
  const docsCheques = useDocumentLinks('FINANCIAL_INSTRUMENT', filas.flatMap((r) => (r.financial_instrument_id ? [r.financial_instrument_id] : [])));
  const adjuntar = useAttachInstrumentDocument();
  const [accion, setAccion] = useState<{ action: InstrumentAction; r: PurchasePaymentDetailRow } | null>(null);
  const reemplazados = new Set(filas.map((r) => r.replaces_instrument_id).filter(Boolean));

  return (
    <div className="px-4 pb-3 border-t border-[#E4DCC8] bg-[#FAF6EE] text-sm space-y-2">
      <div className="flex flex-wrap items-center gap-2 pt-2">
        <span className="text-xs text-[#8A7A5C]">Factura:</span>
        {docs && docs.length > 0 ? <Comprobantes docs={docs} /> : <span className="text-xs text-[#8A7A5C]">sin archivo</span>}
        {f.fiscal_document_id && <span className="text-xs px-2 py-0.5 rounded bg-blue-50 text-blue-800">En Fiscal</span>}
        <span className="flex-1" />
        {f.pending > 0 && (
          <>
            <button type="button" onClick={() => onEmitir()} className="text-xs px-2 py-1 rounded bg-amber-600 text-white hover:bg-amber-700">Emitir cheques / eCheqs</button>
            <button type="button" onClick={onImputar} className="text-xs px-2 py-1 rounded bg-amber-100 text-amber-900 hover:bg-amber-200">Imputar pago registrado</button>
          </>
        )}
      </div>
      {detalle.isLoading ? <p className="text-xs text-gray-500">Cargando pagos...</p>
        : detalle.error ? <p className="text-xs text-red-700">{errorMessage(detalle.error)}</p>
          : filas.length === 0 ? <p className="text-xs text-[#8A7A5C]">Sin pagos asignados.</p> : (
            <ul className="space-y-1">
              {filas.map((r) => (
                <li key={r.allocation_id} className="bg-white border border-[#E4DCC8] rounded px-2 py-1.5 flex flex-wrap items-center gap-2 text-xs">
                  {r.financial_instrument_id ? (
                    <>
                      <span className="font-semibold">{TIPO[r.instrument_type!]} {r.cheque_number}</span>
                      <span className="text-[#8A7A5C]">{r.bank_account_name} · emitido {formatearFechaLocal(r.issued_date!)} · vence {formatearFechaLocal(r.maturity_date!)}
                        {r.debited_date ? ` · debitado ${formatearFechaLocal(r.debited_date)}` : ''}{r.rejected_date ? ` · ${formatearFechaLocal(r.rejected_date)}` : ''}</span>
                      {r.replaces_instrument_id && <span className="text-[#8A7A5C]">(reemplazo)</span>}
                      <span className={`px-2 py-0.5 rounded ${ESTADO[r.estado!].clase}`}>{r.estado === 'ISSUED' ? 'Programado' : ESTADO[r.estado!].texto}</span>
                      <Comprobantes docs={docsCheques.data?.get(r.financial_instrument_id)} compacto />
                    </>
                  ) : (
                    <span>Pago registrado · {r.payment_date ? formatearFechaLocal(r.payment_date) : ''} <span className="text-[#8A7A5C]">(operación {r.financial_operation_id})</span></span>
                  )}
                  <span className="flex-1" />
                  <span className={`font-semibold ${r.estado === 'REJECTED' || r.estado === 'CANCELLED' ? 'line-through text-[#8A7A5C]' : ''}`}>{formatoPesos(r.amount)}</span>
                  {r.estado === 'ISSUED' && (['debit', 'cancel', 'reject'] as InstrumentAction[]).map((a) => (
                    <button key={a} type="button" onClick={() => setAccion({ action: a, r })}
                      className={`px-2 py-0.5 rounded ${a === 'debit' ? 'bg-amber-100 text-amber-900 hover:bg-amber-200' : 'bg-red-50 text-red-700 hover:bg-red-100'}`}>{ACCION[a]}</button>
                  ))}
                  {(r.estado === 'REJECTED' || r.estado === 'CANCELLED') && !reemplazados.has(r.financial_instrument_id) && f.pending > 0 && (
                    <button type="button" onClick={() => onEmitir(r)} className="px-2 py-0.5 rounded bg-amber-100 text-amber-900 hover:bg-amber-200">Reemplazar</button>
                  )}
                  {r.financial_instrument_id && (
                    <label className="px-2 py-0.5 rounded bg-stone-100 text-[#6B5D45] hover:bg-stone-200 cursor-pointer">
                      {adjuntar.isPending ? 'Subiendo…' : 'Adjuntar PDF'}
                      <input type="file" accept={ACEPTA} className="hidden" disabled={adjuntar.isPending}
                        onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file && user) adjuntar.mutate({ userId: user.id, instrumentId: r.financial_instrument_id!, file }); }} />
                    </label>
                  )}
                </li>
              ))}
            </ul>
          )}
      {adjuntar.error ? <p className="text-xs text-red-700">{errorMessage(adjuntar.error)}</p> : null}
      {f.voided_instruments > 0 && <p className="text-[11px] text-[#8A7A5C]">Los cheques rechazados o anulados no cuentan como pago; quedan en el historial.</p>}
      {accion && (
        <AccionModal action={accion.action} onClose={() => setAccion(null)}
          inst={{ id: accion.r.financial_instrument_id!, direction: 'ISSUED', instrument_type: accion.r.instrument_type!, cheque_number: accion.r.cheque_number, amount: accion.r.amount }} />
      )}
    </div>
  );
}

interface FilaCheque { tipo: InstrumentType; numero: string; monto: string; emision: string; vencimiento: string; cuenta: string; archivo: File | null }
const filaVacia = (monto = '', cuenta = ''): FilaCheque => ({ tipo: 'ECHEQ', numero: '', monto, emision: getTodayDate(), vencimiento: getTodayDate(), cuenta, archivo: null });

function EmitirChequesModal({ f, reemplaza, onClose }: { f: PurchasePaymentStatusRow; reemplaza?: PurchasePaymentDetailRow; onClose: () => void }) {
  const { user } = useAuth();
  const cuentas = useFinancialAccounts();
  const bancos = (cuentas.data ?? []).filter((a) => a.account_type === 'BANK_ACCOUNT');
  const emitir = useIssuePurchaseInstruments();
  const [filas, setFilas] = useState<FilaCheque[]>(() => [filaVacia(String(reemplaza ? Math.min(reemplaza.amount, f.pending) : f.pending), reemplaza?.bank_account_id ?? '')]);
  const [motivo, setMotivo] = useState('');
  const [clave] = useState(() => `PINS-${crypto.randomUUID()}`);   // idempotency: one per opened form
  const suma = filas.reduce((s, r) => s + (Number(r.monto) || 0), 0);
  const valida = (r: FilaCheque) => r.numero.trim() !== '' && Number(r.monto) > 0 && r.emision !== '' && r.vencimiento >= r.emision && r.cuenta !== '';
  const puede = !!user && filas.length > 0 && filas.every(valida) && suma <= f.pending + 0.005;
  const set = (i: number, p: Partial<FilaCheque>) => setFilas((fs) => fs.map((r, j) => (j === i ? { ...r, ...p } : r)));

  return (
    <Modal titulo={`${reemplaza ? 'Reemplazar' : 'Emitir'} cheques — ${f.supplier_name}`} onClose={onClose} puedeGuardar={puede} guardando={emitir.isPending}
      error={emitir.error ?? cuentas.error} textoGuardar={`Emitir ${filas.length}`}
      onSubmit={() => emitir.mutate({
        userId: user!.id, purchaseId: f.purchase_id, idempotencyKey: clave, reason: motivo,
        rows: filas.map((r, i) => ({ instrument_type: r.tipo, cheque_number: r.numero.trim(), amount: Number(r.monto), issued_date: r.emision, maturity_date: r.vencimiento,
          bank_account_id: r.cuenta, replaces_instrument_id: i === 0 && reemplaza ? reemplaza.financial_instrument_id : null, file: r.archivo })),
      }, { onSuccess: onClose })}>
      <p className="text-xs text-[#6B5D45]">Factura {f.supplier_invoice_number ?? 's/n'} · total {formatoPesos(f.amount_total)} · pendiente <b>{formatoPesos(f.pending)}</b>
        {reemplaza && <> · reemplaza {TIPO[reemplaza.instrument_type!]} {reemplaza.cheque_number} ({ESTADO[reemplaza.estado!].texto.toLowerCase()})</>}</p>
      {filas.map((r, i) => (
        <div key={i} className="border border-[#E4DCC8] rounded-lg p-2 space-y-1">
          <div className="flex items-center gap-2">
            {INSTRUMENT_TYPES.map((t) => (
              <button key={t} type="button" onClick={() => set(i, { tipo: t })}
                className={`px-2 py-1 rounded text-xs font-medium ${r.tipo === t ? 'bg-amber-600 text-white' : 'bg-stone-100 text-gray-700'}`}>{TIPO[t]}</button>
            ))}
            <span className="flex-1" />
            {filas.length > 1 && <button type="button" onClick={() => setFilas((fs) => fs.filter((_, j) => j !== i))} className="text-xs text-red-700">Quitar</button>}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className={etiqueta}>Número<input type="text" value={r.numero} onChange={(e) => set(i, { numero: e.target.value })} className={campo} /></label>
            <label className={etiqueta}>Monto<input type="number" min="0" step="0.01" value={r.monto} onChange={(e) => set(i, { monto: e.target.value })} className={campo} /></label>
            <label className={etiqueta}>Emisión<input type="date" value={r.emision} onChange={(e) => set(i, { emision: e.target.value })} className={campo} /></label>
            <label className={etiqueta}>Vencimiento<input type="date" value={r.vencimiento} onChange={(e) => set(i, { vencimiento: e.target.value })} className={campo} /></label>
          </div>
          <label className={etiqueta}>Cuenta bancaria
            <select value={r.cuenta} onChange={(e) => set(i, { cuenta: e.target.value })} className={campo}>
              <option value="">Elegir cuenta…</option>
              {bancos.map((a) => <option key={a.id} value={a.id}>{a.nombre}</option>)}
            </select>
          </label>
          <label className={etiqueta}>PDF / foto del cheque (opcional)
            <input type="file" accept={ACEPTA} onChange={(e) => set(i, { archivo: e.target.files?.[0] ?? null })} className="block text-xs mt-1" />
          </label>
        </div>
      ))}
      {!reemplaza && filas.length < 24 && (
        <button type="button" onClick={() => setFilas((fs) => [...fs, filaVacia(String(Math.max(0, +(f.pending - suma).toFixed(2))), fs[fs.length - 1]?.cuenta ?? '')])}
          className="text-xs text-[#A8552E] hover:underline">+ Agregar otro cheque</button>
      )}
      <p className={`text-xs ${suma > f.pending + 0.005 ? 'text-red-700' : 'text-[#6B5D45]'}`}>Suma {formatoPesos(suma)} de {formatoPesos(f.pending)} pendiente.</p>
      <label className={etiqueta}>Notas (opcional)<input type="text" value={motivo} onChange={(e) => setMotivo(e.target.value)} className={campo} /></label>
      <p className="text-xs text-gray-500">Baja la deuda con el proveedor; el banco se mueve recién al marcar cada cheque como debitado.</p>
    </Modal>
  );
}

function ImputarPagoModal({ f, onClose }: { f: PurchasePaymentStatusRow; onClose: () => void }) {
  // only payments with an amount still free to allocate (fin_supplier_unallocated_payments, 0110), with that amount
  const libres = useUnallocatedPayments();
  const pagos = { ...libres, data: (libres.data ?? []).filter((p) => p.supplier_id === f.supplier_id) };
  const imputar = useAllocatePurchasePayment();
  const [opId, setOpId] = useState('');
  const [monto, setMonto] = useState(String(f.pending));
  const [clave] = useState(() => `PALLOC-${crypto.randomUUID()}`);
  const disponible = pagos.data.find((p) => String(p.financial_operation_id) === opId)?.available ?? 0;
  const puede = opId !== '' && Number(monto) > 0 && Number(monto) <= f.pending + 0.005 && Number(monto) <= disponible + 0.005;

  return (
    <Modal titulo={`Imputar pago — ${f.supplier_name}`} onClose={onClose} puedeGuardar={puede} guardando={imputar.isPending} error={imputar.error ?? pagos.error}
      textoGuardar="Imputar" onSubmit={() => imputar.mutate({ purchaseId: f.purchase_id, operationId: Number(opId), amount: Number(monto), idempotencyKey: clave }, { onSuccess: onClose })}>
      <p className="text-xs text-[#6B5D45]">Un pago ya registrado al proveedor (Cuentas a pagar → Pagar) se asigna a esta factura. No se crea otro movimiento.</p>
      <label className={etiqueta}>Pago
        <select value={opId} onChange={(e) => setOpId(e.target.value)} className={campo}>
          <option value="">{pagos.isLoading ? 'Cargando…' : pagos.data.length === 0 ? 'No hay pagos disponibles para imputar a este proveedor' : 'Elegir pago…'}</option>
          {pagos.data.map((p) => <option key={p.financial_operation_id} value={p.financial_operation_id}>{formatearFechaLocal(p.effective_date)} · pagado {formatoPesos(p.paid)} · disponible {formatoPesos(p.available)}{p.reason ? ` · ${p.reason}` : ''}</option>)}
        </select>
      </label>
      {opId !== '' && Number(monto) > disponible + 0.005 && <p className="text-xs text-red-700">Supera lo disponible de ese pago ({formatoPesos(disponible)}).</p>}
      <label className={etiqueta}>Monto a imputar<input type="number" min="0" step="0.01" value={monto} onChange={(e) => setMonto(e.target.value)} className={campo} /></label>
    </Modal>
  );
}
