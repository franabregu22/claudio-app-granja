import { Plus, Package } from 'lucide-react';
import type { Pedido, Rol } from '../../types/domain';
import { PedidoCard } from './PedidoCard';
import { formatoPedidoId, resumenLineas, formatoPesos } from './helpers';

interface ListaPedidosProps {
  pendientes: Pedido[];
  entregados: Pedido[];
  loading: boolean;
  error: Error | null;
  rol: Rol | null;
  onNuevo: () => void;
  onEntregar: (id: number) => void;
  onCancelar: (id: number) => void;
  onRectificar: (pedido: Pedido) => void;
  onRetry: () => void;
  markingId?: number;
  formatearFechaEntrega?: (fecha: string) => string;
  todosPedidos?: Pedido[];
}

export function ListaPedidos({
  pendientes,
  entregados,
  loading,
  error,
  rol,
  onNuevo,
  onEntregar,
  onCancelar,
  onRectificar,
  onRetry,
  markingId,
  formatearFechaEntrega,
  todosPedidos = [],
}: ListaPedidosProps) {
  return (
    <div className="flex-1 flex flex-col">
      <header className="px-5 pt-6 pb-4 border-b border-[#E4DCC8]">
        <p className="text-xs font-semibold tracking-wide text-[#A8552E] uppercase">
          Granja Santo Tomás
        </p>
        <div className="flex items-center justify-between mt-0.5">
          <h1 className="text-2xl font-bold text-[#2C2419]">Pedidos de hoy</h1>
          {rol === 'dueño' && (
            <button
              onClick={onNuevo}
              className="flex items-center gap-2 bg-[#A8552E] text-white font-semibold px-4 py-2 rounded-lg hover:bg-[#8B4423] transition-colors"
            >
              <Plus className="w-4 h-4" /> Nuevo
            </button>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-5 pt-4 pb-28">
        {error && (
          <div className="bg-[#FCE4E4] border border-[#E4B0B0] text-[#A32D2D] text-sm px-4 py-3 rounded-lg mb-4 flex items-center justify-between">
            <span>No se pudieron cargar los pedidos</span>
            <button
              onClick={onRetry}
              className="underline text-[#A32D2D] hover:font-semibold"
            >
              Reintentar
            </button>
          </div>
        )}

        {loading ? (
          <div className="flex justify-center items-center py-12">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#A8552E]"></div>
          </div>
        ) : (
          <>
            <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide mb-2">
              Pendientes de reparto — {pendientes.length}
            </p>

            {pendientes.length === 0 && (
              <div className="border border-dashed border-[#D8CDB0] rounded-xl py-8 px-4 text-center mb-6">
                <Package className="w-6 h-6 text-[#B3A484] mx-auto mb-2" />
                <p className="text-sm text-[#8A7A5C]">
                  No hay pedidos cargados todavía.
                </p>
              </div>
            )}

            <div className="space-y-3 mb-8">
              {pendientes.map((p) => (
                <PedidoCard
                  key={p.id}
                  pedido={p}
                  estado="pendiente"
                  rol={rol}
                  onEntregar={onEntregar}
                  onCancelar={onCancelar}
                  onRectificar={onRectificar}
                  isMarking={markingId === p.id}
                />
              ))}
            </div>

            {entregados.length > 0 && (
              <>
                <p className="text-xs font-semibold text-[#6B7A4E] uppercase tracking-wide mb-2">
                  Entregados últimos 7 días — {entregados.length}
                </p>
                <div className="space-y-2">
                  {entregados.map((p) => (
                    <PedidoCard
                      key={p.id}
                      pedido={p}
                      estado="entregado"
                      rol={rol}
                      onRectificar={onRectificar}
                      fechaFormateada={formatearFechaEntrega && p.entregado_en ? formatearFechaEntrega(p.entregado_en.split('T')[0]) : undefined}
                    />
                  ))}
                </div>
              </>
            )}

            {/* Histórico Completo */}
            {todosPedidos.length > 0 && (
              <div className="mt-8 pt-6 border-t-4 border-[#D8CDB0]">
                <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide mb-4">
                  Histórico Completo — {todosPedidos.length} pedidos
                </p>
                <div className="space-y-2">
                  {todosPedidos
                    .sort((a, b) => b.id - a.id)
                    .map((p) => (
                      <div
                        key={p.id}
                        className="bg-white/70 border border-[#E4DCC8] rounded-lg p-3 text-xs hover:bg-white transition"
                      >
                        <div className="flex items-start justify-between gap-2 mb-1">
                          <div className="flex-1">
                            <p className="font-semibold text-[#2C2419]">
                              #{formatoPedidoId(p.id)} · {p.cliente_nombre}
                            </p>
                            <p className="text-[#8A7A5C] text-xs mt-0.5">
                              {resumenLineas(p.lineas)}
                            </p>
                            {p.observaciones && (
                              <p className="text-[#8B7355] italic mt-1">📝 {p.observaciones}</p>
                            )}
                          </div>
                          <div className="text-right shrink-0">
                            <p className="font-bold text-[#A8552E]">{formatoPesos(p.monto_total)}</p>
                            <p className="text-[#8A7A5C] text-xs mt-0.5">
                              {p.fecha_pedido}
                            </p>
                            <span className={`inline-block text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full mt-1 ${
                              p.estado === 'entregado' ? 'bg-[#E8F5E9] text-[#6B7A4E]' :
                              p.estado === 'pendiente' ? 'bg-[#FCEFD4] text-[#8A5A0B]' :
                              'bg-[#FCE4E4] text-[#A32D2D]'
                            }`}>
                              {p.estado}
                            </span>
                          </div>
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

    </div>
  );
}
