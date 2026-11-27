import { useRef, useState } from 'react';
import { ChevronDown, Trash2 } from 'lucide-react';
import { errorMessage } from '../../target/messages';
import {
  enTarjeta, esChequeFila, etiquetaFila, fechaFila, GRUPOS, grupoFila, totales, vencida,
  type ChequeInput, type PayableDueRow, type Tarjeta,
} from '../../target/paymentPlan';
import type { GastoItem } from '../../target/expenseHub';
import { formatearFechaLocal, getTodayDate } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';
import { repartirEnCuotas } from '../fiscal/cuotas';
import { useFinancialAccounts } from '../pedidos/useCommercial';
import { AccionModal } from './Cheques';
import { FechaPagoChequeModal } from './FechaPagoCheque';
import { DetalleGasto, ModalesGasto, useGastoItems, type Accion } from './Gastos';
import { campo, etiqueta, Modal } from './Modal';
import { usePayablesDue, usePaymentPlanMutations } from './usePaymentPlan';
import { useLedgerBalances } from './useTreasury';
import { useAnnulments } from './useExpenses';
import { Comprobantes } from './Comprobantes';
import { useComprobantesDeGastos } from './useInvoicePayments';
import { useSetPaymentDates } from './usePaymentCalendar';
import { usePlanPago } from './EditorPlanPago';
import { NumeroInput } from '../../components/NumeroInput';

const TARJETAS: { id: Tarjeta; label: string }[] = [
  { id: 'TOTAL', label: 'Total a pagar' }, { id: 'VENCIDO', label: 'Vencido' }, { id: 'PROX7', label: 'Próximos 7 días' },
  { id: 'PROX30', label: 'Próximos 30 días' }, { id: 'SIN_FECHA', label: 'Sin fecha' },
];
const fecha = (s: string | null) => (s ? formatearFechaLocal(s).slice(0, 5) : '—');
const btnPrimario = 'text-sm px-3 py-1.5 rounded-lg bg-amber-600 text-white hover:bg-amber-700';
const nueva = (p: string) => `${p}-${crypto.randomUUID()}`;
/** The expense of a row, in the shared expense list (invoice or pending expense, by its chain root). */
const gastoDe = (todos: GastoItem[], root: string | null) => (root ? todos.find((g) => (g.kind === 'FACTURA' && g.factura.purchase_root_id === root)
  || (g.kind === 'A_PAGAR' && g.gasto.purchase_root_id === root)) ?? null : null);

/**
 * Caja → Cuentas a pagar → Pendientes (0121, caja-mejoras-v2, owner-approved prototype on real data): ONE list of every open due item
 * (fin_payables_due) — plan instalments, obligations without plan, own cheques / eCheqs to be debited — grouped Vencidos / Esta semana /
 * Este mes / Más adelante / Sin fecha; five cards that filter; supplier and type filters (a supplier shows its debt, cheques and credit).
 * Each row opens its expense (the shared DetalleGasto: data, receipts, Editar / Rectificar with the existing locks, history) and its plan.
 * Pagar pays THAT item (cash / transfer, or own cheques / eCheqs when it has a supplier); "Cambiar forma de pago" replans what is open.
 * Every figure is the backend's; every action is its RPC with one idempotency key per opened form.
 */
