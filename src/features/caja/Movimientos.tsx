import { useState } from 'react';
import { errorMessage } from '../../target/messages';
import { formatoPesos } from '../pedidos/helpers';
import { useFinancialAccounts } from '../pedidos/useCommercial';
import { CuentaDetalle } from './CuentaDetalle';
import { PanelResolver, type PanelPorResolver, TarjetasPorResolver } from './PorResolver';
import { useLedgerBalances } from './useTreasury';

const TIPO: Record<string, string> = { CASH: 'Efectivo', BANK_ACCOUNT: 'Banco', EXTERNAL_SERVICE: 'Servicio externo' };

/**
 * Caja → Movimientos. Account balances (F27-D; Lote 3C: cards): the latest closing balance of each account in
 * report_balance_period (Σ financial_posting); an active account with no posting yet shows "Sin movimientos"; no balance is
 * computed here. Below them, Por resolver and one content space: a selected account's movements (CuentaDetalle) or a Por resolver
 * list, never both. That space is reserved for the unified paginated history; only posted money will belong there, so a declared
 * Mercado Pago collection and an unpaid obligation stay out of it (ADR-027 / ADR-026) and a transfer counts as one operation.
 */
export function Movimientos() {
  const cuentas = useFinancialAccounts();
  const saldos = useLedgerBalances('ACCOUNT');
  const [abierta, setAbierta] = useState<string | null>(null);
  const [panel, setPanel] = useState<PanelPorResolver | null>(null);
  const abrirPanel = (p: PanelPorResolver | null) => { setPanel(p); setAbierta(null); };

  if (cuentas.isLoading || saldos.isLoading) return <p className="text-sm text-gray-500">Cargando saldos...</p>;
  const error = cuentas.error ?? saldos.error;
  if (error) return <p className="text-sm text-red-700">{errorMessage(error)}</p>;

  const lista = cuentas.data ?? [];
  const porCuenta = new Map((saldos.data ?? []).map((s) => [s.entity_id, s]));
  const c = lista.find((x) => x.id === abierta);
  return (
    <div className="space-y-4">
      {lista.length === 0 ? <p className="text-sm text-[#8A7A5C]">No hay cuentas activas. Crealas en Administración.</p> : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3" aria-label="Cuentas">
          {lista.map((x) => {
            const s = porCuenta.get(x.id);
            const activa = abierta === x.id;
            return (
              <button key={x.id} type="button" onClick={() => { setAbierta(activa ? null : x.id); setPanel(null); }} aria-expanded={activa}
                className={`text-left rounded-lg border p-3 sm:p-4 min-w-0 hover:border-[#A8552E] ${activa ? 'border-[#A8552E] ring-1 ring-[#A8552E] bg-amber-50' : 'bg-white border-[#E4DCC8]'}`}>
                <p className="font-semibold text-[#2C2419] truncate">{x.nombre}</p>
                <p className="text-xs text-[#8A7A5C]">{TIPO[x.account_type] ?? x.account_type}</p>
                {s ? <p className={`mt-2 text-lg sm:text-xl font-bold ${s.balance < 0 ? 'text-red-700' : 'text-[#2C2419]'}`}>{formatoPesos(s.balance)}</p>
                  : <p className="mt-2 text-sm text-[#8A7A5C]">Sin movimientos</p>}
              </button>
            );
          })}
        </div>
      )}
      <TarjetasPorResolver panel={panel} onPanel={abrirPanel} />
      <section aria-label="Historial financiero">
        {panel ? <PanelResolver panel={panel} onPanel={abrirPanel} />
          : c ? <CuentaDetalle key={c.id} cuenta={c} saldo={porCuenta.get(c.id)?.balance ?? null} onClose={() => setAbierta(null)} />
            : lista.length > 0 && <p className="text-xs text-[#8A7A5C]">Tocá una cuenta para ver sus movimientos.</p>}
      </section>
    </div>
  );
}
