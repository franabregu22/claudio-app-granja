/** Dashboard → Producción (owner 2026-11-17): closed days only, same days compared, healthy eggs, broken, laying %, charts. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  deLote, diasDe, escalaPostura, posturaPonderada, rangoPersonalizado, ticksRedondos, rangosDashboard, seriePostura, serieHuevosMes, serieHuevosRango, totalesDe, variacionPct,
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
  it('mortality counts every flock-day of the range (with or without production); the lote filter', () => {
    const conMuertes = [dia({ mortality: 3 }), dia({ flock_id: 'f3', shed_nombre: 'Galpón 3', daily_production_id: null, eggs_total: null, eggs_broken: null, mortality: 2 }),
      dia({ business_date: '2026-11-09', mortality: 7 })];
    expect(totalesDe(conMuertes, { desde: '2026-11-16', hasta: '2026-11-16' }).muertes).toBe(5);
    expect(totalesDe(deLote(conMuertes, 'f3'), { desde: '2026-11-16', hasta: '2026-11-16' }).muertes).toBe(2);
    expect(deLote(conMuertes, '')).toHaveLength(3);
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
    const serie = seriePostura(filas, '2026-11-15', '2026-11-16', ['Galpón 1', 'Galpón 2'], (d) => d.shed_nombre);
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
    for (const t of ['Esta semana', 'Este mes', 'Huevos sanos', 'Huevos rotos', '% de postura', 'Mortandad', 'Evolución', 'Sin días cerrados todavía', 'Todos los lotes']) expect(app).toContain(t);
    expect((app.match(/<Tarjeta label=/g) ?? []).length).toBe(4);   // one card per indicator; the period selector replaces the repeated cards
    expect(app).not.toMatch(/ddmm|slice\(8, 10\)\}\/\$/);   // dates as «1 nov», never dd/mm
    expect(app).toMatch(/MESES_CORTOS = \['ene'/);
    expect(app).toMatch(/const filas = deLote\(todas, elegido\);/);   // the lote filter feeds every card and chart
    expect(app).toMatch(/filter\(\(f\) => f\.estado === 'ACTIVE'\)\.map\(\(f\) => \(\{ id: f\.id, codigo: codigoLote\(f\)/);   // only the ACTIVE lotes, by code
    expect(app).toMatch(/label="Mortandad" vacio=\{comp \? null/);   // mortality shows even without eggs (recría)
    expect(app).not.toMatch(/latestPerFlock|Edad \(sem\.\)/);
    expect(app).toMatch(/VENTANAS = \[30, 60, 90\]/);
    expect(app).toMatch(/menosEsMejor/);   // more broken eggs is red
  });
});

describe('período personalizado (owner 2026-11-26): the chosen closed range vs the same number of days right before it', () => {
  it('10–20/11 (11 days) vs 30/10–09/11; a single day; reversed ends; across months and years', () => {
    expect(rangoPersonalizado('2026-11-10', '2026-11-20')).toEqual({ actual: { desde: '2026-11-10', hasta: '2026-11-20' }, anterior: { desde: '2026-10-30', hasta: '2026-11-09' } });
    expect(diasDe({ desde: '2026-11-10', hasta: '2026-11-20' })).toBe(11);
    expect(rangoPersonalizado('2026-11-25', '2026-11-25')).toEqual({ actual: { desde: '2026-11-25', hasta: '2026-11-25' }, anterior: { desde: '2026-11-24', hasta: '2026-11-24' } });
    expect(rangoPersonalizado('2026-11-20', '2026-11-10').actual).toEqual({ desde: '2026-11-10', hasta: '2026-11-20' });
    expect(rangoPersonalizado('2027-01-01', '2027-01-31').anterior).toEqual({ desde: '2026-12-01', hasta: '2026-12-31' });
    expect(rangoPersonalizado('2026-03-01', '2026-03-03').anterior).toEqual({ desde: '2026-02-26', hasta: '2026-02-28' });
  });
  it('the eggs chart pairs each day with the day at the same position of the previous range', () => {
    const filas = [dia({ business_date: '2026-11-10', eggs_total: 100, eggs_broken: 0 }), dia({ business_date: '2026-11-08', eggs_total: 80, eggs_broken: 0 })];
    const s = serieHuevosRango(filas, rangoPersonalizado('2026-11-10', '2026-11-11'));
    expect(s.map((p) => [p.fecha, p.sanos, p.fechaAnterior, p.anterior])).toEqual([['2026-11-10', 100, '2026-11-08', 80], ['2026-11-11', null, '2026-11-09', null]]);
  });
  it('the dashboard offers it with the calendar; cards and both charts follow the range', () => {
    const c = readFileSync(resolve(__dirname, '../../src/features/production/ProductionDashboard.tsx'), 'utf8');
    expect(c).toContain("'Período personalizado'");
    expect(c).toContain('<CalendarioRango desde={rango.desde} hasta={rango.hasta} max={ayer}');
    expect(c).toContain("const comp = periodo === 'semana' ? semana : periodo === 'mes' ? mes : personalizado;");
    expect(c).toContain('serieHuevosRango(filas, personalizado)');
    expect(c).toContain('seriePostura(filas, personalizado.actual.desde, personalizado.actual.hasta');
    const k = readFileSync(resolve(__dirname, '../../src/features/production/CalendarioRango.tsx'), 'utf8');
    expect(k).toContain('const deshabilitado = f > max;');
    expect(k).toContain('Últimos {n} días');
  });
});

