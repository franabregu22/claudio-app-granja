import { ArrowLeftRight, History, MoreHorizontal, Undo2 } from 'lucide-react';
import { useState } from 'react';
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
import { clasificableEnFila, EditorCelda, editableEnFila, type CampoFila } from './EdicionEnFila';
import { ChipEtiqueta } from './Etiquetas';
import { DetalleGasto, ModalesGasto, useGastoItems, type Accion } from './Gastos';
import { useEtiquetas, useEtiquetasDeGastos } from './useEtiquetas';
import { campo, etiqueta, Modal } from './Modal';
import { ImpuestoModal, ImpuestoPorPeriodo, TransferenciaModal, TransferenciasAnticipadas, VincularAnticipada } from './Transferencias';
import { usePurchaseAttachments } from './useInvoicePayments';
import { useOperationList, useOperationTimeline, usePayFromRow } from './useOperations';
import { usePagosRevertidos, useRevertirPago } from './useExpenses';
import { useAllExpenseSubcategories, useExpenseCategories, useExpenseGroups, useMovementList, useSuppliers, useTransferIntents } from './useTreasury';
import { useProfileEmails } from './useUnclassified';
import { NumeroInput } from '../../components/NumeroInput';
import { FiltroColumna, OpcionesFiltro } from '../../components/FiltroColumna';

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
  etiqueta: string;   // 0127: '' todas, 'SIN' sin etiqueta, else a tag id
}
export const FILTROS_VACIOS: Filtros = {
  desde: '', hasta: '', tipo: '', cuenta: '', estado: '', grupo: '', subcategoria: '', naturaleza: '', proveedor: '', buscar: '', orden: 'FECHA', etiqueta: '',
};
/** The server filter of a set of owner filters ("SIN" = Sin asignar). */
export function filtroServidor(f: Filtros, recientes: boolean): OperationFilter {
  return {
    from: f.desde || undefined, to: f.hasta || undefined, tipo: f.tipo || undefined, accountId: f.cuenta && f.cuenta !== 'SIN' ? f.cuenta : undefined,
    sinCuenta: f.cuenta === 'SIN', estado: f.estado || undefined, groupId: f.grupo || undefined, categoryId: f.subcategoria || undefined,
    nature: f.naturaleza || undefined, supplierId: f.proveedor || undefined, search: f.buscar || undefined, order: recientes ? 'CARGA' : f.orden,
    tagId: f.etiqueta && f.etiqueta !== 'SIN' ? f.etiqueta : undefined, sinEtiqueta: f.etiqueta === 'SIN',
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
  const tags = useEtiquetasDeGastos();   // 0127: purchase id → its tag (the column «Etiqueta»)
  const [pagina, setPagina] = useState(0);
  const [detalle, setDetalle] = useState<OperationRow | null>(null);
  const [revertir, setRevertir] = useState<OperationRow | null>(null);   // 0130
  const revertidos = usePagosRevertidos();   // owner 2026-11-17: the full detail opens in a window («⋯»)
  const [editando, setEditando] = useState<{ fila: string; campo: CampoFila } | null>(null);   // owner 2026-11-17: in-row editing
  const [pagar, setPagar] = useState<OperationRow | null>(null);
  const [historial, setHistorial] = useState<OperationRow | null>(null);
  const [transfiriendo, setTransfiriendo] = useState(false);
  const [aviso, setAviso] = useState<{ texto: string; clave: string | null } | null>(null);
  const grupos = useExpenseGroups();
  const subcategorias = useAllExpenseSubcategories();
  const etiquetas = useEtiquetas();   // 0127
  // the account cards above filter the same list: kept in step with them
  const filtros = { ...f, cuenta: f.cuenta === 'SIN' ? 'SIN' : cuentaId };
  // 'RECIENTES': the just-recorded operation is not a row yet (Mercado Pago): the list by loading time instead of one row
  const recientes = foco === 'RECIENTES';
  const focus = recientes ? null : foco;
  const lista = useOperationList(filtroServidor(filtros, recientes), pagina, focus);
  const filas = lista.data?.rows ?? [];
  const adjuntos = usePurchaseAttachments(filas.flatMap((r) => (r.purchase_id ? [r.purchase_id] : [])));
  const total = lista.data?.total ?? 0;
  const poner = (cambio: Partial<Filtros>) => {
    setF((x) => ({ ...x, ...cambio, ...('grupo' in cambio ? { subcategoria: '' } : {}) }));
    if ('cuenta' in cambio) onCuenta(cambio.cuenta && cambio.cuenta !== 'SIN' ? cambio.cuenta : '');
    setPagina(0); setEditando(null); onFocus(null);
  };
  const limpiar = () => { setF(FILTROS_VACIOS); setTexto(''); onCuenta(''); setPagina(0); setEditando(null); onFocus(null); };
  const subcatsDelGrupo = (subcategorias.data ?? []).filter((s) => !filtros.grupo || s.group_id === filtros.grupo);
  // owner 2026-11-17: Excel-like filters — an arrow next to each column name opens its choices (the same server filters as before)
  const opcion = (titulo: string, valor: string, onElegir: (v: string) => void, opciones: { v: string; t: string }[], todos = 'Todos', subtitulo?: string) => (
    <FiltroColumna titulo={titulo} activo={valor !== ''}>
      {(cerrar) => <OpcionesFiltro valor={valor} opciones={opciones} todos={todos} subtitulo={subtitulo} onElegir={(v) => { onElegir(v); cerrar(); }} />}
    </FiltroColumna>
  );
  const TH = 'px-2 py-2 font-medium whitespace-nowrap';
  const encabezado = (
    <thead><tr className="text-xs text-[#8A7A5C] border-b border-[#E4DCC8] text-left">
      <th className={TH}>
        <FiltroColumna titulo="Fecha" activo={filtros.desde !== '' || filtros.hasta !== '' || filtros.orden === 'CARGA'}>
          {(cerrar) => (
            <div className="space-y-2 p-1">
              <label className="block text-xs text-[#8A7A5C]">Desde<input type="date" value={filtros.desde} onChange={(e) => poner({ desde: e.target.value })} className={campo} /></label>
              <label className="block text-xs text-[#8A7A5C]">Hasta<input type="date" value={filtros.hasta} onChange={(e) => poner({ hasta: e.target.value })} className={campo} /></label>
              <OpcionesFiltro subtitulo="Orden" valor={filtros.orden === 'CARGA' ? 'CARGA' : ''} todos="Por fecha" opciones={[{ v: 'CARGA', t: 'Cargadas recientemente' }]}
                onElegir={(v) => poner({ orden: v === 'CARGA' ? 'CARGA' : 'FECHA' })} />
              <div className="flex items-center justify-between pt-1">
                <button type="button" onClick={() => { poner({ desde: '', hasta: '', orden: 'FECHA' }); cerrar(); }} className="text-xs text-[#A8552E] hover:underline">Quitar filtro</button>
                <button type="button" onClick={cerrar} className="text-xs px-3 py-1 rounded bg-amber-600 text-white hover:bg-amber-700">Listo</button>
              </div>
            </div>
          )}
        </FiltroColumna>
      </th>
      <th className={TH}>{opcion('Tipo', filtros.tipo, (v) => poner({ tipo: v as OperationTipo | '' }), [{ v: 'INGRESO', t: 'Ingresos' }, { v: 'EGRESO', t: 'Egresos' }, { v: 'TRANSFERENCIA', t: 'Transferencias' }])}</th>
      <th className={TH}>
        <FiltroColumna titulo="Concepto" activo={filtros.buscar !== ''}>
          {(cerrar) => (
            <form className="space-y-2 p-1" onSubmit={(e) => { e.preventDefault(); poner({ buscar: texto.trim() }); cerrar(); }}>
              <label className="block text-xs text-[#8A7A5C]">Contiene
                <input type="search" ref={(el) => el?.focus({ preventScroll: true })} value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Ej.: gasoil, maíz, nombre del proveedor…" className={campo} />
              </label>
              <p className="text-[11px] text-[#8A7A5C]">Busca en el concepto, el proveedor o el cliente.</p>
              <div className="flex items-center justify-between">
                <button type="button" onClick={() => { setTexto(''); poner({ buscar: '' }); cerrar(); }} className="text-xs text-[#A8552E] hover:underline">Quitar filtro</button>
                <button type="submit" className="text-xs px-3 py-1 rounded bg-amber-600 text-white hover:bg-amber-700">Filtrar</button>
              </div>
            </form>
          )}
        </FiltroColumna>
      </th>
      <th className={TH}>{opcion('Categoría', filtros.grupo, (v) => poner({ grupo: v }), (grupos.data ?? []).map((g) => ({ v: g.id, t: g.nombre })), 'Todas')}</th>
      <th className={TH}>{opcion('Subcategoría', filtros.subcategoria, (v) => poner({ subcategoria: v }), subcatsDelGrupo.map((x) => ({ v: x.id, t: x.nombre })), 'Todas')}</th>
      <th className={TH}>{opcion('Naturaleza', filtros.naturaleza, (v) => poner({ naturaleza: v as OperationNature | '' }),
        (Object.keys(NATURALEZA_LABEL) as OperationNature[]).map((n) => ({ v: n, t: NATURALEZA_LABEL[n] })), 'Todas')}</th>
      <th className={TH}>{opcion('Etiqueta', filtros.etiqueta, (v) => poner({ etiqueta: v }), [{ v: 'SIN', t: 'Sin etiqueta' }, ...(etiquetas.data ?? []).map((e) => ({ v: e.id, t: e.nombre }))], 'Todas')}</th>
      <th className={TH}>{opcion('Cuenta', filtros.cuenta, (v) => poner({ cuenta: v }), [{ v: 'SIN', t: 'Sin asignar' }, ...cuentas.map((c) => ({ v: c.id, t: c.nombre }))], 'Todas')}</th>
      <th className={`${TH} text-right`}>Importe</th>
      <th className={TH}>{opcion('Estado', filtros.estado, (v) => poner({ estado: v as Filtros['estado'] }),
        [{ v: 'PENDIENTE', t: 'Pendientes' }, { v: 'COMPLETADA', t: 'Pagadas / cobradas / realizadas' }, { v: 'POR_REVISAR', t: 'Por revisar' }])}</th>
      <th className={TH}>Acciones</th>
    </tr></thead>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-bold text-[#2C2419]">Todas las operaciones</h2>
        <span className="flex items-center gap-3">
          <span className="text-xs text-[#8A7A5C]">{lista.isFetching ? 'Actualizando…' : `${total} ${total === 1 ? 'operación' : 'operaciones'}`}
            {!lista.isFetching && lista.data && filtros.estado === 'PENDIENTE' ? <> · Total pendiente <b className="text-red-700">{formatoPesos(Math.abs(lista.data.importe))}</b></> : null}
            {!lista.isFetching && lista.data && filtros.estado !== 'PENDIENTE' && (filtros.tipo === 'INGRESO' || filtros.tipo === 'EGRESO') ? <> · Total <b>{formatoPesos(Math.abs(lista.data.importe))}</b></> : null}
            {!lista.isFetching && lista.data && filtros.etiqueta && filtros.etiqueta !== 'SIN' && filtros.estado !== 'PENDIENTE' && filtros.tipo !== 'INGRESO' && filtros.tipo !== 'EGRESO'
              ? <> · Total de la etiqueta <b className="text-violet-900">{formatoPesos(Math.abs(lista.data.importe))}</b></> : null}</span>
          <button type="button" onClick={() => setTransfiriendo(true)} disabled={cuentas.length < 2}
            className="flex items-center gap-1.5 text-sm px-3 py-1.5 bg-amber-100 text-amber-900 rounded-lg hover:bg-amber-200 disabled:opacity-50">
            <ArrowLeftRight className="w-4 h-4" /> Transferir entre cuentas
          </button>
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filtros">
        <form className="flex flex-1 min-w-[15rem] items-center gap-1" onSubmit={(e) => { e.preventDefault(); poner({ buscar: texto.trim() }); }}>
          <input type="search" value={texto} onChange={(e) => setTexto(e.target.value)} aria-label="Buscar" placeholder="Buscar concepto, proveedor, cliente, importe…"
            className="flex-1 min-w-0 border border-[#E4DCC8] rounded-lg px-3 py-1.5 text-sm bg-white" />
          <button type="submit" className="px-3 py-1.5 rounded-lg bg-amber-600 text-white text-sm hover:bg-amber-700">Buscar</button>
        </form>
        <button type="button" onClick={limpiar} disabled={!hayFiltros(filtros) && texto === '' && !foco}
          className="text-xs px-3 py-1.5 rounded border border-[#E4DCC8] bg-white hover:bg-stone-50 disabled:opacity-40">Limpiar filtros</button>
        <span className="w-full text-xs text-[#8A7A5C]">Para filtrar, tocá la flechita al lado del nombre de cada columna. Para corregir un gasto —o clasificar un egreso de Mercado Pago eligiendo su subcategoría— doble clic en la celda (queda en el historial).</span>
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
        : (
          <div className="bg-white rounded-lg border border-[#E4DCC8] overflow-x-auto">
            <table className="w-full text-sm">
              {encabezado}
              <tbody>
                {filas.length === 0 && (
                  <tr><td colSpan={11} className="px-3 py-4 text-sm text-[#8A7A5C]">
                    {focus ? 'La operación todavía no aparece. Probá con “Cargadas recientemente”.' : 'No hay operaciones con estos filtros.'}
                  </td></tr>
                )}
                {filas.map((r) => (
                  <Fila key={r.row_key} r={r} etiqueta={r.purchase_id ? tags.data?.get(r.purchase_id)?.nombre : undefined} destacada={focus === r.row_key}
                    docs={r.purchase_id ? adjuntos.data?.get(r.purchase_id) : undefined}
                    onPagar={() => setPagar(r)} onHistorial={() => setHistorial(r)} onDetalle={() => setDetalle(r)}
                    revertido={r.operation_id !== null && !!revertidos.data?.has(r.operation_id)}
                    revertible={pagoRevertible(r, cuentas) && !(r.operation_id !== null && revertidos.data?.has(r.operation_id))} onRevertir={() => setRevertir(r)}
                    editando={editando?.fila === r.row_key ? editando.campo : null}
                    onEditar={(campo) => setEditando(campo ? { fila: r.row_key, campo } : null)} />
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
      {revertir && <RevertirPagoModal r={revertir} onClose={() => setRevertir(null)} onListo={(t) => { setRevertir(null); setAviso({ texto: t, clave: null }); }} />}
      {detalle && (
        <Modal titulo={`${TIPO_LABEL[detalle.tipo]} — ${detalle.concepto}`} onClose={() => setDetalle(null)} puedeGuardar guardando={false} error={null} textoGuardar="Cerrar" onSubmit={() => setDetalle(null)}>
          <DetalleFila r={detalle} onHistorial={() => setHistorial(detalle)} />
        </Modal>
      )}
    </div>
  );
}

/** ONE line: Fecha | Tipo | Concepto | Categoría | Subcategoría | Naturaleza | Etiqueta | Cuenta | Importe | Estado | Acciones. No drop-down
 * (owner 2026-11-17): an expense is corrected in its cells (double click), an unclassified Mercado Pago outflow is classified from its
 * subcategory cell; Acciones: Registrar pago, the invoice, the history and «⋯» (the full detail: supplier / invoice number, rectify
 * items, annul, payments, cheques, transfer, transfer). An unclassified Mercado Pago outflow is classified only from its cell. */
function Fila({ r, etiqueta, destacada, docs, onPagar, onHistorial, onDetalle, editando, onEditar, revertible, revertido, onRevertir }: {
  r: OperationRow; etiqueta?: string; destacada: boolean; docs: Parameters<typeof Comprobantes>[0]['docs']; onPagar: () => void; onHistorial: () => void;
  onDetalle: () => void; editando: CampoFila | null; onEditar: (campo: CampoFila | null) => void; revertible: boolean; revertido: boolean; onRevertir: () => void;
}) {
  const pagable = pagableDesdeFila(r);
  const editable = editableEnFila(r);
  const clasificable = clasificableEnFila(r);
  const celda = (campo: CampoFila, contenido: React.ReactNode) => (editando === campo ? <EditorCelda r={r} campo={campo} onFin={() => onEditar(null)} /> : contenido);
  const puede = (campo: CampoFila) => editable || (clasificable && campo === 'categoria');
  const alDoble = (campo: CampoFila) => (puede(campo)
    ? { onDoubleClick: () => onEditar(campo), title: clasificable ? 'Doble clic para clasificar el egreso' : 'Doble clic para editar' } : {});
  const cls = (campo: CampoFila) => (puede(campo) ? ' cursor-text hover:bg-amber-100/50' : '');
  const importe = r.tipo === 'TRANSFERENCIA' ? formatoPesos(Math.abs(r.amount)) : `${r.amount < 0 ? '−' : '+'} ${formatoPesos(Math.abs(r.amount))}`;
  const icono = 'p-1 rounded text-[#A8552E] hover:bg-amber-50';
  return (
    <tr className={`border-b border-[#EFE8D6] ${destacada ? 'bg-sky-50' : ''}`}>
      <td className={`${TD}${cls('fecha')}`} {...alDoble('fecha')}>{celda('fecha', r.date ? formatearFechaLocal(r.date) : NADA)}</td>
      <td className={`${TD} font-semibold ${TONO_TIPO[r.tipo]}`}>{TIPO_LABEL[r.tipo]}</td>
      <td className={`px-2 py-2 max-w-[18rem] ${editando === 'concepto' ? '' : 'truncate'}${cls('concepto')}`} title={r.concepto} {...alDoble('concepto')}>
        {celda('concepto', <span className="font-medium text-[#2C2419]">{r.concepto || NADA}</span>)}</td>
      <td className={`${TD} max-w-[10rem] ${editando === 'categoria' ? '' : 'truncate'}${cls('categoria')}`} title={r.category ?? undefined} {...alDoble('categoria')}>
        {editando === 'categoria' ? null : (r.category ?? (clasificable ? <span className="text-xs text-orange-800">Sin clasificar</span> : NADA))}</td>
      <td className={`${TD} ${editando === 'categoria' ? '' : 'max-w-[10rem] truncate'}${cls('categoria')}`} title={r.subcategory ?? undefined} {...alDoble('categoria')}>
        {celda('categoria', r.subcategory ?? NADA)}</td>
      <td className={`${TD}${cls('naturaleza')}`} {...alDoble('naturaleza')}>{celda('naturaleza', r.nature ? NATURALEZA_LABEL[r.nature] : NADA)}</td>
      <td className={`${TD}${cls('etiqueta')}`} {...alDoble('etiqueta')}>
        {celda('etiqueta', r.purchase_id ? (etiqueta ? <ChipEtiqueta nombre={etiqueta} /> : <span className="text-xs text-[#8A7A5C]">Sin etiqueta</span>) : NADA)}</td>
      <td className={`${TD} max-w-[12rem] truncate`}>{r.accounts.length === 0 ? <span className="text-[#8A7A5C] italic">Sin asignar</span> : cuentasLabel(r)}</td>
      <td {...alDoble('importe')} className={`${TD} text-right font-bold${cls('importe')} ${r.informativo ? 'text-[#8A7A5C] font-normal' : r.tipo === 'INGRESO' ? 'text-green-800' : r.tipo === 'EGRESO' ? 'text-red-800' : 'text-[#2C2419]'}`}
        title={r.informativo ? 'Ya está en Mercado Pago como movimiento sin clasificar: no se cuenta dos veces' : undefined}>
        {celda('importe', r.informativo ? `(${importe})` : importe)}
      </td>
      <td className={TD}>
        <span className="flex items-center gap-1">
          <span className={`${CHIP} ${TONO_ESTADO[r.estado]}`}>{estadoLabel(r)}</span>
          {r.clasificacion && <span className={`${CHIP} bg-orange-100 text-orange-900`} title={CLASIFICACION_LABEL[r.clasificacion]}>Por revisar</span>}
          {revertido && <span className={`${CHIP} bg-stone-200 text-stone-700`} title="El pago se revirtió: el gasto volvió a pendiente y el dinero a la cuenta">Pago revertido</span>}
        </span>
      </td>
      <td className={TD}>
        <span className="flex items-center gap-1">
          {revertible && <button type="button" onClick={onRevertir} title="Revertir pago (vuelve a pendiente)" aria-label="Revertir pago" className={icono}><Undo2 className="w-4 h-4" /></button>}
          {pagable !== null && <button type="button" onClick={onPagar} className="text-xs px-2 py-1 rounded bg-amber-600 text-white hover:bg-amber-700">Registrar pago</button>}
          <Comprobantes docs={docs} compacto />
          <button type="button" onClick={onHistorial} title="Historial de cambios" aria-label="Historial de cambios" className={icono}><History className="w-4 h-4" /></button>
          <button type="button" onClick={onDetalle} title="Más: proveedor y factura, anular, pagos, cheques…" aria-label="Más" className={icono}><MoreHorizontal className="w-4 h-4" /></button>
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
function DetalleFila({ r }: { r: OperationRow; onHistorial?: () => void }) {
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

/** 0130: the payment row of an expense WITHOUT supplier paid from cash / bank (the backend checks the same and more). */
export function pagoRevertible(r: OperationRow, cuentas: FinancialAccountRow[]): boolean {
  if (r.row_kind !== 'OP' || r.tipo !== 'EGRESO' || r.estado !== 'COMPLETADA' || !r.purchase_id || r.supplier_id || r.operation_id === null || r.informativo) return false;
  return r.accounts.length === 1 && cuentas.some((c) => c.id === r.accounts[0].account_id && (c.account_type === 'CASH' || c.account_type === 'BANK_ACCOUNT'));
}

function RevertirPagoModal({ r, onClose, onListo }: { r: OperationRow; onClose: () => void; onListo: (texto: string) => void }) {
  const revertir = useRevertirPago();
  const [motivo, setMotivo] = useState('');
  const [clave] = useState(() => `REV-${crypto.randomUUID()}`);
  const monto = formatoPesos(Math.abs(r.amount));
  return (
    <Modal titulo={`Revertir pago — ${r.concepto}`} onClose={onClose} puedeGuardar={!revertir.isPending} guardando={revertir.isPending} error={revertir.error}
      textoGuardar="Revertir pago"
      onSubmit={() => revertir.mutate({ purchaseId: r.purchase_id!, operationId: r.operation_id!, reason: motivo.trim() || 'Revertir pago', idempotencyKey: clave },
        { onSuccess: () => onListo(`Pago revertido: «${r.concepto}» quedó pendiente de pago y ${monto} volvió a ${cuentasLabel(r)}.`) })}>
      <p className="text-sm text-[#2C2419]">El gasto vuelve a <b>pendiente de pago</b> y {monto} vuelve a <b>{cuentasLabel(r)}</b> con la fecha del pago ({r.date ? formatearFechaLocal(r.date) : '—'}).</p>
      <p className="text-xs text-[#6B5D45]">El gasto sigue en resultados. El pago original y la reversión quedan en el historial.</p>
      <label className={etiqueta}>Motivo (opcional)
        <input type="text" value={motivo} onChange={(e) => setMotivo(e.target.value)} maxLength={200} placeholder="Ej.: se cargó como pagado por error" className={campo} />
      </label>
    </Modal>
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
        <NumeroInput min="0" step="0.01" max={maximo} value={monto} onChange={(e) => setMonto(e.target.value)} className={campo} />
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
