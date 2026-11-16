import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { balanceAfterCollection, balanceState, collectionMethodFor, type BalanceState, type ClientBalance } from '../../target/commercial';
import { DECLARED_LABEL } from '../../target/customerCollections';
import { errorMessage } from '../../target/messages';
import { useEsCuentaMp } from '../caja/MovimientoMp';
import { getTodayDate } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';
import { useFinancialAccounts, useRegisterCollection, useRegisterDeclaredCollection } from '../pedidos/useCommercial';
import { useTreasuryMutations } from '../caja/useTreasury';
import { NumeroInput } from '../../components/NumeroInput';

const ESTADO: Record<BalanceState, { texto: string; tono: string }> = {
  DEBE: { texto: 'Debe', tono: 'text-red-600' }, AL_DIA: { texto: 'Al día', tono: 'text-[#6B7A4E]' }, A_FAVOR: { texto: 'A favor', tono: 'text-green-700' },
};
function SaldoTexto({ balance }: { balance: number }) {
  const { estado, monto } = balanceState(balance);
  return <span className={`font-bold ${ESTADO[estado].tono}`}>{ESTADO[estado].texto}{estado === 'AL_DIA' ? '' : ` ${formatoPesos(monto)}`}</span>;
}

interface RegistroPagoModalProps {
  cliente: ClientBalance;
  onClose: () => void;
}

