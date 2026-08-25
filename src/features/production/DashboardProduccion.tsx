import { useState, useEffect } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, Edit2 } from 'lucide-react';
import type { Produccion, Lote, RecuentoLote } from '../../types/domain';
import {
  calcularMetricasPeriodo,
  calcularMetricasPorGalpon,
  generarAlertas,
  calcularSparklineUltimos7Dias,
  type MetricaPeriodo,
} from './produccionCalculos';

interface DashboardProduccionProps {
  producciones: Produccion[];
  lotes: Lote[];
  recuentos: RecuentoLote[];
  onEditar?: (id: string) => void;
}

type Periodo = 'ayer' | 'semana' | 'mes' | 'personalizado';

function formatearFecha(fecha: string): string {
  const [año, mes, día] = fecha.split('-');
  return `${día}/${mes}/${año}`;
}

function agregarDias(fecha: string, dias: number): string {
  const d = new Date(fecha);
  d.setDate(d.getDate() + dias);
  return d.toISOString().split('T')[0];
}

function obtenerInicioSemana(fecha: string): string {
  const d = new Date(fecha);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(d.setDate(diff)).toISOString().split('T')[0];
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
  const [fechaPersonalizadaInicio, setFechaPersonalizadaInicio] = useState<string>(ayer);
  const [fechaPersonalizadaFin, setFechaPersonalizadaFin] = useState<string>(ayer);
  const [fechaComparacionInicio, setFechaComparacionInicio] = useState<string>(agregarDias(ayer, -1));
  const [fechaComparacionFin, setFechaComparacionFin] = useState<string>(agregarDias(ayer, -1));
  const [paginaHistorico, setPaginaHistorico] = useState(0);

  const ITEMS_POR_PAGINA = 15;

  // Auto-actualizar fechas de comparación según período
  useEffect(() => {
    if (periodo === 'ayer') {
      const dosYasAtrás = agregarDias(ayer, -1);
      setFechaComparacionInicio(dosYasAtrás);
      setFechaComparacionFin(dosYasAtrás);
    } else if (periodo === 'semana') {
      const inicioSemana = obtenerInicioSemana(ayer);
      const diasEnSemana = calcularDiasEntre(inicioSemana, ayer);
      const finSemanaPasada = agregarDias(inicioSemana, -1);
      const inicioSemanaPasada = agregarDias(finSemanaPasada, -(diasEnSemana - 1));
      setFechaComparacionInicio(inicioSemanaPasada);
      setFechaComparacionFin(finSemanaPasada);
    } else if (periodo === 'mes') {
      const inicioMes = obtenerInicioMes(ayer);
      const diasEnMes = calcularDiasEntre(inicioMes, ayer);
      const finMesPasado = agregarDias(inicioMes, -1);
      const inicioMesPasado = agregarDias(finMesPasado, -(diasEnMes - 1));
      setFechaComparacionInicio(inicioMesPasado);
      setFechaComparacionFin(finMesPasado);
    }
  }, [periodo, ayer]);

  // Calcular rangos de fechas según período (usando ayer como referencia, no hoy)
  let fechaInicio = ayer;
  let fechaFin = ayer;
  let fechaInicioComparacion = fechaComparacionInicio;
  let fechaFinComparacion = fechaComparacionFin;

  if (periodo === 'ayer') {
    fechaInicio = ayer;
    fechaFin = ayer;
  } else if (periodo === 'semana') {
    fechaInicio = obtenerInicioSemana(ayer);
    fechaFin = ayer;
  } else if (periodo === 'mes') {
    fechaInicio = obtenerInicioMes(ayer);
    fechaFin = ayer;
  } else if (periodo === 'personalizado') {
    fechaInicio = fechaPersonalizadaInicio;
    fechaFin = fechaPersonalizadaFin;
  }

  const metricasActuales = calcularMetricasPeriodo(
    producciones,
    lotes,
    recuentos,
    fechaInicio,
    fechaFin
  );

  const metricasComparacion = calcularMetricasPeriodo(
    producciones,
    lotes,
    recuentos,
    fechaInicioComparacion,
    fechaFinComparacion
  );

  // Las métricas por galpón se calculan para el último día del período seleccionado
  const metricasPorGalpon = calcularMetricasPorGalpon(producciones, lotes, recuentos, fechaFin);
  // Las alertas son para ayer (no incluir hoy porque la info no está completa)
  const alertas = generarAlertas(producciones, lotes, recuentos, ayer);
  // El sparkline es para los últimos 7 días hasta ayer
  const sparklineData = calcularSparklineUltimos7Dias(producciones, lotes, recuentos, ayer);

  // Histórico de producciones paginado
  const historico = producciones
    .sort((a, b) => b.fecha.localeCompare(a.fecha))
    .slice(paginaHistorico * ITEMS_POR_PAGINA, (paginaHistorico + 1) * ITEMS_POR_PAGINA);

  const totalPaginas = Math.ceil(producciones.length / ITEMS_POR_PAGINA);

  const calculoVariacion = (actual: number, anterior: number): number => {
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

  return (
    <div className="space-y-6 pb-20">
      {/* Selector de período */}
      <div className="space-y-4">
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
          <button
            onClick={() => setPeriodo('personalizado')}
            className={`px-4 py-2 text-sm font-medium rounded transition ${
              periodo === 'personalizado'
                ? 'bg-[#A8552E] text-white'
                : 'bg-white border border-[#D8CDB0] text-[#2C2419]'
            }`}
          >
            Período personalizado
          </button>
        </div>

        {/* Período personalizado */}
        {periodo === 'personalizado' && (
          <div className="space-y-3 bg-amber-50 rounded-lg p-4 border border-amber-200">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-semibold text-gray-700 block mb-1">Desde</label>
                <input
                  type="date"
                  value={fechaPersonalizadaInicio}
                  onChange={(e) => setFechaPersonalizadaInicio(e.target.value)}
                  className="w-full px-3 py-2 border border-amber-300 rounded text-sm"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-700 block mb-1">Hasta</label>
                <input
                  type="date"
                  value={fechaPersonalizadaFin}
                  onChange={(e) => setFechaPersonalizadaFin(e.target.value)}
                  className="w-full px-3 py-2 border border-amber-300 rounded text-sm"
                />
              </div>
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-700 block mb-2">Comparar con</label>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-gray-600 block mb-1">Desde</label>
                  <input
                    type="date"
                    value={fechaComparacionInicio}
                    onChange={(e) => setFechaComparacionInicio(e.target.value)}
                    className="w-full px-3 py-2 border border-amber-300 rounded text-sm"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-600 block mb-1">Hasta</label>
                  <input
                    type="date"
                    value={fechaComparacionFin}
                    onChange={(e) => setFechaComparacionFin(e.target.value)}
                    className="w-full px-3 py-2 border border-amber-300 rounded text-sm"
                  />
                </div>
              </div>
            </div>
          </div>
        )}
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

      {/* Métricas principales - Orden específica del usuario */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <CardMetrica
          label="Huevos totales"
          valor={metricasActuales.huevos_totales}
          comparacion={calculoVariacion(metricasActuales.huevos_totales, metricasComparacion.huevos_totales)}
          unidad=""
        />
        <CardMetrica
          label="Postura promedio"
          valor={metricasActuales.postura_promedio.toFixed(1)}
          comparacion={calculoVariacion(metricasActuales.postura_promedio, metricasComparacion.postura_promedio)}
          unidad="%"
          alerta={metricasActuales.postura_promedio < 80}
        />
        <CardMetrica
          label="Mortandad"
          valor={metricasActuales.mortandad_total}
          comparacion={calculoVariacion(metricasActuales.mortandad_total, metricasComparacion.mortandad_total)}
          unidad="aves"
        />
        <CardMetrica
          label="Huevos cachados"
          valor={metricasActuales.huevos_cachados}
          comparacion={calculoVariacion(metricasActuales.huevos_cachados, metricasComparacion.huevos_cachados)}
          unidad=""
        />
        <CardMetrica
          label="% Cachados"
          valor={metricasActuales.ratio_cachados.toFixed(1)}
          unidad="%"
        />
        <CardMetrica
          label="Días registrados"
          valor={metricasActuales.dias}
          unidad=""
        />
      </div>

      {/* Postura por galpón */}
      {metricasPorGalpon.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-bold text-amber-900 uppercase tracking-wide">Postura por galpón</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {metricasPorGalpon.map((gal) => (
              <div key={gal.galpon} className="bg-white rounded-lg p-4 border border-amber-200">
                <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-2">
                  {gal.galpon}
                </p>
                <p
                  className={`text-2xl font-bold ${
                    gal.postura < 80 ? 'text-red-600' : 'text-amber-900'
                  }`}
                >
                  {gal.postura.toFixed(1)}%
                </p>
                <div className="space-y-0.5 mt-2 text-xs text-gray-600">
                  <p>Gallinas: {gal.galinasActuales}</p>
                  <p>Huevos sanos: {gal.huevos_sanos}</p>
                  <p>Mortandad: {gal.mortandad}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Huevos por galpón */}
      {metricasPorGalpon.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-bold text-amber-900 uppercase tracking-wide">Huevos por galpón</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {metricasPorGalpon.map((gal) => (
              <div key={`huevos-${gal.galpon}`} className="bg-white rounded-lg p-4 border border-amber-200">
                <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-2">
                  {gal.galpon}
                </p>
                <p className="text-2xl font-bold text-amber-900">{gal.huevos_totales}</p>
                <div className="space-y-0.5 mt-2 text-xs text-gray-600">
                  <p>Sanos: {gal.huevos_sanos}</p>
                  <p>Cachados: {gal.huevos_cachados}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Sparkline - Últimos 7 días */}
      {sparklineData.length > 0 && (
        <div className="bg-white rounded-lg p-4 border border-amber-200">
          <p className="text-xs font-bold text-amber-900 uppercase tracking-wide mb-3">
            Postura - Últimos 7 días
          </p>
          <div className="flex items-end justify-between gap-2 h-20">
            {sparklineData.map((d, i) => (
              <div key={i} className="flex-1 flex flex-col items-center">
                <div
                  className="w-full bg-amber-300 rounded-t"
                  style={{
                    height: `${Math.max(d.postura, 10)}px`,
                    minHeight: '4px',
                  }}
                  title={`${d.postura.toFixed(1)}%`}
                />
                <p className="text-xs text-gray-500 mt-1">{d.fecha.slice(5)}</p>
              </div>
            ))}
          </div>
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
                <th className="px-4 py-2 text-right font-semibold text-amber-900">Mortandad</th>
                <th className="px-4 py-2 text-left font-semibold text-amber-900">Observaciones</th>
                {onEditar && <th className="px-4 py-2 text-center font-semibold text-amber-900">Acción</th>}
              </tr>
            </thead>
            <tbody>
              {historico.map((prod) => (
                <tr key={prod.id} className="border-b border-amber-100 hover:bg-amber-50">
                  <td className="px-4 py-2 text-gray-700">{formatearFecha(prod.fecha)}</td>
                  <td className="px-4 py-2 text-gray-700">{prod.galpon}</td>
                  <td className="px-4 py-2 text-right font-semibold text-amber-900">
                    {prod.huevos_sanos_mediodia +
                      prod.huevos_cachados_mediodia +
                      prod.huevos_sanos_tarde +
                      prod.huevos_cachados_tarde}
                  </td>
                  <td className="px-4 py-2 text-right text-gray-700">{prod.mortandad}</td>
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
              ))}
            </tbody>
          </table>
        </div>

        {/* Paginación */}
        {totalPaginas > 1 && (
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
        )}
      </div>
    </div>
  );
}
