import { useState } from 'react';
import { Bar, CartesianGrid, ComposedChart, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { errorMessage } from '../../target/messages';
import { agregarDiasAFecha, getTodayDate } from '../../utils/dateUtils';
import type { Rango } from '../pedidos/periodos';
import {
  deGalpon, escalaPostura, rangosDashboard, ticksRedondos, seriePostura, serieHuevosMes, totalesDe, variacionPct,
} from './indicadoresProduccion';
import { useFlockDaysRange } from './useProduction';

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
/** Sheds in a fixed order (by name) → a fixed hue each (validated categorical slots 1–4…; never cycled by rank). */
const COLORES_GALPON = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
const TINTA = '#2C2419';
const ACENTO = '#A8552E';
const REFERENCIA = '#B8AC94';
const VENTANAS = [30, 60, 90] as const;
type Periodo = 'semana' | 'mes';

const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
/** «1 nov» (owner 2026-11-17: never dd/mm). */
const fechaCorta = (f: string) => `${Number(f.slice(8, 10))} ${MESES_CORTOS[Number(f.slice(5, 7)) - 1]}`;
const rangoTexto = (r: Rango) => (r.desde === r.hasta ? fechaCorta(r.desde) : `${fechaCorta(r.desde)} – ${fechaCorta(r.hasta)}`);
const entero = (n: number) => n.toLocaleString('es-AR');
const pct1 = (n: number | null) => (n === null ? '—' : `${n.toLocaleString('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`);

const botonClase = (activo: boolean, chico = false) =>
  `${chico ? 'px-2.5 py-1 text-xs' : 'px-4 py-2 text-sm'} font-medium rounded transition ${activo ? 'bg-[#A8552E] text-white' : 'bg-white border border-[#D8CDB0] text-[#2C2419]'}`;

/** One indicator of the selected period: the value, what it is compared with and the change (green = good). */
function Tarjeta({ label, valor, anterior, cambio, unidad = '%', menosEsMejor = false, detalle, vacio }: {
  label: string; valor: string; anterior: string; cambio: number | null; unidad?: '%' | 'pp'; menosEsMejor?: boolean; detalle?: string;
  vacio: string | null;
}) {
  const bueno = cambio !== null && (menosEsMejor ? cambio < 0 : cambio > 0);
  return (
    <div className="bg-white rounded-lg p-4 border border-amber-200">
      <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-2">{label}</p>
      {vacio !== null ? (
        <><p className="text-3xl font-bold text-amber-900">—</p><p className="text-xs text-gray-500">{vacio}</p></>
      ) : (
        <>
          <p className="text-3xl font-bold text-amber-900">{valor}</p>
          {detalle && <p className="text-xs text-gray-500">{detalle}</p>}
          <p className="text-xs text-gray-500 mt-1">vs {anterior}</p>
          {cambio !== null && Math.abs(cambio) >= 0.05 && (
            <p className={`text-sm font-semibold mt-2 ${bueno ? 'text-green-600' : 'text-red-600'}`}>
              {cambio > 0 ? '↑' : '↓'} {Math.abs(cambio).toLocaleString('es-AR', { maximumFractionDigits: 1 })}{unidad === 'pp' ? ' pp' : '%'}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Dashboard → Producción (owner 2026-11-17): one glance on top — healthy eggs, broken eggs, laying % and mortality of the selected
 * period (this week / this month, closed days only: up to yesterday, against the same days of the previous period) for every shed or
 * one — and the evolution charts below. report_flock_day only; indicadoresProduccion.ts holds the rules.
 */
export function ProductionDashboard() {
  const hoy = getTodayDate();
  const { semana, mes, ayer } = rangosDashboard(hoy);
  const [periodo, setPeriodo] = useState<Periodo>('semana');
  const [galpon, setGalpon] = useState('');   // '' = todos
  const [ventana, setVentana] = useState<(typeof VENTANAS)[number]>(30);
  // one read covers every period: the previous month's 1st (or the previous week) and the longest chart window
  const desdeLectura = [agregarDiasAFecha(ayer, -89), mes?.anterior.desde ?? ayer, semana?.anterior.desde ?? ayer].sort()[0];
  const dias = useFlockDaysRange(desdeLectura, ayer);
  if (dias.isLoading) return <div className="flex items-center justify-center py-12"><p className="text-gray-500">Cargando dashboard…</p></div>;
  if (dias.error) return <p className="m-6 text-sm text-red-700">{errorMessage(dias.error)}</p>;
  const todas = dias.data ?? [];
  // the sheds in a fixed order (by name): the filter buttons and each shed's fixed hue
  const todosGalpones = [...new Set(todas.filter((d) => d.daily_production_id !== null).map((d) => d.shed_nombre))].sort((a, b) => a.localeCompare(b, 'es'));
  const filas = deGalpon(todas, galpon);

  // the cards: the selected period against the same days of the previous one
  const comp = periodo === 'semana' ? semana : mes;
  const a = comp ? totalesDe(filas, comp.actual) : null;
  const b = comp ? totalesDe(filas, comp.anterior) : null;
  const vacio = !comp ? 'Sin días cerrados todavía' : a?.dias === 0 ? 'Sin producción cargada' : null;
  const pp = (x: number | null, y: number | null) => (x === null || y === null ? null : x - y);

  // eggs per day of this month, against the previous month day by day
  const huevosMes = mes ? serieHuevosMes(filas, mes) : [];
  const ticksHuevos = ticksRedondos(Math.max(0, ...huevosMes.flatMap((p) => [p.sanos ?? 0, p.anterior ?? 0])));
  const mesNombre = MESES[Number(hoy.slice(5, 7)) - 1];
  const mesAnteriorNombre = mes ? MESES[Number(mes.anterior.desde.slice(5, 7)) - 1] : '';

  // laying % per day: the farm total and one line per shed (one line when a shed is selected)
  const galpones = galpon === '' ? todosGalpones : [galpon];
  const postura = seriePostura(filas, agregarDiasAFecha(ayer, -(ventana - 1)), ayer, galpones);
  const conTotal = galpon === '';
  const [yMin, yMax] = escalaPostura(postura, conTotal ? ['total', ...galpones] : galpones);
  const ticks = Array.from({ length: Math.floor((yMax - yMin) / 5) + 1 }, (_, i) => yMin + i * 5).filter((t, _i, arr) => arr.length <= 12 || t % 10 === 0);

  return (
    <div className="px-4 md:px-6 pt-6 pb-10 space-y-6">
      <div>
        <p className="text-xs font-semibold tracking-wide text-[#A8552E] uppercase">Dashboard</p>
        <h1 className="text-2xl font-bold text-[#2C2419] mt-1">Producción</h1>
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Período">
          <button type="button" onClick={() => setPeriodo('semana')} aria-pressed={periodo === 'semana'} className={botonClase(periodo === 'semana')}>Esta semana</button>
          <button type="button" onClick={() => setPeriodo('mes')} aria-pressed={periodo === 'mes'} className={botonClase(periodo === 'mes')}>Este mes</button>
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Galpón">
          {['', ...todosGalpones].map((g) => (
            <button key={g || 'todos'} type="button" onClick={() => setGalpon(g)} aria-pressed={galpon === g} className={botonClase(galpon === g, true)}>
              {g === '' ? 'Todos los galpones' : g}
            </button>
          ))}
        </div>
        <p className="text-xs text-gray-500">
          {comp ? <>Días cerrados <b>{rangoTexto(comp.actual)}</b> vs <b>{rangoTexto(comp.anterior)}</b> (hasta ayer; hoy está incompleto)</>
            : `${periodo === 'semana' ? 'La semana' : 'El mes'} todavía no tiene días cerrados (hoy está incompleto).`}
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Tarjeta label="Huevos sanos" vacio={vacio} valor={a ? entero(a.sanos) : ''} anterior={b ? entero(b.sanos) : ''}
          cambio={a && b ? variacionPct(a.sanos, b.sanos) : null} />
        <Tarjeta label="Huevos rotos" vacio={vacio} valor={a ? entero(a.rotos) : ''} anterior={b ? entero(b.rotos) : ''}
          detalle={a ? `${pct1(a.pctRotos)} del total` : undefined} cambio={a && b ? variacionPct(a.rotos, b.rotos) : null} menosEsMejor />
        <Tarjeta label="% de postura" vacio={vacio} valor={a ? pct1(a.postura) : ''} anterior={b ? pct1(b.postura) : ''}
          detalle={periodo === 'mes' ? 'acumulado del mes' : undefined} cambio={a && b ? pp(a.postura, b.postura) : null} unidad="pp" />
        <Tarjeta label="Mortandad" vacio={vacio} valor={a ? entero(a.muertes) : ''} anterior={b ? entero(b.muertes) : ''}
          detalle="aves muertas" cambio={a && b ? variacionPct(a.muertes, b.muertes) : null} menosEsMejor />
      </div>

      <div className="space-y-4">
        <h2 className="text-sm font-semibold text-[#8A6A2E] uppercase tracking-wide">Evolución</h2>
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <div className="bg-white rounded-lg p-3 border border-amber-200">
            <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-3">Huevos sanos por día · {mesNombre}</p>
            {!mes ? <p className="text-sm text-gray-500">Sin días cerrados todavía.</p> : (
              <ResponsiveContainer width="100%" height={300}>
                <ComposedChart data={huevosMes} margin={{ top: 5, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="#EEE8DA" />
                  <XAxis dataKey="dia" tick={{ fontSize: 11, fill: '#6B5D45' }} tickLine={false} axisLine={{ stroke: '#D8CDB0' }} interval="preserveStartEnd" />
                  <YAxis domain={[0, ticksHuevos[ticksHuevos.length - 1]]} ticks={ticksHuevos} tick={{ fontSize: 11, fill: '#6B5D45' }} tickLine={false} axisLine={false}
                    width={48} tickFormatter={(v: number) => entero(v)} />
                  <Tooltip cursor={{ fill: '#F5EEDF' }} content={({ active, payload }) => {
                    const p = active ? (payload?.[0]?.payload as (typeof huevosMes)[number] | undefined) : undefined;
                    if (!p) return null;
                    return (
                      <div className="rounded border border-[#E4DCC8] bg-white px-2 py-1 text-xs shadow">
                        <p><b>{fechaCorta(p.fecha)}</b>: {p.sanos === null ? 'sin carga' : `${entero(p.sanos)} sanos`}</p>
                        {p.fechaAnterior && <p className="text-gray-500">{fechaCorta(p.fechaAnterior)}: {p.anterior === null ? 'sin carga' : entero(p.anterior)}</p>}
                      </div>
                    );
                  }} />
                  <Legend iconSize={10} wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="sanos" name={mesNombre} fill={ACENTO} radius={[4, 4, 0, 0]} maxBarSize={28} />
                  <Line dataKey="anterior" name={mesAnteriorNombre} stroke={REFERENCIA} strokeWidth={2} strokeDasharray="5 4" dot={false} connectNulls />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </div>

          <div className="bg-white rounded-lg p-3 border border-amber-200">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide">% de postura por día</p>
              <div className="flex gap-1" role="group" aria-label="Período del gráfico">
                {VENTANAS.map((v) => (
                  <button key={v} type="button" onClick={() => setVentana(v)} aria-pressed={ventana === v} className={botonClase(ventana === v, true)}>{v} días</button>
                ))}
              </div>
            </div>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={postura} margin={{ top: 5, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="#EEE8DA" />
                <XAxis dataKey="fecha" tickFormatter={fechaCorta} tick={{ fontSize: 11, fill: '#6B5D45' }} tickLine={false} axisLine={{ stroke: '#D8CDB0' }}
                  interval="preserveStartEnd" minTickGap={24} />
                <YAxis domain={[yMin, yMax]} ticks={ticks} tickFormatter={(v: number) => `${v}%`} tick={{ fontSize: 11, fill: '#6B5D45' }}
                  tickLine={false} axisLine={false} width={42} allowDataOverflow />
                <Tooltip labelFormatter={(f) => fechaCorta(String(f))}
                  formatter={(v, n) => [pct1(typeof v === 'number' ? v : null), n === 'total' ? 'Total granja' : String(n)]}
                  itemSorter={(item) => -(Number(item.value) || 0)} contentStyle={{ fontSize: 12 }} />
                <Legend iconSize={10} wrapperStyle={{ fontSize: 12 }} formatter={(n) => (n === 'total' ? 'Total granja' : n)} />
                {galpones.map((g) => (
                  <Line key={g} dataKey={g} name={g} stroke={COLORES_GALPON[todosGalpones.indexOf(g) % COLORES_GALPON.length]} strokeWidth={conTotal ? 2 : 3}
                    dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
                ))}
                {conTotal && <Line dataKey="total" name="total" stroke={TINTA} strokeWidth={3} dot={false} activeDot={{ r: 5 }} isAnimationActive={false} />}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}
