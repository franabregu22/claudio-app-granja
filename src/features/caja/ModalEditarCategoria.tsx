import { useState, useMemo } from 'react';
import { X } from 'lucide-react';
import { useCategorias, useActualizarMovimientoCategoria } from '../../hooks/useCategorias';
import type { MovimientoCaja } from '../../types/domain';

interface ModalEditarCategoriaProps {
  movimiento: MovimientoCaja;
  onClose: () => void;
  onGuardar: () => void;
}

export function ModalEditarCategoria({ movimiento, onClose, onGuardar }: ModalEditarCategoriaProps) {
  const categoriasQuery = useCategorias();
  const actualizarMutation = useActualizarMovimientoCategoria();

  // Solo se permite categorizar egresos
  if (movimiento.tipo !== 'egreso') {
    return null;
  }

  const [categoriaTecnica, setCategoriaTecnica] = useState(movimiento.categoria_tecnica || '');
  const [subcategoria, setSubcategoria] = useState(movimiento.subcategoria || '');
  const [error, setError] = useState<string | null>(null);

  // Obtener subcategorías disponibles para la categoría seleccionada
  const subcategoriasDisponibles = useMemo(() => {
    if (!categoriaTecnica || !categoriasQuery.data) return [];
    return [
      ...new Set(
        categoriasQuery.data
          .filter((c) => c.categoria_tecnica === categoriaTecnica)
          .map((c) => c.subcategoria)
      ),
    ];
  }, [categoriaTecnica, categoriasQuery.data]);

  const handleGuardar = async () => {
    setError(null);

    if (!categoriaTecnica || !subcategoria) {
      setError('Selecciona categoría y subcategoría');
      return;
    }

    try {
      await actualizarMutation.mutateAsync({
        movimientoId: movimiento.id,
        categoriaTecnica,
        subcategoria,
      });
      onGuardar();
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Error al guardar la categoría');
    }
  };

  const categoriasTecnicas = useMemo(() => {
    if (!categoriasQuery.data) return [];
    return [...new Set(categoriasQuery.data.map((c) => c.categoria_tecnica))];
  }, [categoriasQuery.data]);

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg max-w-md w-full p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-[#2C2419]">Editar Categoría</h3>
          <button onClick={onClose} className="text-[#8A7A5C] hover:text-[#2C2419]">
            <X className="w-5 h-5" />
          </button>
        </div>

        <p className="text-sm text-[#8A7A5C] mb-4">{movimiento.concepto}</p>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-lg text-sm mb-4">
            {error}
          </div>
        )}

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-[#6B5D45] mb-2">
              Categoría Técnica
            </label>
            <select
              value={categoriaTecnica}
              onChange={(e) => {
                setCategoriaTecnica(e.target.value);
                setSubcategoria('');
              }}
              className="w-full border border-[#D8CDB0] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#A8552E]"
            >
              <option value="">Seleccionar...</option>
              {categoriasTecnicas.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>
          </div>

          {categoriaTecnica && (
            <div>
              <label className="block text-sm font-medium text-[#6B5D45] mb-2">
                Subcategoría
              </label>
              <select
                value={subcategoria}
                onChange={(e) => setSubcategoria(e.target.value)}
                className="w-full border border-[#D8CDB0] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#A8552E]"
              >
                <option value="">Seleccionar...</option>
                {subcategoriasDisponibles.map((sub) => (
                  <option key={sub} value={sub}>
                    {sub}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div className="flex gap-2 mt-6">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2 border border-[#D8CDB0] rounded-lg text-[#2C2419] font-medium hover:bg-[#F5EFE6]"
          >
            Cancelar
          </button>
          <button
            onClick={handleGuardar}
            disabled={actualizarMutation.isPending || !categoriaTecnica || !subcategoria}
            className="flex-1 px-4 py-2 bg-[#A8552E] text-white rounded-lg font-medium hover:bg-[#8B4423] disabled:opacity-50"
          >
            {actualizarMutation.isPending ? 'Guardando...' : 'Guardar'}
          </button>
        </div>
      </div>
    </div>
  );
}
