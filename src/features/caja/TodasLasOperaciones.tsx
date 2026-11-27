import { ArrowLeftRight, History, MoreHorizontal, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { listCompensatedAmounts, registerManagementEvent } from '../../target/pnl';
import { errorMessage } from '../../target/messages';
import type { MovementRow } from '../../target/movementHistory';
import {
  ACCION_HISTORIAL, CLASIFICACION_LABEL, retiroAnulable, retiroAnulado, cuentasLabel, estadoLabel, NATURALEZA_LABEL, OPERATION_PAGE, TIPO_LABEL,
  type OperationEstado, type OperationFilter, type OperationNature, type OperationRow, type OperationTipo, type PendienteFactura, type TimelineEvent,
} from '../../target/operations';
import { formatearFechaLocal, getTodayDate } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';
import type { FinancialAccountRow } from '../../target/masters';
import { Comprobantes } from './Comprobantes';
import { campoEditableEnFila, clasificableEnFila, EditorCelda, socioEditableEnFila, type CampoFila } from './EdicionEnFila';
import { ChipEtiqueta } from './Etiquetas';
import { anulable, ModalesGasto, useGastoItems, vinculosDe, type Accion } from './Gastos';
import { PagosDelGasto } from './GastosAPagar';
import { AccionGastoSinClasificar } from './GastosSinClasificar';
import { DetalleFactura } from './PagosFacturas';
import type { GastoItem } from '../../target/expenseHub';
import { useEtiquetas, useEtiquetasDeGastos } from './useEtiquetas';
import { campo, etiqueta, Modal } from './Modal';
import { ImpuestoModal, ImpuestoPorPeriodo, TransferenciaModal, TransferenciasAnticipadas, VincularAnticipada } from './Transferencias';
import { useComprobantesDeGastos, usePurchaseAttachments } from './useInvoicePayments';
import type { FeedPurchase, FeedPurchaseExtra } from '../../target/alimento';
import { useOperationList, useOperationTimeline, usePayFromRow } from './useOperations';
import { useAnnulExpense, usePagosRevertidos, useRevertirPago } from './useExpenses';
import { useEstadoGuardado } from './useEstadoGuardado';
import { useAllExpenseSubcategories, useExpenseCategories, useExpenseGroups, useMovementList, usePurchase, useSuppliers, useTransferIntents } from './useTreasury';
import { useProfileEmails } from './useUnclassified';
import { NumeroInput } from '../../components/NumeroInput';
import { usePendingSummary, usePurchaseMpLinks, useSettlePurchaseMp } from './useMpActivity';
import type { MpOutflowCandidate, PurchaseMpLinkRow } from '../../target/purchaseMpLink';
import { mandatoryPending } from '../../target/pendingClassification';
import { FiltroColumna, OpcionesFiltro } from '../../components/FiltroColumna';
import { KgModal, useComprasDeInsumos } from '../production/alimento/Insumos';

const CHIP = 'text-xs px-2 py-0.5 rounded whitespace-nowrap';
const TONO_ESTADO: Record<OperationEstado, string> = { PENDIENTE: 'bg-amber-100 text-amber-900', COMPLETADA: 'bg-green-100 text-green-800' };
const TONO_TIPO: Record<OperationTipo, string> = { INGRESO: 'text-green-800', EGRESO: 'text-red-800', TRANSFERENCIA: 'text-sky-800' };
const NADA = '—';
const TD = 'px-1.5 py-1.5 whitespace-nowrap';

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
  comprobante: 'CON' | 'SIN' | '';   // 0137: expenses with / without an invoice number or file
}
export const FILTROS_VACIOS: Filtros = {
  desde: '', hasta: '', tipo: '', cuenta: '', estado: '', grupo: '', subcategoria: '', naturaleza: '', proveedor: '', buscar: '', orden: 'FECHA', etiqueta: '', comprobante: '',
};
/** The server filter of a set of owner filters ("SIN" = Sin asignar). */
export function filtroServidor(f: Filtros, recientes: boolean): OperationFilter {
  return {
    from: f.desde || undefined, to: f.hasta || undefined, tipo: f.tipo || undefined, accountId: f.cuenta && f.cuenta !== 'SIN' ? f.cuenta : undefined,
    sinCuenta: f.cuenta === 'SIN', estado: f.estado || undefined, groupId: f.grupo || undefined, categoryId: f.subcategoria || undefined,
    nature: f.naturaleza || undefined, supplierId: f.proveedor || undefined, search: f.buscar || undefined, order: recientes ? 'CARGA' : f.orden,
    tagId: f.etiqueta && f.etiqueta !== 'SIN' ? f.etiqueta : undefined, sinEtiqueta: f.etiqueta === 'SIN',
    comprobante: f.comprobante || undefined,
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
export function TodasLasOperaciones({ cuentas, cuentaId, onCuenta, focus: foco, onFocus, onResolver }: {
  cuentas: FinancialAccountRow[]; cuentaId: string; onCuenta: (id: string) => void; focus: string | null; onFocus: (key: string | null) => void;
  /** owner 2026-11-25: opens «Pendientes de clasificar» (Movimientos) from the banner of what is left to review */
  onResolver?: () => void;
}) {
  // owner 2026-11-24: the filters, the search and the page survive a change of tab or section (a saved set gains any newer filter empty)
  const [f, setF] = useEstadoGuardado<Filtros>('caja.operaciones.filtros', () => ({ ...FILTROS_VACIOS, cuenta: cuentaId }), (g) => ({ ...FILTROS_VACIOS, ...g }));
  const [texto, setTexto] = useEstadoGuardado('caja.operaciones.texto', '');
  const tags = useEtiquetasDeGastos();   // 0127: purchase id → its tag (the column «Etiqueta»)
  const [pagina, setPagina] = useEstadoGuardado('caja.operaciones.pagina', 0);
  // owner 2026-11-27: «⋯» is a short menu of the row's other actions (no detail window: its information is already in the table)
  const [mas, setMas] = useState<{ r: OperationRow; x: number; y: number } | null>(null);
  const [panel, setPanel] = useState<PanelFila | null>(null);
  const [accionGasto, setAccionGasto] = useState<Accion | null>(null);
  const [revertir, setRevertir] = useState<OperationRow | null>(null);   // 0130
  const revertidos = usePagosRevertidos();
  const [anular, setAnular] = useState<OperationRow | null>(null);   // owner 2026-11-18: Anular retiro
  const compensados = useQuery({ queryKey: ['treasury', 'retiros-compensados'], queryFn: () => listCompensatedAmounts(supabase) });   // owner 2026-11-17: the full detail opens in a window («⋯»)
  const [editando, setEditando] = useState<{ fila: string; campo: CampoFila } | null>(null);   // owner 2026-11-17: in-row editing
  const [pagar, setPagar] = useState<OperationRow | null>(null);
  const [historial, setHistorial] = useState<OperationRow | null>(null);
  const [transfiriendo, setTransfiriendo] = useState(false);
  const [aviso, setAviso] = useState<{ texto: string; clave: string | null } | null>(null);
  const grupos = useExpenseGroups();
  const subcategorias = useAllExpenseSubcategories();
  const etiquetas = useEtiquetas();   // 0127
  // owner 2026-11-26: an invoice with several feed ingredients shows them all in Subcategoría («Maíz + Soja»), not only its own category
  const insumosPorRaiz = useComprasDeInsumos();
  const nombreSub = new Map((subcategorias.data ?? []).map((x) => [x.id, x.nombre]));
  const insumosDe = (r: OperationRow) => {
    const filasCompra = r.purchase_id ? insumosPorRaiz.get(r.purchase_root_id ?? r.purchase_id) : undefined;
    return filasCompra && filasCompra.length > 1 ? filasCompra.map((c) => nombreSub.get(c.expense_category_id) ?? c.ingredient_nombre).join(' + ') : undefined;
  };
  // the account cards above filter the same list: kept in step with them
  const filtros = { ...f, cuenta: f.cuenta === 'SIN' ? 'SIN' : cuentaId };
  // 'RECIENTES': the just-recorded operation is not a row yet (Mercado Pago): the list by loading time instead of one row
  const recientes = foco === 'RECIENTES';
  const focus = recientes ? null : foco;
  const lista = useOperationList(filtroServidor(filtros, recientes), pagina, focus);
  const filas = lista.data?.rows ?? [];
  // owner 2026-11-25: an unclassified Mercado Pago outflow suggests the expense already recorded as paid with Mercado Pago of its amount
  const gastosMp = usePurchaseMpLinks();
  const sugeridos = new Map<string, PurchaseMpLinkRow[]>();
  for (const g of gastosMp.data ?? []) if (g.status === 'PENDIENTE_VINCULACION_MP') for (const k of g.candidates ?? []) sugeridos.set(k.source_id, [...(sugeridos.get(k.source_id) ?? []), g]);
  const [vinculando, setVinculando] = useState<ParMp[] | null>(null);
  // the pairs of an outflow (its pending MP expenses) and of an expense (its outflows): the same link from either row
  const paresDeSalida = (r: OperationRow): ParMp[] => (r.mp_source_id
    ? (sugeridos.get(r.mp_source_id) ?? []).flatMap((g) => (g.candidates ?? []).filter((c) => c.source_id === r.mp_source_id).map((c) => ({ gasto: g, salida: c }))) : []);
  const paresDeGasto = (r: OperationRow): ParMp[] => {
    const g = r.row_kind === 'MP_PENDIENTE' ? (gastosMp.data ?? []).find((x) => x.status === 'PENDIENTE_VINCULACION_MP' && x.purchase_root_id === r.purchase_root_id) : undefined;
    return g ? (g.candidates ?? []).map((c) => ({ gasto: g, salida: c })) : [];
  };
  const resumenMp = usePendingSummary();
  const salidasActuales = resumenMp.data ? mandatoryPending(resumenMp.data).current : 0;
  const esperando = (gastosMp.data ?? []).filter((g) => g.status === 'PENDIENTE_VINCULACION_MP').length;
  const conPar = (gastosMp.data ?? []).filter((g) => g.status === 'PENDIENTE_VINCULACION_MP' && (g.candidates ?? []).length > 0).length;
  // 0142 (owner 2026-11-26): the ones with no Mercado Pago outflow to link — usually a duplicate of an outflow already classified
  const sinPar = (gastosMp.data ?? []).filter((g) => g.status === 'PENDIENTE_VINCULACION_MP' && (g.candidates ?? []).length === 0);
  const [anulandoMp, setAnulandoMp] = useState<PurchaseMpLinkRow | null>(null);
  const comprobantes = useComprobantesDeGastos(filas.flatMap((r) => (r.purchase_id ? [{ purchase_id: r.purchase_id, purchase_root_id: r.purchase_root_id ?? r.purchase_id }] : [])));
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
  const TH = 'px-1.5 py-1.5 font-medium whitespace-nowrap';
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
      <th className={`${TH} w-full`}>
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
      <th className={TH}>{opcion('Cuenta', filtros.cuenta, (v) => poner({ cuenta: v }), [{ v: 'SIN', t: 'Sin asignar' }, ...cuentas.map((c) => ({ v: c.id, t: c.nombre }))], 'Todas')}</th>
      <th className={`${TH} text-right`}>Importe</th>
      <th className={TH}>{opcion('Estado', filtros.estado, (v) => poner({ estado: v as Filtros['estado'] }),
        [{ v: 'PENDIENTE', t: 'Pendientes' }, { v: 'COMPLETADA', t: 'Pagadas / cobradas / realizadas' }, { v: 'POR_REVISAR', t: 'Por revisar' }])}</th>
      {/* owner 2026-11-18: Etiqueta between Estado and Acciones */}
      <th className={TH}>{opcion('Etiqueta', filtros.etiqueta, (v) => poner({ etiqueta: v }), [{ v: 'SIN', t: 'Sin etiqueta' }, ...(etiquetas.data ?? []).map((e) => ({ v: e.id, t: e.nombre }))], 'Todas')}</th>
      {/* owner 2026-11-24: the invoice number and the uploaded invoice / receipt of each expense, in its own column */}
      <th className={TH}>{opcion('Factura / comprobante', filtros.comprobante, (v) => poner({ comprobante: v as Filtros['comprobante'] }),
        [{ v: 'CON', t: 'Con comprobante' }, { v: 'SIN', t: 'Sin comprobante' }])}</th>
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

      {/* owner 2026-11-25: what is left to review, always in sight (only the current ones; the historical stay in Por resolver) */}
      {(salidasActuales > 0 || esperando > 0) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-orange-300 bg-orange-50 px-3 py-2 text-sm text-orange-900" role="status">
          <span className="font-semibold">Por revisar:</span>
          {salidasActuales > 0 && <span>{salidasActuales} salida{salidasActuales === 1 ? '' : 's'} de Mercado Pago sin clasificar</span>}
          {esperando > 0 && <span>{esperando} gasto{esperando === 1 ? '' : 's'} pagado{esperando === 1 ? '' : 's'} con Mercado Pago esperando su movimiento</span>}
          {conPar > 0 && <span className="text-emerald-800">· {conPar === 1 ? '1 ya tiene' : `${conPar} ya tienen`} su par: tocá «Vincular» (verde) en la fila</span>}
          {onResolver && salidasActuales > 0 && <button type="button" onClick={onResolver} className="ml-auto text-xs px-2 py-1 rounded bg-orange-600 text-white hover:bg-orange-700">Resolver ›</button>}
          {sinPar.map((g) => (
            <div key={g.purchase_root_id} className="w-full flex flex-wrap items-center gap-2 border-t border-orange-200 pt-1 text-xs">
              <span><b>{g.concept ?? 'Gasto'}</b> · {formatearFechaLocal(g.economic_date)} · {formatoPesos(g.amount_total)} · cargado {g.origin === 'WHATSAPP' ? 'por WhatsApp' : 'en el ERP'} el {formatearFechaLocal(g.created_at.slice(0, 10))}:
                no hay ninguna salida de Mercado Pago libre que coincida. Si esa salida ya la clasificaste como gasto, este es un duplicado.</span>
              <button type="button" onClick={() => onFocus(`MP_PENDIENTE:${g.purchase_root_id}`)} className="px-2 py-0.5 rounded bg-white border border-orange-300 hover:bg-orange-100">Ver</button>
              <button type="button" onClick={() => setAnulandoMp(g)} className="px-2 py-0.5 rounded bg-orange-600 text-white hover:bg-orange-700">Anular (duplicado)</button>
            </div>
          ))}
        </div>
      )}
      {anulandoMp && <AnularEsperandoMpModal g={anulandoMp} onClose={() => setAnulandoMp(null)}
        onListo={(t) => { setAnulandoMp(null); setAviso({ texto: t, clave: null }); }} />}
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
                  <tr><td colSpan={12}className="px-3 py-4 text-sm text-[#8A7A5C]">
                    {focus ? 'La operación todavía no aparece. Probá con “Cargadas recientemente”.' : 'No hay operaciones con estos filtros.'}
                  </td></tr>
                )}
                {filas.map((r) => (
                  <Fila key={r.row_key} r={r} pares={clasificableEnFila(r) ? paresDeSalida(r) : paresDeGasto(r)}
                    onVincular={setVinculando} insumos={insumosDe(r)} etiqueta={r.purchase_id ? tags.data?.get(r.purchase_id)?.nombre : undefined} destacada={focus === r.row_key}
                    comprobante={r.purchase_id ? comprobantes.data?.get(r.purchase_root_id ?? r.purchase_id) : undefined}
                    onPagar={() => setPagar(r)} onHistorial={() => setHistorial(r)} onMas={(b) => setMas({ r, x: b.right, y: b.bottom })}
                    revertido={r.retiro ? retiroAnulado(r, compensados.data) : r.operation_id !== null && !!revertidos.data?.has(r.operation_id)}
                    revertible={r.retiro ? retiroAnulable(r, cuentas, compensados.data)
                      : pagoRevertible(r, cuentas) && !(r.operation_id !== null && revertidos.data?.has(r.operation_id))}
                    onRevertir={() => (r.retiro ? setAnular(r) : setRevertir(r))}
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
      {vinculando && <VincularSugeridoModal pares={vinculando} onClose={() => setVinculando(null)}
        onListo={(t) => { setVinculando(null); setAviso({ texto: t, clave: null }); }} />}
      {revertir && <RevertirPagoModal r={revertir} onClose={() => setRevertir(null)} onListo={(t) => { setRevertir(null); setAviso({ texto: t, clave: null }); }} />}
      {anular && <AnularRetiroModal r={anular} compensado={(anular.retiro && compensados.data?.get(anular.retiro.event_id)) || 0}
        onClose={() => setAnular(null)} onListo={(t) => { setAnular(null); setAviso({ texto: t, clave: null }); }} />}
      {mas && <MenuMas r={mas.r} x={mas.x} y={mas.y} onClose={() => setMas(null)} onAccion={setAccionGasto} onPanel={setPanel} />}
      {panel?.tipo === 'kg' ? <KgModal filas={panel.filas} onClose={() => setPanel(null)} />
        : panel?.tipo === 'impuesto' ? <ImpuestoModal transferencia={panel.op} onClose={() => setPanel(null)} />
          : panel && (
            <Modal titulo={panel.titulo} onClose={() => setPanel(null)} puedeGuardar guardando={false} error={null} textoGuardar="Cerrar" onSubmit={() => setPanel(null)}>
              <PanelDeFila p={panel} onAccion={(a) => { setPanel(null); setAccionGasto(a); }} />
            </Modal>
          )}
      <ModalesGasto accion={accionGasto} onClose={() => setAccionGasto(null)} />
    </div>
  );
}

/** ONE line: Fecha | Tipo | Concepto | Categoría | Subcategoría | Naturaleza | Cuenta | Importe | Estado | Etiqueta | Factura / comprobante | Acciones. No drop-down
 * (owner 2026-11-17): an expense is corrected in its cells (double click), an unclassified Mercado Pago outflow is classified from its
 * subcategory cell; Acciones: Registrar pago, the invoice, the history and «⋯» (the full detail: supplier / invoice number, rectify
 * items, annul, payments, cheques, transfer, transfer). An unclassified Mercado Pago outflow is classified only from its cell. */
function Fila({ r, pares, onVincular, insumos, etiqueta, destacada, comprobante, onPagar, onHistorial, onMas, editando, onEditar, revertible, revertido, onRevertir }: {
  r: OperationRow; pares: ParMp[]; onVincular: (pares: ParMp[]) => void; insumos?: string; etiqueta?: string; destacada: boolean; comprobante: FeedPurchaseExtra | undefined; onPagar: () => void; onHistorial: () => void;
  onMas: (boton: DOMRect) => void; editando: CampoFila | null; onEditar: (campo: CampoFila | null) => void; revertible: boolean; revertido: boolean; onRevertir: () => void;
}) {
  const pagable = pagableDesdeFila(r);
  const clasificable = clasificableEnFila(r);
  const retiro = socioEditableEnFila(r);   // 0133: a partner withdrawal — its socio from the Categoría / Subcategoría cell
  const celda = (campo: CampoFila, contenido: React.ReactNode) => (editando === campo ? <EditorCelda r={r} campo={campo} onFin={() => onEditar(null)} /> : contenido);
  const puede = (campo: CampoFila) => campoEditableEnFila(r, campo) || ((clasificable || retiro) && campo === 'categoria');
  const alDoble = (campo: CampoFila) => (puede(campo)
    ? { onDoubleClick: () => onEditar(campo), title: clasificable ? 'Doble clic para clasificar el egreso' : retiro ? 'Doble clic para elegir el socio' : 'Doble clic para editar' } : {});
  const cls = (campo: CampoFila) => (puede(campo) ? ' cursor-text hover:bg-amber-100/50' : '');
  const importe = r.tipo === 'TRANSFERENCIA' ? formatoPesos(Math.abs(r.amount)) : `${r.amount < 0 ? '−' : '+'} ${formatoPesos(Math.abs(r.amount))}`;
  const icono = 'p-1 rounded text-[#A8552E] hover:bg-amber-50';
  return (
    <tr className={`border-b border-[#EFE8D6] ${destacada ? 'bg-sky-50' : ''}`}>
      <td className={`${TD}${cls('fecha')}`} {...alDoble('fecha')}>{celda('fecha', r.date ? formatearFechaLocal(r.date) : NADA)}</td>
      <td className={`${TD} font-semibold ${TONO_TIPO[r.tipo]}`}>{TIPO_LABEL[r.tipo]}</td>
      <td className={`px-1.5 py-1.5 min-w-[12rem] ${editando === 'concepto' ? '' : 'max-w-0 truncate'}${cls('concepto')}`} title={r.concepto} {...alDoble('concepto')}>
        {celda('concepto', <span className="font-medium text-[#2C2419]">{chequeDebitado(r) && <span className={`${CHIP} mr-1 bg-slate-100 text-slate-700 font-normal`} title="Débito en el banco de un cheque / eCheq propio; el concepto es el gasto o la factura que pagó">Cheque debitado</span>}{r.concepto || NADA}</span>)}</td>
      <td className={`${TD} max-w-[10rem] ${editando === 'categoria' ? '' : 'truncate'}${cls('categoria')}`} title={r.category ?? undefined} {...alDoble('categoria')}>
        {editando === 'categoria' ? null : (r.category ?? (clasificable ? <span className="text-xs text-orange-800">Sin clasificar</span> : retiro ? 'Retiros de socios' : NADA))}</td>
      <td className={`${TD} ${editando === 'categoria' ? '' : 'max-w-[10rem] truncate'}${cls('categoria')}`} title={insumos ? `Una factura con varios insumos: ${insumos}` : r.subcategory ?? undefined} {...alDoble('categoria')}>
        {celda('categoria', insumos ?? r.subcategory ?? (retiro ? <span className="text-xs text-orange-800">Sin socio</span> : NADA))}</td>
      <td className={`${TD}${cls('naturaleza')}`} {...alDoble('naturaleza')}>{celda('naturaleza', r.nature ? NATURALEZA_LABEL[r.nature] : NADA)}</td>
      <td className={`${TD} max-w-[12rem] truncate`}>{r.accounts.length === 0 ? <span className="text-[#8A7A5C] italic">Sin asignar</span> : cuentasLabel(r)}</td>
      <td {...alDoble('importe')} className={`${TD} text-right font-bold${cls('importe')} ${r.informativo ? 'text-[#8A7A5C] font-normal' : r.tipo === 'INGRESO' ? 'text-green-800' : r.tipo === 'EGRESO' ? 'text-red-800' : 'text-[#2C2419]'}`}
        title={r.informativo ? 'Ya está en Mercado Pago como movimiento sin clasificar: no se cuenta dos veces' : undefined}>
        {celda('importe', r.informativo ? `(${importe})` : importe)}
        {/* owner 2026-11-25: a pending row is what is still to pay; the amount recorded (the invoice / expense total) is shown under it */}
        {r.pendiente && editando !== 'importe' && Math.abs(r.pendiente.total - Math.abs(r.amount)) > 0.005 && (
          <span className="block text-[11px] font-normal text-[#8A7A5C] whitespace-nowrap">de {formatoPesos(r.pendiente.total)} cargado</span>
        )}
      </td>
      <td className={TD}>
        <span className="flex items-center gap-1">
          {enCheques(r)
            ? <span className={`${CHIP} bg-sky-100 text-sky-900`} title="Cubierta con cheques / eCheqs: la deuda con el proveedor ya está saldada; falta que se debiten del banco">En cheques · por debitar</span>
            : <span className={`${CHIP} ${TONO_ESTADO[r.estado]}`}>{estadoLabel(r)}</span>}
          {r.clasificacion && <span className={`${CHIP} bg-orange-100 text-orange-900`} title={CLASIFICACION_LABEL[r.clasificacion]}>Por revisar</span>}
          {pares.length > 0 && (
            <button type="button" onClick={() => onVincular(pares)} className={`${CHIP} bg-emerald-100 text-emerald-900 hover:bg-emerald-200 whitespace-nowrap`}
              title={`Es el mismo pago: ${pares.map((p) => (r.row_kind === 'MP_PENDIENTE' ? `salida de Mercado Pago del ${formatearFechaLocal(p.salida.date)} por ${formatoPesos(p.salida.amount)}` : descripcionSugerido(p.gasto))).join(' / ')}`}>
              {r.row_kind === 'MP_PENDIENTE' ? 'Vincular con salida ›' : 'Vincular con gasto ›'}</button>
          )}
          {revertido && (r.retiro
            ? <span className={`${CHIP} bg-stone-200 text-stone-700`} title="El retiro se anuló: el dinero volvió a la cuenta">Retiro anulado</span>
            : <span className={`${CHIP} bg-stone-200 text-stone-700`} title="El pago se revirtió: el gasto volvió a pendiente y el dinero a la cuenta">Pago revertido</span>)}
        </span>
      </td>
      <td className={`${TD}${cls('etiqueta')}`} {...alDoble('etiqueta')}>
        {celda('etiqueta', r.purchase_id ? (etiqueta ? <ChipEtiqueta nombre={etiqueta} /> : <span className="text-xs text-[#8A7A5C]">Sin etiqueta</span>) : NADA)}</td>
      <td className={TD}>
        {comprobante && (comprobante.numero || comprobante.docs.length > 0) ? (
          <span className="flex items-center gap-1">
            {comprobante.numero && <span className="text-xs text-[#2C2419] max-w-[8rem] truncate" title={`Factura ${comprobante.numero}`}>{comprobante.numero}</span>}
            <Comprobantes docs={comprobante.docs} compacto />
          </span>
        ) : r.purchase_id ? <span className="text-xs text-[#8A7A5C]">Sin comprobante</span> : NADA}
      </td>
      <td className={TD}>
        <span className="flex items-center gap-1">
          {revertible && (r.retiro
            ? <button type="button" onClick={onRevertir} title="Anular retiro (el dinero vuelve a la cuenta)" aria-label="Anular retiro" className={icono}><Undo2 className="w-4 h-4" /></button>
            : <button type="button" onClick={onRevertir} title="Revertir pago (vuelve a pendiente)" aria-label="Revertir pago" className={icono}><Undo2 className="w-4 h-4" /></button>)}
          {pagable !== null && <button type="button" onClick={onPagar} className="text-xs px-2 py-1 rounded bg-amber-600 text-white hover:bg-amber-700">Registrar pago</button>}
          <button type="button" onClick={onHistorial} title="Historial de cambios" aria-label="Historial de cambios" className={icono}><History className="w-4 h-4" /></button>
          {tieneMas(r) && <button type="button" onClick={(e) => onMas(e.currentTarget.getBoundingClientRect())} title="Más acciones" aria-label="Más acciones" aria-haspopup="menu" className={icono}><MoreHorizontal className="w-4 h-4" /></button>}
        </span>
      </td>
    </tr>
  );
}

type ItemFactura = Extract<GastoItem, { kind: 'FACTURA' }>;
type PanelFila =
  | { tipo: 'factura'; titulo: string; it: ItemFactura }
  | { tipo: 'pagosGasto'; titulo: string; payableId: string }
  | { tipo: 'clasificar'; titulo: string; pendingId: number }
  | { tipo: 'anticipada'; titulo: string; id: number }
  | { tipo: 'impuesto'; titulo: string; op: MovementRow }
  | { tipo: 'kg'; titulo: string; filas: FeedPurchase[] };

/** Rows that can have an action besides the ones in the row: an expense / invoice, an expense to classify, a transfer. */
const tieneMas = (r: OperationRow) => r.purchase_id !== null || r.pending_class_id !== null || r.tipo === 'TRANSFERENCIA' || r.row_kind === 'TRANSFERENCIA';

/**
 * Owner 2026-11-27: «⋯» opens a short menu with only the actions this row allows (they lived in a detail window that repeated the
 * table): Editar (supplier, invoice…), Rectificar ítems, kilos of feed ingredients, an invoice's cheques and payments, the payments of
 * a pending expense, classify an expense, the anticipated transfer, the tax of a transfer, Anular. Each one opens its existing form.
 */
function MenuMas({ r, x, y, onClose, onAccion, onPanel }: {
  r: OperationRow; x: number; y: number; onClose: () => void; onAccion: (a: Accion) => void; onPanel: (p: PanelFila) => void;
}) {
  const gastos = useGastoItems();
  const it = r.purchase_id !== null ? gastos.todos.find((g) => g.purchaseId === r.purchase_id) : undefined;
  const compra = usePurchase(it && it.kind !== 'SIN_CLASIFICAR' ? it.purchaseId : null);
  const porRaiz = useComprasDeInsumos();
  const transferencia = r.tipo === 'TRANSFERENCIA' && r.operation_id !== null;
  const mov = useMovementList({ search: transferencia ? String(r.operation_id) : '__ninguna__' }, 0);
  const op = transferencia ? (mov.data?.rows ?? []).find((m): m is MovementRow => m.row_type === 'OP' && m.operation_id === r.operation_id) : undefined;
  const c = compra.data;
  const titulo = r.concepto || 'Operación';
  const items: { label: string; peligro?: boolean; run: () => void }[] = [];
  if (it && c) {
    items.push({ label: 'Editar (proveedor, factura y más)', run: () => onAccion({ tipo: 'editar', compra: c, vinculos: vinculosDe(it, c) }) });
    if (c.supplier_id && c.lineas.length > 0 && !c.fiscal_document_id) items.push({ label: 'Rectificar ítems', run: () => onAccion({ tipo: 'rectificar', compra: c }) });
  }
  const filasKg = porRaiz.get(r.purchase_root_id ?? r.purchase_id ?? '');
  if (filasKg && filasKg.length > 0) {
    items.push({ label: filasKg.some((f) => f.quantity_kg === null) ? 'Cargar kilos de los insumos' : 'Kilos de los insumos (o desglosar)', run: () => onPanel({ tipo: 'kg', titulo, filas: filasKg }) });
  }
  if (it?.kind === 'FACTURA') items.push({ label: 'Cheques y pagos de la factura', run: () => onPanel({ tipo: 'factura', titulo: `Factura — ${titulo}`, it }) });
  if (it?.kind === 'A_PAGAR' && it.gasto.paid > 0) items.push({ label: 'Pagos realizados', run: () => onPanel({ tipo: 'pagosGasto', titulo: `Pagos — ${titulo}`, payableId: it.gasto.payable_id }) });
  if (r.pending_class_id !== null && r.purchase_id === null) {
    const id = r.pending_class_id;
    items.push({ label: 'Clasificar el gasto', run: () => onPanel({ tipo: 'clasificar', titulo: `Clasificar — ${titulo}`, pendingId: id }) });
  }
  if (r.row_kind === 'TRANSFERENCIA' && r.ref_id !== null) {
    const id = r.ref_id;
    items.push({ label: 'Vincular o cancelar la transferencia anticipada', run: () => onPanel({ tipo: 'anticipada', titulo: `Transferencia anticipada — ${titulo}`, id }) });
  }
  if (op && op.kind === 'TRANSFERENCIA' && (op.related_taxes ?? []).length === 0) items.push({ label: 'Agregar el impuesto cobrado', run: () => onPanel({ tipo: 'impuesto', titulo, op }) });
  if (it && c && anulable(it)) items.push({ label: 'Anular el gasto', peligro: true, run: () => onAccion({ tipo: 'anular', compra: c }) });
  const cargando = gastos.cargando || compra.isLoading || (transferencia && mov.isLoading);
  const ancho = 272;
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden />
      <div role="menu" aria-label="Más acciones" onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
        className="fixed z-50 bg-white border border-[#E4DCC8] rounded-lg shadow-lg py-1 text-sm"
        style={{ width: ancho, left: Math.max(8, Math.min(x - ancho, window.innerWidth - ancho - 8)), top: Math.min(y + 4, window.innerHeight - 260) }}>
        {cargando ? <p className="px-3 py-2 text-xs text-gray-500">Cargando…</p>
          : items.length === 0 ? <p className="px-3 py-2 text-xs text-[#8A7A5C]">No hay otras acciones para esta fila.</p>
            : items.map((i, k) => (
              <button key={i.label} type="button" role="menuitem" autoFocus={k === 0} onClick={() => { onClose(); i.run(); }}
                className={`block w-full text-left px-3 py-1.5 hover:bg-amber-50 focus:bg-amber-50 focus:outline-none ${i.peligro ? 'text-red-700' : 'text-[#2C2419]'}`}>{i.label}</button>
            ))}
      </div>
    </>
  );
}

