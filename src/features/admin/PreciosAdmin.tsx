import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import * as preciosApi from '../../api/precios';
import { CATEGORIAS } from '../../constants/categorias';
import type { Categoria } from '../../types/domain';

interface Precio {
  id: string;
  categoria: string;
  precio: number;
}

export function PreciosAdmin() {
  const queryClient = useQueryClient();
  const [editando, setEditando] = useState<string | null>(null);

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
  useState(() => {
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
  });

  const actualizarMutation = useMutation({
    mutationFn: (variables: { categoria: Categoria; precio: number }) =>
      preciosApi.actualizarPrecio(variables.categoria, variables.precio),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['preciosAdmin'] });
      setEditando(null);
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-gray-500">Cargando precios...</p>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="bg-white rounded-lg border border-amber-200 overflow-hidden">
        <div className="grid grid-cols-3 gap-4 p-4 bg-stone-50 border-b border-amber-200 font-semibold text-sm text-amber-900">
          <div>Categoría</div>
          <div>Precio actual</div>
          <div>Acción</div>
        </div>

        <div className="divide-y divide-gray-200">
          {CATEGORIAS.map((cat) => {
            const precio = precios.find((p) => p.categoria === cat.id);
            const isEditing = editando === cat.id;

            return (
              <div
                key={cat.id}
                className="grid grid-cols-3 gap-4 p-4 items-center hover:bg-stone-50"
              >
                <div className="font-medium text-gray-800">{cat.label}</div>

                {isEditing && precio ? (
                  <input
                    type="number"
                    defaultValue={precio.precio}
                    onBlur={(e) => {
                      const newPrice = Number(e.currentTarget.value);
                      if (newPrice !== precio.precio && newPrice > 0) {
                        actualizarMutation.mutate({
                          categoria: cat.id as Categoria,
                          precio: newPrice,
                        });
                      } else {
                        setEditando(null);
                      }
                    }}
                    onKeyPress={(e) => {
                      if (e.key === 'Enter') {
                        const newPrice = Number(e.currentTarget.value);
                        if (newPrice > 0) {
                          actualizarMutation.mutate({
                            categoria: cat.id as Categoria,
                            precio: newPrice,
                          });
                        }
                      }
                    }}
                    autoFocus
                    className="border border-amber-600 rounded px-3 py-1 text-sm"
                  />
                ) : (
                  <div
                    onClick={() => setEditando(cat.id)}
                    className="cursor-pointer hover:text-amber-600 font-semibold text-amber-900"
                  >
                    ${precio?.precio.toLocaleString('es-AR') || '0'}
                  </div>
                )}

                <button
                  onClick={() => setEditando(cat.id)}
                  disabled={actualizarMutation.isPending || isEditing}
                  className="text-sm text-amber-600 hover:text-amber-700 font-medium disabled:opacity-50"
                >
                  {isEditing ? 'Guardando...' : 'Editar'}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
