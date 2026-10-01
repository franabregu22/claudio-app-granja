#!/usr/bin/env node
/**
 * ADR-007 — FLOCK LIFECYCLE TEST SUITE. LOCAL TEST DATABASE ONLY.
 *
 * RPC 44 register_flock, RPC 45 close_flock and invariant 29 (no dated flock activity after
 * flocks.exit_date) across every dated flock-activity RPC amended by 0057: register / rectify daily
 * production, register / rectify mortality, register_count_adjustment, assign_flock_feed.
 *
 * Role-scoped calls simulate real Supabase sessions (SET LOCAL ROLE + request.jwt.claims). The two
 * concurrency checks run independent PostgreSQL sessions. Fixtures are prefixed "F7-TEST" and removed at
 * start and end; the period closed by the suite is reopened. Anomalous rows that the RPCs can no longer
 * create (activity after an exit, an ACTIVE flock with an exit date) are inserted by the table owner, as
 * migrated data could contain them.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *     node scripts/target-db/flock_lifecycle.test.mjs
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
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
const OPA = '22222222-2222-2222-2222-222222222222';          // operator A (existing test operator)
const OPC = '77777777-7777-7777-7777-777777777777';          // operator C (ADR-007 fixture)
const MISSING_UUID = '99999999-9999-9999-9999-999999999999';
const TAG = 'F7-TEST';
const CLOSED_BY_SUITE = ['2026-03-01'];

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
const sessionSql = (pgRole, claims, sqlText) => `
BEGIN;
SET LOCAL ROLE ${pgRole};
SET LOCAL "request.jwt.claims" = '${JSON.stringify(claims).replace(/'/g, "''")}';
${sqlText}
COMMIT;`;
const asRole = (pgRole, claims, sqlText) => raw(sessionSql(pgRole, claims, sqlText));
const claimsOf = (uid) => ({ sub: uid, role: 'authenticated' });
const asUser = (uid, sqlText) => asRole('authenticated', claimsOf(uid), sqlText);
const ADMIN = (sqlText) => asUser(ADMIN_UID, sqlText);
const OPERATOR = (sqlText) => asUser(OPA, sqlText);
const asAnon = (sqlText) => asRole('anon', { role: 'anon' }, sqlText);
const asServiceRole = (sqlText) => asRole('service_role', { role: 'service_role' }, sqlText);

function session(sqlText, appName) {
  return new Promise((done) => {
    const p = spawn(DOCKER, ['exec', '-i', '-e', `PGAPPNAME=${appName}`, container, ...PSQL]);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => done({ ok: code === 0, out: out.trim(), err: err.trim() }));
    p.stdin.end(sqlText);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(condSql, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (owner(condSql) === 't') return true;
    await sleep(100);
  }
  return false;
}
/** A runs callA and then holds its transaction open; B runs callB and must wait on a lock held by A. */
async function race(callA, callB, appPrefix) {
  const pA = session(sessionSql('authenticated', claimsOf(ADMIN_UID), `SELECT ${callA};\nSELECT pg_sleep(2);`), `${appPrefix}-A`);
  const aIn = await waitFor(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = '${appPrefix}-A'
    AND state = 'active' AND query LIKE '%pg_sleep%');`);
  const pB = session(sessionSql('authenticated', claimsOf(ADMIN_UID), `SELECT ${callB};`), `${appPrefix}-B`);
  const bWait = await waitFor(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = '${appPrefix}-B' AND wait_event_type = 'Lock');`);
  const [ra, rb] = await Promise.all([pA, pB]);
  return { aIn, bWait, ra, rb };
}

function okAs(fn, sqlText) {
  const r = fn(sqlText);
  if (!r.ok) throw new Error(`SQL failed:\n${sqlText}\n${r.err}`);
  return r.out;
}
const rpc = (call) => JSON.parse(okAs(ADMIN, `SELECT ${call};`));
const firstErr = (r) => (r.err.split('\n').find((l) => /ERROR/.test(l)) || r.err.split('\n')[0] || '').slice(0, 160);
const denied = (r) => !r.ok && /permission denied/i.test(r.err);
const raised = (r, code) => !r.ok && new RegExp(`ERROR:\\s+${code}`).test(r.err);

