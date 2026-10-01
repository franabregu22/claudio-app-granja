#!/usr/bin/env node
/**
 * PHASE 18 — PRODUCTION (SLICE 3) TEST SUITE. LOCAL TEST DATABASE ONLY.
 *
 * Behavioural tests of RPCs 18–22 (register/rectify daily production,
 * register/rectify mortality, register count adjustment) over daily_production
 * and population_events, reusing sheds / flocks / operator_assignments.
 *
 * Role-scoped calls simulate real Supabase sessions; OPERATOR authority is
 * exercised with two real operator profiles (A, B) and real assignments.
 * Failure injection uses test-only triggers in schema p18_harness (dropped at
 * the end). The concurrency group runs independent PostgreSQL sessions.
 *
 * Flocks are created by the table owner (the frozen design gives flock
 * creation no application RPC: "created through a privileged path").
 * Fixtures are prefixed "P18-TEST" and removed at start and end; periods
 * closed by the suite are reopened.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *     node scripts/target-db/production.test.mjs
 */

import { spawn, spawnSync } from 'node:child_process';
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
const ADR005_VIEWS = ['report_balance_period', 'report_classification_day', 'report_feed_consumption_interval', 'report_feria_session_cash',
  'report_flock_day', 'report_mp_movement_status', 'report_sales_line'].map((v) => `'${v}'`).join(',');   // ADR-005 derived views (Phase 25): no stored value, proven by reporting.test.mjs

const ADMIN_UID = '11111111-1111-1111-1111-111111111111';
const OPA = '22222222-2222-2222-2222-222222222222';          // operator A (existing test operator)
const OPB = '55555555-5555-5555-5555-555555555555';          // operator B (Phase 18 fixture)
const INACTIVE_UID = '33333333-3333-3333-3333-333333333333';
const NOPROFILE_UID = '44444444-4444-4444-4444-444444444444';
const MISSING_UUID = '99999999-9999-9999-9999-999999999999';
const TAG = 'P18-TEST';
const RPCS = ['rectify_daily_production', 'rectify_mortality', 'register_count_adjustment', 'register_daily_production', 'register_mortality'];
const TABLES = ['daily_production', 'population_events'];
const ALL_DEFINERS = 'assert_period_open,assign_flock_feed,assign_freight_to_purchase,cancel_order,cancel_supplier_instrument,clear_cheque,close_flock,close_sales_session,current_app_role,deliver_order,'
  + 'deposit_cheque,endorse_cheque,issue_supplier_instrument,mark_supplier_instrument_debited,mp_allocate_to_client,mp_apply_transition,mp_auto_allocate,mp_check_report_coverage,mp_claim_deliveries,mp_clear_attribution_flag,mp_delivery_transition,mp_flag_for_attribution,mp_ingest_api_snapshot,mp_map_payer_to_client,mp_normalize_report_fallback,mp_normalize_source,mp_reconcile_movement,mp_record_balance_check,mp_register_delivery,mp_request_refetch,mp_requeue_config_blocked,mp_resolve_chargeback_signal,mp_resolve_match,mp_reverse_client_allocation,mp_unmap_payer,open_sales_session,pay_fiscal_obligation,pay_supplier,publish_feed_formula_version,receive_cheque,'
  + 'rectify_classification,rectify_daily_production,rectify_delivered_order,rectify_feed_manufacturing,rectify_mortality,rectify_purchase,register_bank_tax,register_classification,register_collection,'
  + 'register_count_adjustment,register_daily_production,register_feed_inventory_count,register_feed_manufacturing,register_feed_movement,register_fiscal_document,register_fiscal_obligation,register_flock,register_freight,register_management_event,register_mortality,register_purchase,register_purchase_with_fiscal_document,register_session_cash_event,register_session_movement,reject_cheque,'
  + 'reject_supplier_instrument,transfer_between_accounts';

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
const sessionSql = (pgRole, claims, sqlText) => `
BEGIN;
SET LOCAL ROLE ${pgRole};
SET LOCAL "request.jwt.claims" = '${JSON.stringify(claims).replace(/'/g, "''")}';
${sqlText}
COMMIT;`;
const asRole = (pgRole, claims, sqlText) => raw(sessionSql(pgRole, claims, sqlText));
const claimsOf = (uid) => ({ sub: uid, role: 'authenticated' });
const asUser = (uid, sqlText) => asRole('authenticated', claimsOf(uid), sqlText);
const ADMIN = (sqlText) => asUser(ADMIN_UID, sqlText);
const A = (sqlText) => asUser(OPA, sqlText);
const B = (sqlText) => asUser(OPB, sqlText);
const asAnon = (sqlText) => asRole('anon', { role: 'anon' }, sqlText);
const asServiceRole = (sqlText) => asRole('service_role', { role: 'service_role' }, sqlText);

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
async function race(uid, callA, callB, appPrefix) {
  const pA = session(sessionSql('authenticated', claimsOf(uid), `SELECT ${callA};\nSELECT pg_sleep(2);`), `${appPrefix}-A`);
  const aIn = await waitFor(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = '${appPrefix}-A'
    AND state = 'active' AND query LIKE '%pg_sleep%');`);
  const pB = session(sessionSql('authenticated', claimsOf(uid), `SELECT ${callB};`), `${appPrefix}-B`);
  const bWait = await waitFor(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = '${appPrefix}-B' AND wait_event_type = 'Lock');`);
  const [ra, rb] = await Promise.all([pA, pB]);
  return { aIn, bWait, ra, rb };
}

function okAs(fn, sqlText) {
  const r = fn(sqlText);
  if (!r.ok) throw new Error(`SQL failed:\n${sqlText}\n${r.err}`);
  return r.out;
}
const rpcAs = (fn, call) => JSON.parse(okAs(fn, `SELECT ${call};`));
const rpc = (call) => rpcAs(ADMIN, call);
const firstErr = (r) => (r.err.split('\n').find((l) => /ERROR/.test(l)) || r.err.split('\n')[0] || '').slice(0, 160);
const denied = (r) => !r.ok && /permission denied/i.test(r.err);
const raised = (r, code) => !r.ok && new RegExp(`ERROR:\\s+${code}`).test(r.err);
const violates = (r, name) => !r.ok && r.err.includes(name);

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

const CURRENT_MONTH = owner(`SELECT date_trunc('month', (NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires'))::DATE;`);
const CLOSED_BY_SUITE = ['2026-03-01', CURRENT_MONTH];

// ── fixture lifecycle ──────────────────────────────────────────────────────
const TF = `(SELECT f.id FROM flocks f JOIN sheds s ON s.id = f.shed_id WHERE s.nombre LIKE '${TAG}%')`;
function cleanup() {
  owner(`
DROP SCHEMA IF EXISTS p18_harness CASCADE;
DELETE FROM audit_events WHERE entity_type = 'daily_production'
   AND entity_id IN (SELECT id::TEXT FROM daily_production WHERE flock_id IN ${TF});
DELETE FROM audit_events WHERE entity_type = 'population_events'
   AND entity_id IN (SELECT id::TEXT FROM population_events WHERE flock_id IN ${TF});
UPDATE daily_production SET superseded_by = NULL WHERE flock_id IN ${TF};
DELETE FROM daily_production WHERE flock_id IN ${TF};
UPDATE population_events SET superseded_by = NULL WHERE flock_id IN ${TF};
DELETE FROM population_events WHERE flock_id IN ${TF};
DELETE FROM operator_assignments WHERE flock_id IN ${TF};
DELETE FROM flocks WHERE id IN ${TF};
DELETE FROM sheds WHERE nombre LIKE '${TAG}%';
-- operator B is a Phase 18 fixture: removed so other suites keep their exact profile counts
DELETE FROM audit_events WHERE performed_by = '${OPB}';
DELETE FROM operator_assignments WHERE operator_id = '${OPB}';
DELETE FROM perfiles WHERE id = '${OPB}';
DELETE FROM auth.users WHERE id = '${OPB}';
UPDATE management_period SET status = 'OPEN', closed_at = NULL
 WHERE periodo_fecha IN (${CLOSED_BY_SUITE.map((m) => `'${m}'`).join(',')});`);
}

