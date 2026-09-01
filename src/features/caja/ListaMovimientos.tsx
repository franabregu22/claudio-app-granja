import { useState, useMemo, useEffect } from 'react';
import { Trash2, X, Edit2, Filter, ChevronUp, ChevronDown } from 'lucide-react';
import { useActualizarMovimientoCaja } from '../../hooks/useCaja';
import type { MovimientoCaja } from '../../types/domain';
import { formatoPesos } from '../pedidos/helpers';
import { ModalEditarCategoria } from './ModalEditarCategoria';

interface ListaMovimientosProps {
  movimientos: MovimientoCaja[];
  onAnular?: (id: number, motivo?: string) => Promise<void>;
}

type SortColumn = 'fecha_operacion' | 'fecha_pago' | 'tipo' | 'forma_pago' | 'concepto' | 'monto' | 'movimiento_estado' | null;
type SortDir = 'asc' | 'desc';

interface Filtros {
  fechaOpDesde?: string;
  fechaOpHasta?: string;
  fechaPagoDesde?: string;
  fechaPagoHasta?: string;
  tipo?: string;
  medio?: string;
  nombre?: string;
  estado?: string;
  monto?: { min?: number; max?: number };
}

export function ListaMovimientos({ movimientos, onAnular }: ListaMovimientosProps) {
  const [anularId, setAnularId] = useState<number | null>(null);
  const [motivo, setMotivo] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [movimientoEnEdicion, setMovimientoEnEdicion] = useState<MovimientoCaja | null>(null);
  const [confirmarPagoId, setConfirmarPagoId] = useState<number | null>(null);
  const [fechaPagoConfirmar, setFechaPagoConfirmar] = useState('');
  const [isLoadingConfirmar, setIsLoadingConfirmar] = useState(false);

  const [filtros, setFiltros] = useState<Filtros>({});
  const [sortColumn, setSortColumn] = useState<SortColumn>(null);
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [filterOpen, setFilterOpen] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const ITEMS_PER_PAGE = 10;

  const actualizarMutation = useActualizarMovimientoCaja();

  useEffect(() => {
    setCurrentPage(1);
  }, [filtros, sortColumn, sortDir]);

  const handleConfirmarPago = async () => {
    if (!confirmarPagoId || !fechaPagoConfirmar) return;
    setIsLoadingConfirmar(true);
    try {
      await actualizarMutation.mutateAsync({
        id: confirmarPagoId,
        movimiento: {
          movimiento_estado: 'confirmado',
          fecha_pago: fechaPagoConfirmar,
        },
      });
      setConfirmarPagoId(null);
      setFechaPagoConfirmar('');
    } finally {
      setIsLoadingConfirmar(false);
    }
  };

  const movimientosFiltrados = useMemo(() => {
    let resultado = movimientos;

    // Aplicar filtros
    if (filtros.fechaOpDesde) {
      resultado = resultado.filter((m) => m.fecha_operacion >= filtros.fechaOpDesde!);
    }
    if (filtros.fechaOpHasta) {
      resultado = resultado.filter((m) => m.fecha_operacion <= filtros.fechaOpHasta!);
    }
    if (filtros.fechaPagoDesde) {
      resultado = resultado.filter((m) => m.fecha_pago && m.fecha_pago >= filtros.fechaPagoDesde!);
    }
    if (filtros.fechaPagoHasta) {
      resultado = resultado.filter((m) => m.fecha_pago && m.fecha_pago <= filtros.fechaPagoHasta!);
    }
    if (filtros.tipo) {
      resultado = resultado.filter((m) => m.tipo === filtros.tipo);
    }
    if (filtros.medio) {
      resultado = resultado.filter((m) => m.forma_pago === filtros.medio);
    }
    if (filtros.nombre) {
      const q = filtros.nombre.toLowerCase();
      resultado = resultado.filter((m) => m.concepto.toLowerCase().includes(q));
    }
    if (filtros.estado) {
      resultado = resultado.filter((m) => m.movimiento_estado === filtros.estado);
    }
    if (filtros.monto?.min !== undefined) {
      resultado = resultado.filter((m) => m.monto >= filtros.monto!.min!);
    }
    if (filtros.monto?.max !== undefined) {
      resultado = resultado.filter((m) => m.monto <= filtros.monto!.max!);
    }

    // Aplicar sorting
    if (sortColumn) {
      resultado = [...resultado].sort((a, b) => {
        let valA: any = a[sortColumn as keyof MovimientoCaja];
        let valB: any = b[sortColumn as keyof MovimientoCaja];

        if (valA == null) valA = sortDir === 'asc' ? Infinity : -Infinity;
        if (valB == null) valB = sortDir === 'asc' ? Infinity : -Infinity;

        if (valA < valB) return sortDir === 'asc' ? -1 : 1;
        if (valA > valB) return sortDir === 'asc' ? 1 : -1;
        return 0;
      });
    }

    return resultado;
  }, [movimientos, filtros, sortColumn, sortDir]);

  const totalPages = Math.ceil(movimientosFiltrados.length / ITEMS_PER_PAGE);
  const startIdx = (currentPage - 1) * ITEMS_PER_PAGE;
  const paginatedMovimientos = movimientosFiltrados.slice(startIdx, startIdx + ITEMS_PER_PAGE);

  if (movimientos.length === 0) {
    return (
      <div className="border border-dashed border-[#D8CDB0] rounded-lg p-6 text-center">
        <p className="text-sm text-[#8A7A5C]">No hay movimientos registrados</p>
      </div>
    );
  }

  const hasFiltros = Object.values(filtros).some((v) => v !== undefined && v !== '');

  const toggleSort = (col: SortColumn) => {
    if (sortColumn === col) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(col);
      setSortDir('desc');
    }
  };

  const HeaderCell = ({ col, label }: { col: SortColumn; label: string }) => (
    <th className="px-3 py-2 text-left font-semibold text-[#2C2419] relative group">
      <div className="flex items-center gap-1">
        <span>{label}</span>
        <div className="flex gap-0.5 opacity-50 group-hover:opacity-100 transition-opacity">
          <button
            onClick={() => setFilterOpen(filterOpen === col ? null : col)}
            className="p-0.5 hover:bg-amber-100 rounded"
            title="Filtrar"
          >
            <Filter className="w-4 h-4" />
          </button>
          <button
            onClick={() => toggleSort(col)}
            className="p-0.5 hover:bg-amber-100 rounded"
            title="Ordenar"
          >
            {sortColumn === col ? (
              sortDir === 'asc' ? (
                <ChevronUp className="w-4 h-4" />
              ) : (
                <ChevronDown className="w-4 h-4" />
              )
            ) : (
              <ChevronUp className="w-4 h-4 opacity-30" />
            )}
          </button>
        </div>
      </div>
    </th>
  );

  const handleAnular = async () => {
    if (anularId && onAnular) {
      setIsLoading(true);
      try {
        await onAnular(anularId, motivo || undefined);
        setAnularId(null);
        setMotivo('');
      } finally {
        setIsLoading(false);
      }
    }
  };

  return (
    <>
      <div className="bg-white rounded-lg border border-[#E4DCC8] overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-amber-50 border-b border-[#D8CDB0]">
            <tr>
              <HeaderCell col="fecha_operacion" label="Fecha Op." />
              <HeaderCell col="fecha_pago" label="Fecha Pago" />
              <HeaderCell col="tipo" label="Tipo" />
              <HeaderCell col="forma_pago" label="Medio" />
              <HeaderCell col="concepto" label="Nombre" />
              <th className="px-3 py-2 text-left font-semibold text-[#2C2419]">Comentario</th>
              <HeaderCell col="monto" label="Monto" />
              <HeaderCell col="movimiento_estado" label="Estado" />
              <th className="px-3 py-2 text-center font-semibold text-[#2C2419]">Acción</th>
            </tr>
          </thead>
          <tbody>
            {paginatedMovimientos.map((m) => (
              <tr
                key={m.id}
                className={`border-b border-[#E4DCC8] hover:transition-colors ${
                  m.movimiento_estado === 'cancelado'
                    ? 'bg-gray-50 opacity-60 hover:bg-gray-100'
                    : m.movimiento_estado === 'pendiente'
                    ? 'bg-amber-50 hover:bg-amber-100'
                    : 'hover:bg-amber-50'
                }`}
              >
                <td className="px-3 py-2 text-[#2C2419] font-medium">{m.fecha_operacion}</td>
                <td className="px-3 py-2 text-[#2C2419] font-medium">{m.fecha_pago || '—'}</td>
                <td className="px-3 py-2">
                  <span className={`text-[10px] font-bold uppercase px-2 py-1 rounded-full whitespace-nowrap ${
                    m.tipo === 'ingreso'
                      ? 'bg-green-100 text-green-700'
                      : 'bg-red-100 text-red-700'
                  }`}>
                    {m.tipo}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <span className={`text-[10px] font-bold uppercase px-2 py-1 rounded-full whitespace-nowrap ${
                    m.forma_pago === 'efectivo' ? 'bg-yellow-100 text-yellow-700' :
                    m.forma_pago === 'mercadopago' ? 'bg-blue-100 text-blue-700' :
                    m.forma_pago === 'cheque' ? 'bg-purple-100 text-purple-700' :
                    'bg-gray-100 text-gray-700'
                  }`}>
                    {m.forma_pago}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <p className={`font-semibold truncate ${m.movimiento_estado === 'cancelado' ? 'line-through text-[#8A7A5C]' : 'text-[#2C2419]'}`}>
                    {m.concepto}
                  </p>
                  {m.tipo === 'egreso' && (
                    <button
                      onClick={() => setMovimientoEnEdicion(m)}
                      className="flex items-center gap-1 text-[9px] font-semibold uppercase px-1.5 py-0.5 rounded text-orange-700 hover:bg-orange-100 transition-colors mt-1"
                      title="Editar categoría"
                    >
                      {m.categoria_tecnica || 'Sin categoría'}
                      <Edit2 className="w-3 h-3" />
                    </button>
                  )}
                </td>
                <td className="px-3 py-2 text-[#8A7A5C] text-xs truncate max-w-xs">
                  {m.notas || (m.impuesto_cheque && m.impuesto_cheque > 0 ? `Imp: $${m.impuesto_cheque.toFixed(0)}` : '—')}
                </td>
                <td className="px-3 py-2 text-right">
                  <p className={`font-bold ${
                    m.tipo === 'ingreso' ? 'text-green-700' : 'text-red-700'
                  }`}>
                    {m.tipo === 'ingreso' ? '+' : '-'}{formatoPesos(m.monto)}
                  </p>
                </td>
                <td className="px-3 py-2 text-center">
                  {m.movimiento_estado === 'pendiente' ? (
                    <button
                      onClick={() => {
                        setConfirmarPagoId(m.id);
                        setFechaPagoConfirmar(new Date().toISOString().split('T')[0]);
                      }}
                      className="text-[10px] font-bold uppercase px-2 py-1 rounded-full whitespace-nowrap bg-amber-200 text-amber-800 hover:bg-amber-300 transition-colors"
                      title="Confirmar pago"
                    >
                      Pendiente ✓
                    </button>
                  ) : (
                    <span className="text-[10px] font-bold uppercase px-2 py-1 rounded-full whitespace-nowrap bg-green-100 text-green-700">
                      Confirmado
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-center">
                  {m.movimiento_estado === 'confirmado' && onAnular && (
                    <button
                      onClick={() => setAnularId(m.id)}
                      className="p-1.5 text-red-600 hover:bg-red-50 rounded transition-colors inline-block"
                      title="Anular movimiento"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Paginación Responsive */}
      {totalPages > 1 && (
        <div className="mt-3 flex flex-col sm:flex-row items-center justify-between gap-3 text-sm">
          <p className="text-[#8A7A5C] text-xs">
            Página {currentPage} de {totalPages} ({movimientosFiltrados.length})
          </p>
          <div className="flex gap-1 flex-wrap justify-center">
            <button
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              className="px-2 py-1 border border-[#D8CDB0] rounded text-sm disabled:opacity-50 hover:bg-[#F5EFE6]"
            >
              ←
            </button>

            {/* Páginas cercanas a la actual */}
            {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => {
              const isVisible = p === 1 || p === totalPages || Math.abs(p - currentPage) <= 1;
              const showDotsBefore = p === 2 && currentPage > 3;
              const showDotsAfter = p === totalPages - 1 && currentPage < totalPages - 2;

              return (
                <div key={p}>
                  {showDotsBefore && <span className="px-1 text-[#8A7A5C]">...</span>}
                  {isVisible && (
                    <button
                      onClick={() => setCurrentPage(p)}
                      className={`px-2 py-1 rounded text-sm ${
                        currentPage === p
                          ? 'bg-[#A8552E] text-white'
                          : 'border border-[#D8CDB0] hover:bg-[#F5EFE6]'
                      }`}
                    >
                      {p}
                    </button>
                  )}
                  {showDotsAfter && <span className="px-1 text-[#8A7A5C]">...</span>}
                </div>
              );
            })}

            <button
              onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
              className="px-2 py-1 border border-[#D8CDB0] rounded text-sm disabled:opacity-50 hover:bg-[#F5EFE6]"
            >
              →
            </button>
          </div>
        </div>
      )}

      {/* Modal de edición de categoría */}
      {movimientoEnEdicion && (
        <ModalEditarCategoria
          movimiento={movimientoEnEdicion}
          onClose={() => setMovimientoEnEdicion(null)}
          onGuardar={() => {
            setMovimientoEnEdicion(null);
          }}
        />
      )}

      {/* Modal de filtro */}
      {filterOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg max-w-md w-full p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold text-[#2C2419]">Filtrar por {filterOpen === 'fecha_operacion' ? 'Fecha Op.' : filterOpen === 'fecha_pago' ? 'Fecha Pago' : filterOpen === 'tipo' ? 'Tipo' : filterOpen === 'forma_pago' ? 'Medio' : filterOpen === 'concepto' ? 'Nombre' : filterOpen === 'monto' ? 'Monto' : 'Estado'}</h3>
              <button onClick={() => setFilterOpen(null)} className="text-[#8A7A5C] hover:text-[#2C2419]"><X className="w-4 h-4" /></button>
            </div>

            {filterOpen === 'fecha_operacion' && (
              <div className="space-y-2">
                <div>
                  <label className="text-xs font-medium text-[#6B5D45]">Desde</label>
                  <input type="date" value={filtros.fechaOpDesde || ''} onChange={(e) => setFiltros({...filtros, fechaOpDesde: e.target.value})} className="w-full border border-[#D8CDB0] rounded px-2 py-1 text-sm" />
                </div>
                <div>
                  <label className="text-xs font-medium text-[#6B5D45]">Hasta</label>
                  <input type="date" value={filtros.fechaOpHasta || ''} onChange={(e) => setFiltros({...filtros, fechaOpHasta: e.target.value})} className="w-full border border-[#D8CDB0] rounded px-2 py-1 text-sm" />
                </div>
              </div>
            )}

            {filterOpen === 'fecha_pago' && (
              <div className="space-y-2">
                <div>
                  <label className="text-xs font-medium text-[#6B5D45]">Desde</label>
                  <input type="date" value={filtros.fechaPagoDesde || ''} onChange={(e) => setFiltros({...filtros, fechaPagoDesde: e.target.value})} className="w-full border border-[#D8CDB0] rounded px-2 py-1 text-sm" />
                </div>
                <div>
                  <label className="text-xs font-medium text-[#6B5D45]">Hasta</label>
                  <input type="date" value={filtros.fechaPagoHasta || ''} onChange={(e) => setFiltros({...filtros, fechaPagoHasta: e.target.value})} className="w-full border border-[#D8CDB0] rounded px-2 py-1 text-sm" />
                </div>
              </div>
            )}

            {filterOpen === 'tipo' && (
              <div className="space-y-2">
                {['ingreso', 'egreso'].map((t) => (
                  <label key={t} className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" name="tipo" value={t} checked={filtros.tipo === t} onChange={(e) => setFiltros({...filtros, tipo: e.target.checked ? t : undefined})} />
                    <span className="text-sm capitalize">{t}</span>
                  </label>
                ))}
                <button onClick={() => setFiltros({...filtros, tipo: undefined})} className="text-xs text-[#A8552E] hover:underline">Limpiar</button>
              </div>
            )}

            {filterOpen === 'forma_pago' && (
              <div className="space-y-2">
                {['efectivo', 'mercadopago', 'transferencia', 'cheque', 'echeq'].map((m) => (
                  <label key={m} className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" name="medio" value={m} checked={filtros.medio === m} onChange={(e) => setFiltros({...filtros, medio: e.target.checked ? m : undefined})} />
                    <span className="text-sm capitalize">{m}</span>
                  </label>
                ))}
                <button onClick={() => setFiltros({...filtros, medio: undefined})} className="text-xs text-[#A8552E] hover:underline">Limpiar</button>
              </div>
            )}

            {filterOpen === 'concepto' && (
              <div className="space-y-2">
                <input type="text" placeholder="Buscar..." value={filtros.nombre || ''} onChange={(e) => setFiltros({...filtros, nombre: e.target.value})} className="w-full border border-[#D8CDB0] rounded px-2 py-1 text-sm" />
              </div>
            )}

            {filterOpen === 'monto' && (
              <div className="space-y-2">
                <div>
                  <label className="text-xs font-medium text-[#6B5D45]">Mín</label>
                  <input type="number" placeholder="0" value={filtros.monto?.min || ''} onChange={(e) => setFiltros({...filtros, monto: {...filtros.monto, min: e.target.value ? parseFloat(e.target.value) : undefined}})} className="w-full border border-[#D8CDB0] rounded px-2 py-1 text-sm" />
                </div>
                <div>
                  <label className="text-xs font-medium text-[#6B5D45]">Máx</label>
                  <input type="number" placeholder="999999" value={filtros.monto?.max || ''} onChange={(e) => setFiltros({...filtros, monto: {...filtros.monto, max: e.target.value ? parseFloat(e.target.value) : undefined}})} className="w-full border border-[#D8CDB0] rounded px-2 py-1 text-sm" />
                </div>
              </div>
            )}

            {filterOpen === 'movimiento_estado' && (
              <div className="space-y-2">
                {['pendiente', 'confirmado', 'cancelado'].map((e) => (
                  <label key={e} className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" name="estado" value={e} checked={filtros.estado === e} onChange={(ev) => setFiltros({...filtros, estado: ev.target.checked ? e : undefined})} />
                    <span className="text-sm capitalize">{e}</span>
                  </label>
                ))}
                <button onClick={() => setFiltros({...filtros, estado: undefined})} className="text-xs text-[#A8552E] hover:underline">Limpiar</button>
              </div>
            )}

            <div className="flex gap-2 mt-4">
              <button onClick={() => setFilterOpen(null)} className="flex-1 px-3 py-1.5 border border-[#D8CDB0] rounded text-sm font-medium hover:bg-[#F5EFE6]">Cerrar</button>
              {hasFiltros && <button onClick={() => { setFiltros({}); setFilterOpen(null); }} className="flex-1 px-3 py-1.5 bg-amber-100 text-amber-800 rounded text-sm font-medium hover:bg-amber-200">Limpiar todo</button>}
            </div>
          </div>
        </div>
      )}

      {/* Modal de anulación */}
      {anularId && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg max-w-sm w-full p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-[#2C2419]">Anular movimiento</h3>
              <button
                onClick={() => setAnularId(null)}
                className="text-[#8A7A5C] hover:text-[#2C2419]"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="text-sm text-[#8A7A5C] mb-4">
              ¿Estás seguro de que querés anular este movimiento? Quedará registrado como cancelado para auditoría.
            </p>

            <div className="mb-4">
              <label className="block text-sm font-medium text-[#6B5D45] mb-1">
                Motivo (opcional)
              </label>
              <textarea
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                placeholder="Ej: Error al cargar, prueba, etc."
                className="w-full border border-[#D8CDB0] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#A8552E]"
                rows={2}
              />
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => setAnularId(null)}
                className="flex-1 px-4 py-2 border border-[#D8CDB0] rounded-lg text-[#2C2419] font-medium hover:bg-[#F5EFE6]"
              >
                Cancelar
              </button>
              <button
                onClick={handleAnular}
                disabled={isLoading}
                className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg font-medium hover:bg-red-700 disabled:opacity-50"
              >
                {isLoading ? 'Anulando...' : 'Anular'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal de confirmación de pago */}
      {confirmarPagoId && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg max-w-sm w-full p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-[#2C2419]">Confirmar pago</h3>
              <button
                onClick={() => setConfirmarPagoId(null)}
                className="text-[#8A7A5C] hover:text-[#2C2419]"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="text-sm text-[#8A7A5C] mb-4">
              ¿En qué fecha pagaste este movimiento?
            </p>

            <div className="mb-4">
              <label className="block text-sm font-medium text-[#6B5D45] mb-1">
                Fecha de pago
              </label>
              <input
                type="date"
                value={fechaPagoConfirmar}
                onChange={(e) => setFechaPagoConfirmar(e.target.value)}
                className="w-full border border-[#D8CDB0] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#A8552E]"
              />
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => setConfirmarPagoId(null)}
                className="flex-1 px-4 py-2 border border-[#D8CDB0] rounded-lg text-[#2C2419] font-medium hover:bg-[#F5EFE6]"
              >
                Cancelar
              </button>
              <button
                onClick={handleConfirmarPago}
                disabled={isLoadingConfirmar || !fechaPagoConfirmar}
                className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700 disabled:opacity-50"
              >
                {isLoadingConfirmar ? 'Confirmando...' : 'Confirmar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
