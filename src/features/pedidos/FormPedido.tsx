import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useAuth } from '../../auth/useAuth';
import { currentPrice, type LineInput, type OrderRow } from '../../target/commercial';
import { PRICE_LISTS, type PriceList } from '../../target/masters';
import { errorMessage } from '../../target/messages';
import { formatoPesos } from './helpers';
import { useOrderCatalog, useOrderMutations } from './useCommercial';

type Modo = 'nuevo' | 'editar' | 'rectificar';
const LIST_LABEL: Record<PriceList, string> = { MINORISTA: 'Minorista', MAYORISTA: 'Mayorista' };

interface FormPedidoProps {
  modo: Modo;
  pedido?: OrderRow | null;
  onDone: () => void;
}

/**
 * Order form (F27-C). "nuevo" / "editar" write a PENDING order directly (the only authorized order writes);
 * "rectificar" corrects a DELIVERED order through rectify_delivered_order with a mandatory reason. Each line's
 * price starts at the current price of the chosen list (price_history) and is snapshotted on the line; the total
 * shown is a preview — the saved total is the sum of the database-generated subtotals.
 */
export function FormPedido({ modo, pedido, onDone }: FormPedidoProps) {
  const { user } = useAuth();
  const catalog = useOrderCatalog();
  const m = useOrderMutations();
  const [clienteId, setClienteId] = useState(pedido?.cliente_id ?? '');
  const [lista, setLista] = useState<PriceList>('MINORISTA');
  const [lineas, setLineas] = useState<LineInput[]>(() => (pedido?.lineas ?? []).map((l) => ({
    producto_id: l.producto_id, producto_nombre: l.producto_nombre, cantidad: l.cantidad, precio_unitario: l.precio_unitario,
  })));
  const [productoSelId, setProductoSelId] = useState('');
  const [motivo, setMotivo] = useState('');

  const precioDe = (productoId: string, l: PriceList) => currentPrice(catalog.prices, productoId, l);
  const sinPrecio = (l: LineInput) => precioDe(l.producto_id, lista) === null;
  const estimado = lineas.reduce((s, l) => s + l.cantidad * l.precio_unitario, 0);
  const mutation = modo === 'nuevo' ? m.create : modo === 'editar' ? m.updatePending : m.rectify;
  const lineasOk = lineas.length > 0 && lineas.every((l) => l.cantidad > 0 && l.precio_unitario >= 0);
  const puedeGuardar = clienteId !== '' && lineasOk && (modo !== 'rectificar' || motivo.trim() !== '') && !mutation.isPending;

  function agregarProducto() {
    const producto = catalog.products.find((p) => p.id === productoSelId);
    if (!producto) return;
    if (lineas.some((l) => l.producto_id === producto.id)) { setProductoSelId(''); return; }
    setLineas([...lineas, { producto_id: producto.id, producto_nombre: producto.nombre, cantidad: 1, precio_unitario: precioDe(producto.id, lista) ?? 0 }]);
    setProductoSelId('');
  }
  function cambiarLista(nueva: PriceList) {
    setLista(nueva);
    // re-apply the chosen list's current price to every line that has one
    setLineas(lineas.map((l) => ({ ...l, precio_unitario: precioDe(l.producto_id, nueva) ?? l.precio_unitario })));
  }
  const actualizar = (id: string, cambio: Partial<LineInput>) => setLineas(lineas.map((l) => (l.producto_id === id ? { ...l, ...cambio } : l)));

  function guardar() {
    if (!puedeGuardar) return;
    const opts = { onSuccess: onDone };
    if (modo === 'nuevo') m.create.mutate({ clienteId, lines: lineas, userId: user?.id ?? null }, opts);
    else if (modo === 'editar' && pedido) {
      m.updatePending.mutate({ orderId: pedido.id, clienteId, lines: lineas, previousLineIds: pedido.lineas.map((l) => l.id), userId: user?.id ?? null }, opts);
    } else if (modo === 'rectificar' && pedido) m.rectify.mutate({ orderId: pedido.id, lines: lineas, reason: motivo }, opts);
  }

  const campo = 'w-full border border-[#D8CDB0] rounded-lg px-3 py-2.5 bg-white text-[#2C2419] disabled:opacity-50';
  const etiqueta = 'block text-xs font-semibold text-[#6B5D45] uppercase tracking-wide mb-1.5';
  if (catalog.isLoading) return <div className="text-sm text-[#8A7A5C]">Cargando clientes y productos...</div>;
  if (catalog.error) return <div className="text-sm text-[#A32D2D]">{errorMessage(catalog.error)}</div>;

  return (
    <div className="flex flex-col">
      {mutation.error && (
        <div className="bg-[#FCE4E4] border border-[#E4B0B0] text-[#A32D2D] text-sm px-3 py-2 rounded-lg mb-4">{errorMessage(mutation.error)}</div>
      )}

      <label className={etiqueta}>Cliente</label>
      <select value={clienteId} onChange={(e) => setClienteId(e.target.value)} disabled={mutation.isPending || modo === 'rectificar'} className={`${campo} mb-5`}>
        <option value="">Elegir cliente…</option>
        {catalog.clients.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
      </select>

      <label className={etiqueta}>Lista de precios</label>
      <div className="flex gap-2 mb-5">
        {PRICE_LISTS.map((l) => (
          <button key={l} type="button" onClick={() => cambiarLista(l)} disabled={mutation.isPending}
            className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium ${lista === l ? 'bg-[#A8552E] text-white' : 'bg-white border border-[#D8CDB0] text-[#2C2419]'}`}>
            {LIST_LABEL[l]}
          </button>
        ))}
      </div>

      <label className={etiqueta}>Productos</label>
      <div className="mb-4 flex gap-2">
        <select value={productoSelId} onChange={(e) => setProductoSelId(e.target.value)} disabled={mutation.isPending} className={`flex-1 ${campo}`}>
          <option value="">Elegir producto…</option>
          {catalog.products.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
        </select>
        <button onClick={agregarProducto} disabled={!productoSelId || mutation.isPending}
          className="px-4 py-2.5 bg-[#A8552E] text-white rounded-lg disabled:bg-[#D8CDB0] disabled:text-[#A89878] font-medium flex items-center gap-1">
          <Plus className="w-4 h-4" /> Agregar
        </button>
      </div>

      {lineas.length === 0 ? (
        <div className="bg-[#F5EFE6] border border-[#E4DCC8] rounded-lg p-4 text-center mb-5">
          <p className="text-sm text-[#8A7A5C]">No hay productos agregados aún</p>
        </div>
      ) : (
        <div className="space-y-3 mb-5">
          {lineas.map((l) => (
            <div key={l.producto_id} className="bg-white border border-[#E4DCC8] rounded-lg p-3">
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="flex-1">
                  <p className="font-semibold text-[#2C2419]">{l.producto_nombre}</p>
                  <div className="flex items-center gap-1 mt-1">
                    <span className="text-xs text-[#8A7A5C]">$</span>
                    <input type="text" inputMode="decimal" value={l.precio_unitario} aria-label={`Precio ${l.producto_nombre}`}
                      onFocus={(e) => e.target.select()}
                      onChange={(e) => actualizar(l.producto_id, { precio_unitario: Math.max(0, Number(e.target.value) || 0) })}
                      disabled={mutation.isPending} className="w-24 text-center text-sm font-semibold border border-[#D8CDB0] rounded py-0.5" />
                    <span className="text-xs text-[#8A7A5C]">por unidad</span>
                  </div>
                  {sinPrecio(l) && <p className="text-xs text-[#A32D2D] mt-1">Sin precio vigente en la lista {LIST_LABEL[lista].toLowerCase()}: ingresalo a mano.</p>}
                </div>
                <button onClick={() => setLineas(lineas.filter((x) => x.producto_id !== l.producto_id))} disabled={mutation.isPending}
                  aria-label={`Quitar ${l.producto_nombre}`} className="p-1.5 text-[#A32D2D] hover:bg-[#FCE4E4] rounded">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => actualizar(l.producto_id, { cantidad: Math.max(1, l.cantidad - 1) })} disabled={mutation.isPending}
                  className="w-8 h-8 flex items-center justify-center rounded-full bg-[#A8552E] text-white">−</button>
                <input type="number" inputMode="numeric" min={1} value={l.cantidad} aria-label={`Cantidad ${l.producto_nombre}`}
                  onFocus={(e) => e.target.select()} onChange={(e) => actualizar(l.producto_id, { cantidad: Math.max(0, Number(e.target.value) || 0) })}
                  disabled={mutation.isPending} className="flex-1 text-center font-semibold border border-[#D8CDB0] rounded-md py-1" />
                <button onClick={() => actualizar(l.producto_id, { cantidad: l.cantidad + 1 })} disabled={mutation.isPending}
                  className="w-8 h-8 flex items-center justify-center rounded-full bg-[#A8552E] text-white">+</button>
                <span className="text-right text-sm font-semibold text-[#A8552E] min-w-24">{formatoPesos(l.cantidad * l.precio_unitario)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {modo === 'rectificar' && (
        <>
          <label className={etiqueta}>Motivo de la rectificación</label>
          <textarea value={motivo} onChange={(e) => setMotivo(e.target.value)} rows={2} disabled={mutation.isPending}
            placeholder="Ej: se entregaron 2 maples menos" className={`${campo} mb-5 resize-none`} />
        </>
      )}

      <div className="flex items-center justify-between px-1 mb-4">
        <span className="text-sm text-[#6B5D45]">Total estimado</span>
        <span className="text-2xl font-bold text-[#A8552E] tabular-nums">{formatoPesos(estimado)}</span>
      </div>
      <p className="text-xs text-[#8A7A5C] mb-4">El total definitivo lo calcula el sistema a partir de las líneas guardadas.</p>

      <button onClick={guardar} disabled={!puedeGuardar}
        className="w-full bg-[#A8552E] disabled:bg-[#D8CDB0] disabled:text-[#A89878] text-white font-semibold py-3.5 rounded-lg">
        {mutation.isPending ? 'Guardando...' : modo === 'rectificar' ? 'Guardar rectificación' : modo === 'editar' ? 'Guardar cambios' : 'Cargar pedido'}
      </button>
    </div>
  );
}
