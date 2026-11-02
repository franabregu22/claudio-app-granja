import { useState } from 'react';
import { ArrowLeftRight } from 'lucide-react';
import { errorMessage } from '../../target/messages';
import { mpOwnInflowCandidates, mpOwnPayoutCandidates } from '../../target/mpActivity';
import { formatearFechaLocal, getTodayDate } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';
import { useFinancialAccounts } from '../pedidos/useCommercial';
import type { TransferHistoryRow } from '../../target/treasury';
import { campo, etiqueta, Modal } from './Modal';
import { SelectorMovimientoMp, useActividadMp, useEsCuentaMp } from './MovimientoMp';
import { useClassifyMp, useConfirmPayoutTransfer } from './useMpActivity';
import { useBankTaxPeriods, useTransfers, useTreasuryMutations } from './useTreasury';

/**
 * Caja → Transferencias: the history of transfers between own accounts, their related tax and a new manual transfer
 * (TransferenciaModal keeps its idempotency key per opened form and its Mercado Pago routes). A transfer is one operation with
 * two postings, listed once here.
 */
export function Transferencias() {
  const cuentas = useFinancialAccounts();
  const [transfiriendo, setTransfiriendo] = useState(false);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-[#8A7A5C]">Movimientos entre cuentas propias.</p>
        <button onClick={() => setTransfiriendo(true)} disabled={(cuentas.data ?? []).length < 2}
          className="flex items-center gap-2 text-sm px-3 py-2 bg-amber-100 text-amber-900 rounded-lg hover:bg-amber-200 disabled:opacity-50">
          <ArrowLeftRight className="w-4 h-4" /> Transferir entre cuentas
        </button>
      </div>
      {transfiriendo && <TransferenciaModal onClose={() => setTransfiriendo(false)} />}
      <div className="bg-white rounded-lg border border-[#E4DCC8] p-4">
        <HistorialTransferencias />
        <ImpuestoPorPeriodo />
      </div>
    </div>
  );
}

