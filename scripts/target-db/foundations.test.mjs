#!/usr/bin/env node
/**
 * PHASE 13 — FOUNDATIONS TEST SUITE. LOCAL TEST DATABASE ONLY.
 *
 * Tests behaviour, not just the existence of objects. Every case runs through the
 * guard first, and every role-scoped case simulates a real authenticated session
 * the way Supabase does it:
 *     SET LOCAL ROLE authenticated;
 *     SET LOCAL request.jwt.claims = '{"sub":"<uuid>","role":"authenticated"}';
 * because auth.uid() reads request.jwt.claim.sub / request.jwt.claims->>'sub'
 * and auth.role() reads the role claim.
 *
 * The CLOSED-period proof uses a fixture in schema `test_harness`, deliberately
 * OUTSIDE `public`: it is a test artefact, never part of the target schema, and it
 * is dropped at the end. It exercises the real Foundation guard
 * (public.assert_period_open) through a real protected write.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *     node scripts/target-db/foundations.test.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeDestructiveTarget } from '../test-env/guard.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function resolveDockerBin() {
  if (process.env.DOCKER_BIN) return process.env.DOCKER_BIN;
  const onPath = spawnSync('docker', ['--version'], { encoding: 'utf8' });
  if (!onPath.error && onPath.status === 0) return 'docker';
  const c = resolve(process.env.LOCALAPPDATA ?? '', 'Programs', 'DockerDesktop', 'resources', 'bin', 'docker.exe');
  return existsSync(c) ? c : 'docker';
}
const DOCKER = resolveDockerBin();

const ADMIN_UID = '11111111-1111-1111-1111-111111111111';
const OPER_UID = '22222222-2222-2222-2222-222222222222';
const INACTIVE_UID = '33333333-3333-3333-3333-333333333333';
const NOPROFILE_UID = '44444444-4444-4444-4444-444444444444';

let container;
let pass = 0;
let fail = 0;
const failures = [];

function dockerRun(args, input) {
  const r = spawnSync(DOCKER, args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`docker: ${r.error.message}`);
  return r;
}

/**
 * Runs SQL as the database owner. Returns { ok, out, err }.
 * `-q` matters: without it psql echoes command tags (BEGIN, SET, COMMIT,
 * "INSERT 0 1") into stdout alongside the value, and every equality assertion
 * would compare against that noise instead of the result.
 */
