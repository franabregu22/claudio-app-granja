import { useState } from 'react';
import { errorMessage } from '../../target/messages';
import { mpOutflowCandidates } from '../../target/mpActivity';
import { ChevronDown } from 'lucide-react';
import type { SupplierRow } from '../../target/masters';
import { classifySuppliers, INSTRUMENT_TYPES, SUPPLIER_PAYMENT_METHODS, type InstrumentType, type SupplierAccount, type SupplierPaymentMethod } from '../../target/treasury';
import { getTodayDate } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';
import { useFinancialAccounts } from '../pedidos/useCommercial';
import { campo, etiqueta, Modal } from './Modal';
import { BloqueoMp, SelectorMovimientoMp, useActividadMp, useEsCuentaMp } from './MovimientoMp';
import { useClassifyMp } from './useMpActivity';
import { FichaProveedor } from './FichaProveedor';
import { GastosAPagar, usePayables } from './GastosAPagar';
import { useActiveMaster, useLedgerBalances, useTreasuryMutations } from './useTreasury';

const METODO: Record<SupplierPaymentMethod | InstrumentType, string> = {
  CASH: 'Efectivo', TRANSFER: 'Transferencia', MERCADOPAGO: 'MercadoPago', CHEQUE: 'Cheque', ECHEQ: 'eCheq',
};

type Tarjeta = 'DEUDA' | 'SIN_PROVEEDOR' | 'AL_DIA' | 'A_FAVOR';

/**
 * Cuentas a pagar (F27-D; Lote 3A): ONE module for what we owe, organised in selectable cards — suppliers with debt, pending
 * expenses without supplier, suppliers up to date, credits in our favour (advances). Only the chosen card's list is shown.
 * The supplier balance is the latest closing balance of the supplier ledger in report_balance_period (purchases + freight −
 * payments − issued / endorsed instruments, all booked by the backend); each supplier opens its ficha (FichaProveedor).
 * Paying is pay_supplier; paying with a cheque or eCheq is issue_supplier_instrument (the contract's only path); paying more than
 * the debt leaves a credit in our favour (an advance — never an expense). Pending expenses keep their own circuit (GastosAPagar).
 * Meta A (0091): paying from Mercado Pago is the payment of the supplier debt with a Mercado Pago outflow (payout to a third
 * party or outbound payment) chosen here: mp_classify_payout_outflow SUPPLIER_PAYMENT; amount and date come from the movement.
 */
