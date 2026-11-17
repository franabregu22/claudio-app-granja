/**
 * Producción dashboard indicators (owner 2026-11-17) — presentation sums over report_flock_day rows, the only source (ADR-005 D1/D2:
 * eggs, population and the daily laying % come from the view; nothing per day is recomputed here).
 *
 * Rules:
 *   - today is incomplete: every period ends YESTERDAY (closed days only);
 *   - semana: Monday → yesterday vs the same weekdays of the previous week; on Monday there is no closed day (null → «Sin días
 *     cerrados todavía»);
 *   - mes: the 1st → yesterday vs the 1st of the previous month → the same day number (capped at that month's last day); on the 1st
 *     there is no closed day (null);
 *   - huevos sanos = huevos totales − rotos (dirty eggs are no longer collected);
 *   - mortandad of a period = the deaths the view reports for every flock-day of it (with or without production);
 *   - % postura of a period = the view's daily laying % weighted by that day's birds (= total eggs ÷ bird-days, total eggs as the
 *     sector measures it), over the days with production.
 */
import { agregarDiasAFecha } from '../../utils/dateUtils';
import { inicioSemana, type Rango } from '../pedidos/periodos';
import type { FlockDay } from '../../target/production';

export interface Comparacion { actual: Rango; anterior: Rango }
const pad = (n: number) => String(n).padStart(2, '0');
const ultimoDiaDelMes = (anio: number, mes: number) => new Date(anio, mes, 0).getDate();   // mes 1–12

/** The week and the month to show, both ending yesterday; null when the period has no closed day yet. */
export function rangosDashboard(hoy: string): { semana: Comparacion | null; mes: Comparacion | null; ayer: string } {
  const ayer = agregarDiasAFecha(hoy, -1);
  const lunes = inicioSemana(hoy);
  const semana = lunes === hoy ? null : {
    actual: { desde: lunes, hasta: ayer },
    anterior: { desde: agregarDiasAFecha(lunes, -7), hasta: agregarDiasAFecha(ayer, -7) },
  };
  const [a, m, d] = hoy.split('-').map(Number);
  let mes: Comparacion | null = null;
  if (d > 1) {
    const pa = m === 1 ? a - 1 : a;
    const pm = m === 1 ? 12 : m - 1;
    const dia = Math.min(d - 1, ultimoDiaDelMes(pa, pm));
    mes = { actual: { desde: `${a}-${pad(m)}-01`, hasta: ayer }, anterior: { desde: `${pa}-${pad(pm)}-01`, hasta: `${pa}-${pad(pm)}-${pad(dia)}` } };
  }
  return { semana, mes, ayer };
}

export interface Totales { sanos: number; rotos: number; totales: number; postura: number | null; pctRotos: number | null; dias: number; muertes: number }

const dentro = (f: string, r: Rango) => f >= r.desde && f <= r.hasta;
const sanosDe = (d: FlockDay) => (d.eggs_total ?? 0) - (d.eggs_broken ?? 0);

/** Laying % of a set of flock-days: the view's daily % weighted by the day's birds (only the days with production). */
export function posturaPonderada(filas: FlockDay[]): number | null {
  let pesoTotal = 0;
  let acumulado = 0;
  for (const d of filas) {
    if (d.laying_pct === null || d.population <= 0) continue;
    acumulado += d.laying_pct * d.population;
    pesoTotal += d.population;
  }
  return pesoTotal === 0 ? null : acumulado / pesoTotal;
}

/** The totals of a range (only the flock-days with production count). */
export function totalesDe(filas: FlockDay[], r: Rango): Totales {
  const delRango = filas.filter((d) => d.daily_production_id !== null && dentro(d.business_date, r));
  const totales = delRango.reduce((s, d) => s + (d.eggs_total ?? 0), 0);
  const rotos = delRango.reduce((s, d) => s + (d.eggs_broken ?? 0), 0);
  return {
    sanos: totales - rotos, rotos, totales, postura: posturaPonderada(delRango),
    pctRotos: totales > 0 ? (rotos * 100) / totales : null, dias: new Set(delRango.map((d) => d.business_date)).size,
    muertes: filas.filter((d) => dentro(d.business_date, r)).reduce((s, d) => s + d.mortality, 0),
  };
}

