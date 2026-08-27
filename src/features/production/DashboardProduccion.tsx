import { useState, useEffect } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, Edit2 } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import type { Produccion, Lote, RecuentoLote } from '../../types/domain';
import {
  calcularMetricasPeriodo,
  calcularPosturaBrutaPeriodo,
  generarAlertas,
  calcularHuevosPorGalponUltimos15Dias,
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
  const datosGrafico = calcularHuevosPorGalponUltimos15Dias(producciones, ayer);

  const calcularVariacion = (actual: number, anterior: number): number => {
    if (anterior === 0) return 0;
    return ((actual - anterior) / anterior) * 100;
  };

  const CardMetrica = ({ label, valor, comparacion, unidad, alerta }: any) => (
    <div className={`bg-white rounded-lg p-4 border ${alerta ? 'border-red-200' : 'border-amber-200'}`}>
      <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-2">{label}</p>
      <p className={`text-3xl font-bold ${alerta ? 'text-red-600' : 'text-amber-900'}`}>
        {valor}{unidad && <span className="text-lg ml-1">{unidad}</span>}
      </p>
      {comparacion !== undefined && comparacion !== 0 && (
        <p className={`text-xs font-semibold mt-2 ${comparacion > 0 ? 'text-green-600' : 'text-red-600'}`}>
          {comparacion > 0 ? '↑' : '↓'} {Math.abs(comparacion).toFixed(1)}%
        </p>
      )}
    </div>
  );

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
        />
        <CardMetrica
          label="Postura Bruta"
          valor={posturaActual.toFixed(1)}
          comparacion={calcularVariacion(posturaActual, posturaComparacion)}
          unidad="%"
          alerta={posturaActual < 80}
        />
        <CardMetrica
          label="Mortandad"
          valor={metricasActuales.mortandad_total}
          comparacion={calcularVariacion(metricasActuales.mortandad_total, metricasComparacion.mortandad_total)}
          unidad="aves"
        />
        <CardMetrica
          label="Huevos Cachados"
          valor={metricasActuales.huevos_cachados}
          comparacion={calcularVariacion(metricasActuales.huevos_cachados, metricasComparacion.huevos_cachados)}
          unidad=""
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

      {/* Gráfico de huevos por galpón */}
      {datosGrafico.length > 0 && (
        <div className="bg-white rounded-lg border border-amber-200 p-4">
          <h3 className="text-sm font-bold text-amber-900 uppercase tracking-wide mb-4">
            Huevos Totales - Últimos 10 días
          </h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={datosGrafico} margin={{ top: 5, right: 60, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis
                dataKey="fecha"
                tickFormatter={(fecha) => fecha.slice(5)}
                tick={{ fontSize: 12 }}
              />
              <YAxis yAxisId="left" tick={{ fontSize: 12 }} />
              <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 12 }} />
              <Tooltip
                formatter={(value: any) => value.toLocaleString('es-AR')}
                labelFormatter={(label) => formatearFecha(label)}
              />
              <Legend />
              {galpones.map((galpon, idx) => (
                <Bar
                  key={galpon}
                  dataKey={galpon}
                  fill={mapaColores[galpon]}
                  name={galpon}
                  isAnimationActive={false}
                  stackId="huevos"
                  yAxisId={idx === 0 ? 'right' : 'left'}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
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
                <th className="px-4 py-2 text-right font-semibold text-amber-900">Mortandad</th>
                <th className="px-4 py-2 text-left font-semibold text-amber-900">Observaciones</th>
                <th className="px-4 py-2 text-center font-semibold text-amber-900">ID Lote</th>
                <th className="px-4 py-2 text-right font-semibold text-amber-900">Aves Actuales</th>
                <th className="px-4 py-2 text-right font-semibold text-amber-900">% Postura</th>
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
                        {prod.huevos_sanos_mediodia + prod.huevos_sanos_tarde}
                      </td>
                      <td className="px-4 py-2 text-right text-gray-700">
                        {prod.huevos_cachados_mediodia + prod.huevos_cachados_tarde}
                      </td>
                      <td className="px-4 py-2 text-right text-gray-700">
                        {(() => {
                          const rotos = prod.huevos_cachados_mediodia + prod.huevos_cachados_tarde;
                          const sanos = prod.huevos_sanos_mediodia + prod.huevos_sanos_tarde;
                          const total = rotos + sanos;
                          return total > 0 ? `${((rotos / total) * 100).toFixed(2)}%` : '—';
                        })()}
                      </td>
                      <td className="px-4 py-2 text-right text-gray-700">{prod.mortandad}</td>
                      <td className="px-4 py-2 text-left text-gray-700 max-w-xs truncate" title={prod.observaciones || ''}>
                        {prod.observaciones ? (
                          <span className="text-amber-700 font-medium">📝 {prod.observaciones}</span>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-center font-medium text-amber-900 text-xs">
                        {loteBuscado ? loteBuscado.lote_id || loteBuscado.id.slice(-8) : 'No determinado'}
                      </td>
                      <td className="px-4 py-2 text-right font-semibold text-gray-700">
                        {loteBuscado ? avesActuales : '—'}
                      </td>
                      <td className="px-4 py-2 text-right font-semibold text-amber-900">
                        {loteBuscado ? `${porcentajePostura.toFixed(1)}%` : '—'}
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

        {/* Paginación */}
        {(() => {
          const totalPaginas = Math.ceil(producciones.length / ITEMS_POR_PAGINA);
          return totalPaginas > 1 ? (
            <div className="flex items-center justify-between">
              <button
                onClick={() => setPaginaHistorico(Math.max(0, paginaHistorico - 1))}
                disabled={paginaHistorico === 0}
                className="flex items-center gap-1 px-3 py-1.5 text-sm font-medium text-[#A8552E] disabled:text-gray-300 disabled:cursor-not-allowed"
              >
                <ChevronLeft className="w-4 h-4" />
                Anterior
              </button>
              <span className="text-xs text-gray-600">
                Página {paginaHistorico + 1} de {totalPaginas}
              </span>
              <button
                onClick={() => setPaginaHistorico(Math.min(totalPaginas - 1, paginaHistorico + 1))}
                disabled={paginaHistorico === totalPaginas - 1}
                className="flex items-center gap-1 px-3 py-1.5 text-sm font-medium text-[#A8552E] disabled:text-gray-300 disabled:cursor-not-allowed"
              >
                Siguiente
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          ) : null;
        })()}
      </div>
    </div>
  );
}
