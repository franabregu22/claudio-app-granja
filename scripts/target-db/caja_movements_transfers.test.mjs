#!/usr/bin/env node
/**
 * 0116 — CAJA: MOVIMIENTOS UNIFICADOS, TRANSFERENCIAS ANTICIPADAS E IMPUESTOS YA REGISTRADOS. LOCAL TEST DATABASE ONLY. Synthetic values.
 *
 * A synthetic bank account with a statement and an active cut; a cash account; the Mercado Pago account of the database.
 *   A. fin_movement_list: ADMIN only; parameters; an operation's state and its bank evidence (SIN_CONCILIAR → CONCILIADO), the
 *      statement lines after the cut with no match listed once (before the cut, matched or settled: not), totals and paging, the
 *      account / kind filters, the "Por resolver" filters equal to their views' counts.
 *   B. anticipated transfers: routes, idempotency, link to the one transfer (amount and accounts exact; never a second one; one
 *      intent per transfer), a link through a missing Mercado Pago movement writes nothing, cancel; no money moves until linked.
 *   C. a debits/credits tax recorded with its transfer: associated, never booked again from the statement (RECORDED, the posting to
 *      match), matched once; an unrecorded tax line keeps its proposal.
 * Everything runs inside ONE transaction that is rolled back.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" node scripts/target-db/caja_movements_transfers.test.mjs
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
const ADMIN = 'aaaaaaaa-0116-0000-0000-00000000000a';
const OPER = 'aaaaaaaa-0116-0000-0000-00000000000b';
const ACC = 'bbbbbbbb-0116-0000-0000-0000000000a1';    // bank with a statement and a cut
const CASH = 'bbbbbbbb-0116-0000-0000-0000000000c1';
const RUN_SEP = 'cccccccc-0116-0000-0000-0000000000f9';
const RUN_OCT = 'cccccccc-0116-0000-0000-0000000000fa';
const MP = `(SELECT id FROM financial_account WHERE nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE')`;
const Y = '2032';

const sql = [];
const add = (s) => sql.push(s);
const expect = (name, got, like) => add(`SELECT pg_temp.expect(${lit(name)}, ${got}, ${lit(like)});`);
const as = (role, uid, call, key = null) => `pg_temp.run_as(${lit(role)}, ${lit(uid)}, ${lit(call)}, ${lit(key)})`;
const A = (q, key = null) => as('authenticated', ADMIN, q, key);
const O = (q) => as('authenticated', OPER, q);
const L = (n) => `(SELECT id FROM fin_statement_line WHERE description_raw LIKE '%[${n}]')`;
const OP = (ref) => `(SELECT id FROM financial_operation WHERE external_ref = '${ref}')`;
const POST = (ref, acc) => `(SELECT p.id FROM financial_posting p JOIN financial_operation o ON o.id = p.financial_operation_id WHERE o.external_ref = '${ref}' AND p.financial_account_id = ${acc})`;
const list = (args) => `SELECT fin_movement_list(${args})::text`;
const listJ = (args, path) => `SELECT (fin_movement_list(${args}) ${path})::text`;
const MONEY = ['financial_operation', 'financial_posting', 'fin_statement_match', 'bank_tax_charge', 'fin_transfer_intent', 'audit_events'];
const counts = () => MONEY.map((t) => `SELECT ${lit(t)} AS t, count(*) AS n FROM ${t}`).join(' UNION ALL ');
const delta = (snap) => `coalesce((SELECT string_agg(c.t || '=' || (c.n - b.n), ',' ORDER BY c.t) FROM (${counts()}) c JOIN ${snap} b ON b.t = c.t WHERE c.n <> b.n), 'none')`;
const INTENT = (k) => `(SELECT id FROM fin_transfer_intent WHERE idempotency_key = '${k}')`;

// [n, run, position, date, description, bank reference, amount]
const LINES = [
  [1, RUN_SEP, 1, `${Y}-09-20`, 'TRANSF RECIBIDA', '1', 1000],               // before the cut: never listed
  [2, RUN_SEP, 2, `${Y}-09-30`, 'GRAVAMEN LEY 25413 S/CRED', '0', -6],       // the anchor
  [3, RUN_OCT, 1, `${Y}-10-05`, 'CREDITO TRANSF', '9', 20000],              // the cash → bank transfer
  [4, RUN_OCT, 2, `${Y}-10-05`, 'GRAVAMEN LEY 25413 S/CRED', '9', -120],     // its tax, recorded before the statement
  [5, RUN_OCT, 3, `${Y}-10-07`, 'GRAVAMEN LEY 25413 S/DEB', '7', -77],       // a tax nobody recorded: proposed
  [6, RUN_OCT, 4, `${Y}-10-08`, 'VARIOS', '5', -5],                          // no rule: stays to resolve
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
INSERT INTO perfiles (id, email, rol_type) VALUES ('${ADMIN}', 'caja-0116-admin@test.local', 'ADMIN'), ('${OPER}', 'caja-0116-oper@test.local', 'OPERATOR');
INSERT INTO financial_account (id, nombre, account_type) VALUES ('${ACC}', 'ZZ Banco 0116', 'BANK_ACCOUNT'), ('${CASH}', 'ZZ Caja 0116', 'CASH');
INSERT INTO fin_statement_account_config (financial_account_id, format_code, expected_account_number, expected_cbu) VALUES ('${ACC}', 'BNA_MONTHLY_PDF_V1', 'ZZ-0116-1', '0000000000000000001161');
INSERT INTO management_period (periodo_fecha, status) VALUES ('${Y}-09-01', 'OPEN'), ('${Y}-10-01', 'OPEN'), ('${Y}-11-01', 'OPEN')
  ON CONFLICT (periodo_fecha) DO UPDATE SET status = 'OPEN';
INSERT INTO fin_import_run (id, source_kind, mode, financial_account_id, format_code, parser_version, file_sha256, storage_path, file_name, byte_size, coverage_from, coverage_to, status, created_by) VALUES
  ('${RUN_SEP}', 'BANK_STATEMENT', 'NORMAL', '${ACC}', 'BNA_MONTHLY_PDF_V1', 'test-0116', repeat('d', 64), 'test/0116-09.pdf', '0116-09.pdf', 1, '${Y}-09-01', '${Y}-09-30', 'PARSED', '${ADMIN}'),
  ('${RUN_OCT}', 'BANK_STATEMENT', 'NORMAL', '${ACC}', 'BNA_MONTHLY_PDF_V1', 'test-0116', repeat('e', 64), 'test/0116-10.pdf', '0116-10.pdf', 1, '${Y}-10-01', '${Y}-10-31', 'PARSED', '${ADMIN}');`);
let running = 499006;
for (const [n, run, pos, d, desc, ref, amt] of LINES) {
  running = Math.round((running + amt) * 100) / 100;
  add(`WITH l AS (INSERT INTO fin_statement_line (financial_account_id, value_date, description_raw, description_norm, bank_reference, signed_amount, running_balance, fingerprint, first_run_id)
  VALUES ('${ACC}', '${d}', '${desc} [${n}]', '${desc}', '${ref}', ${amt}, ${n === 2 ? 500000 : running}, md5('0116-${n}') || md5('x-0116-${n}'), '${run}') RETURNING id)
  INSERT INTO fin_import_run_line (run_id, row_number, source_kind, mode, raw_row, outcome, statement_line_id, statement_position) SELECT '${run}', ${pos}, 'BANK_STATEMENT', 'NORMAL', '{}'::jsonb, 'NEW', id, ${pos} FROM l;`);
}
add(`SELECT pg_temp.must('cut', ${A(`SELECT fin_resolve_statement_cutover('${ACC}'::uuid, ${L(2)}, 500000, 'corte de prueba 0116', NULL)::text`)});`);
// the cash → bank transfer of 05/10 and, separately, its debits/credits tax recorded by hand before the statement (not related yet)
add(`SELECT pg_temp.must('trf', ${A(`SELECT transfer_between_accounts('${CASH}', '${ACC}', 20000, '${Y}-10-05', 'TRF-0116-1', 'prueba 0116')::text`)});`);
add(`SELECT pg_temp.must('tax', ${A(`SELECT register_bank_tax('${ACC}', 120, '${Y}-10-05', 'DEBITOS_CREDITOS', 'IDC-0116-1', NULL, 'impuesto de la transferencia')::text`)});`);
const ACCF = `p_account_id => '${ACC}'`;

// ── A. the unified list ──
expect('A-1 OPERATOR: refused', O(list('')), 'ERR:FORBIDDEN%');
expect('A-2 a bad pending filter: refused', A(list(`p_pending => 'X'`)), 'ERR:INVALID_PENDING%');
expect('A-3 a scope without its filter: refused', A(list(`p_scope => 'CURRENT'`)), 'ERR:INVALID_SCOPE%');
expect('A-4 a scope on unclassified expenses: refused', A(list(`p_pending => 'GASTO_SIN_CLASIFICAR', p_scope => 'CURRENT'`)), 'ERR:INVALID_SCOPE%');
expect('A-5 the account: 2 operations + the 4 post-cut lines without a match (before the cut and the anchor: never)',
  A(`SELECT (r ->> 'total') || '|' || (r ->> 'lines_total') FROM (SELECT fin_movement_list(${ACCF}) r) x`), 'OK:6|4');
expect('A-6 order: newest first; on one day the operations before the lines',
  A(`SELECT string_agg(coalesce(e ->> 'label', '') || '@' || (e ->> 'effective_date'), ',' ORDER BY n) FROM jsonb_array_elements(fin_movement_list(${ACCF}) -> 'rows') WITH ORDINALITY z(e, n)`),
  `OK:Movimiento bancario sin vincular@${Y}-10-08,Movimiento bancario sin vincular@${Y}-10-07,Impuesto bancario@${Y}-10-05,Transferencia@${Y}-10-05,Movimiento bancario sin vincular@${Y}-10-05,Movimiento bancario sin vincular@${Y}-10-05`);
expect('A-7 the transfer: SIN_CONCILIAR, no evidence yet, its bank posting needs one',
  A(`SELECT e ->> 'status' || '|' || jsonb_array_length(e -> 'bank') || '|' || (e ->> 'net_amount') FROM jsonb_array_elements(fin_movement_list(${ACCF}, p_kind => 'TRANSFERENCIA') -> 'rows') e`), 'OK:SIN_CONCILIAR|0|20000.00');
expect('A-8 a line row carries its bank data and the charge proposal',
  A(`SELECT string_agg((e ->> 'bank_reference') || ':' || (e ->> 'signed_amount') || ':' || coalesce(e -> 'charge' ->> 'status', '-'), ',' ORDER BY (e ->> 'statement_line_id')::bigint)
       FROM jsonb_array_elements(fin_movement_list(${ACCF}, p_kind => 'SIN_VINCULAR') -> 'rows') e`), 'OK:9:20000.00:NO_RULE,9:-120.00:RECORDED,7:-77.00:PROPOSED,5:-5.00:NO_RULE');
expect('A-9 paging: limit 2 offset 4 gives the last two, total unchanged', A(`SELECT (r ->> 'total') || '|' || jsonb_array_length(r -> 'rows') FROM (SELECT fin_movement_list(${ACCF}, p_limit => 2, p_offset => 4) r) x`), 'OK:6|2');
expect('A-10 search by amount finds the line and the operation of 20.000', A(`SELECT r ->> 'total' FROM (SELECT fin_movement_list(${ACCF}, p_search => '20000', p_amount => 20000) r) x`), 'OK:2');
add(`SELECT pg_temp.must('match-trf', ${A(`SELECT fin_match_statement_line(${L(3)}, ${POST('TRF-0116-1', `'${ACC}'`)}, 'prueba')::text`)});`);
expect('A-11 matched: the transfer is CONCILIADO with its line as evidence; the line is no longer a row',
  A(`SELECT (e ->> 'status') || '|' || (e -> 'bank' -> 0 ->> 'bank_reference') || '|' || (e -> 'bank' -> 0 ->> 'signed_amount') || '|' || (SELECT fin_movement_list(${ACCF}) ->> 'lines_total')
       FROM jsonb_array_elements(fin_movement_list(${ACCF}, p_kind => 'TRANSFERENCIA') -> 'rows') e`), 'OK:CONCILIADO|9|20000.00|3');
expect('A-12 the cash side of the same transfer: no bank evidence needed for cash; one operation for both accounts',
  A(`SELECT (r ->> 'total') || '|' || (r -> 'rows' -> 0 ->> 'status') FROM (SELECT fin_movement_list(p_account_id => '${CASH}') r) x`), 'OK:1|CONCILIADO');
expect('A-13 Por resolver: Mercado Pago pending = the view count', A(`SELECT ((fin_movement_list(p_pending => 'MP_CLASIFICAR') ->> 'total')::int = (SELECT count(*) FROM fin_mp_pending_classification))::text`), 'OK:true');
expect('A-14 Por resolver: unclassified expenses = the view count', A(`SELECT ((fin_movement_list(p_pending => 'GASTO_SIN_CLASIFICAR') ->> 'total')::int = (SELECT count(*) FROM fin_expense_pending_classification WHERE status = 'SIN_CLASIFICAR'))::text`), 'OK:true');
expect('A-15 Por resolver: current unlinked inflows = the view count', A(`SELECT ((fin_movement_list(p_pending => 'ENTRADA_SIN_VINCULAR', p_scope => 'CURRENT') ->> 'total')::int = (SELECT count(*) FROM fin_mp_unlinked_inflows WHERE NOT is_historical))::text`), 'OK:true');
add(`SELECT pg_temp.must('unclassified', ${A(`SELECT register_unclassified_expense('${Y}-10-09', 300, 'gasto de prueba 0116', '${CASH}', 'CASH', 'UNCL-0116-1')::text`)});`);
expect('A-16 an unclassified expense: in its filter with its pending id, SIN_CLASIFICAR in the list',
  A(`SELECT (e ->> 'status') || '|' || (e -> 'pending' ->> 'type') || '|' || ((e -> 'pending' ->> 'pending_id') IS NOT NULL)
       FROM jsonb_array_elements(fin_movement_list(p_pending => 'GASTO_SIN_CLASIFICAR', p_account_id => '${CASH}') -> 'rows') e`), 'OK:SIN_CLASIFICAR|GASTO_SIN_CLASIFICAR|true');

// ── B. anticipated transfers ──
add(`CREATE TEMP TABLE s1 AS ${counts()};`);
const reg = (from, to, amount, date, key) => `SELECT fin_register_transfer_intent(${from}, ${to}, ${amount}, '${date}', '${key}', 'prueba 0116')::text`;
expect('B-1 OPERATOR: refused', O(reg(MP, `'${ACC}'`, 50000, `${Y}-10-10`, 'TI-X')), 'ERR:FORBIDDEN%');
expect('B-2 cash → bank is a direct transfer, not an anticipated one', A(reg(`'${CASH}'`, `'${ACC}'`, 50000, `${Y}-10-10`, 'TI-X')), 'ERR:ROUTE_NOT_SUPPORTED%');
expect('B-3 an invalid amount: refused', A(reg(MP, `'${ACC}'`, 0, `${Y}-10-10`, 'TI-X')), 'ERR:INVALID_AMOUNT%');
expect('B-4 Mercado Pago → bank: registered, pending', A(reg(MP, `'${ACC}'`, 50000, `${Y}-10-10`, 'TI-1')), 'OK:%"status": "PENDIENTE"%"replayed": false%');
expect('B-5 the same key and data: replay', A(reg(MP, `'${ACC}'`, 50000, `${Y}-10-10`, 'TI-1')), 'OK:%"replayed": true%');
expect('B-6 the same key, other data: refused', A(reg(MP, `'${ACC}'`, 50001, `${Y}-10-10`, 'TI-1')), 'ERR:IDEMPOTENCY_KEY_REUSED%');
expect('B-7 bank → Mercado Pago: registered', A(reg(`'${ACC}'`, MP, 7000, `${Y}-10-11`, 'TI-2')), 'OK:%"status": "PENDIENTE"%');
expect('B-8 registering moved no money (only the intents and their audits)', delta('s1'), 'audit_events=2,fin_transfer_intent=2');
// the transfer Mercado Pago → bank as the payout confirmation would write it (fixture; its source guard is deferred and never reached)
add(`WITH o AS (INSERT INTO financial_operation (operation_type, effective_date, external_ref, reason, created_by) VALUES ('TRANSFER', '${Y}-10-12', 'MPT-0116-1', 'fixture payout', '${ADMIN}') RETURNING id)
INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date, created_by)
SELECT id, ${MP}, -50000, '${Y}-10-12'::date, '${ADMIN}'::uuid FROM o UNION ALL SELECT id, '${ACC}'::uuid, 50000, '${Y}-10-12'::date, '${ADMIN}'::uuid FROM o;
WITH o AS (INSERT INTO financial_operation (operation_type, effective_date, external_ref, reason, created_by) VALUES ('TRANSFER', '${Y}-10-12', 'MPT-0116-2', 'fixture other amount', '${ADMIN}') RETURNING id)
INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date, created_by)
SELECT id, ${MP}, -49999, '${Y}-10-12'::date, '${ADMIN}'::uuid FROM o UNION ALL SELECT id, '${ACC}'::uuid, 49999, '${Y}-10-12'::date, '${ADMIN}'::uuid FROM o;`);
const link = (key, src, op) => `SELECT fin_link_transfer_intent(${INTENT(key)}, ${src === null ? 'NULL' : `'${src}'`}, ${op === null ? 'NULL' : op})::text`;
add(`CREATE TEMP TABLE s2 AS ${counts()};`);
expect('B-9 both a movement and an operation: refused', A(link('TI-1', '123', OP('MPT-0116-1'))), 'ERR:INVALID_LINK%');
expect('B-10 a transfer of another amount: refused', A(link('TI-1', null, OP('MPT-0116-2'))), 'ERR:TRANSFER_MISMATCH%');
expect('B-11 a transfer of the other direction: refused', A(link('TI-2', null, OP('MPT-0116-1'))), 'ERR:TRANSFER_MISMATCH%');
expect('B-12 a Mercado Pago movement that does not exist: refused by the payout route', A(link('TI-1', '999999999016', null)), 'ERR:PAYOUT_NOT_FOUND%');
expect('B-13 the refusals wrote nothing; the intent is still pending', `${delta('s2')} || '|' || (SELECT status FROM fin_transfer_intent WHERE idempotency_key = 'TI-1')`, 'none|PENDIENTE');
expect('B-14 linked to the transfer of the same accounts and amount', A(link('TI-1', null, OP('MPT-0116-1'))), 'OK:%"replayed": false%');
expect('B-15 again: replay', A(link('TI-1', null, OP('MPT-0116-1'))), 'OK:%"replayed": true%');
add(`SELECT pg_temp.must('ti-3', ${A(reg(MP, `'${ACC}'`, 50000, `${Y}-10-12`, 'TI-3'))});`);
expect('B-16 the same transfer for a second intent: refused', A(link('TI-3', null, OP('MPT-0116-1'))), 'ERR:TRANSFER_ALREADY_LINKED%');
expect('B-17 a linked intent cannot be cancelled', A(`SELECT fin_cancel_transfer_intent(${INTENT('TI-1')}, 'x')::text`), 'ERR:INTENT_ALREADY_LINKED%');
expect('B-18 cancel needs a reason', A(`SELECT fin_cancel_transfer_intent(${INTENT('TI-3')}, ' ')::text`), 'ERR:REASON_REQUIRED%');
expect('B-19 cancelled', A(`SELECT fin_cancel_transfer_intent(${INTENT('TI-3')}, 'registrada por error')::text`), 'OK:%"replayed": false%');
expect('B-20 a cancelled intent cannot be linked', A(link('TI-3', null, OP('MPT-0116-2'))), 'ERR:INTENT_CANCELLED%');
expect('B-21 linking created no operation or posting (one transfer, the one that existed)', `${delta('s2')}`, 'audit_events=3,fin_transfer_intent=1');
expect('B-22 the list shows the transfer with the intent it settled',
  A(`SELECT (e -> 'transfer_intent' ->> 'intent_id') = ${INTENT('TI-1')}::text FROM jsonb_array_elements(fin_movement_list(${ACCF}, p_kind => 'TRANSFERENCIA', p_amount => 50000, p_search => '50000') -> 'rows') e`), 'OK:true');
expect('B-23 the intents are readable by ADMIN only and not writable through the API',
  `(${A(`SELECT count(*)::text FROM fin_transfer_intent WHERE idempotency_key LIKE 'TI-%'`)} || '|' || ${O(`SELECT count(*)::text FROM fin_transfer_intent`)} || '|' || ${A(`UPDATE fin_transfer_intent SET amount = 1 RETURNING 'x'`)})`,
  'OK:3|OK:0|ERR:permission denied%');

// ── C. the tax recorded with its transfer ──
const TAXOP = OP('IDC-0116-1');
expect('C-1 the statement proposes NOT to book it again: RECORDED, with the posting to match',
  A(`SELECT status || '|' || (recorded_posting_id = ${POST('IDC-0116-1', `'${ACC}'`)}) || '|' || recorded_count FROM fin_statement_charge_proposals('${ACC}') WHERE statement_line_id = ${L(4)}`), 'OK:RECORDED|true|1');
expect('C-2 the unrecorded tax keeps its proposal', A(`SELECT status || '|' || kind FROM fin_statement_charge_proposals('${ACC}') WHERE statement_line_id = ${L(5)}`), 'OK:PROPOSED|BANK_TAX_DEBCRED');
add(`CREATE TEMP TABLE s3 AS ${counts()};`);
expect('C-3 booking the recorded tax from the statement: refused', A(`SELECT fin_book_statement_charges('${ACC}', jsonb_build_array(jsonb_build_object('statement_line_id', ${L(4)}, 'kind', 'BANK_TAX_DEBCRED')), 'BOOK-0116-1')::text`), 'ERR:PROPOSAL_CHANGED%RECORDED%');
expect('C-4 associate the tax with its transfer', A(`SELECT fin_relate_bank_tax(${TAXOP}, ${OP('TRF-0116-1')}, 'cobrado con la transferencia')::text`), 'OK:%"replayed": false%');
expect('C-5 again: replay', A(`SELECT fin_relate_bank_tax(${TAXOP}, ${OP('TRF-0116-1')})::text`), 'OK:%"replayed": true%');
expect('C-6 to another transfer: refused', A(`SELECT fin_relate_bank_tax(${TAXOP}, ${OP('MPT-0116-1')})::text`), 'ERR:BANK_TAX_ALREADY_RELATED%');
expect('C-7 OPERATOR: refused', O(`SELECT fin_relate_bank_tax(${TAXOP}, ${OP('TRF-0116-1')})::text`), 'ERR:FORBIDDEN%');
expect('C-8 the association moved no money', delta('s3'), 'audit_events=1');
expect('C-9 the transfer lists its tax (not matched yet)', A(`SELECT (e -> 'related_taxes' -> 0 ->> 'amount') || '|' || (e -> 'related_taxes' -> 0 ->> 'matched') FROM jsonb_array_elements(fin_movement_list(${ACCF}, p_kind => 'TRANSFERENCIA', p_search => 'prueba 0116') -> 'rows') e`), 'OK:120.00|false');
expect('C-10 matched with the statement line (no second tax)', A(`SELECT fin_match_statement_line(${L(4)}, ${POST('IDC-0116-1', `'${ACC}'`)}, 'impuesto ya registrado')::text`), 'OK:%');
expect('C-11 after the match: the line leaves the proposals and the list; the tax shows matched; one tax in total',
  A(`SELECT (SELECT count(*) FROM fin_statement_charge_proposals('${ACC}') WHERE statement_line_id = ${L(4)}) || '|' || (SELECT fin_movement_list(${ACCF}) ->> 'lines_total') || '|'
       || (SELECT e -> 'related_taxes' -> 0 ->> 'matched' FROM jsonb_array_elements(fin_movement_list(${ACCF}, p_kind => 'TRANSFERENCIA', p_search => 'prueba 0116') -> 'rows') e) || '|'
       || (SELECT count(*) FROM bank_tax_charge WHERE financial_account_id = '${ACC}')`), 'OK:0|2|true|1');
expect('C-12 the account balance moved only by what was recorded (20.000 − 120 + the two fixture transfers in, 50.000 and 49.999)',
  `(SELECT sum(signed_amount)::text FROM financial_posting WHERE financial_account_id = '${ACC}')`, '119879.00');

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
