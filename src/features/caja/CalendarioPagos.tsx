import { useState } from 'react';
import { errorMessage } from '../../target/messages';
import { calendarDate, isOverdue, monthCommitments, netFundsNeed, supplierPositions, type CalendarItemKind, type CalendarRow } from '../../target/paymentCalendar';
import { formatearFechaLocal, getTodayDate } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';
import { AccionModal } from './Cheques';
import { Comprobantes } from './Comprobantes';
import { EtiquetasFechas, FechasPagoModal } from './FechasPago';
import { useDebitedInstruments, useDocumentLinks } from './useInvoicePayments';
import { usePaymentCalendar, useUnallocatedPayments } from './usePaymentCalendar';
import { useLedgerBalances } from './useTreasury';

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
 * Calendario de pagos (Lote 3B, 0110; replaces Vencimientos of 0104): every FUTURE commitment once, from fin_payment_calendar —
 * supplier invoices (their pending already excludes the own cheques allocated to them), pending expenses without supplier, own
 * cheques / eCheqs still to be debited. Each one sits on its estimated payment date, or its due date; "vencido" is decided by
 * the due date only. Kept apart: cheques WITHOUT allocation (their invoice is not determined, never matched here), obligations
 * without a date, and the instruments debited in the month (REAL movements, not commitments). No date ever moves money: the
 * bank moves only with "Marcar debitado"; an invoice or expense is paid from Cuentas a pagar.
 * The month shows each document's pending (gross). The NET need of funds (supplier balance + cheques still to be debited +
 * pending expenses) is shown apart, with the payments free to allocate (advances) and the differences per supplier: an advance
 * is never discounted from a specific invoice here — it is allocated by hand in Pagos de facturas (onImputar).
 */
