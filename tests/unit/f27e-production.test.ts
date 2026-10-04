import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canSeeModule, modulesFor, resolveModule } from '../../src/target/roles';
import {
  latestPerFlock, listFlockDays, rectifyDailyProduction, rectifyMortality, registerCountAdjustment, registerDailyProduction, registerMortality, shiftDate,
  type FlockDay,
} from '../../src/target/production';
import { registerClassification } from '../../src/target/classification';
import { FEED_MOVEMENT_TYPES, listConsumptionIntervals, registerFeedManufacturing, registerFeedMovement } from '../../src/target/feed';

/** PostgREST-shaped stub recording every read / rpc, answering from a queue. */
function stub(results: { data: unknown; error: unknown }[] = []) {
  const calls: { kind: string; table?: string; fn?: string; args?: unknown; columns?: string }[] = [];
  const next = () => results.shift() ?? { data: {}, error: null };
  const client = {
    from(table: string) {
      let columns = '';
      const q: any = {
        select: (c: string) => { columns = c; return q; }, eq: () => q, gte: () => q, lte: () => q, order: () => q, limit: () => q,
        then: (res: (v: unknown) => void) => { calls.push({ kind: 'select', table, columns }); res(next()); },
      };
      return q;
    },
    rpc: async (fn: string, args: unknown) => { calls.push({ kind: 'rpc', fn, args }); return next(); },
  };
  return { client: client as never, calls };
}
const day = (flock: string, date: string, population: number, laying: number | null): FlockDay => ({
  flock_id: flock, shed_id: 's', shed_nombre: 'G', genetics_line: null, business_date: date, daily_production_id: null, eggs_total: null,
  eggs_broken: null, eggs_dirty: null, mortality: 0, count_adjustment: 0, population, age_weeks: null, laying_pct: laying, expected_laying_pct: null,
  quality_data_warning: false,
});

