import { useState } from 'react';
import { errorMessage } from '../../target/messages';
import type { PendingFilter } from '../../target/movementHistory';
import { formatoPesos } from '../pedidos/helpers';
import { useFinancialAccounts } from '../pedidos/useCommercial';
import { MovimientosHistoricos } from './MovimientosHistoricos';
import { TarjetasPorResolver } from './PorResolver';
import { useLedgerBalances } from './useTreasury';

const TIPO: Record<string, string> = { CASH: 'Efectivo', BANK_ACCOUNT: 'Banco', EXTERNAL_SERVICE: 'Servicio externo' };

/**
 * Caja → Movimientos. Account balances (F27-D; Lote 3C: cards): the latest closing balance of each account in
 * report_balance_period (Σ financial_posting); an active account with no posting yet shows "Sin movimientos"; no balance is
 * computed here. 0116: a card is a filter of the movement list below (touching it again, or "Todas las cuentas", removes it), and so
 * is each Por resolver indicator: one list (MovimientosHistoricos), no secondary list. Only posted money is a movement: a declared
 * Mercado Pago collection and an unpaid obligation stay out of it (ADR-027 / ADR-026) and a transfer counts as one operation.
 */
export function Movimientos({ onIrAExtractos }: { onIrAExtractos?: () => void }) {
  const cuentas = useFinancialAccounts();
  const saldos = useLedgerBalances('ACCOUNT');
  const [cuentaId, setCuentaId] = useState('');
  const [pendiente, setPendiente] = useState<PendingFilter | null>(null);

  if (cuentas.isLoading || saldos.isLoading) return <p className="text-sm text-gray-500">Cargando saldos...</p>;
  const error = cuentas.error ?? saldos.error;
  if (error) return <p className="text-sm text-red-700">{errorMessage(error)}</p>;

  const lista = cuentas.data ?? [];
  const porCuenta = new Map((saldos.data ?? []).map((s) => [s.entity_id, s]));
  return (
    <div className="space-y-4">
      {lista.length === 0 ? <p className="text-sm text-[#8A7A5C]">No hay cuentas activas. Crealas en Administración.</p> : (
        <div className="space-y-2">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3" role="group" aria-label="Cuentas">
            {lista.map((x) => {
              const s = porCuenta.get(x.id);
              const activa = cuentaId === x.id;
              return (
                <button key={x.id} type="button" onClick={() => setCuentaId(activa ? '' : x.id)} aria-pressed={activa}
                  title={activa ? 'Ver todas las cuentas' : `Ver solo los movimientos de ${x.nombre}`}
                  className={`text-left rounded-lg border p-3 sm:p-4 min-w-0 hover:border-[#A8552E] ${activa ? 'border-[#A8552E] ring-1 ring-[#A8552E] bg-amber-50' : 'bg-white border-[#E4DCC8]'}`}>
                  <p className="font-semibold text-[#2C2419] truncate">{x.nombre}</p>
                  <p className="text-xs text-[#8A7A5C]">{TIPO[x.account_type] ?? x.account_type}</p>
                  {s ? <p className={`mt-2 text-lg sm:text-xl font-bold ${s.balance < 0 ? 'text-red-700' : 'text-[#2C2419]'}`}>{formatoPesos(s.balance)}</p>
                    : <p className="mt-2 text-sm text-[#8A7A5C]">Sin movimientos</p>}
                </button>
              );
            })}
          </div>
          {cuentaId && <button type="button" onClick={() => setCuentaId('')} className="text-xs text-[#A8552E] hover:underline">← Todas las cuentas</button>}
        </div>
      )}
      <TarjetasPorResolver activo={pendiente} onFiltro={setPendiente} />
      <section aria-label="Movimientos históricos">
        <MovimientosHistoricos cuentas={lista} cuentaId={cuentaId} onCuenta={setCuentaId} pendiente={pendiente} onPendiente={setPendiente} onIrAExtractos={onIrAExtractos} />
      </section>
    </div>
  );
}
