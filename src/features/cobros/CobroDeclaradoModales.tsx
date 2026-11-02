import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { declaredIdOf, DECLARED_LABEL, type CustomerCollectionRow } from '../../target/customerCollections';
import { errorMessage } from '../../target/messages';
import { formatearFechaLocal } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';
import { useActiveClients, useDeclaredCollectionReversal } from '../pedidos/useCommercial';

const campo = 'w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-amber-600';

/** Shell of both forms. One idempotency key per opened form: a double submit replays, never doubles. */
function ModalDeclarado({ titulo, cobro, onClose, children }: { titulo: string; cobro: CustomerCollectionRow; onClose: () => void; children: (cerrar: () => void) => React.ReactNode }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialogRef.current?.showModal(); }, []);
  const cerrar = () => { dialogRef.current?.close(); onClose(); };
  return (
    <dialog ref={dialogRef} onClose={cerrar} className="w-full max-w-md p-5 rounded-lg backdrop:bg-black backdrop:bg-opacity-50">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-amber-900">{titulo}</h2>
        <button onClick={cerrar} className="text-gray-400 hover:text-gray-600"><X size={24} /></button>
      </div>
      <div className="bg-stone-50 p-3 rounded-lg text-sm mb-4 text-gray-700 space-y-0.5">
        <p>{DECLARED_LABEL}</p>
        <p>{formatearFechaLocal(cobro.business_date)} · <span className="font-bold">{formatoPesos(cobro.amount)}</span></p>
      </div>
      {children(cerrar)}
    </dialog>
  );
}

const Botones = ({ cerrar, puede, pendiente, texto, enCurso }: { cerrar: () => void; puede: boolean; pendiente: boolean; texto: string; enCurso: string }) => (
  <div className="flex gap-2 pt-2">
    <button type="button" onClick={cerrar} className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 font-medium hover:bg-gray-50">Cancelar</button>
    <button type="submit" disabled={!puede} className="flex-1 px-4 py-2 bg-amber-600 text-white rounded-lg font-medium hover:bg-amber-700 disabled:opacity-50">{pendiente ? enCurso : texto}</button>
  </div>
);

/** Annul a declared collection (0112): the client's debt goes back up at the original date; no money moves; the original stays as evidence. */
export function AnularCobroDeclaradoModal({ cobro, clienteNombre, onClose }: { cobro: CustomerCollectionRow; clienteNombre: string; onClose: () => void }) {
  const { annul } = useDeclaredCollectionReversal();
  const [motivo, setMotivo] = useState('');
  const [confirmado, setConfirmado] = useState(false);
  const [clave] = useState(() => `ui:${crypto.randomUUID()}`);
  const id = declaredIdOf(cobro);
  const puede = id !== null && motivo.trim() !== '' && confirmado && !annul.isPending && !annul.isSuccess;
  return (
    <ModalDeclarado titulo={`Anular cobro — ${clienteNombre}`} cobro={cobro} onClose={onClose}>
      {(cerrar) => (
        <form onSubmit={(e) => { e.preventDefault(); if (puede && id) annul.mutate({ id, reason: motivo.trim(), idempotencyKey: clave }, { onSuccess: cerrar }); }} className="space-y-4">
          <label className="block text-sm font-medium text-gray-700">Motivo (obligatorio)
            <textarea value={motivo} onChange={(e) => setMotivo(e.target.value)} rows={2} className={`${campo} mt-1 resize-none`} />
          </label>
          <label className="flex items-start gap-2 text-sm text-gray-700">
            <input type="checkbox" className="mt-0.5" checked={confirmado} onChange={(e) => setConfirmado(e.target.checked)} />
            <span>Confirmo anular {formatoPesos(cobro.amount)} de {clienteNombre}. Su deuda aumenta en ese importe. No se mueve dinero. El cobro queda como evidencia, marcado ANULADO.</span>
          </label>
          {annul.error ? <div role="alert" className="bg-red-100 border border-red-300 text-red-800 px-3 py-2 rounded-lg text-sm">{errorMessage(annul.error)}</div> : null}
          <Botones cerrar={cerrar} puede={puede} pendiente={annul.isPending} texto="Anular cobro" enCurso="Anulando..." />
        </form>
      )}
    </ModalDeclarado>
  );
}

/** Rectify a declared collection (0112): client, amount and date; the reversal and the new declaration are one server transaction. No money moves. */
export function RectificarCobroDeclaradoModal({ cobro, clienteNombre, onClose }: { cobro: CustomerCollectionRow; clienteNombre: string; onClose: () => void }) {
  const { rectify } = useDeclaredCollectionReversal();
  const clientes = useActiveClients();
  const [clienteId, setClienteId] = useState(cobro.cliente_id);
  const [monto, setMonto] = useState(String(cobro.amount));
  const [fecha, setFecha] = useState(cobro.business_date);
  const [motivo, setMotivo] = useState('');
  const [clave] = useState(() => `ui:${crypto.randomUUID()}`);
  const id = declaredIdOf(cobro);
  const montoNum = Number(monto);
  const igual = clienteId === cobro.cliente_id && montoNum === cobro.amount && fecha === cobro.business_date;
  const puede = id !== null && montoNum > 0 && fecha !== '' && !igual && motivo.trim() !== '' && !rectify.isPending && !rectify.isSuccess;
  const encontrado = (clientes.data ?? []).some((c) => c.id === clienteId);
  return (
    <ModalDeclarado titulo={`Rectificar cobro — ${clienteNombre}`} cobro={cobro} onClose={onClose}>
      {(cerrar) => (
        <form onSubmit={(e) => { e.preventDefault(); if (puede && id) rectify.mutate({ id, clienteId, amount: montoNum, effectiveDate: fecha, reason: motivo.trim(), idempotencyKey: clave }, { onSuccess: cerrar }); }} className="space-y-3">
          <label className="block text-sm font-medium text-gray-700">Cliente
            <select value={clienteId} onChange={(e) => setClienteId(e.target.value)} className={`${campo} mt-1`}>
              {!encontrado && <option value={clienteId}>{clientes.isLoading ? 'Cargando…' : clienteNombre}</option>}
              {(clientes.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-sm font-medium text-gray-700">Importe correcto
              <input type="number" min="0.01" step="0.01" value={monto} onChange={(e) => setMonto(e.target.value)} className={`${campo} mt-1`} />
            </label>
            <label className="block text-sm font-medium text-gray-700">Fecha
              <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} className={`${campo} mt-1`} />
            </label>
          </div>
          {igual && <p className="text-xs text-gray-500">Cambiá al menos un dato para rectificar.</p>}
          <label className="block text-sm font-medium text-gray-700">Motivo (obligatorio)
            <textarea value={motivo} onChange={(e) => setMotivo(e.target.value)} rows={2} className={`${campo} mt-1 resize-none`} />
          </label>
          <p className="text-xs text-gray-500">Solo cambia la cuenta corriente: no se mueve dinero. Si en realidad fue efectivo o banco, anulalo y registralo por su cuenta.</p>
          {(rectify.error || clientes.error) ? <div role="alert" className="bg-red-100 border border-red-300 text-red-800 px-3 py-2 rounded-lg text-sm">{errorMessage(rectify.error ?? clientes.error)}</div> : null}
          <Botones cerrar={cerrar} puede={puede} pendiente={rectify.isPending} texto="Rectificar cobro" enCurso="Rectificando..." />
        </form>
      )}
    </ModalDeclarado>
  );
}