describe('F27-E production data layer', () => {
  it('daily production / rectification / mortality / count adjustment send exactly the contract arguments', async () => {
    const { client, calls } = stub();
    await registerDailyProduction(client, { flockId: 'f', date: '2026-09-29', eggsTotal: 800, eggsBroken: 10, eggsDirty: 5, reason: ' ' });
    await rectifyDailyProduction(client, { productionId: 'p', eggsTotal: 790, eggsBroken: 12, eggsDirty: 5, reason: 'r' });
    await registerMortality(client, { flockId: 'f', date: '2026-09-29', deaths: 20 });
    await rectifyMortality(client, { eventId: 7, deaths: 15, reason: 'r' });
    await registerCountAdjustment(client, { flockId: 'f', date: '2026-09-30', delta: -3, reason: 'r' });
    expect(calls).toEqual([
      { kind: 'rpc', fn: 'register_daily_production', args: { p_flock_id: 'f', p_production_date: '2026-09-29', p_eggs_total: 800, p_eggs_broken: 10, p_eggs_dirty: 5, p_reason: null } },
      { kind: 'rpc', fn: 'rectify_daily_production', args: { p_production_id: 'p', p_new_eggs_total: 790, p_new_eggs_broken: 12, p_new_eggs_dirty: 5, p_reason: 'r' } },
      { kind: 'rpc', fn: 'register_mortality', args: { p_flock_id: 'f', p_event_date: '2026-09-29', p_deaths: 20, p_reason: null } },
      { kind: 'rpc', fn: 'rectify_mortality', args: { p_event_id: 7, p_new_deaths: 15, p_reason: 'r' } },
      { kind: 'rpc', fn: 'register_count_adjustment', args: { p_flock_id: 'f', p_event_date: '2026-09-30', p_delta: -3, p_reason: 'r' } },
    ]);
  });

  it('population and laying % are read from report_flock_day as reported, never recomputed', async () => {
    const { client, calls } = stub([{ data: [{ ...day('f', '2026-09-29', 980, 81.6), population: '980', laying_pct: '81.63', eggs_total: 800 }], error: null }]);
    const [d] = await listFlockDays(client, '2026-09-01', '2026-09-30');
    expect(calls[0]).toMatchObject({ kind: 'select', table: 'report_flock_day' });
    expect(d).toMatchObject({ population: 980, laying_pct: 81.63, eggs_total: 800 });
  });

  it('latestPerFlock keeps the first (newest) row of each flock; shiftDate moves calendar days', () => {
    const rows = [day('a', '2026-09-30', 990, 80), day('b', '2026-09-30', 500, 70), day('a', '2026-09-29', 1000, 79)];
    expect(latestPerFlock(rows).map((r) => [r.flock_id, r.population])).toEqual([['a', 990], ['b', 500]]);
    expect(shiftDate('2026-10-01', -1)).toBe('2026-09-30');
    expect(shiftDate('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('F27-E classification and feed data layer', () => {
  it('a classification session is one call with the grade ids from reference data (no frontend grade constants)', async () => {
    const { client, calls } = stub();
    await registerClassification(client, { idempotencyKey: 'k', date: '2026-09-29', lines: [{ classification_grade_id: 'g1', quantity: 300 }], location: ' ', reason: null });
    expect(calls[0]).toEqual({ kind: 'rpc', fn: 'register_classification', args: {
      p_idempotency_key: 'k', p_classification_date: '2026-09-29', p_lines: [{ classification_grade_id: 'g1', quantity: 300 }], p_location: null, p_reason: null,
    } });
  });

  it('feed writes go through their RPCs; the consumption view is read in kg only (no cost column requested)', async () => {
    const { client, calls } = stub([{ data: {}, error: null }, { data: {}, error: null }, { data: [], error: null }]);
    await registerFeedManufacturing(client, { formulaVersionId: 'v', date: '2026-09-29', quantityKg: 1000, idempotencyKey: 'FAB-1' });
    await registerFeedMovement(client, { feedTypeId: 't', type: 'LOSS', quantityKg: 5, date: '2026-09-29', reason: 'x' });
    await listConsumptionIntervals(client);
    expect(calls[0]).toMatchObject({ fn: 'register_feed_manufacturing', args: { p_idempotency_key: 'FAB-1', p_batch_number: null } });
    expect(calls[1]).toMatchObject({ fn: 'register_feed_movement', args: { p_movement_type: 'LOSS', p_pedido_id: null } });
    expect(calls[2].table).toBe('report_feed_consumption_interval');
    expect(calls[2].columns).not.toMatch(/cost|precio|price|monto|amount/i);
    expect([...FEED_MOVEMENT_TYPES]).toEqual(['EXTERNAL_SALE', 'LOSS', 'ADJUSTMENT_POSITIVE', 'ADJUSTMENT_NEGATIVE']);
  });

  it('OPERATOR working set: production, classification and feed only (no Dashboard, owner decision 2026-10-04)', () => {
    expect(modulesFor('OPERATOR')).toEqual(['produccion', 'clasificacion', 'alimento']);
    expect(canSeeModule('OPERATOR', 'dashboard_produccion')).toBe(false);
    expect(modulesFor('ADMIN')).toEqual(expect.arrayContaining(['dashboard_produccion', 'clasificacion', 'alimento']));
  });

  it('module access control: an OPERATOR request for the Dashboard resolves to an allowed module; ADMIN unchanged', () => {
    expect(resolveModule('OPERATOR', 'dashboard_produccion')).toBe('produccion');
    expect(resolveModule('OPERATOR', 'admin')).toBe('produccion');
    expect(resolveModule('OPERATOR', 'pedidos')).toBe('produccion');
    expect(resolveModule('OPERATOR', 'alimento')).toBe('alimento');
    expect(resolveModule('ADMIN', 'dashboard_produccion')).toBe('dashboard_produccion');
    expect(resolveModule('ADMIN', 'pedidos')).toBe('pedidos');
    expect(resolveModule(null, 'dashboard_produccion')).toBeNull();
  });

  it('App renders modules only through resolveModule (no direct tab render path)', () => {
    const app = readFileSync(resolve(__dirname, '../../src/App.tsx'), 'utf8');
    expect(app).toMatch(/const currentTab = resolveModule\(rol, tab\)/);
    expect(app).not.toMatch(/tab === 'dashboard_produccion'/);
    expect(app).toMatch(/currentTab === 'dashboard_produccion' && <ProductionDashboard \/>/);
  });
});

describe('F27-E migrated files carry no legacy or duplicated authority', () => {
  const SRC = resolve(__dirname, '../../src');
  const FILES = ['target/production.ts', 'target/classification.ts', 'target/feed.ts', 'features/production/useProduction.ts',
    'features/production/ProductionApp.tsx', 'features/production/FormProduccion.tsx', 'features/production/ProductionDashboard.tsx',
    'features/production/ClasificacionApp.tsx', 'features/production/AlimentoApp.tsx'];

  it.each(FILES)('%s: no legacy table / hook / role, no direct PostgREST call, no population or laying computation', (f) => {
    const text = readFileSync(resolve(SRC, f), 'utf8');
    for (const n of ['producciones', 'lotes', 'recuentos_lote', 'dueño', 'colaborador', 'repartidor']) expect(text).not.toMatch(new RegExp(`['"\`]${n}['"\`]`));
    expect(text).not.toMatch(/(?<!Array)\.from\(/);
    expect(text).not.toMatch(/\.(insert|update|delete|upsert)\(/);
    expect(text).not.toMatch(/hooks\/use(Lotes|Producciones|Recuentos)\b|api\/(lotes|producciones|recuentos)\b|produccionCalculos|produccionHelpers/);
    // no local population / laying arithmetic: those values only come from report_flock_day
    expect(text).not.toMatch(/initial_population\s*[-+]|eggs_total\s*\/|\/\s*population|avesActuales|calcularPostura|huevos_sanos/i);
    expect(text).not.toMatch(/unit_cost|precio|costo/i);
  });

  it('the legacy production authorities are gone', () => {
    for (const f of ['api/lotes.ts', 'api/producciones.ts', 'api/recuentos.ts', 'hooks/useLotes.ts', 'hooks/useProducciones.ts', 'hooks/useRecuentos.ts',
      'features/production/produccionCalculos.ts', 'features/production/produccionHelpers.ts', 'features/production/DashboardProduccion.tsx',
      'features/production/ListaProducciones.tsx']) {
      expect(existsSync(resolve(SRC, f)), f).toBe(false);
    }
  });
});
