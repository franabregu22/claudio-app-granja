import { History } from 'lucide-react';
import { useState } from 'react';
import { errorMessage } from '../../target/messages';
import {
  ACCION_HISTORIAL, CLASIFICACION_LABEL, CONCILIACION_LABEL, cuentasLabel, estadoLabel, OPERATION_PAGE, TIPO_LABEL,
  type OperationEstado, type OperationFilter, type OperationRow, type OperationTipo, type PendienteFactura, type TimelineEvent,
} from '../../target/operations';
import { formatearFechaLocal, getTodayDate } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';
import type { FinancialAccountRow } from '../../target/masters';
import { campo, etiqueta, Modal } from './Modal';
import { useOperationList, useOperationTimeline, usePayFromRow } from './useOperations';
import { useExpenseCategories, useSuppliers } from './useTreasury';
import { useProfileEmails } from './useUnclassified';

const CHIP = 'text-xs px-2 py-0.5 rounded whitespace-nowrap';
const TONO_ESTADO: Record<OperationEstado, string> = { PENDIENTE: 'bg-amber-100 text-amber-900', COMPLETADA: 'bg-green-100 text-green-800' };
const TONO_TIPO: Record<OperationTipo, string> = { INGRESO: 'text-green-800', EGRESO: 'text-red-800', TRANSFERENCIA: 'text-sky-800' };

/** What can be paid from the row now (null: nothing): a pending expense's remainder; the part of an invoice no cheque covers. */
export function pagableDesdeFila(r: OperationRow): number | null {
  if (r.estado !== 'PENDIENTE' || !r.pendiente) return null;
  if (r.row_kind === 'GASTO') return r.pendiente.pendiente > 0 ? r.pendiente.pendiente : null;
  if (r.row_kind === 'FACTURA') return (r.pendiente as PendienteFactura).sin_cubrir > 0 ? (r.pendiente as PendienteFactura).sin_cubrir : null;
  return null;
}

/**
 * Caja → Movimientos → Todas las operaciones (0119): every recorded operation and everything still unpaid, each amount once, with its
 * state (Pendiente / Pagado / Cobrado / Realizada), its bank reconciliation apart, the payment of a pending expense or invoice from its
 * row and the audited history of each row. `focus` shows exactly one row (a just-recorded operation, whatever its date).
 */
