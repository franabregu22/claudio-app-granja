import { Check, Pencil, X } from 'lucide-react';
import type { Pedido, Precios, Rol } from '../../types/domain';
import { formatoPesos, resumenLineas, totalPedido } from './helpers';

interface PedidoCardProps {
  pedido: Pedido;
  estado: 'pendiente' | 'entregado';
  precios?: Precios;
  rol: Rol | null;
  onEntregar?: (id: string) => void;
  onCancelar?: (id: string) => void;
  onRectificar?: (pedido: Pedido) => void;
  isMarking?: boolean;
}

export function PedidoCard({
  pedido,
  estado,
  precios,
  rol,
  onEntregar,
  onCancelar,
  onRectificar,
  isMarking = false,
}: PedidoCardProps) {
  if (estado === 'pendiente') {
    return (
      <div className="bg-white rounded-xl border border-[#E4DCC8] p-4 shadow-sm">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="font-semibold text-[#2C2419]">{pedido.cliente_nombre}</p>
            <p className="text-sm text-[#6B5D45] mt-0.5">
              {resumenLineas(pedido.lineas)}
            </p>
            <p className="text-xs text-[#A89878] mt-1">
              {new Date(pedido.fecha_pedido + 'T00:00:00').toLocaleDateString('es-AR', {
                day: '2-digit',
                month: '2-digit',
                year: 'numeric'
              })} · {formatoPesos(totalPedido(pedido.lineas, pedido.precios_snapshot || precios || {}))}
            </p>
          </div>
          <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide bg-[#FCEFD4] text-[#8A5A0B] px-2 py-1 rounded-full">
            Pendiente
          </span>
        </div>
        <div className="flex gap-2 mt-3">
          {rol === 'dueño' || rol === 'repartidor' ? (
            <button
              onClick={() => onEntregar?.(pedido.id)}
              disabled={isMarking}
              className="flex-1 flex items-center justify-center gap-1.5 bg-[#3B6D11] disabled:bg-[#B0C85E] text-white text-sm font-semibold py-2.5 rounded-lg active:scale-95 transition-transform disabled:active:scale-100"
            >
              <Check className="w-4 h-4" /> Marcar entregado
            </button>
          ) : null}
          {rol === 'dueño' ? (
            <button
              onClick={() => onCancelar?.(pedido.id)}
              aria-label="Cancelar pedido"
              className="w-11 flex items-center justify-center bg-[#A8552E] rounded-lg text-white active:scale-95 transition-transform"
            >
              <X className="w-4 h-4" />
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white/70 rounded-xl border border-[#E4DCC8] p-3.5 flex items-center justify-between gap-2">
      <div>
        <p className="font-medium text-[#2C2419] text-sm">
          {pedido.cliente_nombre}
          {pedido.rectificado && (
            <span className="ml-1.5 text-[10px] font-bold uppercase tracking-wide bg-[#FCE4E4] text-[#A32D2D] px-1.5 py-0.5 rounded-full align-middle">
              Rectificado
            </span>
          )}
        </p>
        <p className="text-xs text-[#8A7A5C] mt-0.5">
          {resumenLineas(pedido.lineas)}
        </p>
      </div>
      {rol === 'dueño' ? (
        <button
          onClick={() => onRectificar?.(pedido)}
          aria-label="Rectificar pedido"
          className="w-9 h-9 shrink-0 flex items-center justify-center bg-[#A8552E] rounded-lg text-white active:scale-95 transition-transform"
        >
          <Pencil className="w-4 h-4" />
        </button>
      ) : null}
    </div>
  );
}
