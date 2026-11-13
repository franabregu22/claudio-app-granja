/**
 * Caja → Flujo de caja: DEMONSTRATION data (caja-mejoras-v2 prototype). Everything here is fictitious and pure: no Supabase client,
 * no RPC, no write — nothing in this module can reach the database. Only realized money, up to today (no projection). Totals are
 * coherent by construction: each column's closing balance is its opening balance plus its net flow, and the next column opens with it.
 */
export type Grano = 'MES' | 'SEMANA';
export type EstadoPeriodo = 'PASADO' | 'ACTUAL' | 'FUTURO';
export interface Periodo { inicio: string; fin: string; etiqueta: string; estado: EstadoPeriodo }
export type TipoFila = 'saldo' | 'total' | 'categoria' | 'sub' | 'neto';
export interface Fila { id: string; etiqueta: string; valores: number[]; tipo: TipoFila; hijos: Fila[] }
export interface Flujo { periodos: Periodo[]; filas: Fila[] }

interface Evento { fecha: string; ingreso: boolean; categoria: string; sub: string; monto: number }

export const DEMO_DESDE = '2026-05-01';
export const DEMO_HASTA = '2027-02-28';
const SALDO_BASE = 3_200_000;
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

// ── dates (UTC, ISO yyyy-mm-dd) ─────────────────────────────────────────────
const fecha = (s: string) => new Date(`${s}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
export const sumarDias = (s: string, n: number) => { const d = fecha(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
export function inicioPeriodo(g: Grano, s: string): string {
  if (g === 'MES') return `${s.slice(0, 7)}-01`;
  const dow = (fecha(s).getUTCDay() + 6) % 7;   // Monday = 0
  return sumarDias(s, -dow);
}
export function moverPeriodo(g: Grano, inicio: string, n: number): string {
  if (g === 'SEMANA') return sumarDias(inicio, 7 * n);
  const d = fecha(inicio); d.setUTCMonth(d.getUTCMonth() + n); return iso(d);
}
function finPeriodo(g: Grano, inicio: string): string {
  return g === 'SEMANA' ? sumarDias(inicio, 6) : sumarDias(moverPeriodo('MES', inicio, 1), -1);
}
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

// ── fictitious events ───────────────────────────────────────────────────────
function variacion(clave: string): number {
  let h = 0;
  for (const c of clave) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return 0.9 + (h % 2001) / 10000;   // 0.90 – 1.10, deterministic
}
const PLANTILLA: { dias: number[]; ingreso: boolean; categoria: string; sub: string; base: number }[] = [
  { dias: [5, 20], ingreso: true, categoria: 'Ingresos', sub: 'Clientes mayoristas', base: 950_000 },
  { dias: [25], ingreso: true, categoria: 'Ingresos', sub: 'Cheques de clientes', base: 780_000 },
  { dias: [3], ingreso: false, categoria: 'Alimento', sub: 'Maíz', base: 1_150_000 },
  { dias: [18], ingreso: false, categoria: 'Alimento', sub: 'Núcleo y balanceado', base: 620_000 },
  { dias: [4], ingreso: false, categoria: 'Personal', sub: 'Sueldos', base: 1_350_000 },
  { dias: [12], ingreso: false, categoria: 'Personal', sub: 'Cargas sociales', base: 410_000 },
  { dias: [9], ingreso: false, categoria: 'Sanidad', sub: 'Vacunas', base: 260_000 },
  { dias: [22], ingreso: false, categoria: 'Sanidad', sub: 'Veterinario', base: 140_000 },
  { dias: [10], ingreso: false, categoria: 'Envases', sub: 'Maples', base: 330_000 },
  { dias: [14], ingreso: false, categoria: 'Servicios', sub: 'Energía', base: 190_000 },
  { dias: [7, 21], ingreso: false, categoria: 'Servicios', sub: 'Combustible', base: 120_000 },
  { dias: [16], ingreso: false, categoria: 'Impuestos y bancos', sub: 'Impuestos', base: 290_000 },
  { dias: [28], ingreso: false, categoria: 'Impuestos y bancos', sub: 'Comisiones bancarias', base: 45_000 },
];
/** Every fictitious event of the demo range up to today (realized money only). */
export function eventosDemo(hoy: string): Evento[] {
  const out: Evento[] = [];
  const incluir = (e: Evento) => { if (e.fecha <= hoy) out.push(e); };
  for (let mes = DEMO_DESDE; mes <= DEMO_HASTA; mes = moverPeriodo('MES', mes, 1)) {
    for (const p of PLANTILLA) for (const dia of p.dias) {
      const f = `${mes.slice(0, 8)}${String(dia).padStart(2, '0')}`;
      incluir({ fecha: f, ingreso: p.ingreso, categoria: p.categoria, sub: p.sub, monto: Math.round(p.base * variacion(f + p.sub)) });
    }
  }
  // Ventas en feria every Saturday
  for (let d = sumarDias(DEMO_DESDE, (6 - fecha(DEMO_DESDE).getUTCDay() + 7) % 7); d <= DEMO_HASTA; d = sumarDias(d, 7)) {
    incluir({ fecha: d, ingreso: true, categoria: 'Ingresos', sub: 'Ventas en feria', monto: Math.round(470_000 * variacion(d)) });
  }
  return out.sort((a, b) => a.fecha.localeCompare(b.fecha));
}

// ── the table ───────────────────────────────────────────────────────────────
function fila(id: string, etiquetaFila: string, tipo: TipoFila, valores: number[], hijos: Fila[] = []): Fila {
  return { id, etiqueta: etiquetaFila, tipo, valores, hijos };
}
function sumaPorPeriodo(evs: Evento[], cols: Periodo[]): number[] {
  return cols.map((c) => evs.reduce((t, e) => (e.fecha >= c.inicio && e.fecha <= c.fin ? t + e.monto : t), 0));
}
function agrupar(id: string, evs: Evento[], cols: Periodo[], clave: (e: Evento) => string, tipo: TipoFila,
  hijos?: (id: string, evs: Evento[]) => Fila[]): Fila[] {
  const nombres = [...new Set(evs.map(clave))].sort((a, b) => a.localeCompare(b));
  return nombres.map((n) => {
    const propios = evs.filter((e) => clave(e) === n);
    return fila(`${id}/${n}`, n, tipo, sumaPorPeriodo(propios, cols), hijos ? hijos(`${id}/${n}`, propios) : []);
  });
}

/** Saldo inicial, ingresos cobrados, egresos pagados (category → subcategory), flujo neto and the cash at the end of each period. */
export function construirFlujo(g: Grano, primero: string, n: number, hoy: string): Flujo {
  const cols = periodos(g, primero, n, hoy);
  const evs = eventosDemo(hoy);
  const ing = evs.filter((e) => e.ingreso);
  const egr = evs.filter((e) => !e.ingreso);
  const ingresos = sumaPorPeriodo(ing, cols);
  const egresos = sumaPorPeriodo(egr, cols);
  const neto = cols.map((_, i) => ingresos[i] - egresos[i]);
  const inicial: number[] = [];
  const final: number[] = [];
  cols.forEach((c, i) => {
    inicial.push(i === 0 ? SALDO_BASE + evs.filter((e) => e.fecha < c.inicio).reduce((t, e) => t + (e.ingreso ? e.monto : -e.monto), 0) : final[i - 1]);
    final.push(inicial[i] + neto[i]);
  });
  return {
    periodos: cols,
    filas: [
      fila('inicial', 'Saldo inicial', 'saldo', inicial),
      fila('ingresos', 'Ingresos cobrados', 'total', ingresos, agrupar('ingresos', ing, cols, (e) => e.sub, 'sub')),
      fila('egresos', 'Egresos pagados', 'total', egresos,
        agrupar('egresos', egr, cols, (e) => e.categoria, 'categoria', (id, xs) => agrupar(id, xs, cols, (e) => e.sub, 'sub'))),
      fila('neto', 'Flujo neto', 'neto', neto),
      fila('final', 'Saldo final', 'saldo', final),
    ],
  };
}