export function TodasLasOperaciones({ cuentas, cuentaId, onCuenta, focus: foco, onFocus }: {
  cuentas: FinancialAccountRow[]; cuentaId: string; onCuenta: (id: string) => void; focus: string | null; onFocus: (key: string | null) => void;
}) {
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  const [tipo, setTipo] = useState<OperationTipo | ''>('');
  const [sinCuenta, setSinCuenta] = useState(false);
  const [estado, setEstado] = useState<OperationEstado | ''>('');
  const [texto, setTexto] = useState('');
  const [buscar, setBuscar] = useState('');
  const [orden, setOrden] = useState<'FECHA' | 'CARGA'>('FECHA');
  const [pagina, setPagina] = useState(0);
  const [pagar, setPagar] = useState<OperationRow | null>(null);
  const [historial, setHistorial] = useState<OperationRow | null>(null);
  const [aviso, setAviso] = useState<{ texto: string; clave: string | null } | null>(null);
  // 'RECIENTES': the just-recorded operation is not a row yet (Mercado Pago): the list by loading time instead of one row
  const recientes = foco === 'RECIENTES';
  const focus = recientes ? null : foco;

  const filtro: OperationFilter = {
    from: desde || undefined, to: hasta || undefined, tipo: tipo || undefined, accountId: sinCuenta ? undefined : cuentaId || undefined, sinCuenta,
    estado: estado || undefined, search: buscar || undefined, order: recientes ? 'CARGA' : orden,
  };
  const lista = useOperationList(filtro, pagina, focus);
  const filas = lista.data?.rows ?? [];
  const total = lista.data?.total ?? 0;
  const cambiar = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPagina(0); onFocus(null); };

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold text-[#2C2419]">Todas las operaciones</h2>
        <span className="text-xs text-[#8A7A5C]">{lista.isFetching ? 'Actualizando…' : `${total} ${total === 1 ? 'operación' : 'operaciones'}`}</span>
      </div>

      <div className="bg-white rounded-lg border border-[#E4DCC8] p-3 grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2 text-sm" role="group" aria-label="Filtros">
        <label className="text-xs text-[#8A7A5C]">Desde<input type="date" value={desde} onChange={(e) => cambiar(setDesde)(e.target.value)} className={campo} /></label>
        <label className="text-xs text-[#8A7A5C]">Hasta<input type="date" value={hasta} onChange={(e) => cambiar(setHasta)(e.target.value)} className={campo} /></label>
        <label className="text-xs text-[#8A7A5C]">Tipo
          <select value={tipo} onChange={(e) => cambiar(setTipo)(e.target.value as OperationTipo | '')} className={campo}>
            <option value="">Todos</option><option value="INGRESO">Ingresos</option><option value="EGRESO">Egresos</option><option value="TRANSFERENCIA">Transferencias</option>
          </select>
        </label>
        <label className="text-xs text-[#8A7A5C]">Cuenta
          <select value={sinCuenta ? 'SIN' : cuentaId} className={campo}
            onChange={(e) => { const v = e.target.value; setSinCuenta(v === 'SIN'); onCuenta(v === 'SIN' ? '' : v); setPagina(0); onFocus(null); }}>
            <option value="">Todas</option><option value="SIN">Sin asignar</option>
            {cuentas.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
          </select>
        </label>
        <label className="text-xs text-[#8A7A5C]">Estado
          <select value={estado} onChange={(e) => cambiar(setEstado)(e.target.value as OperationEstado | '')} className={campo}>
            <option value="">Todos</option><option value="PENDIENTE">Pendientes</option><option value="COMPLETADA">Pagadas / cobradas / realizadas</option>
          </select>
        </label>
        <label className="text-xs text-[#8A7A5C]">Orden
          <select value={recientes ? 'CARGA' : orden} onChange={(e) => cambiar(setOrden)(e.target.value as 'FECHA' | 'CARGA')} className={campo}>
            <option value="FECHA">Por fecha</option><option value="CARGA">Cargadas recientemente</option>
          </select>
        </label>
        <form className="col-span-2 flex items-end gap-1" onSubmit={(e) => { e.preventDefault(); cambiar(setBuscar)(texto.trim()); }}>
          <label className="text-xs text-[#8A7A5C] flex-1">Buscar
            <input type="search" value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Concepto, proveedor, cliente, importe…" className={campo} />
          </label>
          <button type="submit" className="px-3 py-2 rounded-lg bg-amber-600 text-white text-sm hover:bg-amber-700">Buscar</button>
        </form>
      </div>

      {aviso && (
        <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-900 flex flex-wrap items-center gap-2" role="status">
          <span>{aviso.texto}</span>
          {aviso.clave && <button type="button" className="underline font-semibold" onClick={() => { onFocus(aviso.clave); setAviso(null); }}>Ver el pago</button>}
          <button type="button" className="ml-auto text-xs text-green-800 hover:underline" onClick={() => setAviso(null)}>Cerrar</button>
        </div>
      )}
      {focus && (
        <div className="rounded-lg border border-sky-200 bg-sky-50 p-2 text-sm text-sky-900 flex flex-wrap items-center gap-2">
          <span>Mostrando solo la operación registrada.</span>
          <button type="button" className="underline" onClick={() => onFocus(null)}>Ver todas las operaciones</button>
        </div>
      )}

      {lista.isLoading ? <p className="text-sm text-gray-500">Cargando operaciones…</p>
        : lista.error ? <p className="text-sm text-red-700">{errorMessage(lista.error)}</p>
        : filas.length === 0 ? (
          <p className="text-sm text-[#8A7A5C]">{focus ? 'La operación todavía no aparece (un gasto por Mercado Pago aparece cuando llega su movimiento). Probá con “Cargadas recientemente”.' : 'No hay operaciones con estos filtros.'}</p>
        ) : (
          <div className="bg-white rounded-lg border border-[#E4DCC8] overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-xs text-[#8A7A5C] border-b border-[#E4DCC8] text-left">
                <th className="px-3 py-2">Fecha</th><th className="px-3 py-2">Tipo</th><th className="px-3 py-2">Concepto</th><th className="px-3 py-2">Cuenta</th>
                <th className="px-3 py-2 text-right">Importe</th><th className="px-3 py-2">Estado</th><th className="px-3 py-2">Acciones</th>
              </tr></thead>
              <tbody>
                {filas.map((r) => <Fila key={r.row_key} r={r} destacada={focus === r.row_key} onPagar={() => setPagar(r)} onHistorial={() => setHistorial(r)} />)}
              </tbody>
            </table>
          </div>
        )}

      {!focus && total > OPERATION_PAGE && (
        <div className="flex items-center justify-center gap-3 text-sm">
          <button type="button" disabled={pagina === 0} onClick={() => setPagina(pagina - 1)} className="px-3 py-1 rounded border border-[#E4DCC8] bg-white disabled:opacity-40">‹ Anteriores</button>
          <span className="text-[#8A7A5C]">Página {pagina + 1} de {Math.ceil(total / OPERATION_PAGE)}</span>
          <button type="button" disabled={(pagina + 1) * OPERATION_PAGE >= total} onClick={() => setPagina(pagina + 1)} className="px-3 py-1 rounded border border-[#E4DCC8] bg-white disabled:opacity-40">Siguientes ›</button>
        </div>
      )}

      {pagar && (
        <PagarDesdeFilaModal r={pagar} cuentas={cuentas} onClose={() => setPagar(null)}
          onPagado={(op, resto) => { setPagar(null); setAviso({ texto: `Pago registrado${resto > 0 ? `; queda pendiente ${formatoPesos(resto)}` : ''}.`, clave: `OP:${op}` }); }} />
      )}
      {historial && <HistorialModal r={historial} onClose={() => setHistorial(null)} />}
    </div>
  );
}

