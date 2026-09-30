import { useState } from 'react';
import { Bar, BarChart, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { SalesLineRow } from '../../target/commercial';
import { errorMessage } from '../../target/messages';
import { agregarDiasAFecha, getTodayDate } from '../../utils/dateUtils';
import { formatoPesos } from './helpers';
import { useSalesLines } from './useCommercial';

type Periodo = 'semana' | 'mes' | 'personalizado';
const COLORES = ['#A8552E', '#D4A574', '#8A6A2E', '#E8D4C0', '#6B7A4E', '#C9A27E', '#5C4A32', '#F5E6D3'];

function inicioSemana(fecha: string): string {
  const [a, m, d] = fecha.split('-').map(Number);
  const dia = new Date(a, m - 1, d).getDay();
  return agregarDiasAFecha(fecha, -(dia === 0 ? 6 : dia - 1));
}
const inicioMes = (fecha: string) => `${fecha.slice(0, 8)}01`;
const diasEntre = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000) + 1;

/** Presentation-only sums over report_sales_line rows (delivered sales; plan §4 allows exactly this). */
function resumen(rows: SalesLineRow[]) {
  return {
    entregas: new Set(rows.map((r) => r.pedido_id)).size,
    monto: rows.reduce((s, r) => s + r.subtotal, 0),
    unidades: rows.reduce((s, r) => s + r.cantidad, 0),
  };
}

/** Sales dashboard (F27-C): report_sales_line only (business date = delivery date). No pricing or status rule here. */
export function DashboardPedidos() {
  const hoy = getTodayDate();
  const [periodo, setPeriodo] = useState<Periodo>('semana');
  const [desde, setDesde] = useState(agregarDiasAFecha(hoy, -1));
  const [hasta, setHasta] = useState(agregarDiasAFecha(hoy, -1));

  let inicio = inicioSemana(hoy);
  let fin = hoy;
  if (periodo === 'mes') inicio = inicioMes(hoy);
  if (periodo === 'personalizado') { inicio = desde; fin = hasta; }
  const largo = diasEntre(inicio, fin);
  const compFin = agregarDiasAFecha(inicio, -1);
  const compInicio = agregarDiasAFecha(compFin, -(largo - 1));
  const seisSemanasDesde = agregarDiasAFecha(inicioSemana(hoy), -35);

  const actual = useSalesLines(inicio, fin);
  const comparacion = useSalesLines(compInicio, compFin);
  const semanas = useSalesLines(seisSemanasDesde, hoy);
  const error = actual.error ?? comparacion.error ?? semanas.error;

  const a = resumen(actual.data ?? []);
  const b = resumen(comparacion.data ?? []);
  const variacion = (x: number, y: number) => (y === 0 ? 0 : ((x - y) / y) * 100);

  const productos = [...new Set((semanas.data ?? []).map((r) => r.producto_nombre))];
  const datosGrafico = Array.from({ length: 6 }, (_, i) => {
    const ini = agregarDiasAFecha(seisSemanasDesde, i * 7);
    const finSem = agregarDiasAFecha(ini, 6);
    const fila: Record<string, string | number> = { semana: `${ini.slice(8, 10)}/${ini.slice(5, 7)}` };
    for (const p of productos) fila[p] = 0;
    for (const r of semanas.data ?? []) if (r.business_date >= ini && r.business_date <= finSem) fila[r.producto_nombre] = Number(fila[r.producto_nombre]) + r.cantidad;
    return fila;
  });

  const Card = ({ label, valor, anterior, cambio }: { label: string; valor: string; anterior: string; cambio: number }) => (
    <div className="bg-white rounded-lg p-4 border border-amber-200">
      <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-2">{label}</p>
      <p className="text-3xl font-bold text-amber-900">{valor}</p>
      <p className="text-xs text-gray-500 mt-1">vs {anterior}</p>
      {cambio !== 0 && (
        <p className={`text-sm font-semibold mt-2 ${cambio > 0 ? 'text-green-600' : 'text-red-600'}`}>{cambio > 0 ? '↑' : '↓'} {Math.abs(cambio).toFixed(1)}%</p>
      )}
    </div>
  );
  const boton = (p: Periodo, label: string) => (
    <button onClick={() => setPeriodo(p)}
      className={`px-4 py-2 text-sm font-medium rounded transition ${periodo === p ? 'bg-[#A8552E] text-white' : 'bg-white border border-[#D8CDB0] text-[#2C2419]'}`}>
      {label}
    </button>
  );

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {boton('semana', 'Semana')}
          {boton('mes', 'Mes')}
          {boton('personalizado', 'Período personalizado')}
        </div>
        {periodo === 'personalizado' && (
          <div className="grid grid-cols-2 gap-3 bg-amber-50 rounded-lg p-4 border border-amber-200">
            <label className="text-xs font-semibold text-gray-700">Desde
              <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} className="w-full px-3 py-2 border border-amber-300 rounded text-sm mt-1" />
            </label>
            <label className="text-xs font-semibold text-gray-700">Hasta
              <input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} className="w-full px-3 py-2 border border-amber-300 rounded text-sm mt-1" />
            </label>
          </div>
        )}
      </div>

      {error ? (
        <div className="bg-[#FCE4E4] border border-[#E4B0B0] text-[#A32D2D] text-sm px-4 py-3 rounded-lg">{errorMessage(error)}</div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
          <div className="lg:col-span-3 grid grid-cols-2 md:grid-cols-3 gap-3 content-start">
            <Card label="Pedidos entregados" valor={String(a.entregas)} anterior={String(b.entregas)} cambio={variacion(a.entregas, b.entregas)} />
            <Card label="Monto vendido" valor={formatoPesos(a.monto)} anterior={formatoPesos(b.monto)} cambio={variacion(a.monto, b.monto)} />
            <Card label="Unidades" valor={a.unidades.toLocaleString('es-AR')} anterior={b.unidades.toLocaleString('es-AR')} cambio={variacion(a.unidades, b.unidades)} />
          </div>
          <div className="lg:col-span-2 bg-white rounded-lg p-3 border border-amber-200 flex flex-col">
            <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-4">Últimas 6 semanas (unidades entregadas)</p>
            {productos.length === 0 ? (
              <p className="text-sm text-gray-500">Sin entregas en las últimas 6 semanas.</p>
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={datosGrafico} margin={{ top: 5, right: 5, left: 0, bottom: 20 }}>
                  <XAxis dataKey="semana" tick={{ fontSize: 11 }} />
                  <YAxis hide />
                  <Tooltip formatter={(v) => Number(v ?? 0).toLocaleString('es-AR')} />
                  <Legend />
                  {productos.map((p, i) => <Bar key={p} dataKey={p} stackId="a" fill={COLORES[i % COLORES.length]} />)}
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
