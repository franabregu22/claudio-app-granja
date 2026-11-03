#!/usr/bin/env node
/**
 * 0115 — CHEQUES DEBITADOS ANTES DEL CORTE BANCARIO. LOCAL TEST DATABASE ONLY. Every value is synthetic.
 *
 * The BNA case of 2026-11-03 rebuilt on a synthetic account: two supplier invoices, each paid with two eCheqs; one eCheq of each
 * invoice was debited before the cut (one on the last day of the previous statement, one on the anchor's day but BEFORE the anchor),
 * the other after it. The pre-cut ones are settled without any operation or posting (the balance does not move), the post-cut ones
 * keep the usual path (mark debited + match). Refusals: account, amount, number, date, debit before issue, post-cut (also the same day
 * after the anchor), no cut, a used line, a non-ISSUED instrument, a reused key; ADMIN only; a pre-cut debit can never be reversed;
 * the invoices and the supplier accounts end settled.
 *
 * Everything runs inside ONE transaction that is rolled back.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" node scripts/target-db/fin_instrument_precut_debit.test.mjs
 */
import { spawnSync } from 'node:child_process';
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

const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const ADMIN = 'aaaaaaaa-0115-0000-0000-00000000000a';
const OPER = 'aaaaaaaa-0115-0000-0000-00000000000b';
const ACC = 'bbbbbbbb-0115-0000-0000-0000000000a1';
const ACC2 = 'bbbbbbbb-0115-0000-0000-0000000000a2';
const RUN_SEP = 'cccccccc-0115-0000-0000-0000000000f9';
const RUN_OCT = 'cccccccc-0115-0000-0000-0000000000fa';
const SUP_V = 'eeeeeeee-0115-0000-0000-0000000000e1';   // the freight invoice (eCheqs 31 and 32)
const SUP_C = 'eeeeeeee-0115-0000-0000-0000000000e2';   // the soybean invoice (eCheqs 29 and 30)
const SUP_X = 'eeeeeeee-0115-0000-0000-0000000000e3';   // refusal cases
const Y = '2031';

const sql = [];
const add = (s) => sql.push(s);
const expect = (name, got, like) => add(`SELECT pg_temp.expect(${lit(name)}, ${got}, ${lit(like)});`);
const as = (role, uid, call, key = null) => `pg_temp.run_as(${lit(role)}, ${lit(uid)}, ${lit(call)}, ${lit(key)})`;
const A = (q, key = null) => as('authenticated', ADMIN, q, key);
const L = (n) => `(SELECT id FROM fin_statement_line WHERE description_raw LIKE '%[${n}]')`;
const I = (ref) => `(SELECT id FROM financial_instrument WHERE external_ref = '${ref}')`;
const precut = (ref, n, date, key, reason = null) =>
  `SELECT fin_mark_instrument_debited_precut(${I(ref)}, ${L(n)}, '${date}'::date, '${key}', ${reason === null ? 'NULL' : `'${reason}'`})::text`;
const cands = (ref) => `SELECT coalesce(string_agg(substring(description_raw FROM '\\[(\\d+)\\]$'), ',' ORDER BY statement_line_id), '-') FROM fin_instrument_precut_candidates(${I(ref)})`;
const MONEY = ['financial_operation', 'financial_posting', 'fin_statement_match', 'supplier_ledger', 'financial_instrument_event', 'fin_instrument_precut_debit', 'audit_events'];
const counts = () => MONEY.map((t) => `SELECT ${lit(t)} AS t, count(*) AS n FROM ${t}`).join(' UNION ALL ');
const delta = (snap) => `coalesce((SELECT string_agg(c.t || '=' || (c.n - b.n), ',' ORDER BY c.t) FROM (${counts()}) c JOIN ${snap} b ON b.t = c.t WHERE c.n <> b.n), 'none')`;
const BAL = `(SELECT coalesce(sum(signed_amount), 0)::text FROM financial_posting WHERE financial_account_id = '${ACC}')`;
const SUPBAL = (s) => `(SELECT coalesce(sum(signed_amount), 0)::text FROM supplier_ledger WHERE supplier_id = '${s}')`;

