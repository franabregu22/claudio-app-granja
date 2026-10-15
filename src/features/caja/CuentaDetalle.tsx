import { useState } from 'react';
import { X } from 'lucide-react';
import { bankHistoryStatus, CUTOVER_NOTICE, importe, needsCutoverNotice, type StatementLine } from '../../target/bankReconciliation';
import type { FinancialAccountRow } from '../../target/masters';
import { errorMessage } from '../../target/messages';
import { isMercadoPagoAccount, isVisibleActivity, MP_OUTFLOW_CHOICE_LABEL, type MpActivityRow, mpActivityType, type MpCoverageStatus, type MpOutflowChoice, type MpPayoutMatch, mpStatusLabel, payoutMatchLabel } from '../../target/mpActivity';
import { formatearFechaLocal } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';
import { useClassifyMp, useConfirmPayoutTransfer, useMpActivity, useMpPayoutMatches, useOwnBankAccounts } from './useMpActivity';
import { useBankHistory } from './useReconciliation';
import { useAccountPostings, useClients, useExpenseCategories, useLedgerBalances, useSuppliers } from './useTreasury';

type Pestana = 'erp' | 'banco' | 'mp';

const ESTADO_ESTILO: Record<string, string> = {
  'Corte pendiente': 'bg-stone-200 text-stone-700', 'Histórico': 'bg-blue-100 text-blue-800', 'Pendiente de conciliar': 'bg-amber-100 text-amber-900',
  'Conciliado': 'bg-green-100 text-green-800', 'Revisar corte': 'bg-purple-100 text-purple-800', 'Sin clasificar': 'bg-stone-100 text-stone-600',
};
const MP_ESTILO: Record<MpCoverageStatus, string> = {
  CONTROL: 'bg-stone-100 text-stone-600', PRE_CUTOVER: 'bg-blue-100 text-blue-800', RESERVE: 'bg-stone-100 text-stone-600',
  COVERED: 'bg-green-100 text-green-800', BACKFILL_PROCESSED: 'bg-green-100 text-green-800', BACKFILL_PENDING: 'bg-amber-100 text-amber-900',
  EXCEPTION: 'bg-red-100 text-red-800', YIELD: 'bg-teal-100 text-teal-800', PAYOUT: 'bg-purple-100 text-purple-800', OUTBOUND: 'bg-stone-200 text-stone-700',
  OWN_TRANSFER: 'bg-sky-100 text-sky-900', CLASSIFY_INFLOW: 'bg-amber-100 text-amber-900', CLASSIFIED_OUTFLOW: 'bg-stone-200 text-stone-800',
};

/**
 * One account inside Caja → Saldos. "Movimientos ERP" are its financial_posting rows (they make the ERP balance);
 * "Movimientos bancarios" (bank accounts only) are the imported statement lines (ADR-018): bank evidence, shown whatever
 * the statement cut, read-only — importing a statement never creates money, so they never change the ERP balance.
 * Reconciliation and the cut stay in Caja → Extractos bancarios → Conciliación. "Actividad Mercado Pago" (the MP account
 * only) is what the official release report says, with its coverage status (ADR-018 §15): read-only evidence; payment
 * money comes only from the Mercado Pago payment circuit, so this list never changes the ERP balance either.
 */
