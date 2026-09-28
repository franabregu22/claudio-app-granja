#!/usr/bin/env node
/**
 * ADR-006 — MERCADO PAGO REAL-TIME, PRE-V-2 SUITE (Steps 1–2: 0047 + 0048). LOCAL TEST DATABASE ONLY.
 *
 * Covers the objects that exist before V-1 / V-2 (ADR006_TEST_MATRIX_V1):
 *   schema (0047), delivery identity (N-SHA, natural key, bounded conflict key), queue
 *   (SKIP LOCKED claims, lease recovery, CONFIG_BLOCKED, requeue, RELEASE, RETRY), chargeback
 *   SIGNALS (no financial effect), optional client attribution (C1–C7), RPC 40 csv_import
 *   (DEFERRED_V4, report-only identity), report evidence (R1, R3, R4), and the Step-2
 *   security perimeter.
 *
 * No api_payment payload and no V-2 field is used anywhere. Receipts for attribution tests
 * are OWNER-created fixture movements (a csv_import source, a payment movement, a payment
 * APPROVAL identity and the three applied treasury components), exactly the state that
 * mp_apply_transition (0050) will produce; they never exercise webhook or API code.
 * Final RLS (0051) is NOT tested here.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *     node scripts/target-db/mp_realtime.test.mjs
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { assertSafeDestructiveTarget } from '../test-env/guard.mjs';

function resolveDockerBin() {
  if (process.env.DOCKER_BIN) return process.env.DOCKER_BIN;
  const onPath = spawnSync('docker', ['--version'], { encoding: 'utf8' });
  if (!onPath.error && onPath.status === 0) return 'docker';
  const c = resolve(process.env.LOCALAPPDATA ?? '', 'Programs', 'DockerDesktop', 'resources', 'bin', 'docker.exe');
  return existsSync(c) ? c : 'docker';
}
const DOCKER = resolveDockerBin();

const ADMIN_UID = '11111111-1111-1111-1111-111111111111';
const OPA = '22222222-2222-2222-2222-222222222222';
const TAG = 'RT6-TEST';
const NEW_TABLES = ['mp_attribution_flag', 'mp_client_allocation', 'mp_payer_client_map', 'mp_report_match',
  'mp_transition_identity', 'mp_webhook_delivery'];
const BASELINE_DEFINERS = ['assert_period_open', 'assign_flock_feed', 'assign_freight_to_purchase', 'cancel_order',
  'cancel_supplier_instrument', 'clear_cheque', 'close_sales_session', 'current_app_role', 'deliver_order', 'deposit_cheque',
  'endorse_cheque', 'issue_supplier_instrument', 'mark_supplier_instrument_debited', 'mp_normalize_source', 'mp_reconcile_movement',
  'open_sales_session', 'pay_fiscal_obligation', 'pay_supplier', 'receive_cheque', 'rectify_daily_production',
  'rectify_delivered_order', 'rectify_mortality', 'rectify_purchase', 'register_classification', 'register_collection',
  'register_count_adjustment', 'register_daily_production', 'register_feed_inventory_count', 'register_feed_manufacturing',
  'register_feed_movement', 'register_fiscal_document', 'register_fiscal_obligation', 'register_freight',
  'register_management_event', 'register_mortality', 'register_purchase', 'register_session_cash_event',
  'register_session_movement', 'reject_cheque', 'reject_supplier_instrument', 'transfer_between_accounts'];
// Step-2 definers by design (ADR006_TEST_MATRIX_V1 §INV checkpoint "after 0048")
const STEP2_DEFINERS = {
  mp_register_delivery: 'service_role', mp_claim_deliveries: 'service_role', mp_delivery_transition: 'service_role',
  mp_requeue_config_blocked: 'authenticated,service_role', mp_request_refetch: 'authenticated',
  mp_resolve_chargeback_signal: 'authenticated', mp_allocate_to_client: 'authenticated', mp_auto_allocate: 'service_role',
  mp_reverse_client_allocation: 'authenticated', mp_flag_for_attribution: 'authenticated', mp_clear_attribution_flag: 'authenticated',
  mp_map_payer_to_client: 'authenticated', mp_unmap_payer: 'authenticated', mp_resolve_match: 'authenticated',
  mp_check_report_coverage: 'service_role', mp_record_balance_check: 'service_role',
};
const INVOKER_HELPERS = ['mp_is_auto_applicable', 'mp_v4_verified', 'mp_parse_report_row', 'mp_delivery_immutable_guard', 'mp_report_match_guard'];

let container;
let pass = 0;
let fail = 0;
const failures = [];

function dockerRun(args, input) {
  const r = spawnSync(DOCKER, args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`docker: ${r.error.message}`);
  return r;
}
const PSQL = ['psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'];
function raw(sqlText) {
  const r = dockerRun(['exec', '-i', container, ...PSQL], sqlText);
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
function owner(sqlText) {
  const r = raw(sqlText);
  if (!r.ok) throw new Error(`owner SQL failed:\n${sqlText}\n${r.err}`);
  return r.out;
}
const esc = (s) => String(s).replace(/'/g, "''");
const q = (v) => (v === null || v === undefined ? 'NULL' : `'${esc(v)}'`);
const sessionSql = (pgRole, claims, sqlText) => `
BEGIN;
SET LOCAL ROLE ${pgRole};
SET LOCAL "request.jwt.claims" = '${esc(JSON.stringify(claims))}';
${sqlText}
COMMIT;`;
const asRole = (pgRole, claims, sqlText) => raw(sessionSql(pgRole, claims, sqlText));
const ADMIN = (s) => asRole('authenticated', { sub: ADMIN_UID, role: 'authenticated' }, s);
const OPER = (s) => asRole('authenticated', { sub: OPA, role: 'authenticated' }, s);
const SVC = (s) => asRole('service_role', { role: 'service_role' }, s);
const ANON = (s) => asRole('anon', { role: 'anon' }, s);
const ROLE_SQL = {
  admin: (s) => sessionSql('authenticated', { sub: ADMIN_UID, role: 'authenticated' }, s),
  svc: (s) => sessionSql('service_role', { role: 'service_role' }, s),
};

function session(sqlText, appName) {
  return new Promise((done) => {
    const p = spawn(DOCKER, ['exec', '-i', '-e', `PGAPPNAME=${appName}`, container, ...PSQL]);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => done({ ok: code === 0, out: out.trim(), err: err.trim() }));
    p.stdin.end(sqlText);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(condSql, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (owner(condSql) === 't') return true;
    await sleep(100);
  }
  return false;
}

function okAs(fn, sqlText) {
  const r = fn(sqlText);
  if (!r.ok) throw new Error(`SQL failed:\n${sqlText}\n${r.err}`);
  return r.out;
}
const rpcAs = (fn, call) => JSON.parse(okAs(fn, `SELECT ${call};`));
const firstErr = (r) => (r.err.split('\n').find((l) => /ERROR/.test(l)) || r.err.split('\n')[0] || '').slice(0, 200);
const denied = (r) => !r.ok && /permission denied/i.test(r.err);
const raised = (r, code) => !r.ok && new RegExp(`ERROR:\\s+${code}`).test(r.err);

function check(label, condition, detail) {
  if (condition) {
    pass += 1;
    console.log(`    OK   ${label}`);
  } else {
    fail += 1;
    failures.push({ label, detail });
    console.log(`    MAL  ${label}${detail !== undefined ? ` :: ${detail}` : ''}`);
  }
}
function section(n, title) {
  console.log(`\n  ── ${n}. ${title} ${'─'.repeat(Math.max(0, 54 - title.length))}`);
}

// ── guard, container ───────────────────────────────────────────────────────
const target = assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);
container = (dockerRun(['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}']).stdout || '')
  .trim().split('\n').filter(Boolean)[0];
if (!container) {
  console.error('  no running supabase_db container. Run `supabase start`.');
  process.exit(1);
}
const mapping = (dockerRun(['port', container, '5432/tcp']).stdout || '').trim();
if (!mapping.includes(`:${target.port}`)) {
  console.error(`  container mapping ${mapping} does not match guarded port ${target.port}`);
  process.exit(1);
}
console.log(`  container: ${container}`);

// ── fixture lifecycle (OWNER-only teardown, FK order derived from 0047) ─────
function cleanup() {
  owner(`
CREATE TEMP TABLE _src AS SELECT id FROM mp_source_record WHERE external_id LIKE '${TAG}%';
CREATE TEMP TABLE _mv  AS SELECT id FROM mp_financial_movement WHERE mp_source_record_id IN (SELECT id FROM _src);
CREATE TEMP TABLE _cli AS SELECT id FROM clients WHERE nombre LIKE '${TAG}%';
CREATE TEMP TABLE _op  AS SELECT id FROM financial_operation WHERE external_ref LIKE 'MP:${TAG}%'
                    UNION SELECT financial_operation_id FROM mp_reconciliation WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
CREATE TEMP TABLE _al  AS SELECT id, client_ledger_id FROM mp_client_allocation WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
CREATE TEMP TABLE _dl  AS SELECT id FROM mp_webhook_delivery
  WHERE resource_id LIKE '9%' OR resource_id LIKE 'rt6%' OR report_source_id IN (SELECT id FROM _src) OR source_record_id IN (SELECT id FROM _src);
DELETE FROM audit_events WHERE entity_type IN ('mp_client_allocation') AND entity_id IN (SELECT id::TEXT FROM _al);
DELETE FROM mp_client_allocation WHERE id IN (SELECT id FROM _al) AND reversal_of_id IS NOT NULL;
DELETE FROM mp_client_allocation WHERE id IN (SELECT id FROM _al);
DELETE FROM client_ledger WHERE id IN (SELECT client_ledger_id FROM _al) OR cliente_id IN (SELECT id FROM _cli);
DELETE FROM audit_events WHERE entity_type = 'mp_attribution_flag'
   AND entity_id IN (SELECT id::TEXT FROM mp_attribution_flag WHERE mp_financial_movement_id IN (SELECT id FROM _mv));
DELETE FROM mp_attribution_flag WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
DELETE FROM audit_events WHERE entity_type = 'mp_payer_client_map'
   AND entity_id IN (SELECT id::TEXT FROM mp_payer_client_map WHERE cliente_id IN (SELECT id FROM _cli));
DELETE FROM mp_payer_client_map WHERE cliente_id IN (SELECT id FROM _cli);
DELETE FROM audit_events WHERE entity_type = 'mp_report_match';
DELETE FROM mp_report_match WHERE report_source_id IN (SELECT id FROM _src)
   OR transition_id IN (SELECT id FROM mp_transition_identity WHERE mp_financial_movement_id IN (SELECT id FROM _mv));
DELETE FROM audit_events WHERE entity_type = 'mp_webhook_delivery';
DELETE FROM mp_webhook_delivery WHERE (key_conflict_of IN (SELECT id FROM _dl) OR triggered_by_delivery_id IN (SELECT id FROM _dl));
DELETE FROM mp_webhook_delivery WHERE id IN (SELECT id FROM _dl);
DELETE FROM mp_transition_identity WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
DELETE FROM mp_reconciliation WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
DELETE FROM financial_posting WHERE financial_operation_id IN (SELECT id FROM _op);
DELETE FROM financial_operation WHERE id IN (SELECT id FROM _op);
DELETE FROM mp_financial_movement WHERE id IN (SELECT id FROM _mv);
DELETE FROM audit_events WHERE entity_type = 'mp_source_record' AND entity_id IN (SELECT id::TEXT FROM _src);
DELETE FROM mp_source_record WHERE id IN (SELECT id FROM _src);
DELETE FROM clients WHERE id IN (SELECT id FROM _cli);
DROP TABLE _src, _mv, _cli, _op, _al, _dl;`);
}

cleanup();
owner(`
INSERT INTO auth.users (id, is_sso_user, is_anonymous) VALUES ('${ADMIN_UID}', false, false), ('${OPA}', false, false)
ON CONFLICT (id) DO NOTHING;
INSERT INTO perfiles (id, email, rol_type, activo) VALUES
  ('${ADMIN_UID}', 'admin@test.local', 'ADMIN', true), ('${OPA}', 'operator@test.local', 'OPERATOR', true)
ON CONFLICT (id) DO NOTHING;`);

const MPACC = owner(`SELECT id FROM financial_account WHERE nombre = 'Mercado Pago';`);
const CX = owner(`INSERT INTO clients (nombre) VALUES ('${TAG} Cliente X') RETURNING id;`);
const CY = owner(`INSERT INTO clients (nombre) VALUES ('${TAG} Cliente Y') RETURNING id;`);
const CZ = owner(`INSERT INTO clients (nombre, activo) VALUES ('${TAG} Cliente Z', false) RETURNING id;`);

// financial / ledger fingerprint: proves "no financial effect"
const money = () => owner(`SELECT concat_ws('|', (SELECT count(*) FROM financial_operation), (SELECT count(*) FROM financial_posting),
  (SELECT count(*) FROM mp_reconciliation), (SELECT count(*) FROM mp_financial_movement), (SELECT count(*) FROM collections),
  (SELECT count(*) FROM client_ledger), (SELECT count(*) FROM mp_client_allocation));`);

// ── OWNER receipt fixture: the state mp_apply_transition (0050) will produce (no API payload) ──
let pidSeq = 0;
function receipt({ gross = 100, fee = -5, tax = -2, date = '2026-10-05', applied = true } = {}) {
  const pid = `9${String(Date.now() % 1e9).padStart(9, '0')}${String(++pidSeq).padStart(3, '0')}`;
  const net = gross + fee + tax;
  const ext = `${TAG}-${pid}:payment:C`;
  const src = owner(`INSERT INTO mp_source_record (source_type, external_id, event_data, occurred_at, occurred_date, processing_status, processed_at)
    VALUES ('csv_import', '${ext}', '{"fixture":"owner receipt"}'::jsonb, '${date}T12:00:00-03:00', '${date}', 'NORMALIZED', NOW()) RETURNING id;`);
  const mv = owner(`INSERT INTO mp_financial_movement (mp_source_record_id, movement_kind, gross_amount, fee_amount, tax_amount, net_amount, occurred_date)
    VALUES ('${src}', 'payment', ${gross}, ${fee}, ${tax}, ${net}, '${date}') RETURNING id;`);
  const t = owner(`INSERT INTO mp_transition_identity (resource_type, resource_id, transition, claimed_by_source_id, mp_financial_movement_id)
    VALUES ('payment', '${pid}', 'APPROVAL', '${src}', ${mv}) RETURNING id;`);
  if (applied) {
    for (const [k, type, amt] of [['SETTLE', 'MP_SETTLEMENT', gross], ['FEE', 'FEE', fee], ['TAX', 'ADJUSTMENT', tax]]) {
      if (amt === 0) continue;
      const key = `MPA:${t}:${k}`;
      const op = owner(`INSERT INTO financial_operation (operation_type, effective_date, external_ref, source_entity_type, source_entity_id, reason)
        VALUES ('${type}', '${date}', 'MP:${TAG}:${key}', 'mp_financial_movement', '${mv}', 'fixture') RETURNING id;`);
      owner(`INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date) VALUES (${op}, '${MPACC}', ${amt}, '${date}');`);
      owner(`INSERT INTO mp_reconciliation (mp_financial_movement_id, financial_operation_id, financial_account_id, assigned_amount, idempotency_key)
        VALUES (${mv}, ${op}, '${MPACC}', ${amt}, '${key}');`);
    }
    owner(`UPDATE mp_source_record SET processing_status = 'RECONCILED' WHERE id = '${src}';`);
  }
  return { pid, src, mv, t };
}
let keySeq = 0;
const newKey = () => `${TAG}:${String(++keySeq).padStart(4, '0')}`;
const nsha = (origin, cls, topic, action, rid, payload) => owner(`SELECT encode(sha256(convert_to((jsonb_build_array(
  ${q(origin)}::TEXT, ${q(cls)}::TEXT, ${q(topic)}::TEXT, ${q(action)}::TEXT, ${q(rid)}::TEXT, ${q(JSON.stringify(payload ?? {}))}::jsonb))::text, 'UTF8')), 'hex');`);
const register = (o) => rpcAs(SVC, `mp_register_delivery(${q(o.origin ?? 'webhook')}, ${q(o.topic ?? 'payment')}, ${q(o.cls ?? 'payment')}, ${q(o.action ?? null)},
  ${q(o.rid ?? null)}, ${q(o.nid ?? null)}, ${q(o.xrid ?? null)}, ${o.payload === undefined ? 'NULL' : `${q(JSON.stringify(o.payload))}::jsonb`}, ${o.sig ?? true})`);
const dRow = (id) => owner(`SELECT delivery_key || '|' || status || '|' || attempts || '|' || coalesce(key_conflict_of::TEXT, '-') || '|' || coalesce(x_request_id, '-')
  FROM mp_webhook_delivery WHERE id = '${id}';`);
const transition = (fn, d, tok, outcome, src = null, code = null, detail = null, retry = null, link = null) =>
  fn(`SELECT mp_delivery_transition(${q(d)}, ${q(tok)}, ${q(outcome)}, ${q(src)}, ${q(code)}, ${q(detail)}, ${retry === null ? 'NULL' : retry}, ${q(link)});`);
const claim = (limit = 50) => okAs(SVC, `SELECT delivery_id || '|' || claim_token || '|' || origin || '|' || topic_class || '|' || topic || '|' || coalesce(resource_id, '-') || '|' || attempts
  FROM mp_claim_deliveries(${limit}, 120);`).split('\n').filter(Boolean).map((l) => {
  const [id, token, origin, cls, topic, rid, attempts] = l.split('|');
  return { id, token, origin, cls, topic, rid, attempts: Number(attempts) };
});

let r;
let x;

try {
// ═══════════════════════════════════════════════════════════════════════════
section('S', 'Schema (0047)');

check('S1 the six ADR-006 tables exist, all with RLS enabled',
  owner(`SELECT string_agg(relname || ':' || relrowsecurity, ',' ORDER BY relname) FROM pg_class
          WHERE relnamespace = 'public'::regnamespace AND relname IN (${NEW_TABLES.map(q).join(',')});`)
  === NEW_TABLES.map((t) => `${t}:true`).join(','));
check('S2 the two ADR-006 enums exist with the exact labels',
  owner(`SELECT string_agg(t.typname || '=' || (SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid), ' ' ORDER BY t.typname)
          FROM pg_type t WHERE t.typname IN ('mp_delivery_status','mp_match_outcome');`)
  === 'mp_delivery_status=RECEIVED,PROCESSING,FETCHED,SIGNAL_RECORDED,FAILED_RETRYABLE,FAILED_PERMANENT,CONFIG_BLOCKED,UNSUPPORTED mp_match_outcome=MATCHED,DISCREPANCY,REPORT_ONLY,MISSING_IN_REPORT,BALANCE_CHECK');
const cons = owner(`SELECT string_agg(conname, ',' ORDER BY conname) FROM pg_constraint
  WHERE conrelid IN (${NEW_TABLES.map((t) => `'${t}'::regclass`).join(',')}) AND contype IN ('c','u');`);
const wantCons = ['chk_alloc_amount_nonzero', 'chk_alloc_manual_reason', 'chk_alloc_mode', 'chk_alloc_mp_reversal', 'chk_alloc_origin',
  'chk_alloc_reversal_link', 'chk_alloc_sign', 'chk_delivery_attempts', 'chk_delivery_backfill_ref', 'chk_delivery_config_blocked',
  'chk_delivery_fetched', 'chk_delivery_origin', 'chk_delivery_payload_keys', 'chk_delivery_payment_resource', 'chk_delivery_processing',
  'chk_delivery_signal_resolution', 'chk_delivery_signal_status', 'chk_delivery_signature', 'chk_delivery_topic_class', 'chk_delivery_trigger_ref',
  'chk_flag_clear_set', 'chk_flag_reason', 'chk_match_coverage', 'chk_match_exception', 'chk_match_resolution_only_exception',
  'chk_match_resolution_set', 'chk_match_resolution_value', 'chk_match_shape', 'chk_payer_deactivation', 'chk_payer_id_format',
  'chk_transition_kind', 'chk_transition_payment_id', 'chk_transition_ref', 'chk_transition_resource_type',
  'mp_client_allocation_client_ledger_id_key', 'mp_client_allocation_idempotency_key_key', 'mp_transition_identity_mp_financial_movement_id_key',
  'mp_webhook_delivery_delivery_key_key', 'uq_match_report_outcome', 'uq_mp_transition'];
check('S3 exact CHECK / UNIQUE constraint set on the six tables', cons === wantCons.join(','), cons);
check('S4 partial unique / queue indexes exist',
  owner(`SELECT string_agg(indexname, ',' ORDER BY indexname) FROM pg_indexes WHERE indexname IN ('uq_match_missing','uq_payer_active','uq_flag_open',
         'idx_mp_delivery_due','idx_mp_delivery_lease','idx_mp_delivery_config_blocked','idx_mp_delivery_resource');`)
  === 'idx_mp_delivery_config_blocked,idx_mp_delivery_due,idx_mp_delivery_lease,idx_mp_delivery_resource,uq_flag_open,uq_match_missing,uq_payer_active');
check('S5 no stored balance / remaining / attributed-total column on the ADR-006 tables',
  owner(`SELECT count(*) FROM information_schema.columns WHERE table_name IN (${NEW_TABLES.map(q).join(',')})
          AND column_name ~* '(balance|saldo|remaining|total|attributed)';`) === '0');
check('S6 no speculative API / V-2 column on the ADR-006 tables or on existing MP tables',
  owner(`SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
          AND table_name IN (${[...NEW_TABLES, 'mp_source_record', 'mp_financial_movement', 'mp_reconciliation'].map(q).join(',')})
          AND column_name ~* '(transaction_amount|net_received|fee_details|date_approved|date_last_updated|external_reference|payer|collector|currency|operation_type|refund)'
          AND NOT (table_name = 'mp_payer_client_map' AND column_name = 'mp_payer_id');`) === '0');
check('S7 no application-role privilege on the six tables before 0051 (fail-closed)',
  owner(`SELECT count(*) FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
          WHERE c.relname IN (${NEW_TABLES.map(q).join(',')}) AND a.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role'));`) === '0'
  && [ADMIN, OPER, SVC, ANON].every((fn) => denied(fn(`SELECT count(*) FROM mp_webhook_delivery;`))));
x = raw(`BEGIN; INSERT INTO mp_webhook_delivery (delivery_key, notification_sha256, origin, topic, topic_class, resource_id, signature_verified)
  VALUES ('h:rt6-guard', repeat('a', 64), 'webhook', 'payment', 'payment', '123', true); UPDATE mp_webhook_delivery SET resource_id = '124' WHERE delivery_key = 'h:rt6-guard'; ROLLBACK;`);
const xm = raw(`BEGIN; INSERT INTO mp_report_match (outcome, report_source_id, transition_id, detail, is_exception)
  SELECT 'BALANCE_CHECK', id, NULL, '{"difference": 1}', true FROM mp_source_record LIMIT 0; ROLLBACK;`);
check('S8 immutability guard on mp_webhook_delivery raises even for the owner', !x.ok && /notification identity is immutable/.test(x.err) && xm.ok, firstErr(x));
const chkCases = [
  ['non-numeric payment resource', `('h:rt6-c1', repeat('a',64), 'webhook','payment','payment','abc', true, '{}', 'RECEIVED')`],
  ['payer data in the reduced payload', `('h:rt6-c2', repeat('a',64), 'webhook','payment','payment','1', true, '{"payer_email":"x"}', 'RECEIVED')`],
  ['unverified webhook', `('h:rt6-c3', repeat('a',64), 'webhook','payment','payment','1', false, '{}', 'RECEIVED')`],
  ['chargeback delivery FETCHED', `('h:rt6-c4', repeat('a',64), 'webhook','chargeback','chargeback','c1', true, '{}', 'FETCHED')`],
  ['CONFIG_BLOCKED without AUTH_CONFIGURATION_ERROR', `('h:rt6-c5', repeat('a',64), 'webhook','payment','payment','1', true, '{}', 'CONFIG_BLOCKED')`],
  ['payment delivery with a NULL resource id', `('h:rt6-c6', repeat('a',64), 'webhook','payment','payment',NULL, true, '{}', 'RECEIVED')`],
];
for (const [what, vals] of chkCases) {
  x = raw(`BEGIN; INSERT INTO mp_webhook_delivery (delivery_key, notification_sha256, origin, topic, topic_class, resource_id, signature_verified, notification_payload, status) VALUES ${vals}; ROLLBACK;`);
  check(`S9 CHECK rejects: ${what}`, !x.ok && /violates check constraint/.test(x.err), firstErr(x));
}

// ═══════════════════════════════════════════════════════════════════════════
section('W', 'Delivery identity (S1): N-SHA, natural key, bounded conflict key');

const P1 = { type: 'payment', action: 'payment.created', data_id: '900001' };
const w1 = register({ rid: '900001', action: 'payment.created', nid: 'rt6-n1', xrid: 'rt6-xr-1', payload: P1 });
check('W1 notification with a documented id → natural key n:payment:<id>; x-request-id stored for traceability only',
  w1.created === true && dRow(w1.delivery_id) === `n:payment:rt6-n1|RECEIVED|0|-|rt6-xr-1`, dRow(w1.delivery_id));
const w2 = register({ rid: '900001', action: 'payment.created', nid: 'rt6-n1', xrid: 'rt6-xr-2', payload: P1 });
check('W2 same notification retried with a DIFFERENT x-request-id → same delivery, no new row (x-request-id is not identity)',
  w2.created === false && w2.delivery_id === w1.delivery_id);
const w2b = register({ rid: '900001', action: 'payment.created', nid: 'rt6-n1', xrid: 'rt6-xr-1', payload: P1 });
check('W2b same notification retried with the same x-request-id → no new row', w2b.created === false && w2b.delivery_id === w1.delivery_id);
const shaW1 = owner(`SELECT notification_sha256 FROM mp_webhook_delivery WHERE id = '${w1.delivery_id}';`);
check('W3 stored notification_sha256 equals an independent SQL evaluation of the frozen N-SHA formula',
  shaW1 === nsha('webhook', 'payment', 'payment', 'payment.created', '900001', P1));
const w2c = register({ rid: '900002', action: 'payment.updated', nid: 'rt6-n1', payload: { type: 'payment', action: 'payment.updated', data_id: '900002' } });
const ck = owner(`SELECT delivery_key || '|' || length(delivery_key) || '|' || key_conflict_of FROM mp_webhook_delivery WHERE id = '${w2c.delivery_id}';`);
const expCk = `conflict:${createHash('sha256').update(`n:payment:rt6-n1:${nsha('webhook', 'payment', 'payment', 'payment.updated', '900002', { type: 'payment', action: 'payment.updated', data_id: '900002' })}`).digest('hex')}`;
check('W4 same natural key, different content → separate conflict row, key = conflict:sha256(original key:new hash), length 73, key_conflict_of = original',
  w2c.created === true && w2c.key_conflict === true && ck === `${expCk}|73|${w1.delivery_id}`, ck);
const w2d = register({ rid: '900002', action: 'payment.updated', nid: 'rt6-n1', payload: { type: 'payment', action: 'payment.updated', data_id: '900002' } });
check('W5 the same conflicting notification replayed → same conflict row, no new row, no unique violation',
  w2d.created === false && w2d.key_conflict === true && w2d.delivery_id === w2c.delivery_id);
const w2e = register({ rid: '900003', action: 'payment.updated', nid: 'rt6-n1', payload: { type: 'payment', action: 'payment.updated', data_id: '900003' } });
check('W6 a second, different conflicting content → a distinct conflict row, still pointing at the ORIGINAL natural-key row (no chaining)',
  w2e.created === true && w2e.delivery_id !== w2c.delivery_id
  && owner(`SELECT key_conflict_of FROM mp_webhook_delivery WHERE id = '${w2e.delivery_id}';`) === w1.delivery_id);
const reordered = register({ rid: '900010', action: 'payment.created', payload: { data_id: '900010', action: 'payment.created', type: 'payment' } });
const reordered2 = register({ rid: '900010', action: 'payment.created', payload: { type: 'payment', action: 'payment.created', data_id: '900010' } });
check('W7 hash fallback key h:<sha> when no notification id; payload JSON key order does not change N-SHA',
  owner(`SELECT delivery_key FROM mp_webhook_delivery WHERE id = '${reordered.delivery_id}';`).startsWith('h:')
  && reordered2.created === false && reordered2.delivery_id === reordered.delivery_id);
check('W8 NULL action and empty-string action hash differently (JSON null ≠ "")',
  nsha('webhook', 'payment', 'payment', null, '900011', {}) !== nsha('webhook', 'payment', 'payment', '', '900011', {}));
const longId = 'x'.repeat(121);
const wl = register({ rid: '900012', action: 'payment.created', nid: longId, payload: { data_id: '900012' } });
check('W9 notification id outside ^[A-Za-z0-9._:-]{1,120}$ → hash fallback key; every stored key ≤ 200 characters',
  owner(`SELECT delivery_key FROM mp_webhook_delivery WHERE id = '${wl.delivery_id}';`).startsWith('h:')
  && owner(`SELECT coalesce(max(length(delivery_key)), 0) <= 200 FROM mp_webhook_delivery;`) === 't');
const wu = register({ topic: 'merchant_order', cls: 'unsupported', rid: 'rt6-mo-1', payload: { type: 'merchant_order' } });
check('W10 unsupported topic → stored UNSUPPORTED', owner(`SELECT status FROM mp_webhook_delivery WHERE id = '${wu.delivery_id}';`) === 'UNSUPPORTED');
r = SVC(`SELECT mp_register_delivery('report_backfill', 'payment', 'payment', NULL, '1', NULL, NULL, '{}'::jsonb, false);`);
const rBad = SVC(`SELECT mp_register_delivery('webhook', 'payment', 'payment', NULL, 'abc', NULL, NULL, '{}'::jsonb, true);`);
check('W11 origin other than webhook / chargeback_refresh → INVALID_DELIVERY; a CHECK failure maps to INVALID_DELIVERY',
  raised(r, 'INVALID_DELIVERY') && raised(rBad, 'INVALID_DELIVERY'), `${firstErr(r)} | ${firstErr(rBad)}`);
check('W12 register audits exactly the created rows (no audit on duplicates)',
  owner(`SELECT count(*) FROM audit_events WHERE action = 'MP_DELIVERY_REGISTER';`)
  === owner(`SELECT count(*) FROM mp_webhook_delivery;`));

// ═══════════════════════════════════════════════════════════════════════════
section('Q', 'Queue (S2, S3, S5, S6): claims, leases, retries, CONFIG_BLOCKED');

const cols = owner(`SELECT string_agg(a.attname || ':' || format_type(a.atttypid, NULL), ',' ORDER BY a.ordinality)
  FROM pg_proc p, unnest(p.proallargtypes, p.proargnames, p.proargmodes) WITH ORDINALITY a(atttypid, attname, mode, ordinality)
 WHERE p.proname = 'mp_claim_deliveries' AND a.mode = 't';`).replace(/:[^,]+/g, '');
check('Q1 mp_claim_deliveries returns exactly (delivery_id, claim_token, origin, topic_class, topic, resource_id, attempts) in that order',
  cols === 'delivery_id,claim_token,origin,topic_class,topic,resource_id,attempts', cols);
const qIds = [];
for (let i = 0; i < 10; i += 1) qIds.push(register({ rid: `9100${i}`, action: 'payment.created', payload: { data_id: `9100${i}` } }).delivery_id);
const pA = session(ROLE_SQL.svc(`SELECT string_agg(delivery_id::TEXT, ',') FROM mp_claim_deliveries(5, 120);\nSELECT pg_sleep(2);`), 'rt6-claim-A');
const aIn = await waitFor(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = 'rt6-claim-A' AND query LIKE '%pg_sleep%');`);
const pB = session(ROLE_SQL.svc(`SELECT string_agg(delivery_id::TEXT, ',') FROM mp_claim_deliveries(50, 120);`), 'rt6-claim-B');
const [ra, rb] = await Promise.all([pA, pB]);
const setA = (ra.out.split('\n')[0] || '').split(',').filter(Boolean);
const setB = (rb.out.split('\n')[0] || '').split(',').filter(Boolean);
const claimedAll = [...setA, ...setB];
check('Q2 concurrent claims (FOR UPDATE SKIP LOCKED): disjoint sets, B did not wait for A, union covers every due delivery',
  aIn && ra.ok && rb.ok && setA.length === 5 && setA.every((id) => !setB.includes(id)) && qIds.every((id) => claimedAll.includes(id)),
  `${setA.length}/${setB.length} ${firstErr(rb)}`);
const due = owner(`SELECT count(*) FROM mp_webhook_delivery WHERE status IN ('RECEIVED','FAILED_RETRYABLE');`);
check('Q3 every claimed row is PROCESSING with a token and lease; attempts = 1', due === '0'
  && owner(`SELECT count(*) FROM mp_webhook_delivery WHERE status = 'PROCESSING' AND (claim_token IS NULL OR lease_expires_at IS NULL OR attempts <> 1);`) === '0');
// lease recovery
const lid = qIds[0];
const oldTok = owner(`SELECT claim_token FROM mp_webhook_delivery WHERE id = '${lid}';`);
owner(`UPDATE mp_webhook_delivery SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = '${lid}';`);
const re = claim();
check('Q4 an expired lease is re-claimable: same row, new token, attempts 2', re.length === 1 && re[0].id === lid && re[0].token !== oldTok && re[0].attempts === 2);
r = transition(SVC, lid, oldTok, 'PERMANENT', null, 'MP_BAD_REQUEST');
check('Q5 the stale worker (old token) → CLAIM_LOST; the row is unchanged', raised(r, 'CLAIM_LOST')
  && owner(`SELECT status FROM mp_webhook_delivery WHERE id = '${lid}';`) === 'PROCESSING', firstErr(r));
// RETRY schedule
const t1 = owner(`SELECT claim_token FROM mp_webhook_delivery WHERE id = '${qIds[1]}';`);
okAs(SVC, `SELECT mp_delivery_transition('${qIds[1]}', '${t1}', 'RETRY', NULL, 'MP_UNAVAILABLE', 'timeout');`);
check('Q6 RETRY (transient) → FAILED_RETRYABLE, first_failed_at set, next attempt ≈ +60 s (attempt 1)',
  owner(`SELECT status || '|' || (first_failed_at IS NOT NULL) || '|' || (next_attempt_at BETWEEN NOW() + INTERVAL '50 seconds' AND NOW() + INTERVAL '70 seconds')
          FROM mp_webhook_delivery WHERE id = '${qIds[1]}';`) === 'FAILED_RETRYABLE|true|true');
const t2 = owner(`SELECT claim_token FROM mp_webhook_delivery WHERE id = '${qIds[2]}';`);
r = transition(SVC, qIds[2], t2, 'RETRY', null, 'MP_AUTH');
const r2 = transition(SVC, qIds[2], t2, 'RETRY', null, 'MP_RATE_LIMIT', null, 5000);
check('Q7 RETRY with a non-transient code → INVALID_OUTCOME; Retry-After is clamped to ≤ 3600 s',
  raised(r, 'INVALID_OUTCOME') && r2.ok
  && owner(`SELECT next_attempt_at <= NOW() + INTERVAL '3601 seconds' AND next_attempt_at >= NOW() + INTERVAL '3500 seconds' FROM mp_webhook_delivery WHERE id = '${qIds[2]}';`) === 't', firstErr(r));
owner(`UPDATE mp_webhook_delivery SET first_failed_at = NOW() - INTERVAL '49 hours' WHERE id = '${qIds[1]}';`);
owner(`UPDATE mp_webhook_delivery SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE id = '${qIds[1]}';`);
const rq = claim().find((c) => c.id === qIds[1]);
okAs(SVC, `SELECT mp_delivery_transition('${qIds[1]}', '${rq.token}', 'RETRY', NULL, 'MP_UNAVAILABLE', '5xx');`);
check('Q8 past the 48 h internal horizon a transient RETRY becomes FAILED_PERMANENT (dead letter)',
  owner(`SELECT status FROM mp_webhook_delivery WHERE id = '${qIds[1]}';`) === 'FAILED_PERMANENT');
// CONFIG_BLOCKED
const t3 = owner(`SELECT claim_token FROM mp_webhook_delivery WHERE id = '${qIds[3]}';`);
r = transition(SVC, qIds[3], t3, 'CONFIG_BLOCKED', null, 'MP_AUTH');
okAs(SVC, `SELECT mp_delivery_transition('${qIds[3]}', '${t3}', 'CONFIG_BLOCKED', NULL, 'AUTH_CONFIGURATION_ERROR', 'http 401');`);
check('Q9 CONFIG_BLOCKED requires AUTH_CONFIGURATION_ERROR; the row holds, lease cleared',
  raised(r, 'INVALID_OUTCOME') && owner(`SELECT status || '|' || last_error_code || '|' || (claim_token IS NULL) FROM mp_webhook_delivery WHERE id = '${qIds[3]}';`)
  === 'CONFIG_BLOCKED|AUTH_CONFIGURATION_ERROR|true', firstErr(r));
owner(`UPDATE mp_webhook_delivery SET next_attempt_at = NOW() - INTERVAL '1 hour' WHERE id = '${qIds[3]}';`);
check('Q10 CONFIG_BLOCKED is never returned by the normal claim (no hot retry)', !claim().some((c) => c.id === qIds[3]));
const aud0 = owner(`SELECT count(*) FROM audit_events WHERE action = 'MP_DELIVERY_REQUEUE';`);
r = OPER(`SELECT mp_requeue_config_blocked('try');`);
const rqA = rpcAs(ADMIN, `mp_requeue_config_blocked('token rotated')`);
check('Q11 ADMIN requeue → RECEIVED (last error kept), audited once; OPERATOR refused',
  rqA.requeued === 1 && raised(r, 'FORBIDDEN')
  && owner(`SELECT status || '|' || last_error_code FROM mp_webhook_delivery WHERE id = '${qIds[3]}';`) === 'RECEIVED|AUTH_CONFIGURATION_ERROR'
  && Number(owner(`SELECT count(*) FROM audit_events WHERE action = 'MP_DELIVERY_REQUEUE';`)) === Number(aud0) + 1, firstErr(r));
const rqB = rpcAs(SVC, `mp_requeue_config_blocked('probe')`);
check('Q12 repeated requeue with nothing blocked → {requeued: 0}, no audit (service role path)',
  rqB.requeued === 0 && Number(owner(`SELECT count(*) FROM audit_events WHERE action = 'MP_DELIVERY_REQUEUE';`)) === Number(aud0) + 1);
// RELEASE
const rel = claim().find((c) => c.id === qIds[3]);
okAs(SVC, `SELECT mp_delivery_transition('${qIds[3]}', '${rel.token}', 'RELEASE');`);
check('Q13 RELEASE → back to RECEIVED (never failed), the unused attempt is not counted, lease cleared',
  owner(`SELECT status || '|' || attempts || '|' || (claim_token IS NULL) FROM mp_webhook_delivery WHERE id = '${qIds[3]}';`) === `RECEIVED|${rel.attempts - 1}|true`);
// FETCHED contract
const fx = claim().find((c) => c.id === qIds[3]);
r = transition(SVC, qIds[3], fx.token, 'FETCHED');
const srcAny = owner(`INSERT INTO mp_source_record (source_type, external_id, event_data, occurred_at, occurred_date)
  VALUES ('csv_import', '${TAG}-fetch-src', '{}'::jsonb, NOW(), CURRENT_DATE) RETURNING id;`);
okAs(SVC, `SELECT mp_delivery_transition('${qIds[3]}', '${fx.token}', 'FETCHED', '${srcAny}');`);
check('Q14 FETCHED requires a source record; then FETCHED with the link, lease cleared',
  raised(r, 'INVALID_OUTCOME') && owner(`SELECT status || '|' || source_record_id FROM mp_webhook_delivery WHERE id = '${qIds[3]}';`) === `FETCHED|${srcAny}`, firstErr(r));
// S6 re-fetch
r = OPER(`SELECT mp_request_refetch('910003', 'x');`);
const rf = rpcAs(ADMIN, `mp_request_refetch('910003', 'failed permanently, retry after fix')`);
check('Q15 ADMIN re-fetch creates one manual_refetch payment delivery (RECEIVED), audited; OPERATOR refused; invalid id refused',
  raised(r, 'FORBIDDEN') && raised(ADMIN(`SELECT mp_request_refetch('abc', 'x');`), 'INVALID_PAYMENT_ID')
  && owner(`SELECT origin || '|' || topic_class || '|' || status || '|' || (delivery_key LIKE 'refetch:910003:%') FROM mp_webhook_delivery WHERE id = '${rf.delivery_id}';`)
     === 'manual_refetch|payment|RECEIVED|true'
  && owner(`SELECT count(*) FROM audit_events WHERE action = 'MP_REFETCH_REQUEST' AND entity_id = '${rf.delivery_id}';`) === '1', firstErr(r));
// drain everything left so later sections start clean
for (const c of claim()) okAs(SVC, `SELECT mp_delivery_transition('${c.id}', '${c.token}', 'PERMANENT', NULL, 'TEST_DRAIN');`);

// ═══════════════════════════════════════════════════════════════════════════
section('C', 'Chargeback SIGNALS (S3 SIGNAL_RECORDED, S7): no financial effect');

const moneyBefore = money();
const cb1 = register({ topic: 'chargebacks', cls: 'chargeback', rid: 'rt6-cb-1', action: 'created', payload: { type: 'chargebacks' } });
check('C1 a verified chargeback notification is stored as a chargeback delivery (RECEIVED), never UNSUPPORTED',
  owner(`SELECT topic_class || '|' || status FROM mp_webhook_delivery WHERE id = '${cb1.delivery_id}';`) === 'chargeback|RECEIVED');
const cbc = claim().find((c) => c.id === cb1.delivery_id);
check('C2 the claim returns topic_class chargeback (the worker branches without another lookup)', cbc && cbc.cls === 'chargeback');
r = transition(SVC, cb1.delivery_id, cbc.token, 'SIGNAL_RECORDED', null, null, null, null, 'abc');
check('C3 invalid p_link_payment_id → INVALID_PAYMENT_ID; the whole transition rolls back (still PROCESSING, same token, no refresh row)',
  raised(r, 'INVALID_PAYMENT_ID') && owner(`SELECT status || '|' || claim_token || '|' || coalesce(signal_resolution, '-') FROM mp_webhook_delivery WHERE id = '${cb1.delivery_id}';`)
    === `PROCESSING|${cbc.token}|-`
  && owner(`SELECT count(*) FROM mp_webhook_delivery WHERE triggered_by_delivery_id = '${cb1.delivery_id}';`) === '0', firstErr(r));
r = transition(SVC, cb1.delivery_id, cbc.token, 'FETCHED', srcAny, null, null, null, '123');
check('C4 p_link_payment_id on an unrelated outcome → INVALID_ARGUMENT; no state change', raised(r, 'INVALID_ARGUMENT')
  && owner(`SELECT status FROM mp_webhook_delivery WHERE id = '${cb1.delivery_id}';`) === 'PROCESSING', firstErr(r));
okAs(SVC, `SELECT mp_delivery_transition('${cb1.delivery_id}', '${cbc.token}', 'SIGNAL_RECORDED', NULL, NULL, NULL, NULL, '920001');`);
check('C5 SIGNAL_RECORDED with a documented payment id → LINKED automatically (actor NULL) + one chargeback_refresh payment delivery',
  owner(`SELECT status || '|' || signal_resolution || '|' || coalesce(signal_resolved_by::TEXT, 'NULL') FROM mp_webhook_delivery WHERE id = '${cb1.delivery_id}';`)
    === 'SIGNAL_RECORDED|LINKED|NULL'
  && owner(`SELECT origin || '|' || topic_class || '|' || resource_id || '|' || delivery_key FROM mp_webhook_delivery WHERE triggered_by_delivery_id = '${cb1.delivery_id}';`)
    === `chargeback_refresh|payment|920001|cbrefresh:${cb1.delivery_id}:920001`);
const cb2 = register({ topic: 'chargebacks', cls: 'chargeback', rid: 'rt6-cb-2', action: 'created', payload: { type: 'chargebacks', data_id: 'rt6-cb-2' } });
const cbc2 = claim().find((c) => c.id === cb2.delivery_id);
okAs(SVC, `SELECT mp_delivery_transition('${cb2.delivery_id}', '${cbc2.token}', 'SIGNAL_RECORDED');`);
check('C6 SIGNAL_RECORDED without a payment reference → unresolved signal (REVIEW_REQUIRED until ADMIN link / dismiss)',
  owner(`SELECT status || '|' || coalesce(signal_resolution, 'NULL') FROM mp_webhook_delivery WHERE id = '${cb2.delivery_id}';`) === 'SIGNAL_RECORDED|NULL');
r = OPER(`SELECT mp_resolve_chargeback_signal('${cb2.delivery_id}', 'LINKED', '920002', 'x');`);
rpcAs(ADMIN, `mp_resolve_chargeback_signal('${cb2.delivery_id}', 'LINKED', '920002', 'identified the disputed payment')`);
const again = ADMIN(`SELECT mp_resolve_chargeback_signal('${cb2.delivery_id}', 'DISMISSED', NULL, 'twice');`);
check('C7 ADMIN link → LINKED by the ADMIN + refresh delivery; a second resolve → ALREADY_RESOLVED; OPERATOR refused',
  raised(r, 'FORBIDDEN') && raised(again, 'ALREADY_RESOLVED')
  && owner(`SELECT signal_resolution || '|' || signal_resolved_by FROM mp_webhook_delivery WHERE id = '${cb2.delivery_id}';`) === `LINKED|${ADMIN_UID}`
  && owner(`SELECT count(*) FROM mp_webhook_delivery WHERE triggered_by_delivery_id = '${cb2.delivery_id}' AND resource_id = '920002';`) === '1', firstErr(again));
const cb3 = register({ topic: 'chargebacks', cls: 'chargeback', rid: 'rt6-cb-3', payload: { type: 'chargebacks', data_id: 'rt6-cb-3' } });
const cbc3 = claim().find((c) => c.id === cb3.delivery_id);
okAs(SVC, `SELECT mp_delivery_transition('${cb3.delivery_id}', '${cbc3.token}', 'SIGNAL_RECORDED');`);
rpcAs(ADMIN, `mp_resolve_chargeback_signal('${cb3.delivery_id}', 'DISMISSED', NULL, 'dispute won before any debit')`);
check('C8 ADMIN dismiss → DISMISSED, no refresh delivery; audit MP_CHARGEBACK_SIGNAL_RESOLVE × 2 (link + dismiss)',
  owner(`SELECT signal_resolution FROM mp_webhook_delivery WHERE id = '${cb3.delivery_id}';`) === 'DISMISSED'
  && owner(`SELECT count(*) FROM mp_webhook_delivery WHERE triggered_by_delivery_id = '${cb3.delivery_id}';`) === '0'
  && owner(`SELECT count(*) FROM audit_events WHERE action = 'MP_CHARGEBACK_SIGNAL_RESOLVE';`) === '2');
const pw = register({ rid: '920009', action: 'payment.created', payload: { data_id: '920009' } });
const pay = claim().find((c) => c.id === pw.delivery_id);
r = pay ? transition(SVC, pay.id, pay.token, 'SIGNAL_RECORDED') : { ok: true, err: '' };
check('C9 SIGNAL_RECORDED on a payment delivery → INVALID_OUTCOME', raised(r, 'INVALID_OUTCOME'), firstErr(r));
if (pay) okAs(SVC, `SELECT mp_delivery_transition('${pay.id}', '${pay.token}', 'PERMANENT', NULL, 'TEST_DRAIN');`);
for (const c of claim()) okAs(SVC, `SELECT mp_delivery_transition('${c.id}', '${c.token}', 'PERMANENT', NULL, 'TEST_DRAIN');`);
check('C10 no financial effect from any chargeback signal: operations, postings, reconciliations, movements, collections, client ledger, allocations unchanged',
  money() === moneyBefore, `${moneyBefore} → ${money()}`);

// ═══════════════════════════════════════════════════════════════════════════
section('A', 'Optional client attribution (C1–C7): client_ledger only, never money');

const R1 = receipt();
check('A1 CLIENT_UNASSIGNED is a valid state: a posted receipt with no allocation needs nothing (no flag, no allocation, no work item)',
  owner(`SELECT (SELECT count(*) FROM mp_client_allocation WHERE mp_financial_movement_id = ${R1.mv}) || '|' || (SELECT count(*) FROM mp_attribution_flag WHERE mp_financial_movement_id = ${R1.mv})`) === '0|0');
const flag = rpcAs(ADMIN, `mp_flag_for_attribution(${R1.mv}, 'settles a CC; identify the client')`);
r = ADMIN(`SELECT mp_flag_for_attribution(${R1.mv}, 'again');`);
check('A2 explicit flag (CLIENT_RESOLUTION_REQUESTED) only on ADMIN request; a second open flag → FLAG_ALREADY_OPEN', !!flag.flag_id && raised(r, 'FLAG_ALREADY_OPEN'), firstErr(r));
const m0 = owner(`SELECT concat_ws('|', (SELECT count(*) FROM financial_operation), (SELECT count(*) FROM financial_posting), (SELECT count(*) FROM collections), (SELECT count(*) FROM mp_reconciliation));`);
const a1 = rpcAs(ADMIN, `mp_allocate_to_client(${R1.mv}, '${CX}', 40, '2026-10-05', '${newKey()}', 'partial CC settlement')`);
check('A3 manual partial allocation 40 → client_ledger COLLECTION −40 with provenance mp_client_allocation / allocation id; active 40',
  a1.active_attributed === 40 && Number(a1.effective_receipt) === 100
  && owner(`SELECT movement_type || '|' || signed_amount || '|' || source_entity_type || '|' || source_entity_id FROM client_ledger WHERE id = ${a1.client_ledger_id};`)
     === `COLLECTION|-40.00|mp_client_allocation|${a1.allocation_id}`);
const a2 = rpcAs(ADMIN, `mp_allocate_to_client(${R1.mv}, '${CY}', 60, '2026-10-06', '${newKey()}', 'split: the rest to another CC')`);
check('A4 split allocation 60 to another client → active 100 = effective receipt; the open flag is auto-cleared FULLY_ASSIGNED',
  a2.active_attributed === 100 && owner(`SELECT clear_reason FROM mp_attribution_flag WHERE id = '${flag.flag_id}';`) === 'FULLY_ASSIGNED');
check('A5 attribution creates NO collections row, NO financial_operation, NO financial_posting, NO reconciliation',
  owner(`SELECT concat_ws('|', (SELECT count(*) FROM financial_operation), (SELECT count(*) FROM financial_posting), (SELECT count(*) FROM collections), (SELECT count(*) FROM mp_reconciliation));`) === m0);
r = ADMIN(`SELECT mp_allocate_to_client(${R1.mv}, '${CX}', 0.01, '2026-10-06', '${newKey()}', 'over');`);
check('A6 over-allocation beyond the effective receipt → ALLOCATION_EXCEEDS_RECEIPT; nothing written', raised(r, 'ALLOCATION_EXCEEDS_RECEIPT'), firstErr(r));
const dupKey = newKey();
const R2 = receipt({ gross: 50, fee: -1, tax: 0 });
rpcAs(ADMIN, `mp_allocate_to_client(${R2.mv}, '${CX}', 10, '2026-10-05', '${dupKey}', 'first')`);
r = ADMIN(`SELECT mp_allocate_to_client(${R2.mv}, '${CX}', 10, '2026-10-05', '${dupKey}', 'retry');`);
const rPrefix = ADMIN(`SELECT mp_allocate_to_client(${R2.mv}, '${CX}', 1, '2026-10-05', 'MPAUTO:1', 'x');`);
check('A7 duplicate MANUAL key → DUPLICATE_ALLOCATION; a reserved key prefix → INVALID_IDEMPOTENCY_KEY',
  raised(r, 'DUPLICATE_ALLOCATION') && raised(rPrefix, 'INVALID_IDEMPOTENCY_KEY'), `${firstErr(r)} | ${firstErr(rPrefix)}`);
check('A8 inactive client / date before the receipt / reason missing are refused',
  raised(ADMIN(`SELECT mp_allocate_to_client(${R2.mv}, '${CZ}', 1, '2026-10-05', '${newKey()}', 'x');`), 'CLIENT_NOT_FOUND_OR_INACTIVE')
  && raised(ADMIN(`SELECT mp_allocate_to_client(${R2.mv}, '${CX}', 1, '2026-10-04', '${newKey()}', 'x');`), 'EFFECTIVE_DATE_BEFORE_RECEIPT')
  && raised(ADMIN(`SELECT mp_allocate_to_client(${R2.mv}, '${CX}', 1, '2026-10-05', '${newKey()}', ' ');`), 'REASON_REQUIRED'));
const RN = receipt({ applied: false });
check('A9 a receipt whose treasury effect is not applied → RECEIPT_NOT_POSTED (money must exist before attribution)',
  raised(ADMIN(`SELECT mp_allocate_to_client(${RN.mv}, '${CX}', 1, '2026-10-05', '${newKey()}', 'x');`), 'RECEIPT_NOT_POSTED'));
check('A10 the service role cannot choose a client (no EXECUTE on the MANUAL path); OPERATOR is refused',
  denied(SVC(`SELECT mp_allocate_to_client(${R2.mv}, '${CX}', 1, '2026-10-05', '${newKey()}', 'x');`))
  && raised(OPER(`SELECT mp_allocate_to_client(${R2.mv}, '${CX}', 1, '2026-10-05', '${newKey()}', 'x');`), 'FORBIDDEN'));
// concurrency on the cap
const R3 = receipt();
const k1 = newKey();
const k2 = newKey();
const cA = session(ROLE_SQL.admin(`SELECT mp_allocate_to_client(${R3.mv}, '${CX}', 60, '2026-10-05', '${k1}', 'race A');\nSELECT pg_sleep(2);`), 'rt6-cap-A');
const capIn = await waitFor(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = 'rt6-cap-A' AND query LIKE '%pg_sleep%');`);
const cB = session(ROLE_SQL.admin(`SELECT mp_allocate_to_client(${R3.mv}, '${CY}', 60, '2026-10-05', '${k2}', 'race B');`), 'rt6-cap-B');
const capWait = await waitFor(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = 'rt6-cap-B' AND wait_event_type = 'Lock');`);
const [rcA, rcB] = await Promise.all([cA, cB]);
check('A11 two concurrent allocations of 60 on a 100 receipt: B waited on the movement lock, then ALLOCATION_EXCEEDS_RECEIPT; active 60',
  capIn && capWait && rcA.ok && raised(rcB, 'ALLOCATION_EXCEEDS_RECEIPT')
  && owner(`SELECT sum(amount) FROM mp_client_allocation WHERE mp_financial_movement_id = ${R3.mv};`) === '60.00', firstErr(rcB));
// manual reversal (wrong attribution)
const rv = rpcAs(ADMIN, `mp_reverse_client_allocation('${a1.allocation_id}', 40, '${newKey()}', 'attributed to the wrong client')`);
check('A12 manual reversal of the whole 40 → client_ledger REVERSAL +40 linked to the original ledger row; a −40 MANUAL_REVERSAL row; nothing updated',
  rv.remaining === 0
  && owner(`SELECT movement_type || '|' || signed_amount || '|' || reversal_of_id || '|' || source_entity_type FROM client_ledger WHERE id = ${rv.client_ledger_id};`)
     === `REVERSAL|40.00|${a1.client_ledger_id}|mp_client_allocation`
  && owner(`SELECT origin || '|' || amount || '|' || reversal_of_id FROM mp_client_allocation WHERE id = '${rv.reversal_id}';`) === `MANUAL_REVERSAL|-40.00|${a1.allocation_id}`
  && owner(`SELECT signed_amount FROM client_ledger WHERE id = ${a1.client_ledger_id};`) === '-40.00');
check('A13 reversing more than remains → REVERSAL_EXCEEDS_ALLOCATION; X can be re-attributed afterwards (active 60 + 40 = 100)',
  raised(ADMIN(`SELECT mp_reverse_client_allocation('${a1.allocation_id}', 0.01, '${newKey()}', 'x');`), 'REVERSAL_EXCEEDS_ALLOCATION')
  && rpcAs(ADMIN, `mp_allocate_to_client(${R1.mv}, '${CY}', 40, '2026-10-06', '${newKey()}', 'correct client')`).active_attributed === 100);
check('A14 attribution audit: one MP_CLIENT_ALLOCATION per allocation, one MP_CLIENT_ALLOCATION_REVERSAL per reversal',
  owner(`SELECT count(*) FROM audit_events WHERE action = 'MP_CLIENT_ALLOCATION';`) === owner(`SELECT count(*) FROM mp_client_allocation WHERE origin = 'ALLOCATION';`)
  && owner(`SELECT count(*) FROM audit_events WHERE action = 'MP_CLIENT_ALLOCATION_REVERSAL';`) === owner(`SELECT count(*) FROM mp_client_allocation WHERE origin <> 'ALLOCATION';`));
// AUTO pre-V-2 and payer map
const auto = rpcAs(SVC, `mp_auto_allocate(${R2.mv})`);
check('A15 mp_auto_allocate before V-2 reads no MP field → {allocated: false, NO_EVIDENCE}; no write; ADMIN has no EXECUTE',
  auto.allocated === false && auto.reason === 'NO_EVIDENCE' && denied(ADMIN(`SELECT mp_auto_allocate(${R2.mv});`)));
const mapA = rpcAs(ADMIN, `mp_map_payer_to_client('777001', '${CX}', 'known payer')`);
r = ADMIN(`SELECT mp_map_payer_to_client('777001', '${CY}', 'dup');`);
rpcAs(ADMIN, `mp_unmap_payer('${mapA.mapping_id}', 'wrong mapping')`);
const mapB = rpcAs(ADMIN, `mp_map_payer_to_client('777001', '${CY}', 'corrected')`);
check('A16 payer map: one active mapping per payer (PAYER_ALREADY_MAPPED), unmap deactivates (history kept), then remap',
  raised(r, 'PAYER_ALREADY_MAPPED') && !!mapB.mapping_id
  && owner(`SELECT string_agg(activo::TEXT, ',' ORDER BY created_at) FROM mp_payer_client_map WHERE mp_payer_id = '777001';`) === 'false,true', firstErr(r));
const clr = rpcAs(ADMIN, `mp_flag_for_attribution(${R2.mv}, 'check')`);
rpcAs(ADMIN, `mp_clear_attribution_flag('${clr.flag_id}', 'not needed')`);
check('A17 flag clear by ADMIN; clearing again → FLAG_NOT_OPEN',
  raised(ADMIN(`SELECT mp_clear_attribution_flag('${clr.flag_id}', 'again');`), 'FLAG_NOT_OPEN'));

// ═══════════════════════════════════════════════════════════════════════════
section('N', 'RPC 40 csv_import (Step 2): DEFERRED_V4, report-only identity');

const HEADER = ['DATE', 'SOURCE_ID', 'DESCRIPTION', 'NET_CREDIT_AMOUNT', 'NET_DEBIT_AMOUNT', 'GROSS_AMOUNT', 'MP_FEE_AMOUNT', 'TAXES_AMOUNT',
  'PAYMENT_METHOD', 'TRANSACTION_APPROVAL_DATE', 'BUSINESS_UNIT', 'SUB_UNIT', 'BALANCE_AMOUNT', 'PAYMENT_METHOD_TYPE', 'PURCHASE_ID'];
const lib = (date, sid, desc, cr, db, gross, fee, tax, bal = '0.00') =>
  Object.fromEntries(HEADER.map((h, i) => [h, [date, sid, desc, cr, db, gross, fee, tax, 'available_money', date, '', '', bal, '', TAG][i]]));
const ingestLib = (row) => {
  const net = Number(row.NET_CREDIT_AMOUNT) - Number(row.NET_DEBIT_AMOUNT);
  return okAs(SVC, `INSERT INTO mp_source_record (source_type, external_id, event_data, occurred_at, occurred_date)
    VALUES ('csv_import', '${row.SOURCE_ID}:${row.DESCRIPTION}:${net > 0 ? 'C' : 'D'}', ${q(JSON.stringify(row))}::jsonb, '${row.DATE}',
            (TIMESTAMPTZ '${row.DATE}' AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE) RETURNING id;`);
};
const wide = () => owner(`SELECT concat_ws('|', (SELECT count(*) FROM mp_financial_movement), (SELECT count(*) FROM mp_transition_identity),
  (SELECT count(*) FROM mp_report_match), (SELECT count(*) FROM financial_operation), (SELECT count(*) FROM financial_posting),
  (SELECT count(*) FROM mp_reconciliation), (SELECT count(*) FROM mp_client_allocation), (SELECT count(*) FROM client_ledger));`);
const w0 = wide();
const payRow = lib('2026-10-07T10:00:00.000-03:00', `${TAG}-930001`, 'payment', '980.00', '0.00', '1000.00', '-12.00', '-8.00');
const nPay = ingestLib(payRow);
const n1 = rpcAs(SVC, `mp_normalize_source('${nPay}')`);
check('N1 Liberaciones payment row → validated, then PENDING DEFERRED_V4; no movement / identity / match / operation / posting / reconciliation / allocation / ledger',
  n1.processing_status === 'PENDING' && n1.movements_created === 0 && wide() === w0
  && owner(`SELECT processing_status || '|' || (processed_at IS NULL) || '|' || processing_note FROM mp_source_record WHERE id = '${nPay}';`)
     === 'PENDING|true|DEFERRED_V4: payment/API equivalence unverified');
const aud1 = owner(`SELECT count(*) FROM audit_events WHERE entity_type = 'mp_source_record' AND entity_id = '${nPay}';`);
const n2 = rpcAs(SVC, `mp_normalize_source('${nPay}')`);
check('N2 DEFERRED_V4 replay: still PENDING, zero economic effect, no second audit',
  n2.processing_status === 'PENDING' && wide() === w0 && aud1 === '1'
  && owner(`SELECT count(*) FROM audit_events WHERE entity_type = 'mp_source_record' AND entity_id = '${nPay}';`) === '1');
const badPay = lib('2026-10-07T10:00:00.000-03:00', `${TAG}-930002`, 'payment', '980.00', '0.00', '1000.01', '-12.00', '-8.00');
const nBad = ingestLib(badPay);
check('N3 an invalid payment row is still ERROR (validation precedes the deferral)',
  rpcAs(SVC, `mp_normalize_source('${nBad}')`).processing_status === 'ERROR');
const yRow = lib('2026-10-08T04:00:00.000-03:00', `${TAG}-930003`, 'asset_management', '45.50', '0.00', '45.50', '0.00', '0.00');
const nY = ingestLib(yRow);
const ny = rpcAs(SVC, `mp_normalize_source('${nY}')`);
check('N4 Liberaciones yield → NORMALIZED, 1 movement, identity (report, external_id, YIELD, \'\'), REPORT_ONLY match (not an exception)',
  ny.processing_status === 'NORMALIZED' && ny.movements_created === 1
  && owner(`SELECT t.resource_type || '|' || t.resource_id || '|' || t.transition || '|' || t.transition_ref || '|' || m.outcome || '|' || m.is_exception
     FROM mp_transition_identity t JOIN mp_report_match m ON m.transition_id = t.id WHERE t.claimed_by_source_id = '${nY}';`)
     === `report|${TAG}-930003:asset_management:C|YIELD||REPORT_ONLY|false`);
const oRow = lib('2026-10-08T12:00:00.000-03:00', `${TAG}-930004`, 'payout', '0.00', '5000.00', '-4970.00', '0.00', '-30.00');
const nO = ingestLib(oRow);
rpcAs(SVC, `mp_normalize_source('${nO}')`);
check('N5 Liberaciones payout → transfer movement + PAYOUT identity; the helper says payout is NOT auto-applicable, yield is',
  owner(`SELECT transition FROM mp_transition_identity WHERE claimed_by_source_id = '${nO}';`) === 'PAYOUT'
  && owner(`SELECT mp_is_auto_applicable((SELECT id FROM mp_financial_movement WHERE mp_source_record_id = '${nO}'))
            || '|' || mp_is_auto_applicable((SELECT id FROM mp_financial_movement WHERE mp_source_record_id = '${nY}'));`) === 'false|true');
const apiSrc = owner(`INSERT INTO mp_source_record (source_type, external_id, event_data, occurred_at, occurred_date)
  VALUES ('api_payment', '${TAG}-MPPAY:1', '{}'::jsonb, NOW(), CURRENT_DATE) RETURNING id;`);
const refSrc = owner(`INSERT INTO mp_source_record (source_type, external_id, event_data, occurred_at, occurred_date)
  VALUES ('api_refund', '${TAG}-MPREF:1', '{}'::jsonb, NOW(), CURRENT_DATE) RETURNING id;`);
// Step 6 (0050): the api_payment parser now exists; a malformed owner fixture fails closed on identity.
// api_refund stays UNSUPPORTED_SOURCE_TYPE (refunds fail closed, V-2 §15.1).
const n6api = rpcAs(SVC, `mp_normalize_source('${apiSrc}')`).processing_status;
const n6ref = rpcAs(SVC, `mp_normalize_source('${refSrc}')`).processing_status;
check('N6 api_payment \'{}\' fixture → ERROR IDENTITY_MISMATCH (Step-6 parser, fail-closed); api_refund stays ERROR UNSUPPORTED_SOURCE_TYPE',
  n6api === 'ERROR' && n6ref === 'ERROR'
  && owner(`SELECT string_agg(split_part(processing_note, ':', 1), ',' ORDER BY source_type) FROM mp_source_record WHERE id IN ('${apiSrc}', '${refSrc}');`)
    === 'IDENTITY_MISMATCH,UNSUPPORTED_SOURCE_TYPE');
check('N7 mp_v4_verified() is false', owner(`SELECT mp_v4_verified();`) === 'f');

// ═══════════════════════════════════════════════════════════════════════════
section('R', 'Report evidence (R1, R3, R4): no financial write');

const m1 = money();
const balRow = lib('2026-10-09T23:00:00.000-03:00', `${TAG}-930005`, 'asset_management', '1.00', '0.00', '1.00', '0.00', '0.00', '999999.00');
const nB = ingestLib(balRow);
const earlier = ingestLib(lib('2026-10-09T08:00:00.000-03:00', `${TAG}-930006`, 'asset_management', '1.00', '0.00', '1.00', '0.00', '0.00', '5.00'));
r = SVC(`SELECT mp_record_balance_check('${earlier}');`);
const bc = rpcAs(SVC, `mp_record_balance_check('${nB}')`);
const bc2 = rpcAs(SVC, `mp_record_balance_check('${nB}')`);
check('R1 balance check on the day-closing row only (NOT_DAY_CLOSING_ROW otherwise); a difference ≠ 0 is an exception; rerun creates nothing',
  raised(r, 'NOT_DAY_CLOSING_ROW') && bc.created === true && bc2.created === false
  && owner(`SELECT outcome || '|' || is_exception || '|' || (detail->>'reported') FROM mp_report_match WHERE id = '${bc.match_id}';`) === 'BALANCE_CHECK|true|999999.00', firstErr(r));
const cov = rpcAs(SVC, `mp_check_report_coverage('csv_import', '2026-10-01', '2026-10-31')`);
check('R2 coverage while V-4 is open: no payment transition can be reported missing; nothing inserted, no audit; Account Money → REPORT_TYPE_NOT_SUPPORTED',
  cov.missing_inserted === 0 && cov.v4_verified === false
  && owner(`SELECT count(*) FROM audit_events WHERE action = 'MP_COVERAGE_CHECK';`) === '0'
  && raised(SVC(`SELECT mp_check_report_coverage('account_money_csv', '2026-10-01', '2026-10-31');`), 'REPORT_TYPE_NOT_SUPPORTED'));
const onlyMatch = owner(`SELECT m.id FROM mp_report_match m JOIN mp_transition_identity t ON t.id = m.transition_id WHERE t.claimed_by_source_id = '${nY}';`);
check('R3 resolve: a non-exception → NOT_AN_EXCEPTION; CORRECTED without a later correction → NO_CORRECTION_FOUND',
  raised(ADMIN(`SELECT mp_resolve_match('${onlyMatch}', 'EXPLAINED', 'x');`), 'NOT_AN_EXCEPTION')
  && raised(ADMIN(`SELECT mp_resolve_match('${bc.match_id}', 'CORRECTED', 'x');`), 'NO_CORRECTION_FOUND'));
rpcAs(ADMIN, `mp_resolve_match('${bc.match_id}', 'EXPLAINED', 'test balance fixture')`);
check('R4 ADMIN resolves EXPLAINED once (audited); a second resolve → ALREADY_RESOLVED; the evidence row is otherwise immutable',
  raised(ADMIN(`SELECT mp_resolve_match('${bc.match_id}', 'SUPERSEDED', 'x');`), 'ALREADY_RESOLVED')
  && owner(`SELECT count(*) FROM audit_events WHERE action = 'MP_MATCH_RESOLVE' AND entity_id = '${bc.match_id}';`) === '1'
  && !raw(`UPDATE mp_report_match SET detail = '{}' WHERE id = '${bc.match_id}';`).ok);
check('R5 report evidence functions wrote no financial row', money() === m1);

// ═══════════════════════════════════════════════════════════════════════════
section('Z', 'Security perimeter at Step 2 (final RLS is 0051)');

const definers = owner(`SELECT string_agg(proname, ',' ORDER BY proname) FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace;`);
// Step 6 (0050) adds exactly one definer, S4 (INV class D, by name)
const STEP6_DEFINERS = ['mp_ingest_api_snapshot'];
const expected = [...BASELINE_DEFINERS, ...Object.keys(STEP2_DEFINERS), ...STEP6_DEFINERS].sort().join(',');
check(`Z1 exact SECURITY DEFINER set = baseline (41) ∪ the ${Object.keys(STEP2_DEFINERS).length} Step-2 definers ∪ the Step-6 definer mp_ingest_api_snapshot, by name`, definers === expected,
  definers.split(',').filter((d) => !expected.split(',').includes(d)).join(',') || 'missing:' + expected.split(',').filter((d) => !definers.split(',').includes(d)).join(','));
const hard = owner(`SELECT string_agg(proname || '=' || prosecdef || ':' || (coalesce(proconfig, '{}') @> ARRAY['search_path=public']) || ':' || pg_get_userbyid(proowner)
  || ':' || has_function_privilege('anon', oid, 'EXECUTE') || ':' || has_function_privilege('authenticated', oid, 'EXECUTE') || ':' || has_function_privilege('service_role', oid, 'EXECUTE'), ',' ORDER BY proname)
  FROM pg_proc WHERE proname IN (${Object.keys(STEP2_DEFINERS).map(q).join(',')});`);
const wantHard = Object.keys(STEP2_DEFINERS).sort().map((n) => {
  const g = STEP2_DEFINERS[n];
  return `${n}=true:true:postgres:false:${g.includes('authenticated')}:${g.includes('service_role')}`;
}).join(',');
check('Z2 every Step-2 definer: SECURITY DEFINER, search_path=public, owner postgres, no anon EXECUTE, exact authenticated / service_role grant',
  hard === wantHard, hard);
check('Z3 no Step-2 definer is executable by PUBLIC',
  owner(`SELECT count(*) FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          WHERE p.proname IN (${Object.keys(STEP2_DEFINERS).map(q).join(',')}) AND a.grantee = 0;`) === '0');
check('Z4 helpers and guards are SECURITY INVOKER and not executable by anon / authenticated / service_role',
  owner(`SELECT string_agg(proname || '=' || prosecdef || ':' || has_function_privilege('anon', oid, 'EXECUTE') || ':' || has_function_privilege('authenticated', oid, 'EXECUTE')
          || ':' || has_function_privilege('service_role', oid, 'EXECUTE'), ',' ORDER BY proname) FROM pg_proc WHERE proname IN (${INVOKER_HELPERS.map(q).join(',')});`)
  === [...INVOKER_HELPERS].sort().map((n) => `${n}=false:false:false:false`).join(','));
check('Z5 no Step-2 function takes an actor parameter',
  owner(`SELECT count(*) FROM pg_proc WHERE proname IN (${Object.keys(STEP2_DEFINERS).map(q).join(',')})
          AND EXISTS (SELECT 1 FROM unnest(proargnames) n WHERE n ~* '(user|actor|role|performed|created_by|uid)');`) === '0');
check('Z6 anon is refused EXECUTE on representative Step-2 RPCs (service, ADMIN and ADMIN-or-service paths)',
  denied(ANON(`SELECT mp_requeue_config_blocked('x');`)) && denied(ANON(`SELECT mp_claim_deliveries(1, 30);`))
  && denied(ANON(`SELECT mp_request_refetch('1', 'x');`)) && denied(ANON(`SELECT mp_resolve_match(NULL, NULL, NULL);`)));
} finally {
  cleanup();
}

section('Z9', 'Cleanup');
check('Z9 fixture rows removed',
  owner(`SELECT (SELECT count(*) FROM mp_source_record WHERE external_id LIKE '${TAG}%') + (SELECT count(*) FROM clients WHERE nombre LIKE '${TAG}%')
         + (SELECT count(*) FROM mp_webhook_delivery);`) === '0');

console.log(`\n  ══ MP REALTIME (PRE-V-2) RESULT: ${pass} passed, ${fail} failed ══`);
if (fail) {
  console.log('\n  Failures:');
  for (const f of failures) console.log(`   - ${f.label}${f.detail !== undefined ? ` :: ${f.detail}` : ''}`);
  process.exit(1);
}
