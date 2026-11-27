import { useState } from 'react';
import { errorMessage } from '../../target/messages';
import { calendarDate, isOverdue, monthCommitments, withPlanInstalments, type CalendarItemKind, type CalendarRow } from '../../target/paymentCalendar';
import { formatearFechaLocal, getTodayDate } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';
import { AccionModal } from './Cheques';
import { EtiquetaFechaCorregida, FechaPagoChequeModal } from './FechaPagoCheque';
import { Comprobantes } from './Comprobantes';
import { EtiquetasFechas, FechasPagoModal } from './FechasPago';
import { useDocumentLinks } from './useInvoicePayments';
import { usePaymentCalendar } from './usePaymentCalendar';
import { usePayablesDue } from './usePaymentPlan';
import { useAllInstrumentDateChanges } from './useTreasury';

const DIAS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const TIPO_ITEM: Record<CalendarItemKind, { label: string; tono: string }> = {
  FACTURA: { label: 'Factura', tono: 'bg-red-50 text-red-800' },
  GASTO: { label: 'Gasto a pagar', tono: 'bg-amber-50 text-amber-900' },
  CHEQUE: { label: 'Cheque propio', tono: 'bg-sky-50 text-sky-900' },
  ECHEQ: { label: 'eCheq propio', tono: 'bg-sky-50 text-sky-900' },
};
const esInstrumento = (r: CalendarRow) => r.item_kind === 'CHEQUE' || r.item_kind === 'ECHEQ';
const suma = (xs: CalendarRow[]) => xs.reduce((t, x) => t + x.amount, 0);

/**
 * Calendario de pagos (Lote 3B, 0110; simplified in caja-mejoras-v2): the month's FUTURE commitments from fin_payment_calendar —
 * supplier invoices, pending expenses, own cheques / eCheqs still to be debited — each on its estimated payment date, or its due date;
 * "vencido" is decided by the due date only. Only the month's total and the calendar: each day shows its total and who is paid;
 * touching a day lists its payments with their actions (dates, cheque payment date, "Marcar debitado"). The totals by deadline, the
 * items without a date and the debt per supplier live in Cuentas a pagar; real debits are movements (Movimientos). No date moves money.
 */
