/**
 * Mercado Pago inflow action: «Clasificar ingreso» (0088). The outflows are classified in the Pendientes de clasificar tray
 * (BandejaPendientesMp, owner 2026-11-20).
 */
import { useState } from 'react';
import { errorMessage } from '../../target/messages';
import { useClassifyMp, useOwnBankAccounts } from './useMpActivity';

const SELECT_CLS = 'text-xs border border-[#E4DCC8] rounded px-1 py-0.5 bg-white';
const ACCION_CLS = 'text-xs px-2 py-0.5 rounded border border-amber-300 bg-white text-amber-900 hover:bg-amber-50 disabled:opacity-50';

type TipoIngreso = 'OWN_TRANSFER' | 'COLLECTION';

/**
 * 0088 — "Clasificar ingreso" for an account_fund + DEBIN inflow (CLASSIFY_INFLOW): money from an own account (one
 * TRANSFER, 0086) or a client receipt (applied server-side). ADR-027: it never names a client (a collection is declared in Cuentas
 * corrientes, so it would be discounted twice). "Otro ingreso" is not offered yet.
 */
export function ClasificarIngreso({ paymentId }: { paymentId: string }) {
  const [abierto, setAbierto] = useState(false);
  const [tipo, setTipo] = useState<TipoIngreso>('OWN_TRANSFER');
  const [cuenta, setCuenta] = useState('');
  const cuentas = useOwnBankAccounts();
  const { collection, ownTransfer } = useClassifyMp();
  const pendiente = collection.isPending || ownTransfer.isPending;
  const error = collection.error ?? ownTransfer.error;
  if (!abierto) {
    return <button type="button" className={`ml-2 ${ACCION_CLS}`} onClick={() => setAbierto(true)}>Clasificar ingreso</button>;
  }
  const listo = tipo === 'COLLECTION' || cuenta !== '';
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1" role="group" aria-label="Clasificar ingreso">
      <select aria-label="Tipo de ingreso" className={SELECT_CLS} value={tipo} onChange={(e) => setTipo(e.target.value as TipoIngreso)}>
        <option value="OWN_TRANSFER">Transferencia desde cuenta propia</option><option value="COLLECTION">Cobro de cliente (sin asignar)</option>
      </select>
      {tipo === 'OWN_TRANSFER' && (
        <select aria-label="Cuenta propia de origen" className={SELECT_CLS} value={cuenta} onChange={(e) => setCuenta(e.target.value)}>
          <option value="">Cuenta…</option>
          {(cuentas.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.nombre}</option>)}
        </select>
      )}
      <button type="button" className={ACCION_CLS} disabled={!listo || pendiente}
        onClick={() => (tipo === 'OWN_TRANSFER' ? ownTransfer.mutate({ paymentId, fromAccountId: cuenta }) : collection.mutate({ paymentId }))}>
        {pendiente ? 'Confirmando...' : 'Confirmar'}
      </button>
      <button type="button" className="text-xs text-[#8A7A5C] underline" onClick={() => setAbierto(false)}>Cancelar</button>
      {error && <p className="w-full text-[11px] text-red-700">{errorMessage(error)}</p>}
    </div>
  );
}
