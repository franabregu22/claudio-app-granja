#!/usr/bin/env node
/**
 * ADR-013 — FEED FORMULA PUBLICATION (Phase 27 acceptance fixes block 4, owner D-FEED-1…5).
 * LOCAL TEST DATABASE ONLY.
 *
 *   * RPC 48 publish_feed_formula_version: ADMIN only, atomic (version + all lines or nothing), deterministic
 *     version number, prior version closed at D − 1, same-or-earlier start refused, never cuts a version still
 *     manufactured on/after D;
 *   * one effective version per feed type (EXCLUDE), even for the owner;
 *   * no direct application write path for versions / lines;
 *   * manufacturing refuses an empty version; history keeps pointing to the exact version used.
 *
 * Fixtures are prefixed "ADR013-TEST" and removed at start and end.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *     node scripts/target-db/feed_formula.test.mjs
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
const MISSING_UUID = '99999999-9999-9999-9999-999999999999';
const TAG = 'ADR013-TEST';

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

const CURRENT_MONTH = owner(`SELECT date_trunc('month', (NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires'))::DATE;`);
const plusDays = (d, n) => owner(`SELECT ('${d}'::DATE + ${n})::DATE;`);

const TYPES = `(SELECT id FROM feed_type WHERE nombre LIKE '${TAG}%')`;
const VERSIONS = `(SELECT id FROM feed_formula_version WHERE feed_type_id IN ${TYPES})`;
function cleanup() {
  owner(`
DELETE FROM audit_events WHERE entity_type = 'feed_formula_version' AND entity_id IN (SELECT id::TEXT FROM ${VERSIONS} v);
DELETE FROM audit_events WHERE entity_type = 'feed_manufacturing' AND entity_id IN
  (SELECT id::TEXT FROM feed_manufacturing WHERE formula_version_id IN ${VERSIONS});
DELETE FROM feed_manufacturing WHERE formula_version_id IN ${VERSIONS};
DELETE FROM feed_formula_line WHERE formula_version_id IN ${VERSIONS};
DELETE FROM feed_formula_version WHERE feed_type_id IN ${TYPES};
DELETE FROM feed_type WHERE nombre LIKE '${TAG}%';
DELETE FROM feed_ingredient WHERE nombre LIKE '${TAG}%';`);
}
owner(`
INSERT INTO auth.users (id, is_sso_user, is_anonymous) VALUES ('${ADMIN_UID}', false, false), ('${OPER_UID}', false, false)
ON CONFLICT (id) DO NOTHING;
INSERT INTO perfiles (id, email, rol_type, activo) VALUES
  ('${ADMIN_UID}', 'admin@test.local', 'ADMIN', true), ('${OPER_UID}', 'operator@test.local', 'OPERATOR', true)
ON CONFLICT (id) DO NOTHING;
INSERT INTO management_period (periodo_fecha) VALUES ('${CURRENT_MONTH}') ON CONFLICT DO NOTHING;`);
cleanup();

const adminOk = (sqlText) => { const r = ADMIN(sqlText); if (!r.ok) throw new Error(r.err); return r.out; };
const feedType = (name, activo = true) => adminOk(`INSERT INTO feed_type (nombre, feed_category, activo) VALUES ('${TAG} ${name}', 'LAYER', ${activo}) RETURNING id;`);
const ingredient = (name, activo = true) => adminOk(`INSERT INTO feed_ingredient (nombre, activo) VALUES ('${TAG} ${name}', ${activo}) RETURNING id;`);
const publish = (as, ft, from, lines) => as(`SELECT publish_feed_formula_version('${ft}', '${from}', '${JSON.stringify(lines)}'::jsonb, 'test');`);
const manufacture = (as, fv, date, kg = 100) =>
  as(`SELECT register_feed_manufacturing('${fv}', '${date}', ${kg}, '${TAG}-${randomUUID()}');`);
const versionsOf = (ft) => owner(`SELECT string_agg(version || ':' || effective_from || '→' || coalesce(effective_to::TEXT, 'open'), ',' ORDER BY version)
  FROM feed_formula_version WHERE feed_type_id = '${ft}';`);
const compositionOf = (fv) => owner(`SELECT string_agg(i.nombre || ':' || l.quantity_kg, ',' ORDER BY i.nombre)
  FROM feed_formula_line l JOIN feed_ingredient i ON i.id = l.ingredient_id WHERE l.formula_version_id = '${fv}';`);
const countFor = (ft) => owner(`SELECT count(*) FROM feed_formula_version WHERE feed_type_id = '${ft}';`);

try {
  const T = feedType('Ponedoras prueba');
  const T_OFF = feedType('Inactivo', false);
  const MAIZ = ingredient('Maiz');
  const SOJA = ingredient('Soja');
  const OFF = ingredient('Inactivo', false);
  const D1 = '2026-01-01';
  const MFG = CURRENT_MONTH;
  const D2 = plusDays(CURRENT_MONTH, 1);

  section('A', 'Validation and atomicity');
  let r = publish(OPER, T, D1, [{ ingredient_id: MAIZ, quantity_kg: 60 }]);
  check('A1 OPERATOR → FORBIDDEN', raised(r, 'FORBIDDEN') && countFor(T) === '0', firstErr(r));
  r = publish(ADMIN, T, D1, []);
  check('A2 zero lines → EMPTY_LINE_SET', raised(r, 'EMPTY_LINE_SET') && countFor(T) === '0', firstErr(r));
  r = publish(ADMIN, T, D1, [{ ingredient_id: MAIZ, quantity_kg: 60 }, { ingredient_id: MISSING_UUID, quantity_kg: 40 }]);
  check('A3 one invalid ingredient → INGREDIENT_NOT_FOUND; no version and no line left (atomic)', raised(r, 'INGREDIENT_NOT_FOUND') && countFor(T) === '0', firstErr(r));
  r = publish(ADMIN, T, D1, [{ ingredient_id: OFF, quantity_kg: 40 }]);
  check('A4 inactive ingredient → INGREDIENT_NOT_FOUND', raised(r, 'INGREDIENT_NOT_FOUND'), firstErr(r));
  r = publish(ADMIN, T, D1, [{ ingredient_id: MAIZ, quantity_kg: 60 }, { ingredient_id: MAIZ, quantity_kg: 10 }]);
  check('A5 the same ingredient twice → DUPLICATE_INGREDIENT', raised(r, 'DUPLICATE_INGREDIENT'), firstErr(r));
  for (const [label, qty] of [['0', 0], ['negative', -1], ['4 decimals', 1.0001]]) {
    r = publish(ADMIN, T, D1, [{ ingredient_id: MAIZ, quantity_kg: qty }]);
    check(`A6 quantity ${label} → INVALID_QUANTITY`, raised(r, 'INVALID_QUANTITY'), firstErr(r));
  }
  r = publish(ADMIN, T_OFF, D1, [{ ingredient_id: MAIZ, quantity_kg: 60 }]);
  check('A7 inactive feed type → FEED_TYPE_NOT_FOUND_OR_INACTIVE', raised(r, 'FEED_TYPE_NOT_FOUND_OR_INACTIVE'), firstErr(r));
  r = publish(ADMIN, MISSING_UUID, D1, [{ ingredient_id: MAIZ, quantity_kg: 60 }]);
  check('A8 missing feed type → FEED_TYPE_NOT_FOUND_OR_INACTIVE', raised(r, 'FEED_TYPE_NOT_FOUND_OR_INACTIVE'), firstErr(r));

  section('B', 'Publication and lifecycle (D-FEED-1 / D-FEED-2)');
  const v1 = json(publish(ADMIN, T, D1, [{ ingredient_id: MAIZ, quantity_kg: 60 }, { ingredient_id: SOJA, quantity_kg: 40.5 }]));
  check('B1 first publication: version 1, open from D1, two lines, nothing closed',
    v1.version === 1 && v1.line_count === 2 && v1.closed_version_id === null && versionsOf(T) === `1:${D1}→open`, `${JSON.stringify(v1)} ${versionsOf(T)}`);
  check('B2 composition stored exactly', compositionOf(v1.formula_version_id) === `${TAG} Maiz:60.000,${TAG} Soja:40.500`, compositionOf(v1.formula_version_id));
  const audit = owner(`SELECT action || '|' || (after_values->>'version') || '|' || (after_values->>'line_count') FROM audit_events
    WHERE entity_type = 'feed_formula_version' AND entity_id = '${v1.formula_version_id}';`);
  check('B3 audit PUBLISH row', audit === 'PUBLISH|1|2', audit);
  const m1 = json(manufacture(OPER, v1.formula_version_id, MFG));
  check('B4 manufacturing with v1 (OPERATOR, effective date)', !!m1.manufacturing_id);
  r = publish(ADMIN, T, MFG, [{ ingredient_id: MAIZ, quantity_kg: 55 }]);
  check('B5 a new version starting on a date v1 was already manufactured → FORMULA_VERSION_USED_AFTER_DATE (history never cut)',
    raised(r, 'FORMULA_VERSION_USED_AFTER_DATE') && versionsOf(T) === `1:${D1}→open`, firstErr(r));
  const v2 = json(publish(ADMIN, T, D2, [{ ingredient_id: MAIZ, quantity_kg: 55 }, { ingredient_id: SOJA, quantity_kg: 45 }]));
  check('B6 v2 from D2: version number 2; v1 closed automatically at D2 − 1',
    v2.version === 2 && v2.closed_version_id === v1.formula_version_id && versionsOf(T) === `1:${D1}→${MFG},2:${D2}→open`, versionsOf(T));
  check('B7 historical manufacturing still references v1 and v1 composition is unchanged',
    owner(`SELECT formula_version_id FROM feed_manufacturing WHERE id = '${m1.manufacturing_id}';`) === v1.formula_version_id
    && compositionOf(v1.formula_version_id) === `${TAG} Maiz:60.000,${TAG} Soja:40.500`);
  r = publish(ADMIN, T, D2, [{ ingredient_id: MAIZ, quantity_kg: 50 }]);
  check('B8 same start date as an existing version → FORMULA_VERSION_DATE_CONFLICT (fail closed)', raised(r, 'FORMULA_VERSION_DATE_CONFLICT') && countFor(T) === '2', firstErr(r));
  r = publish(ADMIN, T, '2026-02-01', [{ ingredient_id: MAIZ, quantity_kg: 50 }]);
  check('B9 an earlier start than the latest version → FORMULA_VERSION_DATE_CONFLICT', raised(r, 'FORMULA_VERSION_DATE_CONFLICT') && countFor(T) === '2', firstErr(r));
  const overlaps = owner(`SELECT count(*) FROM feed_formula_version a JOIN feed_formula_version b
    ON a.feed_type_id = b.feed_type_id AND a.id < b.id AND daterange(a.effective_from, a.effective_to, '[]') && daterange(b.effective_from, b.effective_to, '[]')
    WHERE a.feed_type_id = '${T}';`);
  check('B10 no two versions of the feed type overlap', overlaps === '0', overlaps);
  r = raw(`INSERT INTO feed_formula_version (feed_type_id, version, effective_from) VALUES ('${T}', 9, '2026-06-01');`);
  check('B11 an overlapping version is impossible even for the owner (excl_feed_formula_version_no_overlap)',
    !r.ok && r.err.includes('excl_feed_formula_version_no_overlap'), firstErr(r));

  section('C', 'Manufacturing selector and empty versions (D-FEED-5)');
  r = manufacture(OPER, v2.formula_version_id, MFG);
  check('C1 v2 is not effective before D2 → FORMULA_VERSION_NOT_EFFECTIVE', raised(r, 'FORMULA_VERSION_NOT_EFFECTIVE'), firstErr(r));
  r = manufacture(OPER, v1.formula_version_id, D2);
  check('C2 v1 is not effective after its close → FORMULA_VERSION_NOT_EFFECTIVE', raised(r, 'FORMULA_VERSION_NOT_EFFECTIVE'), firstErr(r));
  const effective = (d) => owner(`SELECT string_agg(version::TEXT, ',') FROM feed_formula_version WHERE feed_type_id = '${T}'
    AND effective_from <= '${d}' AND (effective_to IS NULL OR effective_to >= '${d}');`);
  check('C3 exactly one version is effective on each date (MFG → v1, D2 → v2)', effective(MFG) === '1' && effective(D2) === '2', `${effective(MFG)} / ${effective(D2)}`);
  const T_EMPTY = feedType('Vacio');
  const vEmpty = owner(`INSERT INTO feed_formula_version (feed_type_id, version, effective_from) VALUES ('${T_EMPTY}', 1, '${D1}') RETURNING id;`);
  r = manufacture(OPER, vEmpty, MFG);
  check('C4 a version with no lines cannot be manufactured → FORMULA_VERSION_EMPTY', raised(r, 'FORMULA_VERSION_EMPTY'), firstErr(r));

  section('D', 'Write path and immutability');
  const direct = [
    ADMIN(`INSERT INTO feed_formula_version (feed_type_id, version, effective_from) VALUES ('${T}', 3, '2027-01-01');`),
    ADMIN(`INSERT INTO feed_formula_line (formula_version_id, ingredient_id, quantity_kg) VALUES ('${v2.formula_version_id}', '${MAIZ}', 1);`),
    ADMIN(`UPDATE feed_formula_version SET effective_to = NULL WHERE id = '${v1.formula_version_id}';`),
    ADMIN(`UPDATE feed_formula_line SET quantity_kg = 1 WHERE formula_version_id = '${v1.formula_version_id}';`),
    ADMIN(`DELETE FROM feed_formula_line WHERE formula_version_id = '${v1.formula_version_id}';`),
    OPER(`INSERT INTO feed_formula_version (feed_type_id, version, effective_from) VALUES ('${T}', 3, '2027-01-01');`),
  ];
  check('D1 no direct INSERT / UPDATE / DELETE on versions or lines for ADMIN or OPERATOR (RPC 48 only)', direct.every(denied), direct.map(firstErr).join(' | '));
  const pol = owner(`SELECT count(*) FROM pg_policies WHERE tablename IN ('feed_formula_version','feed_formula_line') AND cmd <> 'SELECT';`);
  check('D2 no write policy left on the two formula tables', pol === '0', pol);
  r = raw(`INSERT INTO feed_formula_line (formula_version_id, ingredient_id, quantity_kg) VALUES ('${v1.formula_version_id}', '${MAIZ}', 1);`);
  check('D3 a used version stays immutable even for the owner (FORMULA_VERSION_IN_USE trigger kept)', raised(r, 'FORMULA_VERSION_IN_USE'), firstErr(r));
  const fn = owner(`SELECT p.prosecdef || '|' || has_function_privilege('anon', p.oid, 'EXECUTE') || '|' ||
    has_function_privilege('authenticated', p.oid, 'EXECUTE') || '|' || has_function_privilege('service_role', p.oid, 'EXECUTE')
    FROM pg_proc p WHERE p.proname = 'publish_feed_formula_version';`);
  check('D4 publish_feed_formula_version: SECURITY DEFINER, EXECUTE only for authenticated', fn === 'true|false|true|false', fn);
} finally {
  cleanup();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
