import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { ClienteSaldo } from '../../types/domain';
import { formatoPedidoId, formatoPesos } from '../pedidos/helpers';
import { calcularDíasDesdeBA, isoAFechaBA } from '../../utils/dateUtils';

interface ListaClientesConCreditoProps {
  clientes: ClienteSaldo[];
}

export function ListaClientesConCredito({ clientes }: ListaClientesConCreditoProps) {
  const [expandido, setExpandido] = useState<string | null>(null);

  if (clientes.length === 0) {
    return (
      <div className="text-center py-12 text-gray-500">
        <p>No hay clientes con crédito</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="space-y-3">
        {clientes.map((cliente) => {
          const isExpanded = expandido === cliente.cliente_id;
          const creditoDisponible = Math.abs(cliente.saldo);

          // Calcular días desde última entrega (zona horaria Buenos Aires)
          const ultimaEntrega = cliente.pedidos
            .filter(p => p.entregado_en)
            .sort((a, b) => new Date(b.entregado_en!).getTime() - new Date(a.entregado_en!).getTime())[0];

          const diasDesdeUltimaEntrega = ultimaEntrega
            ? calcularDíasDesdeBA(isoAFechaBA(ultimaEntrega.entregado_en!))
            : null;

          // Calcular días desde último pago (zona horaria Buenos Aires)
          const ultimoPago = cliente.pagos
            .sort((a, b) => new Date(b.fecha_pago).getTime() - new Date(a.fecha_pago).getTime())[0];

          const diasDesdeUltimoPago = ultimoPago
            ? calcularDíasDesdeBA(ultimoPago.fecha_pago)
            : null;

          return (
            <div
              key={cliente.cliente_id}
              className="border border-green-200 rounded-lg overflow-hidden bg-white"
            >
              <button
                onClick={() => setExpandido(isExpanded ? null : cliente.cliente_id)}
                className="w-full px-4 py-2.5 hover:bg-green-50 flex items-center justify-between transition"
              >
                <div className="flex-1 text-left">
                  <div className="text-sm text-gray-800">
                    <span className="font-semibold text-green-900">{cliente.cliente_nombre}</span>
                    <span className="text-gray-500"> · Crédito: </span>
                    <span className="font-bold text-green-600">{formatoPesos(creditoDisponible)}</span>
                    {diasDesdeUltimaEntrega !== null && (
                      <>
                        <span className="text-gray-500"> · Último pedido </span>
                        <span className="text-gray-700">{diasDesdeUltimaEntrega}d atrás</span>
                      </>
                    )}
                    {diasDesdeUltimoPago !== null && (
                      <>
                        <span className="text-gray-500"> · Último pago </span>
                        <span className="text-gray-700">{diasDesdeUltimoPago}d atrás</span>
                      </>
                    )}
                  </div>
                </div>
                <ChevronDown
                  size={20}
                  className={`text-gray-400 transition flex-shrink-0 ${isExpanded ? 'rotate-180' : ''}`}
                />
              </button>

              {isExpanded && (
                <div className="border-t border-green-200 px-4 py-4 bg-green-50 space-y-4">
                  {/* Pedidos entregados */}
                  <div>
                    <h3 className="font-semibold text-sm text-green-900 mb-3">
                      Pedidos entregados
                    </h3>
                    <div className="space-y-2">
                      {cliente.pedidos.map((pedido) => {
                        const lineas = Array.isArray(pedido.lineas) ? pedido.lineas : [];
                        const fechaPedido = pedido.fecha_operacion || pedido.fecha_pedido;

                        return (
                          <div
                            key={pedido.id}
                            className="bg-white p-3 rounded border border-gray-200 text-sm"
                          >
                            <div className="font-medium text-gray-800">Pedido #{formatoPedidoId(pedido.id)}</div>
                            {pedido.entregado_en && (
                              <div className="text-xs text-gray-600 mt-1">
                                Entregado por: <span className="font-medium">{pedido.entregado_por_nombre || 'Usuario'}</span> ·{' '}
                                {new Date(pedido.entregado_en).toLocaleDateString('es-AR')}
                              </div>
                            )}

                            {/* Detalle de líneas */}
                            {lineas.length > 0 && (
                              <div className="mt-2 pt-2 border-t border-gray-200">
                                <div className="space-y-1">
                                  {lineas.map((linea: any, idx: number) => (
                                    <div key={idx} className="flex justify-between text-xs">
                                      <span className="text-gray-700">
                                        {linea.producto_nombre || 'Producto'} x{linea.cantidad}
                                      </span>
                                      <span className="text-gray-600">
                                        {formatoPesos(linea.subtotal || 0)}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}

                            <div className="text-sm font-semibold text-green-600 mt-2">
                              {formatoPesos(pedido.monto_total)}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Histórico de pagos */}
                  <div>
                    <h3 className="font-semibold text-sm text-green-900 mb-3">
                      Histórico de pagos
                    </h3>
                    {cliente.pagos.length === 0 ? (
                      <p className="text-xs text-gray-500">Sin pagos</p>
                    ) : (
                      <div className="space-y-2">
                        {cliente.pagos.map((pago) => (
                          <div
                            key={pago.id}
                            className="bg-white p-3 rounded border border-gray-200 text-sm"
                          >
                            <div className="font-medium text-gray-800">
                              {formatoPesos(pago.monto)}
                            </div>
                            <div className="text-xs text-gray-600 mt-1">
                              {pago.metodo_pago.charAt(0).toUpperCase() +
                                pago.metodo_pago.slice(1)} · {pago.fecha_pago}
                            </div>
                            {pago.creado_por_nombre && (
                              <div className="text-xs text-gray-600 mt-1">
                                Registrado por: <span className="font-medium">{pago.creado_por_nombre}</span>
                              </div>
                            )}
                            {pago.notas && (
                              <div className="text-xs text-gray-500 italic mt-1">
                                "{pago.notas}"
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
