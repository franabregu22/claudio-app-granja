/** caja-mejoras-v2: Flujo de caja prototype — fictitious data only, coherent totals, between the balances and the history. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { construirFlujo, inicioPeriodo, moverPeriodo, periodos, type Fila } from '../../src/features/caja/flujoDemo';

const SRC = (f: string) => readFileSync(resolve(__dirname, '../../src', f), 'utf8');
const mov = SRC('features/caja/Movimientos.tsx');
const ui = SRC('features/caja/FlujoCaja.tsx');
const demo = SRC('features/caja/flujoDemo.ts');
const HOY = '2026-11-12';
const val = (fs: Fila[], id: string) => fs.find((f) => f.id === id)!.valores;

describe('Flujo de caja (demo)', () => {
  it('sits between the balance cards and the history; the history is unchanged', () => {
    const i = (s: string) => mov.indexOf(s);
    expect(i('Saldos por cuenta')).toBeLessThan(i('<FlujoCaja />'));
    expect(i('<FlujoCaja />')).toBeLessThan(i('Historial de movimientos'));
    expect(mov).toContain('<TodasLasOperaciones cuentas={lista} cuentaId={cuentaId} onCuenta={setCuentaId} focus={focus} onFocus={onFocus} />');
  });
  it('cannot reach Supabase: no client, query or mutation; labelled as a demo', () => {
    for (const s of [ui, demo]) expect(s).not.toMatch(/supabase|useMutation|useQuery|\.rpc\(|target\//);
    expect(ui).toContain('Vista de demostración · Datos ficticios');
  });
  it('weeks run Monday to Sunday; months and weeks navigate', () => {
    expect(inicioPeriodo('SEMANA', '2026-11-12')).toBe('2026-11-09');
    expect(inicioPeriodo('SEMANA', '2026-11-15')).toBe('2026-11-09');
    expect(inicioPeriodo('SEMANA', '2026-11-16')).toBe('2026-11-16');
    expect(moverPeriodo('MES', '2026-12-01', 1)).toBe('2027-01-01');
    const ps = periodos('SEMANA', '2026-11-02', 3, HOY);
    expect(ps.map((p) => [p.inicio, p.fin, p.estado])).toEqual([
      ['2026-11-02', '2026-11-08', 'PASADO'], ['2026-11-09', '2026-11-15', 'ACTUAL'], ['2026-11-16', '2026-11-22', 'FUTURO']]);
  });
  for (const [g, primero, n] of [['MES', '2026-06-01', 6], ['SEMANA', '2026-09-21', 8]] as const) {
    it(`${g}: totals are coherent (children add up, each column closes into the next)`, () => {
      const { filas, periodos: ps } = construirFlujo(g, primero, n, HOY);
      const ini = val(filas, 'inicial'), ing = val(filas, 'ingresos'), egr = val(filas, 'egresos'), neto = val(filas, 'neto');
      const fin = val(filas, 'final');
      expect(filas.map((f) => f.id)).toEqual(['inicial', 'ingresos', 'egresos', 'neto', 'final']);   // no projected rows
      expect(ps.at(-1)!.estado).toBe('ACTUAL');   // the window ends at the current period
      ps.forEach((_, i) => {
        expect(neto[i]).toBe(ing[i] - egr[i]);
        expect(fin[i]).toBe(ini[i] + neto[i]);
        if (i > 0) expect(ini[i]).toBe(fin[i - 1]);
        for (const f of filas) if (f.hijos.length) expect(f.hijos.reduce((t, h) => t + h.valores[i], 0)).toBe(f.valores[i]);
        for (const c of filas.find((f) => f.id === 'egresos')!.hijos) expect(c.hijos.reduce((t, h) => t + h.valores[i], 0)).toBe(c.valores[i]);
      });
    });
  }
  it('the opening balance of a date is the same by month and by week (1 June 2026 is a Monday)', () => {
    expect(val(construirFlujo('MES', '2026-06-01', 1, HOY).filas, 'inicial')[0]).toBe(val(construirFlujo('SEMANA', '2026-06-01', 1, HOY).filas, 'inicial')[0]);
    expect(val(construirFlujo('MES', '2026-06-01', 1, HOY).filas, 'inicial')[0]).toBe(val(construirFlujo('MES', '2026-05-01', 2, HOY).filas, 'inicial')[1]);
  });
});
