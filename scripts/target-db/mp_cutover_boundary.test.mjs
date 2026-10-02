#!/usr/bin/env node
/**
 * ADR-017 (G-7) — Mercado Pago cutover boundary (migration 0071). LOCAL TEST DATABASE ONLY.
 *
 * Every scenario runs in ONE transaction that ends in ROLLBACK, through the real path:
 *   delivery (mp_register_delivery) → claim → S4 mp_ingest_api_snapshot → RPC 40 mp_normalize_source
 *   → A1 mp_apply_transition (for created movements),
 * with the boundary written as the database owner (the cutover procedure) inside the transaction.
 * No real Mercado Pago call: payloads are the sanitized ADR-006 V-2 fixtures.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" node scripts/target-db/mp_cutover_boundary.test.mjs
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { assertSafeDestructiveTarget } from '../test-env/guard.mjs';

assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);
const REPO = resolve(import.meta.dirname, '..', '..');
const FIX = JSON.parse(readFileSync(join(REPO, 'scripts', 'target-db', 'fixtures', 'adr006-v2-payments.json'), 'utf8'));
const sample = (label) => { const { _label, ...s } = FIX.samples.find((x) => x._label === label); return s; };
const container = (spawnSync('docker', ['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout || '').trim().split('\n')[0];
if (!container) { console.error('no local supabase_db container'); process.exit(1); }

function run(sql) {
  const r = spawnSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    { encoding: 'utf8', input: sql, maxBuffer: 16 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
let pass = 0; let fail = 0;
const check = (label, cond, detail = '') => { if (cond) { pass++; console.log(`    OK   ${label}`); } else { fail++; console.log(`    MAL  ${label} :: ${String(detail).slice(0, 400)}`); } };
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const SVC = `SET LOCAL ROLE service_role; SET LOCAL "request.jwt.claims" = '{"role":"service_role"}';`;
const OWNER = 'RESET ROLE;';
let seq = 0;
const pid = () => `9917${String(Date.now()).slice(-6)}${String(++seq).padStart(3, '0')}`;
const payment = (label, over = {}) => ({ ...sample(label), ...over, id: Number(pid()) });
const CUT = '2026-10-15T00:00:00.000-03:00';   // a synthetic boundary for tests only; the real one is an owner input

/** delivery + claim + S4 + RPC 40 for one payload, as the service role; psql variables carry the ids. */
const ingest = (p, tag) => `
${SVC}
SELECT mp_register_delivery('webhook', 'payment', 'payment', 'payment.updated', ${q(String(p.id))}, NULL, ${q(`G7-${tag}`)},
  ${q(JSON.stringify({ notification_id: `g7-${tag}-${p.id}` }))}::jsonb, true) IS NOT NULL AS _ \\gset
SELECT delivery_id AS d_${tag}, claim_token AS t_${tag} FROM mp_claim_deliveries(50, 120) WHERE resource_id = ${q(String(p.id))} \\gset
SELECT mp_ingest_api_snapshot(:'d_${tag}', :'t_${tag}', ${q(String(p.id))}, ${q(JSON.stringify(p))}::jsonb)->>'source_record_id' AS s_${tag} \\gset
SELECT mp_normalize_source(:'s_${tag}') AS n_${tag} \\gset
${OWNER}`;
const applyAll = (tag) => `${SVC}
SELECT count(mp_apply_transition(m.id)) AS a_${tag} FROM mp_financial_movement m WHERE m.mp_source_record_id = :'s_${tag}' \\gset
${OWNER}`;
const boundary = (at) => `DELETE FROM mp_cutover_boundary; INSERT INTO mp_cutover_boundary (cutover_at, import_batch, evidence_ref) VALUES (${q(at)}, 'G7-TEST', 'G7-TEST');`;
const result = (tag) => `SELECT concat_ws('|', s.processing_status, coalesce(split_part(s.processing_note, ':', 1), '-'),
  (SELECT count(*) FROM mp_financial_movement m WHERE m.mp_source_record_id = s.id),
  (SELECT count(*) FROM financial_posting fp JOIN mp_reconciliation r ON r.financial_operation_id = fp.financial_operation_id
     JOIN mp_financial_movement m ON m.id = r.mp_financial_movement_id WHERE m.mp_source_record_id = s.id),
  (SELECT count(*) FROM mp_webhook_delivery WHERE resource_id = ${q('__PID__')}),
  (SELECT count(*) FROM audit_events WHERE entity_type = 'mp_source_record' AND entity_id = s.id::TEXT AND action = 'NORMALIZE'))
  FROM mp_source_record s WHERE s.id = :'s_${tag}';`;
