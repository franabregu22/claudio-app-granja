#!/usr/bin/env node
/**
 * ADR-018 §9.3 — MP RELEASE REPORT CAPTURE, VALIDATION MODE (migration 0078). LOCAL TEST DATABASE ONLY.
 *
 * Covers fin_capture_mp_release_report: caller / actor checks, attempt fields, canonical evidence path, the p_rows
 * contract, row validity decided by the frozen D1 parser (unknown DESCRIPTION, malformed DATE, arithmetic, non-numeric
 * payment SOURCE_ID, duplicate identity), CONTROL rows, file-level rejection, replay and the previous_run_id chain,
 * evidence immutability, the ZERO-FINANCIAL-EFFECT assertion (no row added to financial_operation, financial_posting,
 * mp_source_record, mp_transition_identity, mp_webhook_delivery, mp_reconciliation, mp_financial_movement,
 * mp_report_match, fin_statement_line), and the privilege / Storage perimeter.
 *
 * Everything runs inside ONE transaction that is rolled back (runs and appearances are immutable). Synthetic data only.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *     node scripts/target-db/fin_mp_release_report.test.mjs
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
const dockerRun = (args, input) => {
  const r = spawnSync(DOCKER, args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`docker: ${r.error.message}`);
  return r;
};

// ── SQL helpers ──────────────────────────────────────────────────────────────
const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const ADMIN = 'aaaaaaaa-0080-0000-0000-00000000000a';
const OPER = 'aaaaaaaa-0080-0000-0000-00000000000b';
const MPACC = `(SELECT id FROM financial_account WHERE nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE')`;
const sha = (seed) => createHash('sha256').update(`ADR018-0080-${seed}`).digest('hex');
const RES = (key, path = 'run_id') => `(SELECT v ->> '${path}' FROM res WHERE k = '${key}')`;
const P = (expr) => `{{${expr}}}`;   // resolved by run_as as the owner, before the role switch
const PARSER = 'mp-release-report-csv/1.0.0';
const FORMAT = 'MP_RELEASE_REPORT_CSV_V1';

const sql = [];
const add = (s) => sql.push(s);
const expect = (name, got, like) => add(`SELECT pg_temp.expect(${lit(name)}, ${got}, ${lit(like)});`);

// ── synthetic Liberaciones rows (ADR-003 D1: 15 keys, every value the exported string) ─────────────────────────
const EMPTY = { BALANCE_AMOUNT: '', BUSINESS_UNIT: '', DATE: '', DESCRIPTION: '', GROSS_AMOUNT: '', MP_FEE_AMOUNT: '',
  NET_CREDIT_AMOUNT: '', NET_DEBIT_AMOUNT: '', PAYMENT_METHOD: '', PAYMENT_METHOD_TYPE: '', PURCHASE_ID: '', SOURCE_ID: '',
  SUB_UNIT: '', TAXES_AMOUNT: '', TRANSACTION_APPROVAL_DATE: '' };
const mv = (t, sid, desc, credit, debit, gross, tax, bal, method = 'available_money', type = 'account_money') => ({
  ...EMPTY, DATE: `2026-10-05T${t}.000-03:00`, SOURCE_ID: sid, DESCRIPTION: desc, NET_CREDIT_AMOUNT: credit, NET_DEBIT_AMOUNT: debit,
  GROSS_AMOUNT: gross, MP_FEE_AMOUNT: '0.00', TAXES_AMOUNT: tax, PAYMENT_METHOD: method, TRANSACTION_APPROVAL_DATE: `2026-10-05T${t}.000-03:00`,
  BALANCE_AMOUNT: bal, PAYMENT_METHOD_TYPE: type });
const OPENING = { ...EMPTY, DATE: '2026-10-05T00:00:00.000-03:00', NET_CREDIT_AMOUNT: '1000.00', NET_DEBIT_AMOUNT: '0.00',
  GROSS_AMOUNT: '1000.00', MP_FEE_AMOUNT: '0.00', TAXES_AMOUNT: '0.00', BALANCE_AMOUNT: '1000.00' };
const TOTALS = { ...EMPTY, NET_CREDIT_AMOUNT: '9941.00', NET_DEBIT_AMOUNT: '0.00', GROSS_AMOUNT: '10000.00', MP_FEE_AMOUNT: '0.00',
  TAXES_AMOUNT: '-59.00', BALANCE_AMOUNT: '0.00' };
const GOOD = [
  OPENING,
  mv('08:00:00', '900000000001', 'payment', '8946.00', '0.00', '9000.00', '-54.00', '9946.00', 'cvu', 'bank_transfer'),
  mv('09:00:00', '900000000002', 'payment', '0.00', '500.00', '-500.00', '0.00', '9446.00'),
  mv('10:00:00', '900000000003', 'asset_management', '12.34', '0.00', '12.34', '0.00', '9458.34', '', ''),
  mv('11:00:00', '900000000004', 'reserve_for_payout', '0.00', '200.00', '-200.00', '0.00', '9258.34', 'available_money', ''),
  mv('11:00:01', '900000000004', 'reserve_for_payout', '200.00', '0.00', '200.00', '0.00', '9458.34', 'available_money', ''),
  mv('11:00:01', '900000000004', 'payout', '0.00', '200.00', '-200.00', '0.00', '9258.34', 'available_money', ''),
  mv('12:00:00', '900000000005', 'reserve_for_payment', '0.00', '10.00', '-10.00', '0.00', '9248.34'),
  TOTALS,
];
const rowsOf = (raws) => raws.map((raw_row, i) => ({ row_number: i + 1, raw_row }));
const swap = (i, over) => GOOD.map((r, j) => (j === i ? { ...r, ...over } : r));

function captureCall(o) {
  const s = o.sha;
  return `SELECT ${o.fn ?? 'fin_capture_mp_release_report'}(${lit(o.actor === undefined ? ADMIN : o.actor)}::uuid, ${lit(o.parser ?? PARSER)},
    ${lit(o.format === undefined ? FORMAT : o.format)}, ${lit(s)},
    ${o.path === undefined ? P(`'mp/' || ${MPACC} || '/${s}.csv'`) : lit(o.path)}, ${lit(o.file ?? 'release-report.csv')}, 2048,
    '2026-10-05'::date, '2026-10-05'::date, ${lit(JSON.stringify(o.meta ?? { report_type: 'release_report', task_id: '1' }))}::jsonb,
    ${lit(o.reject ?? null)}, ${o.rows === null ? 'NULL' : `${lit(JSON.stringify(o.rows ?? rowsOf(GOOD)))}::jsonb`})::text`;
}
const as = (role, uid, call, key = null) => `pg_temp.run_as(${lit(role)}, ${lit(uid)}, ${lit(call)}, ${lit(key)})`;
const service = (o, key = null) => as('service_role', null, captureCall(o), key);
const RUN = (key) => `(SELECT r FROM fin_import_run r WHERE r.id = ${RES(key)}::uuid)`;
const outcomes = (key) => `(SELECT string_agg(row_number || ':' || outcome || ':' || coalesce(appearance_meta ->> 'row_class', '?') || ':' || coalesce(split_part(note, ':', 1), '-'), ',' ORDER BY row_number)
  FROM fin_import_run_line WHERE run_id = ${RES(key)}::uuid)`;

const FIN_TABLES = ['financial_operation', 'financial_posting', 'mp_source_record', 'mp_transition_identity', 'mp_webhook_delivery',
  'mp_reconciliation', 'mp_financial_movement', 'mp_report_match', 'fin_statement_line'];
const counts = () => FIN_TABLES.map((t) => `SELECT ${lit(t)} AS t, count(*) AS n FROM ${t}`).join(' UNION ALL ');

// ── prelude ──────────────────────────────────────────────────────────────────
add(`\\set ON_ERROR_STOP 1
BEGIN;
CREATE TEMP TABLE res (k TEXT PRIMARY KEY, v JSONB);
CREATE FUNCTION pg_temp.run_as(p_role TEXT, p_uid TEXT, p_sql TEXT, p_key TEXT) RETURNS TEXT LANGUAGE plpgsql AS $f$
DECLARE v TEXT; msg TEXT; ok BOOLEAN := false; e TEXT; val TEXT;
BEGIN
  LOOP
    e := substring(p_sql FROM '\\{\\{(.+?)\\}\\}');
    EXIT WHEN e IS NULL;
    EXECUTE 'SELECT (' || e || ')::text' INTO val;
    p_sql := replace(p_sql, '{{' || e || '}}', quote_nullable(val));
  END LOOP;
  BEGIN
    EXECUTE format('SET LOCAL ROLE %I', p_role);
    PERFORM set_config('request.jwt.claims', CASE WHEN p_uid IS NULL THEN json_build_object('role', p_role)::text
                                                  ELSE json_build_object('sub', p_uid, 'role', p_role)::text END, true);
    EXECUTE p_sql INTO v;
    ok := true;
    RESET ROLE;
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    RESET ROLE;
  END;
  IF ok AND p_key IS NOT NULL THEN
    INSERT INTO res VALUES (p_key, v::jsonb) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v;
  END IF;
  RETURN CASE WHEN ok THEN 'OK:' || coalesce(v, 'null') ELSE 'ERR:' || msg END;
END $f$;
CREATE FUNCTION pg_temp.expect(p_name TEXT, p_got TEXT, p_like TEXT) RETURNS VOID LANGUAGE plpgsql AS $f$
BEGIN
  IF p_got IS NULL OR p_got NOT LIKE p_like THEN
    RAISE NOTICE 'FAIL % :: got [%] expected like [%]', p_name, p_got, p_like;
  ELSE
    RAISE NOTICE 'PASS %', p_name;
  END IF;
END $f$;
CREATE FUNCTION pg_temp.err_of(p_sql TEXT) RETURNS TEXT LANGUAGE plpgsql AS $f$
BEGIN EXECUTE p_sql; RETURN 'OK'; EXCEPTION WHEN others THEN RETURN 'ERR:' || SQLERRM; END $f$;
INSERT INTO perfiles (id, email, rol_type) VALUES
  ('${ADMIN}', 'adr018-0080-admin@test.local', 'ADMIN'),
  ('${OPER}',  'adr018-0080-oper@test.local',  'OPERATOR');
CREATE TEMP TABLE before_counts AS ${counts()};`);

const NORMAL = (o, key = null) => as('service_role', null, captureCall({ ...o, fn: 'fin_ingest_mp_release_report' }), key);
const VALID = (o, key = null) => as('service_role', null, captureCall({ ...o, fn: 'fin_capture_mp_release_report' }), key);
const EMPTY_DAY = [{ ...OPENING, DATE: '2026-10-11T00:00:00.000-03:00' }, { ...TOTALS, NET_CREDIT_AMOUNT: '0.00', GROSS_AMOUNT: '0.00', TAXES_AMOUNT: '0.00' }];
const P10 = 'mp-release-report-csv/1.0.0';
const P11 = 'mp-release-report-csv/1.1.0';
const runFields = (key) => `(SELECT format('%s|%s|%s|%s|%s|%s|%s|%s', r.mode, r.status, r.rows_total, r.lines_new, r.lines_known, r.rows_ignored, r.rows_invalid, coalesce(r.reject_reason, '-'))
  FROM fin_import_run r WHERE r.id = ${RES(key)}::uuid)`;

// ── A. NORMAL, valid report without movements ────────────────────────────────
const SA = sha('normal-empty');
expect('A-1 NORMAL empty valid report → PARSED', NORMAL({ sha: SA, parser: P11, rows: rowsOf(EMPTY_DAY) }, 'A'), 'OK:%"status": "PARSED"%');
expect('A-2 rows 2 · new 0 · known 0 · ignored 2 · invalid 0 · no reject reason', runFields('A'), 'NORMAL|PARSED|2|0|0|2|0|-');
expect('A-3 both appearances IGNORED CONTROL, no destination', outcomes('A'), '1:IGNORED:CONTROL:CONTROL_ROW,2:IGNORED:CONTROL:CONTROL_ROW');
expect('A-4 response: 0 back-fills, 0 yields', `(SELECT (v ->> 'backfills_created') || '/' || (v ->> 'yields_applied') FROM res WHERE k = 'A')`, '0/0');

// ── B. VALIDATION, valid report without movements (same rule for model consistency) ─
expect('B-1 VALIDATION empty valid report → VALIDATED', VALID({ sha: sha('validation-empty'), parser: P11, rows: rowsOf(EMPTY_DAY) }, 'B'), 'OK:%"status": "VALIDATED"%');
expect('B-2 two CAPTURED CONTROL rows, nothing invalid', outcomes('B'), '1:CAPTURED:CONTROL:-,2:CAPTURED:CONTROL:-');

// ── C. replay ────────────────────────────────────────────────────────────────
expect('C-1 same empty report again → replay of the same run', NORMAL({ sha: SA, parser: P11, rows: rowsOf(EMPTY_DAY) }, 'A2'), 'OK:%"replayed": true%');
expect('C-2 replay returns the first run id', `(${RES('A2')} = ${RES('A')})::text`, 'true');

// ── D. the 2026-10-11 case: REJECTED NO_MOVEMENT_ROWS under 1.0.0, reprocessed with 1.1.0 ─
const SD = sha('2026-10-11');
add(`INSERT INTO fin_import_run (id, source_kind, mode, financial_account_id, format_code, parser_version, file_sha256, storage_path, file_name, byte_size,
  coverage_from, coverage_to, status, reject_reason, rows_total, rows_ignored, source_meta, created_by)
SELECT 'dddddddd-0080-0000-0000-000000000011', 'MP_RELEASE_REPORT', 'NORMAL', ${MPACC}, 'MP_RELEASE_REPORT_CSV_V1', '${P10}', '${SD}',
  'mp/' || ${MPACC} || '/${SD}.csv', 'release-report.csv', 2048, '2026-10-11', '2026-10-11', 'REJECTED',
  'NO_MOVEMENT_ROWS: the report has no movement row', 2, 2, '{}'::jsonb, '${ADMIN}';
INSERT INTO fin_import_run_line (run_id, row_number, source_kind, mode, raw_row, outcome, note, appearance_meta)
SELECT 'dddddddd-0080-0000-0000-000000000011', n, 'MP_RELEASE_REPORT', 'NORMAL', r, 'IGNORED', 'RUN_REJECTED', '{"row_class":"CONTROL"}'::jsonb
  FROM jsonb_array_elements(${lit(JSON.stringify(EMPTY_DAY))}::jsonb) WITH ORDINALITY x(r, n);
CREATE TEMP TABLE old_run AS SELECT * FROM fin_import_run WHERE id = 'dddddddd-0080-0000-0000-000000000011';
CREATE TEMP TABLE old_lines AS SELECT * FROM fin_import_run_line WHERE run_id = 'dddddddd-0080-0000-0000-000000000011';`);
expect('D-1 same bytes, same old parser version → replay of the REJECTED attempt (old evidence returned)',
  NORMAL({ sha: SD, parser: P10, rows: rowsOf(EMPTY_DAY) }, 'D0'), 'OK:%"status": "REJECTED"%"replayed": true%');
expect('D-2 reprocess with parser 1.1.0 → new run PARSED', NORMAL({ sha: SD, parser: P11, rows: rowsOf(EMPTY_DAY) }, 'D'), 'OK:%"status": "PARSED"%"replayed": false%');
expect('D-3 new run linked to the REJECTED one (previous_run_id), 2 CONTROL, 0 new, 0 invalid',
  `(SELECT (previous_run_id = 'dddddddd-0080-0000-0000-000000000011')::text || '|' || rows_total || '|' || rows_ignored || '|' || lines_new || '|' || rows_invalid
     FROM fin_import_run WHERE id = ${RES('D')}::uuid)`, 'true|2|2|0|0');
expect('D-4 the REJECTED run and its appearances are unchanged',
  `((SELECT row(r.*)::text FROM fin_import_run r WHERE id = 'dddddddd-0080-0000-0000-000000000011') = (SELECT row(o.*)::text FROM old_run o)
    AND (SELECT string_agg(row(l.*)::text, ',' ORDER BY row_number) FROM fin_import_run_line l WHERE run_id = 'dddddddd-0080-0000-0000-000000000011')
      = (SELECT string_agg(row(o.*)::text, ',' ORDER BY row_number) FROM old_lines o))::text`, 'true');
expect('D-5 a further attempt with 1.1.0 → replay of the PARSED run (processed once)', NORMAL({ sha: SD, parser: P11, rows: rowsOf(EMPTY_DAY) }), 'OK:%"replayed": true%');

// ── E. malformed reports that look empty stay REJECTED ──────────────────────
const bad = (label, seed, rows, note) => {
  expect(`E ${label} → REJECTED`, NORMAL({ sha: sha(seed), parser: P11, rows: rowsOf(rows) }, `E_${seed}`), 'OK:%"status": "REJECTED"%');
  expect(`E ${label}: INVALID ${note}`, `(SELECT string_agg(DISTINCT split_part(note, ':', 1), ',') FROM fin_import_run_line WHERE run_id = ${RES(`E_${seed}`)}::uuid AND outcome = 'INVALID')`, note);
  expect(`E ${label}: nothing reached mp_source_record`, `(SELECT count(*)::text FROM fin_import_run_line WHERE run_id = ${RES(`E_${seed}`)}::uuid AND mp_source_record_id IS NOT NULL)`, '0');
};
bad('control row with a malformed amount', 'bad-amount', [{ ...EMPTY_DAY[0], BALANCE_AMOUNT: '1.000,00' }, EMPTY_DAY[1]], 'INVALID_CONTROL_ROW');
bad('control row with a malformed DATE', 'bad-date', [{ ...EMPTY_DAY[0], DATE: '11/10/2026' }, EMPTY_DAY[1]], 'INVALID_CONTROL_ROW');
bad('control row carrying a payment method', 'bad-method', [{ ...EMPTY_DAY[0], PAYMENT_METHOD: 'available_money' }, EMPTY_DAY[1]], 'INVALID_CONTROL_ROW');
bad('control row with an empty amount', 'bad-empty-amount', [{ ...EMPTY_DAY[0], GROSS_AMOUNT: '' }, EMPTY_DAY[1]], 'INVALID_CONTROL_ROW');
bad('empty day plus an unknown DESCRIPTION row', 'bad-desc', [EMPTY_DAY[0], mv('12:00:00', '900000000099', 'money_transfer', '1.00', '0.00', '1.00', '0.00', '1.00'), EMPTY_DAY[1]], 'UNKNOWN_DESCRIPTION');
expect('E rows contract still enforced (missing key → exception)', NORMAL({ sha: sha('bad-contract'), parser: P11, rows: rowsOf([(({ BALANCE_AMOUNT: _b, ...r }) => r)(EMPTY_DAY[0])]) }), 'ERR:INVALID_ROWS_CONTRACT%');

// ── F. a day without activity: no exception, no effect ───────────────────────
expect('F-1 activity view: only CONTROL rows for the empty days, no EXCEPTION',
  `(SELECT string_agg(DISTINCT v.coverage_status, ',') FROM (SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true)) c,
     LATERAL (SELECT * FROM fin_mp_report_activity WHERE run_id IN (${RES('A')}::uuid, ${RES('D')}::uuid)) v)`, 'CONTROL');
for (const t of FIN_TABLES) {
  expect(`F zero financial effect: Δ ${t} = 0`, `(SELECT ((SELECT count(*) FROM ${t}) - b.n)::text FROM before_counts b WHERE b.t = ${lit(t)})`, '0');
}

// ── G. regression: a report with movements is unchanged (payment back-fill, yield, payout, outbound) ─
const SG = sha('regression');
expect('G-1 report with movements → PARSED', NORMAL({ sha: SG, parser: P11, rows: rowsOf(GOOD) }, 'G'), 'OK:%"status": "PARSED"%');
expect('G-2 one inbound back-fill, one yield application (as before 0080)', `(SELECT (v ->> 'backfills_created') || '/' || (v ->> 'yields_applied') FROM res WHERE k = 'G')`, '1/1');
expect('G-3 payout movement not applied; outbound parked; payment parked DEFERRED_V4',
  `(SELECT string_agg(s.external_id || '=' || s.processing_status || ':' || coalesce(split_part(s.processing_note, ':', 1), '-'), ',' ORDER BY s.external_id)
     FROM fin_import_run_line l JOIN mp_source_record s ON s.id = l.mp_source_record_id
    WHERE l.run_id = ${RES('G')}::uuid AND s.event_data ->> 'DESCRIPTION' IN ('payment', 'payout'))`,
  '900000000001:payment:C=PENDING:DEFERRED_V4,900000000002:payment:D=PENDING:DEFERRED_V4,900000000004:payout:D=NORMALIZED:-');
expect('G-4 invalid economic row still fails closed', NORMAL({ sha: sha('regression-bad'), parser: P11, rows: rowsOf(swap(2, { DESCRIPTION: 'money_transfer' })) }), 'OK:%"status": "REJECTED"%');

// ── H. perimeter ─────────────────────────────────────────────────────────────
expect('H-1 SECURITY DEFINER set = 88 (0080 adds none; 0081, 0083, 0084, 0086 + 0087 payout confirm add one each)', `(SELECT count(*)::text FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace)`, '88');
expect('H-2 helper fin_mp_control_row_valid: INVOKER, IMMUTABLE, owner only',
  `(SELECT prosecdef || ':' || provolatile::text || ':' || has_function_privilege('anon', oid, 'EXECUTE') || has_function_privilege('authenticated', oid, 'EXECUTE')
      || has_function_privilege('service_role', oid, 'EXECUTE') FROM pg_proc WHERE proname = 'fin_mp_control_row_valid')`, 'false:i:falsefalsefalse');
expect('H-3 report functions keep service_role-only EXECUTE',
  `(SELECT string_agg(proname || ':' || has_function_privilege('authenticated', oid, 'EXECUTE') || has_function_privilege('service_role', oid, 'EXECUTE'), ',' ORDER BY proname)
     FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('fin_capture_mp_release_report', 'fin_ingest_mp_release_report'))`,
  'fin_capture_mp_release_report:falsetrue,fin_ingest_mp_release_report:falsetrue');

add('ROLLBACK;');

// ── run ──────────────────────────────────────────────────────────────────────
const target = assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);
const container = (dockerRun(['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}']).stdout || '').trim().split('\n').filter(Boolean)[0];
if (!container) { console.error('  no running supabase_db container. Run `supabase start`.'); process.exit(1); }
const mapping = (dockerRun(['port', container, '5432/tcp']).stdout || '').trim();
if (!mapping.includes(`:${target.port}`)) { console.error(`  container mapping ${mapping} does not match guarded port ${target.port}`); process.exit(1); }
console.log(`  container: ${container}`);

const r = dockerRun(['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], sql.join('\n'));
const lines = `${r.stdout}\n${r.stderr}`.split('\n');
let pass = 0;
let fail = 0;
for (const l of lines) {
  const m = l.match(/NOTICE:\s+(PASS|FAIL) (.*)$/);
  if (m) {
    if (m[1] === 'PASS') { pass += 1; console.log(`    OK   ${m[2]}`); } else { fail += 1; console.log(`    MAL  ${m[2]}`); }
  }
}
if (r.status !== 0) {
  fail += 1;
  console.log(`    MAL  psql aborted: ${(lines.find((l) => /ERROR/.test(l)) || r.stderr || '').slice(0, 300)}`);
}
console.log(`\n  ══ ADR-018 0080 EMPTY REPORTS RESULT: ${pass} passed, ${fail} failed ══\n`);
process.exit(fail === 0 ? 0 : 1);
