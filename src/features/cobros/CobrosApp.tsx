import { useState } from 'react';
import { useAuth } from '../../auth/useAuth';
import { useClientesSaldo } from '../../hooks/useClientesSaldo';
import { ListaClientes } from './ListaClientes';
import { RegistroPagoModal } from './RegistroPagoModal';
import type { ClienteSaldo } from '../../types/domain';
import { formatoPesos } from '../pedidos/helpers';

export function CobrosApp() {
  const { rol } = useAuth();
  const { clientes, finalizados, totalDeudor, isLoading, error } = useClientesSaldo();
  const [modalOpen, setModalOpen] = useState(false);
  const [clienteSeleccionado, setClienteSeleccionado] = useState<ClienteSaldo | null>(null);

  if (rol !== 'dueño') {
    return (
      <div className="min-h-screen bg-stone-100 flex items-center justify-center">
        <div className="bg-white p-8 rounded-lg text-center max-w-sm mx-4">
          <p className="text-lg font-semibold text-gray-800">Acceso restringido</p>
          <p className="text-gray-600 mt-2">Solo el dueño puede gestionar cobros.</p>
        </div>
      </div>
    );
  }

  function abrirModal(cliente: ClienteSaldo) {
    setClienteSeleccionado(cliente);
    setModalOpen(true);
  }

  function cerrarModal() {
    setModalOpen(false);
    setClienteSeleccionado(null);
  }

  return (
    <div className="min-h-screen bg-stone-100 flex justify-center relative">
      <div className="w-full max-w-2xl bg-[#FAF6EE] min-h-screen flex flex-col relative">
        {/* Cobros Pendientes */}
        <div className="px-5 pt-6 pb-2 border-b border-[#E4DCC8] bg-white/50">
          <h2 className="text-sm font-bold text-[#8A5A0B] uppercase">Cobros Pendientes</h2>
        </div>
        <ListaClientes
          clientes={clientes}
          totalDeudor={totalDeudor}
          loading={isLoading}
          error={error}
          onRegistrarPago={abrirModal}
          onRetry={() => {}}
        />

        {/* Cobros Finalizados */}
        {finalizados && finalizados.length > 0 && (
          <div className="border-t-4 border-[#D8CDB0]">
            <div className="px-5 pt-4 pb-2 border-b border-[#E4DCC8] bg-white/50">
              <h2 className="text-sm font-bold text-[#6B7A4E] uppercase">Cobros Finalizados</h2>
              <p className="text-xs text-[#6B7A4E] mt-0.5">{finalizados.length} clientes · Últimos 15 días</p>
            </div>
            <div className="px-5 pt-3 pb-3 space-y-2 max-h-48 overflow-y-auto">
              {finalizados.map((cliente) => (
                <div key={cliente.cliente_id} className="bg-white/60 border border-[#D8CDB0] rounded p-2.5 text-xs">
                  <div className="flex justify-between items-center">
                    <span className="font-medium text-[#6B7A4E]">{cliente.cliente_nombre}</span>
                    <span className="text-xs font-semibold text-[#6B7A4E] bg-[#E8F5E9] px-2 py-0.5 rounded">
                      ✓ Pagado
                    </span>
                  </div>
                  <p className="text-[#8A7A5C] mt-0.5">{formatoPesos(cliente.totalPedidos)} · {cliente.pagos.length} pago(s)</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {modalOpen && clienteSeleccionado && (
          <RegistroPagoModal
            cliente={clienteSeleccionado}
            onClose={cerrarModal}
          />
        )}
      </div>
    </div>
  );
}
