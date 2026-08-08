import { useMemo } from 'react';
import { usePedidos } from './usePedidos';
import { usePagos } from './usePagos';
import type { ClienteSaldo } from '../types/domain';

export function useClientesSaldo() {
  const pedidosQuery = usePedidos();
  const pagosQuery = usePagos();

  const data = useMemo(() => {
    if (!pedidosQuery.data || !pagosQuery.data) return [];

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

    // Sumar pagos por cliente
    pagos.forEach((pago) => {
      const cliente = clienteMap.get(pago.cliente_id);
      if (cliente) {
        cliente.totalPagado += pago.monto;
        cliente.pagos.push(pago);
      }
    });

    // Calcular saldo y filtrar solo clientes con deuda
    return Array.from(clienteMap.values())
      .map((cliente) => ({
        ...cliente,
        saldo: cliente.totalPedidos - cliente.totalPagado,
      }))
      .filter((cliente) => cliente.saldo > 0)
      .sort((a, b) => b.saldo - a.saldo);
  }, [pedidosQuery.data, pagosQuery.data]);

  const totalDeudor = useMemo(
    () => data.reduce((sum, c) => sum + c.saldo, 0),
    [data]
  );

  return {
    clientes: data,
    totalDeudor,
    isLoading: pedidosQuery.isLoading || pagosQuery.isLoading,
    error: pedidosQuery.error || pagosQuery.error,
  };
}