/** D-WALK-2 / D-WALK-7: read-only transfer history; the related tax line shows only when the relation exists. */
function HistorialTransferencias() {
  const transferencias = useTransfers();
  const [agregando, setAgregando] = useState<TransferHistoryRow | null>(null);
  if (transferencias.isLoading) return <p className="mt-4 text-sm text-gray-500">Cargando transferencias...</p>;
  if (transferencias.error) return <p className="mt-4 text-sm text-red-700">{errorMessage(transferencias.error)}</p>;
  const filas = transferencias.data ?? [];
  return (
    <div>
      <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide mb-2">Historial</p>
      {filas.length === 0 && <p className="text-sm text-[#8A7A5C]">No hay transferencias registradas.</p>}
      <div className="space-y-2">
        {filas.map((t) => (
          <div key={t.id} className="border border-[#E4DCC8] rounded-lg p-2 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span>{formatearFechaLocal(t.effective_date)} · {t.origen?.nombre ?? '—'} → {t.destino?.nombre ?? '—'} · <span className="font-bold">{formatoPesos(t.amount)}</span></span>
              {t.impuestos.length === 0 && (
                <button onClick={() => setAgregando(t)} className="text-xs text-[#A8552E] hover:underline">+ Impuesto</button>
              )}
            </div>
            {t.impuestos.map((i) => (
              <p key={i.id} className="text-xs text-[#8A7A5C]">Impuesto Débitos/Créditos relacionado · {formatoPesos(i.amount)}</p>
            ))}
          </div>
        ))}
      </div>
      {filas.length >= 50 && <p className="text-xs text-[#8A7A5C] mt-2">Se muestran las 50 transferencias más recientes.</p>}
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

/** Register the tax of an existing transfer (also the recovery path after a partial success). */
function ImpuestoModal({ transferencia, onClose }: { transferencia: TransferHistoryRow; onClose: () => void }) {
  const { bankTax } = useTreasuryMutations();
  const [cuenta, setCuenta] = useState(transferencia.origen?.account_id ?? '');
  const [monto, setMonto] = useState('');
  const [clave] = useState(() => `IDC-${crypto.randomUUID()}`);   // idempotency: one per opened form
  const puede = cuenta !== '' && Number(monto) > 0;
  return (
    <Modal titulo="Impuesto Débitos/Créditos" onClose={onClose} puedeGuardar={puede} guardando={bankTax.isPending} error={bankTax.error}
      textoGuardar="Registrar impuesto"
      onSubmit={() => bankTax.mutate({ accountId: cuenta, amount: Number(monto), effectiveDate: transferencia.effective_date, externalRef: clave, relatedOperationId: transferencia.id },
        { onSuccess: onClose })}>
      <p className="text-sm">{formatearFechaLocal(transferencia.effective_date)} · {transferencia.origen?.nombre ?? '—'} → {transferencia.destino?.nombre ?? '—'} · {formatoPesos(transferencia.amount)}</p>
      <CuentaImpuesto transferencia={transferencia} value={cuenta} onChange={setCuenta} />
      <label className={etiqueta}>Monto del impuesto
        <input type="number" min="0" step="0.01" value={monto} onChange={(e) => setMonto(e.target.value)} className={campo} />
      </label>
    </Modal>
  );
}

function CuentaImpuesto({ transferencia, value, onChange }: { transferencia: Pick<TransferHistoryRow, 'origen' | 'destino'>; value: string; onChange: (v: string) => void }) {
  return (
    <label className={etiqueta}>Cuenta debitada por el impuesto
      <select value={value} onChange={(e) => onChange(e.target.value)} className={campo}>
        {transferencia.origen && <option value={transferencia.origen.account_id}>{transferencia.origen.nombre} (origen)</option>}
        {transferencia.destino && <option value={transferencia.destino.account_id}>{transferencia.destino.nombre} (destino)</option>}
      </select>
    </label>
  );
}

/**
 * Transfer between own accounts. Meta A (0091): a transfer that touches Mercado Pago is the Mercado Pago movement chosen
 * here — Mercado Pago → own account: the payout whose destination is exactly that account (mp_confirm_payout_transfer);
 * own account → Mercado Pago: the inflow from an own account (mp_reclassify_inbound_own_transfer). Amount and date come
 * from the movement; without a candidate the transfer is blocked.
 */
function TransferenciaModal({ onClose }: { onClose: () => void }) {
  const cuentas = useFinancialAccounts();
  const { transferWithTax } = useTreasuryMutations();
  const [origen, setOrigen] = useState('');
  const [destino, setDestino] = useState('');
  const [monto, setMonto] = useState('');
  const [fecha, setFecha] = useState(getTodayDate());
  const [notas, setNotas] = useState('');
  const [clave] = useState(() => `TRF-${crypto.randomUUID()}`);   // idempotency: one per opened form
  const [impuesto, setImpuesto] = useState('');
  const [cuentaImpuesto, setCuentaImpuesto] = useState('');
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
  const puede = esMp ? candidatosMp.some((c) => c.sourceId === movimientoMp) : origen !== '' && destino !== '' && Number(monto) > 0 && fecha !== '';
  const nombre = (id: string) => (cuentas.data ?? []).find((a) => a.id === id)?.nombre ?? '—';

  function guardar() {
    if (esMp) {
      if (origenMp) confirmarRetiro.mutate(movimientoMp, { onSuccess: onClose });
      else ownTransfer.mutate({ paymentId: movimientoMp, fromAccountId: origen }, { onSuccess: onClose });
      return;
    }
    const tax = Number(impuesto) > 0 ? { accountId: cuentaImpuesto || origen, amount: Number(impuesto) } : null;
    transferWithTax.mutate({ sourceAccountId: origen, destAccountId: destino, amount: Number(monto), effectiveDate: fecha, externalRef: clave, reason: notas,
      transferOperationId: operacionId, tax }, {
      onSuccess: (r) => {
        if (r.taxError) { setOperacionId(r.transferOperationId); setErrorImpuesto(r.taxError); } else onClose();
      },
    });
  }

  return (
    <Modal titulo="Transferir entre cuentas" onClose={onClose} puedeGuardar={puede} guardando={transferWithTax.isPending || mutacionMp.isPending}
      error={esMp ? mutacionMp.error ?? actividadMp.error : transferWithTax.error}
      textoGuardar={hecha ? 'Reintentar impuesto' : 'Transferir'} onSubmit={guardar}>
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
          {(cuentas.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.nombre}</option>)}
        </select>
      </label>
      <label className={etiqueta}>Hacia
        <select value={destino} onChange={(e) => setDestino(e.target.value)} className={campo}>
          <option value="">Elegir cuenta…</option>
          {(cuentas.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.nombre}</option>)}
        </select>
      </label>
      {esMp && origen !== '' && destino !== '' && (
        <SelectorMovimientoMp titulo="Movimiento de Mercado Pago" candidatos={candidatosMp} cargando={actividadMp.cargando} value={movimientoMp} onChange={setMovimientoMp} />
      )}
      {!esMp && <>
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
        <summary className="text-sm text-[#8A6A2E] cursor-pointer">Impuesto Débitos/Créditos (opcional)</summary>
        <label className={etiqueta}>Monto del impuesto
          <input type="number" min="0" step="0.01" value={impuesto} onChange={(e) => setImpuesto(e.target.value)} className={campo} />
        </label>
        {origen !== '' && destino !== '' && (
          <CuentaImpuesto transferencia={{ origen: { account_id: origen, nombre: nombre(origen) }, destino: { account_id: destino, nombre: nombre(destino) } }}
            value={cuentaImpuesto || origen} onChange={setCuentaImpuesto} />
        )}
      </details>}
    </Modal>
  );
}
