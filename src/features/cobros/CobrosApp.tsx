import { useState } from 'react';
import { useAuth } from '../../auth/useAuth';
import type { ClientBalance } from '../../target/commercial';
import { errorMessage } from '../../target/messages';
import { formatoPesos } from '../pedidos/helpers';
import { useClientBalances, useClientCollections, useOrders } from '../pedidos/useCommercial';
import { ListaSaldosClientes, type Variante } from './ListaSaldosClientes';
import { RegistroPagoModal } from './RegistroPagoModal';

/**
 * Cuentas corrientes (F27-C, ADMIN). Balances come only from report_balance_period (client ledger); collections are
 * registered through register_collection (or the Mercado Pago allocation) and read from fin_customer_collections. The
 * three cards split clients by the sign of that balance (debe / al día / a favor); only the chosen card's list is shown.
 */
export function CobrosApp() {
  const { rol } = useAuth();
  const saldos = useClientBalances();
  const cobros = useClientCollections();
  const entregas = useOrders(['DELIVERED']);
  const [cliente, setCliente] = useState<ClientBalance | null>(null);
  const [vista, setVista] = useState<Variante>('deudor');

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
  const totalCredito = conCredito.reduce((s, c) => s - c.balance, 0);
  const props = { entregas: entregas.data ?? [], cobros: cobros.data ?? [], onRegistrarPago: setCliente };
  const tarjetas: { id: Variante; titulo: string; cantidad: number; detalle: string; tono: string }[] = [
    { id: 'deudor', titulo: 'Cuentas a cobrar', cantidad: deudores.length, detalle: `${formatoPesos(totalDeudor)} a cobrar`, tono: 'text-red-600' },
    { id: 'finalizado', titulo: 'Clientes al día', cantidad: finalizados.length, detalle: 'Saldo cero', tono: 'text-[#6B7A4E]' },
    { id: 'credito', titulo: 'Clientes con crédito', cantidad: conCredito.length, detalle: `${formatoPesos(totalCredito)} a favor`, tono: 'text-green-700' },
  ];
  const lista = { deudor: deudores, finalizado: finalizados, credito: conCredito }[vista];

  return (
    <div className="min-h-screen bg-stone-100 flex justify-center relative">
      <div className="w-full max-w-7xl bg-[#FAF6EE] min-h-screen flex flex-col relative">
        <div className="px-5 pt-6 pb-3 border-b border-[#E4DCC8] bg-white/50">
          <h2 className="text-lg font-bold text-[#8A5A0B]">Cuentas corrientes</h2>
        </div>
        {error ? (
          <div className="m-5 bg-[#FCE4E4] border border-[#E4B0B0] text-[#A32D2D] text-sm px-4 py-3 rounded-lg">{errorMessage(error)}</div>
        ) : cargando ? (
          <p className="text-sm text-gray-500 px-5 py-6">Cargando saldos...</p>
        ) : (
          <>
            <div role="tablist" aria-label="Situación de los clientes" className="grid grid-cols-3 gap-2 px-5 pt-4">
              {tarjetas.map((t) => {
                const activa = vista === t.id;
                return (
                  <button key={t.id} role="tab" aria-selected={activa} onClick={() => setVista(t.id)}
                    className={`text-left rounded-lg border p-3 transition ${activa ? 'bg-white border-amber-600 ring-1 ring-amber-600 shadow-sm' : 'bg-white/60 border-[#E4DCC8] hover:border-amber-400'}`}>
                    <p className="text-xs sm:text-sm font-semibold text-[#6B5D45] leading-tight">{t.titulo}</p>
                    <p className="text-xl sm:text-2xl font-bold text-gray-900 mt-1">{t.cantidad}</p>
                    <p className={`text-[11px] sm:text-xs ${t.tono} truncate`}>{t.detalle}</p>
                  </button>
                );
              })}
            </div>
            <ListaSaldosClientes variante={vista} clientes={lista} {...props} />
          </>
        )}

        {cliente && <RegistroPagoModal cliente={cliente} onClose={() => setCliente(null)} />}
      </div>
    </div>
  );
}