function raw(sqlText) {
  const r = dockerRun(
    ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    sqlText
  );
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

/** Runs SQL as the database owner and throws on failure. */
function owner(sqlText) {
  const r = raw(sqlText);
  if (!r.ok) throw new Error(`setup SQL failed:\n${r.err}`);
  return r.out;
}

/** Runs SQL inside a session impersonating a Supabase role + JWT claims. */
function asRole(pgRole, claims, sqlText) {
  const claimsJson = JSON.stringify(claims).replace(/'/g, "''");
  const wrapped = `
BEGIN;
SET LOCAL ROLE ${pgRole};
SET LOCAL "request.jwt.claims" = '${claimsJson}';
${sqlText}
COMMIT;`;
  return raw(wrapped);
}

const asAuthenticated = (uid, sqlText) =>
  asRole('authenticated', { sub: uid, role: 'authenticated' }, sqlText);
const asServiceRole = (sqlText) => asRole('service_role', { role: 'service_role' }, sqlText);

function check(label, condition, detail) {
  if (condition) {
    pass += 1;
    console.log(`    OK   ${label}`);
  } else {
    fail += 1;
    failures.push({ label, detail });
    console.log(`    MAL  ${label}${detail ? ` :: ${detail}` : ''}`);
  }
}

function section(n, title) {
  console.log(`\n  ── ${n}. ${title} ${'─'.repeat(Math.max(0, 52 - title.length))}`);
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

// ── pre-clean: remove this suite's own fixtures from an earlier run ──────────
// Makes the suite re-runnable on a database it has already exercised.
owner(`
DROP SCHEMA IF EXISTS test_harness CASCADE;
DELETE FROM operator_assignments WHERE flock_id IN (
  SELECT f.id FROM flocks f JOIN sheds s ON s.id = f.shed_id
   WHERE s.nombre IN ('shed-test-1','shed-test-2'));
DELETE FROM flocks WHERE shed_id IN (SELECT id FROM sheds WHERE nombre IN ('shed-test-1','shed-test-2'));
DELETE FROM sheds WHERE nombre IN ('shed-test-1','shed-test-2','shed-admin-write');
`);

// ── fixtures: auth users + profiles ───────────────────────────────────────
owner(`
INSERT INTO auth.users (id, is_sso_user, is_anonymous) VALUES
  ('${ADMIN_UID}', false, false),
  ('${OPER_UID}', false, false),
  ('${INACTIVE_UID}', false, false),
  ('${NOPROFILE_UID}', false, false)
ON CONFLICT (id) DO NOTHING;

INSERT INTO perfiles (id, email, rol_type, activo) VALUES
  ('${ADMIN_UID}', 'admin@test.local',    'ADMIN',    true),
  ('${OPER_UID}',  'operator@test.local', 'OPERATOR', true),
  ('${INACTIVE_UID}', 'inactive@test.local','OPERATOR', false)
ON CONFLICT (id) DO NOTHING;
`);

// ═══════════════════════════════════════════════════════════════════════════
section(1, 'Foundations schema created from scratch');

const tableList = owner(
  `SELECT string_agg(table_name, ',' ORDER BY table_name)
     FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE';`
).split(',');
const expectedTables = [
  'audit_events', 'classification_grade', 'clients', 'expense_category', 'feed_ingredient',
  'feed_type', 'financial_account', 'flocks', 'genetics_consumption_curve',
  'management_period', 'operator_assignments', 'perfiles', 'price_history', 'products',
  'projects', 'sheds', 'suppliers',
];
// Tables materialised by later, already-built phases. Anything outside
// Foundation + this list is an unexpected object and fails the suite.
const LATER_PHASE_TABLES = [
  'client_ledger', 'collections', 'financial_operation', 'financial_posting',
  'pedido_lineas', 'pedidos',                                   // Phase 14 Commercial
  'financial_instrument', 'financial_instrument_event', 'supplier_ledger', // Phase 16 Instruments
  'freight', 'freight_allocation', 'purchase_attachment', 'purchase_line', 'purchases', // Phase 17 Purchases
  'daily_production', 'population_events',                                             // Phase 18 Production
  'classification', 'classification_line',                                             // Phase 19 Classification
  'feed_formula_line', 'feed_formula_version', 'feed_inventory_count', 'feed_manufacturing', 'feed_movement', 'flock_feed_assignment', // Phase 20 Feed
  'sales_session', 'sales_session_cash_event', 'sales_session_movement',                    // Phase 21 Feria
  'fiscal_document', 'fiscal_document_component', 'fiscal_obligation', 'fiscal_obligation_installment', 'fiscal_payment', // Phase 22 Fiscal
  'mp_financial_movement', 'mp_reconciliation', 'mp_source_record',                            // Phase 23 Mercado Pago
  'management_event',                                                                           // Phase 24 P&L (ADR-004)
  'mp_attribution_flag', 'mp_client_allocation', 'mp_payer_client_map', 'mp_report_match', 'mp_transition_identity', 'mp_webhook_delivery', // ADR-006 (0047)
  'bank_tax_charge',                                                                            // ADR-011 (0062)
];
const foundationFound = tableList.filter((t) => expectedTables.includes(t));
check(`17 Foundation tables exist (found ${foundationFound.length})`, foundationFound.length === 17, foundationFound.join(','));
for (const t of expectedTables) check(`table ${t}`, tableList.includes(t));
const unexpected = tableList.filter((t) => !expectedTables.includes(t) && !LATER_PHASE_TABLES.includes(t));
check('no table outside Foundation + built later phases', unexpected.length === 0, unexpected.join(','));

const rlsOff = owner(
  `SELECT coalesce(string_agg(tablename, ','), '') FROM pg_tables
    WHERE schemaname='public' AND rowsecurity=false;`
);
check('RLS enabled on every Foundation table', rlsOff === '', rlsOff);

// ═══════════════════════════════════════════════════════════════════════════
section(2, 'Expected enums exist with the frozen values');

const enumCount = owner(
  `SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname='public' AND t.typtype='e';`
);
// 28 frozen enum types + 2 added by ADR-004 in Phase 24 (expense_cost_class, management_event_type)
// + 2 added by ADR-006 in 0047 (mp_delivery_status, mp_match_outcome)
// + 1 added by ADR-012 in 0063 (classification_entry_unit)
check(`28 frozen + 2 ADR-004 + 2 ADR-006 + 1 ADR-012 enum types exist (found ${enumCount})`, enumCount === '33');

const rolValues = owner(`SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder)
  FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='rol_type';`);
check("rol_type = ADMIN,OPERATOR", rolValues === 'ADMIN,OPERATOR', rolValues);

const periodStatus = owner(`SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder)
  FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='management_period_status';`);
check("management_period_status = OPEN,CLOSED", periodStatus === 'OPEN,CLOSED', periodStatus);

const instrEstado = owner(`SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid
  WHERE t.typname='instrument_estado';`);
check('instrument_estado has 8 values', instrEstado === '8', instrEstado);

// ═══════════════════════════════════════════════════════════════════════════
section(3, 'Constraints actually reject bad data');

let r = raw(`INSERT INTO management_period (periodo_fecha) VALUES ('2027-03-15');`);
check('management_period rejects a non-month-start date', !r.ok && /chk_periodo_fecha_is_month_start/.test(r.err));

r = raw(`INSERT INTO perfiles (id, email) VALUES ('${NOPROFILE_UID}', 'admin@test.local');`);
check('perfiles.email uniqueness enforced', !r.ok && /perfiles_email_key|duplicate key/.test(r.err));

owner(`INSERT INTO sheds (nombre) VALUES ('shed-test-1') ON CONFLICT DO NOTHING;`);
const shedId = owner(`SELECT id FROM sheds WHERE nombre='shed-test-1';`);
owner(`INSERT INTO flocks (shed_id, entry_date, initial_population, estado)
       VALUES ('${shedId}', '2026-02-01', 1000, 'ACTIVE');`);
r = raw(`INSERT INTO flocks (shed_id, entry_date, initial_population, estado)
         VALUES ('${shedId}', '2026-03-01', 500, 'ACTIVE');`);
check('invariant 1: one ACTIVE flock per shed enforced', !r.ok && /idx_flocks_shed_active/.test(r.err));

r = raw(`INSERT INTO flocks (shed_id, entry_date, initial_population)
         VALUES ('${shedId}', '2026-03-01', -5);`);
check('flocks.initial_population >= 0 enforced', !r.ok && /initial_population/.test(r.err));

// ═══════════════════════════════════════════════════════════════════════════
section(4, 'auth.users ↔ perfiles linkage');

const linked = owner(`
SELECT count(*) FROM perfiles p JOIN auth.users u ON u.id = p.id
 WHERE p.id IN ('${ADMIN_UID}','${OPER_UID}','${INACTIVE_UID}');`);
check('every test profile resolves to an auth.users row', linked === '3', linked);

const uidSeen = asAuthenticated(ADMIN_UID, `SELECT auth.uid();`);
check('auth.uid() inside an authenticated session returns the caller', uidSeen.out === ADMIN_UID, uidSeen.out || uidSeen.err);

// ═══════════════════════════════════════════════════════════════════════════
section(5, 'current_app_role() returns the correct role');

let res = asAuthenticated(ADMIN_UID, `SELECT current_app_role();`);
check("ADMIN profile -> 'ADMIN'", res.ok && res.out === 'ADMIN', res.out || res.err);

res = asAuthenticated(OPER_UID, `SELECT current_app_role();`);
check("OPERATOR profile -> 'OPERATOR'", res.ok && res.out === 'OPERATOR', res.out || res.err);

// ═══════════════════════════════════════════════════════════════════════════
section(6, 'Inactive or profile-less users get no business role');

res = asAuthenticated(INACTIVE_UID, `SELECT current_app_role();`);
check('activo=false -> USER_NOT_FOUND_OR_INACTIVE', !res.ok && /USER_NOT_FOUND_OR_INACTIVE/.test(res.err), res.err.slice(0, 120));

res = asAuthenticated(NOPROFILE_UID, `SELECT current_app_role();`);
check('no perfiles row -> USER_NOT_FOUND_OR_INACTIVE', !res.ok && /USER_NOT_FOUND_OR_INACTIVE/.test(res.err), res.err.slice(0, 120));

res = asRole('authenticated', { role: 'authenticated' }, `SELECT current_app_role();`);
check('no sub claim -> NOT_AUTHENTICATED', !res.ok && /NOT_AUTHENTICATED/.test(res.err), res.err.slice(0, 120));

res = asAuthenticated(INACTIVE_UID, `SELECT count(*) FROM clients;`);
check('inactive user reading clients is rejected, not silently allowed', !res.ok, res.out);

// ═══════════════════════════════════════════════════════════════════════════
section(7, 'ADMIN and OPERATOR are differentiated');

res = asAuthenticated(ADMIN_UID, `SELECT count(*) FROM clients;`);
check('ADMIN can read clients', res.ok && Number(res.out) >= 1, res.out || res.err);

res = asAuthenticated(OPER_UID, `SELECT count(*) FROM clients;`);
check('OPERATOR reading clients returns 0 rows (no policy)', res.ok && res.out === '0', res.out || res.err);

res = asAuthenticated(OPER_UID, `SELECT count(*) FROM financial_account;`);
check('OPERATOR reading financial_account returns 0 rows', res.ok && res.out === '0', res.out || res.err);

res = asAuthenticated(ADMIN_UID, `SELECT count(*) FROM financial_account;`);
check('ADMIN reading financial_account sees the 4 seeded accounts', res.ok && res.out === '4', res.out || res.err);

res = asAuthenticated(OPER_UID, `SELECT count(*) FROM classification_grade;`);
check('OPERATOR can read classification_grade (7 seeded, active)', res.ok && res.out === '7', res.out || res.err);

// ═══════════════════════════════════════════════════════════════════════════
section(8, 'Foundation RLS row scoping');

owner(`INSERT INTO operator_assignments (operator_id, flock_id)
       SELECT '${OPER_UID}', id FROM flocks WHERE shed_id='${shedId}' AND estado='ACTIVE'
       ON CONFLICT DO NOTHING;`);

res = asAuthenticated(OPER_UID, `SELECT count(*) FROM flocks;`);
check('OPERATOR sees only assigned flocks (1)', res.ok && res.out === '1', res.out || res.err);

const otherShed = owner(`INSERT INTO sheds (nombre) VALUES ('shed-test-2') RETURNING id;`);
owner(`INSERT INTO flocks (shed_id, entry_date, initial_population)
       VALUES ('${otherShed}', '2026-02-01', 800);`);
res = asAuthenticated(OPER_UID, `SELECT count(*) FROM flocks;`);
check('an unassigned flock stays invisible to OPERATOR', res.ok && res.out === '1', res.out || res.err);

res = asAuthenticated(ADMIN_UID, `SELECT count(*) FROM flocks;`);
check('ADMIN sees both flocks', res.ok && res.out === '2', res.out || res.err);

res = asAuthenticated(OPER_UID, `SELECT count(*) FROM perfiles;`);
check('OPERATOR sees only its own perfiles row', res.ok && res.out === '1', res.out || res.err);

res = asAuthenticated(ADMIN_UID, `SELECT count(*) FROM perfiles;`);
check('ADMIN sees all 3 profiles', res.ok && res.out === '3', res.out || res.err);

// ═══════════════════════════════════════════════════════════════════════════
section(9, 'Application roles cannot write where writes are forbidden');

for (const [table, stmt] of [
  ['audit_events', `INSERT INTO audit_events (entity_type, entity_id, action) VALUES ('x','y','z');`],
  ['management_period', `UPDATE management_period SET status='CLOSED' WHERE periodo_fecha='2026-01-01';`],
  ['flocks', `INSERT INTO flocks (shed_id, entry_date, initial_population) VALUES ('${shedId}','2026-04-01',1);`],
  ['perfiles self-escalation', `UPDATE perfiles SET rol_type='ADMIN' WHERE id='${OPER_UID}';`],
]) {
  res = asAuthenticated(OPER_UID, stmt);
  check(`OPERATOR cannot write ${table}`, !res.ok && /permission denied|denegado/i.test(res.err), res.err.split('\n')[0]?.slice(0, 90));
}

res = asAuthenticated(ADMIN_UID, `UPDATE perfiles SET rol_type='ADMIN' WHERE id='${OPER_UID}';`);
check('even ADMIN cannot UPDATE perfiles directly (no privilege granted)', !res.ok && /permission denied|denegado/i.test(res.err), res.err.split('\n')[0]?.slice(0, 90));

res = asAuthenticated(ADMIN_UID, `INSERT INTO sheds (nombre) VALUES ('shed-admin-write');`);
check('ADMIN CAN write a master table (sheds) — the perimeter is not blanket-deny', res.ok, res.err.split('\n')[0]);

res = asAuthenticated(OPER_UID, `INSERT INTO sheds (nombre) VALUES ('shed-operator-write');`);
check('OPERATOR cannot write sheds (privilege granted, but no RLS policy)', !res.ok, res.err.split('\n')[0]?.slice(0, 90));

// ═══════════════════════════════════════════════════════════════════════════
section(10, 'service_role stays separate from the business role');

// Any failure mode proves the separation: service_role either has no profile
// (USER_NOT_FOUND_OR_INACTIVE) or is refused EXECUTE outright. The second is the
// stronger separation, and is what this perimeter produces, since EXECUTE on
// current_app_role() is granted only to `authenticated`.
res = asServiceRole(`SELECT current_app_role();`);
check(
  'service_role has NO business role',
  !res.ok && /USER_NOT_FOUND_OR_INACTIVE|NOT_AUTHENTICATED|permission denied for function current_app_role/.test(res.err),
  res.err.slice(0, 100)
);

res = asServiceRole(`SELECT auth.role();`);
check("auth.role() = 'service_role'", res.ok && res.out === 'service_role', res.out || res.err);

res = asServiceRole(`SELECT count(*) FROM financial_account;`);
check('service_role reads financial_account via its own policy', res.ok && res.out === '4', res.out || res.err);

// Frozen section 9 gives service_role no access to commercial data. It holds no
// SELECT privilege on clients at all, so it is refused before RLS is consulted —
// a stronger outcome than returning zero rows.
res = asServiceRole(`SELECT count(*) FROM clients;`);
check(
  'service_role has no access to clients',
  (res.ok && res.out === '0') || (!res.ok && /permission denied for table clients/.test(res.err)),
  res.ok ? res.out : res.err.split('\n')[0]?.slice(0, 80)
);

const badPolicies = owner(`
SELECT coalesce(string_agg(policyname, ','), '') FROM pg_policies
 WHERE schemaname='public'
   AND (qual LIKE '%SERVICE_ROLE%' OR with_check LIKE '%SERVICE_ROLE%');`);
check("no policy tests current_app_role() = 'SERVICE_ROLE'", badPolicies === '', badPolicies);

const jwtPolicies = owner(`
SELECT coalesce(string_agg(policyname, ','), '') FROM pg_policies
 WHERE schemaname='public' AND (qual LIKE '%jwt()%' OR with_check LIKE '%jwt()%');`);
check('no policy authorizes via a JWT business-role claim', jwtPolicies === '', jwtPolicies);

// ═══════════════════════════════════════════════════════════════════════════
section(11, 'SECURITY DEFINER hardening');

const unpinned = owner(`
SELECT coalesce(string_agg(proname, ','), '') FROM pg_proc
 WHERE prosecdef = true AND pronamespace='public'::regnamespace
   AND NOT (coalesce(proconfig,'{}') @> ARRAY['search_path=public']);`);
check('every SECURITY DEFINER function pins search_path=public', unpinned === '', unpinned);

const definers = owner(`
SELECT coalesce(string_agg(proname, ',' ORDER BY proname), '') FROM pg_proc
 WHERE prosecdef = true AND pronamespace='public'::regnamespace;`);
// Foundation's two functions plus the RPCs of built later phases (Phase 14: RPCs 1–4; Phase 15: RPC 39; Phase 16: RPCs 5–12 + 42; Phase 17: RPCs 13–17).
const LATER_PHASE_DEFINERS = [
  'cancel_order', 'deliver_order', 'rectify_delivered_order', 'register_collection',   // Phase 14
  'transfer_between_accounts',                                                           // Phase 15
  'clear_cheque', 'deposit_cheque', 'endorse_cheque', 'issue_supplier_instrument',       // Phase 16
  'mark_supplier_instrument_debited', 'receive_cheque', 'reject_cheque', 'reject_supplier_instrument',
  'cancel_supplier_instrument',                                                          // Phase 16, RPC 42 (ADR-001)
  'assign_freight_to_purchase', 'pay_supplier', 'rectify_purchase', 'register_freight', 'register_purchase', // Phase 17
  'register_daily_production', 'rectify_daily_production', 'register_mortality', 'rectify_mortality',
  'register_count_adjustment',                                                                            // Phase 18
  'register_classification',                                                                              // Phase 19
  'register_feed_manufacturing', 'register_feed_inventory_count', 'register_feed_movement', 'assign_flock_feed', // Phase 20
  'open_sales_session', 'register_session_movement', 'register_session_cash_event', 'close_sales_session', // Phase 21
  'register_fiscal_document', 'register_fiscal_obligation', 'pay_fiscal_obligation',                     // Phase 22
  'mp_normalize_source', 'mp_reconcile_movement',                                                        // Phase 23
  'register_management_event',                                                                           // Phase 24 (ADR-004)
  'register_flock', 'close_flock',                                                                       // ADR-007 RPCs 44 / 45 (0057)
  'register_bank_tax',                                                                                   // ADR-011 RPC 46 (0062)
  'rectify_classification', 'publish_feed_formula_version',                                              // ADR-012 RPC 47 (0063) / ADR-013 RPC 48 (0064)
  'rectify_feed_manufacturing',                                                                          // ADR-014 RPC 49 (0065)
  'register_purchase_with_fiscal_document',                                                              // ADR-015 RPC 50 (0068)
  'mp_allocate_to_client', 'mp_apply_transition', 'mp_auto_allocate', 'mp_check_report_coverage', 'mp_claim_deliveries', 'mp_clear_attribution_flag', 'mp_delivery_transition', 'mp_flag_for_attribution', 'mp_ingest_api_snapshot', 'mp_map_payer_to_client', 'mp_normalize_report_fallback', 'mp_record_balance_check', 'mp_register_delivery', 'mp_request_refetch', 'mp_requeue_config_blocked', 'mp_resolve_chargeback_signal', 'mp_resolve_match', 'mp_reverse_client_allocation', 'mp_unmap_payer', // ADR-006 Step 2 (0048)
];
const expectedDefiners = ['assert_period_open', 'current_app_role', ...LATER_PHASE_DEFINERS].sort().join(',');
check('SECURITY DEFINER inventory is exactly Foundation (2) + built later-phase RPCs',
  definers === expectedDefiners, definers);

const publicExec = owner(`
SELECT coalesce(string_agg(p.proname, ','), '') FROM pg_proc p
 WHERE p.prosecdef = true AND p.pronamespace='public'::regnamespace
   AND has_function_privilege('public', p.oid, 'EXECUTE');`);
check('no SECURITY DEFINER function is executable by PUBLIC', publicExec === '', publicExec);

// ═══════════════════════════════════════════════════════════════════════════
section(12, 'audit_events invariants');

const auditCols = owner(`
SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.columns
 WHERE table_schema='public' AND table_name='audit_events';`);
const wantCols = ['action','after_values','before_values','entity_id','entity_type','id','performed_at','performed_by','reason'];
check('audit_events has exactly the frozen columns', auditCols === wantCols.join(','), auditCols);

const auditGrants = owner(`
SELECT coalesce(string_agg(DISTINCT privilege_type, ','), '') FROM information_schema.role_table_grants
 WHERE table_schema='public' AND table_name='audit_events'
   AND grantee IN ('anon','authenticated') AND privilege_type IN ('INSERT','UPDATE','DELETE');`);
check('no application role holds INSERT/UPDATE/DELETE on audit_events', auditGrants === '', auditGrants);

owner(`INSERT INTO audit_events (entity_type, entity_id, action, performed_by, reason)
       VALUES ('perfiles', '${OPER_UID}', 'TEST', '${ADMIN_UID}', 'foundations test');`);
res = asAuthenticated(OPER_UID, `SELECT count(*) FROM audit_events;`);
check('OPERATOR cannot read an audit row of entity_type perfiles', res.ok && res.out === '0', res.out || res.err);

res = asAuthenticated(ADMIN_UID, `SELECT count(*) FROM audit_events;`);
check('ADMIN can read audit_events', res.ok && Number(res.out) >= 1, res.out || res.err);

res = asAuthenticated(ADMIN_UID, `DELETE FROM audit_events;`);
check('audit_events cannot be deleted by an application role', !res.ok && /permission denied|denegado/i.test(res.err));

// ═══════════════════════════════════════════════════════════════════════════
section(13, 'management_period OPEN path');

const openPeriods = owner(`SELECT count(*) FROM management_period WHERE status='OPEN';`);
check('12 OPEN periods seeded for 2026', openPeriods === '12', openPeriods);

r = raw(`SELECT assert_period_open('2026-05-17');`);
check('assert_period_open succeeds for a date in an OPEN period', r.ok, r.err.split('\n')[0]);

r = raw(`SELECT assert_period_open('2030-01-15');`);
check('assert_period_open raises PERIOD_NOT_FOUND for an unseeded month', !r.ok && /PERIOD_NOT_FOUND/.test(r.err));

// ── the protected write fixture (test harness only, dropped at the end) ────
owner(`
CREATE SCHEMA IF NOT EXISTS test_harness;

CREATE TABLE IF NOT EXISTS test_harness.guarded_fact (
  id            BIGSERIAL PRIMARY KEY,
  business_date DATE NOT NULL,
  note          TEXT NOT NULL,
  created_by    UUID
);

-- Mirrors the frozen RPC pattern: authorize, guard the period, then write.
CREATE OR REPLACE FUNCTION test_harness.record_guarded_fact(p_business_date DATE, p_note TEXT)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_id BIGINT;
BEGIN
  IF current_app_role() NOT IN ('ADMIN','OPERATOR') THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;

  PERFORM public.assert_period_open(p_business_date);

  INSERT INTO test_harness.guarded_fact (business_date, note, created_by)
  VALUES (p_business_date, p_note, auth.uid())
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$fn$;

REVOKE ALL ON FUNCTION test_harness.record_guarded_fact(DATE, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION test_harness.record_guarded_fact(DATE, TEXT) TO authenticated;
GRANT  USAGE ON SCHEMA test_harness TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON test_harness.guarded_fact FROM anon, authenticated;
`);

res = asAuthenticated(ADMIN_UID, `SELECT test_harness.record_guarded_fact('2026-05-17', 'open-period write');`);
check('protected write SUCCEEDS while the period is OPEN', res.ok && Number(res.out) >= 1, res.out || res.err.split('\n')[0]);

const rowsAfterOpen = owner(`SELECT count(*) FROM test_harness.guarded_fact WHERE business_date='2026-05-17';`);
check('the row really landed (count = 1)', rowsAfterOpen === '1', rowsAfterOpen);

// ═══════════════════════════════════════════════════════════════════════════
section(14, 'management_period CLOSED blocks a real protected write');

owner(`UPDATE management_period SET status='CLOSED', closed_at=NOW() WHERE periodo_fecha='2026-05-01';`);
const statusNow = owner(`SELECT status FROM management_period WHERE periodo_fecha='2026-05-01';`);
check('2026-05 is now CLOSED', statusNow === 'CLOSED', statusNow);

res = asAuthenticated(ADMIN_UID, `SELECT test_harness.record_guarded_fact('2026-05-17', 'closed-period write');`);
check('protected write is REJECTED while the period is CLOSED', !res.ok, res.out);
check('the rejection comes from the period guard (PERIOD_CLOSED)', /PERIOD_CLOSED/.test(res.err), res.err.split('\n')[0]?.slice(0, 120));

const rowsAfterClosed = owner(`SELECT count(*) FROM test_harness.guarded_fact WHERE business_date='2026-05-17';`);
check('no extra row was written (still 1)', rowsAfterClosed === '1', rowsAfterClosed);

// a different, still-OPEN month must keep working -> proves it is the period, not the function
res = asAuthenticated(ADMIN_UID, `SELECT test_harness.record_guarded_fact('2026-06-17', 'other month still open');`);
check('a write into a still-OPEN month keeps working', res.ok, res.err.split('\n')[0]);

// no bypass: a direct write by an application role must be impossible
res = asAuthenticated(ADMIN_UID,
  `INSERT INTO test_harness.guarded_fact (business_date, note) VALUES ('2026-05-17','bypass attempt');`);
check('no bypass: direct INSERT by an application role is refused', !res.ok && /permission denied|denegado/i.test(res.err), res.err.split('\n')[0]?.slice(0, 90));

const finalRows = owner(`SELECT count(*) FROM test_harness.guarded_fact WHERE business_date='2026-05-17';`);
check('still exactly 1 row for the closed month after the bypass attempt', finalRows === '1', finalRows);

// restore the period so the suite is re-runnable
owner(`UPDATE management_period SET status='OPEN', closed_at=NULL WHERE periodo_fecha='2026-05-01';`);

// ═══════════════════════════════════════════════════════════════════════════
section(15, 'Foundation ACL perimeter (0013) — real catalog ACLs');

// Inspects pg_class.relacl through aclexplode(), not behaviour alone: a privilege
// that no test happens to exercise (TRUNCATE, TRIGGER, ...) still shows up here.
const MASTER_WRITE = [
  'classification_grade', 'clients', 'expense_category', 'feed_ingredient', 'feed_type',
  'financial_account', 'genetics_consumption_curve', 'operator_assignments', 'price_history',
  'products', 'projects', 'sheds', 'suppliers',
];
const tblList = expectedTables.map((t) => `'${t}'`).join(',');
const aclOf = (grantee) => owner(`
SELECT coalesce(string_agg(relname || ':' || privs, ',' ORDER BY relname), '') FROM (
  SELECT c.relname, string_agg(a.privilege_type, '+' ORDER BY a.privilege_type) AS privs
    FROM pg_class c, aclexplode(c.relacl) a
   WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN (${tblList})
     AND a.grantee = ${grantee === 'PUBLIC' ? '0' : `'${grantee}'::regrole`}
   GROUP BY c.relname) s;`);

const wantAuth = [...expectedTables].sort()
  .map((t) => `${t}:${MASTER_WRITE.includes(t) ? 'INSERT+SELECT+UPDATE' : 'SELECT'}`).join(',');
const authAcl = aclOf('authenticated');
check('A. authenticated ACL on Foundation = SELECT everywhere + INSERT/UPDATE on the 13 frozen masters, nothing else',
  authAcl === wantAuth, authAcl);
const authExtra = owner(`
SELECT count(*) FROM pg_class c, aclexplode(c.relacl) a
 WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN (${tblList})
   AND a.grantee = 'authenticated'::regrole
   AND a.privilege_type IN ('TRUNCATE','REFERENCES','TRIGGER','MAINTAIN','DELETE');`);
check('A. authenticated holds no TRUNCATE / REFERENCES / TRIGGER / MAINTAIN / DELETE on any Foundation table',
  authExtra === '0', authExtra);

check('B. anon holds no privilege on any Foundation table', aclOf('anon') === '', aclOf('anon'));
check('B. PUBLIC holds no privilege on any Foundation table', aclOf('PUBLIC') === '', aclOf('PUBLIC'));
res = asRole('anon', { role: 'anon' }, `SELECT count(*) FROM clients;`);
check('B. anon SELECT on clients is refused at the privilege layer', !res.ok && /permission denied/i.test(res.err), res.err.split('\n')[0]);

const srAcl = aclOf('service_role');
check('C. service_role ACL on Foundation is exactly SELECT on financial_account', srAcl === 'financial_account:SELECT', srAcl);
res = asServiceRole(`SELECT count(*) FROM financial_account;`);
check('C. service_role keeps SELECT on financial_account (4 seeded accounts)', res.ok && res.out === '4', res.out || res.err);
res = asServiceRole(`SELECT count(*) FROM clients;`);
check('C. service_role has no SELECT on clients', !res.ok && /permission denied/i.test(res.err), res.err.split('\n')[0]);
const srWrites = [
  asServiceRole(`TRUNCATE audit_events;`),
  asServiceRole(`INSERT INTO management_period (periodo_fecha) VALUES ('2030-01-01');`),
  asServiceRole(`UPDATE financial_account SET activo = false;`),
  asServiceRole(`DELETE FROM clients;`),
];
check('C. service_role: TRUNCATE / INSERT / UPDATE / DELETE on Foundation all refused',
  srWrites.every((x) => !x.ok && /permission denied/i.test(x.err)), srWrites.map((x) => x.err.split('\n')[0]).join(' | '));

const seqAcl = owner(`
SELECT coalesce(string_agg(c.relname || ':' || a.grantee::regrole || ':' || a.privilege_type, ','), '')
  FROM pg_class c, aclexplode(c.relacl) a
 WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'S'
   AND a.grantee IN (0, 'anon'::regrole, 'authenticated'::regrole, 'service_role'::regrole);`);
check('D. no sequence in public grants anything to PUBLIC / anon / authenticated / service_role', seqAcl === '', seqAcl);

res = raw(`
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub":"${ADMIN_UID}","role":"authenticated"}';
INSERT INTO clients (nombre) VALUES ('acl-probe-client');
UPDATE clients SET contacto = 'x' WHERE nombre = 'acl-probe-client';
SELECT count(*) FROM clients WHERE nombre = 'acl-probe-client' AND contacto = 'x';
ROLLBACK;`);
check('E. narrow grant still works: ADMIN INSERT + UPDATE on clients (rolled back)', res.ok && res.out === '1', res.out || res.err);
res = asAuthenticated(OPER_UID, `INSERT INTO clients (nombre) VALUES ('acl-probe-operator');`);
check('E. OPERATOR still refused on clients by RLS (grant exists, no policy)', !res.ok && /row-level security/i.test(res.err), res.err.split('\n')[0]);
const adminDenied = [
  asAuthenticated(ADMIN_UID, `TRUNCATE clients;`),
  asAuthenticated(ADMIN_UID, `DELETE FROM products;`),
  asAuthenticated(ADMIN_UID, `UPDATE management_period SET status = 'CLOSED';`),
];
check('E. even ADMIN: TRUNCATE / DELETE on masters and UPDATE on management_period refused',
  adminDenied.every((x) => !x.ok && /permission denied/i.test(x.err)), adminDenied.map((x) => x.err.split('\n')[0]).join(' | '));

const defAcl = owner(`
SELECT coalesce(string_agg(d.defaclobjtype::TEXT || ':' || a.grantee::regrole || ':' || a.privilege_type, ','), '')
  FROM pg_default_acl d, aclexplode(d.defaclacl) a
 WHERE d.defaclrole = 'postgres'::regrole AND d.defaclnamespace = 'public'::regnamespace
   AND d.defaclobjtype IN ('r','S')
   AND a.grantee IN ('anon'::regrole, 'authenticated'::regrole, 'service_role'::regrole);`);
check('F. DEFAULT PRIVILEGES of postgres in public grant no table/sequence privilege to application roles', defAcl === '', defAcl);
// relacl stays NULL when the resulting ACL equals the built-in owner-only
// default, so the effective ACL is evaluated through acldefault().
const probe = owner(`
BEGIN;
CREATE TABLE public._acl_probe (id BIGSERIAL PRIMARY KEY);
SELECT coalesce(string_agg(DISTINCT c.relname || ':' || a.grantee::regrole, ','), '')
  FROM pg_class c,
       aclexplode(coalesce(c.relacl, acldefault(CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END::"char", c.relowner))) a
 WHERE c.relname IN ('_acl_probe', '_acl_probe_id_seq');
ROLLBACK;`);
check('F. a table + sequence created now by postgres are born owner-only (probe, rolled back)',
  probe === '_acl_probe:postgres,_acl_probe_id_seq:postgres', probe);

// ═══════════════════════════════════════════════════════════════════════════
section(16, 'Cleanup of test-only artefacts');

owner(`DROP SCHEMA test_harness CASCADE;`);
const harnessGone = owner(`SELECT count(*) FROM information_schema.schemata WHERE schema_name='test_harness';`);
check('test_harness schema removed — it is not part of the target schema', harnessGone === '0', harnessGone);

const publicTables = owner(
  `SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE';`
);
const expectedCount = String(17 + LATER_PHASE_TABLES.length);
check(`public holds exactly the 17 Foundation tables + ${LATER_PHASE_TABLES.length} later-phase tables (no test artefact)`,
  publicTables === expectedCount, publicTables);

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n  ══ RESULT: ${pass} passed, ${fail} failed ══\n`);
if (fail > 0) {
  console.log('  Failures:');
  for (const f of failures) console.log(`    - ${f.label}${f.detail ? ` :: ${f.detail}` : ''}`);
  console.log('');
}
process.exit(fail === 0 ? 0 : 1);
