#!/usr/bin/env node
/**
 * ADR-018 §9.3 — MP PAYOUT DESTINATION PRIVATE STORAGE (migration 0083, parser 1.2.0). LOCAL TEST DATABASE ONLY.
 *
 * Covers fin_record_mp_payout_destinations + fin_mp_payout_destination: service_role only; the run must be an MP report run
 * and every row an appearance of it; original kept, normalization minimal (trim, inner whitespace removed), class
 * UNVERIFIED; idempotent replay; a different value for the same appearance refused; malformed items / values refused
 * without echoing the value; immutable; private (no SELECT for anon / authenticated / ADMIN, service_role only); the
 * ingestion rows and the D1 identity unchanged; zero financial effect; SECURITY DEFINER 78; cron unchanged.
 *
 * Everything runs inside ONE transaction that is rolled back. Synthetic data only.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *     node scripts/target-db/fin_mp_payout_destination.test.mjs
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
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
const ADMIN = 'aaaaaaaa-0083-0000-0000-00000000000a';
const OPER = 'aaaaaaaa-0083-0000-0000-00000000000b';
const MPACC = `(SELECT id FROM financial_account WHERE nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE')`;
const sha = (seed) => createHash('sha256').update(`ADR018-0083-${seed}`).digest('hex');
const RES = (key, path = 'run_id') => `(SELECT v ->> '${path}' FROM res WHERE k = '${key}')`;
const P = (expr) => `{{${expr}}}`;   // resolved by run_as as the owner, before the role switch
const PARSER = 'mp-release-report-csv/1.1.0';
const DAY = '2026-10-13';
const FORMAT = 'MP_RELEASE_REPORT_CSV_V1';

const sql = [];
const add = (s) => sql.push(s);
const expect = (name, got, like) => add(`SELECT pg_temp.expect(${lit(name)}, ${got}, ${lit(like)});`);

// ── synthetic Liberaciones rows (ADR-003 D1: 15 keys, every value the exported string) ─────────────────────────
const EMPTY = { BALANCE_AMOUNT: '', BUSINESS_UNIT: '', DATE: '', DESCRIPTION: '', GROSS_AMOUNT: '', MP_FEE_AMOUNT: '',
  NET_CREDIT_AMOUNT: '', NET_DEBIT_AMOUNT: '', PAYMENT_METHOD: '', PAYMENT_METHOD_TYPE: '', PURCHASE_ID: '', SOURCE_ID: '',
  SUB_UNIT: '', TAXES_AMOUNT: '', TRANSACTION_APPROVAL_DATE: '' };
const mv = (t, sid, desc, credit, debit, gross, tax, bal, method = 'available_money', type = 'account_money') => ({
  ...EMPTY, DATE: `2026-10-13T${t}.000-03:00`, SOURCE_ID: sid, DESCRIPTION: desc, NET_CREDIT_AMOUNT: credit, NET_DEBIT_AMOUNT: debit,
  GROSS_AMOUNT: gross, MP_FEE_AMOUNT: '0.00', TAXES_AMOUNT: tax, PAYMENT_METHOD: method, TRANSACTION_APPROVAL_DATE: `2026-10-13T${t}.000-03:00`,
  BALANCE_AMOUNT: bal, PAYMENT_METHOD_TYPE: type });
const OPENING = { ...EMPTY, DATE: '2026-10-13T00:00:00.000-03:00', NET_CREDIT_AMOUNT: '1000.00', NET_DEBIT_AMOUNT: '0.00',
  GROSS_AMOUNT: '1000.00', MP_FEE_AMOUNT: '0.00', TAXES_AMOUNT: '0.00', BALANCE_AMOUNT: '1000.00' };
const TOTALS = { ...EMPTY, NET_CREDIT_AMOUNT: '9941.00', NET_DEBIT_AMOUNT: '0.00', GROSS_AMOUNT: '10000.00', MP_FEE_AMOUNT: '0.00',
  TAXES_AMOUNT: '-59.00', BALANCE_AMOUNT: '0.00' };
const GOOD = [
  OPENING,
  mv('08:00:00', '830000000001', 'payment', '8946.00', '0.00', '9000.00', '-54.00', '9946.00', 'cvu', 'bank_transfer'),
  mv('09:00:00', '830000000002', 'payment', '0.00', '500.00', '-500.00', '0.00', '9446.00'),
  mv('10:00:00', '830000000003', 'asset_management', '12.34', '0.00', '12.34', '0.00', '9458.34', '', ''),
  mv('11:00:00', '830000000004', 'reserve_for_payout', '0.00', '200.00', '-200.00', '0.00', '9258.34', 'available_money', ''),
  mv('11:00:01', '830000000004', 'reserve_for_payout', '200.00', '0.00', '200.00', '0.00', '9458.34', 'available_money', ''),
  mv('11:00:01', '830000000004', 'payout', '0.00', '200.00', '-200.00', '0.00', '9258.34', 'available_money', ''),
  mv('12:00:00', '830000000005', 'reserve_for_payment', '0.00', '10.00', '-10.00', '0.00', '9248.34'),
  TOTALS,
];
const rowsOf = (raws) => raws.map((raw_row, i) => ({ row_number: i + 1, raw_row }));
const swap = (i, over) => GOOD.map((r, j) => (j === i ? { ...r, ...over } : r));

function captureCall(o) {
  const s = o.sha;
  return `SELECT ${o.fn ?? 'fin_capture_mp_release_report'}(${lit(o.actor === undefined ? ADMIN : o.actor)}::uuid, ${lit(o.parser ?? PARSER)},
    ${lit(o.format === undefined ? FORMAT : o.format)}, ${lit(s)},
    ${o.path === undefined ? P(`'mp/' || ${MPACC} || '/${s}.csv'`) : lit(o.path)}, ${lit(o.file ?? 'release-report.csv')}, 2048,
    ${lit(o.day ?? DAY)}::date, ${lit(o.day ?? DAY)}::date, ${lit(JSON.stringify(o.meta ?? { report_type: 'release_report', task_id: '1' }))}::jsonb,
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
  ('${ADMIN}', 'adr018-0083-admin@test.local', 'ADMIN'),
  ('${OPER}',  'adr018-0083-oper@test.local',  'OPERATOR');
CREATE TEMP TABLE before_counts AS ${counts()};
CREATE TEMP TABLE before_jobs AS SELECT jobid, jobname, schedule, command, active FROM cron.job;`);

const NORMAL = (o, key = null) => as('service_role', null, captureCall({ ...o, fn: 'fin_ingest_mp_release_report' }), key);
const runOf = (key, cols) => `(SELECT ${cols} FROM fin_import_run r WHERE r.id = ${RES(key)}::uuid)`;
const backfills = (pid) => `(SELECT count(*)::text FROM mp_webhook_delivery WHERE origin = 'report_backfill' AND resource_id = '${pid}')`;
const deliveries = (pid) => `(SELECT count(*)::text FROM mp_webhook_delivery WHERE resource_id = '${pid}')`;
const CTL = (day) => ({ ...GOOD[0], DATE: `${day}T00:00:00.000-03:00` });
const TOT = (credit, gross, tax) => ({ ...GOOD[GOOD.length - 1], NET_CREDIT_AMOUNT: credit, GROSS_AMOUNT: gross, TAXES_AMOUNT: tax });
// a payments day without yields: inbound payment, outbound payment, payout with its reserve pair, control rows
const DAILY = [
  CTL(DAY),
  mv('08:00:00', '830000000001', 'payment', '8946.00', '0.00', '9000.00', '-54.00', '9946.00', 'cvu', 'bank_transfer'),
  mv('09:00:00', '830000000002', 'payment', '0.00', '500.00', '-500.00', '0.00', '9446.00'),
  mv('11:00:00', '830000000004', 'reserve_for_payout', '0.00', '200.00', '-200.00', '0.00', '9246.00', 'available_money', ''),
  mv('11:00:01', '830000000004', 'reserve_for_payout', '200.00', '0.00', '200.00', '0.00', '9446.00', 'available_money', ''),
  mv('11:00:01', '830000000004', 'payout', '0.00', '200.00', '-200.00', '0.00', '9246.00', 'available_money', ''),
  TOT('8246.00', '8300.00', '-54.00'),
];
const D14 = '2026-10-14';
const WEBHOOK_FIRST = [
  CTL(D14),
  { ...mv('08:00:00', '830000000021', 'payment', '79.52', '0.00', '80.00', '-0.48', '1079.52', 'cvu', 'bank_transfer'),
    DATE: `${D14}T08:00:00.000-03:00`, TRANSACTION_APPROVAL_DATE: `${D14}T08:00:00.000-03:00` },
  TOT('79.52', '80.00', '-0.48'),
];

const DEST = '0110999900000099999999';   // synthetic
const recD = (items, run = RES('A')) => as('service_role', null, `SELECT fin_record_mp_payout_destinations(${P(run)}::uuid, ${lit(JSON.stringify(items))}::jsonb)::text`);
const PAYOUT_ROW = DAILY.findIndex((r) => r.DESCRIPTION === 'payout') + 1;
const PAY_ROW = DAILY.findIndex((r) => r.DESCRIPTION === 'payment') + 1;
const NOT_A_RUN = `'00000000-0000-4000-8000-000000000000'`;

// ── A. a run recorded by the unchanged NORMAL ingestion (15-key rows) ───────
expect('A-1 NORMAL ingestion of a payout day → PARSED (rows contract unchanged: exactly {row_number, raw_row})',
  NORMAL({ sha: sha('payout-day'), actor: null, rows: rowsOf(DAILY) }, 'A'), 'OK:%"status": "PARSED"%');
expect('A-2 a row carrying the destination inside the rows is still refused by the frozen contract',
  NORMAL({ sha: sha('payout-day-16'), actor: null, rows: rowsOf(DAILY).map((r) => ({ ...r, payout_destination: DEST })) }), 'ERR:INVALID_ROWS_CONTRACT%');

// ── B. recording ────────────────────────────────────────────────────────────
expect('B-1 service_role records the payout destination → 1', recD([{ row_number: PAYOUT_ROW, value: `  ${DEST} ` }]), 'OK:1');
expect('B-2 stored: original kept, normalized = trimmed, class UNVERIFIED, SOURCE_ID / DESCRIPTION from the appearance',
  `(SELECT (original_value = '  ${DEST} ')::text || '|' || (normalized_value = '${DEST}')::text || '|' || value_class || '|' || source_id || '|' || description
     FROM fin_mp_payout_destination WHERE run_id = ${RES('A')}::uuid AND row_number = ${PAYOUT_ROW})`, 'true|true|UNVERIFIED|830000000004|payout');
expect('B-3 a second appearance recorded', recD([{ row_number: PAY_ROW, value: '0110 9999 0000' }]), 'OK:1');
expect('B-4 inner whitespace removed by the minimal normalization',
  `(SELECT normalized_value FROM fin_mp_payout_destination WHERE run_id = ${RES('A')}::uuid AND row_number = ${PAY_ROW})`, '011099990000');
expect('B-5 replay with the same value → no-op (still 2 rows)',
  `(${recD([{ row_number: PAYOUT_ROW, value: `  ${DEST} ` }])} || '|' || (SELECT count(*) FROM fin_mp_payout_destination WHERE run_id = ${RES('A')}::uuid))`, 'OK:1|2');
expect('B-6 another value for the same appearance → DESTINATION_CONFLICT, value not echoed',
  recD([{ row_number: PAYOUT_ROW, value: '9999999999999999999999' }]), `ERR:DESTINATION_CONFLICT: row ${PAYOUT_ROW} already holds another value`);
expect('B-7 a row that is not an appearance of the run → ROW_MISMATCH', recD([{ row_number: 999, value: DEST }]), 'ERR:ROW_MISMATCH%');
expect('B-8 a run that is not an MP report run → RUN_MISMATCH', recD([{ row_number: 1, value: DEST }], NOT_A_RUN), 'ERR:RUN_MISMATCH%');
expect('B-9 malformed items refused',
  `(${recD([])} || ${recD([{ row_number: 1 }])} || ${recD([{ row_number: '1', value: DEST }])} || ${recD([{ row_number: 1, value: DEST, extra: 1 }])})`,
  'ERR:INVALID_ITEMS%ERR:INVALID_ITEMS%ERR:INVALID_ITEMS%ERR:INVALID_ITEMS%');
const LONG = 'X'.repeat(65);
expect('B-10 blank / control-character / oversized values refused without echoing them',
  `(${recD([{ row_number: 1, value: '   ' }])} || ${recD([{ row_number: 1, value: 'AB\nCD' }])} || ${recD([{ row_number: 1, value: LONG }])})`,
  'ERR:INVALID_VALUE: row 1ERR:INVALID_VALUE: row 1ERR:INVALID_VALUE: row 1');

// ── C. privacy and perimeter ────────────────────────────────────────────────
const callAs = (role, uid) => as(role, uid, `SELECT fin_record_mp_payout_destinations(gen_random_uuid(), '[]'::jsonb)::text`);
expect('C-1 authenticated ADMIN and anon cannot record', `(${callAs('authenticated', ADMIN)} || ${callAs('anon', null)})`, 'ERR:permission denied%ERR:permission denied%');
const cnt = "SELECT count(*)::text FROM fin_mp_payout_destination WHERE source_id LIKE '830000000%'";   // this suite's rows only
expect('C-2 SELECT: ADMIN refused, OPERATOR refused, anon refused, service_role 2',
  `(${as('authenticated', ADMIN, cnt)} || '|' || ${as('authenticated', OPER, cnt)} || '|' || ${as('anon', null, cnt)} || '|' || ${as('service_role', null, cnt)})`,
  'ERR:permission denied%|ERR:permission denied%|ERR:permission denied%|OK:2');
expect('C-3 no write privilege for any API role; RLS on; one policy (service_role SELECT)',
  `((SELECT relrowsecurity FROM pg_class WHERE relname = 'fin_mp_payout_destination')
     AND NOT has_table_privilege('service_role', 'fin_mp_payout_destination', 'INSERT,UPDATE,DELETE,TRUNCATE')
     AND NOT has_table_privilege('authenticated', 'fin_mp_payout_destination', 'SELECT,INSERT,UPDATE,DELETE')
     AND NOT has_table_privilege('anon', 'fin_mp_payout_destination', 'SELECT,INSERT,UPDATE,DELETE')
     AND (SELECT string_agg(policyname, ',') FROM pg_policies WHERE tablename = 'fin_mp_payout_destination') = 'fin_mp_payout_destination_service_select')::text`, 'true');
expect('C-4 immutable (UPDATE / DELETE refused even for the owner)',
  `(pg_temp.err_of('UPDATE fin_mp_payout_destination SET value_class = ''UNVERIFIED''') || '|' || pg_temp.err_of('DELETE FROM fin_mp_payout_destination'))`, 'ERR:%|ERR:%');
expect('C-5 the destination never reaches the ingestion evidence (raw_row, appearance_meta, source_meta, mp_source_record)',
  `((SELECT count(*) FROM fin_import_run_line WHERE raw_row::text LIKE '%${DEST}%' OR appearance_meta::text LIKE '%${DEST}%')
    + (SELECT count(*) FROM fin_import_run WHERE source_meta::text LIKE '%${DEST}%') + (SELECT count(*) FROM mp_source_record WHERE event_data::text LIKE '%${DEST}%'))::text`, '0');
expect('C-6 fin_record_mp_payout_destinations: DEFINER, owner postgres, search_path=public, EXECUTE service_role only',
  `(SELECT prosecdef || ':' || pg_get_userbyid(proowner) || ':' || (proconfig @> ARRAY['search_path=public']) || ':' || has_function_privilege('anon', oid, 'EXECUTE')
      || has_function_privilege('authenticated', oid, 'EXECUTE') || has_function_privilege('service_role', oid, 'EXECUTE') FROM pg_proc WHERE proname = 'fin_record_mp_payout_destinations')`,
  'true:postgres:true:falsefalsetrue');
expect('C-7 SECURITY DEFINER set = 80 (77 + fin_record_mp_payout_destinations + 0084 fin_mp_payout_matches + 0086)', `(SELECT count(*)::text FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace)`, '80');
expect('C-8 ingestion functions unchanged by 0083 (still the 0080 capture / 0081 NORMAL bodies)',
  `(SELECT string_agg(proname || ':' || md5(replace(prosrc, chr(13), '')), ',' ORDER BY proname) FROM pg_proc WHERE proname IN ('fin_capture_mp_release_report', 'fin_ingest_mp_release_report'))`,
  'fin_capture_mp_release_report:ba537f978db607841cbf1e7aeaa6ebcd,fin_ingest_mp_release_report:676607433dcb030dcd4204afc80cb131');

// ── D. no financial effect, nothing scheduled ───────────────────────────────
for (const t of ['financial_operation', 'financial_posting', 'mp_reconciliation', 'fin_statement_line']) {
  expect(`D-1 zero financial / bank effect: Δ ${t} = 0`, `(SELECT ((SELECT count(*) FROM ${t}) - b.n)::text FROM before_counts b WHERE b.t = ${lit(t)})`, '0');
}
expect('D-2 cron jobs unchanged (worker + daily report + fallback)', `(SELECT string_agg(jobname, ',' ORDER BY jobname) FROM cron.job)`, 'mp_release_report_daily,mp_release_report_daily_fallback,mp_worker_every_minute');
expect('D-3 mp_v4_verified() still false', '(SELECT mp_v4_verified()::text)', 'false');

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
console.log(`\n  ══ ADR-018 0083 PAYOUT DESTINATION RESULT: ${pass} passed, ${fail} failed ══\n`);
process.exit(fail === 0 ? 0 : 1);