const scenario = (body) => run(`BEGIN;\n${body}\nROLLBACK;`);
const last = (r) => (r.ok ? r.out.split('\n').filter(Boolean).pop() : `ERR ${r.err.split('\n')[0]}`);

console.log('\n  [authority]');
{
  const r = run(`SELECT has_table_privilege('anon','mp_cutover_boundary','SELECT')||':'||has_table_privilege('authenticated','mp_cutover_boundary','SELECT')
    ||':'||has_table_privilege('service_role','mp_cutover_boundary','INSERT')||':'||has_table_privilege('service_role','mp_cutover_boundary','SELECT')
    ||'|'||(SELECT column_default IS NULL FROM information_schema.columns WHERE table_name='mp_cutover_boundary' AND column_name='cutover_at')
    ||'|'||(SELECT count(*) FROM pg_proc WHERE prosecdef AND pronamespace='public'::regnamespace)
    ||'|'||(SELECT count(*) FROM migration_ledger.applied WHERE filename='0071_mp_cutover_boundary.sql');`);
  check('B1 no API role reads or writes the boundary; cutover_at has no default; definer set unchanged (69); 0071 in ledger', r.out === 'false:false:false:false|true|69|1', r.out || r.err);
  const two = scenario(`${boundary(CUT)} INSERT INTO mp_cutover_boundary (cutover_at, import_batch, evidence_ref) VALUES (now(), 'x', 'x');`);
  check('B2 singleton: a second boundary row is refused', !two.ok && /duplicate key|mp_cutover_boundary_pkey/.test(two.err), two.err);
  const svc = scenario(`${SVC} INSERT INTO mp_cutover_boundary (cutover_at, import_batch, evidence_ref) VALUES (now(), 'x', 'x');`);
  check('B3 the service role (worker) cannot write the boundary', !svc.ok && /permission denied/.test(svc.err), svc.err);
}

