import { ChevronLeft } from 'lucide-react';
import { CATEGORIAS } from '../../constants/categorias';
import type { Cliente, Precios, Lineas, Rol } from '../../types/domain';
import {
  totalUnidades,
  totalPedido,
  formatoPesos,
} from './helpers';
import { useState } from 'react';

interface FormPedidoProps {
  modo: 'nuevo' | 'rectificar';
  clientes: Cliente[];
  clienteSel: string;
  setClienteSel: (id: string) => void;
  clienteNuevo: string;
  setClienteNuevo: (nombre: string) => void;
  lineas: Lineas;
  cambiarCantidad: (catId: string, delta: number) => void;
  setCantidadDirecta: (catId: string, valor: string) => void;
  precios: Precios;
  cambiarPrecio: (catId: string, valor: string) => void;
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
  cambiarCantidad,
  setCantidadDirecta,
  precios,
  cambiarPrecio,
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

  const total = totalUnidades(lineas);
  const monto = totalPedido(lineas, precios);
  const puedeGuardar = (clienteSel || clienteNuevo.trim()) && total > 0;

  async function handleGuardar() {
    setIsSaving(true);
    try {
      await onGuardar();
    } finally {
      setIsSaving(false);
    }
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

        <div className="flex items-center justify-between mb-2">
          <label className="text-xs font-semibold text-[#6B5D45] uppercase tracking-wide">
            Maples por categoría
          </label>
          {rol === 'dueño' && (
            <label className="text-xs font-semibold text-[#6B5D45] uppercase tracking-wide">
              Precio x maple
            </label>
          )}
        </div>
        <div className="space-y-2">
          {CATEGORIAS.map((c) => (
            <div
              key={c.id}
              className="bg-white border border-[#E4DCC8] rounded-lg px-3 py-2.5"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-[#2C2419] w-12 shrink-0">
                  {c.label}
                </span>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => cambiarCantidad(c.id, -1)}
                    aria-label={`Restar ${c.label}`}
                    className="w-8 h-8 shrink-0 flex items-center justify-center rounded-full bg-[#A8552E] text-white active:scale-90 transition-transform disabled:opacity-50"
                    disabled={isSaving}
                  >
                    −
                  </button>
                  <input
                    type="number"
                    inputMode="numeric"
                    min="0"
                    value={lineas[c.id]}
                    onFocus={(e) => e.target.select()}
                    onChange={(e) => setCantidadDirecta(c.id, e.target.value)}
                    disabled={isSaving}
                    className="w-14 text-center font-semibold tabular-nums text-[#2C2419] border border-[#D8CDB0] rounded-md py-1 disabled:opacity-50"
                  />
                  <button
                    onClick={() => cambiarCantidad(c.id, 1)}
                    aria-label={`Sumar ${c.label}`}
                    className="w-8 h-8 shrink-0 flex items-center justify-center rounded-full bg-[#A8552E] text-white active:scale-90 transition-transform disabled:opacity-50"
                    disabled={isSaving}
                  >
                    +
                  </button>
                </div>

                {rol === 'dueño' && (
                  <div className="flex items-center gap-1 shrink-0">
                    <span className="text-sm text-[#A89878]">$</span>
                    <input
                      type="number"
                      inputMode="numeric"
                      min="0"
                      value={precios[c.id]}
                      onFocus={(e) => e.target.select()}
                      onChange={(e) => cambiarPrecio(c.id, e.target.value)}
                      disabled={isSaving}
                      className="w-16 text-center text-sm tabular-nums text-[#6B5D45] border border-[#E4DCC8] rounded-md py-1 disabled:opacity-50"
                    />
                  </div>
                )}
              </div>
              {lineas[c.id] > 0 && (
                <p className="text-right text-xs text-[#A89878] mt-1.5">
                  {lineas[c.id]} × {formatoPesos(precios[c.id])} = {formatoPesos(lineas[c.id] * precios[c.id])}
                </p>
              )}
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between mt-5 px-1">
          <span className="text-sm text-[#6B5D45]">Total maples</span>
          <span className="text-lg font-semibold text-[#2C2419] tabular-nums">
            {total}
          </span>
        </div>
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
