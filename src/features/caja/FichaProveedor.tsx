import { useState } from 'react';
import type { PurchasePaymentStatusRow } from '../../target/invoicePayments';
import { errorMessage } from '../../target/messages';
import { SUPPLIER_MOVEMENT, type InstrumentEstado, type SupplierAccount } from '../../target/treasury';
import { formatearFechaLocal, getTodayDate } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';
import { Comprobantes } from './Comprobantes';
import { FechasPagoModal } from './FechasPago';
import { useUnallocatedPayments } from './usePaymentCalendar';
import { useDocumentLinks, usePurchaseAttachments, useSupplierInvoices } from './useInvoicePayments';
import { useInstruments, useSupplierLedger } from './useTreasury';

const ESTADO_INSTRUMENTO: Partial<Record<InstrumentEstado, string>> = {
  ISSUED: 'Programado (aún no debitado)', DEBITED: 'Debitado', REJECTED: 'Rechazado', CANCELLED: 'Anulado', ENDORSED: 'Endosado',
};
const TIPO_MOV: Record<'OBLIGACION' | 'PAGO' | 'INSTRUMENTO' | 'CORRECCION', string> = {
  OBLIGACION: 'bg-red-50 text-red-800', PAGO: 'bg-green-50 text-green-800', INSTRUMENTO: 'bg-sky-50 text-sky-900', CORRECCION: 'bg-stone-100 text-stone-700',
};
const TH = 'py-1 pr-3 text-left font-normal whitespace-nowrap';
const TD = 'py-1 pr-3 align-top whitespace-nowrap';
const Seccion = ({ titulo, children }: { titulo: string; children: React.ReactNode }) => (
  <div>
    <p className="text-xs font-semibold text-[#6B5D45] uppercase mt-3 mb-1">{titulo}</p>
    {children}
  </div>
);

/**
 * Lote 3A — the supplier's current account as the ERP already records it (nothing derived, nothing invented):
 *   · Facturas: each current purchase with the backend's payment status (fin_purchase_payment_status) and its receipts, its
 *     due date and estimated payment date (Lote 3B, 0110: planning only, editable from here);
 *   · Movimientos: the supplier ledger — obligations (+), real payments and own instruments (−), corrections;
 *   · Cheques / eCheqs: own instruments issued to this supplier and third-party cheques endorsed to it, with their PDFs.
 * The balance is report_balance_period's: a negative one is a credit in our favour (advance), never an expense.
 */
