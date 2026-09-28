#!/usr/bin/env node
/**
 * ADR-006 Step 7 — atomic financial application (0051): A1 mp_apply_transition, the RPC 41
 * AUTO_APPLICATION_PENDING guard, R2 mp_normalize_report_fallback + its internal helper.
 *
 * Run:  TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *         node scripts/target-db/mp_atomic_application.test.mjs
 *
 * Authority: ADR006_RPC_CONTRACTS_V1 A1 / §41 / R2; ADR006_TEST_MATRIX_V1 T, C (C-1, C-2, C-14), M-3, M-6, M-6b.
 * Movements come from the real pipeline (S4 + RPC 40 for api_payment; RPC 40 for Liberaciones rows).
 * OWNER-built rows are used only for structural cases no pipeline can produce (malformed movement,
 * refund kind, movement without transition) and for the V-4 test branch (R2), which runs inside a
 * rolled-back transaction with mp_v4_verified() redefined locally. mp_v4_verified() stays false.
 * Synthetic ids only (777… payments, 8877… report rows); dates in 2026-11 (T-7 closes that period).
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertSafeDestructiveTarget } from '../test-env/guard.mjs';

function resolveDockerBin() {
  const onPath = spawnSync('docker', ['--version'], { encoding: 'utf8' });
  if (!onPath.error && onPath.status === 0) return 'docker';
  const c = resolve(process.env.LOCALAPPDATA ?? '', 'Programs', 'DockerDesktop', 'resources', 'bin', 'docker.exe');
  if (existsSync(c)) return c;
  throw new Error('docker not found');
}
const DOCKER = resolveDockerBin();
const ADMIN_UID = '11111111-1111-1111-1111-111111111111';
const TAG = 'S7T';
let pass = 0;
let fail = 0;
const failures = [];
const PSQL = ['psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'];
let container;
function raw(sqlText) {
  const r = spawnSync(DOCKER, ['exec', '-i', container, ...PSQL], { encoding: 'utf8', input: sqlText, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
function session(sqlText) {
  return new Promise((done) => {
    const p = spawn(DOCKER, ['exec', '-i', container, ...PSQL]);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => done({ ok: code === 0, out: out.trim(), err: err.trim() }));
    p.stdin.end(sqlText);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function owner(sqlText) { const r = raw(sqlText); if (!r.ok) throw new Error(`owner SQL failed:\n${sqlText}\n${r.err}`); return r.out; }
const esc = (s) => String(s).replace(/'/g, "''");
const q = (v) => (v === null || v === undefined ? 'NULL' : `'${esc(v)}'`);
const j = (o) => `${q(JSON.stringify(o))}::jsonb`;
const wrap = (role, claims, s) => `BEGIN;\nSET LOCAL ROLE ${role};\nSET LOCAL "request.jwt.claims" = '${esc(JSON.stringify(claims))}';\n${s}\nCOMMIT;`;
const SVCSQL = (s) => wrap('service_role', { role: 'service_role' }, s);
const ADMINSQL = (s) => wrap('authenticated', { sub: ADMIN_UID, role: 'authenticated' }, s);
const SVC = (s) => raw(SVCSQL(s));
const ADMIN = (s) => raw(ADMINSQL(s));
const AUTH = (s) => raw(wrap('authenticated', { sub: '22222222-2222-2222-2222-222222222222', role: 'authenticated' }, s));
const okAs = (fn, s) => { const r = fn(s); if (!r.ok) throw new Error(`SQL failed:\n${s}\n${r.err}`); return r.out; };
const rpc = (call) => JSON.parse(okAs(SVC, `SELECT ${call};`));
const raised = (r, code) => !r.ok && new RegExp(`ERROR:\\s+${code}`).test(r.err);
const denied = (r) => !r.ok && /permission denied/i.test(r.err);
const errOf = (r) => (r.err.split('\n').find((l) => /ERROR/.test(l)) || r.err).slice(0, 180);
function check(label, condition, detail) {
  if (condition) { pass += 1; console.log(`    OK   ${label}`); } else { fail += 1; failures.push(label); console.log(`    MAL  ${label}${detail !== undefined ? ` :: ${detail}` : ''}`); }
}
const section = (n, t) => console.log(`\n  ── ${n}. ${t} ${'─'.repeat(Math.max(0, 54 - t.length))}`);

// ── guard, container ─────────────────────────────────────────────────────────
const target = assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);
container = (spawnSync(DOCKER, ['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout || '').trim().split('\n').filter(Boolean)[0];
if (!container) { console.error('  no running supabase_db container'); process.exit(1); }
const mapping = (spawnSync(DOCKER, ['port', container, '5432/tcp'], { encoding: 'utf8' }).stdout || '').trim();
if (!mapping.includes(`:${target.port}`)) { console.error(`  container mapping ${mapping} does not match guarded port ${target.port}`); process.exit(1); }

const MPACC = owner(`SELECT id FROM financial_account WHERE nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE' AND activo;`);
const OTHER = owner(`SELECT id FROM financial_account WHERE activo AND id <> '${MPACC}' ORDER BY nombre LIMIT 1;`);

// ── lifecycle (FK-safe, owner) ───────────────────────────────────────────────
function cleanup() {
  owner(`
DROP TRIGGER IF EXISTS s7t_fault ON financial_posting;
DROP FUNCTION IF EXISTS s7t_fault_fn();
UPDATE management_period SET status = 'OPEN' WHERE periodo_fecha = '2026-11-01' AND status <> 'OPEN';
CREATE TEMP TABLE _src AS SELECT id FROM mp_source_record WHERE external_id LIKE 'MPPAY:777%' OR external_id LIKE '8877%' OR external_id LIKE '${TAG}-%';
CREATE TEMP TABLE _mv  AS SELECT id FROM mp_financial_movement WHERE mp_source_record_id IN (SELECT id FROM _src);
CREATE TEMP TABLE _op  AS SELECT financial_operation_id AS id FROM mp_reconciliation WHERE mp_financial_movement_id IN (SELECT id FROM _mv)
                    UNION SELECT id FROM financial_operation WHERE external_ref LIKE 'MP:MPA:%' AND source_entity_type = 'mp_financial_movement'
                                                              AND source_entity_id IN (SELECT id::TEXT FROM _mv)
                    UNION SELECT id FROM financial_operation WHERE reason LIKE '${TAG}%' OR external_ref LIKE '${TAG}%';
CREATE TEMP TABLE _dl  AS SELECT id FROM mp_webhook_delivery WHERE resource_id LIKE '777%';
CREATE TEMP TABLE _al  AS SELECT id FROM mp_client_allocation WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
DELETE FROM audit_events WHERE entity_type = 'mp_source_record' AND entity_id IN (SELECT id::TEXT FROM _src);
DELETE FROM audit_events WHERE entity_type = 'mp_financial_movement' AND entity_id IN (SELECT id::TEXT FROM _mv);
DELETE FROM audit_events WHERE entity_type = 'mp_webhook_delivery' AND entity_id IN (SELECT id::TEXT FROM _dl);
DELETE FROM audit_events WHERE entity_type = 'mp_reconciliation' AND entity_id IN (SELECT id::TEXT FROM mp_reconciliation WHERE mp_financial_movement_id IN (SELECT id FROM _mv));
DELETE FROM audit_events WHERE entity_type IN ('mp_client_allocation', 'client_ledger') AND entity_id IN (SELECT id::TEXT FROM _al);
DELETE FROM mp_client_allocation WHERE reversal_of_id IN (SELECT id FROM _al);
CREATE TEMP TABLE _cl AS SELECT client_ledger_id AS id FROM mp_client_allocation WHERE id IN (SELECT id FROM _al);
DELETE FROM mp_client_allocation WHERE id IN (SELECT id FROM _al);
DELETE FROM client_ledger WHERE id IN (SELECT id FROM _cl);
DELETE FROM mp_report_match WHERE report_source_id IN (SELECT id FROM _src)
   OR transition_id IN (SELECT id FROM mp_transition_identity WHERE mp_financial_movement_id IN (SELECT id FROM _mv));
DELETE FROM mp_reconciliation WHERE mp_financial_movement_id IN (SELECT id FROM _mv) OR financial_operation_id IN (SELECT id FROM _op);
DELETE FROM financial_posting WHERE financial_operation_id IN (SELECT id FROM _op);
DELETE FROM audit_events WHERE entity_type = 'financial_operation' AND entity_id IN (SELECT id::TEXT FROM _op);
DELETE FROM financial_operation WHERE id IN (SELECT id FROM _op);
DELETE FROM mp_transition_identity WHERE mp_financial_movement_id IN (SELECT id FROM _mv) OR resource_id LIKE '777%';
DELETE FROM mp_financial_movement WHERE id IN (SELECT id FROM _mv);
DELETE FROM mp_webhook_delivery WHERE id IN (SELECT id FROM _dl);
DELETE FROM mp_source_record WHERE id IN (SELECT id FROM _src);
DELETE FROM clients WHERE nombre LIKE '${TAG}%';`);
}
const snap = () => owner(`SELECT concat_ws('|',
  (SELECT count(*) FROM financial_operation), (SELECT count(*) FROM financial_posting), (SELECT count(*) FROM mp_reconciliation),
  (SELECT count(*) FROM audit_events), (SELECT count(*) FROM client_ledger), (SELECT count(*) FROM collections),
  (SELECT count(*) FROM mp_client_allocation), (SELECT count(*) FROM mp_financial_movement));`);
const mpBalance = () => Number(owner(`SELECT coalesce(sum(signed_amount), 0) FROM financial_posting WHERE financial_account_id = '${MPACC}';`));
const srcStatus = (mv) => owner(`SELECT s.processing_status FROM mp_source_record s JOIN mp_financial_movement m ON m.mp_source_record_id = s.id WHERE m.id = ${mv};`);
const opsOf = (mv) => owner(`SELECT coalesce(string_agg(concat_ws('|', o.operation_type, o.external_ref, p.signed_amount, p.financial_account_id = '${MPACC}', r.assigned_amount, r.idempotency_key,
    (SELECT count(*) FROM financial_posting pp WHERE pp.financial_operation_id = o.id)), ';' ORDER BY o.operation_type::TEXT), '-')
  FROM mp_reconciliation r JOIN financial_operation o ON o.id = r.financial_operation_id JOIN financial_posting p ON p.financial_operation_id = o.id
  WHERE r.mp_financial_movement_id = ${mv};`);
const tid = (mv) => owner(`SELECT id FROM mp_transition_identity WHERE mp_financial_movement_id = ${mv};`);

// ── api_payment pipeline (S4 + RPC 40) ───────────────────────────────────────
let seq = 0;
let nseq = 0;
const newPid = () => `777${String(Date.now()).slice(-6)}${String(++seq).padStart(3, '0')}`;
function apiPayment({ gross, fee = 0, net, day = '05', opType = 'money_transfer' }) {
  const pid = newPid();
  const at = `2026-11-${day}T10:00:00.000-04:00`;
  const pl = {
    id: Number(pid), operation_type: opType, status: 'approved', status_detail: 'accredited', currency_id: 'ARS', live_mode: true,
    collector_id: 100000001, payer: { id: '800000999' }, external_reference: null,
    date_created: at, date_approved: at, date_last_updated: at, transaction_amount: gross,
    transaction_details: { net_received_amount: net }, fee_details: fee ? [{ type: 'mercadopago_fee', amount: fee, fee_payer: 'collector' }] : [],
    refunds: [], transaction_amount_refunded: 0, taxes_amount: 0, charges_details: [],
  };
  rpc(`mp_register_delivery('webhook', 'payment', 'payment', 'payment.updated', ${q(pid)}, NULL, 'S7T-x', ${j({ notification_id: `s7t-${++nseq}-${Date.now()}` })}, true)`);
  const mine = okAs(SVC, `SELECT delivery_id || '|' || claim_token || '|' || coalesce(resource_id, '-') FROM mp_claim_deliveries(50, 120);`)
    .split('\n').filter(Boolean).map((l) => l.split('|')).find((r) => r[2] === pid);
  const ing = rpc(`mp_ingest_api_snapshot(${q(mine[0])}, ${q(mine[1])}, ${q(pid)}, ${j(pl)})`);
  const res = rpc(`mp_normalize_source(${q(ing.source_record_id)})`);
  if (res.processing_status !== 'NORMALIZED') throw new Error(`payment not normalized: ${JSON.stringify(res)}`);
  return Number(owner(`SELECT id FROM mp_financial_movement WHERE mp_source_record_id = ${q(ing.source_record_id)};`));
}
// ── Liberaciones rows through RPC 40 ─────────────────────────────────────────
const HDR = ['DATE', 'SOURCE_ID', 'DESCRIPTION', 'NET_CREDIT_AMOUNT', 'NET_DEBIT_AMOUNT', 'GROSS_AMOUNT', 'MP_FEE_AMOUNT', 'TAXES_AMOUNT',
  'PAYMENT_METHOD', 'TRANSACTION_APPROVAL_DATE', 'BUSINESS_UNIT', 'SUB_UNIT', 'BALANCE_AMOUNT', 'PAYMENT_METHOD_TYPE', 'PURCHASE_ID'];
const libRow = (date, sid, desc, cr, db, gross, fee, tax) => Object.fromEntries(HDR.map((h, i) => [h, [date, sid, desc, cr, db, gross, fee, tax, 'available_money', date, '', '', '0.00', '', TAG][i]]));
function libIngest(row) {
  const net = Number(row.NET_CREDIT_AMOUNT) - Number(row.NET_DEBIT_AMOUNT);
  const src = okAs(SVC, `INSERT INTO mp_source_record (source_type, external_id, event_data, occurred_at, occurred_date)
    VALUES ('csv_import', '${row.SOURCE_ID}:${row.DESCRIPTION}:${net > 0 ? 'C' : 'D'}', ${j(row)}, '${row.DATE}', (TIMESTAMPTZ '${row.DATE}' AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE) RETURNING id;`);
  rpc(`mp_normalize_source('${src}')`);
  return { src, mv: Number(owner(`SELECT coalesce((SELECT id FROM mp_financial_movement WHERE mp_source_record_id = '${src}'), 0);`)) };
}
let lseq = 0;
const libSid = () => `8877${String(Date.now()).slice(-7)}${String(++lseq).padStart(2, '0')}`;

cleanup();
check('S0 fixtures: the seeded MP account exists and 2026-11 is an OPEN management period',
  MPACC.length === 36 && owner(`SELECT status FROM management_period WHERE periodo_fecha = '2026-11-01';`) === 'OPEN');

// ═════════════════════════════════════════════════════════════════════════════
section('T', 'mp_apply_transition');
let P1;
{
  P1 = apiPayment({ gross: 100, fee: 5, net: 93 });
  const t1 = tid(P1);
  const s0 = snap();
  const b0 = mpBalance();
  const r = rpc(`mp_apply_transition(${P1})`);
  const s1 = snap().split('|').map(Number);
  const d = s1.map((v, i) => v - Number(s0.split('|')[i]));
  check('T-1 APPLIED: 3 operations MP_SETTLEMENT +100 / FEE −5 / ADJUSTMENT −2, each 1 posting on the MP account, external_refs MP:MPA:{t}:SETTLE/FEE/TAX, keys MPA:{t}:*',
    r.status === 'APPLIED' && opsOf(P1) === [`ADJUSTMENT|MP:MPA:${t1}:TAX|-2.00|t|-2.00|MPA:${t1}:TAX|1`, `FEE|MP:MPA:${t1}:FEE|-5.00|t|-5.00|MPA:${t1}:FEE|1`,
      `MP_SETTLEMENT|MP:MPA:${t1}:SETTLE|100.00|t|100.00|MPA:${t1}:SETTLE|1`].join(';'), `${JSON.stringify(r)} ${opsOf(P1)}`);
  check('T-1 Σ assigned = 93 = net; source RECONCILED; MP balance Δ +93', Number(owner(`SELECT sum(assigned_amount) FROM mp_reconciliation WHERE mp_financial_movement_id = ${P1};`)) === 93
    && srcStatus(P1) === 'RECONCILED' && Math.round((mpBalance() - b0) * 100) === 9300);
  check('T-1 Δ operation 3, posting 3, reconciliation 3, audit 1 (MP_APPLY_TRANSITION); client_ledger / collections / allocation Δ 0',
    d[0] === 3 && d[1] === 3 && d[2] === 3 && d[3] === 1 && d[4] === 0 && d[5] === 0 && d[6] === 0
      && owner(`SELECT count(*) FROM audit_events WHERE entity_type = 'mp_financial_movement' AND entity_id = '${P1}' AND action = 'MP_APPLY_TRANSITION';`) === '1', d.join(','));
  const s2 = snap();
  const r2 = rpc(`mp_apply_transition(${P1})`);
  check('T-3 exact replay → ALREADY_APPLIED; Δ every table = 0, audit included', r2.status === 'ALREADY_APPLIED' && snap() === s2, JSON.stringify(r2));
  check('C-1 after application the receipt has no allocation (CLIENT_UNASSIGNED)', owner(`SELECT count(*) FROM mp_client_allocation WHERE mp_financial_movement_id = ${P1};`) === '0');

  // T-4 mismatched replay: an ADMIN counter-assignment pair after application
  const P4 = apiPayment({ gross: 100, fee: 5, net: 93 });
  rpc(`mp_apply_transition(${P4})`);
  okAs(ADMIN, `SELECT mp_reconcile_movement(${P4}, -1, '${TAG}-t4a-${P4}', '${MPACC}', 'ADJUSTMENT', NULL, '${TAG} counter');`);
  okAs(ADMIN, `SELECT mp_reconcile_movement(${P4}, 1, '${TAG}-t4b-${P4}', '${MPACC}', 'FEE', NULL, '${TAG} counter');`);
  const s4 = snap();
  const r4 = SVC(`SELECT mp_apply_transition(${P4});`);
  check('T-4 after an RPC 41 counter-assignment pair → TRANSITION_ALREADY_ASSIGNED; Δ = 0; source still RECONCILED',
    raised(r4, 'TRANSITION_ALREADY_ASSIGNED') && snap() === s4 && srcStatus(P4) === 'RECONCILED', errOf(r4));

  // T-2 sequential RPC 41 cannot replace A1
  const P2 = apiPayment({ gross: 100, fee: 5, net: 93 });
  const r2a = ADMIN(`SELECT mp_reconcile_movement(${P2}, 100, '${TAG}-t2-${P2}', '${MPACC}', 'MP_SETTLEMENT', NULL, 'x');`);
  const r2s = SVC(`SELECT mp_reconcile_movement(${P2}, 100, '${TAG}-t2s-${P2}', '${MPACC}', 'MP_SETTLEMENT', NULL, 'x');`);
  const o2 = owner(`INSERT INTO mp_source_record (source_type, external_id, event_data, occurred_at, occurred_date, processing_status)
    VALUES ('csv_import', '${TAG}-t2-plain', '{}'::jsonb, '2026-11-06T10:00:00-03:00', '2026-11-06', 'NORMALIZED') RETURNING id;`);
  const plainMv = owner(`INSERT INTO mp_financial_movement (mp_source_record_id, movement_kind, gross_amount, fee_amount, tax_amount, net_amount, occurred_date)
    VALUES ('${o2}', 'payment', 100, -5, -2, 93, '2026-11-06') RETURNING id;`);
  const r2b = ADMIN(`SELECT mp_reconcile_movement(${plainMv}, 100, '${TAG}-t2p-${plainMv}', '${MPACC}', 'MP_SETTLEMENT', NULL, 'x');`);
  const r2c = rpc(`mp_apply_transition(${P2})`);
  check('T-2 / T-11 RPC 41 +100 on the auto-applicable movement (ADMIN and service role) → AUTO_APPLICATION_PENDING; on a non-transition movement the per-request cap → OVER_ASSIGNMENT; A1 applies it',
    raised(r2a, 'AUTO_APPLICATION_PENDING') && raised(r2s, 'AUTO_APPLICATION_PENDING') && raised(r2b, 'OVER_ASSIGNMENT') && r2c.status === 'APPLIED',
    `${errOf(r2a)} / ${errOf(r2b)}`);
  check('T-11b after A1, a further manual MP_SETTLEMENT on the applied movement is refused by the cap (no duplicate treasury effect)',
    raised(ADMIN(`SELECT mp_reconcile_movement(${P2}, 1, '${TAG}-t11b-${P2}', '${MPACC}', 'MP_SETTLEMENT', NULL, 'x');`), 'OVER_ASSIGNMENT'));

  // T-5 orphan external_ref
  const P5 = apiPayment({ gross: 100, fee: 5, net: 93 });
  const t5 = tid(P5);
  owner(`INSERT INTO financial_operation (operation_type, effective_date, external_ref, reason) VALUES ('FEE', '2026-11-05', 'MP:MPA:${t5}:FEE', '${TAG} orphan');`);
  const s5 = snap();
  const r5 = SVC(`SELECT mp_apply_transition(${P5});`);
  check('T-5 pre-existing MP:MPA:{t}:FEE without reconciliation → EXTERNAL_REF_CONFLICT; Δ = 0; source still NORMALIZED',
    raised(r5, 'EXTERNAL_REF_CONFLICT') && snap() === s5 && srcStatus(P5) === 'NORMALIZED', errOf(r5));

  // T-6 fault injection on the 3rd posting
  const P6 = apiPayment({ gross: 100, fee: 5, net: 92.63 }); // tax −2.37
  owner(`CREATE FUNCTION s7t_fault_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
           IF NEW.signed_amount = -2.37 THEN RAISE EXCEPTION 'S7T_FAULT'; END IF; RETURN NEW; END $$;
         CREATE TRIGGER s7t_fault BEFORE INSERT ON financial_posting FOR EACH ROW EXECUTE FUNCTION s7t_fault_fn();`);
  const s6 = snap();
  const b6 = mpBalance();
  const r6 = SVC(`SELECT mp_apply_transition(${P6});`);
  const after6 = snap();
  owner('DROP TRIGGER IF EXISTS s7t_fault ON financial_posting; DROP FUNCTION IF EXISTS s7t_fault_fn();');
  check('T-6 failure on the 3rd posting → whole application rolled back: Δ operation / posting / reconciliation / audit = 0; balance unchanged; source NORMALIZED',
    !r6.ok && /S7T_FAULT/.test(r6.err) && after6 === s6 && mpBalance() === b6 && srcStatus(P6) === 'NORMALIZED' && opsOf(P6) === '-', errOf(r6));
  const r6b = rpc(`mp_apply_transition(${P6})`);
  check('T-6b after the fault is removed the same transition applies once (3 components, Σ = 92.63)',
    r6b.status === 'APPLIED' && Number(owner(`SELECT sum(assigned_amount) FROM mp_reconciliation WHERE mp_financial_movement_id = ${P6};`)) === 92.63);

  // T-7 closed period
  const P7 = apiPayment({ gross: 100, fee: 5, net: 93, day: '07' });
  owner(`UPDATE management_period SET status = 'CLOSED' WHERE periodo_fecha = '2026-11-01';`);
  const s7 = snap();
  const r7 = SVC(`SELECT mp_apply_transition(${P7});`);
  const r7b = ADMIN(`SELECT mp_reconcile_movement(${P7}, 93, '${TAG}-t7-${P7}', '${MPACC}', 'MP_SETTLEMENT', NULL, 'x');`);
  const after7 = snap();
  owner(`UPDATE management_period SET status = 'OPEN' WHERE periodo_fecha = '2026-11-01';`);
  const r7c = rpc(`mp_apply_transition(${P7})`);
  const r7d = rpc(`mp_apply_transition(${P7})`);
  check('T-7 CLOSED period → PERIOD_CLOSED, Δ = 0; RPC 41 → AUTO_APPLICATION_PENDING; reopen → APPLIED once, then ALREADY_APPLIED',
    raised(r7, 'PERIOD_CLOSED') && raised(r7b, 'AUTO_APPLICATION_PENDING') && after7 === s7 && r7c.status === 'APPLIED' && r7d.status === 'ALREADY_APPLIED'
      && opsOf(P7).split(';').length === 3, `${errOf(r7)} / ${errOf(r7b)}`);

  // T-8 zero components
  const P8 = apiPayment({ gross: 200000, net: 200000, opType: 'account_fund' });
  rpc(`mp_apply_transition(${P8})`);
  const t8 = tid(P8);
  check('T-8 fee 0 and tax 0 → exactly 1 operation (MP_SETTLEMENT = net); no zero-value operation',
    opsOf(P8) === `MP_SETTLEMENT|MP:MPA:${t8}:SETTLE|200000.00|t|200000.00|MPA:${t8}:SETTLE|1` && srcStatus(P8) === 'RECONCILED', opsOf(P8));
  const P8b = apiPayment({ gross: 15000, net: 14910 });
  rpc(`mp_apply_transition(${P8b})`);
  const t8b = tid(P8b);
  check('T-8b fee 0 / tax −90 → MP_SETTLEMENT +15000 and ADJUSTMENT −90 only (no FEE operation)',
    opsOf(P8b) === [`ADJUSTMENT|MP:MPA:${t8b}:TAX|-90.00|t|-90.00|MPA:${t8b}:TAX|1`, `MP_SETTLEMENT|MP:MPA:${t8b}:SETTLE|15000.00|t|15000.00|MPA:${t8b}:SETTLE|1`].join(';'), opsOf(P8b));

  // T-9 payout never auto-applied; Mode 2 still links it
  const pay = libIngest(libRow('2026-11-08T10:00:00.000-03:00', libSid(), 'payout', '0.00', '4970.00', '-4970.00', '0.00', '0.00'));
  const s9 = snap();
  const r9 = SVC(`SELECT mp_apply_transition(${pay.mv});`);
  const s9a = snap();
  const tr = JSON.parse(okAs(ADMIN, `SELECT transfer_between_accounts('${MPACC}', '${OTHER}', 4970, '2026-11-08', '${TAG}-tr-${pay.mv}', '${TAG} payout link');`));
  const trOp = tr.financial_operation_id ?? tr.operation_id ?? tr.id;
  const r9b = ADMIN(`SELECT mp_reconcile_movement(${pay.mv}, -4970, '${TAG}-t9-${pay.mv}', '${MPACC}', 'MP_SETTLEMENT', ${trOp}, '${TAG} payout');`);
  check('T-9 payout → NOT_AUTO_APPLICABLE (Δ = 0); RPC 41 Mode 2 to transfer_between_accounts still links it; source RECONCILED',
    raised(r9, 'NOT_AUTO_APPLICABLE') && r9b.ok && srcStatus(pay.mv) === 'RECONCILED', `${errOf(r9)} / ${r9b.ok ? '' : errOf(r9b)} / ${JSON.stringify(tr)}`);
  check('T-9b the NOT_AUTO_APPLICABLE refusal wrote nothing (Δ every counted table = 0)', s9a === s9);

  // T-10 / M-3 yield
  const yl = libIngest(libRow('2026-11-09T04:00:00.000-03:00', libSid(), 'asset_management', '45.50', '0.00', '45.50', '0.00', '0.00'));
  const ty = tid(yl.mv);
  const ry = rpc(`mp_apply_transition(${yl.mv})`);
  const pnlY = okAs(ADMIN, `SELECT coalesce(string_agg(bucket || '|' || signed_amount, ';'), '-') FROM pnl_line_item WHERE source_entity_type = 'mp_financial_movement' AND source_entity_id = '${yl.mv}';`);
  check('T-10 / M-3 yield (report-only, REPORT_ONLY match) → exactly 1 MP_SETTLEMENT = net 45.50; source RECONCILED; P&L OTROS_INGRESOS_FINANCIEROS +45.50 once',
    ry.status === 'APPLIED' && opsOf(yl.mv) === `MP_SETTLEMENT|MP:MPA:${ty}:SETTLE|45.50|t|45.50|MPA:${ty}:SETTLE|1` && srcStatus(yl.mv) === 'RECONCILED'
      && owner(`SELECT outcome FROM mp_report_match WHERE report_source_id = '${yl.src}';`) === 'REPORT_ONLY' && pnlY === 'OTROS_INGRESOS_FINANCIEROS|45.50', `${opsOf(yl.mv)} / ${pnlY}`);
  const pnlF = okAs(ADMIN, `SELECT coalesce(string_agg(bucket || '|' || signed_amount, ';'), '-') FROM pnl_line_item WHERE source_entity_type = 'mp_financial_movement' AND source_entity_id = '${P1}';`);
  const pnlOps = okAs(ADMIN, `SELECT count(*) FROM pnl_line_item WHERE source_entity_type = 'financial_operation' AND source_entity_id IN
    (SELECT financial_operation_id::TEXT FROM mp_reconciliation WHERE mp_financial_movement_id = ${P1});`);
  check('T-12 (Step-7 part) the applied P1 has exactly one P&L MP fee line −5.00 (from the movement); its MP_SETTLEMENT / FEE / ADJUSTMENT operations add no P&L line; tax excluded',
    pnlF === 'COSTOS_INDIRECTOS|-5.00' && pnlOps === '0', `${pnlF} / ${pnlOps}`);
}

// ═════════════════════════════════════════════════════════════════════════════
section('T+', 'eligibility, malformed rows, concurrency, security');
{
  // movement without transition
  const o = owner(`INSERT INTO mp_source_record (source_type, external_id, event_data, occurred_at, occurred_date, processing_status)
    VALUES ('csv_import', '${TAG}-nt', '{}'::jsonb, '2026-11-10T10:00:00-03:00', '2026-11-10', 'NORMALIZED') RETURNING id;`);
  const mvNt = owner(`INSERT INTO mp_financial_movement (mp_source_record_id, movement_kind, gross_amount, fee_amount, tax_amount, net_amount, occurred_date)
    VALUES ('${o}', 'payment', 100, 0, 0, 100, '2026-11-10') RETURNING id;`);
  check('T+1 movement without a transition → NOT_AUTO_APPLICABLE', raised(SVC(`SELECT mp_apply_transition(${mvNt});`), 'NOT_AUTO_APPLICABLE'));
  check('T+2 a transition without a movement is structurally impossible (mp_financial_movement_id NOT NULL + UNIQUE)',
    owner(`SELECT is_nullable FROM information_schema.columns WHERE table_name = 'mp_transition_identity' AND column_name = 'mp_financial_movement_id';`) === 'NO');
  check('T+3 unknown movement → MOVEMENT_NOT_FOUND', raised(SVC('SELECT mp_apply_transition(-1);'), 'MOVEMENT_NOT_FOUND'));
  // malformed arithmetic on an APPROVAL movement (owner-built)
  const om = owner(`INSERT INTO mp_source_record (source_type, external_id, event_data, occurred_at, occurred_date, processing_status)
    VALUES ('csv_import', '${TAG}-bad', '{}'::jsonb, '2026-11-10T10:00:00-03:00', '2026-11-10', 'NORMALIZED') RETURNING id;`);
  const mvBad = owner(`INSERT INTO mp_financial_movement (mp_source_record_id, movement_kind, gross_amount, fee_amount, tax_amount, net_amount, occurred_date)
    VALUES ('${om}', 'payment', 100, -5, -2, 90, '2026-11-10') RETURNING id;`);
  owner(`INSERT INTO mp_transition_identity (resource_type, resource_id, transition, claimed_by_source_id, mp_financial_movement_id)
    VALUES ('payment', '777000000900', 'APPROVAL', '${om}', ${mvBad});`);
  const sb = snap();
  check('T+4 malformed arithmetic (100 − 5 − 2 ≠ 90) → MOVEMENT_INVALID; Δ = 0', raised(SVC(`SELECT mp_apply_transition(${mvBad});`), 'MOVEMENT_INVALID') && snap() === sb);
  // refund kind: auto-applicable pair, deferred in Step 7
  const orf = owner(`INSERT INTO mp_source_record (source_type, external_id, event_data, occurred_at, occurred_date, processing_status)
    VALUES ('csv_import', '${TAG}-rf', '{}'::jsonb, '2026-11-10T10:00:00-03:00', '2026-11-10', 'NORMALIZED') RETURNING id;`);
  const mvRf = owner(`INSERT INTO mp_financial_movement (mp_source_record_id, movement_kind, gross_amount, fee_amount, tax_amount, net_amount, occurred_date)
    VALUES ('${orf}', 'refund', -10, 0, 0, -10, '2026-11-10') RETURNING id;`);
  owner(`INSERT INTO mp_transition_identity (resource_type, resource_id, transition, transition_ref, claimed_by_source_id, mp_financial_movement_id)
    VALUES ('payment', '777000000901', 'REFUND', 'r1', '${orf}', ${mvRf});`);
  const sr = snap();
  check('T+5 refund/REFUND movement → TRANSITION_KIND_NOT_SUPPORTED (refunds fail closed); Δ = 0',
    raised(SVC(`SELECT mp_apply_transition(${mvRf});`), 'TRANSITION_KIND_NOT_SUPPORTED') && snap() === sr);
  // source not applicable
  const PX = apiPayment({ gross: 100, net: 100 });
  owner(`UPDATE mp_source_record SET processing_status = 'ERROR', processing_note = '${TAG} forced' WHERE id = (SELECT mp_source_record_id FROM mp_financial_movement WHERE id = ${PX});`);
  check('T+6 source in ERROR → SOURCE_NOT_APPLICABLE', raised(SVC(`SELECT mp_apply_transition(${PX});`), 'SOURCE_NOT_APPLICABLE'));
  // MP account missing (inside a rolled-back transaction)
  const PM = apiPayment({ gross: 100, net: 100 });
  const rm = raw(`BEGIN;\nUPDATE financial_account SET activo = false WHERE id = '${MPACC}';\nSET LOCAL ROLE service_role;\nSET LOCAL "request.jwt.claims" = '{"role":"service_role"}';\nSELECT mp_apply_transition(${PM});\nROLLBACK;`);
  check('T+7 no active MP account → MP_ACCOUNT_MISSING (the account change was rolled back)',
    raised(rm, 'MP_ACCOUNT_MISSING') && owner(`SELECT activo FROM financial_account WHERE id = '${MPACC}';`) === 't');
  // security
  check('T+8 authenticated / anon cannot execute mp_apply_transition', denied(AUTH(`SELECT mp_apply_transition(${PM});`))
    && denied(raw(`BEGIN; SET LOCAL ROLE anon; SELECT mp_apply_transition(${PM}); COMMIT;`)));
  // concurrency: two sessions apply the same transition
  const PC = apiPayment({ gross: 100, fee: 5, net: 93 });
  const sa = session(SVCSQL(`SELECT mp_apply_transition(${PC})->>'status';\nSELECT pg_sleep(2);`));
  await sleep(700);
  const sbb = session(SVCSQL(`SELECT mp_apply_transition(${PC})->>'status';`));
  const [ra, rb] = await Promise.all([sa, sbb]);
  const statuses = [ra.out.split('\n')[0], rb.out.split('\n')[0]].sort().join(',');
  check('T+9 concurrent A1 on the same movement → exactly one APPLIED, the other ALREADY_APPLIED (it waited on the lock); exactly 3 operations',
    ra.ok && rb.ok && statuses === 'ALREADY_APPLIED,APPLIED' && opsOf(PC).split(';').length === 3
      && owner(`SELECT count(*) FROM financial_operation WHERE external_ref LIKE 'MP:MPA:${tid(PC)}:%';`) === '3', `${statuses} ${ra.err} ${rb.err}`);
}

// ═════════════════════════════════════════════════════════════════════════════
section('C', 'Client attribution against a real applied receipt');
{
  const client = owner(`INSERT INTO clients (nombre) VALUES ('${TAG} client ${Date.now()}') RETURNING id;`);
  const PA = apiPayment({ gross: 1000, net: 994 });
  const r14 = ADMIN(`SELECT mp_allocate_to_client(${PA}, '${client}', 100, '2026-11-05', '${TAG}-c14-${PA}', 'settles CC');`);
  check('C-14 allocation on a NORMALIZED (unapplied) receipt → RECEIPT_NOT_POSTED', raised(r14, 'RECEIPT_NOT_POSTED'), errOf(r14));
  rpc(`mp_apply_transition(${PA})`);
  const s = snap().split('|').map(Number);
  const r2 = ADMIN(`SELECT mp_allocate_to_client(${PA}, '${client}', 100, '2026-11-05', '${TAG}-c2-${PA}', 'settles CC');`);
  const s2 = snap().split('|').map(Number);
  check('C-2 after A1 the ADMIN allocation succeeds: client_ledger +1, allocation +1; operation / posting / collections Δ 0',
    r2.ok && s2[4] - s[4] === 1 && s2[6] - s[6] === 1 && s2[0] === s[0] && s2[1] === s[1] && s2[5] === s[5], `${r2.ok ? '' : errOf(r2)}`);
  const r15 = SVC(`SELECT mp_allocate_to_client(${PA}, '${client}', 1, '2026-11-05', '${TAG}-c15', 'x');`);
  check('C-15 service role cannot allocate to a client (FORBIDDEN or no EXECUTE)', raised(r15, 'FORBIDDEN') || denied(r15), errOf(r15));
}

// ═════════════════════════════════════════════════════════════════════════════
section('M', 'R2 report fallback (M-6b now; M-6 in the V-4 test branch)');
{
  const lr = libRow('2026-11-11T10:00:00.000-03:00', libSid(), 'payment', '980.00', '0.00', '1000.00', '-12.00', '-8.00');
  const src = owner(`INSERT INTO mp_source_record (source_type, external_id, event_data, occurred_at, occurred_date, processing_status, processing_note)
    VALUES ('csv_import', '${lr.SOURCE_ID}:payment:C', ${j(lr)}, '${lr.DATE}', '2026-11-11', 'PENDING', 'DEFERRED_BACKFILL: awaiting API payment ${lr.SOURCE_ID}') RETURNING id;`);
  const r0 = ADMIN(`SELECT mp_normalize_report_fallback('${src}', 'API gone');`);
  check('M-6b with mp_v4_verified() = false → V4_NOT_VERIFIED', raised(r0, 'V4_NOT_VERIFIED'), errOf(r0));
  check('M-6b service role / non-ADMIN cannot call the fallback',
    raised(AUTH(`SELECT mp_normalize_report_fallback('${src}', 'x');`), 'FORBIDDEN') && denied(SVC(`SELECT mp_normalize_report_fallback('${src}', 'x');`)));
  check('M-6b the internal helper is not executable by service_role / authenticated',
    denied(SVC(`SELECT mp_claim_report_payment_fallback('${src}', NULL, 'x');`)) && denied(ADMIN(`SELECT mp_claim_report_payment_fallback('${src}', NULL, 'x');`)));
  check('M-6b RPC 40 never references the fallback helper; the helper is SECURITY INVOKER (not in the definer inventory)',
    owner(`SELECT position('mp_claim_report_payment_fallback' in prosrc) FROM pg_proc WHERE proname = 'mp_normalize_source';`) === '0'
      && owner(`SELECT prosecdef FROM pg_proc WHERE proname = 'mp_claim_report_payment_fallback';`) === 'f');
  check('M-6b mp_v4_verified() is still false', owner('SELECT mp_v4_verified();') === 'f');

  // V-4 test branch: every case runs in its own transaction that is never committed
  const branch = (deliveryStatus, errCode, row, note, body) => `BEGIN;
CREATE OR REPLACE FUNCTION mp_v4_verified() RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS 'SELECT true';
CREATE TEMP TABLE _b ON COMMIT DROP AS SELECT 1;
INSERT INTO mp_source_record (source_type, external_id, event_data, occurred_at, occurred_date, processing_status, processing_note)
  VALUES ('csv_import', '${row.SOURCE_ID}:payment:${Number(row.NET_CREDIT_AMOUNT) > 0 ? 'C' : 'D'}', ${j(row)}, '${row.DATE}', '2026-11-12', 'PENDING', '${note}');
INSERT INTO mp_webhook_delivery (delivery_key, notification_sha256, origin, topic, topic_class, resource_id, signature_verified, report_source_id, status, last_error_code)
  SELECT 'backfill:payment:${row.SOURCE_ID}', repeat('a', 64), 'report_backfill', 'payment', 'payment', '${row.SOURCE_ID}', false, id, '${deliveryStatus}', ${q(errCode)}
    FROM mp_source_record WHERE external_id LIKE '${row.SOURCE_ID}:payment:%';
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub":"${ADMIN_UID}","role":"authenticated"}';
${body}
ROLLBACK;`;
  const srcOf = (sid) => `(SELECT id FROM mp_source_record WHERE external_id LIKE '${sid}:payment:%')`;
  const rowC = libRow('2026-11-12T10:00:00.000-03:00', libSid(), 'payment', '980.00', '0.00', '1000.00', '-12.00', '-8.00');
  const ok = raw(branch('FAILED_PERMANENT', 'MP_NOT_FOUND', rowC, `DEFERRED_BACKFILL: awaiting API payment ${rowC.SOURCE_ID}`, `
SELECT mp_normalize_report_fallback(${srcOf(rowC.SOURCE_ID)}, 'API permanently unavailable')->>'status';
RESET ROLE;
SELECT concat_ws('|', m.movement_kind, m.gross_amount, m.fee_amount, m.tax_amount, m.net_amount, m.occurred_date, t.resource_type, t.resource_id, t.transition,
                 s.processing_status, s.processing_note, rm.outcome, rm.detail->>'fallback')
  FROM mp_financial_movement m JOIN mp_transition_identity t ON t.mp_financial_movement_id = m.id
  JOIN mp_source_record s ON s.id = m.mp_source_record_id JOIN mp_report_match rm ON rm.report_source_id = s.id
 WHERE s.id = ${srcOf(rowC.SOURCE_ID)};
SELECT count(*) FROM audit_events WHERE action = 'MP_REPORT_FALLBACK' AND entity_id = ${srcOf(rowC.SOURCE_ID)}::TEXT AND performed_by = '${ADMIN_UID}';
SET LOCAL ROLE service_role;
SET LOCAL "request.jwt.claims" = '{"role":"service_role"}';
SELECT mp_apply_transition((SELECT id FROM mp_financial_movement WHERE mp_source_record_id = ${srcOf(rowC.SOURCE_ID)}))->>'status';`));
  const lines = ok.out.split('\n');
  check('M-6 (V-4 test branch) exhausted back-fill → ADMIN fallback CREATED: movement payment 1000 / −12 / −8 / 980 on ("payment", SOURCE_ID, APPROVAL); source NORMALIZED REPORT_FALLBACK; REPORT_ONLY fallback match; audit by the ADMIN; then A1 applies it',
    ok.ok && lines[0] === 'CREATED' && lines[1] === `payment|1000.00|-12.00|-8.00|980.00|2026-11-12|payment|${rowC.SOURCE_ID}|APPROVAL|NORMALIZED|REPORT_FALLBACK|REPORT_ONLY|true`
      && lines[2] === '1' && lines[3] === 'APPLIED', `${ok.out} ${ok.err}`);
  // an API snapshot later finds the identity claimed
  const rowC2 = libRow('2026-11-12T10:00:00.000-03:00', libSid(), 'payment', '980.00', '0.00', '1000.00', '-12.00', '-8.00');
  const apiPl = { id: Number(rowC2.SOURCE_ID), operation_type: 'money_transfer', status: 'approved', status_detail: 'accredited', currency_id: 'ARS', live_mode: true,
    collector_id: 100000001, date_created: '2026-11-12T09:00:00.000-04:00', date_approved: '2026-11-12T09:00:00.000-04:00', transaction_amount: 1000,
    transaction_details: { net_received_amount: 980 }, fee_details: [{ type: 'mercadopago_fee', amount: 12, fee_payer: 'collector' }], refunds: [], transaction_amount_refunded: 0 };
  const later = raw(branch('FAILED_PERMANENT', 'MP_NOT_FOUND', rowC2, `DEFERRED_BACKFILL: awaiting API payment ${rowC2.SOURCE_ID}`, `
SELECT mp_normalize_report_fallback(${srcOf(rowC2.SOURCE_ID)}, 'API permanently unavailable')->>'status';
RESET ROLE;
INSERT INTO mp_source_record (source_type, external_id, event_data, occurred_at, occurred_date)
  VALUES ('api_payment', 'MPPAY:${rowC2.SOURCE_ID}:' || left(encode(sha256(convert_to(${j(apiPl)}::text, 'UTF8')), 'hex'), 32), ${j(apiPl)},
          '2026-11-12T09:00:00.000-04:00', '2026-11-12');
SET LOCAL ROLE service_role;
SET LOCAL "request.jwt.claims" = '{"role":"service_role"}';
SELECT mp_normalize_source((SELECT id FROM mp_source_record WHERE external_id LIKE 'MPPAY:${rowC2.SOURCE_ID}:%'))->>'processing_status';
RESET ROLE;
SELECT processing_note FROM mp_source_record WHERE external_id LIKE 'MPPAY:${rowC2.SOURCE_ID}:%';
SELECT count(*) FROM mp_financial_movement m JOIN mp_transition_identity t ON t.mp_financial_movement_id = m.id WHERE t.resource_id = '${rowC2.SOURCE_ID}';`));
  const l2 = later.out.split('\n');
  check('M-6 a later API snapshot for the fallback payment → IGNORED NO_NEW_TRANSITION; exactly one movement (first claimant wins)',
    later.ok && l2[0] === 'CREATED' && l2[1] === 'IGNORED' && l2[2] === 'NO_NEW_TRANSITION' && l2[3] === '1', `${later.out} ${later.err}`);
  // precondition refusals (each branch rolls back)
  const rowR = libRow('2026-11-12T10:00:00.000-03:00', libSid(), 'payment', '980.00', '0.00', '1000.00', '-12.00', '-8.00');
  const call = (row, why = 'x') => `SELECT mp_normalize_report_fallback(${srcOf(row.SOURCE_ID)}, '${why}');`;
  check('M-6b back-fill not exhausted (FAILED_RETRYABLE) → BACKFILL_NOT_EXHAUSTED',
    raised(raw(branch('FAILED_RETRYABLE', 'MP_NOT_FOUND', rowR, `DEFERRED_BACKFILL: awaiting API payment ${rowR.SOURCE_ID}`, call(rowR))), 'BACKFILL_NOT_EXHAUSTED'));
  check('M-6b back-fill failed with COLLECTOR_MISMATCH → DIRECTION_CONFLICT',
    raised(raw(branch('FAILED_PERMANENT', 'COLLECTOR_MISMATCH', rowR, `DEFERRED_BACKFILL: awaiting API payment ${rowR.SOURCE_ID}`, call(rowR))), 'DIRECTION_CONFLICT'));
  check('M-6b not parked DEFERRED_BACKFILL (DEFERRED_V4 note) → NOT_DEFERRED',
    raised(raw(branch('FAILED_PERMANENT', 'MP_NOT_FOUND', rowR, 'DEFERRED_V4: payment/API equivalence unverified', call(rowR))), 'NOT_DEFERRED'));
  check('M-6b missing reason → REASON_REQUIRED',
    raised(raw(branch('FAILED_PERMANENT', 'MP_NOT_FOUND', rowR, `DEFERRED_BACKFILL: awaiting API payment ${rowR.SOURCE_ID}`, call(rowR, ' '))), 'REASON_REQUIRED'));
  const rowD = libRow('2026-11-12T10:00:00.000-03:00', libSid(), 'payment', '0.00', '505.00', '-500.00', '0.00', '-5.00');
  check('M-6b outbound (direction D) row forced into DEFERRED_BACKFILL → OUTBOUND_NOT_ELIGIBLE (defence in depth)',
    raised(raw(branch('FAILED_PERMANENT', 'MP_NOT_FOUND', rowD, `DEFERRED_BACKFILL: awaiting API payment ${rowD.SOURCE_ID}`, call(rowD))), 'OUTBOUND_NOT_ELIGIBLE'));
  check('M-6b after every branch rolled back: no fallback row, identity or movement survives; mp_v4_verified() still false',
    owner(`SELECT count(*) FROM mp_transition_identity WHERE resource_id IN ('${rowC.SOURCE_ID}', '${rowC2.SOURCE_ID}', '${rowR.SOURCE_ID}', '${rowD.SOURCE_ID}');`) === '0'
      && owner(`SELECT count(*) FROM mp_source_record WHERE external_id LIKE '${rowC.SOURCE_ID}%' OR external_id LIKE '${rowR.SOURCE_ID}%';`) === '0'
      && owner('SELECT mp_v4_verified();') === 'f');
}

cleanup();
console.log(`\n  ══ MP ATOMIC APPLICATION RESULT: ${pass} passed, ${fail} failed ══\n`);
if (fail) console.log(failures.map((f) => `   - ${f}`).join('\n'));
process.exit(fail === 0 ? 0 : 1);
