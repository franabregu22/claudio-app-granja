import { useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { NATURALEZA_GASTO_LABEL, type VinculosGasto } from '../../target/expenses';
import {
  armarGastos, buscar, coincide, contar, GASTO_ESTADO_LABEL, GASTO_FILTROS, ordenar, totalFiltro, type GastoEstado, type GastoFiltro, type GastoItem,
} from '../../target/expenseHub';
import type { PurchasePaymentDetailRow, PurchasePaymentStatusRow } from '../../target/invoicePayments';
import { errorMessage } from '../../target/messages';
import type { PayableRow } from '../../target/payables';
import type { PurchaseRow } from '../../target/treasury';
import { formatearFechaLocal, getTodayDate } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';
import { AsignarFleteModal, Fletes, RectificarCompraModal } from './Compras';
import { Comprobantes } from './Comprobantes';
import { EditarGastoModal, HistorialGasto } from './EditarGasto';
import { EtiquetasFechas, FechasPagoModal } from './FechasPago';
import { PagarGastoModal, PagosDelGasto, usePayables, VincularProveedorModal } from './GastosAPagar';
import { AccionGastoSinClasificar } from './GastosSinClasificar';
import { DetalleFactura, EmitirChequesModal, ImputarPagoModal } from './PagosFacturas';
import { useInvoicePaymentStatus, usePurchaseAttachments } from './useInvoicePayments';
import { usePurchaseMpLinks } from './useMpActivity';
import { useFreight, usePurchase, usePurchases } from './useTreasury';
import { useUnclassifiedOpen } from './useUnclassified';

const PAGINA = 30;
const ESTADO_CLASE: Record<GastoEstado, string> = {
  POR_REVISAR: 'bg-amber-100 text-amber-900', PENDIENTE: 'bg-red-50 text-red-800', CHEQUES: 'bg-sky-50 text-sky-900', PAGADO: 'bg-green-50 text-green-800',
};

type Accion =
  | { tipo: 'emitir'; f: PurchasePaymentStatusRow; reemplaza?: PurchasePaymentDetailRow }
  | { tipo: 'imputar'; f: PurchasePaymentStatusRow }
  | { tipo: 'pagar'; g: PayableRow }
  | { tipo: 'vincular'; g: PayableRow }
  | { tipo: 'fechas'; purchaseId: string; rootId: string; titulo: string; due: string | null; planned: string | null }
  | { tipo: 'rectificar'; compra: PurchaseRow }
  | { tipo: 'editar'; compra: PurchaseRow; vinculos: VinculosGasto }
  | { tipo: 'flete'; purchaseId: string };

/**
 * Cuentas a pagar → Gastos: invoices, pending expenses and purchases in ONE list (src/target/expenseHub.ts), filtered by what is left to
 * do — Por revisar, Pendientes de pago, Cheques pendientes, Pagados, Todos. Each row opens the existing detail and forms of its source:
 * invoice payments and eCheqs (PagosFacturas), pending-expense payments (GastosAPagar), classification (GastosSinClasificar),
 * dates (FechasPago), rectification and freight (Compras). Nothing is computed or written here: the figures are the backend's and
 * every action is the existing RPC, with its idempotency key per opened form.
 */
export function Gastos() {
  const facturasPendientes = useInvoicePaymentStatus(true, 500);   // every invoice still owed, however old
  const facturas = useInvoicePaymentStatus(false, 500);            // and the latest ones, paid or not
  const aPagar = usePayables(false);
  const sinClasificar = useUnclassifiedOpen();
  const mp = usePurchaseMpLinks();
  const compras = usePurchases(500);
  const fletes = useFreight();
  const [filtro, setFiltro] = useState<GastoFiltro>('PENDIENTE');
  const [texto, setTexto] = useState('');
  const [mostrar, setMostrar] = useState(PAGINA);
  const [abierto, setAbierto] = useState<string | null>(null);
  const [accion, setAccion] = useState<Accion | null>(null);

  const fuentes = [facturasPendientes, facturas, aPagar, sinClasificar, mp, compras];
  const cargando = fuentes.some((q) => q.isLoading);
  const error = fuentes.find((q) => q.error)?.error;
  const todos = useMemo(() => armarGastos({
    facturas: [...(facturasPendientes.data ?? []), ...(facturas.data ?? [])], aPagar: aPagar.data ?? [], sinClasificar: sinClasificar.data ?? [],
    mp: mp.data ?? [], compras: compras.data ?? [],
  }), [facturasPendientes.data, facturas.data, aPagar.data, sinClasificar.data, mp.data, compras.data]);
  const cuentas = contar(todos);
  const filtrados = ordenar(todos.filter((it) => coincide(it, filtro) && buscar(it, texto)), filtro);
  const visibles = filtrados.slice(0, mostrar);
  const total = totalFiltro(filtrados, filtro);
  const adjuntos = usePurchaseAttachments(visibles.flatMap((it) => (it.purchaseId ? [it.purchaseId] : [])));
  const hoy = getTodayDate();
  const elegir = (f: GastoFiltro) => { setFiltro(f); setMostrar(PAGINA); setAbierto(null); };

  return (
    <div className="space-y-3">
      <div role="tablist" aria-label="Filtros de gastos" className="flex gap-2 overflow-x-auto pb-1">
        {GASTO_FILTROS.map((f) => (
          <button key={f.id} type="button" role="tab" aria-selected={filtro === f.id} onClick={() => elegir(f.id)}
            className={`whitespace-nowrap px-3 py-1 rounded-full text-sm font-medium border ${filtro === f.id ? 'bg-[#A8552E] text-white border-[#A8552E]' : 'bg-white text-[#6B5D45] border-[#E4DCC8] hover:bg-stone-50'}`}>
            {f.label}
            {!cargando && <span className={`ml-1.5 inline-block min-w-5 px-1.5 rounded-full text-xs ${filtro === f.id ? 'bg-white/25' : f.id === 'POR_REVISAR' && cuentas.POR_REVISAR > 0 ? 'bg-amber-500 text-white' : 'bg-stone-100'}`}>{cuentas[f.id]}</span>}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input type="search" value={texto} onChange={(e) => { setTexto(e.target.value); setMostrar(PAGINA); }} placeholder="Buscar proveedor, concepto o factura"
          aria-label="Buscar gastos" className="flex-1 min-w-48 border border-[#E4DCC8] rounded-lg px-3 py-1.5 text-sm bg-white" />
        {total !== null && filtrados.length > 0 && (
          <span className="text-sm">{filtro === 'CHEQUES' ? 'En cheques sin debitar' : 'Total pendiente'}: <b className={filtro === 'CHEQUES' ? 'text-sky-900' : 'text-red-700'}>{formatoPesos(total)}</b></span>
        )}
      </div>
      <p className="text-xs text-[#8A7A5C]">{AYUDA[filtro]}</p>

      {cargando ? <p className="text-sm text-gray-500">Cargando gastos...</p> : (
        <>
          {error ? <p className="text-sm text-red-700">{errorMessage(error)}</p> : null}
          {filtrados.length === 0 ? <p className="text-sm text-[#8A7A5C]">{texto.trim() ? 'Ningún gasto coincide con la búsqueda.' : VACIO[filtro]}</p> : (
            <div className="space-y-2">
              {visibles.map((it) => (
                <div key={it.key} className="bg-white rounded-lg border border-[#E4DCC8]">
                  <button type="button" onClick={() => setAbierto(abierto === it.key ? null : it.key)} aria-expanded={abierto === it.key}
                    className="w-full flex flex-wrap items-center gap-x-2 gap-y-1 p-3 text-left text-sm">
                    <ChevronDown className={`w-4 h-4 shrink-0 transition ${abierto === it.key ? 'rotate-180' : ''}`} />
                    <span className="min-w-0 flex-1">
                      <span className="font-semibold text-amber-900">{it.titulo}</span>
                      <span className="block text-xs text-[#8A7A5C] truncate">{formatearFechaLocal(it.fecha)}{it.detalle ? ` · ${it.detalle}` : ''}</span>
                    </span>
                    <span className="text-right">
                      <span className="block font-bold">{it.pendiente > 0 ? <span className="text-red-700">{formatoPesos(it.pendiente)}</span> : formatoPesos(it.total)}</span>
                      {it.pendiente > 0 && it.pendiente < it.total - 0.005 && <span className="block text-[11px] text-[#8A7A5C]">de {formatoPesos(it.total)}</span>}
                      {it.programado > 0 && <span className="block text-[11px] text-sky-900">{formatoPesos(it.programado)} en cheques</span>}
                    </span>
                    <span className="w-full flex flex-wrap items-center gap-1.5 pl-6">
                      <span className={`text-xs px-2 py-0.5 rounded ${ESTADO_CLASE[it.estado]}`}>{GASTO_ESTADO_LABEL[it.estado]}</span>
                      {it.origen === 'WHATSAPP' && <span className="text-xs px-2 py-0.5 rounded bg-emerald-50 text-emerald-800">WhatsApp</span>}
                      {it.estado === 'PENDIENTE' && <EtiquetasFechas due={it.vence} planned={it.estimada} hoy={hoy} />}
                      {it.purchaseId && <Comprobantes docs={adjuntos.data?.get(it.purchaseId)} compacto />}
                    </span>
                  </button>
                  {abierto === it.key && <DetalleGasto it={it} docs={it.purchaseId ? adjuntos.data?.get(it.purchaseId) : undefined} onAccion={setAccion} />}
                </div>
              ))}
              {filtrados.length > visibles.length && (
                <button type="button" onClick={() => setMostrar((m) => m + PAGINA)} className="w-full text-sm py-2 rounded-lg border border-[#E4DCC8] bg-white hover:bg-stone-50 text-[#A8552E]">
                  Ver más ({filtrados.length - visibles.length} restantes)
                </button>
              )}
            </div>
          )}
        </>
      )}

      <Fletes />

      {accion?.tipo === 'emitir' && <EmitirChequesModal f={accion.f} reemplaza={accion.reemplaza} onClose={() => setAccion(null)} />}
      {accion?.tipo === 'imputar' && <ImputarPagoModal f={accion.f} onClose={() => setAccion(null)} />}
      {accion?.tipo === 'pagar' && <PagarGastoModal gasto={accion.g} onClose={() => setAccion(null)} />}
      {accion?.tipo === 'vincular' && <VincularProveedorModal gasto={accion.g} onClose={() => setAccion(null)} />}
      {accion?.tipo === 'fechas' && <FechasPagoModal purchaseId={accion.purchaseId} rootId={accion.rootId} titulo={accion.titulo} due={accion.due} planned={accion.planned} onClose={() => setAccion(null)} />}
      {accion?.tipo === 'editar' && <EditarGastoModal compra={accion.compra} vinculos={accion.vinculos} onClose={() => setAccion(null)} />}
      {accion?.tipo === 'rectificar' && <RectificarCompraModal compra={accion.compra} onClose={() => setAccion(null)} />}
      {accion?.tipo === 'flete' && <AsignarFleteModal purchaseId={accion.purchaseId} fletes={fletes.data ?? []} onClose={() => setAccion(null)} />}
    </div>
  );
}

const AYUDA: Record<GastoFiltro, string> = {
  POR_REVISAR: 'Gastos ya registrados (muchos desde WhatsApp) a los que les falta un dato: la categoría o el movimiento de Mercado Pago que los pagó.',
  PENDIENTE: 'Gastos y facturas con saldo sin cubrir. Desde cada uno se registra el pago o se emiten los eCheqs.',
  CHEQUES: 'Cubiertos con cheques o eCheqs: la deuda con el proveedor ya bajó; el banco se mueve recién cuando se marca el débito.',
  PAGADO: 'Gastos cubiertos por completo (pagos registrados o cheques debitados).',
  TODOS: 'Todos los gastos, del más reciente al más antiguo.',
};
const VACIO: Record<GastoFiltro, string> = {
  POR_REVISAR: 'No hay gastos por revisar.', PENDIENTE: 'No hay gastos pendientes de pago.', CHEQUES: 'No hay cheques pendientes de débito.',
  PAGADO: 'No hay gastos pagados.', TODOS: 'No hay gastos registrados.',
};
const boton = 'text-xs px-2 py-1 rounded border border-[#E4DCC8] bg-white hover:bg-stone-50';

/** The detail of one row: the existing detail of its source, the purchase lines and the actions its state allows. */
function DetalleGasto({ it, docs, onAccion }: { it: GastoItem; docs: Parameters<typeof Comprobantes>[0]['docs']; onAccion: (a: Accion) => void }) {
  const compra = usePurchase(it.kind === 'SIN_CLASIFICAR' ? null : it.purchaseId);
  const c = compra.data;
  const [historial, setHistorial] = useState(false);
  return (
    <div className="border-t border-[#E4DCC8] bg-[#FAF6EE]">
      {it.kind === 'FACTURA' && (
        <>
          <DetalleFactura f={it.factura} docs={docs} onEmitir={(reemplaza) => onAccion({ tipo: 'emitir', f: it.factura, reemplaza })} onImputar={() => onAccion({ tipo: 'imputar', f: it.factura })} />
          {it.factura.pending > 0.005 && (
            <div className="px-4 pb-2 flex flex-wrap gap-2">
              <button type="button" className={boton} onClick={() => onAccion({ tipo: 'fechas', purchaseId: it.factura.purchase_id, rootId: it.factura.purchase_root_id, titulo: it.titulo, due: it.vence, planned: it.estimada })}>Fechas</button>
            </div>
          )}
        </>
      )}
      {it.kind === 'A_PAGAR' && (
        <div className="px-4 py-2 text-sm space-y-2">
          {docs && docs.length > 0 && <p className="flex items-center gap-2 text-xs">Comprobante: <Comprobantes docs={docs} /></p>}
          {it.gasto.pending > 0.005 ? (
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => onAccion({ tipo: 'pagar', g: it.gasto })} className="text-xs px-3 py-1 bg-amber-600 text-white rounded hover:bg-amber-700">Registrar pago</button>
              <button type="button" className={boton} onClick={() => onAccion({ tipo: 'fechas', purchaseId: it.gasto.purchase_id, rootId: it.gasto.purchase_root_id, titulo: it.titulo, due: it.vence, planned: it.estimada })}>Fechas</button>
              <button type="button" className={boton} onClick={() => onAccion({ tipo: 'vincular', g: it.gasto })}>Vincular a proveedor</button>
            </div>
          ) : null}
          {it.gasto.pending > 0.005 && <p className="text-xs text-[#8A7A5C]">Sin proveedor registrado: para pagarlo con cheque o eCheq, primero vinculalo a un proveedor; queda como factura de ese proveedor.</p>}
          {it.gasto.paid > 0 && <><p className="text-xs text-[#6B5D45]">Pagado {formatoPesos(it.gasto.paid)} de {formatoPesos(it.gasto.amount)}</p><PagosDelGasto payableId={it.gasto.payable_id} /></>}
        </div>
      )}
      {it.kind === 'SIN_CLASIFICAR' && (
        <div className="px-4 py-2"><AccionGastoSinClasificar pendingId={it.sinClasificar.pending_id} /></div>
      )}
      {it.kind === 'MP_PENDIENTE' && (
        <div className="px-4 py-2 text-xs text-[#6B5D45] space-y-1">
          <p>Registrado como pagado con Mercado Pago{it.mp.origin_code ? ` (WhatsApp ${it.mp.origin_code})` : ''}: falta vincular el movimiento real. Ya está en resultados; vincularlo no crea otro gasto.</p>
          <p>{(it.mp.candidates ?? []).length > 0 ? `Hay ${(it.mp.candidates ?? []).length} movimiento(s) de Mercado Pago del mismo importe. ` : ''}Se vincula desde Caja → Movimientos → Por resolver → Pendientes de clasificar.</p>
          {docs && docs.length > 0 && <p className="flex items-center gap-2">Comprobante: <Comprobantes docs={docs} /></p>}
        </div>
      )}
      {it.kind === 'COMPRA' && docs && docs.length > 0 && <p className="px-4 pt-2 flex items-center gap-2 text-xs">Comprobante: <Comprobantes docs={docs} /></p>}
      {it.kind !== 'SIN_CLASIFICAR' && (
        <div className="px-4 pb-3 pt-1 text-xs text-gray-700 space-y-1">
          {compra.isLoading ? <p className="text-gray-500">Cargando detalle...</p> : compra.error ? <p className="text-red-700">{errorMessage(compra.error)}</p> : c ? (
            <>
              <p>{c.subcategory ? <b>{c.subcategory} · </b> : null}{c.categoria_nombre} · {NATURALEZA_GASTO_LABEL[c.nature] ?? c.nature}
                {c.amount_net !== c.amount_total ? ` · Neto ${formatoPesos(c.amount_net)}` : ''}{c.version_seq > 0 ? ' · Rectificada' : ''}</p>
              {c.lineas.map((l) => <p key={l.id}>{l.cantidad} {l.unit_type} · {l.descripcion} · {formatoPesos(l.precio_unitario)} c/u</p>)}
              <span className="flex flex-wrap gap-2 pt-1">
                <button type="button" className="text-xs px-3 py-1 rounded bg-[#A8552E] text-white hover:bg-[#8B4423]" onClick={() => onAccion({ tipo: 'editar', compra: c, vinculos: vinculosDe(it, c) })}>Editar / Rectificar</button>
                {c.supplier_id && c.lineas.length > 0 && !c.fiscal_document_id && <button type="button" className={boton} onClick={() => onAccion({ tipo: 'rectificar', compra: c })}>Rectificar ítems</button>}
                <button type="button" className={boton} onClick={() => onAccion({ tipo: 'flete', purchaseId: c.id })}>Asignar flete</button>
                <button type="button" className={boton} aria-expanded={historial} onClick={() => setHistorial((h) => !h)}>{historial ? 'Ocultar historial' : 'Historial'}</button>
              </span>
              {historial && <HistorialGasto purchaseId={c.id} rootId={raizDe(it)} />}
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}

const raizDe = (it: GastoItem) => (it.kind === 'FACTURA' ? it.factura.purchase_root_id : it.kind === 'A_PAGAR' ? it.gasto.purchase_root_id
  : it.kind === 'MP_PENDIENTE' ? it.mp.purchase_root_id : null);

/** What the row says about the expense's links and how its payment is handled (the edit form explains it; the backend enforces it). */
function vinculosDe(it: GastoItem, c: PurchaseRow): VinculosGasto {
  const estadoPago = GASTO_ESTADO_LABEL[it.estado];
  const noSeDeshace = 'Un pago registrado no se deshace desde aquí (requiere revertir su movimiento).';
  if (it.kind === 'FACTURA') {
    const f = it.factura;
    return { pendienteSinProveedor: false, mpVinculado: false, asignado: f.scheduled + f.debited + f.other_payments, estadoPago,
      comoPagar: f.pending > 0.005 ? `Para pagarla: «Emitir cheques / eCheqs», o pagar desde Proveedores y luego «Imputar pago registrado». ${noSeDeshace}`
        : `Los cheques se debitan, anulan o rechazan desde su fila. ${noSeDeshace}` };
  }
  if (it.kind === 'A_PAGAR') {
    return { pendienteSinProveedor: true, mpVinculado: false, asignado: 0, estadoPago,
      comoPagar: it.gasto.pending > 0.005 ? `Para marcarlo pagado usá «Registrar pago»; para un cheque o eCheq, primero «Vincular a proveedor». ${noSeDeshace}` : noSeDeshace };
  }
  if (it.kind === 'MP_PENDIENTE') {
    return { pendienteSinProveedor: false, mpVinculado: false, asignado: 0, estadoPago: 'Pagado con Mercado Pago (falta vincular el movimiento)',
      comoPagar: 'Se vincula a su movimiento desde Caja → Movimientos → Por resolver.' };
  }
  return { pendienteSinProveedor: false, mpVinculado: !c.supplier_id && !c.paid_operation_id, asignado: 0, estadoPago, comoPagar: noSeDeshace };
}
