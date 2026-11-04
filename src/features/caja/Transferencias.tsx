import { useState } from 'react';
import { ArrowLeftRight } from 'lucide-react';
import { isMercadoPagoAccount, mpOwnInflowCandidates, mpOwnPayoutCandidates } from '../../target/mpActivity';
import { errorMessage } from '../../target/messages';
import { MOVEMENT_PAGE, rowStatusLabel, rowStatusTone, type MovementRow } from '../../target/movementHistory';
import {
  INTENT_STATUS_LABEL, intentCandidates, intentRoute, recordedTaxesNear, sameAmountTax, type RecordedTax, type TransferIntentRow,
} from '../../target/transferIntents';
import { formatearFechaLocal, getTodayDate } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';
import { useFinancialAccounts } from '../pedidos/useCommercial';
import { campo, etiqueta, Modal } from './Modal';
import { SelectorMovimientoMp, useActividadMp, useEsCuentaMp } from './MovimientoMp';
import { Paginador } from './PendientesClasificar';
import { useClassifyMp, useConfirmPayoutTransfer } from './useMpActivity';
import { useBankTaxPeriods, useMovementList, useTransferIntentMutations, useTransferIntents, useTreasuryMutations, useUnrelatedTaxes } from './useTreasury';

const ESTADO = { action: 'bg-amber-100 text-amber-900', done: 'bg-green-100 text-green-800', neutral: 'bg-stone-100 text-stone-600' };
type Lado = { account_id: string; nombre: string } | null;
const lados = (r: Pick<MovementRow, 'postings'>): { origen: Lado; destino: Lado } => {
  const s = r.postings.find((p) => p.signed_amount < 0);
  const e = r.postings.find((p) => p.signed_amount > 0);
  return { origen: s ? { account_id: s.account_id, nombre: s.account_name } : null, destino: e ? { account_id: e.account_id, nombre: e.account_name } : null };
};

/**
 * Caja → Transferencias (0116). A transfer between own accounts is one operation with two postings: no income, no expense.
 * · Its state: registered, waiting for its bank / Mercado Pago evidence (pendiente de vinculación) or reconciled (conciliada).
 * · Between Mercado Pago and a bank it can be registered BEFORE its Mercado Pago movement (an anticipated transfer, no money yet: every
 *   Mercado Pago posting needs its movement, 0091); when the movement arrives it is linked and the ONE transfer is created then.
 * · A debits/credits tax actually charged is its own debit: recorded with the transfer, or — if it is already recorded (e.g. from the
 *   statement) — associated, never recorded twice. No percentage is applied by itself.
 */
export function Transferencias() {
  const cuentas = useFinancialAccounts();
  const [transfiriendo, setTransfiriendo] = useState(false);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-[#8A7A5C]">Movimientos entre cuentas propias: no son ingreso ni gasto.</p>
        <button onClick={() => setTransfiriendo(true)} disabled={(cuentas.data ?? []).length < 2}
          className="flex items-center gap-2 text-sm px-3 py-2 bg-amber-100 text-amber-900 rounded-lg hover:bg-amber-200 disabled:opacity-50">
          <ArrowLeftRight className="w-4 h-4" /> Transferir entre cuentas
        </button>
      </div>
      {transfiriendo && <TransferenciaModal onClose={() => setTransfiriendo(false)} />}
      <TransferenciasAnticipadas />
      <div className="bg-white rounded-lg border border-[#E4DCC8] p-4">
        <HistorialTransferencias />
        <ImpuestoPorPeriodo />
      </div>
    </div>
  );
}