/** The one form a menu entry opens (the ones that are not a window of their own). */
function PanelDeFila({ p, onAccion }: { p: PanelFila; onAccion: (a: Accion) => void }) {
  if (p.tipo === 'factura') return <PanelFactura it={p.it} onAccion={onAccion} />;
  if (p.tipo === 'pagosGasto') return <div className="p-3"><PagosDelGasto payableId={p.payableId} /></div>;
  if (p.tipo === 'clasificar') return <div className="p-3"><AccionGastoSinClasificar pendingId={p.pendingId} /></div>;
  if (p.tipo === 'anticipada') return <PanelAnticipada id={p.id} />;
  return null;
}
function PanelFactura({ it, onAccion }: { it: ItemFactura; onAccion: (a: Accion) => void }) {
  const adjuntos = usePurchaseAttachments(it.purchaseId ? [it.purchaseId] : []);
  const docs = it.purchaseId ? adjuntos.data?.get(it.purchaseId) : undefined;
  return <DetalleFactura f={it.factura} docs={docs} onEmitir={(reemplaza) => onAccion({ tipo: 'emitir', f: it.factura, reemplaza })} onImputar={() => onAccion({ tipo: 'imputar', f: it.factura })} />;
}
function PanelAnticipada({ id }: { id: number }) {
  const q = useTransferIntents();
  const intent = (q.data ?? []).find((x) => x.id === id);
  if (q.isLoading) return <p className="p-3 text-xs text-gray-500">Cargando…</p>;
  return intent ? <div className="p-3"><VincularAnticipada f={intent} onCerrar={() => undefined} /></div> : <p className="p-3 text-xs text-[#8A7A5C]">La transferencia anticipada ya no está pendiente.</p>;
}

