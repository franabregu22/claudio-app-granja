/**
 * Mercado Pago outflow actions (moved from the retired per-account detail, 0116): the payout destination and its confirmation as an own
 * transfer, and the classification of an outflow. They are offered in a Caja → Movimientos row under Pendientes de clasificar.
 */
import { useState } from 'react';
import { errorMessage } from '../../target/messages';
import type { PurchaseMpLinkRow } from '../../target/purchaseMpLink';
import { MP_OUTFLOW_CHOICE_LABEL, type MpActivityRow, type MpOutflowChoice, type MpPayoutMatch, payoutMatchLabel } from '../../target/mpActivity';
import { formatearFechaLocal } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';
import { useClassifyMp, useConfirmPayoutTransfer, useOwnBankAccounts } from './useMpActivity';
import { SelectorCategoria } from './SelectorCategoria';
import { useLedgerBalances, useSuppliers } from './useTreasury';

const DESTINO_ESTILO = { own: 'bg-sky-100 text-sky-900', classify: 'bg-amber-100 text-amber-900', review: 'bg-purple-100 text-purple-800' } as const;

/**
 * Payout destination proposal (0084) and its confirmation (0087). The button exists only for an unconfirmed
 * OWN_ACCOUNT_EXACT payout and sends only the SOURCE_ID: the server resolves amount, date and destination account.
 */
export function DestinoRetiro({ r, matches }: { r: MpActivityRow; matches: ReadonlyMap<string, MpPayoutMatch> }) {
  const m = payoutMatchLabel(r, matches);
  const confirmar = useConfirmPayoutTransfer();
  if (!m) return null;
  return (
    <div className="mt-1">
      <span className={`text-xs px-2 py-0.5 rounded ${DESTINO_ESTILO[m.tone]}`}>{m.title}</span>
      {m.detail && <p className="text-[11px] text-[#8A7A5C] mt-0.5">{m.detail}</p>}
      {m.canConfirm && r.source_id && (
        <button type="button" disabled={confirmar.isPending} onClick={() => confirmar.mutate(r.source_id as string)}
          className="ml-2 text-xs px-2 py-0.5 rounded border border-sky-300 bg-white text-sky-900 hover:bg-sky-50 disabled:opacity-50">
          {confirmar.isPending ? 'Confirmando...' : 'Confirmar transferencia'}
        </button>
      )}
      {confirmar.error && <p className="text-[11px] text-red-700 mt-0.5">{errorMessage(confirmar.error)}</p>}
      {m.canClassify && r.source_id && <ClasificarSalida sourceId={r.source_id} />}
    </div>
  );
}

const SELECT_CLS = 'text-xs border border-[#E4DCC8] rounded px-1 py-0.5 bg-white';
const SIN_PROVEEDOR = 'SIN_PROVEEDOR';
const ACCION_CLS = 'text-xs px-2 py-0.5 rounded border border-amber-300 bg-white text-amber-900 hover:bg-amber-50 disabled:opacity-50';

/**
 * 0089 — "Clasificar salida" for a payout to a third party (NO_OWN_ACCOUNT_MATCH): one "Compra / gasto" or a partner
 * withdrawal. Only identifiers, the concept and the optional counterparty name are sent: amount, date and the Mercado Pago
 * account are resolved by the server. A registered supplier: purchase + payment, or the payment of its existing debt.
 * "Sin proveedor registrado" (ADR-019): a casual purchase — no supplier, no supplier debt, optional "Comercio / nombre".
 * Own-account payouts keep their own confirmation. ADR-020 (0090): an unclassified outbound payment uses the same form; the
 * purchase gets the economic amount and the Mercado Pago tax is booked apart by the server.
 */
