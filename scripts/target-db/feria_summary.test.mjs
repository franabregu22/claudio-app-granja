#!/usr/bin/env node
/**
 * ADR-016 — FERIA V1 SUMMARIZED CLOSING (migration 0070). LOCAL TEST DATABASE ONLY.
 *
 * RPC 51 close_feria_summary and RPC 52 rectify_feria_closing over sales_session_closing,
 * treasury (financial_posting), the CONSUMIDOR FINAL client ledger, the P&L views
 * (pnl_line_item / pnl_summary: "Gastos de Feria", "Diferencia de caja"), report_feria_closing
 * and the private Storage bucket `feria-worksheets`.
 *
 * Every scenario runs inside ONE transaction that ends in ROLLBACK: fixtures (accounts,
 * session) are created inside it, so nothing is left behind.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" node scripts/target-db/feria_summary.test.mjs
 */
import { spawnSync } from 'node:child_process';
import { assertSafeDestructiveTarget } from '../test-env/guard.mjs';

assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);
const container = (spawnSync('docker', ['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout || '').trim().split('\n')[0];
if (!container) { console.error('no local supabase_db container'); process.exit(1); }

const ADMIN = '11111111-1111-1111-1111-111111111111';
const OPA = '22222222-2222-2222-2222-222222222222';
const DAY = '2026-09-12';
const PERIOD = '2026-09-01';

function run(sql) {
  const r = spawnSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    { encoding: 'utf8', input: sql, maxBuffer: 16 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
let pass = 0; let fail = 0;
const check = (label, cond, detail = '') => { if (cond) { pass++; console.log(`    OK   ${label}`); } else { fail++; console.log(`    MAL  ${label} :: ${String(detail).slice(0, 300)}`); } };

const as = (uid) => `SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claims" = '{"sub":"${uid}","role":"authenticated"}';`;
const owner = 'RESET ROLE;';

// fixtures inside the transaction: two cash-type accounts, a bank account, an OPEN session
const FIX = `
INSERT INTO auth.users (id, is_sso_user, is_anonymous) VALUES ('${ADMIN}', false, false), ('${OPA}', false, false) ON CONFLICT (id) DO NOTHING;
INSERT INTO perfiles (id, email, rol_type, activo) VALUES ('${ADMIN}', 'admin@example.invalid', 'ADMIN', true), ('${OPA}', 'opa@example.invalid', 'OPERATOR', true) ON CONFLICT (id) DO NOTHING;
UPDATE management_period SET status = 'OPEN', closed_at = NULL WHERE periodo_fecha = '${PERIOD}';
INSERT INTO financial_account (id, nombre, account_type) VALUES
  ('a7000000-0000-0000-0000-000000000001', 'P70-TEST Caja', 'CASH'),
  ('a7000000-0000-0000-0000-000000000002', 'P70-TEST Caja 2', 'CASH'),
  ('a7000000-0000-0000-0000-000000000003', 'P70-TEST Banco', 'BANK_ACCOUNT');
INSERT INTO sales_session (id, session_date, location, idempotency_key, opened_by)
VALUES ('5e700000-0000-0000-0000-000000000001', '${DAY}', 'P70-TEST', 'P70-TEST:s1', '${ADMIN}');
CREATE TEMP TABLE t_before ON COMMIT DROP AS
  SELECT (SELECT coalesce(sum(signed_amount), 0) FROM client_ledger l JOIN clients c ON c.id = l.cliente_id WHERE c.nombre = 'CONSUMIDOR FINAL') AS cf_balance;
GRANT SELECT ON t_before TO authenticated;
`;
const S = "'5e700000-0000-0000-0000-000000000001'";
const CAJA = "'a7000000-0000-0000-0000-000000000001'";
const CAJA2 = "'a7000000-0000-0000-0000-000000000002'";
const BANCO = "'a7000000-0000-0000-0000-000000000003'";
const MP_ACC = "(SELECT id FROM financial_account WHERE nombre = 'Mercado Pago')";

const close = (cash, mp, trf, exp, counted, { flt = 0, trfAcc = 'NULL', acc = CAJA, ws = 'NULL', merma = 'NULL', notes = 'NULL' } = {}) =>
  `SELECT close_feria_summary(${S}, ${cash}, ${mp}, ${trf}, ${exp}, ${counted}, ${acc}, ${trfAcc}, ${flt}, ${merma}, ${notes}, ${ws});`;
const cur = `(SELECT id FROM sales_session_closing WHERE sales_session_id = ${S} AND is_current)`;
const bal = (acc) => `(SELECT coalesce(sum(p.signed_amount), 0) FROM financial_posting p WHERE p.financial_account_id = ${acc})`;
const cf = `((SELECT coalesce(sum(signed_amount), 0) FROM client_ledger l JOIN clients c ON c.id = l.cliente_id WHERE c.nombre = 'CONSUMIDOR FINAL') - (SELECT cf_balance FROM t_before))`;
const pnl = (bucket) => `(SELECT coalesce(sum(signed_amount), 0) FROM pnl_line_item WHERE bucket = '${bucket}' AND business_date = '${DAY}'
  AND (source_entity_type = 'sales_session_closing' OR source_entity_id IN (SELECT aggregated_pedido_id::TEXT FROM sales_session_closing WHERE sales_session_id = ${S})))`;
const ventas = pnl('VENTAS_NETAS');

/** run the body in one rolled-back transaction; returns the output lines */
function scenario(body) {
  const r = run(`BEGIN;\n${FIX}\n${body}\nROLLBACK;`);
  return r.ok ? { ok: true, lines: r.out.split('\n').filter((l) => l !== '') } : { ok: false, err: r.err };
}
const expectRow = (label, body, expected) => {
  const r = scenario(body);
  check(label, r.ok && r.lines[r.lines.length - 1] === expected, r.ok ? `got ${r.lines[r.lines.length - 1]} expected ${expected}` : r.err);
};
const expectErr = (label, body, re) => {
  const r = scenario(body);
  check(label, !r.ok && re.test(r.err), r.ok ? 'no error' : r.err.split('\n')[0]);
};

console.log('\n  [inventory]');
{
  const r = run(`SELECT (SELECT count(*) FROM products WHERE is_system)||'|'||(SELECT count(*) FROM expense_category WHERE nombre='Gastos de Feria')||'|'
    ||(SELECT string_agg(proname||':'||prosecdef||':'||has_function_privilege('anon',oid,'EXECUTE')||':'||has_function_privilege('authenticated',oid,'EXECUTE'), ',' ORDER BY proname) FROM pg_proc WHERE proname IN ('close_feria_summary','rectify_feria_closing') AND pronamespace='public'::regnamespace)||'|'
    ||(SELECT relrowsecurity FROM pg_class WHERE oid='public.sales_session_closing'::regclass)||'|'
    ||has_table_privilege('anon','sales_session_closing','SELECT')||':'||has_table_privilege('authenticated','sales_session_closing','INSERT')||':'||has_table_privilege('authenticated','sales_session_closing','SELECT')||'|'
    ||(SELECT count(*) FROM migration_ledger.applied WHERE filename='0070_feria_summary_closing.sql');`);
  check('I1 one system product, "Gastos de Feria" category, RPC 51/52 definer, anon denied, authenticated EXECUTE, RLS, SELECT-only grant, 0070 in ledger',
    r.out === '1|1|close_feria_summary:true:false:true,rectify_feria_closing:true:false:true|true|false:false:true|1', r.out || r.err);
}

console.log('\n  [closing variants]');
expectRow('C1 cash-only: total, expected, diff 0; caja = counted − float; CF balance 0; ventas once',
  `${as(ADMIN)} ${close(1000, 0, 0, 0, 1000)} ${owner}
   SELECT ${bal(CAJA)}||'|'||${cf}||'|'||${ventas}||'|'||(SELECT total_sales||'/'||expected_cash||'/'||cash_difference FROM report_feria_closing WHERE closing_id=${cur});`,
  '1000.00|0.00|1000.00|1000.00/1000.00/0.00');
expectRow('C2 MP-only: no collection, no posting anywhere, CF receivable = MP amount (left to ADR-006), ventas = MP',
  `${as(ADMIN)} ${close(0, 750, 0, 0, 0)} ${owner}
   SELECT ${bal(CAJA)}||'|'||${bal(MP_ACC)}||'|'||${cf}||'|'||${ventas}||'|'||(SELECT count(*) FROM collections WHERE sales_session_id=${S});`,
  '0|0|750.00|750.00|0');
expectRow('C3 transfer-only: posts only to the transfer account; caja untouched; CF 0',
  `${as(ADMIN)} ${close(0, 0, 500, 0, 0, { trfAcc: BANCO })} ${owner}
   SELECT ${bal(CAJA)}||'|'||${bal(BANCO)}||'|'||${cf}||'|'||(SELECT payment_method FROM collections WHERE sales_session_id=${S});`,
  '0|500.00|0.00|TRANSFER');
expectRow('C4 mixed + float 200 + expenses 150, exact count: caja = counted − float; banco = transfer; CF = MP; ventas = total',
  `${as(ADMIN)} ${close(1000, 300, 400, 150, 1050, { flt: 200, trfAcc: BANCO })} ${owner}
   SELECT ${bal(CAJA)}||'|'||${bal(BANCO)}||'|'||${cf}||'|'||${ventas}||'|'||(SELECT expected_cash||'/'||counted_cash||'/'||cash_difference FROM report_feria_closing WHERE closing_id=${cur});`,
  '850.00|400.00|300.00|1700.00|1050.00/1050.00/0.00');
expectRow('C5 shortage: diff −30 posted once; caja = counted − float; P&L DIFERENCIA_CAJA −30',
  `${as(ADMIN)} ${close(1000, 0, 0, 100, 1070, { flt: 200 })} ${owner}
   SELECT ${bal(CAJA)}||'|'||(SELECT cash_difference FROM report_feria_closing WHERE closing_id=${cur})||'|'||${pnl('DIFERENCIA_CAJA')}||'|'||(SELECT count(*) FROM financial_operation WHERE operation_type='ADJUSTMENT' AND external_ref LIKE 'FERIA:%:DIFF');`,
  '870.00|-30.00|-30.00|1');
expectRow('C6 overage: diff +25; P&L DIFERENCIA_CAJA +25; caja = counted',
  `${as(ADMIN)} ${close(500, 0, 0, 0, 525)} ${owner}
   SELECT ${bal(CAJA)}||'|'||${pnl('DIFERENCIA_CAJA')};`,
  '525.00|25.00');
expectRow('C7 exact count: no difference operation, no DIFERENCIA_CAJA line',
  `${as(ADMIN)} ${close(500, 0, 0, 0, 500)} ${owner}
   SELECT (SELECT count(*) FROM financial_operation WHERE external_ref LIKE 'FERIA:%:DIFF')||'|'||(SELECT count(*) FROM pnl_line_item WHERE bucket='DIFERENCIA_CAJA' AND business_date='${DAY}');`,
  '0|0');
expectRow('C8 nonzero float is not revenue and has no posting: ventas = sales only; caja = counted − float',
  `${as(ADMIN)} ${close(300, 0, 0, 0, 800, { flt: 500 })} ${owner}
   SELECT ${ventas}||'|'||${bal(CAJA)}||'|'||${pnl('DIFERENCIA_CAJA')};`,
  '300.00|300.00|0');
expectRow('C9 expenses: one SESSION_CASH operation, P&L "Gastos de Feria" once (COSTOS_INDIRECTOS)',
  `${as(ADMIN)} ${close(1000, 0, 0, 120, 880)} ${owner}
   SELECT (SELECT count(*) FROM financial_operation WHERE operation_type='SESSION_CASH' AND external_ref LIKE 'FERIA:%:EXP')||'|'
     ||(SELECT count(*)||'/'||sum(signed_amount) FROM pnl_line_item WHERE source_entity_type='sales_session_closing' AND bucket='COSTOS_INDIRECTOS' AND description='Gastos de Feria');`,
  '1|1/-120.00');
expectRow('C10 counted cash is the treasury authority for the destination (other caja untouched; selectable destination)',
  `${as(ADMIN)} ${close(800, 0, 0, 50, 760, { acc: CAJA2, flt: 10 })} ${owner}
   SELECT ${bal(CAJA)}||'|'||${bal(CAJA2)};`,
  '0|750.00');
expectRow('C11 session CLOSED, aggregated pedido one system line, delivered on the Feria date',
  `${as(ADMIN)} ${close(100, 200, 0, 0, 100)} ${owner}
   SELECT s.estado||'|'||p.estado||'|'||p.delivered_date||'|'||(SELECT count(*) FROM pedido_lineas l JOIN products pr ON pr.id=l.producto_id WHERE l.pedido_id=p.id AND l.is_current AND pr.is_system)||'|'||p.is_aggregated_retail
     FROM sales_session s JOIN pedidos p ON p.id = s.aggregated_pedido_id WHERE s.id=${S};`,
  `CLOSED|DELIVERED|${DAY}|1|true`);
expectRow('C12 all-zero closing: no pedido, no operations, session closed',
  `${as(ADMIN)} ${close(0, 0, 0, 0, 0)} ${owner}
   SELECT (SELECT estado FROM sales_session WHERE id=${S})||'|'||(SELECT aggregated_pedido_id IS NULL FROM sales_session_closing WHERE id=${cur})||'|'||(SELECT count(*) FROM financial_operation WHERE external_ref LIKE 'FERIA:%');`,
  'CLOSED|true|0');
expectRow('C13 merma, notes and worksheet metadata stored; report shows has_worksheet',
  `${as(ADMIN)} ${close(10, 0, 0, 0, 10, { merma: 3, notes: "'nota'", ws: `'{"storage_path":"${ADMIN}/x.pdf","file_name":"x.pdf","content_type":"application/pdf","byte_size":1234}'` })} ${owner}
   SELECT merma||'|'||notes||'|'||has_worksheet||'|'||worksheet_file_name FROM report_feria_closing WHERE closing_id=${cur};`,
  '3.00|nota|true|x.pdf');

console.log('\n  [validation]');
expectErr('V1 already-closed session rejected', `${as(ADMIN)} ${close(1, 0, 0, 0, 1)} ${close(1, 0, 0, 0, 1)}`, /SESSION_ALREADY_CLOSED/);
expectErr('V2 transfer > 0 without account rejected', `${as(ADMIN)} ${close(0, 0, 5, 0, 0)}`, /TRANSFER_ACCOUNT_REQUIRED/);
expectErr('V3 MP account as physical destination rejected', `${as(ADMIN)} ${close(5, 0, 0, 0, 5, { acc: MP_ACC })}`, /CASH_ACCOUNT_INVALID/);
expectErr('V4 negative amount rejected', `${as(ADMIN)} ${close(-1, 0, 0, 0, 0)}`, /INVALID_AMOUNT/);
expectErr('V5 session with granular cash events rejected (no mixing)',
  `INSERT INTO sales_session_cash_event (sales_session_id, event_type, amount, event_date, created_by) VALUES (${S}, 'COUNT', 1, '${DAY}', '${ADMIN}'); ${as(ADMIN)} ${close(1, 0, 0, 0, 1)}`, /LEGACY_CASH_EVENTS_PRESENT/);
expectErr('V6 bad worksheet MIME rejected', `${as(ADMIN)} ${close(1, 0, 0, 0, 1, { ws: `'{"storage_path":"a/b","file_name":"b","content_type":"text/plain","byte_size":1}'` })}`, /INVALID_WORKSHEET/);
expectErr('V7 worksheet > 10 MB rejected', `${as(ADMIN)} ${close(1, 0, 0, 0, 1, { ws: `'{"storage_path":"a/b","file_name":"b","content_type":"image/png","byte_size":10485761}'` })}`, /INVALID_WORKSHEET/);
expectErr('V8 closed period rejected',
  `UPDATE management_period SET status='CLOSED', closed_at=now() WHERE periodo_fecha='${PERIOD}'; ${as(ADMIN)} ${close(1, 0, 0, 0, 1)}`, /PERIOD|CLOSED/i);

console.log('\n  [rectification]');
const rect = (reason, cash, mp, trf, exp, counted, { flt = 0, trfAcc = 'NULL', acc = CAJA, ws = 'NULL', keep = 'true' } = {}) =>
  `SELECT rectify_feria_closing(${cur}, ${reason}, ${cash}, ${mp}, ${trf}, ${exp}, ${counted}, ${acc}, ${trfAcc}, ${flt}, NULL, NULL, ${ws}, ${keep});`;
expectRow('R1 original preserved, new version current, chain + reason, only one current',
  `${as(ADMIN)} ${close(1000, 0, 0, 0, 1000)} ${rect("'error de tipeo'", 900, 0, 0, 0, 900)} ${owner}
   SELECT (SELECT count(*) FROM sales_session_closing WHERE sales_session_id=${S})||'|'||(SELECT count(*) FROM sales_session_closing WHERE sales_session_id=${S} AND is_current)||'|'
     ||(SELECT version_seq||'/'||rectification_reason||'/'||(supersedes_id IS NOT NULL) FROM sales_session_closing WHERE id=${cur})||'|'
     ||(SELECT cash_sales FROM sales_session_closing WHERE sales_session_id=${S} AND version_seq=0);`,
  '2|1|1/error de tipeo/true|1000.00');
expectErr('R2 reason mandatory', `${as(ADMIN)} ${close(10, 0, 0, 0, 10)} ${rect("' '", 5, 0, 0, 0, 5)}`, /REASON_REQUIRED/);
expectErr('R3 superseded version cannot be rectified',
  `${as(ADMIN)} ${close(10, 0, 0, 0, 10)} CREATE TEMP TABLE t_old AS SELECT ${cur} AS id; ${rect("'r'", 5, 0, 0, 0, 5)}
   SELECT rectify_feria_closing((SELECT id FROM t_old), 'r2', 1, 0, 0, 0, 1, ${CAJA}, NULL, 0, NULL, NULL, NULL, true);`, /CLOSING_SUPERSEDED/);
expectRow('R4 treasury compensated: caja/banco end at the new values only; CF = new MP',
  `${as(ADMIN)} ${close(1000, 300, 400, 150, 1050, { flt: 200, trfAcc: BANCO })}
   ${rect("'corrección'", 800, 100, 0, 50, 900, { flt: 100 })} ${owner}
   SELECT ${bal(CAJA)}||'|'||${bal(BANCO)}||'|'||${cf};`,
  '800.00|0.00|100.00');
expectRow('R5 P&L effective values only: ventas = new total, Gastos de Feria = new, DIFERENCIA_CAJA = new (no double counting)',
  `${as(ADMIN)} ${close(1000, 0, 0, 100, 880)} ${rect("'r'", 700, 0, 0, 40, 670)} ${owner}
   SELECT ${ventas}||'|'||(SELECT sum(signed_amount) FROM pnl_line_item WHERE source_entity_type='sales_session_closing' AND description='Gastos de Feria')||'|'||${pnl('DIFERENCIA_CAJA')};`,
  '700.00|-40.00|10.00');
expectRow('R6 report shows every version; current one flagged; pedido corrected through RPC 2 (versioned lines)',
  `${as(ADMIN)} ${close(1000, 0, 0, 0, 1000)} ${rect("'r'", 600, 0, 0, 0, 600)}
   SELECT (SELECT count(*) FROM report_feria_closing WHERE sales_session_id=${S})||'|'||(SELECT total_sales FROM report_feria_closing WHERE sales_session_id=${S} AND is_current)||'|'
     ||(SELECT count(*) FROM pedido_lineas l JOIN sales_session s ON s.aggregated_pedido_id=l.pedido_id WHERE s.id=${S});`,
  '2|600.00|2');
expectRow('R7 rectify from zero total creates + delivers the pedido',
  `${as(ADMIN)} ${close(0, 0, 0, 0, 0)} ${rect("'faltó cargar'", 200, 0, 0, 0, 200)} ${owner}
   SELECT ${ventas}||'|'||(SELECT p.estado FROM sales_session s JOIN pedidos p ON p.id=s.aggregated_pedido_id WHERE s.id=${S});`,
  '200.00|DELIVERED');
expectRow('R8 worksheet history: previous version keeps its file; keep=true carries it; a new file replaces it on the new version only',
  `${as(ADMIN)} ${close(10, 0, 0, 0, 10, { ws: `'{"storage_path":"${ADMIN}/a.pdf","file_name":"a.pdf","content_type":"application/pdf","byte_size":5}'` })}
   ${rect("'r1'", 10, 0, 0, 0, 10)}
   ${rect("'r2'", 10, 0, 0, 0, 10, { ws: `'{"storage_path":"${ADMIN}/b.png","file_name":"b.png","content_type":"image/png","byte_size":6}'` })}
   SELECT string_agg(version_seq||':'||worksheet_file_name, ',' ORDER BY version_seq) FROM sales_session_closing WHERE sales_session_id=${S};`,
  '0:a.pdf,1:a.pdf,2:b.png');
expectRow('R9 transfer reversal: client_ledger REVERSAL rows reference the original COLLECTION rows',
  `${as(ADMIN)} ${close(100, 0, 50, 0, 100, { trfAcc: BANCO })} ${rect("'r'", 100, 0, 0, 0, 100)} ${owner}
   SELECT count(*) FROM client_ledger WHERE movement_type='REVERSAL' AND source_entity_type='sales_session_closing' AND reversal_of_id IS NOT NULL;`,
  '2');

console.log('\n  [P&L summary]');
expectRow('P1 pnl_summary: diferencia_caja column, part of resultado_operativo',
  `${as(ADMIN)} ${close(1000, 0, 0, 100, 880)}
   SELECT diferencia_caja||'|'||(resultado_operativo - ventas_netas_devengadas - costos_directos - costos_indirectos = diferencia_caja) FROM pnl_summary WHERE period='${PERIOD}';`,
  '-20.00|true');
expectRow('P2 operating result moves exactly by sales − expenses + difference (MP counted once, float none)',
  `   ${as(ADMIN)} CREATE TEMP TABLE t_p0 AS SELECT coalesce((SELECT resultado_operativo FROM pnl_summary WHERE period='${PERIOD}'), 0) AS r0;
   ${close(1000, 400, 0, 100, 1080, { flt: 200 })}
   SELECT coalesce((SELECT resultado_operativo FROM pnl_summary WHERE period='${PERIOD}'), 0) - (SELECT r0 FROM t_p0);`,
  '1280.00');

console.log('\n  [security]');
expectErr('S1 OPERATOR denied close', `${as(OPA)} ${close(1, 0, 0, 0, 1)}`, /FORBIDDEN/);
expectErr('S2 OPERATOR denied rectify', `${as(ADMIN)} ${close(1, 0, 0, 0, 1)} ${owner} ${as(OPA)} ${rect("'r'", 1, 0, 0, 0, 1)}`, /FORBIDDEN/);
expectErr('S3 anon denied (privilege)', `SET LOCAL ROLE anon; ${close(1, 0, 0, 0, 1)}`, /permission denied/);
expectRow('S4 OPERATOR reads no closing rows / report rows',
  `${as(ADMIN)} ${close(1, 0, 0, 0, 1)} ${owner} ${as(OPA)}
   SELECT (SELECT count(*) FROM sales_session_closing)||'|'||(SELECT count(*) FROM report_feria_closing);`, '0|0');
expectErr('S5 direct INSERT into sales_session_closing denied to ADMIN',
  `${as(ADMIN)} INSERT INTO sales_session_closing (sales_session_id, closing_date, counted_cash, cash_account_id, expense_category_id) VALUES (${S}, '${DAY}', 0, ${CAJA}, (SELECT id FROM expense_category LIMIT 1));`, /permission denied/);

console.log('\n  [storage]');
{
  const r = run(`SELECT public||'|'||file_size_limit||'|'||array_to_string(allowed_mime_types, ',') FROM storage.buckets WHERE id='feria-worksheets';
    SELECT count(*) FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname LIKE 'feria_worksheets_%';
    SELECT count(*) FROM storage.buckets WHERE id='purchase-attachments';`);
  check('ST1 bucket private, 10 MB, PDF/JPEG/PNG/WebP; 3 ADMIN policies; purchase-attachments untouched',
    r.out === 'false|10485760|application/pdf,image/jpeg,image/png,image/webp\n3\n1', r.out || r.err);
}
const obj = (uid, path) => `INSERT INTO storage.objects (bucket_id, name, owner_id) VALUES ('feria-worksheets', '${path}', '${uid}');`;
expectRow('ST2 ADMIN uploads into own folder', `${as(ADMIN)} ${obj(ADMIN, `${ADMIN}/p70.pdf`)} SELECT count(*) FROM storage.objects WHERE bucket_id='feria-worksheets' AND name='${ADMIN}/p70.pdf';`, '1');
expectErr('ST3 ADMIN cannot upload into another folder', `${as(ADMIN)} ${obj(ADMIN, `${OPA}/p70.pdf`)}`, /row-level security/);
expectErr('ST4 OPERATOR cannot upload', `${as(OPA)} ${obj(OPA, `${OPA}/p70.pdf`)}`, /row-level security/);
expectRow('ST5 OPERATOR cannot read worksheets',
  `${obj(ADMIN, `${ADMIN}/p70r.pdf`)} ${as(OPA)} SELECT count(*) FROM storage.objects WHERE bucket_id='feria-worksheets';`, '0');
{
  const r = run(`SELECT cmd||':'||(qual LIKE '%feria-worksheets%' AND qual LIKE '%ADMIN%') FROM pg_policies WHERE schemaname='storage' AND policyname='feria_worksheets_admin_delete';`);
  check('ST6 ADMIN delete policy for compensation cleanup (the delete itself goes through the Storage API: integration suite)', r.out === 'DELETE:true', r.out || r.err);
}

console.log('\n  [legacy]');
expectRow('L1 legacy product-line sessions stay readable (report_feria_session_cash and sales_session as ADMIN)',
  `${as(ADMIN)} SELECT (SELECT count(*) >= 0 FROM report_feria_session_cash)||'|'||(SELECT count(*) >= 1 FROM sales_session);`, 'true|true');

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
