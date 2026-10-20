import { agregarDiasAFecha } from '../../utils/dateUtils';

export type Periodo = 'semana' | 'mes' | 'personalizado';
/** A date range of the sales dashboard, both ends inclusive (YYYY-MM-DD, Buenos Aires business dates). */
export interface Rango { desde: string; hasta: string }

/** Monday of the week of `fecha` (calendar arithmetic on the date parts: no UTC conversion). */
export function inicioSemana(fecha: string): string {
  const [a, m, d] = fecha.split('-').map(Number);
  const dia = new Date(a, m - 1, d).getDay();
  return agregarDiasAFecha(fecha, -(dia === 0 ? 6 : dia - 1));
}
const pad = (n: number) => String(n).padStart(2, '0');
const ultimoDiaDelMes = (anio: number, mes: number) => new Date(anio, mes, 0).getDate();   // mes 1–12
export const diasEntre = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000) + 1;

/**
 * The selected range and the range it is compared with (the dashboard queries, variations and labels all use these):
 *   - semana: Monday → today vs the previous Monday → the same weekday of the previous week;
 *   - mes: the 1st → today vs the 1st of the previous month → the same day number, capped at that month's last day;
 *   - personalizado: desde → hasta vs the same number of days immediately before (unchanged); no comparison when the range
 *     is invalid (desde after hasta).
 * `hoy` is the Buenos Aires business date (getTodayDate).
 */
export function rangosPeriodo(periodo: Periodo, hoy: string, desde: string, hasta: string): { actual: Rango; anterior: Rango | null } {
  if (periodo === 'semana') {
    const lunes = inicioSemana(hoy);
    return { actual: { desde: lunes, hasta: hoy }, anterior: { desde: agregarDiasAFecha(lunes, -7), hasta: agregarDiasAFecha(hoy, -7) } };
  }
  if (periodo === 'mes') {
    const [a, m, d] = hoy.split('-').map(Number);
    const pa = m === 1 ? a - 1 : a;
    const pm = m === 1 ? 12 : m - 1;
    const dia = Math.min(d, ultimoDiaDelMes(pa, pm));
    return {
      actual: { desde: `${a}-${pad(m)}-01`, hasta: hoy },
      anterior: { desde: `${pa}-${pad(pm)}-01`, hasta: `${pa}-${pad(pm)}-${pad(dia)}` },
    };
  }
  const largo = diasEntre(desde, hasta);
  if (largo < 1) return { actual: { desde, hasta }, anterior: null };
  const compHasta = agregarDiasAFecha(desde, -1);
  return { actual: { desde, hasta }, anterior: { desde: agregarDiasAFecha(compHasta, -(largo - 1)), hasta: compHasta } };
}
