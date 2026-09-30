import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { COLLECTION_METHODS, type ClientBalance, type CollectionMethod } from '../../target/commercial';
import { errorMessage } from '../../target/messages';
import { getTodayDate } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';
import { useFinancialAccounts, useRegisterCollection } from '../pedidos/useCommercial';

const METODO: Record<CollectionMethod, string> = { CASH: 'Efectivo', TRANSFER: 'Transferencia', MERCADOPAGO: 'MercadoPago' };

interface RegistroPagoModalProps {
  cliente: ClientBalance;
  onClose: () => void;
}

/**
 * Collection entry (F27-C): register_collection only. The RPC books the client-ledger decrease, the financial
 * operation and the posting on the chosen account; cheques are received through the instruments flow (F27-D).
 * The receipt id is the contract's idempotency key: one per opened form, so a double submit cannot book twice.
 */
export function RegistroPagoModal({ cliente, onClose }: RegistroPagoModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cuentas = useFinancialAccounts();
  const registrar = useRegisterCollection();
  const [monto, setMonto] = useState('');
  const [metodo, setMetodo] = useState<CollectionMethod>('CASH');
  const [fecha, setFecha] = useState(getTodayDate());
  const [cuentaId, setCuentaId] = useState('');
  const [comprobante, setComprobante] = useState('');
  const [notas, setNotas] = useState('');
  const [claveAuto] = useState(() => `COBRO-${crypto.randomUUID()}`);

  useEffect(() => { dialogRef.current?.showModal(); }, []);
  const cerrar = () => { dialogRef.current?.close(); onClose(); };
  const montoNum = Number(monto);
  const puedeGuardar = montoNum > 0 && cuentaId !== '' && fecha !== '' && !registrar.isPending;

  function guardar(e: React.FormEvent) {
    e.preventDefault();
    if (!puedeGuardar) return;
    registrar.mutate({
      clienteId: cliente.cliente_id, amount: montoNum, method: metodo, receiptId: comprobante.trim() || claveAuto,
      effectiveDate: fecha, accountId: cuentaId, reason: notas,
    }, { onSuccess: cerrar });
  }

  const campo = 'w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-amber-600';
  return (
    <dialog ref={dialogRef} onClose={cerrar} className="w-full max-w-sm p-6 rounded-lg backdrop:bg-black backdrop:bg-opacity-50">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-amber-900">Registrar cobro — {cliente.cliente_nombre}</h2>
        <button onClick={cerrar} className="text-gray-400 hover:text-gray-600"><X size={24} /></button>
      </div>
      <div className="bg-stone-50 p-3 rounded-lg text-sm mb-4 text-gray-600">
        Saldo pendiente: <span className="font-bold text-lg text-red-600">{formatoPesos(cliente.balance)}</span>
      </div>
      <form onSubmit={guardar} className="space-y-4">
        <label className="block text-sm font-medium text-gray-700">Monto
          <input type="number" min="0" step="0.01" value={monto} onChange={(e) => setMonto(e.target.value)} className={`${campo} mt-1`} placeholder="0" />
        </label>
        <div>
          <p className="block text-sm font-medium text-gray-700 mb-2">Método</p>
          <div className="grid grid-cols-3 gap-2">
            {COLLECTION_METHODS.map((m) => (
              <button key={m} type="button" onClick={() => setMetodo(m)}
                className={`px-3 py-2 rounded-lg text-sm font-medium ${metodo === m ? 'bg-amber-600 text-white' : 'bg-stone-100 text-gray-700 hover:bg-stone-200'}`}>
                {METODO[m]}
              </button>
            ))}
          </div>
        </div>
        <label className="block text-sm font-medium text-gray-700">Cuenta donde entra el dinero
          <select value={cuentaId} onChange={(e) => setCuentaId(e.target.value)} className={`${campo} mt-1`}>
            <option value="">{cuentas.isLoading ? 'Cargando cuentas…' : 'Elegir cuenta…'}</option>
            {(cuentas.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.nombre}</option>)}
          </select>
        </label>
        <label className="block text-sm font-medium text-gray-700">Fecha del cobro
          <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} className={`${campo} mt-1`} />
        </label>
        <label className="block text-sm font-medium text-gray-700">Nº de comprobante (opcional)
          <input type="text" value={comprobante} onChange={(e) => setComprobante(e.target.value)} className={`${campo} mt-1`} placeholder="Se genera uno si lo dejás vacío" />
        </label>
        <label className="block text-sm font-medium text-gray-700">Notas (opcional)
          <textarea value={notas} onChange={(e) => setNotas(e.target.value)} rows={2} className={`${campo} mt-1 resize-none`} />
        </label>
        {(registrar.error || cuentas.error) && (
          <div className="bg-red-100 border border-red-300 text-red-800 px-3 py-2 rounded-lg text-sm">{errorMessage(registrar.error ?? cuentas.error)}</div>
        )}
        <div className="flex gap-2 pt-2">
          <button type="button" onClick={cerrar} className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 font-medium hover:bg-gray-50">Cancelar</button>
          <button type="submit" disabled={!puedeGuardar}
            className="flex-1 px-4 py-2 bg-amber-600 text-white rounded-lg font-medium hover:bg-amber-700 disabled:opacity-50">
            {registrar.isPending ? 'Guardando...' : 'Registrar cobro'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