/**
 * Collection entry (F27-C): register_collection only. The RPC books the client-ledger decrease, the financial
 * operation and the posting on the chosen account; cheques are received through the instruments flow (F27-D).
 * The method is not asked: it follows the destination account (caja → CASH, banco → TRANSFER). The receipt id is the
 * contract's idempotency key, generated once per opened form (never typed), so a double submit cannot book twice.
 * ADR-027 (0112): with account = Mercado Pago the collection is declared (register_declared_collection): same amount, date and
 * note, it lowers the client's current account and nothing else. No movement is searched or linked, no money moves.
 * A collection that creates or increases a credit in the client's favour (prepayment / overpayment, allowed by the frozen architecture)
 * needs an explicit confirmation of that exact resulting balance.
 * caja-mejoras-v2 (0123): "Cheque / eCheq" receives a client cheque (receive_cheque, unchanged): it lowers the client's balance and
 * goes to Caja → Cartera de cheques; no money moves until the bank credits it (or it is endorsed to a supplier).
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
  const declarar = useRegisterDeclaredCollection();
  const { receiveCheque } = useTreasuryMutations();
  const [forma, setForma] = useState<'CUENTA' | 'CHEQUE'>('CUENTA');
  const [chTipo, setChTipo] = useState<'CHEQUE' | 'ECHEQ'>('ECHEQ');
  const [chNumero, setChNumero] = useState('');
  const [chFecha, setChFecha] = useState(getTodayDate());
  const esCheque = forma === 'CHEQUE';

  useEffect(() => { dialogRef.current?.showModal(); }, []);
  const cerrar = () => { dialogRef.current?.close(); onClose(); };
  const montoNum = Number(monto);
  const importe = montoNum > 0 ? montoNum : 0;
  const { resultante, generaCredito } = balanceAfterCollection(cliente.balance, importe);
  const [creditoConfirmado, setCreditoConfirmado] = useState<number | null>(null);
  const creditoOk = !generaCredito || creditoConfirmado === resultante;
  const puedeGuardar = creditoOk && montoNum > 0 && fecha !== '' && (esCheque ? chNumero.trim() !== '' && chFecha !== '' && !receiveCheque.isPending
    : esMp ? !declarar.isPending : metodo !== null && !registrar.isPending);

  function guardar(e: React.FormEvent) {
    e.preventDefault();
    if (!puedeGuardar) return;
    if (esCheque) {
      receiveCheque.mutate({ clienteId: cliente.cliente_id, type: chTipo, chequeNumber: chNumero.trim(), amount: montoNum, maturityDate: chFecha,
        receivedAt: `${fecha}T12:00:00`, receiptId: claveAuto, reason: notas }, { onSuccess: cerrar });
      return;
    }
    if (esMp) {
      declarar.mutate({ clienteId: cliente.cliente_id, amount: montoNum, effectiveDate: fecha, note: notas, idempotencyKey: `ui:${claveAuto}` }, { onSuccess: cerrar });
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
        Saldo actual: <span className="text-lg"><SaldoTexto balance={cliente.balance} /></span>
      </div>
      <form onSubmit={guardar} className="space-y-4">
        <label className="block text-sm font-medium text-gray-700">Importe a registrar
          <NumeroInput min="0" step="0.01" value={monto} onChange={(e) => setMonto(e.target.value)} className={`${campo} mt-1`} placeholder="0" />
        </label>
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Forma de cobro">
          {([['CUENTA', 'Dinero en cuenta'], ['CHEQUE', 'Cheque / eCheq']] as const).map(([f, l]) => (
            <button key={f} type="button" role="radio" aria-checked={forma === f} onClick={() => setForma(f)}
              className={`py-2 rounded-lg text-sm font-medium border ${forma === f ? 'bg-amber-600 text-white border-amber-600' : 'bg-white text-gray-700 border-gray-300'}`}>{l}</button>
          ))}
        </div>
        {esCheque ? (
          <div className="space-y-2 border border-[#E4DCC8] rounded-lg p-2">
            <div className="grid grid-cols-2 gap-2">
              <label className="block text-sm font-medium text-gray-700">Tipo
                <select value={chTipo} onChange={(e) => setChTipo(e.target.value as 'CHEQUE' | 'ECHEQ')} className={`${campo} mt-1`}><option value="ECHEQ">eCheq</option><option value="CHEQUE">Cheque</option></select>
              </label>
              <label className="block text-sm font-medium text-gray-700">Número
                <input value={chNumero} onChange={(e) => setChNumero(e.target.value)} className={`${campo} mt-1`} />
              </label>
            </div>
            <label className="block text-sm font-medium text-gray-700">Fecha de cobro del cheque
              <input type="date" value={chFecha} onChange={(e) => setChFecha(e.target.value)} className={`${campo} mt-1`} />
            </label>
            <p className="text-xs text-[#6B5D45]">Baja la cuenta corriente del cliente y el cheque queda en Caja → Cartera de cheques. El dinero entra cuando se acredita.</p>
          </div>
        ) : (
        <label className="block text-sm font-medium text-gray-700">{esMp ? 'Medio de cobro' : 'Cuenta donde entra el dinero'}
          <select value={cuentaId} onChange={(e) => setCuentaId(e.target.value)} className={`${campo} mt-1`}>
            <option value="">{cuentas.isLoading ? 'Cargando cuentas…' : 'Elegir cuenta…'}</option>
            {(cuentas.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.nombre}</option>)}
          </select>
        </label>
        )}
        {!esCheque && esMp && <p className="bg-amber-50 border border-amber-200 text-amber-900 px-3 py-2 rounded-lg text-xs">{DECLARED_LABEL}. Descuenta la cuenta corriente y no mueve el saldo de Mercado Pago.</p>}
        <label className="block text-sm font-medium text-gray-700">Fecha del cobro
          <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} className={`${campo} mt-1`} />
        </label>
        <label className="block text-sm font-medium text-gray-700">Comentario (opcional)
          <textarea value={notas} onChange={(e) => setNotas(e.target.value)} rows={2} className={`${campo} mt-1 resize-none`} />
        </label>
        {importe > 0 && (
          <div className="bg-stone-50 border border-[#E4DCC8] p-3 rounded-lg text-sm text-gray-600" aria-live="polite">
            Saldo resultante: <SaldoTexto balance={resultante} />
            {generaCredito && (
              <label className="flex items-start gap-2 mt-2 text-sm text-green-900">
                <input type="checkbox" className="mt-0.5" checked={creditoConfirmado === resultante}
                  onChange={(e) => setCreditoConfirmado(e.target.checked ? resultante : null)} />
                <span>Confirmo que {cliente.cliente_nombre} queda con {formatoPesos(-resultante)} a favor.</span>
              </label>
            )}
          </div>
        )}
        {(registrar.error || declarar.error || receiveCheque.error || cuentas.error) && (
          <div className="bg-red-100 border border-red-300 text-red-800 px-3 py-2 rounded-lg text-sm">{errorMessage(registrar.error ?? declarar.error ?? receiveCheque.error ?? cuentas.error)}</div>
        )}
        <div className="flex gap-2 pt-2">
          <button type="button" onClick={cerrar} className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 font-medium hover:bg-gray-50">Cancelar</button>
          <button type="submit" disabled={!puedeGuardar}
            className="flex-1 px-4 py-2 bg-amber-600 text-white rounded-lg font-medium hover:bg-amber-700 disabled:opacity-50">
            {registrar.isPending || declarar.isPending || receiveCheque.isPending ? 'Guardando...' : 'Registrar cobro'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
