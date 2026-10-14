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
const ADMIN = 'aaaaaaaa-0078-0000-0000-00000000000a';
const OPER = 'aaaaaaaa-0078-0000-0000-00000000000b';
const MPACC = `(SELECT id FROM financial_account WHERE nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE')`;
const sha = (seed) => createHash('sha256').update(`ADR018-0078-${seed}`).digest('hex');
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
  return `SELECT fin_capture_mp_release_report(${lit(o.actor === undefined ? ADMIN : o.actor)}::uuid, ${lit(o.parser ?? PARSER)},
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
  ('${ADMIN}', 'adr018-0078-admin@test.local', 'ADMIN'),
  ('${OPER}',  'adr018-0078-oper@test.local',  'OPERATOR');
CREATE TEMP TABLE before_counts AS ${counts()};`);

expect('the Mercado Pago account exists (EXTERNAL_SERVICE)', `(SELECT count(*)::text FROM financial_account WHERE nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE' AND activo)`, '1');

// ── 1. caller and actor ──────────────────────────────────────────────────────
expect('authenticated (even ADMIN) cannot call it', as('authenticated', ADMIN, captureCall({ sha: sha('auth') })), 'ERR:permission denied%');
expect('anon cannot call it', as('anon', null, captureCall({ sha: sha('auth') })), 'ERR:permission denied%');
expect('service_role with an OPERATOR actor → FORBIDDEN', service({ sha: sha('auth'), actor: OPER }), 'ERR:FORBIDDEN%');
expect('service_role without actor → FORBIDDEN', service({ sha: sha('auth'), actor: null }), 'ERR:FORBIDDEN%');

// ── 2. attempt fields and contract ───────────────────────────────────────────
expect('parser_version required', service({ sha: sha('c1'), parser: ' ' }), 'ERR:PARSER_VERSION_REQUIRED%');
expect('sha256 must be lowercase hex', service({ sha: 'ABC', path: 'mp/x/ABC.csv' }), 'ERR:INVALID_FILE_SHA256%');
expect('evidence path must be mp/<MP account>/<sha>.csv', service({ sha: sha('c2'), path: `bank/x/${sha('c2')}.csv` }), 'ERR:EVIDENCE_PATH_INVALID%');
expect('a parsed file must carry the MP format', service({ sha: sha('c3'), format: 'BNA_MONTHLY_PDF_V1' }), 'ERR:INVALID_ROWS_CONTRACT%');
expect('a file-level reject carries no rows', service({ sha: sha('c4'), format: null, reject: 'HEADER_MISMATCH: x' }), 'ERR:INVALID_ROWS_CONTRACT%');
expect('rows: outcome is never accepted from the caller',
  service({ sha: sha('c5'), rows: rowsOf(GOOD).map((r) => ({ ...r, outcome: 'CAPTURED' })) }), 'ERR:INVALID_ROWS_CONTRACT%');
expect('rows: row_number must be 1..n in order',
  service({ sha: sha('c6'), rows: rowsOf(GOOD).map((r) => ({ ...r, row_number: r.row_number + 1 })) }), 'ERR:INVALID_ROWS_CONTRACT%');
expect('rows: raw_row must hold exactly the 15 keys', (() => {
  const { PURCHASE_ID: _drop, ...fourteen } = GOOD[1];
  return service({ sha: sha('c7'), rows: rowsOf([OPENING, fourteen]) });
})(), 'ERR:INVALID_ROWS_CONTRACT%');
expect('rows: every raw value is a string',
  service({ sha: sha('c8'), rows: rowsOf([OPENING, { ...GOOD[1], GROSS_AMOUNT: 9000 }]) }), 'ERR:INVALID_ROWS_CONTRACT%');
expect('nothing written by refused calls', `(SELECT count(*)::text FROM fin_import_run WHERE file_sha256 IN (${['auth', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'].map((s) => lit(sha(s))).join(', ')}))`, '0');

