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
      <div className="bg-white rounded-lg border border-[#E4DCC8] overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-amber-50 border-b border-[#D8CDB0]">
            <tr>
              <th className="px-3 py-2 text-left font-semibold text-[#2C2419]">Fecha</th>
              <th className="px-3 py-2 text-left font-semibold text-[#2C2419]">Tipo</th>
              <th className="px-3 py-2 text-left font-semibold text-[#2C2419]">Medio</th>
              <th className="px-3 py-2 text-left font-semibold text-[#2C2419]">Nombre</th>
              <th className="px-3 py-2 text-left font-semibold text-[#2C2419]">Comentario</th>
              <th className="px-3 py-2 text-right font-semibold text-[#2C2419]">Monto</th>
              <th className="px-3 py-2 text-center font-semibold text-[#2C2419]">Acción</th>
            </tr>
          </thead>
          <tbody>
            {movimientos.map((m) => (
              <tr
                key={m.id}
                className={`border-b border-[#E4DCC8] hover:bg-amber-50 transition-colors ${
                  m.estado === 'cancelado'
                    ? 'bg-gray-50 opacity-60'
                    : ''
                }`}
              >
                <td className="px-3 py-2 text-[#2C2419] font-medium">{m.fecha_operacion}</td>
                <td className="px-3 py-2">
                  <span className={`text-[10px] font-bold uppercase px-2 py-1 rounded-full whitespace-nowrap ${
                    m.tipo === 'ingreso'
                      ? 'bg-green-100 text-green-700'
                      : 'bg-red-100 text-red-700'
                  }`}>
                    {m.tipo}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <span className={`text-[10px] font-bold uppercase px-2 py-1 rounded-full whitespace-nowrap ${
                    m.forma_pago === 'efectivo' ? 'bg-yellow-100 text-yellow-700' :
                    m.forma_pago === 'mercadopago' ? 'bg-blue-100 text-blue-700' :
                    m.forma_pago === 'cheque' ? 'bg-purple-100 text-purple-700' :
                    'bg-gray-100 text-gray-700'
                  }`}>
                    {m.forma_pago}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <p className={`font-semibold truncate ${m.estado === 'cancelado' ? 'line-through text-[#8A7A5C]' : 'text-[#2C2419]'}`}>
                    {m.concepto}
                  </p>
                  {m.tipo === 'egreso' && (
                    <button
                      onClick={() => setMovimientoEnEdicion(m)}
                      className="flex items-center gap-1 text-[9px] font-semibold uppercase px-1.5 py-0.5 rounded text-orange-700 hover:bg-orange-100 transition-colors mt-1"
                      title="Editar categoría"
                    >
                      {m.categoria_tecnica || 'Sin categoría'}
                      <Edit2 className="w-3 h-3" />
                    </button>
                  )}
                </td>
                <td className="px-3 py-2 text-[#8A7A5C] text-xs truncate max-w-xs">
                  {m.notas || (m.impuesto_cheque && m.impuesto_cheque > 0 ? `Imp: $${m.impuesto_cheque.toFixed(0)}` : '—')}
                </td>
                <td className="px-3 py-2 text-right">
                  <p className={`font-bold ${
                    m.tipo === 'ingreso' ? 'text-green-700' : 'text-red-700'
                  }`}>
                    {m.tipo === 'ingreso' ? '+' : '-'}{formatoPesos(m.monto)}
                  </p>
                  {m.estado !== 'confirmado' && (
                    <p className="text-[9px] text-[#A89878]">({m.estado})</p>
                  )}
                </td>
                <td className="px-3 py-2 text-center">
                  {m.estado === 'confirmado' && onAnular && (
                    <button
                      onClick={() => setAnularId(m.id)}
                      className="p-1.5 text-red-600 hover:bg-red-50 rounded transition-colors inline-block"
                      title="Anular movimiento"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
