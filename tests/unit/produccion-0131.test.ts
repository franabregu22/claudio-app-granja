/** 0131 Producción (owner 2026-11-17): no «Sucios» / «% Esperado», % Rotos, the day edited with a reason (anyone), «Modificado» with who
 *  and what, notes in the table, bird counts by their total (only the last one deleted), column filters, the whole table on a phone. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  brokenPct, codigoLote, describeDayEdit, editProductionDay, horaActual, lastValidCount, registerBirdCount, registerProductionDay, voidBirdCount, type BirdCount,
} from '../../src/target/production';

function stub() {
  const calls: { fn: string; args: unknown }[] = [];
  const client = { rpc: async (fn: string, args: unknown) => { calls.push({ fn, args }); return { data: {}, error: null }; } };
  return { client: client as never, calls };
}
const src = (f: string) => readFileSync(resolve(__dirname, '../../src', f), 'utf8');
const conteo = (o: Partial<BirdCount>): BirdCount => ({
  id: 1, flock_id: 'f', date: '2026-11-16', counted: 2290, computed: 2304, difference: -14, reason: null, at: '2026-11-16T12:00:00Z', by: 'Ana',
  voided_at: null, voided_by: null, void_reason: null, ...o,
});

describe('0131 — production day, edits and counts', () => {
  it('the flock code: G + shed number + entry YYMM', () => {
    expect(codigoLote({ shed_nombre: 'Galpón 3', entry_date: '2025-01-03' })).toBe('G03-2501');
    expect(codigoLote({ shed_nombre: 'Galpón 12', entry_date: '2026-07-21' })).toBe('G12-2607');
    expect(codigoLote({ shed_nombre: 'Recría', entry_date: '2026-07-21' })).toBe('Recría-2607');
  });

  it('% Rotos over the day eggs; none without eggs', () => {
    expect(brokenPct({ eggs_total: 582, eggs_broken: 1 })).toBe(0.17);
    expect(brokenPct({ eggs_total: 0, eggs_broken: 0 })).toBeNull();
    expect(brokenPct({ eggs_total: null, eggs_broken: null })).toBeNull();
  });

  it('describes only the fields that changed', () => {
    expect(describeDayEdit({ before: { eggs_total: 582, eggs_broken: 1, deaths: 6, notes: null }, after: { eggs_total: 590, eggs_broken: 1, deaths: 4, notes: 'x' } }))
      .toBe('Huevos 582 → 590 · Mortandad 6 → 4 · Notas — → x');
    expect(describeDayEdit({ before: { deaths: 5 }, after: { deaths: 3 } })).toBe('Mortandad 5 → 3');   // an earlier rectify_mortality
    expect(describeDayEdit({ before: { time: '07:45', eggs_total: 1 }, after: { time: '08:10', eggs_total: 1 } })).toBe('Hora 07:45 → 08:10');
    expect(horaActual(new Date(2026, 10, 17, 7, 5))).toBe('07:05');
  });

  it('the last valid count is the newest not deleted', () => {
    expect(lastValidCount([conteo({ id: 3, voided_at: '2026-11-17T10:00:00Z' }), conteo({ id: 2 }), conteo({ id: 1 })])?.id).toBe(2);
    expect(lastValidCount([conteo({ voided_at: 'x' })])).toBeNull();
  });

  it('calls the 0131 RPCs with the contract arguments', async () => {
    const { client, calls } = stub();
    await registerProductionDay(client, { flockId: 'f', date: '2026-11-17', eggsTotal: 580, eggsBroken: 2, deaths: 0, notes: '  ', recordedTime: '07:45' });
    await editProductionDay(client, { flockId: 'f', date: '2026-11-17', eggsTotal: 590, eggsBroken: 2, deaths: 1, notes: 'nota', recordedTime: null, reason: 'mal contado' });
    await registerBirdCount(client, { flockId: 'f', date: '2026-11-17', counted: 2290 });
    await voidBirdCount(client, { countId: 9 });
    expect(calls).toEqual([
      { fn: 'register_production_day', args: { p_flock_id: 'f', p_date: '2026-11-17', p_eggs_total: 580, p_eggs_broken: 2, p_deaths: 0, p_notes: null, p_recorded_time: '07:45' } },
      { fn: 'edit_production_day', args: { p_flock_id: 'f', p_date: '2026-11-17', p_eggs_total: 590, p_eggs_broken: 2, p_deaths: 1, p_notes: 'nota', p_recorded_time: null, p_reason: 'mal contado' } },
      { fn: 'register_bird_count', args: { p_flock_id: 'f', p_date: '2026-11-17', p_counted: 2290, p_reason: null } },
      { fn: 'void_bird_count', args: { p_count_id: 9, p_reason: null } },
    ]);
  });
});

describe('0131 — Producción screen', () => {
  const app = src('features/production/ProductionApp.tsx');
  const form = src('features/production/FormProduccion.tsx');

  it('no dirty eggs and no expected curve anywhere in the module', () => {
    for (const t of [app, form, src('features/production/ProductionDashboard.tsx')]) {
      expect(t).not.toMatch(/Sucios|eggs_dirty|Esperado|expected_laying_pct|esperado/);
    }
  });

  it('the whole table on a phone: no column hidden by width', () => {
    expect(app).not.toMatch(/hidden (sm|md|lg|xl):table-cell/);
    expect(app).toMatch(/overflow-x-auto/);
    // nothing escapes the table's own scroll (an absolute sr-only label widened the page on Android and pushed «Nuevo» off screen)
    expect(app).toMatch(/className="relative w-full bg-white rounded-lg border border-amber-200 overflow-x-auto"/);
    expect(app).not.toMatch(/sr-only/);
    // all the page's rows visible, then the pages (no inner vertical scroll)
    expect(app).not.toMatch(/max-h-\[calc/);
  });

  it('columns, filters, notes, «Modificado», the pencil for everybody', () => {
    const titulos = [...app.slice(0, app.indexOf("function EditarDia")).matchAll(/<FiltroColumna titulo="([^"]+)"|>(Hora|Responsable|Lote|Huevos|Rotos|% Rotos|% Postura|Mortandad|Aves|Notas)<\/th>/g)].map((m) => m[1] ?? m[2]);
    expect(titulos).toEqual(['Fecha', 'Hora', 'Responsable', 'Galpón', 'Lote', 'Huevos', 'Rotos', '% Rotos', '% Postura', 'Mortandad', 'Aves', 'Notas']);
    expect(app).toMatch(/colSpan=\{13\}/);
    expect(app).toMatch(/info\.data\?\.get\(k\)\?\.by/);
    expect(app).toMatch(/Modificado/);
    expect(app).toMatch(/describeDayEdit\(e\)/);
    expect(app).not.toMatch(/rol === 'ADMIN'/);
    expect(app).toMatch(/const ITEMS_POR_PAGINA = 30;/);
  });

  it('the edit needs a reason; the count is entered as a total', () => {
    expect(app).toMatch(/Motivo de la modificación/);
    expect(app).toMatch(/motivo\.trim\(\) !== ''/);
    expect(app).toMatch(/Aves contadas/);
    expect(app).not.toMatch(/Diferencia de aves/);
    expect(app).toMatch(/ultimo\?\.id === c\.id/);
  });

  it('date and time come filled in and both can be changed', () => {
    expect(form).toMatch(/useState\(horaActual\(\)\)/);
    expect(form).toMatch(/type="time"/);
    expect(form).toMatch(/recordedTime: hora/);
    expect(app).toMatch(/Hora del registro/);
  });

  it('the day is registered in one call', () => {
    expect(form).toMatch(/registerDay\.mutate\(/);
    expect(form).not.toMatch(/mortality\.mutateAsync|register\.mutateAsync/);
  });
});