export function PendientesPagar({ onProveedores, onCheques, onAnulados }: { onProveedores?: () => void; onCheques?: () => void; onAnulados?: () => void } = {}) {
  const anulados = useAnnulments();
  const hoy = getTodayDate();
  const due = usePayablesDue();
  const gastos = useGastoItems();
  const saldos = useLedgerBalances('SUPPLIER');
  const [tarjeta, setTarjeta] = useState<Tarjeta>('TOTAL');
  const [prov, setProv] = useState('TODOS');
  const [tipo, setTipo] = useState('TODOS');
  const [abierto, setAbierto] = useState<string | null>(null);
  const [pagando, setPagando] = useState<PayableDueRow | null>(null);
  const [plan, setPlan] = useState<PayableDueRow | null>(null);
  const [accion, setAccion] = useState<Accion | null>(null);
  const [debitar, setDebitar] = useState<PayableDueRow | null>(null);
  const [fechaCheque, setFechaCheque] = useState<PayableDueRow | null>(null);
  // owner 2026-11-27: each row's receipt (purchase files, their root's and the fiscal document's), to see the invoice from the list
  const comprobantes = useComprobantesDeGastos((due.data ?? []).flatMap((r) => (r.purchase_id && r.purchase_root_id ? [{ purchase_id: r.purchase_id, purchase_root_id: r.purchase_root_id }] : [])));

  if (due.isLoading) return <p className="text-sm text-gray-500">Cargando pendientes...</p>;
  if (due.error) return <p className="text-sm text-red-700">{errorMessage(due.error)}</p>;
  const todas = due.data ?? [];
  const proveedores = [...new Map(todas.filter((r) => r.supplier_id).map((r) => [r.supplier_id!, r.supplier_name ?? '—'])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const filtradas = todas.filter((r) => {
    if (prov !== 'TODOS' && (r.supplier_id ?? '') !== prov) return false;
    if (tipo === 'CUOTA' && r.row_kind !== 'CUOTA') return false;
    if (tipo === 'CHEQUE' && !esChequeFila(r)) return false;
    if (tipo === 'PAGO' && !(r.row_kind === 'PAGO' || r.row_kind === 'DIFERENCIA')) return false;
    return true;
  });
  const t = totales(filtradas, hoy);
  const lista = filtradas.filter((r) => enTarjeta(r, tarjeta, hoy)).sort((a, b) => (fechaFila(a) ?? '9999').localeCompare(fechaFila(b) ?? '9999'));
  const filtroActivo = prov !== 'TODOS' || tipo !== 'TODOS' || tarjeta !== 'TOTAL';
  const deProv = prov !== 'TODOS' && prov !== '' ? filtradas : [];
  const saldoProv = (saldos.data ?? []).find((s) => s.entity_id === prov)?.balance ?? 0;
  const titulo = (r: PayableDueRow) => (r.supplier_id ? r.supplier_name ?? '—' : r.concept ?? r.supplier_name ?? 'Gasto');
  const docsDe = (r: PayableDueRow) => { const d = r.purchase_root_id ? comprobantes.data?.get(r.purchase_root_id)?.docs : undefined; return d && d.length > 0 ? d : undefined; };
  const subtitulo = (r: PayableDueRow) => [r.supplier_id ? r.concept : (r.supplier_name ? `Sin proveedor · ${r.supplier_name}` : 'Sin proveedor'), etiquetaFila(r)].filter(Boolean).join(' · ');

  return (
    <div className="space-y-3">
      <div className={`grid grid-cols-2 ${onProveedores ? 'sm:grid-cols-4 lg:grid-cols-8' : 'sm:grid-cols-5'} gap-2`} role="group" aria-label="Totales (tocá una tarjeta para filtrar)">
        {TARJETAS.map((x) => {
          const activa = tarjeta === x.id;
          const rojo = x.id === 'VENCIDO' && t.VENCIDO > 0;
          return (
            <button key={x.id} type="button" onClick={() => setTarjeta(activa && x.id !== 'TOTAL' ? 'TOTAL' : x.id)} aria-pressed={activa}
              className={`text-left rounded-lg border px-3 py-2 ${activa ? 'border-[#A8552E] ring-1 ring-[#A8552E] bg-amber-50' : 'bg-white border-[#E4DCC8] hover:border-[#A8552E]'}`}>
              <p className={`text-xs ${rojo ? 'text-red-700' : 'text-[#8A7A5C]'}`}>{x.label}</p>
              <p className={`font-bold ${rojo ? 'text-red-700' : 'text-[#2C2419]'}`}>{formatoPesos(t[x.id])}</p>
            </button>
          );
        })}
        {/* owner 2026-11-24: the supplier accounts (debt, advances, ficha) open from here (was «Ver también») */}
        {onProveedores && (
          <button type="button" onClick={onProveedores} title="Deuda, anticipos y ficha de cada proveedor"
            className="text-left rounded-lg border px-3 py-2 bg-white border-[#E4DCC8] hover:border-[#A8552E]">
            <p className="text-xs text-[#8A7A5C]">Proveedores</p>
            <p className="font-bold text-[#A8552E]">Ver cuentas ›</p>
          </button>
        )}
        {onCheques && (
          <button type="button" onClick={onCheques} title="Cheques y eCheqs propios: anular, rechazar, reemplazar"
            className="text-left rounded-lg border px-3 py-2 bg-white border-[#E4DCC8] hover:border-[#A8552E]">
            <p className="text-xs text-[#8A7A5C]">Cheques emitidos</p>
            <p className="font-bold text-[#A8552E]">Ver cheques ›</p>
          </button>
        )}
        {/* owner 2026-11-25: the annulled expenses as a card (was a folded list at the bottom) */}
        {onAnulados && (
          <button type="button" onClick={onAnulados} title="Gastos anulados: tachados, con quién, cuándo y por qué"
            className="text-left rounded-lg border px-3 py-2 bg-white border-[#E4DCC8] hover:border-[#A8552E]">
            <p className="text-xs text-[#8A7A5C]">Anulados{anulados.data ? ` · ${anulados.data.length}` : ''}</p>
            <p className="font-bold text-[#A8552E]">Ver anulados ›</p>
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <select value={prov} onChange={(e) => setProv(e.target.value)} className="border border-[#E4DCC8] rounded-lg px-2 py-1 bg-white" aria-label="Proveedor">
          <option value="TODOS">Todos los proveedores</option>
          {proveedores.map(([id, nombre]) => <option key={id} value={id}>{nombre}</option>)}
          <option value="">Sin proveedor</option>
        </select>
        <select value={tipo} onChange={(e) => setTipo(e.target.value)} className="border border-[#E4DCC8] rounded-lg px-2 py-1 bg-white" aria-label="Tipo">
          <option value="TODOS">Todos los tipos</option><option value="PAGO">Pago único</option><option value="CUOTA">Cuotas</option><option value="CHEQUE">Cheques y eCheqs</option>
        </select>
        {filtroActivo && <button type="button" onClick={() => { setProv('TODOS'); setTipo('TODOS'); setTarjeta('TOTAL'); }} className="text-[#A8552E] hover:underline">Limpiar filtros</button>}
      </div>
      {prov !== 'TODOS' && prov !== '' && (
        <p className="text-sm text-[#6B5D45] bg-white border border-[#E4DCC8] rounded-lg px-3 py-2">
          <b>{proveedores.find(([id]) => id === prov)?.[1]}</b>: deuda {formatoPesos(deProv.filter((r) => !esChequeFila(r)).reduce((x, r) => x + r.amount, 0))}
          {' · '}cheques a debitar {formatoPesos(deProv.filter(esChequeFila).reduce((x, r) => x + r.amount, 0))}
          {saldoProv < 0 && <span className="text-green-700"> · a favor {formatoPesos(-saldoProv)}</span>}
        </p>
      )}

      {lista.length === 0 && <p className="text-sm text-[#8A7A5C]">No hay pagos pendientes{filtroActivo ? ' con estos filtros' : ''}.</p>}
      {GRUPOS.map((gr) => {
        const filas = lista.filter((r) => grupoFila(r, hoy) === gr.id);
        if (filas.length === 0) return null;
        const rojo = gr.id === 'VENCIDO';
        return (
          <section key={gr.id} aria-label={gr.label}>
            <div className="flex items-baseline justify-between mb-1">
              <h3 className={`text-xs font-semibold uppercase tracking-wide ${rojo ? 'text-red-700' : 'text-[#8A6A2E]'}`}>{gr.label} · {filas.length}</h3>
              <span className={`text-sm font-semibold ${rojo ? 'text-red-700' : 'text-[#2C2419]'}`}>{formatoPesos(filas.reduce((x, r) => x + r.amount, 0))}</span>
            </div>
            <ul className="bg-white rounded-lg border border-[#E4DCC8] divide-y divide-[#F0EADC]">
              {filas.map((r) => {
                const open = abierto === r.row_key;
                const g = gastoDe(gastos.todos, r.purchase_root_id);
                const delGasto = todas.filter((x) => x.purchase_root_id && x.purchase_root_id === r.purchase_root_id);
                return (
                  <li key={r.row_key}>
                    <div className="px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                      <button type="button" onClick={() => setAbierto(open ? null : r.row_key)} aria-expanded={open} aria-label={open ? 'Cerrar' : 'Ver detalle'} className="shrink-0">
                        <ChevronDown className={`w-4 h-4 text-[#8A7A5C] transition ${open ? '' : '-rotate-90'}`} />
                      </button>
                      <FechaFila r={r} hoy={hoy} onPlan={() => setPlan(r)} onCheque={() => setFechaCheque(r)} />
                      <button type="button" onClick={() => setAbierto(open ? null : r.row_key)} className="min-w-0 flex-1 text-left">
                        <span className="block text-sm font-medium text-[#2C2419] truncate">{titulo(r)}</span>
                        <span className="block text-xs text-[#8A7A5C] truncate">{subtitulo(r)}</span>
                      </button>
                      {docsDe(r) && <Comprobantes docs={docsDe(r)} compacto />}
                      <span className="font-semibold tabular-nums text-[#2C2419]">{formatoPesos(r.amount)}</span>
                      {esChequeFila(r) ? <span className="text-xs text-sky-800 w-20 text-right">a debitar</span>
                        : r.row_kind === 'DIFERENCIA' ? <button type="button" onClick={() => setPlan(r)} className={btnPrimario}>Ajustar plan</button>
                          : <button type="button" onClick={() => setPagando(r)} className={btnPrimario}>Pagar</button>}
                    </div>
                    {open && (
                      <div className="bg-[#FAF6EE] border-t border-[#F0EADC]">
                        {esChequeFila(r) ? (
                          <div className="px-4 py-2 flex flex-wrap gap-2 text-xs">
                            <span className="text-[#6B5D45]">{r.link_status === 'IMPUTADO' ? `Imputado a factura ${r.document_number ?? ''}` : 'Sin imputar: la factura no está determinada'}</span>
                            <button type="button" onClick={() => setFechaCheque(r)} className="px-2 py-0.5 rounded border border-[#E4DCC8] bg-white hover:bg-stone-50">Fecha de pago</button>
                            <button type="button" onClick={() => setDebitar(r)} className="px-2 py-0.5 rounded bg-amber-100 text-amber-900 hover:bg-amber-200">Marcar debitado</button>
                          </div>
                        ) : (
                          <div className="px-4 pt-2 text-xs space-y-1">
                            <div className="flex items-center justify-between">
                              <p className="font-semibold uppercase tracking-wide text-[#8A6A2E]">Vencimientos pendientes</p>
                              <button type="button" onClick={() => setPlan(r)} className="text-[#A8552E] hover:underline">Cambiar forma de pago (cuotas…)</button>
                            </div>
                            <ul className="space-y-0.5">
                              {delGasto.sort((a, b) => (fechaFila(a) ?? '9999').localeCompare(fechaFila(b) ?? '9999')).map((x) => (
                                <li key={x.row_key} className="flex gap-3">
                                  <span className={`w-12 tabular-nums ${vencida(x, hoy) ? 'text-red-700' : 'text-[#6B5D45]'}`}>{fecha(fechaFila(x))}</span>
                                  <span className="flex-1 text-[#2C2419]">{etiquetaFila(x)}</span>
                                  <span className="tabular-nums">{formatoPesos(x.amount)}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {g && <DetalleGasto it={g} docs={docsDe(r)} onAccion={setAccion} />}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}


      {pagando && <PagarModal r={pagando} g={gastoDe(gastos.todos, pagando.purchase_root_id)} onClose={() => setPagando(null)} />}
      {plan && <PlanModal r={plan} abierto={todas.filter((x) => x.purchase_root_id === plan.purchase_root_id && !esChequeFila(x)).reduce((s, x) => s + x.amount, 0)}
        conPlan={todas.some((x) => x.purchase_root_id === plan.purchase_root_id && (x.item_id !== null || x.row_kind === 'DIFERENCIA'))}
        actuales={todas.filter((x) => x.purchase_root_id === plan.purchase_root_id && x.item_id !== null).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))}
        onClose={() => setPlan(null)} />}
      <ModalesGasto accion={accion} onClose={() => setAccion(null)} />
      {debitar && <AccionModal action="debit" onClose={() => setDebitar(null)}
        inst={{ id: debitar.instrument_id!, direction: 'ISSUED', instrument_type: debitar.row_kind === 'ECHEQ' ? 'ECHEQ' : 'CHEQUE', cheque_number: debitar.cheque_number ?? '', amount: debitar.amount }} />}
      {fechaCheque && <FechaPagoChequeModal onClose={() => setFechaCheque(null)} cheque={{ id: fechaCheque.instrument_id!, tipo: fechaCheque.row_kind === 'ECHEQ' ? 'eCheq' : 'Cheque',
        numero: fechaCheque.cheque_number, amount: fechaCheque.amount, maturity_date: fechaCheque.due_date, destinatario: fechaCheque.supplier_name }} />}
    </div>
  );
}

// ── pay ONE item ────────────────────────────────────────────────────────────
interface ChequeForm { tipo: 'CHEQUE' | 'ECHEQ'; numero: string; fecha: string; importe: string; cuenta: string }
function PagarModal({ r, g, onClose }: { r: PayableDueRow; g: GastoItem | null; onClose: () => void }) {
  const m = usePaymentPlanMutations();
  const cuentas = useFinancialAccounts();
  const hoy = getTodayDate();
  const [clave] = useState(() => nueva('PAGAR'));
  const [monto, setMonto] = useState(String(r.amount));
  const [medio, setMedio] = useState<'TRANSFER' | 'CASH' | 'CHEQUE'>('TRANSFER');
  const [cuenta, setCuenta] = useState('');
  const [fechaPago, setFechaPago] = useState(hoy);
  const bancos = (cuentas.data ?? []).filter((c) => c.activo && c.account_type === 'BANK_ACCOUNT');
  const [cheques, setCheques] = useState<ChequeForm[]>([{ tipo: 'ECHEQ', numero: '', fecha: '', importe: String(r.amount), cuenta: '' }]);
  const conProveedor = !!r.supplier_id && r.obligation_kind === 'FACTURA';
  const admitidas = (cuentas.data ?? []).filter((c) => c.activo && (medio === 'CASH' ? c.account_type === 'CASH' : c.account_type === 'BANK_ACCOUNT'));
  const n = Number(monto);
  const sumaCheques = cheques.reduce((s, c) => s + (Number(c.importe) || 0), 0);
  const chequesOk = cheques.every((c) => c.numero.trim() && c.fecha && Number(c.importe) > 0 && (c.cuenta || bancos[0]));
  const puede = medio === 'CHEQUE' ? conProveedor && chequesOk && sumaCheques > 0 && sumaCheques <= r.amount + 0.005
    : n > 0 && n <= r.amount + 0.005 && !!(cuenta || admitidas[0]) && !!fechaPago;
  const pendiente = Object.values(m).some((x) => x.isPending);
  const error = Object.values(m).find((x) => x.error)?.error;
  const setCheque = (i: number, k: keyof ChequeForm, v: string) => setCheques(cheques.map((c, j) => (j === i ? { ...c, [k]: v } : c)));

  const guardar = async () => {
    if (medio === 'CHEQUE') {
      const instruments: ChequeInput[] = cheques.map((c) => ({ instrument_type: c.tipo, cheque_number: c.numero.trim(), amount: Number(c.importe),
        maturity_date: c.fecha, issued_date: hoy, bank_account_id: c.cuenta || bancos[0].id }));
      if (r.item_id !== null) await m.chequesItem.mutateAsync({ itemId: r.item_id, instruments, idempotencyKey: clave });
      else await m.chequesObligation.mutateAsync({ purchaseId: r.purchase_id!, instruments, idempotencyKey: clave });
    } else {
      const accountId = cuenta || admitidas[0].id;
      if (r.item_id !== null) await m.payItem.mutateAsync({ itemId: r.item_id, amount: n, date: fechaPago, method: medio, accountId, idempotencyKey: clave });
      else if (r.obligation_kind === 'GASTO' && g?.kind === 'A_PAGAR') await m.payPending.mutateAsync({ payableId: g.gasto.payable_id, amount: n, effectiveDate: fechaPago, accountId, method: medio, idempotencyKey: clave });
      else await m.payInvoice.mutateAsync({ rootId: r.purchase_root_id!, amount: n, date: fechaPago, method: medio, accountId, idempotencyKey: clave, reference: '' });
    }
    onClose();
  };

  return (
    <Modal titulo={`Pagar · ${etiquetaFila(r)}`} onClose={onClose} onSubmit={() => { guardar().catch(() => {}); }} puedeGuardar={puede} guardando={pendiente} error={error}
      textoGuardar={medio === 'CHEQUE' ? 'Emitir y registrar' : 'Registrar pago'}>
      <p className="text-sm text-[#6B5D45]">{r.supplier_name ?? r.concept ?? 'Gasto'} · pendiente {formatoPesos(r.amount)}</p>
      <label className={etiqueta}>Forma de pago
        <select value={medio} onChange={(e) => { setMedio(e.target.value as typeof medio); setCuenta(''); }} className={campo}>
          <option value="TRANSFER">Transferencia</option><option value="CASH">Efectivo</option>
          {conProveedor && <option value="CHEQUE">Emitir cheque / eCheq</option>}
        </select>
      </label>
      {!conProveedor && <p className="text-xs text-[#8A7A5C]">Sin proveedor registrado: para pagarlo con cheque o eCheq, primero vinculalo a un proveedor (desde el detalle).</p>}
      {medio !== 'CHEQUE' ? (
        <>
          <label className={etiqueta}>Importe<NumeroInput min="0" step="0.01" value={monto} onChange={(e) => setMonto(e.target.value)} className={campo} /></label>
          {n > 0 && n < r.amount && <p className="text-xs text-[#8A7A5C]">Pago parcial: en este vencimiento quedan {formatoPesos(r.amount - n)}.</p>}
          {n > r.amount + 0.005 && <p className="text-xs text-red-700">No puede superar lo pendiente de este vencimiento.</p>}
          <div className="grid grid-cols-2 gap-2">
            <label className={etiqueta}>Cuenta
              <select value={cuenta || admitidas[0]?.id || ''} onChange={(e) => setCuenta(e.target.value)} className={campo}>{admitidas.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}</select>
            </label>
            <label className={etiqueta}>Fecha de pago<input type="date" value={fechaPago} onChange={(e) => setFechaPago(e.target.value)} className={campo} /></label>
          </div>
        </>
      ) : (
        <div className="space-y-2">
          {cheques.map((c, i) => (
            <div key={i} className="grid grid-cols-6 gap-1 text-sm items-center">
              <select value={c.tipo} onChange={(e) => setCheque(i, 'tipo', e.target.value)} className="col-span-2 border border-gray-300 rounded px-1 py-1" aria-label="Tipo"><option value="ECHEQ">eCheq</option><option value="CHEQUE">Cheque</option></select>
              <input value={c.numero} onChange={(e) => setCheque(i, 'numero', e.target.value)} placeholder="Número" className="col-span-2 border border-gray-300 rounded px-2 py-1" />
              <select value={c.cuenta || bancos[0]?.id || ''} onChange={(e) => setCheque(i, 'cuenta', e.target.value)} className="col-span-2 border border-gray-300 rounded px-1 py-1" aria-label="Cuenta">{bancos.map((b) => <option key={b.id} value={b.id}>{b.nombre}</option>)}</select>
              <input type="date" value={c.fecha} onChange={(e) => setCheque(i, 'fecha', e.target.value)} className="col-span-3 border border-gray-300 rounded px-2 py-1" aria-label="Fecha de pago" />
              <NumeroInput step="0.01" value={c.importe} onChange={(e) => setCheque(i, 'importe', e.target.value)} placeholder="Importe" className="col-span-2 border border-gray-300 rounded px-2 py-1 text-right" />
              <button type="button" onClick={() => setCheques(cheques.filter((_, j) => j !== i))} disabled={cheques.length === 1} className="text-gray-400 hover:text-red-600 disabled:opacity-30 justify-self-center" aria-label="Quitar cheque"><Trash2 className="w-4 h-4" /></button>
            </div>
          ))}
          <div className="flex flex-wrap gap-4">
            <button type="button" onClick={() => setCheques([...cheques, { ...cheques[cheques.length - 1], numero: '', fecha: '', importe: '' }])} className="text-sm text-[#A8552E] hover:underline">+ Agregar otro cheque</button>
            {cheques.length > 1 && <button type="button" onClick={() => { const p = repartirEnCuotas(r.amount, cheques.length); setCheques(cheques.map((c, i) => ({ ...c, importe: p[i].toFixed(2) }))); }} className="text-sm text-[#A8552E] hover:underline">Repartir {formatoPesos(r.amount)} en los {cheques.length} cheques</button>}
          </div>
          <p className={`text-xs ${sumaCheques <= r.amount + 0.005 ? 'text-[#8A7A5C]' : 'text-red-700'}`}>Cheques {formatoPesos(sumaCheques)} de {formatoPesos(r.amount)} pendientes. Salen del banco en su fecha.</p>
        </div>
      )}
    </Modal>
  );
}

/**
 * Owner 2026-11-27: the date of a row, edited right there. A payment without plan: its ESTIMATED payment date (set_payment_date PLANNED,
 * internal, no reason; it places it in the Calendario; the contractual due date is changed in «Fechas»). An instalment: its plan
 * (Cambiar forma de pago). An own cheque: its payment date form.
 */
function FechaFila({ r, hoy, onPlan, onCheque }: { r: PayableDueRow; hoy: string; onPlan: () => void; onCheque: () => void }) {
  const [editando, setEditando] = useState(false);
  const fechas = useSetPaymentDates();
  const hecho = useRef(false);
  const txt = fecha(fechaFila(r));
  const tono = vencida(r, hoy) ? 'text-red-700 font-semibold' : 'text-[#6B5D45]';
  const sinPlan = r.row_key.startsWith('OB:') && r.purchase_id !== null;
  if (sinPlan && editando) {
    const guardar = (v: string) => {
      if (hecho.current) return;
      hecho.current = true;
      if (v === (r.planned_date ?? '')) { setEditando(false); return; }
      fechas.mutate({ purchaseId: r.purchase_id!, changes: [{ kind: 'PLANNED', date: v || null }], reason: '' },
        { onSettled: () => setEditando(false), onError: () => { hecho.current = false; } });
    };
    return (
      <span className="shrink-0">
        <input type="date" defaultValue={r.planned_date ?? ''} autoFocus aria-label="Fecha estimada de pago" disabled={fechas.isPending}
          className="w-36 border border-amber-500 rounded px-1 py-0.5 text-sm" onBlur={(e) => guardar(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { hecho.current = true; setEditando(false); } }} />
        {fechas.error ? <span className="block text-[11px] text-red-700">{errorMessage(fechas.error)}</span> : null}
      </span>
    );
  }
  const accion = sinPlan ? () => { hecho.current = false; setEditando(true); } : esChequeFila(r) ? onCheque : r.item_id !== null ? onPlan : null;
  const ayuda = sinPlan ? 'Fecha estimada de pago: tocá para cargarla o cambiarla (la ubica en el Calendario)'
    : esChequeFila(r) ? 'Fecha de pago del cheque' : r.item_id !== null ? 'Fecha de la cuota: se cambia en Cambiar forma de pago' : undefined;
  return accion
    ? <button type="button" onClick={accion} title={ayuda} className={`w-12 shrink-0 text-left text-sm tabular-nums underline decoration-dotted underline-offset-2 hover:text-[#A8552E] ${tono}`}>{txt}</button>
    : <span className={`w-12 shrink-0 text-sm tabular-nums ${tono}`}>{txt}</span>;
}

// ── change the payment form (plan) over what is open ────────────────────────
function PlanModal({ r, abierto, conPlan, actuales, onClose }: { r: PayableDueRow; abierto: number; conPlan: boolean; actuales: PayableDueRow[]; onClose: () => void }) {
  const m = usePaymentPlanMutations();
  const [clave] = useState(() => nueva('PLAN'));
  const [motivo, setMotivo] = useState('');
  const total = Math.round(abierto * 100) / 100;
  // owner 2026-11-27: it opens with the open instalments of the plan in force (what is left of each), to change only one of them
  const plan = usePlanPago(total, { cheques: 'NO', inicial: actuales.map((x) => ({ due_date: x.due_date, amount: x.amount })) });   // cheques: «Pagar» on each due item
  const items = plan.forma === 'UNICO' && plan.items.length === 0 ? [{ due_date: null, amount: total }] : plan.items;
  const puede = plan.valido && items.length > 0 && (!conPlan || motivo.trim() !== '');
  return (
    <Modal titulo="Cambiar forma de pago" onClose={onClose} guardando={m.plan.isPending} error={m.plan.error} puedeGuardar={puede}
      onSubmit={() => { m.plan.mutateAsync({ purchaseId: r.purchase_id!, items, idempotencyKey: clave, reason: motivo }).then(onClose).catch(() => {}); }}>
      <p className="text-sm text-[#6B5D45]">{r.supplier_name ?? r.concept ?? 'Gasto'}: se organizan los <b>{formatoPesos(total)}</b> que quedan por pagar. Lo ya pagado y los cheques emitidos no cambian.</p>
      {plan.editor}
      {conPlan && <label className={etiqueta}>Motivo del cambio<input value={motivo} onChange={(e) => setMotivo(e.target.value)} className={campo} placeholder="Ej.: el proveedor aceptó otro plan" /></label>}
      <p className="text-xs text-[#8A7A5C]">Para pagar con cheques o eCheqs usá «Pagar» en cada vencimiento.</p>
    </Modal>
  );
}

/** 0124: the annulled expenses, struck through, with who, when and why (nothing is deleted). Owner 2026-11-25: opened from its card. */
export function Anulados() {
  const q = useAnnulments();
  const xs = q.data ?? [];
  if (q.isLoading) return <p className="text-sm text-gray-500">Cargando anulados…</p>;
  if (xs.length === 0) return <p className="text-sm text-[#8A7A5C]">No hay gastos anulados.</p>;
  return (
    <section>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-[#8A7A5C]">Anulados · {xs.length}</h3>
      <ul className="mt-1 bg-white rounded-lg border border-[#E4DCC8] divide-y divide-[#F0EADC]">
        {xs.map((a) => (
          <li key={a.annulment_id} className="px-3 py-2 text-sm flex flex-wrap items-center gap-x-3 gap-y-0.5">
            <s className="flex-1 min-w-0 text-[#8A7A5C] truncate">{a.concept ?? 'Gasto'}{a.counterparty ? ` · ${a.counterparty}` : ''} · {fecha(a.economic_date)}</s>
            <s className="tabular-nums text-[#8A7A5C]">{formatoPesos(a.amount_total)}</s>
            <span className="w-full text-xs text-[#6B5D45]">Anulado el {formatearFechaLocal(a.annulled_date)} por {a.created_by_name ?? 'usuario'} — «{a.reason}»</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
