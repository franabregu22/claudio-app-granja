import { useState } from 'react';
import { errorMessage } from '../../target/messages';
import { INSTRUMENT_TYPES, SUPPLIER_PAYMENT_METHODS, type InstrumentType, type LedgerBalance, type SupplierPaymentMethod } from '../../target/treasury';
import { getTodayDate } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';
import { useFinancialAccounts } from '../pedidos/useCommercial';
import { campo, etiqueta, Modal } from './Modal';
import { useLedgerBalances, useTreasuryMutations } from './useTreasury';

const METODO: Record<SupplierPaymentMethod | InstrumentType, string> = {
  CASH: 'Efectivo', TRANSFER: 'Transferencia', MERCADOPAGO: 'MercadoPago', CHEQUE: 'Cheque', ECHEQ: 'eCheq',
};

/**
 * Cuentas a pagar (F27-D): the supplier balance is the latest closing balance of the supplier ledger in
 * report_balance_period (purchases + freight − payments − issued / endorsed instruments, all booked by the backend).
 * Paying is pay_supplier; paying with a cheque or eCheq is issue_supplier_instrument (the contract's only path).
 */
export function CuentasAPagar() {
  const saldos = useLedgerBalances('SUPPLIER');
  const [pagando, setPagando] = useState<LedgerBalance | null>(null);

  if (saldos.isLoading) return <p className="text-sm text-gray-500">Cargando saldos de proveedores...</p>;
  if (saldos.error) return <p className="text-sm text-red-700">{errorMessage(saldos.error)}</p>;
  const deudas = (saldos.data ?? []).filter((s) => s.balance > 0).sort((a, b) => b.balance - a.balance);
  const aFavor = (saldos.data ?? []).filter((s) => s.balance < 0);

  return (
    <div className="space-y-2">
      {deudas.length === 0 && <p className="text-sm text-[#8A7A5C]">No hay deudas con proveedores.</p>}
      {deudas.map((s) => (
        <div key={s.entity_id} className="bg-white rounded-lg border border-[#E4DCC8] p-3 flex items-center justify-between gap-2">
          <span className="font-semibold text-amber-900">{s.entity_name}</span>
          <div className="flex items-center gap-3">
            <span className="font-bold text-red-600">{formatoPesos(s.balance)}</span>
            <button onClick={() => setPagando(s)} className="text-sm px-3 py-1.5 bg-amber-600 text-white rounded-lg hover:bg-amber-700">Pagar</button>
          </div>
        </div>
      ))}
      {aFavor.length > 0 && (
        <div className="pt-2">
          <p className="text-xs font-semibold text-green-700 uppercase mb-1">Saldo a favor con proveedores</p>
          {aFavor.map((s) => (
            <p key={s.entity_id} className="text-sm text-gray-700">{s.entity_name} · <span className="text-green-700 font-semibold">{formatoPesos(Math.abs(s.balance))}</span></p>
          ))}
        </div>
      )}
      {pagando && <PagoProveedorModal proveedor={pagando} onClose={() => setPagando(null)} />}
    </div>
  );
}

function PagoProveedorModal({ proveedor, onClose }: { proveedor: LedgerBalance; onClose: () => void }) {
  const cuentas = useFinancialAccounts();
  const { paySupplier, issueInstrument } = useTreasuryMutations();
  const [metodo, setMetodo] = useState<SupplierPaymentMethod | InstrumentType>('TRANSFER');
  const [monto, setMonto] = useState('');
  const [fecha, setFecha] = useState(getTodayDate());
  const [cuentaId, setCuentaId] = useState('');
  const [numero, setNumero] = useState('');
  const [vencimiento, setVencimiento] = useState(getTodayDate());
  const [notas, setNotas] = useState('');
  const [clave] = useState(() => crypto.randomUUID());   // idempotency: one per opened form
  const esInstrumento = (INSTRUMENT_TYPES as readonly string[]).includes(metodo);
  const mutacion = esInstrumento ? issueInstrument : paySupplier;
  const puede = Number(monto) > 0 && cuentaId !== '' && fecha !== '' && (!esInstrumento || (numero.trim() !== '' && vencimiento !== ''));

  function guardar() {
    if (esInstrumento) {
      issueInstrument.mutate({
        supplierId: proveedor.entity_id, type: metodo as InstrumentType, chequeNumber: numero.trim(), amount: Number(monto), maturityDate: vencimiento,
        issuedDate: fecha, bankAccountId: cuentaId, externalRef: `EMI-${clave}`, reason: notas,
      }, { onSuccess: onClose });
    } else {
      paySupplier.mutate({
        supplierId: proveedor.entity_id, amount: Number(monto), effectiveDate: fecha, method: metodo as SupplierPaymentMethod, accountId: cuentaId,
        externalRef: `PAG-${clave}`, reason: notas,
      }, { onSuccess: onClose });
    }
  }

  return (
    <Modal titulo={`Pagar a ${proveedor.entity_name}`} onClose={onClose} onSubmit={guardar} puedeGuardar={puede} guardando={mutacion.isPending}
      error={mutacion.error} textoGuardar={esInstrumento ? 'Emitir' : 'Registrar pago'}>
      <p className="text-sm text-gray-600">Deuda actual: <span className="font-bold text-red-600">{formatoPesos(proveedor.balance)}</span></p>
      <div className="grid grid-cols-3 gap-2">
        {[...SUPPLIER_PAYMENT_METHODS, ...INSTRUMENT_TYPES].map((m) => (
          <button key={m} type="button" onClick={() => setMetodo(m)}
            className={`px-2 py-2 rounded-lg text-sm font-medium ${metodo === m ? 'bg-amber-600 text-white' : 'bg-stone-100 text-gray-700 hover:bg-stone-200'}`}>
            {METODO[m]}
          </button>
        ))}
      </div>
      <label className={etiqueta}>Monto
        <input type="number" min="0" step="0.01" value={monto} onChange={(e) => setMonto(e.target.value)} className={campo} />
      </label>
      <label className={etiqueta}>{esInstrumento ? 'Cuenta de emisión (se debita al cobrarse)' : 'Cuenta de la que sale el dinero'}
        <select value={cuentaId} onChange={(e) => setCuentaId(e.target.value)} className={campo}>
          <option value="">Elegir cuenta…</option>
          {(cuentas.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.nombre}</option>)}
        </select>
      </label>
      <label className={etiqueta}>{esInstrumento ? 'Fecha de emisión' : 'Fecha del pago'}
        <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} className={campo} />
      </label>
      {esInstrumento && (
        <>
          <label className={etiqueta}>Número de {METODO[metodo]}
            <input type="text" value={numero} onChange={(e) => setNumero(e.target.value)} className={campo} />
          </label>
          <label className={etiqueta}>Vencimiento
            <input type="date" value={vencimiento} onChange={(e) => setVencimiento(e.target.value)} className={campo} />
          </label>
        </>
      )}
      <label className={etiqueta}>Notas (opcional)
        <input type="text" value={notas} onChange={(e) => setNotas(e.target.value)} className={campo} />
      </label>
    </Modal>
  );
}
