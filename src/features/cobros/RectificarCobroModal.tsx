import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { collectionIdOf, rectificationEffect, type CustomerCollectionRow } from '../../target/customerCollections';
import { errorMessage } from '../../target/messages';
import { formatearFechaLocal } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';
import { useActiveClients, useCollectionReversal, useFinancialAccounts } from '../pedidos/useCommercial';

/**
 * Lote 1E — "Rectificar cobro" of a cash / bank collection: rectify_collection (0108) reverses the original and registers the
 * correct collection in ONE server transaction (all or nothing). Client, amount, account (cash or bank only: Mercado Pago keeps
 * its own circuit) and date may change; the net effect on debts and accounts is shown before the explicit confirmation.
 */
export function RectificarCobroModal({ cobro, clienteNombre, onClose }: { cobro: CustomerCollectionRow; clienteNombre: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const { rectify } = useCollectionReversal();
  const clientes = useActiveClients();
  const cuentas = useFinancialAccounts();
  const destinos = (cuentas.data ?? []).filter((a) => a.account_type === 'CASH' || a.account_type === 'BANK_ACCOUNT');
  const [clienteId, setClienteId] = useState(cobro.cliente_id);
  const [monto, setMonto] = useState(String(cobro.amount));
  const [cuentaId, setCuentaId] = useState('');
  const [fecha, setFecha] = useState(cobro.business_date);
  const [motivo, setMotivo] = useState('');
  const [confirmado, setConfirmado] = useState<string | null>(null);
  const [clave] = useState(() => `ui:${crypto.randomUUID()}`);
  const collectionId = collectionIdOf(cobro);
  const cuentaElegida = cuentaId || destinos.find((a) => a.nombre === cobro.account_name)?.id || '';
  const cuenta = destinos.find((a) => a.id === cuentaElegida);
  const nuevoCliente = (clientes.data ?? []).find((c) => c.id === clienteId);
  const montoNum = Number(monto);

  useEffect(() => { dialogRef.current?.showModal(); }, []);
  const cerrar = () => { dialogRef.current?.close(); onClose(); };

  const datosOk = collectionId !== null && montoNum > 0 && Boolean(cuenta) && fecha !== '' && Boolean(nuevoCliente);
  const igual = clienteId === cobro.cliente_id && montoNum === cobro.amount && cuenta?.nombre === cobro.account_name && fecha === cobro.business_date;
  const efecto = datosOk && !igual ? rectificationEffect(
    { clienteId: cobro.cliente_id, clienteNombre, amount: cobro.amount, accountName: cobro.account_name },
    { clienteId, clienteNombre: nuevoCliente?.nombre ?? '', amount: montoNum, accountName: cuenta?.nombre ?? '' }) : null;
  // the confirmation is bound to the exact rectification shown: any change asks for it again
  const firma = `${clienteId}|${montoNum}|${cuentaElegida}|${fecha}`;
  const puedeGuardar = efecto !== null && motivo.trim() !== '' && confirmado === firma && !rectify.isPending && !rectify.isSuccess;

  function guardar(e: React.FormEvent) {
    e.preventDefault();
    if (!puedeGuardar || !collectionId || !cuenta) return;
    rectify.mutate({ collectionId, clienteId, amount: montoNum, accountId: cuenta.id, effectiveDate: fecha, reason: motivo.trim(), idempotencyKey: clave },
      { onSuccess: cerrar });
  }

  const campo = 'w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-amber-600';
  return (
    <dialog ref={dialogRef} onClose={cerrar} className="w-full max-w-md p-5 rounded-lg backdrop:bg-black backdrop:bg-opacity-50">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-amber-900">Rectificar cobro — {clienteNombre}</h2>
        <button onClick={cerrar} className="text-gray-400 hover:text-gray-600"><X size={24} /></button>
      </div>
      <div className="bg-stone-50 p-3 rounded-lg text-sm mb-4 text-gray-700">
        Original: {formatearFechaLocal(cobro.business_date)} · <span className="font-bold">{formatoPesos(cobro.amount)}</span> · {cobro.account_name}
      </div>
      <form onSubmit={guardar} className="space-y-3">
        <label className="block text-sm font-medium text-gray-700">Cliente
          <select value={clienteId} onChange={(e) => setClienteId(e.target.value)} className={`${campo} mt-1`}>
            {!nuevoCliente && <option value={clienteId}>{clientes.isLoading ? 'Cargando…' : clienteNombre}</option>}
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
        <label className="block text-sm font-medium text-gray-700">Cuenta donde entró el dinero
          <select value={cuentaElegida} onChange={(e) => setCuentaId(e.target.value)} className={`${campo} mt-1`}>
            <option value="">{cuentas.isLoading ? 'Cargando cuentas…' : 'Elegir cuenta…'}</option>
            {destinos.map((a) => <option key={a.id} value={a.id}>{a.nombre}</option>)}
          </select>
          <span className="block text-xs text-gray-500 mt-1">Solo efectivo o bancos. Un cobro de Mercado Pago se imputa desde su movimiento.</span>
        </label>
        {igual && datosOk && <p className="text-xs text-gray-500">Cambiá al menos un dato para rectificar.</p>}
        {efecto && (
          <div className="bg-stone-50 border border-[#E4DCC8] p-3 rounded-lg text-sm text-gray-700" aria-live="polite">
            <p className="font-medium mb-1">Efecto neto</p>
            {efecto.clientes.map((c) => (
              <p key={c.clienteId}>{c.nombre}: deuda {c.deuda > 0 ? 'sube' : 'baja'} <span className={c.deuda > 0 ? 'text-red-600' : 'text-green-700'}>{formatoPesos(Math.abs(c.deuda))}</span></p>
            ))}
            {efecto.cuentas.map((a) => (
              <p key={a.nombre}>{a.nombre}: {a.saldo > 0 ? 'entra' : 'sale'} <span className={a.saldo > 0 ? 'text-green-700' : 'text-red-600'}>{formatoPesos(Math.abs(a.saldo))}</span></p>
            ))}
            {efecto.clientes.length === 0 && efecto.cuentas.length === 0 && <p>Sin cambio de importes (solo cambia la fecha).</p>}
          </div>
        )}
        <label className="block text-sm font-medium text-gray-700">Motivo (obligatorio)
          <textarea value={motivo} onChange={(e) => setMotivo(e.target.value)} rows={2} className={`${campo} mt-1 resize-none`} />
        </label>
        {efecto && (
          <label className="flex items-start gap-2 text-sm text-gray-700">
            <input type="checkbox" className="mt-0.5" checked={confirmado === firma} onChange={(e) => setConfirmado(e.target.checked ? firma : null)} />
            <span>Confirmo la rectificación. El cobro original queda como evidencia, marcado RECTIFICADO, y se registra el cobro correcto.</span>
          </label>
        )}
        {(rectify.error || clientes.error || cuentas.error) && (
          <div className="bg-red-100 border border-red-300 text-red-800 px-3 py-2 rounded-lg text-sm">{errorMessage(rectify.error ?? clientes.error ?? cuentas.error)}</div>
        )}
        <div className="flex gap-2 pt-2">
          <button type="button" onClick={cerrar} className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 font-medium hover:bg-gray-50">Cancelar</button>
          <button type="submit" disabled={!puedeGuardar}
            className="flex-1 px-4 py-2 bg-amber-600 text-white rounded-lg font-medium hover:bg-amber-700 disabled:opacity-50">
            {rectify.isPending ? 'Rectificando...' : 'Rectificar cobro'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