export function ClasificarSalida({ sourceId, conceptoInicial, gastosMpPendientes = [] }: { sourceId: string; /** ADR-025: the WhatsApp concept, pre-filled (editable) */ conceptoInicial?: string;
  /** Lote 4 (0111): purchases ALREADY recorded as paid with Mercado Pago for this same amount — classifying the outflow as a NEW purchase needs an explicit confirmation (owner: warn, never block) */
  gastosMpPendientes?: readonly PurchaseMpLinkRow[] }) {
  const [abierto, setAbierto] = useState(false);
  const [tipo, setTipo] = useState<MpOutflowChoice>('PURCHASE');
  const [proveedor, setProveedor] = useState('');
  const [categoria, setCategoria] = useState('');
  const [concepto, setConcepto] = useState(conceptoInicial ?? '');
  const [naturaleza, setNaturaleza] = useState<'OPERATING' | 'REINVESTMENT' | 'INVESTMENT'>('OPERATING');
  const [aDeuda, setADeuda] = useState(false);
  const [comercio, setComercio] = useState('');
  const [esOtroGasto, setEsOtroGasto] = useState(false);
  const proveedores = useSuppliers();
  const saldos = useLedgerBalances('SUPPLIER');
  const { outflow } = useClassifyMp();
  if (!abierto) {
    // the WhatsApp concept arrives after the row is mounted: it is applied when the form opens (never over a typed concept)
    return <button type="button" className={`ml-2 ${ACCION_CLS}`} onClick={() => { if (concepto === '' && conceptoInicial) setConcepto(conceptoInicial); setAbierto(true); }}>Clasificar salida</button>;
  }
  const sinProveedor = proveedor === SIN_PROVEEDOR;
  const deuda = sinProveedor ? 0 : (saldos.data ?? []).find((x) => x.entity_id === proveedor)?.balance ?? 0;
  const pagoDeuda = tipo === 'PURCHASE' && aDeuda && deuda > 0;
  // a NEW purchase / expense while an already recorded MP purchase has this amount: possible duplicate → explicit confirmation
  const posibleDuplicado = tipo === 'PURCHASE' && !pagoDeuda && gastosMpPendientes.length > 0;
  const listo = (tipo === 'OWNER_WITHDRAWAL' || (proveedor !== '' && (pagoDeuda || (categoria !== '' && concepto.trim() !== '')))) && (!posibleDuplicado || esOtroGasto);
  const confirmar = () => outflow.mutate(tipo === 'OWNER_WITHDRAWAL' ? { sourceId, classification: 'OWNER_WITHDRAWAL' }
    : pagoDeuda ? { sourceId, classification: 'SUPPLIER_PAYMENT', supplierId: proveedor }
      : sinProveedor ? { sourceId, classification: 'CASUAL_PURCHASE', expenseCategoryId: categoria, nature: naturaleza, concept: concepto.trim(), counterpartyName: comercio.trim() || null }
        : { sourceId, classification: 'EXPENSE', supplierId: proveedor, expenseCategoryId: categoria, nature: naturaleza, concept: concepto.trim() });
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1" role="group" aria-label="Clasificar salida">
      <select aria-label="Tipo de salida" className={SELECT_CLS} value={tipo} onChange={(e) => setTipo(e.target.value as MpOutflowChoice)}>
        {(Object.keys(MP_OUTFLOW_CHOICE_LABEL) as MpOutflowChoice[]).map((k) => <option key={k} value={k}>{MP_OUTFLOW_CHOICE_LABEL[k]}</option>)}
      </select>
      {tipo === 'PURCHASE' && (
        <>
          <select aria-label="Proveedor" className={SELECT_CLS} value={proveedor} onChange={(e) => { setProveedor(e.target.value); setADeuda(false); }}>
            <option value="">Proveedor…</option>
            {(proveedores.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
            <option value={SIN_PROVEEDOR}>Sin proveedor registrado</option>
          </select>
          {sinProveedor && (
            <input aria-label="Comercio / nombre (opcional)" className={SELECT_CLS} placeholder="Comercio / nombre (opcional)" maxLength={120}
              value={comercio} onChange={(e) => setComercio(e.target.value)} />
          )}
          {deuda > 0 && (
            <label className="text-xs flex items-center gap-1">
              <input type="checkbox" checked={aDeuda} onChange={(e) => setADeuda(e.target.checked)} />
              Aplicar a la deuda existente del proveedor ({formatoPesos(deuda)})
            </label>
          )}
          {!pagoDeuda && (
            <>
              <SelectorCategoria compacto campo={SELECT_CLS} subcategoriaId={categoria} onSubcategoria={setCategoria} naturaleza={naturaleza} onNaturaleza={setNaturaleza} />
              <input aria-label="Concepto" className={SELECT_CLS} placeholder="Concepto" maxLength={100} value={concepto} onChange={(e) => setConcepto(e.target.value)} />
            </>
          )}
        </>
      )}
      {posibleDuplicado && (
        <div className="w-full bg-amber-50 border border-amber-300 rounded p-2 text-xs text-amber-900" role="alert">
          <p className="font-semibold">Posible duplicado: ya hay {gastosMpPendientes.length === 1 ? 'un gasto registrado' : gastosMpPendientes.length + ' gastos registrados'} pagado con Mercado Pago por este importe, esperando su movimiento:</p>
          <ul className="list-disc ml-4">{gastosMpPendientes.map((g) => <li key={g.purchase_root_id}>{[g.origin_code, g.concept, formatearFechaLocal(g.economic_date), formatoPesos(g.amount_total)].filter(Boolean).join(' · ')}</li>)}</ul>
          <p>Si es ese gasto, vinculalo arriba en "Gastos registrados pagados con Mercado Pago" (no se registra otra compra).</p>
          <label className="flex items-center gap-1 mt-1"><input type="checkbox" checked={esOtroGasto} onChange={(e) => setEsOtroGasto(e.target.checked)} /> Confirmo que es un gasto distinto y quiero registrarlo como compra nueva</label>
        </div>
      )}
      <button type="button" className={ACCION_CLS} disabled={!listo || outflow.isPending} onClick={confirmar}>
        {outflow.isPending ? 'Confirmando...' : 'Confirmar'}
      </button>
      <button type="button" className="text-xs text-[#8A7A5C] underline" onClick={() => setAbierto(false)}>Cancelar</button>
      {outflow.error && <p className="w-full text-[11px] text-red-700">{errorMessage(outflow.error)}</p>}
    </div>
  );
}

type TipoIngreso = 'OWN_TRANSFER' | 'COLLECTION';

/**
 * 0088 — "Clasificar ingreso" for an account_fund + DEBIN inflow (CLASSIFY_INFLOW): money from an own account (one
 * TRANSFER, 0086) or a client receipt (applied server-side). ADR-027: it never names a client (a collection is declared in Cuentas
 * corrientes, so it would be discounted twice). "Otro ingreso" is not offered yet.
 */
export function ClasificarIngreso({ paymentId }: { paymentId: string }) {
  const [abierto, setAbierto] = useState(false);
  const [tipo, setTipo] = useState<TipoIngreso>('OWN_TRANSFER');
  const [cuenta, setCuenta] = useState('');
  const cuentas = useOwnBankAccounts();
  const { collection, ownTransfer } = useClassifyMp();
  const pendiente = collection.isPending || ownTransfer.isPending;
  const error = collection.error ?? ownTransfer.error;
  if (!abierto) {
    return <button type="button" className={`ml-2 ${ACCION_CLS}`} onClick={() => setAbierto(true)}>Clasificar ingreso</button>;
  }
  const listo = tipo === 'COLLECTION' || cuenta !== '';
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1" role="group" aria-label="Clasificar ingreso">
      <select aria-label="Tipo de ingreso" className={SELECT_CLS} value={tipo} onChange={(e) => setTipo(e.target.value as TipoIngreso)}>
        <option value="OWN_TRANSFER">Transferencia desde cuenta propia</option><option value="COLLECTION">Cobro de cliente (sin asignar)</option>
      </select>
      {tipo === 'OWN_TRANSFER' && (
        <select aria-label="Cuenta propia de origen" className={SELECT_CLS} value={cuenta} onChange={(e) => setCuenta(e.target.value)}>
          <option value="">Cuenta…</option>
          {(cuentas.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.nombre}</option>)}
        </select>
      )}
      <button type="button" className={ACCION_CLS} disabled={!listo || pendiente}
        onClick={() => (tipo === 'OWN_TRANSFER' ? ownTransfer.mutate({ paymentId, fromAccountId: cuenta }) : collection.mutate({ paymentId }))}>
        {pendiente ? 'Confirmando...' : 'Confirmar'}
      </button>
      <button type="button" className="text-xs text-[#8A7A5C] underline" onClick={() => setAbierto(false)}>Cancelar</button>
      {error && <p className="w-full text-[11px] text-red-700">{errorMessage(error)}</p>}
    </div>
  );
}
