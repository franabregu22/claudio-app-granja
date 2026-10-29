import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { collectionMethodFor, type ClientBalance } from '../../target/commercial';
import { errorMessage } from '../../target/messages';
import { mpReceiptCandidates } from '../../target/mpActivity';
import { useAsignarCobroMp, useCobrosMp, useEsCuentaMp } from '../caja/MovimientoMp';
import { getTodayDate } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';
import { useFinancialAccounts, useRegisterCollection } from '../pedidos/useCommercial';
import { BuscadorCobroMp } from './BuscadorCobroMp';

interface RegistroPagoModalProps {
  cliente: ClientBalance;
  onClose: () => void;
}

/**
 * Collection entry (F27-C): register_collection only. The RPC books the client-ledger decrease, the financial
 * operation and the posting on the chosen account; cheques are received through the instruments flow (F27-D).
 * The method is not asked: it follows the destination account (caja → CASH, banco → TRANSFER). The receipt id is the
 * contract's idempotency key, generated once per opened form (never typed), so a double submit cannot book twice.
 * Meta A (0091): with account = Mercado Pago the user picks the Mercado Pago receipt and the collection is its allocation
 * to the client (mp_allocate_to_client): date and SOURCE_ID come from the receipt; the amount defaults to what is left to
 * assign and may be lower (a receipt split between clients, or a partial payment) — never higher; the server re-checks
 * it (ALLOCATION_EXCEEDS_RECEIPT). No new money is booked: the receipt is already in treasury. No receipt → blocked.
 */
export function RegistroPagoModal({ cliente, onClose }: RegistroPagoModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cuentas = useFinancialAccounts();
  const registrar = useRegisterCollection();
  const [monto, setMonto] = useState('');
  const [fecha, setFecha] = useState(getTodayDate());
  const [cuentaId, setCuentaId] = useState('');
  const [notas, setNotas] = useState('');
  const [claveAuto] = useState(() => `COBRO-${crypto.randomUUID()}`);
  const esMp = useEsCuentaMp(cuentaId);
  const metodo = collectionMethodFor((cuentas.data ?? []).find((a) => a.id === cuentaId)?.account_type);
  const cobrosMp = useCobrosMp(esMp);
  const asignar = useAsignarCobroMp();
  const candidatosMp = mpReceiptCandidates(cobrosMp.rows);
  const [movimientoMp, setMovimientoMp] = useState('');
  const [montoMp, setMontoMp] = useState('');
  const elegidoMp = candidatosMp.find((c) => c.sourceId === movimientoMp);
  const elegirMp = (sourceId: string) => {
    setMovimientoMp(sourceId);
    setMontoMp(String(candidatosMp.find((c) => c.sourceId === sourceId)?.amount ?? ''));
  };

  useEffect(() => { dialogRef.current?.showModal(); }, []);
  const cerrar = () => { dialogRef.current?.close(); onClose(); };
  const montoNum = Number(monto);
  const montoMpNum = Number(montoMp);
  const montoMpValido = Boolean(elegidoMp) && montoMpNum > 0 && montoMpNum <= (elegidoMp?.amount ?? 0);
  const puedeGuardar = esMp ? montoMpValido && !asignar.isPending : montoNum > 0 && metodo !== null && fecha !== '' && !registrar.isPending;

  function guardar(e: React.FormEvent) {
    e.preventDefault();
    if (!puedeGuardar) return;
    if (esMp) {
      if (!elegidoMp || !montoMpValido) return;
      asignar.mutate({ movementId: elegidoMp.movementId, clienteId: cliente.cliente_id, amount: montoMpNum, effectiveDate: elegidoMp.date,
        idempotencyKey: `ui:${claveAuto}`, reason: notas.trim() || 'Cobro de cliente en Mercado Pago' }, { onSuccess: cerrar });
      return;
    }
    if (!metodo) return;
    registrar.mutate({
      clienteId: cliente.cliente_id, amount: montoNum, method: metodo, receiptId: claveAuto,
      effectiveDate: fecha, accountId: cuentaId, reason: notas,
    }, { onSuccess: cerrar });
  }

  const campo = 'w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-amber-600';
  return (
    <dialog ref={dialogRef} onClose={cerrar} className="w-full max-w-md p-5 rounded-lg backdrop:bg-black backdrop:bg-opacity-50">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-amber-900">Registrar cobro — {cliente.cliente_nombre}</h2>
        <button onClick={cerrar} className="text-gray-400 hover:text-gray-600"><X size={24} /></button>
      </div>
      <div className="bg-stone-50 p-3 rounded-lg text-sm mb-4 text-gray-600">
        Saldo pendiente: <span className="font-bold text-lg text-red-600">{formatoPesos(cliente.balance)}</span>
      </div>
      <form onSubmit={guardar} className="space-y-4">
        {!esMp && <label className="block text-sm font-medium text-gray-700">Monto
          <input type="number" min="0" step="0.01" value={monto} onChange={(e) => setMonto(e.target.value)} className={`${campo} mt-1`} placeholder="0" />
        </label>}
        <label className="block text-sm font-medium text-gray-700">Cuenta donde entra el dinero
          <select value={cuentaId} onChange={(e) => setCuentaId(e.target.value)} className={`${campo} mt-1`}>
            <option value="">{cuentas.isLoading ? 'Cargando cuentas…' : 'Elegir cuenta…'}</option>
            {(cuentas.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.nombre}</option>)}
          </select>
        </label>
        {esMp && (
          <BuscadorCobroMp candidatos={candidatosMp} cargando={cobrosMp.cargando} value={movimientoMp} onChange={elegirMp} />
        )}
        {esMp && elegidoMp && <label className="block text-sm font-medium text-gray-700">Monto a imputar a este cliente
          <input type="number" min="0.01" step="0.01" max={elegidoMp.amount} value={montoMp} onChange={(e) => setMontoMp(e.target.value)} className={`${campo} mt-1`} />
          <span className={`block text-xs mt-1 ${montoMpValido ? 'text-gray-500' : 'text-red-600'}`}>
            Disponible MP: {formatoPesos(elegidoMp.amount)} (dinero del movimiento todavía sin imputar).
          </span>
        </label>}
        {!esMp && <label className="block text-sm font-medium text-gray-700">Fecha del cobro
          <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} className={`${campo} mt-1`} />
        </label>}
        <label className="block text-sm font-medium text-gray-700">Comentario (opcional)
          <textarea value={notas} onChange={(e) => setNotas(e.target.value)} rows={2} className={`${campo} mt-1 resize-none`} />
        </label>
        {(registrar.error || asignar.error || cobrosMp.error || cuentas.error) && (
          <div className="bg-red-100 border border-red-300 text-red-800 px-3 py-2 rounded-lg text-sm">{errorMessage(registrar.error ?? asignar.error ?? cobrosMp.error ?? cuentas.error)}</div>
        )}
        <div className="flex gap-2 pt-2">
          <button type="button" onClick={cerrar} className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 font-medium hover:bg-gray-50">Cancelar</button>
          <button type="submit" disabled={!puedeGuardar}
            className="flex-1 px-4 py-2 bg-amber-600 text-white rounded-lg font-medium hover:bg-amber-700 disabled:opacity-50">
            {registrar.isPending || asignar.isPending ? 'Guardando...' : 'Registrar cobro'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