function Fila({ r, destacada, onPagar, onHistorial }: { r: OperationRow; destacada: boolean; onPagar: () => void; onHistorial: () => void }) {
  const pagable = pagableDesdeFila(r);
  const factura = r.row_kind === 'FACTURA' ? (r.pendiente as PendienteFactura | null) : null;
  return (
    <tr className={`border-b border-[#EFE8D6] last:border-0 align-top ${destacada ? 'bg-sky-50' : ''}`}>
      <td className="px-3 py-2 whitespace-nowrap">{r.date ? formatearFechaLocal(r.date) : 'Sin fecha'}</td>
      <td className={`px-3 py-2 font-semibold ${TONO_TIPO[r.tipo]}`}>{TIPO_LABEL[r.tipo]}</td>
      <td className="px-3 py-2 min-w-[14rem]">
        <span className="font-medium text-[#2C2419]">{r.concepto}</span>
        <span className="block text-xs text-[#8A7A5C]">{[r.detalle !== r.concepto ? r.detalle : null, r.operation_id ? `operación ${r.operation_id}` : null].filter(Boolean).join(' · ')}</span>
        {r.row_kind === 'GASTO' && r.pendiente && r.pendiente.pagado > 0 && (
          <span className="block text-xs text-[#8A7A5C]">Total {formatoPesos(r.pendiente.total)} · pagado {formatoPesos(r.pendiente.pagado)}</span>
        )}
        {factura && (
          <span className="block text-xs text-[#8A7A5C]">
            Total {formatoPesos(factura.total)}{factura.pagado > 0 ? ` · pagado ${formatoPesos(factura.pagado)}` : ''}
            {factura.cheques_por_debitar > 0 ? ` · cheques por debitar ${formatoPesos(factura.cheques_por_debitar)} (ver en Cheques)` : ''}
          </span>
        )}
      </td>
      <td className="px-3 py-2 whitespace-nowrap">{r.accounts.length === 0 ? <span className="text-[#8A7A5C] italic">Sin asignar</span> : cuentasLabel(r)}</td>
      <td className={`px-3 py-2 text-right font-bold whitespace-nowrap ${r.tipo === 'INGRESO' ? 'text-green-800' : r.tipo === 'EGRESO' ? 'text-red-800' : 'text-[#2C2419]'}`}>
        {r.tipo === 'TRANSFERENCIA' ? formatoPesos(Math.abs(r.amount)) : `${r.amount < 0 ? '−' : '+'} ${formatoPesos(Math.abs(r.amount))}`}
      </td>
      <td className="px-3 py-2">
        <span className="flex flex-wrap gap-1">
          <span className={`${CHIP} ${TONO_ESTADO[r.estado]}`}>{estadoLabel(r)}</span>
          {r.conciliacion && <span className={`${CHIP} ${r.conciliacion === 'SIN_CONCILIAR' ? 'bg-stone-100 text-stone-700' : 'bg-sky-50 text-sky-800'}`} title="Conciliación bancaria: información aparte del estado de pago">{CONCILIACION_LABEL[r.conciliacion]}</span>}
          {r.clasificacion && <span className={`${CHIP} bg-orange-100 text-orange-900`}>{CLASIFICACION_LABEL[r.clasificacion]}</span>}
        </span>
      </td>
      <td className="px-3 py-2">
        <span className="flex items-center gap-2">
          {pagable !== null && <button type="button" onClick={onPagar} className="text-xs px-2 py-1 rounded bg-amber-600 text-white hover:bg-amber-700 whitespace-nowrap">Registrar pago</button>}
          {factura && pagable === null && factura.cheques_por_debitar > 0 && <span className="text-xs text-[#8A7A5C]">Cubierta con cheques</span>}
          {r.row_kind === 'CHEQUE' && <span className="text-xs text-[#8A7A5C]">Se gestiona en Cheques</span>}
          {r.row_kind === 'TRANSFERENCIA' && <span className="text-xs text-[#8A7A5C]">Se vincula al llegar el movimiento</span>}
          <button type="button" onClick={onHistorial} title="Historial" aria-label="Historial" className="p-1 rounded text-[#A8552E] hover:bg-amber-50"><History className="w-4 h-4" /></button>
        </span>
      </td>
    </tr>
  );
}