// [n, run, position, date, description, bank reference, amount] — the BNA order: (coverage_to, position)
const LINES = [
  [1, RUN_SEP, 1, `${Y}-09-04`, 'ECHEQ.EMI.NRO 000000029', '29', -50],
  [2, RUN_SEP, 2, `${Y}-09-30`, '48HS. BANCOS', '31', -827714.40],          // eCheq 31 (the real line 45)
  [3, RUN_SEP, 3, `${Y}-09-30`, '48HS. BANCOS', '77', -999],                // refusal: amount
  [4, RUN_SEP, 4, `${Y}-09-30`, '48HS. BANCOS', '33', -827714.40],          // refusal: same amount, another number
  [5, RUN_SEP, 5, `${Y}-09-30`, '48HS. BANCOS', '88', -500],                // refusal: debited before its issue
  [10, RUN_OCT, 1, `${Y}-10-01`, '48HS. BANCOS', '29', -2477410],           // eCheq 29 (the real line 321): the anchor's day, before it
  [11, RUN_OCT, 2, `${Y}-10-01`, 'GRAVAMEN LEY 25413 S/DEB', '29', -14864.46],
  [12, RUN_OCT, 6, `${Y}-10-01`, 'GRAVAMEN LEY 25413 S/CRED', '0', -1800],   // the anchor (the real line 326)
  [13, RUN_OCT, 7, `${Y}-10-01`, '48HS. BANCOS', '55', -300],               // the anchor's day, AFTER it: post-cut
  [14, RUN_OCT, 8, `${Y}-10-06`, '48HS. BANCOS', '32', -827714.40],         // eCheq 32 (the real line 329)
  [15, RUN_OCT, 9, `${Y}-10-23`, '48HS. BANCOS', '30', -2477410],           // eCheq 30 (the real line 357)
];

add(`\\set ON_ERROR_STOP 1
BEGIN;
CREATE TEMP TABLE res (k TEXT PRIMARY KEY, v TEXT);
CREATE FUNCTION pg_temp.run_as(p_role TEXT, p_uid TEXT, p_sql TEXT, p_key TEXT) RETURNS TEXT LANGUAGE plpgsql AS $f$
DECLARE v TEXT; msg TEXT; ok BOOLEAN := false;
BEGIN
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
    INSERT INTO res VALUES (p_key, v) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v;
  END IF;
  RETURN CASE WHEN ok THEN 'OK:' || coalesce(v, 'null') ELSE 'ERR:' || msg END;
END $f$;
CREATE FUNCTION pg_temp.expect(p_name TEXT, p_got TEXT, p_like TEXT) RETURNS VOID LANGUAGE plpgsql AS $f$
BEGIN
  IF p_got IS NULL OR p_got NOT LIKE p_like THEN
    RAISE NOTICE 'FAIL % :: got [%] expected like [%]', p_name, left(p_got, 400), p_like;
  ELSE
    RAISE NOTICE 'PASS %', p_name;
  END IF;
END $f$;
CREATE FUNCTION pg_temp.must(p_name TEXT, p_got TEXT) RETURNS VOID LANGUAGE plpgsql AS $f$
BEGIN
  IF p_got IS NULL OR p_got NOT LIKE 'OK:%' THEN RAISE NOTICE 'FAIL setup % :: %', p_name, left(p_got, 300); END IF;
END $f$;
INSERT INTO perfiles (id, email, rol_type) VALUES ('${ADMIN}', 'precut-0115-admin@test.local', 'ADMIN'), ('${OPER}', 'precut-0115-oper@test.local', 'OPERATOR');
INSERT INTO financial_account (id, nombre, account_type) VALUES ('${ACC}', 'ZZ Banco Corte', 'BANK_ACCOUNT'), ('${ACC2}', 'ZZ Banco Otro', 'BANK_ACCOUNT');
INSERT INTO fin_statement_account_config (financial_account_id, format_code, expected_account_number, expected_cbu) VALUES
  ('${ACC}', 'BNA_MONTHLY_PDF_V1', 'ZZ-0115-1', '0000000000000000001151'), ('${ACC2}', 'BNA_MONTHLY_PDF_V1', 'ZZ-0115-2', '0000000000000000001152');
INSERT INTO management_period (periodo_fecha, status) VALUES ('${Y}-08-01', 'OPEN'), ('${Y}-09-01', 'OPEN'), ('${Y}-10-01', 'OPEN')
  ON CONFLICT (periodo_fecha) DO UPDATE SET status = 'OPEN';
INSERT INTO fin_import_run (id, source_kind, mode, financial_account_id, format_code, parser_version, file_sha256, storage_path, file_name, byte_size, coverage_from, coverage_to, status, created_by) VALUES
  ('${RUN_SEP}', 'BANK_STATEMENT', 'NORMAL', '${ACC}', 'BNA_MONTHLY_PDF_V1', 'test-0115', repeat('b', 64), 'test/0115-09.pdf', '0115-09.pdf', 1, '${Y}-09-01', '${Y}-09-30', 'PARSED', '${ADMIN}'),
  ('${RUN_OCT}', 'BANK_STATEMENT', 'NORMAL', '${ACC}', 'BNA_MONTHLY_PDF_V1', 'test-0115', repeat('c', 64), 'test/0115-10.pdf', '0115-10.pdf', 1, '${Y}-10-01', '${Y}-10-30', 'PARSED', '${ADMIN}');
INSERT INTO suppliers (id, nombre) VALUES ('${SUP_V}', 'ZZ Transportes 0115'), ('${SUP_C}', 'ZZ Acondicionadora 0115'), ('${SUP_X}', 'ZZ Proveedor pruebas 0115');`);
let running = 4000000;
for (const [n, run, pos, d, desc, ref, amt] of LINES) {
  running = Math.round((running + amt) * 100) / 100;
  add(`WITH l AS (INSERT INTO fin_statement_line (financial_account_id, value_date, description_raw, description_norm, bank_reference, signed_amount, running_balance, fingerprint, first_run_id)
  VALUES ('${ACC}', '${d}', '${desc} [${n}]', '${desc}', '${ref}', ${amt}, ${n === 12 ? 335713 : running}, md5('0115-${n}') || md5('x-0115-${n}'), '${run}') RETURNING id)
  INSERT INTO fin_import_run_line (run_id, row_number, source_kind, mode, raw_row, outcome, statement_line_id, statement_position) SELECT '${run}', ${pos}, 'BANK_STATEMENT', 'NORMAL', '{}'::jsonb, 'NEW', id, ${pos} FROM l;`);
}