/** 0130: the payment row of an expense WITHOUT supplier paid from cash / bank (the backend checks the same and more). */
export function pagoRevertible(r: OperationRow, cuentas: FinancialAccountRow[]): boolean {
  if (r.row_kind !== 'OP' || r.tipo !== 'EGRESO' || r.estado !== 'COMPLETADA' || !r.purchase_id || r.supplier_id || r.operation_id === null || r.informativo) return false;
  return r.accounts.length === 1 && cuentas.some((c) => c.id === r.accounts[0].account_id && (c.account_type === 'CASH' || c.account_type === 'BANK_ACCOUNT'));
}

/**
 * 0142 (owner 2026-11-26): annul an expense recorded as paid with Mercado Pago that has no outflow to link — the duplicate of an outflow
 * already classified (annul_expense: it leaves the P&L and stops waiting; nothing deleted, audited). A linked one cannot be annulled.
 */
function AnularEsperandoMpModal({ g, onClose, onListo }: { g: PurchaseMpLinkRow; onClose: () => void; onListo: (texto: string) => void }) {
  const anular = useAnnulExpense();
  const qc = useQueryClient();
  const [motivo, setMotivo] = useState('');
  const [clave] = useState(() => `ANUL-MP-${crypto.randomUUID()}`);
  return (
    <Modal titulo={`Anular gasto — ${g.concept ?? 'Gasto'}`} onClose={onClose} puedeGuardar={!anular.isPending} guardando={anular.isPending} error={anular.error}
      textoGuardar="Anular gasto"
      onSubmit={() => anular.mutate({ purchaseId: g.purchase_id, reason: motivo.trim() || 'Duplicado: la salida de Mercado Pago ya se clasificó como gasto', idempotencyKey: clave },
        { onSuccess: () => { void qc.invalidateQueries(); onListo(`Gasto «${g.concept ?? ''}» de ${formatoPesos(g.amount_total)} anulado: sale de los gastos y deja de esperar su movimiento.`); } })}>
      <p className="text-sm text-[#2C2419]">{g.concept ?? 'Gasto'} · {formatearFechaLocal(g.economic_date)} · <b>{formatoPesos(g.amount_total)}</b> · pagado con Mercado Pago, sin movimiento vinculado.</p>
      <p className="text-xs text-[#6B5D45]">Anulalo solo si la salida de Mercado Pago de este pago ya está clasificada como otro gasto (si no, quedaría sin registrar). Sale de los gastos y de resultados; no se borra nada y queda en el historial. Si tenía un comprobante, podés adjuntarlo al otro gasto.</p>
      <label className={etiqueta}>Motivo (opcional)
        <input type="text" value={motivo} onChange={(e) => setMotivo(e.target.value)} maxLength={200} placeholder="Duplicado: la salida de Mercado Pago ya se clasificó como gasto" className={campo} />
      </label>
    </Modal>
  );
}

