import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { collectionIdOf, type CustomerCollectionRow } from '../../target/customerCollections';
import { errorMessage } from '../../target/messages';
import { formatearFechaLocal } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';
import { useCollectionReversal } from '../pedidos/useCommercial';

/**
 * Lote 1E — "Anular cobro" of a cash / bank collection: reverse_collection (0108). Append-only: the original stays as evidence
 * (ANULADO); a compensating entry raises the client's debt and takes the money out of the original account, at the
 * collection's date (its period must be open). One idempotency key per opened form: a double submit replays, never doubles.
 */
export function AnularCobroModal({ cobro, clienteNombre, onClose }: { cobro: CustomerCollectionRow; clienteNombre: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const { annul } = useCollectionReversal();
  const [motivo, setMotivo] = useState('');
  const [confirmado, setConfirmado] = useState(false);
  const [clave] = useState(() => `ui:${crypto.randomUUID()}`);
  const collectionId = collectionIdOf(cobro);

  useEffect(() => { dialogRef.current?.showModal(); }, []);
  const cerrar = () => { dialogRef.current?.close(); onClose(); };
  const puedeGuardar = collectionId !== null && motivo.trim() !== '' && confirmado && !annul.isPending && !annul.isSuccess;

  function guardar(e: React.FormEvent) {
    e.preventDefault();
    if (!puedeGuardar || !collectionId) return;
    annul.mutate({ collectionId, reason: motivo.trim(), idempotencyKey: clave }, { onSuccess: cerrar });
  }

  const campo = 'w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-amber-600';
  return (
    <dialog ref={dialogRef} onClose={cerrar} className="w-full max-w-md p-5 rounded-lg backdrop:bg-black backdrop:bg-opacity-50">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-amber-900">Anular cobro — {clienteNombre}</h2>
        <button onClick={cerrar} className="text-gray-400 hover:text-gray-600"><X size={24} /></button>
      </div>
      <div className="bg-stone-50 p-3 rounded-lg text-sm mb-4 text-gray-700 space-y-0.5">
        <p>Cobro del {formatearFechaLocal(cobro.business_date)} en {cobro.account_name}</p>
        <p>Importe a anular: <span className="font-bold">{formatoPesos(cobro.amount)}</span></p>
      </div>
      <form onSubmit={guardar} className="space-y-4">
        <label className="block text-sm font-medium text-gray-700">Motivo (obligatorio)
          <textarea value={motivo} onChange={(e) => setMotivo(e.target.value)} rows={2} className={`${campo} mt-1 resize-none`} />
        </label>
        <label className="flex items-start gap-2 text-sm text-gray-700">
          <input type="checkbox" className="mt-0.5" checked={confirmado} onChange={(e) => setConfirmado(e.target.checked)} />
          <span>
            Confirmo anular {formatoPesos(cobro.amount)} de {clienteNombre}. Su deuda aumenta en ese importe y {cobro.account_name} baja
            {' '}{formatoPesos(cobro.amount)}. El cobro original queda como evidencia, marcado ANULADO.
          </span>
        </label>
        {annul.error && <div className="bg-red-100 border border-red-300 text-red-800 px-3 py-2 rounded-lg text-sm">{errorMessage(annul.error)}</div>}
        <div className="flex gap-2 pt-2">
          <button type="button" onClick={cerrar} className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 font-medium hover:bg-gray-50">Cancelar</button>
          <button type="submit" disabled={!puedeGuardar}
            className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg font-medium hover:bg-red-700 disabled:opacity-50">
            {annul.isPending ? 'Anulando...' : 'Anular cobro'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