export function CuentasAPagar() {
  const saldos = useLedgerBalances('SUPPLIER');
  const proveedores = useActiveMaster<SupplierRow>('suppliers');
  const gastos = usePayables(true);
  const [tarjeta, setTarjeta] = useState<Tarjeta>('DEUDA');
  const [abierto, setAbierto] = useState<string | null>(null);
  const [pagando, setPagando] = useState<SupplierAccount | null>(null);

  const cargando = saldos.isLoading || proveedores.isLoading || gastos.isLoading;
  const error = saldos.error ?? proveedores.error ?? gastos.error;
  if (cargando) return <p className="text-sm text-gray-500">Cargando cuentas a pagar...</p>;
  if (error) return <p className="text-sm text-red-700">{errorMessage(error)}</p>;

  const cuentas = classifySuppliers(saldos.data ?? [], proveedores.data ?? []);
  const de = (s: SupplierAccount['situation']) => cuentas.filter((c) => c.situation === s);
  const deuda = de('DEUDA').sort((a, b) => b.balance - a.balance);
  const alDia = de('AL_DIA');
  const aFavor = de('A_FAVOR').sort((a, b) => a.balance - b.balance);
  const pendientes = gastos.data ?? [];
  const suma = (xs: number[]) => xs.reduce((t, x) => t + x, 0);
  const tarjetas: { id: Tarjeta; titulo: string; cantidad: number; detalle: string; tono: string }[] = [
    { id: 'DEUDA', titulo: 'Proveedores con deuda', cantidad: deuda.length, detalle: `${formatoPesos(suma(deuda.map((c) => c.balance)))} a pagar`, tono: 'text-red-600' },
    { id: 'SIN_PROVEEDOR', titulo: 'Gastos sin proveedor', cantidad: pendientes.length, detalle: `${formatoPesos(suma(pendientes.map((g) => g.pending)))} pendiente`, tono: 'text-red-600' },
    { id: 'AL_DIA', titulo: 'Proveedores al día', cantidad: alDia.length, detalle: 'Saldo cero', tono: 'text-[#6B7A4E]' },
    { id: 'A_FAVOR', titulo: 'Saldos a favor / anticipos', cantidad: aFavor.length, detalle: `${formatoPesos(suma(aFavor.map((c) => -c.balance)))} a favor`, tono: 'text-green-700' },
  ];
  const lista = tarjeta === 'DEUDA' ? deuda : tarjeta === 'AL_DIA' ? alDia : aFavor;

  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="Cuentas a pagar" className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {tarjetas.map((t) => (
          <button key={t.id} role="tab" aria-selected={tarjeta === t.id} onClick={() => { setTarjeta(t.id); setAbierto(null); }}
            className={`text-left rounded-lg border p-3 transition ${tarjeta === t.id ? 'bg-white border-amber-600 ring-1 ring-amber-600 shadow-sm' : 'bg-white/60 border-[#E4DCC8] hover:border-amber-400'}`}>
            <p className="text-xs sm:text-sm font-semibold text-[#6B5D45] leading-tight">{t.titulo}</p>
            <p className="text-xl sm:text-2xl font-bold text-gray-900 mt-1">{t.cantidad}</p>
            <p className={`text-[11px] sm:text-xs ${t.tono} truncate`}>{t.detalle}</p>
          </button>
        ))}
      </div>

      {tarjeta === 'SIN_PROVEEDOR' ? <GastosAPagar titulo="Gastos sin proveedor" /> : (
        <div className="space-y-2">
          {lista.length === 0 && <p className="text-sm text-[#8A7A5C]">No hay proveedores en esta situación.</p>}
          {lista.map((c) => {
            const open = abierto === c.supplier_id;
            return (
              <div key={c.supplier_id} className="bg-white rounded-lg border border-[#E4DCC8] overflow-hidden">
                <div className="p-3 flex items-center justify-between gap-2">
                  <button type="button" onClick={() => setAbierto(open ? null : c.supplier_id)} className="flex items-center gap-2 text-left min-w-0" aria-expanded={open}>
                    <ChevronDown className={`w-4 h-4 shrink-0 transition ${open ? 'rotate-180' : ''}`} />
                    <span className="font-semibold text-amber-900 truncate">{c.nombre}</span>
                  </button>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className={`font-bold ${c.balance > 0 ? 'text-red-600' : c.balance < 0 ? 'text-green-700' : 'text-[#6B7A4E]'}`}>
                      {c.balance > 0 ? formatoPesos(c.balance) : c.balance < 0 ? `A favor ${formatoPesos(-c.balance)}` : 'Al día'}
                    </span>
                    <button onClick={() => setPagando(c)} className="text-sm px-3 py-1.5 bg-amber-600 text-white rounded-lg hover:bg-amber-700">
                      {c.balance > 0 ? 'Pagar' : 'Anticipo'}
                    </button>
                  </div>
                </div>
                {open && <FichaProveedor cuenta={c} />}
              </div>
            );
          })}
        </div>
      )}
      {pagando && <PagoProveedorModal proveedor={pagando} onClose={() => setPagando(null)} />}
    </div>
  );
}

