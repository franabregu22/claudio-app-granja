import { useState } from 'react';
import { Trash2, X, Edit2 } from 'lucide-react';
import type { MovimientoCaja } from '../../types/domain';
import { formatoPesos } from '../pedidos/helpers';
import { ModalEditarCategoria } from './ModalEditarCategoria';

interface ListaMovimientosProps {
  movimientos: MovimientoCaja[];
  onAnular?: (id: number, motivo?: string) => Promise<void>;
}

export function ListaMovimientos({ movimientos, onAnular }: ListaMovimientosProps) {
  const [anularId, setAnularId] = useState<number | null>(null);
  const [motivo, setMotivo] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [movimientoEnEdicion, setMovimientoEnEdicion] = useState<MovimientoCaja | null>(null);
  if (movimientos.length === 0) {
    return (
      <div className="border border-dashed border-[#D8CDB0] rounded-lg p-6 text-center">
        <p className="text-sm text-[#8A7A5C]">No hay movimientos registrados</p>
      </div>
    );
  }

  const handleAnular = async () => {
    if (anularId && onAnular) {
      setIsLoading(true);
      try {
        await onAnular(anularId, motivo || undefined);
        setAnularId(null);
        setMotivo('');
      } finally {
        setIsLoading(false);
      }
    }
  };

  return (
    <>
      <div className="space-y-2">
        {movimientos.map((m) => (
          <div
            key={m.id}
            className={`border rounded-lg p-4 flex items-center justify-between ${
              m.estado === 'cancelado'
                ? 'bg-gray-50 border-gray-200 opacity-60'
                : 'bg-white border-[#E4DCC8]'
            }`}
          >
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <p className={`font-semibold ${m.estado === 'cancelado' ? 'line-through text-[#8A7A5C]' : 'text-[#2C2419]'}`}>
                  {m.concepto}
                </p>
                <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${
                  m.tipo === 'ingreso'
                    ? 'bg-green-100 text-green-700'
                    : 'bg-red-100 text-red-700'
                }`}>
                  {m.tipo}
                </span>
                <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${
                  m.forma_pago === 'efectivo' ? 'bg-yellow-100 text-yellow-700' :
                  m.forma_pago === 'mercadopago' ? 'bg-blue-100 text-blue-700' :
                  m.forma_pago === 'cheque' ? 'bg-purple-100 text-purple-700' :
                  'bg-gray-100 text-gray-700'
                }`}>
                  {m.forma_pago}
                </span>
                {m.tipo === 'egreso' && (
                  <button
                    onClick={() => setMovimientoEnEdicion(m)}
                    className="flex items-center gap-1 text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full bg-orange-100 text-orange-700 hover:bg-orange-200 transition-colors"
                    title="Editar categoría"
                  >
                    {m.categoria_tecnica || 'Sin categoría'}
                    <Edit2 className="w-3 h-3" />
                  </button>
                )}
              </div>
              <div className="flex gap-4 mt-1 text-xs text-[#8A7A5C]">
                <p className="font-medium">{m.fecha_operacion}</p>
                {m.notas && <p>{m.notas}</p>}
                {m.impuesto_cheque && m.impuesto_cheque > 0 && (
                  <p className="font-semibold text-indigo-700">Impuesto: ${m.impuesto_cheque.toFixed(1)}</p>
                )}
              </div>
              {m.estado !== 'confirmado' && (
                <p className="text-xs text-[#A89878] mt-1">Estado: {m.estado}</p>
              )}
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <div className="text-right">
                <p className={`text-lg font-bold ${
                  m.tipo === 'ingreso' ? 'text-green-700' : 'text-red-700'
                }`}>
                  {m.tipo === 'ingreso' ? '+' : '-'}{formatoPesos(m.monto)}
                </p>
              </div>
              {m.estado === 'confirmado' && onAnular && (
                <button
                  onClick={() => setAnularId(m.id)}
                  className="p-1.5 text-red-600 hover:bg-red-50 rounded transition-colors"
                  title="Anular movimiento"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Modal de edición de categoría */}
      {movimientoEnEdicion && (
        <ModalEditarCategoria
          movimiento={movimientoEnEdicion}
          onClose={() => setMovimientoEnEdicion(null)}
          onGuardar={() => {
            setMovimientoEnEdicion(null);
            // Opcional: refetch movimientos aquí si es necesario
          }}
        />
      )}

      {/* Modal de anulación */}
      {anularId && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg max-w-sm w-full p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-[#2C2419]">Anular movimiento</h3>
              <button
                onClick={() => setAnularId(null)}
                className="text-[#8A7A5C] hover:text-[#2C2419]"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="text-sm text-[#8A7A5C] mb-4">
              ¿Estás seguro de que querés anular este movimiento? Quedará registrado como cancelado para auditoría.
            </p>

            <div className="mb-4">
              <label className="block text-sm font-medium text-[#6B5D45] mb-1">
                Motivo (opcional)
              </label>
              <textarea
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                placeholder="Ej: Error al cargar, prueba, etc."
                className="w-full border border-[#D8CDB0] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#A8552E]"
                rows={2}
              />
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => setAnularId(null)}
                className="flex-1 px-4 py-2 border border-[#D8CDB0] rounded-lg text-[#2C2419] font-medium hover:bg-[#F5EFE6]"
              >
                Cancelar
              </button>
              <button
                onClick={handleAnular}
                disabled={isLoading}
                className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg font-medium hover:bg-red-700 disabled:opacity-50"
              >
                {isLoading ? 'Anulando...' : 'Anular'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
