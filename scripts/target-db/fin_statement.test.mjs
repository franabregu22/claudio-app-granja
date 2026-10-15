#!/usr/bin/env node
/**
 * ADR-018 — FINANCIAL STATEMENT FUNCTIONS TEST SUITE (migration 0075). LOCAL TEST DATABASE ONLY.
 *
 * Covers fin_norm_description / fin_statement_fingerprint (byte-for-byte parity with a non-authoritative JS
 * reference and node:crypto), fin_import_bank_statement (auth, configuration, idempotency, reprocess chain,
 * NEW / ALREADY_KNOWN, BNA and Patagonia adapter rules, persisted REJECTED runs), fin_match_statement_line,
 * fin_reverse_statement_match, fin_resolve_statement_cutover (K-4, Patagonia same-day ambiguity, supersession),
 * and the privilege / SECURITY DEFINER perimeter.
 *
 * Everything runs inside ONE transaction that is rolled back: runs, lines, appearances, matches and cuts are
 * immutable / append-only, so nothing is ever written to the database. Synthetic data only (tag ADR018-0075);
 * no real statement, account number or CBU is used here — the 0074 configuration seed is read as is.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *     node scripts/target-db/fin_statement.test.mjs
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeDestructiveTarget } from '../test-env/guard.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CASES = JSON.parse(readFileSync(resolve(HERE, 'fixtures', 'adr018-normalization-cases.json'), 'utf8'));

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

// ── non-authoritative JS reference of ADR-018 §7.1 (tests only) ──────────────
function jsNorm(s) {
  const v = s.normalize('NFKD');
  if (/[\x00-\x08\x0E-\x1F\x7F]/.test(v)) throw new Error('DESCRIPTION_CONTROL_CHAR');
  return v.replace(/[^\x00-\x7F]/g, '').replace(/[a-z]/g, (c) => c.toUpperCase())
    .replace(/[\t\n\v\f\r ]+/g, ' ').replace(/^ +| +$/g, '');
}
function jsFingerprint(f) {
  const parts = f.format === 'BNA_MONTHLY_PDF_V1'
    ? [f.value_date, f.description_norm, f.bank_reference ?? '', f.signed_amount, f.running_balance]
    : [f.value_date, f.description_norm, f.bank_reference ?? '', f.fecha_valor ?? '', f.signed_amount, f.running_balance ?? ''];
  return createHash('sha256').update(parts.join('\x1f'), 'utf8').digest('hex');
}

// ── SQL helpers ──────────────────────────────────────────────────────────────
const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const hex = (s) => Buffer.from(s, 'utf8').toString('hex');
const ADMIN = 'aaaaaaaa-0075-0000-0000-00000000000a';
const OPER = 'aaaaaaaa-0075-0000-0000-00000000000b';
const ACC = (name) => `(SELECT id FROM financial_account WHERE nombre = '${name}')`;
const sha = (seed) => createHash('sha256').update(`ADR018-0075-${seed}`).digest('hex');
const RES = (key, path = 'run_id') => `(SELECT v ->> '${path}' FROM res WHERE k = '${key}')`;
const P = (expr) => `{{${expr}}}`;   // resolved by run_as as the owner, before the role switch

const sql = [];
const add = (s) => sql.push(s);
const expect = (name, got, like) => add(`SELECT pg_temp.expect(${lit(name)}, ${got}, ${lit(like)});`);

function importCall(o) {
  return `SELECT fin_import_bank_statement(${lit(o.actor ?? ADMIN)}::uuid, ${P(ACC(o.account ?? 'BNA'))}::uuid, ${lit(o.parser ?? 'bna-v1.0.0')},
    ${lit(o.format === undefined ? 'BNA_MONTHLY_PDF_V1' : o.format)}, ${lit(o.sha)}, ${lit(`bank/acc/${o.sha}.pdf`)}, ${lit(o.file ?? 'statement.pdf')}, 1024,
    ${lit(o.from ?? null)}::date, ${lit(o.to ?? null)}::date, ${o.meta === undefined ? 'NULL' : `${lit(JSON.stringify(o.meta))}::jsonb`},
    ${o.prev ? P(o.prev) : 'NULL'}::uuid, ${lit(o.reject ?? null)}, ${o.rows === undefined ? 'NULL' : `${lit(JSON.stringify(o.rows))}::jsonb`})::text`;
}
// run as role; the result (OK:<json> | ERR:<message>) is stored under key
const as = (role, uid, call, key = null) =>
  `pg_temp.run_as(${lit(role)}, ${lit(uid)}, ${lit(call)}, ${lit(key)})`;
const service = (o, key = null) => as('service_role', null, importCall(o), key);
const admin = (call, key = null) => as('authenticated', ADMIN, `SELECT ${call}::text`, key);

// ── prelude ──────────────────────────────────────────────────────────────────
add(`\\set ON_ERROR_STOP 1
BEGIN;
CREATE TEMP TABLE res (k TEXT PRIMARY KEY, v JSONB);
CREATE FUNCTION pg_temp.run_as(p_role TEXT, p_uid TEXT, p_sql TEXT, p_key TEXT) RETURNS TEXT LANGUAGE plpgsql AS $f$
DECLARE v TEXT; msg TEXT; ok BOOLEAN := false; e TEXT; val TEXT;
BEGIN
  -- {{expr}} placeholders are evaluated as the owner BEFORE switching role and inlined as literals,
  -- so the probed role only ever executes the function call itself
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
  ('${ADMIN}', 'adr018-0075-admin@test.local', 'ADMIN'),
  ('${OPER}',  'adr018-0075-oper@test.local',  'OPERATOR');`);

// ── 1. helpers: parity JS ↔ PostgreSQL ───────────────────────────────────────
for (const c of CASES.description_norm) {
  const pg = `pg_temp.err_of('SELECT 1') || ':' || coalesce((SELECT fin_norm_description(convert_from(decode('${hex(c.input)}', 'hex'), 'UTF8'))), '<null>')`;
  if (c.error) {
    let jsErr = null;
    try { jsNorm(c.input); } catch (e) { jsErr = e.message; }
    if (jsErr !== c.error) add(`SELECT pg_temp.expect(${lit(`JS norm ${c.label}`)}, ${lit(String(jsErr))}, ${lit(c.error)});`);
    expect(`PG norm rejects ${c.label}`, `pg_temp.err_of('SELECT fin_norm_description(convert_from(decode(''${hex(c.input)}'', ''hex''), ''UTF8''))')`, `ERR:${c.error}%`);
  } else {
    const js = jsNorm(c.input);
    add(`SELECT pg_temp.expect(${lit(`JS norm ${c.label}`)}, ${lit(hex(js))}, ${lit(hex(c.expected))});`);
    expect(`PG norm ${c.label} (byte-for-byte)`,
      `encode(convert_to(fin_norm_description(convert_from(decode('${hex(c.input)}', 'hex'), 'UTF8')), 'UTF8'), 'hex')`, hex(c.expected));
    void pg;
  }
}
for (const f of CASES.fingerprint) {
  const want = jsFingerprint(f);
  expect(`fingerprint parity ${f.label}`,
    `fin_statement_fingerprint(${lit(f.format)}, ${lit(f.value_date)}::date, ${lit(f.description_norm)}, ${lit(f.bank_reference)},
       ${lit(f.fecha_valor)}::date, ${lit(f.signed_amount)}::numeric, ${lit(f.running_balance)}::numeric)`, want);
}
expect('fingerprint unknown format fails closed', `pg_temp.err_of('SELECT fin_statement_fingerprint(''BNA_CSV_V1'', ''2026-01-01'', ''X'', '''', NULL, 1, 1)')`, 'ERR:FINGERPRINT_UNKNOWN_FORMAT%');
expect('fingerprint BNA requires balance', `pg_temp.err_of('SELECT fin_statement_fingerprint(''BNA_MONTHLY_PDF_V1'', ''2026-01-01'', ''X'', '''', NULL, 1, NULL)')`, 'ERR:FINGERPRINT_BALANCE_REQUIRED%');
expect('format_code is not hashed (same fields, both formats differ only by layout)',
  `(fin_statement_fingerprint('PATAGONIA_STATEMENT_PDF_V1', '2026-01-02', 'X', '', NULL, 0.50, NULL))`,
  jsFingerprint({ format: 'PATAGONIA_STATEMENT_PDF_V1', value_date: '2026-01-02', description_norm: 'X', bank_reference: '', fecha_valor: null, signed_amount: '0.50', running_balance: null }));

// ── 2. import: BNA ───────────────────────────────────────────────────────────
const bnaMeta = (o, c) => ({ opening_balance: o, closing_balance: c, period: '31/07/2026 AL 31/08/2026' });
const ctl = (n, type, balance) => ({ row_number: n, kind: 'CONTROL', control_type: type, balance, raw_row: { text: type } });
const eco = (n, pos, date, desc, ref, amt, bal, extra = {}) => ({
  row_number: n, kind: 'ECONOMIC', statement_position: pos, value_date: date, description_raw: desc, bank_reference: ref,
  signed_amount: amt, running_balance: bal, raw_row: { text: `${date} ${desc} ${ref} ${amt} ${bal}` }, appearance_meta: { page: 1, physical_row: n }, ...extra });
const BNA_A = [
  ctl(1, 'SALDO_ANTERIOR', '1000.00'),
  eco(2, 1, '2026-08-04', 'GRAVAMEN LEY 25413 S/DEB', '21', '-240.00', '760.00'),
  eco(3, 2, '2026-08-04', 'Gravámen  ley 25413 s/cred', '21', '-1.44', '758.56'),
  ctl(4, 'TRANSPORTE', '758.56'),
  eco(5, 3, '2026-08-05', 'DEBIN 30000000000', '412', '100.00', '858.56'),
  ctl(6, 'SALDO_FINAL', '858.56'),
];
const AUG = { from: '2026-07-31', to: '2026-08-31' };
const A = { sha: sha('A'), ...AUG, meta: bnaMeta('1000.00', '858.56'), rows: BNA_A };

expect('anon cannot execute import', as('anon', null, importCall(A)), 'ERR:permission denied for function%');
expect('authenticated ADMIN cannot execute import directly', as('authenticated', ADMIN, importCall(A)), 'ERR:permission denied for function%');
expect('service_role with OPERATOR actor refused', service({ ...A, actor: OPER }), 'ERR:FORBIDDEN%');
expect('service_role with unknown actor refused', service({ ...A, actor: 'aaaaaaaa-0075-0000-0000-0000000000ff' }), 'ERR:FORBIDDEN%');
expect('non-bank account refused', service({ ...A, account: 'Caja chica' }), 'ERR:ACCOUNT_NOT_FOUND_OR_NOT_BANK%');
expect('format of another adapter refused', service({ ...A, format: 'PATAGONIA_STATEMENT_PDF_V1' }), 'ERR:FORMAT_NOT_ALLOWED_FOR_ACCOUNT%');
add(`UPDATE fin_statement_account_config SET activo = false WHERE financial_account_id = ${ACC('BNA')};`);
expect('inactive configuration refused', service(A), 'ERR:STATEMENT_CONFIG_MISSING%');
add(`UPDATE fin_statement_account_config SET activo = true WHERE financial_account_id = ${ACC('BNA')};`);
expect('previous_run_id without an earlier attempt refused', service({ ...A, prev: `'00000000-0000-0000-0000-000000000001'` }), 'ERR:PREVIOUS_RUN_INVALID%');
expect('caller-supplied description_norm refused', service({ ...A, rows: [ { ...BNA_A[1], description_norm: 'X' } ] }), 'ERR:INVALID_ROWS_CONTRACT%');
expect('caller-supplied fingerprint refused', service({ ...A, rows: [ { ...BNA_A[1], fingerprint: 'a'.repeat(64) } ] }), 'ERR:INVALID_ROWS_CONTRACT%');
expect('duplicate row_number refused', service({ ...A, rows: [BNA_A[0], { ...BNA_A[1], row_number: 1 }] }), 'ERR:INVALID_ROWS_CONTRACT%');
expect('unknown row kind refused', service({ ...A, rows: [{ ...BNA_A[0], kind: 'TOTAL' }] }), 'ERR:INVALID_ROWS_CONTRACT%');

expect('BNA statement A parsed', service(A, 'A'), 'OK:%"status": "PARSED"%');
expect('A counters', `(SELECT format('%s/%s/%s/%s/%s/%s', rows_total, lines_new, lines_known, rows_ignored, rows_invalid, rows_captured) FROM fin_import_run WHERE id = ${RES('A')}::uuid)`, '6/3/0/3/0/0');
expect('A run row', `(SELECT format('%s|%s|%s|%s', status, format_code, created_by, coalesce(reject_reason, '-')) FROM fin_import_run WHERE id = ${RES('A')}::uuid)`, `PARSED|BNA_MONTHLY_PDF_V1|${ADMIN}|-`);
expect('A description_norm computed by the database', `(SELECT description_norm FROM fin_statement_line WHERE first_run_id = ${RES('A')}::uuid AND bank_reference = '21' AND signed_amount = -1.44)`, jsNorm('Gravámen  ley 25413 s/cred'));
for (const row of BNA_A.filter((r) => r.kind === 'ECONOMIC')) {
  const fp = jsFingerprint({ format: 'BNA_MONTHLY_PDF_V1', value_date: row.value_date, description_norm: jsNorm(row.description_raw), bank_reference: row.bank_reference, fecha_valor: null, signed_amount: row.signed_amount, running_balance: row.running_balance });
  expect(`A fingerprint row ${row.row_number} = node:crypto`, `(SELECT fingerprint FROM fin_statement_line WHERE first_run_id = ${RES('A')}::uuid AND signed_amount = ${row.signed_amount})`, fp);
}
expect('A appearances: 3 NEW + 3 IGNORED, raw / position / meta kept',
  `(SELECT string_agg(format('%s:%s:%s:%s:%s', row_number, outcome, coalesce(statement_position::text, '-'), (raw_row ? 'text')::text, coalesce(appearance_meta ->> 'page', '-')), ',' ORDER BY row_number) FROM fin_import_run_line WHERE run_id = ${RES('A')}::uuid)`,
  '1:IGNORED:-:true:-,2:NEW:1:true:1,3:NEW:2:true:1,4:IGNORED:-:true:-,5:NEW:3:true:1,6:IGNORED:-:true:-');
expect('A control appearance note', `(SELECT note FROM fin_import_run_line WHERE run_id = ${RES('A')}::uuid AND row_number = 4)`, 'CONTROL:TRANSPORTE');
expect('same attempt replays', service(A, 'A_re'), `OK:%"replayed": true%`);
expect('same attempt replays the same run', `(${RES('A_re')} = ${RES('A')})::text`, 'true');
expect('same effective file with another parser version returns the PARSED run', service({ ...A, parser: 'bna-v1.0.1' }, 'A2'), 'OK:%"replayed": true%');
expect('no new run for an effective file', `(${RES('A2')} = ${RES('A')})::text`, 'true');
expect('runs for file A', `(SELECT count(*)::text FROM fin_import_run WHERE file_sha256 = '${A.sha}')`, '1');

// overlapping statement B: three known facts + one new
const BNA_B = [ctl(1, 'SALDO_ANTERIOR', '1000.00'), BNA_A[1], BNA_A[2], BNA_A[4],
  eco(6, 4, '2026-08-10', 'DEBIN 30000000000', '413', '100.00', '958.56'), ctl(7, 'SALDO_FINAL', '958.56')];
const B = { sha: sha('B'), ...AUG, meta: bnaMeta('1000.00', '958.56'), rows: BNA_B };
expect('overlapping statement B parsed', service(B, 'B'), 'OK:%"lines_known": 3%');
expect('B counters', `(SELECT format('%s/%s/%s/%s', rows_total, lines_new, lines_known, rows_ignored) FROM fin_import_run WHERE id = ${RES('B')}::uuid)`, '6/1/3/2');
expect('one fact, two appearances', `(SELECT format('%s lines / %s appearances', (SELECT count(*) FROM fin_statement_line WHERE financial_account_id = ${ACC('BNA')} AND bank_reference = '412'), count(*)) FROM fin_import_run_line a JOIN fin_statement_line l ON l.id = a.statement_line_id WHERE l.bank_reference = '412' AND l.financial_account_id = ${ACC('BNA')})`, '1 lines / 2 appearances');
expect('B known appearances outcome', `(SELECT string_agg(outcome, ',' ORDER BY row_number) FROM fin_import_run_line WHERE run_id = ${RES('B')}::uuid AND statement_line_id IS NOT NULL)`, 'ALREADY_KNOWN,ALREADY_KNOWN,ALREADY_KNOWN,NEW');
expect('BNA statement lines total', `(SELECT count(*)::text FROM fin_statement_line WHERE financial_account_id = ${ACC('BNA')} AND first_run_id IN (${RES('A')}::uuid, ${RES('B')}::uuid))`, '4');

// content rejections are persisted REJECTED runs with no lines and no appearances
const rej = (seed, rows, meta, extra = {}) => ({ sha: sha(seed), ...AUG, meta, rows, ...extra });
const rejectCase = (label, o, code) => {
  const key = `R_${label}`;
  expect(`${label} → REJECTED ${code}`, service(o, key), `OK:%"reject_reason": "${code}"%`);
  expect(`${label} persisted without lines or appearances`,
    `(SELECT format('%s|%s|%s', status, (SELECT count(*) FROM fin_statement_line WHERE first_run_id = r.id), (SELECT count(*) FROM fin_import_run_line WHERE run_id = r.id)) FROM fin_import_run r WHERE r.id = ${RES(key)}::uuid)`, 'REJECTED|0|0');
};
rejectCase('chain broken', rej('C', [ctl(1, 'SALDO_ANTERIOR', '1000.00'), eco(2, 1, '2026-08-04', 'X', '1', '-240.00', '761.00'), ctl(3, 'SALDO_FINAL', '761.00')], bnaMeta('1000.00', '761.00')), 'BALANCE_CHAIN_MISMATCH');
rejectCase('reissue', rej('D', [eco(1, 1, '2026-08-04', 'GRAVAMEN LEY 25413 S/DEB', '21', '-240.00', '660.00')], bnaMeta('900.00', '660.00')), 'REISSUE_SUSPECTED');
rejectCase('missing balance', rej('E', [eco(1, 1, '2026-08-04', 'X', '1', '-1.00', null)], bnaMeta('1.00', '0.00')), 'RUNNING_BALANCE_REQUIRED');
rejectCase('closing mismatch', rej('F', [eco(1, 1, '2026-08-04', 'X', '1', '-1.00', '0.00')], bnaMeta('1.00', '5.00')), 'CLOSING_BALANCE_MISMATCH');
rejectCase('transporte mismatch', rej('G', [eco(1, 1, '2026-08-04', 'X', '1', '-1.00', '0.00'), ctl(2, 'TRANSPORTE', '9.00')], bnaMeta('1.00', '0.00')), 'TRANSPORTE_MISMATCH');
rejectCase('date outside coverage', rej('H', [eco(1, 1, '2026-07-31', 'X', '1', '-1.00', '0.00')], bnaMeta('1.00', '0.00')), 'DATE_OUTSIDE_COVERAGE');
rejectCase('control char', rej('I', [eco(1, 1, '2026-08-04', 'DEBIN\u0001X', '1', '-1.00', '0.00')], bnaMeta('1.00', '0.00')), 'DESCRIPTION_CONTROL_CHAR');
rejectCase('bank reference', rej('J', [eco(1, 1, '2026-08-04', 'X', ' 21', '-1.00', '0.00')], bnaMeta('1.00', '0.00')), 'INVALID_BANK_REFERENCE');
rejectCase('BNA detail row', rej('K', [{ row_number: 1, kind: 'DETAIL', raw_row: { t: 'x' } }], bnaMeta('1.00', '1.00')), 'UNSUPPORTED_STRUCTURE');
rejectCase('position gap', rej('P', [eco(1, 2, '2026-08-04', 'X', '1', '-1.00', '0.00')], bnaMeta('1.00', '0.00')), 'STATEMENT_POSITION_SEQUENCE');
rejectCase('empty description', rej('Q', [eco(1, 1, '2026-08-04', '€', '1', '-1.00', '0.00')], bnaMeta('1.00', '0.00')), 'EMPTY_DESCRIPTION');
expect('a rejected attempt replays with the same parser version', service(rej('C', [], bnaMeta('1.00', '1.00'))), 'OK:%"status": "REJECTED"%"replayed": true%');

// parser-level rejection, then a reprocess of the same bytes
const SEP = { from: '2026-08-31', to: '2026-09-30' };
const L_ROWS = [ctl(1, 'SALDO_ANTERIOR', '958.56'), eco(2, 1, '2026-09-02', 'COMIS.COMPENSACION ATEN C', '427', '-69.00', '889.56'), ctl(3, 'SALDO_FINAL', '889.56')];
expect('unrecognised file → REJECTED with format_code NULL', service({ sha: sha('L'), parser: 'detector-v1', format: null, reject: 'UNKNOWN_FORMAT' }, 'L0'), 'OK:%"status": "REJECTED"%');
expect('parser rejection persisted', `(SELECT format('%s|%s|%s|%s', status, coalesce(format_code, 'NULL'), parser_version, reject_reason) FROM fin_import_run WHERE id = ${RES('L0')}::uuid)`, 'REJECTED|NULL|detector-v1|UNKNOWN_FORMAT');
expect('blank reject reason refused', service({ sha: sha('L9'), parser: 'detector-v1', format: null, reject: '  ' }), 'ERR:REJECT_REASON_BLANK%');
expect('reprocess without previous_run_id refused', service({ sha: sha('L'), ...SEP, meta: bnaMeta('958.56', '889.56'), rows: L_ROWS }), 'ERR:PREVIOUS_RUN_INVALID%');
expect('reprocess with a foreign previous_run_id refused', service({ sha: sha('L'), ...SEP, meta: bnaMeta('958.56', '889.56'), rows: L_ROWS, prev: `${RES('A')}` }), 'ERR:PREVIOUS_RUN_INVALID%');
expect('reprocess with the latest attempt parsed', service({ sha: sha('L'), ...SEP, meta: bnaMeta('958.56', '889.56'), rows: L_ROWS, prev: `${RES('L0')}` }, 'L1'), 'OK:%"status": "PARSED"%');
expect('reprocess chain recorded', `(SELECT (previous_run_id = ${RES('L0')}::uuid)::text FROM fin_import_run WHERE id = ${RES('L1')}::uuid)`, 'true');
expect('rejected predecessor unchanged', `(SELECT format('%s|%s', status, reject_reason) FROM fin_import_run WHERE id = ${RES('L0')}::uuid)`, 'REJECTED|UNKNOWN_FORMAT');
expect('PARSED file cannot start a new attempt (returns the effective run)', service({ sha: sha('L'), parser: 'bna-v2.0.0', ...SEP, meta: bnaMeta('958.56', '889.56'), rows: L_ROWS, prev: `${RES('L1')}` }, 'L2'), 'OK:%"replayed": true%');
expect('effective run returned', `(${RES('L2')} = ${RES('L1')})::text`, 'true');

// immutability of what the function wrote (0073 guards)
expect('finalized run immutable', `pg_temp.err_of('UPDATE fin_import_run SET file_name = ''x'' WHERE id = ''' || ${RES('A')} || '''')`, 'ERR:FIN_EVIDENCE_IMMUTABLE%');
expect('statement line immutable', `pg_temp.err_of('UPDATE fin_statement_line SET description_raw = ''x'' WHERE first_run_id = ''' || ${RES('A')} || '''')`, 'ERR:FIN_EVIDENCE_IMMUTABLE%');
expect('appearance immutable', `pg_temp.err_of('DELETE FROM fin_import_run_line WHERE run_id = ''' || ${RES('A')} || '''')`, 'ERR:FIN_EVIDENCE_IMMUTABLE%');

// ── 3. import: Patagonia ─────────────────────────────────────────────────────
const patMeta = (o, c) => ({ opening_balance: o, closing_balance: c, statement_id: 'SYNTHETIC' });
const P1_ROWS = [
  ctl(1, 'SALDO_ANTERIOR', '994.00'),
  eco(2, 1, '2026-06-05', 'IMP.DB/CR BANCARIOS P/CREDITOS', '', '-3.00', null),
  eco(3, 2, '2026-06-05', 'TRANSFERENCIA ENTRE CUENTAS', '', '500.00', '1491.00', { appearance_meta: { page: 1, transfer_detail: { nombre_orig: 'SYNTHETIC', banco: '143', imp_original: '500.00' } } }),
  ctl(4, 'SALDO_ACTUAL', '1491.00'),
  { row_number: 5, kind: 'DETAIL', raw_row: { text: 'detail without unique partner' }, review_code: 'TRANSFER_DETAIL_UNMATCHED', note: 'detail not associated' },
];
const PAT = { account: 'Patagonia', format: 'PATAGONIA_STATEMENT_PDF_V1', parser: 'pat-v1.0.0' };
expect('Patagonia P1 parsed (nullable balance, daily balance)', service({ ...PAT, sha: sha('P1'), from: '2026-02-27', to: '2026-06-30', meta: patMeta('994.00', '1491.00'), rows: P1_ROWS }, 'P1'), 'OK:%"status": "PARSED"%');
expect('P1 counters', `(SELECT format('%s/%s/%s/%s', rows_total, lines_new, lines_known, rows_ignored) FROM fin_import_run WHERE id = ${RES('P1')}::uuid)`, '5/2/0/3');
expect('P1 null balance stored', `(SELECT (running_balance IS NULL)::text FROM fin_statement_line WHERE first_run_id = ${RES('P1')}::uuid AND signed_amount = -3.00)`, 'true');
expect('P1 unmatched detail kept as reviewed evidence', `(SELECT format('%s|%s|%s|%s', outcome, coalesce(statement_line_id::text, 'NULL'), review_code, note) FROM fin_import_run_line WHERE run_id = ${RES('P1')}::uuid AND row_number = 5)`, 'IGNORED|NULL|TRANSFER_DETAIL_UNMATCHED|detail not associated');
expect('P1 transfer detail metadata on the main appearance', `(SELECT appearance_meta #>> '{transfer_detail,banco}' FROM fin_import_run_line WHERE run_id = ${RES('P1')}::uuid AND row_number = 3)`, '143');
for (const row of P1_ROWS.filter((r) => r.kind === 'ECONOMIC')) {
  const fp = jsFingerprint({ format: 'PATAGONIA_STATEMENT_PDF_V1', value_date: row.value_date, description_norm: jsNorm(row.description_raw), bank_reference: row.bank_reference, fecha_valor: null, signed_amount: row.signed_amount, running_balance: row.running_balance });
  expect(`P1 fingerprint row ${row.row_number} = node:crypto`, `(SELECT fingerprint FROM fin_statement_line WHERE first_run_id = ${RES('P1')}::uuid AND signed_amount = ${row.signed_amount})`, fp);
}
expect('Patagonia daily balance mismatch → REJECTED', service({ ...PAT, sha: sha('P2'), from: '2026-02-27', to: '2026-06-30', meta: patMeta('994.00', '1490.00'),
  rows: [eco(1, 1, '2026-06-05', 'IMP', '', '-3.00', null), eco(2, 2, '2026-06-05', 'TRF', '', '500.00', '1490.00')] }), 'OK:%"reject_reason": "BALANCE_CHAIN_MISMATCH"%');
expect('Patagonia duplicate content → REJECTED', service({ ...PAT, sha: sha('P3'), from: '2026-02-27', to: '2026-06-30', meta: patMeta('994.00', '1488.00'),
  rows: [eco(1, 1, '2026-06-05', 'IMP.DB/CR BANCARIOS P/CREDITOS', '', '-3.00', null), eco(2, 2, '2026-06-05', 'IMP.DB/CR BANCARIOS P/CREDITOS', '', '-3.00', null),
         eco(3, 3, '2026-06-05', 'TRANSFERENCIA ENTRE CUENTAS', '', '500.00', '1488.00')] }), 'OK:%"reject_reason": "DUPLICATE_CONTENT_IN_STATEMENT"%');
const P4_ROWS = [ctl(1, 'SALDO_ANTERIOR', '1491.00'), eco(2, 1, '2026-09-01', 'TRANSFERENCIA ENTRE CUENTAS', '', '500.00', '1991.00', { fecha_valor: '2026-09-02' }), ctl(3, 'SALDO_ACTUAL', '1991.00')];
expect('Patagonia P4 parsed (FECHA VALOR present)', service({ ...PAT, sha: sha('P4'), from: '2026-06-30', to: '2026-09-30', meta: patMeta('1491.00', '1991.00'), rows: P4_ROWS }, 'P4'), 'OK:%"status": "PARSED"%');
expect('P4 fingerprint includes FECHA VALOR', `(SELECT fingerprint FROM fin_statement_line WHERE first_run_id = ${RES('P4')}::uuid)`,
  jsFingerprint({ format: 'PATAGONIA_STATEMENT_PDF_V1', value_date: '2026-09-01', description_norm: 'TRANSFERENCIA ENTRE CUENTAS', bank_reference: '', fecha_valor: '2026-09-02', signed_amount: '500.00', running_balance: '1991.00' }));

// ── 4. cutover and reconciliation ────────────────────────────────────────────
const line = (run, pos) => `(SELECT a.statement_line_id FROM fin_import_run_line a WHERE a.run_id = ${RES(run)}::uuid AND a.statement_position = ${pos})`;
add(`INSERT INTO financial_operation (operation_type, effective_date, external_ref, reason) VALUES ('ADJUSTMENT', '2026-08-04', 'ADR018-0075-OP1', 'test'), ('ADJUSTMENT', '2026-08-04', 'ADR018-0075-OP2', 'test');
INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date)
SELECT o.id, a.id, x.amt, '2026-08-04' FROM (VALUES ('ADR018-0075-OP1', 'BNA', -240.00), ('ADR018-0075-OP1', 'BNA', -1.44), ('ADR018-0075-OP1', 'BNA', 100.00),
  ('ADR018-0075-OP2', 'BNA', 100.00), ('ADR018-0075-OP2', 'Patagonia', 100.00), ('ADR018-0075-OP2', 'BNA', -2.00), ('ADR018-0075-OP2', 'BNA', -69.00),
  ('ADR018-0075-OP2', 'Patagonia', 500.00)) x(op, acc, amt)
  JOIN financial_operation o ON o.external_ref = x.op JOIN financial_account a ON a.nombre = x.acc;`);
const post = (op, acc, amt) => `(SELECT p.id FROM financial_posting p JOIN financial_operation o ON o.id = p.financial_operation_id JOIN financial_account a ON a.id = p.financial_account_id WHERE o.external_ref = 'ADR018-0075-${op}' AND a.nombre = '${acc}' AND p.signed_amount = ${amt})`;
const lA = line('A', 1), lB = line('A', 2), lC = line('A', 3), lD = line('B', 4), lL = line('L1', 1);
const P_A = post('OP1', 'BNA', -240.00), P_B = post('OP1', 'BNA', -1.44), P_C = post('OP1', 'BNA', 100.00), P_C2 = post('OP2', 'BNA', 100.00);
const P_PAT100 = post('OP2', 'Patagonia', 100.00), P_X = post('OP2', 'BNA', -2.00), P_L = post('OP2', 'BNA', -69.00), P_PAT500 = post('OP2', 'Patagonia', 500.00);
const match = (l, p, r = 'test') => `fin_match_statement_line(${P(l)}::bigint, ${P(p)}::bigint, ${lit(r)})`;
const cut = (acc, l, open, note, reason = null) => `fin_resolve_statement_cutover(${P(ACC(acc))}::uuid, ${P(l)}::bigint, ${open}, ${lit(note)}, ${lit(reason)})`;
const MATCH_ID = (key) => P(RES(key, 'match_id'));

expect('match without a cut → CUTOVER_UNRESOLVED', as('authenticated', ADMIN, `SELECT ${match(lC, P_C)}::text`), 'ERR:CUTOVER_UNRESOLVED%');
expect('cut: anchor from another account refused', as('authenticated', ADMIN, `SELECT ${cut('BNA', line('P4', 1), 1991.00, 'ev')}::text`), 'ERR:ANCHOR_NOT_IN_ACCOUNT%');
expect('cut: opening ≠ anchor balance refused (K-4)', as('authenticated', ADMIN, `SELECT ${cut('BNA', lB, 760.00, 'ev')}::text`), 'ERR:OPENING_BALANCE_MISMATCH%');
expect('cut: blank evidence refused', as('authenticated', ADMIN, `SELECT ${cut('BNA', lB, 758.56, ' ')}::text`), 'ERR:EVIDENCE_REQUIRED%');
expect('cut: supersede reason without an active cut refused', as('authenticated', ADMIN, `SELECT ${cut('BNA', lB, 758.56, 'ev', 'why')}::text`), 'ERR:SUPERSEDE_REASON_NOT_ALLOWED%');
expect('cut: OPERATOR refused', as('authenticated', OPER, `SELECT ${cut('BNA', lB, 758.56, 'ev')}::text`), 'ERR:FORBIDDEN%');
expect('cut: anon has no EXECUTE', as('anon', null, `SELECT ${cut('BNA', lB, 758.56, 'ev')}::text`), 'ERR:permission denied for function%');
expect('cut: service_role has no EXECUTE', as('service_role', null, `SELECT ${cut('BNA', lB, 758.56, 'ev')}::text`), 'ERR:permission denied for function%');
expect('cut BNA resolved (anchor = statement A position 2)', admin(cut('BNA', lB, 758.56, 'statement A, line 2'), 'CUT1'), 'OK:%"superseded_id": null%');

expect('match the anchor → PRE_CUTOVER_LINE', as('authenticated', ADMIN, `SELECT ${match(lB, P_B)}::text`), 'ERR:PRE_CUTOVER_LINE%');
expect('match an earlier line → PRE_CUTOVER_LINE', as('authenticated', ADMIN, `SELECT ${match(lA, P_A)}::text`), 'ERR:PRE_CUTOVER_LINE%');
expect('match OPERATOR refused', as('authenticated', OPER, `SELECT ${match(lC, P_C)}::text`), 'ERR:FORBIDDEN%');
expect('match anon has no EXECUTE', as('anon', null, `SELECT ${match(lC, P_C)}::text`), 'ERR:permission denied for function%');
expect('match POST line', admin(match(lC, P_C), 'M1'), 'OK:%"replayed": false%');
expect('operation derived from the posting', `(SELECT (financial_operation_id = (SELECT id FROM financial_operation WHERE external_ref = 'ADR018-0075-OP1'))::text FROM fin_statement_match WHERE id = (${RES('M1', 'match_id')})::bigint)`, 'true');
expect('identical match replays', admin(match(lC, P_C)), 'OK:%"replayed": true%');
expect('second active match on the line refused', as('authenticated', ADMIN, `SELECT ${match(lC, P_C2)}::text`), 'ERR:LINE_ALREADY_MATCHED%');
expect('posting of another account refused', as('authenticated', ADMIN, `SELECT ${match(lD, P_PAT100)}::text`), 'ERR:ACCOUNT_MISMATCH%');
expect('unequal amount refused', as('authenticated', ADMIN, `SELECT ${match(lD, P_X)}::text`), 'ERR:AMOUNT_MISMATCH%');
expect('second active match on the posting refused', as('authenticated', ADMIN, `SELECT ${match(lD, P_C)}::text`), 'ERR:POSTING_ALREADY_MATCHED%');
expect('reverse without reason refused', as('authenticated', ADMIN, `SELECT fin_reverse_statement_match(${MATCH_ID('M1')}::bigint, ' ')::text`), 'ERR:REASON_REQUIRED%');
expect('reverse OPERATOR refused', as('authenticated', OPER, `SELECT fin_reverse_statement_match(${MATCH_ID('M1')}::bigint, 'x')::text`), 'ERR:FORBIDDEN%');
expect('reverse', admin(`fin_reverse_statement_match(${MATCH_ID('M1')}::bigint, 'wrong pick')`), 'OK:%"reversed": true%');
expect('reverse twice refused', as('authenticated', ADMIN, `SELECT fin_reverse_statement_match(${MATCH_ID('M1')}::bigint, 'again')::text`), 'ERR:MATCH_ALREADY_REVERSED%');
expect('posting freed: rematch with another line', admin(match(lD, P_C), 'M2'), 'OK:%"replayed": false%');
expect('later statement line is POST', admin(match(lL, P_L)), 'OK:%"replayed": false%');
expect('match history kept', `(SELECT format('%s rows, %s reversed', count(*), count(reversed_at)) FROM fin_statement_match WHERE financial_posting_id = ${P_C})`, '2 rows, 1 reversed');
expect('match / reverse audited', `(SELECT string_agg(action, ',' ORDER BY id) FROM audit_events WHERE entity_type = 'fin_statement_match' AND performed_by = '${ADMIN}')`, 'FIN_STATEMENT_MATCH,FIN_STATEMENT_MATCH_REVERSE,FIN_STATEMENT_MATCH,FIN_STATEMENT_MATCH');

expect('supersede without reason refused', as('authenticated', ADMIN, `SELECT ${cut('BNA', lA, 760.00, 'statement A, line 1')}::text`), 'ERR:SUPERSEDE_REASON_REQUIRED%');
expect('supersede with reason', admin(cut('BNA', lA, 760.00, 'statement A, line 1', 'anchor corrected'), 'CUT2'), 'OK:%"superseded_id": %');
expect('superseded id is the first cut', `(${RES('CUT2', 'superseded_id')} = ${RES('CUT1', 'cutover_id')})::text`, 'true');
expect('cut history: 2 rows, 1 active', `(SELECT format('%s/%s', count(*), count(*) FILTER (WHERE superseded_at IS NULL)) FROM fin_statement_cutover WHERE financial_account_id = ${ACC('BNA')})`, '2/1');
expect('cuts audited', `(SELECT count(*)::text FROM audit_events WHERE entity_type = 'fin_statement_cutover' AND performed_by = '${ADMIN}')`, '2');

expect('Patagonia anchor without balance refused', as('authenticated', ADMIN, `SELECT ${cut('Patagonia', line('P1', 1), 991.00, 'ev')}::text`), 'ERR:ANCHOR_WITHOUT_BALANCE%');
expect('Patagonia same-day anchor refused', as('authenticated', ADMIN, `SELECT ${cut('Patagonia', line('P1', 2), 1491.00, 'ev')}::text`), 'ERR:ANCHOR_AMBIGUOUS_DAY%');
expect('Patagonia cut on a lone-day line', admin(cut('Patagonia', line('P4', 1), 1991.00, 'statement AL 30/09')), 'OK:%"cutover_id"%');
expect('Patagonia earlier line is PRE', as('authenticated', ADMIN, `SELECT ${match(line('P1', 2), P_PAT500)}::text`), 'ERR:PRE_CUTOVER_LINE%');

// ── 5. perimeter ─────────────────────────────────────────────────────────────
expect('no function uses the global cutover instant or the MP boundary',
  `(SELECT count(*)::text FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'fin\\_%' AND prosrc ~* '(cutover_at|mp_cutover_boundary)')`, '0');
expect('SECURITY DEFINER set = 88 (0078 capture + 0079 NORMAL ingest and report back-fill + 0081 scheduler log + 0083 payout destinations + 0084 payout matches + 0086 inbound reclass + 0087 payout confirm)', `(SELECT count(*)::text FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace)`, '88');
expect('the four definers: owner postgres, search_path=public',
  `(SELECT string_agg(proname || ':' || prosecdef || ':' || pg_get_userbyid(proowner) || ':' || (coalesce(proconfig, '{}') @> ARRAY['search_path=public']), ',' ORDER BY proname)
     FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('fin_import_bank_statement','fin_match_statement_line','fin_reverse_statement_match','fin_resolve_statement_cutover'))`,
  'fin_import_bank_statement:true:postgres:true,fin_match_statement_line:true:postgres:true,fin_resolve_statement_cutover:true:postgres:true,fin_reverse_statement_match:true:postgres:true');
expect('helpers: INVOKER, IMMUTABLE, search_path=pg_catalog, no application EXECUTE',
  `(SELECT string_agg(proname || ':' || prosecdef || ':' || provolatile::text || ':' || (coalesce(proconfig, '{}') @> ARRAY['search_path=pg_catalog'])
      || ':' || has_function_privilege('anon', oid, 'EXECUTE') || ':' || has_function_privilege('authenticated', oid, 'EXECUTE') || ':' || has_function_privilege('service_role', oid, 'EXECUTE'), ',' ORDER BY proname)
     FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('fin_norm_description','fin_statement_fingerprint'))`,
  'fin_norm_description:false:i:true:false:false:false,fin_statement_fingerprint:false:i:true:false:false:false');
expect('EXECUTE: import service_role only; reconciliation authenticated only; no PUBLIC',
  `(SELECT string_agg(proname || ':' || has_function_privilege('anon', oid, 'EXECUTE') || ':' || has_function_privilege('authenticated', oid, 'EXECUTE') || ':' || has_function_privilege('service_role', oid, 'EXECUTE')
      || ':' || (proacl IS NOT NULL AND NOT EXISTS (SELECT 1 FROM aclexplode(proacl) a WHERE a.grantee = 0)), ',' ORDER BY proname)
     FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('fin_import_bank_statement','fin_match_statement_line','fin_reverse_statement_match','fin_resolve_statement_cutover'))`,
  'fin_import_bank_statement:false:false:true:true,fin_match_statement_line:false:true:false:true,fin_resolve_statement_cutover:false:true:false:true,fin_reverse_statement_match:false:true:false:true');
expect('table grants unchanged since 0074',
  `(SELECT string_agg(table_name || ':' || grantee || ':' || privilege_type, ',' ORDER BY table_name, grantee, privilege_type) FROM information_schema.role_table_grants
     WHERE table_schema = 'public' AND table_name IN ('fin_statement_account_config','fin_import_run','fin_statement_line','fin_import_run_line','fin_statement_match','fin_statement_cutover')
       AND grantee IN ('PUBLIC','anon','authenticated','service_role'))`,
  'fin_import_run:authenticated:SELECT,fin_import_run:service_role:SELECT,fin_import_run_line:authenticated:SELECT,fin_statement_account_config:authenticated:SELECT,fin_statement_account_config:service_role:SELECT,fin_statement_cutover:authenticated:SELECT,fin_statement_line:authenticated:SELECT,fin_statement_match:authenticated:SELECT');

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
console.log(`\n  ══ ADR-018 0075 RESULT: ${pass} passed, ${fail} failed ══\n`);
process.exit(fail === 0 ? 0 : 1);