console.log('\n  [G-7 matrix]');
// 1. pre-cutover payment, delivered before the switch simulation (boundary set): included in opening, no effect
{
  const p = payment('A1', { date_approved: '2026-10-14T23:59:59.000-03:00' });
  const r = scenario(`${boundary(CUT)} ${ingest(p, 'x')} ${applyAll('x')} ${result('x').replace('__PID__', p.id)}`);
  check('G1 pre-cutover approved payment → IGNORED PRE_CUTOVER_INCLUDED_IN_OPENING_BALANCE; 0 movement; 0 posting; delivery + audit kept', last(r) === 'IGNORED|PRE_CUTOVER_INCLUDED_IN_OPENING_BALANCE|0|0|1|1', last(r));
}
// 2. pre-cutover payment, webhook retried after the target switch (a second delivery of the same payment)
{
  const p = payment('A2', { date_approved: '2026-10-01T10:00:00.000-03:00' });
  const r = scenario(`${boundary(CUT)} ${ingest(p, 'a')}
    ${SVC}
    SELECT mp_register_delivery('webhook', 'payment', 'payment', 'payment.updated', ${q(String(p.id))}, NULL, 'G7-retry',
      ${q(JSON.stringify({ notification_id: `g7-retry-${p.id}` }))}::jsonb, true) IS NOT NULL AS _ \\gset
    SELECT delivery_id AS d2, claim_token AS t2 FROM mp_claim_deliveries(50, 120) WHERE resource_id = ${q(String(p.id))} \\gset
    SELECT mp_ingest_api_snapshot(:'d2', :'t2', ${q(String(p.id))}, ${q(JSON.stringify(p))}::jsonb)->>'source_record_id' AS s2 \\gset
    ${OWNER}
    SELECT concat_ws('|', (SELECT count(*) FROM mp_webhook_delivery WHERE resource_id = ${q(String(p.id))}), :'s2' = :'s_a',
      (SELECT processing_status FROM mp_source_record WHERE id = :'s_a'),
      (SELECT count(*) FROM mp_financial_movement m JOIN mp_source_record s ON s.id = m.mp_source_record_id WHERE s.external_id LIKE ${q(`MPPAY:${p.id}:%`)}));`);
  check('G2 retried pre-cutover webhook after the switch: both deliveries kept, the retry resolves to the same snapshot (already IGNORED), still 0 movement',
    last(r) === '2|t|IGNORED|0', last(r));
}
// 3. payment exactly at the boundary → normal processing (>= cutover)
{
  const p = payment('A1', { date_approved: CUT });
  const r = scenario(`${boundary(CUT)} ${ingest(p, 'x')} ${applyAll('x')} ${result('x').replace('__PID__', p.id)}`);
  check('G3 date_approved == cutover_at → normal processing: NORMALIZED, movement created and applied (postings)', /^(NORMALIZED|RECONCILED)\|-\|1\|[1-9]\d*\|1\|1$/.test(last(r)), last(r));
}
// 4. post-cutover payment → normal
{
  const p = payment('A1', { date_approved: '2026-10-15T00:00:00.001-03:00' });
  const r = scenario(`${boundary(CUT)} ${ingest(p, 'x')} ${applyAll('x')} ${result('x').replace('__PID__', p.id)}`);
  check('G4 post-cutover payment (1 ms after) → NORMALIZED and applied', /^(NORMALIZED|RECONCILED)\|-\|1\|[1-9]\d*\|1\|1$/.test(last(r)), last(r));
}
// 5. duplicate retry of a pre-cutover payment: identical payload → same S4 snapshot, no second source, no movement
{
  const p = payment('B1', { date_approved: '2026-09-30T12:00:00.000-03:00' });
  const r = scenario(`${boundary(CUT)} ${ingest(p, 'a')}
    ${SVC}
    SELECT mp_register_delivery('webhook', 'payment', 'payment', 'payment.updated', ${q(String(p.id))}, NULL, 'G7-r', ${q(JSON.stringify({ notification_id: `g7-r-${p.id}` }))}::jsonb, true) IS NOT NULL AS _ \\gset
    SELECT delivery_id AS d2, claim_token AS t2 FROM mp_claim_deliveries(50, 120) WHERE resource_id = ${q(String(p.id))} \\gset
    SELECT (mp_ingest_api_snapshot(:'d2', :'t2', ${q(String(p.id))}, ${q(JSON.stringify(p))}::jsonb)->>'created') AS created2 \\gset
    ${OWNER}
    SELECT concat_ws('|', :'created2', (SELECT count(*) FROM mp_source_record WHERE external_id LIKE ${q(`MPPAY:${p.id}:%`)}),
      (SELECT count(*) FROM mp_financial_movement m JOIN mp_source_record s ON s.id = m.mp_source_record_id WHERE s.external_id LIKE ${q(`MPPAY:${p.id}:%`)}));`);
  check('G5 duplicate retry of a pre-cutover payment: same snapshot reused (no second source), 0 movement', last(r) === 'false|1|0', last(r));
}
// 6. duplicate retry of a post-cutover payment: idempotency intact (one movement, applied once)
{
  const p = payment('C1', { date_approved: '2026-10-20T12:00:00.000-03:00' });
  const r = scenario(`${boundary(CUT)} ${ingest(p, 'a')} ${applyAll('a')}
    ${SVC}
    SELECT mp_register_delivery('webhook', 'payment', 'payment', 'payment.updated', ${q(String(p.id))}, NULL, 'G7-r', ${q(JSON.stringify({ notification_id: `g7-r2-${p.id}` }))}::jsonb, true) IS NOT NULL AS _ \\gset
    SELECT delivery_id AS d2, claim_token AS t2 FROM mp_claim_deliveries(50, 120) WHERE resource_id = ${q(String(p.id))} \\gset
    SELECT (mp_ingest_api_snapshot(:'d2', :'t2', ${q(String(p.id))}, ${q(JSON.stringify(p))}::jsonb)->>'created') AS created2 \\gset
    ${OWNER}
    SELECT concat_ws('|', :'created2', (SELECT count(*) FROM mp_financial_movement m JOIN mp_source_record s ON s.id = m.mp_source_record_id WHERE s.external_id LIKE ${q(`MPPAY:${p.id}:%`)}),
      (SELECT count(*) FROM mp_reconciliation r JOIN mp_financial_movement m ON m.id = r.mp_financial_movement_id JOIN mp_source_record s ON s.id = m.mp_source_record_id
        WHERE s.external_id LIKE ${q(`MPPAY:${p.id}:%`)}) > 0);`);
  check('G6 duplicate retry of a post-cutover payment: no second snapshot, one movement, applied once', last(r) === 'false|1|t', last(r));
}
// 7. pre-cutover payment with a post-cutover chargeback SIGNAL: the signal is still recorded (ADR-006 signal-only path)
{
  const p = payment('D1', { date_approved: '2026-10-01T10:00:00.000-03:00' });
  const r = scenario(`${boundary(CUT)} ${ingest(p, 'x')}
    ${SVC}
    SELECT mp_register_delivery('webhook', 'chargebacks', 'chargeback', 'chargeback.created', ${q(`CB${p.id}`)}, NULL, 'G7-cb',
      ${q(JSON.stringify({ notification_id: `g7-cb-${p.id}` }))}::jsonb, true)->>'delivery_id' AS cbd \\gset
    ${OWNER}
    SELECT concat_ws('|', (SELECT topic_class FROM mp_webhook_delivery WHERE id = :'cbd'), (SELECT status::TEXT FROM mp_webhook_delivery WHERE id = :'cbd'),
      (SELECT processing_status::TEXT FROM mp_source_record WHERE id = :'s_x'));`);
  check('G7 post-cutover chargeback signal for a pre-cutover payment is recorded as a delivery (not discarded by the boundary)', /^chargeback\|[A-Z_]+\|IGNORED$/.test(last(r)), last(r));
}
// 8. pre-cutover payment with post-cutover refund evidence → NOT classified pre-cutover; the unchanged fail-closed logic decides
{
  const refund = [{ id: 1, amount: 10, date_created: '2026-10-20T10:00:00.000-03:00', status: 'approved' }];
  const p = payment('E1', { date_approved: '2026-10-01T10:00:00.000-03:00', status: 'refunded', status_detail: 'refunded', refunds: refund, transaction_amount_refunded: 10 });
  const p2 = payment('F1', { date_approved: '2026-10-01T10:00:00.000-03:00', refunds: refund, transaction_amount_refunded: 10 });
  const r = scenario(`${boundary(CUT)} ${ingest(p, 'x')} ${ingest(p2, 'y')}
    SELECT concat_ws('|', (SELECT processing_status || ':' || split_part(processing_note, ':', 1) FROM mp_source_record WHERE id = :'s_x'),
                          (SELECT processing_status || ':' || split_part(processing_note, ':', 1) FROM mp_source_record WHERE id = :'s_y'));`);
  const out = last(r);
  check('G8 pre-cutover payment with post-cutover refund evidence (full / partial) is not hidden as pre-cutover: fail-closed ADR-006 outcome',
    r.ok && !out.includes('PRE_CUTOVER') && out.split('|').every((x) => /^(ERROR|IGNORED):/.test(x)), out);
}
// 9. missing cutover authority → fail safe
{
  const p = payment('H1', { date_approved: '2026-10-20T12:00:00.000-03:00' });
  const r = scenario(`DELETE FROM mp_cutover_boundary; ${ingest(p, 'x')}`);
  check('G9 no boundary row → RPC 40 raises CUTOVER_BOUNDARY_MISSING (no movement; the transaction writes nothing)', !r.ok && /CUTOVER_BOUNDARY_MISSING/.test(r.err), r.err || r.out);
  const r2 = scenario(`DELETE FROM mp_cutover_boundary; ${SVC}
    SELECT mp_register_delivery('webhook', 'payment', 'payment', 'payment.updated', ${q(String(p.id))}, NULL, 'G7-m', ${q(JSON.stringify({ notification_id: `g7-m-${p.id}` }))}::jsonb, true) IS NOT NULL AS _ \\gset
    SELECT delivery_id AS d, claim_token AS t FROM mp_claim_deliveries(50, 120) WHERE resource_id = ${q(String(p.id))} \\gset
    SELECT mp_ingest_api_snapshot(:'d', :'t', ${q(String(p.id))}, ${q(JSON.stringify(p))}::jsonb)->>'source_record_id' AS s \\gset
    ${OWNER}
    SELECT concat_ws('|', (SELECT processing_status FROM mp_source_record WHERE id = :'s'), (SELECT count(*) FROM mp_webhook_delivery WHERE resource_id = ${q(String(p.id))}));`);
  check('G9b without a boundary the delivery and the immutable snapshot are still recorded (evidence kept, source PENDING for a later retry)', last(r2) === 'PENDING|1', last(r2));
}
// 10. malformed / unusable authoritative timestamp → not classified pre-cutover; the 0050 DATE_MISMATCH stays
{
  const p = payment('A1', { date_approved: 'not-a-timestamp', date_created: '2026-10-01T10:00:00.000-03:00' });
  const r = scenario(`${boundary(CUT)} ${ingest(p, 'x')} ${result('x').replace('__PID__', p.id)}`);
  check('G10 malformed date_approved (pre-cutover date_created) → ERROR DATE_MISMATCH, never silently PRE_CUTOVER', /^ERROR\|DATE_MISMATCH\|0\|0\|1\|1$/.test(last(r)), last(r));
  const p2 = payment('A2', { date_approved: '2026-13-45T99:99:99.000-04:00', date_created: '2026-10-01T10:00:00.000-03:00' });
  const r2 = scenario(`${boundary(CUT)} ${ingest(p2, 'x')} ${result('x').replace('__PID__', p2.id)}`);
  check('G10b well-shaped but impossible date_approved → ERROR DATE_MISMATCH (the guard never raises on it)', /^ERROR\|DATE_MISMATCH\|0\|0\|1\|1$/.test(last(r2)), last(r2));
}
// 11. report rows: a pre-cutover Liberaciones row is included in the opening; a post-cutover row keeps the ADR-006 path
{
  const mk = (ext, at) => `INSERT INTO mp_source_record (source_type, external_id, event_data, occurred_at, occurred_date)
    VALUES ('csv_import', ${q(ext)}, '{"fixture":"g7"}'::jsonb, ${q(at)}::timestamptz, (${q(at)}::timestamptz AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE) RETURNING id AS ${ext.replace(/-/g, '_')} \\gset\n`;
  const r = scenario(`${boundary(CUT)}\n${mk('G7-pre', '2026-10-10T10:00:00-03:00')}${mk('G7-post', '2026-10-16T10:00:00-03:00')}
    ${SVC} SELECT mp_normalize_source(:'g7_pre') IS NOT NULL AS _ \\gset
    SELECT mp_normalize_source(:'g7_post') IS NOT NULL AS _ \\gset
    ${OWNER}
    SELECT concat_ws('|', (SELECT processing_status || ':' || split_part(processing_note, ':', 1) FROM mp_source_record WHERE id = :'g7_pre'),
                          (SELECT processing_status || ':' || coalesce(split_part(processing_note, ':', 1), '-') FROM mp_source_record WHERE id = :'g7_post'));`);
  const [pre, post] = last(r).split('|');
  check('G11 report rows: pre-cutover → IGNORED PRE_CUTOVER; post-cutover → unchanged ADR-006 report path (not PRE_CUTOVER)',
    pre === 'IGNORED:PRE_CUTOVER_INCLUDED_IN_OPENING_BALANCE' && post !== undefined && !post.includes('PRE_CUTOVER'), last(r));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
