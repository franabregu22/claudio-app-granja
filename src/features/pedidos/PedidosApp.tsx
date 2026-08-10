import { useState, useMemo } from 'react';
import { usePedidos, useCrearPedido, useRectificarPedido, useCancelarPedido, useMarcarEntregado } from '../../hooks/usePedidos';
import { useClientes } from '../../hooks/useClientes';
import { usePagos } from '../../hooks/usePagos';
import { useAuth } from '../../auth/useAuth';
import { ListaPedidos } from './ListaPedidos';
import { FormPedido } from './FormPedido';
import { lineasVacias } from './helpers';
import type { Lineas, Precios, Pedido } from '../../types/domain';

type Vista = 'lista' | 'nuevo' | 'rectificar';

function getTodayDate(): string {
  const hoy = new Date();
  return hoy.toISOString().split('T')[0];
}

function formatearFechaEntrega(fechaIso: string): string {
  const fecha = new Date(fechaIso + 'T00:00:00');
  const diasSemana = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  const meses = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

  const diaSemana = diasSemana[fecha.getDay()];
  const dia = fecha.getDate();
  const mes = meses[fecha.getMonth()];

  return `${diaSemana} ${dia} - ${mes}`;
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
  const [lineas, setLineas] = useState<Lineas>(lineasVacias());
  const [precios, setPrecios] = useState<Precios>({
    xl: 0,
    n1: 0,
    n2: 0,
    n3: 0,
    docena: 0,
  });
  const [fechaPedido, setFechaPedido] = useState(getTodayDate());
  const [observaciones, setObservaciones] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const pedidosQuery = usePedidos();
  const clientesQuery = useClientes();
  const pagosQuery = usePagos();

  const crearPedidoMutation = useCrearPedido();
  const rectificarPedidoMutation = useRectificarPedido();
  const cancelarPedidoMutation = useCancelarPedido();
  const marcarEntregadoMutation = useMarcarEntregado();


  function abrirNuevo() {
    setClienteSel('');
    setClienteSelNombre('');
    setClienteNuevo('');
    setLineas(lineasVacias());
    setFechaPedido(getTodayDate());
    setObservaciones('');
    setPedidoEnEdicion(null);
    setFormError(null);
    setVista('nuevo');
  }

  function abrirRectificar(pedido: Pedido) {
    setClienteSel(pedido.cliente_id);
    setClienteSelNombre(pedido.cliente_nombre);
    setLineas({ ...pedido.lineas });
    setPrecios({ ...pedido.precios_snapshot });
    setFechaPedido(pedido.fecha_pedido);
    setObservaciones(pedido.observaciones || '');
    setPedidoEnEdicion(pedido);
    setFormError(null);
    setVista('rectificar');
  }

  function cambiarCantidad(catId: string, delta: number) {
    setLineas((prev) => ({
      ...prev,
      [catId]: Math.max(0, prev[catId as keyof Lineas] + delta),
    }));
  }

  function setCantidadDirecta(catId: string, valor: string) {
    const n = Math.max(0, Math.floor(Number(valor)) || 0);
    setLineas((prev) => ({ ...prev, [catId]: n }));
  }

  function cambiarPrecio(catId: string, valor: string) {
    const n = Math.max(0, Number(valor) || 0);
    setPrecios((prev) => ({ ...prev, [catId]: n }));
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

      const total = Object.values(lineas).reduce((a, b) => a + b, 0);
      if (total === 0) {
        setFormError('Agrega al menos una cantidad');
        return;
      }

      if (vista === 'rectificar' && pedidoEnEdicion) {
        await rectificarPedidoMutation.mutateAsync({
          id: pedidoEnEdicion.id,
          lineas,
          preciosSnapshot: precios,
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
          preciosSnapshot: precios,
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

  // Entregados en últimos 7 días con saldo pendiente
  const hace7Dias = new Date();
  hace7Dias.setDate(hace7Dias.getDate() - 7);
  const fecha7DiasAgo = hace7Dias.toISOString().split('T')[0];

  const entregados = useMemo(() => {
    const pagos = pagosQuery.data || [];

    // Calcular total pagado por cliente
    const pagoPorCliente = new Map<string, number>();
    pagos.forEach((p) => {
      pagoPorCliente.set(p.cliente_id, (pagoPorCliente.get(p.cliente_id) || 0) + p.monto);
    });

    // Calcular total despachado por cliente (últimos 7 días)
    const despachoPorCliente = new Map<string, number>();
    const pedidosEntregados7Dias = pedidos.filter((p) => {
      if (p.estado !== 'entregado' || !p.entregado_en) return false;
      const fechaEntrega = p.entregado_en.split('T')[0];
      return fechaEntrega >= fecha7DiasAgo;
    });

    pedidosEntregados7Dias.forEach((p) => {
      despachoPorCliente.set(p.cliente_id, (despachoPorCliente.get(p.cliente_id) || 0) + p.monto_total);
    });

    // Filtrar solo los que tienen saldo pendiente
    return pedidosEntregados7Dias.filter((p) => {
      const totalDespachado = despachoPorCliente.get(p.cliente_id) || 0;
      const totalPagado = pagoPorCliente.get(p.cliente_id) || 0;
      return totalDespachado > totalPagado;
    });
  }, [pedidos, pagosQuery.data, fecha7DiasAgo]);

  const clientes = clientesQuery.data || [];

  return (
    <div className="min-h-screen bg-stone-100 flex justify-center relative">
      <div className="w-full max-w-7xl bg-[#FAF6EE] min-h-screen flex flex-col lg:flex-row relative">
        <div className="flex-1 min-h-screen lg:max-h-screen lg:overflow-y-auto">
          {(vista === 'lista' || vista === 'nuevo' || vista === 'rectificar') && (
            <ListaPedidos
              pendientes={pendientes}
              entregados={entregados}
              loading={pedidosQuery.isLoading}
              error={pedidosQuery.error}
              rol={rol}
              onNuevo={abrirNuevo}
              onEntregar={marcarEntregado}
              onCancelar={cancelarPedido}
              onRectificar={abrirRectificar}
              onRetry={() => pedidosQuery.refetch()}
              markingId={marcarEntregadoMutation.isPending ? undefined : undefined}
              formatearFechaEntrega={formatearFechaEntrega}
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
              cambiarCantidad={cambiarCantidad}
              setCantidadDirecta={setCantidadDirecta}
              precios={precios}
              cambiarPrecio={cambiarPrecio}
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
