/**
 * ADR-017 test fixture — LOCAL TEST DATABASE ONLY.
 *
 * Since migration 0071, RPC 40 refuses to normalize anything until `mp_cutover_boundary` holds the
 * cutover instant (fail safe). The pre-existing MP suites test post-cutover behaviour, so this helper
 * records a synthetic boundary far in the past (2000-01-01T00:00:00Z, import_batch LOCAL-TEST-FIXTURE):
 * every fixture payment is then "after the cutover" and keeps its ADR-006 behaviour.
 *
 * Idempotent (ON CONFLICT DO NOTHING; the singleton is never updated). Guarded: refuses any target that
 * is not the local test stack. The Phase 31 cutover runner refuses a target that carries this row.
 */
import { spawnSync } from 'node:child_process';
import { assertSafeDestructiveTarget } from './guard.mjs';

export const LOCAL_TEST_BOUNDARY_BATCH = 'LOCAL-TEST-FIXTURE';

export function ensureLocalMpBoundary() {
  assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);
  const c = (spawnSync('docker', ['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout || '')
    .trim().split('\n').filter(Boolean)[0];
  if (!c) throw new Error('ensureLocalMpBoundary: no local supabase_db container');
  const sql = `INSERT INTO mp_cutover_boundary (cutover_at, import_batch, evidence_ref)
VALUES ('2000-01-01T00:00:00Z', '${LOCAL_TEST_BOUNDARY_BATCH}', 'local test fixture: every fixture payment is after this boundary')
ON CONFLICT (singleton) DO NOTHING;`;
  const r = spawnSync('docker', ['exec', '-i', c, 'psql', '-U', 'postgres', '-d', 'postgres', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    { encoding: 'utf8', input: sql });
  if (r.status !== 0) throw new Error(`ensureLocalMpBoundary failed: ${r.stderr}`);
}
