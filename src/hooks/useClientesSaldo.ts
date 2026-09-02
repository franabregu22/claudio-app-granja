import { useMemo } from 'react';
import { usePedidos } from './usePedidos';
import { usePagos } from './usePagos';
import type { ClienteSaldo } from '../types/domain';

export function useClientesSaldo() {
  const pedidosQuery = usePedidos();
  const pagosQuery = usePagos();

  const { clientes: data, finalizados } = useMemo(() => {
    if (!pedidosQuery.data || !pagosQuery.data) return { clientes: [], finalizados: [] };

    const pedidos = pedidosQuery.data;
    const pagos = pagosQuery.data;

    // Filtrar solo pedidos entregados
    const pedidosEntregados = pedidos.filter((p) => p.estado === 'entregado');

    // Agrupar por cliente
    const clienteMap = new Map<string, ClienteSaldo>();

    pedidosEntregados.forEach((pedido) => {
      if (!clienteMap.has(pedido.cliente_id)) {
        clienteMap.set(pedido.cliente_id, {
          cliente_id: pedido.cliente_id,
          cliente_nombre: pedido.cliente_nombre,
          totalPedidos: 0,
          totalPagado: 0,
          saldo: 0,
          pedidos: [],
          pagos: [],
        });
      }

      const cliente = clienteMap.get(pedido.cliente_id)!;
      cliente.totalPedidos += pedido.monto_total;
      cliente.pedidos.push(pedido);
    });

    // Sumar pagos confirmados por cliente (ignorar cancelados)
    pagos.forEach((pago) => {
      const cliente = clienteMap.get(pago.cliente_id);
      if (cliente && pago.estado !== 'cancelado') {
        cliente.totalPagado += pago.monto;
        cliente.pagos.push(pago);
      }
    });

    // Calcular saldo para todos los clientes
    const todosClientes = Array.from(clienteMap.values()).map((cliente) => ({
      ...cliente,
      saldo: cliente.totalPedidos - cliente.totalPagado,
    }));

    // Separar en pendientes y finalizados
    const clientes = todosClientes
      .filter((cliente) => cliente.saldo > 0)
      .sort((a, b) => b.saldo - a.saldo);

    const finalizados = todosClientes
      .filter((cliente) => cliente.saldo === 0 && cliente.totalPedidos > 0)
      .sort((a, b) => {
        const ultimoPagoA = a.pagos.sort((x, y) => new Date(y.fecha_pago).getTime() - new Date(x.fecha_pago).getTime())[0];
        const ultimoPagoB = b.pagos.sort((x, y) => new Date(y.fecha_pago).getTime() - new Date(x.fecha_pago).getTime())[0];
        if (!ultimoPagoA) return 1;
        if (!ultimoPagoB) return -1;
        return new Date(ultimoPagoB.fecha_pago).getTime() - new Date(ultimoPagoA.fecha_pago).getTime();
      });

    return { clientes, finalizados };
  }, [pedidosQuery.data, pagosQuery.data]);

  const totalDeudor = useMemo(
    () => data.reduce((sum, c) => sum + c.saldo, 0),
    [data]
  );

  return {
    clientes: data,
    finalizados,
    totalDeudor,
    isLoading: pedidosQuery.isLoading || pagosQuery.isLoading,
    error: pedidosQuery.error || pagosQuery.error,
  };
}