cleanup();   // first: remove leftovers of an earlier run (including the operator B fixture)
owner(`
INSERT INTO auth.users (id, is_sso_user, is_anonymous) VALUES
  ('${ADMIN_UID}', false, false), ('${OPA}', false, false), ('${OPB}', false, false),
  ('${INACTIVE_UID}', false, false), ('${NOPROFILE_UID}', false, false)
ON CONFLICT (id) DO NOTHING;
INSERT INTO perfiles (id, email, rol_type, activo) VALUES
  ('${ADMIN_UID}', 'admin@test.local', 'ADMIN', true),
  ('${OPA}', 'operator@test.local', 'OPERATOR', true),
  ('${OPB}', 'operator-b@test.local', 'OPERATOR', true),
  ('${INACTIVE_UID}', 'inactive@test.local', 'OPERATOR', false)
ON CONFLICT (id) DO NOTHING;`);

// ── fixture helpers ────────────────────────────────────────────────────────
let seq = 0;
/** One flock in its own shed (one ACTIVE flock per shed), created by the owner. */
function mkFlock(name, initial = 1000, estado = 'ACTIVE') {
  const shed = owner(`INSERT INTO sheds (nombre) VALUES ('${TAG} ${name} #${++seq}') RETURNING id;`);
  return owner(`INSERT INTO flocks (shed_id, entry_date, initial_population, estado) VALUES ('${shed}', '2026-01-05', ${initial}, '${estado}') RETURNING id;`);
}
const assign = (op, flock) => okAs(ADMIN, `INSERT INTO operator_assignments (operator_id, flock_id, assigned_by) VALUES ('${op}', '${flock}', '${ADMIN_UID}');`);
const setAssignment = (op, flock, activo) => okAs(ADMIN, `UPDATE operator_assignments SET activo = ${activo} WHERE operator_id = '${op}' AND flock_id = '${flock}';`);

const q = (v) => (v === null || v === undefined ? 'NULL' : `'${v}'`);
const n = (v) => (v === null || v === undefined ? 'NULL' : String(v));
const prodCall = (f, d, total, broken = 0, dirty = 0, reason = null) => `register_daily_production(${q(f)}, ${q(d)}, ${n(total)}, ${n(broken)}, ${n(dirty)}, ${q(reason)})`;
const rectProdCall = (id, total, broken = 0, dirty = 0, reason = 'corrección') => `rectify_daily_production(${q(id)}, ${n(total)}, ${n(broken)}, ${n(dirty)}, ${q(reason)})`;
const mortCall = (f, d, deaths, reason = null) => `register_mortality(${q(f)}, ${q(d)}, ${n(deaths)}, ${q(reason)})`;
const rectMortCall = (id, deaths, reason = 'recuento') => `rectify_mortality(${n(id)}, ${n(deaths)}, ${q(reason)})`;
const adjCall = (f, d, delta, reason = 'recuento físico') => `register_count_adjustment(${q(f)}, ${q(d)}, ${n(delta)}, ${q(reason)})`;

const population = (f) => owner(`SELECT f.initial_population + COALESCE((SELECT SUM(delta) FROM population_events e WHERE e.flock_id = f.id AND e.is_current), 0)
  FROM flocks f WHERE f.id = '${f}';`);
const prodRow = (id) => owner(`SELECT flock_id || '|' || production_date || '|' || eggs_total || '|' || eggs_broken || '|' || eggs_dirty || '|' || is_current
  || '|' || coalesce(superseded_by::TEXT, '-') || '|' || version_seq || '|' || created_by FROM daily_production WHERE id = '${id}';`);
const evRow = (id) => owner(`SELECT flock_id || '|' || event_type || '|' || delta || '|' || event_date || '|' || is_current
  || '|' || coalesce(superseded_by::TEXT, '-') || '|' || version_seq || '|' || created_by FROM population_events WHERE id = ${id};`);
const econ = () => owner(`SELECT (SELECT count(*) FROM financial_operation) || '|' || (SELECT count(*) FROM financial_posting) || '|'
  || (SELECT count(*) FROM client_ledger) || '|' || (SELECT count(*) FROM supplier_ledger);`);
const snapshot = () => owner(`
SELECT concat_ws('|',
  (SELECT count(*) FROM daily_production), (SELECT count(*) FROM daily_production WHERE is_current),
  (SELECT string_agg(id::TEXT || is_current || coalesce(superseded_by::TEXT, '-'), ',' ORDER BY id) FROM daily_production),
  (SELECT count(*) FROM population_events), (SELECT count(*) FROM population_events WHERE is_current),
  (SELECT string_agg(id::TEXT || is_current || coalesce(superseded_by::TEXT, '-'), ',' ORDER BY id) FROM population_events),
  (SELECT count(*) FROM audit_events));`);
const closePeriod = (m) => owner(`UPDATE management_period SET status = 'CLOSED', closed_at = NOW() WHERE periodo_fecha = '${m}';`);
const openPeriod = (m) => owner(`UPDATE management_period SET status = 'OPEN', closed_at = NULL WHERE periodo_fecha = '${m}';`);

let r;
let snap;
let x;