/** The transfers with their state and their tax, from the unified list (server page and total). */
function HistorialTransferencias() {
  const [pagina, setPagina] = useState(0);
  const q = useMovementList({ kind: 'TRANSFERENCIA' }, pagina);
  const [agregando, setAgregando] = useState<MovementRow | null>(null);
  if (q.isLoading) return <p className="mt-4 text-sm text-gray-500">Cargando transferencias...</p>;
  if (q.error) return <p className="mt-4 text-sm text-red-700">{errorMessage(q.error)}</p>;
  const filas = (q.data?.rows ?? []).filter((r): r is MovementRow => r.row_type === 'OP');
  const total = q.data?.total ?? 0;
  return (
    <div>
      <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide mb-2">Historial</p>
      {filas.length === 0 && <p className="text-sm text-[#8A7A5C]">No hay transferencias registradas.</p>}
      <div className="space-y-2">
        {filas.map((t) => {
          const { origen, destino } = lados(t);
          const impuestos = t.related_taxes ?? [];
          return (
            <div key={t.operation_id} className="border border-[#E4DCC8] rounded-lg p-2 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>{formatearFechaLocal(t.effective_date)} · {origen?.nombre ?? '—'} → {destino?.nombre ?? '—'} · <span className="font-bold">{formatoPesos(t.moved_amount)}</span></span>
                <span className="flex items-center gap-2">
                  <span className={`text-[11px] px-1.5 py-0.5 rounded ${ESTADO[rowStatusTone(t.status)]}`}>{rowStatusLabel(t)}</span>
                  {impuestos.length === 0 && <button onClick={() => setAgregando(t)} className="text-xs text-[#A8552E] hover:underline">+ Impuesto cobrado</button>}
                </span>
              </div>
              {t.transfer_intent && <p className="text-xs text-[#8A7A5C]">Registrada antes del movimiento (Nº {t.transfer_intent.intent_id}).</p>}
              {impuestos.map((i) => (
                <p key={i.operation_id} className="text-xs text-[#8A7A5C]">Impuesto Débitos/Créditos · {i.account_name} · {formatoPesos(i.amount)} · {i.matched ? 'conciliado con el extracto' : 'sin conciliar'}</p>
              ))}
            </div>
          );
        })}
      </div>
      {filas.length > 0 && <div className="mt-2"><Paginador pagina={pagina} paginas={Math.max(1, Math.ceil(total / MOVEMENT_PAGE))} total={total} onCambiar={setPagina} /></div>}
      {agregando && <ImpuestoModal transferencia={agregando} onClose={() => setAgregando(null)} />}
    </div>
  );
}

/** ADR-011: the amount paid per period as report_bank_tax_period returns it (no computability figure). */
function ImpuestoPorPeriodo() {
  const periodos = useBankTaxPeriods();
  if (periodos.isLoading || periodos.error || (periodos.data ?? []).length === 0) return null;
  return (
    <div className="mt-6">
      <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide mb-2">Impuesto Débitos/Créditos por período</p>
      {(periodos.data ?? []).map((p) => (
        <div key={`${p.period}-${p.financial_account_id}-${p.tax_kind}`} className="flex justify-between text-sm">
          <span>{p.period.slice(0, 7)} · {p.account_name}</span>
          <span className="font-bold">{formatoPesos(p.amount_paid)}</span>
        </div>
      ))}
    </div>
  );
}

/** The recorded taxes of an account near a date that are not any transfer's yet: associated, never recorded again. */
function ImpuestosRegistrados({ cercanos, transferenciaId, onAsociado }: { cercanos: RecordedTax[]; transferenciaId: number | null; onAsociado?: () => void }) {
  const { relateTax } = useTransferIntentMutations();
  if (cercanos.length === 0) return null;
  return (
    <div className="bg-sky-50 border border-sky-200 rounded-lg p-2 text-sm space-y-1" aria-label="Impuestos ya registrados">
      <p className="text-xs text-sky-900">Ya hay impuesto Débitos/Créditos registrado en esta cuenta cerca de la fecha (por ejemplo, desde el extracto). Si es el de esta transferencia, asocialo: no se descuenta otra vez.</p>
      {cercanos.map((t) => (
        <div key={t.operation_id} className="flex flex-wrap items-center justify-between gap-2">
          <span>{formatearFechaLocal(t.effective_date)} · {formatoPesos(t.amount)} · operación {t.operation_id}</span>
          {transferenciaId !== null && (
            <button type="button" disabled={relateTax.isPending} onClick={() => relateTax.mutate({ taxOperationId: t.operation_id, transferOperationId: transferenciaId }, { onSuccess: onAsociado })}
              className="text-xs px-2 py-0.5 rounded border border-sky-300 bg-white text-sky-900 hover:bg-sky-50 disabled:opacity-50">Asociar a esta transferencia</button>
          )}
        </div>
      ))}
      {relateTax.error ? <p className="text-xs text-red-700">{errorMessage(relateTax.error)}</p> : null}
    </div>
  );
}

