import { useState, useEffect } from 'react';
import type { Pedido } from '../../types/domain';
import { getTodayDate, agregarDiasAFecha } from '../../utils/dateUtils';
import {
  calcularMetricasPeriodoPedidos,
  calcularVariacionPorcentaje,
  formatearPedidoResumen,
  calcularUltimas6Semanas,
  type MetricasPeriodoPedidos,
} from './pedidosCalculos';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Cell } from 'recharts';

interface DashboardPedidosProps {
  pedidos: Pedido[];
  onEditar?: (pedido: Pedido) => void;
}

type Periodo = 'semana' | 'mes' | 'personalizado';

// Parse date string YYYY-MM-DD, create Date object, then convert back without timezone issues
function parseLocalDate(fechaString: string): Date {
  const [año, mes, día] = fechaString.split('-').map(Number);
  return new Date(año, mes - 1, día);
}

function agregarDias(fecha: string, dias: number): string {
  return agregarDiasAFecha(fecha, dias);
}

function obtenerInicioSemana(fecha: string): string {
  const d = parseLocalDate(fecha);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);

  const año = d.getFullYear();
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const día = String(d.getDate()).padStart(2, '0');
  return `${año}-${mes}-${día}`;
}

function obtenerInicioMes(fecha: string): string {
  const [año, mes] = fecha.split('-');
  return `${año}-${mes}-01`;
}

function calcularDiasEntre(fechaInicio: string, fechaFin: string): number {
  const inicio = parseLocalDate(fechaInicio);
  const fin = parseLocalDate(fechaFin);
  return Math.floor((fin.getTime() - inicio.getTime()) / (1000 * 60 * 60 * 24)) + 1;
}

function formatearFecha(fecha: string): string {
  const [año, mes, día] = fecha.split('-');
  return `${día}/${mes}/${año}`;
}

