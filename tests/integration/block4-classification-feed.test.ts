/**
 * Phase 27 acceptance fixes block 4 (ADR-012 / ADR-013) through the frontend data layer against the guarded LOCAL
 * stack only (127.0.0.1, local demo keys read from the running container):
 *   - classification sessions entered in UNIDAD / MAPLE, listed per day with their exact entry, rectified as a new
 *     version (the daily report counts the effective version only);
 *   - feed formula publication through RPC 48 (versions, automatic close, composition, selector by date, no direct path).
 *
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" npx vitest run tests/integration/block4-classification-feed.test.ts
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertNoProductionCredentials, assertSafeDestructiveTarget } from '../../scripts/test-env/guard.mjs';
import { TargetDbError, writeTable } from '../../src/target/db';
import { listClassificationDays, listGrades, listSessions, rectifyClassification, registerClassification } from '../../src/target/classification';
import {
  listFormulaComposition, listFormulaVersions, publishFormulaVersion, registerFeedManufacturing, versionsEffectiveOn,
} from '../../src/target/feed';
import { createMaster } from '../../src/target/masters';

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
const TAG = `B4-${run}`;
const password = `B4-${randomUUID()}`;
const users: Record<'ADMIN' | 'OPERATOR', { email: string; id?: string; client?: SupabaseClient }> = {
  ADMIN: { email: `b4-admin-${run}@example.invalid` },
  OPERATOR: { email: `b4-operator-${run}@example.invalid` },
};
const admin = () => users.ADMIN.client!;
const operator = () => users.OPERATOR.client!;
const code = (e: unknown) => (e instanceof TargetDbError ? e.code : String(e));
const DAY = '2026-05-27';
const fx = { today: '', yesterday: '', g: {} as Record<string, string> };

const TYPES = `(SELECT id FROM feed_type WHERE nombre LIKE '${TAG}%')`;
const VERSIONS = `(SELECT id FROM feed_formula_version WHERE feed_type_id IN ${TYPES})`;
function cleanup() {
  owner(`
CREATE TEMP TABLE _c AS SELECT id FROM classification WHERE location = '${TAG}';
DELETE FROM classification_line WHERE classification_id IN (SELECT id FROM _c);
UPDATE classification SET supersedes_id = NULL, version_seq = 0, rectification_reason = NULL WHERE id IN (SELECT id FROM _c);
DELETE FROM classification WHERE id IN (SELECT id FROM _c);
DELETE FROM feed_manufacturing WHERE formula_version_id IN ${VERSIONS};
DELETE FROM feed_formula_line WHERE formula_version_id IN ${VERSIONS};
DELETE FROM feed_formula_version WHERE feed_type_id IN ${TYPES};
DELETE FROM feed_type WHERE nombre LIKE '${TAG}%';
DELETE FROM feed_ingredient WHERE nombre LIKE '${TAG}%';`);
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
  fx.today = owner(`SELECT (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE;`);
  fx.yesterday = owner(`SELECT ((now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE - 1);`);
  for (const g of await listGrades(admin())) fx.g[g.nombre] = g.id;
});

afterAll(async () => {
  cleanup();
  const ids = Object.values(users).map((u) => u.id).filter(Boolean);
  const idList = ids.map((i) => `'${i}'`).join(',');
  if (ids.length) owner(`DELETE FROM audit_events WHERE performed_by IN (${idList});\nDELETE FROM perfiles WHERE id IN (${idList});`);
  for (const u of Object.values(users)) if (u.id) await service.auth.admin.deleteUser(u.id);
});

describe('ADR-012 classification: units, sessions, rectification', () => {
  it('a mixed-unit session is converted by the backend and listed with its exact entry', async () => {
    const before = (await listClassificationDays(admin(), DAY, DAY))[0]?.day_total ?? 0;
    const r = await registerClassification(operator(), { idempotencyKey: randomUUID(), date: DAY, location: TAG, lines: [
      { classification_grade_id: fx.g.N1, quantity: 3, unit: 'MAPLE' },
      { classification_grade_id: fx.g.XL, quantity: 2, unit: 'MAPLE' },
      { classification_grade_id: fx.g.Sucios, quantity: 3, unit: 'UNIDAD' },
    ] });
    expect(r.total_quantity).toBe(133);
    await registerClassification(operator(), { idempotencyKey: randomUUID(), date: DAY, location: TAG, lines: [{ classification_grade_id: fx.g.N2, quantity: 1, unit: 'MAPLE' }] });
    const sessions = (await listSessions(operator(), DAY)).filter((s) => s.current.location === TAG);
    expect(sessions).toHaveLength(2);
    const s1 = sessions.find((s) => s.current.id === r.classification_id)!;
    expect(s1.current.total).toBe(133);
    expect(s1.current.lines.map((l) => [l.grade_nombre, l.entered_quantity, l.entered_unit, l.quantity])).toEqual([
      ['N1', 3, 'MAPLE', 90], ['Sucios', 3, 'UNIDAD', 3], ['XL', 2, 'MAPLE', 40],
    ]);
    expect(s1.history).toEqual([]);
    const after = (await listClassificationDays(admin(), DAY, DAY))[0]?.day_total ?? 0;
    expect(after - before).toBe(163);
  });

  it('rectification needs a reason, keeps the prior version and the report counts only the effective one', async () => {
    const [s] = (await listSessions(operator(), DAY)).filter((x) => x.current.location === TAG && x.current.total === 133);
    const before = (await listClassificationDays(admin(), DAY, DAY))[0].day_total;
    const noReason = await rectifyClassification(operator(), { idempotencyKey: randomUUID(), classificationId: s.current.id, reason: ' ',
      lines: [{ classification_grade_id: fx.g.N1, quantity: 2, unit: 'MAPLE' }] }).catch((e) => e);
    expect(code(noReason)).toBe('REASON_REQUIRED');
    const r = await rectifyClassification(operator(), { idempotencyKey: randomUUID(), classificationId: s.current.id, reason: 'un maple de más',
      lines: [{ classification_grade_id: fx.g.N1, quantity: 2, unit: 'MAPLE' }, { classification_grade_id: fx.g.XL, quantity: 2, unit: 'MAPLE' },
        { classification_grade_id: fx.g.Sucios, quantity: 3, unit: 'UNIDAD' }] });
    expect(r.total_quantity).toBe(103);
    const sessions = (await listSessions(operator(), DAY)).filter((x) => x.current.location === TAG);
    expect(sessions).toHaveLength(2);
    const now = sessions.find((x) => x.current.id === r.classification_id)!;
    expect(now.current.rectification_reason).toBe('un maple de más');
    expect(now.history.map((h) => [h.id, h.total])).toEqual([[s.current.id, 133]]);
    const report = await listClassificationDays(admin(), DAY, DAY);
    expect(report[0].day_total).toBe(before - 30);
    const again = await rectifyClassification(operator(), { idempotencyKey: randomUUID(), classificationId: s.current.id, reason: 'x',
      lines: [{ classification_grade_id: fx.g.N1, quantity: 1, unit: 'UNIDAD' }] }).catch((e) => e);
    expect(code(again)).toBe('CLASSIFICATION_SUPERSEDED');
  });
});

describe('ADR-013 feed formula publication', () => {
  it('ADMIN publishes versions through RPC 48; the previous closes; the selector offers the effective one', async () => {
    const tipo = (await createMaster<{ id: string }>(admin(), 'feed_type', { nombre: `${TAG} Ponedoras prueba`, feed_category: 'LAYER' })).id;
    const maiz = (await createMaster<{ id: string }>(admin(), 'feed_ingredient', { nombre: `${TAG} Maíz prueba`, unit_type: 'KG' })).id;
    const soja = (await createMaster<{ id: string }>(admin(), 'feed_ingredient', { nombre: `${TAG} Soja prueba`, unit_type: 'KG' })).id;

    const denied = await publishFormulaVersion(operator(), { feedTypeId: tipo, effectiveFrom: '2026-01-01', lines: [{ ingredientId: maiz, quantityKg: 1 }] }).catch((e) => e);
    expect(code(denied)).toBe('FORBIDDEN');
    const empty = await publishFormulaVersion(admin(), { feedTypeId: tipo, effectiveFrom: '2026-01-01', lines: [] }).catch((e) => e);
    expect(code(empty)).toBe('EMPTY_LINE_SET');

    const v1 = await publishFormulaVersion(admin(), { feedTypeId: tipo, effectiveFrom: '2026-01-01', lines: [{ ingredientId: maiz, quantityKg: 60 }, { ingredientId: soja, quantityKg: 40 }] });
    const m = await registerFeedManufacturing(admin(), { formulaVersionId: v1.formula_version_id, date: fx.yesterday, quantityKg: 100, idempotencyKey: `${TAG}-M1` });
    expect(m.manufacturing_id).toBeTruthy();
    const v2 = await publishFormulaVersion(admin(), { feedTypeId: tipo, effectiveFrom: fx.today, lines: [{ ingredientId: maiz, quantityKg: 55 }, { ingredientId: soja, quantityKg: 45 }] });
    expect([v1.version, v2.version, v2.closed_version_id]).toEqual([1, 2, v1.formula_version_id]);

    const versions = (await listFormulaVersions(admin())).filter((v) => v.feed_type_id === tipo);
    expect(versions.map((v) => [v.version, v.effective_from, v.effective_to]).sort()).toEqual([[1, '2026-01-01', fx.yesterday], [2, fx.today, null]]);
    expect(versionsEffectiveOn(versions, fx.today).map((v) => v.version)).toEqual([2]);
    expect(versionsEffectiveOn(versions, fx.yesterday).map((v) => v.version)).toEqual([1]);
    const comp = await listFormulaComposition(admin(), [v1.formula_version_id]);
    expect(comp.map((l) => [l.ingredient_name, l.quantity_kg]).sort()).toEqual([[`${TAG} Maíz prueba`, 60], [`${TAG} Soja prueba`, 40]]);

    const stale = await registerFeedManufacturing(admin(), { formulaVersionId: v1.formula_version_id, date: fx.today, quantityKg: 1, idempotencyKey: `${TAG}-M2` }).catch((e) => e);
    expect(code(stale)).toBe('FORMULA_VERSION_NOT_EFFECTIVE');
    const conflict = await publishFormulaVersion(admin(), { feedTypeId: tipo, effectiveFrom: fx.today, lines: [{ ingredientId: maiz, quantityKg: 1 }] }).catch((e) => e);
    expect(code(conflict)).toBe('FORMULA_VERSION_DATE_CONFLICT');
    await expect(writeTable(admin(), 'feed_formula_version' as never, 'insert' as never, {})).rejects.toMatchObject({ code: 'DIRECT_WRITE_NOT_ALLOWED' });
    const raw = await admin().from('feed_formula_line').insert({ formula_version_id: v2.formula_version_id, ingredient_id: maiz, quantity_kg: 1 }).select();
    expect(raw.error).not.toBeNull();
  });
});