/** The tax actually charged for an existing transfer (also the recovery path after a partial success). */
function ImpuestoModal({ transferencia, onClose }: { transferencia: MovementRow; onClose: () => void }) {
  const { bankTax } = useTreasuryMutations();
  const { origen, destino } = lados(transferencia);
  const [cuenta, setCuenta] = useState(origen?.account_id ?? '');
  const [monto, setMonto] = useState('');
  const [otroCargo, setOtroCargo] = useState(false);
  const [clave] = useState(() => `IDC-${crypto.randomUUID()}`);   // idempotency: one per opened form
  const registrados = useUnrelatedTaxes(cuenta);
  const cercanos = recordedTaxesNear(registrados.data ?? [], transferencia.effective_date);
  const igual = Number(monto) > 0 ? sameAmountTax(cercanos, Number(monto)) : null;
  const puede = cuenta !== '' && Number(monto) > 0 && (!igual || otroCargo);
  return (
    <Modal titulo="Impuesto Débitos/Créditos cobrado" onClose={onClose} puedeGuardar={puede} guardando={bankTax.isPending} error={bankTax.error}
      textoGuardar="Registrar impuesto"
      onSubmit={() => bankTax.mutate({ accountId: cuenta, amount: Number(monto), effectiveDate: transferencia.effective_date, externalRef: clave, relatedOperationId: transferencia.operation_id },
        { onSuccess: onClose })}>
      <p className="text-sm">{formatearFechaLocal(transferencia.effective_date)} · {origen?.nombre ?? '—'} → {destino?.nombre ?? '—'} · {formatoPesos(transferencia.moved_amount)}</p>
      <CuentaImpuesto transferencia={{ origen, destino }} value={cuenta} onChange={setCuenta} />
      <ImpuestosRegistrados cercanos={cercanos} transferenciaId={transferencia.operation_id} onAsociado={onClose} />
      <label className={etiqueta}>Monto efectivamente cobrado (del comprobante o del extracto)
        <input type="number" min="0" step="0.01" value={monto} onChange={(e) => setMonto(e.target.value)} className={campo} />
      </label>
      {igual && (
        <label className="flex items-center gap-1 text-xs text-amber-900">
          <input type="checkbox" checked={otroCargo} onChange={(e) => setOtroCargo(e.target.checked)} />
          Ya hay un impuesto de {formatoPesos(igual.amount)} registrado el {formatearFechaLocal(igual.effective_date)}: confirmo que es otro cargo distinto
        </label>
      )}
      <p className="text-xs text-[#8A7A5C]">Solo un cargo confirmado: no se calcula ningún porcentaje. Si después llega en el extracto, se concilia con este registro.</p>
    </Modal>
  );
}

function CuentaImpuesto({ transferencia, value, onChange }: { transferencia: { origen: Lado; destino: Lado }; value: string; onChange: (v: string) => void }) {
  return (
    <label className={etiqueta}>Cuenta debitada por el impuesto
      <select value={value} onChange={(e) => onChange(e.target.value)} className={campo}>
        {transferencia.origen && <option value={transferencia.origen.account_id}>{transferencia.origen.nombre} (origen)</option>}
        {transferencia.destino && <option value={transferencia.destino.account_id}>{transferencia.destino.nombre} (destino)</option>}
      </select>
    </label>
  );
}