// ── 3. successful VALIDATION capture ─────────────────────────────────────────
const S1 = sha('good');
expect('capture → VALIDATED', service({ sha: S1 }, 'R1'), 'OK:%"status": "VALIDATED"%');
expect('run: MP_RELEASE_REPORT / VALIDATION / MP account / ADMIN / format / parser / coverage',
  `(SELECT format('%s|%s|%s|%s|%s|%s|%s|%s', r.source_kind, r.mode, r.financial_account_id = ${MPACC}, r.created_by = '${ADMIN}', r.format_code, r.parser_version, r.coverage_from, r.coverage_to)
     FROM fin_import_run r WHERE r.id = ${RES('R1')}::uuid)`,
  `MP_RELEASE_REPORT|VALIDATION|t|t|${FORMAT}|${PARSER}|2026-10-05|2026-10-05`);
expect('counters: total 9, captured 9, invalid 0, no new/known lines', `(SELECT format('%s/%s/%s/%s/%s/%s', rows_total, rows_captured, rows_invalid, lines_new, lines_known, rows_ignored) FROM fin_import_run WHERE id = ${RES('R1')}::uuid)`, '9/9/0/0/0/0');
expect('every row CAPTURED; opening and totals rows are CONTROL', outcomes('R1'),
  '1:CAPTURED:CONTROL:-,2:CAPTURED:MOVEMENT:-,3:CAPTURED:MOVEMENT:-,4:CAPTURED:MOVEMENT:-,5:CAPTURED:MOVEMENT:-,6:CAPTURED:MOVEMENT:-,7:CAPTURED:MOVEMENT:-,8:CAPTURED:MOVEMENT:-,9:CAPTURED:CONTROL:-');
expect('appearances keep the exact raw row and have no destination',
  `(SELECT format('%s|%s|%s', count(*) FILTER (WHERE statement_line_id IS NULL AND mp_source_record_id IS NULL),
                  bool_and(source_kind = 'MP_RELEASE_REPORT' AND mode = 'VALIDATION'),
                  (SELECT raw_row FROM fin_import_run_line WHERE run_id = ${RES('R1')}::uuid AND row_number = 2) = ${lit(JSON.stringify(GOOD[1]))}::jsonb)
     FROM fin_import_run_line WHERE run_id = ${RES('R1')}::uuid)`, '9|t|t');
expect('source_meta kept as given', `(SELECT source_meta ->> 'report_type' FROM fin_import_run WHERE id = ${RES('R1')}::uuid)`, 'release_report');

// ── 4. idempotency ───────────────────────────────────────────────────────────
expect('same bytes, same parser → replay of the same run', service({ sha: S1 }, 'R1b'), 'OK:%"replayed": true%');
expect('replay returns the first run id', `(${RES('R1b')} = ${RES('R1')})::text`, 'true');
expect('one run and 9 appearances for those bytes', `(SELECT format('%s/%s', count(DISTINCT r.id), count(l.*)) FROM fin_import_run r LEFT JOIN fin_import_run_line l ON l.run_id = r.id WHERE r.file_sha256 = '${S1}')`, '1/9');
expect('same bytes, new parser version → new run', service({ sha: S1, parser: 'mp-release-report-csv/1.0.1' }, 'R2'), 'OK:%"replayed": false%');
expect('the new attempt links to the latest one (previous_run_id)', `(SELECT (previous_run_id = ${RES('R1')}::uuid)::text FROM fin_import_run WHERE id = ${RES('R2')}::uuid)`, 'true');

