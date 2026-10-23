import { useState } from 'react';
import { normalizeDbError } from '../../target/db';
import { errorMessage } from '../../target/messages';
import type { PurchaseNatureValue } from '../../target/masters';
import { mandatoryPending } from '../../target/pendingClassification';
import {
  classifyReady, originText, PENDING_EXPENSE_ORIGIN_LABEL, PENDING_EXPENSE_PAGE, PENDING_EXPENSE_STATUS_LABEL, type PendingExpenseFilter,
  type PendingExpenseOrigin, type PendingExpenseRow, type PendingExpenseStatus, UNCLASSIFIED_BALANCE_NOTE, UNCLASSIFIED_MP_NOTE,
} from '../../target/unclassifiedExpenses';
import { NATURE_LABEL } from '../../target/expenseCategories';
import { formatearFechaLocal } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';
import { useFinancialAccounts } from '../pedidos/useCommercial';
import { campo, etiqueta, Modal } from './Modal';
import { Paginador } from './PendientesClasificar';
import { SelectorCategoria } from './SelectorCategoria';
import { usePendingSummary } from './useMpActivity';
import { useClassifyPendingExpense, usePendingExpenses, useProfileEmails, useUnclassifiedCount } from './useUnclassified';

const FILTRO = 'border border-[#E4DCC8] rounded-lg px-2 py-1 text-sm bg-white';
const ESTADOS: (PendingExpenseStatus | 'ALL')[] = ['SIN_CLASIFICAR', 'CLASIFICADO', 'ALL'];

/** ALREADY_CLASSIFIED is the Mercado Pago text in the shared catalogue; here it is a pending expense. */
const mensajeError = (e: unknown) => (normalizeDbError(e).code === 'ALREADY_CLASSIFIED'
  ? 'Ese gasto ya fue clasificado (otra persona o una pestaña anterior). Se actualizó la lista.' : errorMessage(e));

/**
 * Caja → Gastos sin clasificar (ADR-025, ERP 0102). Expenses ALREADY paid (the balance already dropped) whose category was
 * doubtful when they were confirmed — e.g. from WhatsApp "Registrar sin clasif". Classifying one only adds its purchase on
 * the same payment (classify_pending_expense): no new operation, posting or payment; the P&L moves it from "Gastos sin
 * clasificar" to its category. The Mercado Pago pending outflows keep their own list and routes (ADR-021): shown here as a
 * summary with a shortcut, never duplicated.
 */
