/**
 * F27-A integration: target role resolution and the ADMIN / OPERATOR / no-access perimeter against the
 * guarded LOCAL stack only (127.0.0.1). Production is never reachable: the target URL is fixed, the database
 * guard must prove a local test target, production credentials in the environment abort the run, and the
 * keys used are the local stack's demo keys (iss supabase-demo), read from the running local container.
 *
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" npm run test:integration
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// plain .mjs guard shared with the target-db suites
import { assertNoProductionCredentials, assertSafeDestructiveTarget } from '../../scripts/test-env/guard.mjs';
import { resolveTargetRole } from '../../src/target/role';
import { modulesFor } from '../../src/target/roles';
import { callRpc, readView, TargetDbError } from '../../src/target/db';

const LOCAL_URL = 'http://127.0.0.1:54321';
assertNoProductionCredentials(process.env);
assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);

/**
 * Local stack keys, read from the running local edge-runtime container (the Supabase CLI binary can be blocked
 * by Windows Application Control). Each key must be a local demo JWT (iss supabase-demo) of the expected role.
 */
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
const admin = createClient(LOCAL_URL, keys.service, { auth: { persistSession: false, autoRefreshToken: false } });
const run = randomUUID().slice(0, 8);
const password = `F27a-${randomUUID()}`;
const users: Record<'ADMIN' | 'OPERATOR' | 'NONE', { email: string; id?: string; client?: SupabaseClient }> = {
  ADMIN: { email: `f27a-admin-${run}@example.invalid` },
  OPERATOR: { email: `f27a-operator-${run}@example.invalid` },
  NONE: { email: `f27a-noaccess-${run}@example.invalid` },
};

beforeAll(async () => {
  for (const [role, u] of Object.entries(users)) {
    const { data, error } = await admin.auth.admin.createUser({ email: u.email, password, email_confirm: true });
    if (error) throw error;
    u.id = data.user!.id;
    if (role !== 'NONE') owner(`INSERT INTO perfiles (id, email, rol_type, activo) VALUES ('${u.id}', '${u.email}', '${role}', true);`);
    const client = createClient(LOCAL_URL, keys.anon, { auth: { persistSession: false, autoRefreshToken: false } });
    const s = await client.auth.signInWithPassword({ email: u.email, password });
    if (s.error) throw s.error;
    u.client = client;
  }
});

afterAll(async () => {
  const ids = Object.values(users).map((u) => u.id).filter(Boolean);
  if (ids.length) owner(`DELETE FROM perfiles WHERE id IN (${ids.map((i) => `'${i}'`).join(',')});`);
  for (const u of Object.values(users)) if (u.id) await admin.auth.admin.deleteUser(u.id);
});

describe('F27-A target auth / role perimeter (local stack)', () => {
  it('ADMIN login resolves ADMIN from current_app_role() and gets the full navigation', async () => {
    const role = await resolveTargetRole(users.ADMIN.client!);
    expect(role).toBe('ADMIN');
    expect(modulesFor(role)).toContain('admin');
    expect(await readView(users.ADMIN.client!, 'report_mp_delivery_health')).toHaveLength(1);
  });

  it('OPERATOR login resolves OPERATOR and gets only the production working set', async () => {
    const role = await resolveTargetRole(users.OPERATOR.client!);
    expect(role).toBe('OPERATOR');
    expect(modulesFor(role)).toEqual(['produccion', 'clasificacion', 'alimento']);   // F27-E working set
  });

  it('OPERATOR cannot obtain an ADMIN-only surface: the database refuses it (RLS / in-body check), not the frontend', async () => {
    const c = users.OPERATOR.client!;
    expect(await readView(c, 'report_sales_line')).toEqual([]);
    expect(await readView(c, 'report_mp_delivery_health')).toEqual([]);
    const err = await callRpc(c, 'mp_requeue_config_blocked', { p_reason: 'f27a probe' }).catch((e) => e);
    expect(err).toBeInstanceOf(TargetDbError);
    expect((err as TargetDbError).code).toBe('FORBIDDEN');
  });

  it('a user without an active target profile (e.g. a former repartidor) gets no role, no module and no business data', async () => {
    const c = users.NONE.client!;
    const role = await resolveTargetRole(c);
    expect(role).toBeNull();
    expect(modulesFor(role)).toEqual([]);
    // the ADMIN-filtered views evaluate current_app_role(), which refuses a user without an active profile outright
    const viewErr = await readView(c, 'report_sales_line').catch((e) => e);
    expect(viewErr).toBeInstanceOf(TargetDbError);
    expect((viewErr as TargetDbError).code).toBe('USER_NOT_FOUND_OR_INACTIVE');
    const err = await callRpc(c, 'mp_flag_for_attribution', { p_movement_id: 1, p_reason: 'f27a probe' }).catch((e) => e);
    expect(err).toBeInstanceOf(TargetDbError);
    expect(['FORBIDDEN', 'USER_NOT_FOUND_OR_INACTIVE']).toContain((err as TargetDbError).code);
  });
});
