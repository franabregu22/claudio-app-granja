import { useState } from 'react';
import { useAuth } from '../../auth/useAuth';
import { useClientesSaldo } from '../../hooks/useClientesSaldo';
import { ListaClientes } from './ListaClientes';
import { RegistroPagoModal } from './RegistroPagoModal';
import type { ClienteSaldo, MetodoPago } from '../../types/domain';

export function CobrosApp() {
  const { rol } = useAuth();
  const { clientes, totalDeudor, isLoading, error } = useClientesSaldo();
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
        <ListaClientes
          clientes={clientes}
          totalDeudor={totalDeudor}
          loading={isLoading}
          error={error}
          onRegistrarPago={abrirModal}
          onRetry={() => {}}
        />

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
