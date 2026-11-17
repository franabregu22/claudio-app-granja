/** Dashboard → Producción (owner 2026-11-17): closed days only, same days compared, healthy eggs, broken, laying %, charts. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  deGalpon, escalaPostura, posturaPonderada, ticksRedondos, rangosDashboard, seriePostura, serieHuevosMes, totalesDe, variacionPct,
} from '../../src/features/production/indicadoresProduccion';
import type { FlockDay } from '../../src/target/production';

const dia = (o: Partial<FlockDay>): FlockDay => ({
  flock_id: 'f1', shed_id: 's1', shed_nombre: 'Galpón 1', genetics_line: null, business_date: '2026-11-16', daily_production_id: 'p', eggs_total: 900,
  eggs_broken: 10, eggs_dirty: 0, mortality: 0, count_adjustment: 0, population: 1000, age_weeks: 30, laying_pct: 90, expected_laying_pct: null,
  quality_data_warning: false, ...o,
});

describe('periods: up to yesterday, same days compared', () => {
  it('Tuesday 17/11: week = 16/11 vs 09/11; month = 01–16/11 vs 01–16/10', () => {
    const r = rangosDashboard('2026-11-17');
    expect(r.ayer).toBe('2026-11-16');
    expect(r.semana).toEqual({ actual: { desde: '2026-11-16', hasta: '2026-11-16' }, anterior: { desde: '2026-11-09', hasta: '2026-11-09' } });
    expect(r.mes).toEqual({ actual: { desde: '2026-11-01', hasta: '2026-11-16' }, anterior: { desde: '2026-10-01', hasta: '2026-10-16' } });
  });
  it('Monday: the week has no closed day; the 1st: the month has none', () => {
    expect(rangosDashboard('2026-11-16').semana).toBeNull();
    expect(rangosDashboard('2026-12-01').mes).toBeNull();
    expect(rangosDashboard('2026-12-01').semana).not.toBeNull();   // Tuesday 1/12
  });
  it('the previous month is capped at its last day; January compares with December', () => {
    expect(rangosDashboard('2027-03-31').mes?.anterior).toEqual({ desde: '2027-02-01', hasta: '2027-02-28' });
    expect(rangosDashboard('2027-01-10').mes?.anterior).toEqual({ desde: '2026-12-01', hasta: '2026-12-09' });
  });
});

describe('totals', () => {
  const filas = [
    dia({}), dia({ flock_id: 'f2', shed_nombre: 'Galpón 2', eggs_total: 450, eggs_broken: 5, population: 500, laying_pct: 90 }),
    dia({ business_date: '2026-11-15', eggs_total: 800, eggs_broken: 0, laying_pct: 80 }),
    dia({ business_date: '2026-11-16', flock_id: 'f3', daily_production_id: null, eggs_total: null, eggs_broken: null, laying_pct: null, population: 300 }),
  ];
  it('healthy = total − broken; only days with production; laying % weighted by birds', () => {
    const t = totalesDe(filas, { desde: '2026-11-16', hasta: '2026-11-16' });
    expect(t).toMatchObject({ totales: 1350, rotos: 15, sanos: 1335, dias: 1 });
    expect(t.postura).toBeCloseTo(90, 6);
    expect(t.pctRotos).toBeCloseTo(15 * 100 / 1350, 6);
  });
  it('mortality counts every flock-day of the range (with or without production); the shed filter', () => {
    const conMuertes = [dia({ mortality: 3 }), dia({ flock_id: 'f3', shed_nombre: 'Galpón 3', daily_production_id: null, eggs_total: null, eggs_broken: null, mortality: 2 }),
      dia({ business_date: '2026-11-09', mortality: 7 })];
    expect(totalesDe(conMuertes, { desde: '2026-11-16', hasta: '2026-11-16' }).muertes).toBe(5);
    expect(totalesDe(deGalpon(conMuertes, 'Galpón 3'), { desde: '2026-11-16', hasta: '2026-11-16' }).muertes).toBe(2);
    expect(deGalpon(conMuertes, '')).toHaveLength(3);
  });
  it('weighted laying % = total eggs ÷ bird-days', () => {
    expect(posturaPonderada([dia({ laying_pct: 90, population: 1000 }), dia({ laying_pct: 60, population: 500 })])).toBeCloseTo(80, 6);
    expect(posturaPonderada([])).toBeNull();
  });
  it('variation without a base is null', () => {
    expect(variacionPct(110, 100)).toBeCloseTo(10, 6);
    expect(variacionPct(5, 0)).toBeNull();
  });
});

describe('charts', () => {
  it('eggs per day of the month against the same day number of the previous month', () => {
    const filas = [dia({ business_date: '2026-11-01', eggs_total: 100, eggs_broken: 1 }), dia({ business_date: '2026-10-01', eggs_total: 90, eggs_broken: 0 })];
    const serie = serieHuevosMes(filas, rangosDashboard('2026-11-03').mes!);
    expect(serie).toEqual([
      { dia: 1, fecha: '2026-11-01', sanos: 99, fechaAnterior: '2026-10-01', anterior: 90 },
      { dia: 2, fecha: '2026-11-02', sanos: null, fechaAnterior: '2026-10-02', anterior: null },
    ]);
  });
  it('laying % per day: farm total and per shed; gaps stay null; a readable Y range', () => {
    const filas = [dia({ business_date: '2026-11-15', laying_pct: 70 }), dia({ business_date: '2026-11-15', flock_id: 'f2', shed_nombre: 'Galpón 2', laying_pct: 40, population: 1000 })];
    const serie = seriePostura(filas, '2026-11-15', '2026-11-16', ['Galpón 1', 'Galpón 2']);
    expect(serie[0]).toMatchObject({ fecha: '2026-11-15', 'Galpón 1': 70, 'Galpón 2': 40 });
    expect(serie[0].total).toBeCloseTo(55, 6);
    expect(serie[1]).toMatchObject({ fecha: '2026-11-16', total: null, 'Galpón 1': null });
    expect(escalaPostura(serie, ['total', 'Galpón 1', 'Galpón 2'])).toEqual([35, 75]);
    expect(escalaPostura([], ['total'])).toEqual([0, 100]);
    expect(ticksRedondos(2450)).toEqual([0, 500, 1000, 1500, 2000, 2500]);
    expect(ticksRedondos(4300)).toEqual([0, 1000, 2000, 3000, 4000, 5000]);
    expect(ticksRedondos(0)).toEqual([0, 1]);
    expect(escalaPostura([{ fecha: 'x', total: 112 }, { fecha: 'y', total: 80 }], ['total'])).toEqual([75, 120]);   // above 100: shown
  });
});

describe('the screen', () => {
  const app = readFileSync(resolve(__dirname, '../../src/features/production/ProductionDashboard.tsx'), 'utf8');
  it('sections and cards as asked; the old per-flock charts are gone', () => {
    for (const t of ['Esta semana', 'Este mes', 'Huevos sanos', 'Huevos rotos', '% de postura', 'Mortandad', 'Evolución', 'Sin días cerrados todavía', 'Todos los galpones']) expect(app).toContain(t);
    expect((app.match(/<Tarjeta label=/g) ?? []).length).toBe(4);   // one card per indicator; the period selector replaces the repeated cards
    expect(app).not.toMatch(/ddmm|slice\(8, 10\)\}\/\$/);   // dates as «1 nov», never dd/mm
    expect(app).toMatch(/MESES_CORTOS = \['ene'/);
    expect(app).toMatch(/const filas = deGalpon\(todas, galpon\);/);   // the shed filter feeds every card and chart
    expect(app).not.toMatch(/latestPerFlock|Edad \(sem\.\)/);
    expect(app).toMatch(/VENTANAS = \[30, 60, 90\]/);
    expect(app).toMatch(/menosEsMejor/);   // more broken eggs is red
  });
});
