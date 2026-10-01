#!/usr/bin/env node
/**
 * ADR-006 Step 9 — final privilege perimeter (0054): S-1…S-7, direct-insert and write negatives,
 * exact grant / policy / EXECUTE maps, RLS_IMPLEMENTATION_SPEC_V1 §11 verification queries.
 *
 * Run:  TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *         node scripts/target-db/mp_privileges.test.mjs
 *
 * Authority: ADR006_RLS_AND_SECURITY_V1 §1–§5; ADR006_TEST_MATRIX_V1 S-1…S-7, N-9, B4 / D7 (§P23-T).
 * Fixtures are built through the real service RPCs (S1 register, S2 claim, S4 snapshot, RPC 40, A1, C2)
 * plus owner rows for the ADMIN-only tables. Synthetic ids only: payments 7776…, clients 'S9P …'.
 */

import { spawnSync } from 'node:child_process';
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
const OPA = '22222222-2222-2222-2222-222222222222';
const COLLECTOR = '100000001';
let pass = 0;
let fail = 0;
const failures = [];
const PSQL = ['psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'];
let container;
function raw(sqlText) {
  const r = spawnSync(DOCKER, ['exec', '-i', container, ...PSQL], { encoding: 'utf8', input: sqlText, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
function owner(s) { const r = raw(s); if (!r.ok) throw new Error(`owner SQL failed:\n${s}\n${r.err}`); return r.out; }
const esc = (s) => String(s).replace(/'/g, "''");
const q = (v) => (v === null || v === undefined ? 'NULL' : `'${esc(v)}'`);
const wrap = (role, claims, s, end = 'COMMIT') => `BEGIN;\nSET LOCAL ROLE ${role};\nSET LOCAL "request.jwt.claims" = '${esc(JSON.stringify(claims))}';\n${s}\n${end};`;
const ACT = {
  anon: (s, end) => raw(wrap('anon', { role: 'anon' }, s, end)),
  operator: (s, end) => raw(wrap('authenticated', { sub: OPA, role: 'authenticated' }, s, end)),
  admin: (s, end) => raw(wrap('authenticated', { sub: ADMIN_UID, role: 'authenticated' }, s, end)),
  service: (s, end) => raw(wrap('service_role', { role: 'service_role' }, s, end)),
};
const SVC = ACT.service;
function svcJson(call) {
  const r = SVC(`SELECT (${call})::text;`);
  if (!r.ok) throw new Error(`service RPC failed: ${call}\n${r.err}`);
  return JSON.parse(r.out);
}
const errLine = (r) => (r.err.split('\n').find((l) => /ERROR/.test(l)) || r.err.split('\n')[0] || '').slice(0, 180);
const denied = (r) => !r.ok && /permission denied/i.test(r.err);
const forbidden = (r) => !r.ok && /ERROR:\s+FORBIDDEN/.test(r.err);
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

// ── authority literals ───────────────────────────────────────────────────────
const MP_TABLES = ['mp_attribution_flag', 'mp_client_allocation', 'mp_financial_movement', 'mp_payer_client_map', 'mp_reconciliation',
  'mp_report_match', 'mp_source_record', 'mp_transition_identity', 'mp_webhook_delivery'];
const NEW_TABLES = ['mp_attribution_flag', 'mp_client_allocation', 'mp_payer_client_map', 'mp_report_match', 'mp_transition_identity', 'mp_webhook_delivery'];
// ADR006_RLS_AND_SECURITY_V1 §2 (+ 0041 for the three pre-existing tables): app-role table privileges
const WANT_TABLE_ACL = [
  'mp_attribution_flag:authenticated:SELECT',
  'mp_client_allocation:authenticated:SELECT',
  'mp_financial_movement:authenticated:SELECT', 'mp_financial_movement:service_role:SELECT',
  'mp_payer_client_map:authenticated:SELECT',
  'mp_reconciliation:authenticated:SELECT', 'mp_reconciliation:service_role:SELECT',
  'mp_report_match:authenticated:SELECT', 'mp_report_match:service_role:SELECT',
  'mp_source_record:authenticated:SELECT', 'mp_source_record:service_role:INSERT', 'mp_source_record:service_role:SELECT',
  'mp_transition_identity:authenticated:SELECT', 'mp_transition_identity:service_role:SELECT',
  'mp_webhook_delivery:authenticated:SELECT', 'mp_webhook_delivery:service_role:SELECT',
];
const ADMIN_Q = "(current_app_role() = 'ADMIN'::text)";
const SVC_Q = "(auth.role() = 'service_role'::text)";
const WANT_POLICIES = [
  `mp_attribution_flag|mp_attribution_flag_admin_select|SELECT|${ADMIN_Q}|`,
  `mp_client_allocation|mp_allocation_admin_select|SELECT|${ADMIN_Q}|`,
  `mp_financial_movement|mp_movement_admin_select|SELECT|${ADMIN_Q}|`,
  `mp_financial_movement|mp_movement_service_select|SELECT|${SVC_Q}|`,
  `mp_payer_client_map|mp_payer_map_admin_select|SELECT|${ADMIN_Q}|`,
  `mp_reconciliation|mp_reconciliation_admin_select|SELECT|${ADMIN_Q}|`,
  `mp_reconciliation|mp_reconciliation_service_select|SELECT|${SVC_Q}|`,
  `mp_report_match|mp_match_admin_select|SELECT|${ADMIN_Q}|`,
  `mp_report_match|mp_match_service_select|SELECT|${SVC_Q}|`,
  `mp_source_record|mp_source_admin_select|SELECT|${ADMIN_Q}|`,
  `mp_source_record|mp_source_service_insert|INSERT||((auth.role() = 'service_role'::text) AND ((source_type)::text = ANY ((ARRAY['csv_import'::character varying, 'account_money_csv'::character varying])::text[])))`,
  `mp_source_record|mp_source_service_select|SELECT|${SVC_Q}|`,
  `mp_transition_identity|mp_identity_admin_select|SELECT|${ADMIN_Q}|`,
  `mp_transition_identity|mp_identity_service_select|SELECT|${SVC_Q}|`,
  `mp_webhook_delivery|mp_delivery_admin_select|SELECT|${ADMIN_Q}|`,
  `mp_webhook_delivery|mp_delivery_service_select|SELECT|${SVC_Q}|`,
];
// §3 EXECUTE table (app roles holding EXECUTE; '' = owner only)
const SERVICE_FNS = ['mp_register_delivery', 'mp_claim_deliveries', 'mp_delivery_transition', 'mp_ingest_api_snapshot', 'mp_normalize_source',
  'mp_apply_transition', 'mp_auto_allocate', 'mp_check_report_coverage', 'mp_record_balance_check'];
const BOTH_FNS = ['mp_requeue_config_blocked', 'mp_reconcile_movement'];
const ADMIN_FNS = ['mp_allocate_to_client', 'mp_reverse_client_allocation', 'mp_flag_for_attribution', 'mp_clear_attribution_flag',
  'mp_map_payer_to_client', 'mp_unmap_payer', 'mp_resolve_match', 'mp_normalize_report_fallback', 'mp_request_refetch', 'mp_resolve_chargeback_signal'];
const INVOKER_FNS = ['mp_is_auto_applicable', 'mp_v4_verified', 'mp_parse_report_row', 'mp_claim_report_payment_fallback',
  'mp_delivery_immutable_guard', 'mp_report_match_guard', 'mp_source_raw_guard', 'mp_source_insert_guard'];
const WANT_EXEC = Object.fromEntries([
  ...SERVICE_FNS.map((f) => [f, 'service_role']), ...BOTH_FNS.map((f) => [f, 'authenticated,service_role']),
  ...ADMIN_FNS.map((f) => [f, 'authenticated']), ...INVOKER_FNS.map((f) => [f, '']),
]);
// ADR006_RLS_AND_SECURITY_V1 §4: 41 verified baseline + 19 ADR-006 = 60; ADR-007 adds RPCs 44 / 45 → 62 (owner-approved)
const BASELINE_41 = ['assert_period_open', 'assign_flock_feed', 'assign_freight_to_purchase', 'cancel_order', 'cancel_supplier_instrument',
  'clear_cheque', 'close_sales_session', 'current_app_role', 'deliver_order', 'deposit_cheque', 'endorse_cheque', 'issue_supplier_instrument',
  'mark_supplier_instrument_debited', 'mp_normalize_source', 'mp_reconcile_movement', 'open_sales_session', 'pay_fiscal_obligation', 'pay_supplier',
  'receive_cheque', 'rectify_daily_production', 'rectify_delivered_order', 'rectify_mortality', 'rectify_purchase', 'register_classification',
  'register_collection', 'register_count_adjustment', 'register_daily_production', 'register_feed_inventory_count', 'register_feed_manufacturing',
  'register_feed_movement', 'register_fiscal_document', 'register_fiscal_obligation', 'register_freight', 'register_management_event',
  'register_mortality', 'register_purchase', 'register_session_cash_event', 'register_session_movement', 'reject_cheque',
  'reject_supplier_instrument', 'transfer_between_accounts'];
const ADR006_19 = ['mp_register_delivery', 'mp_claim_deliveries', 'mp_delivery_transition', 'mp_requeue_config_blocked', 'mp_request_refetch',
  'mp_resolve_chargeback_signal', 'mp_ingest_api_snapshot', 'mp_apply_transition', 'mp_allocate_to_client', 'mp_auto_allocate',
  'mp_reverse_client_allocation', 'mp_flag_for_attribution', 'mp_clear_attribution_flag', 'mp_map_payer_to_client', 'mp_unmap_payer',
  'mp_resolve_match', 'mp_normalize_report_fallback', 'mp_check_report_coverage', 'mp_record_balance_check'];
const ADR007_2 = ['register_flock', 'close_flock'];
const ADR011_1 = ['register_bank_tax'];   // ADR-011 RPC 46 (0062, Phase 27 acceptance fixes) → 63
const ADR012_013 = ['rectify_classification', 'publish_feed_formula_version'];   // ADR-012 RPC 47 (0063) / ADR-013 RPC 48 (0064) → 65
const ADR014_1 = ['rectify_feed_manufacturing'];   // ADR-014 RPC 49 (0065) → 66
const DEFINER_66 = [...BASELINE_41, ...ADR006_19, ...ADR007_2, ...ADR011_1, ...ADR012_013, ...ADR014_1].sort();

// ── fixtures ─────────────────────────────────────────────────────────────────
function cleanup() {
  owner(`
CREATE TEMP TABLE _src AS SELECT id FROM mp_source_record WHERE external_id LIKE 'MPPAY:7776%' OR external_id LIKE 'S9P-%';
CREATE TEMP TABLE _mv  AS SELECT id FROM mp_financial_movement WHERE mp_source_record_id IN (SELECT id FROM _src);
CREATE TEMP TABLE _op  AS SELECT financial_operation_id AS id FROM mp_reconciliation WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
CREATE TEMP TABLE _dl  AS SELECT id FROM mp_webhook_delivery WHERE resource_id LIKE '7776%';
CREATE TEMP TABLE _al  AS SELECT id, client_ledger_id FROM mp_client_allocation WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
CREATE TEMP TABLE _cl  AS SELECT id FROM clients WHERE nombre LIKE 'S9P %';
DELETE FROM audit_events WHERE entity_type = 'mp_client_allocation' AND entity_id IN (SELECT id::TEXT FROM _al);
DELETE FROM mp_client_allocation WHERE id IN (SELECT id FROM _al);
DELETE FROM client_ledger WHERE id IN (SELECT client_ledger_id FROM _al);
DELETE FROM mp_attribution_flag WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
DELETE FROM mp_payer_client_map WHERE cliente_id IN (SELECT id FROM _cl);
DELETE FROM mp_report_match WHERE report_source_id IN (SELECT id FROM _src);
DELETE FROM audit_events WHERE (entity_type = 'mp_source_record' AND entity_id IN (SELECT id::TEXT FROM _src))
   OR (entity_type = 'mp_financial_movement' AND entity_id IN (SELECT id::TEXT FROM _mv))
   OR (entity_type = 'mp_webhook_delivery' AND entity_id IN (SELECT id::TEXT FROM _dl));
DELETE FROM mp_reconciliation WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
DELETE FROM financial_posting WHERE financial_operation_id IN (SELECT id FROM _op);
DELETE FROM financial_operation WHERE id IN (SELECT id FROM _op);
DELETE FROM mp_transition_identity WHERE mp_financial_movement_id IN (SELECT id FROM _mv);
DELETE FROM mp_financial_movement WHERE id IN (SELECT id FROM _mv);
DELETE FROM mp_webhook_delivery WHERE triggered_by_delivery_id IN (SELECT id FROM _dl);
DELETE FROM mp_webhook_delivery WHERE id IN (SELECT id FROM _dl);
DELETE FROM mp_source_record WHERE id IN (SELECT id FROM _src);
DELETE FROM clients WHERE id IN (SELECT id FROM _cl);`);
}
cleanup();
owner(`
INSERT INTO auth.users (id, is_sso_user, is_anonymous) VALUES ('${ADMIN_UID}', false, false), ('${OPA}', false, false) ON CONFLICT (id) DO NOTHING;
INSERT INTO perfiles (id, email, rol_type, activo) VALUES ('${ADMIN_UID}', 'admin@test.local', 'ADMIN', true), ('${OPA}', 'operator@test.local', 'OPERATOR', true)
ON CONFLICT (id) DO NOTHING;`);

let pseq = 0;
const newPid = () => `7776${String(Date.now()).slice(-6)}${String(++pseq).padStart(2, '0')}`;
function payload(pid, extref) {
  const at = '2026-11-05T10:00:00.000-04:00';
  return { id: Number(pid), operation_type: 'money_transfer', status: 'approved', status_detail: 'accredited', currency_id: 'ARS', live_mode: true,
    collector_id: Number(COLLECTOR), payer: { id: '800000999' }, external_reference: extref, date_created: at, date_approved: at,
    transaction_amount: 100, transaction_details: { net_received_amount: 93 }, fee_details: [{ type: 'mercadopago_fee', amount: 5, fee_payer: 'collector' }],
    refunds: [], transaction_amount_refunded: 0, taxes_amount: 0, charges_details: [] };
}
/** the worker's DB path, as service_role: S1 → S2 → S4 → RPC 40 → A1 → C2 → FETCHED */
function pipeline(extref) {
  const pid = newPid();
  const d = svcJson(`mp_register_delivery('webhook', 'payment', 'payment', 'payment.updated', ${q(pid)}, NULL, 'S9P', ${q(JSON.stringify({ notification_id: `s9p-${pid}` }))}::jsonb, true)`).delivery_id;
  const claims = JSON.parse(SVC(`SELECT coalesce(json_agg(c), '[]')::text FROM mp_claim_deliveries(50, 120) c;`).out);
  const c = claims.find((x) => x.delivery_id === d);
  const src = svcJson(`mp_ingest_api_snapshot(${q(d)}, ${q(c.claim_token)}, ${q(pid)}, ${q(JSON.stringify(payload(pid, extref)))}::jsonb)`);
  svcJson(`mp_normalize_source(${q(src.source_record_id)})`);
  const mv = Number(SVC(`SELECT m.id FROM mp_financial_movement m WHERE m.mp_source_record_id = ${q(src.source_record_id)};`).out);
  const app = svcJson(`mp_apply_transition(${mv})`);
  const alloc = svcJson(`mp_auto_allocate(${mv})`);
  svcJson(`mp_delivery_transition(${q(d)}, ${q(c.claim_token)}, 'FETCHED', ${q(src.source_record_id)}, NULL, NULL, NULL, NULL)`);
  return { pid, d, src: src.source_record_id, mv, app, alloc };
}

section('F', 'fixtures through the real service path');
const due = owner(`SELECT count(*) FROM mp_webhook_delivery WHERE status IN ('RECEIVED', 'FAILED_RETRYABLE') AND next_attempt_at <= NOW() + INTERVAL '1 day' AND coalesce(resource_id, '') NOT LIKE '7776%';`);
check('F-0 no foreign due deliveries (the claim sees only this suite rows)', due === '0', due);
const CLI = owner(`INSERT INTO clients (nombre, activo) VALUES ('S9P active ${Date.now()}', true) RETURNING id;`);
const CLI_OFF = owner(`INSERT INTO clients (nombre, activo) VALUES ('S9P inactive ${Date.now()}', false) RETURNING id;`);
const P = pipeline(`GST:C:${CLI}`);
check('S4-1 (S4 still works under 0054) mp_ingest_api_snapshot as service_role creates the api_payment source (external_id MPPAY:<id>:<hash>); RPC 40 → A1 APPLIED → C2 allocated',
  owner(`SELECT source_type || '|' || (external_id ~ '^MPPAY:${P.pid}:[0-9a-f]{32}$') || '|' || processing_status FROM mp_source_record WHERE id = ${q(P.src)};`) === 'api_payment|true|RECONCILED'
    && P.app.status === 'APPLIED' && P.alloc.allocated === true, `${JSON.stringify(P.app)} ${JSON.stringify(P.alloc)}`);
const RSRC = owner(`INSERT INTO mp_source_record (source_type, external_id, event_data, occurred_at, occurred_date, processing_status, processed_at)
  VALUES ('csv_import', 'S9P-${Date.now()}:payment:C', '{"fixture":"owner"}'::jsonb, '2026-11-05T12:00:00-03:00', '2026-11-05', 'NORMALIZED', NOW()) RETURNING id;`);
owner(`INSERT INTO mp_report_match (outcome, report_source_id, detail, is_exception) VALUES ('BALANCE_CHECK', ${q(RSRC)}, '{"difference":"0"}'::jsonb, false);
INSERT INTO mp_attribution_flag (mp_financial_movement_id, reason, requested_by) VALUES (${P.mv}, 'S9P fixture', '${ADMIN_UID}');
INSERT INTO mp_payer_client_map (mp_payer_id, cliente_id, created_by) VALUES ('5559${String(Date.now()).slice(-8)}', ${q(CLI)}, '${ADMIN_UID}');`);
const counts = Object.fromEntries(MP_TABLES.map((t) => [t, Number(owner(`SELECT count(*) FROM ${t};`))]));
check('F-1 every one of the nine MP tables holds at least one row (row-visibility tests are meaningful)', MP_TABLES.every((t) => counts[t] > 0), JSON.stringify(counts));

// ═════════════════════════════════════════════════════════════════════════════
section('M', 'exact grant / policy / EXECUTE maps');
check('M-1 table privileges of anon / authenticated / service_role on the nine MP tables = the authority matrix exactly (SELECT only, plus the service report INSERT)',
  owner(`SELECT string_agg(c.relname || ':' || r.rolname || ':' || a.privilege_type, ',' ORDER BY c.relname, r.rolname, a.privilege_type)
    FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a JOIN pg_roles r ON r.oid = a.grantee
    WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN (${MP_TABLES.map(q).join(',')}) AND r.rolname IN ('anon','authenticated','service_role');`) === WANT_TABLE_ACL.join(','),
  owner(`SELECT string_agg(c.relname || ':' || r.rolname || ':' || a.privilege_type, ',' ORDER BY c.relname, r.rolname, a.privilege_type)
    FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a JOIN pg_roles r ON r.oid = a.grantee
    WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN (${MP_TABLES.map(q).join(',')}) AND r.rolname IN ('anon','authenticated','service_role');`));
check('M-2 PUBLIC holds no privilege on any MP table', owner(`SELECT count(*) FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
  WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN (${MP_TABLES.map(q).join(',')}) AND a.grantee = 0;`) === '0');
check('M-3 RLS enabled on all nine MP tables', owner(`SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN (${MP_TABLES.map(q).join(',')}) AND relrowsecurity;`) === '9');
const pols = owner(`SELECT string_agg(tablename || '|' || policyname || '|' || cmd || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), E'\\n' ORDER BY tablename, policyname)
  FROM pg_policies WHERE schemaname = 'public' AND tablename IN (${MP_TABLES.map(q).join(',')});`);
check('M-4 policies on the MP tables = the authority set exactly (SELECT policies ADMIN / service; the narrowed report INSERT; nothing else)', pols === WANT_POLICIES.join('\n'), pols);
const execMap = JSON.parse(owner(`SELECT json_object_agg(p.proname, (SELECT coalesce(string_agg(r, ',' ORDER BY r), '') FROM unnest(ARRAY['anon','authenticated','service_role']) r
    WHERE has_function_privilege(r, p.oid, 'EXECUTE')))::text FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'mp\\_%';`));
const wrongExec = Object.keys({ ...WANT_EXEC, ...execMap }).sort().filter((f) => execMap[f] !== WANT_EXEC[f]).map((f) => `${f}: got ${execMap[f]} want ${WANT_EXEC[f]}`);
check(`M-5 EXECUTE on every mp_ function (${Object.keys(execMap).length} in pg_proc) = the §3 table exactly; no function outside it`, wrongExec.length === 0, wrongExec.join('; '));
check('M-6 no mp_ function is executable by PUBLIC', owner(`SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'mp\\_%' AND has_function_privilege('public', p.oid, 'EXECUTE');`) === '0');
check('M-7 sequences of the MP tables: no privilege for anon / authenticated / service_role / PUBLIC',
  owner(`SELECT count(*) FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('S', c.relowner))) a
    WHERE c.relkind = 'S' AND c.relnamespace = 'public'::regnamespace AND c.relname LIKE 'mp\\_%' AND (a.grantee = 0 OR a.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')));`) === '0'
    && ['anon', 'authenticated', 'service_role'].every((r) => owner(`SELECT has_sequence_privilege('${r}', 'mp_transition_identity_id_seq', 'USAGE') OR has_sequence_privilege('${r}', 'mp_transition_identity_id_seq', 'UPDATE') OR has_sequence_privilege('${r}', 'mp_financial_movement_id_seq', 'USAGE');`) === 'f'));

// ═════════════════════════════════════════════════════════════════════════════
section('S-1', 'anon');
{
  const sel = MP_TABLES.map((t) => [t, ACT.anon(`SELECT count(*) FROM ${t};`)]);
  check('S-1a anon SELECT on each of the nine MP tables → permission denied', sel.every(([, r]) => denied(r)), sel.filter(([, r]) => !denied(r)).map(([t]) => t).join());
  const anonExec = owner(`SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND (p.proname LIKE 'mp\\_%' OR p.prosecdef) AND has_function_privilege('anon', p.oid, 'EXECUTE');`);
  check('S-1b anon holds EXECUTE on no mp_ function and on no SECURITY DEFINER function', anonExec === '0', anonExec);
  const calls = [ACT.anon(`SELECT mp_register_delivery('webhook','payment','payment',NULL,'1',NULL,NULL,'{}'::jsonb,true,NULL);`), ACT.anon(`SELECT mp_claim_deliveries(1, 60);`),
    ACT.anon(`SELECT mp_auto_allocate(1);`), ACT.anon(`SELECT mp_requeue_config_blocked('x');`)];
  check('S-1c anon calls to ADR-006 RPCs → permission denied', calls.every(denied), calls.map(errLine).join(' | '));
}

// ═════════════════════════════════════════════════════════════════════════════
section('S-2', 'OPERATOR');
{
  const rows = MP_TABLES.map((t) => [t, ACT.operator(`SELECT count(*) FROM ${t};`)]);
  check('S-2a OPERATOR sees 0 rows in every MP table (no policy admits it)', rows.every(([, r]) => r.ok && r.out === '0'), rows.map(([t, r]) => `${t}=${r.ok ? r.out : errLine(r)}`).join(' '));
  const adminCalls = {
    mp_allocate_to_client: `mp_allocate_to_client(${P.mv}, '${CLI}', 1, '2026-11-05', 'S9P-k', 'r')`,
    mp_reverse_client_allocation: `mp_reverse_client_allocation(gen_random_uuid(), 1, 'S9P-k', 'r')`,
    mp_flag_for_attribution: `mp_flag_for_attribution(${P.mv}, 'r')`,
    mp_clear_attribution_flag: `mp_clear_attribution_flag(gen_random_uuid(), 'r')`,
    mp_map_payer_to_client: `mp_map_payer_to_client('123', '${CLI}', 'r')`,
    mp_unmap_payer: `mp_unmap_payer(gen_random_uuid(), 'r')`,
    mp_resolve_match: `mp_resolve_match(gen_random_uuid(), 'EXPLAINED', 'r')`,
    mp_normalize_report_fallback: `mp_normalize_report_fallback(gen_random_uuid(), 'r')`,
    mp_request_refetch: `mp_request_refetch('123', 'r')`,
    mp_resolve_chargeback_signal: `mp_resolve_chargeback_signal(gen_random_uuid(), 'DISMISSED', NULL, 'r')`,
    mp_requeue_config_blocked: `mp_requeue_config_blocked('r')`,
    mp_reconcile_movement: `mp_reconcile_movement(${P.mv}, 1, 'S9P-k', gen_random_uuid(), 'MP_SETTLEMENT', NULL, 'r')`,
  };
  const res = Object.entries(adminCalls).map(([f, c]) => [f, ACT.operator(`SELECT ${c};`)]);
  check('S-2b OPERATOR → every ADMIN / ADMIN-or-service RPC raises FORBIDDEN (12 functions)', res.every(([, r]) => forbidden(r)), res.filter(([, r]) => !forbidden(r)).map(([f, r]) => `${f}: ${errLine(r)}`).join(' | '));
  const svcOnly = SERVICE_FNS.map((f) => [f, ACT.operator(`SELECT ${f === 'mp_claim_deliveries' ? 'mp_claim_deliveries(1, 60)' : f === 'mp_auto_allocate' ? `mp_auto_allocate(${P.mv})` : f === 'mp_apply_transition' ? `mp_apply_transition(${P.mv})` : f === 'mp_normalize_source' ? `mp_normalize_source('${P.src}')` : f === 'mp_record_balance_check' ? `mp_record_balance_check('${RSRC}')` : f === 'mp_check_report_coverage' ? `mp_check_report_coverage('liberaciones', '2026-11-01', '2026-11-02')` : f === 'mp_ingest_api_snapshot' ? `mp_ingest_api_snapshot(gen_random_uuid(), gen_random_uuid(), '1', '{}'::jsonb)` : f === 'mp_delivery_transition' ? `mp_delivery_transition(gen_random_uuid(), gen_random_uuid(), 'FETCHED', NULL, NULL, NULL, NULL, NULL)` : `mp_register_delivery('webhook','payment','payment',NULL,'1',NULL,NULL,'{}'::jsonb,true,NULL)`};`)]);
  check('S-2c OPERATOR → every service-only RPC is permission denied (no EXECUTE)', svcOnly.every(([, r]) => denied(r)), svcOnly.filter(([, r]) => !denied(r)).map(([f, r]) => `${f}: ${errLine(r)}`).join(' | '));
}

// ═════════════════════════════════════════════════════════════════════════════
section('S-3', 'ADMIN');
{
  const rows = MP_TABLES.map((t) => [t, ACT.admin(`SELECT count(*) FROM ${t};`)]);
  check('S-3a ADMIN reads every MP table (read-only visibility by policy; row counts equal the owner view)',
    rows.every(([t, r]) => r.ok && Number(r.out) === Number(owner(`SELECT count(*) FROM ${t};`))), rows.map(([t, r]) => `${t}=${r.ok ? r.out : errLine(r)}`).join(' '));
  const svcOnly = SERVICE_FNS.map((f) => [f, ACT.admin(`SELECT ${f === 'mp_auto_allocate' ? `mp_auto_allocate(${P.mv})` : f === 'mp_claim_deliveries' ? 'mp_claim_deliveries(1, 60)' : f === 'mp_apply_transition' ? `mp_apply_transition(${P.mv})` : f === 'mp_normalize_source' ? `mp_normalize_source('${P.src}')` : f === 'mp_record_balance_check' ? `mp_record_balance_check('${RSRC}')` : f === 'mp_check_report_coverage' ? `mp_check_report_coverage('liberaciones', '2026-11-01', '2026-11-02')` : f === 'mp_ingest_api_snapshot' ? `mp_ingest_api_snapshot(gen_random_uuid(), gen_random_uuid(), '1', '{}'::jsonb)` : f === 'mp_delivery_transition' ? `mp_delivery_transition(gen_random_uuid(), gen_random_uuid(), 'FETCHED', NULL, NULL, NULL, NULL, NULL)` : `mp_register_delivery('webhook','payment','payment',NULL,'1',NULL,NULL,'{}'::jsonb,true,NULL)`};`)]);
  check('S-3b ADMIN cannot call any service-only RPC (permission denied: no EXECUTE for authenticated)', svcOnly.every(([, r]) => denied(r)), svcOnly.filter(([, r]) => !denied(r)).map(([f, r]) => `${f}: ${errLine(r)}`).join(' | '));
  const rq = ACT.admin(`SELECT mp_requeue_config_blocked('S9P admin requeue')::text;`);
  check('S-3c ADMIN can call mp_requeue_config_blocked; OPERATOR (FORBIDDEN) and anon (permission denied) cannot',
    rq.ok && JSON.parse(rq.out).requeued >= 0 && forbidden(ACT.operator(`SELECT mp_requeue_config_blocked('x');`)) && denied(ACT.anon(`SELECT mp_requeue_config_blocked('x');`)), errLine(rq));
  owner(`DELETE FROM audit_events WHERE action = 'MP_DELIVERY_REQUEUE' AND reason = 'S9P admin requeue';`);
}

// ═════════════════════════════════════════════════════════════════════════════
section('W', 'direct writes by application roles (all nine MP tables)');
{
  const firstCol = Object.fromEntries(MP_TABLES.map((t) => [t, owner(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${t}' ORDER BY ordinal_position LIMIT 1;`)]));
  const bad = [];
  for (const actor of ['anon', 'operator', 'admin', 'service']) {
    for (const t of MP_TABLES) {
      const stmts = { UPDATE: `UPDATE ${t} SET ${firstCol[t]} = ${firstCol[t]} WHERE false;`, DELETE: `DELETE FROM ${t} WHERE false;`, TRUNCATE: `TRUNCATE ${t};` };
      if (!(actor === 'service' && t === 'mp_source_record')) stmts.INSERT = `INSERT INTO ${t} DEFAULT VALUES;`;
      for (const [op, sql] of Object.entries(stmts)) {
        const r = ACT[actor](sql, 'ROLLBACK');
        if (!denied(r)) bad.push(`${actor}:${op}:${t}:${errLine(r) || 'ALLOWED'}`);
      }
    }
  }
  check('W-1 anon / OPERATOR / ADMIN / service_role: INSERT, UPDATE, DELETE, TRUNCATE on every MP table → permission denied (except the one service report-source INSERT)', bad.length === 0, bad.join(' | '));
  const privs = owner(`SELECT count(*) FROM pg_class c, unnest(ARRAY['anon','authenticated','service_role']) r, unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE']) p
    WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN (${MP_TABLES.map(q).join(',')}) AND has_table_privilege(r, c.oid, p)
      AND NOT (c.relname = 'mp_source_record' AND r = 'service_role' AND p = 'INSERT');`);
  check('W-2 has_table_privilege agrees: zero write privilege for the application roles apart from the service report-source INSERT', privs === '0', privs);
}

// ═════════════════════════════════════════════════════════════════════════════
section('S-4', 'service_role perimeter + direct source INSERT (R4 / N-9 / B4 / D7)');
{
  const noSel = ['mp_client_allocation', 'mp_payer_client_map', 'mp_attribution_flag'].map((t) => [t, SVC(`SELECT count(*) FROM ${t};`)]);
  check('S-4a service_role has no SELECT on mp_client_allocation / mp_payer_client_map / mp_attribution_flag', noSel.every(([, r]) => denied(r)), noSel.map(([t, r]) => `${t}:${errLine(r)}`).join(' | '));
  const yesSel = ['mp_webhook_delivery', 'mp_transition_identity', 'mp_report_match', 'mp_source_record', 'mp_financial_movement', 'mp_reconciliation']
    .map((t) => [t, SVC(`SELECT count(*) FROM ${t};`)]);
  check('S-4b service_role reads the queue, identity, match, source, movement and reconciliation tables (all rows)',
    yesSel.every(([t, r]) => r.ok && Number(r.out) === counts[t] || (r.ok && Number(r.out) === Number(owner(`SELECT count(*) FROM ${t};`)))), yesSel.map(([t, r]) => `${t}=${r.ok ? r.out : errLine(r)}`).join(' '));
  const wk = SVC(`SELECT notification_payload->>'notification_id' FROM mp_webhook_delivery WHERE id = ${q(P.d)};`);
  const ob = SVC(`SELECT count(*) FROM (SELECT resource_id FROM mp_webhook_delivery WHERE status = 'CONFIG_BLOCKED' AND topic_class = 'payment' ORDER BY updated_at LIMIT 1) x;`);
  check('S-4c the two Step-8 worker reads (chargeback data_payment_id, oldest CONFIG_BLOCKED) succeed as service_role — no longer fail-closed', wk.ok && wk.out === `s9p-${P.pid}` && ob.ok, `${errLine(wk)} ${errLine(ob)}`);
  const ins = (type, end = 'ROLLBACK') => SVC(`INSERT INTO mp_source_record (source_type, external_id, event_data, occurred_at, occurred_date)
    VALUES ('${type}', 'S9P-direct-${type}-${Date.now()}', '{}'::jsonb, '2026-11-05T12:00:00-03:00', '2026-11-05') RETURNING source_type;`, end);
  const deniedTypes = ['api_payment', 'api_refund', 'webhook', 'api'].map((t) => [t, ins(t)]);
  check('S-4d / N-9 service_role direct INSERT of api_payment / api_refund / webhook / api → denied (SOURCE_TYPE_NOT_INSERTABLE; R4)',
    deniedTypes.every(([, r]) => !r.ok && /SOURCE_TYPE_NOT_INSERTABLE/.test(r.err)), deniedTypes.map(([t, r]) => `${t}:${r.ok ? 'ALLOWED' : errLine(r)}`).join(' | '));
  const allowed = ['csv_import', 'account_money_csv'].map((t) => [t, ins(t)]);
  check('S-4e service_role direct INSERT of the report source types csv_import / account_money_csv → allowed (rolled back)',
    allowed.every(([t, r]) => r.ok && r.out.split('\n').includes(t)), allowed.map(([t, r]) => `${t}:${r.ok ? r.out : errLine(r)}`).join(' | '));
  check('S-4f R4 mechanism: service_role holds BYPASSRLS (the narrowed policy is declarative only), so the enabled SECURITY INVOKER guard trg_mp_source_insert_guard enforces it',
    owner(`SELECT rolbypassrls FROM pg_roles WHERE rolname = 'service_role';`) === 't'
      && owner(`SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_mp_source_insert_guard' AND tgrelid = 'mp_source_record'::regclass AND tgenabled = 'O';`) === '1'
      && owner(`SELECT prosecdef FROM pg_proc WHERE proname = 'mp_source_insert_guard';`) === 'f');
  const lg = SVC(`INSERT INTO client_ledger (cliente_id, movement_type, signed_amount, effective_date, ledger_client_name) VALUES ('${CLI}', 'COLLECTION', -1, '2026-11-05', 'x');`, 'ROLLBACK');
  check('S-4g service_role cannot INSERT client_ledger directly', denied(lg), errLine(lg));
}

// ═════════════════════════════════════════════════════════════════════════════
section('S-5', 'service_role business tables + guard triggers');
{
  const biz = ['clients', 'pedidos', 'client_ledger', 'collections', 'financial_operation', 'financial_posting', 'supplier_ledger', 'management_period',
    'audit_events', 'financial_account'];
  const w = owner(`SELECT coalesce(string_agg(t || ':' || p, ','), '') FROM unnest(ARRAY[${biz.map(q).join(',')}]) t, unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE']) p
    WHERE has_table_privilege('service_role', t, p);`);
  check('S-5a service_role has no INSERT / UPDATE / DELETE / TRUNCATE on clients, pedidos, client_ledger, collections, financial ledgers, periods, audit', w === '', w);
  const a = [SVC(`INSERT INTO clients (nombre) VALUES ('S9P svc');`, 'ROLLBACK'), SVC(`UPDATE pedidos SET cliente_id = cliente_id WHERE false;`, 'ROLLBACK'),
    SVC(`INSERT INTO collections DEFAULT VALUES;`, 'ROLLBACK'), SVC(`DELETE FROM client_ledger WHERE false;`, 'ROLLBACK')];
  check('S-5b actual service_role writes on clients / pedidos / collections / client_ledger → permission denied', a.every(denied), a.map(errLine).join(' | '));
  const g1 = raw(`BEGIN; UPDATE mp_webhook_delivery SET resource_id = '0' WHERE id = ${q(P.d)}; ROLLBACK;`);
  const g2 = raw(`BEGIN; UPDATE mp_report_match SET detail = '{"difference":"0","x":1}'::jsonb WHERE report_source_id = ${q(RSRC)}; ROLLBACK;`);
  const g3 = raw(`BEGIN; UPDATE mp_source_record SET event_data = '{}'::jsonb WHERE id = ${q(P.src)}; ROLLBACK;`);
  check('S-5c guard triggers still protect immutable columns even for the owner: delivery identity, match evidence, raw source',
    /notification identity is immutable/.test(g1.err) && /mp_report_match evidence is immutable/.test(g2.err) && /raw source data is immutable/.test(g3.err), [g1, g2, g3].map(errLine).join(' | '));
}

// ═════════════════════════════════════════════════════════════════════════════
section('S-6', 'evidence-only AUTO attribution');
{
  check('S-6a mp_auto_allocate has one signature (p_movement_id bigint): no client / amount parameter exists',
    owner(`SELECT string_agg(pg_get_function_identity_arguments(oid), ';') FROM pg_proc WHERE proname = 'mp_auto_allocate';`) === 'p_movement_id bigint');
  const man = SVC(`SELECT mp_allocate_to_client(${P.mv}, '${CLI}', 1, '2026-11-05', 'S9P-svc', 'r');`, 'ROLLBACK');
  check('S-6b service_role cannot call the client-choosing MANUAL RPC mp_allocate_to_client (permission denied)', denied(man), errLine(man));
  const ghost = pipeline('GST:C:00000000-0000-4000-8000-00000000abcd');
  const off = pipeline(`GST:C:${CLI_OFF}`);
  check('S-6c a forged external_reference naming a non-existent client → NO_EVIDENCE; an inactive client → CLIENT_INACTIVE; no allocation for either',
    ghost.alloc.allocated === false && ghost.alloc.reason === 'NO_EVIDENCE' && off.alloc.allocated === false && off.alloc.reason === 'CLIENT_INACTIVE'
      && owner(`SELECT count(*) FROM mp_client_allocation WHERE mp_financial_movement_id IN (${ghost.mv}, ${off.mv});`) === '0', `${JSON.stringify(ghost.alloc)} ${JSON.stringify(off.alloc)}`);
}

// ═════════════════════════════════════════════════════════════════════════════
section('S-7', 'SECURITY DEFINER inventory + RLS spec §11 verification');
{
  const got = owner(`SELECT string_agg(proname, ',' ORDER BY proname) FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace;`);
  check(`S-7a SECURITY DEFINER set = the exact 66-name literal (41 verified baseline + 19 ADR-006 + 2 ADR-007 + 1 ADR-011 + 2 ADR-012/013 + 1 ADR-014; §4)`, got === DEFINER_66.join(','),
    `extra=${got.split(',').filter((x) => !DEFINER_66.includes(x))} missing=${DEFINER_66.filter((x) => !got.split(',').includes(x))}`);
  check('S-7b count = 66 (ADR-007 + ADR-011 + ADR-012/013 + ADR-014)', got.split(',').length === 66 && DEFINER_66.length === 66);
  check('S-7c every SECURITY DEFINER is owned by postgres', owner(`SELECT count(*) FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace AND proowner <> 'postgres'::regrole;`) === '0');
  check('S-7d spec check 6: every SECURITY DEFINER pins search_path = public (0 rows)', owner(`SELECT count(*) FROM pg_proc WHERE prosecdef = true AND pronamespace = 'public'::regnamespace
    AND NOT (COALESCE(proconfig, '{}') @> ARRAY['search_path=public']);`) === '0');
  check('S-7e spec check 7: no SECURITY DEFINER executable by PUBLIC (0 rows)', owner(`SELECT count(*) FROM pg_proc p WHERE p.prosecdef = true AND p.pronamespace = 'public'::regnamespace
    AND has_function_privilege('public', p.oid, 'EXECUTE');`) === '0');
  check('S-7f spec check 8: the MP raw-guard trigger exists (1 row)', owner(`SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_mp_source_raw_guard';`) === '1');
  const inv = owner(`SELECT string_agg(proname || ':' || prosecdef || ':' || (has_function_privilege('anon', oid, 'EXECUTE') OR has_function_privilege('authenticated', oid, 'EXECUTE')
    OR has_function_privilege('service_role', oid, 'EXECUTE')), ',' ORDER BY proname) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN (${INVOKER_FNS.map(q).join(',')});`);
  check('S-7g the helpers / trigger functions are SECURITY INVOKER and executable by no application role (mp_parse_report_row, mp_claim_report_payment_fallback absent from the definer set)',
    inv === [...INVOKER_FNS].sort().map((f) => `${f}:false:false`).join(','), inv);
  check('S-7h no ADR-006 definer body uses dynamic EXECUTE', owner(`SELECT count(*) FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace AND proname LIKE 'mp\\_%'
    AND prosrc ~* '\\mEXECUTE\\s+(format|''|\\$|[a-z_]+\\s*\\|\\|)';`) === '0');
  check('S-7i helper semantics unchanged: mp_v4_verified() = false; mp_is_auto_applicable(payment / APPROVAL) = true',
    owner(`SELECT mp_v4_verified()::text || '|' || mp_is_auto_applicable(${P.mv})::text;`) === 'false|true');
  // RLS_IMPLEMENTATION_SPEC_V1 §11 checks 1–5b
  check('S-7j spec check 1: RLS enabled on every public table (0 rows)', owner(`SELECT coalesce(string_agg(tablename, ','), '') FROM pg_tables WHERE schemaname = 'public' AND rowsecurity = false;`) === '');
  check('S-7k spec checks 2–4: no jwt() claim authorization, no SERVICE_ROLE business-role test, no no-op deny policy (0 rows)', owner(`SELECT count(*) FROM pg_policies WHERE schemaname = 'public'
    AND ((qual LIKE '%jwt()%' OR with_check LIKE '%jwt()%') OR (qual LIKE '%current_app_role() = ''SERVICE_ROLE''%' OR with_check LIKE '%current_app_role() = ''SERVICE_ROLE''%')
      OR (qual ILIKE '%and false%' OR qual = 'false' OR with_check = 'false'));`) === '0');
  const c5 = owner(`SELECT coalesce(string_agg(table_name || ':' || privilege_type, ','), '') FROM information_schema.role_table_grants
    WHERE grantee IN ('authenticated','anon') AND privilege_type IN ('INSERT','UPDATE','DELETE')
      AND table_name IN ('client_ledger','collections','financial_operation','financial_posting','financial_instrument','financial_instrument_event','supplier_ledger',
        'purchases','purchase_line','freight','freight_allocation','population_events','daily_production','flock_weighing','temperature_record','classification',
        'classification_line','feed_manufacturing','feed_movement','feed_inventory_count','flock_feed_assignment','sales_session','sales_session_movement',
        'sales_session_cash_event','fiscal_document','fiscal_document_component','fiscal_obligation','fiscal_obligation_installment','fiscal_payment',
        'management_period','audit_events','flocks','mp_source_record','mp_financial_movement','mp_reconciliation',
        ${NEW_TABLES.map(q).join(',')});`);
  check('S-7l spec check 5 (extended to the six ADR-006 tables): no INSERT / UPDATE / DELETE for authenticated / anon on any fact table (0 rows)', c5 === '', c5);
  check('S-7m spec check 5b: the pedidos exception stays contained (exactly one UPDATE policy, estado = PENDING on both sides)',
    owner(`SELECT count(*) || '|' || bool_and(qual LIKE '%PENDING%' AND with_check LIKE '%PENDING%') FROM pg_policies WHERE schemaname = 'public' AND tablename = 'pedidos' AND cmd = 'UPDATE';`) === '1|true');
}

cleanup();
console.log(`\n  ══ MP PRIVILEGES (STEP 9) RESULT: ${pass} passed, ${fail} failed ══\n`);
if (fail) console.log(failures.map((f) => `   - ${f}`).join('\n'));
process.exit(fail === 0 ? 0 : 1);
