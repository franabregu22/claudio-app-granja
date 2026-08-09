import { Edit } from 'lucide-react';
import type { Produccion } from '../../types/domain';

interface ListaProduccionesProps {
  producciones: Produccion[];
  onEditar: (id: string) => void;
  produccionEnEdicion: string | null;
}

export function ListaProducciones({
  producciones,
  onEditar,
  produccionEnEdicion,
}: ListaProduccionesProps) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      <div className="p-4 bg-gray-50 border-b border-gray-200">
        <h2 className="font-semibold text-gray-900">Histórico de producción</h2>
      </div>

      {producciones.length === 0 ? (
        <div className="p-8 text-center text-gray-500">
          No hay registros de producción
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="px-4 py-3 text-left font-semibold text-gray-700">Fecha</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-700">Galpón</th>
                <th className="px-4 py-3 text-right font-semibold text-gray-700">Sanos</th>
                <th className="px-4 py-3 text-right font-semibold text-gray-700">Cachados</th>
                <th className="px-4 py-3 text-right font-semibold text-gray-700">Total</th>
                <th className="px-4 py-3 text-right font-semibold text-gray-700">Mortandad</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-700">Notas</th>
                <th className="px-4 py-3 text-center font-semibold text-gray-700">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {producciones.map((p) => {
                const sanos = p.huevos_sanos_mediodia + p.huevos_sanos_tarde;
                const cachados = p.huevos_cachados_mediodia + p.huevos_cachados_tarde;
                const total = sanos + cachados;

                return (
                  <tr
                    key={p.id}
                    className={`border-b border-gray-200 ${
                      produccionEnEdicion === p.id ? 'bg-amber-50' : 'hover:bg-gray-50'
                    }`}
                  >
                    <td className="px-4 py-3 font-medium text-gray-900">{p.fecha}</td>
                    <td className="px-4 py-3 text-gray-700">{p.galpon}</td>
                    <td className="px-4 py-3 text-right text-green-600 font-semibold">{sanos}</td>
                    <td className="px-4 py-3 text-right text-orange-600 font-semibold">{cachados}</td>
                    <td className="px-4 py-3 text-right font-bold text-gray-900">{total}</td>
                    <td className="px-4 py-3 text-right text-red-600 font-semibold">{p.mortandad}</td>
                    <td className="px-4 py-3 text-gray-600 text-xs">{p.observaciones || '—'}</td>
                    <td className="px-4 py-3 text-center">
                      <button
                        onClick={() => onEditar(p.id)}
                        className="text-amber-600 hover:text-amber-700 p-1"
                        title="Editar"
                      >
                        <Edit size={18} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