// the two invoices and their eCheqs, through the existing RPCs (as the screens do)
const CAT = `(SELECT id FROM expense_category WHERE activo ORDER BY nombre LIMIT 1)`;
const purchase = (sup, date, total, inv, key) => `SELECT register_purchase(p_supplier_id => '${sup}', p_economic_date => '${date}', p_amount_net => ${total}, p_amount_total => ${total},
  p_expense_category_id => ${CAT}, p_subcategory => NULL, p_nature => 'OPERATING', p_lines => '[]'::jsonb, p_attachments => NULL, p_idempotency_key => '${key}',
  p_supplier_invoice_number => '${inv}')::text`;
const PUR = (inv) => `(SELECT id FROM purchases WHERE supplier_invoice_number = '${inv}' AND is_current)`;
const echeq = (num, amount, issued, maturity, acc = ACC) => `jsonb_build_object('instrument_type', 'ECHEQ', 'cheque_number', '${num}', 'amount', ${amount}, 'issued_date', '${issued}', 'maturity_date', '${maturity}', 'bank_account_id', '${acc}')`;
const issue = (inv, items, key) => `SELECT issue_purchase_instruments(${PUR(inv)}, jsonb_build_array(${items.join(', ')}), '${key}', NULL)::text`;
add(`SELECT pg_temp.must('fac-v', ${A(purchase(SUP_V, `${Y}-09-21`, 1655428.80, 'ZZ-0051-00087608', 'PUR-0115-V'))});`);
add(`SELECT pg_temp.must('fac-c', ${A(purchase(SUP_C, `${Y}-08-25`, 4954820, 'ZZ-00001-00000484', 'PUR-0115-C'))});`);
add(`SELECT pg_temp.must('chq-v', ${A(issue('ZZ-0051-00087608', [echeq('31', 827714.40, `${Y}-09-23`, `${Y}-09-29`), echeq('32', 827714.40, `${Y}-09-23`, `${Y}-10-05`)], 'CHQ-0115-V'))});`);
add(`SELECT pg_temp.must('chq-c', ${A(issue('ZZ-00001-00000484', [echeq('29', 2477410, `${Y}-09-04`, `${Y}-09-14`), echeq('30', 2477410, `${Y}-09-04`, `${Y}-10-09`)], 'CHQ-0115-C'))});`);
const solo = (num, amount, issued, ref, acc = ACC) => `SELECT issue_supplier_instrument('${SUP_X}', 'ECHEQ', '${num}', ${amount}, '${issued}', '${issued}', '${acc}', '${ref}', NULL)::text`;
add(`SELECT pg_temp.must('x77', ${A(solo('77', 1000, `${Y}-09-01`, 'X-77'))});`);              // amount differs from line 3
add(`SELECT pg_temp.must('x88', ${A(solo('88', 500, `${Y}-10-02`, 'X-88'))});`);               // issued after the debit of line 5
add(`SELECT pg_temp.must('x55', ${A(solo('55', 300, `${Y}-09-01`, 'X-55'))});`);               // its line is the anchor's day, after it
add(`SELECT pg_temp.must('x31acc2', ${A(solo('31', 827714.40, `${Y}-09-01`, 'X-31-ACC2', ACC2))});`);   // another account
add(`SELECT pg_temp.must('x31dup', ${A(solo('0031', 827714.40, `${Y}-09-01`, 'X-31-DUP'))});`);          // same number (zeros) and amount
// the issue references of the four invoice eCheqs (issue_purchase_instruments: key:1, key:2)
const E31 = 'CHQ-0115-V:1', E32 = 'CHQ-0115-V:2', E29 = 'CHQ-0115-C:1', E30 = 'CHQ-0115-C:2';