function check(label, condition, detail) {
  if (condition) { pass += 1; console.log(`    OK   ${label}`); } else { fail += 1; console.log(`    MAL  ${label}${detail !== undefined ? ` :: ${detail}` : ''}`); }
}
function section(n, title) {
  console.log(`\n  ── ${n}. ${title} ${'─'.repeat(Math.max(0, 54 - title.length))}`);
}

// ── guard, container ───────────────────────────────────────────────────────
const target = assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);
container = (dockerRun(['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}']).stdout || '').trim().split('\n').filter(Boolean)[0];
if (!container) { console.error('  no running supabase_db container. Run `supabase start`.'); process.exit(1); }
const mapping = (dockerRun(['port', container, '5432/tcp']).stdout || '').trim();
if (!mapping.includes(`:${target.port}`)) { console.error(`  container mapping ${mapping} does not match guarded port ${target.port}`); process.exit(1); }
console.log(`  container: ${container}`);

const TODAY = owner(`SELECT (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE;`);
const TOMORROW = owner(`SELECT ((now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE + 1);`);

// ── fixture lifecycle ──────────────────────────────────────────────────────
const TF = `(SELECT f.id FROM flocks f JOIN sheds s ON s.id = f.shed_id WHERE s.nombre LIKE '${TAG}%')`;
function cleanup() {
  owner(`
DELETE FROM audit_events WHERE entity_type = 'flocks' AND entity_id IN (SELECT id::TEXT FROM flocks WHERE id IN ${TF});
DELETE FROM audit_events WHERE entity_type = 'daily_production'
   AND entity_id IN (SELECT id::TEXT FROM daily_production WHERE flock_id IN ${TF});
DELETE FROM audit_events WHERE entity_type = 'population_events'
   AND entity_id IN (SELECT id::TEXT FROM population_events WHERE flock_id IN ${TF});
DELETE FROM audit_events WHERE entity_type = 'flock_feed_assignment'
   AND entity_id IN (SELECT id::TEXT FROM flock_feed_assignment WHERE flock_id IN ${TF});
DELETE FROM flock_feed_assignment WHERE flock_id IN ${TF};
UPDATE daily_production SET superseded_by = NULL WHERE flock_id IN ${TF};
DELETE FROM daily_production WHERE flock_id IN ${TF};
UPDATE population_events SET superseded_by = NULL WHERE flock_id IN ${TF};
DELETE FROM population_events WHERE flock_id IN ${TF};
DELETE FROM operator_assignments WHERE flock_id IN ${TF};
DELETE FROM flocks WHERE id IN ${TF};
DELETE FROM sheds WHERE nombre LIKE '${TAG}%';
DELETE FROM suppliers WHERE nombre LIKE '${TAG}%';
DELETE FROM feed_type WHERE nombre LIKE '${TAG}%';
DELETE FROM audit_events WHERE performed_by = '${OPC}';
DELETE FROM operator_assignments WHERE operator_id = '${OPC}';
DELETE FROM perfiles WHERE id = '${OPC}';
DELETE FROM auth.users WHERE id = '${OPC}';
UPDATE management_period SET status = 'OPEN', closed_at = NULL
 WHERE periodo_fecha IN (${CLOSED_BY_SUITE.map((m) => `'${m}'`).join(',')});`);
}

cleanup();
owner(`
INSERT INTO auth.users (id, is_sso_user, is_anonymous) VALUES ('${ADMIN_UID}', false, false), ('${OPA}', false, false), ('${OPC}', false, false)
ON CONFLICT (id) DO NOTHING;
INSERT INTO perfiles (id, email, rol_type, activo) VALUES
  ('${ADMIN_UID}', 'admin@test.local', 'ADMIN', true),
  ('${OPA}', 'operator@test.local', 'OPERATOR', true),
  ('${OPC}', 'operator-c@test.local', 'OPERATOR', true)
ON CONFLICT (id) DO NOTHING;`);

