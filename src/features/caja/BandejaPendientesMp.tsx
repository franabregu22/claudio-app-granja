import { useState } from 'react';
import { Check } from 'lucide-react';
import { defaultNatureOf, selectableGroups, selectableSubcategories, socios } from '../../target/expenseCategories';
import { errorMessage } from '../../target/messages';
import { isMercadoPagoAccount, type MpPayoutMatch } from '../../target/mpActivity';
import { NATURALEZA_LABEL, type OperationNature } from '../../target/operations';
import { mandatoryPending, PENDING_KIND_LABEL, type MpWhatsappNote, type PendingRow } from '../../target/pendingClassification';
import { type PurchaseMpLinkRow, samePendingAmount } from '../../target/purchaseMpLink';
import { formatearFechaLocal } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';
import { useFinancialAccounts } from '../pedidos/useCommercial';
import { Comprobantes } from './Comprobantes';
import { Paginador, RevisionTecnicaMp } from './PendientesClasificar';
import { useDocumentLinks } from './useInvoicePayments';
import {
  useClassifyMp, useConfirmPayoutTransfer, useMpPayoutMatches, useMpWhatsappNotes, usePendingPage, usePendingSummary, usePurchaseMpLinks, useSettlePurchaseMp,
} from './useMpActivity';
import { useSetWithdrawalSocio } from './useOperations';
import { useExpenseCategories, useExpenseGroups, useLedgerBalances, useSuppliers } from './useTreasury';

/**
 * Owner 2026-11-20 — Caja → Movimientos → Por resolver → Pendientes de clasificar, as a tray: ONE card per Mercado Pago outflow still to
 * classify, and ONE question, «¿Qué fue este pago?». The options are only the ones that apply to that payment:
 *   · «Es un gasto ya cargado» — an expense recorded as paid with Mercado Pago (e.g. from WhatsApp) for this same amount: one click links it
 *     (settle_purchase_mp: only the payment side, no second expense); it is listed first, never chosen automatically;
 *   · «Un gasto nuevo» — subcategory, concept, nature and an optional supplier (EXPENSE / CASUAL_PURCHASE); when an expense of this amount is
 *     already recorded the button itself says it is ANOTHER expense (the explicit confirmation of Lote 4: warn, never block);
 *   · «Pago de deuda a un proveedor» (suppliers with a balance), «Retiro de un socio» (0133), «Transferencia a <cuenta propia>» (0087, a
 *     payout whose destination IS that account — then it is the only option).
 * Nothing here moves money: the outflow is already in the balance; amount, date and account are resolved by the server.
 * Historical outflows (before the cutover) have no action yet; they are only counted.
 */
type Opcion = { tipo: 'VINCULAR'; gasto: PurchaseMpLinkRow } | { tipo: 'NUEVO' } | { tipo: 'PROVEEDOR' } | { tipo: 'RETIRO' } | { tipo: 'TRANSFERENCIA' };
const claveOpcion = (o: Opcion) => (o.tipo === 'VINCULAR' ? `V:${o.gasto.purchase_root_id}` : o.tipo);