/**
 * The payment of a pending expense or of the uncovered part of an invoice, from its row: account, effective date, optional reference.
 * The existing contracts do the rest (pay_pending_expense / pay_purchase_invoice): one movement, partial payments, no over-payment,
 * cash from a cash account and a transfer from a bank account; Mercado Pago and cheques keep their own routes.
 */
function PagarDesdeFilaModal({ r, cuentas, onClose, onPagado }: {
  r: OperationRow; cuentas: FinancialAccountRow[]; onClose: () => void; onPagado: (operationId: number, resto: number) => void;
}) {
  const { pendingExpense, invoice } = usePayFromRow();
  const maximo = pagableDesdeFila(r) ?? 0;
  const [monto, setMonto] = useState(String(maximo));
  const [cuentaId, setCuentaId] = useState('');
  const [fecha, setFecha] = useState(getTodayDate());
  const [referencia, setReferencia] = useState('');
  const [clave] = useState(() => `FILA-${crypto.randomUUID()}`);   // idempotency: one per opened form
  const admitidas = cuentas.filter((c) => c.activo !== false && (c.account_type === 'CASH' || c.account_type === 'BANK_ACCOUNT'));
  const cuenta = admitidas.find((c) => c.id === cuentaId);
  const importe = Number(monto);
  const puede = !!cuenta && importe > 0 && importe <= maximo && fecha !== '';
  const mut = r.row_kind === 'GASTO' ? pendingExpense : invoice;

  const enviar = () => {
    if (!cuenta) return;
    const method = cuenta.account_type === 'CASH' ? 'CASH' as const : 'TRANSFER' as const;
    if (r.row_kind === 'GASTO') {
      pendingExpense.mutate({ payableId: r.ref_uuid!, amount: importe, effectiveDate: fecha, accountId: cuenta.id, method, idempotencyKey: clave, reason: referencia },
        { onSuccess: (x) => onPagado(Number(x.financial_operation_id), Number(x.pending)) });
    } else {
      invoice.mutate({ rootId: r.ref_uuid!, amount: importe, date: fecha, method, accountId: cuenta.id, idempotencyKey: clave, reference: referencia },
        { onSuccess: (x) => onPagado(Number(x.financial_operation_id), Number(x.pending) - ((r.pendiente as PendienteFactura).cheques_por_debitar ?? 0)) });
    }
  };

  return (
    <Modal titulo={`Registrar pago — ${r.concepto}`} onClose={onClose} puedeGuardar={puede} guardando={mut.isPending} error={mut.error} textoGuardar="Registrar pago" onSubmit={enviar}>
      <p className="text-xs text-gray-600">
        Pendiente: <b>{formatoPesos(maximo)}</b>. Se registra un solo movimiento en la cuenta elegida, en la fecha efectiva del pago. Para pagar con cheque
        o eCheq, o por Mercado Pago, usá su circuito propio.
      </p>
      <label className={etiqueta}>Importe
        <input type="number" min="0" step="0.01" max={maximo} value={monto} onChange={(e) => setMonto(e.target.value)} className={campo} />
      </label>
      {importe > maximo && <p className="text-xs text-red-700">No puede superar lo pendiente ({formatoPesos(maximo)}).</p>}
      {importe > 0 && importe < maximo && <p className="text-xs text-[#8A7A5C]">Pago parcial: quedará pendiente {formatoPesos(maximo - importe)}.</p>}
      <label className={etiqueta}>Cuenta de origen
        <select value={cuentaId} onChange={(e) => setCuentaId(e.target.value)} className={campo}>
          <option value="">Elegir cuenta…</option>
          {admitidas.map((c) => <option key={c.id} value={c.id}>{c.nombre}{c.account_type === 'CASH' ? ' (efectivo)' : ' (transferencia)'}</option>)}
        </select>
      </label>
      <label className={etiqueta}>Fecha efectiva del pago
        <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} className={campo} />
      </label>
      <label className={etiqueta}>Referencia (opcional)
        <input type="text" value={referencia} onChange={(e) => setReferencia(e.target.value)} maxLength={120} placeholder="Nº de transferencia, recibo…" className={campo} />
      </label>
    </Modal>
  );
}

