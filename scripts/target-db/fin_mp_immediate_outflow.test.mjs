#!/usr/bin/env node
/**
 * ADR-021 — A REAL MERCADO PAGO OUTFLOW AFFECTS THE BALANCE IMMEDIATELY (migration 0093). LOCAL TEST DATABASE ONLY.
 *
 * Through the real NORMAL ingestion: every payout / outbound payment gets ONE provisional (MP down by the net debit at once,
 * pending classification, no P&L); every classification route (casual purchase, purchase + supplier payment, partner
 * withdrawal, own-account transfer confirmation) releases it in the same transaction, so Mercado Pago never moves twice;
 * replay no-op; the period close is blocked while pendings exist; a provisional that cannot be posted is a technical
 * exception (day INCOMPLETE) and recoverable; reserves / controls never post; history classified before ADR-021 unchanged.
 *
 * Everything runs inside ONE transaction that is rolled back.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *     node scripts/target-db/fin_mp_immediate_outflow.test.mjs
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
const ADMIN = 'aaaaaaaa-0093-0000-0000-00000000000a';
const OPER = 'aaaaaaaa-0093-0000-0000-00000000000b';
const MPACC = `(SELECT id FROM financial_account WHERE nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE')`;
const sha = (seed) => createHash('sha256').update(`ADR021-0093-${seed}`).digest('hex');
const RES = (key, path = 'run_id') => `(SELECT v ->> '${path}' FROM res WHERE k = '${key}')`;
const P = (expr) => `{{${expr}}}`;   // resolved by run_as as the owner, before the role switch
const PARSER = 'mp-release-report-csv/1.1.0';
const DAY = '2026-10-20';
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
  ('${ADMIN}', 'adr021-0093-admin@test.local', 'ADMIN'),
  ('${OPER}',  'adr021-0093-oper@test.local',  'OPERATOR');`);

// ── fixtures ────────────────────────────────────────────────────────────────
const SUP = 'cccccccc-0093-0000-0000-0000000000a1';
const CAT = 'cccccccc-0093-0000-0000-0000000000c1';
add(`INSERT INTO suppliers (id, nombre) VALUES ('${SUP}', 'Proveedor ADR-021');
INSERT INTO expense_category (id, nombre, pnl_cost_class) VALUES ('${CAT}', 'Categoría ADR-021', 'INDIRECT');
INSERT INTO management_period (periodo_fecha, status) VALUES ('2027-01-01', 'OPEN'), ('2027-02-01', 'OPEN') ON CONFLICT (periodo_fecha) DO NOTHING;`);

// one report day: 2 outbound payments (economic + 0.6% tax), 3 payouts (2 third party, 1 own account BNA), the reserve pair of O1
const O1 = '930000000101'; const O2 = '930000000102';
const P1 = '930000000201'; const P2 = '930000000202'; const P3 = '930000000203';
const DROWS = [CTL,
  mv('01:00:00', O1, 'reserve_for_payment', '0.00', '1006.00', '-1006.00', '0.00', '0.00'),
  mv('01:00:01', O1, 'reserve_for_payment', '1006.00', '0.00', '1006.00', '0.00', '0.00'),
  mv('01:00:02', O1, 'payment', '0.00', '1006.00', '-1000.00', '-6.00', '0.00'),
  mv('02:00:00', O2, 'payment', '0.00', '503.00', '-500.00', '-3.00', '0.00'),
  mv('03:00:00', P1, 'payout', '0.00', '2000.00', '-2000.00', '0.00', '0.00', 'available_money', ''),
  mv('04:00:00', P2, 'payout', '0.00', '3000.00', '-3000.00', '0.00', '0.00', 'available_money', ''),
  mv('05:00:00', P3, 'payout', '0.00', '700.00', '-700.00', '0.00', '0.00', 'available_money', ''),
  TOT];
const rowOf = (sid, desc) => DROWS.findIndex((r) => r.SOURCE_ID === sid && r.DESCRIPTION === desc) + 1;
const CBU = (bank) => `(SELECT c.expected_cbu::text FROM fin_statement_account_config c JOIN financial_account a ON a.id = c.financial_account_id WHERE a.nombre = '${bank}' AND c.activo)`;
const EXTERNAL = `'2850590940090418135201'`;
const OUT = (sid, cls, sup = null, cat = null, concept = cat ? 'Compra ADR-021' : null, name = null) =>
  as('authenticated', ADMIN, `SELECT mp_classify_payout_outflow(${lit(sid)}, ${lit(cls)}, ${sup ? `'${sup}'::uuid` : 'NULL'}, ${cat ? `'${cat}'::uuid` : 'NULL'}, NULL, ${lit(concept)}, ${lit(name)}, NULL)::text`);
const CONFIRM = (sid) => as('authenticated', ADMIN, `SELECT mp_confirm_payout_transfer(${lit(sid)})::text`);
const POSTP = (sid, role = 'authenticated', uid = ADMIN) => as(role, uid, `SELECT mp_post_pending_outflow(${lit(sid)})::text`);
const MOVID = (sid) => `(SELECT m.id FROM mp_transition_identity t JOIN mp_financial_movement m ON m.id = t.mp_financial_movement_id
  WHERE t.resource_type = 'report' AND t.resource_id IN ('${sid}:payout:D', '${sid}:payment:D'))`;
const OPS = (sid) => `(SELECT string_agg(o.operation_type || ':' || r.assigned_amount || ':' || split_part(o.external_ref, ':', 1), ' ' ORDER BY o.id) FROM mp_reconciliation r
  JOIN financial_operation o ON o.id = r.financial_operation_id WHERE r.mp_financial_movement_id = ${MOVID(sid)})`;
const SUMREC = (sid) => `(SELECT sum(r.assigned_amount)::text FROM mp_reconciliation r WHERE r.mp_financial_movement_id = ${MOVID(sid)})`;
const PEND = as('authenticated', ADMIN, `SELECT coalesce(string_agg(source_id || ':' || kind || ':' || direction || ':' || amount || ':' || economic_amount || ':' || already_posted, ',' ORDER BY source_id), '-')
  FROM fin_mp_pending_classification WHERE source_id LIKE '9300000%'`);
const ACT = as('authenticated', ADMIN, `SELECT string_agg(source_id || ':' || coalesce(description, '-') || ':' || coverage_status, ',' ORDER BY row_number)
  FROM fin_mp_report_activity WHERE run_id = ${P(RES('R'))}::uuid AND source_id IS NOT NULL`);
const TECH = as('authenticated', ADMIN, `SELECT coalesce(string_agg(issue || ':' || source_id || ':' || coalesce(review_code, '-'), ',' ORDER BY source_id), '-') FROM fin_mp_technical_review WHERE source_id LIKE '9300000%'`);
const MPD = (snap) => `((SELECT (${BAL('Mercado Pago')} - mp)::NUMERIC(15,2) FROM ${snap}))::text`;
const BNAD = (snap) => `((SELECT (${BAL('BNA')} - bna)::NUMERIC(15,2) FROM ${snap}))::text`;
const SNAP = (name) => add(`CREATE TEMP TABLE ${name} AS SELECT ${BAL('Mercado Pago')} AS mp, ${BAL('BNA')} AS bna; CREATE TEMP TABLE ${name}c AS ${counts()};`);
const PNLB = (b) => as('authenticated', ADMIN, `SELECT coalesce(sum(signed_amount), 0)::text FROM pnl_line_item WHERE bucket = '${b}' AND business_date = '${DAY}' AND source_entity_type IN ('purchases', 'management_event')`);

// ── A / D. ingest: every real outflow reaches the MP balance at once, pending classification ──
SNAP('s0');
add(`CREATE TEMP TABLE p0 AS SELECT ${PNLB('COSTOS_INDIRECTOS')} AS ind, ${PNLB('RETIROS')} AS ret;`);
expect('A-1 NORMAL run (2 outbound + 3 payouts + reserve pair) → PARSED; 5 provisionals posted, 0 failed',
  NORMAL({ sha: sha('day'), actor: null, rows: rowsOf(DROWS) }, 'R'), 'OK:%"status": "PARSED"%"provisionals_posted": 5%"provisionals_not_posted": 0%');
expect('A-2 destinations: P1 / P3 third party, P2 own account (BNA)', as('service_role', null,
  `SELECT fin_record_mp_payout_destinations(${P(RES('R'))}::uuid, jsonb_build_array(jsonb_build_object('row_number', ${rowOf(P1, 'payout')}, 'value', ${EXTERNAL}),
     jsonb_build_object('row_number', ${rowOf(P2, 'payout')}, 'value', ${CBU('BNA')}), jsonb_build_object('row_number', ${rowOf(P3, 'payout')}, 'value', ${EXTERNAL})))::text`), 'OK:3');
expect('A-3 MP down at once by every net debit: 1,006 + 503 + 2,000 + 3,000 + 700 = 7,209', MPD('s0'), '-7209.00');
expect('A-4 pending classification: 5 outflows, in balance, net amount and economic amount', PEND,
  `OK:${O1}:OUTBOUND:OUT:-1006.00:1000.00:true,${O2}:OUTBOUND:OUT:-503.00:500.00:true,${P1}:PAYOUT:OUT:-2000.00:2000.00:true,${P2}:PAYOUT:OUT:-3000.00:3000.00:true,${P3}:PAYOUT:OUT:-700.00:700.00:true`);
expect('A-5 the provisional: ONE ADJUSTMENT MP-PENDING of the net, reconciled to the movement', OPS(O1), 'ADJUSTMENT:-1006.00:MP-PENDING');
expect('A-6 no purchase, no withdrawal, no supplier debt, no BNA credit, no P&L (provisional only)',
  `(coalesce(${delta('s0c')}, 'none') || '|' || ${BNAD('s0')} || '|' || (${PNLB('COSTOS_INDIRECTOS')}) || '|' || (${PNLB('RETIROS')}))`,
  '%financial_operation=5,financial_posting=5,%mp_reconciliation=5%|0.00|OK:0|OK:0');
expect('A-7 activity: payments / payouts PENDING_CLASSIFICATION; the reserve pair RESERVE (never pending)', ACT,
  `OK:${O1}:reserve_for_payment:RESERVE,${O1}:reserve_for_payment:RESERVE,${O1}:payment:PENDING_CLASSIFICATION,${O2}:payment:PENDING_CLASSIFICATION,`
  + `${P1}:payout:PENDING_CLASSIFICATION,${P2}:payout:PENDING_CLASSIFICATION,${P3}:payout:PENDING_CLASSIFICATION`);
expect('A-8 no technical exception; the report day is not INCOMPLETE', `(${TECH} || '|' || ${as('authenticated', ADMIN,
  `SELECT status || ':' || technical_count || ':' || pending_count FROM fin_mp_report_day_status WHERE run_id = ${P(RES('R'))}::uuid`)})`, 'OK:-|OK:%:0:5');
SNAP('s1');
expect('K-1 the same file again → replayed', NORMAL({ sha: sha('day'), actor: null, rows: rowsOf(DROWS) }), 'OK:%"replayed": true%');
expect('K-1b … nothing written', `coalesce(${delta('s1c')}, 'none')`, 'none');
expect('K-2 another report repeating the rows (ALREADY_KNOWN) → no second provisional', NORMAL({ sha: sha('day-again'), actor: null, rows: rowsOf(DROWS) }), 'OK:%"provisionals_posted": 0%"provisionals_not_posted": 0%');
expect('K-2b MP unchanged by both repeated reports', MPD('s1'), '0.00');
expect('K-3 recovery RPC on a posted SOURCE_ID → EXISTS, replayed', POSTP(O1), 'OK:%"outcome": "EXISTS"%"replayed": true%');
expect('K-4 operator / anon cannot post a provisional', `(${POSTP(O1, 'authenticated', OPER)} || '|' || ${POSTP(O1, 'anon', null)})`, 'ERR:FORBIDDEN%|ERR:permission denied%');
expect('K-5 a pending movement accepts no other reconciliation (MP_PENDING_NOT_RELEASED)', `pg_temp.err_of($q$INSERT INTO mp_reconciliation (mp_financial_movement_id, financial_operation_id, financial_account_id, assigned_amount, idempotency_key)
  SELECT ${MOVID(O2)}, (SELECT provisional_operation_id FROM mp_pending_outflow WHERE source_id = '${O1}'), ${MPACC}, -1, 'K5-PROBE'$q$)`, 'ERR:MP_PENDING_NOT_RELEASED%');
expect('K-6 every provisional operation is linked to its movement (SOURCE_ID invariant input)',
  `(SELECT count(*)::text FROM financial_operation o WHERE o.external_ref LIKE 'MP-PENDING:9300000%' AND NOT EXISTS (SELECT 1 FROM mp_reconciliation r WHERE r.financial_operation_id = o.id))`, '0');

// ── G. a period with pending classifications cannot be closed ──
expect('G-1 closing the period with pending classifications → PENDING_CLASSIFICATION (count, outgoing, incoming)',
  `pg_temp.err_of($q$UPDATE management_period SET status = 'CLOSED', closed_at = NOW() WHERE periodo_fecha = '2026-10-01'$q$)`,
  'ERR:PENDING_CLASSIFICATION: % movimiento(s) pendiente(s) de clasificar en el período 2026-10 (salidas %, entradas %). Clasificalos antes de cerrarlo.');
expect('G-2 the period stays OPEN', `(SELECT status::text FROM management_period WHERE periodo_fecha = '2026-10-01')`, 'OPEN');

// ── B / C. classify an outbound payment as a purchase: MP does not move again ──
SNAP('s2');
expect('B-1 O1 → Compra / gasto sin proveedor: economic 1,000', OUT(O1, 'CASUAL_PURCHASE', null, CAT, 'Combustible', 'EL KEROSENERO'), 'OK:%"amount": 1000.00%"replayed": false%');
expect('B-2 MP unchanged by the classification', MPD('s2'), '0.00');
expect('B-3 operations: provisional −1,006, its release +1,006, purchase −1,000, tax −6 (Σ = net −1,006)',
  `(${OPS(O1)} || ' Σ' || ${SUMREC(O1)})`, 'ADJUSTMENT:-1006.00:MP-PENDING ADJUSTMENT:1006.00:MP-PENDING-RELEASE PURCHASE_PAYMENT:-1000.00:MP-OUTFLOW ADJUSTMENT:-6.00:MP-OUTFLOW-TAX Σ-1006.00');
expect('B-4 purchase at the economic amount; P&L −1,000 once; tax not in the P&L',
  `((SELECT amount_total::text FROM purchases WHERE id = (SELECT purchase_id FROM mp_outflow_classification WHERE source_id = '${O1}')) || '|' || (${PNLB('COSTOS_INDIRECTOS')}))`, '1000.00|OK:-1000.00');
expect('B-5 pending resolved (route CASUAL_PURCHASE, audited); out of the pending view',
  `((SELECT route FROM mp_pending_outflow_resolution WHERE pending_id = (SELECT id FROM mp_pending_outflow WHERE source_id = '${O1}')) || '|'
    || (SELECT count(*) FROM audit_events WHERE entity_type = 'mp_pending_outflow' AND entity_id = (SELECT id::text FROM mp_pending_outflow WHERE source_id = '${O1}')) || '|'
    || (${PEND} NOT LIKE '%${O1}%'))`, 'CASUAL_PURCHASE|2|true');
SNAP('s3');
expect('C-1 exact replay → replayed', OUT(O1, 'CASUAL_PURCHASE', null, CAT, 'Combustible', 'EL KEROSENERO'), 'OK:%"replayed": true%');
expect('C-2 recovery RPC after classification → EXISTS (no new provisional)', POSTP(O1), 'OK:%"outcome": "EXISTS"%');
expect('C-3 the replay and the recovery call wrote nothing', `coalesce(${delta('s3c')}, 'none')`, 'none');

// ── E. payout to an own account confirmed as a transfer ──
SNAP('s4');
expect('E-1 P2 confirmed as transfer to BNA', CONFIRM(P2), 'OK:%"amount": 3000.00%"replayed": false%');
expect('E-2 MP unchanged; BNA +3,000 (the transfer credit)', `(${MPD('s4')} || '|' || ${BNAD('s4')})`, '0.00|3000.00');
expect('E-3 operations: provisional −3,000, release +3,000, TRANSFER −3,000; resolution OWN_TRANSFER',
  `(${OPS(P2)} || '|' || (SELECT route FROM mp_pending_outflow_resolution WHERE pending_id = (SELECT id FROM mp_pending_outflow WHERE source_id = '${P2}')))`,
  'ADJUSTMENT:-3000.00:MP-PENDING ADJUSTMENT:3000.00:MP-PENDING-RELEASE TRANSFER:-3000.00:MP-PAYOUT-TRANSFER|OWN_TRANSFER');
expect('E-4 confirmation replay → replayed', CONFIRM(P2), 'OK:%"replayed": true%');

// ── F. payouts classified as purchase / partner withdrawal; outbound with a registered supplier ──
SNAP('s5');
expect('F-1 P1 → Compra / gasto (casual)', OUT(P1, 'CASUAL_PURCHASE', null, CAT, 'Cartones', 'Proveedor de cartones'), 'OK:%"amount": 2000.00%');
expect('F-2 P3 → Retiro de socios', OUT(P3, 'OWNER_WITHDRAWAL'), 'OK:%"amount": 700.00%');
expect('F-3 O2 → Compra / gasto con proveedor (purchase + payment)', OUT(O2, 'EXPENSE', SUP, CAT, 'Honorarios'), 'OK:%"amount": 500.00%');
expect('F-4 MP unchanged by the three classifications', MPD('s5'), '0.00');
expect('F-5 P1 / P3 / O2 operations net to the report debit once',
  `(${SUMREC(P1)} || '|' || ${SUMREC(P3)} || '|' || ${SUMREC(O2)} || '|' || ${OPS(P3)})`,
  '-2000.00|-700.00|-503.00|ADJUSTMENT:-700.00:MP-PENDING ADJUSTMENT:700.00:MP-PENDING-RELEASE OWNER_WITHDRAWAL:-700.00:MGMT');
expect('F-6 supplier ledger nets 0 (purchase + payment); P&L: purchases 1,000 + 2,000 + 500, withdrawal 700',
  `((SELECT coalesce(sum(signed_amount), 0)::text FROM supplier_ledger WHERE supplier_id = '${SUP}') || '|' || (${PNLB('COSTOS_INDIRECTOS')}) || '|' || (${PNLB('RETIROS')}))`, '0.00|OK:-3500.00|OK:-700.00');
expect('F-7 nothing pending; MP total since the ingest = the 7,209 of net debits, once', `(${PEND} || '|' || ${MPD('s0')})`, 'OK:-|-7209.00');

// ── H. a period without pending closes as before (and then refuses writes) ──
expect('H-1 closing a period with zero pending → allowed', `pg_temp.err_of($q$UPDATE management_period SET status = 'CLOSED', closed_at = NOW() WHERE periodo_fecha = '2027-01-01'$q$)`, 'OK');
expect('H-2 the closed period refuses writes (PERIOD_CLOSED, unchanged)', `pg_temp.err_of($q$SELECT assert_period_open('2027-01-15')$q$)`, 'ERR:PERIOD_CLOSED%');

// ── J. a provisional that cannot be posted is a technical exception; the day is not reconciled; recovery ──
const JDAY = '2027-02-10';
const JP = '930000000301';
const JROWS = [{ ...CTL, DATE: `${JDAY}T00:00:00.000-03:00` },
  { ...mv('06:00:00', JP, 'payout', '0.00', '450.00', '-450.00', '0.00', '0.00', 'available_money', ''), DATE: `${JDAY}T06:00:00.000-03:00`, TRANSACTION_APPROVAL_DATE: `${JDAY}T06:00:00.000-03:00` }, TOT];
add(`UPDATE management_period SET status = 'CLOSED', closed_at = NOW() WHERE periodo_fecha = '2027-02-01';`);
SNAP('s6');
const JRUN = (key) => as('service_role', null, captureCall({ sha: sha('jday'), rows: rowsOf(JROWS), fn: 'fin_ingest_mp_release_report' }).replace(new RegExp(`'${DAY}'::date`, 'g'), `'${JDAY}'::date`), key);
expect('J-1 the report of a closed period is still ingested (PARSED); 1 provisional not posted', JRUN('J'), 'OK:%"status": "PARSED"%"provisionals_posted": 0%"provisionals_not_posted": 1%');
expect('J-2 the evidence is kept; its appearance carries PROVISIONAL_NOT_POSTED; MP unchanged',
  `((SELECT review_code || ':' || (note LIKE 'PERIOD_CLOSED%') FROM fin_import_run_line WHERE run_id = ${RES('J')}::uuid AND raw_row ->> 'SOURCE_ID' = '${JP}') || '|' || ${MPD('s6')})`, 'PROVISIONAL_NOT_POSTED:true|0.00');
expect('J-3 technical review lists the unposted outflow; it is NOT a pending classification', `(${TECH} || '|' || ${PEND})`, `OK:UNPOSTED_OUTFLOW:${JP}:PROVISIONAL_NOT_POSTED|OK:-`);
expect('J-4 the report day is INCOMPLETE (never RECONCILED)', as('authenticated', ADMIN,
  `SELECT status || ':' || technical_count FROM fin_mp_report_day_status WHERE run_id = ${P(RES('J'))}::uuid`), 'OK:INCOMPLETE:1');
add(`UPDATE management_period SET status = 'OPEN', closed_at = NULL WHERE periodo_fecha = '2027-02-01';`);
expect('J-5 recovery after reopening: mp_post_pending_outflow → POSTED', POSTP(JP), 'OK:%"outcome": "POSTED"%');
expect('J-5b MP −450 once', MPD('s6'), '-450.00');
expect('J-6 no technical exception left; now pending classification', `(${TECH} || '|' || ${PEND})`, `OK:-|OK:${JP}:PAYOUT:OUT:-450.00:450.00:true`);
expect('J-7 an unposted outflow also blocks the period close (closing again with the pending → refused)',
  `pg_temp.err_of($q$UPDATE management_period SET status = 'CLOSED', closed_at = NOW() WHERE periodo_fecha = '2027-02-01'$q$)`, 'ERR:PENDING_CLASSIFICATION%');

// ── L. history: an outflow classified before ADR-021 (no provisional) keeps its behaviour ──
const LO = '930000000401';
const LROW = mv('07:00:00', LO, 'payment', '0.00', '201.20', '-200.00', '-1.20', '0.00');
add(`CREATE TEMP TABLE lsrc AS SELECT 1;`);
expect('L-1 a parked outbound row without provisional (pre-ADR-021 history)', as('service_role', null,
  `WITH s AS (INSERT INTO mp_source_record (source_type, external_id, event_data, occurred_at, occurred_date) VALUES ('csv_import', '${LO}:payment:D', ${lit(JSON.stringify(LROW))}::jsonb, '${DAY}T07:00:00-03:00', '${DAY}') RETURNING id)
   SELECT mp_normalize_source((SELECT id FROM s))::text`), 'OK:%');
SNAP('s7');
expect('L-2 classified as before: no provisional to release', OUT(LO, 'CASUAL_PURCHASE', null, CAT, 'Historia'), 'OK:%"replayed": false%');
expect('L-3a MP −201.20 once (purchase −200 + tax −1.20); no provisional / release', `(${MPD('s7')} || '|' || ${OPS(LO)})`, '-201.20|PURCHASE_PAYMENT:-200.00:MP-OUTFLOW ADJUSTMENT:-1.20:MP-OUTFLOW-TAX');
expect('L-3 the recovery RPC never adds a provisional to classified history → APPLIED', POSTP(LO), 'OK:%"outcome": "APPLIED"%');
expect('L-4 … and writes nothing (MP still −201.20 since the snapshot)', MPD('s7'), '-201.20');

// ── I / security / inventory ──
expect('I-1 reserve / control rows never post and never become pending',
  `(SELECT count(*)::text FROM mp_source_record s WHERE s.external_id LIKE '${O1}:reserve_for_payment:%' AND EXISTS (SELECT 1 FROM mp_financial_movement m JOIN mp_reconciliation r ON r.mp_financial_movement_id = m.id WHERE m.mp_source_record_id = s.id))`, '0');
expect('I-2 no duplicate postings', `(SELECT count(*)::text FROM (SELECT financial_operation_id, financial_account_id, signed_amount FROM financial_posting GROUP BY 1, 2, 3 HAVING count(*) > 1) x)`, '0');
expect('I-3 pending / resolution rows are immutable', `pg_temp.err_of($q$UPDATE mp_pending_outflow SET amount = -1 WHERE source_id = '${O1}'$q$)`, 'ERR:FIN_EVIDENCE_IMMUTABLE%');
expect('I-4 helpers INVOKER / guards DEFINER without API EXECUTE; recovery RPC for authenticated; SECURITY DEFINER set 93',
  `((SELECT string_agg(proname || '=' || prosecdef || has_function_privilege('authenticated', oid, 'EXECUTE') || has_function_privilege('anon', oid, 'EXECUTE'), ',' ORDER BY proname)
     FROM pg_proc WHERE proname IN ('mp_pending_outflow_post', 'mp_pending_outflow_release', 'mp_pending_classification_totals', 'mp_reconciliation_pending_guard', 'management_period_close_guard', 'mp_post_pending_outflow'))
     || '|' || (SELECT count(*) FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace))`,
  'management_period_close_guard=truefalsefalse,mp_pending_classification_totals=falsefalsefalse,mp_pending_outflow_post=falsefalsefalse,mp_pending_outflow_release=falsefalsefalse,mp_post_pending_outflow=truetruefalse,mp_reconciliation_pending_guard=truefalsefalse|93');
expect('I-5 mp_v4_verified() still false', `mp_v4_verified()::text`, 'false');

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
console.log(`\n  ══ ADR-021 0093 MP IMMEDIATE OUTFLOW RESULT: ${pass} passed, ${fail} failed ══\n`);
process.exit(fail === 0 ? 0 : 1);