export function CuentaDetalle({ cuenta, saldo, onClose }: { cuenta: FinancialAccountRow; saldo: number | null; onClose: () => void }) {
  const esBanco = cuenta.account_type === 'BANK_ACCOUNT';
  const esMp = isMercadoPagoAccount(cuenta);
  const [pestana, setPestana] = useState<Pestana>(esBanco ? 'banco' : esMp ? 'mp' : 'erp');
  const pestanas: [Pestana, string][] = [['erp', 'Movimientos ERP'], ...(esBanco ? [['banco', 'Movimientos bancarios']] : []),
    ...(esMp ? [['mp', 'Actividad Mercado Pago']] : [])] as [Pestana, string][];
  return (
    <section className="mt-4 border border-[#E4DCC8] rounded-lg p-4 bg-[#FAF6EE]" aria-label={`Cuenta ${cuenta.nombre}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-bold text-[#2C2419]">{cuenta.nombre}</p>
          <p className="text-xs text-[#8A7A5C]">Saldo ERP: {saldo === null ? 'sin movimientos' : formatoPesos(saldo)}</p>
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="Cerrar cuenta"><X size={20} /></button>
      </div>
      <div className="flex gap-2 mt-3" role="tablist" aria-label="Movimientos de la cuenta">
        {pestanas.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={pestana === id} onClick={() => setPestana(id)}
            className={`px-3 py-1 rounded-full text-sm font-medium ${pestana === id ? 'bg-amber-100 text-amber-900 border border-amber-300' : 'bg-white text-[#6B5D45] border border-[#E4DCC8] hover:bg-stone-50'}`}>
            {label}
          </button>
        ))}
      </div>
      <div className="mt-3">
        {pestana === 'erp' ? <MovimientosErp accountId={cuenta.id} />
          : pestana === 'mp' ? <ActividadMercadoPago accountId={cuenta.id} /> : <MovimientosBancarios accountId={cuenta.id} />}
      </div>
    </section>
  );
}

function MovimientosErp({ accountId }: { accountId: string }) {
  const postings = useAccountPostings(accountId);
  if (postings.isLoading) return <p className="text-sm text-gray-500">Cargando movimientos...</p>;
  if (postings.error) return <p className="text-sm text-red-700">{errorMessage(postings.error)}</p>;
  const rows = postings.data ?? [];
  if (rows.length === 0) return <p className="text-sm text-[#8A7A5C]">La cuenta no tiene movimientos registrados en el ERP.</p>;
  return (
    <div className="overflow-x-auto bg-white rounded-lg border border-[#E4DCC8]">
      <table className="w-full text-sm" aria-label="Movimientos ERP">
        <thead><tr className="text-left text-xs text-[#8A7A5C] border-b border-[#E4DCC8]">
          <th className="px-3 py-2">Fecha</th><th className="px-3 py-2">Operación</th><th className="px-3 py-2">Referencia</th><th className="px-3 py-2 text-right">Importe</th>
        </tr></thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id} className="border-b border-stone-100 last:border-0">
              <td className="px-3 py-2 whitespace-nowrap">{formatearFechaLocal(p.effective_date)}</td>
              <td className="px-3 py-2 whitespace-nowrap">{p.operation_type ?? '—'}</td>
              <td className="px-3 py-2 max-w-[16rem] truncate" title={p.reason ?? p.external_ref ?? ''}>{p.reason || p.external_ref || '—'}</td>
              <td className={`px-3 py-2 text-right whitespace-nowrap font-medium ${p.signed_amount < 0 ? 'text-red-700' : 'text-green-800'}`}>{importe(p.signed_amount, true)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length >= 100 && <p className="text-xs text-[#8A7A5C] px-3 py-2">Se muestran los 100 movimientos más recientes.</p>}
    </div>
  );
}

function MovimientosBancarios({ accountId }: { accountId: string }) {
  const historial = useBankHistory(accountId);
  if (historial.isLoading) return <p className="text-sm text-gray-500">Cargando movimientos bancarios...</p>;
  if (historial.error) return <p className="text-sm text-red-700">{errorMessage(historial.error)}</p>;
  const lineas: StatementLine[] = historial.data ?? [];
  if (lineas.length === 0) {
    return <p className="text-sm text-[#8A7A5C]">Todavía no se importaron extractos de esta cuenta (Caja → Extractos bancarios → Importaciones).</p>;
  }
  return (
    <div className="space-y-2">
      <p className="text-xs text-[#8A7A5C]">Movimientos importados del extracto bancario. Son evidencia del banco: no modifican el saldo ERP.</p>
      {needsCutoverNotice(lineas) && <p className="text-xs bg-stone-100 border border-stone-200 text-stone-700 rounded-lg px-3 py-2">{CUTOVER_NOTICE}</p>}
      <div className="overflow-x-auto bg-white rounded-lg border border-[#E4DCC8]">
        <table className="w-full text-sm" aria-label="Movimientos bancarios">
          <thead><tr className="text-left text-xs text-[#8A7A5C] border-b border-[#E4DCC8]">
            <th className="px-3 py-2">Fecha</th><th className="px-3 py-2">Descripción</th><th className="px-3 py-2">Referencia</th>
            <th className="px-3 py-2 text-right">Importe</th><th className="px-3 py-2 text-right">Saldo informado por banco</th><th className="px-3 py-2">Estado</th>
          </tr></thead>
          <tbody>
            {lineas.map((l) => {
              const estado = bankHistoryStatus(l);
              return (
                <tr key={l.statement_line_id} className="border-b border-stone-100 last:border-0">
                  <td className="px-3 py-2 whitespace-nowrap">{formatearFechaLocal(l.value_date)}</td>
                  <td className="px-3 py-2 max-w-[18rem] truncate" title={l.description_raw}>{l.description_raw}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-[#8A7A5C]">{l.bank_reference || '—'}</td>
                  <td className={`px-3 py-2 text-right whitespace-nowrap font-medium ${l.signed_amount < 0 ? 'text-red-700' : 'text-green-800'}`}>{importe(l.signed_amount, true)}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap text-[#8A7A5C]">{importe(l.running_balance)}</td>
                  <td className="px-3 py-2 whitespace-nowrap"><span className={`text-xs px-2 py-0.5 rounded ${ESTADO_ESTILO[estado]}`}>{estado}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-[#8A7A5C]">{lineas.length} movimiento(s), los más recientes primero. La conciliación se hace en Extractos bancarios → Conciliación.</p>
    </div>
  );
}

function ActividadMercadoPago({ accountId }: { accountId: string }) {
  const actividad = useMpActivity(accountId);
  const coincidencias = useMpPayoutMatches(accountId);
  const matches: ReadonlyMap<string, MpPayoutMatch> = coincidencias.data ?? new Map();   // proposal only; the list works without it
  if (actividad.isLoading) return <p className="text-sm text-gray-500">Cargando actividad de Mercado Pago...</p>;
  if (actividad.error) return <p className="text-sm text-red-700">{errorMessage(actividad.error)}</p>;
  const todas: MpActivityRow[] = actividad.data ?? [];
  const filas = todas.filter(isVisibleActivity);   // CONTROL and RESERVE rows stay in the view as evidence, not in the list
  if (filas.length === 0) {
    return <p className="text-sm text-[#8A7A5C]">Todavía no se procesó ningún reporte de Mercado Pago.</p>;
  }
  return (
    <div className="space-y-2">
      <p className="text-xs text-[#8A7A5C]">Actividad informada por el reporte oficial de Mercado Pago. Es evidencia: no modifica el saldo ERP; los cobros se registran solo por el circuito de pagos de Mercado Pago. Solo &quot;Confirmar transferencia&quot; registra un retiro a una cuenta propia como transferencia interna.</p>
      <div className="overflow-x-auto bg-white rounded-lg border border-[#E4DCC8]">
        <table className="w-full text-sm" aria-label="Actividad Mercado Pago">
          <thead><tr className="text-left text-xs text-[#8A7A5C] border-b border-[#E4DCC8]">
            <th className="px-3 py-2">Fecha</th><th className="px-3 py-2">Tipo</th><th className="px-3 py-2">Referencia</th>
            <th className="px-3 py-2 text-right">Importe</th><th className="px-3 py-2">Estado</th>
          </tr></thead>
          <tbody>
            {filas.map((r) => (
              <tr key={`${r.run_id}:${r.row_number}`} className="border-b border-stone-100 last:border-0">
                <td className="px-3 py-2 whitespace-nowrap">{formatearFechaLocal(r.business_date)}</td>
                <td className="px-3 py-2 whitespace-nowrap">{mpActivityType(r)}</td>
                <td className="px-3 py-2 whitespace-nowrap text-[#8A7A5C]">{r.source_id ?? '—'}</td>
                <td className={`px-3 py-2 text-right whitespace-nowrap font-medium ${(r.net_amount ?? 0) < 0 ? 'text-red-700' : 'text-green-800'}`}>{importe(r.net_amount, true)}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <span className={`text-xs px-2 py-0.5 rounded ${MP_ESTILO[r.coverage_status]}`}>{mpStatusLabel(r)}</span>
                  <DestinoRetiro r={r} matches={matches} />
                  {r.coverage_status === 'CLASSIFY_INFLOW' && r.source_id && <ClasificarIngreso paymentId={r.source_id} />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-[#8A7A5C]">{filas.length} movimiento(s) del reporte, los más recientes primero ({todas.length - filas.length} fila(s) internas del reporte omitidas: saldos, totales y reservas).</p>
    </div>
  );
}

const DESTINO_ESTILO = { own: 'bg-sky-100 text-sky-900', classify: 'bg-amber-100 text-amber-900', review: 'bg-purple-100 text-purple-800' } as const;

/**
 * Payout destination proposal (0084) and its confirmation (0087). The button exists only for an unconfirmed
 * OWN_ACCOUNT_EXACT payout and sends only the SOURCE_ID: the server resolves amount, date and destination account.
 */
function DestinoRetiro({ r, matches }: { r: MpActivityRow; matches: ReadonlyMap<string, MpPayoutMatch> }) {
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
 * Own-account payouts keep their own confirmation.
 */
function ClasificarSalida({ sourceId }: { sourceId: string }) {
  const [abierto, setAbierto] = useState(false);
  const [tipo, setTipo] = useState<MpOutflowChoice>('PURCHASE');
  const [proveedor, setProveedor] = useState('');
  const [categoria, setCategoria] = useState('');
  const [concepto, setConcepto] = useState('');
  const [naturaleza, setNaturaleza] = useState<'OPERATING' | 'REINVESTMENT' | 'INVESTMENT'>('OPERATING');
  const [aDeuda, setADeuda] = useState(false);
  const [comercio, setComercio] = useState('');
  const proveedores = useSuppliers();
  const categorias = useExpenseCategories();
  const saldos = useLedgerBalances('SUPPLIER');
  const { outflow } = useClassifyMp();
  if (!abierto) {
    return <button type="button" className={`ml-2 ${ACCION_CLS}`} onClick={() => setAbierto(true)}>Clasificar salida</button>;
  }
  const sinProveedor = proveedor === SIN_PROVEEDOR;
  const deuda = sinProveedor ? 0 : (saldos.data ?? []).find((x) => x.entity_id === proveedor)?.balance ?? 0;
  const pagoDeuda = tipo === 'PURCHASE' && aDeuda && deuda > 0;
  const listo = tipo === 'OWNER_WITHDRAWAL' || (proveedor !== '' && (pagoDeuda || (categoria !== '' && concepto.trim() !== '')));
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
              <select aria-label="Categoría" className={SELECT_CLS} value={categoria} onChange={(e) => setCategoria(e.target.value)}>
                <option value="">Categoría…</option>
                {(categorias.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
              </select>
              <input aria-label="Concepto" className={SELECT_CLS} placeholder="Concepto" maxLength={100} value={concepto} onChange={(e) => setConcepto(e.target.value)} />
              <select aria-label="Naturaleza" className={SELECT_CLS} value={naturaleza} onChange={(e) => setNaturaleza(e.target.value as typeof naturaleza)}>
                <option value="OPERATING">Operativo</option><option value="REINVESTMENT">Reinversión</option><option value="INVESTMENT">Inversión</option>
              </select>
            </>
          )}
        </>
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
 * TRANSFER, 0086) or a client receipt (applied server-side; the client is optional). "Otro ingreso" is not offered yet.
 */
function ClasificarIngreso({ paymentId }: { paymentId: string }) {
  const [abierto, setAbierto] = useState(false);
  const [tipo, setTipo] = useState<TipoIngreso>('OWN_TRANSFER');
  const [cuenta, setCuenta] = useState('');
  const [cliente, setCliente] = useState('');
  const cuentas = useOwnBankAccounts();
  const clientes = useClients();
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
        <option value="OWN_TRANSFER">Transferencia desde cuenta propia</option><option value="COLLECTION">Cobro de cliente</option>
      </select>
      {tipo === 'OWN_TRANSFER' ? (
        <select aria-label="Cuenta propia de origen" className={SELECT_CLS} value={cuenta} onChange={(e) => setCuenta(e.target.value)}>
          <option value="">Cuenta…</option>
          {(cuentas.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.nombre}</option>)}
        </select>
      ) : (
        <select aria-label="Cliente" className={SELECT_CLS} value={cliente} onChange={(e) => setCliente(e.target.value)}>
          <option value="">Sin cliente</option>
          {(clientes.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
        </select>
      )}
      <button type="button" className={ACCION_CLS} disabled={!listo || pendiente}
        onClick={() => (tipo === 'OWN_TRANSFER' ? ownTransfer.mutate({ paymentId, fromAccountId: cuenta }) : collection.mutate({ paymentId, clientId: cliente || null }))}>
        {pendiente ? 'Confirmando...' : 'Confirmar'}
      </button>
      <button type="button" className="text-xs text-[#8A7A5C] underline" onClick={() => setAbierto(false)}>Cancelar</button>
      {error && <p className="w-full text-[11px] text-red-700">{errorMessage(error)}</p>}
    </div>
  );
}
