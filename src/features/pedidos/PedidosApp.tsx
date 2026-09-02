import { useState } from 'react';
import { Plus, Check, Pencil, X, Package, ChevronLeft, ChevronRight } from 'lucide-react';
import { usePedidos, useCrearPedido, useRectificarPedido, useCancelarPedido, useMarcarEntregado } from '../../hooks/usePedidos';
import { useClientes } from '../../hooks/useClientes';
import { useAuth } from '../../auth/useAuth';
import { FormPedido } from './FormPedido';
import { DashboardPedidos } from './DashboardPedidos';
import { lineasGenericasVacias, formatoPedidoId, formatoPesos } from './helpers';
import { getTodayDate, formatearFechaLocal } from '../../utils/dateUtils';
import type { LineaPedido, Pedido } from '../../types/domain';

type Vista = 'lista' | 'nuevo' | 'rectificar' | 'dashboard';

export function PedidosApp() {
  const { rol } = useAuth();
  const [vista, setVista] = useState<Vista>('lista');
  const [pedidoEnEdicion, setPedidoEnEdicion] = useState<Pedido | null>(null);

  const [clienteSel, setClienteSel] = useState('');
  const [clienteSelNombre, setClienteSelNombre] = useState('');
  const [clienteNuevo, setClienteNuevo] = useState('');
  const [lineas, setLineas] = useState<LineaPedido[]>(lineasGenericasVacias());
  const [fechaPedido, setFechaPedido] = useState(getTodayDate());
  const [observaciones, setObservaciones] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [paginaHistorico, setPaginaHistorico] = useState(0);

  const ITEMS_POR_PAGINA = 15;
  const pedidosQuery = usePedidos();
  const clientesQuery = useClientes();

  const crearPedidoMutation = useCrearPedido();
  const rectificarPedidoMutation = useRectificarPedido();
  const cancelarPedidoMutation = useCancelarPedido();
  const marcarEntregadoMutation = useMarcarEntregado();

  function abrirNuevo() {
    setClienteSel('');
    setClienteSelNombre('');
    setClienteNuevo('');
    setLineas(lineasGenericasVacias());
    setFechaPedido(getTodayDate());
    setObservaciones('');
    setPedidoEnEdicion(null);
    setFormError(null);
    setVista('nuevo');
  }

  function abrirRectificar(pedido: Pedido) {
    setClienteSel(pedido.cliente_id);
    setClienteSelNombre(pedido.cliente_nombre);
    // Support both old and new structure
    if (Array.isArray(pedido.lineas)) {
      setLineas([...(pedido.lineas as LineaPedido[])]);
    } else {
      setLineas(lineasGenericasVacias());
    }
    setFechaPedido(pedido.fecha_operacion || pedido.fecha_pedido || getTodayDate());
    setObservaciones(pedido.observaciones || '');
    setPedidoEnEdicion(pedido);
    setFormError(null);
    setVista('rectificar');
  }

  async function guardarPedido() {
    setFormError(null);
    try {
      let nombreCliente = '';
      if (clienteSelNombre) {
        nombreCliente = clienteSelNombre;
      } else if (clienteNuevo.trim()) {
        nombreCliente = clienteNuevo.trim();
      }

      if (!nombreCliente) {
        setFormError('Selecciona o ingresa un cliente');
        return;
      }

      const totalUnidades = lineas.reduce((acc, l) => acc + l.cantidad, 0);
      if (totalUnidades === 0) {
        setFormError('Agrega al menos un producto');
        return;
      }

      if (vista === 'rectificar' && pedidoEnEdicion) {
        await rectificarPedidoMutation.mutateAsync({
          id: pedidoEnEdicion.id,
          lineas,
          fechaPedido,
          clienteId: clienteSel,
          clienteNombre: nombreCliente,
          observaciones: observaciones || undefined,
        });
      } else {
        const clienteId = clienteSel;

        if (!clienteId) {
          setFormError('Debes seleccionar un cliente de la lista');
          return;
        }

        await crearPedidoMutation.mutateAsync({
          clienteId,
          clienteNombre: nombreCliente,
          lineas,
          fechaPedido,
          observaciones: observaciones || undefined,
        });
      }

      setVista('lista');
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Error al guardar');
    }
  }

  async function marcarEntregado(id: number) {
    try {
      await marcarEntregadoMutation.mutateAsync(id);
    } catch (error) {
      console.error('Error al marcar entregado:', error);
    }
  }

  async function cancelarPedido(id: number) {
    try {
      await cancelarPedidoMutation.mutateAsync(id);
    } catch (error) {
      console.error('Error al cancelar pedido:', error);
    }
  }

  const pedidos = pedidosQuery.data || [];
  const pendientes = pedidos.filter((p) => p.estado === 'pendiente');

  const clientes = clientesQuery.data || [];

  if (rol !== 'dueño') {
    return (
      <div className="min-h-screen bg-stone-100 flex items-center justify-center">
        <div className="bg-white p-8 rounded-lg text-center max-w-sm mx-4">
          <p className="text-lg font-semibold text-gray-800">Acceso restringido</p>
          <p className="text-gray-600 mt-2">Solo el dueño puede gestionar pedidos.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-stone-100 flex justify-center relative">
      <div className="w-full max-w-7xl bg-[#FAF6EE] min-h-screen flex flex-col relative">
        {/* Vista única: Dashboard + Pedidos Pendientes + Histórico */}
        <div className="flex-1 min-h-screen overflow-y-auto overflow-x-hidden px-4 md:px-6 py-6 space-y-8 relative">
          {/* Header */}
          <header className="border-b border-[#E4DCC8] pb-4">
            <p className="text-xs font-semibold tracking-wide text-[#A8552E] uppercase">
              Granja Santo Tomás
            </p>
            <div className="flex items-center justify-between mt-2">
              <h1 className="text-2xl font-bold text-[#2C2419]">Despachos / Pedidos</h1>
              {rol === 'dueño' && (
                <button
                  onClick={abrirNuevo}
                  className="hidden md:flex items-center gap-2 bg-[#A8552E] text-white font-semibold px-4 py-2 rounded-lg hover:bg-[#8B4423] transition-colors"
                >
                  <Plus className="w-4 h-4" /> Nuevo
                </button>
              )}
            </div>
          </header>

          {/* Botón flotante para mobile */}
          {rol === 'dueño' && (
            <div className="md:hidden fixed bottom-6 right-4 z-40">
              <button
                onClick={abrirNuevo}
                className="bg-[#A8552E] text-white rounded-full p-3 shadow-lg hover:bg-[#8B4423] transition-colors"
                title="Nuevo pedido"
              >
                <Plus className="w-6 h-6" />
              </button>
            </div>
          )}

          {/* Dashboard */}
          {!pedidosQuery.isLoading && !pedidosQuery.error && (
            <div className="space-y-4">
              <DashboardPedidos
                pedidos={pedidos}
                onEditar={abrirRectificar}
              />
            </div>
          )}

          {/* Pedidos Pendientes (compacto) */}
          {pedidosQuery.isLoading ? (
            <div className="flex justify-center items-center py-12">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#A8552E]"></div>
            </div>
          ) : pedidosQuery.error ? (
            <div className="bg-[#FCE4E4] border border-[#E4B0B0] text-[#A32D2D] text-sm px-4 py-3 rounded-lg flex items-center justify-between">
              <span>No se pudieron cargar los pedidos</span>
              <button
                onClick={() => pedidosQuery.refetch()}
                className="underline text-[#A32D2D] hover:font-semibold"
              >
                Reintentar
              </button>
            </div>
          ) : (
            <>
              {/* Divider */}
              <div className="border-t-2 border-[#D8CDB0] pt-6"></div>

              <div>
                <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide mb-3">
                  Pendientes de reparto — {pendientes.length}
                </p>
                {pendientes.length === 0 ? (
                  <div className="border border-dashed border-[#D8CDB0] rounded-xl py-6 px-4 text-center">
                    <Package className="w-6 h-6 text-[#B3A484] mx-auto mb-2" />
                    <p className="text-sm text-[#8A7A5C]">
                      No hay pedidos cargados todavía.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {pendientes.map((p) => (
                      <div key={p.id} className="bg-white rounded-lg border border-[#E4DCC8] p-3 shadow-sm">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <p className="font-semibold text-[#2C2419] text-sm">
                              #{formatoPedidoId(p.id)} · {p.cliente_nombre}
                            </p>
                            {Array.isArray(p.lineas) && p.lineas.length > 0 && (
                              <p className="text-xs text-[#8A7A5C] mt-1">
                                {p.lineas.map((l) => `${l.cantidad} ${l.producto_nombre}`).join(', ')}
                              </p>
                            )}
                            {p.creado_por_nombre && (
                              <p className="text-xs text-[#A89878] mt-1">
                                Cargado por: <span className="font-medium">{p.creado_por_nombre}</span> · {new Date((p.fecha_operacion || p.fecha_pedido) + 'T00:00:00').toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' })}
                              </p>
                            )}
                          </div>
                          <div className="shrink-0 flex items-center gap-2">
                            <span className="text-sm font-bold text-[#A8552E]">{formatoPesos(p.monto_total)}</span>
                            {rol === 'dueño' || rol === 'repartidor' ? (
                              <button
                                onClick={() => marcarEntregado(p.id)}
                                disabled={marcarEntregadoMutation.isPending}
                                className="flex items-center justify-center gap-1 bg-[#3B6D11] disabled:bg-[#B0C85E] text-white text-xs font-semibold px-2 py-1.5 rounded transition-colors"
                              >
                                <Check className="w-3 h-3" /> Entregar
                              </button>
                            ) : null}
                            {rol === 'dueño' ? (
                              <>
                                <button
                                  onClick={() => abrirRectificar(p)}
                                  className="w-8 h-8 flex items-center justify-center bg-[#A8552E] rounded text-white transition-colors hover:bg-[#8B4423]"
                                >
                                  <Pencil className="w-3 h-3" />
                                </button>
                                <button
                                  onClick={() => cancelarPedido(p.id)}
                                  className="w-8 h-8 flex items-center justify-center bg-[#A8552E] rounded text-white transition-colors hover:bg-[#8B4423]"
                                >
                                  <X className="w-3 h-3" />
                                </button>
                              </>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Divider */}
              <div className="border-t-2 border-[#D8CDB0] py-6"></div>

              {/* Histórico */}
              <div className="space-y-3">
                <h3 className="text-sm font-bold text-amber-900 uppercase tracking-wide">Histórico</h3>
                <div className="bg-white rounded-lg border border-amber-200 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-amber-50 border-b border-amber-200">
                      <tr>
                        <th className="px-4 py-2 text-left font-semibold text-amber-900">Pedido</th>
                        <th className="hidden md:table-cell px-4 py-2 text-left font-semibold text-amber-900">Tipo</th>
                        <th className="px-4 py-2 text-left font-semibold text-amber-900">Cliente</th>
                        <th className="hidden lg:table-cell px-4 py-2 text-left font-semibold text-amber-900">Contenido</th>
                        <th className="px-4 py-2 text-right font-semibold text-amber-900">Monto</th>
                        <th className="hidden xl:table-cell px-4 py-2 text-left font-semibold text-amber-900">Fecha carga</th>
                        <th className="hidden 2xl:table-cell px-4 py-2 text-left font-semibold text-amber-900">Entregado por</th>
                        <th className="hidden lg:table-cell px-4 py-2 text-left font-semibold text-amber-900">Fecha entrega</th>
                        {rol === 'dueño' && <th className="px-4 py-2 text-center font-semibold text-amber-900">Acción</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {(() => {
                        const pedidosEntregados = pedidos
                          .filter((p) => p.estado === 'entregado')
                          .sort((a, b) => (b.fecha_operacion || '').localeCompare(a.fecha_operacion || ''));
                        const inicio = paginaHistorico * ITEMS_POR_PAGINA;
                        const paginados = pedidosEntregados.slice(inicio, inicio + ITEMS_POR_PAGINA);

                        return paginados.map((p) => {
                          const cliente = clientes.find((c) => c.id === p.cliente_id);
                          return (
                            <tr key={p.id} className="border-b border-amber-100 hover:bg-amber-50">
                              <td className="px-4 py-2 text-gray-700 font-medium">#{p.id}</td>
                              <td className="hidden md:table-cell px-4 py-2 text-gray-700 text-xs">{cliente?.categoria || '—'}</td>
                              <td className="px-4 py-2 text-gray-700 font-medium">{p.cliente_nombre}</td>
                              <td className="hidden lg:table-cell px-4 py-2 text-gray-700 text-xs">
                                {Array.isArray(p.lineas) && p.lineas.length > 0
                                  ? p.lineas
                                      .filter((l) => l.cantidad > 0)
                                      .map((l) => `${l.producto_nombre}: ${l.cantidad}`)
                                      .join(' | ')
                                  : '—'}
                              </td>
                              <td className="px-4 py-2 text-right font-semibold text-amber-900">
                                ${p.monto_total.toLocaleString('es-AR')}
                              </td>
                              <td className="hidden xl:table-cell px-4 py-2 text-gray-700">
                                {p.fecha_operacion ? formatearFechaLocal(p.fecha_operacion) : '—'}
                              </td>
                              <td className="hidden 2xl:table-cell px-4 py-2 text-gray-700 text-xs">
                                {p.entregado_por_nombre || '—'}
                              </td>
                              <td className="hidden lg:table-cell px-4 py-2 text-gray-700">
                                {p.entregado_en ? formatearFechaLocal(p.entregado_en) : '—'}
                              </td>
                              {rol === 'dueño' && (
                                <td className="px-4 py-2 text-center">
                                  <button
                                    onClick={() => abrirRectificar(p)}
                                    className="text-amber-600 hover:text-amber-900 inline-flex items-center gap-1"
                                    title="Editar"
                                  >
                                    <Pencil className="w-4 h-4" />
                                  </button>
                                </td>
                              )}
                            </tr>
                          );
                        });
                      })()}
                    </tbody>
                  </table>
                </div>

                {/* Paginación */}
                {(() => {
                  const totalEntregados = pedidos.filter((p) => p.estado === 'entregado').length;
                  const totalPaginas = Math.ceil(totalEntregados / ITEMS_POR_PAGINA);

                  return totalPaginas > 1 ? (
                    <div className="flex items-center justify-center gap-1 text-sm flex-wrap">
                      <button
                        onClick={() => setPaginaHistorico(Math.max(0, paginaHistorico - 1))}
                        disabled={paginaHistorico === 0}
                        className="px-2 py-1 border border-amber-200 rounded text-sm disabled:opacity-50 hover:bg-amber-50"
                      >
                        ←
                      </button>

                      {paginaHistorico > 2 && (
                        <>
                          <button
                            onClick={() => setPaginaHistorico(0)}
                            className="px-2 py-1 border border-amber-200 rounded text-sm hover:bg-amber-50"
                          >
                            1
                          </button>
                          {paginaHistorico > 3 && <span className="px-1 text-gray-500">…</span>}
                        </>
                      )}

                      {paginaHistorico > 0 && (
                        <button
                          onClick={() => setPaginaHistorico(paginaHistorico - 1)}
                          className="px-2 py-1 border border-amber-200 rounded text-sm hover:bg-amber-50"
                        >
                          {paginaHistorico}
                        </button>
                      )}

                      <button
                        onClick={() => setPaginaHistorico(paginaHistorico)}
                        className="px-2 py-1 bg-amber-900 text-white rounded text-sm"
                      >
                        {paginaHistorico + 1}
                      </button>

                      {paginaHistorico < totalPaginas - 1 && (
                        <button
                          onClick={() => setPaginaHistorico(paginaHistorico + 1)}
                          className="px-2 py-1 border border-amber-200 rounded text-sm hover:bg-amber-50"
                        >
                          {paginaHistorico + 2}
                        </button>
                      )}

                      {paginaHistorico < totalPaginas - 3 && (
                        <>
                          {paginaHistorico < totalPaginas - 4 && <span className="px-1 text-gray-500">…</span>}
                          <button
                            onClick={() => setPaginaHistorico(totalPaginas - 1)}
                            className="px-2 py-1 border border-amber-200 rounded text-sm hover:bg-amber-50"
                          >
                            {totalPaginas}
                          </button>
                        </>
                      )}

                      <button
                        onClick={() => setPaginaHistorico(Math.min(totalPaginas - 1, paginaHistorico + 1))}
                        disabled={paginaHistorico === totalPaginas - 1}
                        className="px-2 py-1 border border-amber-200 rounded text-sm disabled:opacity-50 hover:bg-amber-50"
                      >
                        →
                      </button>
                    </div>
                  ) : null;
                })()}
              </div>
            </>
          )}
        </div>

        {/* Modal centrado - único */}
        {(vista === 'nuevo' || vista === 'rectificar') && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-[#FAF6EE] rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
              {/* Header del modal */}
              <div className="sticky top-0 flex items-center justify-between px-6 py-4 border-b border-[#E4DCC8] bg-[#FAF6EE]">
                <h2 className="text-lg font-bold text-[#2C2419]">
                  {vista === 'nuevo' ? 'Nuevo Pedido' : 'Rectificar Pedido'}
                </h2>
                <button
                  onClick={() => setVista('lista')}
                  className="text-[#8A7A5C] hover:text-[#2C2419]"
                >
                  <X className="w-6 h-6" />
                </button>
              </div>

              {/* Contenido del modal */}
              <div className="px-6 py-6">
                <FormPedido
                  modo={vista as 'nuevo' | 'rectificar'}
                  clientes={clientes}
                  clienteSel={clienteSel}
                  setClienteSel={(id) => {
                    setClienteSel(id);
                    if (id) {
                      const cliente = clientes.find((c) => c.id === id);
                      setClienteSelNombre(cliente?.nombre || '');
                      setClienteNuevo('');
                    }
                  }}
                  clienteNuevo={clienteNuevo}
                  setClienteNuevo={(nombre) => {
                    setClienteNuevo(nombre);
                    if (nombre.trim()) {
                      setClienteSel('');
                      setClienteSelNombre('');
                    }
                  }}
                  lineas={lineas}
                  setLineas={setLineas}
                  fechaPedido={fechaPedido}
                  setFechaPedido={setFechaPedido}
                  observaciones={observaciones}
                  setObservaciones={setObservaciones}
                  onGuardar={guardarPedido}
                  onVolver={() => setVista('lista')}
                  error={formError}
                  rol={rol}
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
