import { describe, expect, it } from 'vitest';
import { inicioSemana, rangosPeriodo } from '../../src/features/pedidos/periodos';
import { getTodayDate } from '../../src/utils/dateUtils';

const r = (desde: string, hasta: string) => ({ desde, hasta });

describe('Pedidos dashboard — selected and comparison ranges', () => {
  it('semana: Monday → today vs the previous Monday → the same weekday (owner example 20/10/2026)', () => {
    expect(rangosPeriodo('semana', '2026-10-20', '', '')).toEqual({ actual: r('2026-10-19', '2026-10-20'), anterior: r('2026-10-12', '2026-10-13') });
  });

  it('semana: on a Monday both ranges are one day; on a Sunday the whole week', () => {
    expect(rangosPeriodo('semana', '2026-10-19', '', '')).toEqual({ actual: r('2026-10-19', '2026-10-19'), anterior: r('2026-10-12', '2026-10-12') });
    expect(rangosPeriodo('semana', '2026-10-25', '', '')).toEqual({ actual: r('2026-10-19', '2026-10-25'), anterior: r('2026-10-12', '2026-10-18') });
  });

  it('semana: across a month and a year boundary', () => {
    expect(rangosPeriodo('semana', '2026-11-03', '', '')).toEqual({ actual: r('2026-11-02', '2026-11-03'), anterior: r('2026-10-26', '2026-10-27') });
    expect(rangosPeriodo('semana', '2027-01-01', '', '')).toEqual({ actual: r('2026-12-28', '2027-01-01'), anterior: r('2026-12-21', '2026-12-25') });
  });

  it('mes: the 1st → today vs the 1st → the same day of the previous month (owner example 20/10/2026)', () => {
    expect(rangosPeriodo('mes', '2026-10-20', '', '')).toEqual({ actual: r('2026-10-01', '2026-10-20'), anterior: r('2026-09-01', '2026-09-20') });
  });

  it('mes: capped at the last day of the previous month (31 → 30, 31 → 28 / 29 in February)', () => {
    expect(rangosPeriodo('mes', '2026-10-31', '', '')).toEqual({ actual: r('2026-10-01', '2026-10-31'), anterior: r('2026-09-01', '2026-09-30') });
    expect(rangosPeriodo('mes', '2027-03-31', '', '')).toEqual({ actual: r('2027-03-01', '2027-03-31'), anterior: r('2027-02-01', '2027-02-28') });
    expect(rangosPeriodo('mes', '2028-03-30', '', '').anterior).toEqual(r('2028-02-01', '2028-02-29'));   // leap year
  });

  it('mes: January compares with December of the previous year', () => {
    expect(rangosPeriodo('mes', '2027-01-15', '', '')).toEqual({ actual: r('2027-01-01', '2027-01-15'), anterior: r('2026-12-01', '2026-12-15') });
  });

  it('personalizado: unchanged — the same number of days immediately before; an invalid range has no comparison', () => {
    expect(rangosPeriodo('personalizado', '2026-10-20', '2026-10-10', '2026-10-14')).toEqual({ actual: r('2026-10-10', '2026-10-14'), anterior: r('2026-10-05', '2026-10-09') });
    expect(rangosPeriodo('personalizado', '2026-10-20', '2026-01-01', '2026-01-01')).toEqual({ actual: r('2026-01-01', '2026-01-01'), anterior: r('2025-12-31', '2025-12-31') });
    expect(rangosPeriodo('personalizado', '2026-10-20', '2026-10-14', '2026-10-10').anterior).toBeNull();
  });

  it('dates are Buenos Aires calendar dates: no UTC shift (late evening in Argentina is already the next day in UTC)', () => {
    // 2026-10-20 23:30 in Buenos Aires = 2026-10-21 02:30 UTC
    const hoy = getTodayDate(new Date('2026-10-21T02:30:00Z'));
    expect(hoy).toBe('2026-10-20');
    expect(rangosPeriodo('semana', hoy, '', '').actual).toEqual(r('2026-10-19', '2026-10-20'));
    expect(inicioSemana('2026-10-20')).toBe('2026-10-19');
  });
});
