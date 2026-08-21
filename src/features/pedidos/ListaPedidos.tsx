import { Plus, Package, Check, Pencil, X } from 'lucide-react';
import type { Pedido, Rol } from '../../types/domain';
import { formatoPedidoId, resumenLineas, formatoPesos } from './helpers';

function formatearFechaHistorico(fechaIso: string): string {
  const fecha = new Date(fechaIso + 'T00:00:00');
  const diasSemana = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  const meses = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

  const diaSemana = diasSemana[fecha.getDay()];
  const dia = fecha.getDate();
  const mes = meses[fecha.getMonth()];

  return `${diaSemana} ${dia} de ${mes}`;
}

interface ListaPedidosProps {
  pendientes: Pedido[];
  loading: boolean;
  error: Error | null;
  rol: Rol | null;
  onNuevo: () => void;
  onEntregar: (id: number) => void;
  onCancelar: (id: number) => void;
  onRectificar: (pedido: Pedido) => void;
  onRetry: () => void;
  markingId?: number;
  todosPedidos?: Pedido[];
}

export function ListaPedidos({
  pendientes,
  loading,
  error,
  rol,
  onNuevo,
  onEntregar,
  onCancelar,
  onRectificar,
  onRetry,
  markingId,
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
                <div key={p.id} className="bg-white rounded-xl border border-[#E4DCC8] p-4 shadow-sm">
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <p className="font-semibold text-[#2C2419]">
                          #{formatoPedidoId(p.id)} · {p.cliente_nombre}
                        </p>
                        <span className="shrink-0 bg-[#A8552E] text-white text-sm font-bold px-3 py-1 rounded-lg">
                          {formatoPesos(p.monto_total)}
                        </span>
                      </div>
                    </div>
                    <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide bg-[#FCEFD4] text-[#8A5A0B] px-2 py-1 rounded-full">
                      Pendiente
                    </span>
                  </div>

                  {/* Items como bullets */}
                  {Array.isArray(p.lineas) && p.lineas.length > 0 && (
                    <ul className="space-y-1 mb-3 text-sm text-[#2C2419]">
                      {p.lineas.map((linea, idx) => (
                        <li key={idx} className="flex justify-between gap-2">
                          <span>• {linea.cantidad} {linea.producto_nombre}</span>
                          <span className="text-[#8A7A5C]">{formatoPesos(linea.subtotal)}</span>
                        </li>
                      ))}
                    </ul>
                  )}

                  {p.observaciones && (
                    <p className="text-xs text-[#8B7355] italic mb-3">📝 {p.observaciones}</p>
                  )}

                  <div className="flex items-center justify-between mb-3">
                    <p className="text-xs text-[#A89878]">
                      {new Date(p.fecha_pedido + 'T00:00:00').toLocaleDateString('es-AR', {
                        day: '2-digit',
                        month: '2-digit',
                        year: 'numeric'
                      })}
                    </p>
                  </div>

                  <div className="flex gap-2">
                    {rol === 'dueño' || rol === 'repartidor' ? (
                      <button
                        onClick={() => onEntregar?.(p.id)}
                        disabled={markingId === p.id}
                        className="flex-1 flex items-center justify-center gap-1.5 bg-[#3B6D11] disabled:bg-[#B0C85E] text-white text-sm font-semibold py-2.5 rounded-lg active:scale-95 transition-transform disabled:active:scale-100"
                      >
                        <Check className="w-4 h-4" /> Marcar entregado
                      </button>
                    ) : null}
                    {rol === 'dueño' ? (
                      <>
                        <button
                          onClick={() => onRectificar?.(p)}
                          aria-label="Editar pedido"
                          className="w-11 flex items-center justify-center bg-[#A8552E] rounded-lg text-white active:scale-95 transition-transform"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => onCancelar?.(p.id)}
                          aria-label="Cancelar pedido"
                          className="w-11 flex items-center justify-center bg-[#A8552E] rounded-lg text-white active:scale-95 transition-transform"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>


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
                            {p.estado === 'entregado' && p.entregado_por_nombre && (
                              <p className="text-[#6B7A4E] font-medium mt-1">
                                ✓ Entregado por: {p.entregado_por_nombre}
                              </p>
                            )}
                          </div>
                          <div className="text-right shrink-0 flex gap-1">
                            {rol === 'dueño' && (
                              <button
                                onClick={() => onRectificar?.(p)}
                                aria-label="Editar pedido"
                                className="w-7 h-7 flex items-center justify-center bg-[#A8552E] rounded text-white active:scale-95 transition-transform"
                              >
                                <Pencil className="w-3 h-3" />
                              </button>
                            )}
                            <div>
                              <p className="font-bold text-[#A8552E]">{formatoPesos(p.monto_total)}</p>
                              <p className="text-[#8A7A5C] text-xs mt-0.5">
                                {formatearFechaHistorico(p.fecha_operacion || p.fecha_pedido || '')}
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
