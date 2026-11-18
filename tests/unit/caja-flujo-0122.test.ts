/** 0122 (caja-mejoras-v2): Flujo de caja on real data — periods, rows, coherence (closing = opening + net), between cards and history. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { construirFlujo, inicioPeriodo, moverPeriodo, periodos, type CashFlow } from '../../src/target/cashFlow';

const SRC = (f: string) => readFileSync(resolve(__dirname, '../../src', f), 'utf8');
const HOY = '2026-11-13';
const val = (f: ReturnType<typeof construirFlujo>, id: string) => f.filas.find((x) => x.id === id)?.valores;

describe('Flujo de caja (0122)', () => {
  it('lives in its own tab, Caja → Análisis (owner 2026-11-18), always open; Movimientos keeps the balances and the table; real data', () => {
    const mov = SRC('features/caja/Movimientos.tsx');
    expect(mov).not.toMatch(/FlujoCaja/);
    expect(mov.indexOf('Saldos por cuenta')).toBeLessThan(mov.indexOf('Historial de movimientos'));
    const caja = SRC('features/caja/CajaApp.tsx');
    expect(caja).toMatch(/\{vista === 'analisis' && <FlujoCaja \/>\}/);
    const ui = SRC('features/caja/FlujoCaja.tsx');
    expect(ui).not.toMatch(/plegar|tocá para ver|caja\.flujo\.abierto|enabled: visible/);
    expect(ui).toContain('getCashFlow(supabase');
    expect(ui).not.toMatch(/Datos ficticios|flujoDemo/);
  });
  it('weeks run Monday to Sunday; the window ends at the current period', () => {
    expect(inicioPeriodo('SEMANA', '2026-11-15')).toBe('2026-11-09');
    expect(moverPeriodo('MES', '2026-12-01', 1)).toBe('2027-01-01');
    const ps = periodos('MES', moverPeriodo('MES', inicioPeriodo('MES', HOY), -5), 6, HOY);
    expect(ps.at(-1)).toMatchObject({ inicio: '2026-11-01', estado: 'ACTUAL' });
  });
  it('rows: income by movement, outflows by group → subcategory (shown positive), other movements only when present; closing = opening + net', () => {
    const cols = periodos('MES', '2026-10-01', 2, HOY);
    const cf: CashFlow = {
      opening: 1000,
      net: [{ period: '2026-10-01', net: 300 }, { period: '2026-11-01', net: -50 }],
      rows: [
        { period: '2026-10-01', tipo: 'INGRESO', grupo: 'Cobro', sub: null, amount: 500 },
        { period: '2026-10-01', tipo: 'EGRESO', grupo: 'Servicios', sub: 'Electricidad', amount: -150 },
        { period: '2026-10-01', tipo: 'EGRESO', grupo: 'Servicios', sub: 'Contador', amount: -50 },
        { period: '2026-11-01', tipo: 'EGRESO', grupo: 'Sin categoría', sub: 'Impuesto bancario', amount: -30 },
        { period: '2026-11-01', tipo: 'OTRO', grupo: 'Retiro de socios', sub: null, amount: -20 },
      ],
    };
    const f = construirFlujo(cols, cf);
    expect(f.filas.map((x) => x.id)).toEqual(['inicial', 'ingresos', 'egresos', 'otros', 'neto', 'final']);
    expect(val(f, 'inicial')).toEqual([1000, 1300]);
    expect(val(f, 'egresos')).toEqual([200, 30]);
    expect(val(f, 'final')).toEqual([1300, 1250]);
    const egr = f.filas.find((x) => x.id === 'egresos')!;
    expect(egr.hijos.find((h) => h.etiqueta === 'Servicios')!.hijos.map((h) => [h.etiqueta, h.valores[0]])).toEqual([['Contador', 50], ['Electricidad', 150]]);
    // per column: income − outflows + other movements = net
    f.periodos.forEach((_, i) => expect(val(f, 'ingresos')![i] - val(f, 'egresos')![i] + val(f, 'otros')![i]).toBe(val(f, 'neto')![i]));
    expect(construirFlujo(cols, { ...cf, rows: cf.rows.filter((x) => x.tipo !== 'OTRO') }).filas.some((x) => x.id === 'otros')).toBe(false);
  });
});