try {
// ═══════════════════════════════════════════════════════════════════════════
section('A', 'Structure');

const colsOf = (t) => owner(`SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_name = '${t}';`);
check('A1 population_events columns exactly as frozen',
  colsOf('population_events') === 'id,flock_id,event_type,delta,event_date,is_current,superseded_by,version_seq,reason,created_at,created_by', colsOf('population_events'));
check('A2 daily_production columns exactly as frozen (no classification_session_id)',
  colsOf('daily_production') === 'id,flock_id,production_date,eggs_total,eggs_broken,eggs_dirty,is_current,superseded_by,version_seq,created_at,created_by', colsOf('daily_production'));
const checks = owner(`SELECT string_agg(conname, ',' ORDER BY conname) FROM pg_constraint WHERE contype = 'c' AND conrelid IN ('daily_production'::regclass, 'population_events'::regclass);`);
check('A3 CHECKs: eggs_total/broken/dirty >= 0, delta <> 0',
  checks === 'daily_production_eggs_broken_check,daily_production_eggs_dirty_check,daily_production_eggs_total_check,population_events_delta_check', checks);
const fks = owner(`SELECT string_agg(x, ',' ORDER BY x) FROM (
  SELECT c.conrelid::regclass || '.' || a.attname || '>' || c.confrelid::regclass || ':' || c.confdeltype::TEXT AS x
    FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
   WHERE c.contype = 'f' AND c.conrelid IN ('daily_production'::regclass, 'population_events'::regclass)) s;`);
check('A4 FKs incl. the 1:1 self-FKs superseded_by, all RESTRICT',
  fks === 'daily_production.created_by>perfiles:r,daily_production.flock_id>flocks:r,daily_production.superseded_by>daily_production:r,'
  + 'population_events.created_by>perfiles:r,population_events.flock_id>flocks:r,population_events.superseded_by>population_events:r', fks);
const idx = owner(`SELECT string_agg(indexname || '=' || regexp_replace(indexdef, '^.* USING ', ''), ' ; ' ORDER BY indexname) FROM pg_indexes
  WHERE tablename IN ('daily_production','population_events') AND indexname LIKE 'idx_%';`);
check('A5 partial unique indexes as frozen (production current per flock/date; MORTALITY current per flock/date) + lookup indexes',
  idx === "idx_daily_production_current=btree (flock_id, production_date) WHERE (is_current = true) ; "
  + 'idx_daily_production_flock_date=btree (flock_id, production_date) ; '
  + "idx_population_events_flock_date=btree (flock_id, event_date) ; "
  + "idx_population_events_mortality_current=btree (flock_id, event_date) WHERE ((event_type = 'MORTALITY'::population_event_type) AND (is_current = true))", idx);
check('A6 both unique indexes are UNIQUE', owner(`SELECT count(*) FROM pg_index WHERE indisunique
  AND indexrelid IN ('idx_daily_production_current'::regclass, 'idx_population_events_mortality_current'::regclass);`) === '2');
check('A7 RLS enabled on both tables', owner(`SELECT count(*) FROM pg_class WHERE relname IN ('daily_production','population_events') AND relrowsecurity;`) === '2');
const stored = owner(`SELECT coalesce(string_agg(table_name || '.' || column_name, ','), '') FROM information_schema.columns WHERE table_schema = 'public'
  AND column_name ~* '(population|birds_alive|alive|mortality_total|total_deaths)' AND column_name <> 'initial_population' AND table_name NOT IN (${ADR005_VIEWS});`);
check('A8 no stored current population / birds alive / mortality total anywhere', stored === '', stored);
check('A9 flocks reused unchanged (frozen columns)', colsOf('flocks') === 'id,shed_id,estado,genetics_line,birth_date,entry_date,initial_population,supplier_id,purchase_id,exit_date,created_at,created_by');
check('A10 operator_assignments reused unchanged', colsOf('operator_assignments') === 'id,operator_id,flock_id,activo,assigned_at,assigned_by');
check('A11 no conflict table / conflict flag / MORTALITY_CONFLICT type (frozen Part 26)',
  owner(`SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND column_name ~* 'conflict'
     AND NOT (table_name = 'mp_webhook_delivery' AND column_name = 'key_conflict_of')          -- ADR-006 HRN-1: authorized exception
     AND NOT (table_name = 'report_mp_delivery_health' AND column_name = 'key_conflicts');`) === '0'   // its derived count (ADR006_SCHEMA_DELTA_V1 §9)
  && owner(`SELECT string_agg(enumlabel, ',' ORDER BY enumsortorder) FROM pg_enum WHERE enumtypid = 'population_event_type'::regtype;`) === 'MORTALITY,COUNT_ADJUSTMENT');

// ── common fixtures ──
const FX = mkFlock('X', 1000);
const FY = mkFlock('Y', 1000);
assign(OPA, FX);
assign(OPB, FY);

// ═══════════════════════════════════════════════════════════════════════════
section('B', 'Register production — ADMIN');

let econ0 = econ();
const pB = rpc(prodCall(FX, '2026-04-01', 2400, 20, 30, 'lote X día 1'));
check('B1 returns {production_id, production_date, eggs_total}', !!pB.production_id && pB.production_date === '2026-04-01' && pB.eggs_total === 2400, JSON.stringify(pB));
check('B2 exact current row: flock, date, 2400/20/30, current, no superseded_by, version 0, created_by ADMIN',
  prodRow(pB.production_id) === `${FX}|2026-04-01|2400|20|30|true|-|0|${ADMIN_UID}`, prodRow(pB.production_id));
check('B3 audit CREATE with flock, date, eggs_total and reason',
  owner(`SELECT action || '|' || (after_values->>'eggs_total') || '|' || (after_values->>'flock_id') || '|' || reason || '|' || performed_by
         FROM audit_events WHERE entity_type = 'daily_production' AND entity_id = '${pB.production_id}';`) === `CREATE|2400|${FX}|lote X día 1|${ADMIN_UID}`);
check('B4 no economic effect: no operation, posting, client or supplier ledger row', econ() === econ0);

// ═══════════════════════════════════════════════════════════════════════════
section('C', 'Register production — OPERATOR');

const pC = rpcAs(A, prodCall(FX, '2026-04-02', 2380));
check('C1 OPERATOR on an assigned active flock succeeds; created_by = operator', prodRow(pC.production_id).endsWith(`|true|-|0|${OPA}`));
snap = snapshot();
r = A(`SELECT ${prodCall(FY, '2026-04-02', 100)};`);
check('C2 OPERATOR on an unassigned flock → FLOCK_NOT_ASSIGNED, nothing written', raised(r, 'FLOCK_NOT_ASSIGNED') && snapshot() === snap, firstErr(r));
r = asUser(INACTIVE_UID, `SELECT ${prodCall(FX, '2026-04-03', 1)};`);
const rNp = asUser(NOPROFILE_UID, `SELECT ${prodCall(FX, '2026-04-03', 1)};`);
check('C3 inactive / missing profile → USER_NOT_FOUND_OR_INACTIVE', raised(r, 'USER_NOT_FOUND_OR_INACTIVE') && raised(rNp, 'USER_NOT_FOUND_OR_INACTIVE'));

// ═══════════════════════════════════════════════════════════════════════════
section('D', 'Flock state');

const FR = mkFlock('Retirado', 500, 'RETIRED');
r = ADMIN(`SELECT ${prodCall(FR, '2026-04-02', 10)};`);
check('D1 production on a non-ACTIVE (RETIRED) flock → FLOCK_NOT_ACTIVE', raised(r, 'FLOCK_NOT_ACTIVE'), firstErr(r));
r = ADMIN(`SELECT ${prodCall(MISSING_UUID, '2026-04-02', 10)};`);
check('D2 production on a missing flock → FLOCK_NOT_ACTIVE', raised(r, 'FLOCK_NOT_ACTIVE'), firstErr(r));

// ═══════════════════════════════════════════════════════════════════════════
section('E', 'Production validation');

snap = snapshot();
for (const [what, call] of [
  ['eggs_total negative', prodCall(FX, '2026-04-05', -1)],
  ['eggs_total NULL', prodCall(FX, '2026-04-05', null)],
  ['eggs_broken negative', prodCall(FX, '2026-04-05', 10, -1, 0)],
  ['eggs_broken NULL', prodCall(FX, '2026-04-05', 10, null, 0)],
  ['eggs_dirty negative', prodCall(FX, '2026-04-05', 10, 0, -1)],
  ['eggs_dirty NULL', prodCall(FX, '2026-04-05', 10, 0, null)],
]) {
  r = ADMIN(`SELECT ${call};`);
  check(`E ${what} → INVALID_QUANTITY`, raised(r, 'INVALID_QUANTITY'), firstErr(r));
}
r = A(`SELECT ${prodCall(FX, '2026-04-01', 1)};`);
check('E1 a second current production for the same flock/date → DUPLICATE_PRODUCTION', raised(r, 'DUPLICATE_PRODUCTION'), firstErr(r));
check('E2 none of the rejected registrations wrote anything', snapshot() === snap);
r = raw(`INSERT INTO daily_production (flock_id, production_date, eggs_total, eggs_broken) VALUES ('${FX}', '2026-04-06', 1, -1);`);
check('E3 physical backstop: eggs_broken < 0 violates daily_production_eggs_broken_check (even for the owner)', violates(r, 'daily_production_eggs_broken_check'), firstErr(r));
r = raw(`INSERT INTO daily_production (flock_id, production_date, eggs_total) VALUES ('${FX}', '2026-04-01', 1);`);
check('E4 physical backstop: a second current row for flock/date violates idx_daily_production_current', violates(r, 'idx_daily_production_current'), firstErr(r));
const pDayOther = rpc(prodCall(FY, '2026-04-01', 900));
check('E5 the uniqueness is per flock/date, not global by date (another flock, same date)', !!pDayOther.production_id);

// ═══════════════════════════════════════════════════════════════════════════
section('F', 'Production period');

closePeriod('2026-03-01');
snap = snapshot();
r = ADMIN(`SELECT ${prodCall(FX, '2026-03-20', 10)};`);
check('F1 CLOSED production_date → PERIOD_CLOSED, nothing written', raised(r, 'PERIOD_CLOSED') && snapshot() === snap, firstErr(r));
r = A(`SELECT ${prodCall(FX, '2026-03-21', 10)};`);
check('F2 OPERATOR is equally blocked by a CLOSED period', raised(r, 'PERIOD_CLOSED') && snapshot() === snap, firstErr(r));
openPeriod('2026-03-01');
r = ADMIN(`SELECT ${prodCall(FX, '2027-02-10', 10)};`);
check('F3 date without a management_period → PERIOD_NOT_FOUND', raised(r, 'PERIOD_NOT_FOUND') && snapshot() === snap, firstErr(r));
closePeriod(CURRENT_MONTH);
const pF = rpc(prodCall(FX, '2026-04-07', 2300));
check(`F4 created_at irrelevant: current month ${CURRENT_MONTH} CLOSED, production_date 2026-04-07 OPEN → accepted`,
  owner(`SELECT production_date || '|' || date_trunc('month', created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE FROM daily_production WHERE id = '${pF.production_id}';`)
  === `2026-04-07|${CURRENT_MONTH}`);
openPeriod(CURRENT_MONTH);

// ═══════════════════════════════════════════════════════════════════════════
section('G', 'Rectify production — ADMIN');

econ0 = econ();
const gR = rpc(rectProdCall(pC.production_id, 2390, 5, 7, 'recuento ADMIN'));
check('G1 returns {previous_id, new_id, version_seq 1}', gR.previous_id === pC.production_id && gR.version_seq === 1 && !!gR.new_id, JSON.stringify(gR));
check('G2 old row retired, business values untouched, superseded_by = new id (ADMIN may rectify an operator-authored row)',
  prodRow(pC.production_id) === `${FX}|2026-04-02|2380|0|0|false|${gR.new_id}|0|${OPA}`, prodRow(pC.production_id));
check('G3 new current row: same flock and date, new values, version 1, created_by = ADMIN (the real actor)',
  prodRow(gR.new_id) === `${FX}|2026-04-02|2390|5|7|true|-|1|${ADMIN_UID}`, prodRow(gR.new_id));
check('G4 audit RECTIFY: before (values, v0, original author), after (values, v1, new_id, actor_role ADMIN), reason',
  owner(`SELECT (before_values->>'eggs_total') || '|' || (before_values->>'created_by') || '|' || (after_values->>'eggs_total') || '|' || (after_values->>'version')
         || '|' || (after_values->>'new_id') || '|' || (after_values->>'actor_role') || '|' || reason FROM audit_events
         WHERE entity_type = 'daily_production' AND entity_id = '${pC.production_id}' AND action = 'RECTIFY';`)
  === `2380|${OPA}|2390|1|${gR.new_id}|ADMIN|recuento ADMIN`);
check('G5 no economic effect', econ() === econ0);

// ═══════════════════════════════════════════════════════════════════════════
section('H', 'Rectify production — OPERATOR own record');

const pH = rpcAs(A, prodCall(FX, '2026-04-08', 2200));
const hA = rpcAs(A, rectProdCall(pH.production_id, 2210, 1, 1, 'mi corrección'));
check('H1 operator A rectifies its own row on an assigned flock; the new version is authored by A',
  hA.version_seq === 1 && prodRow(hA.new_id) === `${FX}|2026-04-08|2210|1|1|true|-|1|${OPA}`, prodRow(hA.new_id));
check('H2 audit records actor_role OPERATOR', owner(`SELECT after_values->>'actor_role' FROM audit_events WHERE entity_id = '${pH.production_id}' AND action = 'RECTIFY';`) === 'OPERATOR');
assign(OPB, FX);
snap = snapshot();
r = B(`SELECT ${rectProdCall(hA.new_id, 1, 0, 0, 'no es mío')};`);
check('H3 operator B assigned to the same flock cannot rectify A\'s row → NOT_OWN_RECORD, nothing written', raised(r, 'NOT_OWN_RECORD') && snapshot() === snap, firstErr(r));
r = A(`SELECT ${rectProdCall(pB.production_id, 1, 0, 0, 'fila de ADMIN')};`);
check('H4 operator A cannot rectify an ADMIN-authored row → NOT_OWN_RECORD', raised(r, 'NOT_OWN_RECORD') && snapshot() === snap, firstErr(r));
setAssignment(OPA, FX, false);
r = A(`SELECT ${rectProdCall(hA.new_id, 1, 0, 0, 'sin asignación')};`);
check('H5 operator A with its assignment inactive cannot rectify even its own row → FLOCK_NOT_ASSIGNED', raised(r, 'FLOCK_NOT_ASSIGNED') && snapshot() === snap, firstErr(r));
r = A(`SELECT ${prodCall(FX, '2026-04-09', 1)};`);
check('H6 …nor register production on that flock → FLOCK_NOT_ASSIGNED', raised(r, 'FLOCK_NOT_ASSIGNED'), firstErr(r));
setAssignment(OPA, FX, true);
setAssignment(OPB, FX, false);
const hAdmin = rpc(rectProdCall(hA.new_id, 2215, 1, 1, 'ADMIN corrige'));
check('H7 ADMIN rectifies any current row regardless of author', hAdmin.version_seq === 2);

// ═══════════════════════════════════════════════════════════════════════════
section('I', 'Rectify production — errors / superseded');

snap = snapshot();
for (const [what, call, code] of [
  ['a superseded version', rectProdCall(pH.production_id, 1), 'ALREADY_SUPERSEDED'],
  ['a missing row', rectProdCall(MISSING_UUID, 1), 'PRODUCTION_NOT_FOUND'],
  ['blank reason', rectProdCall(hAdmin.new_id, 1, 0, 0, '   '), 'REASON_REQUIRED'],
  ['NULL reason', rectProdCall(hAdmin.new_id, 1, 0, 0, null), 'REASON_REQUIRED'],
  ['negative total', rectProdCall(hAdmin.new_id, -1), 'INVALID_QUANTITY'],
  ['NULL total', rectProdCall(hAdmin.new_id, null), 'INVALID_QUANTITY'],
  ['negative broken', rectProdCall(hAdmin.new_id, 1, -1, 0), 'INVALID_QUANTITY'],
  ['NULL dirty', rectProdCall(hAdmin.new_id, 1, 0, null), 'INVALID_QUANTITY'],
]) {
  r = ADMIN(`SELECT ${call};`);
  check(`I rectify ${what} → ${code}`, raised(r, code), firstErr(r));
}
check('I1 no rejected rectification wrote anything', snapshot() === snap);
const pI = rpc(prodCall(FX, '2026-03-10', 100));
closePeriod('2026-03-01');
snap = snapshot();
r = ADMIN(`SELECT ${rectProdCall(pI.production_id, 101)};`);
check('I2 ORIGINAL production_date in a CLOSED period → PERIOD_CLOSED (for ADMIN too)', raised(r, 'PERIOD_CLOSED') && snapshot() === snap, firstErr(r));
openPeriod('2026-03-01');

// ═══════════════════════════════════════════════════════════════════════════
section('J', 'Production N-pass');

const pJ = rpc(prodCall(FX, '2026-04-10', 2000));
const chainJ = [pJ.production_id];
for (let i = 1; i <= 4; i += 1) chainJ.push(rpc(rectProdCall(chainJ[chainJ.length - 1], 2000 + i)).new_id);
const jList = `(${chainJ.map((i) => `'${i}'`).join(',')})`;
check('J1 after 4 passes exactly one current row for flock/date, and it is the latest',
  owner(`SELECT count(*) FILTER (WHERE is_current) || '|' || bool_or(is_current AND id = '${chainJ[4]}') FROM daily_production WHERE id IN ${jList};`) === '1|true');
check('J2 version_seq 0..4', owner(`SELECT string_agg(version_seq::TEXT, ',' ORDER BY version_seq) FROM daily_production WHERE id IN ${jList};`) === '0,1,2,3,4');
check('J3 supersession chain exact: v(i).superseded_by = v(i+1), latest has none',
  chainJ.every((id, i) => owner(`SELECT coalesce(superseded_by::TEXT, '-') FROM daily_production WHERE id = '${id}';`) === (i < 4 ? chainJ[i + 1] : '-')));
check('J4 the current value for the flock/date is the latest (2004); history kept (2000..2003)',
  owner(`SELECT eggs_total FROM daily_production WHERE flock_id = '${FX}' AND production_date = '2026-04-10' AND is_current;`) === '2004'
  && owner(`SELECT string_agg(eggs_total::TEXT, ',' ORDER BY version_seq) FROM daily_production WHERE id IN ${jList};`) === '2000,2001,2002,2003,2004');

// ═══════════════════════════════════════════════════════════════════════════
section('K', 'Rectification atomicity (injected failures)');

owner(`
CREATE SCHEMA p18_harness;
CREATE TABLE p18_harness.fail_on (target TEXT, k TEXT);
CREATE FUNCTION p18_harness.hit(p_target TEXT, p_k TEXT) RETURNS BOOLEAN LANGUAGE sql AS $$
  SELECT EXISTS (SELECT 1 FROM p18_harness.fail_on WHERE target = p_target AND k = p_k);
$$;
CREATE FUNCTION p18_harness.dp_ins() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.version_seq > 0 AND p18_harness.hit('dp_insert', NEW.flock_id || '|' || NEW.production_date) THEN RAISE EXCEPTION 'HARNESS_FAIL_NEW_VERSION'; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION p18_harness.dp_upd() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.superseded_by IS NOT NULL AND OLD.superseded_by IS NULL AND p18_harness.hit('dp_pointer', NEW.flock_id || '|' || NEW.production_date) THEN
    RAISE EXCEPTION 'HARNESS_FAIL_POINTER';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION p18_harness.pe_ins() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.version_seq > 0 AND p18_harness.hit('pe_insert', NEW.flock_id || '|' || NEW.event_date) THEN RAISE EXCEPTION 'HARNESS_FAIL_NEW_VERSION'; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION p18_harness.pe_upd() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.superseded_by IS NOT NULL AND OLD.superseded_by IS NULL AND p18_harness.hit('pe_pointer', NEW.flock_id || '|' || NEW.event_date) THEN
    RAISE EXCEPTION 'HARNESS_FAIL_POINTER';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION p18_harness.au_ins() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.action IN ('RECTIFY', 'RECTIFY_MORTALITY') AND p18_harness.hit('audit', NEW.entity_id) THEN RAISE EXCEPTION 'HARNESS_FAIL_AUDIT'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER p18_dp_ins BEFORE INSERT ON public.daily_production FOR EACH ROW EXECUTE FUNCTION p18_harness.dp_ins();
CREATE TRIGGER p18_dp_upd BEFORE UPDATE ON public.daily_production FOR EACH ROW EXECUTE FUNCTION p18_harness.dp_upd();
CREATE TRIGGER p18_pe_ins BEFORE INSERT ON public.population_events FOR EACH ROW EXECUTE FUNCTION p18_harness.pe_ins();
CREATE TRIGGER p18_pe_upd BEFORE UPDATE ON public.population_events FOR EACH ROW EXECUTE FUNCTION p18_harness.pe_upd();
CREATE TRIGGER p18_au_ins BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION p18_harness.au_ins();`);
try {
  const pK = rpc(prodCall(FX, '2026-04-11', 1500));
  const kKey = `${FX}|2026-04-11`;
  for (const [targetName, keyVal, what, code] of [
    ['dp_insert', kKey, 'after the old row is retired, the new version insert fails', 'HARNESS_FAIL_NEW_VERSION'],
    ['dp_pointer', kKey, 'after the new version is inserted, the superseded_by update fails', 'HARNESS_FAIL_POINTER'],
    ['audit', pK.production_id, 'after superseded_by is set, the audit fails', 'HARNESS_FAIL_AUDIT'],
  ]) {
    owner(`DELETE FROM p18_harness.fail_on; INSERT INTO p18_harness.fail_on VALUES ('${targetName}', '${keyVal}');`);
    snap = snapshot();
    r = ADMIN(`SELECT ${rectProdCall(pK.production_id, 1600)};`);
    check(`K production: ${what} → full rollback (old row current, no pointer, no new row, no audit)`,
      raised(r, code) && snapshot() === snap && prodRow(pK.production_id) === `${FX}|2026-04-11|1500|0|0|true|-|0|${ADMIN_UID}`, firstErr(r));
  }
  const mK = rpc(mortCall(FX, '2026-04-11', 7));
  const mKey = `${FX}|2026-04-11`;
  for (const [targetName, keyVal, what, code] of [
    ['pe_insert', mKey, 'after the old mortality is retired, the replacement insert fails', 'HARNESS_FAIL_NEW_VERSION'],
    ['pe_pointer', mKey, 'after the replacement is inserted, the superseded_by update fails', 'HARNESS_FAIL_POINTER'],
    ['audit', String(mK.event_id), 'after superseded_by is set, the audit fails', 'HARNESS_FAIL_AUDIT'],
  ]) {
    owner(`DELETE FROM p18_harness.fail_on; INSERT INTO p18_harness.fail_on VALUES ('${targetName}', '${keyVal}');`);
    snap = snapshot();
    r = ADMIN(`SELECT ${rectMortCall(mK.event_id, 6)};`);
    check(`K mortality: ${what} → full rollback`,
      raised(r, code) && snapshot() === snap && evRow(mK.event_id) === `${FX}|MORTALITY|-7|2026-04-11|true|-|0|${ADMIN_UID}`, firstErr(r));
  }
} finally {
  owner(`DROP SCHEMA IF EXISTS p18_harness CASCADE;`);
}
check('K1 harness triggers removed', owner(`SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'p18_%';`) === '0');

// ═══════════════════════════════════════════════════════════════════════════
section('L', 'Register mortality');

econ0 = econ();
const mL = rpc(mortCall(FX, '2026-04-12', 10, 'mortandad'));
check('L1 returns {event_id, event_date, deaths}', Number.isInteger(mL.event_id) && mL.deaths === 10 && mL.event_date === '2026-04-12', JSON.stringify(mL));
check('L2 stored as MORTALITY with NEGATIVE delta -10, current, version 0',
  evRow(mL.event_id) === `${FX}|MORTALITY|-10|2026-04-12|true|-|0|${ADMIN_UID}`, evRow(mL.event_id));
check('L3 audit MORTALITY with deaths', owner(`SELECT action || '|' || (after_values->>'deaths') FROM audit_events WHERE entity_type = 'population_events' AND entity_id = '${mL.event_id}';`) === 'MORTALITY|10');
const mLA = rpcAs(A, mortCall(FX, '2026-04-13', 3));
check('L4 assigned OPERATOR registers mortality (created_by = operator)', evRow(mLA.event_id).endsWith(`|${OPA}`));
check('L5 no economic effect', econ() === econ0);
snap = snapshot();
for (const [what, fn, call, code] of [
  ['deaths 0', ADMIN, mortCall(FX, '2026-04-14', 0), 'INVALID_QUANTITY'],
  ['deaths negative', ADMIN, mortCall(FX, '2026-04-14', -2), 'INVALID_QUANTITY'],
  ['deaths NULL', ADMIN, mortCall(FX, '2026-04-14', null), 'INVALID_QUANTITY'],
  ['OPERATOR on unassigned flock', A, mortCall(FY, '2026-04-14', 1), 'FLOCK_NOT_ASSIGNED'],
]) {
  r = fn(`SELECT ${call};`);
  check(`L ${what} → ${code}`, raised(r, code), firstErr(r));
}
check('L6 rejected registrations wrote nothing', snapshot() === snap);

// ═══════════════════════════════════════════════════════════════════════════
section('M', 'Mortality uniqueness');

snap = snapshot();
r = A(`SELECT ${mortCall(FX, '2026-04-12', 4)};`);
check('M1 a second current MORTALITY for the same flock/date → MORTALITY_ALREADY_RECORDED reporting the existing value (10)',
  raised(r, 'MORTALITY_ALREADY_RECORDED') && /: 10 deaths already recorded/.test(r.err), firstErr(r));
check('M2 no second row survives', snapshot() === snap);
r = raw(`INSERT INTO population_events (flock_id, event_type, delta, event_date) VALUES ('${FX}', 'MORTALITY', -1, '2026-04-12');`);
check('M3 physical backstop idx_population_events_mortality_current (even for the owner)', violates(r, 'idx_population_events_mortality_current'), firstErr(r));
const adjSameDay = rpc(adjCall(FX, '2026-04-12', -2));
check('M4 COUNT_ADJUSTMENT on the same flock/date is not covered by that uniqueness', Number.isInteger(adjSameDay.event_id));

// ═══════════════════════════════════════════════════════════════════════════
section('O', 'Rectify mortality');

const oR = rpc(rectMortCall(mL.event_id, 8, 'recuento corregido'));
check('O1 returns {previous_id, new_id, version_seq 1}', oR.previous_id === mL.event_id && oR.version_seq === 1 && Number.isInteger(oR.new_id), JSON.stringify(oR));
check('O2 old row: flock, date and delta (-10) UNCHANGED; only is_current=false and superseded_by=new id',
  evRow(mL.event_id) === `${FX}|MORTALITY|-10|2026-04-12|false|${oR.new_id}|0|${ADMIN_UID}`, evRow(mL.event_id));
check('O3 new current MORTALITY: same flock and date, delta -8, version 1', evRow(oR.new_id) === `${FX}|MORTALITY|-8|2026-04-12|true|-|1|${ADMIN_UID}`, evRow(oR.new_id));
check('O4 audit RECTIFY_MORTALITY: before {deaths 10, v0}, after {deaths 8, v1, new_id}, reason',
  owner(`SELECT (before_values->>'deaths') || '|' || (after_values->>'deaths') || '|' || (after_values->>'version') || '|' || (after_values->>'new_id') || '|' || reason
         FROM audit_events WHERE entity_type = 'population_events' AND entity_id = '${mL.event_id}' AND action = 'RECTIFY_MORTALITY';`)
  === `10|8|1|${oR.new_id}|recuento corregido`);
snap = snapshot();
for (const [what, call, code] of [
  ['a superseded mortality', rectMortCall(mL.event_id, 5), 'ALREADY_SUPERSEDED'],
  ['a count adjustment', rectMortCall(adjSameDay.event_id, 5), 'NOT_A_MORTALITY_EVENT'],
  ['a missing event', rectMortCall(999999999, 5), 'EVENT_NOT_FOUND'],
  ['deaths 0', rectMortCall(oR.new_id, 0), 'INVALID_QUANTITY'],
  ['deaths NULL', rectMortCall(oR.new_id, null), 'INVALID_QUANTITY'],
  ['blank reason', rectMortCall(oR.new_id, 5, ' '), 'REASON_REQUIRED'],
]) {
  r = ADMIN(`SELECT ${call};`);
  check(`O rectify ${what} → ${code}`, raised(r, code), firstErr(r));
}
check('O5 rejected mortality rectifications wrote nothing', snapshot() === snap);
const mOld = rpc(mortCall(FX, '2026-03-11', 2));
closePeriod('2026-03-01');
r = ADMIN(`SELECT ${rectMortCall(mOld.event_id, 1)};`);
check('O6 ORIGINAL event_date in a CLOSED period → PERIOD_CLOSED', raised(r, 'PERIOD_CLOSED') && evRow(mOld.event_id).includes('|true|'), firstErr(r));
openPeriod('2026-03-01');

// ═══════════════════════════════════════════════════════════════════════════
section('P', 'OPERATOR cannot rectify mortality');

snap = snapshot();
r = A(`SELECT ${rectMortCall(oR.new_id, 1, 'intento operador')};`);
check('P1 OPERATOR (assigned) → FORBIDDEN from rectify_mortality, nothing written', raised(r, 'FORBIDDEN') && snapshot() === snap, firstErr(r));

// ═══════════════════════════════════════════════════════════════════════════
section('Q', 'Count adjustment');

const qPos = rpc(adjCall(FX, '2026-04-15', 2));
const qNeg = rpcAs(A, adjCall(FX, '2026-04-15', -5, 'recuento de galpón'));
check('Q1 positive and negative adjustments stored exactly as supplied; operator allowed on assigned flock',
  evRow(qPos.event_id).startsWith(`${FX}|COUNT_ADJUSTMENT|2|2026-04-15|true|-|0|`) && evRow(qNeg.event_id) === `${FX}|COUNT_ADJUSTMENT|-5|2026-04-15|true|-|0|${OPA}`);
check('Q2 multiple adjustments for the same flock/date are allowed',
  owner(`SELECT count(*) FROM population_events WHERE flock_id = '${FX}' AND event_date = '2026-04-15' AND event_type = 'COUNT_ADJUSTMENT';`) === '2');
check('Q3 audit COUNT_ADJUSTMENT with delta and reason',
  owner(`SELECT action || '|' || (after_values->>'delta') || '|' || reason FROM audit_events WHERE entity_type = 'population_events' AND entity_id = '${qNeg.event_id}';`) === 'COUNT_ADJUSTMENT|-5|recuento de galpón');
snap = snapshot();
for (const [what, fn, call, code] of [
  ['delta 0', ADMIN, adjCall(FX, '2026-04-15', 0), 'INVALID_QUANTITY'],
  ['delta NULL', ADMIN, adjCall(FX, '2026-04-15', null), 'INVALID_QUANTITY'],
  ['NULL reason', ADMIN, adjCall(FX, '2026-04-15', 1, null), 'REASON_REQUIRED'],
  ['blank reason', ADMIN, adjCall(FX, '2026-04-15', 1, '  '), 'REASON_REQUIRED'],
  ['OPERATOR on unassigned flock', A, adjCall(FY, '2026-04-15', 1), 'FLOCK_NOT_ASSIGNED'],
]) {
  r = fn(`SELECT ${call};`);
  check(`Q ${what} → ${code}`, raised(r, code), firstErr(r));
}
closePeriod('2026-03-01');
r = ADMIN(`SELECT ${adjCall(FX, '2026-03-15', 1)};`);
check('Q4 CLOSED event_date → PERIOD_CLOSED', raised(r, 'PERIOD_CLOSED'), firstErr(r));
r = ADMIN(`SELECT ${mortCall(FX, '2026-03-16', 1)};`);
check('Q5 mortality in a CLOSED event_date → PERIOD_CLOSED', raised(r, 'PERIOD_CLOSED'), firstErr(r));
openPeriod('2026-03-01');
check('Q6 rejected adjustments / closed-period calls wrote nothing', snapshot() === snap);

// ═══════════════════════════════════════════════════════════════════════════
section('R', 'Derived population');

const FP = mkFlock('Población', 1000);
check('R1 initial population 1000, no events → 1000', population(FP) === '1000');
const rM = rpc(mortCall(FP, '2026-04-01', 10));
check('R2 mortality 10 on day 1 → 990', population(FP) === '990');
rpc(adjCall(FP, '2026-04-02', -5));
check('R3 count adjustment -5 on day 2 → 985', population(FP) === '985');
rpc(adjCall(FP, '2026-04-02', 2));
check('R4 count adjustment +2 on the same day → 987', population(FP) === '987');
const rR1 = rpc(rectMortCall(rM.event_id, 8));
check('R5 rectify mortality 10 → 8: 1000 - 8 - 5 + 2 = 989 (the superseded -10 no longer contributes)', population(FP) === '989');
const rR2 = rpc(rectMortCall(rR1.new_id, 7));
rpc(rectMortCall(rR2.new_id, 6));
check('R6 after N mortality rectifications only the final current one contributes: 1000 - 6 - 5 + 2 = 991', population(FP) === '991');
check('R7 historical mortality rows remain queryable (4 rows, 1 current, deltas -10,-8,-7,-6)',
  owner(`SELECT count(*) || '|' || count(*) FILTER (WHERE is_current) || '|' || string_agg(delta::TEXT, ',' ORDER BY version_seq)
         FROM population_events WHERE flock_id = '${FP}' AND event_type = 'MORTALITY';`) === '4|1|-10,-8,-7,-6');
check('R8 derivation equals initial + SUM(current deltas); summing ALL rows would be wrong (it would give 1000-10-8-7-6-5+2 = 966)',
  owner(`SELECT (SELECT initial_population FROM flocks WHERE id = '${FP}') + SUM(delta) FROM population_events WHERE flock_id = '${FP}';`) === '966' && population(FP) === '991');

// ═══════════════════════════════════════════════════════════════════════════
section('S', 'One ACTIVE flock per shed');

const shedS = owner(`SELECT shed_id FROM flocks WHERE id = '${FP}';`);
r = raw(`INSERT INTO flocks (shed_id, entry_date, initial_population, estado) VALUES ('${shedS}', '2026-04-01', 10, 'ACTIVE');`);
check('S1 a second ACTIVE flock in the same shed violates idx_flocks_shed_active', violates(r, 'idx_flocks_shed_active'), firstErr(r));

// ═══════════════════════════════════════════════════════════════════════════
section('T', 'RLS / privileges');

const cnt = (fn, t, f) => { const x2 = fn(`SELECT count(*) FROM ${t} WHERE flock_id = '${f}';`); return x2.ok ? x2.out : `ERR ${firstErr(x2)}`; };
check('T1 ADMIN reads production and events of every flock',
  Number(cnt(ADMIN, 'daily_production', FX)) > 0 && Number(cnt(ADMIN, 'daily_production', FY)) > 0 && Number(cnt(ADMIN, 'population_events', FX)) > 0);
check('T2 operator A reads production and events of its assigned flock X',
  cnt(A, 'daily_production', FX) === owner(`SELECT count(*) FROM daily_production WHERE flock_id = '${FX}';`)
  && cnt(A, 'population_events', FX) === owner(`SELECT count(*) FROM population_events WHERE flock_id = '${FX}';`));
check('T3 operator A reads NOTHING of unassigned flock Y (production and events)', cnt(A, 'daily_production', FY) === '0' && cnt(A, 'population_events', FY) === '0');
check('T4 operator B (assignment on X now inactive) reads nothing of X, but reads Y',
  cnt(B, 'daily_production', FX) === '0' && Number(cnt(B, 'daily_production', FY)) > 0);
snap = snapshot();
const direct = [
  A(`INSERT INTO daily_production (flock_id, production_date, eggs_total) VALUES ('${FX}', '2026-04-20', 1);`),
  A(`UPDATE daily_production SET eggs_total = 1 WHERE flock_id = '${FX}';`),
  A(`DELETE FROM daily_production WHERE flock_id = '${FX}';`),
  A(`INSERT INTO population_events (flock_id, event_type, delta, event_date) VALUES ('${FX}', 'MORTALITY', -1, '2026-04-20');`),
  A(`UPDATE population_events SET delta = -1;`),
  ADMIN(`INSERT INTO daily_production (flock_id, production_date, eggs_total) VALUES ('${FX}', '2026-04-20', 1);`),
  ADMIN(`UPDATE population_events SET is_current = false;`),
  ADMIN(`DELETE FROM population_events;`),
  ADMIN(`TRUNCATE daily_production;`),
  ADMIN(`TRUNCATE population_events;`),
];
check('T5 no direct INSERT / UPDATE / DELETE / TRUNCATE for OPERATOR or ADMIN (RPC-only writes)',
  direct.every(denied) && snapshot() === snap, direct.map((d) => (denied(d) ? 'd' : 'OPEN')).join(','));
check('T6 anon: no SELECT and no EXECUTE', [asAnon(`SELECT count(*) FROM daily_production;`), asAnon(`SELECT count(*) FROM population_events;`),
  asAnon(`SELECT ${prodCall(FX, '2026-04-21', 1)};`)].every(denied));
check('T7 service_role: no SELECT and no EXECUTE', [asServiceRole(`SELECT count(*) FROM daily_production;`), asServiceRole(`SELECT count(*) FROM population_events;`),
  asServiceRole(`SELECT ${mortCall(FX, '2026-04-21', 1)};`)].every(denied));
const acl = owner(`SELECT string_agg(relname || '=' || relacl::TEXT, ' ' ORDER BY relname) FROM pg_class WHERE relname IN ('daily_production','population_events','population_events_id_seq');`);
check('T8 exact ACLs: authenticated SELECT only; sequence owner-only',
  acl === 'daily_production={postgres=arwdDxtm/postgres,authenticated=r/postgres} population_events={postgres=arwdDxtm/postgres,authenticated=r/postgres} '
  + 'population_events_id_seq={postgres=rwU/postgres}', acl);
const pols = owner(`SELECT string_agg(tablename || ':' || policyname || ':' || cmd, ',' ORDER BY tablename, policyname) FROM pg_policies WHERE tablename IN ('daily_production','population_events');`);
check('T9 policies exactly as frozen: ADMIN SELECT + OPERATOR SELECT (assigned) per table, no write policy',
  pols === 'daily_production:daily_production_admin_select:SELECT,daily_production:daily_production_operator_select:SELECT,'
  + 'population_events:population_events_admin_select:SELECT,population_events:population_events_operator_select:SELECT', pols);
check('T10 flocks / operator_assignments policies unchanged (flocks: ADMIN + OPERATOR-assigned SELECT)',
  owner(`SELECT string_agg(policyname, ',' ORDER BY policyname) FROM pg_policies WHERE tablename = 'flocks';`) === 'flocks_admin_select,flocks_operator_assigned');

// ═══════════════════════════════════════════════════════════════════════════
section('U', 'SECURITY DEFINER');

const definers = owner(`SELECT string_agg(proname, ',' ORDER BY proname) FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace;`);
check('U1 SECURITY DEFINER inventory = previous 21 + RPCs 18–22 + built later-phase RPCs', definers === ALL_DEFINERS, definers);
const hard = owner(`SELECT string_agg(proname || ':' || prosecdef || ':' || (coalesce(proconfig, '{}') @> ARRAY['search_path=public']) || ':' ||
  pg_get_userbyid(proowner) || ':' || (proacl IS NOT NULL AND NOT EXISTS (SELECT 1 FROM aclexplode(proacl) a WHERE a.grantee = 0)) || ':' ||
  has_function_privilege('anon', oid, 'EXECUTE') || ':' || has_function_privilege('authenticated', oid, 'EXECUTE') || ':' ||
  has_function_privilege('service_role', oid, 'EXECUTE'), ',' ORDER BY proname) FROM pg_proc WHERE proname IN (${RPCS.map((p) => `'${p}'`).join(',')});`);
check('U2 RPCs 18–22: DEFINER, search_path=public, owner postgres, no PUBLIC, anon no, authenticated yes, service_role no',
  hard === RPCS.map((p) => `${p}:true:true:postgres:true:false:true:false`).join(','), hard);
const actorArgs = owner(`SELECT coalesce(string_agg(proname, ','), '') FROM pg_proc WHERE proname IN (${RPCS.map((p) => `'${p}'`).join(',')})
  AND EXISTS (SELECT 1 FROM unnest(proargnames) a WHERE a ~* '(user|actor|role|performed|created_by|uid|operator)');`);
check('U3 no parameter can name the actor, the role or the operator', actorArgs === '', actorArgs);

// ═══════════════════════════════════════════════════════════════════════════
section('V', 'Concurrency (independent PostgreSQL sessions)');

const FV = mkFlock('Concurrencia', 800);
assign(OPA, FV);
x = await race(OPA, prodCall(FV, '2026-04-20', 700), prodCall(FV, '2026-04-20', 710), 'p18-prod');
check('V1 duplicate production race: B waited, then DUPLICATE_PRODUCTION; exactly one current row',
  x.aIn && x.bWait && x.ra.ok && raised(x.rb, 'DUPLICATE_PRODUCTION')
  && owner(`SELECT count(*) FROM daily_production WHERE flock_id = '${FV}' AND production_date = '2026-04-20' AND is_current;`) === '1', firstErr(x.rb));
x = await race(OPA, mortCall(FV, '2026-04-20', 4), mortCall(FV, '2026-04-20', 9), 'p18-mort');
check('V2 duplicate mortality race: B waited, then MORTALITY_ALREADY_RECORDED reporting A\'s value (4); exactly one current',
  x.aIn && x.bWait && x.ra.ok && raised(x.rb, 'MORTALITY_ALREADY_RECORDED') && /: 4 deaths already recorded/.test(x.rb.err)
  && owner(`SELECT count(*) FROM population_events WHERE flock_id = '${FV}' AND event_date = '2026-04-20' AND event_type = 'MORTALITY' AND is_current;`) === '1', firstErr(x.rb));
const pV = owner(`SELECT id FROM daily_production WHERE flock_id = '${FV}' AND production_date = '2026-04-20' AND is_current;`);
x = await race(ADMIN_UID, rectProdCall(pV, 720), rectProdCall(pV, 730), 'p18-rp');
check('V3 concurrent rectifications of the same production: B waited, then ALREADY_SUPERSEDED; one current, version 1',
  x.aIn && x.bWait && x.ra.ok && raised(x.rb, 'ALREADY_SUPERSEDED')
  && owner(`SELECT count(*) || '|' || max(version_seq) FROM daily_production WHERE flock_id = '${FV}' AND production_date = '2026-04-20' AND is_current;`) === '1|1', firstErr(x.rb));
const mV = owner(`SELECT id FROM population_events WHERE flock_id = '${FV}' AND event_date = '2026-04-20' AND event_type = 'MORTALITY' AND is_current;`);
x = await race(ADMIN_UID, rectMortCall(mV, 3), rectMortCall(mV, 2), 'p18-rm');
check('V4 concurrent rectifications of the same mortality: B waited, then ALREADY_SUPERSEDED; one current MORTALITY',
  x.aIn && x.bWait && x.ra.ok && raised(x.rb, 'ALREADY_SUPERSEDED')
  && owner(`SELECT count(*) || '|' || min(delta) FROM population_events WHERE flock_id = '${FV}' AND event_date = '2026-04-20' AND event_type = 'MORTALITY' AND is_current;`) === '1|-3', firstErr(x.rb));

// ═══════════════════════════════════════════════════════════════════════════
section('W', 'Phase 17 integration (flocks ↔ purchases)');

check('W1 cycle-2 FKs from Phase 17 still exist and are validated',
  owner(`SELECT string_agg(conname || ':' || convalidated, ',' ORDER BY conname) FROM pg_constraint WHERE conname IN ('fk_flocks_purchase','fk_purchases_flock');`)
  === 'fk_flocks_purchase:true,fk_purchases_flock:true');
check('W2 a purchase is not mandatory: every Phase 18 test flock has purchase_id NULL and works',
  owner(`SELECT bool_and(purchase_id IS NULL) FROM flocks WHERE id IN ${TF};`) === 't');

// ═══════════════════════════════════════════════════════════════════════════
section('E2E', 'Slice 3 end to end');

const FE = mkFlock('E2E', 2700);
assign(OPA, FE);
econ0 = econ();
const e1 = rpcAs(A, prodCall(FE, '2026-05-01', 2400, 20, 30));
const eM = rpcAs(A, mortCall(FE, '2026-05-01', 5));
check('E1 day 1: production 2400/20/30 and mortality 5 by the assigned operator → population 2695', population(FE) === '2695');
rpcAs(A, prodCall(FE, '2026-05-02', 2420));
rpcAs(A, adjCall(FE, '2026-05-02', -3, 'recuento'));
check('E2 day 2: production 2420 and count adjustment -3 → population 2692', population(FE) === '2692');
const eRM = rpc(rectMortCall(eM.event_id, 4, 'eran 4'));
check('E3 ADMIN rectifies day-1 mortality 5 → 4 → population 2693', population(FE) === '2693');
const eRP = rpcAs(A, rectProdCall(e1.production_id, 2410, 20, 30, 'conteo final'));
check('E4 the same operator, still assigned, rectifies its day-1 production 2400 → 2410',
  owner(`SELECT eggs_total || '|' || created_by FROM daily_production WHERE flock_id = '${FE}' AND production_date = '2026-05-01' AND is_current;`) === `2410|${OPA}`);
check('E5 old day-1 production and old mortality remain historical (non-current, pointing to their replacements)',
  prodRow(e1.production_id).includes(`|false|${eRP.new_id}|`) && evRow(eM.event_id).includes(`|false|${eRM.new_id}|`));
check('E6 current state: mortality -4, adjustment -3, population 2693',
  owner(`SELECT string_agg(event_type || ':' || delta, ',' ORDER BY event_date, id) FROM population_events WHERE flock_id = '${FE}' AND is_current;`)
  === 'MORTALITY:-4,COUNT_ADJUSTMENT:-3' && population(FE) === '2693');
check('E7 no ledger, no posting, no financial operation anywhere in the slice', econ() === econ0);

// ═══════════════════════════════════════════════════════════════════════════
section('AUTH', 'Authorization end to end');

const AX = mkFlock('Auth X', 500);
const AY = mkFlock('Auth Y', 500);
assign(OPA, AX);
assign(OPB, AY);
const aP = rpcAs(A, prodCall(AX, '2026-05-10', 400));
const aM = rpcAs(A, mortCall(AX, '2026-05-10', 1));
const aAdj = rpcAs(A, adjCall(AX, '2026-05-10', 1));
const aR = rpcAs(A, rectProdCall(aP.production_id, 401, 0, 0, 'mía'));
check('AUTH1 A can register production, mortality and adjustment on X, and rectify its own production',
  !!aP.production_id && Number.isInteger(aM.event_id) && Number.isInteger(aAdj.event_id) && aR.version_seq === 1);
const bP = rpcAs(B, prodCall(AY, '2026-05-10', 300));
snap = snapshot();
const aOnY = [A(`SELECT ${prodCall(AY, '2026-05-11', 1)};`), A(`SELECT ${mortCall(AY, '2026-05-11', 1)};`), A(`SELECT ${adjCall(AY, '2026-05-11', 1)};`)];
check('AUTH2 A cannot write on Y (production, mortality, adjustment → FLOCK_NOT_ASSIGNED)', aOnY.every((z) => raised(z, 'FLOCK_NOT_ASSIGNED')) && snapshot() === snap);
check('AUTH3 A cannot read Y production or events', cnt(A, 'daily_production', AY) === '0' && cnt(A, 'population_events', AY) === '0');
assign(OPA, AY);
r = A(`SELECT ${rectProdCall(bP.production_id, 1, 0, 0, 'ahora asignado')};`);
check('AUTH4 even after being assigned to Y, A cannot rectify B\'s production → NOT_OWN_RECORD', raised(r, 'NOT_OWN_RECORD') && snapshot() === snap, firstErr(r));
check('AUTH5 once assigned to Y, A can read Y (reads follow the active assignment)', Number(cnt(A, 'daily_production', AY)) === 1);
const admB = rpc(rectProdCall(bP.production_id, 305, 0, 0, 'ADMIN corrige a B'));
const admA = rpc(rectProdCall(aR.new_id, 402, 0, 0, 'ADMIN corrige a A'));
const admM = rpc(rectMortCall(aM.event_id, 2, 'ADMIN corrige mortandad'));
check('AUTH6 ADMIN rectifies all current production (A\'s and B\'s) and rectifies mortality',
  admB.version_seq === 1 && admA.version_seq === 2 && admM.version_seq === 1);
} finally {
  cleanup();
}

section('Z', 'Cleanup');
const left = owner(`SELECT (SELECT count(*) FROM sheds WHERE nombre LIKE '${TAG}%') + (SELECT count(*) FROM information_schema.schemata WHERE schema_name = 'p18_harness')
  + (SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'p18_%') + (SELECT count(*) FROM operator_assignments WHERE operator_id = '${OPB}')
  + (SELECT count(*) FROM perfiles WHERE id = '${OPB}');`);
check('Z1 all P18-TEST sheds/flocks/assignments, operator B fixture, harness schema and triggers removed', left === '0', left);
const closedLeft = owner(`SELECT count(*) FROM management_period WHERE status = 'CLOSED' AND periodo_fecha IN (${CLOSED_BY_SUITE.map((m) => `'${m}'`).join(',')});`);
check('Z2 periods closed by the suite are OPEN again', closedLeft === '0', closedLeft);

console.log(`\n  ══ PRODUCTION RESULT: ${pass} passed, ${fail} failed ══\n`);
if (fail > 0) {
  console.log('  Failures:');
  for (const f of failures) console.log(`    - ${f.label}${f.detail !== undefined ? ` :: ${f.detail}` : ''}`);
  console.log('');
}
process.exit(fail === 0 ? 0 : 1);
