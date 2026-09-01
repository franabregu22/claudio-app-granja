import { useState, useEffect } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, Edit2 } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import type { Produccion, Lote, RecuentoLote } from '../../types/domain';
import {
  calcularMetricasPeriodo,
  calcularPosturaBrutaPeriodo,
  generarAlertas,
  calcularHuevosPorGalponUltimos15Dias,
  calcularPosturaPorGalponUltimos15Dias,
  encontrarLotePorGalponYFecha,
  calcularAvesActualesParaRegistro,
  calcularPosturaPorcentajeDelRegistro,
  type MetricaPeriodo,
  type Alerta,
} from './produccionCalculos';
import { calcularDíasDesdeBA, isoAFechaBA } from '../../utils/dateUtils';

interface DashboardProduccionProps {
  producciones: Produccion[];
  lotes: Lote[];
  recuentos: RecuentoLote[];
  onEditar?: (id: string) => void;
}

interface Linea {
  producto_nombre?: string;
  cantidad?: number;
  [key: string]: any;
}

type Periodo = 'ayer' | 'semana' | 'mes';

function formatearFecha(fecha: string): string {
  const [año, mes, día] = fecha.split('-');
  return `${día}/${mes}/${año}`;
}

function agregarDias(fecha: string, dias: number): string {
  const [año, mes, día] = fecha.split('-').map(Number);
  const d = new Date(año, mes - 1, día);
  d.setDate(d.getDate() + dias);
  const nuevoAño = d.getFullYear();
  const nuevoMes = String(d.getMonth() + 1).padStart(2, '0');
  const nuevoDía = String(d.getDate()).padStart(2, '0');
  return `${nuevoAño}-${nuevoMes}-${nuevoDía}`;
}

function obtenerInicioSemana(fecha: string): string {
  const [año, mes, día] = fecha.split('-').map(Number);
  const d = new Date(año, mes - 1, día);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  const nuevoAño = d.getFullYear();
  const nuevoMes = String(d.getMonth() + 1).padStart(2, '0');
  const nuevoDía = String(d.getDate()).padStart(2, '0');
  return `${nuevoAño}-${nuevoMes}-${nuevoDía}`;
}

function obtenerInicioMes(fecha: string): string {
  const [año, mes] = fecha.split('-');
  return `${año}-${mes}-01`;
}

function calcularDiasEntre(fechaInicio: string, fechaFin: string): number {
  const inicio = new Date(fechaInicio);
  const fin = new Date(fechaFin);
  return Math.floor((fin.getTime() - inicio.getTime()) / (1000 * 60 * 60 * 24)) + 1;
}