// ── A. permissions ──
expect('A-1 anon cannot call it', as('anon', null, `SELECT fin_mark_instrument_debited_precut('00000000-0000-0000-0000-000000000115'::uuid, 1, '${Y}-09-30'::date, 'k-a', NULL)::text`), 'ERR:permission denied for function fin_mark_instrument_debited_precut%');
expect('A-2 service_role cannot call it', as('service_role', null, `SELECT fin_mark_instrument_debited_precut('00000000-0000-0000-0000-000000000115'::uuid, 1, '${Y}-09-30'::date, 'k-a', NULL)::text`), 'ERR:permission denied for function fin_mark_instrument_debited_precut%');
expect('A-3 OPERATOR is refused', as('authenticated', OPER, precut(E31, 2, `${Y}-09-30`, 'k-a3')), 'ERR:FORBIDDEN%');
expect('A-4 OPERATOR cannot list candidates', as('authenticated', OPER, cands(E31)), 'ERR:FORBIDDEN%');
expect('A-5 anon cannot list candidates', as('anon', null, `SELECT count(*)::text FROM fin_instrument_precut_candidates('00000000-0000-0000-0000-000000000115'::uuid)`), 'ERR:permission denied for function fin_instrument_precut_candidates%');
expect('A-6 the internal check and the guard are not callable by API roles',
  `(SELECT string_agg(p.proname || '=' || (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('service_role', p.oid, 'EXECUTE')), ',' ORDER BY p.proname)
     FROM pg_proc p WHERE p.proname IN ('fin_instrument_precut_check', 'fin_instrument_precut_final_guard'))`,
  'fin_instrument_precut_check=false,fin_instrument_precut_final_guard=false');
expect('A-7 OPERATOR reads no evidence', as('authenticated', OPER, 'SELECT count(*)::text FROM fin_instrument_precut_debit'), 'OK:0');

// ── B. without a cut nothing is settled ──
expect('B-1 no cut: refused', A(precut(E31, 2, `${Y}-09-30`, 'k-b1')), 'ERR:NOT_PRE_CUTOVER%');
expect('B-2 no cut: no candidate', A(cands(E31)), 'OK:-');
add(`SELECT pg_temp.must('cut', ${A(`SELECT fin_resolve_statement_cutover('${ACC}'::uuid, ${L(12)}, 335713, 'corte de prueba 0115', NULL)::text`)});`);
expect('B-3 the classification of the lines under the cut (the anchor\'s day: before it PRE, after it POST)',
  `(SELECT string_agg(substring(description_raw FROM '\\[(\\d+)\\]$') || '=' || fin_statement_line_cut_class(id), ',' ORDER BY id) FROM fin_statement_line WHERE financial_account_id = '${ACC}' AND description_raw ~ '\\[(2|10|12|13|14)\\]$')`,
  '2=PRE_CUTOVER,10=PRE_CUTOVER,12=PRE_CUTOVER,13=POST_CUTOVER,14=POST_CUTOVER');

