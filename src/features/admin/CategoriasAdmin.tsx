import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useCategorias, useCrearCategoria } from '../../hooks/useCategorias';
import { desactivarCategoria } from '../../api/categorias';
import type { CategoriaFinanzas } from '../../api/categorias';

export function CategoriasAdmin() {
  const categoriasQuery = useCategorias();
  const crearMutation = useCrearCategoria();

  const [mostrarFormulario, setMostrarFormulario] = useState(false);
  const [categoriaTecnica, setCategoriaTecnica] = useState('');
  const [subcategoria, setSubcategoria] = useState('');
  const [categoriaAnalisis, setCategoriaAnalisis] = useState<'GASTOS_OPERATIVOS' | 'REINVERSION_OPERATIVA' | 'INVERSION'>('GASTOS_OPERATIVOS');
  const [eliminando, setEliminando] = useState<number | null>(null);

  const handleCrear = async () => {
    if (!categoriaTecnica || !subcategoria) {
      alert('Completa todos los campos');
      return;
    }

    await crearMutation.mutateAsync({
      categoria_tecnica: categoriaTecnica,
      subcategoria,
      categoria_analisis: categoriaAnalisis,
    });

    setCategoriaTecnica('');
    setSubcategoria('');
    setCategoriaAnalisis('GASTOS_OPERATIVOS');
    setMostrarFormulario(false);
  };

  const handleEliminar = async (id: number) => {
    if (confirm('¿Eliminar esta categoría?')) {
      setEliminando(id);
      try {
        await desactivarCategoria(id);
        categoriasQuery.refetch();
      } finally {
        setEliminando(null);
      }
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-[#2C2419]">Categorías Finanzas</h2>
        <button
          onClick={() => setMostrarFormulario(!mostrarFormulario)}
          className="flex items-center gap-2 bg-[#A8552E] text-white px-4 py-2 rounded-lg hover:bg-[#8B4423] transition-colors"
        >
          <Plus className="w-4 h-4" />
          Nueva Categoría
        </button>
      </div>

      {mostrarFormulario && (
        <div className="border border-[#D8CDB0] rounded-lg p-4 bg-white">
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-[#6B5D45] mb-1">
                Categoría Técnica
              </label>
              <input
                type="text"
                value={categoriaTecnica}
                onChange={(e) => setCategoriaTecnica(e.target.value)}
                className="w-full border border-[#D8CDB0] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#A8552E]"
                placeholder="Ej: Insumos alimento balanceado"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-[#6B5D45] mb-1">
                Subcategoría
              </label>
              <input
                type="text"
                value={subcategoria}
                onChange={(e) => setSubcategoria(e.target.value)}
                className="w-full border border-[#D8CDB0] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#A8552E]"
                placeholder="Ej: Maíz"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-[#6B5D45] mb-1">
                Clasificación
              </label>
              <select
                value={categoriaAnalisis}
                onChange={(e) => setCategoriaAnalisis(e.target.value as any)}
                className="w-full border border-[#D8CDB0] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#A8552E]"
              >
                <option value="GASTOS_OPERATIVOS">Gastos Operativos</option>
                <option value="REINVERSION_OPERATIVA">Reinversión Operativa</option>
                <option value="INVERSION">Inversión</option>
              </select>
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => setMostrarFormulario(false)}
                className="flex-1 px-3 py-2 border border-[#D8CDB0] rounded-lg text-[#2C2419] font-medium hover:bg-[#F5EFE6]"
              >
                Cancelar
              </button>
              <button
                onClick={handleCrear}
                disabled={crearMutation.isPending}
                className="flex-1 px-3 py-2 bg-[#A8552E] text-white rounded-lg font-medium hover:bg-[#8B4423] disabled:opacity-50"
              >
                {crearMutation.isPending ? 'Creando...' : 'Crear'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="border border-[#D8CDB0] rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-[#F5EFE6] border-b border-[#D8CDB0]">
            <tr>
              <th className="text-left px-4 py-3 text-[#6B5D45] font-semibold">Categoría Técnica</th>
              <th className="text-left px-4 py-3 text-[#6B5D45] font-semibold">Subcategoría</th>
              <th className="text-left px-4 py-3 text-[#6B5D45] font-semibold">Clasificación</th>
              <th className="text-center px-4 py-3 text-[#6B5D45] font-semibold">Acción</th>
            </tr>
          </thead>
          <tbody>
            {categoriasQuery.data?.map((cat) => (
              <tr key={cat.id} className="border-b border-[#E4DCC8] hover:bg-[#FAF6EE]">
                <td className="px-4 py-3 text-[#2C2419]">{cat.categoria_tecnica}</td>
                <td className="px-4 py-3 text-[#2C2419]">{cat.subcategoria}</td>
                <td className="px-4 py-3">
                  <span className="text-[10px] font-semibold uppercase px-2 py-1 rounded-full bg-amber-100 text-amber-700">
                    {cat.categoria_analisis === 'GASTOS_OPERATIVOS'
                      ? 'Op.'
                      : cat.categoria_analisis === 'REINVERSION_OPERATIVA'
                      ? 'Reinv.'
                      : 'Inv.'}
                  </span>
                </td>
                <td className="px-4 py-3 text-center">
                  <button
                    onClick={() => handleEliminar(cat.id)}
                    disabled={eliminando === cat.id}
                    className="text-red-600 hover:text-red-700 disabled:opacity-50"
                    title="Eliminar categoría"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {categoriasQuery.data?.length === 0 && (
          <div className="p-6 text-center text-[#8A7A5C]">
            <p>No hay categorías definidas</p>
          </div>
        )}
      </div>

      {categoriasQuery.isLoading && (
        <div className="text-center text-[#8A7A5C]">
          <p>Cargando categorías...</p>
        </div>
      )}
    </div>
  );
}
