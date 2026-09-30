import { useState } from 'react';
import { useAuth } from '../../auth/useAuth';
import type { ClientBalance } from '../../target/commercial';
import { errorMessage } from '../../target/messages';
import { formatearFechaLocal } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';
import { useClientBalances, useCollections, useOrders } from '../pedidos/useCommercial';
import { ListaSaldosClientes } from './ListaSaldosClientes';
import { RegistroPagoModal } from './RegistroPagoModal';

const METODO: Record<string, string> = { CASH: 'Efectivo', TRANSFER: 'Transferencia', MERCADOPAGO: 'MercadoPago', CHEQUE: 'Cheque' };

/**
 * Cuentas a cobrar (F27-C, ADMIN). Balances come only from report_balance_period (client ledger); collections are
 * registered only through register_collection. The sections split clients by the sign of that balance.
 */
export function CobrosApp() {
  const { rol } = useAuth();
  const saldos = useClientBalances();
  const cobros = useCollections();
  const entregas = useOrders(['DELIVERED']);
  const [cliente, setCliente] = useState<ClientBalance | null>(null);

  if (rol !== 'ADMIN') {
    return (
      <div className="min-h-screen bg-stone-100 flex items-center justify-center">
        <div className="bg-white p-8 rounded-lg text-center max-w-sm mx-4">
          <p className="text-lg font-semibold text-gray-800">Acceso restringido</p>
          <p className="text-gray-600 mt-2">Solo un administrador puede gestionar cobros.</p>
        </div>
      </div>
    );
  }

  const cargando = saldos.isLoading || cobros.isLoading || entregas.isLoading;
  const error = saldos.error ?? cobros.error ?? entregas.error;
  const todos = saldos.data ?? [];
  const deudores = todos.filter((c) => c.balance > 0).sort((a, b) => b.balance - a.balance);
  const finalizados = todos.filter((c) => c.balance === 0);
  const conCredito = todos.filter((c) => c.balance < 0).sort((a, b) => a.balance - b.balance);
  const totalDeudor = deudores.reduce((s, c) => s + c.balance, 0);
  const props = { entregas: entregas.data ?? [], cobros: cobros.data ?? [] };

  return (
    <div className="min-h-screen bg-stone-100 flex justify-center relative">
      <div className="w-full max-w-7xl bg-[#FAF6EE] min-h-screen flex flex-col relative">
        <div className="px-5 pt-6 pb-4 border-b border-[#E4DCC8] bg-white/50">
          <h2 className="text-lg font-bold text-[#8A5A0B]">Últimos cobros registrados</h2>
          {cargando ? <p className="text-xs text-gray-500 mt-2">Cargando...</p> : (cobros.data ?? []).length === 0 ? (
            <p className="text-xs text-gray-500 mt-2">Sin cobros registrados.</p>
          ) : (
            <div className="mt-3 space-y-1 max-h-48 overflow-y-auto">
              {(cobros.data ?? []).slice(0, 5).map((c) => (
                <div key={c.id} className="text-xs text-gray-700 py-1">
                  <span className="font-semibold text-green-700">{formatoPesos(c.amount)}</span> · {c.cliente_nombre} · {METODO[c.payment_method] ?? c.payment_method} · {formatearFechaLocal(c.effective_date)}
                </div>
              ))}
            </div>
          )}
        </div>

        {error ? (
          <div className="m-5 bg-[#FCE4E4] border border-[#E4B0B0] text-[#A32D2D] text-sm px-4 py-3 rounded-lg">{errorMessage(error)}</div>
        ) : cargando ? (
          <p className="text-sm text-gray-500 px-5 py-6">Cargando saldos...</p>
        ) : (
          <>
            <div className="px-5 pt-6 pb-2 border-b border-[#E4DCC8] bg-white/50">
              <h2 className="text-lg font-bold text-[#8A5A0B]">Cuentas a cobrar</h2>
              <p className="text-xs text-[#8A6A2E] mt-1">{deudores.length} clientes con saldo · {formatoPesos(totalDeudor)} total</p>
            </div>
            <ListaSaldosClientes variante="deudor" clientes={deudores} {...props} onRegistrarPago={setCliente} />

            {finalizados.length > 0 && (
              <div className="border-t-4 border-[#D8CDB0]">
                <div className="px-5 pt-6 pb-3 border-b border-[#E4DCC8] bg-white/50">
                  <h2 className="text-lg font-bold text-[#6B7A4E]">Saldos finalizados</h2>
                  <p className="text-xs text-[#6B7A4E] mt-1">{finalizados.length} clientes</p>
                </div>
                <ListaSaldosClientes variante="finalizado" clientes={finalizados} {...props} />
              </div>
            )}

            {conCredito.length > 0 && (
              <div className="border-t-4 border-green-200">
                <div className="px-5 pt-6 pb-3 border-b border-[#E4DCC8] bg-white/50">
                  <h2 className="text-lg font-bold text-green-700">Clientes con crédito</h2>
                  <p className="text-xs text-green-700 mt-1">{conCredito.length} clientes · Crédito disponible para próximas compras</p>
                </div>
                <ListaSaldosClientes variante="credito" clientes={conCredito} {...props} />
              </div>
            )}
          </>
        )}

        {cliente && <RegistroPagoModal cliente={cliente} onClose={() => setCliente(null)} />}
      </div>
    </div>
  );
}
