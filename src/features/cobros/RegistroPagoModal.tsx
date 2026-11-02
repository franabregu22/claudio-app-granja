import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { balanceAfterCollection, balanceState, collectionMethodFor, type BalanceState, type ClientBalance } from '../../target/commercial';
import { DECLARED_LABEL } from '../../target/customerCollections';
import { errorMessage } from '../../target/messages';
import { useEsCuentaMp } from '../caja/MovimientoMp';
import { getTodayDate } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';
import { useFinancialAccounts, useRegisterCollection, useRegisterDeclaredCollection } from '../pedidos/useCommercial';

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

  useEffect(() => { dialogRef.current?.showModal(); }, []);
  const cerrar = () => { dialogRef.current?.close(); onClose(); };
  const montoNum = Number(monto);
  const importe = montoNum > 0 ? montoNum : 0;
  const { resultante, generaCredito } = balanceAfterCollection(cliente.balance, importe);
  const [creditoConfirmado, setCreditoConfirmado] = useState<number | null>(null);
  const creditoOk = !generaCredito || creditoConfirmado === resultante;
  const puedeGuardar = creditoOk && montoNum > 0 && fecha !== '' && (esMp ? !declarar.isPending : metodo !== null && !registrar.isPending);

  function guardar(e: React.FormEvent) {
    e.preventDefault();
    if (!puedeGuardar) return;
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
          <input type="number" min="0" step="0.01" value={monto} onChange={(e) => setMonto(e.target.value)} className={`${campo} mt-1`} placeholder="0" />
        </label>
        <label className="block text-sm font-medium text-gray-700">Cuenta donde entra el dinero
          <select value={cuentaId} onChange={(e) => setCuentaId(e.target.value)} className={`${campo} mt-1`}>
            <option value="">{cuentas.isLoading ? 'Cargando cuentas…' : 'Elegir cuenta…'}</option>
            {(cuentas.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.nombre}</option>)}
          </select>
        </label>
        {esMp && <p className="bg-amber-50 border border-amber-200 text-amber-900 px-3 py-2 rounded-lg text-xs">{DECLARED_LABEL}. Descuenta la cuenta corriente y no mueve el saldo de Mercado Pago.</p>}
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
        {(registrar.error || declarar.error || cuentas.error) && (
          <div className="bg-red-100 border border-red-300 text-red-800 px-3 py-2 rounded-lg text-sm">{errorMessage(registrar.error ?? declarar.error ?? cuentas.error)}</div>
        )}
        <div className="flex gap-2 pt-2">
          <button type="button" onClick={cerrar} className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 font-medium hover:bg-gray-50">Cancelar</button>
          <button type="submit" disabled={!puedeGuardar}
            className="flex-1 px-4 py-2 bg-amber-600 text-white rounded-lg font-medium hover:bg-amber-700 disabled:opacity-50">
            {registrar.isPending || declarar.isPending ? 'Guardando...' : 'Registrar cobro'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
