import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { ClienteSaldo } from '../../types/domain';
import { formatoPesos, formatoPedidoId } from '../pedidos/helpers';

interface ListaClientesProps {
  clientes: ClienteSaldo[];
  totalDeudor: number;
  loading: boolean;
  error: unknown;
  onRegistrarPago: (cliente: ClienteSaldo) => void;
  onRetry: () => void;
  mostrarTotal?: boolean;
}

export function ListaClientes({
  clientes,
  totalDeudor,
  loading,
  error,
  onRegistrarPago,
  mostrarTotal = true,
}: ListaClientesProps) {
  const [expandido, setExpandido] = useState<string | null>(null);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-gray-500">Cargando cobros...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="bg-red-100 border border-red-300 text-red-800 p-4 rounded-lg max-w-sm">
          <p className="font-semibold">Error al cargar cobros</p>
          <p className="text-sm mt-1">{error instanceof Error ? error.message : 'Error desconocido'}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col">
      {mostrarTotal && (
        <div className="px-6 pt-4 pb-6 border-b border-amber-200">
          <div className="bg-gradient-to-r from-amber-100 to-amber-50 border border-amber-200 rounded-lg p-4">
            <div className="text-sm text-amber-900 font-medium">Total a cobrar:</div>
            <div className="text-2xl font-bold text-amber-900 mt-1">{formatoPesos(totalDeudor)}</div>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-6">
        {clientes.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            <p>No hay clientes con saldo pendiente</p>
          </div>
        ) : (
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
                    className="w-full px-4 py-4 hover:bg-stone-50 flex items-center justify-between transition"
                  >
                    <div className="flex-1 text-left">
                      <div className="font-semibold text-amber-900">{cliente.cliente_nombre}</div>
                      <div className="text-sm text-gray-600 mt-1">
                        Saldo:{' '}
                        <span className="font-bold text-red-600">{formatoPesos(cliente.saldo)}</span>
                      </div>
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
                              <div className="text-sm font-semibold text-green-600 mt-1">
                                {formatoPesos(pedido.monto_total)}
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
                          <p className="text-xs text-gray-500">Sin pagos aún</p>
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
                                  {pago.fecha_pago} ·{' '}
                                  {pago.metodo_pago.charAt(0).toUpperCase() +
                                    pago.metodo_pago.slice(1)}
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

                      {/* Botón registrar pago */}
                      <button
                        onClick={() => onRegistrarPago(cliente)}
                        className="w-full bg-amber-600 hover:bg-amber-700 text-white py-2 rounded-lg font-medium transition"
                      >
                        + Registrar pago
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
