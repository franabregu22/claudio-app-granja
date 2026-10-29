import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { allocationIdOf, type CustomerCollectionRow } from '../../target/customerCollections';
import { errorMessage } from '../../target/messages';
import { uiIdempotencyKey } from '../../target/mp';
import { formatearFechaLocal } from '../../utils/dateUtils';
import { useAnularAsignacionMp } from '../caja/MovimientoMp';
import { formatoPesos } from '../pedidos/helpers';

/**
 * Lote 1D — "Anular cobro" of a Mercado Pago allocation: mp_reverse_client_allocation of the WHOLE reversible remainder
 * (the view's net amount; the server re-checks it under a lock: REVERSAL_EXCEEDS_ALLOCATION). The client's balance goes
 * back up and the amount returns to Disponible MP; the Mercado Pago money and the original allocation stay (history).
 * One idempotency key per opened form, so a double submit cannot reverse twice (DUPLICATE_ALLOCATION).
 */
export function AnularCobroMpModal({ cobro, clienteNombre, onClose }: { cobro: CustomerCollectionRow; clienteNombre: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const anular = useAnularAsignacionMp();
  const [motivo, setMotivo] = useState('');
  const [confirmado, setConfirmado] = useState(false);
  const [clave] = useState(() => uiIdempotencyKey());
  const allocationId = allocationIdOf(cobro);

  useEffect(() => { dialogRef.current?.showModal(); }, []);
  const cerrar = () => { dialogRef.current?.close(); onClose(); };
  const puedeGuardar = allocationId !== null && cobro.amount > 0 && motivo.trim() !== '' && confirmado && !anular.isPending && !anular.isSuccess;

  function guardar(e: React.FormEvent) {
    e.preventDefault();
    if (!puedeGuardar || !allocationId) return;
    anular.mutate({ allocationId, amount: cobro.amount, idempotencyKey: clave, reason: motivo.trim() }, { onSuccess: cerrar });
  }

  const campo = 'w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-amber-600';
  return (
    <dialog ref={dialogRef} onClose={cerrar} className="w-full max-w-md p-5 rounded-lg backdrop:bg-black backdrop:bg-opacity-50">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-amber-900">Anular cobro — {clienteNombre}</h2>
        <button onClick={cerrar} className="text-gray-400 hover:text-gray-600"><X size={24} /></button>
      </div>
      <div className="bg-stone-50 p-3 rounded-lg text-sm mb-4 text-gray-700 space-y-0.5">
        <p>Cobro en Mercado Pago del {formatearFechaLocal(cobro.business_date)}</p>
        <p>Importe a anular: <span className="font-bold">{formatoPesos(cobro.amount)}</span></p>
        {cobro.source_id && <p className="text-xs text-gray-500">Ref. MP {cobro.source_id}</p>}
      </div>
      <form onSubmit={guardar} className="space-y-4">
        <label className="block text-sm font-medium text-gray-700">Motivo (obligatorio)
          <textarea value={motivo} onChange={(e) => setMotivo(e.target.value)} rows={2} className={`${campo} mt-1 resize-none`} />
        </label>
        <label className="flex items-start gap-2 text-sm text-gray-700">
          <input type="checkbox" className="mt-0.5" checked={confirmado} onChange={(e) => setConfirmado(e.target.checked)} />
          <span>
            Confirmo anular {formatoPesos(cobro.amount)} de {clienteNombre}. Su saldo aumenta en ese importe y vuelve a quedar como
            Disponible MP; el ingreso de Mercado Pago no se modifica.
          </span>
        </label>
        {anular.error && <div className="bg-red-100 border border-red-300 text-red-800 px-3 py-2 rounded-lg text-sm">{errorMessage(anular.error)}</div>}
        <div className="flex gap-2 pt-2">
          <button type="button" onClick={cerrar} className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 font-medium hover:bg-gray-50">Cancelar</button>
          <button type="submit" disabled={!puedeGuardar}
            className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg font-medium hover:bg-red-700 disabled:opacity-50">
            {anular.isPending ? 'Anulando...' : 'Anular cobro'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
