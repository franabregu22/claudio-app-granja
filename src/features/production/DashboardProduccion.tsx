import { AlertTriangle, TrendingUp, TrendingDown } from 'lucide-react';
import type { Produccion, Lote } from '../../types/domain';
import {
  calcularMetricasHoy,
  calcularMetricasSemana,
  calcularMetricasMes,
  calcularPosturaPorGalpon,
  generarAlertas,
  calcularUltimas4Semanas,
  type Alerta,
  type SemanaTendencia,
} from './produccionHelpers';

interface DashboardProduccionProps {
  producciones: Produccion[];
  lotes: Lote[];
  periodo: 'hoy' | 'semana' | 'mes' | 'ultimas4';
}

function formatoPesos(num: number): string {
  return new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'ARS',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(num);
}

function obtenerDiasDelMes(fecha: Date): number {
  return new Date(fecha.getFullYear(), fecha.getMonth() + 1, 0).getDate();
}

export function DashboardProduccion({ producciones, lotes, periodo }: DashboardProduccionProps) {
  const hoy = new Date();
  const hoyStr = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}-${String(hoy.getDate()).padStart(2, '0')}`;

  const ayer = new Date(hoy);
  ayer.setDate(ayer.getDate() - 1);
  const ayerStr = `${ayer.getFullYear()}-${String(ayer.getMonth() + 1).padStart(2, '0')}-${String(ayer.getDate()).padStart(2, '0')}`;

  // Semana
  const inicioSemanaActual = new Date(hoy);
  inicioSemanaActual.setDate(hoy.getDate() - hoy.getDay() + (hoy.getDay() === 0 ? -6 : 1));
  const inicioSemanaActualStr = `${inicioSemanaActual.getFullYear()}-${String(inicioSemanaActual.getMonth() + 1).padStart(2, '0')}-${String(inicioSemanaActual.getDate()).padStart(2, '0')}`;

  const inicioSemanaPasada = new Date(inicioSemanaActual);
  inicioSemanaPasada.setDate(inicioSemanaPasada.getDate() - 7);
  const inicioSemanaPasadaStr = `${inicioSemanaPasada.getFullYear()}-${String(inicioSemanaPasada.getMonth() + 1).padStart(2, '0')}-${String(inicioSemanaPasada.getDate()).padStart(2, '0')}`;

  const finSemanaPasadaStr = `${inicioSemanaPasada.getFullYear()}-${String(inicioSemanaPasada.getMonth() + 1).padStart(2, '0')}-${String(new Date(inicioSemanaPasada.getTime() + 6 * 24 * 60 * 60 * 1000).getDate()).padStart(2, '0')}`;

  // Mes
  const inicioMesActual = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
  const inicioMesActualStr = `${inicioMesActual.getFullYear()}-${String(inicioMesActual.getMonth() + 1).padStart(2, '0')}-01`;

  const inicioMesPasado = new Date(inicioMesActual);
  inicioMesPasado.setMonth(inicioMesPasado.getMonth() - 1);
  const inicioMesPasadoStr = `${inicioMesPasado.getFullYear()}-${String(inicioMesPasado.getMonth() + 1).padStart(2, '0')}-01`;

  const finMesPasadoStr = `${inicioMesPasado.getFullYear()}-${String(inicioMesPasado.getMonth() + 1).padStart(2, '0')}-${obtenerDiasDelMes(inicioMesPasado)}`;

  const finMesActualStr = hoyStr;

  // Calcular métricas
  const metricasHoy = calcularMetricasHoy(producciones, lotes, hoyStr, ayerStr);
  const metricasSemana = calcularMetricasSemana(
    producciones,
    lotes,
    inicioSemanaActualStr,
    inicioSemanaPasadaStr,
    hoyStr,
    finSemanaPasadaStr
  );
  const metricasMes = calcularMetricasMes(
    producciones,
    inicioMesActualStr,
    inicioMesPasadoStr,
    finMesActualStr,
    finMesPasadoStr
  );
  const posturaPorGalpon = calcularPosturaPorGalpon(producciones, lotes, hoyStr);
  const alertas = generarAlertas(producciones, lotes, hoyStr, ayerStr);
  const ultimas4Semanas = calcularUltimas4Semanas(producciones, lotes, hoyStr);

  return (
    <div className="space-y-6">
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

      {/* HOY */}
      {periodo === 'hoy' && (
        <div>
          <h3 className="text-lg font-bold text-amber-900 mb-3">HOY</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="bg-white border border-amber-200 rounded-lg p-4">
              <p className="text-xs text-gray-600 font-semibold uppercase tracking-wide mb-1">Huevos</p>
              <p className="text-2xl font-bold text-amber-900">{metricasHoy.huevos_totales}</p>
              {metricasHoy.variacion_vs_ayer !== 0 && (
                <p className={`text-xs font-semibold flex items-center gap-1 mt-1 ${metricasHoy.variacion_vs_ayer > 0 ? 'text-green-600' : 'text-red-600'}`}>
                  {metricasHoy.variacion_vs_ayer > 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                  {Math.abs(metricasHoy.variacion_vs_ayer).toFixed(1)}% vs ayer
                </p>
              )}
            </div>
            <div className="bg-white border border-amber-200 rounded-lg p-4">
              <p className="text-xs text-gray-600 font-semibold uppercase tracking-wide mb-1">Mortandad</p>
              <p className="text-2xl font-bold text-amber-900">{metricasHoy.mortandad_total}</p>
              <p className="text-xs text-gray-500 mt-1">aves</p>
            </div>
            <div className="bg-white border border-amber-200 rounded-lg p-4">
              <p className="text-xs text-gray-600 font-semibold uppercase tracking-wide mb-1">Postura promedio</p>
              <p className="text-2xl font-bold text-amber-900">{metricasHoy.postura_promedio.toFixed(1)}%</p>
            </div>
            <div className="bg-white border border-amber-200 rounded-lg p-4">
              <p className="text-xs text-gray-600 font-semibold uppercase tracking-wide mb-1">Lotes activos</p>
              <p className="text-2xl font-bold text-amber-900">{lotes.filter((l) => !l.fecha_salida).length}</p>
            </div>
          </div>
          <div className="mt-6">
            <h3 className="text-lg font-bold text-amber-900 mb-3">POSTURA POR GALPÓN</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
              {posturaPorGalpon.map((gal) => (
                <div key={gal.galpon} className="bg-white border border-amber-200 rounded-lg p-4">
                  <p className="text-sm font-bold text-amber-900">{gal.galpon}</p>
                  <p className="text-3xl font-bold text-amber-700 mt-2">{gal.postura}%</p>
                  <div className="space-y-1 mt-3 text-xs text-gray-600">
                    <p>Huevos: {gal.huevos_totales}</p>
                    <p>Mortandad: {gal.mortandad}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* SEMANA */}
      {periodo === 'semana' && (
        <div>
          <h3 className="text-lg font-bold text-amber-900 mb-3">SEMANA ACTUAL</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="bg-white border border-amber-200 rounded-lg p-4">
              <p className="text-xs text-gray-600 font-semibold uppercase tracking-wide mb-1">Huevos</p>
              <p className="text-2xl font-bold text-amber-900">{metricasSemana.actual.huevos_totales}</p>
            </div>
            <div className="bg-white border border-amber-200 rounded-lg p-4">
              <p className="text-xs text-gray-600 font-semibold uppercase tracking-wide mb-1">Promedio diario</p>
              <p className="text-2xl font-bold text-amber-900">{metricasSemana.actual.promedio_diario}</p>
              <p className="text-xs text-gray-500 mt-1">huevos/día</p>
            </div>
            <div className="bg-white border border-amber-200 rounded-lg p-4">
              <p className="text-xs text-gray-600 font-semibold uppercase tracking-wide mb-1">Mortandad</p>
              <p className="text-2xl font-bold text-amber-900">{metricasSemana.actual.mortandad_total}</p>
            </div>
            <div className="bg-white border border-amber-200 rounded-lg p-4">
              <p className="text-xs text-gray-600 font-semibold uppercase tracking-wide mb-1">Días registrados</p>
              <p className="text-2xl font-bold text-amber-900">{metricasSemana.actual.dias}</p>
            </div>
          </div>
        </div>
      )}

      {/* MES */}
      {periodo === 'mes' && (
        <div>
          <h3 className="text-lg font-bold text-amber-900 mb-3">MES ACTUAL</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="bg-white border border-amber-200 rounded-lg p-4">
              <p className="text-xs text-gray-600 font-semibold uppercase tracking-wide mb-1">Huevos</p>
              <p className="text-2xl font-bold text-amber-900">{metricasMes.actual.huevos_totales}</p>
            </div>
            <div className="bg-white border border-amber-200 rounded-lg p-4">
              <p className="text-xs text-gray-600 font-semibold uppercase tracking-wide mb-1">Promedio diario</p>
              <p className="text-2xl font-bold text-amber-900">{metricasMes.actual.promedio_diario}</p>
              <p className="text-xs text-gray-500 mt-1">huevos/día</p>
            </div>
            <div className="bg-white border border-amber-200 rounded-lg p-4">
              <p className="text-xs text-gray-600 font-semibold uppercase tracking-wide mb-1">Mortandad</p>
              <p className="text-2xl font-bold text-amber-900">{metricasMes.actual.mortandad_total}</p>
            </div>
            <div className="bg-white border border-amber-200 rounded-lg p-4">
              <p className="text-xs text-gray-600 font-semibold uppercase tracking-wide mb-1">Días registrados</p>
              <p className="text-2xl font-bold text-amber-900">{metricasMes.actual.dias}</p>
            </div>
          </div>
        </div>
      )}

      {/* ÚLTIMAS 4 SEMANAS */}
      {periodo === 'ultimas4' && (
        <div>
          <h3 className="text-lg font-bold text-amber-900 mb-3">ÚLTIMAS 4 SEMANAS</h3>
          <div className="bg-white border border-amber-200 rounded-lg overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-amber-50 border-b border-amber-200">
                <tr>
                  <th className="px-4 py-2 text-left font-semibold text-amber-900">Semana</th>
                  <th className="px-4 py-2 text-right font-semibold text-amber-900">Huevos</th>
                  <th className="px-4 py-2 text-right font-semibold text-amber-900">Postura</th>
                  <th className="px-4 py-2 text-right font-semibold text-amber-900">Mortandad</th>
                </tr>
              </thead>
              <tbody>
                {ultimas4Semanas.map((semana, i) => (
                  <tr key={i} className="border-b border-amber-100 hover:bg-amber-50">
                    <td className="px-4 py-2 text-gray-700">{semana.semana}</td>
                    <td className="px-4 py-2 text-right font-semibold text-amber-900">{semana.huevos}</td>
                    <td className="px-4 py-2 text-right font-semibold text-amber-900">{semana.postura_promedio}%</td>
                    <td className="px-4 py-2 text-right text-gray-700">{semana.mortandad}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