export function GastosSinClasificar({ onVerPendientesMp }: { onVerPendientesMp: () => void }) {
  const [filtro, setFiltro] = useState<PendingExpenseFilter>({ status: 'SIN_CLASIFICAR', from: '', to: '', accountId: '', origin: '' });
  const [pagina, setPagina] = useState(0);
  const q = usePendingExpenses(filtro, pagina);
  const contador = useUnclassifiedCount();
  const mp = usePendingSummary();
  const cuentas = useFinancialAccounts();
  const emails = useProfileEmails();
  const [elegido, setElegido] = useState<PendingExpenseRow | null>(null);
  const cambiar = (p: Partial<PendingExpenseFilter>) => { setFiltro((f) => ({ ...f, ...p })); setPagina(0); };
  const filas = q.data?.rows ?? [];
  const total = q.data?.total ?? 0;
  const paginas = Math.max(1, Math.ceil(total / PENDING_EXPENSE_PAGE));
  const mpPend = mp.data ? mandatoryPending(mp.data) : null;
  const autor = (id: string | null) => (id ? emails.data?.get(id) ?? '—' : '—');

  return (
    <div className="space-y-4">
      <div className={`rounded-lg px-4 py-3 border ${contador.data ? 'bg-amber-50 border-amber-300' : 'bg-green-50 border-green-200'}`} role="status">
        <p className={`font-semibold ${contador.data ? 'text-amber-900' : 'text-green-900'}`}>
          {contador.isLoading ? 'Contando…' : contador.data ? `Gastos sin clasificar: ${contador.data}` : 'Todo clasificado'}
        </p>
        <p className="text-xs text-[#6B5D45] mt-0.5">{UNCLASSIFIED_BALANCE_NOTE}</p>
      </div>

      {mpPend && mpPend.count > 0 && (
        <div className="bg-white border border-[#E4DCC8] rounded-lg px-4 py-3 text-sm flex flex-wrap items-center justify-between gap-2" aria-label="Mercado Pago">
          <div>
            <p className="font-medium text-[#3D3424]">Mercado Pago: {mpPend.count} pendiente(s) · {formatoPesos(mpPend.outgoing)}</p>
            <p className="text-xs text-[#8A7A5C]">{UNCLASSIFIED_MP_NOTE}</p>
          </div>
          <button type="button" onClick={onVerPendientesMp} className="text-sm px-3 py-1 rounded-lg border border-[#A8552E] text-[#A8552E] hover:bg-amber-50">
            Ver pendientes de Mercado Pago
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-2" role="group" aria-label="Filtros">
        <label className="text-xs text-[#6B5D45]">Estado
          <select className={`${FILTRO} block`} value={filtro.status} onChange={(e) => cambiar({ status: e.target.value as PendingExpenseFilter['status'] })}>
            {ESTADOS.map((s) => <option key={s} value={s}>{s === 'ALL' ? 'Todos' : PENDING_EXPENSE_STATUS_LABEL[s]}</option>)}
          </select>
        </label>
        <label className="text-xs text-[#6B5D45]">Desde<input type="date" className={`${FILTRO} block`} value={filtro.from} onChange={(e) => cambiar({ from: e.target.value })} /></label>
        <label className="text-xs text-[#6B5D45]">Hasta<input type="date" className={`${FILTRO} block`} value={filtro.to} onChange={(e) => cambiar({ to: e.target.value })} /></label>
        <label className="text-xs text-[#6B5D45]">Cuenta
          <select className={`${FILTRO} block`} value={filtro.accountId} onChange={(e) => cambiar({ accountId: e.target.value })}>
            <option value="">Todas</option>
            {(cuentas.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
          </select>
        </label>
        <label className="text-xs text-[#6B5D45]">Origen
          <select className={`${FILTRO} block`} value={filtro.origin} onChange={(e) => cambiar({ origin: e.target.value as PendingExpenseOrigin | '' })}>
            <option value="">Todos</option>
            {(Object.keys(PENDING_EXPENSE_ORIGIN_LABEL) as PendingExpenseOrigin[]).map((o) => <option key={o} value={o}>{PENDING_EXPENSE_ORIGIN_LABEL[o]}</option>)}
          </select>
        </label>
      </div>

      {q.isLoading ? <p className="text-sm text-gray-500">Cargando…</p>
        : q.error ? <p className="text-sm text-red-700">{errorMessage(q.error)}</p>
          : total === 0 ? <p className="text-sm text-green-800">No hay gastos con esos filtros.</p> : (
            <>
              <div className="overflow-x-auto bg-white rounded-lg border border-[#E4DCC8]">
                <table className="w-full text-sm" aria-label="Gastos sin clasificar">
                  <thead><tr className="text-left text-xs text-[#8A7A5C] border-b border-[#E4DCC8]">
                    <th className="px-3 py-2">Fecha</th><th className="px-3 py-2 text-right">Importe</th><th className="px-3 py-2">Concepto</th>
                    <th className="px-3 py-2">Cuenta</th><th className="px-3 py-2">Origen</th><th className="px-3 py-2">Registró</th>
                    <th className="px-3 py-2">Estado</th><th className="px-3 py-2">Acción</th>
                  </tr></thead>
                  <tbody>
                    {filas.map((r) => (
                      <tr key={r.pending_id} className="border-b border-stone-100 last:border-0 align-top">
                        <td className="px-3 py-2 whitespace-nowrap">{formatearFechaLocal(r.economic_date)}</td>
                        <td className="px-3 py-2 text-right whitespace-nowrap font-medium text-red-700">{formatoPesos(-r.amount)}</td>
                        <td className="px-3 py-2">{r.concept}{r.counterparty_name && <span className="text-[#8A7A5C]"> · {r.counterparty_name}</span>}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{r.account_name}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{originText(r)}</td>
                        <td className="px-3 py-2 whitespace-nowrap text-xs text-[#6B5D45]">{autor(r.created_by)}</td>
                        <td className="px-3 py-2">
                          {r.status === 'SIN_CLASIFICAR' ? (
                            <>
                              <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-900">Sin clasificar</span>
                              <p className="text-[11px] text-[#8A7A5C] mt-0.5">Ya descontado del saldo</p>
                            </>
                          ) : (
                            <>
                              <span className="text-xs px-2 py-0.5 rounded bg-green-100 text-green-900">Clasificado</span>
                              <p className="text-[11px] text-[#8A7A5C] mt-0.5">{r.category_name}{r.nature ? ` · ${NATURE_LABEL[r.nature]}` : ''} · {autor(r.classified_by)}</p>
                            </>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {r.status === 'SIN_CLASIFICAR' && (
                            <button type="button" onClick={() => setElegido(r)} className="text-xs px-2 py-1 rounded bg-[#A8552E] text-white hover:bg-[#8E4626]">Clasificar</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Paginador pagina={pagina} paginas={paginas} total={total} onCambiar={setPagina} />
            </>
          )}
      {elegido && <ClasificarGasto r={elegido} onClose={() => setElegido(null)} />}
    </div>
  );
}

/** The classification form: category → subcategory (only selectable ones: active, in an active category), nature, concept, counterparty. */
function ClasificarGasto({ r, onClose }: { r: PendingExpenseRow; onClose: () => void }) {
  const [subcategoria, setSubcategoria] = useState('');
  const [naturaleza, setNaturaleza] = useState<PurchaseNatureValue>('OPERATING');
  const [concepto, setConcepto] = useState(r.concept);
  const [contraparte, setContraparte] = useState(r.counterparty_name ?? '');
  const [motivo, setMotivo] = useState('');
  const clasificar = useClassifyPendingExpense();
  const listo = classifyReady({ expenseCategoryId: subcategoria, nature: naturaleza, concept: concepto });
  const guardar = () => clasificar.mutate({
    pendingId: r.pending_id, expenseCategoryId: subcategoria, nature: naturaleza,
    concept: concepto.trim() === r.concept ? null : concepto,
    counterpartyName: contraparte.trim() === (r.counterparty_name ?? '') ? null : contraparte,
    reason: motivo || null,
  }, { onSuccess: onClose });
  return (
    <Modal titulo={`Clasificar gasto de ${formatoPesos(r.amount)}`} onClose={onClose} onSubmit={guardar} puedeGuardar={listo} guardando={clasificar.isPending}
      textoGuardar="Clasificar">
      <p className="text-xs text-[#6B5D45] bg-amber-50 border border-amber-200 rounded px-2 py-1">
        {formatearFechaLocal(r.economic_date)} · {r.account_name} · {originText(r)}. El egreso ya está registrado: clasificar no genera otro movimiento ni cambia el saldo.
      </p>
      <SelectorCategoria campo={campo} etiqueta={etiqueta} subcategoriaId={subcategoria} onSubcategoria={setSubcategoria} naturaleza={naturaleza} onNaturaleza={setNaturaleza} />
      <label className={etiqueta}>Concepto
        <input className={campo} maxLength={100} value={concepto} onChange={(e) => setConcepto(e.target.value)} />
      </label>
      <label className={etiqueta}>Comercio / contraparte (opcional)
        <input className={campo} maxLength={120} value={contraparte} onChange={(e) => setContraparte(e.target.value)} />
      </label>
      <label className={etiqueta}>Nota (opcional, queda en la auditoría)
        <input className={campo} maxLength={200} value={motivo} onChange={(e) => setMotivo(e.target.value)} />
      </label>
      {clasificar.error ? <div className="bg-red-100 border border-red-300 text-red-800 px-3 py-2 rounded-lg text-sm" role="alert">{mensajeError(clasificar.error)}</div> : null}
    </Modal>
  );
}