const CAMPO_HISTORIAL: Record<string, string> = {
  amount: 'Importe', date: 'Fecha', concept: 'Concepto', expense_category_id: 'Categoría', nature: 'Naturaleza', economic_date: 'Fecha', supplier_id: 'Proveedor',
  supplier_invoice_number: 'Nº de factura', amount_total: 'Importe', amount_net: 'Neto', maturity_date: 'Fecha de pago', estado: 'Estado', reference: 'Referencia',
  method: 'Medio', cancelled_date: 'Fecha de anulación',
};
const NATURALEZA: Record<string, string> = { OPERATING: 'Operativo', REINVESTMENT: 'Reinversión operativa', INVESTMENT: 'Inversión' };
const METODO: Record<string, string> = { CASH: 'Efectivo', TRANSFER: 'Transferencia', CHEQUE: 'Cheque', MERCADOPAGO: 'Mercado Pago' };
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** A value as the owner reads it: money, dates, names instead of ids, Spanish words instead of codes. */
function valorCon(nombres: Map<string, string>) {
  return (k: string, v: unknown): string => (v === null || v === undefined ? '—'
    : /amount/.test(k) && !Number.isNaN(Number(v)) ? formatoPesos(Number(v))
    : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? formatearFechaLocal(v)
    : k === 'nature' ? NATURALEZA[String(v)] ?? String(v)
    : k === 'method' ? METODO[String(v)] ?? String(v)
    : typeof v === 'string' && nombres.has(v) ? nombres.get(v)!
    : typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v) ? '(registro)' : String(v));
}
const valor = valorCon(new Map());
/** A recorded reason without internal ids ("Pago de factura <id>" → "Pago de factura"); technical traces are hidden. */
const motivoLegible = (m: string | null | undefined) => (m && !/^(ADR-?\d|phase\d)/i.test(m) ? m.replace(UUID, '').replace(/\s+/g, ' ').trim() || null : null);