// ── C. candidates: exact only ──
expect('C-1 eCheq 31: only its line (same number; line 4 has the same amount but number 33)', A(cands(E31)), 'OK:2');
expect('C-2 eCheq 29: the line of the anchor\'s day before the anchor', A(cands(E29)), 'OK:10');
expect('C-3 eCheqs 32 and 30 (debited after the cut): none', A(`SELECT (${cands(E32)}) || '|' || (${cands(E30)})`), 'OK:-|-');
expect('C-4 a cheque of another account: none', A(cands('X-31-ACC2')), 'OK:-');
expect('C-5 leading zeros of the number are ignored (0031 = 31)', A(cands('X-31-DUP')), 'OK:2');

// ── D. refusals: nothing written ──
add(`CREATE TEMP TABLE s0 AS ${counts()};`);
add(`CREATE TEMP TABLE b0 AS SELECT ${BAL}::numeric AS b;`);
expect('D-1 another account', A(precut('X-31-ACC2', 2, `${Y}-09-30`, 'k-d1')), 'ERR:LINE_NOT_IN_ACCOUNT%');
expect('D-2 another amount', A(precut('X-77', 3, `${Y}-09-30`, 'k-d2')), 'ERR:AMOUNT_MISMATCH%');
expect('D-3 same amount, another number', A(precut(E31, 4, `${Y}-09-30`, 'k-d3')), 'ERR:CHEQUE_NUMBER_MISMATCH%');
expect('D-4 a date that is not the bank\'s (the cheque\'s payment date 29/09)', A(precut(E31, 2, `${Y}-09-29`, 'k-d4')), 'ERR:DEBIT_DATE_MISMATCH%');
expect('D-5 debited before its issue', A(precut('X-88', 5, `${Y}-09-30`, 'k-d5')), 'ERR:DEBIT_BEFORE_ISSUE%');
expect('D-6 a post-cut line (eCheq 32, line of 06/10)', A(precut(E32, 14, `${Y}-10-06`, 'k-d6')), 'ERR:NOT_PRE_CUTOVER%');
expect('D-7 the anchor\'s day AFTER the anchor is post-cut', A(precut('X-55', 13, `${Y}-10-01`, 'k-d7')), 'ERR:NOT_PRE_CUTOVER%');
expect('D-8 an empty key', A(precut(E31, 2, `${Y}-09-30`, ' ')), 'ERR:INVALID_IDEMPOTENCY_KEY%');
expect('D-9 an unknown line', A(`SELECT fin_mark_instrument_debited_precut(${I(E31)}, -1, '${Y}-09-30'::date, 'k-d9', NULL)::text`), 'ERR:LINE_NOT_FOUND%');
expect('D-10 nothing written by any refusal', delta('s0'), 'none');

// ── E. the two historical cases ──
add(`CREATE TEMP TABLE s1 AS ${counts()};`);
expect('E-1 eCheq 31 with its line of 30/09', A(precut(E31, 2, `${Y}-09-30`, 'PRECUT-31', 'eCheq 31 Vesprini'), 'e31'), 'OK:%"estado": "DEBITED"%"replayed": false%');
expect('E-2 eCheq 29 with its line of 01/10, before the anchor', A(precut(E29, 10, `${Y}-10-01`, 'PRECUT-29'), 'e29'), 'OK:%"estado": "DEBITED"%"replayed": false%');
expect('E-3 no operation, no posting, no match, no supplier movement: two events, two evidence rows, two audits', delta('s1'),
  'audit_events=2,fin_instrument_precut_debit=2,financial_instrument_event=2');
expect('E-4 the account balance did not move', `((SELECT b FROM b0) - ${BAL}::numeric)::text`, '0');
expect('E-5 both DEBITED on the bank date', `(SELECT string_agg(cheque_number || '=' || estado || '@' || debited_date, ',' ORDER BY cheque_number) FROM financial_instrument WHERE id IN (${I(E31)}, ${I(E29)}))`,
  `29=DEBITED@${Y}-10-01,31=DEBITED@${Y}-09-30`);
