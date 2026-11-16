import type { FormulaSection } from '../../../target/feed';

/** Presentation helpers of the Alimento module (no business rule lives here). */
export const SECCIONES: { id: FormulaSection; label: string }[] = [{ id: 'PREMIX', label: 'Premezcla' }, { id: 'MACRO', label: 'Macronutrientes' }];
const MES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

export const etiquetaMes = (period: string) => `${MES[Number(period.slice(5, 7)) - 1]} ${period.slice(2, 4)}`;
export const fechaDMA = (f: string) => `${f.slice(8, 10)}/${f.slice(5, 7)}/${f.slice(2, 4)}`;
export const fechaCorta = (f: string) => `${f.slice(8, 10)}/${f.slice(5, 7)}`;
export const kgTxt = (v: number | null) => (v === null ? '—' : `${v.toLocaleString('es-AR', { maximumFractionDigits: 1 })} kg`);
export const kgLinea = (v: number, s: FormulaSection) =>
  `${v.toLocaleString('es-AR', s === 'PREMIX' ? { minimumFractionDigits: 3, maximumFractionDigits: 3 } : { maximumFractionDigits: 2 })} kg`;
export const pctLinea = (kg: number, total: number, s: FormulaSection) => {
  const d = s === 'PREMIX' ? 3 : 1;
  return `${((kg / total) * 100).toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d })} %`;
};
export const pesos = (v: number | null) => (v === null ? '—' : `$ ${v.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

/** The first day of the month of a date, and the months [from, to] as 'YYYY-MM-01'. */
export const mesDe = (f: string) => `${f.slice(0, 7)}-01`;
export function meses(desde: string, hasta: string): string[] {
  const out: string[] = [];
  let [y, m] = [Number(desde.slice(0, 4)), Number(desde.slice(5, 7))];
  const fin = hasta.slice(0, 7);
  while (`${y}-${String(m).padStart(2, '0')}` <= fin) { out.push(`${y}-${String(m).padStart(2, '0')}-01`); m += 1; if (m > 12) { m = 1; y += 1; } }
  return out;
}
export const mesAnterior = (period: string) => meses(`${Number(period.slice(0, 4)) - (period.slice(5, 7) === '01' ? 1 : 0)}-${period.slice(5, 7) === '01' ? '12' : String(Number(period.slice(5, 7)) - 1).padStart(2, '0')}-01`, period)[0];
export const finDeMes = (period: string) => {
  const [y, m] = [Number(period.slice(0, 4)), Number(period.slice(5, 7))];
  return `${period.slice(0, 7)}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
};

/** Same days of the previous month: 14/11 → 01/10–14/10 (clamped to the length of the previous month). */
export function periodoComparable(hoy: string) {
  const ant = mesAnterior(mesDe(hoy));
  const dia = Math.min(Number(hoy.slice(8, 10)), Number(finDeMes(ant).slice(8, 10)));
  return { desde: mesDe(hoy), hasta: hoy, desdeAnt: ant, hastaAnt: `${ant.slice(0, 7)}-${String(dia).padStart(2, '0')}`, mesAnt: ant };
}
export const variacion = (actual: number, anterior: number) => (anterior === 0 ? null : ((actual - anterior) / anterior) * 100);

/**
 * Kg of each line for another batch size, keeping the proportions, rounded for the scales (owner 2026-11-16): Premezcla to the gram
 * (3 decimals), Macronutrientes to 10 g (2 decimals). What the rounding leaves goes to the heaviest Macronutriente (usually maize), so
 * the lines still add up to the batch. At the recipe's own batch the stored quantities are shown as they are.
 */
export function escalar<L extends { quantity_kg: number; section: FormulaSection; ingredient_id: string }>(lineas: L[], base: number, batch: number): L[] {
  if (!(base > 0) || batch === base) return lineas;
  const red = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
  const out = lineas.map((l) => ({ ...l, quantity_kg: red((l.quantity_kg * batch) / base, l.section === 'PREMIX' ? 3 : 2) }));
  const objetivo = red((lineas.reduce((s, l) => s + l.quantity_kg, 0) * batch) / base, 3);
  const mayor = out.reduce<number>((m, l, i) => (l.section === 'MACRO' && (m < 0 || l.quantity_kg > out[m].quantity_kg) ? i : m), -1);
  if (mayor >= 0) {
    const resto = red(objetivo - out.reduce((s, l) => s + l.quantity_kg, 0), 3);
    out[mayor] = { ...out[mayor], quantity_kg: red(out[mayor].quantity_kg + resto, 2) };
  }
  return out;
}