let seq = 0;
const mkShed = (activo = true) => owner(`INSERT INTO sheds (nombre, activo) VALUES ('${TAG} galpon #${++seq}', ${activo}) RETURNING id;`);
const q = (v) => (v === null || v === undefined ? 'NULL' : `'${v}'`);
const n = (v) => (v === null || v === undefined ? 'NULL' : String(v));
const regCall = (shed, entry, pop, o = {}) =>
  `register_flock(${q(shed)}, ${q(entry)}, ${n(pop)}, ${q(o.line)}, ${q(o.birth)}, ${q(o.supplier)}, ${q(o.purchase)}, ${q(o.reason)})`;
const closeCall = (flock, exit, reason = 'fin de ciclo') => `close_flock(${q(flock)}, ${q(exit)}, ${q(reason)})`;
const mortCall = (f, d, deaths = 2) => `register_mortality(${q(f)}, ${q(d)}, ${n(deaths)}, NULL)`;
const adjCall = (f, d, delta = 1) => `register_count_adjustment(${q(f)}, ${q(d)}, ${n(delta)}, 'recuento')`;
const prodCall = (f, d, total = 500) => `register_daily_production(${q(f)}, ${q(d)}, ${n(total)}, 0, 0, NULL)`;
const flockRow = (id) => owner(`SELECT estado || '|' || COALESCE(exit_date::TEXT, '-') FROM flocks WHERE id = '${id}';`);
const audits = (id, action) => Number(owner(`SELECT count(*) FROM audit_events WHERE entity_type = 'flocks' AND entity_id = '${id}' AND action = '${action}';`));
const flockCount = () => Number(owner(`SELECT count(*) FROM flocks WHERE id IN ${TF};`));
const closePeriod = (m) => owner(`UPDATE management_period SET status = 'CLOSED', closed_at = NOW() WHERE periodo_fecha = '${m}';`);
const openPeriod = (m) => owner(`UPDATE management_period SET status = 'OPEN', closed_at = NULL WHERE periodo_fecha = '${m}';`);

