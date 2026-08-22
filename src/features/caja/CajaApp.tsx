import { useState, useMemo } from 'react';
import { Plus, AlertTriangle, Download } from 'lucide-react';
import { useMovimientosCaja, useCheques, useAnularMovimiento } from '../../hooks/useCaja';
import { useAuth } from '../../auth/useAuth';
import { ListaMovimientos } from './ListaMovimientos';
import { FormMovimiento } from './FormMovimiento';
import { Pagination } from '../../components/Pagination';
import { formatoPesos } from '../pedidos/helpers';
import { getTodayDate } from '../../utils/dateUtils';

type Vista = 'lista' | 'nuevo';
type Periodo = 'hoy' | 'semana' | 'mes' | 'custom';

function getStartOfWeek(): string {
  const today = new Date();
  const day = today.getDay();
  const diff = today.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(today.getFullYear(), today.getMonth(), diff);
  const year = monday.getFullYear();
  const month = String(monday.getMonth() + 1).padStart(2, '0');
  const dateStr = String(monday.getDate()).padStart(2, '0');
  return `${year}-${month}-${dateStr}`;
}

function getStartOfMonth(): string {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}-01`;
}

export function CajaApp() {
  const { rol } = useAuth();
  const [vista, setVista] = useState<Vista>('lista');
  const [periodo, setPeriodo] = useState<Periodo>('mes');
  const [fechaDesde, setFechaDesde] = useState(getStartOfMonth());
  const [fechaHasta, setFechaHasta] = useState(getTodayDate());
  const [mostrarImportarSheets, setMostrarImportarSheets] = useState(false);
  const [movimientosPage, setMovimientosPage] = useState(1);
  const ITEMS_PER_PAGE = 10;

  const movimientosQuery = useMovimientosCaja();
  const chequesQuery = useCheques();
  const anularMutation = useAnularMovimiento();

  if (rol !== 'dueño') {
    return (
      <div className="min-h-screen bg-stone-100 flex items-center justify-center">
        <div className="bg-white p-8 rounded-lg text-center max-w-sm mx-4">
          <p className="text-lg font-semibold text-gray-800">Acceso restringido</p>
          <p className="text-gray-600 mt-2">Solo el dueño puede acceder a Caja.</p>
        </div>
      </div>
    );
  }

  // Calcular fechas según período
  const getDateRange = () => {
    const hoy = getTodayDate();
    switch (periodo) {
      case 'hoy':
        return { desde: hoy, hasta: hoy };
      case 'semana':
        return { desde: getStartOfWeek(), hasta: hoy };
      case 'mes':
        return { desde: getStartOfMonth(), hasta: hoy };
      case 'custom':
        return { desde: fechaDesde, hasta: fechaHasta };
    }
  };

  const { desde, hasta } = getDateRange();

  // Filtrar movimientos
  const movimientos = movimientosQuery.data || [];
  const movimientosFiltrados = useMemo(() => {
    return movimientos.filter(
      (m) => m.fecha_operacion >= desde && m.fecha_operacion <= hasta
    );
  }, [movimientos, desde, hasta]);

  // Calcular resumen por categoría analítica
  const resumen = useMemo(() => {
    let ingresos = 0;
    let egresosOperativos = 0;
    let egresosReinversion = 0;
    let egresosInversion = 0;

    movimientosFiltrados.forEach((m) => {
      if (m.estado === 'confirmado') {
        if (m.tipo === 'ingreso') {
          ingresos += m.monto;
        } else {
          switch (m.categoria_analisis) {
            case 'GASTOS_OPERATIVOS':
              egresosOperativos += m.monto;
              break;
            case 'REINVERSION_OPERATIVA':
              egresosReinversion += m.monto;
              break;
            case 'INVERSION':
              egresosInversion += m.monto;
              break;
            default:
              egresosOperativos += m.monto;
          }
        }
      }
    });

    const egresosTotal = egresosOperativos + egresosReinversion + egresosInversion;
    const balanceOperativo = ingresos - egresosOperativos;

    return {
      ingresos,
      egresosOperativos,
      egresosReinversion,
      egresosInversion,
      egresosTotal,
      balance: ingresos - egresosTotal,
      balanceOperativo,
    };
  }, [movimientosFiltrados]);

  // Calcular total impuesto al cheque
  const totalImpuestoAlCheque = useMemo(() => {
    return movimientosFiltrados
      .filter((m) => m.estado === 'confirmado')
      .reduce((sum, m) => sum + (m.impuesto_cheque || 0), 0);
  }, [movimientosFiltrados]);

  // Cheques próximos a vencer (30 días)
  const chequesPorVencer = useMemo(() => {
    const hoy = new Date();
    const en30Dias = new Date(hoy.getTime() + 30 * 24 * 60 * 60 * 1000);
    const chequesData = chequesQuery.data || [];

    return chequesData.filter((c) => {
      if (c.estado !== 'emitido') return false;
      const fecha = new Date(c.fecha_vencimiento);
      return fecha <= en30Dias && fecha >= hoy;
    });
  }, [chequesQuery.data]);

  // Agrupación por clasificación analítica → categoría técnica → subcategorías (solo egresos)
  const resumenPorClasificacion = useMemo(() => {
    const clasificaciones: Record<string, any> = {
      GASTOS_OPERATIVOS: { label: 'Operativo', categorias: {}, total: 0 },
      REINVERSION_OPERATIVA: { label: 'Reinversión', categorias: {}, total: 0 },
      INVERSION: { label: 'Inversión', categorias: {}, total: 0 },
    };

    let sinCategoria = { label: 'Sin Categoría', categorias: {}, total: 0 };

    movimientosFiltrados.forEach((m) => {
      // Solo procesar egresos confirmados
      if (m.estado !== 'confirmado' || m.tipo !== 'egreso') return;

      const clasificacion = m.categoria_analisis || 'GASTOS_OPERATIVOS';
      const categoria = m.categoria_tecnica || 'Sin categoría';
      const subcategoria = m.subcategoria || 'Sin subcategoría';

      if (!m.categoria_tecnica) {
        // Gastos sin categoría
        const cats = sinCategoria.categorias as Record<string, Record<string, number>>;
        if (!cats[categoria]) {
          cats[categoria] = {};
        }
        if (!cats[categoria][subcategoria]) {
          cats[categoria][subcategoria] = 0;
        }
        cats[categoria][subcategoria] += m.monto;
        sinCategoria.total += m.monto;
      } else {
        // Gastos categorizados
        if (!clasificaciones[clasificacion].categorias[categoria]) {
          clasificaciones[clasificacion].categorias[categoria] = {};
        }
        if (!clasificaciones[clasificacion].categorias[categoria][subcategoria]) {
          clasificaciones[clasificacion].categorias[categoria][subcategoria] = 0;
        }
        clasificaciones[clasificacion].categorias[categoria][subcategoria] += m.monto;
        clasificaciones[clasificacion].total += m.monto;
      }
    });

    // Ordenar y retornar
    const resultado = [];

    // Agregar clasificaciones con gastos
    Object.entries(clasificaciones).forEach(([key, data]) => {
      if (data.total > 0) {
        resultado.push({ key, ...data });
      }
    });

    // Agregar gastos sin categoría al final
    if (sinCategoria.total > 0) {
      resultado.push({ key: 'SIN_CATEGORIA', ...sinCategoria });
    }

    return resultado;
  }, [movimientosFiltrados]);

  // Paginación de movimientos
  const totalMovimientosPages = Math.ceil(movimientosFiltrados.length / ITEMS_PER_PAGE);
  const startIdx = (movimientosPage - 1) * ITEMS_PER_PAGE;
  const paginatedMovimientos = movimientosFiltrados.slice(startIdx, startIdx + ITEMS_PER_PAGE);

  if (vista === 'nuevo') {
    return (
      <FormMovimiento
        onGuardar={() => {
          setVista('lista');
          movimientosQuery.refetch();
        }}
        onCancelar={() => setVista('lista')}
      />
    );
  }

  return (
    <div className="min-h-screen bg-stone-100 flex justify-center">
      <div className="w-full max-w-6xl bg-[#FAF6EE] min-h-screen flex flex-col">
        {/* Header */}
        <header className="px-4 md:px-6 pt-6 pb-4 border-b border-[#E4DCC8]">
          <p className="text-xs font-semibold tracking-wide text-[#A8552E] uppercase">
            Granja Santo Tomás
          </p>
          <h1 className="text-2xl font-bold text-[#2C2419] mt-1">Caja & Finanzas</h1>
        </header>

        {/* Selector de Período */}
        <div className="px-4 md:px-6 pt-4 pb-2 border-b border-[#E4DCC8]">
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <button
              onClick={() => setPeriodo('hoy')}
              className={`px-3 py-1.5 text-sm font-medium rounded ${
                periodo === 'hoy'
                  ? 'bg-[#A8552E] text-white'
                  : 'bg-white border border-[#D8CDB0] text-[#2C2419]'
              }`}
            >
              Hoy
            </button>
            <button
              onClick={() => setPeriodo('semana')}
              className={`px-3 py-1.5 text-sm font-medium rounded ${
                periodo === 'semana'
                  ? 'bg-[#A8552E] text-white'
                  : 'bg-white border border-[#D8CDB0] text-[#2C2419]'
              }`}
            >
              Semana
            </button>
            <button
              onClick={() => setPeriodo('mes')}
              className={`px-3 py-1.5 text-sm font-medium rounded ${
                periodo === 'mes'
                  ? 'bg-[#A8552E] text-white'
                  : 'bg-white border border-[#D8CDB0] text-[#2C2419]'
              }`}
            >
              Mes
            </button>
            <button
              onClick={() => setPeriodo('custom')}
              className={`px-3 py-1.5 text-sm font-medium rounded ${
                periodo === 'custom'
                  ? 'bg-[#A8552E] text-white'
                  : 'bg-white border border-[#D8CDB0] text-[#2C2419]'
              }`}
            >
              Personalizado
            </button>

            {periodo === 'custom' && (
              <div className="flex gap-2">
                <input
                  type="date"
                  value={fechaDesde}
                  onChange={(e) => setFechaDesde(e.target.value)}
                  className="px-2 py-1 text-sm border border-[#D8CDB0] rounded"
                />
                <input
                  type="date"
                  value={fechaHasta}
                  onChange={(e) => setFechaHasta(e.target.value)}
                  className="px-2 py-1 text-sm border border-[#D8CDB0] rounded"
                />
              </div>
            )}
          </div>
          <p className="text-xs text-[#8A7A5C]">
            {desde} → {hasta} ({movimientosFiltrados.length} movimientos)
          </p>
        </div>

        {/* Contenido Principal */}
        <div className="flex-1 overflow-y-auto px-4 md:px-6 pt-6 pb-20">
          {/* Tarjetas de Resumen - Primera fila */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
            <div className="bg-green-50 border border-green-200 rounded-lg p-4">
              <p className="text-xs text-green-700 font-semibold uppercase mb-1">Ingresos</p>
              <p className="text-2xl font-bold text-green-700">{formatoPesos(resumen.ingresos)}</p>
            </div>
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
              <p className="text-xs text-amber-700 font-semibold uppercase mb-1">Gasto Operativo</p>
              <p className="text-2xl font-bold text-amber-700">{formatoPesos(resumen.egresosOperativos)}</p>
            </div>
            <div className={`${
              resumen.balanceOperativo >= 0
                ? 'bg-blue-50 border border-blue-200'
                : 'bg-orange-50 border border-orange-200'
            } rounded-lg p-4`}>
              <p className={`text-xs font-semibold uppercase mb-1 ${
                resumen.balanceOperativo >= 0 ? 'text-blue-700' : 'text-orange-700'
              }`}>
                Balance Operativo
              </p>
              <p className={`text-2xl font-bold ${
                resumen.balanceOperativo >= 0 ? 'text-blue-700' : 'text-orange-700'
              }`}>
                {formatoPesos(resumen.balanceOperativo)}
              </p>
            </div>
          </div>

          {/* Tarjetas de Resumen - Segunda fila */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-6">
            <div className="bg-violet-50 border border-violet-200 rounded-lg p-4">
              <p className="text-xs text-violet-700 font-semibold uppercase mb-1">Reinversión Op.</p>
              <p className="text-2xl font-bold text-violet-700">{formatoPesos(resumen.egresosReinversion)}</p>
            </div>
            <div className="bg-cyan-50 border border-cyan-200 rounded-lg p-4">
              <p className="text-xs text-cyan-700 font-semibold uppercase mb-1">Inversión</p>
              <p className="text-2xl font-bold text-cyan-700">{formatoPesos(resumen.egresosInversion)}</p>
            </div>
            <div className="bg-purple-50 border border-purple-200 rounded-lg p-4">
              <p className="text-xs text-purple-700 font-semibold uppercase mb-1">Cheques</p>
              <p className="text-2xl font-bold text-purple-700">{chequesPorVencer.length}</p>
            </div>
            <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-4">
              <p className="text-xs text-indigo-700 font-semibold uppercase mb-1">Impuesto Cheque</p>
              <p className="text-2xl font-bold text-indigo-700">{formatoPesos(totalImpuestoAlCheque)}</p>
            </div>
          </div>

          {/* Alertas de Cheques */}
          {chequesPorVencer.length > 0 && (
            <div className="bg-yellow-50 border-l-4 border-yellow-400 p-4 mb-6 rounded">
              <div className="flex gap-3">
                <AlertTriangle className="w-5 h-5 text-yellow-600 shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="font-semibold text-yellow-800 mb-2">
                    {chequesPorVencer.length} cheque(s) próximo(s) a vencer
                  </p>
                  <div className="space-y-1 text-sm text-yellow-700">
                    {chequesPorVencer.slice(0, 5).map((c) => (
                      <p key={c.id}>
                        • Cheque #{c.numero} ({c.banco}) - {formatoPesos(c.monto)} - Vence: {c.fecha_vencimiento}
                      </p>
                    ))}
                    {chequesPorVencer.length > 5 && (
                      <p>• +{chequesPorVencer.length - 5} más...</p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Análisis por Categoría */}
          {resumenPorClasificacion.length > 0 && (
            <div className="mb-6">
              <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide mb-4">
                Resumen por Categoría
              </p>
              <div className="space-y-6">
                {resumenPorClasificacion.map((clasificacion) => (
                  <div key={clasificacion.key} className="border border-[#D8CDB0] rounded-lg overflow-hidden bg-white">
                    {/* Header de clasificación */}
                    <div className="bg-amber-50 px-4 py-3 border-b border-[#D8CDB0] flex items-center justify-between">
                      <h3 className="font-bold text-[#2C2419] text-sm uppercase">
                        {clasificacion.label}
                      </h3>
                      <p className="text-red-700 font-bold">{formatoPesos(clasificacion.total)}</p>
                    </div>

                    {/* Categorías técnicas dentro de la clasificación */}
                    <div className="p-4 space-y-3">
                      {Object.entries(clasificacion.categorias).map(([categoria, subcategorias]) => {
                        // Ordenar subcategorías por monto descendente
                        const subcatOrdenadas = Object.entries(subcategorias as Record<string, number>)
                          .sort((a, b) => b[1] - a[1]);

                        return (
                          <div key={categoria} className="border-l-4 border-amber-300 pl-3">
                            <p className="text-sm font-semibold text-[#2C2419] mb-2">{categoria}</p>
                            <div className="space-y-1 text-xs text-[#8A7A5C]">
                              {subcatOrdenadas.map(([subcategoria, monto]) => (
                                <div key={subcategoria} className="flex justify-between">
                                  <span>• {subcategoria}</span>
                                  <span className="font-medium text-red-700">{formatoPesos(monto)}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Listado de Movimientos */}
          {movimientosFiltrados.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide mb-3">
                Movimientos Detallados
              </p>
              <ListaMovimientos
                movimientos={paginatedMovimientos}
                onAnular={(id, motivo) => anularMutation.mutateAsync({ id, motivo })}
              />
              {totalMovimientosPages > 1 && (
                <Pagination
                  currentPage={movimientosPage}
                  totalPages={totalMovimientosPages}
                  onPageChange={setMovimientosPage}
                />
              )}
            </div>
          )}

          {movimientosFiltrados.length === 0 && (
            <div className="border border-dashed border-[#D8CDB0] rounded-lg p-6 text-center">
              <p className="text-sm text-[#8A7A5C]">No hay movimientos en este período</p>
            </div>
          )}
        </div>

        {/* Botones flotantes */}
        <div className="fixed bottom-6 right-6 flex flex-col gap-3">
          <button
            onClick={() => setMostrarImportarSheets(true)}
            className="flex items-center gap-2 bg-blue-600 text-white font-semibold px-4 py-3 rounded-lg hover:bg-blue-700 transition-colors shadow-lg"
            title="Importar desde Google Sheets"
          >
            <Download className="w-5 h-5" />
          </button>
          <button
            onClick={() => setVista('nuevo')}
            className="flex items-center gap-2 bg-[#A8552E] text-white font-semibold px-4 py-3 rounded-lg hover:bg-[#8B4423] transition-colors shadow-lg"
          >
            <Plus className="w-5 h-5" /> Nuevo
          </button>
        </div>

      </div>
    </div>
  );
}