export function CalendarioPagos({ onImputar }: { onImputar?: () => void }) {
  const hoy = getTodayDate();
  const [mes, setMes] = useState(hoy.slice(0, 7));
  const calendario = usePaymentCalendar();
  const saldos = useLedgerBalances('SUPPLIER');
  const libres = useUnallocatedPayments();
  const debitados = useDebitedInstruments(mes);
  const filas = calendario.data ?? [];
  const m = monthCommitments(filas, mes, hoy);
  const docs = useDocumentLinks('FINANCIAL_INSTRUMENT', filas.filter(esInstrumento).map((r) => r.item_id));
  const posiciones = supplierPositions(filas, saldos.data ?? [], libres.data ?? []);
  const neto = netFundsNeed(filas, saldos.data ?? [], libres.data ?? []);
  const [debitar, setDebitar] = useState<CalendarRow | null>(null);
  const [fechas, setFechas] = useState<CalendarRow | null>(null);

  const [y, mm] = mes.split('-').map(Number);
  const diasMes = new Date(Date.UTC(y, mm, 0)).getUTCDate();
  const offset = (new Date(Date.UTC(y, mm - 1, 1)).getUTCDay() + 6) % 7;   // Monday first
  const porDia = new Map<number, CalendarRow[]>();
  for (const r of m.enMes) { const d = Number(calendarDate(r)!.slice(8, 10)); porDia.set(d, [...(porDia.get(d) ?? []), r]); }
  const mover = (delta: number) => { const d = new Date(Date.UTC(y, mm - 1 + delta, 1)); setMes(d.toISOString().slice(0, 7)); };
  const totalDebitado = (debitados.data ?? []).reduce((t, d) => t + d.amount, 0);
  const error = calendario.error ?? saldos.error ?? debitados.error ?? libres.error;

  const Fila = ({ r }: { r: CalendarRow }) => (
    <li className={`bg-white border rounded px-2 py-1.5 flex flex-wrap items-center gap-2 text-sm ${isOverdue(r, hoy) ? 'border-red-300' : 'border-[#E4DCC8]'}`}>
      <span className="whitespace-nowrap w-20">{calendarDate(r) ? formatearFechaLocal(calendarDate(r)!) : 'Sin fecha'}</span>
      <span className={`text-xs px-1.5 py-0.5 rounded ${TIPO_ITEM[r.item_kind].tono}`}>{TIPO_ITEM[r.item_kind].label}</span>
      <span className="font-semibold">{esInstrumento(r) ? r.document_number : r.item_kind === 'FACTURA' ? r.supplier_name : (r.concept ?? 'Gasto')}</span>
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
      {esInstrumento(r) && r.due_date && r.due_date < hoy && <span className="text-xs px-2 py-0.5 rounded bg-red-100 text-red-800">Vencido sin debitar</span>}
      {esInstrumento(r) && <Comprobantes docs={docs.data?.get(r.item_id)} compacto />}
      <span className="flex-1" />
      <span className="font-bold">{formatoPesos(r.amount)}</span>
      {esInstrumento(r)
        ? <button type="button" onClick={() => setDebitar(r)} className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-900 hover:bg-amber-200">Marcar debitado</button>
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
        <input type="month" value={mes} onChange={(e) => e.target.value && setMes(e.target.value)} className="border border-[#E4DCC8] rounded-lg px-2 py-1 text-sm bg-white" />
        <button type="button" onClick={() => mover(1)} className="px-2 py-1 rounded border border-[#E4DCC8] bg-white text-sm">›</button>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 text-sm">
        <div className="bg-white rounded-lg border border-[#E4DCC8] p-2"><p className="text-xs text-[#8A7A5C]">Compromisos del mes</p><b className="text-amber-900">{formatoPesos(m.confirmado)}</b>
          <p className="text-[11px] text-gray-500">pendiente por documento: facturas, gastos y cheques imputados</p></div>
        <div className="bg-white rounded-lg border border-[#E4DCC8] p-2"><p className="text-xs text-[#8A7A5C]">Cheques sin imputar del mes</p><b className="text-sky-900">{formatoPesos(m.sinImputar)}</b>
          <p className="text-[11px] text-gray-500">vinculación a factura no determinada</p></div>
        <div className="bg-white rounded-lg border border-[#E4DCC8] p-2"><p className="text-xs text-[#8A7A5C]">Sin fecha</p><b className="text-[#6B5D45]">{formatoPesos(m.totalSinFecha)}</b>
          <p className="text-[11px] text-gray-500">{m.sinFecha.length} obligación(es)</p></div>
        <div className="bg-white rounded-lg border border-[#E4DCC8] p-2"><p className="text-xs text-[#8A7A5C]">Debitado en el mes (real)</p><b className="text-green-800">{formatoPesos(totalDebitado)}</b>
          <p className="text-[11px] text-gray-500">movimientos de banco, no compromisos</p></div>
      </div>
      <div className="bg-white rounded-lg border border-[#E4DCC8] p-2 text-sm flex flex-wrap gap-x-6 gap-y-1" aria-label="Necesidad neta de fondos">
        <span><span className="text-xs text-[#8A7A5C]">Pendiente por documentos (todas las fechas) </span><b>{formatoPesos(neto.bruto)}</b></span>
        <span><span className="text-xs text-[#8A7A5C]">Necesidad neta de fondos </span><b className="text-amber-900">{formatoPesos(neto.neto)}</b></span>
        <span><span className="text-xs text-[#8A7A5C]">Pagos disponibles para imputar </span><b className="text-green-800">{formatoPesos(neto.disponibles)}</b></span>
        <p className="w-full text-[11px] text-gray-500">Neta = deuda en cuenta corriente de cada proveedor + cheques y eCheqs a debitar + gastos sin proveedor. No se reparte por mes: los anticipos y cheques sin imputar no se asignan a ninguna factura.</p>
      </div>
      <p className="text-xs text-[#8A7A5C]">Previsto, no pagado: ninguna fecha registra un pago. Cada compromiso aparece en su fecha estimada de pago o, si no tiene, en su vencimiento; “vencido” se decide solo por el vencimiento.</p>

      {calendario.isLoading ? <p className="text-sm text-gray-500">Cargando calendario...</p>
        : error ? <p className="text-sm text-red-700">{errorMessage(error)}</p> : (
          <>
            <div className="grid grid-cols-7 gap-1 text-xs" aria-label="Calendario de pagos">
              {DIAS.map((d) => <div key={d} className="text-center font-semibold text-[#8A7A5C]">{d}</div>)}
              {Array.from({ length: offset }, (_, i) => <div key={`v${i}`} />)}
              {Array.from({ length: diasMes }, (_, i) => {
                const dia = i + 1;
                const xs = porDia.get(dia) ?? [];
                const fecha = `${mes}-${String(dia).padStart(2, '0')}`;
                const conf = xs.filter((r) => r.link_status !== 'SIN_IMPUTAR');
                const sinImp = xs.filter((r) => r.link_status === 'SIN_IMPUTAR');
                const vencido = xs.some((r) => isOverdue(r, hoy));
                return (
                  <div key={dia} className={`min-h-14 rounded border p-1 ${fecha === hoy ? 'border-[#A8552E]' : 'border-[#E4DCC8]'} ${xs.length ? (vencido ? 'bg-red-50' : 'bg-amber-50') : 'bg-white'}`}>
                    <div className="text-[#8A7A5C]">{dia}</div>
                    {conf.length > 0 && <div className={`font-semibold ${vencido ? 'text-red-700' : 'text-amber-900'}`}>{formatoPesos(suma(conf))}</div>}
                    {sinImp.length > 0 && <div className="text-[10px] text-sky-900">+{formatoPesos(suma(sinImp))} s/imputar</div>}
                    {xs.length > 1 && <div className="text-[10px] text-[#8A7A5C]">{xs.length} compromisos</div>}
                  </div>
                );
              })}
            </div>

            <Lista titulo="Compromisos del mes" xs={m.enMes} vacio="No hay compromisos con fecha en este mes." />
            {m.vencidos.length > 0 && <Lista titulo={`Vencidos de meses anteriores (siguen pendientes) · ${formatoPesos(m.vencido)}`} xs={m.vencidos} vacio="" />}
            <Lista titulo="Obligaciones sin fecha" xs={m.sinFecha} vacio="Todas las obligaciones tienen fecha."
              nota="Cargá su vencimiento o una fecha estimada de pago con “Fechas” para ubicarlas en el calendario." />

            {posiciones.length > 0 && (
              <section>
                <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide mb-1">Anticipos y diferencias por imputar</p>
                <p className="text-xs text-[#8A7A5C] mb-1">El pendiente de cada factura no se descuenta solo: los pagos disponibles y los cheques sin imputar se imputan a mano en Pagos de facturas.</p>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm bg-white border border-[#E4DCC8] rounded">
                    <thead><tr className="text-xs text-[#8A7A5C] text-left">
                      <th className="px-2 py-1">Proveedor</th><th className="px-2 py-1 text-right">Facturas pendientes</th><th className="px-2 py-1 text-right">Pagos disponibles para imputar</th>
                      <th className="px-2 py-1 text-right">Cheques sin imputar</th><th className="px-2 py-1 text-right">Otros sin factura</th>
                      <th className="px-2 py-1 text-right">Saldo cuenta corriente</th><th className="px-2 py-1 text-right">Necesidad neta</th><th className="px-2 py-1" />
                    </tr></thead>
                    <tbody>
                      {posiciones.map((p) => (
                        <tr key={p.supplier_id} className="border-t border-[#E4DCC8]">
                          <td className="px-2 py-1 font-semibold">{p.nombre || 'Proveedor'}</td>
                          <td className="px-2 py-1 text-right">{formatoPesos(p.facturasPendientes)}</td>
                          <td className="px-2 py-1 text-right text-green-800">{formatoPesos(p.pagosDisponibles)}</td>
                          <td className="px-2 py-1 text-right text-sky-900">{formatoPesos(p.chequesSinImputar)}</td>
                          <td className="px-2 py-1 text-right" title="Movimientos de la cuenta corriente sin una factura pendiente en el calendario (saldos iniciales, notas de crédito o débito)">{formatoPesos(p.otros)}</td>
                          <td className="px-2 py-1 text-right">{p.saldo < 0 ? `${formatoPesos(-p.saldo)} a favor` : formatoPesos(p.saldo)}</td>
                          <td className="px-2 py-1 text-right font-bold text-amber-900">{formatoPesos(p.necesidadNeta)}</td>
                          <td className="px-2 py-1 text-right">
                            {(p.pagosDisponibles > 0 || p.chequesSinImputar > 0) && onImputar
                              && <button type="button" onClick={onImputar} className="text-xs px-2 py-0.5 rounded border border-[#E4DCC8] hover:bg-stone-50 whitespace-nowrap">Imputar en Pagos de facturas</button>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-[11px] text-gray-500 mt-1">Facturas pendientes = saldo + pagos disponibles + cheques sin imputar + otros. Necesidad neta = deuda (si hay) + cheques y eCheqs a debitar, imputados o no.</p>
              </section>
            )}

            <section>
              <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide mb-1">Debitados en el mes (pagos reales)</p>
              {(debitados.data ?? []).length === 0 ? <p className="text-sm text-[#8A7A5C]">Sin débitos de cheques propios este mes.</p> : (
                <ul className="space-y-1">
                  {(debitados.data ?? []).map((d) => (
                    <li key={d.id} className="bg-white border border-[#E4DCC8] rounded px-2 py-1.5 flex flex-wrap items-center gap-2 text-sm">
                      <span className="whitespace-nowrap">{formatearFechaLocal(d.debited_date)}</span>
                      <span className="font-semibold">{d.instrument_type === 'ECHEQ' ? 'eCheq' : 'Cheque'} {d.cheque_number}</span>
                      {d.maturity_date && <span className="text-[#8A7A5C]">vencía {formatearFechaLocal(d.maturity_date)}</span>}
                      <span className="flex-1" />
                      <span className="font-bold text-green-800">{formatoPesos(d.amount)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      {debitar && (
        <AccionModal action="debit" onClose={() => setDebitar(null)}
          inst={{ id: debitar.item_id, direction: 'ISSUED', instrument_type: debitar.item_kind === 'ECHEQ' ? 'ECHEQ' : 'CHEQUE', cheque_number: debitar.document_number, amount: debitar.amount }} />
      )}
      {fechas && fechas.purchase_id && fechas.purchase_root_id && (
        <FechasPagoModal purchaseId={fechas.purchase_id} rootId={fechas.purchase_root_id}
          titulo={fechas.item_kind === 'FACTURA' ? `Factura ${fechas.document_number ?? ''} · ${fechas.supplier_name ?? ''}` : (fechas.concept ?? 'Gasto a pagar')}
          due={fechas.due_date} planned={fechas.planned_date} onClose={() => setFechas(null)} />
      )}
    </div>
  );
}
