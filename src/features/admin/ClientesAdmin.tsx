import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import * as clientesApi from '../../api/clientes';
import type { ClienteCategoria } from '../../types/domain';
import { ChevronDown, Plus, FileText } from 'lucide-react';

const CATEGORIAS: { id: ClienteCategoria; label: string }[] = [
  { id: 'particular', label: 'Particular' },
  { id: 'comercio', label: 'Comercio' },
  { id: 'distribuidor', label: 'Distribuidor' },
  { id: 'feria municipal', label: 'Feria Municipal' },
];

export function ClientesAdmin() {
  const queryClient = useQueryClient();
  const [nuevoNombre, setNuevoNombre] = useState('');
  const [nuevoCategoria, setNuevoCategoria] = useState<ClienteCategoria>('particular');
  const [nuevoNotas, setNuevoNotas] = useState('');
  const [expandidoActivos, setExpandidoActivos] = useState(true);
  const [expandidoInactivos, setExpandidoInactivos] = useState(false);
  const [clienteNotasId, setClienteNotasId] = useState<string | null>(null);

  const { data: clientes = [], isLoading } = useQuery({
    queryKey: ['clientesAdmin'],
    queryFn: clientesApi.listarTodosClientes,
  });

  // Suscripción a cambios en tiempo real
  useEffect(() => {
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
  }, [queryClient]);

  const crearMutation = useMutation({
    mutationFn: (data: { nombre: string; categoria: ClienteCategoria; notas?: string }) =>
      clientesApi.crearCliente(data.nombre, data.categoria, data.notas),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clientesAdmin'] });
      setNuevoNombre('');
      setNuevoCategoria('particular');
      setNuevoNotas('');
    },
  });

  const actualizarMutation = useMutation({
    mutationFn: (data: { id: string; nombre: string; categoria: ClienteCategoria; activo: boolean; notas?: string }) =>
      clientesApi.actualizarCliente(data.id, data.nombre, data.categoria, data.activo, data.notas),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clientesAdmin'] });
      setClienteNotasId(null);
    },
  });

  const agregarCliente = () => {
    if (!nuevoNombre.trim()) return;
    crearMutation.mutate({ nombre: nuevoNombre.trim(), categoria: nuevoCategoria, notas: nuevoNotas.trim() || undefined });
  };

  const activos = clientes.filter((c) => c.activo);
  const inactivos = clientes.filter((c) => !c.activo);

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
        <div className="flex gap-2 mb-3">
          <input
            type="text"
            value={nuevoNombre}
            onChange={(e) => setNuevoNombre(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && agregarCliente()}
            placeholder="Nombre del cliente"
            className="flex-1 border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-600"
          />
          <select
            value={nuevoCategoria}
            onChange={(e) => setNuevoCategoria(e.target.value as ClienteCategoria)}
            className="border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-600"
          >
            {CATEGORIAS.map((cat) => (
              <option key={cat.id} value={cat.id}>
                {cat.label}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={nuevoNotas}
            onChange={(e) => setNuevoNotas(e.target.value)}
            placeholder="Notas (opcional)"
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

      {/* Clientes Activos */}
      <div className="mb-4">
        <button
          onClick={() => setExpandidoActivos(!expandidoActivos)}
          className="w-full flex items-center gap-2 p-4 bg-green-100 hover:bg-green-200 rounded-lg font-semibold text-green-900 transition"
        >
          <ChevronDown
            size={20}
            className={`transition ${expandidoActivos ? 'rotate-180' : ''}`}
          />
          Activos ({activos.length})
        </button>

        {expandidoActivos && (
          <div className="mt-2 space-y-2">
            {activos.length === 0 ? (
              <p className="text-gray-500 text-sm p-4">No hay clientes activos</p>
            ) : (
              activos.map((cliente) => (
                <div key={cliente.id} className="bg-white rounded border border-gray-200 overflow-hidden">
                  <div className="p-4 flex items-center justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-gray-800">{cliente.nombre}</p>
                        <button
                          onClick={() => setClienteNotasId(clienteNotasId === cliente.id ? null : cliente.id)}
                          className="text-gray-400 hover:text-gray-600"
                          title="Ver/editar notas"
                        >
                          <FileText size={16} />
                        </button>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <select
                        value={cliente.categoria}
                        onChange={(e) => {
                          actualizarMutation.mutate({
                            id: cliente.id,
                            nombre: cliente.nombre,
                            categoria: e.target.value as ClienteCategoria,
                            activo: cliente.activo,
                            notas: cliente.notas,
                          });
                        }}
                        className="text-sm border border-gray-300 rounded px-2 py-1"
                      >
                        {CATEGORIAS.map((cat) => (
                          <option key={cat.id} value={cat.id}>
                            {cat.label}
                          </option>
                        ))}
                      </select>

                      <button
                        onClick={() => {
                          actualizarMutation.mutate({
                            id: cliente.id,
                            nombre: cliente.nombre,
                            categoria: cliente.categoria,
                            activo: false,
                            notas: cliente.notas,
                          });
                        }}
                        className="text-red-500 hover:text-red-700 font-medium text-sm px-2 py-1"
                      >
                        Desactivar
                      </button>
                    </div>
                  </div>

                  {clienteNotasId === cliente.id && (
                    <div className="px-4 pb-4 bg-gray-50 border-t border-gray-200">
                      <textarea
                        value={cliente.notas || ''}
                        onChange={(e) => {
                          actualizarMutation.mutate({
                            id: cliente.id,
                            nombre: cliente.nombre,
                            categoria: cliente.categoria,
                            activo: cliente.activo,
                            notas: e.target.value || undefined,
                          });
                        }}
                        placeholder="Agregar notas (ej: pertenece a despensa X)"
                        className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-600 resize-none"
                        rows={3}
                      />
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Clientes Inactivos */}
      <div>
        <button
          onClick={() => setExpandidoInactivos(!expandidoInactivos)}
          className="w-full flex items-center gap-2 p-4 bg-gray-100 hover:bg-gray-200 rounded-lg font-semibold text-gray-900 transition"
        >
          <ChevronDown
            size={20}
            className={`transition ${expandidoInactivos ? 'rotate-180' : ''}`}
          />
          Inactivos ({inactivos.length})
        </button>

        {expandidoInactivos && (
          <div className="mt-2 space-y-2">
            {inactivos.length === 0 ? (
              <p className="text-gray-500 text-sm p-4">No hay clientes inactivos</p>
            ) : (
              inactivos.map((cliente) => (
                <div
                  key={cliente.id}
                  className="bg-white rounded border border-gray-200 overflow-hidden opacity-75"
                >
                  <div className="p-4 flex items-center justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-gray-800">{cliente.nombre}</p>
                        {cliente.notas && (
                          <button
                            onClick={() => setClienteNotasId(clienteNotasId === cliente.id ? null : cliente.id)}
                            className="text-gray-400 hover:text-gray-600"
                            title="Ver notas"
                          >
                            <FileText size={16} />
                          </button>
                        )}
                      </div>
                    </div>

                    <button
                      onClick={() => {
                        actualizarMutation.mutate({
                          id: cliente.id,
                          nombre: cliente.nombre,
                          categoria: cliente.categoria,
                          activo: true,
                          notas: cliente.notas,
                        });
                      }}
                      className="text-green-600 hover:text-green-700 font-medium text-sm px-2 py-1"
                    >
                      Activar
                    </button>
                  </div>

                  {clienteNotasId === cliente.id && cliente.notas && (
                    <div className="px-4 pb-4 bg-gray-50 border-t border-gray-200 text-sm text-gray-600">
                      {cliente.notas}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
