import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { ClienteSaldo } from '../../types/domain';
import { formatoPedidoId } from '../pedidos/helpers';

interface ListaFinalizadosProps {
  clientes: ClienteSaldo[];
}

export function ListaFinalizados({ clientes }: ListaFinalizadosProps) {
  const [expandido, setExpandido] = useState<string | null>(null);

  if (clientes.length === 0) {
    return (
      <div className="text-center py-12 text-gray-500">
        <p>No hay saldos finalizados</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="space-y-3">
        {clientes.map((cliente) => {
          const isExpanded = expandido === cliente.cliente_id;

          return (
            <div
              key={cliente.cliente_id}
              className="border border-amber-200 rounded-lg overflow-hidden bg-white"
            >
              <button
                onClick={() => setExpandido(isExpanded ? null : cliente.cliente_id)}
                className="w-full px-4 py-3 hover:bg-stone-50 flex items-center justify-between transition"
              >
                <div className="flex-1 text-left">
                  <div className="font-semibold text-amber-900">{cliente.cliente_nombre}</div>
                </div>
                <ChevronDown
                  size={20}
                  className={`text-gray-400 transition ${isExpanded ? 'rotate-180' : ''}`}
                />
              </button>

              {isExpanded && (
                <div className="border-t border-amber-200 px-4 py-4 bg-stone-50 space-y-4">
                  {/* Pedidos entregados */}
                  <div>
                    <h3 className="font-semibold text-sm text-amber-900 mb-3">
                      Pedidos entregados
                    </h3>
                    <div className="space-y-2">
                      {cliente.pedidos.map((pedido) => (
                        <div
                          key={pedido.id}
                          className="bg-white p-3 rounded border border-gray-200 text-sm"
                        >
                          <div className="font-medium text-gray-800">Pedido #{formatoPedidoId(pedido.id)}</div>
                          <div className="text-xs text-gray-600 mt-1">
                            {pedido.entregado_en}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Histórico de pagos */}
                  <div>
                    <h3 className="font-semibold text-sm text-amber-900 mb-3">
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
                              ${pago.monto.toLocaleString('es-AR')}
                            </div>
                            <div className="text-xs text-gray-600 mt-1">
                              {pago.fecha_pago} · {pago.metodo_pago.charAt(0).toUpperCase() + pago.metodo_pago.slice(1)}
                            </div>
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
