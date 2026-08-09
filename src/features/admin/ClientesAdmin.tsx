import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import * as clientesApi from '../../api/clientes';
import type { Cliente } from '../../types/domain';
import { Trash2, Plus } from 'lucide-react';

export function ClientesAdmin() {
  const queryClient = useQueryClient();
  const [nuevoNombre, setNuevoNombre] = useState('');
  const [editando, setEditando] = useState<string | null>(null);

  const { data: clientes = [], isLoading } = useQuery({
    queryKey: ['clientesAdmin'],
    queryFn: clientesApi.listarTodosClientes,
  });

  // Suscripción a cambios en tiempo real
  useState(() => {
    const channel = supabase
      .channel('clientes-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'clientes' },
        () => {
          queryClient.invalidateQueries({ queryKey: ['clientesAdmin'] });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  });

  const crearMutation = useMutation({
    mutationFn: (nombre: string) => clientesApi.crearCliente(nombre),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clientesAdmin'] });
      setNuevoNombre('');
    },
  });

  const actualizarMutation = useMutation({
    mutationFn: ({
      id,
      nombre,
      activo,
    }: {
      id: string;
      nombre: string;
      activo: boolean;
    }) => clientesApi.actualizarCliente(id, nombre, activo),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clientesAdmin'] });
      setEditando(null);
    },
  });

  const agregarCliente = () => {
    if (!nuevoNombre.trim()) return;
    crearMutation.mutate(nuevoNombre.trim());
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-gray-500">Cargando clientes...</p>
      </div>
    );
  }

  return (
    <div className="p-6">
      {/* Formulario agregar cliente */}
      <div className="mb-8 bg-white p-4 rounded-lg border border-amber-200">
        <h2 className="font-semibold text-amber-900 mb-3">Agregar cliente</h2>
        <div className="flex gap-2">
          <input
            type="text"
            value={nuevoNombre}
            onChange={(e) => setNuevoNombre(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && agregarCliente()}
            placeholder="Nombre del cliente"
            className="flex-1 border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-600"
          />
          <button
            onClick={agregarCliente}
            disabled={crearMutation.isPending || !nuevoNombre.trim()}
            className="bg-amber-600 hover:bg-amber-700 text-white px-4 py-2 rounded font-medium text-sm disabled:opacity-50 flex items-center gap-1"
          >
            <Plus size={16} />
            Agregar
          </button>
        </div>
      </div>

      {/* Lista de clientes */}
      <div className="space-y-2">
        <h2 className="font-semibold text-amber-900 mb-3">Clientes</h2>
        {clientes.length === 0 ? (
          <p className="text-gray-500 text-sm">No hay clientes</p>
        ) : (
          clientes.map((cliente) => (
            <div
              key={cliente.id}
              className="bg-white p-4 rounded border border-gray-200 flex items-center justify-between"
            >
              <div className="flex-1">
                {editando === cliente.id ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      defaultValue={cliente.nombre}
                      onBlur={(e) => {
                        if (e.currentTarget.value !== cliente.nombre) {
                          actualizarMutation.mutate({
                            id: cliente.id,
                            nombre: e.currentTarget.value,
                            activo: cliente.activo,
                          });
                        } else {
                          setEditando(null);
                        }
                      }}
                      onKeyPress={(e) => {
                        if (e.key === 'Enter') {
                          actualizarMutation.mutate({
                            id: cliente.id,
                            nombre: e.currentTarget.value,
                            activo: cliente.activo,
                          });
                        }
                      }}
                      autoFocus
                      className="flex-1 border border-amber-600 rounded px-2 py-1 text-sm"
                    />
                  </div>
                ) : (
                  <div
                    onClick={() => setEditando(cliente.id)}
                    className="cursor-pointer hover:text-amber-600"
                  >
                    <p className="font-medium text-gray-800">{cliente.nombre}</p>
                    <p className="text-xs text-gray-500">
                      {cliente.activo ? '✓ Activo' : '✗ Inactivo'}
                    </p>
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1 cursor-pointer text-sm">
                  <input
                    type="checkbox"
                    checked={cliente.activo}
                    onChange={(e) => {
                      actualizarMutation.mutate({
                        id: cliente.id,
                        nombre: cliente.nombre,
                        activo: e.currentTarget.checked,
                      });
                    }}
                    className="w-4 h-4"
                  />
                  <span className="text-gray-600">Activo</span>
                </label>
                <button
                  onClick={() => {
                    actualizarMutation.mutate({
                      id: cliente.id,
                      nombre: cliente.nombre,
                      activo: false,
                    });
                  }}
                  className="text-red-500 hover:text-red-700"
                >
                  <Trash2 size={18} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