export function DashboardProduccion({
  producciones,
  lotes,
  recuentos,
  onEditar,
}: DashboardProduccionProps) {
  const hoy = new Date().toISOString().split('T')[0];
  const ayer = agregarDias(hoy, -1);

  const [periodo, setPeriodo] = useState<Periodo>('ayer');
  const [paginaHistorico, setPaginaHistorico] = useState(0);

  const ITEMS_POR_PAGINA = 15;

  // Calcular rangos según período
  let fechaInicio = ayer;
  let fechaFin = ayer;
  let fechaComparacionInicio = agregarDias(ayer, -1);
  let fechaComparacionFin = agregarDias(ayer, -1);
  let etiquetaPeriodo = `${formatearFecha(ayer)}`;
  let etiquetaComparacion = `${formatearFecha(agregarDias(ayer, -1))}`;

  if (periodo === 'semana') {
    const inicioSemana = obtenerInicioSemana(ayer);
    const diasEnSemana = calcularDiasEntre(inicioSemana, ayer);
    const inicioSemanaPasada = agregarDias(inicioSemana, -7);
    const finSemanaPasada = agregarDias(inicioSemanaPasada, diasEnSemana - 1);

    fechaInicio = inicioSemana;
    fechaFin = ayer;
    fechaComparacionInicio = inicioSemanaPasada;
    fechaComparacionFin = finSemanaPasada;
    etiquetaPeriodo = `${formatearFecha(inicioSemana)} → ${formatearFecha(ayer)}`;
    etiquetaComparacion = `${formatearFecha(inicioSemanaPasada)} → ${formatearFecha(finSemanaPasada)}`;
  } else if (periodo === 'mes') {
    const inicioMes = obtenerInicioMes(ayer);
    const diasEnMes = calcularDiasEntre(inicioMes, ayer);
    const inicioMesPasado = obtenerInicioMes(agregarDias(inicioMes, -1));
    const finMesPasado = agregarDias(inicioMesPasado, diasEnMes - 1);

    fechaInicio = inicioMes;
    fechaFin = ayer;
    fechaComparacionInicio = inicioMesPasado;
    fechaComparacionFin = finMesPasado;
    etiquetaPeriodo = `${formatearFecha(inicioMes)} → ${formatearFecha(ayer)}`;
    etiquetaComparacion = `${formatearFecha(inicioMesPasado)} → ${formatearFecha(finMesPasado)}`;
  }

  const metricasActuales = calcularMetricasPeriodo(producciones, lotes, recuentos, fechaInicio, fechaFin);
  const metricasComparacion = calcularMetricasPeriodo(producciones, lotes, recuentos, fechaComparacionInicio, fechaComparacionFin);

  const posturaActual = calcularPosturaBrutaPeriodo(producciones, lotes, recuentos, fechaInicio, fechaFin);
  const posturaComparacion = calcularPosturaBrutaPeriodo(producciones, lotes, recuentos, fechaComparacionInicio, fechaComparacionFin);

  const alertas = generarAlertas(producciones, lotes, recuentos, ayer);
  const datosGrafico = calcularPosturaPorGalponUltimos15Dias(producciones, lotes, recuentos, ayer);

  const calcularVariacion = (actual: number, anterior: number): number => {
    if (anterior === 0) return 0;
    return ((actual - anterior) / anterior) * 100;
  };

  const CardMetrica = ({ label, valor, comparacion, unidad, alerta, valorComparacion, invertirColores }: any) => {
    const esPositivo = comparacion > 0;
    const esVerde = invertirColores ? !esPositivo : esPositivo;

    return (
      <div className={`bg-white rounded-lg p-4 border ${alerta ? 'border-red-200' : 'border-amber-200'}`}>
        <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-2">{label}</p>
        <p className={`text-3xl font-bold ${alerta ? 'text-red-600' : 'text-amber-900'}`}>
          {valor}{unidad && <span className="text-lg ml-1">{unidad}</span>}
        </p>
        {valorComparacion !== undefined && (
          <div className="mt-2 space-y-1">
            <p className="text-xs text-gray-500">vs {valorComparacion}{unidad}</p>
            {comparacion !== undefined && comparacion !== 0 && (
              <p className={`text-xs font-semibold ${esVerde ? 'text-green-600' : 'text-red-600'}`}>
                {esPositivo ? '↑' : '↓'} {Math.abs(comparacion).toFixed(1)}%
              </p>
            )}
            {comparacion === 0 && (
              <p className="text-xs font-semibold text-gray-500">
                ↔ 0%
              </p>
            )}
          </div>
        )}
      </div>
    );
  };

  // Obtener galpones disponibles
  const galpones = [...new Set(producciones.map(p => p.galpon))].sort();
  const colores = ['#3b82f6', '#ef4444', '#f59e0b', '#10b981', '#8b5cf6', '#ec4899'];
  const mapaColores: Record<string, string> = {};
  galpones.forEach((galpon, idx) => {
    mapaColores[galpon] = colores[idx % colores.length];
  });

  return (
    <div className="space-y-6 pb-20">
      {/* Selector de período */}
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setPeriodo('ayer')}
            className={`px-4 py-2 text-sm font-medium rounded transition ${
              periodo === 'ayer'
                ? 'bg-[#A8552E] text-white'
                : 'bg-white border border-[#D8CDB0] text-[#2C2419]'
            }`}
          >
            Ayer
          </button>
          <button
            onClick={() => setPeriodo('semana')}
            className={`px-4 py-2 text-sm font-medium rounded transition ${
              periodo === 'semana'
                ? 'bg-[#A8552E] text-white'
                : 'bg-white border border-[#D8CDB0] text-[#2C2419]'
            }`}
          >
            Semana
          </button>
          <button
            onClick={() => setPeriodo('mes')}
            className={`px-4 py-2 text-sm font-medium rounded transition ${
              periodo === 'mes'
                ? 'bg-[#A8552E] text-white'
                : 'bg-white border border-[#D8CDB0] text-[#2C2419]'
            }`}
          >
            Mes
          </button>
        </div>
      </div>

      {/* Alertas */}
      {alertas.length > 0 && (
        <div className="space-y-2">
          {alertas.map((alerta, i) => (
            <div
              key={i}
              className={`flex gap-3 p-3 rounded-lg ${
                alerta.severidad === 'error'
                  ? 'bg-red-50 border border-red-200'
                  : 'bg-yellow-50 border border-yellow-200'
              }`}
            >
              <AlertTriangle
                className={`w-5 h-5 flex-shrink-0 ${
                  alerta.severidad === 'error' ? 'text-red-600' : 'text-yellow-600'
                }`}
              />
              <div className={alerta.severidad === 'error' ? 'text-red-800' : 'text-yellow-800'}>
                <p className="font-semibold text-sm">{alerta.galpon}</p>
                <p className="text-sm">{alerta.mensaje}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Métricas principales */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
        <CardMetrica
          label="Huevos Totales"
          valor={metricasActuales.huevos_totales}
          comparacion={calcularVariacion(metricasActuales.huevos_totales, metricasComparacion.huevos_totales)}
          unidad=""
          valorComparacion={metricasComparacion.huevos_totales}
        />
        <CardMetrica
          label="Postura Bruta"
          valor={posturaActual.toFixed(1)}
          comparacion={calcularVariacion(posturaActual, posturaComparacion)}
          unidad="%"
          alerta={posturaActual < 80}
          valorComparacion={posturaComparacion.toFixed(1)}
        />
        <CardMetrica
          label="Mortandad"
          valor={metricasActuales.mortandad_total}
          comparacion={calcularVariacion(metricasActuales.mortandad_total, metricasComparacion.mortandad_total)}
          unidad="aves"
          valorComparacion={metricasComparacion.mortandad_total}
          invertirColores={true}
        />
        <CardMetrica
          label="Huevos Cachados"
          valor={metricasActuales.huevos_cachados}
          comparacion={calcularVariacion(metricasActuales.huevos_cachados, metricasComparacion.huevos_cachados)}
          unidad=""
          valorComparacion={metricasComparacion.huevos_cachados}
          invertirColores={true}
        />
      </div>

      {/* Información de períodos */}
      <div className="grid grid-cols-2 gap-4 text-xs text-gray-600">
        <div>
          <p className="font-semibold">Período actual</p>
          <p>{etiquetaPeriodo}</p>
        </div>
        <div>
          <p className="font-semibold">Período anterior</p>
          <p>{etiquetaComparacion}</p>
        </div>
      </div>

      {/* Gráfico de postura por galpón */}
      {datosGrafico.length > 0 && (
        <div className="bg-white rounded-lg border border-amber-200 p-4">
          <h3 className="text-sm font-bold text-amber-900 uppercase tracking-wide mb-4">
            % Postura - Últimos 15 días
          </h3>
          {(() => {
            const datosAjustados = datosGrafico.map((d: any) => ({
              fecha: d.fecha,
              ...Object.fromEntries(
                Object.entries(d)
                  .filter(([k]) => k !== 'fecha')
                  .map(([k, v]: [string, any]) => [k, typeof v === 'number' ? v - 50 : v])
              )
            }));
            return (
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={datosAjustados} margin={{ top: 5, right: 60, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis
                    dataKey="fecha"
                    tickFormatter={(fecha) => fecha.slice(5)}
                    tick={{ fontSize: 12 }}
                  />
                  <YAxis yAxisId="left" label={{ value: '%', angle: -90, position: 'insideLeft' }} tick={{ fontSize: 12 }} domain={[0, 50]} tickFormatter={(value) => `${value + 50}%`} />
                  <Tooltip
                    formatter={(value: any) => `${typeof value === 'number' ? (value + 50).toFixed(1) : value}%`}
                    labelFormatter={(label: any) => (label ? formatearFecha(String(label)) : '')}
                  />
                  <Legend />
                  {galpones.map((galpon) => (
                    <Line
                      key={galpon}
                      dataKey={galpon}
                      stroke={mapaColores[galpon]}
                      name={galpon}
                      isAnimationActive={false}
                      yAxisId="left"
                      connectNulls
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            );
          })()}
        </div>
      )}

      {/* Histórico de producciones */}
      <div className="space-y-3">
        <h3 className="text-sm font-bold text-amber-900 uppercase tracking-wide">Histórico</h3>
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
                {onEditar && <th className="px-4 py-2 text-center font-semibold text-amber-900">Acción</th>}
              </tr>
            </thead>
            <tbody>
              {(() => {
                const historico = producciones
                  .sort((a, b) => b.fecha.localeCompare(a.fecha))
                  .slice(paginaHistorico * ITEMS_POR_PAGINA, (paginaHistorico + 1) * ITEMS_POR_PAGINA);

                return historico.map((prod) => {
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
                      {onEditar && (
                        <td className="px-4 py-2 text-center">
                          <button
                            onClick={() => onEditar(prod.id)}
                            className="text-amber-600 hover:text-amber-900 inline-flex items-center gap-1"
                            title="Editar"
                          >
                            <Edit2 className="w-4 h-4" />
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

        {/* Paginación Responsive */}
        {(() => {
          const totalPaginas = Math.ceil(producciones.length / ITEMS_POR_PAGINA);
          return totalPaginas > 1 ? (
            <div className="mt-3 flex flex-col sm:flex-row items-center justify-between gap-3 text-sm">
              <p className="text-xs text-gray-600">
                Página {paginaHistorico + 1} de {totalPaginas} ({producciones.length})
              </p>
              <div className="flex gap-1 flex-wrap justify-center">
                <button
                  onClick={() => setPaginaHistorico(Math.max(0, paginaHistorico - 1))}
                  disabled={paginaHistorico === 0}
                  className="px-2 py-1 border border-[#D8CDB0] rounded text-sm disabled:opacity-50 hover:bg-[#F5EFE6]"
                >
                  ←
                </button>

                {Array.from({ length: totalPaginas }, (_, i) => i).map((p) => {
                  const isVisible = p === 0 || p === totalPaginas - 1 || Math.abs(p - paginaHistorico) <= 1;
                  const showDotsBefore = p === 1 && paginaHistorico > 2;
                  const showDotsAfter = p === totalPaginas - 2 && paginaHistorico < totalPaginas - 3;

                  return (
                    <div key={p}>
                      {showDotsBefore && <span className="px-1 text-gray-600">...</span>}
                      {isVisible && (
                        <button
                          onClick={() => setPaginaHistorico(p)}
                          className={`px-2 py-1 rounded text-sm ${
                            paginaHistorico === p
                              ? 'bg-[#A8552E] text-white'
                              : 'border border-[#D8CDB0] hover:bg-[#F5EFE6]'
                          }`}
                        >
                          {p + 1}
                        </button>
                      )}
                      {showDotsAfter && <span className="px-1 text-gray-600">...</span>}
                    </div>
                  );
                })}

                <button
                  onClick={() => setPaginaHistorico(Math.min(totalPaginas - 1, paginaHistorico + 1))}
                  disabled={paginaHistorico === totalPaginas - 1}
                  className="px-2 py-1 border border-[#D8CDB0] rounded text-sm disabled:opacity-50 hover:bg-[#F5EFE6]"
                >
                  →
                </button>
              </div>
            </div>
          ) : null;
        })()}
      </div>
    </div>
  );
}
