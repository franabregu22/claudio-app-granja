import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { CATEGORIAS } from '../../constants/categorias';
import type { Categoria } from '../../types/domain';
import { X } from 'lucide-react';

interface Precio {
  id: string;
  categoria: Categoria;
  tipo_cliente: 'minorista' | 'mayorista' | 'ambos';
  precio: number;
  vigente_desde: string;
}

export function PreciosAdmin() {
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [modalData, setModalData] = useState<{
    id: string;
    categoria: Categoria;
    tipoCliente: string;
    precioActual: number;
  } | null>(null);
  const [nuevoPrecio, setNuevoPrecio] = useState('');
  const [vigentDesde, setVigentDesde] = useState('');

  const { data: precios = [], isLoading } = useQuery({
    queryKey: ['preciosAdmin'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('precios_actuales')
        .select('*')
        .order('categoria');

      if (error) throw error;
      return data as Precio[];
    },
  });

  // Suscripción a cambios
  useEffect(() => {
    const channel = supabase
      .channel('precios-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'precios_actuales' },
        () => {
          queryClient.invalidateQueries({ queryKey: ['preciosAdmin'] });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient]);

  const actualizarMutation = useMutation({
    mutationFn: async (variables: { id: string; precio: number; vigentDesde: string }) => {
      // Primero, guardar en historial el precio anterior
      const precioActual = precios.find((p) => p.id === variables.id);
      if (precioActual) {
        const { error: historialError } = await supabase
          .from('precios_historial')
          .insert([{
            categoria: precioActual.categoria,
            tipo_cliente: precioActual.tipo_cliente,
            precio_anterior: precioActual.precio,
            precio_nuevo: variables.precio,
            vigente_desde: variables.vigentDesde,
          }]);
        if (historialError) throw historialError;
      }

      // Luego, actualizar el precio actual
      const { error } = await supabase
        .from('precios_actuales')
        .update({ precio: variables.precio, vigente_desde: variables.vigentDesde })
        .eq('id', variables.id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['preciosAdmin'] });
      setModalOpen(false);
      setModalData(null);
    },
  });

  const abrirModal = (precio: Precio) => {
    setModalData({
      id: precio.id,
      categoria: precio.categoria,
      tipoCliente: precio.tipo_cliente,
      precioActual: precio.precio,
    });
    setNuevoPrecio(precio.precio.toString());
    setVigentDesde(precio.vigente_desde);
    setModalOpen(true);
  };

  const guardarPrecio = () => {
    if (!nuevoPrecio || !vigentDesde || !modalData) return;

    const nuevo = Number(nuevoPrecio);
    if (nuevo <= 0) return;

    actualizarMutation.mutate({
      id: modalData.id,
      precio: nuevo,
      vigentDesde,
    });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-gray-500">Cargando precios...</p>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="space-y-6">
        {CATEGORIAS.map((cat) => {
          const preciosCategoria = precios.filter((p) => p.categoria === cat.id);
          const minorista = preciosCategoria.find((p) => p.tipo_cliente === 'minorista' || p.tipo_cliente === 'ambos');
          const mayorista = preciosCategoria.find((p) => p.tipo_cliente === 'mayorista' || p.tipo_cliente === 'ambos');

          return (
            <div key={cat.id} className="bg-white rounded-lg border border-amber-200 overflow-hidden">
              <div className="bg-amber-50 px-4 md:px-6 py-4 border-b border-amber-200">
                <h3 className="font-semibold text-amber-900">{cat.label}</h3>
              </div>

              <div className="p-6">
                {cat.id === 'docena' ? (
                  // Docena: un solo precio
                  minorista && (
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-gray-600">Precio</p>
                        <p className="text-2xl font-bold text-amber-900">
                          ${minorista.precio.toLocaleString('es-AR')}
                        </p>
                        <p className="text-xs text-gray-500 mt-1">
                          Vigente desde: {minorista.vigente_desde}
                        </p>
                      </div>
                      <button
                        onClick={() => abrirModal(minorista)}
                        className="bg-amber-600 hover:bg-amber-700 text-white px-4 md:px-6 py-2 rounded font-medium"
                      >
                        Actualizar precio
                      </button>
                    </div>
                  )
                ) : (
                  // Otras categorías: minorista + mayorista
                  <div className="grid grid-cols-2 gap-6">
                    <div>
                      <p className="text-gray-600 font-medium mb-3">Minorista</p>
                      {minorista ? (
                        <>
                          <p className="text-2xl font-bold text-amber-900">
                            ${minorista.precio.toLocaleString('es-AR')}
                          </p>
                          <p className="text-xs text-gray-500 mt-1">
                            Vigente: {minorista.vigente_desde}
                          </p>
                          <button
                            onClick={() => abrirModal(minorista)}
                            className="mt-4 bg-amber-600 hover:bg-amber-700 text-white px-4 py-2 rounded text-sm font-medium"
                          >
                            Actualizar
                          </button>
                        </>
                      ) : (
                        <p className="text-gray-500">Sin precio</p>
                      )}
                    </div>

                    <div>
                      <p className="text-gray-600 font-medium mb-3">Mayorista</p>
                      {mayorista ? (
                        <>
                          <p className="text-2xl font-bold text-amber-900">
                            ${mayorista.precio.toLocaleString('es-AR')}
                          </p>
                          <p className="text-xs text-gray-500 mt-1">
                            Vigente: {mayorista.vigente_desde}
                          </p>
                          <button
                            onClick={() => abrirModal(mayorista)}
                            className="mt-4 bg-amber-600 hover:bg-amber-700 text-white px-4 py-2 rounded text-sm font-medium"
                          >
                            Actualizar
                          </button>
                        </>
                      ) : (
                        <p className="text-gray-500">Sin precio</p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Modal */}
      {modalOpen && modalData && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg max-w-sm w-full p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold text-amber-900">
                Actualizar precio - {modalData.tipoCliente}
              </h2>
              <button
                onClick={() => setModalOpen(false)}
                className="text-gray-400 hover:text-gray-600"
              >
                <X size={24} />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Precio actual: ${modalData.precioActual.toLocaleString('es-AR')}
                </label>
                <input
                  type="number"
                  value={nuevoPrecio}
                  onChange={(e) => setNuevoPrecio(e.target.value)}
                  placeholder="Nuevo precio"
                  className="w-full border border-gray-300 rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-amber-600"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Vigente desde
                </label>
                <input
                  type="date"
                  value={vigentDesde}
                  onChange={(e) => setVigentDesde(e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-amber-600"
                />
              </div>

              <div className="flex gap-2 pt-4">
                <button
                  onClick={() => setModalOpen(false)}
                  className="flex-1 px-4 py-2 border border-gray-300 rounded text-gray-700 font-medium hover:bg-gray-50"
                >
                  Cancelar
                </button>
                <button
                  onClick={guardarPrecio}
                  disabled={actualizarMutation.isPending || !nuevoPrecio || !vigentDesde}
                  className="flex-1 px-4 py-2 bg-amber-600 text-white rounded font-medium hover:bg-amber-700 disabled:opacity-50"
                >
                  {actualizarMutation.isPending ? 'Guardando...' : 'Guardar'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