function PagoProveedorModal({ proveedor, onClose }: { proveedor: SupplierAccount; onClose: () => void }) {
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
  const esMp = useEsCuentaMp(cuentaId);
  const actividadMp = useActividadMp(cuentaId, esMp && !esInstrumento);
  const candidatosMp = mpOutflowCandidates(actividadMp.rows, actividadMp.matches);
  const [movimientoMp, setMovimientoMp] = useState('');
  const { outflow } = useClassifyMp();
  const mutacionFinal = esMp && !esInstrumento ? outflow : mutacion;
  const puede = esMp ? !esInstrumento && candidatosMp.some((c) => c.sourceId === movimientoMp)
    : Number(monto) > 0 && cuentaId !== '' && fecha !== '' && (!esInstrumento || (numero.trim() !== '' && vencimiento !== ''));

  function guardar() {
    if (esMp) {
      if (!esInstrumento) outflow.mutate({ sourceId: movimientoMp, classification: 'SUPPLIER_PAYMENT', supplierId: proveedor.supplier_id }, { onSuccess: onClose });
      return;
    }
    if (esInstrumento) {
      issueInstrument.mutate({
        supplierId: proveedor.supplier_id, type: metodo as InstrumentType, chequeNumber: numero.trim(), amount: Number(monto), maturityDate: vencimiento,
        issuedDate: fecha, bankAccountId: cuentaId, externalRef: `EMI-${clave}`, reason: notas,
      }, { onSuccess: onClose });
    } else {
      paySupplier.mutate({
        supplierId: proveedor.supplier_id, amount: Number(monto), effectiveDate: fecha, method: metodo as SupplierPaymentMethod, accountId: cuentaId,
        externalRef: `PAG-${clave}`, reason: notas,
      }, { onSuccess: onClose });
    }
  }

  return (
    <Modal titulo={`${proveedor.balance > 0 ? 'Pagar a' : 'Anticipo a'} ${proveedor.nombre}`} onClose={onClose} onSubmit={guardar} puedeGuardar={puede} guardando={mutacionFinal.isPending}
      error={mutacionFinal.error ?? (esMp ? actividadMp.error : null)} textoGuardar={esInstrumento ? 'Emitir' : 'Registrar pago'}>
      <p className="text-sm text-gray-600">
        {proveedor.balance > 0 ? <>Deuda actual: <span className="font-bold text-red-600">{formatoPesos(proveedor.balance)}</span></>
          : proveedor.balance < 0 ? <>Saldo a favor actual: <span className="font-bold text-green-700">{formatoPesos(-proveedor.balance)}</span></> : 'Sin deuda.'}
      </p>
      {!esMp && Number(monto) > Math.max(proveedor.balance, 0) && (
        <p className="text-xs bg-green-50 border border-green-200 text-green-900 rounded p-2">
          {proveedor.balance > 0 ? `Excede la deuda en ${formatoPesos(Number(monto) - proveedor.balance)}: ese excedente` : 'Todo el importe'} queda como saldo a favor
          (anticipo) del proveedor. No es un gasto: se descuenta de sus próximas compras.
        </p>
      )}
      <div className="grid grid-cols-3 gap-2">
        {[...SUPPLIER_PAYMENT_METHODS, ...INSTRUMENT_TYPES].map((m) => (
          <button key={m} type="button" onClick={() => setMetodo(m)}
            className={`px-2 py-2 rounded-lg text-sm font-medium ${metodo === m ? 'bg-amber-600 text-white' : 'bg-stone-100 text-gray-700 hover:bg-stone-200'}`}>
            {METODO[m]}
          </button>
        ))}
      </div>
      <label className={etiqueta}>{esInstrumento ? 'Cuenta de emisión (se debita al cobrarse)' : 'Cuenta de la que sale el dinero'}
        <select value={cuentaId} onChange={(e) => setCuentaId(e.target.value)} className={campo}>
          <option value="">Elegir cuenta…</option>
          {(cuentas.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.nombre}</option>)}
        </select>
      </label>
      {esMp && (esInstrumento ? <BloqueoMp /> : (
        <SelectorMovimientoMp titulo="Salida de Mercado Pago" candidatos={candidatosMp} cargando={actividadMp.cargando} value={movimientoMp} onChange={setMovimientoMp} />
      ))}
      {!esMp && <>
      <label className={etiqueta}>Monto
        <input type="number" min="0" step="0.01" value={monto} onChange={(e) => setMonto(e.target.value)} className={campo} />
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
      </>}
      <label className={etiqueta}>Notas (opcional)
        <input type="text" value={notas} onChange={(e) => setNotas(e.target.value)} className={campo} />
      </label>
    </Modal>
  );
}