/** Anular retiro: a compensation of the whole rest (register_management_event, same account and date) — audited, nothing deleted. */
function AnularRetiroModal({ r, compensado, onClose, onListo }: { r: OperationRow; compensado: number; onClose: () => void; onListo: (texto: string) => void }) {
  const qc = useQueryClient();
  const anular = useMutation({
    mutationFn: (p: Parameters<typeof registerManagementEvent>[1]) => registerManagementEvent(supabase, p),
    onSuccess: () => Promise.all([['pnl'], ['treasury'], ['management-events']].map((queryKey) => qc.invalidateQueries({ queryKey }))),
  });
  const [motivo, setMotivo] = useState('');
  const [clave] = useState(() => `ANUL-RET-${crypto.randomUUID()}`);
  const resto = Math.round((Math.abs(r.amount) - compensado) * 100) / 100;
  return (
    <Modal titulo={`Anular retiro — ${r.concepto}`} onClose={onClose} puedeGuardar={!anular.isPending && resto > 0} guardando={anular.isPending} error={anular.error}
      textoGuardar="Anular retiro"
      onSubmit={() => anular.mutate({
        type: 'RETIRO', effectiveDate: r.date!, amount: resto, idempotencyKey: clave, reason: `Anulación: ${motivo.trim() || 'retiro cargado por error'}`.slice(0, 200),
        accountId: r.accounts[0].account_id, compensatesEventId: r.retiro!.event_id,
      }, { onSuccess: () => onListo(`Retiro anulado: ${formatoPesos(resto)} volvió a ${cuentasLabel(r)}. Si había un error, cargalo de nuevo desde «Nuevo gasto».`) })}>
      <p className="text-sm text-[#2C2419]">{formatoPesos(resto)} vuelve a <b>{cuentasLabel(r)}</b> con la fecha del retiro ({r.date ? formatearFechaLocal(r.date) : '—'}).</p>
      <p className="text-xs text-[#6B5D45]">No se borra nada: el retiro y su anulación quedan en el historial. Si el importe o la fecha estaban mal, cargalo de nuevo desde «Nuevo gasto».</p>
      <label className={etiqueta}>Motivo (opcional)
        <input type="text" value={motivo} onChange={(e) => setMotivo(e.target.value)} maxLength={150} placeholder="Ej.: importe mal cargado" className={campo} />
      </label>
    </Modal>
  );
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

const descripcionSugerido = (g: PurchaseMpLinkRow) => [g.origin_code ? `WhatsApp ${g.origin_code}` : null, g.concept ?? 'Gasto', g.category_name, formatearFechaLocal(g.economic_date), formatoPesos(g.amount_total)].filter(Boolean).join(' · ');

/** 0139: an expense recorded as paid with Mercado Pago and an outflow that can be its payment (up to $1 apart). */
type ParMp = { gasto: PurchaseMpLinkRow; salida: MpOutflowCandidate };
const difDe = (p: ParMp) => Math.round((p.salida.difference ?? p.salida.amount - p.gasto.amount_total) * 100) / 100;
const claveDe = (p: ParMp) => `${p.gasto.purchase_id}:${p.salida.source_id}`;

/**
 * Owner 2026-11-25: the link of an expense recorded as paid with Mercado Pago and its real outflow, opened from either row (the backend's
 * candidates, the same as Pendientes de clasificar; up to $1 apart since 0139 — the difference is the rounding of THAT expense).
 * settle_purchase_mp: no second expense, one idempotency key per opened form.
 */
function VincularSugeridoModal({ pares, onClose, onListo }: { pares: ParMp[]; onClose: () => void; onListo: (texto: string) => void }) {
  const vincular = useSettlePurchaseMp();
  const [elegido, setElegido] = useState(pares.length === 1 ? claveDe(pares[0]) : '');
  const [clave] = useState(() => `PURCHASE-MP-${crypto.randomUUID()}`);   // idempotency of the link: one per opened form
  const p = pares.find((x) => claveDe(x) === elegido);
  const dif = p ? difDe(p) : 0;
  return (
    <Modal titulo={'Vincular el gasto con su pago de Mercado Pago'} onClose={onClose} puedeGuardar={!!p} guardando={vincular.isPending} error={vincular.error}
      textoGuardar="Vincular" onSubmit={() => { if (!p) return; vincular.mutate({ purchaseId: p.gasto.purchase_id, sourceId: p.salida.source_id, idempotencyKey: clave, reason: 'Vinculación desde Todas las operaciones' },
        { onSuccess: () => onListo(`Gasto «${p.gasto.concept ?? 'Gasto'}» vinculado a su pago de Mercado Pago${dif !== 0 ? ` (redondeo ${formatoPesos(dif)} sumado al gasto)` : ''}: no se cargó otro gasto.`) }); }}>
      <div className="space-y-2" role="radiogroup" aria-label="Gasto y pago a vincular">
        {pares.map((x) => {
          const d = difDe(x);
          return (
            <label key={claveDe(x)} className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm cursor-pointer ${elegido === claveDe(x) ? 'border-amber-600 bg-amber-50' : 'border-[#E4DCC8]'}`}>
              <input type="radio" name="par-mp" checked={elegido === claveDe(x)} onChange={() => setElegido(claveDe(x))} className="mt-1" />
              <span className="space-y-0.5">
                <span className="block">Gasto: {descripcionSugerido(x.gasto)}</span>
                <span className="block">Pago de Mercado Pago del {formatearFechaLocal(x.salida.date)} por {formatoPesos(x.salida.amount)} · Nº {x.salida.source_id}</span>
                {d !== 0 && <span className="block text-xs text-amber-800">Diferencia de redondeo {formatoPesos(d)}: se suma al costo de este gasto.</span>}
              </span>
            </label>
          );
        })}
      </div>
      <p className="text-xs text-[#6B5D45]">El gasto ya está en resultados{p?.gasto.fiscal_document_id ? ' (con su factura e IVA)' : ''}: vincularlo solo registra que se pagó con ese movimiento.
        {p && p.gasto.economic_date !== p.salida.date ? ` El gasto conserva su fecha (${formatearFechaLocal(p.gasto.economic_date)}); el pago queda con la del movimiento.` : ''}</p>
    </Modal>
  );
}

/** An invoice fully covered with own cheques / eCheqs still to be debited: nothing is owed to the supplier, only the bank debit is left. */
const enCheques = (r: OperationRow) => r.row_kind === 'FACTURA' && r.estado === 'PENDIENTE' && !!r.pendiente
  && (r.pendiente as PendienteFactura).cheques_por_debitar > 0 && (r.pendiente as PendienteFactura).sin_cubrir <= 0.005;

/** Owner 2026-11-25: the bank debit of an own cheque / eCheq is named after the expense it paid — the row says it is a cheque debit
 * (a debit not linked to an expense already reads «Cheque … / eCheq …»). */
const chequeDebitado = (r: OperationRow) => r.row_kind === 'OP' && r.detalle === 'Cheque debitado' && !/^(Cheque|eCheq) /.test(r.concepto);
