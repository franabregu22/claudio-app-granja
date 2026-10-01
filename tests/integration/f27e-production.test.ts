/**
 * F27-E integration: production, flock population, classification and feed through the frontend data layer
 * (src/target/{production,classification,feed}.ts) against the guarded LOCAL stack only (127.0.0.1, local demo
 * keys read from the running container). OPERATOR acts only on its assigned flock; population and laying % are
 * read from report_flock_day; ADR-007 refuses activity after a flock's exit; nothing is written directly.
 *
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" npm run test:integration
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertNoProductionCredentials, assertSafeDestructiveTarget } from '../../scripts/test-env/guard.mjs';
import { TargetDbError, writeTable } from '../../src/target/db';
import { assignOperator, closeFlock, createMaster, registerFlock } from '../../src/target/masters';
import {
  latestPerFlock, listFlockDays, listFlockOptions, listMortalityEvents, rectifyDailyProduction, rectifyMortality, registerCountAdjustment,
  registerDailyProduction, registerMortality,
} from '../../src/target/production';
import { listClassificationDays, listGrades, registerClassification } from '../../src/target/classification';
import {
  assignFlockFeed, listConsumptionIntervals, listFeedTypes, listFlockFeed, listFormulaVersions, publishFormulaVersion, registerFeedInventoryCount,
  registerFeedManufacturing, registerFeedMovement,
} from '../../src/target/feed';

const LOCAL_URL = 'http://127.0.0.1:54321';
assertNoProductionCredentials(process.env);
assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);

function localKeys(): { anon: string; service: string } {
  const c = (spawnSync('docker', ['ps', '--filter', 'name=supabase_edge_runtime', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout || '')
    .trim().split('\n')[0];
  if (!c) throw new Error('local edge-runtime container not running');
  const env = (spawnSync('docker', ['inspect', c, '--format', '{{range .Config.Env}}{{println .}}{{end}}'], { encoding: 'utf8' }).stdout || '')
    .split(/\r?\n/);
  const get = (k: string) => (env.find((l) => l.startsWith(`${k}=`)) ?? '').slice(k.length + 1);
  const keys = { anon: get('SUPABASE_ANON_KEY'), service: get('SUPABASE_SERVICE_ROLE_KEY') };
  for (const [want, jwt] of [['anon', keys.anon], ['service_role', keys.service]] as const) {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString() || '{}');
    if (payload.iss !== 'supabase-demo' || payload.role !== want) throw new Error(`not a local demo ${want} key`);
  }
  return keys;
}
function owner(sql: string): string {
  const c = (spawnSync('docker', ['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout || '').trim().split('\n')[0];
  const r = spawnSync('docker', ['exec', '-i', c, 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    { encoding: 'utf8', input: sql });
  if (r.status !== 0) throw new Error(r.stderr);
  return (r.stdout || '').trim();
}

const keys = localKeys();
const service = createClient(LOCAL_URL, keys.service, { auth: { persistSession: false, autoRefreshToken: false } });
const run = randomUUID().slice(0, 8);
const TAG = `F27E-${run}`;
const password = `F27e-${randomUUID()}`;
const users: Record<'ADMIN' | 'OPERATOR', { email: string; id?: string; client?: SupabaseClient }> = {
  ADMIN: { email: `f27e-admin-${run}@example.invalid` },
  OPERATOR: { email: `f27e-operator-${run}@example.invalid` },
};
const admin = () => users.ADMIN.client!;
const operator = () => users.OPERATOR.client!;
const code = (e: unknown) => (e instanceof TargetDbError ? e.code : String(e));
const denied = (e: unknown) => e instanceof TargetDbError && ['PERMISSION_DENIED', 'RLS_DENIED', 'FORBIDDEN'].includes(e.code);
const day = (offset: number) => owner(`SELECT ((now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE + ${offset})::TEXT;`);
const fx = { shedA: '', shedB: '', flockA: '', flockB: '', grade1: '', grade2: '', feedType: '', formula: '', today: '' };
const flockDay = async (c: SupabaseClient, flockId: string, date: string) =>
  (await listFlockDays(c, date, date)).find((d) => d.flock_id === flockId);

const SHEDS = `(SELECT id FROM sheds WHERE nombre LIKE '${TAG}%')`;
const FLOCKS = `(SELECT id FROM flocks WHERE shed_id IN ${SHEDS})`;
const FEED = `(SELECT id FROM feed_type WHERE nombre LIKE '${TAG}%')`;
function cleanup() {
  owner(`
CREATE TEMP TABLE _c AS SELECT id FROM classification WHERE location LIKE '${TAG}%';
DELETE FROM audit_events WHERE entity_id IN (SELECT id::TEXT FROM ${FLOCKS} f UNION SELECT id::TEXT FROM _c)
   OR entity_id IN (SELECT id::TEXT FROM daily_production WHERE flock_id IN ${FLOCKS})
   OR entity_id IN (SELECT id::TEXT FROM population_events WHERE flock_id IN ${FLOCKS})
   OR entity_id IN (SELECT id::TEXT FROM flock_feed_assignment WHERE flock_id IN ${FLOCKS} OR feed_type_id IN ${FEED})
   OR entity_id IN (SELECT id::TEXT FROM feed_manufacturing WHERE idempotency_key LIKE '${TAG}%');
DELETE FROM classification_line WHERE classification_id IN (SELECT id FROM _c);
DELETE FROM classification WHERE id IN (SELECT id FROM _c);
DELETE FROM classification_grade WHERE nombre LIKE '${TAG}%';
DELETE FROM flock_feed_assignment WHERE flock_id IN ${FLOCKS} OR feed_type_id IN ${FEED};
DELETE FROM feed_manufacturing WHERE idempotency_key LIKE '${TAG}%';
DELETE FROM feed_movement WHERE feed_type_id IN ${FEED};
DELETE FROM feed_inventory_count WHERE feed_type_id IN ${FEED};
DELETE FROM feed_formula_line WHERE formula_version_id IN (SELECT id FROM feed_formula_version WHERE feed_type_id IN ${FEED});
DELETE FROM feed_formula_version WHERE feed_type_id IN ${FEED};
DELETE FROM feed_ingredient WHERE nombre LIKE '${TAG}%';
DELETE FROM feed_type WHERE nombre LIKE '${TAG}%';
UPDATE daily_production SET superseded_by = NULL WHERE flock_id IN ${FLOCKS};
DELETE FROM daily_production WHERE flock_id IN ${FLOCKS};
UPDATE population_events SET superseded_by = NULL WHERE flock_id IN ${FLOCKS};
DELETE FROM population_events WHERE flock_id IN ${FLOCKS};
DELETE FROM operator_assignments WHERE flock_id IN ${FLOCKS};
DELETE FROM flocks WHERE shed_id IN ${SHEDS};
DELETE FROM sheds WHERE nombre LIKE '${TAG}%';`);
}

beforeAll(async () => {
  for (const [role, u] of Object.entries(users)) {
    const { data, error } = await service.auth.admin.createUser({ email: u.email, password, email_confirm: true });
    if (error) throw error;
    u.id = data.user!.id;
    owner(`INSERT INTO perfiles (id, email, rol_type, activo) VALUES ('${u.id}', '${u.email}', '${role}', true);`);
    const client = createClient(LOCAL_URL, keys.anon, { auth: { persistSession: false, autoRefreshToken: false } });
    const s = await client.auth.signInWithPassword({ email: u.email, password });
    if (s.error) throw s.error;
    u.client = client;
  }
  fx.today = day(0);
  // masters and flocks through the F27-B layer (ADMIN)
  fx.shedA = (await createMaster<{ id: string }>(admin(), 'sheds', { nombre: `${TAG} galpón A`, capacidad: 2000 })).id;
  fx.shedB = (await createMaster<{ id: string }>(admin(), 'sheds', { nombre: `${TAG} galpón B`, capacidad: 2000 })).id;
  fx.flockA = (await registerFlock(admin(), { shedId: fx.shedA, entryDate: day(-10), initialPopulation: 1000 })).flock_id;
  fx.flockB = (await registerFlock(admin(), { shedId: fx.shedB, entryDate: day(-10), initialPopulation: 500 })).flock_id;
  await assignOperator(admin(), { operatorId: users.OPERATOR.id!, flockId: fx.flockA, userId: users.ADMIN.id! });
  fx.grade1 = ((await writeTable(admin(), 'classification_grade', 'insert', { nombre: `${TAG} N1` })) as { id: string }[])[0].id;
  fx.grade2 = ((await writeTable(admin(), 'classification_grade', 'insert', { nombre: `${TAG} N2` })) as { id: string }[])[0].id;
  fx.feedType = ((await writeTable(admin(), 'feed_type', 'insert', { nombre: `${TAG} postura`, feed_category: 'LAYER' })) as { id: string }[])[0].id;
  const ing = ((await writeTable(admin(), 'feed_ingredient', 'insert', { nombre: `${TAG} maíz` })) as { id: string }[])[0].id;
  // ADR-013: formula versions are published only through RPC 48 (atomic, no direct write path)
  fx.formula = (await publishFormulaVersion(admin(), { feedTypeId: fx.feedType, effectiveFrom: day(-30), lines: [{ ingredientId: ing, quantityKg: 1000 }] })).formula_version_id;
});

afterAll(async () => {
  cleanup();
  const ids = Object.values(users).map((u) => u.id).filter(Boolean);
  const idList = ids.map((i) => `'${i}'`).join(',');
  if (ids.length) owner(`DELETE FROM audit_events WHERE performed_by IN (${idList});\nDELETE FROM perfiles WHERE id IN (${idList});`);
  for (const u of Object.values(users)) if (u.id) await service.auth.admin.deleteUser(u.id);
});

describe('F27-E production (OPERATOR on its assigned flock)', () => {
  let productionId = '';

  it('OPERATOR sees only its assigned flock and registers the day; laying % comes from report_flock_day', async () => {
    expect((await listFlockOptions(operator())).map((f) => f.id)).toEqual([fx.flockA]);
    const r = await registerDailyProduction(operator(), { flockId: fx.flockA, date: day(-1), eggsTotal: 800, eggsBroken: 10, eggsDirty: 5 });
    productionId = r.production_id;
    const d = (await flockDay(operator(), fx.flockA, day(-1)))!;
    expect(d).toMatchObject({ daily_production_id: productionId, eggs_total: 800, eggs_broken: 10, eggs_dirty: 5, population: 1000 });
    expect(d.laying_pct).toBe(80);
    expect((await listFlockDays(operator(), day(-3), day(0))).every((x) => x.flock_id === fx.flockA)).toBe(true);
  });

  it('the backend refuses a duplicate day, an unassigned flock, a negative quantity and a date without an open period', async () => {
    const dup = await registerDailyProduction(operator(), { flockId: fx.flockA, date: day(-1), eggsTotal: 1, eggsBroken: 0, eggsDirty: 0 }).catch((e) => e);
    expect(code(dup)).toBe('DUPLICATE_PRODUCTION');
    const other = await registerDailyProduction(operator(), { flockId: fx.flockB, date: day(-1), eggsTotal: 1, eggsBroken: 0, eggsDirty: 0 }).catch((e) => e);
    expect(code(other)).toBe('FLOCK_NOT_ASSIGNED');
    const neg = await registerDailyProduction(operator(), { flockId: fx.flockA, date: day(-2), eggsTotal: -1, eggsBroken: 0, eggsDirty: 0 }).catch((e) => e);
    expect(code(neg)).toBe('INVALID_QUANTITY');
    const noPeriod = await registerDailyProduction(admin(), { flockId: fx.flockA, date: '2001-01-15', eggsTotal: 1, eggsBroken: 0, eggsDirty: 0 }).catch((e) => e);
    expect(code(noPeriod)).toBe('PERIOD_NOT_FOUND');
  });

  it('rectification needs a reason and replaces the current version; the view follows', async () => {
    const noReason = await rectifyDailyProduction(operator(), { productionId, eggsTotal: 790, eggsBroken: 10, eggsDirty: 5, reason: ' ' }).catch((e) => e);
    expect(code(noReason)).toBe('REASON_REQUIRED');
    const r = await rectifyDailyProduction(operator(), { productionId, eggsTotal: 790, eggsBroken: 12, eggsDirty: 5, reason: 'recuento de bandejas' });
    const d = (await flockDay(operator(), fx.flockA, day(-1)))!;
    expect(d).toMatchObject({ daily_production_id: r.new_id, eggs_total: 790, eggs_broken: 12 });
    const again = await rectifyDailyProduction(operator(), { productionId, eggsTotal: 1, eggsBroken: 0, eggsDirty: 0, reason: 'x' }).catch((e) => e);
    expect(code(again)).toBe('ALREADY_SUPERSEDED');
  });
});

describe('F27-E mortality and population (read from report_flock_day)', () => {
  it('mortality lowers the reported population; a second entry for the day is refused; only ADMIN rectifies', async () => {
    await registerMortality(operator(), { flockId: fx.flockA, date: day(-1), deaths: 20 });
    expect((await flockDay(operator(), fx.flockA, day(0)))!.population).toBe(980);
    const dup = await registerMortality(operator(), { flockId: fx.flockA, date: day(-1), deaths: 1 }).catch((e) => e);
    expect(code(dup)).toBe('MORTALITY_ALREADY_RECORDED');
    const [ev] = await listMortalityEvents(operator(), fx.flockA, day(-1));
    expect(ev.deaths).toBe(20);
    expect(denied(await rectifyMortality(operator(), { eventId: ev.id, deaths: 15, reason: 'error' }).catch((e) => e))).toBe(true);
    await rectifyMortality(admin(), { eventId: ev.id, deaths: 15, reason: 'recuento corregido' });
    expect((await flockDay(admin(), fx.flockA, day(0)))!.population).toBe(985);
  });

  it('a count adjustment needs a reason and moves the population; OPERATOR cannot adjust a flock it is not assigned to', async () => {
    const noReason = await registerCountAdjustment(operator(), { flockId: fx.flockA, date: day(0), delta: 5, reason: '' }).catch((e) => e);
    expect(code(noReason)).toBe('REASON_REQUIRED');
    await registerCountAdjustment(operator(), { flockId: fx.flockA, date: day(0), delta: 5, reason: 'recuento físico' });
    expect((await flockDay(operator(), fx.flockA, day(0)))!.population).toBe(990);
    const other = await registerCountAdjustment(operator(), { flockId: fx.flockB, date: day(0), delta: 1, reason: 'x' }).catch((e) => e);
    expect(code(other)).toBe('FLOCK_NOT_ASSIGNED');
    const latest = latestPerFlock(await listFlockDays(admin(), day(-3), day(0)));
    expect(latest.find((d) => d.flock_id === fx.flockA)?.population).toBe(990);
  });

  it('ADR-007: after a flock exits, activity dated after the exit is refused; a correction on or before the exit is valid', async () => {
    await closeFlock(admin(), { flockId: fx.flockB, exitDate: day(-3) });
    const after = await registerMortality(admin(), { flockId: fx.flockB, date: day(-2), deaths: 1 }).catch((e) => e);
    expect(code(after)).toBe('ACTIVITY_AFTER_FLOCK_EXIT');
    await registerMortality(admin(), { flockId: fx.flockB, date: day(-3), deaths: 2 });
    const adj = await registerCountAdjustment(admin(), { flockId: fx.flockB, date: day(-1), delta: -1, reason: 'x' }).catch((e) => e);
    expect(code(adj)).toBe('ACTIVITY_AFTER_FLOCK_EXIT');
    const prod = await registerDailyProduction(admin(), { flockId: fx.flockB, date: day(-4), eggsTotal: 1, eggsBroken: 0, eggsDirty: 0 }).catch((e) => e);
    expect(code(prod)).toBe('FLOCK_NOT_ACTIVE');
  });
});

describe('F27-E classification (reference grades, one idempotent session per call)', () => {
  it('OPERATOR registers a session; report_classification_day reports it; invalid sessions are refused', async () => {
    const grades = await listGrades(operator());
    expect(grades.map((g) => g.id)).toEqual(expect.arrayContaining([fx.grade1, fx.grade2]));
    const key = randomUUID();
    const r = await registerClassification(operator(), {
      idempotencyKey: key, date: day(-1), location: `${TAG} sala`, lines: [{ classification_grade_id: fx.grade1, quantity: 300, unit: 'UNIDAD' }, { classification_grade_id: fx.grade2, quantity: 100, unit: 'UNIDAD' }],
    });
    expect(r.total_quantity).toBe(400);
    const rows = (await listClassificationDays(admin(), day(-1), day(-1))).filter((x) => [fx.grade1, fx.grade2].includes(x.classification_grade_id));
    expect(rows.map((x) => x.quantity).sort()).toEqual([100, 300]);
    const dup = await registerClassification(operator(), { idempotencyKey: key, date: day(-1), lines: [{ classification_grade_id: fx.grade1, quantity: 1, unit: 'UNIDAD' }] }).catch((e) => e);
    expect(code(dup)).toBe('DUPLICATE_CLASSIFICATION');
    const empty = await registerClassification(operator(), { idempotencyKey: randomUUID(), date: day(-1), lines: [] }).catch((e) => e);
    expect(code(empty)).toBe('EMPTY_LINE_SET');
    const neg = await registerClassification(operator(), { idempotencyKey: randomUUID(), date: day(-1), lines: [{ classification_grade_id: fx.grade1, quantity: -1, unit: 'UNIDAD' }] }).catch((e) => e);
    expect(code(neg)).toBe('INVALID_QUANTITY');
    const twice = await registerClassification(operator(), {
      idempotencyKey: randomUUID(), date: day(-1), lines: [{ classification_grade_id: fx.grade1, quantity: 1, unit: 'UNIDAD' }, { classification_grade_id: fx.grade1, quantity: 2, unit: 'UNIDAD' }],
    }).catch((e) => e);
    expect(code(twice)).toBe('DUPLICATE_GRADE_IN_SESSION');
    const unknown = await registerClassification(operator(), { idempotencyKey: randomUUID(), date: day(-1), lines: [{ classification_grade_id: randomUUID(), quantity: 1, unit: 'UNIDAD' }] }).catch((e) => e);
    expect(code(unknown)).toBe('GRADE_NOT_FOUND');
  });
});

describe('F27-E feed (no inventory authority in the frontend)', () => {
  it('OPERATOR manufactures from the effective formula and counts stock; movements and flock assignment are ADMIN-only', async () => {
    expect((await listFeedTypes(operator())).map((t) => t.id)).toContain(fx.feedType);
    expect((await listFormulaVersions(operator())).map((v) => v.id)).toContain(fx.formula);
    await registerFeedInventoryCount(operator(), { feedTypeId: fx.feedType, date: day(-3), quantityKg: 500 });
    await registerFeedManufacturing(operator(), { formulaVersionId: fx.formula, date: day(-2), quantityKg: 1000, idempotencyKey: `${TAG}-M1` });
    const dupM = await registerFeedManufacturing(operator(), { formulaVersionId: fx.formula, date: day(-2), quantityKg: 1000, idempotencyKey: `${TAG}-M1` }).catch((e) => e);
    expect(code(dupM)).toBe('DUPLICATE_MANUFACTURING');
    await registerFeedInventoryCount(operator(), { feedTypeId: fx.feedType, date: day(-1), quantityKg: 1200 });
    const dupC = await registerFeedInventoryCount(operator(), { feedTypeId: fx.feedType, date: day(-1), quantityKg: 1 }).catch((e) => e);
    expect(code(dupC)).toBe('DUPLICATE_COUNT');

    const interval = (await listConsumptionIntervals(admin())).find((i) => i.feed_type_id === fx.feedType)!;
    expect(interval).toMatchObject({ opening_kg: 500, manufactured_kg: 1000, closing_kg: 1200, internal_consumption_kg: 300 });

    expect(denied(await registerFeedMovement(operator(), { feedTypeId: fx.feedType, type: 'LOSS', quantityKg: 1, date: day(-1), reason: 'x' }).catch((e) => e))).toBe(true);
    expect(denied(await assignFlockFeed(operator(), { flockId: fx.flockA, feedTypeId: fx.feedType, effectiveFrom: day(-5) }).catch((e) => e))).toBe(true);
    const noReason = await registerFeedMovement(admin(), { feedTypeId: fx.feedType, type: 'LOSS', quantityKg: 5, date: day(-1) }).catch((e) => e);
    expect(code(noReason)).toBe('REASON_REQUIRED');
    await registerFeedMovement(admin(), { feedTypeId: fx.feedType, type: 'LOSS', quantityKg: 5, date: day(-1), reason: 'bolsa rota' });
  });

  it('ADMIN assigns feed to a flock (visible to its operator); an assignment after the flock exit is refused', async () => {
    await assignFlockFeed(admin(), { flockId: fx.flockA, feedTypeId: fx.feedType, effectiveFrom: day(-5) });
    expect((await listFlockFeed(operator())).map((a) => a.flock_id)).toEqual([fx.flockA]);
    const retired = await assignFlockFeed(admin(), { flockId: fx.flockB, feedTypeId: fx.feedType, effectiveFrom: day(-1) }).catch((e) => e);
    expect(code(retired)).toBe('ACTIVITY_AFTER_FLOCK_EXIT');
  });
});

describe('F27-E no direct path to production, population, classification or feed facts', () => {
  it('raw inserts are refused for ADMIN and OPERATOR, and the helper refuses before the network', async () => {
    for (const c of [admin(), operator()]) {
      expect((await c.from('daily_production').insert({ flock_id: fx.flockA, production_date: day(-5), eggs_total: 1 }).select()).error).not.toBeNull();
      expect((await c.from('population_events').insert({ flock_id: fx.flockA, event_type: 'MORTALITY', delta: -1, event_date: day(-5) }).select()).error).not.toBeNull();
      expect((await c.from('feed_movement').insert({ feed_type_id: fx.feedType, movement_type: 'LOSS', quantity_kg: 1, movement_date: day(-5) }).select()).error).not.toBeNull();
      expect((await c.from('classification').insert({ idempotency_key: randomUUID(), classification_date: day(-5) }).select()).error).not.toBeNull();
    }
    await expect(writeTable(admin(), 'daily_production' as never, 'insert' as never, {})).rejects.toMatchObject({ code: 'DIRECT_WRITE_NOT_ALLOWED' });
    expect((await flockDay(admin(), fx.flockA, day(-5)))?.eggs_total ?? null).toBeNull();
  });
});
