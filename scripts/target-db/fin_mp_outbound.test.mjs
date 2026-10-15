#!/usr/bin/env node
/**
 * META A — MP OUTBOUND PAYMENTS ARE CLASSIFIABLE (ADR-020, migration 0090). LOCAL TEST DATABASE ONLY.
 *
 * Five outbound report payments (economic amount + 0.6% tax) and one third-party payout, through the real NORMAL
 * ingestion: each classified ONCE through the 0088 / 0089 routes (casual purchase, purchase + supplier payment, partner
 * withdrawal, Compras entry point with the SOURCE_ID); the economic route gets |gross|, the tax is a separate ADJUSTMENT;
 * Mercado Pago goes down once by the net debit; P&L carries the purchase only; replay no-op; conflicts refused.
 *
 * Everything runs inside ONE transaction that is rolled back.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *     node scripts/target-db/fin_mp_outbound.test.mjs
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
const ADMIN = 'aaaaaaaa-0090-0000-0000-00000000000a';
const OPER = 'aaaaaaaa-0090-0000-0000-00000000000b';
const MPACC = `(SELECT id FROM financial_account WHERE nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE')`;
const sha = (seed) => createHash('sha256').update(`META-A-0090-${seed}`).digest('hex');
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
const TOT = { ...EMPTY, NET_CREDIT_AMOUNT: '0.00', NET_DEBIT_AMOUNT: '0.00', GROSS_AMOUNT: '-762462.72', MP_FEE_AMOUNT: '0.00',
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
  'mp_source_record', 'fin_mp_payout_destination', 'fin_import_run_line', 'mp_client_allocation', 'fin_statement_line', 'fin_statement_match', 'purchases', 'management_event', 'suppliers'];
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
  ('${ADMIN}', 'meta-a-0090-admin@test.local', 'ADMIN'),
  ('${OPER}',  'meta-a-0090-oper@test.local',  'OPERATOR');`);

// ── fixtures ────────────────────────────────────────────────────────────────
const SUP = 'cccccccc-0090-0000-0000-0000000000a1';
const CAT = 'cccccccc-0090-0000-0000-0000000000c1';
add(`INSERT INTO suppliers (id, nombre) VALUES ('${SUP}', 'Proveedor ADR-020');
INSERT INTO expense_category (id, nombre, pnl_cost_class) VALUES ('${CAT}', 'Categoría ADR-020', 'INDIRECT');`);

// one report day: five outbound payments mirroring the real ones (economic amount + 0.6% tax), one third-party payout (cartones)
const OB = [
  ['890000000101', '102803.00', '616.82'],
  ['890000000102', '355000.00', '2130.00'],
  ['890000000103', '37100.00', '222.60'],
  ['890000000104', '20165.29', '120.99'],
  ['890000000105', '48000.00', '288.00'],
];
const [O1, O2, O3, O4, O5] = OB.map((o) => o[0]);
const PAYOUT = '890000000201';
const out = (i, [sid, gross, tax]) => mv(`0${i}:00:00`, sid, 'payment', '0.00', (Number(gross) + Number(tax)).toFixed(2), `-${gross}`, `-${tax}`, '0.00', 'available_money', 'account_money');
const DAYROWS = [CTL, ...OB.map((o, i) => out(i + 1, o)), mv('09:00:00', PAYOUT, 'payout', '0.00', '1056890.93', '-1056890.93', '0.00', '0.00', 'available_money', ''), TOT];
const rowOf = (sid) => DAYROWS.findIndex((r) => r.SOURCE_ID === sid) + 1;
const OUT = (sid, cls, sup = null, cat = null, concept = cat ? 'Compra ADR-020' : null, name = null, role = 'authenticated', uid = ADMIN) =>
  as(role, uid, `SELECT mp_classify_payout_outflow(${lit(sid)}, ${lit(cls)}, ${sup ? `'${sup}'::uuid` : 'NULL'}, ${cat ? `'${cat}'::uuid` : 'NULL'}, NULL, ${lit(concept)}, ${lit(name)}, NULL)::text`);
const OMOV = (sid) => `(SELECT m.id FROM mp_transition_identity t JOIN mp_financial_movement m ON m.id = t.mp_financial_movement_id WHERE t.resource_type = 'report' AND t.resource_id = '${sid}:payment:D' AND t.transition = 'OUTBOUND')`;
const OPS = (sid) => `(SELECT string_agg(o.operation_type || ':' || r.assigned_amount || ':' || coalesce(o.external_ref, '-'), ' ' ORDER BY o.id) FROM mp_reconciliation r
  JOIN financial_operation o ON o.id = r.financial_operation_id WHERE r.mp_financial_movement_id = ${OMOV(sid)})`;
const SRC = (sid) => `(SELECT processing_status || ':' || coalesce(left(processing_note, 9), '-') FROM mp_source_record WHERE source_type = 'csv_import' AND external_id = '${sid}:payment:D')`;
const PNLB = (b) => as('authenticated', ADMIN, `SELECT coalesce(sum(signed_amount), 0)::text FROM pnl_line_item WHERE bucket = '${b}' AND business_date = '${DAY}' AND source_entity_type IN ('purchases', 'management_event')`);
const EXTERNAL = `'2850590940090418135201'`;

expect('A-1 NORMAL run of the day (5 outbound payments + 1 payout) → PARSED', NORMAL({ sha: sha('outbound-day'), actor: null, rows: rowsOf(DAYROWS) }, 'R'), 'OK:%"status": "PARSED"%');
expect('A-2 payout destination: third party', as('service_role', null,
  `SELECT fin_record_mp_payout_destinations(${P(RES('R'))}::uuid, jsonb_build_array(jsonb_build_object('row_number', ${rowOf(PAYOUT)}, 'value', ${EXTERNAL})))::text`), 'OK:1');
expect('A-4 before classification: outbound rows parked, no movement',
  `((SELECT count(*) FROM mp_source_record WHERE source_type = 'csv_import' AND external_id LIKE '89000000010%:payment:D' AND processing_status = 'PENDING' AND processing_note LIKE 'DEFERRED_V4%')::text
    || ':' || (SELECT count(*) FROM mp_transition_identity WHERE resource_type = 'report' AND resource_id LIKE '89000000010%:payment:D')
    || ':' || (SELECT count(*) FROM mp_webhook_delivery WHERE resource_id LIKE '89000000010%'))`, '5:0:0');
const ACT = as('authenticated', ADMIN, `SELECT string_agg(source_id || ':' || coverage_status || ':' || coalesce(classification, '-') || ':' || (financial_operation_id IS NOT NULL), ',' ORDER BY source_id)
  FROM fin_mp_report_activity WHERE run_id = ${P(RES('R'))}::uuid AND (description = 'payout' OR net_amount < 0)`);
expect('A-5 activity before: 5 OUTBOUND (classifiable) + 1 PAYOUT, no operation',
  ACT, `OK:${O1}:OUTBOUND:-:false,${O2}:OUTBOUND:-:false,${O3}:OUTBOUND:-:false,${O4}:OUTBOUND:-:false,${O5}:OUTBOUND:-:false,${PAYOUT}:PAYOUT:-:false`);
add(`CREATE TEMP TABLE c0 AS ${counts()};
CREATE TEMP TABLE b0 AS SELECT ${BAL('Mercado Pago')} AS mp, (SELECT coalesce(sum(signed_amount), 0) FROM supplier_ledger WHERE supplier_id = '${SUP}') AS sup;`);
add(`CREATE TEMP TABLE p0 AS SELECT ${PNLB('COSTOS_INDIRECTOS')} AS ind, ${PNLB('RETIROS')} AS ret;`);

// B. #1 combustible: casual purchase 102,803 + tax 616.82
expect('B-1 O1 → Compra / gasto sin proveedor (EL KEROSENERO): economic amount 102,803 from the server', OUT(O1, 'CASUAL_PURCHASE', null, CAT, 'Combustible', 'EL KEROSENERO'),
  'OK:%"amount": 102803.00%"replayed": false%"classification": "CASUAL_PURCHASE"%');
expect('B-2 the outbound movement: kind outbound, gross −102,803, tax −616.82, net −103,419.82, identity OUTBOUND',
  `(SELECT m.movement_kind || ':' || m.gross_amount || ':' || m.tax_amount || ':' || m.net_amount FROM mp_financial_movement m WHERE m.id = ${OMOV(O1)})`, 'outbound:-102803.00:-616.82:-103419.82');
expect('B-3 operations reconciled: PURCHASE_PAYMENT −102,803 (MP-OUTFLOW:<id>) + ADJUSTMENT −616.82 (MP-OUTFLOW-TAX:<id>) = net',
  OPS(O1), `PURCHASE_PAYMENT:-102803.00:MP-OUTFLOW:${O1} ADJUSTMENT:-616.82:MP-OUTFLOW-TAX:${O1}`);
expect('B-4 purchase: no supplier, counterparty, total 102,803 (not 103,419.82)',
  `(SELECT (supplier_id IS NULL) || ':' || counterparty_name || ':' || amount_total FROM purchases WHERE id = (SELECT purchase_id FROM mp_outflow_classification WHERE source_id = '${O1}'))`, 'true:EL KEROSENERO:102803.00');
expect('B-5 the parked source row is now RECONCILED (processing metadata only)', SRC(O1), 'RECONCILED:ADR-020: %');
add(`CREATE TEMP TABLE c1 AS ${counts()};`);
expect('B-6 exact replay → replayed, nothing written', `(${OUT(O1, 'CASUAL_PURCHASE', null, CAT, 'Combustible', 'EL KEROSENERO')} LIKE 'OK:%"replayed": true%' AND coalesce(${delta('c1')}, 'none') = 'none')::text`, 'true');
expect('B-7 conflicting classification → ALREADY_CLASSIFIED', OUT(O1, 'OWNER_WITHDRAWAL'), 'ERR:ALREADY_CLASSIFIED%');

// C. #2 contador with a registered supplier (supplier path on an outbound payment)
expect('C-1 O2 → Compra / gasto con proveedor (purchase + payment) 355,000', OUT(O2, 'EXPENSE', SUP, CAT, 'Honorarios contador'), 'OK:%"amount": 355000.00%');
expect('C-2 operations: SUPPLIER_PAYMENT −355,000 + ADJUSTMENT −2,130', OPS(O2), `SUPPLIER_PAYMENT:-355000.00:MP-OUTFLOW:${O2} ADJUSTMENT:-2130.00:MP-OUTFLOW-TAX:${O2}`);
expect('C-3 supplier ledger: PURCHASE +355,000, PAYMENT −355,000 (net 0)', `(SELECT string_agg(movement_type || ' ' || signed_amount, ',' ORDER BY id) FROM supplier_ledger WHERE supplier_id = '${SUP}')`, 'PURCHASE 355000.00,PAYMENT -355000.00');

// D. #3 partner withdrawal on an outbound payment; #4 from the Compras entry point; #5 left unclassified
expect('D-1 O3 → Retiro de socios 37,100 (+ tax 222.60)', OUT(O3, 'OWNER_WITHDRAWAL'), 'OK:%"amount": 37100.00%');
expect('D-2 operations: OWNER_WITHDRAWAL −37,100 + ADJUSTMENT −222.60', OPS(O3), `OWNER_WITHDRAWAL:-37100.00:MGMT:MP-OUTFLOW:${O3} ADJUSTMENT:-222.60:MP-OUTFLOW-TAX:${O3}`);
const CP = (amount) => as('authenticated', ADMIN, `SELECT register_casual_purchase('${DAY}'::date, ${amount}, ${amount}, '${CAT}'::uuid, 'Lubricante', 'OPERATING', ${P(MPACC)}::uuid, 'MERCADOPAGO',
  'COMPRAS-${O4}-${amount}', 'CASTROL', '[]'::jsonb, '[]'::jsonb, NULL, NULL, NULL, '${O4}', NULL)::text`);
expect('D-3 O4 from Compras: the net debit (20,286.28) is refused — the economic amount is the gross', CP('20286.28'), 'ERR:MP_AMOUNT_MISMATCH%20165.29%');
expect('D-4 O4 from Compras with the economic amount 20,165.29 → casual purchase + tax', CP('20165.29'), 'OK:%"replayed": false%');
expect('D-5 O4 operations', OPS(O4), `PURCHASE_PAYMENT:-20165.29:MP-OUTFLOW:${O4} ADJUSTMENT:-120.99:MP-OUTFLOW-TAX:${O4}`);
expect('D-6 O4 then from the activity with the same data → replayed (one classification per SOURCE_ID)', OUT(O4, 'CASUAL_PURCHASE', null, CAT, 'Lubricante', 'CASTROL'), 'OK:%"replayed": true%');
expect('D-7 the payout (cartones) still classifies without tax', OUT(PAYOUT, 'CASUAL_PURCHASE', null, CAT, 'Cartones', 'Proveedor de cartones'), 'OK:%"amount": 1056890.93%');
expect('D-8 payout operations: PURCHASE_PAYMENT −1,056,890.93 only', `(SELECT string_agg(o.operation_type || ':' || r.assigned_amount, ' ') FROM mp_reconciliation r JOIN financial_operation o ON o.id = r.financial_operation_id
   WHERE r.mp_financial_movement_id = (SELECT mp_financial_movement_id FROM mp_outflow_classification WHERE source_id = '${PAYOUT}'))`, 'PURCHASE_PAYMENT:-1056890.93');
expect('D-9 unknown SOURCE_ID → refused', OUT('899999999999', 'OWNER_WITHDRAWAL'), 'ERR:PAYOUT_NOT_FOUND%');

// E. economy
expect('E-1 MP down by the net debits exactly once: 103,419.82 + 357,130 + 37,322.60 + 20,286.28 + 1,056,890.93 (O5 untouched)',
  `((SELECT ${BAL('Mercado Pago')} - mp FROM b0))::text`, '-1575049.63');
expect('E-2 P&L: purchases at the economic amount only (102,803 + 355,000 + 20,165.29 + 1,056,890.93 = 1,534,859.22); withdrawal 37,100; taxes not in the P&L',
  `((${PNLB('COSTOS_INDIRECTOS')}) || '|' || (${PNLB('RETIROS')}) || ' vs ' || (SELECT ind || '|' || ret FROM p0))`, 'OK:-1534859.22|OK:-37100.00 vs OK:0|OK:0');
expect('E-3 no duplicate postings', `(SELECT count(*)::text FROM (SELECT financial_operation_id, financial_account_id, signed_amount FROM financial_posting GROUP BY 1, 2, 3 HAVING count(*) > 1) x)`, '0');
expect('E-4 each classified outflow fully assigned (Σ reconciliations = movement net)',
  `(SELECT count(*)::text FROM mp_outflow_classification oc JOIN mp_financial_movement m ON m.id = oc.mp_financial_movement_id
     WHERE oc.source_id LIKE '890000000%' AND m.net_amount = (SELECT sum(r.assigned_amount) FROM mp_reconciliation r WHERE r.mp_financial_movement_id = m.id))`, '5');
expect('E-5 activity after: O1/O2/O3/O4 + payout CLASSIFIED_OUTFLOW with their operation; O5 still OUTBOUND',
  ACT, `OK:${O1}:CLASSIFIED_OUTFLOW:CASUAL_PURCHASE:true,${O2}:CLASSIFIED_OUTFLOW:EXPENSE:true,${O3}:CLASSIFIED_OUTFLOW:OWNER_WITHDRAWAL:true,`
  + `${O4}:CLASSIFIED_OUTFLOW:CASUAL_PURCHASE:true,${O5}:OUTBOUND:-:false,${PAYOUT}:CLASSIFIED_OUTFLOW:CASUAL_PURCHASE:true`);
expect('E-6 helpers INVOKER with no API EXECUTE; SECURITY DEFINER set unchanged (85)',
  `((SELECT string_agg(proname || '=' || prosecdef || has_function_privilege('authenticated', oid, 'EXECUTE'), ',' ORDER BY proname) FROM pg_proc WHERE proname IN ('mp_outflow_resolve', 'mp_outflow_apply_charges'))
     || '|' || (SELECT count(*) FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace))`, 'mp_outflow_apply_charges=falsefalse,mp_outflow_resolve=falsefalse|87');
expect('E-7 mp_v4_verified() still false', `mp_v4_verified()::text`, 'false');

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
console.log(`\n  ══ META A 0090 MP OUTBOUND RESULT: ${pass} passed, ${fail} failed ══\n`);
process.exit(fail === 0 ? 0 : 1);
