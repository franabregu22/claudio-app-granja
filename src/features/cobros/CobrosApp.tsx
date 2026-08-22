import { useState } from 'react';
import { useAuth } from '../../auth/useAuth';
import { useClientesSaldo } from '../../hooks/useClientesSaldo';
import { ListaClientes } from './ListaClientes';
import { ListaFinalizados } from './ListaFinalizados';
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
      <div className="w-full max-w-7xl bg-[#FAF6EE] min-h-screen flex flex-col relative">
        {/* Saldos Pendientes */}
        <div className="px-5 pt-6 pb-2 border-b border-[#E4DCC8] bg-white/50">
          <h2 className="text-lg font-bold text-[#8A5A0B]">Cuentas a Cobrar</h2>
          <p className="text-xs text-[#8A6A2E] mt-1">{clientes.length} clientes con saldo · {formatoPesos(totalDeudor)} total</p>
        </div>
        <ListaClientes
          clientes={clientes}
          totalDeudor={totalDeudor}
          loading={isLoading}
          error={error}
          onRegistrarPago={abrirModal}
          onRetry={() => {}}
          onPagoAgregado={() => {
            // Refetch data by reloading page
            setTimeout(() => {
              window.location.reload();
            }, 500);
          }}
        />

        {/* Saldos Finalizados */}
        {finalizados && finalizados.length > 0 && (
          <div className="border-t-4 border-[#D8CDB0]">
            <div className="px-5 pt-6 pb-3 border-b border-[#E4DCC8] bg-white/50">
              <h2 className="text-lg font-bold text-[#6B7A4E]">Saldos Finalizados</h2>
              <p className="text-xs text-[#6B7A4E] mt-1">{finalizados.length} clientes · Últimos 15 días</p>
            </div>
            <ListaFinalizados clientes={finalizados} />
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