expect('E-6 the DEBITED events carry no operation and say why', `(SELECT string_agg((financial_operation_id IS NULL)::text || ':' || event_date || ':' || (reason LIKE 'Débito anterior al corte: 48HS. BANCOS [%] · ZZ Banco Corte %')::text, ',' ORDER BY event_date)
     FROM financial_instrument_event WHERE event_type = 'DEBITED' AND financial_instrument_id IN (${I(E31)}, ${I(E29)}))`, `true:${Y}-09-30:true,true:${Y}-10-01:true`);
expect('E-7 the evidence: instrument ↔ line, the active cut, the bank date', `(SELECT string_agg(substring(l.description_raw FROM '\\[(\\d+)\\]$') || ':' || (d.cutover_id = c.id) || ':' || d.debited_date, ',' ORDER BY l.id)
     FROM fin_instrument_precut_debit d JOIN fin_statement_line l ON l.id = d.statement_line_id JOIN fin_statement_cutover c ON c.financial_account_id = l.financial_account_id AND c.superseded_at IS NULL)`,
  `2:true:${Y}-09-30,10:true:${Y}-10-01`);
expect('E-8 one audit DEBIT_PRE_CUTOVER each, with line and amount', `(SELECT string_agg((after_values ->> 'amount'), ',' ORDER BY (after_values ->> 'amount')::numeric) FROM audit_events WHERE action = 'DEBIT_PRE_CUTOVER' AND entity_id IN (${I(E31)}::text, ${I(E29)}::text))`,
  '827714.40,2477410.00');
expect('E-9 no INSTRUMENT_DEBIT operation exists for them', `(SELECT count(*)::text FROM financial_operation WHERE external_ref IN ('DEBIT:' || ${I(E31)}, 'DEBIT:' || ${I(E29)}))`, '0');
expect('E-10 the used lines are no longer candidates (another cheque 31 of the same amount)', A(cands('X-31-DUP')), 'OK:-');

// ── F. idempotency and once-only; never a second debit ──
add(`CREATE TEMP TABLE s2 AS ${counts()};`);
expect('F-1 same key, same pair: replay', A(precut(E31, 2, `${Y}-09-30`, 'PRECUT-31')), 'OK:%"replayed": true%');
expect('F-2 same key, another pair: refused', A(precut(E29, 10, `${Y}-10-01`, 'PRECUT-31')), 'ERR:IDEMPOTENCY_KEY_REUSED%');
expect('F-3 a new key for the debited eCheq 31: refused', A(precut(E31, 2, `${Y}-09-30`, 'PRECUT-31-B')), 'ERR:INVALID_STATE%DEBITED%');
expect('F-4 another cheque 31 on the used line: refused', A(precut('X-31-DUP', 2, `${Y}-09-30`, 'PRECUT-31-C')), 'ERR:LINE_ALREADY_USED%');
expect('F-5 the usual "Marcar debitado" on eCheq 31: refused (no second bank debit)', A(`SELECT mark_supplier_instrument_debited(${I(E31)}, '${Y}-09-30', NULL)::text`), 'ERR:INVALID_STATE%');
expect('F-6 rejecting eCheq 31 (would credit back a debit never posted): refused', A(`SELECT reject_supplier_instrument(${I(E31)}, '${Y}-10-10', 'prueba')::text`), 'ERR:PRECUT_DEBIT_FINAL%');
expect('F-7 cancelling eCheq 29: refused', A(`SELECT cancel_supplier_instrument(${I(E29)}, '${Y}-10-10', 'prueba')::text`), 'ERR:INVALID_STATE%');
expect('F-8 nothing written by F', delta('s2'), 'none');
expect('F-9 the evidence is immutable', `(SELECT pg_temp.run_as('postgres', NULL, 'UPDATE fin_instrument_precut_debit SET reason = ''x'' RETURNING 1', NULL))`, 'ERR:%');
expect('F-10 … and cannot be deleted', `(SELECT pg_temp.run_as('postgres', NULL, 'DELETE FROM fin_instrument_precut_debit RETURNING 1', NULL))`, 'ERR:%');
expect('F-11 the evidence is not writable through the API', A(`INSERT INTO fin_instrument_precut_debit (financial_instrument_id, statement_line_id, cutover_id, debited_date, idempotency_key, reason, created_by)
  SELECT ${I('X-77')}, ${L(3)}, 1, '${Y}-09-30', 'x', 'x', '${ADMIN}' RETURNING 1`), 'ERR:permission denied%');