// ── 5. row-level fail closed (run REJECTED, appearances kept as evidence) ────
const rejectCase = (name, seed, raws, expectRow, expectNote) => {
  const key = `X_${seed}`;
  expect(`${name} → REJECTED (INVALID_ROWS)`, service({ sha: sha(seed), rows: rowsOf(raws) }, key), 'OK:%"status": "REJECTED"%');
  expect(`${name}: reject reason`, `(SELECT reject_reason FROM fin_import_run WHERE id = ${RES(key)}::uuid)`, 'INVALID_ROWS: 1 row(s)%');
  expect(`${name}: row ${expectRow} INVALID with ${expectNote}`,
    `(SELECT outcome || ':' || split_part(note, ':', 1) FROM fin_import_run_line WHERE run_id = ${RES(key)}::uuid AND row_number = ${expectRow})`, `INVALID:${expectNote}`);
  expect(`${name}: the other rows stay CAPTURED`, `(SELECT count(*)::text FROM fin_import_run_line WHERE run_id = ${RES(key)}::uuid AND outcome = 'CAPTURED')`, String(raws.length - 1));
};
rejectCase('unknown DESCRIPTION', 'unknown-desc', swap(2, { DESCRIPTION: 'money_transfer' }), 3, 'UNKNOWN_DESCRIPTION');
rejectCase('empty DESCRIPTION with SOURCE_ID', 'empty-desc', swap(2, { DESCRIPTION: '' }), 3, 'UNKNOWN_DESCRIPTION');
rejectCase('malformed DATE', 'bad-date', swap(1, { DATE: '05/10/2026 08:00' }), 2, 'MALFORMED_DATE');
rejectCase('arithmetic mismatch', 'arith', swap(1, { GROSS_AMOUNT: '9001.00' }), 2, 'ARITHMETIC_MISMATCH');
rejectCase('both credit and debit', 'credit-debit', swap(1, { NET_DEBIT_AMOUNT: '1.00' }), 2, 'CREDIT_DEBIT_INVALID');
rejectCase('malformed amount', 'amount', swap(1, { TAXES_AMOUNT: '-54,00' }), 2, 'MALFORMED_AMOUNT');
rejectCase('payment with a non-numeric SOURCE_ID', 'sid', swap(1, { SOURCE_ID: 'ABC-1' }), 2, 'INVALID_SOURCE_ID');
rejectCase('movement without DATE', 'no-date', swap(1, { DATE: '' }), 2, 'MISSING_IDENTITY');
rejectCase('duplicate identity in the report', 'dup', [...GOOD.slice(0, 2), GOOD[1], ...GOOD.slice(2)], 3, 'DUPLICATE_IDENTITY');

// 0080 (owner decision 2026-10-14): a valid report without movements is a day without activity, not a rejection
expect('only CONTROL rows → VALIDATED (0080: day without activity)', service({ sha: sha('empty'), rows: rowsOf([OPENING, TOTALS]) }, 'E'), 'OK:%"status": "VALIDATED"%');
expect('empty day: 2 CAPTURED CONTROL rows, no reject reason', `(SELECT format('%s/%s/%s', r.rows_captured, r.rows_invalid, coalesce(r.reject_reason, '-')) FROM fin_import_run r WHERE id = ${RES('E')}::uuid)`, '2/0/-');
expect('malformed CONTROL row (bad amount) → REJECTED INVALID_CONTROL_ROW (0080)',
  service({ sha: sha('bad-control'), rows: rowsOf([{ ...OPENING, BALANCE_AMOUNT: '1.000,00' }, TOTALS]) }, 'BC'), 'OK:%"status": "REJECTED"%');
expect('malformed CONTROL row note', `(SELECT outcome || ':' || split_part(note, ':', 1) FROM fin_import_run_line WHERE run_id = ${RES('BC')}::uuid AND row_number = 1)`, 'INVALID:INVALID_CONTROL_ROW');

// ── 6. file-level rejection (Edge parser) ────────────────────────────────────
expect('file-level reject → REJECTED run, format NULL, zero appearances',
  service({ sha: sha('file'), format: null, rows: null, reject: 'HEADER_MISMATCH: missing [PURCHASE_ID] unexpected []' }, 'F'), 'OK:%"status": "REJECTED"%');
