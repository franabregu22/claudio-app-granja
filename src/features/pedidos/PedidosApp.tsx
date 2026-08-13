import { useState } from 'react';
import { usePedidos, useCrearPedido, useRectificarPedido, useCancelarPedido, useMarcarEntregado } from '../../hooks/usePedidos';
import { useClientes } from '../../hooks/useClientes';
import { useAuth } from '../../auth/useAuth';
import { ListaPedidos } from './ListaPedidos';
import { FormPedido } from './FormPedido';
import { lineasGenericasVacias } from './helpers';
import type { LineaPedido, Pedido } from '../../types/domain';

type Vista = 'lista' | 'nuevo' | 'rectificar';

function getTodayDate(): string {
  const hoy = new Date();
  const year = hoy.getFullYear();
  const month = String(hoy.getMonth() + 1).padStart(2, '0');
  const day = String(hoy.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function PedidosApp() {
  const { rol } = useAuth();

  if (rol !== 'dueño') {
    return (
      <div className="min-h-screen bg-stone-100 flex items-center justify-center">
        <div className="bg-white p-8 rounded-lg text-center max-w-sm mx-4">
          <p className="text-lg font-semibold text-gray-800">Acceso restringido</p>
          <p className="text-gray-600 mt-2">Solo el dueño puede gestionar pedidos.</p>
        </div>
      </div>
    );
  }

  const [vista, setVista] = useState<Vista>('lista');
  const [pedidoEnEdicion, setPedidoEnEdicion] = useState<Pedido | null>(null);

  const [clienteSel, setClienteSel] = useState('');
  const [clienteSelNombre, setClienteSelNombre] = useState('');
  const [clienteNuevo, setClienteNuevo] = useState('');
  const [lineas, setLineas] = useState<LineaPedido[]>(lineasGenericasVacias());
  const [fechaPedido, setFechaPedido] = useState(getTodayDate());
  const [observaciones, setObservaciones] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const pedidosQuery = usePedidos();
  const clientesQuery = useClientes();

  const crearPedidoMutation = useCrearPedido();
  const rectificarPedidoMutation = useRectificarPedido();
  const cancelarPedidoMutation = useCancelarPedido();
  const marcarEntregadoMutation = useMarcarEntregado();

  function abrirNuevo() {
    setClienteSel('');
    setClienteSelNombre('');
    setClienteNuevo('');
    setLineas(lineasGenericasVacias());
    setFechaPedido(getTodayDate());
    setObservaciones('');
    setPedidoEnEdicion(null);
    setFormError(null);
    setVista('nuevo');
  }

  function abrirRectificar(pedido: Pedido) {
    setClienteSel(pedido.cliente_id);
    setClienteSelNombre(pedido.cliente_nombre);
    // Support both old and new structure
    if (Array.isArray(pedido.lineas)) {
      setLineas([...(pedido.lineas as LineaPedido[])]);
    } else {
      setLineas(lineasGenericasVacias());
    }
    setFechaPedido(pedido.fecha_operacion || pedido.fecha_pedido || getTodayDate());
    setObservaciones(pedido.observaciones || '');
    setPedidoEnEdicion(pedido);
    setFormError(null);
    setVista('rectificar');
  }

  async function guardarPedido() {
    setFormError(null);
    try {
      let nombreCliente = '';
      if (clienteSelNombre) {
        nombreCliente = clienteSelNombre;
      } else if (clienteNuevo.trim()) {
        nombreCliente = clienteNuevo.trim();
      }

      if (!nombreCliente) {
        setFormError('Selecciona o ingresa un cliente');
        return;
      }

      const totalUnidades = lineas.reduce((acc, l) => acc + l.cantidad, 0);
      if (totalUnidades === 0) {
        setFormError('Agrega al menos un producto');
        return;
      }

      if (vista === 'rectificar' && pedidoEnEdicion) {
        await rectificarPedidoMutation.mutateAsync({
          id: pedidoEnEdicion.id,
          lineas,
          fechaPedido,
          clienteId: clienteSel,
          clienteNombre: nombreCliente,
          observaciones: observaciones || undefined,
        });
      } else {
        const clienteId = clienteSel;

        if (!clienteId) {
          setFormError('Debes seleccionar un cliente de la lista');
          return;
        }

        await crearPedidoMutation.mutateAsync({
          clienteId,
          clienteNombre: nombreCliente,
          lineas,
          fechaPedido,
          observaciones: observaciones || undefined,
        });
      }

      setVista('lista');
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Error al guardar');
    }
  }

  async function marcarEntregado(id: number) {
    try {
      await marcarEntregadoMutation.mutateAsync(id);
    } catch (error) {
      console.error('Error al marcar entregado:', error);
    }
  }

  async function cancelarPedido(id: number) {
    try {
      await cancelarPedidoMutation.mutateAsync(id);
    } catch (error) {
      console.error('Error al cancelar pedido:', error);
    }
  }

  const pedidos = pedidosQuery.data || [];
  const pendientes = pedidos.filter((p) => p.estado === 'pendiente');

  const clientes = clientesQuery.data || [];

  return (
    <div className="min-h-screen bg-stone-100 flex justify-center relative">
      <div className="w-full max-w-7xl bg-[#FAF6EE] min-h-screen flex flex-col lg:flex-row relative">
        <div className="flex-1 min-h-screen lg:max-h-screen lg:overflow-y-auto">
          {(vista === 'lista' || vista === 'nuevo' || vista === 'rectificar') && (
            <ListaPedidos
              pendientes={pendientes}
              loading={pedidosQuery.isLoading}
              error={pedidosQuery.error}
              rol={rol}
              onNuevo={abrirNuevo}
              onEntregar={marcarEntregado}
              onCancelar={cancelarPedido}
              onRectificar={abrirRectificar}
              onRetry={() => pedidosQuery.refetch()}
              markingId={marcarEntregadoMutation.isPending ? undefined : undefined}
              todosPedidos={pedidos}
            />
          )}
        </div>

        {(vista === 'nuevo' || vista === 'rectificar') && (
          <div className="w-full lg:w-96 border-t lg:border-t-0 lg:border-l border-[#E4DCC8] lg:max-h-screen lg:overflow-y-auto">
            <FormPedido
              modo={vista}
              clientes={clientes}
              clienteSel={clienteSel}
              setClienteSel={(id) => {
                setClienteSel(id);
                if (id) {
                  const cliente = clientes.find((c) => c.id === id);
                  setClienteSelNombre(cliente?.nombre || '');
                  setClienteNuevo('');
                }
              }}
              clienteNuevo={clienteNuevo}
              setClienteNuevo={(nombre) => {
                setClienteNuevo(nombre);
                if (nombre.trim()) {
                  setClienteSel('');
                  setClienteSelNombre('');
                }
              }}
              lineas={lineas}
              setLineas={setLineas}
              fechaPedido={fechaPedido}
              setFechaPedido={setFechaPedido}
              observaciones={observaciones}
              setObservaciones={setObservaciones}
              onGuardar={guardarPedido}
              onVolver={() => setVista('lista')}
              error={formError}
              rol={rol}
            />
          </div>
        )}
      </div>
    </div>
  );
}