/** The audited chronology of one row: who, when, what, and the values before and after when they were recorded. */
function HistorialModal({ r, onClose }: { r: OperationRow; onClose: () => void }) {
  const historial = useOperationTimeline(r.row_key);
  const emails = useProfileEmails();
  const proveedores = useSuppliers();
  const categorias = useExpenseCategories();
  const nombres = new Map<string, string>([
    ...(proveedores.data ?? []).map((s): [string, string] => [s.id, s.nombre]), ...(categorias.data ?? []).map((c): [string, string] => [c.id, c.nombre])]);
  const ver = valorCon(nombres);
  const eventos = historial.data ?? [];
  const cambios = (e: TimelineEvent) => {
    const despues = e.after ?? {};
    const antes = e.before ?? {};
    return Object.keys(CAMPO_HISTORIAL).filter((k) => k in despues && JSON.stringify(antes[k] ?? null) !== JSON.stringify(despues[k] ?? null))
      .map((k) => ({ campo: CAMPO_HISTORIAL[k], antes: k in antes ? ver(k, antes[k]) : null, despues: ver(k, despues[k]) }));
  };
  return (
    <Modal titulo={`Historial — ${r.concepto}`} onClose={onClose} puedeGuardar guardando={false} error={historial.error} textoGuardar="Cerrar" onSubmit={onClose}>
      {historial.isLoading ? <p className="text-sm text-gray-500">Cargando historial…</p>
        : eventos.length === 0 ? <p className="text-sm text-[#8A7A5C]">No hay eventos auditados para esta operación.</p> : (
          <ol className="space-y-2">
            {eventos.map((e, i) => (
              <li key={i} className="text-xs border-l-2 border-amber-300 pl-2">
                <p className="font-semibold text-[#2C2419]">{ACCION_HISTORIAL[e.action] ?? e.action}{e.detail && e.detail.cheque ? ` · Nº ${String(e.detail.cheque)}` : ''}</p>
                <p className="text-[#8A7A5C]">{new Date(e.at).toLocaleString('es-AR')} · {e.by ? emails.data?.get(e.by) ?? 'usuario' : 'sistema'}</p>
                {cambios(e).map((c) => (
                  <p key={c.campo}>{c.campo}: {c.antes !== null ? <>{c.antes} → </> : null}<b>{c.despues}</b></p>
                ))}
                {e.detail && 'amount' in e.detail && <p>Importe: <b>{valor('amount', e.detail.amount)}</b></p>}
                {e.detail && 'line' in e.detail && <p>Línea del extracto: {String(e.detail.line)} ({valor('date', e.detail.line_date)})</p>}
                {e.detail && 'postings' in e.detail && Array.isArray(e.detail.postings) && (
                  <p>{(e.detail.postings as { account: string; amount: number }[]).map((p) => `${p.account} ${formatoPesos(Number(p.amount))}`).join(' · ')}</p>
                )}
                {motivoLegible(e.reason) && <p>Motivo / referencia: {motivoLegible(e.reason)}</p>}
              </li>
            ))}
          </ol>
        )}
    </Modal>
  );
}
