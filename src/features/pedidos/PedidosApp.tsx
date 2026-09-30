import { useState } from 'react';
import { Check, Package, Pencil, Plus, X } from 'lucide-react';
import { useAuth } from '../../auth/useAuth';
import { orderTotal, type OrderRow } from '../../target/commercial';
import { errorMessage } from '../../target/messages';
import { formatearFechaLocal } from '../../utils/dateUtils';
import { DashboardPedidos } from './DashboardPedidos';
import { FormPedido } from './FormPedido';
import { formatoPesos } from './helpers';
import { useOrderMutations, useOrders } from './useCommercial';

type Vista = 'lista' | 'nuevo' | 'editar' | 'rectificar';
const ITEMS_POR_PAGINA = 15;

/** Short display reference of an order: its business number when it has one, else a short id. */
export function refPedido(p: Pick<OrderRow, 'id' | 'numero_pedido'>): string {
  return p.numero_pedido !== null ? String(p.numero_pedido).padStart(3, '0') : p.id.slice(0, 8);
}

/**
 * Pedidos (F27-C, ADMIN). PENDING orders are created / edited directly; delivery, cancellation and the correction
 * of a delivered order go through RPCs 1–3. The visibility check is UX only: RLS makes orders ADMIN-only.
 */
export function PedidosApp() {
  const { rol } = useAuth();
  const [vista, setVista] = useState<Vista>('lista');
  const [pedidoSel, setPedidoSel] = useState<OrderRow | null>(null);
  const [pagina, setPagina] = useState(0);
  const pendientes = useOrders(['PENDING']);
  const entregados = useOrders(['DELIVERED']);
  const m = useOrderMutations();

  if (rol !== 'ADMIN') {
    return (
      <div className="min-h-screen bg-stone-100 flex items-center justify-center">
        <div className="bg-white p-8 rounded-lg text-center max-w-sm mx-4">
          <p className="text-lg font-semibold text-gray-800">Acceso restringido</p>
          <p className="text-gray-600 mt-2">Solo un administrador puede gestionar pedidos.</p>
        </div>
      </div>
    );
  }

  const abrir = (v: Vista, p: OrderRow | null = null) => {
    m.create.reset(); m.updatePending.reset(); m.rectify.reset();
    setPedidoSel(p);
    setVista(v);
  };
  const cancelar = (p: OrderRow) => {
    const motivo = window.prompt(`Cancelar el pedido #${refPedido(p)} de ${p.cliente_nombre}. Motivo (opcional):`);
    if (motivo === null) return;
    m.cancel.mutate({ orderId: p.id, reason: motivo.trim() || null });
  };
  const accionError = m.deliver.error ?? m.cancel.error;
  const historial = entregados.data ?? [];
  const totalPaginas = Math.max(1, Math.ceil(historial.length / ITEMS_POR_PAGINA));
  const paginados = historial.slice(pagina * ITEMS_POR_PAGINA, (pagina + 1) * ITEMS_POR_PAGINA);

  return (
    <div className="min-h-screen bg-stone-100 flex justify-center relative">
      <div className="w-full max-w-7xl bg-[#FAF6EE] min-h-screen flex flex-col relative">
        <div className="flex-1 min-h-screen overflow-y-auto overflow-x-hidden px-4 md:px-6 py-6 space-y-8 relative">
          <header className="border-b border-[#E4DCC8] pb-4">
            <p className="text-xs font-semibold tracking-wide text-[#A8552E] uppercase">Granja Santo Tomás</p>
            <div className="flex items-center justify-between mt-2">
              <h1 className="text-2xl font-bold text-[#2C2419]">Despachos / Pedidos</h1>
              <button onClick={() => abrir('nuevo')}
                className="hidden md:flex items-center gap-2 bg-[#A8552E] text-white font-semibold px-4 py-2 rounded-lg hover:bg-[#8B4423] transition-colors">
                <Plus className="w-4 h-4" /> Nuevo
              </button>
            </div>
          </header>

          <div className="md:hidden fixed bottom-6 right-4 z-40">
            <button onClick={() => abrir('nuevo')} className="bg-[#A8552E] text-white rounded-full p-3 shadow-lg hover:bg-[#8B4423]" title="Nuevo pedido">
              <Plus className="w-6 h-6" />
            </button>
          </div>

          <DashboardPedidos />

          {accionError && (
            <div className="bg-[#FCE4E4] border border-[#E4B0B0] text-[#A32D2D] text-sm px-4 py-3 rounded-lg">{errorMessage(accionError)}</div>
          )}

          {pendientes.isLoading ? (
            <div className="flex justify-center items-center py-12">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#A8552E]"></div>
            </div>
          ) : pendientes.error ? (
            <div className="bg-[#FCE4E4] border border-[#E4B0B0] text-[#A32D2D] text-sm px-4 py-3 rounded-lg flex items-center justify-between">
              <span>{errorMessage(pendientes.error)}</span>
              <button onClick={() => pendientes.refetch()} className="underline">Reintentar</button>
            </div>
          ) : (
            <div className="border-t-2 border-[#D8CDB0] pt-6">
              <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide mb-3">
                Pendientes de reparto — {(pendientes.data ?? []).length}
              </p>
              {(pendientes.data ?? []).length === 0 ? (
                <div className="border border-dashed border-[#D8CDB0] rounded-xl py-6 px-4 text-center">
                  <Package className="w-6 h-6 text-[#B3A484] mx-auto mb-2" />
                  <p className="text-sm text-[#8A7A5C]">No hay pedidos pendientes.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {(pendientes.data ?? []).map((p) => (
                    <div key={p.id} className="bg-white rounded-lg border border-[#E4DCC8] p-3 shadow-sm">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold text-[#2C2419] text-sm">#{refPedido(p)} · {p.cliente_nombre}</p>
                          {p.lineas.length > 0 && (
                            <p className="text-xs text-[#8A7A5C] mt-1">{p.lineas.map((l) => `${l.cantidad} ${l.producto_nombre}`).join(', ')}</p>
                          )}
                          <p className="text-xs text-[#A89878] mt-1">Cargado: {formatearFechaLocal(p.created_at)}</p>
                        </div>
                        <div className="shrink-0 flex items-center gap-2">
                          <span className="text-sm font-bold text-[#A8552E]">{formatoPesos(orderTotal(p))}</span>
                          <button onClick={() => m.deliver.mutate(p.id)} disabled={m.deliver.isPending}
                            className="flex items-center justify-center gap-1 bg-[#3B6D11] disabled:bg-[#B0C85E] text-white text-xs font-semibold px-2 py-1.5 rounded">
                            <Check className="w-3 h-3" /> Entregar
                          </button>
                          <button onClick={() => abrir('editar', p)} aria-label="Editar pedido"
                            className="w-8 h-8 flex items-center justify-center bg-[#A8552E] rounded text-white hover:bg-[#8B4423]">
                            <Pencil className="w-3 h-3" />
                          </button>
                          <button onClick={() => cancelar(p)} disabled={m.cancel.isPending} aria-label="Cancelar pedido"
                            className="w-8 h-8 flex items-center justify-center bg-[#A8552E] rounded text-white hover:bg-[#8B4423]">
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="border-t-2 border-[#D8CDB0] pt-6 space-y-3">
            <h3 className="text-sm font-bold text-amber-900 uppercase tracking-wide">Histórico de entregas</h3>
            {entregados.error ? (
              <div className="text-sm text-[#A32D2D]">{errorMessage(entregados.error)}</div>
            ) : (
              <div className="bg-white rounded-lg border border-amber-200 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-amber-50 border-b border-amber-200">
                    <tr>
                      <th className="px-4 py-2 text-left font-semibold text-amber-900">Pedido</th>
                      <th className="px-4 py-2 text-left font-semibold text-amber-900">Cliente</th>
                      <th className="hidden lg:table-cell px-4 py-2 text-left font-semibold text-amber-900">Contenido</th>
                      <th className="px-4 py-2 text-right font-semibold text-amber-900">Monto</th>
                      <th className="hidden lg:table-cell px-4 py-2 text-left font-semibold text-amber-900">Fecha entrega</th>
                      <th className="px-4 py-2 text-center font-semibold text-amber-900">Acción</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paginados.length === 0 ? (
                      <tr><td colSpan={6} className="px-4 py-4 text-center text-gray-500">Sin entregas</td></tr>
                    ) : paginados.map((p) => (
                      <tr key={p.id} className="border-b border-amber-100 hover:bg-amber-50">
                        <td className="px-4 py-2 text-gray-700 font-medium">
                          #{refPedido(p)}
                          {p.rectification_seq > 0 && (
                            <span className="ml-1.5 text-[10px] font-bold uppercase bg-[#FCE4E4] text-[#A32D2D] px-1.5 py-0.5 rounded-full">Rectificado</span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-gray-700 font-medium">{p.cliente_nombre}</td>
                        <td className="hidden lg:table-cell px-4 py-2 text-gray-700 text-xs">
                          {p.lineas.map((l) => `${l.producto_nombre}: ${l.cantidad}`).join(' | ') || '—'}
                        </td>
                        <td className="px-4 py-2 text-right font-semibold text-amber-900">{formatoPesos(orderTotal(p))}</td>
                        <td className="hidden lg:table-cell px-4 py-2 text-gray-700">{p.delivered_date ? formatearFechaLocal(p.delivered_date) : '—'}</td>
                        <td className="px-4 py-2 text-center">
                          <button onClick={() => abrir('rectificar', p)} className="text-amber-600 hover:text-amber-900 inline-flex items-center gap-1" title="Rectificar">
                            <Pencil className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {totalPaginas > 1 && (
              <div className="flex items-center justify-center gap-2 text-sm">
                <button onClick={() => setPagina(Math.max(0, pagina - 1))} disabled={pagina === 0} className="px-2 py-1 border border-amber-200 rounded disabled:opacity-50">←</button>
                <span>{pagina + 1} / {totalPaginas}</span>
                <button onClick={() => setPagina(Math.min(totalPaginas - 1, pagina + 1))} disabled={pagina === totalPaginas - 1}
                  className="px-2 py-1 border border-amber-200 rounded disabled:opacity-50">→</button>
              </div>
            )}
          </div>
        </div>

        {vista !== 'lista' && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-[#FAF6EE] rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
              <div className="sticky top-0 flex items-center justify-between px-6 py-4 border-b border-[#E4DCC8] bg-[#FAF6EE]">
                <h2 className="text-lg font-bold text-[#2C2419]">
                  {vista === 'nuevo' ? 'Nuevo pedido' : vista === 'editar' ? `Editar pedido #${refPedido(pedidoSel!)}` : `Rectificar pedido entregado #${refPedido(pedidoSel!)}`}
                </h2>
                <button onClick={() => setVista('lista')} className="text-[#8A7A5C] hover:text-[#2C2419]"><X className="w-6 h-6" /></button>
              </div>
              <div className="px-6 py-6">
                <FormPedido modo={vista} pedido={pedidoSel} onDone={() => setVista('lista')} />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
