#!/usr/bin/env node
/**
 * ADR-018 §9.1 — MP DAILY RELEASE REPORT SUPPORT (migration 0081). LOCAL TEST DATABASE ONLY.
 *
 * Covers: fin_ingest_mp_release_report with actor NULL (the scheduler; created_by NULL) while a non-NULL actor must still
 * be an active ADMIN; the daily report after the webhook and before it (one back-fill per payment, never money from the
 * report itself); re-execution of the same day (replay) and a re-downloaded report (no new back-fill);
 * fin_mp_report_schedule_log + fin_record_mp_report_schedule (outcomes, constraints, counters-only summary, run of the
 * target day, immutability, RLS and privileges); the activation migration 0082 (re-run inside the rolled-back transaction)
 * executed inside the rolled-back transaction (one job upserted by name, mp_worker_every_minute unchanged), and that
 * nothing is scheduled by the migration; zero bank / financial effect; mp_v4_verified() still false.
 *
 * Everything runs inside ONE transaction that is rolled back. Synthetic data only.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *     node scripts/target-db/fin_mp_report_daily.test.mjs
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
const ADMIN = 'aaaaaaaa-0081-0000-0000-00000000000a';
const OPER = 'aaaaaaaa-0081-0000-0000-00000000000b';
const MPACC = `(SELECT id FROM financial_account WHERE nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE')`;
const sha = (seed) => createHash('sha256').update(`ADR018-0081-${seed}`).digest('hex');
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
  mv('08:00:00', '810000000001', 'payment', '8946.00', '0.00', '9000.00', '-54.00', '9946.00', 'cvu', 'bank_transfer'),
  mv('09:00:00', '810000000002', 'payment', '0.00', '500.00', '-500.00', '0.00', '9446.00'),
  mv('10:00:00', '810000000003', 'asset_management', '12.34', '0.00', '12.34', '0.00', '9458.34', '', ''),
  mv('11:00:00', '810000000004', 'reserve_for_payout', '0.00', '200.00', '-200.00', '0.00', '9258.34', 'available_money', ''),
  mv('11:00:01', '810000000004', 'reserve_for_payout', '200.00', '0.00', '200.00', '0.00', '9458.34', 'available_money', ''),
  mv('11:00:01', '810000000004', 'payout', '0.00', '200.00', '-200.00', '0.00', '9258.34', 'available_money', ''),
  mv('12:00:00', '810000000005', 'reserve_for_payment', '0.00', '10.00', '-10.00', '0.00', '9248.34'),
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
  ('${ADMIN}', 'adr018-0081-admin@test.local', 'ADMIN'),
  ('${OPER}',  'adr018-0081-oper@test.local',  'OPERATOR');
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
  mv('08:00:00', '810000000001', 'payment', '8946.00', '0.00', '9000.00', '-54.00', '9946.00', 'cvu', 'bank_transfer'),
  mv('09:00:00', '810000000002', 'payment', '0.00', '500.00', '-500.00', '0.00', '9446.00'),
  mv('11:00:00', '810000000004', 'reserve_for_payout', '0.00', '200.00', '-200.00', '0.00', '9246.00', 'available_money', ''),
  mv('11:00:01', '810000000004', 'reserve_for_payout', '200.00', '0.00', '200.00', '0.00', '9446.00', 'available_money', ''),
  mv('11:00:01', '810000000004', 'payout', '0.00', '200.00', '-200.00', '0.00', '9246.00', 'available_money', ''),
  TOT('8246.00', '8300.00', '-54.00'),
];
const D14 = '2026-10-14';
const WEBHOOK_FIRST = [
  CTL(D14),
  { ...mv('08:00:00', '810000000021', 'payment', '79.52', '0.00', '80.00', '-0.48', '1079.52', 'cvu', 'bank_transfer'),
    DATE: `${D14}T08:00:00.000-03:00`, TRANSACTION_APPROVAL_DATE: `${D14}T08:00:00.000-03:00` },
  TOT('79.52', '80.00', '-0.48'),
];

// ── A. actor NULL = the scheduler ───────────────────────────────────────────
expect('A-1 actor NULL (service_role) → PARSED, not a replay',
  NORMAL({ sha: sha('daily'), actor: null, rows: rowsOf(DAILY) }, 'A'), 'OK:%"status": "PARSED"%"replayed": false%');
expect('A-2 run created_by NULL, NORMAL, coverage = the target day',
  runOf('A', `(r.created_by IS NULL)::text || '|' || r.mode || '|' || r.coverage_from || '|' || r.coverage_to`), `true|NORMAL|${DAY}|${DAY}`);
expect('A-3 exactly one back-fill (inbound payment only), key report:payment:<SOURCE_ID>',
  `(${backfills('810000000001')} || '|' || ${backfills('810000000002')} || '|' || (SELECT string_agg(delivery_key, ',') FROM mp_webhook_delivery WHERE resource_id = '810000000001'))`,
  '1|0|report:payment:810000000001');
expect('A-4 a non-NULL actor must still be an active ADMIN (OPERATOR refused)',
  NORMAL({ sha: sha('daily-oper'), actor: OPER, rows: rowsOf(DAILY) }), 'ERR:FORBIDDEN%');
expect('A-5 an unknown actor is refused', NORMAL({ sha: sha('daily-ghost'), actor: 'aaaaaaaa-0081-0000-0000-0000000000ff', rows: rowsOf(DAILY) }), 'ERR:FORBIDDEN%');
expect('A-6 an ADMIN actor is still accepted (manual capture unchanged), created_by = the ADMIN',
  NORMAL({ sha: sha('daily-admin'), actor: ADMIN, day: '2026-10-12', rows: rowsOf([CTL('2026-10-12'), TOT('0.00', '0.00', '0.00')]) }, 'A6'), 'OK:%"status": "PARSED"%');
expect('A-7 created_by of the ADMIN run', runOf('A6', `(r.created_by = '${ADMIN}')::text`), 'true');
expect('A-8 authenticated callers cannot execute the ingestion',
  as('authenticated', ADMIN, captureCall({ fn: 'fin_ingest_mp_release_report', sha: sha('daily-auth'), actor: null, rows: rowsOf(DAILY) })), 'ERR:permission denied%');

// ── B. same day again / re-downloaded report ────────────────────────────────
expect('B-1 the same bytes again (second daily execution) → replay', NORMAL({ sha: sha('daily'), actor: null, rows: rowsOf(DAILY) }, 'B1'), 'OK:%"replayed": true%');
expect('B-2 the replay returns the first run id; still one back-fill', `((${RES('B1')} = ${RES('A')})::text || '|' || ${backfills('810000000001')})`, 'true|1');
expect('B-3 a re-downloaded report of the same day (other bytes) → PARSED, no back-fill created',
  NORMAL({ sha: sha('daily-redownload'), actor: null, rows: rowsOf(DAILY) }, 'B3'), 'OK:%"status": "PARSED"%"backfills_created": 0%');
expect('B-4 still exactly one back-fill delivery for the payment', backfills('810000000001'), '1');

// ── C. webhook first, daily report later ────────────────────────────────────
expect('C-1 webhook delivery queued first',
  as('service_role', null, `SELECT mp_register_delivery('webhook', 'payment', 'payment', 'payment.updated', '810000000021', NULL, 'T0081', '{"notification_id":"t0081-1"}'::jsonb, true)::text`), 'OK:%');
expect('C-2 daily report including that payment → PARSED',
  NORMAL({ sha: sha('daily-webhook-first'), actor: null, day: D14, rows: rowsOf(WEBHOOK_FIRST) }, 'C'), 'OK:%"status": "PARSED"%');
expect('C-3 one webhook delivery and at most one back-fill (the worker lets exactly one claim through: fin_mp_report_normal G)',
  `(SELECT (count(*) FILTER (WHERE origin = 'report_backfill') <= 1 AND count(*) FILTER (WHERE origin = 'webhook') = 1)::text FROM mp_webhook_delivery WHERE resource_id = '810000000021')`, 'true');

// ── D. the report never creates money or bank effects by itself ─────────────
for (const t of ['financial_operation', 'financial_posting', 'mp_reconciliation', 'fin_statement_line']) {
  expect(`D zero money / bank effect from the daily report: Δ ${t} = 0`, `(SELECT ((SELECT count(*) FROM ${t}) - b.n)::text FROM before_counts b WHERE b.t = ${lit(t)})`, '0');
}
expect('D the payout is only an unapplied transfer movement (0079 design: waits for the ADMIN), never reconciled',
  `(SELECT count(*) || ':' || string_agg(m.movement_kind, ',') || ':' || bool_and(NOT EXISTS (SELECT 1 FROM mp_reconciliation r WHERE r.mp_financial_movement_id = m.id))
     FROM mp_financial_movement m JOIN mp_source_record s ON s.id = m.mp_source_record_id WHERE s.external_id LIKE '810000000%')`, '1:transfer:true');

// ── E. scheduler log ────────────────────────────────────────────────────────
const rec = (role, uid, args) => as(role, uid, `SELECT fin_record_mp_report_schedule(${args})::text`);
const RUNA = P(RES('A'));
const SUM = '{"rows": 7, "control": 2, "payments_in": 1, "payments_out": 1, "payouts": 1, "reserves": 2, "backfills_created": 1}';
const OKREC = (outcome, run, err = 'NULL', summary = SUM) => `'${DAY}'::date, '${outcome}', ${run}, '777', ${err}, '${summary}'::jsonb`;
expect('E-1 SUCCESS with the run of the day', rec('service_role', null, OKREC('SUCCESS', `${RUNA}::uuid`)), 'OK:%');
expect('E-2 SUCCESS_EMPTY and ALREADY_PROCESSED accepted',
  `(${rec('service_role', null, OKREC('SUCCESS_EMPTY', `${RUNA}::uuid`, 'NULL', '{}'))} || ${rec('service_role', null, OKREC('ALREADY_PROCESSED', `${RUNA}::uuid`, 'NULL', '{}'))})`, 'OK:%OK:%');
expect('E-3 FAILED with error code and task id, no run', rec('service_role', null, `'${DAY}'::date, 'FAILED', NULL, '777', 'MP_TASK_TIMEOUT', '{}'::jsonb`), 'OK:%');
expect('E-4 FAILED without an error code refused', rec('service_role', null, `'${DAY}'::date, 'FAILED', NULL, NULL, NULL, '{}'::jsonb`), 'ERR:INVALID_SCHEDULE_RECORD%');
expect('E-5 SUCCESS without a run refused', rec('service_role', null, OKREC('SUCCESS', 'NULL')), 'ERR:INVALID_SCHEDULE_RECORD%');
expect('E-6 SUCCESS with an error code refused', rec('service_role', null, OKREC('SUCCESS', `${RUNA}::uuid`, `'X'`)), 'ERR:INVALID_SCHEDULE_RECORD%');
expect('E-7 unknown outcome refused', rec('service_role', null, OKREC('PARTIAL', `${RUNA}::uuid`)), 'ERR:INVALID_SCHEDULE_RECORD%');
expect('E-8 a run of another day refused', rec('service_role', null, `'2026-10-12'::date, 'SUCCESS', ${RUNA}::uuid, NULL, NULL, '{}'::jsonb`), 'ERR:RUN_MISMATCH%');
expect('E-9 non-numeric task id refused', rec('service_role', null, `'${DAY}'::date, 'FAILED', NULL, 'abc', 'X', '{}'::jsonb`), 'ERR:INVALID_SCHEDULE_RECORD%');
expect('E-10 summary: unknown key refused (counters only, no report content)', rec('service_role', null, OKREC('SUCCESS', `${RUNA}::uuid`, 'NULL', '{"payer": 1}')), 'ERR:INVALID_SUMMARY%');
expect('E-11 summary: negative / fractional / text values refused',
  `(${rec('service_role', null, OKREC('SUCCESS', `${RUNA}::uuid`, 'NULL', '{"rows": -1}'))} || ${rec('service_role', null, OKREC('SUCCESS', `${RUNA}::uuid`, 'NULL', '{"rows": 1.5}'))}
    || ${rec('service_role', null, OKREC('SUCCESS', `${RUNA}::uuid`, 'NULL', '{"rows": "1"}'))})`,
  'ERR:INVALID_SUMMARY%ERR:INVALID_SUMMARY%ERR:INVALID_SUMMARY%');
expect('E-12 an authenticated ADMIN and anon cannot record',
  `(${rec('authenticated', ADMIN, OKREC('SUCCESS', `${RUNA}::uuid`))} || ${rec('anon', null, OKREC('SUCCESS', `${RUNA}::uuid`))})`, 'ERR:permission denied%ERR:permission denied%');
expect('E-13 four rows recorded for the day', `(SELECT count(*)::text FROM fin_mp_report_schedule_log WHERE target_date = '${DAY}')`, '4');
expect('E-14 rows are immutable (UPDATE and DELETE refused, even for the owner)',
  `(pg_temp.err_of('UPDATE fin_mp_report_schedule_log SET error_code = ''Y'' WHERE outcome = ''FAILED''') || '|' || pg_temp.err_of('DELETE FROM fin_mp_report_schedule_log'))`, 'ERR:%|ERR:%');
const ins = `INSERT INTO fin_mp_report_schedule_log (target_date, outcome, error_code) VALUES ('${DAY}', 'FAILED', 'X') RETURNING id::text`;
expect('E-15 direct INSERT refused for service_role and authenticated',
  `(${as('service_role', null, ins)} || ${as('authenticated', ADMIN, ins)})`, 'ERR:permission denied%ERR:permission denied%');
const cnt = 'SELECT count(*)::text FROM fin_mp_report_schedule_log';
expect('E-16 SELECT: ADMIN 4, service_role 4, OPERATOR 0, anon refused',
  `(${as('authenticated', ADMIN, cnt)} || '|' || ${as('service_role', null, cnt)} || '|' || ${as('authenticated', OPER, cnt)} || '|' || ${as('anon', null, cnt)})`,
  'OK:4|OK:4|OK:0|ERR:permission denied%');
expect('E-17 the latest record of the day (read by the scheduler to resume a timed-out task)',
  `(SELECT outcome || ':' || coalesce(task_id, '-') || ':' || coalesce(error_code, '-') FROM fin_mp_report_schedule_log WHERE target_date = '${DAY}' ORDER BY id DESC LIMIT 1)`,
  'FAILED:777:MP_TASK_TIMEOUT');
// 0085: PENDING = MP accepted the task and is still preparing it (task kept, no run, reason MP_TASK_PREPARING)
const PEND = (task, run, err) => rec('service_role', null, `'${DAY}'::date, 'PENDING', ${run}, ${task}, ${err}, '{}'::jsonb`);
expect('E-18 PENDING with task id, no run, reason MP_TASK_PREPARING → accepted', PEND(`'777'`, 'NULL', `'MP_TASK_PREPARING'`), 'OK:%');
expect('E-19 PENDING without a task / with a run / with another reason / without a reason → refused',
  `(${PEND('NULL', 'NULL', `'MP_TASK_PREPARING'`)} || ${PEND(`'777'`, `${RUNA}::uuid`, `'MP_TASK_PREPARING'`)} || ${PEND(`'777'`, 'NULL', `'MP_TASK_TIMEOUT'`)} || ${PEND(`'777'`, 'NULL', 'NULL')})`,
  'ERR:INVALID_SCHEDULE_RECORD%ERR:INVALID_SCHEDULE_RECORD%ERR:INVALID_SCHEDULE_RECORD%ERR:INVALID_SCHEDULE_RECORD%');
expect('E-20 the latest record with a task is now the PENDING one (what the next slot resumes)',
  `(SELECT outcome || ':' || task_id || ':' || error_code FROM fin_mp_report_schedule_log WHERE target_date = '${DAY}' AND task_id IS NOT NULL ORDER BY id DESC LIMIT 1)`,
  'PENDING:777:MP_TASK_PREPARING');

// ── F. scheduling: nothing scheduled by 0081; 0082 activation; 0085 morning retry slots ─
expect('F-0 after 0085: daily job every 15 min 07:00–07:45 BA, fallback job 08:00 + 11:00 BA with the SAME command; 3 jobs in all',
  `((SELECT schedule FROM cron.job WHERE jobname = 'mp_release_report_daily') || '|' || (SELECT schedule FROM cron.job WHERE jobname = 'mp_release_report_daily_fallback')
    || '|' || ((SELECT command FROM cron.job WHERE jobname = 'mp_release_report_daily') = (SELECT command FROM cron.job WHERE jobname = 'mp_release_report_daily_fallback'))::text
    || '|' || (SELECT count(*) FROM cron.job) || '|' || (SELECT bool_and(active) FROM cron.job))`, '0,15,30,45 10 * * *|0 11,14 * * *|true|3|true');
expect('F-1 after 0082: exactly one mp_release_report_daily job (0081 itself scheduled nothing)', `(SELECT count(*)::text FROM cron.job WHERE jobname = 'mp_release_report_daily')`, '1');
const ACTIVATION = readFileSync(new URL('../../supabase/target-migrations/0082_mp_report_daily_schedule.sql', import.meta.url), 'utf8');
add(ACTIVATION);
add(ACTIVATION);   // cron.schedule upserts by name: twice → still one job
expect('F-2 activation: exactly one daily job at 10:00 and 14:00 UTC (07:00 / 11:00 Buenos Aires), active',
  `(SELECT count(*) || '|' || min(schedule) || '|' || bool_and(active) FROM cron.job WHERE jobname = 'mp_release_report_daily')`, '1|0 10,14 * * *|true');
expect('F-3 the job posts to mp-report-daily from the existing Vault URL and invoke secret, 150 s timeout',
  `(SELECT (command LIKE '%replace(u.decrypted_secret, ''/functions/v1/mp-worker'', ''/functions/v1/mp-report-daily'')%'
        AND command LIKE '%x-worker-invoke-secret%' AND command LIKE '%mp_worker_invoke_secret%' AND command LIKE '%150000%')::text
     FROM cron.job WHERE jobname = 'mp_release_report_daily')`, 'true');
expect('F-4 mp_worker_every_minute unchanged; no other job added',
  `((SELECT string_agg(jobname || schedule || command || active, ',' ORDER BY jobid) FROM cron.job WHERE jobname <> 'mp_release_report_daily')
     = (SELECT string_agg(jobname || schedule || command || active, ',' ORDER BY jobid) FROM before_jobs WHERE jobname <> 'mp_release_report_daily'))::text`, 'true');
expect('F-6 re-running 0082 keeps the same daily job (same jobid and command; upsert by name — it would reset the schedule, hence never re-run after 0085)',
  `((SELECT jobid || command FROM cron.job WHERE jobname = 'mp_release_report_daily') = (SELECT jobid || command FROM before_jobs WHERE jobname = 'mp_release_report_daily'))::text`, 'true');
expect('F-5 the URL derivation maps the worker endpoint to the daily endpoint',
  `replace('https://x.supabase.co/functions/v1/mp-worker', '/functions/v1/mp-worker', '/functions/v1/mp-report-daily')`, 'https://x.supabase.co/functions/v1/mp-report-daily');

// ── G. perimeter ─────────────────────────────────────────────────────────────
expect('G-1 SECURITY DEFINER set = 79 (76 + fin_record_mp_report_schedule + 0083 fin_record_mp_payout_destinations + 0084 fin_mp_payout_matches)', `(SELECT count(*)::text FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace)`, '79');
expect('G-2 fin_record_mp_report_schedule: DEFINER, owner postgres, EXECUTE service_role only',
  `(SELECT prosecdef || ':' || pg_get_userbyid(proowner) || ':' || has_function_privilege('anon', oid, 'EXECUTE') || has_function_privilege('authenticated', oid, 'EXECUTE')
      || has_function_privilege('service_role', oid, 'EXECUTE') FROM pg_proc WHERE proname = 'fin_record_mp_report_schedule')`, 'true:postgres:falsefalsetrue');
expect('G-3 schedule log: RLS on, no write privilege for any API role, anon cannot read',
  `((SELECT relrowsecurity FROM pg_class WHERE relname = 'fin_mp_report_schedule_log')
     AND NOT has_table_privilege('authenticated', 'fin_mp_report_schedule_log', 'INSERT,UPDATE,DELETE,TRUNCATE')
     AND NOT has_table_privilege('service_role', 'fin_mp_report_schedule_log', 'INSERT,UPDATE,DELETE,TRUNCATE')
     AND NOT has_table_privilege('anon', 'fin_mp_report_schedule_log', 'SELECT,INSERT,UPDATE,DELETE'))::text`, 'true');
expect('G-4 report functions keep service_role-only EXECUTE',
  `(SELECT string_agg(proname || ':' || has_function_privilege('authenticated', oid, 'EXECUTE') || has_function_privilege('service_role', oid, 'EXECUTE'), ',' ORDER BY proname)
     FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('fin_capture_mp_release_report', 'fin_ingest_mp_release_report'))`,
  'fin_capture_mp_release_report:falsetrue,fin_ingest_mp_release_report:falsetrue');
expect('G-5 mp_v4_verified() still false', '(SELECT mp_v4_verified()::text)', 'false');

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
console.log(`\n  ══ ADR-018 0081 DAILY REPORT SUPPORT RESULT: ${pass} passed, ${fail} failed ══\n`);
process.exit(fail === 0 ? 0 : 1);
