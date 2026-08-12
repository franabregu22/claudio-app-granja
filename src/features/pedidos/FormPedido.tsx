import { ChevronLeft, Trash2, Plus } from 'lucide-react';
import { useState } from 'react';
import type { Cliente, Rol, LineaPedido } from '../../types/domain';
import {
  totalUnidadesGeneric,
  totalPedidoGeneric,
  formatoPesos,
  agregarLineaPedido,
  removerLineaPedido,
} from './helpers';
import { useProductos } from '../../hooks/useProductos';

interface FormPedidoProps {
  modo: 'nuevo' | 'rectificar';
  clientes: Cliente[];
  clienteSel: string;
  setClienteSel: (id: string) => void;
  clienteNuevo: string;
  setClienteNuevo: (nombre: string) => void;
  lineas: LineaPedido[];
  setLineas: (lineas: LineaPedido[]) => void;
  fechaPedido: string;
  setFechaPedido: (fecha: string) => void;
  observaciones: string;
  setObservaciones: (obs: string) => void;
  onGuardar: () => Promise<void>;
  onVolver: () => void;
  error: string | null;
  rol: Rol | null;
}

export function FormPedido({
  modo,
  clientes,
  clienteSel,
  setClienteSel,
  clienteNuevo,
  setClienteNuevo,
  lineas,
  setLineas,
  fechaPedido,
  setFechaPedido,
  observaciones,
  setObservaciones,
  onGuardar,
  onVolver,
  error,
  rol,
}: FormPedidoProps) {
  const [isSaving, setIsSaving] = useState(false);
  const [productoSelId, setProductoSelId] = useState('');
  const { data: productos = [], isLoading: productosLoading } = useProductos();

  const total = totalUnidadesGeneric(lineas);
  const monto = totalPedidoGeneric(lineas);
  const puedeGuardar = (clienteSel || clienteNuevo.trim()) && total > 0;

  async function handleGuardar() {
    setIsSaving(true);
    try {
      await onGuardar();
    } finally {
      setIsSaving(false);
    }
  }

  function handleAgregarProducto() {
    if (!productoSelId) return;
    const producto = productos.find((p) => p.id === productoSelId);
    if (!producto) return;

    setLineas(agregarLineaPedido(lineas, producto, 1));
    setProductoSelId('');
  }

  function handleCambiarCantidad(productoId: string, cantidad: number) {
    setLineas(
      lineas.map((l) =>
        l.producto_id === productoId
          ? {
              ...l,
              cantidad: Math.max(0, cantidad),
              subtotal: Math.max(0, cantidad) * l.precio_unitario,
            }
          : l
      )
    );
  }

  function handleRemover(productoId: string) {
    setLineas(removerLineaPedido(lineas, productoId));
  }

  return (
    <div className="flex-1 flex flex-col">
      <header className="px-5 pt-6 pb-4 border-b border-[#E4DCC8] flex items-center gap-3">
        <button
          onClick={onVolver}
          aria-label="Volver"
          className="w-9 h-9 flex items-center justify-center rounded-full bg-[#A8552E] text-white active:scale-95 transition-transform disabled:opacity-50"
          disabled={isSaving}
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
        <h1 className="text-lg font-bold text-[#2C2419]">
          {modo === 'rectificar' ? 'Rectificar pedido' : 'Nuevo pedido'}
        </h1>
      </header>

      <div className="flex-1 overflow-y-auto px-5 pt-4 pb-28">
        {error && (
          <div className="bg-[#FCE4E4] border border-[#E4B0B0] text-[#A32D2D] text-sm px-3 py-2 rounded-lg mb-4">
            {error}
          </div>
        )}

        <label className="block text-xs font-semibold text-[#6B5D45] uppercase tracking-wide mb-1.5">
          Cliente
        </label>

        <div className="mb-5">
          <select
            value={clienteSel}
            onChange={(e) => {
              setClienteSel(e.target.value);
              setClienteNuevo('');
            }}
            disabled={isSaving}
            className="w-full border border-[#D8CDB0] rounded-lg px-3 py-2.5 bg-white text-[#2C2419] mb-2 disabled:opacity-50"
          >
            <option value="">Elegir cliente existente…</option>
            {clientes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nombre}
              </option>
            ))}
          </select>
          {modo === 'nuevo' && (
            <p className="text-xs text-[#8A7A5C] mt-2">
              Para agregar un cliente nuevo, crealo en Supabase primero.
            </p>
          )}
        </div>

        <label className="block text-xs font-semibold text-[#6B5D45] uppercase tracking-wide mb-1.5">
          Fecha del pedido
        </label>
        <input
          type="date"
          value={fechaPedido}
          onChange={(e) => setFechaPedido(e.target.value)}
          disabled={isSaving}
          className="w-full border border-[#D8CDB0] rounded-lg px-3 py-2.5 bg-white text-[#2C2419] mb-5 disabled:opacity-50"
        />

        <label className="block text-xs font-semibold text-[#6B5D45] uppercase tracking-wide mb-1.5">
          Productos
        </label>

        {productosLoading ? (
          <div className="text-sm text-[#8A7A5C]">Cargando productos...</div>
        ) : (
          <div className="mb-4 flex gap-2">
            <select
              value={productoSelId}
              onChange={(e) => setProductoSelId(e.target.value)}
              disabled={isSaving}
              className="flex-1 border border-[#D8CDB0] rounded-lg px-3 py-2.5 bg-white text-[#2C2419] disabled:opacity-50"
            >
              <option value="">Elegir producto…</option>
              {productos.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nombre} ({p.unidad})
                </option>
              ))}
            </select>
            <button
              onClick={handleAgregarProducto}
              disabled={!productoSelId || isSaving}
              className="px-4 py-2.5 bg-[#A8552E] text-white rounded-lg disabled:bg-[#D8CDB0] disabled:text-[#A89878] font-medium flex items-center gap-1"
            >
              <Plus className="w-4 h-4" /> Agregar
            </button>
          </div>
        )}

        {lineas.length === 0 ? (
          <div className="bg-[#F5EFE6] border border-[#E4DCC8] rounded-lg p-4 text-center mb-5">
            <p className="text-sm text-[#8A7A5C]">No hay productos agregados aún</p>
          </div>
        ) : (
          <div className="space-y-3 mb-5">
            {lineas.map((linea) => (
              <div
                key={linea.producto_id}
                className="bg-white border border-[#E4DCC8] rounded-lg p-3"
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="flex-1">
                    <p className="font-semibold text-[#2C2419]">{linea.producto_nombre}</p>
                    <div className="flex items-center gap-1 mt-1">
                      <span className="text-xs text-[#8A7A5C]">$</span>
                      {rol === 'dueño' ? (
                        <input
                          type="text"
                          inputMode="decimal"
                          value={linea.precio_unitario || ''}
                          onFocus={(e) => e.target.select()}
                          onChange={(e) => {
                            const val = e.target.value;
                            const nuevoPrecio = val === '' ? 0 : Math.max(0, Number(val) || 0);
                            setLineas(
                              lineas.map((l) =>
                                l.producto_id === linea.producto_id
                                  ? {
                                      ...l,
                                      precio_unitario: nuevoPrecio,
                                      subtotal: l.cantidad * nuevoPrecio,
                                    }
                                  : l
                              )
                            );
                          }}
                          disabled={isSaving}
                          className="w-20 text-center text-sm font-semibold border border-[#D8CDB0] rounded py-0.5 disabled:opacity-50"
                        />
                      ) : (
                        <span className="text-sm font-semibold text-[#8A7A5C]">
                          {linea.precio_unitario.toLocaleString('es-AR')}
                        </span>
                      )}
                      <span className="text-xs text-[#8A7A5C]">por unidad</span>
                    </div>
                  </div>
                  <button
                    onClick={() => handleRemover(linea.producto_id)}
                    disabled={isSaving}
                    className="p-1.5 text-[#A32D2D] hover:bg-[#FCE4E4] rounded disabled:opacity-50"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleCambiarCantidad(linea.producto_id, linea.cantidad - 1)}
                    disabled={isSaving}
                    className="w-8 h-8 flex items-center justify-center rounded-full bg-[#A8552E] text-white disabled:opacity-50"
                  >
                    −
                  </button>
                  <input
                    type="number"
                    inputMode="numeric"
                    min="0"
                    value={linea.cantidad}
                    onFocus={(e) => e.target.select()}
                    onChange={(e) =>
                      handleCambiarCantidad(linea.producto_id, Number(e.target.value))
                    }
                    disabled={isSaving}
                    className="flex-1 text-center font-semibold border border-[#D8CDB0] rounded-md py-1 disabled:opacity-50"
                  />
                  <button
                    onClick={() => handleCambiarCantidad(linea.producto_id, linea.cantidad + 1)}
                    disabled={isSaving}
                    className="w-8 h-8 flex items-center justify-center rounded-full bg-[#A8552E] text-white disabled:opacity-50"
                  >
                    +
                  </button>
                  <span className="text-right text-sm font-semibold text-[#A8552E] min-w-24">
                    {formatoPesos(linea.subtotal)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}

        <label className="block text-xs font-semibold text-[#6B5D45] uppercase tracking-wide mb-1.5">
          Observaciones (opcional)
        </label>
        <textarea
          value={observaciones}
          onChange={(e) => setObservaciones(e.target.value)}
          placeholder="Ej: Cliente nuevo, entregar en domicilio, etc."
          disabled={isSaving}
          className="w-full border border-[#D8CDB0] rounded-lg px-3 py-2.5 bg-white text-[#2C2419] mb-5 disabled:opacity-50 resize-none"
          rows={2}
        />

        {lineas.length > 0 && (
          <div className="mt-5 px-1 py-2 bg-[#F5EFE6] rounded-lg">
            <p className="text-xs text-[#6B5D45] font-semibold mb-1">Resumen</p>
            <p className="text-sm text-[#2C2419]">
              {lineas.map((l) => `${l.cantidad} ${l.producto_nombre}`).join(' + ')}
            </p>
          </div>
        )}
        <div className="flex items-center justify-between px-1">
          <span className="text-sm text-[#6B5D45]">Total del pedido</span>
          <span className="text-2xl font-bold text-[#A8552E] tabular-nums">
            {formatoPesos(monto)}
          </span>
        </div>
      </div>

      <div className="absolute bottom-0 left-0 right-0 p-5 bg-[#FAF6EE] border-t border-[#E4DCC8]">
        <button
          onClick={handleGuardar}
          disabled={!puedeGuardar || isSaving}
          className="w-full bg-[#A8552E] disabled:bg-[#D8CDB0] disabled:text-[#A89878] text-white font-semibold py-3.5 rounded-lg active:scale-95 transition-transform"
        >
          {isSaving
            ? 'Cargando...'
            : modo === 'rectificar'
              ? 'Guardar rectificación'
              : 'Cargar pedido'}
        </button>
      </div>
    </div>
  );
}
