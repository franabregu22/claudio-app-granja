#!/usr/bin/env node
/**
 * ADR-012 — CLASSIFICATION ENTRY UNITS + RECTIFICATION (Phase 27 acceptance fixes block 4,
 * owner D-CLS-1…5). LOCAL TEST DATABASE ONLY.
 *
 *   * UNIDAD = 1 egg; MAPLE = 20 eggs for XL, 30 for every other grade — converted by the backend;
 *     the entered quantity / unit are stored as typed; quantity stays the canonical egg count.
 *   * multiple sessions per day are appended;
 *   * RPC 47 rectify_classification replaces one whole current session (mandatory reason), keeps the prior
 *     version untouched, and report_classification_day counts current versions only;
 *   * no flock reference.
 *
 * Fixtures carry location "ADR012-TEST" and are removed at start and end.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *     node scripts/target-db/classification_units.test.mjs
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
const OPER2_UID = '55555555-5555-5555-5555-555555555555';
const TAG = 'ADR012-TEST';
const DAY = '2026-05-28';
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

const TEST_SESSIONS = `(SELECT id FROM classification WHERE location = '${TAG}')`;
function cleanup() {
  owner(`
DELETE FROM audit_events WHERE entity_type = 'classification' AND entity_id IN (SELECT id::TEXT FROM ${TEST_SESSIONS} s);
DELETE FROM classification_line WHERE classification_id IN ${TEST_SESSIONS};
UPDATE classification SET supersedes_id = NULL, version_seq = 0, rectification_reason = NULL WHERE location = '${TAG}';
DELETE FROM classification WHERE location = '${TAG}';
UPDATE management_period SET status = 'OPEN', closed_at = NULL WHERE periodo_fecha = '${CLOSED_MONTH}';
DELETE FROM perfiles WHERE id = '${OPER2_UID}';`);
}
owner(`
INSERT INTO auth.users (id, is_sso_user, is_anonymous) VALUES ('${ADMIN_UID}', false, false), ('${OPER_UID}', false, false), ('${OPER2_UID}', false, false)
ON CONFLICT (id) DO NOTHING;
INSERT INTO perfiles (id, email, rol_type, activo) VALUES
  ('${ADMIN_UID}', 'admin@test.local', 'ADMIN', true), ('${OPER_UID}', 'operator@test.local', 'OPERATOR', true)
ON CONFLICT (id) DO NOTHING;
INSERT INTO management_period (periodo_fecha) VALUES ('2026-05-01'), ('${CLOSED_MONTH}') ON CONFLICT DO NOTHING;`);
cleanup();
owner(`INSERT INTO perfiles (id, email, rol_type, activo) VALUES ('${OPER2_UID}', 'operator2@test.local', 'OPERATOR', true) ON CONFLICT (id) DO NOTHING;`);

const G = Object.fromEntries(owner(`SELECT string_agg(nombre || '=' || id, ',') FROM classification_grade;`).split(',').map((p) => p.split('=')));
const L = (grade, quantity, unit) => (unit === undefined ? { classification_grade_id: G[grade], quantity } : { classification_grade_id: G[grade], quantity, unit });
const register = (as, lines, date = DAY) =>
  as(`SELECT register_classification('${randomUUID()}', '${date}', '${JSON.stringify(lines)}'::jsonb, '${TAG}');`);
const rectify = (as, id, lines, reason, key = randomUUID()) =>
  as(`SELECT rectify_classification('${key}', '${id}', '${JSON.stringify(lines)}'::jsonb, ${reason === null ? 'NULL' : `'${reason}'`});`);
const linesOf = (id) => owner(`SELECT string_agg(g.nombre || ':' || l.entered_quantity || ' ' || l.entered_unit || '=' || l.quantity, ',' ORDER BY g.nombre)
  FROM classification_line l JOIN classification_grade g ON g.id = l.classification_grade_id WHERE l.classification_id = '${id}';`);
const dayTotal = () => owner(`SELECT COALESCE(max(day_total), 0) || '|' || COALESCE(max(day_sessions), 0) FROM report_classification_day WHERE business_date = '${DAY}';`);

try {
  section('A', 'Entry units: backend conversion (D-CLS-1)');
  check('A0 the seven frozen grades exist (XL, N1, N2, N3, Rotos, Sucios, Descarte)',
    ['XL', 'N1', 'N2', 'N3', 'Rotos', 'Sucios', 'Descarte'].every((g) => G[g]), Object.keys(G).join(','));
  const before = dayTotal();
  const s1 = json(register(ADMIN, [L('N1', 3, 'MAPLE'), L('XL', 2, 'MAPLE'), L('Sucios', 3, 'UNIDAD')]));
  check('A1 mixed units in one session: N1 3 MAPLE = 90, XL 2 MAPLE = 40, Sucios 3 UNIDAD = 3; total 133',
    linesOf(s1.classification_id) === 'N1:3 MAPLE=90,Sucios:3 UNIDAD=3,XL:2 MAPLE=40' && s1.total_quantity === 133, `${linesOf(s1.classification_id)} ${s1.total_quantity}`);
  const s2 = json(register(ADMIN, [L('N2', 1, 'MAPLE'), L('N3', 1, 'MAPLE'), L('Descarte', 1, 'MAPLE'), L('XL', 7, 'UNIDAD')]));
  check('A2 N2 / N3 / Descarte MAPLE = 30 each; XL UNIDAD = 1:1 (Rotos is inactive for new entries — section E)',
    linesOf(s2.classification_id) === 'Descarte:1 MAPLE=30,N2:1 MAPLE=30,N3:1 MAPLE=30,XL:7 UNIDAD=7' && s2.total_quantity === 97, linesOf(s2.classification_id));
  const s3 = json(register(OPER, [L('N1', 5)]));
  check('A3 a line without unit means UNIDAD (pre-ADR-012 meaning), stored as typed', linesOf(s3.classification_id) === 'N1:5 UNIDAD=5', linesOf(s3.classification_id));
  let r = register(ADMIN, [L('N1', 1, 'CAJA')]);
  check('A4 any unit other than UNIDAD / MAPLE → INVALID_UNIT (no CAJA in Classification)', raised(r, 'INVALID_UNIT'), firstErr(r));
  r = register(ADMIN, [L('N1', -1, 'MAPLE')]);
  check('A5 negative entered quantity → INVALID_QUANTITY', raised(r, 'INVALID_QUANTITY'), firstErr(r));
  r = register(ADMIN, [L('N1', 100000000, 'MAPLE')]);
  check('A6 a conversion beyond the integer range → INVALID_QUANTITY (never truncated)', raised(r, 'INVALID_QUANTITY'), firstErr(r));
  r = raw(`INSERT INTO classification_line (classification_id, classification_grade_id, quantity, entered_quantity, entered_unit)
           VALUES ('${s1.classification_id}', '${G.Rotos}', 9, 3, 'UNIDAD');`);
  check('A7 physical backstop: UNIDAD lines must store quantity = entered_quantity', !r.ok && r.err.includes('chk_classification_line_unidad'), firstErr(r));

  section('B', 'Multiple sessions per day (D-CLS-2)');
  const [b0, n0] = before.split('|').map(Number);
  const [b1, n1] = dayTotal().split('|').map(Number);
  check('B1 three sessions on the same day were appended (none replaced): day_sessions +3, day_total +235', n1 - n0 === 3 && b1 - b0 === 235, `${before} → ${dayTotal()}`);
  check('B2 each session stays individually inspectable (three rows, three line sets)',
    owner(`SELECT count(*) FROM classification WHERE location = '${TAG}' AND classification_date = '${DAY}' AND is_current;`) === '3');

  section('C', 'Rectification RPC 47 (D-CLS-3)');
  r = rectify(ADMIN, s1.classification_id, [L('N1', 2, 'MAPLE')], ' ');
  check('C1 blank reason → REASON_REQUIRED, nothing written', raised(r, 'REASON_REQUIRED') && owner(`SELECT count(*) FROM classification WHERE location = '${TAG}';`) === '3', firstErr(r));
  r = rectify(ADMIN, s1.classification_id, [L('N1', 2, 'MAPLE')], null);
  check('C2 NULL reason → REASON_REQUIRED', raised(r, 'REASON_REQUIRED'), firstErr(r));
  r = rectify(ADMIN, s1.classification_id, [], 'x');
  check('C3 empty line set → EMPTY_LINE_SET', raised(r, 'EMPTY_LINE_SET'), firstErr(r));
  const original = linesOf(s1.classification_id);
  const rx = json(rectify(ADMIN, s1.classification_id, [L('N1', 2, 'MAPLE'), L('XL', 2, 'MAPLE'), L('Sucios', 3, 'UNIDAD')], 'conté un maple de más'));
  check('C4 returns the new version: version_seq 1, superseded = the original, total 103', rx.version_seq === 1 && rx.superseded_id === s1.classification_id && rx.total_quantity === 103, JSON.stringify(rx));
  const chain = owner(`SELECT version_seq || '|' || is_current || '|' || supersedes_id || '|' || rectification_reason || '|' || classification_date FROM classification WHERE id = '${rx.classification_id}';`);
  check('C5 new version: current, supersedes the original, keeps its date, stores the reason', chain === `1|true|${s1.classification_id}|conté un maple de más|${DAY}`, chain);
  check('C6 the original version is preserved untouched (lines and entry identical) and is no longer current',
    linesOf(s1.classification_id) === original && owner(`SELECT is_current FROM classification WHERE id = '${s1.classification_id}';`) === 'f', linesOf(s1.classification_id));
  const [b2, n2] = dayTotal().split('|').map(Number);
  check('C7 report uses the effective version only: day_total −30 (133 → 103), day_sessions unchanged (no double count)', b2 === b1 - 30 && n2 === n1, `${b1}|${n1} → ${b2}|${n2}`);
  r = rectify(ADMIN, s1.classification_id, [L('N1', 1, 'MAPLE')], 'otra vez');
  check('C8 rectifying a superseded version → CLASSIFICATION_SUPERSEDED', raised(r, 'CLASSIFICATION_SUPERSEDED'), firstErr(r));
  const rx2 = json(rectify(ADMIN, rx.classification_id, [L('N1', 2, 'MAPLE'), L('XL', 2, 'MAPLE')], 'faltaban los sucios? no: eran del otro día'));
  check('C9 a rectified session can be rectified again (version_seq 2); history keeps all three versions',
    rx2.version_seq === 2 && owner(`SELECT count(*) FROM classification WHERE location = '${TAG}' AND (id = '${s1.classification_id}' OR supersedes_id IS NOT NULL);`) === '3');
  const key = randomUUID();
  json(rectify(ADMIN, s2.classification_id, [L('N2', 2, 'MAPLE')], 'error de tipeo', key));
  r = rectify(ADMIN, rx2.classification_id, [L('N2', 2, 'MAPLE')], 'reuso', key);
  check('C10 a reused idempotency key → DUPLICATE_CLASSIFICATION', raised(r, 'DUPLICATE_CLASSIFICATION'), firstErr(r));
  const audit = owner(`SELECT action || '|' || (before_values->>'total_quantity') || '|' || (after_values->>'total_quantity') || '|' || reason
    FROM audit_events WHERE entity_type = 'classification' AND entity_id = '${rx.classification_id}';`);
  check('C11 audit RECTIFY with before / after totals and the reason', audit === 'RECTIFY|133|103|conté un maple de más', audit);
  r = rectify(OPER, rx2.classification_id, [L('N1', 1, 'UNIDAD')], 'no es mía');
  check('C12 OPERATOR cannot rectify a session it did not create → CLASSIFICATION_NOT_FOUND', raised(r, 'CLASSIFICATION_NOT_FOUND'), firstErr(r));
  r = rectify(OPER2, s3.classification_id, [L('N1', 1, 'UNIDAD')], 'no es mía');
  check('C13 another OPERATOR cannot rectify it either', raised(r, 'CLASSIFICATION_NOT_FOUND'), firstErr(r));
  const ro = json(rectify(OPER, s3.classification_id, [L('N1', 6, 'UNIDAD')], 'era 6'));
  check('C14 OPERATOR rectifies its own current session', ro.version_seq === 1 && ro.total_quantity === 6, JSON.stringify(ro));
  owner(`UPDATE management_period SET status = 'CLOSED', closed_at = NOW() WHERE periodo_fecha = '${CLOSED_MONTH}';`);
  owner(`UPDATE management_period SET status = 'OPEN', closed_at = NULL WHERE periodo_fecha = '${CLOSED_MONTH}';`);
  const sClosed = json(register(ADMIN, [L('N1', 1, 'UNIDAD')], '2026-03-10'));
  owner(`UPDATE management_period SET status = 'CLOSED', closed_at = NOW() WHERE periodo_fecha = '${CLOSED_MONTH}';`);
  r = rectify(ADMIN, sClosed.classification_id, [L('N1', 2, 'UNIDAD')], 'cerrado');
  check('C15 a session in a CLOSED period cannot be rectified → PERIOD_CLOSED', raised(r, 'PERIOD_CLOSED'), firstErr(r));
  owner(`UPDATE management_period SET status = 'OPEN', closed_at = NULL WHERE periodo_fecha = '${CLOSED_MONTH}';`);

  section('D', 'Perimeter');
  const fn = owner(`SELECT p.prosecdef || '|' || has_function_privilege('anon', p.oid, 'EXECUTE') || '|' ||
    has_function_privilege('authenticated', p.oid, 'EXECUTE') || '|' || has_function_privilege('service_role', p.oid, 'EXECUTE')
    FROM pg_proc p WHERE p.proname = 'rectify_classification';`);
  check('D1 rectify_classification: SECURITY DEFINER, EXECUTE only for authenticated', fn === 'true|false|true|false', fn);
  const direct = [
    ADMIN(`UPDATE classification SET is_current = true WHERE id = '${s1.classification_id}';`),
    ADMIN(`UPDATE classification_line SET quantity = 1 WHERE classification_id = '${s1.classification_id}';`),
    ADMIN(`DELETE FROM classification WHERE id = '${s1.classification_id}';`),
    OPER(`UPDATE classification SET rectification_reason = 'x';`),
  ];
  check('D2 no direct UPDATE / DELETE for ADMIN or OPERATOR (RPCs only)', direct.every(denied), direct.map(firstErr).join(' | '));
  const flockCols = owner(`SELECT count(*) FROM information_schema.columns WHERE table_name IN ('classification','classification_line') AND column_name ~* '(flock|lote|shed)';`);
  check('D3 no flock / lote / shed reference introduced (FROZEN Part 14)', flockCols === '0', flockCols);
  const operView = OPER(`SELECT count(*) FROM classification WHERE location = '${TAG}';`);
  check('D4 OPERATOR still reads only its own sessions (both versions of its own rectified session)', operView.ok && operView.out === '2', operView.out || firstErr(operView));

  section('E', 'Grade Rotos merged forward into Descarte (ADR-014 / D-CLS-6)');
  const grades = owner(`SELECT string_agg(nombre || ':' || activo, ',' ORDER BY nombre) FROM classification_grade WHERE nombre IN ('Rotos','Descarte');`);
  check('E1 Rotos is inactive and Descarte active; both rows still exist (no hard delete)', grades === 'Descarte:true,Rotos:false', grades);
  r = register(ADMIN, [L('Rotos', 1, 'UNIDAD')]);
  check('E2 a new session cannot use the inactive Rotos grade → GRADE_NOT_FOUND', raised(r, 'GRADE_NOT_FOUND'), firstErr(r));
  // a historical session recorded while Rotos was active (owner fixture of the pre-0065 state)
  const hist = owner(`INSERT INTO classification (idempotency_key, classification_date, location, created_by)
    VALUES ('${randomUUID()}', '${DAY}', '${TAG}', '${ADMIN_UID}') RETURNING id;`);
  owner(`INSERT INTO classification_line (classification_id, classification_grade_id, quantity, entered_quantity, entered_unit)
    VALUES ('${hist}', '${G.Rotos}', 60, 2, 'MAPLE');`);
  check('E3 a historical Rotos line stays readable with its grade name and its ADR-012 maple conversion (2 maples = 60)',
    linesOf(hist) === 'Rotos:2 MAPLE=60', linesOf(hist));
  const asAdmin = ADMIN(`SELECT g.nombre || ':' || l.quantity FROM classification_line l JOIN classification_grade g ON g.id = l.classification_grade_id WHERE l.classification_id = '${hist}';`);
  check('E4 ADMIN reads the historical Rotos line through RLS (inactive grade still resolves)', asAdmin.ok && asAdmin.out === 'Rotos:60', asAdmin.out || firstErr(asAdmin));
  const operGrade = OPER(`SELECT nombre || ':' || activo FROM classification_grade WHERE id = '${G.Rotos}';`);
  check('E4b OPERATOR can read the inactive grade name for history (0066), still inactive', operGrade.ok && operGrade.out === 'Rotos:false', operGrade.out || firstErr(operGrade));
  const histDay = owner(`SELECT quantity FROM report_classification_day WHERE business_date = '${DAY}' AND grade_nombre = 'Rotos';`);
  check('E5 the daily report still shows historical Rotos under its own name (no reassignment to Descarte)', histDay === '60', histDay);
  const rx3 = json(rectify(ADMIN, hist, [L('Descarte', 2, 'MAPLE')], 'Rotos ya no se usa'));
  check('E6 a historical Rotos session can be rectified onto active grades; the original line is kept', rx3.total_quantity === 60 && linesOf(hist) === 'Rotos:2 MAPLE=60');
  const prod = owner(`SELECT column_name FROM information_schema.columns WHERE table_name = 'daily_production' AND column_name = 'eggs_broken';`);
  check('E7 the Production metric eggs_broken is a separate column, unchanged', prod === 'eggs_broken', prod);
} finally {
  cleanup();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
