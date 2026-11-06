import { ArrowLeftRight, ChevronDown, History } from 'lucide-react';
import { Fragment, useState } from 'react';
import { errorMessage } from '../../target/messages';
import { movementAccounts, type MovementRow } from '../../target/movementHistory';
import {
  ACCION_HISTORIAL, CLASIFICACION_LABEL, CONCILIACION_LABEL, cuentasLabel, estadoLabel, NATURALEZA_LABEL, OPERATION_PAGE, TIPO_LABEL,
  type OperationEstado, type OperationFilter, type OperationNature, type OperationRow, type OperationTipo, type PendienteFactura, type TimelineEvent,
} from '../../target/operations';
import { formatearFechaLocal, getTodayDate } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';
import type { FinancialAccountRow } from '../../target/masters';
import { Comprobantes } from './Comprobantes';
import { DetalleGasto, ModalesGasto, useGastoItems, type Accion } from './Gastos';
import { campo, etiqueta, Modal } from './Modal';
import { ImpuestoModal, ImpuestoPorPeriodo, TransferenciaModal, TransferenciasAnticipadas, VincularAnticipada } from './Transferencias';
import { usePurchaseAttachments } from './useInvoicePayments';
import { useOperationList, useOperationTimeline, usePayFromRow } from './useOperations';
import { useAllExpenseSubcategories, useExpenseCategories, useExpenseGroups, useMovementList, useSuppliers, useTransferIntents } from './useTreasury';
import { useProfileEmails } from './useUnclassified';

const CHIP = 'text-xs px-2 py-0.5 rounded whitespace-nowrap';
const TONO_ESTADO: Record<OperationEstado, string> = { PENDIENTE: 'bg-amber-100 text-amber-900', COMPLETADA: 'bg-green-100 text-green-800' };
const TONO_TIPO: Record<OperationTipo, string> = { INGRESO: 'text-green-800', EGRESO: 'text-red-800', TRANSFERENCIA: 'text-sky-800' };
const NADA = '—';
const TD = 'px-2 py-2 whitespace-nowrap';

/** What can be paid from the row now (null: nothing): a pending expense's remainder; the part of an invoice no cheque covers. */
export function pagableDesdeFila(r: OperationRow): number | null {
  if (r.estado !== 'PENDIENTE' || !r.pendiente) return null;
  if (r.row_kind === 'GASTO') return r.pendiente.pendiente > 0 ? r.pendiente.pendiente : null;
  if (r.row_kind === 'FACTURA') return (r.pendiente as PendienteFactura).sin_cubrir > 0 ? (r.pendiente as PendienteFactura).sin_cubrir : null;
  return null;
}

/** The filters as the owner sets them; "Limpiar filtros" brings every one back here (dates, search and order included). */
interface Filtros {
  desde: string; hasta: string; tipo: OperationTipo | ''; cuenta: string; estado: OperationEstado | 'POR_REVISAR' | ''; grupo: string; subcategoria: string;
  naturaleza: OperationNature | ''; proveedor: string; buscar: string; orden: 'FECHA' | 'CARGA';
}
export const FILTROS_VACIOS: Filtros = {
  desde: '', hasta: '', tipo: '', cuenta: '', estado: '', grupo: '', subcategoria: '', naturaleza: '', proveedor: '', buscar: '', orden: 'FECHA',
};
/** The server filter of a set of owner filters ("SIN" = Sin asignar). */
export function filtroServidor(f: Filtros, recientes: boolean): OperationFilter {
  return {
    from: f.desde || undefined, to: f.hasta || undefined, tipo: f.tipo || undefined, accountId: f.cuenta && f.cuenta !== 'SIN' ? f.cuenta : undefined,
    sinCuenta: f.cuenta === 'SIN', estado: f.estado || undefined, groupId: f.grupo || undefined, categoryId: f.subcategoria || undefined,
    nature: f.naturaleza || undefined, supplierId: f.proveedor || undefined, search: f.buscar || undefined, order: recientes ? 'CARGA' : f.orden,
  };
}
export const hayFiltros = (f: Filtros) => JSON.stringify(f) !== JSON.stringify(FILTROS_VACIOS);