export function CalendarioPagos() {
  const hoy = getTodayDate();
  const [mes, setMes] = useState(hoy.slice(0, 7));
  const calendario = usePaymentCalendar();
  const planes = usePayablesDue();   // owner 2026-11-27: an obligation with a payment plan shows each open instalment on its date
  const filas = withPlanInstalments(calendario.data ?? [], planes.data ?? []);
  const m = monthCommitments(filas, mes, hoy);
  const docs = useDocumentLinks('FINANCIAL_INSTRUMENT', filas.filter(esInstrumento).map((r) => r.item_id));
  const [dia, setDia] = useState<number | null>(null);
  const [debitar, setDebitar] = useState<CalendarRow | null>(null);
  const [fechaPago, setFechaPago] = useState<CalendarRow | null>(null);
  const correcciones = useAllInstrumentDateChanges();   // 0118: corrected payment dates
  const [fechas, setFechas] = useState<CalendarRow | null>(null);

  const [y, mm] = mes.split('-').map(Number);
  const diasMes = new Date(Date.UTC(y, mm, 0)).getUTCDate();
  const offset = (new Date(Date.UTC(y, mm - 1, 1)).getUTCDay() + 6) % 7;   // Monday first
  const porDia = new Map<number, CalendarRow[]>();
  for (const r of m.enMes) { const d = Number(calendarDate(r)!.slice(8, 10)); porDia.set(d, [...(porDia.get(d) ?? []), r]); }
  const mover = (delta: number) => { const d = new Date(Date.UTC(y, mm - 1 + delta, 1)); setMes(d.toISOString().slice(0, 7)); setDia(null); };
  const error = calendario.error ?? planes.error;
  const cuotaTxt = (r: CalendarRow) => (r.cuota ? ` · cuota ${r.cuota.seq ?? '?'}/${r.cuota.n ?? '?'}` : '');
  const nombre = (r: CalendarRow) => (r.item_kind === 'GASTO' ? (r.concept ?? 'Gasto') : (r.supplier_name ?? r.concept ?? '—')) + cuotaTxt(r);

  const Fila = ({ r }: { r: CalendarRow }) => (
    <li className={`bg-white border rounded px-2 py-1.5 flex flex-wrap items-center gap-2 text-sm ${isOverdue(r, hoy) ? 'border-red-300' : 'border-[#E4DCC8]'}`}>
      <span className="whitespace-nowrap w-20">{calendarDate(r) ? formatearFechaLocal(calendarDate(r)!) : 'Sin fecha'}</span>
      <span className={`text-xs px-1.5 py-0.5 rounded ${TIPO_ITEM[r.item_kind].tono}`}>{TIPO_ITEM[r.item_kind].label}</span>
      <span className="font-semibold">{esInstrumento(r) ? r.document_number : r.item_kind === 'FACTURA' ? r.supplier_name : (r.concept ?? 'Gasto')}{cuotaTxt(r)}</span>
      <span className="text-[#8A7A5C]">
        {r.item_kind === 'FACTURA' && (r.document_number ? `Factura ${r.document_number}` : 'Factura sin número')}
        {r.item_kind === 'GASTO' && (r.supplier_name ? `Sin proveedor · ${r.supplier_name}` : 'Sin proveedor')}
        {esInstrumento(r) && `${r.supplier_name ?? ''} · ${r.bank_account_name ?? ''}`}
      </span>
      {esInstrumento(r)
        ? (r.link_status === 'IMPUTADO'
          ? <span className="text-xs px-2 py-0.5 rounded bg-green-50 text-green-800">Imputado a factura {r.linked_invoice_number ?? ''}</span>
          : <span className="text-xs px-2 py-0.5 rounded bg-stone-100 text-stone-700">Sin imputar: factura no determinada</span>)
        : <EtiquetasFechas due={r.due_date} planned={r.planned_date} hoy={hoy} />}
      {esInstrumento(r) && r.due_date && r.due_date < hoy && <span className="text-xs px-2 py-0.5 rounded bg-red-100 text-red-800">Fecha de pago pasada, sin debitar</span>}
      {esInstrumento(r) && <EtiquetaFechaCorregida cambios={correcciones.data?.get(r.item_id)} />}
      {esInstrumento(r) && <Comprobantes docs={docs.data?.get(r.item_id)} compacto />}
      <span className="flex-1" />
      <span className="font-bold">{formatoPesos(r.amount)}</span>
      {esInstrumento(r)
        ? <>
          <button type="button" onClick={() => setFechaPago(r)} className="text-xs px-2 py-0.5 rounded border border-[#E4DCC8] hover:bg-stone-50">Fecha de pago</button>
          <button type="button" onClick={() => setDebitar(r)} className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-900 hover:bg-amber-200">Marcar debitado</button>
        </>
        : r.item_id.startsWith('ITEM:') || r.item_id.startsWith('DIF:')
          ? <span className="text-xs text-[#8A7A5C]">Fechas e importes: Cuentas a pagar → Cambiar forma de pago</span>
          : <button type="button" onClick={() => setFechas(r)} className="text-xs px-2 py-0.5 rounded border border-[#E4DCC8] hover:bg-stone-50">Fechas</button>}
    </li>
  );
  const Lista = ({ titulo, xs, vacio, nota }: { titulo: string; xs: CalendarRow[]; vacio: string; nota?: string }) => (
    <section>
      <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide mb-1">{titulo}</p>
      {nota && <p className="text-xs text-[#8A7A5C] mb-1">{nota}</p>}
      {xs.length === 0 ? <p className="text-sm text-[#8A7A5C]">{vacio}</p> : (
        <ul className="space-y-1">{[...xs].sort((a, b) => (calendarDate(a) ?? '').localeCompare(calendarDate(b) ?? '')).map((r) => <Fila key={`${r.item_kind}:${r.item_id}`} r={r} />)}</ul>
      )}
    </section>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => mover(-1)} className="px-2 py-1 rounded border border-[#E4DCC8] bg-white text-sm">‹</button>
        <input type="month" value={mes} onChange={(e) => { if (e.target.value) { setMes(e.target.value); setDia(null); } }} className="border border-[#E4DCC8] rounded-lg px-2 py-1 text-sm bg-white" />
        <button type="button" onClick={() => mover(1)} className="px-2 py-1 rounded border border-[#E4DCC8] bg-white text-sm">›</button>
      </div>
      <p className="text-sm text-[#6B5D45]">
        A pagar en el mes: <b className="text-[#2C2419]">{formatoPesos(suma(m.enMes))}</b> · {m.enMes.length} pago{m.enMes.length === 1 ? '' : 's'}
        {m.vencidos.length > 0 && <span className="text-red-700"> · vencidos de meses anteriores {formatoPesos(m.vencido)}</span>}
        {m.sinFecha.length > 0 && <span className="text-[#8A7A5C]"> · sin fecha {formatoPesos(m.totalSinFecha)} (en Cuentas a pagar)</span>}
      </p>

      {calendario.isLoading || planes.isLoading ? <p className="text-sm text-gray-500">Cargando calendario...</p>
        : error ? <p className="text-sm text-red-700">{errorMessage(error)}</p> : (
          <>
            <div className="grid grid-cols-7 gap-1 text-xs" aria-label="Calendario de pagos">
              {DIAS.map((d) => <div key={d} className="text-center font-semibold text-[#8A7A5C]">{d}</div>)}
              {Array.from({ length: offset }, (_, i) => <div key={`v${i}`} />)}
              {Array.from({ length: diasMes }, (_, i) => {
                const d = i + 1;
                const xs = porDia.get(d) ?? [];
                const fecha = `${mes}-${String(d).padStart(2, '0')}`;
                const vencido = xs.some((r) => isOverdue(r, hoy));
                const activo = dia === d;
                return (
                  <button key={d} type="button" onClick={() => setDia(activo ? null : d)} disabled={xs.length === 0} aria-pressed={activo}
                    className={`min-h-16 rounded border p-1 text-left align-top flex flex-col ${activo ? 'ring-2 ring-[#A8552E]' : ''} ${fecha === hoy ? 'border-[#A8552E]' : 'border-[#E4DCC8]'} ${xs.length ? (vencido ? 'bg-red-50 hover:bg-red-100' : 'bg-amber-50 hover:bg-amber-100') : 'bg-white cursor-default'}`}>
                    <span className="text-[#8A7A5C]">{d}</span>
                    {xs.length > 0 && <span className={`font-semibold ${vencido ? 'text-red-700' : 'text-amber-900'}`}>{formatoPesos(suma(xs))}</span>}
                    {xs.slice(0, 2).map((r) => <span key={`${r.item_kind}:${r.item_id}`} className="hidden sm:block text-[10px] text-[#6B5D45] truncate w-full">{nombre(r)}</span>)}
                    {xs.length > 2 && <span className="hidden sm:block text-[10px] text-[#8A7A5C]">+{xs.length - 2} más</span>}
                  </button>
                );
              })}
            </div>

            {dia === null ? <p className="text-xs text-[#8A7A5C]">Tocá un día con pagos para ver el detalle.</p>
              : <Lista titulo={`Pagos del ${dia}/${mes.slice(5, 7)}`} xs={porDia.get(dia) ?? []} vacio="No hay pagos este día." />}
          </>
        )}
      {debitar && (
        <AccionModal action="debit" onClose={() => setDebitar(null)}
          inst={{ id: debitar.item_id, direction: 'ISSUED', instrument_type: debitar.item_kind === 'ECHEQ' ? 'ECHEQ' : 'CHEQUE', cheque_number: debitar.document_number, amount: debitar.amount }} />
      )}
      {fechaPago && (
        <FechaPagoChequeModal onClose={() => setFechaPago(null)} cheque={{ id: fechaPago.item_id, tipo: fechaPago.item_kind === 'ECHEQ' ? 'eCheq' : 'Cheque',
          numero: fechaPago.document_number, amount: fechaPago.amount, maturity_date: fechaPago.due_date, destinatario: fechaPago.supplier_name }} />
      )}
      {fechas && fechas.purchase_id && fechas.purchase_root_id && (
        <FechasPagoModal purchaseId={fechas.purchase_id} rootId={fechas.purchase_root_id}
          titulo={fechas.item_kind === 'FACTURA' ? `Factura ${fechas.document_number ?? ''} · ${fechas.supplier_name ?? ''}` : (fechas.concept ?? 'Gasto a pagar')}
          due={fechas.due_date} planned={fechas.planned_date} onClose={() => setFechas(null)} />
      )}
    </div>
  );
}
