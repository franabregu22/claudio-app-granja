/** Producción → Exportar CSV: Spanish-locale CSV (; and decimal comma), every page read, the same rows as the list. */
import { describe, expect, it } from 'vitest';
import { listAllProduction, PRODUCCION_CSV_CABECERA, produccionCsvFila, type FlockDay } from '../../src/target/production';
import { aCsv } from '../../src/utils/csv';

const dia = (o: Partial<FlockDay>): FlockDay => ({
  flock_id: 'f', shed_id: 's', shed_nombre: 'Galpón 1', genetics_line: 'Hy-Line', business_date: '2026-11-14', daily_production_id: 'd', eggs_total: 950,
  eggs_broken: 3, eggs_dirty: 5, mortality: 1, count_adjustment: 0, population: 1000, age_weeks: 30, laying_pct: 95.25, expected_laying_pct: 94,
  quality_data_warning: false, ...o,
});

describe('Producción — exportar CSV', () => {
  it('Spanish-locale CSV: BOM, «;», decimal comma, quoted text when needed, empty for null', () => {
    const csv = aCsv(PRODUCCION_CSV_CABECERA, [produccionCsvFila(dia({ shed_nombre: 'Galpón "A"; norte', eggs_dirty: null }))]);
    expect(csv.startsWith('﻿Fecha;Galpón;Línea genética;')).toBe(true);
    expect(csv.split('\r\n')[1]).toBe('14/11/2026;"Galpón ""A""; norte";Hy-Line;30;1000;950;3;;95,25;94;1;0');
  });
  it('reads every page (1000 rows each) and asks only for the days the list shows, oldest first', async () => {
    const calls: { or?: string; range: [number, number] }[] = [];
    const client = {
      from: () => {
        const st: { or?: string } = {};
        const q = {
          select: () => q, or: (f: string) => { st.or = f; return q; }, order: () => q,
          range: async (a: number, b: number) => {
            calls.push({ or: st.or, range: [a, b] });
            const n = a === 0 ? 1000 : 3;
            return { data: Array.from({ length: n }, () => dia({})), error: null, count: 1003 };
          },
        };
        return q;
      },
    };
    const rows = await listAllProduction(client as never);
    expect(rows).toHaveLength(1003);
    expect(calls.map((c) => c.range)).toEqual([[0, 999], [1000, 1999]]);
    expect(calls[0].or).toBe('daily_production_id.not.is.null,mortality.neq.0,count_adjustment.neq.0');
  });
});