export function DashboardPedidos({ pedidos, onEditar }: DashboardPedidosProps) {
  const hoy = getTodayDate();
  const ayer = agregarDias(hoy, -1);

  const [periodo, setPeriodo] = useState<Periodo>('semana');
  const [fechaPersonalizadaInicio, setFechaPersonalizadaInicio] = useState<string>(ayer);
  const [fechaPersonalizadaFin, setFechaPersonalizadaFin] = useState<string>(ayer);
  const [fechaComparacionInicio, setFechaComparacionInicio] = useState<string>(agregarDias(ayer, -1));
  const [fechaComparacionFin, setFechaComparacionFin] = useState<string>(agregarDias(ayer, -1));

  // Auto-actualizar fechas de comparación según período
  useEffect(() => {
    if (periodo === 'semana') {
      const inicioSemana = obtenerInicioSemana(hoy);
      // Restar exactamente 7 días para obtener la semana anterior (mismos días de la semana)
      setFechaComparacionInicio(agregarDias(inicioSemana, -7));
      setFechaComparacionFin(agregarDias(hoy, -7));
    } else if (periodo === 'mes') {
      const inicioMes = obtenerInicioMes(hoy);
      const diasEnMes = calcularDiasEntre(inicioMes, hoy);
      const finMesPasado = agregarDias(inicioMes, -1);
      const inicioMesPasado = agregarDias(finMesPasado, -(diasEnMes - 1));
      setFechaComparacionInicio(inicioMesPasado);
      setFechaComparacionFin(finMesPasado);
    }
  }, [periodo, hoy]);

  // Calcular rangos de fechas según período
  let fechaInicio = obtenerInicioSemana(hoy);
  let fechaFin = hoy;
  let fechaInicioComparacion = fechaComparacionInicio;
  let fechaFinComparacion = fechaComparacionFin;

  if (periodo === 'semana') {
    fechaInicio = obtenerInicioSemana(hoy);
    fechaFin = hoy;
  } else if (periodo === 'mes') {
    fechaInicio = obtenerInicioMes(hoy);
    fechaFin = hoy;
  } else if (periodo === 'personalizado') {
    fechaInicio = fechaPersonalizadaInicio;
    fechaFin = fechaPersonalizadaFin;
  }

  const metricasActuales = calcularMetricasPeriodoPedidos(pedidos, fechaInicio, fechaFin);
  const metricasComparacion = calcularMetricasPeriodoPedidos(
    pedidos,
    fechaInicioComparacion,
    fechaFinComparacion
  );

  const calculoVariacion = (actual: number, anterior: number): number => {
    if (anterior === 0) return 0;
    return ((actual - anterior) / anterior) * 100;
  };

  const CardMetrica = ({ label, valor, valorAnterior, comparacion, unidad }: any) => (
    <div className="bg-white rounded-lg p-4 border border-amber-200">
      <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-2">{label}</p>
      <div className="flex items-baseline gap-2">
        <p className="text-3xl font-bold text-amber-900">
          {valor}{unidad && <span className="text-lg ml-1">{unidad}</span>}
        </p>
      </div>
      {valorAnterior !== undefined && (
        <p className="text-xs text-gray-500 mt-1">vs {valorAnterior}{unidad}</p>
      )}
      {comparacion !== undefined && comparacion !== 0 && (
        <p className={`text-sm font-semibold mt-2 ${comparacion > 0 ? 'text-green-600' : 'text-red-600'}`}>
          {comparacion > 0 ? '↑' : '↓'} {Math.abs(comparacion).toFixed(1)}%
        </p>
      )}
    </div>
  );

  const datosGrafico = calcularUltimas6Semanas(pedidos);

  const coloresCategoria = {
    xl: '#A8552E',
    n1: '#D4A574',
    n2: '#E8D4C0',
    n3: '#F5E6D3',
    docena: '#FFE8D6',
  };

  return (
    <div className="space-y-6 pb-20">
      {/* Selector de período */}
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">
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

      {/* Layout con métricas a la izquierda y gráfico a la derecha */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        {/* Métricas principales - 3 columnas a la izquierda */}
        <div className="lg:col-span-3 space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <CardMetrica
              label="Pedidos despachados"
              valor={metricasActuales.pedidos_despachados}
              valorAnterior={metricasComparacion.pedidos_despachados}
              comparacion={calculoVariacion(metricasActuales.pedidos_despachados, metricasComparacion.pedidos_despachados)}
            />
            <CardMetrica
              label="Total de huevos"
              valor={metricasActuales.total_huevos}
              valorAnterior={metricasComparacion.total_huevos}
              comparacion={calculoVariacion(metricasActuales.total_huevos, metricasComparacion.total_huevos)}
            />
          </div>
        </div>

        {/* Gráfico de barras apiladas - columna angosta a la derecha */}
        <div className="lg:col-span-2 bg-white rounded-lg p-3 border border-amber-200 flex flex-col">
          <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-4">Últimas 6 semanas</p>
          <ResponsiveContainer width="100%" height={350}>
            <BarChart data={datosGrafico} margin={{ top: 5, right: 5, left: 0, bottom: 40 }}>
              <XAxis dataKey="semana" angle={-45} textAnchor="end" height={80} tick={{ fontSize: 11 }} />
              <YAxis hide />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#2C2419',
                  border: '1px solid #A8552E',
                  color: '#FAF6EE'
                }}
                labelStyle={{ color: '#FAF6EE' }}
                formatter={(value) => (value ?? 0).toLocaleString('es-AR')}
              />
              <Legend wrapperStyle={{ paddingTop: '10px' }} />
              <Bar dataKey="xl" stackId="a" fill={coloresCategoria.xl} name="XL" />
              <Bar dataKey="n1" stackId="a" fill={coloresCategoria.n1} name="N1" />
              <Bar dataKey="n2" stackId="a" fill={coloresCategoria.n2} name="N2" />
              <Bar dataKey="n3" stackId="a" fill={coloresCategoria.n3} name="N3" />
              <Bar dataKey="docena" stackId="a" fill={coloresCategoria.docena} name="Docena" />
            </BarChart>
          </ResponsiveContainer>
          <p className="text-xs text-gray-600 mt-3">**Valores en unidades</p>
        </div>
      </div>

    </div>
  );
}