const CAMPO = 'w-full border border-[#E4DCC8] rounded-md px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-500';
const ETIQUETA = 'block text-xs font-medium text-[#6B5D45] mb-1';
const hora = (ts: string | null) => (ts ? new Date(ts).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' }) : '');

export function BandejaPendientesMp() {
  const [pagina, setPagina] = useState(0);
  const q = usePendingPage('current', pagina);
  const resumen = usePendingSummary();
  const filas = q.data?.rows ?? [];
  const ids = filas.map((r) => r.source_id);
  const notas = useMpWhatsappNotes(ids);
  const docs = useDocumentLinks('MP_PENDING_OUTFLOW', ids);
  const gastosMp = usePurchaseMpLinks();
  const cuentas = useFinancialAccounts();
  const mpId = (cuentas.data ?? []).find((a) => isMercadoPagoAccount(a))?.id ?? '';
  const coincidencias = useMpPayoutMatches(filas.some((r) => r.kind === 'PAYOUT') ? mpId : '');
  const historicos = resumen.data ? mandatoryPending(resumen.data).historical : 0;
  const esperando = (gastosMp.data ?? []).filter((g) => g.status === 'PENDIENTE_VINCULACION_MP' && (g.candidates ?? []).length === 0);
  return (
    <section className="space-y-3" aria-label="Pagos de Mercado Pago por clasificar">
      <div>
        <p className="text-base font-semibold text-[#2C2419]">Pagos de Mercado Pago por clasificar{q.data ? ` (${q.data.total})` : ''}</p>
        <p className="text-sm text-[#6B5D45]">Para cada pago, elegí qué fue. La plata ya está descontada del saldo: clasificarlo solo dice en qué se usó.</p>
      </div>
      {q.isLoading ? <p className="text-sm text-gray-500">Cargando pagos...</p>
        : q.error ? <p className="text-sm text-red-700">{errorMessage(q.error)}</p>
          : filas.length === 0 ? <p className="text-sm text-green-800 bg-green-50 border border-green-200 rounded-lg p-3">No hay pagos por clasificar.</p> : (
            <ul className="space-y-3">
              {filas.map((r) => (
                <TarjetaPagoMp key={r.pending_key} r={r} nota={notas.data?.get(r.source_id)} docs={docs.data?.get(r.source_id)}
                  gastos={samePendingAmount(gastosMp.data ?? [], r.economic_amount)} destino={coincidencias.data?.get(r.source_id)} buscandoDestino={coincidencias.isLoading} />
              ))}
            </ul>
          )}
      {q.data && q.data.total > q.data.pageSize && <Paginador pagina={pagina} paginas={Math.ceil(q.data.total / q.data.pageSize)} total={q.data.total} onCambiar={setPagina} />}
      {historicos > 0 && <p className="text-xs text-[#8A7A5C]">Además hay {historicos} pago(s) históricos (anteriores al corte), no requieren acción: si querés, se clasifican con doble clic en su fila de Todas las operaciones.</p>}
      {esperando.length > 0 && (
        <details className="bg-white rounded-lg border border-[#E4DCC8] p-3 text-sm">
          <summary className="cursor-pointer font-medium text-[#3D3424]">Gastos cargados como pagados con Mercado Pago que esperan su movimiento ({esperando.length})</summary>
          <p className="text-xs text-[#8A7A5C] mt-1">Todavía no llegó un pago de Mercado Pago por ese importe. Cuando llegue, aparece arriba para vincularlo con un clic.</p>
          <ul className="mt-2 space-y-1">
            {esperando.map((g) => <li key={g.purchase_root_id} className="flex justify-between gap-2"><span>{descripcionGasto(g)}</span><span className="font-semibold">{formatoPesos(g.amount_total)}</span></li>)}
          </ul>
        </details>
      )}
      <RevisionTecnicaMp />
    </section>
  );
}

const descripcionGasto = (g: PurchaseMpLinkRow) => [g.origin_code, g.concept ?? 'Gasto', g.category_name, formatearFechaLocal(g.economic_date)].filter(Boolean).join(' · ');

function TarjetaPagoMp({ r, nota, docs, gastos, destino, buscandoDestino }: {
  r: PendingRow; nota: MpWhatsappNote | undefined; docs: Parameters<typeof Comprobantes>[0]['docs']; gastos: PurchaseMpLinkRow[];
  destino: MpPayoutMatch | undefined; buscandoDestino: boolean;
}) {
  const [elegida, setElegida] = useState<string | null>(null);
  const propia = r.kind === 'PAYOUT' && destino?.match_status === 'OWN_ACCOUNT_EXACT' && destino.matched_account_name ? destino.matched_account_name : null;
  const clasificable = r.kind === 'OUTBOUND' || (r.kind === 'PAYOUT' && destino?.match_status === 'NO_OWN_ACCOUNT_MATCH');
  const opciones: { o: Opcion; titulo: string; detalle?: string; sugerida?: boolean }[] = propia
    ? [{ o: { tipo: 'TRANSFERENCIA' }, titulo: `Transferencia a ${propia}`, detalle: 'El destino es esa cuenta propia', sugerida: true }]
    : clasificable ? [
      ...gastos.map((g) => ({ o: { tipo: 'VINCULAR', gasto: g } as Opcion, titulo: `Es el gasto ya cargado ${descripcionGasto(g)}`, detalle: 'Coincide el importe · se vincula, no se carga otro gasto', sugerida: true })),
      { o: { tipo: 'NUEVO' }, titulo: gastos.length ? 'Es otro gasto, nuevo' : 'Un gasto' },
      { o: { tipo: 'PROVEEDOR' }, titulo: 'Pago de deuda a un proveedor' },
      { o: { tipo: 'RETIRO' }, titulo: 'Retiro de un socio' },
    ] : [];
  const actual = opciones.find((x) => claveOpcion(x.o) === elegida)?.o ?? null;
  return (
    <li className="bg-white rounded-xl border border-[#E4DCC8] shadow-sm overflow-hidden">
      <div className="px-4 py-3 flex flex-wrap items-start justify-between gap-2 border-b border-[#EFE8D6]">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[#2C2419]">{PENDING_KIND_LABEL[r.kind]} de Mercado Pago</p>
          <p className="text-xs text-[#8A7A5C]">{formatearFechaLocal(r.business_date)} {hora(r.occurred_at)} · Nº {r.source_id}</p>
          {nota && <p className="text-xs text-[#2C5E3A] mt-0.5">Dicho por WhatsApp ({nota.draft_short_code}): {nota.concept}</p>}
          {docs && docs.length > 0 && <div className="mt-1"><Comprobantes docs={docs} compacto /></div>}
        </div>
        <div className="text-right">
          <p className="text-lg font-bold text-red-800">− {formatoPesos(Math.abs(r.amount))}</p>
          {r.charges_amount !== 0 && <p className="text-xs text-[#8A7A5C]">{formatoPesos(r.economic_amount)} + {formatoPesos(Math.abs(r.charges_amount))} de impuesto</p>}
        </div>
      </div>
      <div className="px-4 py-3 space-y-3">
        {opciones.length === 0 ? (
          <p className="text-sm text-[#8A7A5C]">{buscandoDestino ? 'Buscando el destino del retiro…' : 'El reporte informó destinos distintos para este retiro: hay que revisarlo antes de clasificarlo.'}</p>
        ) : (
          <>
            <p className="text-sm font-medium text-[#3D3424]">¿Qué fue este pago?</p>
            <div role="radiogroup" aria-label={`Qué fue el pago ${r.source_id}`} className="grid gap-2 sm:grid-cols-2">
              {opciones.map(({ o, titulo, detalle, sugerida }) => {
                const k = claveOpcion(o); const si = k === elegida;
                return (
                  <button key={k} type="button" role="radio" aria-checked={si} onClick={() => setElegida(si ? null : k)}
                    className={`text-left rounded-lg border px-3 py-2 text-sm transition flex gap-2 items-start ${si ? 'border-amber-600 ring-1 ring-amber-600 bg-amber-50'
                      : sugerida ? 'border-emerald-300 bg-emerald-50/60 hover:border-emerald-500' : 'border-[#E4DCC8] hover:border-amber-400'} ${sugerida ? 'sm:col-span-2' : ''}`}>
                    <span className={`mt-0.5 w-4 h-4 shrink-0 rounded-full border flex items-center justify-center ${si ? 'bg-amber-600 border-amber-600 text-white' : 'border-[#BFB39A] bg-white'}`}>
                      {si && <Check className="w-3 h-3" aria-hidden />}
                    </span>
                    <span className="min-w-0">
                      <span className="block font-medium text-[#2C2419]">{titulo}</span>
                      {detalle && <span className="block text-xs text-[#6B5D45]">{detalle}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
            {actual && <Formulario key={elegida ?? ''} r={r} o={actual} conceptoInicial={nota?.concept ?? ''} hayGastoCargado={gastos.length > 0} />}
          </>
        )}
      </div>
    </li>
  );
}

const BOTON = 'text-sm px-4 py-1.5 rounded-lg bg-[#A8552E] text-white font-medium hover:bg-[#8F4626] disabled:opacity-50';

/** The few fields of the chosen option and its one button. */
function Formulario({ r, o, conceptoInicial, hayGastoCargado }: { r: PendingRow; o: Opcion; conceptoInicial: string; hayGastoCargado: boolean }) {
  const grupos = useExpenseGroups();
  const subs = useExpenseCategories();
  const proveedores = useSuppliers();
  const saldos = useLedgerBalances('SUPPLIER');
  const { outflow } = useClassifyMp();
  const vincular = useSettlePurchaseMp();
  const transferir = useConfirmPayoutTransfer();
  const setSocio = useSetWithdrawalSocio();
  const [clave] = useState(() => `PURCHASE-MP-${crypto.randomUUID()}`);   // idempotency of the link: one per opened form
  const [sub, setSub] = useState('');
  const [concepto, setConcepto] = useState(conceptoInicial);
  const [naturaleza, setNaturaleza] = useState<OperationNature>('OPERATING');
  const [proveedor, setProveedor] = useState('');
  const [comercio, setComercio] = useState('');
  const [socio, setSocio_] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [ocupado, setOcupado] = useState(false);
  const g = grupos.data ?? []; const s = subs.data ?? [];
  const saldo = (id: string) => (saldos.data ?? []).find((x) => x.entity_id === id)?.balance ?? 0;
  const conDeuda = (proveedores.data ?? []).filter((p) => saldo(p.id) > 0);

  const correr = async (accion: () => Promise<unknown>) => {
    setOcupado(true); setError(null);
    try { await accion(); } catch (e) { setError(e); } finally { setOcupado(false); }
  };
  let campos: React.ReactNode = null;
  let listo = true;
  let texto = 'Guardar';
  let accion: () => Promise<unknown> = async () => undefined;

  if (o.tipo === 'VINCULAR') {
    texto = 'Vincular';
    const fechaPago = r.business_date;
    campos = (
      <p className="text-xs text-[#6B5D45]">
        El gasto ya figura en resultados{o.gasto.fiscal_document_id ? ' (con su factura e IVA)' : ''}: vincularlo solo registra que se pagó con este movimiento.
        {o.gasto.economic_date !== fechaPago ? ` El gasto conserva su fecha (${formatearFechaLocal(o.gasto.economic_date)}); el pago queda con la del movimiento (${formatearFechaLocal(fechaPago)}).` : ''}
      </p>
    );
    accion = () => vincular.mutateAsync({ purchaseId: o.gasto.purchase_id, sourceId: r.source_id, idempotencyKey: clave, reason: 'Vinculación desde Pendientes de clasificar' });
  } else if (o.tipo === 'NUEVO') {
    texto = hayGastoCargado ? 'Registrar como otro gasto' : 'Registrar gasto';
    listo = sub !== '' && concepto.trim() !== '';
    campos = (
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="min-w-0"><span className={ETIQUETA}>Categoría</span>
          <select className={CAMPO} value={sub} aria-label="Categoría del gasto" onChange={(e) => {
            const v = e.target.value; setSub(v);
            if (v) { setNaturaleza(defaultNatureOf(s, v)); if (concepto.trim() === '') setConcepto(s.find((x) => x.id === v)?.nombre ?? ''); }
          }}>
            <option value="">Elegí…</option>
            {selectableGroups(g, s).map((grupo) => (
              <optgroup key={grupo.id} label={grupo.nombre}>
                {selectableSubcategories(g, s, grupo.id).map((x) => <option key={x.id} value={x.id}>{x.nombre}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        <label className="min-w-0"><span className={ETIQUETA}>Concepto</span>
          <input className={CAMPO} value={concepto} maxLength={100} placeholder="Ej.: flete de alimento" onChange={(e) => setConcepto(e.target.value)} />
        </label>
        <label className="min-w-0"><span className={ETIQUETA}>Proveedor (opcional)</span>
          <select className={CAMPO} value={proveedor} onChange={(e) => setProveedor(e.target.value)}>
            <option value="">Sin proveedor</option>
            {(proveedores.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
          </select>
        </label>
        {proveedor === '' && (
          <label className="min-w-0"><span className={ETIQUETA}>Comercio (opcional)</span>
            <input className={CAMPO} value={comercio} maxLength={120} placeholder="Ej.: estación de servicio" aria-label="Comercio / nombre (opcional)" onChange={(e) => setComercio(e.target.value)} />
          </label>
        )}
        <label className="min-w-0"><span className={ETIQUETA}>Naturaleza</span>
          <select className={CAMPO} value={naturaleza} onChange={(e) => setNaturaleza(e.target.value as OperationNature)}>
            {(Object.keys(NATURALEZA_LABEL) as OperationNature[]).map((n) => <option key={n} value={n}>{NATURALEZA_LABEL[n]}</option>)}
          </select>
        </label>
        {hayGastoCargado && <p className="sm:col-span-2 text-xs text-amber-800">Ya hay un gasto cargado por este importe (arriba). Elegí esta opción solo si es un gasto distinto.</p>}
      </div>
    );
    accion = () => outflow.mutateAsync(proveedor
      ? { sourceId: r.source_id, classification: 'EXPENSE', supplierId: proveedor, expenseCategoryId: sub, nature: naturaleza, concept: concepto.trim() }
      : { sourceId: r.source_id, classification: 'CASUAL_PURCHASE', expenseCategoryId: sub, nature: naturaleza, concept: concepto.trim(), counterpartyName: comercio.trim() || null });
  } else if (o.tipo === 'PROVEEDOR') {
    texto = 'Registrar pago';
    listo = proveedor !== '';
    campos = conDeuda.length === 0 ? <p className="text-xs text-[#8A7A5C]">Ningún proveedor tiene deuda pendiente. Si es una compra, elegí «Un gasto».</p> : (
      <label className="block max-w-md"><span className={ETIQUETA}>Proveedor</span>
        <select className={CAMPO} value={proveedor} onChange={(e) => setProveedor(e.target.value)}>
          <option value="">Elegí…</option>
          {conDeuda.map((p) => <option key={p.id} value={p.id}>{p.nombre} · debe {formatoPesos(saldo(p.id))}</option>)}
        </select>
      </label>
    );
    accion = () => outflow.mutateAsync({ sourceId: r.source_id, classification: 'SUPPLIER_PAYMENT', supplierId: proveedor });
  } else if (o.tipo === 'RETIRO') {
    texto = 'Registrar retiro';
    campos = (
      <label className="block max-w-md"><span className={ETIQUETA}>Socio</span>
        <select className={CAMPO} value={socio} onChange={(e) => setSocio_(e.target.value)}>
          <option value="">Sin socio (se elige después)</option>
          {socios(g, s).map((x) => <option key={x.id} value={x.id}>{x.nombre}</option>)}
        </select>
      </label>
    );
    // 0133: the withdrawal, then its socio (if the second call fails the withdrawal stays and its socio is chosen from its row)
    accion = async () => {
      const res = await outflow.mutateAsync({ sourceId: r.source_id, classification: 'OWNER_WITHDRAWAL' });
      if (socio) await setSocio.mutateAsync({ operationId: res.financial_operation_id, socioId: socio });
    };
  } else {
    texto = 'Confirmar transferencia';
    campos = <p className="text-xs text-[#6B5D45]">Se registra como una transferencia entre tus cuentas: no es un gasto.</p>;
    accion = () => transferir.mutateAsync(r.source_id);
  }
  return (
    <div className="rounded-lg bg-[#FAF6EE] border border-[#EFE8D6] p-3 space-y-3">
      {campos}
      <div className="flex items-center gap-3">
        <button type="button" className={BOTON} disabled={!listo || ocupado} onClick={() => { void correr(accion); }}>{ocupado ? 'Guardando…' : texto}</button>
        {error ? <p className="text-xs text-red-700">{errorMessage(error)}</p> : null}
      </div>
    </div>
  );
}
