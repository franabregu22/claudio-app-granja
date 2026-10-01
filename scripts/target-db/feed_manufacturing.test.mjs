#!/usr/bin/env node
/**
 * ADR-014 — FEED MANUFACTURING HISTORY + RECTIFICATION (Phase 27 acceptance fixes block 4 follow-up,
 * owner D-FEED-7 / D-FEED-8). LOCAL TEST DATABASE ONLY.
 *
 *   * RPC 49 rectify_feed_manufacturing replaces one whole current record with a new version (mandatory reason);
 *     ADMIN any current record, OPERATOR only a chain it started; the prior version is kept and stops being current;
 *   * report_feed_consumption_interval counts current versions only (manufactured kg and internal consumption);
 *   * history: a manufacturing row keeps its exact formula version; that version's composition never changes when a
 *     newer version is published; OPERATOR reads every manufacturing row but no other user's profile.
 *
 * Fixtures are prefixed "ADR014-TEST" and removed at start and end.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *     node scripts/target-db/feed_manufacturing.test.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertSafeDestructiveTarget } from '../test-env/guard.mjs';

function resolveDockerBin() {
  if (process.env.DOCKER_BIN) return process.env.DOCKER_BIN;
  const onPath = spawnSync('docker', ['--version'], { encoding: 'utf8' });
  if (!onPath.error && onPath.status === 0) return 'docker';
  const c = resolve(process.env.LOCALAPPDATA ?? '', 'Programs', 'DockerDesktop', 'resources', 'bin', 'docker.exe');
  return existsSync(c) ? c : 'docker';
}
const DOCKER = resolveDockerBin();

const ADMIN_UID = '11111111-1111-1111-1111-111111111111';
const OPER_UID = '22222222-2222-2222-2222-222222222222';
const OPER2_UID = '66666666-6666-6666-6666-666666666666';
const MISSING_UUID = '99999999-9999-9999-9999-999999999999';
const TAG = 'ADR014-TEST';
const CLOSED_MONTH = '2026-03-01';

let container;
let pass = 0;
let fail = 0;

function dockerRun(args, input) {
  const r = spawnSync(DOCKER, args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`docker: ${r.error.message}`);
  return r;
}
const PSQL = ['psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'];
function raw(sqlText) {
  const r = dockerRun(['exec', '-i', container, ...PSQL], sqlText);
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
function owner(sqlText) {
  const r = raw(sqlText);
  if (!r.ok) throw new Error(`owner SQL failed:\n${sqlText}\n${r.err}`);
  return r.out;
}
const asUser = (uid, sqlText) => raw(`
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '${JSON.stringify({ sub: uid, role: 'authenticated' })}';
${sqlText}
COMMIT;`);
const ADMIN = (sqlText) => asUser(ADMIN_UID, sqlText);
const OPER = (sqlText) => asUser(OPER_UID, sqlText);
const OPER2 = (sqlText) => asUser(OPER2_UID, sqlText);
const json = (r) => { if (!r.ok) throw new Error(r.err); return JSON.parse(r.out); };
const firstErr = (r) => (r.err.split('\n').find((l) => /ERROR/.test(l)) || r.err.split('\n')[0] || '').slice(0, 160);
const denied = (r) => !r.ok && /permission denied/i.test(r.err);
const raised = (r, code) => !r.ok && new RegExp(`ERROR:\\s+${code}`).test(r.err);

function check(label, condition, detail) {
  if (condition) { pass += 1; console.log(`    OK   ${label}`); }
  else { fail += 1; console.log(`    MAL  ${label}${detail !== undefined ? ` :: ${detail}` : ''}`); }
}
function section(n, title) {
  console.log(`\n  ── ${n}. ${title} ${'─'.repeat(Math.max(0, 54 - title.length))}`);
}

// ── guard, container ───────────────────────────────────────────────────────
const target = assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);
container = (dockerRun(['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}']).stdout || '')
  .trim().split('\n').filter(Boolean)[0];
if (!container) { console.error('  no running supabase_db container. Run `supabase start`.'); process.exit(1); }
const mapping = (dockerRun(['port', container, '5432/tcp']).stdout || '').trim();
if (!mapping.includes(`:${target.port}`)) { console.error(`  container mapping ${mapping} does not match guarded port ${target.port}`); process.exit(1); }
console.log(`  container: ${container}`);

const TYPES = `(SELECT id FROM feed_type WHERE nombre LIKE '${TAG}%')`;
const VERSIONS = `(SELECT id FROM feed_formula_version WHERE feed_type_id IN ${TYPES})`;
const MFG = `(SELECT id FROM feed_manufacturing WHERE formula_version_id IN ${VERSIONS})`;
function cleanup() {
  owner(`
DELETE FROM audit_events WHERE entity_type IN ('feed_manufacturing','feed_formula_version','feed_inventory_count')
  AND entity_id IN (SELECT id::TEXT FROM ${MFG} m UNION SELECT id::TEXT FROM ${VERSIONS} v
                    UNION SELECT id::TEXT FROM feed_inventory_count WHERE feed_type_id IN ${TYPES});
UPDATE feed_manufacturing SET supersedes_id = NULL, version_seq = 0, rectification_reason = NULL WHERE id IN ${MFG};
DELETE FROM feed_manufacturing WHERE formula_version_id IN ${VERSIONS};
DELETE FROM feed_inventory_count WHERE feed_type_id IN ${TYPES};
DELETE FROM feed_formula_line WHERE formula_version_id IN ${VERSIONS};
DELETE FROM feed_formula_version WHERE feed_type_id IN ${TYPES};
DELETE FROM feed_type WHERE nombre LIKE '${TAG}%';
DELETE FROM feed_ingredient WHERE nombre LIKE '${TAG}%';
UPDATE management_period SET status = 'OPEN', closed_at = NULL WHERE periodo_fecha = '${CLOSED_MONTH}';
DELETE FROM perfiles WHERE id = '${OPER2_UID}';`);
}
owner(`
INSERT INTO auth.users (id, is_sso_user, is_anonymous) VALUES ('${ADMIN_UID}', false, false), ('${OPER_UID}', false, false), ('${OPER2_UID}', false, false)
ON CONFLICT (id) DO NOTHING;
INSERT INTO perfiles (id, email, rol_type, activo) VALUES
  ('${ADMIN_UID}', 'admin@test.local', 'ADMIN', true), ('${OPER_UID}', 'operator@test.local', 'OPERATOR', true)
ON CONFLICT (id) DO NOTHING;
INSERT INTO management_period (periodo_fecha) VALUES ('2026-09-01'), ('${CLOSED_MONTH}') ON CONFLICT DO NOTHING;`);
cleanup();
owner(`INSERT INTO perfiles (id, email, rol_type, activo) VALUES ('${OPER2_UID}', 'operator2@test.local', 'OPERATOR', true) ON CONFLICT (id) DO NOTHING;`);

const adminOk = (sqlText) => { const r = ADMIN(sqlText); if (!r.ok) throw new Error(r.err); return r.out; };
const manufacture = (as, fv, date, kg) => json(as(`SELECT register_feed_manufacturing('${fv}', '${date}', ${kg}, '${TAG}-${randomUUID()}', 'L-1');`));
const rectify = (as, id, kg, reason, extra = '', key = `${TAG}-R-${randomUUID()}`) =>
  as(`SELECT rectify_feed_manufacturing('${key}', '${id}', ${kg}, ${reason === null ? 'NULL' : `'${reason}'`}${extra});`);
const row = (id) => owner(`SELECT quantity_kg || '|' || is_current || '|' || version_seq || '|' || coalesce(supersedes_id::TEXT, '-') || '|' || coalesce(rectification_reason, '-')
  FROM feed_manufacturing WHERE id = '${id}';`);
const interval = (ft) => adminOk(`SELECT manufactured_kg || '|' || internal_consumption_kg FROM report_feed_consumption_interval WHERE feed_type_id = '${ft}';`);
const composition = (fv) => owner(`SELECT string_agg(ingredient_name || ':' || quantity_kg, ',' ORDER BY ingredient_name) FROM feed_formula_line_safe WHERE formula_version_id = '${fv}';`);

try {
  const T = adminOk(`INSERT INTO feed_type (nombre, feed_category) VALUES ('${TAG} Ponedoras', 'LAYER') RETURNING id;`);
  const MAIZ = adminOk(`INSERT INTO feed_ingredient (nombre) VALUES ('${TAG} Maiz') RETURNING id;`);
  const SOJA = adminOk(`INSERT INTO feed_ingredient (nombre) VALUES ('${TAG} Soja') RETURNING id;`);
  const v1 = json(ADMIN(`SELECT publish_feed_formula_version('${T}', '2026-01-01', '[{"ingredient_id":"${MAIZ}","quantity_kg":60},{"ingredient_id":"${SOJA}","quantity_kg":40}]'::jsonb);`)).formula_version_id;
  json(OPER(`SELECT register_feed_inventory_count('${T}', '2026-09-10', 0, NULL);`));
  json(OPER(`SELECT register_feed_inventory_count('${T}', '2026-09-20', 40, NULL);`));

  section('A', 'History (D-FEED-7)');
  const m = manufacture(OPER, v1, '2026-09-15', 500);
  check('A1 report before correction: manufactured 500, internal consumption 460', interval(T) === '500.000|460.000', interval(T));
  const v1Comp = composition(v1);
  json(ADMIN(`SELECT publish_feed_formula_version('${T}', '2026-09-25', '[{"ingredient_id":"${MAIZ}","quantity_kg":50},{"ingredient_id":"${SOJA}","quantity_kg":50}]'::jsonb);`));
  check('A2 the manufacturing keeps its exact version v1; v1 composition unchanged after v2 is published',
    owner(`SELECT formula_version_id FROM feed_manufacturing WHERE id = '${m.manufacturing_id}';`) === v1 && composition(v1) === v1Comp
    && v1Comp === `${TAG} Maiz:60.000,${TAG} Soja:40.000`, composition(v1));
  const operSees = OPER(`SELECT count(*) FROM feed_manufacturing WHERE id = '${m.manufacturing_id}';`);
  const operProfile = OPER(`SELECT count(*) FROM perfiles WHERE id = '${ADMIN_UID}';`);
  check('A3 OPERATOR reads the manufacturing row but no other user\'s profile (no permission broadened)',
    operSees.out === '1' && operProfile.out === '0', `${operSees.out} ${operProfile.out}`);
  const adminProfile = ADMIN(`SELECT email FROM perfiles WHERE id = '${OPER_UID}';`);
  check('A4 ADMIN can resolve the author of the manufacturing', adminProfile.out === 'operator@test.local', adminProfile.out);

  const operVersion = OPER(`SELECT version || '|' || effective_to FROM feed_formula_version WHERE id = '${v1}';`);
  const operCost = OPER(`SELECT count(*) FROM feed_formula_line WHERE formula_version_id = '${v1}';`);
  check('A5 OPERATOR reads the closed historical version v1 (0067) but still no cost line', operVersion.out === '1|2026-09-24' && operCost.out === '0', `${operVersion.out} ${operCost.out}`);

  section('B', 'Rectification RPC 49 (D-FEED-8)');
  let r = rectify(OPER, m.manufacturing_id, 50, ' ');
  check('B1 blank reason → REASON_REQUIRED', raised(r, 'REASON_REQUIRED'), firstErr(r));
  r = rectify(OPER, m.manufacturing_id, 0, 'x');
  check('B2 quantity 0 → INVALID_QUANTITY', raised(r, 'INVALID_QUANTITY'), firstErr(r));
  r = rectify(OPER2, m.manufacturing_id, 50, 'no es mía');
  check('B3 another OPERATOR cannot rectify it → MANUFACTURING_NOT_FOUND', raised(r, 'MANUFACTURING_NOT_FOUND'), firstErr(r));
  r = rectify(ADMIN, MISSING_UUID, 50, 'x');
  check('B4 missing record → MANUFACTURING_NOT_FOUND', raised(r, 'MANUFACTURING_NOT_FOUND'), firstErr(r));
  const original = row(m.manufacturing_id);
  const r1 = json(rectify(OPER, m.manufacturing_id, 50, 'eran 50 kg, no 500'));
  check('B5 OPERATOR rectifies its own record: version 1, superseding the original', r1.version_seq === 1 && r1.superseded_id === m.manufacturing_id, JSON.stringify(r1));
  check('B6 the original stays as it was (500 kg) and is no longer current', row(m.manufacturing_id) === original.replace('|true|', '|false|') && original.startsWith('500.000|true|0'), row(m.manufacturing_id));
  check('B7 the new version is current with 50 kg, same date / version / batch, and the reason',
    row(r1.manufacturing_id) === `50.000|true|1|${m.manufacturing_id}|eran 50 kg, no 500`
    && owner(`SELECT manufacturing_date || '|' || formula_version_id || '|' || batch_number FROM feed_manufacturing WHERE id = '${r1.manufacturing_id}';`) === `2026-09-15|${v1}|L-1`);
  check('B8 report corrected and not double-counted: manufactured 50, internal consumption 10', interval(T) === '50.000|10.000', interval(T));
  const audit = owner(`SELECT action || '|' || (before_values->>'quantity_kg') || '|' || (after_values->>'quantity_kg') || '|' || reason || '|' || performed_by
    FROM audit_events WHERE entity_type = 'feed_manufacturing' AND entity_id = '${r1.manufacturing_id}';`);
  check('B9 audit RECTIFY: before 500, after 50, reason and who rectified', audit === `RECTIFY|500.000|50|eran 50 kg, no 500|${OPER_UID}`, audit);
  r = rectify(OPER, m.manufacturing_id, 40, 'otra');
  check('B10 rectifying a superseded version → MANUFACTURING_SUPERSEDED', raised(r, 'MANUFACTURING_SUPERSEDED'), firstErr(r));
  const r2 = json(rectify(ADMIN, r1.manufacturing_id, 55, 'pesaje corregido'));
  check('B11 ADMIN rectifies any current record (version 2)', r2.version_seq === 2, JSON.stringify(r2));
  const r3 = json(rectify(OPER, r2.manufacturing_id, 52, 'ajuste fino'));
  check('B12 the OPERATOR who started the chain can still rectify it after an ADMIN version', r3.version_seq === 3 && interval(T) === '52.000|12.000', interval(T));
  const key = `${TAG}-dup`;
  json(rectify(ADMIN, r3.manufacturing_id, 51, 'x', '', key));
  r = rectify(ADMIN, r3.manufacturing_id, 51, 'x', '', key);
  check('B13 a reused idempotency key → DUPLICATE_MANUFACTURING', raised(r, 'DUPLICATE_MANUFACTURING'), firstErr(r));
  const cur = owner(`SELECT id FROM feed_manufacturing WHERE formula_version_id = '${v1}' AND is_current;`);
  r = rectify(ADMIN, cur, 51, 'x', `, NULL, '${MISSING_UUID}'`);
  check('B14 rectifying onto a missing formula version → FORMULA_VERSION_NOT_FOUND', raised(r, 'FORMULA_VERSION_NOT_FOUND'), firstErr(r));
  const v2 = owner(`SELECT id FROM feed_formula_version WHERE feed_type_id = '${T}' AND version = 2;`);
  r = rectify(ADMIN, cur, 51, 'x', `, NULL, '${v2}'`);
  check('B15 rectifying onto a version not effective on the manufacturing date → FORMULA_VERSION_NOT_EFFECTIVE', raised(r, 'FORMULA_VERSION_NOT_EFFECTIVE'), firstErr(r));
  check('B16 exactly one current version per chain', owner(`SELECT count(*) FROM feed_manufacturing WHERE formula_version_id IN ${VERSIONS} AND is_current;`) === '1');

  section('C', 'Closed period and perimeter');
  const mOld = manufacture(ADMIN, v1, '2026-03-10', 10);
  owner(`UPDATE management_period SET status = 'CLOSED', closed_at = NOW() WHERE periodo_fecha = '${CLOSED_MONTH}';`);
  r = rectify(ADMIN, mOld.manufacturing_id, 9, 'cerrado');
  check('C1 a record in a CLOSED period cannot be rectified → PERIOD_CLOSED', raised(r, 'PERIOD_CLOSED') && row(mOld.manufacturing_id).startsWith('10.000|true|0'), firstErr(r));
  owner(`UPDATE management_period SET status = 'OPEN', closed_at = NULL WHERE periodo_fecha = '${CLOSED_MONTH}';`);
  const direct = [
    ADMIN(`UPDATE feed_manufacturing SET quantity_kg = 1 WHERE id = '${m.manufacturing_id}';`),
    ADMIN(`UPDATE feed_manufacturing SET is_current = true WHERE id = '${m.manufacturing_id}';`),
    ADMIN(`DELETE FROM feed_manufacturing WHERE id = '${m.manufacturing_id}';`),
    OPER(`UPDATE feed_manufacturing SET rectification_reason = 'x';`),
  ];
  check('C2 no direct UPDATE / DELETE for ADMIN or OPERATOR (RPCs only)', direct.every(denied), direct.map(firstErr).join(' | '));
  const fn = owner(`SELECT p.prosecdef || '|' || has_function_privilege('anon', p.oid, 'EXECUTE') || '|' ||
    has_function_privilege('authenticated', p.oid, 'EXECUTE') || '|' || has_function_privilege('service_role', p.oid, 'EXECUTE')
    FROM pg_proc p WHERE p.proname = 'rectify_feed_manufacturing';`);
  check('C3 rectify_feed_manufacturing: SECURITY DEFINER, EXECUTE only for authenticated', fn === 'true|false|true|false', fn);
} finally {
  cleanup();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