/**
 * Caja → Movimientos → Todas las operaciones (0119 / 0120): every recorded operation and everything still unpaid, each amount once, ONE line
 * per row — Fecha, Tipo, Concepto, Categoría, Subcategoría, Cuenta, Importe, Estado, Acciones — and a drop-down with the rest: the real
 * postings, the bank / Mercado Pago evidence, the transfer and its taxes, and the expense or invoice it belongs to with ALL its existing
 * actions (Gastos' detail: receipts, edit / rectify — category, subcategory, nature, supplier, audited by rectify_purchase_details —,
 * payments, cheques, dates, freight, history). `focus` shows exactly one row (a just-recorded operation, whatever its date).
 */
export function TodasLasOperaciones({ cuentas, cuentaId, onCuenta, focus: foco, onFocus }: {
  cuentas: FinancialAccountRow[]; cuentaId: string; onCuenta: (id: string) => void; focus: string | null; onFocus: (key: string | null) => void;
}) {
  const [f, setF] = useState<Filtros>({ ...FILTROS_VACIOS, cuenta: cuentaId });
  const [texto, setTexto] = useState('');
  const [pagina, setPagina] = useState(0);
  const [abierta, setAbierta] = useState<string | null>(null);
  const [pagar, setPagar] = useState<OperationRow | null>(null);
  const [historial, setHistorial] = useState<OperationRow | null>(null);
  const [transfiriendo, setTransfiriendo] = useState(false);
  const [aviso, setAviso] = useState<{ texto: string; clave: string | null } | null>(null);
  const grupos = useExpenseGroups();
  const subcategorias = useAllExpenseSubcategories();
  const proveedores = useSuppliers();
  // the account cards above filter the same list: kept in step with them
  const filtros = { ...f, cuenta: f.cuenta === 'SIN' ? 'SIN' : cuentaId };
  // 'RECIENTES': the just-recorded operation is not a row yet (Mercado Pago): the list by loading time instead of one row
  const recientes = foco === 'RECIENTES';
  const focus = recientes ? null : foco;
  const lista = useOperationList(filtroServidor(filtros, recientes), pagina, focus);
  const filas = lista.data?.rows ?? [];
  const total = lista.data?.total ?? 0;
  const poner = (cambio: Partial<Filtros>) => {
    setF((x) => ({ ...x, ...cambio, ...('grupo' in cambio ? { subcategoria: '' } : {}) }));
    if ('cuenta' in cambio) onCuenta(cambio.cuenta && cambio.cuenta !== 'SIN' ? cambio.cuenta : '');
    setPagina(0); setAbierta(null); onFocus(null);
  };
  const limpiar = () => { setF(FILTROS_VACIOS); setTexto(''); onCuenta(''); setPagina(0); setAbierta(null); onFocus(null); };
  const subcatsDelGrupo = (subcategorias.data ?? []).filter((s) => !filtros.grupo || s.group_id === filtros.grupo);
  const sel = (label: string, value: string, onChange: (v: string) => void, opciones: { v: string; t: string }[], todos = 'Todos') => (
    <label className="text-xs text-[#8A7A5C]">{label}
      <select value={value} onChange={(e) => onChange(e.target.value)} className={campo}>
        <option value="">{todos}</option>
        {opciones.map((o) => <option key={o.v} value={o.v}>{o.t}</option>)}
      </select>
    </label>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-bold text-[#2C2419]">Todas las operaciones</h2>
        <span className="flex items-center gap-3">
          <span className="text-xs text-[#8A7A5C]">{lista.isFetching ? 'Actualizando…' : `${total} ${total === 1 ? 'operación' : 'operaciones'}`}
            {!lista.isFetching && lista.data && filtros.estado === 'PENDIENTE' ? <> · Total pendiente <b className="text-red-700">{formatoPesos(Math.abs(lista.data.importe))}</b></> : null}
            {!lista.isFetching && lista.data && filtros.estado !== 'PENDIENTE' && (filtros.tipo === 'INGRESO' || filtros.tipo === 'EGRESO') ? <> · Total <b>{formatoPesos(Math.abs(lista.data.importe))}</b></> : null}</span>
          <button type="button" onClick={() => setTransfiriendo(true)} disabled={cuentas.length < 2}
            className="flex items-center gap-1.5 text-sm px-3 py-1.5 bg-amber-100 text-amber-900 rounded-lg hover:bg-amber-200 disabled:opacity-50">
            <ArrowLeftRight className="w-4 h-4" /> Transferir entre cuentas
          </button>
        </span>
      </div>

      <div className="bg-white rounded-lg border border-[#E4DCC8] p-3 grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-2 text-sm" role="group" aria-label="Filtros">
        <label className="text-xs text-[#8A7A5C]">Desde<input type="date" value={filtros.desde} onChange={(e) => poner({ desde: e.target.value })} className={campo} /></label>
        <label className="text-xs text-[#8A7A5C]">Hasta<input type="date" value={filtros.hasta} onChange={(e) => poner({ hasta: e.target.value })} className={campo} /></label>
        {sel('Tipo', filtros.tipo, (v) => poner({ tipo: v as OperationTipo | '' }), [{ v: 'INGRESO', t: 'Ingresos' }, { v: 'EGRESO', t: 'Egresos' }, { v: 'TRANSFERENCIA', t: 'Transferencias' }])}
        {sel('Cuenta', filtros.cuenta, (v) => poner({ cuenta: v }), [{ v: 'SIN', t: 'Sin asignar' }, ...cuentas.map((c) => ({ v: c.id, t: c.nombre }))], 'Todas')}
        {sel('Estado', filtros.estado, (v) => poner({ estado: v as Filtros['estado'] }),
          [{ v: 'PENDIENTE', t: 'Pendientes' }, { v: 'COMPLETADA', t: 'Pagadas / cobradas / realizadas' }, { v: 'POR_REVISAR', t: 'Por revisar' }])}
        {sel('Orden', filtros.orden === 'FECHA' ? '' : 'CARGA', (v) => poner({ orden: v === 'CARGA' ? 'CARGA' : 'FECHA' }), [{ v: 'CARGA', t: 'Cargadas recientemente' }], 'Por fecha')}
        {sel('Categoría', filtros.grupo, (v) => poner({ grupo: v }), (grupos.data ?? []).map((g) => ({ v: g.id, t: g.nombre })), 'Todas')}
        {sel('Subcategoría', filtros.subcategoria, (v) => poner({ subcategoria: v }), subcatsDelGrupo.map((s) => ({ v: s.id, t: s.nombre })), 'Todas')}
        {sel('Naturaleza', filtros.naturaleza, (v) => poner({ naturaleza: v as OperationNature | '' }),
          (Object.keys(NATURALEZA_LABEL) as OperationNature[]).map((n) => ({ v: n, t: NATURALEZA_LABEL[n] })), 'Todas')}
        {sel('Proveedor', filtros.proveedor, (v) => poner({ proveedor: v }), (proveedores.data ?? []).map((s) => ({ v: s.id, t: s.nombre })))}
        <form className="col-span-2 flex items-end gap-1" onSubmit={(e) => { e.preventDefault(); poner({ buscar: texto.trim() }); }}>
          <label className="text-xs text-[#8A7A5C] flex-1">Buscar
            <input type="search" value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Concepto, proveedor, cliente, importe…" className={campo} />
          </label>
          <button type="submit" className="px-3 py-2 rounded-lg bg-amber-600 text-white text-sm hover:bg-amber-700">Buscar</button>
        </form>
        <div className="col-span-2 md:col-span-4 xl:col-span-6 flex justify-end">
          <button type="button" onClick={limpiar} disabled={!hayFiltros(filtros) && texto === '' && !foco}
            className="text-xs px-3 py-1 rounded border border-[#E4DCC8] bg-white hover:bg-stone-50 disabled:opacity-40">Limpiar filtros</button>
        </div>
      </div>

      {aviso && (
        <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-900 flex flex-wrap items-center gap-2" role="status">
          <span>{aviso.texto}</span>
          {aviso.clave && <button type="button" className="underline font-semibold" onClick={() => { onFocus(aviso.clave); setAviso(null); }}>Ver la operación</button>}
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
          <p className="text-sm text-[#8A7A5C]">{focus ? 'La operación todavía no aparece. Probá con “Cargadas recientemente”.' : 'No hay operaciones con estos filtros.'}</p>
        ) : (
          <div className="bg-white rounded-lg border border-[#E4DCC8] overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-xs text-[#8A7A5C] border-b border-[#E4DCC8] text-left">
                <th className="px-2 py-2">Fecha</th><th className="px-2 py-2">Tipo</th><th className="px-2 py-2">Concepto</th><th className="px-2 py-2">Categoría</th>
                <th className="px-2 py-2">Subcategoría</th><th className="px-2 py-2">Cuenta</th><th className="px-2 py-2 text-right">Importe</th>
                <th className="px-2 py-2">Estado</th><th className="px-2 py-2">Acciones</th>
              </tr></thead>
              <tbody>
                {filas.map((r) => (
                  <Fragment key={r.row_key}>
                    <Fila r={r} destacada={focus === r.row_key} abierta={abierta === r.row_key} onAbrir={() => setAbierta(abierta === r.row_key ? null : r.row_key)}
                      onPagar={() => setPagar(r)} onHistorial={() => setHistorial(r)} />
                    {abierta === r.row_key && (
                      <tr className="border-b border-[#EFE8D6] bg-[#FAF6EE]"><td colSpan={9} className="p-0"><DetalleFila r={r} /></td></tr>
                    )}
                  </Fragment>
                ))}
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

      {filtros.tipo === 'TRANSFERENCIA' && (
        <div className="space-y-3">
          <TransferenciasAnticipadas />
          <div className="bg-white rounded-lg border border-[#E4DCC8] p-4"><ImpuestoPorPeriodo /></div>
        </div>
      )}

      {transfiriendo && <TransferenciaModal onClose={() => setTransfiriendo(false)} />}
      {pagar && (
        <PagarDesdeFilaModal r={pagar} cuentas={cuentas} onClose={() => setPagar(null)}
          onPagado={(op, resto) => { setPagar(null); setAviso({ texto: `Pago registrado${resto > 0 ? `; queda pendiente ${formatoPesos(resto)}` : ''}.`, clave: `OP:${op}` }); }} />
      )}
      {historial && <HistorialModal r={historial} onClose={() => setHistorial(null)} />}
    </div>
  );
}

/** ONE line: Fecha | Tipo | Concepto | Categoría | Subcategoría | Cuenta | Importe | Estado | Acciones ("—" when it does not apply). */
function Fila({ r, destacada, abierta, onAbrir, onPagar, onHistorial }: {
  r: OperationRow; destacada: boolean; abierta: boolean; onAbrir: () => void; onPagar: () => void; onHistorial: () => void;
}) {
  const pagable = pagableDesdeFila(r);
  const importe = r.tipo === 'TRANSFERENCIA' ? formatoPesos(Math.abs(r.amount)) : `${r.amount < 0 ? '−' : '+'} ${formatoPesos(Math.abs(r.amount))}`;
  return (
    <tr className={`border-b border-[#EFE8D6] ${destacada ? 'bg-sky-50' : abierta ? 'bg-amber-50/40' : ''}`}>
      <td className={TD}>{r.date ? formatearFechaLocal(r.date) : NADA}</td>
      <td className={`${TD} font-semibold ${TONO_TIPO[r.tipo]}`}>{TIPO_LABEL[r.tipo]}</td>
      <td className="px-2 py-2 max-w-[18rem] truncate" title={r.concepto}><span className="font-medium text-[#2C2419]">{r.concepto || NADA}</span></td>
      <td className={`${TD} max-w-[10rem] truncate`} title={r.category ?? undefined}>{r.category ?? NADA}</td>
      <td className={`${TD} max-w-[10rem] truncate`} title={r.subcategory ?? undefined}>{r.subcategory ?? NADA}</td>
      <td className={`${TD} max-w-[12rem] truncate`}>{r.accounts.length === 0 ? <span className="text-[#8A7A5C] italic">Sin asignar</span> : cuentasLabel(r)}</td>
      <td className={`${TD} text-right font-bold ${r.informativo ? 'text-[#8A7A5C] font-normal' : r.tipo === 'INGRESO' ? 'text-green-800' : r.tipo === 'EGRESO' ? 'text-red-800' : 'text-[#2C2419]'}`}
        title={r.informativo ? 'Ya está en Mercado Pago como movimiento sin clasificar: no se cuenta dos veces' : undefined}>
        {r.informativo ? `(${importe})` : importe}
      </td>
      <td className={TD}>
        <span className="flex items-center gap-1">
          <span className={`${CHIP} ${TONO_ESTADO[r.estado]}`}>{estadoLabel(r)}</span>
          {r.clasificacion && <span className={`${CHIP} bg-orange-100 text-orange-900`} title={CLASIFICACION_LABEL[r.clasificacion]}>Por revisar</span>}
        </span>
      </td>
      <td className={TD}>
        <span className="flex items-center gap-1">
          {pagable !== null && <button type="button" onClick={onPagar} className="text-xs px-2 py-1 rounded bg-amber-600 text-white hover:bg-amber-700">Registrar pago</button>}
          <button type="button" onClick={onAbrir} aria-expanded={abierta} title={abierta ? 'Ocultar detalle' : 'Ver detalle'} aria-label="Detalle"
            className="p-1 rounded text-[#A8552E] hover:bg-amber-50"><ChevronDown className={`w-4 h-4 transition ${abierta ? 'rotate-180' : ''}`} /></button>
          <button type="button" onClick={onHistorial} title="Historial" aria-label="Historial" className="p-1 rounded text-[#A8552E] hover:bg-amber-50"><History className="w-4 h-4" /></button>
        </span>
      </td>
    </tr>
  );
}

const DATO = 'text-xs text-[#6B5D45]';
/**
 * The drop-down of a row: the rest of its information and every action it had in Gastos / Transferencias — the real postings (a transfer
 * is one row, its two movements stay apart), the bank / Mercado Pago evidence, its taxes and the anticipated transfer it settled, and the
 * expense or invoice it belongs to (Gastos' own detail: receipts, Editar / Rectificar, payments, cheques, dates, freight, history).
 */
function DetalleFila({ r }: { r: OperationRow }) {
  const [accion, setAccion] = useState<Accion | null>(null);
  return (
    <div className="p-3 space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1">
        <p className={DATO}>Detalle: <b>{r.detalle || NADA}</b></p>
        <p className={DATO}>Proveedor: <b>{r.supplier ?? NADA}</b></p>
        <p className={DATO}>Naturaleza: <b>{r.nature ? NATURALEZA_LABEL[r.nature] : NADA}</b></p>
        <p className={DATO}>Cargada: <b>{r.created_at ? new Date(r.created_at).toLocaleString('es-AR') : NADA}</b>{r.operation_id ? ` · operación ${r.operation_id}` : ''}</p>
        <p className={DATO}>Conciliación: <b>{r.conciliacion ? CONCILIACION_LABEL[r.conciliacion] : NADA}</b></p>
        <p className={DATO}>A revisar: <b>{r.clasificacion ? CLASIFICACION_LABEL[r.clasificacion] : NADA}</b></p>
        {r.pendiente && <p className={DATO}>Total {formatoPesos(r.pendiente.total)} · pagado {formatoPesos(r.pendiente.pagado)} · pendiente {formatoPesos(r.pendiente.pendiente)}
          {r.row_kind === 'FACTURA' && (r.pendiente as PendienteFactura).cheques_por_debitar > 0 ? ` · en cheques por debitar ${formatoPesos((r.pendiente as PendienteFactura).cheques_por_debitar)}` : ''}</p>}
      </div>
      {r.operation_id !== null && <EvidenciaOperacion operationId={r.operation_id} />}
      {r.row_kind === 'TRANSFERENCIA' && r.ref_id !== null && <AnticipadaDeFila id={r.ref_id} />}
      {r.row_kind === 'CHEQUE' && <p className={DATO}>Cheque propio sin factura: se debita, anula, rechaza o cambia su fecha de pago en Cuentas a pagar → Cheques.</p>}
      {r.row_kind === 'CHEQUE_RECIBIDO' && <p className={DATO}>Cheque de cliente: se deposita, acredita, endosa o rechaza en Cuentas a pagar → Cheques.</p>}
      {(r.purchase_id || r.pending_class_id !== null) && <GastoDeFila r={r} onAccion={setAccion} />}
      <ModalesGasto accion={accion} onClose={() => setAccion(null)} />
    </div>
  );
}

/** The real movements of one operation and their evidence, from the existing unified list (fin_movement_list, searched by its number). */
function EvidenciaOperacion({ operationId }: { operationId: number }) {
  const q = useMovementList({ search: String(operationId) }, 0);
  const [impuesto, setImpuesto] = useState(false);
  const op = (q.data?.rows ?? []).find((x): x is MovementRow => x.row_type === 'OP' && x.operation_id === operationId);
  if (q.isLoading) return <p className={DATO}>Cargando movimientos…</p>;
  if (q.error) return <p className="text-xs text-red-700">{errorMessage(q.error)}</p>;
  if (!op) return null;
  const transferencia = op.kind === 'TRANSFERENCIA';
  return (
    <div className="bg-white rounded border border-[#E4DCC8] p-2 space-y-1">
      <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide">Movimientos {transferencia ? `· ${movementAccounts(op)}` : ''}</p>
      {op.postings.map((p) => <p key={p.posting_id} className={DATO}>{p.account_name}: <b className={p.signed_amount < 0 ? 'text-red-800' : 'text-green-800'}>{formatoPesos(p.signed_amount)}</b></p>)}
      {op.bank.map((b) => <p key={b.statement_line_id} className={DATO}>Extracto {b.account_name} {formatearFechaLocal(b.value_date)}: {b.description_raw}{b.bank_reference ? ` · ref. ${b.bank_reference}` : ''} · {formatoPesos(b.signed_amount)} (conciliado)</p>)}
      {op.mp.map((m) => <p key={m.movement_id} className={DATO}>Mercado Pago {formatearFechaLocal(m.occurred_date)}{m.source_id ? ` · ${m.source_id}` : ''} · {formatoPesos(m.assigned_amount)}</p>)}
      {op.transfer_intent && <p className={DATO}>Registrada antes del movimiento de Mercado Pago (Nº {op.transfer_intent.intent_id}).</p>}
      {(op.related_taxes ?? []).map((t) => <p key={t.operation_id} className={DATO}>Impuesto Débitos/Créditos · {t.account_name} · {formatoPesos(t.amount)} · {t.matched ? 'conciliado con el extracto' : 'sin conciliar'} (operación {t.operation_id})</p>)}
      {transferencia && (op.related_taxes ?? []).length === 0 && (
        <button type="button" onClick={() => setImpuesto(true)} className="text-xs text-[#A8552E] hover:underline">+ Impuesto cobrado por esta transferencia</button>
      )}
      {impuesto && <ImpuestoModal transferencia={op} onClose={() => setImpuesto(false)} />}
    </div>
  );
}

/** A pending anticipated transfer: link it to its movement or cancel it (Transferencias' own form). */
function AnticipadaDeFila({ id }: { id: number }) {
  const q = useTransferIntents();
  const intent = (q.data ?? []).find((x) => x.id === id);
  if (q.isLoading) return <p className={DATO}>Cargando…</p>;
  return intent ? <div className="bg-white rounded border border-[#E4DCC8] p-2"><VincularAnticipada f={intent} onCerrar={() => undefined} /></div> : null;
}

/** The expense / invoice the row belongs to, with Gastos' own detail and actions. */
function GastoDeFila({ r, onAccion }: { r: OperationRow; onAccion: (a: Accion) => void }) {
  const { todos, cargando, error } = useGastoItems();
  const it = todos.find((x) => (r.pending_class_id !== null && x.key === `S-${r.pending_class_id}`) || (r.purchase_id !== null && x.purchaseId === r.purchase_id));
  const adjuntos = usePurchaseAttachments(it?.purchaseId ? [it.purchaseId] : []);
  if (cargando) return <p className={DATO}>Cargando el gasto…</p>;
  if (error) return <p className="text-xs text-red-700">{errorMessage(error)}</p>;
  if (!it) return <p className={DATO}>El gasto de esta operación no está entre los últimos 500 cargados.</p>;
  const docs = it.purchaseId ? adjuntos.data?.get(it.purchaseId) : undefined;
  return (
    <div className="bg-white rounded border border-[#E4DCC8]">
      <p className="px-3 pt-2 text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide flex items-center gap-2">
        Gasto · {it.titulo}{docs && docs.length > 0 ? <Comprobantes docs={docs} compacto /> : null}
      </p>
      <DetalleGasto it={it} docs={docs} onAccion={onAccion} />
    </div>
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
