#!/usr/bin/env node
/**
 * 0114 — CARGOS BANCARIOS DESDE EL EXTRACTO. LOCAL TEST DATABASE ONLY. Every value is synthetic.
 *
 * Recognition per statement format (anchored rules; no rule, a credit, two kinds or a fee without category are never proposed),
 * only post-cut, unmatched, unbooked debits; a batch books each line as its own operation (debits / credits tax through
 * register_bank_tax, the IVA as a BANK_TAX of kind IVA, a fee as one casual purchase) matched 1:1 to its line; the balance moves by
 * exactly the booked lines; idempotent replay, key reuse refused, a line booked once even after its match is reversed; atomic
 * (one bad line books nothing); closed periods refused; ADMIN only; no fiscal document is written.
 *
 * Everything runs inside ONE transaction that is rolled back.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" node scripts/target-db/fin_statement_charges.test.mjs
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
const ADMIN = 'aaaaaaaa-0114-0000-0000-00000000000a';
const OPER = 'aaaaaaaa-0114-0000-0000-00000000000b';
const ACC = 'bbbbbbbb-0114-0000-0000-0000000000a1';
const ACC2 = 'bbbbbbbb-0114-0000-0000-0000000000a2';
const RUN = 'cccccccc-0114-0000-0000-0000000000f1';
const Y = '2031';

const sql = [];
const add = (s) => sql.push(s);
const expect = (name, got, like) => add(`SELECT pg_temp.expect(${lit(name)}, ${got}, ${lit(like)});`);
const as = (role, uid, call, key = null) => `pg_temp.run_as(${lit(role)}, ${lit(uid)}, ${lit(call)}, ${lit(key)})`;
const A = (q, key = null) => as('authenticated', ADMIN, q, key);
const L = (n) => `(SELECT id FROM fin_statement_line WHERE financial_account_id = '${ACC}' AND description_raw LIKE '%[${n}]')`;
const item = (n, kind) => `jsonb_build_object('statement_line_id', ${L(n)}, 'kind', '${kind}')`;
const book = (items, key) => `SELECT fin_book_statement_charges('${ACC}'::uuid, jsonb_build_array(${items.join(', ')}), '${key}')::text`;
const props = `SELECT coalesce(json_agg(json_build_object('n', substring(description_raw FROM '\\[(\\d+)\\]$'), 's', status, 'k', kind, 'c', category_name) ORDER BY statement_line_id), '[]')::text FROM fin_statement_charge_proposals('${ACC}'::uuid)`;
const prop = (key, n) => `(SELECT x ->> 's' || ':' || coalesce(x ->> 'k', '-') FROM res, json_array_elements(v::json) x WHERE k = '${key}' AND x ->> 'n' = '${n}')`;
const MONEY = ['financial_operation', 'financial_posting', 'bank_tax_charge', 'purchases', 'fin_statement_match', 'fin_statement_charge_booking', 'fiscal_document', 'audit_events'];
const counts = () => MONEY.map((t) => `SELECT ${lit(t)} AS t, count(*) AS n FROM ${t}`).join(' UNION ALL ');
const delta = (snap) => `coalesce((SELECT string_agg(c.t || '=' || (c.n - b.n), ',' ORDER BY c.t) FROM (${counts()}) c JOIN ${snap} b ON b.t = c.t WHERE c.n <> b.n), 'none')`;
const BAL = `(SELECT coalesce(sum(signed_amount), 0)::text FROM financial_posting WHERE financial_account_id = '${ACC}')`;

// the statement of one synthetic month: [n] tags each line so a test can name it
const LINES = [
  [1, 'GRAVAMEN LEY 25413 S/DEB', -5],             // before the anchor
  [2, 'GRAVAMEN LEY 25413 S/CRED', -1800],         // the anchor
  [3, 'GRAVAMEN LEY 25413 S/DEB', -6000],
  [4, 'GRAVAMEN LEY 25413 S/CRED', -0.30],
  [5, 'COMIS.COMPENSACION ATEN C', -69000],
  [6, 'ECHEQ.EMI.NRO 123456', -50],
  [7, 'I.V.A. BASE', -14490],
  [8, '48HS. BANCOS', -300000],
  [9, 'DEBITO PAGO DIRECTO', -136026.83],
  [10, 'DEBIN 30719089891', 1000000],
  [11, 'REINTEGRO LEY 25413/DEB', 100],
  [12, 'GRAVAMEN LEY 25413 S/DEB', 50],            // the rule matches, but a charge is a debit
  [13, 'GRAVAMEN LEY 25413 S/DEB EXTRA', -10],     // anchored: a longer, different concept
  [14, 'INTERESES', -100],
  [15, 'AMBIGUO TEST', -7],
  [16, 'FEE SIN CATEGORIA', -8],
  [17, 'GRAVAMEN LEY 25413 S/DEB', -11],           // a closed month
];
const DATES = { 1: `${Y}-01-01`, 2: `${Y}-01-01`, 17: `${Y}-02-03` };
const date = (n) => DATES[n] ?? `${Y}-01-${String(Math.min(28, n + 2)).padStart(2, '0')}`;

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
INSERT INTO perfiles (id, email, rol_type) VALUES ('${ADMIN}', 'cargos-0114-admin@test.local', 'ADMIN'), ('${OPER}', 'cargos-0114-oper@test.local', 'OPERATOR');
INSERT INTO financial_account (id, nombre, account_type) VALUES ('${ACC}', 'ZZ Banco Cargos', 'BANK_ACCOUNT'), ('${ACC2}', 'ZZ Banco Otro', 'BANK_ACCOUNT');
INSERT INTO fin_statement_account_config (financial_account_id, format_code, expected_account_number, expected_cbu) VALUES
  ('${ACC}', 'BNA_MONTHLY_PDF_V1', 'ZZ-0114-1', '0000000000000000001141'), ('${ACC2}', 'BNA_MONTHLY_PDF_V1', 'ZZ-0114-2', '0000000000000000001142');
INSERT INTO management_period (periodo_fecha, status) VALUES ('${Y}-01-01', 'OPEN') ON CONFLICT (periodo_fecha) DO UPDATE SET status = 'OPEN';
INSERT INTO management_period (periodo_fecha, status) VALUES ('${Y}-02-01', 'CLOSED') ON CONFLICT (periodo_fecha) DO UPDATE SET status = 'CLOSED';
INSERT INTO fin_import_run (id, source_kind, mode, financial_account_id, format_code, parser_version, file_sha256, storage_path, file_name, byte_size, coverage_from, coverage_to, status, created_by)
VALUES ('${RUN}', 'BANK_STATEMENT', 'NORMAL', '${ACC}', 'BNA_MONTHLY_PDF_V1', 'test-0114', repeat('a', 64), 'test/0114.pdf', '0114.pdf', 1, '${Y}-01-01', '${Y}-02-28', 'PARSED', '${ADMIN}');
-- an ambiguous concept (two kinds) and a fee rule whose category is inactive; both rolled back with the rest
INSERT INTO fin_statement_charge_rule (format_code, pattern, kind, label) VALUES ('BNA_MONTHLY_PDF_V1', '^AMBIGUO TEST$', 'BANK_IVA', 'prueba A'), ('BNA_MONTHLY_PDF_V1', '^AMBIGUO .*$', 'BANK_TAX_DEBCRED', 'prueba B');
INSERT INTO expense_category (id, nombre, activo, group_id) SELECT 'dddddddd-0114-0000-0000-0000000000c1', 'ZZ categoria inactiva 0114', false, group_id FROM expense_category WHERE nombre = 'Comisiones' AND activo LIMIT 1;
INSERT INTO fin_statement_charge_rule (format_code, pattern, kind, label, expense_category_id) VALUES ('BNA_MONTHLY_PDF_V1', '^FEE SIN CATEGORIA$', 'BANK_FEE', 'prueba C', 'dddddddd-0114-0000-0000-0000000000c1');`);
let running = 400000;
for (const [n, d, amt] of LINES) {
  running = Math.round((running + amt) * 100) / 100;
  add(`WITH l AS (INSERT INTO fin_statement_line (financial_account_id, value_date, description_raw, description_norm, bank_reference, signed_amount, running_balance, fingerprint, first_run_id)
  VALUES ('${ACC}', '${date(n)}', '${d} [${n}]', '${d}', '${100 + n}', ${amt}, ${n === 2 ? 335713 : running}, md5('0114-${n}') || md5('x-0114-${n}'), '${RUN}') RETURNING id)
  INSERT INTO fin_import_run_line (run_id, row_number, source_kind, mode, raw_row, outcome, statement_line_id, statement_position) SELECT '${RUN}', ${n}, 'BANK_STATEMENT', 'NORMAL', '{}'::jsonb, 'NEW', id, ${n} FROM l;`);
}

// ── A. permissions ──
expect('A-1 anon cannot read proposals', as('anon', null, props), 'ERR:permission denied for function fin_statement_charge_proposals%');
expect('A-2 service_role cannot book', as('service_role', null, book([`jsonb_build_object('statement_line_id', 1, 'kind', 'BANK_TAX_DEBCRED')`], 'k-a2')), 'ERR:permission denied for function fin_book_statement_charges%');
expect('A-3 OPERATOR cannot read proposals', as('authenticated', OPER, props), 'ERR:FORBIDDEN%');
expect('A-4 OPERATOR cannot book', as('authenticated', OPER, book([item(3, 'BANK_TAX_DEBCRED')], 'k-a4')), 'ERR:FORBIDDEN%');
expect('A-5 OPERATOR sees no rule and no booking', as('authenticated', OPER, `SELECT ((SELECT count(*) FROM fin_statement_charge_rule) + (SELECT count(*) FROM fin_statement_charge_booking))::text`), 'OK:0');
expect('A-6 the internal helpers are not callable by API roles',
  `(SELECT string_agg(p.proname || '=' || (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('service_role', p.oid, 'EXECUTE')), ',' ORDER BY p.proname)
     FROM pg_proc p WHERE p.proname IN ('fin_statement_line_cut_class', 'fin_statement_charge_proposal', 'fin_statement_bank_iva'))`,
  'fin_statement_bank_iva=false,fin_statement_charge_proposal=false,fin_statement_line_cut_class=false');

// ── B. before the cut nothing is proposed or booked ──
add(`SELECT pg_temp.must('p0', ${A(props, 'p0')});`);
expect('B-1 without a cut no line is proposed', `(SELECT v FROM res WHERE k = 'p0')`, '[]');
expect('B-2 without a cut nothing is booked', A(book([item(3, 'BANK_TAX_DEBCRED')], 'k-b2')), 'ERR:PROPOSAL_CHANGED%NOT_POST_CUTOVER%');
add(`SELECT pg_temp.must('cut', ${A(`SELECT fin_resolve_statement_cutover('${ACC}'::uuid, ${L(2)}, 335713, 'corte de prueba 0114', NULL)::text`)});`);

// ── C. the proposals ──
add(`SELECT pg_temp.must('p1', ${A(props, 'p1')});`);
for (const [n, want] of [[3, 'PROPOSED:BANK_TAX_DEBCRED'], [4, 'PROPOSED:BANK_TAX_DEBCRED'], [5, 'PROPOSED:BANK_FEE'], [6, 'PROPOSED:BANK_FEE'], [7, 'PROPOSED:BANK_IVA'],
  [8, 'NO_RULE:-'], [9, 'NO_RULE:-'], [10, 'NO_RULE:-'], [11, 'NO_RULE:-'], [12, 'CREDIT:BANK_TAX_DEBCRED'], [13, 'NO_RULE:-'], [14, 'NO_RULE:-'],
  [15, 'AMBIGUOUS:-'], [16, 'CATEGORY_MISSING:BANK_FEE'], [17, 'PROPOSED:BANK_TAX_DEBCRED']]) {
  expect(`C-1 line ${n}: ${LINES[n - 1][1]} → ${want}`, prop('p1', n), want);
}
expect('C-2 the line before the anchor and the anchor itself are not listed', `(SELECT count(*)::text FROM res, json_array_elements(v::json) x WHERE k = 'p1' AND x ->> 'n' IN ('1', '2'))`, '0');
expect('C-3 a fee shows its category', `(SELECT x ->> 'c' FROM res, json_array_elements(v::json) x WHERE k = 'p1' AND x ->> 'n' = '5')`, 'Comisiones');
expect('C-4 the proposals of an account show no line of another', A(`SELECT count(*)::text FROM fin_statement_charge_proposals('${ACC2}'::uuid)`), 'OK:0');

// ── D. refusals: nothing is booked ──
add(`CREATE TEMP TABLE s0 AS ${counts()};`);
expect('D-1 a cheque (no rule) in the batch: refused', A(book([item(3, 'BANK_TAX_DEBCRED'), item(8, 'BANK_FEE')], 'k-d1')), 'ERR:PROPOSAL_CHANGED%NO_RULE%');
expect('D-2 a kind other than the proposal: refused', A(book([item(7, 'BANK_FEE')], 'k-d2')), 'ERR:PROPOSAL_CHANGED%');
expect('D-3 a credit: refused', A(book([item(12, 'BANK_TAX_DEBCRED')], 'k-d3')), 'ERR:PROPOSAL_CHANGED%CREDIT%');
expect('D-4 an ambiguous concept: refused', A(book([item(15, 'BANK_IVA')], 'k-d4')), 'ERR:PROPOSAL_CHANGED%AMBIGUOUS%');
expect('D-5 a fee without an active category: refused', A(book([item(16, 'BANK_FEE')], 'k-d5')), 'ERR:PROPOSAL_CHANGED%CATEGORY_MISSING%');
expect('D-6 a line of another account: refused', A(`SELECT fin_book_statement_charges('${ACC2}'::uuid, jsonb_build_array(${item(3, 'BANK_TAX_DEBCRED')}), 'k-d6')::text`), 'ERR:%');
expect('D-7 a closed period: refused, with the valid line of the same batch', A(book([item(3, 'BANK_TAX_DEBCRED'), item(17, 'BANK_TAX_DEBCRED')], 'k-d7')), 'ERR:%PERIOD%');
expect('D-8 the same line twice', A(book([item(3, 'BANK_TAX_DEBCRED'), item(3, 'BANK_TAX_DEBCRED')], 'k-d8')), 'ERR:INVALID_ITEMS%');
expect('D-9 no line', A(`SELECT fin_book_statement_charges('${ACC}'::uuid, '[]'::jsonb, 'k-d9')::text`), 'ERR:INVALID_ITEMS%');
expect('D-10 a line without its kind', A(`SELECT fin_book_statement_charges('${ACC}'::uuid, jsonb_build_array(jsonb_build_object('statement_line_id', ${L(3)})), 'k-d10')::text`), 'ERR:INVALID_ITEMS%');
expect('D-11 an empty key', A(book([item(3, 'BANK_TAX_DEBCRED')], ' ')), 'ERR:INVALID_IDEMPOTENCY_KEY%');
expect('D-12 after every refusal: nothing written', delta('s0'), 'none');

// ── E. a batch of five ──
add(`CREATE TEMP TABLE s1 AS ${counts()}; CREATE TEMP TABLE b1 AS SELECT ${BAL}::numeric AS b;`);
const FIVE = [item(3, 'BANK_TAX_DEBCRED'), item(4, 'BANK_TAX_DEBCRED'), item(5, 'BANK_FEE'), item(6, 'BANK_FEE'), item(7, 'BANK_IVA')];
expect('E-1 five lines booked in one batch', A(book(FIVE, 'lote-1'), 'e1'), 'OK:%"booked": 5%"replayed": false%');
expect('E-2 total 89,540.30', `(SELECT (v::jsonb ->> 'total')::numeric::text FROM res WHERE k = 'e1')`, '89540.30');
expect('E-3 five operations, five postings, three bank taxes, two expenses, five matches, five bookings, no fiscal document; audits',
  delta('s1'), 'audit_events=%,bank_tax_charge=3,fin_statement_charge_booking=5,fin_statement_match=5,financial_operation=5,financial_posting=5,purchases=2');
expect('E-4 the account moved by exactly the booked lines', `((SELECT b FROM b1) - ${BAL}::numeric)::text`, '89540.30');
expect('E-5 each line matched to a posting of its own operation, same account and amount',
  `(SELECT count(*)::text FROM fin_statement_charge_booking b JOIN fin_statement_line l ON l.id = b.statement_line_id JOIN financial_posting p ON p.id = b.financial_posting_id
     JOIN fin_statement_match m ON m.id = b.statement_match_id AND m.reversed_at IS NULL AND m.financial_posting_id = p.id AND m.statement_line_id = l.id
    WHERE b.batch_key = 'lote-1' AND p.signed_amount = l.signed_amount AND p.financial_account_id = l.financial_account_id AND p.financial_operation_id = b.financial_operation_id)`, '5');
expect('E-6 one operation per line', `(SELECT count(DISTINCT financial_operation_id)::text FROM fin_statement_charge_booking WHERE batch_key = 'lote-1')`, '5');
expect('E-7 the debits / credits tax went through register_bank_tax (BANK_TAX, DEBITOS_CREDITOS); the IVA is BANK_TAX of kind IVA',
  `(SELECT string_agg(b.kind || ':' || o.operation_type || ':' || c.tax_kind, ',' ORDER BY b.statement_line_id) FROM fin_statement_charge_booking b JOIN financial_operation o ON o.id = b.financial_operation_id
     JOIN bank_tax_charge c ON c.financial_operation_id = o.id WHERE b.batch_key = 'lote-1')`, 'BANK_TAX_DEBCRED:BANK_TAX:DEBITOS_CREDITOS,BANK_TAX_DEBCRED:BANK_TAX:DEBITOS_CREDITOS,BANK_IVA:BANK_TAX:IVA');
expect('E-8 a fee is one casual purchase paid from the account, category Comisiones, net = total, no fiscal document',
  `(SELECT string_agg(o.operation_type || ':' || c.nombre || ':' || pu.amount_net || '=' || pu.amount_total || ':' || (pu.fiscal_document_id IS NULL) || ':' || (pu.supplier_id IS NULL), ',' ORDER BY b.statement_line_id)
     FROM fin_statement_charge_booking b JOIN purchases pu ON pu.id = b.purchase_id JOIN expense_category c ON c.id = pu.expense_category_id JOIN financial_operation o ON o.id = pu.paid_operation_id
    WHERE b.batch_key = 'lote-1' AND o.id = b.financial_operation_id)`, 'PURCHASE_PAYMENT:Comisiones:69000.00=69000.00:true:true,PURCHASE_PAYMENT:Comisiones:50.00=50.00:true:true');
expect('E-9 the history names them: two taxes and the IVA as bank charges, the fees as purchase payments',
  `(SELECT string_agg(k.kind, ',' ORDER BY b.statement_line_id) FROM fin_statement_charge_booking b JOIN financial_operation o ON o.id = b.financial_operation_id CROSS JOIN LATERAL fin_movement_class(o.operation_type::text, o.external_ref) k WHERE b.batch_key = 'lote-1')`,
  'CARGO,CARGO,PAGO,PAGO,CARGO');
expect('E-10 one batch audit with its total', `(SELECT (after_values ->> 'total') FROM audit_events WHERE action = 'FIN_STATEMENT_CHARGES_BOOKED' AND after_values ->> 'batch_key' = 'lote-1')`, '89540.30');
add(`SELECT pg_temp.must('p2', ${A(props, 'p2')});`);
expect('E-11 booked lines leave the proposals', `(SELECT count(*)::text FROM res, json_array_elements(v::json) x WHERE k = 'p2' AND x ->> 'n' IN ('3', '4', '5', '6', '7'))`, '0');

// ── F. idempotency and once-only ──
add(`CREATE TEMP TABLE s2 AS ${counts()};`);
expect('F-1 the same key and lines replay without writing', A(book(FIVE, 'lote-1')), 'OK:%"booked": 5%"replayed": true%');
expect('F-2 … nothing written', delta('s2'), 'none');
expect('F-3 the same key for other lines is refused', A(book([item(17, 'BANK_TAX_DEBCRED')], 'lote-1')), 'ERR:IDEMPOTENCY_KEY_REUSED%');
expect('F-4 a new key with a booked line is refused', A(book([item(3, 'BANK_TAX_DEBCRED')], 'lote-2')), 'ERR:LINE_ALREADY_BOOKED%');
expect('F-5 … nothing written', delta('s2'), 'none');
add(`SELECT pg_temp.must('rev', ${A(`SELECT fin_reverse_statement_match((SELECT statement_match_id FROM fin_statement_charge_booking WHERE statement_line_id = ${L(3)}), 'prueba 0114')::text`)});`);
expect('F-6 a reversed match does not make the line bookable again', A(book([item(3, 'BANK_TAX_DEBCRED')], 'lote-3')), 'ERR:LINE_ALREADY_BOOKED%');
add(`SELECT pg_temp.must('p3', ${A(props, 'p3')});`);
expect('F-7 … nor proposed again', `(SELECT count(*)::text FROM res, json_array_elements(v::json) x WHERE k = 'p3' AND x ->> 'n' = '3')`, '0');
expect('F-8 the booking evidence is immutable', `(SELECT pg_temp.run_as('postgres', NULL, 'UPDATE fin_statement_charge_booking SET batch_key = ''x'' RETURNING 1', NULL))`, 'ERR:%');
expect('F-9 rules are not writable through the API', as('authenticated', ADMIN, `INSERT INTO fin_statement_charge_rule (format_code, pattern, kind, label) VALUES ('X', '^X$', 'BANK_IVA', 'x') RETURNING 1`), 'ERR:permission denied%');

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