export function FichaProveedor({ cuenta }: { cuenta: SupplierAccount }) {
  const facturas = useSupplierInvoices(cuenta.supplier_id);
  const movimientos = useSupplierLedger(cuenta.supplier_id);
  const instrumentos = useInstruments();
  const cheques = (instrumentos.data ?? []).filter((i) => (i.direction === 'ISSUED' && i.supplier_id === cuenta.supplier_id) || i.endorsed_to_supplier_id === cuenta.supplier_id);
  const adjuntos = usePurchaseAttachments((facturas.data ?? []).map((f) => f.purchase_id));
  const pdfs = useDocumentLinks('FINANCIAL_INSTRUMENT', cheques.filter((c) => c.direction === 'ISSUED').map((c) => c.id));
  const libres = useUnallocatedPayments();
  const disponible = (libres.data ?? []).filter((p) => p.supplier_id === cuenta.supplier_id).reduce((t, p) => t + p.available, 0);
  const error = facturas.error ?? movimientos.error ?? instrumentos.error ?? libres.error;
  const [fechas, setFechas] = useState<PurchasePaymentStatusRow | null>(null);
  const hoy = getTodayDate();

  return (
    <div className="px-4 pb-4 border-t border-[#E4DCC8] bg-[#FAF6EE] text-xs">
      {error && <p className="mt-3 text-red-700">{errorMessage(error)}</p>}
      <p className="mt-3 text-[#6B5D45]">
        {cuenta.balance > 0 ? <>Deuda con el proveedor: <b className="text-red-600">{formatoPesos(cuenta.balance)}</b></>
          : cuenta.balance < 0 ? <>Saldo a favor (anticipo): <b className="text-green-700">{formatoPesos(-cuenta.balance)}</b> — no es un gasto: se descuenta de próximas compras.</>
            : 'Al día: sin deuda ni saldo a favor.'}
      </p>
      {disponible > 0 && (
        <p className="mt-1 text-[#6B5D45]">Pagos disponibles para imputar a facturas: <b className="text-green-700">{formatoPesos(disponible)}</b> — no se descuentan solos del pendiente de cada factura; imputalos desde Caja → Pagos de facturas.</p>
      )}

      <Seccion titulo="Facturas y compras">
        {facturas.isLoading ? <p className="text-gray-500">Cargando…</p> : (facturas.data ?? []).length === 0 ? <p className="text-gray-500">Sin compras registradas.</p> : (
          <div className="overflow-x-auto">
            <table className="text-xs">
              <thead><tr className="text-[#8A7A5C] border-b border-[#E4DCC8]">
                <th className={TH}>Fecha</th><th className={TH}>Factura</th><th className={`${TH} text-right`}>Total</th>
                <th className={`${TH} text-right`}>Cheques programados</th><th className={`${TH} text-right`}>Debitado</th>
                <th className={`${TH} text-right`}>Otros pagos</th><th className={`${TH} text-right`}>Pendiente</th>
                <th className={TH}>Vencimiento</th><th className={TH}>Pago estimado</th><th className={TH}>Comprobante</th><th className={TH} />
              </tr></thead>
              <tbody>
                {(facturas.data ?? []).map((f) => (
                  <tr key={f.purchase_id} className="border-b border-[#EFE8D6] last:border-0 text-gray-700">
                    <td className={TD}>{formatearFechaLocal(f.economic_date)}</td>
                    <td className={TD}>{f.supplier_invoice_number ?? '—'}</td>
                    <td className={`${TD} text-right tabular-nums`}>{formatoPesos(f.amount_total)}</td>
                    <td className={`${TD} text-right tabular-nums text-sky-800`}>{f.scheduled ? formatoPesos(f.scheduled) : '—'}</td>
                    <td className={`${TD} text-right tabular-nums`}>{f.debited ? formatoPesos(f.debited) : '—'}</td>
                    <td className={`${TD} text-right tabular-nums`}>{f.other_payments ? formatoPesos(f.other_payments) : '—'}</td>
                    <td className={`${TD} text-right tabular-nums font-semibold ${f.pending > 0 ? 'text-red-600' : 'text-gray-500'}`}>{formatoPesos(f.pending)}</td>
                    <td className={`${TD} ${f.pending > 0 && f.due_date && f.due_date < hoy ? 'text-red-700 font-semibold' : ''}`}>{f.due_date ? formatearFechaLocal(f.due_date) : '—'}</td>
                    <td className={`${TD} text-sky-800`}>{f.planned_date ? formatearFechaLocal(f.planned_date) : '—'}</td>
                    <td className={TD}><Comprobantes docs={adjuntos.data?.get(f.purchase_id)} compacto /></td>
                    <td className={TD}>{f.pending > 0 && <button type="button" onClick={() => setFechas(f)} className="text-[#A8552E] hover:underline">Fechas</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-[11px] text-gray-500 mt-1">
          El pendiente de cada factura descuenta solo lo imputado a esa factura; un pago o cheque sin imputar baja la deuda total del
          proveedor, no una factura en particular. Los cheques programados ya bajan la deuda pero todavía no movieron el banco.
          Para pagar o imputar una factura: Pagos de facturas. Vencimiento y pago estimado son planificación: no registran pagos.
        </p>
      </Seccion>

      <Seccion titulo="Movimientos de la cuenta corriente">
        {movimientos.isLoading ? <p className="text-gray-500">Cargando…</p> : (movimientos.data ?? []).length === 0 ? <p className="text-gray-500">Sin movimientos.</p> : (
          <div className="overflow-x-auto">
            <table className="text-xs">
              <thead><tr className="text-[#8A7A5C] border-b border-[#E4DCC8]">
                <th className={TH}>Fecha</th><th className={TH}>Movimiento</th><th className={`${TH} text-right`}>Deuda</th><th className={TH}>Detalle</th>
              </tr></thead>
              <tbody>
                {(movimientos.data ?? []).map((m) => {
                  const t = SUPPLIER_MOVEMENT[m.movement_type];
                  return (
                    <tr key={m.id} className="border-b border-[#EFE8D6] last:border-0 text-gray-700">
                      <td className={TD}>{formatearFechaLocal(m.effective_date)}</td>
                      <td className={TD}><span className={`px-1.5 py-0.5 rounded ${TIPO_MOV[t.kind]}`}>{t.label}</span></td>
                      <td className={`${TD} text-right tabular-nums ${m.signed_amount > 0 ? 'text-red-600' : 'text-green-700'}`}>{m.signed_amount > 0 ? '+' : '−'}{formatoPesos(Math.abs(m.signed_amount))}</td>
                      <td className="py-1 align-top text-gray-500 [overflow-wrap:anywhere] min-w-[8rem]">{m.reason ?? ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Seccion>

      <Seccion titulo="Cheques y eCheqs">
        {instrumentos.isLoading ? <p className="text-gray-500">Cargando…</p> : cheques.length === 0 ? <p className="text-gray-500">Sin cheques ni eCheqs.</p> : (
          <div className="overflow-x-auto">
            <table className="text-xs">
              <thead><tr className="text-[#8A7A5C] border-b border-[#E4DCC8]">
                <th className={TH}>Tipo</th><th className={TH}>Número</th><th className={`${TH} text-right`}>Importe</th><th className={TH}>Emisión</th>
                <th className={TH}>Vencimiento</th><th className={TH}>Estado</th><th className={TH}>PDF</th>
              </tr></thead>
              <tbody>
                {cheques.map((c) => (
                  <tr key={c.id} className="border-b border-[#EFE8D6] last:border-0 text-gray-700">
                    <td className={TD}>{c.direction === 'ISSUED' ? (c.instrument_type === 'ECHEQ' ? 'eCheq propio' : 'Cheque propio') : 'Cheque de tercero endosado'}</td>
                    <td className={TD}>{c.cheque_number ?? '—'}</td>
                    <td className={`${TD} text-right tabular-nums`}>{formatoPesos(c.amount)}</td>
                    <td className={TD}>{c.issued_date ? formatearFechaLocal(c.issued_date) : c.endorsed_date ? formatearFechaLocal(c.endorsed_date) : '—'}</td>
                    <td className={TD}>{c.maturity_date ? formatearFechaLocal(c.maturity_date) : '—'}</td>
                    <td className={TD}>{(c.direction === 'RECEIVED' ? 'Endosado' : ESTADO_INSTRUMENTO[c.estado]) ?? c.estado}</td>
                    <td className={TD}>{c.direction === 'ISSUED' ? <Comprobantes docs={pdfs.data?.get(c.id)} compacto /> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Seccion>
      {fechas && <FechasPagoModal purchaseId={fechas.purchase_id} rootId={fechas.purchase_root_id} titulo={`Factura ${fechas.supplier_invoice_number ?? formatearFechaLocal(fechas.economic_date)}`}
        due={fechas.due_date} planned={fechas.planned_date} onClose={() => setFechas(null)} />}
    </div>
  );
}