try {
  // ── 1. perimeter ─────────────────────────────────────────────────────────
  section(1, 'perimeter (ADR-007 §security)');
  check('S1 SECURITY DEFINER count in public = 67 (60 + register_flock + close_flock + ADR-011 register_bank_tax + ADR-012/013 RPCs 47 / 48 + ADR-014 RPC 49 + ADR-015 RPC 50)',
    owner(`SELECT count(*) FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace;`) === '67');
  check('S2 RPC 44/44: SECURITY DEFINER, owner postgres, search_path=public, EXECUTE authenticated only',
    owner(`SELECT string_agg(proname || ':' || prosecdef || ':' || pg_get_userbyid(proowner) || ':' || array_to_string(proconfig, ';') || ':'
      || has_function_privilege('authenticated', oid, 'EXECUTE') || has_function_privilege('anon', oid, 'EXECUTE')
      || has_function_privilege('service_role', oid, 'EXECUTE'), ',' ORDER BY proname)
      FROM pg_proc WHERE proname IN ('register_flock', 'close_flock') AND pronamespace = 'public'::regnamespace;`)
      === 'close_flock:true:postgres:search_path=public:truefalsefalse,register_flock:true:postgres:search_path=public:truefalsefalse');
  check('S3 assert_flock_activity_date: INVOKER, owner-only (no API role may execute it)',
    owner(`SELECT prosecdef || ':' || pg_get_userbyid(proowner) || ':' || has_function_privilege('authenticated', oid, 'EXECUTE')
      || has_function_privilege('anon', oid, 'EXECUTE') || has_function_privilege('service_role', oid, 'EXECUTE')
      FROM pg_proc WHERE proname = 'assert_flock_activity_date';`) === 'false:postgres:falsefalsefalse');
  check('S4 flocks keeps no INSERT / UPDATE / DELETE grant for authenticated / anon',
    owner(`SELECT count(*) FROM information_schema.role_table_grants WHERE table_name = 'flocks'
      AND grantee IN ('authenticated', 'anon') AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE');`) === '0');
  const probeShed = mkShed();
  let r = ADMIN(`INSERT INTO flocks (shed_id, entry_date, initial_population) VALUES ('${probeShed}', '2026-01-10', 1);`);
  check('S5 even ADMIN cannot write flocks directly (permission denied)', denied(r), firstErr(r));
  r = asAnon(`SELECT ${regCall(probeShed, '2026-01-10', 1)};`);
  check('S6 anon cannot execute register_flock', denied(r), firstErr(r));
  r = asServiceRole(`SELECT ${closeCall(MISSING_UUID, '2026-01-10')};`);
  check('S7 service_role cannot execute close_flock', denied(r), firstErr(r));

  // ── 2. register_flock ────────────────────────────────────────────────────
  section(2, 'RPC 44 register_flock');
  const supplier = owner(`INSERT INTO suppliers (nombre) VALUES ('${TAG} proveedor') RETURNING id;`);
  const shedA = mkShed();
  const before = flockCount();
  const created = rpc(regCall(shedA, '2026-02-01', 1200, { line: ' Hy-Line Brown ', birth: '2025-10-01', supplier, reason: 'alta' }));
  const fA = created.flock_id;
  check('R1 ADMIN registers a flock: ACTIVE, no exit date, one row', created.estado === 'ACTIVE' && flockRow(fA) === 'ACTIVE|-' && flockCount() === before + 1);
  check('R2 stored fields: shed, entry, initial population, trimmed genetics line, birth date, supplier, created_by = caller',
    owner(`SELECT shed_id || '|' || entry_date || '|' || initial_population || '|' || genetics_line || '|' || birth_date || '|' || supplier_id || '|' || created_by
      FROM flocks WHERE id = '${fA}';`) === `${shedA}|2026-02-01|1200|Hy-Line Brown|2025-10-01|${supplier}|${ADMIN_UID}`);
  check('R3 one CREATE audit row for the flock', audits(fA, 'CREATE') === 1);
  r = OPERATOR(`SELECT ${regCall(mkShed(), '2026-02-01', 10)};`);
  check('R4 OPERATOR → FORBIDDEN', raised(r, 'FORBIDDEN'), firstErr(r));
  r = ADMIN(`SELECT ${regCall(MISSING_UUID, '2026-02-01', 10)};`);
  check('R5 missing shed → SHED_NOT_FOUND', raised(r, 'SHED_NOT_FOUND'), firstErr(r));
  r = ADMIN(`SELECT ${regCall(mkShed(false), '2026-02-01', 10)};`);
  check('R6 inactive shed → SHED_INACTIVE', raised(r, 'SHED_INACTIVE'), firstErr(r));
  r = ADMIN(`SELECT ${regCall(shedA, '2026-02-02', 10)};`);
  check('R7 shed with an ACTIVE flock → SHED_OCCUPIED (one ACTIVE flock per shed)', raised(r, 'SHED_OCCUPIED'), firstErr(r));
  r = ADMIN(`SELECT ${regCall(mkShed(), '2026-02-01', -1)};`);
  const rNull = ADMIN(`SELECT ${regCall(mkShed(), '2026-02-01', null)};`);
  check('R8 negative / NULL initial population → INVALID_QUANTITY', raised(r, 'INVALID_QUANTITY') && raised(rNull, 'INVALID_QUANTITY'), firstErr(r));
  const zero = rpc(regCall(mkShed(), '2026-02-01', 0));
  check('R9 initial population 0 is valid (frozen CHECK >= 0)', zero.estado === 'ACTIVE');
  r = ADMIN(`SELECT ${regCall(mkShed(), TOMORROW, 10)};`);
  const rToday = ADMIN(`SELECT ${regCall(mkShed(), TODAY, 10)};`);
  check(`R10 entry date after business today (${TOMORROW}) → INVALID_DATE; today is allowed (D-F27B-4)`, raised(r, 'INVALID_DATE') && rToday.ok, firstErr(r) || firstErr(rToday));
  r = ADMIN(`SELECT ${regCall(mkShed(), null, 10)};`);
  const rBirth = ADMIN(`SELECT ${regCall(mkShed(), '2026-02-01', 10, { birth: '2026-02-02' })};`);
  check('R11 missing entry date / birth date after entry → INVALID_DATE', raised(r, 'INVALID_DATE') && raised(rBirth, 'INVALID_DATE'), firstErr(r) || firstErr(rBirth));
  closePeriod('2026-03-01');
  r = ADMIN(`SELECT ${regCall(mkShed(), '2026-03-10', 10)};`);
  openPeriod('2026-03-01');
  check('R12 entry date in a CLOSED period → PERIOD_CLOSED', raised(r, 'PERIOD_CLOSED'), firstErr(r));
  r = ADMIN(`SELECT ${regCall(mkShed(), '2026-02-01', 10, { supplier: MISSING_UUID })};`);
  const rPurchase = ADMIN(`SELECT ${regCall(mkShed(), '2026-02-01', 10, { purchase: MISSING_UUID })};`);
  check('R13 unknown supplier → SUPPLIER_NOT_FOUND; unknown purchase → PURCHASE_NOT_FOUND', raised(r, 'SUPPLIER_NOT_FOUND') && raised(rPurchase, 'PURCHASE_NOT_FOUND'),
    firstErr(r) || firstErr(rPurchase));
  const raceShed = mkShed();
  const rc = await race(regCall(raceShed, '2026-02-01', 10), regCall(raceShed, '2026-02-01', 20), 'f7-reg');
  check('R14 concurrent registrations for one shed: the second waits on the shed lock, then SHED_OCCUPIED; one ACTIVE flock',
    rc.aIn && rc.bWait && rc.ra.ok && raised(rc.rb, 'SHED_OCCUPIED')
    && owner(`SELECT count(*) FROM flocks WHERE shed_id = '${raceShed}' AND estado = 'ACTIVE';`) === '1', `${rc.aIn} ${rc.bWait} ${firstErr(rc.rb)}`);

  // ── 3. close_flock ───────────────────────────────────────────────────────
  section(3, 'RPC 45 close_flock');
  const shedC = mkShed();
  const fC = rpc(regCall(shedC, '2026-04-01', 800)).flock_id;
  okAs(ADMIN, `INSERT INTO operator_assignments (operator_id, flock_id, assigned_by) VALUES ('${OPA}', '${fC}', '${ADMIN_UID}'), ('${OPC}', '${fC}', '${ADMIN_UID}');`);
  okAs(ADMIN, `UPDATE operator_assignments SET activo = false WHERE operator_id = '${OPC}' AND flock_id = '${fC}';`);
  rpc(mortCall(fC, '2026-05-10', 3));
  rpc(prodCall(fC, '2026-05-10'));
  const activeIds = owner(`SELECT string_agg(id::TEXT, ',' ORDER BY id) FROM operator_assignments WHERE flock_id = '${fC}' AND activo;`);
  const assignmentsBefore = owner(`SELECT count(*) FROM operator_assignments WHERE flock_id = '${fC}';`);

  r = OPERATOR(`SELECT ${closeCall(fC, '2026-05-20')};`);
  check('C1 OPERATOR → FORBIDDEN', raised(r, 'FORBIDDEN') && flockRow(fC) === 'ACTIVE|-', firstErr(r));
  r = ADMIN(`SELECT ${closeCall(MISSING_UUID, '2026-05-20')};`);
  check('C2 missing flock → FLOCK_NOT_FOUND', raised(r, 'FLOCK_NOT_FOUND'), firstErr(r));
  r = ADMIN(`SELECT ${closeCall(fC, '2026-03-31')};`);
  const rNullExit = ADMIN(`SELECT ${closeCall(fC, null)};`);
  check('C3 exit before entry / missing exit date → INVALID_DATE', raised(r, 'INVALID_DATE') && raised(rNullExit, 'INVALID_DATE'), firstErr(r) || firstErr(rNullExit));
  r = ADMIN(`SELECT ${closeCall(fC, TOMORROW)};`);
  check('C4 exit after business today → INVALID_DATE', raised(r, 'INVALID_DATE'), firstErr(r));
  r = ADMIN(`SELECT ${closeCall(fC, '2026-05-09')};`);
  check('C5 current production / mortality dated after the exit → EXIT_BEFORE_RECORDED_ACTIVITY', raised(r, 'EXIT_BEFORE_RECORDED_ACTIVITY'), firstErr(r));
  const shedF = mkShed();
  const fF = rpc(regCall(shedF, '2026-04-01', 100)).flock_id;
  const feedType = owner(`INSERT INTO feed_type (nombre, feed_category) VALUES ('${TAG} alimento', (enum_range(NULL::feed_category))[1]) RETURNING id;`);
  rpc(`assign_flock_feed('${fF}', '${feedType}', '2026-06-01', NULL)`);
  r = ADMIN(`SELECT ${closeCall(fF, '2026-05-31')};`);
  check('C6 a feed assignment effective after the exit → EXIT_BEFORE_RECORDED_ACTIVITY', raised(r, 'EXIT_BEFORE_RECORDED_ACTIVITY'), firstErr(r));
  closePeriod('2026-03-01');
  const fP = rpc(regCall(mkShed(), '2026-02-01', 10)).flock_id;
  r = ADMIN(`SELECT ${closeCall(fP, '2026-03-15')};`);
  openPeriod('2026-03-01');
  check('C7 exit date in a CLOSED period → PERIOD_CLOSED, flock still ACTIVE', raised(r, 'PERIOD_CLOSED') && flockRow(fP) === 'ACTIVE|-', firstErr(r));

  const closed = rpc(closeCall(fC, '2026-05-20', 'venta de gallinas'));
  check('C8 ADMIN closes the flock: RETIRED with the exit date', closed.estado === 'RETIRED' && flockRow(fC) === 'RETIRED|2026-05-20');
  check('C9 every active operator assignment of the flock is now inactive (D-F27B-5)',
    owner(`SELECT count(*) FROM operator_assignments WHERE flock_id = '${fC}' AND activo;`) === '0' && closed.deactivated_assignments === 1);
  check('C10 no assignment row deleted (history kept)', owner(`SELECT count(*) FROM operator_assignments WHERE flock_id = '${fC}';`) === assignmentsBefore);
  check('C11 exactly one CLOSE audit row, naming the assignments it deactivated, with the reason',
    audits(fC, 'CLOSE') === 1 && owner(`SELECT (after_values->'deactivated_assignment_ids')::TEXT || '|' || reason FROM audit_events
      WHERE entity_type = 'flocks' AND entity_id = '${fC}' AND action = 'CLOSE';`) === `["${activeIds}"]|venta de gallinas`);
  r = ADMIN(`SELECT ${closeCall(fC, '2026-05-21')};`);
  check('C12 closing again → FLOCK_NOT_ACTIVE; no second audit row', raised(r, 'FLOCK_NOT_ACTIVE') && audits(fC, 'CLOSE') === 1, firstErr(r));
  const next = ADMIN(`SELECT ${regCall(shedC, '2026-05-21', 900)};`);
  check('C13 the shed is free again: a new flock registers in it', next.ok && JSON.parse(next.out).estado === 'ACTIVE', firstErr(next));

  // ── 4. invariant 29: no dated activity after the exit ────────────────────
  section(4, 'invariant 29 across the amended RPCs (D-F27B-6)');
  r = ADMIN(`SELECT ${mortCall(fC, '2026-05-21')};`);
  check('P1 register_mortality dated after the exit → ACTIVITY_AFTER_FLOCK_EXIT', raised(r, 'ACTIVITY_AFTER_FLOCK_EXIT'), firstErr(r));
  const late = ADMIN(`SELECT ${mortCall(fC, '2026-05-18', 1)};`);
  check('P2 register_mortality dated on / before the exit of a RETIRED flock is still allowed (historical)', late.ok, firstErr(late));
  const lateId = JSON.parse(late.out).event_id;
  const rect = ADMIN(`SELECT rectify_mortality(${lateId}, 2, 'corrección posterior');`);
  check('P3 rectify_mortality of an event dated before the exit is allowed after the close', rect.ok, firstErr(rect));
  r = ADMIN(`SELECT ${adjCall(fC, '2026-05-25')};`);
  const adjOk = ADMIN(`SELECT ${adjCall(fC, '2026-05-20')};`);
  check('P4 register_count_adjustment: after the exit rejected, on the exit date allowed', raised(r, 'ACTIVITY_AFTER_FLOCK_EXIT') && adjOk.ok, firstErr(r) || firstErr(adjOk));
  r = ADMIN(`SELECT ${prodCall(fC, '2026-05-15')};`);
  check('P5 register_daily_production keeps its ACTIVE requirement on a RETIRED flock (FLOCK_NOT_ACTIVE, unchanged)', raised(r, 'FLOCK_NOT_ACTIVE'), firstErr(r));
  const prodId = owner(`SELECT id FROM daily_production WHERE flock_id = '${fC}' AND production_date = '2026-05-10' AND is_current;`);
  const rectProd = ADMIN(`SELECT rectify_daily_production('${prodId}', 480, 0, 0, 'recuento');`);
  check('P6 rectify_daily_production of a day before the exit is allowed after the close', rectProd.ok, firstErr(rectProd));
  // anomalous rows (migrated data): activity after the exit, and an ACTIVE flock that carries an exit date
  const badProd = owner(`INSERT INTO daily_production (flock_id, production_date, eggs_total, created_by) VALUES ('${fC}', '2026-05-22', 10, '${ADMIN_UID}') RETURNING id;`);
  r = ADMIN(`SELECT rectify_daily_production('${badProd}', 11, 0, 0, 'recuento');`);
  check('P7 rectify_daily_production of a day after the exit → ACTIVITY_AFTER_FLOCK_EXIT', raised(r, 'ACTIVITY_AFTER_FLOCK_EXIT'), firstErr(r));
  const badEvent = owner(`INSERT INTO population_events (flock_id, event_type, delta, event_date, created_by) VALUES ('${fC}', 'MORTALITY', -1, '2026-05-23', '${ADMIN_UID}') RETURNING id;`);
  r = ADMIN(`SELECT rectify_mortality(${badEvent}, 2, 'corrección');`);
  check('P8 rectify_mortality of an event after the exit → ACTIVITY_AFTER_FLOCK_EXIT', raised(r, 'ACTIVITY_AFTER_FLOCK_EXIT'), firstErr(r));
  const oddShed = mkShed();
  const odd = owner(`INSERT INTO flocks (shed_id, entry_date, initial_population, exit_date) VALUES ('${oddShed}', '2026-04-01', 50, '2026-06-30') RETURNING id;`);
  r = ADMIN(`SELECT ${prodCall(odd, '2026-07-01')};`);
  const oddOk = ADMIN(`SELECT ${prodCall(odd, '2026-06-30')};`);
  check('P9 register_daily_production on an ACTIVE flock with an exit date: after it rejected, on it allowed', raised(r, 'ACTIVITY_AFTER_FLOCK_EXIT') && oddOk.ok,
    firstErr(r) || firstErr(oddOk));
  r = ADMIN(`SELECT assign_flock_feed('${fC}', '${feedType}', '2026-05-21', NULL);`);
  const feedOk = ADMIN(`SELECT assign_flock_feed('${fC}', '${feedType}', '2026-05-01', NULL);`);
  check('P10 assign_flock_feed: effective after the exit rejected, before it allowed', raised(r, 'ACTIVITY_AFTER_FLOCK_EXIT') && feedOk.ok, firstErr(r) || firstErr(feedOk));

  // ── 5. concurrency: a dated write racing a close ──────────────────────────
  section(5, 'concurrency');
  const fR = rpc(regCall(mkShed(), '2026-04-01', 300)).flock_id;
  const rr = await race(closeCall(fR, '2026-06-10'), mortCall(fR, '2026-06-11'), 'f7-close');
  check('K1 a mortality after the exit, concurrent with the close, waits for it and is then rejected',
    rr.aIn && rr.bWait && rr.ra.ok && raised(rr.rb, 'ACTIVITY_AFTER_FLOCK_EXIT')
    && owner(`SELECT count(*) FROM population_events WHERE flock_id = '${fR}';`) === '0', `${rr.aIn} ${rr.bWait} ${firstErr(rr.rb)}`);
} finally {
  cleanup();
}
const leftovers = owner(`SELECT count(*) FROM sheds WHERE nombre LIKE '${TAG}%';`);
check('Z1 fixtures removed, suite period reopened', leftovers === '0'
  && owner(`SELECT count(*) FROM management_period WHERE status = 'CLOSED' AND periodo_fecha IN (${CLOSED_BY_SUITE.map((m) => `'${m}'`).join(',')});`) === '0');

console.log(`\n  ══ ADR-007 FLOCK LIFECYCLE RESULT: ${pass} passed, ${fail} failed ══\n`);
process.exit(fail === 0 ? 0 : 1);
