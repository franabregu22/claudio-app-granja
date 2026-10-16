#!/usr/bin/env node
/**
 * META A — MP PAYOUT → OWN ACCOUNT CONFIRMED TRANSFER (migration 0087). LOCAL TEST DATABASE ONLY.
 *
 * Real pipeline: a payout day is ingested by the unchanged NORMAL ingestion (0079: the payouts are normalized into
 * report-only movements), the destinations are recorded (0083) and matched (0084). mp_confirm_payout_transfer(SOURCE_ID)
 * turns an OWN_ACCOUNT_EXACT payout into ONE TRANSFER (MP −amount, destination +amount) resolved entirely server-side;
 * NO_OWN_ACCOUNT_MATCH / DESTINATION_CONFLICT / no destination / unknown payout are refused; a second call writes nothing;
 * P&L neutral; the evidence is untouched; the activity view shows the confirmed payout as OWN_TRANSFER to the account.
 *
 * Everything runs inside ONE transaction that is rolled back. Synthetic payouts; the own CBUs are read from the database.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *     node scripts/target-db/fin_mp_payout_confirm.test.mjs
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
const ADMIN = 'aaaaaaaa-0087-0000-0000-00000000000a';
const OPER = 'aaaaaaaa-0087-0000-0000-00000000000b';
const MPACC = `(SELECT id FROM financial_account WHERE nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE')`;
const sha = (seed) => createHash('sha256').update(`META-A-0087-${seed}`).digest('hex');
const RES = (key, path = 'run_id') => `(SELECT v ->> '${path}' FROM res WHERE k = '${key}')`;
const P = (expr) => `{{${expr}}}`;   // resolved by run_as as the owner, before the role switch
const PARSER = 'mp-release-report-csv/1.1.0';
const DAY = '2026-10-13';
const FORMAT = 'MP_RELEASE_REPORT_CSV_V1';

const sql = [];
const add = (s) => sql.push(s);
const expect = (name, got, like) => add(`SELECT pg_temp.expect(${lit(name)}, ${got}, ${lit(like)});`);

const EMPTY = { BALANCE_AMOUNT: '', BUSINESS_UNIT: '', DATE: '', DESCRIPTION: '', GROSS_AMOUNT: '', MP_FEE_AMOUNT: '',
  NET_CREDIT_AMOUNT: '', NET_DEBIT_AMOUNT: '', PAYMENT_METHOD: '', PAYMENT_METHOD_TYPE: '', PURCHASE_ID: '', SOURCE_ID: '',
  SUB_UNIT: '', TAXES_AMOUNT: '', TRANSACTION_APPROVAL_DATE: '' };
const mv = (t, sid, desc, credit, debit, gross, tax, bal, method = 'available_money', type = 'account_money') => ({
  ...EMPTY, DATE: `${DAY}T${t}.000-03:00`, SOURCE_ID: sid, DESCRIPTION: desc, NET_CREDIT_AMOUNT: credit, NET_DEBIT_AMOUNT: debit,
  GROSS_AMOUNT: gross, MP_FEE_AMOUNT: '0.00', TAXES_AMOUNT: tax, PAYMENT_METHOD: method, TRANSACTION_APPROVAL_DATE: `${DAY}T${t}.000-03:00`,
  BALANCE_AMOUNT: bal, PAYMENT_METHOD_TYPE: type });
const CTL = { ...EMPTY, DATE: `${DAY}T00:00:00.000-03:00`, NET_CREDIT_AMOUNT: '10000.00', NET_DEBIT_AMOUNT: '0.00',
  GROSS_AMOUNT: '10000.00', MP_FEE_AMOUNT: '0.00', TAXES_AMOUNT: '0.00', BALANCE_AMOUNT: '10000.00' };
const TOT = { ...EMPTY, NET_CREDIT_AMOUNT: '0.00', NET_DEBIT_AMOUNT: '0.00', GROSS_AMOUNT: '-1500.00', MP_FEE_AMOUNT: '0.00',
  TAXES_AMOUNT: '0.00', BALANCE_AMOUNT: '0.00' };
const rowsOf = (raws) => raws.map((raw_row, i) => ({ row_number: i + 1, raw_row }));

function captureCall(o) {
  const s = o.sha;
  return `SELECT ${o.fn ?? 'fin_capture_mp_release_report'}(${lit(o.actor === undefined ? ADMIN : o.actor)}::uuid, ${lit(PARSER)},
    ${lit(FORMAT)}, ${lit(s)}, ${P(`'mp/' || ${MPACC} || '/${s}.csv'`)}, 'release-report.csv', 2048,
    ${lit(DAY)}::date, ${lit(DAY)}::date, ${lit(JSON.stringify({ report_type: 'release_report', task_id: '1' }))}::jsonb,
    NULL, ${lit(JSON.stringify(o.rows))}::jsonb)::text`;
}
const as = (role, uid, call, key = null) => `pg_temp.run_as(${lit(role)}, ${lit(uid)}, ${lit(call)}, ${lit(key)})`;
const NORMAL = (o, key) => as('service_role', null, captureCall({ ...o, fn: 'fin_ingest_mp_release_report' }), key);

const FIN_TABLES = ['financial_operation', 'financial_posting', 'mp_reconciliation', 'mp_financial_movement', 'mp_transition_identity',
  'mp_source_record', 'fin_mp_payout_destination', 'fin_import_run_line', 'mp_client_allocation', 'fin_statement_line', 'fin_statement_match'];
const counts = () => FIN_TABLES.map((t) => `SELECT ${lit(t)} AS t, count(*) AS n FROM ${t}`).join(' UNION ALL ');
const delta = (snap) => `(SELECT string_agg(c.t || '=' || (c.n - b.n), ',' ORDER BY c.t) FROM (${counts()}) c JOIN ${snap} b ON b.t = c.t WHERE c.n <> b.n)`;
const BAL = (acc) => `(SELECT coalesce(sum(p.signed_amount), 0) FROM financial_posting p JOIN financial_account a ON a.id = p.financial_account_id WHERE a.nombre = '${acc}')`;
const PNL = `SELECT md5(coalesce((SELECT string_agg(x::text, '#' ORDER BY x::text) FROM pnl_summary x), '')) || md5(coalesce((SELECT string_agg(x::text, '#' ORDER BY x::text) FROM pnl_line_item x), ''))`;

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
  ('${ADMIN}', 'meta-a-0087-admin@test.local', 'ADMIN'),
  ('${OPER}',  'meta-a-0087-oper@test.local',  'OPERATOR');`);

// one payout day: P1 → BNA, P2 → Patagonia, P3 → third party, P4 → conflicting destinations, P5 → no destination
const PAYOUTS = ['870000000001', '870000000002', '870000000003', '870000000004', '870000000005'];
const [P1, P2, P3, P4, P5] = PAYOUTS;
const AMT = ['1000.00', '2200.00', '759.86', '100.00', '100.00'];
const PDAY = [CTL, ...PAYOUTS.map((sid, i) => mv(`1${i}:00:00`, sid, 'payout', '0.00', AMT[i], `-${AMT[i]}`, '0.00', '0.00', 'available_money', '')), TOT];
const rowOf = (sid) => PDAY.findIndex((r) => r.SOURCE_ID === sid) + 1;
const CBU = (bank) => `(SELECT c.expected_cbu::text FROM fin_statement_account_config c JOIN financial_account a ON a.id = c.financial_account_id WHERE a.nombre = '${bank}' AND c.activo)`;
const EXTERNAL = `'2850590940090418135201'`;
const OTHER = `'2850590940090418135299'`;
const record = (key, items) => as('service_role', null,
  `SELECT fin_record_mp_payout_destinations(${P(RES(key))}::uuid, jsonb_build_array(${items.map(([sid, v]) => `jsonb_build_object('row_number', ${rowOf(sid)}, 'value', ${v})`).join(', ')}))::text`);
const CONFIRM = (sid, role = 'authenticated', uid = ADMIN, key = null) => as(role, uid, `SELECT mp_confirm_payout_transfer(${lit(sid)})::text`, key);
const MOV = (sid) => `(SELECT m.id FROM mp_transition_identity t JOIN mp_financial_movement m ON m.id = t.mp_financial_movement_id
  WHERE t.resource_type = 'report' AND t.resource_id = '${sid}:payout:D' AND t.transition = 'PAYOUT')`;
const OP = (sid) => `(SELECT id FROM financial_operation WHERE external_ref = 'MP-PAYOUT-TRANSFER:${sid}')`;

// ── A. the payout day through the real pipeline ─────────────────────────────
expect('A-1 NORMAL run of the payout day → PARSED', NORMAL({ sha: sha('payout-day'), actor: null, rows: rowsOf(PDAY) }, 'R'), 'OK:%"status": "PARSED"%');
expect('A-2 VALIDATION capture of the same day (other bytes)', as('service_role', null, captureCall({ sha: sha('payout-day-validation'), rows: rowsOf(PDAY) }), 'V'), 'OK:%"status": "VALIDATED"%');
expect('A-3 destinations on the NORMAL run (P1 BNA, P2 Patagonia, P3 third party, P4 third party)',
  record('R', [[P1, CBU('BNA')], [P2, CBU('Patagonia')], [P3, EXTERNAL], [P4, EXTERNAL]]), 'OK:4');
expect('A-4 the VALIDATION run reports P4 elsewhere (conflict)', record('V', [[P4, OTHER]]), 'OK:1');
expect('A-5 each payout is one report-only movement (transfer, net < 0); ADR-021 (0093): reconciled only to its provisional',
  `(SELECT string_agg(t.resource_id || ':' || m.movement_kind || ':' || m.net_amount || ':' || (SELECT count(*) FROM mp_reconciliation r WHERE r.mp_financial_movement_id = m.id), ',' ORDER BY t.resource_id)
     FROM mp_transition_identity t JOIN mp_financial_movement m ON m.id = t.mp_financial_movement_id WHERE t.resource_type = 'report' AND t.resource_id LIKE '87000000000%:payout:D')`,
  PAYOUTS.map((s, i) => `${s}:payout:D:transfer:-${AMT[i]}:1`).join(','));
add(`CREATE TEMP TABLE before_counts AS ${counts()};
CREATE TEMP TABLE before_bal AS SELECT ${BAL('Mercado Pago')} AS mp, ${BAL('BNA')} AS bna, ${BAL('Patagonia')} AS pat;
CREATE TEMP TABLE before_dest AS SELECT md5(string_agg(d::text, '#' ORDER BY run_id, row_number)) AS h FROM fin_mp_payout_destination d;
CREATE TEMP TABLE before_src AS SELECT md5(string_agg(s.id || ':' || s.processing_status || ':' || s.event_data::text, '#' ORDER BY s.id)) AS h FROM mp_source_record s WHERE s.external_id LIKE '87000000000%';
CREATE TEMP TABLE before_pnl AS SELECT ${as('authenticated', ADMIN, PNL)} AS h;`);
expect('A-6 P&L readable as ADMIN (baseline)', `(SELECT h FROM before_pnl)`, 'OK:%');

// ── B. confirm OWN_ACCOUNT_EXACT payouts ────────────────────────────────────
expect('B-1 P1 (OWN_ACCOUNT_EXACT → BNA) confirmed: one transfer, amount from the server',
  CONFIRM(P1, 'authenticated', ADMIN, 'C1'), 'OK:%"amount": 1000.00%"replayed": false%"destination_account": "BNA"%');
expect('B-2 the operation: TRANSFER, external_ref MP-PAYOUT-TRANSFER:<SOURCE_ID>, dated the payout day, postings MP −1000 / BNA +1000',
  `(SELECT o.operation_type || ':' || o.external_ref || ':' || o.effective_date || ':' || (SELECT string_agg(a.nombre || ' ' || p.signed_amount, ' / ' ORDER BY p.signed_amount)
      FROM financial_posting p JOIN financial_account a ON a.id = p.financial_account_id WHERE p.financial_operation_id = o.id) FROM financial_operation o WHERE o.id = ${OP(P1)})`,
  `TRANSFER:MP-PAYOUT-TRANSFER:${P1}:${DAY}:Mercado Pago -1000.00 / BNA 1000.00`);
expect('B-3 the movement: provisional and release (ADR-021), then reconciled to the transfer (MP, −1000, same idempotency key)',
  `(SELECT string_agg((r.financial_operation_id = ${OP(P1)})::text || ':' || a.nombre || ':' || r.assigned_amount || ':' || r.idempotency_key, ',' ORDER BY r.financial_operation_id) FROM mp_reconciliation r
     JOIN financial_account a ON a.id = r.financial_account_id WHERE r.mp_financial_movement_id = ${MOV(P1)})`, `false:Mercado Pago:-1000.00:MP-PENDING:${P1},false:Mercado Pago:1000.00:MP-PENDING-RELEASE:${P1},true:Mercado Pago:-1000.00:MP-PAYOUT-TRANSFER:${P1}`);
expect('B-4 confirmation row links movement, destination evidence (the NORMAL run line), MP and BNA, the transfer',
  `(SELECT (c.mp_financial_movement_id = ${MOV(P1)}) || ':' || (c.destination_run_id::text = ${RES('R')}) || ':' || c.destination_row_number || ':' || ma.nombre || ':' || da.nombre
      || ':' || c.amount || ':' || (c.transfer_operation_id = ${OP(P1)}) || ':' || (c.created_by::text = '${ADMIN}')
     FROM mp_payout_transfer_confirmation c JOIN financial_account ma ON ma.id = c.mp_account_id JOIN financial_account da ON da.id = c.destination_account_id WHERE c.source_id = '${P1}')`,
  `true:true:${rowOf(P1)}:Mercado Pago:BNA:1000.00:true:true`);
add(`CREATE TEMP TABLE mid_counts AS ${counts()};`);
expect('B-5 second call: replayed, same operation, nothing written', CONFIRM(P1), 'OK:%"replayed": true%');
expect('B-6 Δ after the replay = none', `coalesce(${delta('mid_counts')}, 'none')`, 'none');
expect('B-7 P2 (OWN_ACCOUNT_EXACT → Patagonia): the destination is the server match, not a client choice',
  CONFIRM(P2), 'OK:%"amount": 2200.00%"replayed": false%"destination_account": "Patagonia"%');

// ── C. refused ──────────────────────────────────────────────────────────────
expect('C-1 P3 NO_OWN_ACCOUNT_MATCH → refused (stays "Clasificar salida")', CONFIRM(P3), 'ERR:NOT_OWN_ACCOUNT_EXACT%NO_OWN_ACCOUNT_MATCH%');
expect('C-2 P4 DESTINATION_CONFLICT → refused', CONFIRM(P4), 'ERR:NOT_OWN_ACCOUNT_EXACT%DESTINATION_CONFLICT%');
expect('C-3 P5 no stored destination (unknown) → refused', CONFIRM(P5), 'ERR:DESTINATION_UNKNOWN%');
expect('C-4 unknown payout SOURCE_ID → refused', CONFIRM('879999999999'), 'ERR:PAYOUT_NOT_FOUND%');
expect('C-5 malformed SOURCE_ID → refused', CONFIRM("1 OR 1=1"), 'ERR:INVALID_SOURCE_ID%');
expect('C-6 OPERATOR → FORBIDDEN; anon / service_role → no EXECUTE',
  `(${CONFIRM(P3, 'authenticated', OPER)} || '|' || ${CONFIRM(P3, 'anon', null)} || '|' || ${CONFIRM(P3, 'service_role', null)})`,
  'ERR:FORBIDDEN%|ERR:permission denied%|ERR:permission denied%');
expect('C-7 the RPC takes ONLY the SOURCE_ID: no amount, no account parameter exists (single overload)',
  `(SELECT string_agg(pg_get_function_identity_arguments(oid), ',') FROM pg_proc WHERE proname = 'mp_confirm_payout_transfer')`, 'p_source_id text');
expect('C-8 ADMIN cannot write the confirmation table directly (no INSERT privilege)',
  as('authenticated', ADMIN, `INSERT INTO mp_payout_transfer_confirmation (source_id, mp_financial_movement_id, destination_run_id, destination_row_number, mp_account_id, destination_account_id, amount, transfer_operation_id)
    SELECT '${P3}', ${MOV(P3)}, run_id, row_number, ${MPACC}, (SELECT id FROM financial_account WHERE nombre = 'BNA'), 1, ${OP(P1)} FROM fin_mp_payout_destination LIMIT 1 RETURNING 'x'`), 'ERR:permission denied%');
expect('C-9 a second transfer with the same idempotency reference is impossible (DUPLICATE_TRANSFER)',
  as('authenticated', ADMIN, `SELECT transfer_between_accounts(${P(MPACC)}::uuid, ${P("(SELECT id FROM financial_account WHERE nombre = 'BNA')")}::uuid, 1000, '${DAY}', 'MP-PAYOUT-TRANSFER:${P1}', 'x')::text`),
  'ERR:DUPLICATE_TRANSFER%');

// ── D. economy, evidence, view ──────────────────────────────────────────────
expect('D-1 Δ counts = 2 transfers + 2 provisional releases (ADR-021): 4 operations, 6 postings, 4 reconciliations; no movement / source / evidence / allocation / bank row',
  delta('before_counts'), 'financial_operation=4,financial_posting=6,mp_reconciliation=4');
expect('D-2 balances: MP unchanged by the confirmations (the payouts reached MP at the ingest, ADR-021), BNA +1000, Patagonia +2200',
  `((SELECT ${BAL('Mercado Pago')} - mp FROM before_bal) || '|' || (SELECT ${BAL('BNA')} - bna FROM before_bal) || '|' || (SELECT ${BAL('Patagonia')} - pat FROM before_bal))`,
  '0.00|1000.00|2200.00');
expect('D-3 P&L unchanged (pnl_summary + pnl_line_item, as ADMIN)', `((SELECT h FROM before_pnl) = ${as('authenticated', ADMIN, PNL)})::text`, 'true');
expect('D-4 no duplicate postings (operation, account, amount)',
  `(SELECT count(*)::text FROM (SELECT financial_operation_id, financial_account_id, signed_amount FROM financial_posting GROUP BY 1, 2, 3 HAVING count(*) > 1) x)`, '0');
expect('D-5 evidence untouched: payout destinations and source records identical',
  `(((SELECT h FROM before_dest) = (SELECT md5(string_agg(d::text, '#' ORDER BY run_id, row_number)) FROM fin_mp_payout_destination d))
    AND ((SELECT h FROM before_src) = (SELECT md5(string_agg(s.id || ':' || s.processing_status || ':' || s.event_data::text, '#' ORDER BY s.id)) FROM mp_source_record s WHERE s.external_id LIKE '87000000000%')))::text`, 'true');
expect('D-6 confirmation rows are immutable', `pg_temp.err_of('UPDATE mp_payout_transfer_confirmation SET amount = 1 WHERE source_id = ''${P1}''') || '|' || pg_temp.err_of('DELETE FROM mp_payout_transfer_confirmation WHERE source_id = ''${P1}''')`,
  'ERR:%|ERR:%');
const ACT = as('authenticated', ADMIN, `SELECT string_agg(source_id || ':' || coverage_status || ':' || coalesce(counterpart_account_name, '-') || ':' || (financial_operation_id IS NOT NULL), ',' ORDER BY source_id)
  FROM fin_mp_report_activity WHERE run_id = ${P(RES('R'))}::uuid AND description = 'payout'`);
expect('D-7 activity (one row per payout): P1 OWN_TRANSFER BNA, P2 OWN_TRANSFER Patagonia (operation linked), P3/P4/P5 still PENDING_CLASSIFICATION (provisional)',
  ACT, `OK:${P1}:OWN_TRANSFER:BNA:true,${P2}:OWN_TRANSFER:Patagonia:true,${P3}:PENDING_CLASSIFICATION:-:true,${P4}:PENDING_CLASSIFICATION:-:true,${P5}:PENDING_CLASSIFICATION:-:true`);
expect('D-8 the destination posting (BNA +1000) exists for a later bank-line match against THIS operation',
  `(SELECT count(*)::text FROM financial_posting p JOIN financial_account a ON a.id = p.financial_account_id WHERE p.financial_operation_id = ${OP(P1)} AND a.nombre = 'BNA' AND p.signed_amount = 1000)`, '1');
expect('D-9 table perimeter: RLS, ADMIN SELECT policy only; SELECT for authenticated only; immutable trigger',
  `((SELECT relrowsecurity FROM pg_class WHERE relname = 'mp_payout_transfer_confirmation')
     AND (SELECT string_agg(policyname || ':' || cmd, ',') FROM pg_policies WHERE tablename = 'mp_payout_transfer_confirmation') = 'mp_payout_transfer_confirmation_admin_select:SELECT'
     AND has_table_privilege('authenticated', 'mp_payout_transfer_confirmation', 'SELECT')
     AND NOT has_table_privilege('authenticated', 'mp_payout_transfer_confirmation', 'INSERT,UPDATE,DELETE,TRUNCATE')
     AND NOT has_table_privilege('anon', 'mp_payout_transfer_confirmation', 'SELECT')
     AND NOT has_table_privilege('service_role', 'mp_payout_transfer_confirmation', 'SELECT,INSERT,UPDATE,DELETE'))::text`, 'true');
expect('D-10 mp_confirm_payout_transfer: DEFINER, owner postgres, search_path=public, EXECUTE authenticated only',
  `(SELECT prosecdef || ':' || pg_get_userbyid(proowner) || ':' || (proconfig @> ARRAY['search_path=public']) || ':' || has_function_privilege('anon', oid, 'EXECUTE')
      || has_function_privilege('authenticated', oid, 'EXECUTE') || has_function_privilege('service_role', oid, 'EXECUTE') FROM pg_proc WHERE proname = 'mp_confirm_payout_transfer')`,
  'true:postgres:true:falsetruefalse');
expect('D-11 SECURITY DEFINER set = 93 (80 + mp_confirm_payout_transfer)', `(SELECT count(*)::text FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace)`, '93');
expect('D-12 cron jobs unchanged; mp_v4_verified() false',
  `((SELECT string_agg(jobname, ',' ORDER BY jobname) FROM cron.job) || '|' || mp_v4_verified()::text)`, 'mp_release_report_daily,mp_release_report_daily_fallback,mp_worker_every_minute|false');

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
console.log(`\n  ══ META A 0087 PAYOUT OWN-ACCOUNT TRANSFER RESULT: ${pass} passed, ${fail} failed ══\n`);
process.exit(fail === 0 ? 0 : 1);