expect('F-12 the account balance still did not move', `((SELECT b FROM b0) - ${BAL}::numeric)::text`, '0');

// ── G. after the cut, the usual path (debited once, then matched) ──
const debit = (ref, date, k) => A(`SELECT mark_supplier_instrument_debited(${I(ref)}, '${date}', NULL)::text`, k);
const POST = (ref) => `(SELECT p.id FROM financial_posting p JOIN financial_operation o ON o.id = p.financial_operation_id WHERE o.external_ref = 'DEBIT:' || ${I(ref)})`;
add(`SELECT pg_temp.must('d32', ${debit(E32, `${Y}-10-06`, 'd32')});`);
add(`SELECT pg_temp.must('d30', ${debit(E30, `${Y}-10-23`, 'd30')});`);
expect('G-1 eCheq 32 matched to its line of 06/10', A(`SELECT fin_match_statement_line(${L(14)}, ${POST(E32)}, 'eCheq 32')::text`), 'OK:%');
expect('G-2 eCheq 30 matched to its line of 23/10', A(`SELECT fin_match_statement_line(${L(15)}, ${POST(E30)}, 'eCheq 30')::text`), 'OK:%');
expect('G-3 the account moved by exactly the two post-cut eCheqs', `((SELECT b FROM b0) - ${BAL}::numeric)::text`, '3305124.40');
expect('G-4 one debit posting per post-cut eCheq, none for the pre-cut ones', `(SELECT count(*)::text FROM financial_operation WHERE operation_type = 'INSTRUMENT_DEBIT' AND source_entity_id IN (${I(E31)}::text, ${I(E32)}::text, ${I(E29)}::text, ${I(E30)}::text))`, '2');
expect('G-5 a post-cut eCheq cannot then be settled before the cut', A(precut(E32, 14, `${Y}-10-06`, 'k-g5')), 'ERR:%');

// ── H. invoices and suppliers settled ──
expect('H-1 both invoices: total = debited, nothing scheduled or pending', A(`SELECT string_agg(supplier_invoice_number || '|' || amount_total || '|' || debited || '|' || scheduled || '|' || pending, ',' ORDER BY supplier_invoice_number) FROM fin_purchase_payment_status WHERE supplier_invoice_number LIKE 'ZZ-%'`),
  'OK:ZZ-00001-00000484|4954820.00|4954820.00|0|0.00,ZZ-0051-00087608|1655428.80|1655428.80|0|0.00');
expect('H-2 both supplier accounts at zero (invoice − two eCheqs; no advance)', `(${SUPBAL(SUP_V)} || '|' || ${SUPBAL(SUP_C)})`, '0.00|0.00');
expect('H-3 the supplier accounts hold exactly the invoice and the two issued eCheqs', `(SELECT string_agg(movement_type::text, ',' ORDER BY movement_type::text, signed_amount) FROM supplier_ledger WHERE supplier_id = '${SUP_V}')`,
  'INSTRUMENT_ISSUED,INSTRUMENT_ISSUED,PURCHASE');

add('ROLLBACK;');

// ── run ────────────────────────────────────────────────────
const target = assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);
const container = (dockerRun(['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}']).stdout || '').trim().split('\n').filter(Boolean)[0];
if (!container) { console.error('  no running supabase_db container. Run `supabase start`.'); process.exit(1); }
const mapping = (dockerRun(['port', container, '5432/tcp']).stdout || '').trim();
if (!mapping.includes(`:${target.port}`)) { console.error(`  container mapping ${mapping} does not match guarded port ${target.port}`); process.exit(1); }
const r = dockerRun(['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], sql.join('\n'));
const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
const lines = out.split('\n').map((l) => l.replace(/^.*NOTICE:\s+/, '').trim());
const pass = lines.filter((l) => l.startsWith('PASS ')).length;
const fail = lines.filter((l) => l.startsWith('FAIL '));
for (const f of fail) console.log(`  ${f}`);
console.log(`\n  ${pass} passed, ${fail.length} failed`);
if (r.status !== 0 || fail.length > 0 || pass === 0) {
  if (r.status !== 0) console.log(out.slice(-2000));
  process.exit(1);
}
