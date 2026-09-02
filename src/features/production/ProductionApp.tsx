import { useState } from 'react';
import { Plus, X, Edit2, ChevronLeft, ChevronRight } from 'lucide-react';
import { useProducciones, useCrearProduccion, useActualizarProduccion } from '../../hooks/useProducciones';
import { useLotes } from '../../hooks/useLotes';
import { useRecuentos } from '../../hooks/useRecuentos';
import { FormProduccion } from './FormProduccion';
import {
  encontrarLotePorGalponYFecha,
  calcularAvesActualesParaRegistro,
  calcularPosturaPorcentajeDelRegistro,
} from './produccionCalculos';

const GALPONES = ['Galpón 1', 'Galpón 2', 'Galpón 3', 'Galpón 4'];
const ITEMS_POR_PAGINA = 12;

function formatearFecha(fecha: string): string {
  const [año, mes, día] = fecha.split('-');
  return `${día}/${mes}/${año}`;
}

export function ProductionApp() {
  const { data: producciones = [], isLoading: loadingProd } = useProducciones();
  const { data: lotes = [], isLoading: loadingLotes } = useLotes();
  const { data: recuentos = [], isLoading: loadingRecuentos } = useRecuentos();
  const crearMutation = useCrearProduccion();
  const actualizarMutation = useActualizarProduccion();

  const [produccionEnEdicion, setProduccionEnEdicion] = useState<string | null>(null);
  const [mostrarFormulario, setMostrarFormulario] = useState(false);
  const [paginaHistorico, setPaginaHistorico] = useState(0);

  const handleGuardar = (data: any) => {
    if (produccionEnEdicion) {
      actualizarMutation.mutate(
        { id: produccionEnEdicion, ...data },
        {
          onSuccess: () => {
            setProduccionEnEdicion(null);
            setMostrarFormulario(false);
          },
        }
      );
    } else {
      crearMutation.mutate(data, {
        onSuccess: () => {
          setMostrarFormulario(false);
        },
      });
    }
  };

  const handleNuevo = () => {
    setProduccionEnEdicion(null);
    setMostrarFormulario(true);
  };

  const handleCerrarFormulario = () => {
    setMostrarFormulario(false);
    setProduccionEnEdicion(null);
  };

  if (loadingProd || loadingLotes || loadingRecuentos) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-gray-500">Cargando registros de producción...</p>
      </div>
    );
  }

  const totalPaginas = Math.ceil(producciones.length / ITEMS_POR_PAGINA);
  const historico = producciones
    .sort((a, b) => b.fecha.localeCompare(a.fecha))
    .slice(paginaHistorico * ITEMS_POR_PAGINA, (paginaHistorico + 1) * ITEMS_POR_PAGINA);

  return (
    <div className="min-h-screen bg-stone-100 flex justify-center relative">
      <div className="w-full max-w-full bg-[#FAF6EE] min-h-screen flex flex-col">
        {/* Header */}
        <header className="px-4 md:px-6 pt-6 pb-4 border-b border-[#E4DCC8]">
          <p className="text-xs font-semibold tracking-wide text-[#A8552E] uppercase">
            Granja Santo Tomás
          </p>
          <h1 className="text-2xl font-bold text-[#2C2419] mt-1">Producción</h1>
        </header>

        {/* Contenido */}
        <div className="flex-1 overflow-y-auto px-4 md:px-6 pt-6 pb-20">
          <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide mb-4">
            Histórico
          </p>

          {/* Tabla */}
          <div className="bg-white rounded-lg border border-amber-200 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-amber-50 border-b border-amber-200">
                <tr>
                  <th className="px-4 py-2 text-left font-semibold text-amber-900">Fecha</th>
                  <th className="px-4 py-2 text-left font-semibold text-amber-900">Galpón</th>
                  <th className="px-4 py-2 text-right font-semibold text-amber-900">Huevos</th>
                  <th className="px-4 py-2 text-right font-semibold text-amber-900">Cachados</th>
                  <th className="px-4 py-2 text-right font-semibold text-amber-900">% Rotos</th>
                  <th className="px-4 py-2 text-right font-semibold text-amber-900 bg-amber-100">% Postura</th>
                  <th className="px-4 py-2 text-right font-semibold text-amber-900">Mortandad</th>
                  <th className="px-4 py-2 text-center font-semibold text-amber-900">ID Lote</th>
                  <th className="px-4 py-2 text-right font-semibold text-amber-900">Aves Actuales</th>
                  <th className="px-4 py-2 text-left font-semibold text-amber-900">Cargado por</th>
                  <th className="px-4 py-2 text-left font-semibold text-amber-900">Observaciones</th>
                  <th className="px-4 py-2 text-center font-semibold text-amber-900">Acción</th>
                </tr>
              </thead>
              <tbody>
                {historico.map((prod) => {
                  const loteBuscado = encontrarLotePorGalponYFecha(prod.galpon, prod.fecha, lotes);
                  const avesActuales = loteBuscado
                    ? calcularAvesActualesParaRegistro(loteBuscado, producciones, recuentos, prod.fecha, prod.galpon)
                    : 0;
                  const porcentajePostura = loteBuscado
                    ? calcularPosturaPorcentajeDelRegistro(prod, avesActuales)
                    : 0;

                  return (
                    <tr key={prod.id} className="border-b border-amber-100 hover:bg-amber-50">
                      <td className="px-4 py-2 text-gray-700">{formatearFecha(prod.fecha)}</td>
                      <td className="px-4 py-2 text-gray-700">{prod.galpon}</td>
                      <td className="px-4 py-2 text-right font-semibold text-amber-900">
                        {prod.huevos_totales_mediodia + prod.huevos_totales_tarde}
                      </td>
                      <td className="px-4 py-2 text-right text-gray-700">
                        {prod.huevos_cachados_mediodia + prod.huevos_cachados_tarde}
                      </td>
                      <td className="px-4 py-2 text-right text-gray-700">
                        {(() => {
                          const rotos = (prod.huevos_cachados_mediodia || 0) + (prod.huevos_cachados_tarde || 0);
                          const totales = (prod.huevos_totales_mediodia || 0) + (prod.huevos_totales_tarde || 0);
                          return totales > 0 ? `${((rotos / totales) * 100).toFixed(2)}%` : '—';
                        })()}
                      </td>
                      <td className="px-4 py-2 text-right font-semibold text-amber-900 bg-amber-100">
                        {loteBuscado ? `${porcentajePostura.toFixed(1)}%` : '—'}
                      </td>
                      <td className="px-4 py-2 text-right text-gray-700">{prod.mortandad}</td>
                      <td className="px-4 py-2 text-center font-medium text-amber-900 text-xs">
                        {loteBuscado ? loteBuscado.lote_id || loteBuscado.id.slice(-8) : 'No determinado'}
                      </td>
                      <td className="px-4 py-2 text-right font-semibold text-gray-700">
                        {loteBuscado ? avesActuales : '—'}
                      </td>
                      <td className="px-4 py-2 text-left text-gray-700 text-xs">
                        {prod.creado_por_nombre || '—'}
                      </td>
                      <td className="px-4 py-2 text-left text-gray-700 max-w-xs truncate" title={prod.observaciones || ''}>
                        {prod.observaciones ? (
                          <span className="text-amber-700 font-medium">📝 {prod.observaciones}</span>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-center">
                        <button
                          onClick={() => {
                            setProduccionEnEdicion(prod.id);
                            setMostrarFormulario(true);
                          }}
                          className="text-amber-600 hover:text-amber-900 inline-flex items-center gap-1"
                          title="Editar"
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Paginación */}
          {totalPaginas > 1 && (
            <div className="mt-3 flex flex-col sm:flex-row items-center justify-between gap-3 text-sm">
              <p className="text-xs text-gray-600">
                Página {paginaHistorico + 1} de {totalPaginas} ({producciones.length})
              </p>
              <div className="flex gap-1 flex-wrap justify-center">
                <button
                  onClick={() => setPaginaHistorico(Math.max(0, paginaHistorico - 1))}
                  disabled={paginaHistorico === 0}
                  className="px-2 py-1 border border-amber-200 rounded text-sm disabled:opacity-50 hover:bg-amber-50"
                >
                  ←
                </button>
                {Array.from({ length: totalPaginas }, (_, i) => i).map((p) => (
                  <button
                    key={p}
                    onClick={() => setPaginaHistorico(p)}
                    className={`px-2 py-1 rounded text-sm ${
                      paginaHistorico === p
                        ? 'bg-amber-900 text-white'
                        : 'border border-amber-200 hover:bg-amber-50'
                    }`}
                  >
                    {p + 1}
                  </button>
                ))}
                <button
                  onClick={() => setPaginaHistorico(Math.min(totalPaginas - 1, paginaHistorico + 1))}
                  disabled={paginaHistorico === totalPaginas - 1}
                  className="px-2 py-1 border border-amber-200 rounded text-sm disabled:opacity-50 hover:bg-amber-50"
                >
                  →
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Botón flotante */}
        <div className="fixed bottom-6 right-4 md:right-6 z-40">
          <button
            onClick={handleNuevo}
            className="flex items-center gap-2 bg-[#A8552E] text-white font-semibold px-4 py-3 rounded-lg hover:bg-[#8B4423] transition-colors shadow-lg"
            title="Nuevo registro"
          >
            <Plus className="w-5 h-5" /> Nuevo
          </button>
        </div>
      </div>

      {/* Modal con formulario - centrado arriba */}
      {mostrarFormulario && (
        <div className="fixed inset-0 bg-black/50 flex items-start justify-center pt-4 z-50 overflow-y-auto p-4">
          <div className="bg-[#FAF6EE] rounded-lg max-w-2xl w-full">
            {/* Header del modal */}
            <div className="flex items-center justify-between px-4 md:px-6 py-4 border-b border-[#E4DCC8]">
              <h2 className="text-lg font-bold text-[#2C2419]">
                {produccionEnEdicion ? 'Editar producción' : 'Nueva producción'}
              </h2>
              <button
                onClick={handleCerrarFormulario}
                className="text-[#8A7A5C] hover:text-[#2C2419]"
              >
                <X className="w-6 h-6" />
              </button>
            </div>

            {/* Contenido del modal */}
            <div className="px-4 md:px-6 py-6 overflow-y-auto max-h-[calc(100vh-200px)]">
              <FormProduccion
                galpones={GALPONES}
                onGuardar={handleGuardar}
                isLoading={crearMutation.isPending || actualizarMutation.isPending}
                produccionEnEdicion={
                  produccionEnEdicion
                    ? producciones.find((p) => p.id === produccionEnEdicion) || null
                    : null
                }
                onCancelar={handleCerrarFormulario}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
