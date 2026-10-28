import { useState } from 'react';
import { errorMessage } from '../../target/messages';
import type { ScheduledPaymentRow } from '../../target/invoicePayments';
import { formatearFechaLocal, getTodayDate } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';
import { AccionModal, TIPO } from './Cheques';
import { Comprobantes } from './Comprobantes';
import { useDocumentLinks, useMaturities } from './useInvoicePayments';
import { usePayables } from './GastosAPagar';

const DIAS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

/**
 * Vencimientos (ADR-025 stage 4, 0104): the monthly calendar of own cheques / eCheqs still to be debited (SCHEDULED, by
 * maturity) and, apart, the ones already debited in the month (REAL, by effective date). A scheduled payment never
 * counts as money spent: the bank moves only with "Marcar debitado".
 */
export function Vencimientos() {
  const hoy = getTodayDate();
  const [mes, setMes] = useState(hoy.slice(0, 7));
  const datos = useMaturities(mes);
  const programados = datos.data?.scheduled ?? [];
  const debitados = datos.data?.debited ?? [];
  const docs = useDocumentLinks('FINANCIAL_INSTRUMENT', programados.map((p) => p.instrument_id));
  const [debitar, setDebitar] = useState<ScheduledPaymentRow | null>(null);
  const gastos = usePayables(true);   // ADR-026: pending expenses with a due date in the month (projected, never a real payment)

  const [y, m] = mes.split('-').map(Number);
  const diasMes = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const offset = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;   // Monday first
  const porDia = new Map<number, ScheduledPaymentRow[]>();
  for (const p of programados) { const d = Number(p.maturity_date.slice(8, 10)); porDia.set(d, [...(porDia.get(d) ?? []), p]); }
  const total = (xs: { amount: number }[]) => xs.reduce((s, x) => s + x.amount, 0);
  const aPagar = (gastos.data ?? []).filter((g) => g.due_date && g.due_date.slice(0, 7) === mes);
  const sinFecha = (gastos.data ?? []).filter((g) => !g.due_date);
  const mover = (delta: number) => { const d = new Date(Date.UTC(y, m - 1 + delta, 1)); setMes(d.toISOString().slice(0, 7)); };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => mover(-1)} className="px-2 py-1 rounded border border-[#E4DCC8] bg-white text-sm">‹</button>
        <input type="month" value={mes} onChange={(e) => e.target.value && setMes(e.target.value)} className="border border-[#E4DCC8] rounded-lg px-2 py-1 text-sm bg-white" />
        <button type="button" onClick={() => mover(1)} className="px-2 py-1 rounded border border-[#E4DCC8] bg-white text-sm">›</button>
        <span className="flex-1" />
        <span className="text-sm">Programado: <b className="text-amber-900">{formatoPesos(total(programados))}</b></span>
        <span className="text-sm">Gastos a pagar: <b className="text-amber-900">{formatoPesos(aPagar.reduce((s, g) => s + g.pending, 0))}</b></span>
        <span className="text-sm">Debitado: <b className="text-green-800">{formatoPesos(total(debitados))}</b></span>
      </div>
      {datos.isLoading ? <p className="text-sm text-gray-500">Cargando vencimientos...</p>
        : datos.error ? <p className="text-sm text-red-700">{errorMessage(datos.error)}</p> : (
          <>
            <div className="grid grid-cols-7 gap-1 text-xs" aria-label="Calendario de vencimientos">
              {DIAS.map((d) => <div key={d} className="text-center font-semibold text-[#8A7A5C]">{d}</div>)}
              {Array.from({ length: offset }, (_, i) => <div key={`v${i}`} />)}
              {Array.from({ length: diasMes }, (_, i) => {
                const dia = i + 1;
                const xs = porDia.get(dia) ?? [];
                const fecha = `${mes}-${String(dia).padStart(2, '0')}`;
                const vencido = xs.length > 0 && fecha < hoy;
                return (
                  <div key={dia} className={`min-h-14 rounded border p-1 ${fecha === hoy ? 'border-[#A8552E]' : 'border-[#E4DCC8]'} ${xs.length ? (vencido ? 'bg-red-50' : 'bg-amber-50') : 'bg-white'}`}>
                    <div className="text-[#8A7A5C]">{dia}</div>
                    {xs.length > 0 && <div className={`font-semibold ${vencido ? 'text-red-700' : 'text-amber-900'}`}>{formatoPesos(total(xs))}</div>}
                    {xs.length > 1 && <div className="text-[10px] text-[#8A7A5C]">{xs.length} cheques</div>}
                  </div>
                );
              })}
            </div>

            <section>
              <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide mb-1">Programados (a debitar)</p>
              {programados.length === 0 ? <p className="text-sm text-[#8A7A5C]">No hay cheques que venzan este mes.</p> : (
                <ul className="space-y-1">
                  {programados.map((p) => (
                    <li key={p.instrument_id} className={`bg-white border rounded px-2 py-1.5 flex flex-wrap items-center gap-2 text-sm ${p.maturity_date < hoy ? 'border-red-300' : 'border-[#E4DCC8]'}`}>
                      <span className="whitespace-nowrap">{formatearFechaLocal(p.maturity_date)}</span>
                      <span className="font-semibold">{TIPO[p.instrument_type]} {p.cheque_number}</span>
                      <span className="text-[#8A7A5C]">{p.supplier_name}{p.supplier_invoice_number ? ` · Factura ${p.supplier_invoice_number}` : ''} · {p.bank_account_name}</span>
                      {p.maturity_date < hoy && <span className="text-xs px-2 py-0.5 rounded bg-red-100 text-red-800">Vencido sin debitar</span>}
                      <Comprobantes docs={docs.data?.get(p.instrument_id)} compacto />
                      <span className="flex-1" />
                      <span className="font-bold">{formatoPesos(p.amount)}</span>
                      <button type="button" onClick={() => setDebitar(p)} className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-900 hover:bg-amber-200">Marcar debitado</button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide mb-1">Gastos a pagar que vencen este mes (proyectado)</p>
              {aPagar.length === 0 ? <p className="text-sm text-[#8A7A5C]">No hay gastos a pagar con vencimiento este mes.</p> : (
                <ul className="space-y-1">
                  {aPagar.map((g) => (
                    <li key={g.payable_id} className={`bg-white border rounded px-2 py-1.5 flex flex-wrap items-center gap-2 text-sm ${g.due_date! < hoy ? 'border-red-300' : 'border-[#E4DCC8]'}`}>
                      <span className="whitespace-nowrap">{formatearFechaLocal(g.due_date!)}</span>
                      <span className="font-semibold">{g.concept ?? g.category_name}</span>
                      <span className="text-[#8A7A5C]">{g.category_name}{g.counterparty_name ? ` · ${g.counterparty_name}` : ''}</span>
                      {g.due_date! < hoy && <span className="text-xs px-2 py-0.5 rounded bg-red-100 text-red-800">Vencido</span>}
                      <span className="flex-1" />
                      <span className="font-bold">{formatoPesos(g.pending)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {sinFecha.length > 0 && <p className="text-xs text-[#8A7A5C] mt-1">{sinFecha.length} gasto(s) a pagar sin vencimiento: {formatoPesos(sinFecha.reduce((s, g) => s + g.pending, 0))} (Caja → Cuentas a pagar).</p>}
            </section>

            <section>
              <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide mb-1">Debitados en el mes (pagos reales)</p>
              {debitados.length === 0 ? <p className="text-sm text-[#8A7A5C]">Sin débitos de cheques propios este mes.</p> : (
                <ul className="space-y-1">
                  {debitados.map((d) => (
                    <li key={d.id} className="bg-white border border-[#E4DCC8] rounded px-2 py-1.5 flex flex-wrap items-center gap-2 text-sm">
                      <span className="whitespace-nowrap">{formatearFechaLocal(d.debited_date)}</span>
                      <span className="font-semibold">{TIPO[d.instrument_type]} {d.cheque_number}</span>
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
          inst={{ id: debitar.instrument_id, direction: 'ISSUED', instrument_type: debitar.instrument_type, cheque_number: debitar.cheque_number, amount: debitar.amount }} />
      )}
    </div>
  );
}
