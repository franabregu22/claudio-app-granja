/**
 * Caja → Flujo de caja (0122, caja-mejoras-v2; design approved on the prototype). fin_cash_flow serves, per period, the money of every
 * account: income by movement, outflows by expense category group / subcategory, other movements apart, and the period's net of its
 * postings. Here it is only arranged in a table: periods in columns (months, or Monday–Sunday weeks) up to the current one, nothing
 * projected. Closing = opening + net, and each period opens with the previous closing (the balance cards' source).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { callRpc } from './db';

export type Grano = 'MES' | 'SEMANA';
export type EstadoPeriodo = 'PASADO' | 'ACTUAL' | 'FUTURO';
export interface Periodo { inicio: string; fin: string; etiqueta: string; estado: EstadoPeriodo }
export type TipoFila = 'saldo' | 'total' | 'categoria' | 'sub' | 'neto';
export interface Fila { id: string; etiqueta: string; valores: number[]; tipo: TipoFila; hijos: Fila[] }
export interface Flujo { periodos: Periodo[]; filas: Fila[] }
export interface CashFlowRow { period: string; tipo: 'INGRESO' | 'EGRESO' | 'OTRO' | 'AJUSTE'; grupo: string; sub: string | null; amount: number }
export interface CashFlow { opening: number; net: { period: string; net: number }[]; rows: CashFlowRow[] }

export async function getCashFlow(client: SupabaseClient, from: string, to: string, g: Grano): Promise<CashFlow> {
  const r = await callRpc<{ opening: number; net: { period: string; net: number }[]; rows: CashFlowRow[] }>(client, 'fin_cash_flow', {
    p_from: from, p_to: to, p_grain: g === 'MES' ? 'MONTH' : 'WEEK',
  });
  return { opening: Number(r.opening), net: r.net.map((x) => ({ period: x.period, net: Number(x.net) })), rows: r.rows.map((x) => ({ ...x, amount: Number(x.amount) })) };
}

// ── periods (UTC, ISO yyyy-mm-dd) ───────────────────────────────────────────
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const fecha = (s: string) => new Date(`${s}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
export const sumarDias = (s: string, n: number) => { const d = fecha(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
export function inicioPeriodo(g: Grano, s: string): string {
  if (g === 'MES') return `${s.slice(0, 7)}-01`;
  return sumarDias(s, -((fecha(s).getUTCDay() + 6) % 7));   // Monday
}
export function moverPeriodo(g: Grano, inicio: string, n: number): string {
  if (g === 'SEMANA') return sumarDias(inicio, 7 * n);
  const d = fecha(inicio); d.setUTCMonth(d.getUTCMonth() + n); return iso(d);
}
const finPeriodo = (g: Grano, inicio: string) => (g === 'SEMANA' ? sumarDias(inicio, 6) : sumarDias(moverPeriodo('MES', inicio, 1), -1));
function etiqueta(g: Grano, inicio: string, fin: string): string {
  const m = (s: string) => MESES[Number(s.slice(5, 7)) - 1];
  if (g === 'MES') return `${m(inicio)} ${inicio.slice(2, 4)}`;
  const d = (s: string) => String(Number(s.slice(8, 10)));
  return inicio.slice(5, 7) === fin.slice(5, 7) ? `${d(inicio)}–${d(fin)} ${m(fin)}` : `${d(inicio)} ${m(inicio)}–${d(fin)} ${m(fin)}`;
}
export function periodos(g: Grano, primero: string, n: number, hoy: string): Periodo[] {
  return Array.from({ length: n }, (_, i) => {
    const inicio = moverPeriodo(g, primero, i);
    const fin = finPeriodo(g, inicio);
    return { inicio, fin, etiqueta: etiqueta(g, inicio, fin), estado: fin < hoy ? 'PASADO' : inicio > hoy ? 'FUTURO' : 'ACTUAL' };
  });
}

// ── the table ───────────────────────────────────────────────────────────────
const r2 = (n: number) => Math.round(n * 100) / 100;
function agrupar(id: string, xs: CashFlowRow[], cols: Periodo[], clave: (x: CashFlowRow) => string, tipo: TipoFila, signo: number,
  hijos?: (id: string, xs: CashFlowRow[]) => Fila[]): Fila[] {
  return [...new Set(xs.map(clave))].sort((a, b) => a.localeCompare(b)).map((k) => {
    const propios = xs.filter((x) => clave(x) === k);
    return { id: `${id}/${k}`, etiqueta: k, tipo, valores: cols.map((c) => r2(signo * propios.filter((x) => x.period === c.inicio).reduce((t, x) => t + x.amount, 0))),
      hijos: hijos ? hijos(`${id}/${k}`, propios) : [] };
  });
}
/** Saldo inicial, Ingresos cobrados, Egresos pagados (group → subcategory), Otros movimientos (only if any), Flujo neto, Saldo final. */
export function construirFlujo(cols: Periodo[], cf: CashFlow): Flujo {
  const suma = (xs: CashFlowRow[], signo = 1) => cols.map((c) => r2(signo * xs.filter((x) => x.period === c.inicio).reduce((t, x) => t + x.amount, 0)));
  const ing = cf.rows.filter((x) => x.tipo === 'INGRESO');
  const egr = cf.rows.filter((x) => x.tipo === 'EGRESO');
  const otros = cf.rows.filter((x) => x.tipo === 'OTRO' || x.tipo === 'AJUSTE');
  const neto = cols.map((c) => r2(cf.net.find((x) => x.period === c.inicio)?.net ?? 0));
  const inicial: number[] = [];
  const final: number[] = [];
  cols.forEach((_, i) => { inicial.push(i === 0 ? r2(cf.opening) : final[i - 1]); final.push(r2(inicial[i] + neto[i])); });
  const filas: Fila[] = [
    { id: 'inicial', etiqueta: 'Saldo inicial', tipo: 'saldo', valores: inicial, hijos: [] },
    { id: 'ingresos', etiqueta: 'Ingresos cobrados', tipo: 'total', valores: suma(ing), hijos: agrupar('ingresos', ing, cols, (x) => x.grupo, 'sub', 1) },
    { id: 'egresos', etiqueta: 'Egresos pagados', tipo: 'total', valores: suma(egr, -1),
      hijos: agrupar('egresos', egr, cols, (x) => x.grupo, 'categoria', -1, (id, xs) => agrupar(id, xs, cols, (x) => x.sub ?? x.grupo, 'sub', -1)) },
  ];
  if (otros.length > 0) {
    filas.push({ id: 'otros', etiqueta: 'Otros movimientos', tipo: 'total', valores: suma(otros), hijos: agrupar('otros', otros, cols, (x) => x.grupo, 'sub', 1) });
  }
  filas.push({ id: 'neto', etiqueta: 'Flujo neto', tipo: 'neto', valores: neto, hijos: [] });
  filas.push({ id: 'final', etiqueta: 'Saldo final', tipo: 'saldo', valores: final, hijos: [] });
  return { periodos: cols, filas };
}