/** The rows of one flock ('' = the whole farm): the lote filter of the dashboard applies to every card and chart. */
export const deLote = (filas: FlockDay[], flockId: string): FlockDay[] => (flockId === '' ? filas : filas.filter((d) => d.flock_id === flockId));

/** Relative change in % (null without a base). */
export const variacionPct = (x: number, y: number): number | null => (y === 0 ? null : ((x - y) / y) * 100);

export interface PuntoHuevos { dia: number; fecha: string; sanos: number | null; fechaAnterior: string | null; anterior: number | null }
/** Healthy eggs per day of this month (1 → yesterday) and the previous month on the same day number (reference line). */
export function serieHuevosMes(filas: FlockDay[], mes: Comparacion): PuntoHuevos[] {
  const porFecha = new Map<string, number>();
  for (const d of filas) if (d.daily_production_id !== null) porFecha.set(d.business_date, (porFecha.get(d.business_date) ?? 0) + sanosDe(d));
  const out: PuntoHuevos[] = [];
  for (let f = mes.actual.desde; f <= mes.actual.hasta; f = agregarDiasAFecha(f, 1)) {
    const dia = Number(f.slice(8, 10));
    const fa = `${mes.anterior.desde.slice(0, 8)}${pad(dia)}`;
    const valida = fa <= mes.anterior.hasta;
    out.push({ dia, fecha: f, sanos: porFecha.get(f) ?? null, fechaAnterior: valida ? fa : null, anterior: valida ? porFecha.get(fa) ?? null : null });
  }
  return out;
}

export type PuntoPostura = { fecha: string; total: number | null } & Record<string, number | string | null>;
/** Daily laying %: the farm total (weighted by birds) and one value per series key (by default the flock: the view's own %), [desde, hasta]. */
export function seriePostura(filas: FlockDay[], desde: string, hasta: string, claves: string[],
  claveDe: (d: FlockDay) => string = (d) => d.flock_id): PuntoPostura[] {
  const porFecha = new Map<string, FlockDay[]>();
  for (const d of filas) {
    if (d.daily_production_id === null || d.business_date < desde || d.business_date > hasta) continue;
    porFecha.set(d.business_date, [...(porFecha.get(d.business_date) ?? []), d]);
  }
  const out: PuntoPostura[] = [];
  for (let f = desde; f <= hasta; f = agregarDiasAFecha(f, 1)) {
    const delDia = porFecha.get(f) ?? [];
    const punto: PuntoPostura = { fecha: f, total: posturaPonderada(delDia) };
    for (const k of claves) punto[k] = posturaPonderada(delDia.filter((d) => claveDe(d) === k));
    out.push(punto);
  }
  return out;
}

/** A readable Y range for laying %: the data's min / max with a margin, rounded to 5; from 0 up, never below 100 at the top unless all data
 *  is far lower, and ABOVE 100 when a day reports more eggs than birds (the point is shown, not clipped). */
export function escalaPostura(puntos: PuntoPostura[], series: string[]): [number, number] {
  const valores = puntos.flatMap((p) => series.map((s) => p[s])).filter((v): v is number => typeof v === 'number');
  if (valores.length === 0) return [0, 100];
  const min = Math.max(0, Math.floor((Math.min(...valores) - 5) / 5) * 5);
  const alto = Math.max(...valores);
  const max = alto > 100 ? Math.ceil((alto + 5) / 5) * 5 : Math.min(100, Math.ceil((alto + 5) / 5) * 5);
  return [min, max];
}

/** Round ticks for a count axis from 0: a step of 1 / 2 / 2.5 / 5 × 10ⁿ giving at most ~5 intervals (e.g. 0, 500, 1.000, 1.500…). */
export function ticksRedondos(maximo: number, intervalos = 5): number[] {
  if (!(maximo > 0)) return [0, 1];
  const bruto = maximo / intervalos;
  const potencia = 10 ** Math.floor(Math.log10(bruto));
  const paso = [1, 2, 2.5, 5, 10].map((f) => f * potencia).find((p) => p >= bruto) ?? 10 * potencia;
  const tope = Math.ceil(maximo / paso) * paso;
  return Array.from({ length: Math.round(tope / paso) + 1 }, (_, i) => Math.round(i * paso));
}