expect('file-level run fields', `(SELECT format('%s|%s|%s', format_code IS NULL, reject_reason, (SELECT count(*) FROM fin_import_run_line WHERE run_id = r.id)) FROM fin_import_run r WHERE id = ${RES('F')}::uuid)`,
  't|HEADER_MISMATCH: missing [PURCHASE_ID] unexpected []|0');
expect('file-level replay', service({ sha: sha('file'), format: null, rows: null, reject: 'HEADER_MISMATCH: x' }), 'OK:%"replayed": true%');

// ── 7. immutability ──────────────────────────────────────────────────────────
expect('a VALIDATED run cannot be updated', `pg_temp.err_of('UPDATE fin_import_run SET reject_reason = ''x'' WHERE id = ''' || ${RES('R1')} || '''')`, 'ERR:FIN_EVIDENCE_IMMUTABLE%');
expect('a captured appearance cannot be deleted', `pg_temp.err_of('DELETE FROM fin_import_run_line WHERE run_id = ''' || ${RES('R1')} || '''')`, 'ERR:FIN_EVIDENCE_IMMUTABLE%');

// ── 8. ZERO FINANCIAL EFFECT ─────────────────────────────────────────────────
for (const t of FIN_TABLES) {
  expect(`zero financial effect: Δ ${t} = 0`,
    `(SELECT ((SELECT count(*) FROM ${t}) - b.n)::text FROM before_counts b WHERE b.t = ${lit(t)})`, '0');
}
expect('no audit / MP queue entry referencing the captured runs',
  `(SELECT count(*)::text FROM mp_webhook_delivery WHERE origin = 'report_backfill')`, '0');

// ── 9. perimeter ─────────────────────────────────────────────────────────────
expect('SECURITY DEFINER set = 78 (0079 NORMAL ingest + back-fill, 0081 scheduler log, 0083 payout destinations)', `(SELECT count(*)::text FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace)`, '78');
expect('capture function: definer, owner postgres, search_path=public, single overload',
  `(SELECT string_agg(prosecdef || ':' || pg_get_userbyid(proowner) || ':' || (coalesce(proconfig, '{}') @> ARRAY['search_path=public']), ',') FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace AND proname = 'fin_capture_mp_release_report')`, 'true:postgres:true');
expect('EXECUTE: service_role only, no PUBLIC / anon / authenticated',
  `(SELECT has_function_privilege('anon', oid, 'EXECUTE') || ':' || has_function_privilege('authenticated', oid, 'EXECUTE') || ':' || has_function_privilege('service_role', oid, 'EXECUTE')
      || ':' || NOT EXISTS (SELECT 1 FROM aclexplode(proacl) a WHERE a.grantee = 0)
     FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'fin_capture_mp_release_report')`, 'false:false:true:true');
expect('bucket financial-statements: private, 10 MB, pdf + csv',
  `(SELECT public || ':' || file_size_limit || ':' || array_to_string(allowed_mime_types, ',') FROM storage.buckets WHERE id = 'financial-statements')`, 'false:10485760:application/pdf,text/csv');
expect('bucket policies unchanged: one ADMIN SELECT policy',
  `(SELECT string_agg(policyname || ':' || cmd, ',') FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND qual ~ 'financial-statements')`, 'financial_statements_admin_select:SELECT');
expect('cron jobs: the worker + the 0082 daily report job only', `(SELECT string_agg(jobname, ',' ORDER BY jobname) FROM cron.job)`, 'mp_release_report_daily,mp_worker_every_minute');
expect('mp_parse_report_row, RPC 40 and mp_register_delivery untouched: no MP function references the capture',
  `(SELECT count(*)::text FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'mp\\_%' AND prosrc ~ 'fin_capture_mp_release_report')`, '0');

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
console.log(`\n  ══ ADR-018 0078 RESULT: ${pass} passed, ${fail} failed ══\n`);
process.exit(fail === 0 ? 0 : 1);