/** 0116 — the anticipated transfers still waiting for their Mercado Pago movement, and the ones already linked or cancelled. */
function TransferenciasAnticipadas() {
  const q = useTransferIntents();
  const filas = q.data ?? [];
  if (q.isLoading || (!q.error && filas.length === 0)) return null;
  const pendientes = filas.filter((f) => f.status === 'PENDIENTE');
  return (
    <section className="bg-white rounded-lg border border-[#E4DCC8] p-4 space-y-2" aria-label="Transferencias registradas antes del movimiento">
      <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide">Registradas antes del movimiento de Mercado Pago ({pendientes.length} pendiente{pendientes.length === 1 ? '' : 's'})</p>
      <p className="text-xs text-[#8A7A5C]">Todavía no movieron dinero. Cuando llega el movimiento de Mercado Pago se vinculan y recién ahí se registra la transferencia, una sola vez.</p>
      {q.error ? <p className="text-sm text-red-700">{errorMessage(q.error)}</p> : (
        <ul className="space-y-2">{filas.map((f) => <FilaAnticipada key={f.id} f={f} />)}</ul>
      )}
    </section>
  );
}

function FilaAnticipada({ f }: { f: TransferIntentRow }) {
  const [abierta, setAbierta] = useState(false);
  return (
    <li className="border border-[#E4DCC8] rounded-lg p-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>{formatearFechaLocal(f.effective_date)} · {f.origen} → {f.destino} · <b>{formatoPesos(f.amount)}</b>{f.reason ? <span className="text-[#8A7A5C]"> · {f.reason}</span> : null}</span>
        <span className="flex items-center gap-2">
          <span className={`text-[11px] px-1.5 py-0.5 rounded ${f.status === 'PENDIENTE' ? ESTADO.action : f.status === 'VINCULADA' ? ESTADO.done : ESTADO.neutral}`}>{INTENT_STATUS_LABEL[f.status]}</span>
          {f.status === 'PENDIENTE' && <button type="button" onClick={() => setAbierta(!abierta)} className="text-xs text-[#A8552E] hover:underline">{abierta ? 'Cerrar' : 'Vincular / anular'}</button>}
        </span>
      </div>
      {f.status === 'VINCULADA' && <p className="text-xs text-[#8A7A5C]">Transferencia Nº {f.transfer_operation_id}{f.linked_source_id ? ` · movimiento de Mercado Pago ${f.linked_source_id}` : ''}</p>}
      {abierta && f.status === 'PENDIENTE' && <VincularAnticipada f={f} onCerrar={() => setAbierta(false)} />}
    </li>
  );
}

/** Link with the Mercado Pago movement of exactly that amount (the server creates the transfer) or with a transfer already confirmed. */
function VincularAnticipada({ f, onCerrar }: { f: TransferIntentRow; onCerrar: () => void }) {
  const cuentas = useFinancialAccounts();
  const lista = cuentas.data ?? [];
  const desde = lista.find((a) => a.id === f.from_account_id);
  const hacia = lista.find((a) => a.id === f.to_account_id);
  const ruta = desde && hacia ? intentRoute({ isMp: isMercadoPagoAccount(desde), isBank: desde.account_type === 'BANK_ACCOUNT' }, { isMp: isMercadoPagoAccount(hacia), isBank: hacia.account_type === 'BANK_ACCOUNT' }) : null;
  const mpId = ruta === 'PAYOUT' ? f.from_account_id : ruta === 'INFLOW' ? f.to_account_id : '';
  const actividad = useActividadMp(mpId, ruta !== null);
  const movimientos = ruta === 'PAYOUT' ? mpOwnPayoutCandidates(actividad.rows, actividad.matches, f.to_account_id) : ruta === 'INFLOW' ? mpOwnInflowCandidates(actividad.rows) : [];
  const confirmadas = useMovementList({ kind: 'TRANSFERENCIA', accountId: f.to_account_id, search: String(f.amount).replace('.', ','), }, 0);
  const transferencias = (confirmadas.data?.rows ?? []).filter((r): r is MovementRow => r.row_type === 'OP');
  const candidatos = intentCandidates(f, movimientos, transferencias);
  const { link, cancel } = useTransferIntentMutations();
  const [elegido, setElegido] = useState('');
  const [motivo, setMotivo] = useState('');
  const c = candidatos.find((x) => x.key === elegido);
  return (
    <div className="mt-2 space-y-2 border-t border-stone-100 pt-2">
      {actividad.cargando || confirmadas.isLoading ? <p className="text-xs text-gray-500">Buscando el movimiento...</p>
        : candidatos.length === 0 ? <p className="text-xs text-[#8A7A5C]">Todavía no aparece un movimiento de Mercado Pago ni una transferencia confirmada de {formatoPesos(f.amount)} entre estas cuentas.</p> : (
          <div className="flex flex-wrap items-center gap-2">
            <select aria-label="Movimiento a vincular" className="text-xs border border-[#E4DCC8] rounded px-1 py-0.5 bg-white" value={elegido} onChange={(e) => setElegido(e.target.value)}>
              <option value="">Elegir movimiento…</option>
              {candidatos.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
            </select>
            <button type="button" disabled={!c || link.isPending} onClick={() => c && link.mutate({ intentId: f.id, sourceId: c.sourceId ?? null, operationId: c.operationId ?? null }, { onSuccess: onCerrar })}
              className="text-xs px-2 py-0.5 rounded border border-[#3D3424] bg-white disabled:opacity-40">{link.isPending ? 'Vinculando...' : 'Vincular'}</button>
          </div>
        )}
      {link.error ? <p className="text-xs text-red-700">{errorMessage(link.error)}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <input aria-label="Motivo de anulación" placeholder="Motivo para anular" maxLength={200} value={motivo} onChange={(e) => setMotivo(e.target.value)}
          className="text-xs border border-[#E4DCC8] rounded px-1 py-0.5 bg-white" />
        <button type="button" disabled={motivo.trim() === '' || cancel.isPending} onClick={() => cancel.mutate({ intentId: f.id, reason: motivo }, { onSuccess: onCerrar })}
          className="text-xs px-2 py-0.5 rounded border border-[#E4DCC8] bg-white disabled:opacity-40">Anular (no se transfirió)</button>
      </div>
      {cancel.error ? <p className="text-xs text-red-700">{errorMessage(cancel.error)}</p> : null}
    </div>
  );
}

/**
 * Transfer between own accounts. Meta A (0091): a transfer that touches Mercado Pago is the Mercado Pago movement chosen
 * here — Mercado Pago → own account: the payout whose destination is exactly that account (mp_confirm_payout_transfer);
 * own account → Mercado Pago: the inflow from an own account (mp_reclassify_inbound_own_transfer). 0116: when the movement is not
 * there yet, the transfer is registered ahead (no money) and linked when it arrives.
 */
function TransferenciaModal({ onClose }: { onClose: () => void }) {
  const cuentas = useFinancialAccounts();
  const { transferWithTax } = useTreasuryMutations();
  const { register } = useTransferIntentMutations();
  const [origen, setOrigen] = useState('');
  const [destino, setDestino] = useState('');
  const [monto, setMonto] = useState('');
  const [fecha, setFecha] = useState(getTodayDate());
  const [notas, setNotas] = useState('');
  const [clave] = useState(() => `TRF-${crypto.randomUUID()}`);   // idempotency: one per opened form
  const [impuesto, setImpuesto] = useState('');
  const [cuentaImpuesto, setCuentaImpuesto] = useState('');
  const [anticipada, setAnticipada] = useState(false);
  // D-WALK-7: once the transfer succeeded, a retry registers only the tax (never a second transfer)
  const [operacionId, setOperacionId] = useState<number | string | null>(null);
  const [errorImpuesto, setErrorImpuesto] = useState<unknown>(null);
  const hecha = operacionId !== null;
  const origenMp = useEsCuentaMp(origen);
  const destinoMp = useEsCuentaMp(destino);
  const esMp = origenMp || destinoMp;
  const actividadMp = useActividadMp(origenMp ? origen : destino, esMp);
  const candidatosMp = origen === '' || destino === '' || origen === destino ? []
    : origenMp ? mpOwnPayoutCandidates(actividadMp.rows, actividadMp.matches, destino) : destinoMp ? mpOwnInflowCandidates(actividadMp.rows) : [];
  const [movimientoMp, setMovimientoMp] = useState('');
  const confirmarRetiro = useConfirmPayoutTransfer();
  const { ownTransfer } = useClassifyMp();
  const mutacionMp = origenMp ? confirmarRetiro : ownTransfer;
  const lista = cuentas.data ?? [];
  const cuenta = (id: string) => lista.find((a) => a.id === id);
  const nombre = (id: string) => cuenta(id)?.nombre ?? '—';
  const tipo = (id: string) => ({ isMp: !!cuenta(id) && isMercadoPagoAccount(cuenta(id) as NonNullable<ReturnType<typeof cuenta>>), isBank: cuenta(id)?.account_type === 'BANK_ACCOUNT' });
  const ruta = origen !== '' && destino !== '' && origen !== destino ? intentRoute(tipo(origen), tipo(destino)) : null;
  const sinMovimiento = esMp && !actividadMp.cargando && candidatosMp.length === 0;
  const adelantada = esMp && ruta !== null && (anticipada || sinMovimiento);
  const datosOk = origen !== '' && destino !== '' && origen !== destino && Number(monto) > 0 && fecha !== '';
  const cuentaTax = cuentaImpuesto || origen;
  const registrados = useUnrelatedTaxes(!esMp && Number(impuesto) > 0 ? cuentaTax : '');
  const taxRepetido = Number(impuesto) > 0 ? sameAmountTax(recordedTaxesNear(registrados.data ?? [], fecha), Number(impuesto)) : null;
  const puede = adelantada ? datosOk : esMp ? candidatosMp.some((c) => c.sourceId === movimientoMp) : datosOk && !taxRepetido;

  function guardar() {
    if (adelantada) {
      register.mutate({ fromAccountId: origen, toAccountId: destino, amount: Number(monto), effectiveDate: fecha, idempotencyKey: clave, reason: notas }, { onSuccess: onClose });
      return;
    }
    if (esMp) {
      if (origenMp) confirmarRetiro.mutate(movimientoMp, { onSuccess: onClose });
      else ownTransfer.mutate({ paymentId: movimientoMp, fromAccountId: origen }, { onSuccess: onClose });
      return;
    }
    const tax = Number(impuesto) > 0 ? { accountId: cuentaTax, amount: Number(impuesto) } : null;
    transferWithTax.mutate({ sourceAccountId: origen, destAccountId: destino, amount: Number(monto), effectiveDate: fecha, externalRef: clave, reason: notas,
      transferOperationId: operacionId, tax }, {
      onSuccess: (r) => {
        if (r.taxError) { setOperacionId(r.transferOperationId); setErrorImpuesto(r.taxError); } else onClose();
      },
    });
  }

  return (
    <Modal titulo="Transferir entre cuentas" onClose={onClose} puedeGuardar={puede} guardando={transferWithTax.isPending || mutacionMp.isPending || register.isPending}
      error={adelantada ? register.error : esMp ? mutacionMp.error ?? actividadMp.error : transferWithTax.error}
      textoGuardar={hecha ? 'Reintentar impuesto' : adelantada ? 'Registrar y vincular después' : 'Transferir'} onSubmit={guardar}>
      {hecha && (
        <div className="bg-amber-50 border border-amber-300 rounded-lg p-2 text-sm text-amber-900">
          La transferencia se registró correctamente. El impuesto no se pudo registrar: {errorMessage(errorImpuesto)}
          {' '}Podés reintentar solo el impuesto o cerrar y cargarlo después desde el historial.
        </div>
      )}
      <fieldset disabled={hecha} className="space-y-3">
      <label className={etiqueta}>Desde
        <select value={origen} onChange={(e) => setOrigen(e.target.value)} className={campo}>
          <option value="">Elegir cuenta…</option>
          {lista.map((a) => <option key={a.id} value={a.id}>{a.nombre}</option>)}
        </select>
      </label>
      <label className={etiqueta}>Hacia
        <select value={destino} onChange={(e) => setDestino(e.target.value)} className={campo}>
          <option value="">Elegir cuenta…</option>
          {lista.map((a) => <option key={a.id} value={a.id}>{a.nombre}</option>)}
        </select>
      </label>
      {esMp && origen !== '' && destino !== '' && !adelantada && (
        <SelectorMovimientoMp titulo="Movimiento de Mercado Pago" candidatos={candidatosMp} cargando={actividadMp.cargando} value={movimientoMp} onChange={setMovimientoMp} />
      )}
      {esMp && ruta !== null && !sinMovimiento && (
        <label className="flex items-center gap-1 text-xs text-[#6B5D45]">
          <input type="checkbox" checked={anticipada} onChange={(e) => setAnticipada(e.target.checked)} />
          El movimiento todavía no está en Mercado Pago: registrar ahora y vincular cuando llegue
        </label>
      )}
      {adelantada && (
        <p className="text-xs bg-sky-50 border border-sky-200 text-sky-900 rounded-lg px-2 py-1">
          Queda registrada como pendiente de vinculación y no mueve dinero todavía. Cuando aparezca el movimiento de Mercado Pago, vinculalo en Transferencias: ahí se registra la transferencia, una sola vez.
        </p>
      )}
      {esMp && ruta === null && origen !== '' && destino !== '' && origen !== destino && <p className="text-xs text-[#8A7A5C]">Mercado Pago solo transfiere con una cuenta bancaria propia.</p>}
      {(!esMp || adelantada) && <>
      <label className={etiqueta}>Monto
        <input type="number" min="0" step="0.01" value={monto} onChange={(e) => setMonto(e.target.value)} className={campo} />
      </label>
      <label className={etiqueta}>Fecha
        <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} className={campo} />
      </label>
      <label className={etiqueta}>Notas (opcional)
        <input type="text" value={notas} onChange={(e) => setNotas(e.target.value)} className={campo} />
      </label>
      </>}
      </fieldset>
      {!esMp && <details className="border border-[#E4DCC8] rounded-lg p-2" open={hecha}>
        <summary className="text-sm text-[#8A6A2E] cursor-pointer">Impuesto Débitos/Créditos cobrado (opcional)</summary>
        <p className="text-xs text-[#8A7A5C] mt-1">Solo si el banco ya lo cobró y conocés el importe: no se calcula ningún porcentaje. Si llega después en el extracto, se concilia con este registro.</p>
        <label className={etiqueta}>Monto del impuesto
          <input type="number" min="0" step="0.01" value={impuesto} onChange={(e) => setImpuesto(e.target.value)} className={campo} />
        </label>
        {origen !== '' && destino !== '' && (
          <CuentaImpuesto transferencia={{ origen: { account_id: origen, nombre: nombre(origen) }, destino: { account_id: destino, nombre: nombre(destino) } }}
            value={cuentaTax} onChange={setCuentaImpuesto} />
        )}
        {taxRepetido && (
          <p className="text-xs text-amber-900 mt-1" role="alert">Ya hay un impuesto de {formatoPesos(taxRepetido.amount)} registrado el {formatearFechaLocal(taxRepetido.effective_date)} en esa cuenta.
            Registrá la transferencia sin impuesto y asocialo desde el historial (+ Impuesto cobrado): no se descuenta dos veces.</p>
        )}
      </details>}
    </Modal>
  );
}
