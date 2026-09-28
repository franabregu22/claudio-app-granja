#!/usr/bin/env node
/**
 * ADR-006 Step 6 — api_payment normalization (0050): S4 mp_ingest_api_snapshot + RPC 40 api_payment.
 *
 * Run:  TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *         node scripts/target-db/mp_payment_normalization.test.mjs
 *
 * Authority: ADR006_V2_PAYMENT_FIELD_EVIDENCE §15 (V-2 final gate), ADR006_RPC_CONTRACTS_V1 S4 / §40.2,
 * ADR006_TEST_MATRIX_V1 N block. Payloads are built from the sanitized real-shape fixtures
 * (scripts/target-db/fixtures/adr006-v2-payments.json) with test ids in the 777… range.
 * No Step-7 effect is expected anywhere: no operation, posting, reconciliation or allocation.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { assertSafeDestructiveTarget } from '../test-env/guard.mjs';

const REPO = resolve(import.meta.dirname, '..', '..');
const FIX = JSON.parse(readFileSync(join(REPO, 'scripts', 'target-db', 'fixtures', 'adr006-v2-payments.json'), 'utf8'));
const sample = (label) => FIX.samples.find((s) => s._label === label);

function resolveDockerBin() {
  const onPath = spawnSync('docker', ['--version'], { encoding: 'utf8' });
  if (!onPath.error && onPath.status === 0) return 'docker';
  const c = resolve(process.env.LOCALAPPDATA ?? '', 'Programs', 'DockerDesktop', 'resources', 'bin', 'docker.exe');
  if (existsSync(c)) return c;
  throw new Error('docker not found');
}
const DOCKER = resolveDockerBin();
let pass = 0;
let fail = 0;
const failures = [];
const PSQL = ['psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'];
let container;
function raw(sqlText) {
  const r = spawnSync(DOCKER, ['exec', '-i', container, ...PSQL], { encoding: 'utf8', input: sqlText, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
function owner(sqlText) {
  const r = raw(sqlText);
  if (!r.ok) throw new Error(`owner SQL failed:\n${sqlText}\n${r.err}`);
  return r.out;
}
const esc = (s) => String(s).replace(/'/g, "''");
const q = (v) => (v === null || v === undefined ? 'NULL' : `'${esc(v)}'`);
const asRole = (role, claims, s) => raw(`BEGIN;\nSET LOCAL ROLE ${role};\nSET LOCAL "request.jwt.claims" = '${esc(JSON.stringify(claims))}';\n${s}\nCOMMIT;`);
const SVC = (s) => asRole('service_role', { role: 'service_role' }, s);
const AUTH = (s) => asRole('authenticated', { sub: '11111111-1111-1111-1111-111111111111', role: 'authenticated' }, s);
const okAs = (fn, s) => { const r = fn(s); if (!r.ok) throw new Error(`SQL failed:\n${s}\n${r.err}`); return r.out; };
const rpc = (call) => JSON.parse(okAs(SVC, `SELECT ${call};`));
const raised = (r, code) => !r.ok && new RegExp(`ERROR:\\s+${code}`).test(r.err);
const denied = (r) => !r.ok && /permission denied/i.test(r.err);
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

// ── fixture lifecycle ────────────────────────────────────────────────────────
function cleanup() {
  owner(`
CREATE TEMP TABLE _src AS SELECT id FROM mp_source_record WHERE external_id LIKE 'MPPAY:777%' OR external_id LIKE 'N6T-%';
CREATE TEMP TABLE _mv  AS SELECT id FROM mp_financial_movement WHERE mp_source_record_id IN (SELECT id FROM _src);
CREATE TEMP TABLE _dl  AS SELECT id FROM mp_webhook_delivery WHERE resource_id LIKE '777%';
DELETE FROM audit_events WHERE entity_type = 'mp_source_record' AND entity_id IN (SELECT id::TEXT FROM _src);
DELETE FROM audit_events WHERE entity_type = 'mp_webhook_delivery' AND entity_id IN (SELECT id::TEXT FROM _dl);
DELETE FROM mp_transition_identity WHERE mp_financial_movement_id IN (SELECT id FROM _mv) OR resource_id LIKE '777%';
DELETE FROM mp_financial_movement WHERE id IN (SELECT id FROM _mv);
DELETE FROM mp_webhook_delivery WHERE id IN (SELECT id FROM _dl);
DELETE FROM mp_source_record WHERE id IN (SELECT id FROM _src);`);
}
const counts = () => owner(`SELECT concat_ws('|',
  (SELECT count(*) FROM mp_financial_movement), (SELECT count(*) FROM mp_transition_identity),
  (SELECT count(*) FROM financial_operation), (SELECT count(*) FROM financial_posting),
  (SELECT count(*) FROM mp_reconciliation), (SELECT count(*) FROM mp_client_allocation),
  (SELECT count(*) FROM mp_source_record WHERE source_type = 'api_refund'));`);

// ── payload builder (sanitized real shape) ───────────────────────────────────
let seq = 0;
const newPid = () => `777${String(Date.now()).slice(-6)}${String(++seq).padStart(3, '0')}`;
function payload(label, over = {}) {
  const s = sample(label);
  const p = {
    id: null, operation_type: s.operation_type, status: s.status, status_detail: s.status_detail,
    payment_type_id: s.payment_type_id, payment_method_id: s.payment_method_id, currency_id: s.currency_id, live_mode: s.live_mode,
    collector_id: s.collector_id, payer: s.payer, external_reference: s.external_reference,
    date_created: s.date_created, date_approved: s.date_approved, date_last_updated: s.date_last_updated,
    money_release_date: s.money_release_date, money_release_status: s.money_release_status,
    transaction_amount: s.transaction_amount, transaction_amount_refunded: s.transaction_amount_refunded,
    taxes_amount: s.taxes_amount, coupon_amount: s.coupon_amount, shipping_amount: s.shipping_amount,
    transaction_details: s.transaction_details, fee_details: s.fee_details, refunds: s.refunds, charges_details: s.charges_details,
  };
  const out = { ...p, ...over };
  if (out.id === null) out.id = Number(newPid());
  return out;
}
let nseq = 0;
function deliver(pid) {
  rpc(`mp_register_delivery('webhook', 'payment', 'payment', 'payment.updated', ${q(pid)}, NULL, 'N6T-x', ${q(JSON.stringify({ notification_id: `n6t-${++nseq}-${Date.now()}` }))}::jsonb, true)`);
  const rows = okAs(SVC, `SELECT delivery_id || '|' || claim_token || '|' || coalesce(resource_id, '-') FROM mp_claim_deliveries(50, 120);`)
    .split('\n').filter(Boolean).map((l) => l.split('|'));
  const mine = rows.find((r) => r[2] === String(pid));
  if (!mine) throw new Error('delivery not claimed');
  return { d: mine[0], tok: mine[1] };
}
const ingest = (pl, dl) => rpc(`mp_ingest_api_snapshot(${q(dl.d)}, ${q(dl.tok)}, ${q(String(pl.id))}, ${q(JSON.stringify(pl))}::jsonb)`);
const normalize = (src) => rpc(`mp_normalize_source(${q(src)})`);
function run(pl) {
  const dl = deliver(String(pl.id));
  const ing = ingest(pl, dl);
  const res = normalize(ing.source_record_id);
  return { dl, ing, res, pid: String(pl.id) };
}
const mv = (src) => owner(`SELECT coalesce(string_agg(concat_ws('|', movement_kind, gross_amount, fee_amount, tax_amount, net_amount, occurred_date), ';'), '-')
  FROM mp_financial_movement WHERE mp_source_record_id = ${q(src)};`);
const ident = (pid) => owner(`SELECT coalesce(string_agg(concat_ws('|', resource_type, resource_id, transition, transition_ref), ';'), '-') FROM mp_transition_identity WHERE resource_id = ${q(String(pid))};`);
const note = (src) => owner(`SELECT processing_status || '|' || coalesce(processing_note, '') FROM mp_source_record WHERE id = ${q(src)};`);

cleanup();
const before = counts();
const [mv0, id0, op0, po0, rec0, al0, rf0] = before.split('|').map(Number);

// ═════════════════════════════════════════════════════════════════════════════
section('S4', 'mp_ingest_api_snapshot');
{
  const pl = payload('A1');
  const dl = deliver(String(pl.id));
  check('S4-1 wrong claim token → CLAIM_LOST', raised(SVC(`SELECT mp_ingest_api_snapshot(${q(dl.d)}, gen_random_uuid(), ${q(String(pl.id))}, ${q(JSON.stringify(pl))}::jsonb);`), 'CLAIM_LOST'));
  check('S4-2 payload id ≠ payment id → PAYLOAD_ID_MISMATCH', raised(SVC(`SELECT mp_ingest_api_snapshot(${q(dl.d)}, ${q(dl.tok)}, '7771', ${q(JSON.stringify(pl))}::jsonb);`), 'PAYLOAD_ID_MISMATCH'));
  const badDate = { ...pl, date_approved: null, date_created: 'not-a-date' };
  check('S4-3 no valid date → PAYLOAD_DATE_INVALID', raised(SVC(`SELECT mp_ingest_api_snapshot(${q(dl.d)}, ${q(dl.tok)}, ${q(String(pl.id))}, ${q(JSON.stringify(badDate))}::jsonb);`), 'PAYLOAD_DATE_INVALID'));
  check('S4-4 authenticated cannot execute S4', denied(AUTH(`SELECT mp_ingest_api_snapshot(${q(dl.d)}, ${q(dl.tok)}, ${q(String(pl.id))}, ${q(JSON.stringify(pl))}::jsonb);`)));
  const ing = ingest(pl, dl);
  const src = owner(`SELECT source_type || '|' || external_id || '|' || occurred_at::TEXT || '|' || occurred_date || '|' || processing_status FROM mp_source_record WHERE id = ${q(ing.source_record_id)};`).split('|');
  const expExt = owner(`SELECT 'MPPAY:' || ${q(String(pl.id))} || ':' || left(encode(sha256(convert_to(${q(JSON.stringify(pl))}::jsonb::text, 'UTF8')), 'hex'), 32);`);
  const expAt = owner(`SELECT ${q(pl.date_approved)}::timestamptz::TEXT || '|' || (${q(pl.date_approved)}::timestamptz AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE;`).split('|');
  check('S4-5 created api_payment PENDING; external_id = MPPAY:<id>:<sha256(payload)[0:32]>; occurred_at = date_approved; occurred_date = BA date',
    ing.created === true && src[0] === 'api_payment' && src[1] === expExt && src[2] === expAt[0] && src[3] === expAt[1] && src[4] === 'PENDING', JSON.stringify({ ing, src, expExt, expAt }));
  const aud = owner(`SELECT count(*) || '|' || coalesce(string_agg(after_values::text, ';'), '') FROM audit_events WHERE entity_id = ${q(ing.source_record_id)} AND action = 'MP_SNAPSHOT_INGEST';`);
  check('S4-6 audit MP_SNAPSHOT_INGEST once, with source type and payment id only (no payload)',
    aud.startsWith('1|') && !aud.includes('transaction_amount') && !aud.includes('payer') && aud.includes(String(pl.id)), aud);

  // N-2 duplicate identical resource
  const again = ingest(pl, dl);
  check('N-2 identical payload → same source id, created = false; Δ source = 0',
    again.source_record_id === ing.source_record_id && again.created === false
      && owner(`SELECT count(*) FROM mp_source_record WHERE external_id LIKE 'MPPAY:${pl.id}:%';`) === '1');

  // N-1 valid approved payment (A1: collector withholding only)
  const r1 = normalize(ing.source_record_id);
  check('N-1 A1 → NORMALIZED; 1 movement payment 15000.00 / 0.00 / −90.00 / 14910.00 on the BA approval date',
    r1.processing_status === 'NORMALIZED' && r1.movements_created === 1 && mv(ing.source_record_id) === `payment|15000.00|0.00|-90.00|14910.00|${expAt[1]}`,
    JSON.stringify(r1) + ' ' + mv(ing.source_record_id));
  check("N-1 identity ('payment', id, 'APPROVAL', '') with the id as text", ident(pl.id) === `payment|${pl.id}|APPROVAL|`, ident(pl.id));
  check('N-1 replay of RPC 40 → ALREADY_PROCESSED', raised(SVC(`SELECT mp_normalize_source(${q(ing.source_record_id)});`), 'ALREADY_PROCESSED'));

  // N-3 changed version of the same payment
  const v2 = { ...pl, date_last_updated: '2026-01-16T09:00:00.000-04:00' };
  const dl2 = deliver(String(pl.id));
  const ing2 = ingest(v2, dl2);
  const eventBefore = owner(`SELECT md5(event_data::text) FROM mp_source_record WHERE id = ${q(ing.source_record_id)};`);
  const r2 = normalize(ing2.source_record_id);
  check('N-3 changed version → new immutable source; RPC 40 IGNORED NO_NEW_TRANSITION; Δ movement = 0; old version byte-identical',
    ing2.created && ing2.source_record_id !== ing.source_record_id && r2.processing_status === 'IGNORED' && note(ing2.source_record_id) === 'IGNORED|NO_NEW_TRANSITION'
      && r2.movements_created === 0 && mv(ing2.source_record_id) === '-' && owner(`SELECT md5(event_data::text) FROM mp_source_record WHERE id = ${q(ing.source_record_id)};`) === eventBefore
      && owner(`SELECT count(*) FROM mp_transition_identity WHERE resource_id = ${q(String(pl.id))};`) === '1', JSON.stringify(r2));
  check('N-3 raw columns stay immutable (guard)', !raw(`UPDATE mp_source_record SET event_data = '{}' WHERE id = ${q(ing.source_record_id)};`).ok);

  // H: refund evidence after an existing APPROVAL leaves the APPROVAL untouched
  const movBefore = mv(ing.source_record_id);
  const rf = run({ ...pl, refunds: [{ id: 1, amount: 10 }], transaction_amount_refunded: 10, status_detail: 'partially_refunded' });
  check('H / N-11 refund snapshot after APPROVAL → ERROR REFUND_UNSUPPORTED; APPROVAL movement unchanged; no api_refund source',
    rf.res.processing_status === 'ERROR' && note(rf.ing.source_record_id).startsWith('ERROR|REFUND_UNSUPPORTED') && mv(ing.source_record_id) === movBefore
      && mv(rf.ing.source_record_id) === '-' && owner(`SELECT count(*) FROM mp_source_record WHERE source_type = 'api_refund';`) === String(rf0), note(rf.ing.source_record_id));

  // I-b: dispute after APPROVAL keeps it untouched
  const dp = run({ ...pl, status: 'in_mediation', status_detail: 'in_process', date_last_updated: '2026-01-17T09:00:00.000-04:00' });
  check('N-13 in_mediation after APPROVAL → IGNORED NO_NEW_TRANSITION (dispute); APPROVAL untouched; Δ movement = 0',
    dp.res.processing_status === 'IGNORED' && note(dp.ing.source_record_id).startsWith('IGNORED|NO_NEW_TRANSITION: dispute') && mv(ing.source_record_id) === movBefore
      && mv(dp.ing.source_record_id) === '-', note(dp.ing.source_record_id));
}

// ═════════════════════════════════════════════════════════════════════════════
section('N', 'api_payment classification and amounts');
{
  // C: collector-paid fee included, payer-paid fee excluded (B)
  const base = payload('A2');
  const c = run({ ...base, transaction_amount: 100, transaction_details: { ...base.transaction_details, net_received_amount: 93, total_paid_amount: 101.5 },
    fee_details: [{ type: 'mercadopago_fee', amount: 5, fee_payer: 'collector' }, { type: 'financing_fee', amount: 1.5, fee_payer: 'payer' }] });
  check('C/B collector fee 5 → fee −5.00; payer fee 1.5 excluded; tax = 93 − 100 + 5 = −2.00',
    c.res.processing_status === 'NORMALIZED' && mv(c.ing.source_record_id).startsWith('payment|100.00|-5.00|-2.00|93.00|'), mv(c.ing.source_record_id) + ' ' + note(c.ing.source_record_id));

  // N-5 / D: positive residual tax
  const d = run({ ...payload('A1'), transaction_amount: 100, transaction_details: { net_received_amount: 100.01 }, fee_details: [] });
  check('N-5 / D residual tax > 0 (net 100.01 > gross 100) → ERROR SIGN_INVALID; Δ movement = 0',
    d.res.processing_status === 'ERROR' && note(d.ing.source_record_id).startsWith('ERROR|SIGN_INVALID: residual tax') && mv(d.ing.source_record_id) === '-', note(d.ing.source_record_id));
  const m3 = run({ ...payload('A1'), transaction_amount: 10.123 });
  check('N-5b amount with 3 decimals → ERROR MALFORMED_AMOUNT', note(m3.ing.source_record_id).startsWith('ERROR|MALFORMED_AMOUNT'), note(m3.ing.source_record_id));
  const mf = run({ ...payload('A1'), fee_details: [{ type: 'mercadopago_fee', amount: 5, fee_payer: 'somebody' }] });
  check('N-5c fee_details with an unknown fee_payer → ERROR MALFORMED_FEE_DETAILS', note(mf.ing.source_record_id).startsWith('ERROR|MALFORMED_FEE_DETAILS'), note(mf.ing.source_record_id));

  // N-6 unknown operation_type / currency
  const rp = run({ ...payload('A1'), operation_type: 'regular_payment' });
  const pos = run({ ...payload('A1'), operation_type: 'pos_payment' });
  const usd = run({ ...payload('A1'), currency_id: 'USD' });
  check('N-6 / N-14 regular_payment and pos_payment inbound → ERROR UNKNOWN_OPERATION_TYPE; USD → UNSUPPORTED_CURRENCY; Δ movement = 0',
    note(rp.ing.source_record_id).startsWith('ERROR|UNKNOWN_OPERATION_TYPE') && note(pos.ing.source_record_id).startsWith('ERROR|UNKNOWN_OPERATION_TYPE')
      && note(usd.ing.source_record_id).startsWith('ERROR|UNSUPPORTED_CURRENCY') && [rp, pos, usd].every((x) => mv(x.ing.source_record_id) === '-'));
  const nl = run({ ...payload('A1'), live_mode: false });
  const nc = run({ ...payload('A1'), collector_id: null });
  check('N-6b live_mode false → NOT_LIVE_MODE; missing collector → MISSING_COLLECTOR',
    note(nl.ing.source_record_id).startsWith('ERROR|NOT_LIVE_MODE') && note(nc.ing.source_record_id).startsWith('ERROR|MISSING_COLLECTOR'));

  // N-4 non-financial states
  const pend = run({ ...payload('A1'), status: 'pending', status_detail: 'pending_waiting_transfer', date_approved: null });
  const rej = run(payload('G1'));
  check('N-4 pending / rejected → IGNORED NO_FINANCIAL_TRANSITION; Δ movement = 0; occurred_at = date_created',
    note(pend.ing.source_record_id) === 'IGNORED|NO_FINANCIAL_TRANSITION: status pending' && note(rej.ing.source_record_id) === 'IGNORED|NO_FINANCIAL_TRANSITION: status rejected'
      && mv(pend.ing.source_record_id) === '-' && mv(rej.ing.source_record_id) === '-'
      && owner(`SELECT occurred_at = ${q(sample('G1').date_created)}::timestamptz FROM mp_source_record WHERE id = ${q(rej.ing.source_record_id)};`) === 't',
    `${note(pend.ing.source_record_id)} / ${note(rej.ing.source_record_id)}`);

  // APPROVAL-DATE: approved + accredited requires a valid date_approved; never date_created
  const ad1 = run({ ...payload('A1'), date_approved: null });
  check('APPROVAL-DATE-1 approved + accredited + date_approved NULL + valid date_created → ERROR DATE_MISMATCH; zero movement; zero APPROVAL identity',
    note(ad1.ing.source_record_id).startsWith('ERROR|DATE_MISMATCH: approved + accredited requires a valid date_approved')
      && mv(ad1.ing.source_record_id) === '-' && ident(ad1.pid) === '-'
      && owner(`SELECT occurred_at = ${q(sample('A1').date_created)}::timestamptz FROM mp_source_record WHERE id = ${q(ad1.ing.source_record_id)};`) === 't',
    note(ad1.ing.source_record_id));
  const ad2 = run({ ...payload('A1'), date_approved: 'not-a-timestamp' });
  const ad2b = run({ ...payload('A1'), date_approved: '2026-13-45T99:99:99.000-04:00' });
  check('APPROVAL-DATE-2 approved + accredited + malformed date_approved (bad format / impossible value) + valid date_created → ERROR DATE_MISMATCH; zero movement',
    [ad2, ad2b].every((x) => note(x.ing.source_record_id).startsWith('ERROR|DATE_MISMATCH: approved + accredited requires a valid date_approved')
      && mv(x.ing.source_record_id) === '-' && ident(x.pid) === '-'),
    `${note(ad2.ing.source_record_id)} / ${note(ad2b.ing.source_record_id)}`);
  const ad3p = run({ ...payload('A1'), status: 'pending', status_detail: 'pending_waiting_transfer', date_approved: null });
  const ad3r = run({ ...payload('G1'), date_approved: null });
  check('APPROVAL-DATE-3 pending / rejected + date_approved NULL + valid date_created → IGNORED NO_FINANCIAL_TRANSITION (unchanged); occurred_at = date_created',
    note(ad3p.ing.source_record_id) === 'IGNORED|NO_FINANCIAL_TRANSITION: status pending' && note(ad3r.ing.source_record_id) === 'IGNORED|NO_FINANCIAL_TRANSITION: status rejected'
      && mv(ad3p.ing.source_record_id) === '-' && mv(ad3r.ing.source_record_id) === '-'
      && owner(`SELECT bool_and(s.occurred_at = (s.event_data->>'date_created')::timestamptz) FROM mp_source_record s WHERE id IN (${q(ad3p.ing.source_record_id)}, ${q(ad3r.ing.source_record_id)});`) === 't',
    `${note(ad3p.ing.source_record_id)} / ${note(ad3r.ing.source_record_id)}`);

  // A: approved + status_detail ≠ accredited (no refund evidence)
  const pc = run({ ...payload('A1'), status_detail: 'pending_capture' });
  check('A / N-14 approved + pending_capture → no APPROVAL; ERROR UNKNOWN_STATUS; Δ movement = 0',
    note(pc.ing.source_record_id).startsWith('ERROR|UNKNOWN_STATUS: approved/pending_capture') && mv(pc.ing.source_record_id) === '-' && ident(pc.pid) === '-', note(pc.ing.source_record_id));
  const us = run({ ...payload('A1'), status: 'weird' });
  check('N-14b undocumented status → ERROR UNKNOWN_STATUS', note(us.ing.source_record_id).startsWith('ERROR|UNKNOWN_STATUS: weird'));

  // N-11 refund evidence variants on a first snapshot
  const variants = [
    ['refunds[] non-empty', { refunds: [{ id: 9, amount: 1 }] }],
    ['transaction_amount_refunded ≠ 0', { transaction_amount_refunded: 5 }],
    ["status 'refunded'", { status: 'refunded', status_detail: 'refunded' }],
    ['approved + partially_refunded', { status_detail: 'partially_refunded' }],
  ];
  for (const [label, over] of variants) {
    const x = run({ ...payload('A1'), ...over });
    const pid = x.pid;
    check(`N-11 ${label} → ERROR REFUND_UNSUPPORTED; no claim, no movement`,
      note(x.ing.source_record_id).startsWith('ERROR|REFUND_UNSUPPORTED') && mv(x.ing.source_record_id) === '-' && ident(pid) === '-', note(x.ing.source_record_id));
  }

  // I / N-13 dispute without approval
  const cb = run({ ...payload('A1'), status: 'charged_back', status_detail: 'settled' });
  const cbPid = cb.pid;
  check('I / N-13 charged_back first snapshot → ERROR DISPUTE_WITHOUT_APPROVAL; Δ movement = 0; no identity',
    note(cb.ing.source_record_id).startsWith('ERROR|DISPUTE_WITHOUT_APPROVAL') && mv(cb.ing.source_record_id) === '-' && ident(cbPid) === '-', note(cb.ing.source_record_id));

  // N-12 / J: real-shape fixtures, documented components only; taxes_amount / charges_details never read
  const exp = { A1: [15000, 0, -90, 14910], A2: [224000, 0, -1344, 222656], B1: [14000, 0, -84, 13916], C1: [10, 0, -0.06, 9.94], C2: [36000, 0, -216, 35784],
    D1: [468000, 0, -2808, 465192], E1: [15000, 0, -90, 14910], F1: [6500, 0, -39, 6461], H1: [200000, 0, 0, 200000] };
  const f2 = (n) => n.toFixed(2);
  for (const [label, [g, f, t, n]] of Object.entries(exp)) {
    const x = run(payload(label));
    check(`N-12 fixture ${label} (${sample(label).operation_type}) → payment ${f2(g)} / ${f2(f)} / ${f2(t)} / ${f2(n)}`,
      x.res.processing_status === 'NORMALIZED' && mv(x.ing.source_record_id).startsWith(`payment|${f2(g)}|${f2(f)}|${f2(t)}|${f2(n)}|`), mv(x.ing.source_record_id) + ' ' + note(x.ing.source_record_id));
  }
  const j = run({ ...payload('C2'), taxes_amount: 999999, charges_details: [{ type: 'fee', name: 'anything', accounts: { from: 'collector', to: 'mp' }, amounts: { original: 12345, refunded: 0 } }, 'garbage'] });
  check('J arbitrary taxes_amount / charges_details → the same movement as C2 (never read)',
    mv(j.ing.source_record_id).startsWith('payment|36000.00|0.00|-216.00|35784.00|'), mv(j.ing.source_record_id));

  // E / F / G
  const e = run({ ...payload('A1'), external_reference: null });
  const eAbsent = payload('A1'); delete eAbsent.external_reference;
  const e2 = run(eAbsent);
  check('E external_reference null or absent → NORMALIZED', e.res.processing_status === 'NORMALIZED' && e2.res.processing_status === 'NORMALIZED');
  const fStr = run({ ...payload('A1'), payer: { id: '800000123' } });
  const fNone = payload('A1'); delete fNone.payer;
  const f3 = run(fNone);
  check('F payer.id digit string accepted as opaque text; absent payer does not block', fStr.res.processing_status === 'NORMALIZED' && f3.res.processing_status === 'NORMALIZED');
  const g = run(payload('E1'));
  check('G account_fund inbound → NORMALIZED payment; Δ client allocation = 0',
    g.res.processing_status === 'NORMALIZED' && owner('SELECT count(*) FROM mp_client_allocation;') === String(al0));

  // N-9 at Step 6: forged direct inserts are rejected by derivation (the RLS denial is Step 9 / 0051)
  const fp = payload('A1');
  const forged = owner(`INSERT INTO mp_source_record (source_type, external_id, event_data, occurred_at, occurred_date)
    VALUES ('api_payment', 'N6T-forged-1', ${q(JSON.stringify(fp))}::jsonb, ${q(fp.date_approved)}::timestamptz, (${q(fp.date_approved)}::timestamptz AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE) RETURNING id;`);
  const fr = normalize(forged);
  const goodExt = owner(`SELECT 'MPPAY:' || ${q(String(fp.id))} || ':' || left(encode(sha256(convert_to(${q(JSON.stringify(fp))}::jsonb::text, 'UTF8')), 'hex'), 32);`);
  const forged2 = owner(`INSERT INTO mp_source_record (source_type, external_id, event_data, occurred_at, occurred_date)
    VALUES ('api_payment', ${q(goodExt)}, ${q(JSON.stringify(fp))}::jsonb, '2020-01-01T00:00:00Z', '2020-01-01') RETURNING id;`);
  const fr2 = normalize(forged2);
  check('N-9 (Step-6 scope) forged external_id → ERROR IDENTITY_MISMATCH; forged occurred_at → ERROR DATE_MISMATCH; Δ movement = 0',
    note(forged).startsWith('ERROR|IDENTITY_MISMATCH') && note(forged2).startsWith('ERROR|DATE_MISMATCH') && mv(forged) === '-' && mv(forged2) === '-',
    `${note(forged)} / ${note(fr2.source_record_id)}`);

  // api_refund stays unsupported
  const ar = owner(`INSERT INTO mp_source_record (source_type, external_id, event_data, occurred_at, occurred_date)
    VALUES ('api_refund', 'N6T-ref-1', '{}'::jsonb, NOW(), CURRENT_DATE) RETURNING id;`);
  const arr = normalize(ar);
  check('api_refund → ERROR UNSUPPORTED_SOURCE_TYPE (refunds fail closed)', arr.processing_status === 'ERROR' && note(ar).startsWith('ERROR|UNSUPPORTED_SOURCE_TYPE'));
}

// ═════════════════════════════════════════════════════════════════════════════
section('Z', 'No Step-7 effect');
{
  const [mv1, , op1, po1, rec1, al1, rf1] = counts().split('|').map(Number);
  check('Z-1 Δ financial_operation = Δ financial_posting = Δ mp_reconciliation = Δ mp_client_allocation = 0',
    op1 === op0 && po1 === po0 && rec1 === rec0 && al1 === al0, `${op1 - op0}/${po1 - po0}/${rec1 - rec0}/${al1 - al0}`);
  check('Z-2 no api_refund source was created by normalization (only the one test insert)', rf1 === rf0 + 1, `${rf1 - rf0}`);
  check('Z-3 movements were created only by approved payments', mv1 > mv0);
  // Step 7 (0051) adds A1; normalization itself must still never apply: every normalized test source stays NORMALIZED
  check('Z-4 normalization never applies: no reconciliation for any test movement, and every normalized test source is still NORMALIZED (not RECONCILED)',
    owner(`SELECT count(*) FROM mp_reconciliation r JOIN mp_financial_movement m ON m.id = r.mp_financial_movement_id JOIN mp_source_record s ON s.id = m.mp_source_record_id WHERE s.external_id LIKE 'MPPAY:777%';`) === '0'
      && owner(`SELECT count(*) FROM mp_source_record WHERE external_id LIKE 'MPPAY:777%' AND processing_status = 'RECONCILED';`) === '0');
}

cleanup();
console.log(`\n  ══ MP PAYMENT NORMALIZATION RESULT: ${pass} passed, ${fail} failed ══\n`);
if (fail) console.log(failures.map((f) => `   - ${f}`).join('\n'));
process.exit(fail === 0 ? 0 : 1);
