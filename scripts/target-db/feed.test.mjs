#!/usr/bin/env node
/**
 * PHASE 20 — FEED TEST SUITE. LOCAL TEST DATABASE ONLY.
 *
 * Behavioural tests of RPCs 26–29 (register_feed_manufacturing,
 * register_feed_inventory_count, register_feed_movement, assign_flock_feed)
 * over feed_formula_version, feed_formula_line, feed_manufacturing,
 * feed_movement, feed_inventory_count and flock_feed_assignment, plus the
 * feed_formula_line_safe view (composition without cost).
 *
 * Consumption is never stored. The two canonical derivations are exercised as
 * read-only queries over the facts:
 *   consumo interno = opening_count + manufacturing - external_output
 *                     ± adjustments - closing_count          (per feed type, per window)
 *   consumo teórico = population × genetics_consumption_curve(age_weeks)
 *                     attributed to the assigned feed type    (per flock, per day)
 *
 * Role-scoped calls simulate real Supabase sessions with two operator profiles
 * (A, B) and ADMIN. Failure injection uses test-only triggers in schema
 * p20_harness (dropped at the end). The concurrency group runs independent
 * PostgreSQL sessions.
 *
 * Fixtures: every master/fixture row is named "P20-TEST …" (feed types,
 * ingredients, curve genetics line, sheds, client); manufacturing keys start
 * with "P20-TEST:". Formula versions/lines are created through the ADMIN
 * master path (RLS INSERT policies) — no formula-management RPC exists or is
 * invented. Operator B is a Phase 20 fixture removed at the end.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *     node scripts/target-db/feed.test.mjs
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
const OPA = '22222222-2222-2222-2222-222222222222';
const OPB = '77777777-7777-7777-7777-777777777777';
const INACTIVE_UID = '33333333-3333-3333-3333-333333333333';
const NOPROFILE_UID = '44444444-4444-4444-4444-444444444444';
const MISSING_UUID = '99999999-9999-9999-9999-999999999999';
const TAG = 'P20-TEST';
const KEY_PREFIX = `${TAG}:`;
const GENETICS = `${TAG} W36`;
const BIRTH = '2025-10-06';
const TABLES = ['feed_formula_line', 'feed_formula_version', 'feed_inventory_count', 'feed_manufacturing', 'feed_movement', 'flock_feed_assignment'];
const FEED_RPCS = ['assign_flock_feed', 'register_feed_inventory_count', 'register_feed_manufacturing', 'register_feed_movement'];
const ALL_DEFINERS = 'assert_period_open,assign_flock_feed,assign_freight_to_purchase,cancel_order,cancel_supplier_instrument,clear_cheque,close_flock,close_sales_session,current_app_role,deliver_order,'
  + 'deposit_cheque,endorse_cheque,issue_supplier_instrument,mark_supplier_instrument_debited,mp_allocate_to_client,mp_apply_transition,mp_auto_allocate,mp_check_report_coverage,mp_claim_deliveries,mp_clear_attribution_flag,mp_delivery_transition,mp_flag_for_attribution,mp_ingest_api_snapshot,mp_map_payer_to_client,mp_normalize_report_fallback,mp_normalize_source,mp_reconcile_movement,mp_record_balance_check,mp_register_delivery,mp_request_refetch,mp_requeue_config_blocked,mp_resolve_chargeback_signal,mp_resolve_match,mp_reverse_client_allocation,mp_unmap_payer,open_sales_session,pay_fiscal_obligation,pay_supplier,publish_feed_formula_version,receive_cheque,'
  + 'rectify_classification,rectify_daily_production,rectify_delivered_order,rectify_feed_manufacturing,rectify_mortality,rectify_purchase,register_bank_tax,register_classification,register_collection,'
  + 'register_count_adjustment,register_daily_production,register_feed_inventory_count,register_feed_manufacturing,register_feed_movement,'
  + 'register_fiscal_document,register_fiscal_obligation,register_flock,register_freight,register_management_event,register_mortality,register_purchase,register_purchase_with_fiscal_document,register_session_cash_event,register_session_movement,reject_cheque,reject_supplier_instrument,transfer_between_accounts';

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
// A runs sqlA and then holds its transaction open; B starts once A is inside.
async function race(uidA, sqlA, uidB, sqlB, appPrefix, expectWait = true) {
  const pA = session(sessionSql('authenticated', claimsOf(uidA), `${sqlA}\nSELECT pg_sleep(2);`), `${appPrefix}-A`);
  const aIn = await waitFor(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = '${appPrefix}-A'
    AND state = 'active' AND query LIKE '%pg_sleep%');`);
  const pB = session(uidB === null ? sqlB : sessionSql('authenticated', claimsOf(uidB), sqlB), `${appPrefix}-B`);
  const bWait = expectWait
    ? await waitFor(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = '${appPrefix}-B' AND wait_event_type IN ('Lock'));`)
    : null;
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
const firstErr = (r) => (r.err.split('\n').find((l) => /ERROR/.test(l)) || r.err.split('\n')[0] || '').slice(0, 180);
const denied = (r) => !r.ok && /permission denied/i.test(r.err);
const rlsDenied = (r) => !r.ok && /row-level security/i.test(r.err);
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
const FT = `(SELECT id FROM feed_type WHERE nombre LIKE '${TAG}%')`;
const FV = `(SELECT id FROM feed_formula_version WHERE feed_type_id IN ${FT})`;
const TF = `(SELECT f.id FROM flocks f JOIN sheds s ON s.id = f.shed_id WHERE s.nombre LIKE '${TAG}%')`;
function cleanup() {
  owner(`
DROP SCHEMA IF EXISTS p20_harness CASCADE;
DELETE FROM audit_events WHERE entity_type = 'feed_manufacturing'
   AND entity_id IN (SELECT id::TEXT FROM feed_manufacturing WHERE formula_version_id IN ${FV} OR idempotency_key LIKE '${KEY_PREFIX}%');
DELETE FROM audit_events WHERE entity_type = 'feed_inventory_count'
   AND entity_id IN (SELECT id::TEXT FROM feed_inventory_count WHERE feed_type_id IN ${FT});
DELETE FROM audit_events WHERE entity_type = 'feed_movement'
   AND entity_id IN (SELECT id::TEXT FROM feed_movement WHERE feed_type_id IN ${FT});
DELETE FROM audit_events WHERE entity_type = 'flock_feed_assignment'
   AND entity_id IN (SELECT id::TEXT FROM flock_feed_assignment WHERE feed_type_id IN ${FT} OR flock_id IN ${TF});
DELETE FROM audit_events WHERE entity_type = 'population_events'
   AND entity_id IN (SELECT id::TEXT FROM population_events WHERE flock_id IN ${TF});
DELETE FROM feed_manufacturing WHERE formula_version_id IN ${FV} OR idempotency_key LIKE '${KEY_PREFIX}%';
DELETE FROM feed_formula_line WHERE formula_version_id IN ${FV};
DELETE FROM feed_formula_version WHERE feed_type_id IN ${FT};
DELETE FROM feed_movement WHERE feed_type_id IN ${FT};
DELETE FROM feed_inventory_count WHERE feed_type_id IN ${FT};
DELETE FROM flock_feed_assignment WHERE feed_type_id IN ${FT} OR flock_id IN ${TF};
UPDATE population_events SET superseded_by = NULL WHERE flock_id IN ${TF};
DELETE FROM population_events WHERE flock_id IN ${TF};
DELETE FROM operator_assignments WHERE flock_id IN ${TF};
DELETE FROM flocks WHERE id IN ${TF};
DELETE FROM sheds WHERE nombre LIKE '${TAG}%';
DELETE FROM pedidos WHERE cliente_id IN (SELECT id FROM clients WHERE nombre LIKE '${TAG}%');
DELETE FROM clients WHERE nombre LIKE '${TAG}%';
DELETE FROM genetics_consumption_curve WHERE genetics_line LIKE '${TAG}%';
DELETE FROM feed_ingredient WHERE nombre LIKE '${TAG}%';
DELETE FROM feed_type WHERE nombre LIKE '${TAG}%';
-- operator B is a Phase 20 fixture: removed so other suites keep their exact profile counts
DELETE FROM audit_events WHERE performed_by = '${OPB}';
DELETE FROM operator_assignments WHERE operator_id = '${OPB}';
DELETE FROM perfiles WHERE id = '${OPB}';
DELETE FROM auth.users WHERE id = '${OPB}';
UPDATE management_period SET status = 'OPEN', closed_at = NULL
 WHERE periodo_fecha IN (${CLOSED_BY_SUITE.map((m) => `'${m}'`).join(',')});`);
}

cleanup();   // first: remove leftovers of an earlier run
owner(`
INSERT INTO auth.users (id, is_sso_user, is_anonymous) VALUES
  ('${ADMIN_UID}', false, false), ('${OPA}', false, false), ('${OPB}', false, false),
  ('${INACTIVE_UID}', false, false), ('${NOPROFILE_UID}', false, false)
ON CONFLICT (id) DO NOTHING;
INSERT INTO perfiles (id, email, rol_type, activo) VALUES
  ('${ADMIN_UID}', 'admin@test.local', 'ADMIN', true),
  ('${OPA}', 'operator@test.local', 'OPERATOR', true),
  ('${OPB}', 'operator-p20@test.local', 'OPERATOR', true),
  ('${INACTIVE_UID}', 'inactive@test.local', 'OPERATOR', false)
ON CONFLICT (id) DO NOTHING;`);

// ── helpers ────────────────────────────────────────────────────────────────
let keySeq = 0;
const newKey = () => `${KEY_PREFIX}${String(++keySeq).padStart(4, '0')}`;
const q = (v) => (v === null || v === undefined ? 'NULL' : `'${v}'`);
const n = (v) => (v === null || v === undefined ? 'NULL' : String(v));

const mfgCall = (fv, date, qty, key, batch = null, reason = null) =>
  `register_feed_manufacturing(${q(fv)}, ${q(date)}, ${n(qty)}, ${q(key)}, ${q(batch)}, ${q(reason)})`;
const countCall = (ft, date, qty, reason = null) => `register_feed_inventory_count(${q(ft)}, ${q(date)}, ${n(qty)}, ${q(reason)})`;
const movCall = (ft, type, qty, date, pedido = null, reason = null) =>
  `register_feed_movement(${q(ft)}, ${q(type)}, ${n(qty)}, ${q(date)}, ${q(pedido)}, ${q(reason)})`;
const assignCall = (flock, ft, from, reason = null) => `assign_flock_feed(${q(flock)}, ${q(ft)}, ${q(from)}, ${q(reason)})`;
const manufacture = (fn, fv, date, qty, batch = null, reason = null) => {
  const key = newKey();
  return { key, ...rpcAs(fn, mfgCall(fv, date, qty, key, batch, reason)) };
};

// master path (ADMIN, RLS INSERT policies)
const feedType = (name, category = 'LAYER', activo = true) =>
  okAs(ADMIN, `INSERT INTO feed_type (nombre, feed_category, activo) VALUES ('${TAG} ${name}', '${category}', ${activo}) RETURNING id;`);
const ingredient = (name) => okAs(ADMIN, `INSERT INTO feed_ingredient (nombre) VALUES ('${TAG} ${name}') RETURNING id;`);
// [ADR-013] versions / lines have no application write path (RPC 48 only): fixtures are written by the owner
const version = (ft, v, from, to = null) => owner(`INSERT INTO feed_formula_version (feed_type_id, version, effective_from, effective_to, created_by)
  VALUES ('${ft}', ${v}, '${from}', ${q(to)}, '${ADMIN_UID}') RETURNING id;`);
const line = (fv, ing, kg, cost = null) => owner(`INSERT INTO feed_formula_line (formula_version_id, ingredient_id, quantity_kg, unit_cost_snapshot)
  VALUES ('${fv}', '${ing}', ${kg}, ${n(cost)}) RETURNING id;`);
let shedSeq = 0;
const flock = (name, initial = 1000, birth = BIRTH, entry = '2025-12-01') => {
  const shed = owner(`INSERT INTO sheds (nombre) VALUES ('${TAG} ${name} #${++shedSeq}') RETURNING id;`);
  return owner(`INSERT INTO flocks (shed_id, entry_date, initial_population, estado, genetics_line, birth_date)
    VALUES ('${shed}', '${entry}', ${initial}, 'ACTIVE', '${GENETICS}', '${birth}') RETURNING id;`);
};

const snapshot = () => owner(`SELECT concat_ws('|', ${TABLES.map((t) => `(SELECT count(*) FROM ${t})`).join(', ')}, (SELECT count(*) FROM audit_events));`);
const econ = () => owner(`SELECT concat_ws('|', (SELECT count(*) FROM financial_operation), (SELECT count(*) FROM financial_posting),
  (SELECT count(*) FROM client_ledger), (SELECT count(*) FROM supplier_ledger), (SELECT count(*) FROM purchases), (SELECT count(*) FROM purchase_line),
  (SELECT count(*) FROM pedidos), (SELECT count(*) FROM pedido_lineas), (SELECT count(*) FROM collections),
  (SELECT count(*) FROM daily_production), (SELECT count(*) FROM population_events), (SELECT count(*) FROM flocks));`);
const closePeriod = (m) => owner(`UPDATE management_period SET status = 'CLOSED', closed_at = NOW() WHERE periodo_fecha = '${m}';`);
const openPeriod = (m) => owner(`UPDATE management_period SET status = 'OPEN', closed_at = NULL WHERE periodo_fecha = '${m}';`);
const visible = (fn, t, where) => { const x2 = fn(`SELECT count(*) FROM ${t} WHERE ${where};`); return x2.ok ? x2.out : `ERR ${firstErr(x2)}`; };
const num = (s) => Number(s);

// ── canonical derivations (read-only; nothing is stored) ──────────────────
// OWNER RULE (count day): a feed_inventory_count dated D is the stock at the
// CLOSE of day D; every manufacturing / movement dated D happened before it.
// consumo interno for one feed type between two physical counts (d0 = opening
// count date, d1 = closing count date) therefore takes the flows dated in
// (d0, d1]: after the opening count's day, up to and including the closing day.
const internalSql = (ft, d0, d1) => `
SELECT (SELECT quantity_kg FROM feed_inventory_count WHERE feed_type_id = '${ft}' AND count_date = '${d0}')
     + coalesce((SELECT SUM(m.quantity_kg) FROM feed_manufacturing m JOIN feed_formula_version v ON v.id = m.formula_version_id
                  WHERE v.feed_type_id = '${ft}' AND m.manufacturing_date > '${d0}' AND m.manufacturing_date <= '${d1}'), 0)
     - coalesce((SELECT SUM(quantity_kg) FROM feed_movement WHERE feed_type_id = '${ft}' AND movement_date > '${d0}' AND movement_date <= '${d1}'
                  AND movement_type IN ('EXTERNAL_SALE','LOSS','ADJUSTMENT_NEGATIVE')), 0)
     + coalesce((SELECT SUM(quantity_kg) FROM feed_movement WHERE feed_type_id = '${ft}' AND movement_date > '${d0}' AND movement_date <= '${d1}'
                  AND movement_type = 'ADJUSTMENT_POSITIVE'), 0)
     - (SELECT quantity_kg FROM feed_inventory_count WHERE feed_type_id = '${ft}' AND count_date = '${d1}');`;
const internal = (ft, d0, d1) => num(owner(internalSql(ft, d0, d1)));

// OWNER RULES (theoretical consumption):
//   population(D)     = initial_population + current population_events with event_date <= D
//                       (a mortality / COUNT_ADJUSTMENT dated D already counts on D)
//   age_weeks_exact   = (D - birth_date) / 7.0
//   curve_age_weeks   = floor(age_weeks_exact)  -- never round, never ceil
// consumo teórico for one flock over [from, to], per assigned feed type (kg):
// population(D) × expected_g_per_bird_day(curve_age_weeks) with the feed type
// assigned on D.
const AGE_EXACT = (d, birth) => `((${d}) - (${birth})) / 7.0`;
const CURVE_AGE = (d, birth) => `floor(${AGE_EXACT(d, birth)})::INTEGER`;
const populationSql = (flockId, d) => `SELECT f.initial_population + coalesce((SELECT SUM(pe.delta) FROM population_events pe
  WHERE pe.flock_id = f.id AND pe.is_current AND pe.event_date <= '${d}'), 0) FROM flocks f WHERE f.id = '${flockId}';`;
const theoreticalSql = (flockId, from, to) => `
WITH days AS (SELECT d::DATE AS d FROM generate_series('${from}'::DATE, '${to}'::DATE, INTERVAL '1 day') d),
x AS (
  SELECT d.d, a.feed_type_id, f.genetics_line, ${CURVE_AGE('d.d', 'f.birth_date')} AS age_weeks,
         f.initial_population + coalesce((SELECT SUM(pe.delta) FROM population_events pe
                                           WHERE pe.flock_id = f.id AND pe.is_current AND pe.event_date <= d.d), 0) AS population
    FROM days d
    JOIN flocks f ON f.id = '${flockId}'
    JOIN flock_feed_assignment a ON a.flock_id = f.id AND a.effective_from <= d.d AND (a.effective_to IS NULL OR a.effective_to >= d.d))
SELECT coalesce(string_agg(ft.nombre || '=' || s.kg, ',' ORDER BY ft.nombre), '') FROM (
  SELECT x.feed_type_id, round(SUM(x.population * c.expected_g_per_bird_day) / 1000, 3) AS kg
    FROM x JOIN genetics_consumption_curve c ON c.genetics_line = x.genetics_line AND c.age_weeks = x.age_weeks
   GROUP BY x.feed_type_id) s JOIN feed_type ft ON ft.id = s.feed_type_id;`;
// independent JS computation of the same metric, from the curve definition g(w) = 80 + w
const gOf = (w) => 80 + w;
const dayMs = 86400000;
function jsTheoretical(from, to, population, feedOf) {
  const out = {};
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += dayMs) {
    const d = new Date(t).toISOString().slice(0, 10);
    const age = Math.floor((t - Date.parse(`${BIRTH}T00:00:00Z`)) / dayMs / 7);
    const ft = feedOf(d);
    out[ft] = (out[ft] || 0) + population * gOf(age);
  }
  return Object.keys(out).sort().map((k) => `${TAG} ${k}=${(out[k] / 1000).toFixed(3)}`).join(',');
}

let r;
let snap;
let x;
let econAtStart;

try {
// ── masters and fixtures (ADMIN master path / owner for flocks) ───────────
const T_MAIN = feedType('Ponedoras');
const T_RECRIA = feedType('Recria', 'PULLET');
const T_INACTIVE = feedType('Inactivo', 'LAYER', false);
const T_EQ = feedType('Equation');
const T_E2E = feedType('E2E Ponedoras');
const T_RACE = feedType('Race');
const MAIZ = ingredient('Maiz');
const SOJA = ingredient('Soja');
const NUCLEO = ingredient('Nucleo');
const CALCIO = ingredient('Calcio');
okAs(ADMIN, `INSERT INTO genetics_consumption_curve (genetics_line, age_weeks, expected_g_per_bird_day)
  SELECT '${GENETICS}', w, 80 + w FROM generate_series(0, 60) w;`);
const FX = flock('Galpon X');
const FY = flock('Galpon Y');
const FZ = flock('Galpon Z');
const FR = flock('Galpon R');
okAs(ADMIN, `INSERT INTO operator_assignments (operator_id, flock_id, assigned_by) VALUES ('${OPA}', '${FX}', '${ADMIN_UID}'), ('${OPA}', '${FY}', '${ADMIN_UID}');`);
const CLIENT = okAs(ADMIN, `INSERT INTO clients (nombre) VALUES ('${TAG} Cliente alimento') RETURNING id;`);
const PEDIDO = okAs(ADMIN, `INSERT INTO pedidos (cliente_id, created_by) VALUES ('${CLIENT}', '${ADMIN_UID}') RETURNING id;`);
// population fixtures through RPC 20 (before every feed window, so the population is unambiguous)
rpc(`register_mortality('${FX}', '2026-03-15', 10, 'P20 fixture')`);
rpc(`register_mortality('${FY}', '2026-01-20', 10, 'P20 fixture')`);
// temporal-semantics fixtures (group W): same-day population events, age boundaries
const FM = flock('Galpon M', 2700);
rpc(`register_mortality('${FM}', '2026-05-10', 5, 'mortandad del día')`);
rpc(`register_count_adjustment('${FM}', '2026-05-12', 3, 'recuento')`);
const FA = flock('Galpon A', 100, '2026-09-25', '2026-09-25');
econAtStart = econ();

// ═══════════════════════════════════════════════════════════════════════════
section('A', 'Structure');

const colsOf = (t) => owner(`SELECT string_agg(column_name || ':' || data_type, ',' ORDER BY ordinal_position) FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = '${t}';`);
check('A1 the six Phase 20 tables exist; feed_type / feed_ingredient / genetics_consumption_curve reused (one each)',
  owner(`SELECT string_agg(table_name, ',' ORDER BY table_name) FROM information_schema.tables WHERE table_schema = 'public'
    AND table_type = 'BASE TABLE' AND table_name IN (${TABLES.map((t) => `'${t}'`).join(',')}, 'feed_type','feed_ingredient','genetics_consumption_curve');`)
  === 'feed_formula_line,feed_formula_version,feed_ingredient,feed_inventory_count,feed_manufacturing,feed_movement,feed_type,flock_feed_assignment,genetics_consumption_curve');
const wantCols = {
  feed_formula_version: 'id:uuid,feed_type_id:uuid,version:integer,effective_from:date,effective_to:date,created_at:timestamp with time zone,created_by:uuid',
  feed_formula_line: 'id:uuid,formula_version_id:uuid,ingredient_id:uuid,quantity_kg:numeric,unit_cost_snapshot:numeric,created_at:timestamp with time zone',
  // + the ADR-014 version chain (0065)
  feed_manufacturing: 'id:uuid,formula_version_id:uuid,manufacturing_date:date,quantity_kg:numeric,batch_number:character varying,idempotency_key:character varying,created_at:timestamp with time zone,created_by:uuid,'
    + 'version_seq:integer,is_current:boolean,supersedes_id:uuid,rectification_reason:text',
  feed_movement: 'id:bigint,feed_type_id:uuid,movement_type:USER-DEFINED,quantity_kg:numeric,movement_date:date,pedido_id:uuid,reason:text,created_at:timestamp with time zone,created_by:uuid',
  feed_inventory_count: 'id:bigint,feed_type_id:uuid,count_date:date,quantity_kg:numeric,reason:text,created_at:timestamp with time zone,created_by:uuid',
  flock_feed_assignment: 'id:uuid,flock_id:uuid,feed_type_id:uuid,effective_from:date,effective_to:date,created_at:timestamp with time zone,created_by:uuid',
};
const badCols = Object.entries(wantCols).filter(([t, c]) => colsOf(t) !== c).map(([t]) => `${t}=${colsOf(t)}`);
check('A2 columns of all six tables exactly as frozen', badCols.length === 0, badCols.join(' ; '));
const precision = owner(`SELECT string_agg(table_name || '.' || column_name || ':' || numeric_precision || ',' || numeric_scale, ' ' ORDER BY table_name, column_name)
  FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN (${TABLES.map((t) => `'${t}'`).join(',')}) AND data_type = 'numeric';`);
check('A3 numeric precision: quantity_kg DECIMAL(15,3), unit_cost_snapshot NUMERIC(15,2); idempotency_key VARCHAR(100)',
  precision === 'feed_formula_line.quantity_kg:15,3 feed_formula_line.unit_cost_snapshot:15,2 feed_inventory_count.quantity_kg:15,3 '
  + 'feed_manufacturing.quantity_kg:15,3 feed_movement.quantity_kg:15,3'
  && owner(`SELECT character_maximum_length FROM information_schema.columns WHERE table_name = 'feed_manufacturing' AND column_name = 'idempotency_key';`) === '100', precision);
const cons = owner(`SELECT string_agg(conrelid::regclass || '.' || conname || ':' || contype::TEXT, ',' ORDER BY conrelid::regclass::TEXT, conname) FROM pg_constraint
  WHERE conrelid IN (${TABLES.map((t) => `'${t}'::regclass`).join(',')}) AND contype IN ('u','c');`);
check('A4 UNIQUE / CHECK constraints exactly as frozen + the ADR-014 manufacturing version chain',
  cons === 'feed_formula_line.feed_formula_line_formula_version_id_ingredient_id_key:u,feed_formula_line.feed_formula_line_quantity_kg_check:c,'
  + 'feed_formula_version.chk_formula_version_range:c,feed_formula_version.feed_formula_version_feed_type_id_version_key:u,feed_formula_version.feed_formula_version_version_check:c,'
  + 'feed_inventory_count.feed_inventory_count_feed_type_id_count_date_key:u,feed_inventory_count.feed_inventory_count_quantity_kg_check:c,'
  + 'feed_manufacturing.chk_feed_manufacturing_version_chain:c,feed_manufacturing.feed_manufacturing_idempotency_key_key:u,feed_manufacturing.feed_manufacturing_quantity_kg_check:c,'
  + 'feed_manufacturing.feed_manufacturing_supersedes_id_key:u,feed_manufacturing.feed_manufacturing_version_seq_check:c,'
  + 'feed_movement.feed_movement_quantity_kg_check:c,flock_feed_assignment.chk_flock_feed_range:c', cons);
const fks = owner(`SELECT string_agg(x, ',' ORDER BY x) FROM (
  SELECT c.conrelid::regclass || '.' || a.attname || '>' || c.confrelid::regclass || ':' || c.confdeltype::TEXT AS x
    FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
   WHERE c.contype = 'f' AND c.conrelid IN (${TABLES.map((t) => `'${t}'::regclass`).join(',')})) s;`);
check('A5 FKs exactly as frozen + the ADR-014 rectification self-reference, all ON DELETE RESTRICT',
  fks === 'feed_formula_line.formula_version_id>feed_formula_version:r,feed_formula_line.ingredient_id>feed_ingredient:r,'
  + 'feed_formula_version.created_by>perfiles:r,feed_formula_version.feed_type_id>feed_type:r,'
  + 'feed_inventory_count.created_by>perfiles:r,feed_inventory_count.feed_type_id>feed_type:r,'
  + 'feed_manufacturing.created_by>perfiles:r,feed_manufacturing.formula_version_id>feed_formula_version:r,feed_manufacturing.supersedes_id>feed_manufacturing:r,'
  + 'feed_movement.created_by>perfiles:r,feed_movement.feed_type_id>feed_type:r,feed_movement.pedido_id>pedidos:r,'
  + 'flock_feed_assignment.created_by>perfiles:r,flock_feed_assignment.feed_type_id>feed_type:r,flock_feed_assignment.flock_id>flocks:r', fks);
const idx = owner(`SELECT string_agg(indexname || '=' || regexp_replace(indexdef, '^.* USING ', ''), ' ; ' ORDER BY indexname) FROM pg_indexes
  WHERE indexname IN ('idx_feed_manufacturing_date','idx_feed_movement_type_date','idx_flock_feed_current');`);
check('A6 indexes: manufacturing_date; (feed_type_id, movement_date); UNIQUE current assignment per flock',
  idx === 'idx_feed_manufacturing_date=btree (manufacturing_date) ; idx_feed_movement_type_date=btree (feed_type_id, movement_date) ; '
  + 'idx_flock_feed_current=btree (flock_id) WHERE (effective_to IS NULL)'
  && owner(`SELECT indexdef LIKE 'CREATE UNIQUE%' FROM pg_indexes WHERE indexname = 'idx_flock_feed_current';`) === 't', idx);
check('A7 RLS enabled on all six tables', owner(`SELECT count(*) FROM pg_class WHERE relname IN (${TABLES.map((t) => `'${t}'`).join(',')}) AND relrowsecurity;`) === '6');
const viewCols = owner(`SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_name = 'feed_formula_line_safe';`);
const viewMeta = owner(`SELECT pg_get_userbyid(relowner) || '|' || coalesce(array_to_string(reloptions, ','), '') FROM pg_class WHERE relname = 'feed_formula_line_safe' AND relkind = 'v';`);
check('A8 safe view feed_formula_line_safe: exactly formula_version_id, ingredient_id, ingredient_name, quantity_kg; owner postgres; security_invoker=false',
  viewCols === 'formula_version_id,ingredient_id,ingredient_name,quantity_kg' && viewMeta === 'postgres|security_invoker=false', `${viewCols} / ${viewMeta}`);

// ═══════════════════════════════════════════════════════════════════════════
section('B', 'Formula versions (physical constraints; owner fixtures — ADR-013)');

const V1 = version(T_MAIN, 1, '2026-01-01', '2026-03-31');
const V2 = version(T_MAIN, 2, '2026-04-01');
check('B1 fixture v1 (2026-01-01 → 2026-03-31) and v2 (2026-04-01 → open) for one feed type',
  owner(`SELECT string_agg(version || ':' || effective_from || '→' || coalesce(effective_to::TEXT, 'open'), ',' ORDER BY version) FROM feed_formula_version WHERE feed_type_id = '${T_MAIN}';`)
  === '1:2026-01-01→2026-03-31,2:2026-04-01→open');
r = raw(`INSERT INTO feed_formula_version (feed_type_id, version, effective_from) VALUES ('${T_MAIN}', 0, '2026-01-01');`);
check('B2 version must be > 0', violates(r, 'feed_formula_version_version_check'), firstErr(r));
r = raw(`INSERT INTO feed_formula_version (feed_type_id, version, effective_from, effective_to) VALUES ('${T_MAIN}', 9, '2026-05-01', '2026-04-30');`);
check('B3 effective_to < effective_from rejected (chk_formula_version_range)', violates(r, 'chk_formula_version_range'), firstErr(r));
r = raw(`INSERT INTO feed_formula_version (feed_type_id, version, effective_from) VALUES ('${T_MAIN}', 2, '2026-06-01');`);
check('B4 UNIQUE(feed_type_id, version)', violates(r, 'feed_formula_version_feed_type_id_version_key'), firstErr(r));
r = A(`INSERT INTO feed_formula_version (feed_type_id, version, effective_from) VALUES ('${T_MAIN}', 7, '2026-06-01');`);
check('B5 OPERATOR cannot create a formula version (no INSERT grant — ADR-013)', denied(r), firstErr(r));
r = ADMIN(`INSERT INTO feed_formula_version (feed_type_id, version, effective_from) VALUES ('${T_MAIN}', 7, '2026-06-01');`);
check('B5b ADMIN has no direct INSERT on feed_formula_version either (ADR-013: RPC 48 only)', denied(r), firstErr(r));
r = raw(`INSERT INTO feed_formula_version (feed_type_id, version, effective_from) VALUES ('${T_MAIN}', 7, '2026-03-01');`);
check('B5c two versions of one feed type can never overlap, even for the owner (excl_feed_formula_version_no_overlap)', violates(r, 'excl_feed_formula_version_no_overlap'), firstErr(r));
const V_RECRIA = version(T_RECRIA, 1, '2026-01-01');
const V_EQ = version(T_EQ, 1, '2026-01-01');
const V_E2E_1 = version(T_E2E, 1, '2026-01-01', '2026-03-31');
const V_E2E_2 = version(T_E2E, 2, '2026-04-01');
const V_RACE = version(T_RACE, 1, '2026-01-01');
check('B6 versions are history: both versions of the feed type are kept side by side (no overwrite)',
  owner(`SELECT count(*) FROM feed_formula_version WHERE feed_type_id = '${T_MAIN}';`) === '2');

// ═══════════════════════════════════════════════════════════════════════════
section('C', 'Formula composition');

line(V1, MAIZ, 60, 150.00);
line(V1, SOJA, 30, 320.50);
line(V1, NUCLEO, 10, null);
line(V2, MAIZ, 55, 180.00);
line(V2, SOJA, 35, 350.00);
line(V2, NUCLEO, 10, 900.00);
for (const [fv, ing, kg, cost] of [[V_RECRIA, MAIZ, 70, 150], [V_EQ, MAIZ, 100, 150], [V_E2E_1, MAIZ, 100, 150], [V_E2E_2, SOJA, 100, 320], [V_RACE, MAIZ, 100, 1]]) line(fv, ing, kg, cost);
const composition = (fv) => owner(`SELECT string_agg(i.nombre || ':' || l.quantity_kg || ':' || coalesce(l.unit_cost_snapshot::TEXT, 'null'), ',' ORDER BY i.nombre)
  FROM feed_formula_line l JOIN feed_ingredient i ON i.id = l.ingredient_id WHERE l.formula_version_id = '${fv}';`);
const V1_COMPOSITION = composition(V1);
check('C1 composition per 100 kg batch stored by ingredient FK, with cost snapshot (NULL allowed)',
  V1_COMPOSITION === `${TAG} Maiz:60.000:150.00,${TAG} Nucleo:10.000:null,${TAG} Soja:30.000:320.50`, V1_COMPOSITION);
r = raw(`INSERT INTO feed_formula_line (formula_version_id, ingredient_id, quantity_kg) VALUES ('${V_RACE}', '${SOJA}', 0);`);
check('C2 quantity_kg must be > 0', violates(r, 'feed_formula_line_quantity_kg_check'), firstErr(r));
r = raw(`INSERT INTO feed_formula_line (formula_version_id, ingredient_id, quantity_kg) VALUES ('${V_RACE}', '${MAIZ}', 5);`);
check('C3 UNIQUE(formula_version_id, ingredient_id)', violates(r, 'feed_formula_line_formula_version_id_ingredient_id_key'), firstErr(r));
r = raw(`INSERT INTO feed_formula_line (formula_version_id, ingredient_id, quantity_kg) VALUES ('${V_RACE}', '${MISSING_UUID}', 5);`);
check('C4 ingredient must exist (FK to feed_ingredient)', violates(r, 'feed_formula_line_ingredient_id_fkey'), firstErr(r));
r = A(`INSERT INTO feed_formula_line (formula_version_id, ingredient_id, quantity_kg) VALUES ('${V_RACE}', '${SOJA}', 5);`);
check('C5 OPERATOR cannot insert composition (no INSERT grant — ADR-013)', denied(r), firstErr(r));
r = ADMIN(`INSERT INTO feed_formula_line (formula_version_id, ingredient_id, quantity_kg) VALUES ('${V_RACE}', '${SOJA}', 5);`);
check('C5b ADMIN has no direct INSERT on feed_formula_line either (ADR-013: RPC 48 only)', denied(r), firstErr(r));

// ═══════════════════════════════════════════════════════════════════════════
section('D', 'Manufacturing (RPC 26)');

let econ0 = econ();
const d1Key = newKey();
const d1 = rpc(mfgCall(V1, '2026-02-01', 500, d1Key, 'L-001', 'lote febrero'));
check('D1 ADMIN manufactures on 2026-02-01 with v1 → {manufacturing_id, quantity_kg}',
  !!d1.manufacturing_id && Number(d1.quantity_kg) === 500 && Object.keys(d1).length === 2, JSON.stringify(d1));
const mfgRow = (id) => owner(`SELECT formula_version_id || '|' || manufacturing_date || '|' || quantity_kg || '|' || coalesce(batch_number, '-') || '|' || idempotency_key || '|' || created_by
  FROM feed_manufacturing WHERE id = '${id}';`);
check('D2 the EXACT formula_version_id supplied is persisted, with date, quantity, batch, key and real actor',
  mfgRow(d1.manufacturing_id) === `${V1}|2026-02-01|500.000|L-001|${d1Key}|${ADMIN_UID}`, mfgRow(d1.manufacturing_id));
const d3 = manufacture(A, V2, '2026-04-01', 250.5);
const d3b = manufacture(B, V2, '2026-04-02', 10);
check('D3 OPERATOR manufactures (v2 on 2026-04-01); no flock assignment needed (operator B has none)',
  mfgRow(d3.manufacturing_id) === `${V2}|2026-04-01|250.500|-|${d3.key}|${OPA}` && mfgRow(d3b.manufacturing_id).endsWith(`|${OPB}`), mfgRow(d3.manufacturing_id));
r = asUser(INACTIVE_UID, `SELECT ${mfgCall(V2, '2026-04-03', 1, newKey())};`);
const rNp = asUser(NOPROFILE_UID, `SELECT ${mfgCall(V2, '2026-04-03', 1, newKey())};`);
check('D4 inactive / missing profile → USER_NOT_FOUND_OR_INACTIVE', raised(r, 'USER_NOT_FOUND_OR_INACTIVE') && raised(rNp, 'USER_NOT_FOUND_OR_INACTIVE'));
snap = snapshot();
for (const [what, call, code] of [
  ['quantity 0', mfgCall(V2, '2026-04-03', 0, newKey()), 'INVALID_QUANTITY'],
  ['negative quantity', mfgCall(V2, '2026-04-03', -5, newKey()), 'INVALID_QUANTITY'],
  ['NULL quantity', mfgCall(V2, '2026-04-03', null, newKey()), 'INVALID_QUANTITY'],
  ['missing formula version', mfgCall(MISSING_UUID, '2026-04-03', 1, newKey()), 'FORMULA_VERSION_NOT_FOUND'],
  ['NULL formula version', mfgCall(null, '2026-04-03', 1, newKey()), 'FORMULA_VERSION_NOT_FOUND'],
  ['v1 on 2026-04-01 (after effective_to)', mfgCall(V1, '2026-04-01', 1, newKey()), 'FORMULA_VERSION_NOT_EFFECTIVE'],
  ['v2 on 2026-03-31 (before effective_from)', mfgCall(V2, '2026-03-31', 1, newKey()), 'FORMULA_VERSION_NOT_EFFECTIVE'],
  ['NULL manufacturing_date', mfgCall(V2, null, 1, newKey()), 'BUSINESS_DATE_REQUIRED'],
]) {
  r = ADMIN(`SELECT ${call};`);
  check(`D5 ${what} → ${code}`, raised(r, code), firstErr(r));
}
r = ADMIN(`SELECT ${mfgCall(V2, '2026-04-03', 1, null)};`);
check('D6 NULL idempotency_key → rejected by the frozen NOT NULL column', violates(r, 'idempotency_key'), firstErr(r));
check('D7 every rejection was atomic: no manufacturing, no audit', snapshot() === snap);
const dEdge = manufacture(ADMIN, V1, '2026-03-31', 5);
check('D8 effectivity is inclusive: v1 on its effective_to (2026-03-31) is accepted', mfgRow(dEdge.manufacturing_id).startsWith(`${V1}|2026-03-31|`));
check('D9 audit CREATE: formula_version_id, manufacturing_date, quantity_kg, reason, actor',
  owner(`SELECT action || '|' || (after_values->>'formula_version_id') || '|' || (after_values->>'manufacturing_date') || '|' || (after_values->>'quantity_kg')
         || '|' || reason || '|' || performed_by FROM audit_events WHERE entity_type = 'feed_manufacturing' AND entity_id = '${d1.manufacturing_id}';`)
  === `CREATE|${V1}|2026-02-01|500|lote febrero|${ADMIN_UID}`);
snap = snapshot();
r = ADMIN(`SELECT ${mfgCall(V2, '2026-04-05', 999, d1Key)};`);
check('D10 sequential retry with the same idempotency_key → DUPLICATE_MANUFACTURING; nothing written',
  raised(r, 'DUPLICATE_MANUFACTURING') && snapshot() === snap && owner(`SELECT count(*) FROM feed_manufacturing WHERE idempotency_key = '${d1Key}';`) === '1', firstErr(r));
const bn1 = manufacture(ADMIN, V2, '2026-04-06', 1, 'L-SAME');
const bn2 = manufacture(ADMIN, V2, '2026-04-06', 2, 'L-SAME');
check('D11 batch_number is NOT an idempotency key: two manufacturings with the same batch_number, different keys, both persist',
  bn1.manufacturing_id !== bn2.manufacturing_id && owner(`SELECT count(*) FROM feed_manufacturing WHERE batch_number = 'L-SAME' AND idempotency_key LIKE '${KEY_PREFIX}%';`) === '2');
check('D12 no cost stored with manufacturing: no cost column; return and audit carry no cost',
  owner(`SELECT count(*) FROM information_schema.columns WHERE table_name = 'feed_manufacturing' AND column_name ~* '(cost|price|precio|amount|monto)';`) === '0'
  && !/cost/i.test(JSON.stringify(d1))
  && owner(`SELECT count(*) FROM audit_events WHERE entity_type = 'feed_manufacturing' AND after_values::TEXT ~* 'cost';`) === '0');
check('D13 no economic effect (ledgers, money, purchases, orders, production, flocks unchanged)', econ() === econ0);

// ═══════════════════════════════════════════════════════════════════════════
section('E', 'Inventory counts (RPC 27)');

econ0 = econ();
const e1 = rpc(countCall(T_MAIN, '2026-04-10', 1200.5, 'conteo silo'));
check('E1 ADMIN registers a count → {count_id}; row exact', typeof e1.count_id === 'number' && Object.keys(e1).length === 1
  && owner(`SELECT feed_type_id || '|' || count_date || '|' || quantity_kg || '|' || reason || '|' || created_by FROM feed_inventory_count WHERE id = ${e1.count_id};`)
  === `${T_MAIN}|2026-04-10|1200.500|conteo silo|${ADMIN_UID}`, JSON.stringify(e1));
const e2 = rpcAs(A, countCall(T_MAIN, '2026-04-11', 0));
check('E2 OPERATOR registers a count (operators perform physical counts); zero stock is valid',
  owner(`SELECT quantity_kg || '|' || created_by FROM feed_inventory_count WHERE id = ${e2.count_id};`) === `0.000|${OPA}`);
snap = snapshot();
for (const [what, call, code] of [
  ['negative quantity', countCall(T_MAIN, '2026-04-12', -1), 'INVALID_QUANTITY'],
  ['NULL quantity', countCall(T_MAIN, '2026-04-12', null), 'INVALID_QUANTITY'],
  ['NULL count_date', countCall(T_MAIN, null, 1), 'BUSINESS_DATE_REQUIRED'],
  ['same feed type and date again (ADMIN after OPERATOR)', countCall(T_MAIN, '2026-04-11', 7), 'DUPLICATE_COUNT'],
]) {
  r = ADMIN(`SELECT ${call};`);
  check(`E3 ${what} → ${code}`, raised(r, code), firstErr(r));
}
r = ADMIN(`SELECT ${countCall(MISSING_UUID, '2026-04-12', 1)};`);
check('E4 missing feed type → rejected by the frozen FK', violates(r, 'feed_inventory_count_feed_type_id_fkey'), firstErr(r));
check('E5 every rejection was atomic; the first count is unchanged', snapshot() === snap
  && owner(`SELECT quantity_kg FROM feed_inventory_count WHERE id = ${e2.count_id};`) === '0.000');
rpc(countCall(T_RECRIA, '2026-04-11', 5));
rpc(countCall(T_MAIN, '2026-04-13', 6));
check('E6 one count per (feed type, date): same date / other type and same type / other date are allowed',
  owner(`SELECT count(*) FROM feed_inventory_count WHERE (feed_type_id = '${T_RECRIA}' AND count_date = '2026-04-11') OR (feed_type_id = '${T_MAIN}' AND count_date = '2026-04-13');`) === '2');
check('E7 audit CREATE: feed_type_id, count_date, quantity_kg, reason, actor',
  owner(`SELECT action || '|' || (after_values->>'feed_type_id') || '|' || (after_values->>'count_date') || '|' || (after_values->>'quantity_kg') || '|' || reason || '|' || performed_by
         FROM audit_events WHERE entity_type = 'feed_inventory_count' AND entity_id = '${e1.count_id}';`) === `CREATE|${T_MAIN}|2026-04-10|1200.5|conteo silo|${ADMIN_UID}`);
const mfgBefore = owner(`SELECT count(*) || '|' || (SELECT count(*) FROM feed_movement) FROM feed_manufacturing;`);
rpc(countCall(T_MAIN, '2026-04-14', 50));
check('E8 a count is an observation: it alters no manufacturing, no movement and no other fact',
  owner(`SELECT count(*) || '|' || (SELECT count(*) FROM feed_movement) FROM feed_manufacturing;`) === mfgBefore && econ() === econ0);

// ═══════════════════════════════════════════════════════════════════════════
section('F', 'Feed movements (RPC 28, ADMIN only)');

econ0 = econ();
const pedidoBefore = owner(`SELECT estado || '|' || (SELECT count(*) FROM pedido_lineas WHERE pedido_id = '${PEDIDO}') FROM pedidos WHERE id = '${PEDIDO}';`);
snap = snapshot();
r = A(`SELECT ${movCall(T_MAIN, 'LOSS', 1, '2026-04-15', null, 'x')};`);
const rB = B(`SELECT ${movCall(T_MAIN, 'LOSS', 1, '2026-04-15', null, 'x')};`);
check('F1 OPERATOR → FORBIDDEN: ADMIN required; nothing written', raised(r, 'FORBIDDEN') && raised(rB, 'FORBIDDEN') && snapshot() === snap, firstErr(r));
const movs = {};
for (const [type, qty, pedido, reason] of [
  ['EXTERNAL_SALE', 100, PEDIDO, null], ['LOSS', 5, null, 'bolsa rota'],
  ['ADJUSTMENT_POSITIVE', 40, null, 'diferencia de pesaje'], ['ADJUSTMENT_NEGATIVE', 15, null, 'humedad'],
]) movs[type] = rpc(movCall(T_MAIN, type, qty, '2026-04-15', pedido, reason));
const movRows = owner(`SELECT string_agg(movement_type || ':' || quantity_kg || ':' || coalesce(pedido_id::TEXT, '-') || ':' || coalesce(reason, '-') || ':' || created_by, ',' ORDER BY movement_type::TEXT)
  FROM feed_movement WHERE id IN (${Object.values(movs).map((m) => m.movement_id).join(',')});`);
check('F2 each movement type is stored as a positive quantity with its type (EXTERNAL_SALE with Pedido, the rest with reason)',
  movRows === `ADJUSTMENT_NEGATIVE:15.000:-:humedad:${ADMIN_UID},ADJUSTMENT_POSITIVE:40.000:-:diferencia de pesaje:${ADMIN_UID},`
  + `EXTERNAL_SALE:100.000:${PEDIDO}:-:${ADMIN_UID},LOSS:5.000:-:bolsa rota:${ADMIN_UID}`
  && Object.values(movs).every((m) => typeof m.movement_id === 'number' && Object.keys(m).length === 1), movRows);
snap = snapshot();
for (const [what, call, code] of [
  ['EXTERNAL_SALE without Pedido', movCall(T_MAIN, 'EXTERNAL_SALE', 1, '2026-04-15'), 'PEDIDO_REQUIRED'],
  ['LOSS without reason', movCall(T_MAIN, 'LOSS', 1, '2026-04-15'), 'REASON_REQUIRED'],
  ['ADJUSTMENT_POSITIVE with blank reason', movCall(T_MAIN, 'ADJUSTMENT_POSITIVE', 1, '2026-04-15', null, '   '), 'REASON_REQUIRED'],
  ['ADJUSTMENT_NEGATIVE without reason', movCall(T_MAIN, 'ADJUSTMENT_NEGATIVE', 1, '2026-04-15'), 'REASON_REQUIRED'],
  ['quantity 0', movCall(T_MAIN, 'LOSS', 0, '2026-04-15', null, 'x'), 'INVALID_QUANTITY'],
  ['negative quantity', movCall(T_MAIN, 'LOSS', -3, '2026-04-15', null, 'x'), 'INVALID_QUANTITY'],
  ['NULL quantity', movCall(T_MAIN, 'LOSS', null, '2026-04-15', null, 'x'), 'INVALID_QUANTITY'],
  ['NULL movement_date', movCall(T_MAIN, 'LOSS', 1, null, null, 'x'), 'BUSINESS_DATE_REQUIRED'],
]) {
  r = ADMIN(`SELECT ${call};`);
  check(`F3 ${what} → ${code}`, raised(r, code), firstErr(r));
}
r = ADMIN(`SELECT ${movCall(T_MAIN, 'TRANSFER', 1, '2026-04-15', null, 'x')};`);
check('F4 movement_type outside the frozen enum is rejected', !r.ok && /invalid input value for enum feed_movement_type/.test(r.err), firstErr(r));
r = ADMIN(`SELECT ${movCall(T_MAIN, 'EXTERNAL_SALE', 1, '2026-04-15', MISSING_UUID)};`);
check('F5 EXTERNAL_SALE with a nonexistent Pedido → rejected by the frozen FK', violates(r, 'feed_movement_pedido_id_fkey'), firstErr(r));
check('F6 every rejection was atomic', snapshot() === snap);
check('F7 audit CREATE: feed_type_id, movement_type, quantity_kg, movement_date, reason, actor',
  owner(`SELECT action || '|' || (after_values->>'movement_type') || '|' || (after_values->>'quantity_kg') || '|' || (after_values->>'movement_date') || '|' || reason || '|' || performed_by
         FROM audit_events WHERE entity_type = 'feed_movement' AND entity_id = '${movs.LOSS.movement_id}';`) === `CREATE|LOSS|5|2026-04-15|bolsa rota|${ADMIN_UID}`);
check('F8 sign is NOT stored: quantity_kg CHECK > 0 and no sign / direction column (the stock equation derives the sign from movement_type)',
  owner(`SELECT count(*) FROM information_schema.columns WHERE table_name = 'feed_movement' AND column_name ~* '(sign|direction|delta)';`) === '0'
  && owner(`SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'feed_movement_quantity_kg_check';`) === 'CHECK ((quantity_kg > (0)::numeric))');
check('F9 the economic sale is the Pedido: the external-sale movement leaves the Pedido, its lines and every ledger untouched',
  owner(`SELECT estado || '|' || (SELECT count(*) FROM pedido_lineas WHERE pedido_id = '${PEDIDO}') FROM pedidos WHERE id = '${PEDIDO}';`) === pedidoBefore && econ() === econ0);

// ═══════════════════════════════════════════════════════════════════════════
section('G', 'Flock feed assignment (RPC 29, ADMIN only)');

snap = snapshot();
r = A(`SELECT ${assignCall(FY, T_MAIN, '2026-01-01')};`);
check('G1 OPERATOR → FORBIDDEN: ADMIN required', raised(r, 'FORBIDDEN') && snapshot() === snap, firstErr(r));
for (const [what, call, code] of [
  ['missing flock', assignCall(MISSING_UUID, T_MAIN, '2026-01-01'), 'FLOCK_NOT_FOUND'],
  ['NULL flock', assignCall(null, T_MAIN, '2026-01-01'), 'FLOCK_NOT_FOUND'],
  ['inactive feed type', assignCall(FY, T_INACTIVE, '2026-01-01'), 'FEED_TYPE_NOT_FOUND_OR_INACTIVE'],
  ['missing feed type', assignCall(FY, MISSING_UUID, '2026-01-01'), 'FEED_TYPE_NOT_FOUND_OR_INACTIVE'],
]) {
  r = ADMIN(`SELECT ${call};`);
  check(`G2 ${what} → ${code}`, raised(r, code), firstErr(r));
}
check('G3 rejections atomic', snapshot() === snap);
const g1 = rpc(assignCall(FY, T_MAIN, '2026-01-01', 'arranque'));
const g2 = rpc(assignCall(FY, T_RECRIA, '2026-02-15', 'cambio de ración'));
const history = (f) => owner(`SELECT string_agg(ft.nombre || ':' || a.effective_from || '→' || coalesce(a.effective_to::TEXT, 'current'), ',' ORDER BY a.effective_from)
  FROM flock_feed_assignment a JOIN feed_type ft ON ft.id = a.feed_type_id WHERE a.flock_id = '${f}';`);
check('G4 Feed A 2026-01-01 → 2026-02-14, Feed B 2026-02-15 → current: previous closed at effective_from - 1, old row kept',
  history(FY) === `${TAG} Ponedoras:2026-01-01→2026-02-14,${TAG} Recria:2026-02-15→current`
  && owner(`SELECT count(*) FROM flock_feed_assignment WHERE id IN ('${g1.assignment_id}','${g2.assignment_id}');`) === '2', history(FY));
check('G5 exactly one current assignment per flock', owner(`SELECT count(*) FROM flock_feed_assignment WHERE flock_id = '${FY}' AND effective_to IS NULL;`) === '1');
check('G6 audit ASSIGN: flock_id, feed_type_id, effective_from, reason, actor',
  owner(`SELECT action || '|' || (after_values->>'flock_id') || '|' || (after_values->>'feed_type_id') || '|' || (after_values->>'effective_from') || '|' || reason || '|' || performed_by
         FROM audit_events WHERE entity_type = 'flock_feed_assignment' AND entity_id = '${g2.assignment_id}';`) === `ASSIGN|${FY}|${T_RECRIA}|2026-02-15|cambio de ración|${ADMIN_UID}`);
snap = snapshot();
r = ADMIN(`SELECT ${assignCall(FY, T_MAIN, '2026-02-15')};`);
check('G7 a replacement not after the current effective_from cannot close it validly → rejected by chk_flock_feed_range; history intact',
  violates(r, 'chk_flock_feed_range') && snapshot() === snap && history(FY) === `${TAG} Ponedoras:2026-01-01→2026-02-14,${TAG} Recria:2026-02-15→current`, firstErr(r));
r = raw(`INSERT INTO flock_feed_assignment (flock_id, feed_type_id, effective_from) VALUES ('${FY}', '${T_MAIN}', '2026-09-01');`);
check('G8 physical backstop: a second current row for one flock violates idx_flock_feed_current (even for the owner)', violates(r, 'idx_flock_feed_current'), firstErr(r));
check('G9 flocks store no current feed type (the assignment table is the only source)',
  owner(`SELECT count(*) FROM information_schema.columns WHERE table_name = 'flocks' AND column_name ~* '(feed|alimento|ration|racion)';`) === '0');

// ═══════════════════════════════════════════════════════════════════════════
section('T', 'Periods (determinant = the business date; created_at never decides)');

closePeriod('2026-03-01');
snap = snapshot();
for (const [what, fn, call] of [
  ['RPC 26 manufacturing_date (ADMIN)', ADMIN, mfgCall(V1, '2026-03-10', 1, newKey())],
  ['RPC 26 manufacturing_date (OPERATOR)', A, mfgCall(V1, '2026-03-10', 1, newKey())],
  ['RPC 27 count_date (ADMIN)', ADMIN, countCall(T_MAIN, '2026-03-10', 1)],
  ['RPC 27 count_date (OPERATOR)', A, countCall(T_MAIN, '2026-03-10', 1)],
  ['RPC 28 movement_date', ADMIN, movCall(T_MAIN, 'LOSS', 1, '2026-03-10', null, 'x')],
]) {
  r = fn(`SELECT ${call};`);
  check(`T1 CLOSED month → PERIOD_CLOSED: ${what}`, raised(r, 'PERIOD_CLOSED'), firstErr(r));
}
check('T2 CLOSED rejections wrote nothing', snapshot() === snap);
const tAssign = rpc(assignCall(FZ, T_MAIN, '2026-03-10', 'mes cerrado'));
check('T3 RPC 29 has no period guard: an assignment effective in a CLOSED month is accepted', !!tAssign.assignment_id);
openPeriod('2026-03-01');
snap = snapshot();
for (const [what, call] of [
  ['RPC 26', mfgCall(V2, '2027-02-10', 1, newKey())],
  ['RPC 27', countCall(T_MAIN, '2027-02-10', 1)],
  ['RPC 28', movCall(T_MAIN, 'LOSS', 1, '2027-02-10', null, 'x')],
]) {
  r = ADMIN(`SELECT ${call};`);
  check(`T4 date without a management_period → PERIOD_NOT_FOUND: ${what}`, raised(r, 'PERIOD_NOT_FOUND'), firstErr(r));
}
check('T5 missing-period rejections wrote nothing', snapshot() === snap);
const tAssign2 = rpc(assignCall(FZ, T_RECRIA, '2027-02-10', 'sin período'));
check('T6 RPC 29 accepts an effective_from without any management_period (master assignment)', !!tAssign2.assignment_id);
closePeriod(CURRENT_MONTH);
const tm = manufacture(ADMIN, V2, '2026-05-05', 3);
const tc = rpc(countCall(T_MAIN, '2026-05-05', 3));
const tmv = rpc(movCall(T_MAIN, 'LOSS', 3, '2026-05-05', null, 'x'));
check(`T7 created_at irrelevant: current month ${CURRENT_MONTH} CLOSED, business dates in OPEN May → all three RPCs accepted`,
  !!tm.manufacturing_id && !!tc.count_id && !!tmv.movement_id);
openPeriod(CURRENT_MONTH);

// ═══════════════════════════════════════════════════════════════════════════
section('V', 'Formula immutability once used');

check('V0 v1 is used: referenced by manufacturing', owner(`SELECT count(*) > 0 FROM feed_manufacturing WHERE formula_version_id = '${V1}';`) === 't');
r = ADMIN(`INSERT INTO feed_formula_line (formula_version_id, ingredient_id, quantity_kg, unit_cost_snapshot) VALUES ('${V1}', '${CALCIO}', 2, 5);`);
check('V1 ADMIN has no path to add composition to a USED version (no INSERT grant — ADR-013)', denied(r), firstErr(r));
r = raw(`INSERT INTO feed_formula_line (formula_version_id, ingredient_id, quantity_kg) VALUES ('${V1}', '${CALCIO}', 2);`);
check('V2 the guard holds even for the table owner', raised(r, 'FORMULA_VERSION_IN_USE'), firstErr(r));
snap = snapshot();
const mutations = [
  ADMIN(`UPDATE feed_formula_line SET quantity_kg = 99 WHERE formula_version_id = '${V1}';`),
  ADMIN(`UPDATE feed_formula_line SET unit_cost_snapshot = 1 WHERE formula_version_id = '${V1}';`),
  ADMIN(`DELETE FROM feed_formula_line WHERE formula_version_id = '${V1}';`),
  ADMIN(`UPDATE feed_formula_version SET effective_to = '2026-12-31' WHERE id = '${V1}';`),
  ADMIN(`DELETE FROM feed_formula_version WHERE id = '${V_RACE}';`),
  ADMIN(`UPDATE feed_formula_line SET quantity_kg = 99 WHERE formula_version_id = '${V_RACE}';`),
  A(`UPDATE feed_formula_line SET quantity_kg = 99;`),
  A(`DELETE FROM feed_formula_version;`),
  ADMIN(`TRUNCATE feed_formula_line;`),
];
check('V3 no UPDATE / DELETE / TRUNCATE on formula versions or lines for ADMIN or OPERATOR (used or unused)',
  mutations.every(denied) && snapshot() === snap, mutations.map((m) => (denied(m) ? 'd' : 'OPEN')).join(','));
const repoint = [
  ADMIN(`UPDATE feed_manufacturing SET formula_version_id = '${V2}' WHERE id = '${d1.manufacturing_id}';`),
  A(`UPDATE feed_manufacturing SET formula_version_id = '${V2}' WHERE id = '${d1.manufacturing_id}';`),
];
check('V4 manufacturing cannot be repointed to another version (ADMIN and OPERATOR)', repoint.every(denied), repoint.map(firstErr).join(' | '));
// owner probe, never committed: even with its composition removed first, the version is held by manufacturing
r = raw(`BEGIN; DELETE FROM feed_formula_line WHERE formula_version_id = '${V1}'; DELETE FROM feed_formula_version WHERE id = '${V1}'; ROLLBACK;`);
check('V5 a used version cannot be deleted even by the owner (FK RESTRICT from feed_manufacturing; probe rolled back)',
  violates(r, 'feed_manufacturing_formula_version_id_fkey') && composition(V1) === V1_COMPOSITION, firstErr(r));
const V_UNUSED = version(feedType('Unused'), 1, '2026-06-01');   // own feed type: versions of one type never overlap (ADR-013)
line(V_UNUSED, SOJA, 50, 10);
check('V6 an UNUSED version still accepts composition before first use (physical guard only fires once used)',
  owner(`SELECT count(*) FROM feed_formula_line WHERE formula_version_id = '${V_UNUSED}';`) === '1');
check('V7 history exact: the 2026-02-01 manufacturing still points to v1, and v1 composition (incl. cost) is byte-identical',
  mfgRow(d1.manufacturing_id).startsWith(`${V1}|2026-02-01|`) && composition(V1) === V1_COMPOSITION, composition(V1));

// ═══════════════════════════════════════════════════════════════════════════
section('H', 'Internal consumption — derived from the stock equation');

// June window for T_EQ: opening count 2026-06-01, closing count 2026-06-30.
rpcAs(A, countCall(T_EQ, '2026-06-01', 1000));
manufacture(A, V_EQ, '2026-06-10', 500);
rpc(movCall(T_EQ, 'EXTERNAL_SALE', 100, '2026-06-12', PEDIDO));
rpc(movCall(T_EQ, 'ADJUSTMENT_POSITIVE', 40, '2026-06-15', null, 'recuento de bolsas'));
rpc(movCall(T_EQ, 'ADJUSTMENT_NEGATIVE', 15, '2026-06-16', null, 'humedad'));
rpc(movCall(T_EQ, 'LOSS', 5, '2026-06-17', null, 'derrame'));
rpcAs(A, countCall(T_EQ, '2026-06-30', 900));
// noise outside the window or of another feed type
manufacture(ADMIN, V_EQ, '2026-05-20', 999);
rpc(movCall(T_MAIN, 'LOSS', 77, '2026-06-20', null, 'otro tipo'));
manufacture(ADMIN, V2, '2026-06-20', 333);
snap = snapshot();
const hVal = internal(T_EQ, '2026-06-01', '2026-06-30');
check('H1 consumo interno = 1000 + 500 − 100 (external sale) + 40 (adj +) − 15 (adj −) − 5 (loss) − 900 = 520', hVal === 520, hVal);
check('H2 feed type and window boundaries: manufacturing of 2026-05-20 (before the opening count) and June facts of other feed types are excluded',
  hVal === 520 && internal(T_EQ, '2026-06-01', '2026-06-30') === 1000 + 500 - 100 + 40 - 15 - 5 - 900);
r = raw(`BEGIN; UPDATE feed_inventory_count SET quantity_kg = 800 WHERE feed_type_id = '${T_EQ}' AND count_date = '2026-06-30'; ${internalSql(T_EQ, '2026-06-01', '2026-06-30')} ROLLBACK;`);
check('H3 the result depends on the closing count: with 800 instead of 900 it derives 620 (probe transaction, rolled back)',
  r.ok && num(r.out) === 620 && internal(T_EQ, '2026-06-01', '2026-06-30') === 520, r.out || r.err);
check('H4 deriving wrote nothing (the result is never stored)', snapshot() === snap);
check('H5 no stored consumption object: no table or view named *consum* / *consumo* except the reference curve',
  owner(`SELECT coalesce(string_agg(table_name, ','), '') FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* '(consum|consumo)' AND table_name NOT IN (${ADR005_VIEWS});`)
  === 'genetics_consumption_curve');
check('H6 no correction / supersede path invented for counts: the only feed functions are RPCs 26–29, RPC 48 publish_feed_formula_version (ADR-013), RPC 49 rectify_feed_manufacturing (ADR-014) and the immutability trigger function',
  owner(`SELECT string_agg(proname, ',' ORDER BY proname) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname ~* '(feed|formula|consum)';`)
  === 'assign_flock_feed,publish_feed_formula_version,rectify_feed_manufacturing,register_feed_inventory_count,register_feed_manufacturing,register_feed_movement,reject_line_on_used_formula_version');

// ═══════════════════════════════════════════════════════════════════════════
section('I', 'Theoretical consumption — derived from curve × population × assignment');

snap = snapshot();
const popFY = owner(`SELECT initial_population + (SELECT coalesce(SUM(delta), 0) FROM population_events WHERE flock_id = '${FY}' AND is_current) FROM flocks WHERE id = '${FY}';`);
check('I1 population comes from Phase 18 facts: 1000 initial + current events (−10) = 990', popFY === '990', popFY);
const ageRow = (d) => owner(`SELECT ('${d}'::DATE - birth_date) / 7 || ':' || c.expected_g_per_bird_day FROM flocks f
  JOIN genetics_consumption_curve c ON c.genetics_line = f.genetics_line AND c.age_weeks = ('${d}'::DATE - f.birth_date) / 7 WHERE f.id = '${FY}';`);
check('I2 age = completed weeks since birth_date: 2026-02-01 (day 118) → week 16 (96 g), 2026-02-02 (day 119) → week 17 (97 g)',
  ageRow('2026-02-01') === '16:96.000' && ageRow('2026-02-02') === '17:97.000', `${ageRow('2026-02-01')} / ${ageRow('2026-02-02')}`);
const iVal = owner(theoreticalSql(FY, '2026-02-01', '2026-02-28'));
const iJs = jsTheoretical('2026-02-01', '2026-02-28', 990, (d) => (d <= '2026-02-14' ? 'Ponedoras' : 'Recria'));
check('I3 February, flock Y: attributed to Ponedoras for 01–14 and to Recria for 15–28 (the assignment in force each day); equals an independent computation',
  iVal === iJs, `${iVal} vs ${iJs}`);
const oneDay = (d) => owner(theoreticalSql(FY, d, d));
check('I4 boundary day (both in week 18, 98 g): 2026-02-14 → Ponedoras only, 2026-02-15 → Recria only',
  oneDay('2026-02-14') === `${TAG} Ponedoras=${(990 * 98 / 1000).toFixed(3)}` && oneDay('2026-02-15') === `${TAG} Recria=${(990 * 98 / 1000).toFixed(3)}`,
  `${oneDay('2026-02-14')} / ${oneDay('2026-02-15')}`);
check('I5 a day without an assignment yields no theoretical consumption (nothing inferred): 2025-12-31 for flock Y',
  owner(theoreticalSql(FY, '2025-12-31', '2025-12-31')) === '');
check('I6 deriving wrote nothing; the curve is reference data (expected_g_per_bird_day), not a fact of delivered or consumed feed',
  snapshot() === snap && colsOf('genetics_consumption_curve') === 'id:uuid,genetics_line:character varying,age_weeks:integer,expected_g_per_bird_day:numeric,expected_laying_pct:numeric,created_at:timestamp with time zone');

// ═══════════════════════════════════════════════════════════════════════════
section('J', 'Cost protection');

check('J1 ADMIN reads the full composition including unit_cost_snapshot from the base table',
  visible(ADMIN, 'feed_formula_line', `formula_version_id = '${V1}' AND unit_cost_snapshot IN (150.00, 320.50)`) === '2');
check('J2 OPERATOR reads 0 rows from the base table (cost hidden), for every version',
  visible(A, 'feed_formula_line', 'true') === '0' && visible(B, 'feed_formula_line', 'unit_cost_snapshot IS NOT NULL') === '0');
const safeOp = okAs(A, `SELECT string_agg(ingredient_name || ':' || quantity_kg, ',' ORDER BY ingredient_name) FROM feed_formula_line_safe WHERE formula_version_id = '${V1}';`);
check('J3 OPERATOR reads the composition through feed_formula_line_safe (ingredient, name, quantity)',
  safeOp === `${TAG} Maiz:60.000,${TAG} Nucleo:10.000,${TAG} Soja:30.000`, safeOp);
r = A(`SELECT unit_cost_snapshot FROM feed_formula_line_safe;`);
check('J4 the safe view has no cost column: selecting unit_cost_snapshot fails', !r.ok && /column "unit_cost_snapshot" does not exist/.test(r.err), firstErr(r));
check('J5 the view definition does not reference the cost column at all (no indirect leak through expressions)',
  !/cost/i.test(owner(`SELECT pg_get_viewdef('feed_formula_line_safe'::regclass);`)));
check('J6 ADMIN also reads the safe view (same composition)', okAs(ADMIN, `SELECT count(*) FROM feed_formula_line_safe WHERE formula_version_id = '${V1}';`) === '3');
check('J7 anon and service_role: no SELECT on the view or the formula tables', [asAnon(`SELECT 1 FROM feed_formula_line_safe;`), asAnon(`SELECT 1 FROM feed_formula_line;`),
  asServiceRole(`SELECT 1 FROM feed_formula_line_safe;`), asServiceRole(`SELECT 1 FROM feed_formula_line;`), asServiceRole(`SELECT 1 FROM feed_formula_version;`)].every(denied));
check('J8 no cost reaches OPERATOR through other paths: manufacturing audit rows visible to the operator carry no cost key',
  okAs(A, `SELECT count(*) FROM audit_events WHERE entity_type = 'feed_manufacturing';`) !== '0'
  && okAs(A, `SELECT count(*) FROM audit_events WHERE entity_type = 'feed_manufacturing' AND after_values::TEXT ~* 'cost';`) === '0');
const effectiveNow = owner(`SELECT count(*) FROM feed_formula_version WHERE feed_type_id IN ${FT}
  AND effective_from <= CURRENT_DATE AND (effective_to IS NULL OR effective_to >= CURRENT_DATE);`);
// [ADR-014] 0067: OPERATOR reads every version row (the exact version of historical manufacturing); still no cost line
void effectiveNow;
check('J9 OPERATOR and ADMIN see every formula version (ADR-014 / 0067: historical versions, no cost column)',
  visible(A, 'feed_formula_version', `feed_type_id IN ${FT}`) === owner(`SELECT count(*) FROM feed_formula_version WHERE feed_type_id IN ${FT};`)
  && visible(A, 'feed_formula_version', `id = '${V1}'`) === '1' && visible(A, 'feed_formula_version', `id = '${V2}'`) === '1'
  && visible(ADMIN, 'feed_formula_version', `feed_type_id IN ${FT}`) === owner(`SELECT count(*) FROM feed_formula_version WHERE feed_type_id IN ${FT};`), effectiveNow);

// ═══════════════════════════════════════════════════════════════════════════
section('K', 'RLS / privileges');

const allMfg = owner(`SELECT count(*) FROM feed_manufacturing;`);
check('K1 feed_manufacturing: ADMIN and every OPERATOR read all operational rows (no cost column exists there)',
  visible(ADMIN, 'feed_manufacturing', 'true') === allMfg && visible(A, 'feed_manufacturing', 'true') === allMfg && visible(B, 'feed_manufacturing', 'true') === allMfg);
const allCounts = owner(`SELECT count(*) FROM feed_inventory_count;`);
check('K2 feed_inventory_count: ADMIN and OPERATOR read (operators perform the counts)',
  visible(ADMIN, 'feed_inventory_count', 'true') === allCounts && visible(A, 'feed_inventory_count', 'true') === allCounts);
check('K3 feed_movement: ADMIN reads, OPERATOR reads nothing',
  visible(ADMIN, 'feed_movement', `feed_type_id IN ${FT}`) === owner(`SELECT count(*) FROM feed_movement WHERE feed_type_id IN ${FT};`)
  && visible(A, 'feed_movement', 'true') === '0' && visible(B, 'feed_movement', 'true') === '0');
check('K4 flock_feed_assignment: ADMIN all; operator A only its assigned flocks (Y), not Z; operator B (no assignment) nothing',
  visible(ADMIN, 'flock_feed_assignment', `flock_id IN ('${FY}','${FZ}')`) === '4' && visible(A, 'flock_feed_assignment', `flock_id = '${FY}'`) === '2'
  && visible(A, 'flock_feed_assignment', `flock_id = '${FZ}'`) === '0' && visible(B, 'flock_feed_assignment', 'true') === '0');
snap = snapshot();
const direct = [
  A(`INSERT INTO feed_manufacturing (formula_version_id, manufacturing_date, quantity_kg, idempotency_key) VALUES ('${V2}', '2026-04-20', 1, '${newKey()}');`),
  A(`INSERT INTO feed_inventory_count (feed_type_id, count_date, quantity_kg) VALUES ('${T_MAIN}', '2026-04-20', 1);`),
  A(`UPDATE feed_inventory_count SET quantity_kg = 1;`),
  A(`DELETE FROM feed_manufacturing;`),
  ADMIN(`INSERT INTO feed_movement (feed_type_id, movement_type, quantity_kg, movement_date, reason) VALUES ('${T_MAIN}', 'LOSS', 1, '2026-04-20', 'x');`),
  ADMIN(`UPDATE feed_movement SET quantity_kg = 1;`),
  ADMIN(`DELETE FROM feed_movement;`),
  ADMIN(`UPDATE feed_inventory_count SET quantity_kg = 1;`),
  ADMIN(`INSERT INTO flock_feed_assignment (flock_id, feed_type_id, effective_from) VALUES ('${FZ}', '${T_MAIN}', '2026-12-01');`),
  ADMIN(`UPDATE flock_feed_assignment SET effective_to = NULL;`),
  ADMIN(`DELETE FROM flock_feed_assignment;`),
  ADMIN(`TRUNCATE feed_manufacturing, feed_movement, feed_inventory_count, flock_feed_assignment;`),
];
check('K5 no direct INSERT / UPDATE / DELETE / TRUNCATE on the four fact tables for OPERATOR or ADMIN (RPCs 26–29 only)',
  direct.every(denied) && snapshot() === snap, direct.map((d) => (denied(d) ? 'd' : 'OPEN')).join(','));
const acl = owner(`SELECT string_agg(relname || '=' || relacl::TEXT, ' ' ORDER BY relname) FROM pg_class
  WHERE relname IN (${TABLES.map((t) => `'${t}'`).join(',')}, 'feed_formula_line_safe');`);
check('K6 exact ACLs: authenticated SELECT on facts, on the two formula tables (ADR-013: no INSERT) and on the safe view; nothing else',
  acl === 'feed_formula_line={postgres=arwdDxtm/postgres,authenticated=r/postgres} feed_formula_line_safe={postgres=arwdDxtm/postgres,authenticated=r/postgres} '
  + 'feed_formula_version={postgres=arwdDxtm/postgres,authenticated=r/postgres} feed_inventory_count={postgres=arwdDxtm/postgres,authenticated=r/postgres} '
  + 'feed_manufacturing={postgres=arwdDxtm/postgres,authenticated=r/postgres} feed_movement={postgres=arwdDxtm/postgres,authenticated=r/postgres} '
  + 'flock_feed_assignment={postgres=arwdDxtm/postgres,authenticated=r/postgres}', acl);
check('K7 sequences feed_movement_id_seq / feed_inventory_count_id_seq grant nothing to application roles',
  owner(`SELECT count(*) FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('s', c.relowner))) a WHERE c.relname IN ('feed_movement_id_seq','feed_inventory_count_id_seq')
         AND a.grantee <> c.relowner;`) === '0');
const pols = owner(`SELECT string_agg(tablename || ':' || policyname || ':' || cmd, ',' ORDER BY tablename, policyname) FROM pg_policies WHERE tablename IN (${TABLES.map((t) => `'${t}'`).join(',')});`);
check('K8 policies exactly as frozen RLS §8 minus the two formula INSERT policies (ADR-013)',
  pols === 'feed_formula_line:feed_formula_line_admin_select:SELECT,'
  + 'feed_formula_version:feed_formula_version_admin_select:SELECT,feed_formula_version:feed_formula_version_operator_select:SELECT,'
  + 'feed_inventory_count:feed_inventory_count_admin_select:SELECT,feed_inventory_count:feed_inventory_count_operator_select:SELECT,'
  + 'feed_manufacturing:feed_manufacturing_admin_select:SELECT,feed_manufacturing:feed_manufacturing_operator_select:SELECT,'
  + 'feed_movement:feed_movement_admin_select:SELECT,'
  + 'flock_feed_assignment:flock_feed_assignment_admin_select:SELECT,flock_feed_assignment:flock_feed_assignment_operator_select:SELECT', pols);
const anonSr = [
  ...TABLES.map((t) => asAnon(`SELECT 1 FROM ${t};`)), ...TABLES.map((t) => asServiceRole(`SELECT 1 FROM ${t};`)),
  asAnon(`SELECT ${countCall(T_MAIN, '2026-04-21', 1)};`), asServiceRole(`SELECT ${countCall(T_MAIN, '2026-04-21', 1)};`),
  asAnon(`SELECT ${mfgCall(V2, '2026-04-21', 1, newKey())};`), asServiceRole(`SELECT ${mfgCall(V2, '2026-04-21', 1, newKey())};`),
  asAnon(`SELECT ${movCall(T_MAIN, 'LOSS', 1, '2026-04-21', null, 'x')};`), asServiceRole(`SELECT ${assignCall(FZ, T_MAIN, '2026-12-01')};`),
];
check('K9 anon and service_role: no SELECT on any feed table and no EXECUTE on RPCs 26–29', anonSr.every(denied), anonSr.map((d) => (denied(d) ? 'd' : 'OPEN')).join(','));

// ═══════════════════════════════════════════════════════════════════════════
section('L', 'SECURITY DEFINER');

const definers = owner(`SELECT string_agg(proname, ',' ORDER BY proname) FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace;`);
check('L1 SECURITY DEFINER inventory = previous 27 + RPCs 26–29 = 31', definers === ALL_DEFINERS, definers);
const hard = owner(`SELECT string_agg(proname || '=' || prosecdef || ':' || (coalesce(proconfig, '{}') @> ARRAY['search_path=public']) || ':' || pg_get_userbyid(proowner) || ':'
  || (proacl IS NOT NULL AND NOT EXISTS (SELECT 1 FROM aclexplode(proacl) a WHERE a.grantee = 0)) || ':' || has_function_privilege('anon', oid, 'EXECUTE')
  || ':' || has_function_privilege('authenticated', oid, 'EXECUTE') || ':' || has_function_privilege('service_role', oid, 'EXECUTE'), ',' ORDER BY proname)
  FROM pg_proc WHERE proname IN (${FEED_RPCS.map((p) => `'${p}'`).join(',')});`);
check('L2 each: DEFINER, search_path=public, owner postgres, no PUBLIC, anon no, authenticated yes, service_role no',
  hard === FEED_RPCS.map((p) => `${p}=true:true:postgres:true:false:true:false`).join(','), hard);
const sigs = owner(`SELECT string_agg(proname || '(' || pg_get_function_identity_arguments(oid) || ')', ' ; ' ORDER BY proname) FROM pg_proc WHERE proname IN (${FEED_RPCS.map((p) => `'${p}'`).join(',')});`);
const argNames = owner(`SELECT string_agg(array_to_string(proargnames, ','), ',') FROM pg_proc WHERE proname IN (${FEED_RPCS.map((p) => `'${p}'`).join(',')});`);
check('L3 exact frozen signatures; no actor / role / user parameter',
  sigs === 'assign_flock_feed(p_flock_id uuid, p_feed_type_id uuid, p_effective_from date, p_reason text) ; '
  + 'register_feed_inventory_count(p_feed_type_id uuid, p_count_date date, p_quantity_kg numeric, p_reason text) ; '
  + 'register_feed_manufacturing(p_formula_version_id uuid, p_manufacturing_date date, p_quantity_kg numeric, p_idempotency_key character varying, p_batch_number character varying, p_reason text) ; '
  + 'register_feed_movement(p_feed_type_id uuid, p_movement_type feed_movement_type, p_quantity_kg numeric, p_movement_date date, p_pedido_id uuid, p_reason text)'
  && !/(user|actor|role|performed|created_by|uid)/i.test(argNames), sigs);
check('L4 the immutability trigger function is NOT a SECURITY DEFINER and is not executable by application roles',
  owner(`SELECT prosecdef || ':' || has_function_privilege('authenticated', oid, 'EXECUTE') || ':' || has_function_privilege('anon', oid, 'EXECUTE')
         FROM pg_proc WHERE proname = 'reject_line_on_used_formula_version';`) === 'false:false:false');

// ═══════════════════════════════════════════════════════════════════════════
section('M', 'Atomicity (injected failures)');

owner(`
CREATE SCHEMA p20_harness;
CREATE TABLE p20_harness.fail_on (target TEXT, marker TEXT);
CREATE FUNCTION p20_harness.audit_ins() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM p20_harness.fail_on f WHERE f.target = 'audit' AND f.marker = NEW.reason) THEN
    RAISE EXCEPTION 'HARNESS_FAIL_AUDIT';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION p20_harness.mfg_ins() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM p20_harness.fail_on f WHERE f.target = 'mfg' AND f.marker = NEW.idempotency_key) THEN
    RAISE EXCEPTION 'HARNESS_FAIL_MANUFACTURING';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION p20_harness.assign_upd() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM p20_harness.fail_on f WHERE f.target = 'assign_close' AND f.marker = NEW.flock_id::TEXT) THEN
    RAISE EXCEPTION 'HARNESS_FAIL_AFTER_CLOSE';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION p20_harness.assign_ins() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM p20_harness.fail_on f WHERE f.target = 'assign_insert' AND f.marker = NEW.flock_id::TEXT) THEN
    RAISE EXCEPTION 'HARNESS_FAIL_NEW_ASSIGNMENT';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER p20_audit_ins BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION p20_harness.audit_ins();
CREATE TRIGGER p20_mfg_ins BEFORE INSERT ON public.feed_manufacturing FOR EACH ROW EXECUTE FUNCTION p20_harness.mfg_ins();
CREATE TRIGGER p20_assign_upd AFTER UPDATE ON public.flock_feed_assignment FOR EACH ROW EXECUTE FUNCTION p20_harness.assign_upd();
CREATE TRIGGER p20_assign_ins BEFORE INSERT ON public.flock_feed_assignment FOR EACH ROW EXECUTE FUNCTION p20_harness.assign_ins();`);
const failOn = (t, m) => owner(`DELETE FROM p20_harness.fail_on; INSERT INTO p20_harness.fail_on VALUES ('${t}', '${m}');`);
try {
  let key = newKey();
  failOn('mfg', key);
  snap = snapshot();
  r = ADMIN(`SELECT ${mfgCall(V2, '2026-04-22', 1, key)};`);
  check('M1 RPC 26: the manufacturing insert fails → nothing written', raised(r, 'HARNESS_FAIL_MANUFACTURING') && snapshot() === snap, firstErr(r));
  key = newKey();
  failOn('audit', 'm2');
  r = ADMIN(`SELECT ${mfgCall(V2, '2026-04-22', 1, key, null, 'm2')};`);
  check('M2 RPC 26: manufacturing written, then the audit fails → full rollback (no manufacturing)',
    raised(r, 'HARNESS_FAIL_AUDIT') && snapshot() === snap && owner(`SELECT count(*) FROM feed_manufacturing WHERE idempotency_key = '${key}';`) === '0', firstErr(r));
  failOn('audit', 'm3');
  r = ADMIN(`SELECT ${countCall(T_MAIN, '2026-04-22', 1, 'm3')};`);
  check('M3 RPC 27: count written, then the audit fails → full rollback', raised(r, 'HARNESS_FAIL_AUDIT') && snapshot() === snap, firstErr(r));
  failOn('audit', 'm4');
  r = ADMIN(`SELECT ${movCall(T_MAIN, 'LOSS', 1, '2026-04-22', null, 'm4')};`);
  check('M4 RPC 28: movement written, then the audit fails → full rollback', raised(r, 'HARNESS_FAIL_AUDIT') && snapshot() === snap, firstErr(r));
  const fyBefore = history(FY);
  for (const [what, t, m, code] of [
    ['after closing the previous assignment', 'assign_close', FY, 'HARNESS_FAIL_AFTER_CLOSE'],
    ['between closing and inserting the new assignment', 'assign_insert', FY, 'HARNESS_FAIL_NEW_ASSIGNMENT'],
    ['after both, at the audit', 'audit', 'm5', 'HARNESS_FAIL_AUDIT'],
  ]) {
    failOn(t, m);
    r = ADMIN(`SELECT ${assignCall(FY, T_MAIN, '2026-08-01', 'm5')};`);
    check(`M5 RPC 29 fails ${what} → the previous assignment is still current and unchanged, no new row`,
      raised(r, code) && snapshot() === snap && history(FY) === fyBefore, firstErr(r));
  }
} finally {
  owner(`DROP SCHEMA IF EXISTS p20_harness CASCADE;`);
}
check('M6 harness triggers removed', owner(`SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'p20_%';`) === '0');

// ═══════════════════════════════════════════════════════════════════════════
section('N', 'Concurrency (independent PostgreSQL sessions)');

const raceKey = newKey();
x = await race(OPA, `SELECT ${mfgCall(V_RACE, '2026-07-01', 11, raceKey)};`, OPA, `SELECT ${mfgCall(V_RACE, '2026-07-01', 12, raceKey)};`, 'p20-mfg');
check('N1 same manufacturing idempotency_key: B waited, then DUPLICATE_MANUFACTURING; exactly one manufacturing (A\'s)',
  x.aIn && x.bWait && x.ra.ok && raised(x.rb, 'DUPLICATE_MANUFACTURING')
  && owner(`SELECT count(*) || '|' || max(quantity_kg) FROM feed_manufacturing WHERE idempotency_key = '${raceKey}';`) === '1|11.000', firstErr(x.rb));
x = await race(OPA, `SELECT ${countCall(T_RACE, '2026-07-02', 10)};`, ADMIN_UID, `SELECT ${countCall(T_RACE, '2026-07-02', 20)};`, 'p20-count');
check('N2 same feed type and count_date: B waited, then DUPLICATE_COUNT; exactly one count (A\'s)',
  x.aIn && x.bWait && x.ra.ok && raised(x.rb, 'DUPLICATE_COUNT')
  && owner(`SELECT count(*) || '|' || max(quantity_kg) FROM feed_inventory_count WHERE feed_type_id = '${T_RACE}' AND count_date = '2026-07-02';`) === '1|10.000', firstErr(x.rb));
rpc(assignCall(FR, T_MAIN, '2026-01-01'));
x = await race(ADMIN_UID, `SELECT ${assignCall(FR, T_RECRIA, '2026-07-01')};`, ADMIN_UID, `SELECT ${assignCall(FR, T_RACE, '2026-08-01')};`, 'p20-assign');
check('N3 concurrent reassignments of one flock: B waited on the flock lock, then applied after A exactly as a sequential call; history kept, one current',
  x.aIn && x.bWait && x.ra.ok && x.rb.ok
  && history(FR) === `${TAG} Ponedoras:2026-01-01→2026-06-30,${TAG} Recria:2026-07-01→2026-07-31,${TAG} Race:2026-08-01→current`
  && owner(`SELECT count(*) FROM flock_feed_assignment WHERE flock_id = '${FR}' AND effective_to IS NULL;`) === '1', `${history(FR)} ${firstErr(x.rb)}`);
x = await race(ADMIN_UID, `SELECT ${assignCall(FR, T_MAIN, '2026-09-01')};`, ADMIN_UID, `SELECT ${assignCall(FR, T_RECRIA, '2026-09-01')};`, 'p20-assign2');
check('N4 concurrent reassignments with the SAME effective_from: B waited, then was rejected (chk_flock_feed_range); A\'s row current; no silent overwrite',
  x.aIn && x.bWait && x.ra.ok && violates(x.rb, 'chk_flock_feed_range')
  && history(FR) === `${TAG} Ponedoras:2026-01-01→2026-06-30,${TAG} Recria:2026-07-01→2026-07-31,${TAG} Race:2026-08-01→2026-08-31,${TAG} Ponedoras:2026-09-01→current`,
  `${history(FR)} ${firstErr(x.rb)}`);
const V_RACE2 = version(feedType('Race2'), 1, '2026-01-01');   // own feed type: no overlap with V_RACE (ADR-013)
line(V_RACE2, MAIZ, 100, 1);
x = await race(OPA, `SELECT ${mfgCall(V_RACE2, '2026-07-03', 5, newKey())};`,
  null, `INSERT INTO feed_formula_line (formula_version_id, ingredient_id, quantity_kg) VALUES ('${V_RACE2}', '${CALCIO}', 1);`, 'p20-line');
check('N5 first manufacturing of a version vs a concurrent composition insert: the insert waited, then FORMULA_VERSION_IN_USE; composition unchanged',
  x.aIn && x.bWait && x.ra.ok && raised(x.rb, 'FORMULA_VERSION_IN_USE')
  && owner(`SELECT count(*) FROM feed_formula_line WHERE formula_version_id = '${V_RACE2}';`) === '1', firstErr(x.rb));

// ═══════════════════════════════════════════════════════════════════════════
section('W', 'Temporal semantics (owner rules: count day, same-day population, age)');

// W-A count day: the count of D is the stock at the close of D
const T_CD = feedType('Count day');
const V_CD = version(T_CD, 1, '2026-01-01');
line(V_CD, MAIZ, 100, 1);
rpcAs(A, countCall(T_CD, '2026-04-01', 1000));
rpc(movCall(T_CD, 'LOSS', 7, '2026-04-01', null, 'antes del conteo del 01/04'));
manufacture(A, V_CD, '2026-04-30', 500);
rpc(movCall(T_CD, 'EXTERNAL_SALE', 100, '2026-04-30', PEDIDO));
rpcAs(A, countCall(T_CD, '2026-04-30', 900));
rpcAs(A, countCall(T_CD, '2026-05-31', 900));
snap = snapshot();
const cdApril = internal(T_CD, '2026-04-01', '2026-04-30');
check('W1 count day: manufacturing +500 and EXTERNAL_SALE 100 dated 2026-04-30 belong to the period CLOSING on 2026-04-30: 1000 + 500 − 100 − 900 = 500',
  cdApril === 500, cdApril);
check('W2 a flow dated on the OPENING count day (LOSS 7 on 2026-04-01) happened before that count and is excluded from the period it opens',
  cdApril === 1000 + 500 - 100 - 900);
const cdMay = internal(T_CD, '2026-04-30', '2026-05-31');
check('W3 the 2026-04-30 flows are not counted again in the next period (2026-04-30 → 2026-05-31): 900 − 900 = 0', cdMay === 0, cdMay);
r = raw(`BEGIN; UPDATE feed_manufacturing SET manufacturing_date = '2026-05-01' WHERE formula_version_id = '${V_CD}'; ${internalSql(T_CD, '2026-04-01', '2026-04-30')} ROLLBACK;`);
check('W4 the boundary is exactly D: the same manufacturing dated D+1 (probe, rolled back) leaves April at 1000 − 100 − 900 = 0',
  r.ok && num(r.out) === 0 && internal(T_CD, '2026-04-01', '2026-04-30') === 500, r.out || r.err);

// W-B same-day population: a mortality dated D affects D
rpc(assignCall(FM, T_CD, '2026-05-01'));
const pop = (d) => owner(populationSql(FM, d));
check('W5 population before D (2026-05-09) = 2700; with mortality 5 dated D, population(D = 2026-05-10) = 2695 (same day, not D+1)',
  pop('2026-05-09') === '2700' && pop('2026-05-10') === '2695' && pop('2026-05-11') === '2695', `${pop('2026-05-09')}/${pop('2026-05-10')}`);
check('W6 a COUNT_ADJUSTMENT (+3) dated D also counts on D: population(2026-05-12) = 2698', pop('2026-05-12') === '2698', pop('2026-05-12'));
const ageOn = (d) => owner(`SELECT ${CURVE_AGE(`'${d}'::DATE`, `'${BIRTH}'::DATE`)};`);
const theoDay = (d) => owner(theoreticalSql(FM, d, d));
const wantDay = (population, d) => `${TAG} Count day=${(population * gOf(Number(ageOn(d))) / 1000).toFixed(3)}`;
check('W7 theoretical consumption of D multiplies by 2695 (not 2700); D−1 by 2700; the adjustment day by 2698',
  theoDay('2026-05-10') === wantDay(2695, '2026-05-10') && theoDay('2026-05-09') === wantDay(2700, '2026-05-09')
  && theoDay('2026-05-12') === wantDay(2698, '2026-05-12'), `${theoDay('2026-05-09')} / ${theoDay('2026-05-10')} / ${theoDay('2026-05-12')}`);

// W-C age: exact decimal weeks, curve row = floor
const ageCase = (d) => owner(`SELECT to_char(round(${AGE_EXACT(`'${d}'::DATE`, 'f.birth_date')}, 4), 'FM0.0000') || '|' || c.age_weeks || '|' || c.expected_g_per_bird_day
  FROM flocks f JOIN genetics_consumption_curve c ON c.genetics_line = f.genetics_line AND c.age_weeks = ${CURVE_AGE(`'${d}'::DATE`, 'f.birth_date')}
  WHERE f.id = '${FA}';`);
for (const [d, exact, week] of [
  ['2026-09-25', '0.0000', 0], ['2026-10-01', '0.8571', 0], ['2026-10-02', '1.0000', 1],
  ['2026-10-08', '1.8571', 1], ['2026-10-09', '2.0000', 2], ['2026-10-11', '2.2857', 2], ['2026-10-16', '3.0000', 3],
]) {
  check(`W8 birth 2026-09-25, ${d}: exact ${exact} weeks → curve week ${week} (floor; no round, no ceil)`,
    ageCase(d) === `${exact}|${week}|${(80 + week).toFixed(3)}`, ageCase(d));
}
rpc(assignCall(FA, T_CD, '2026-09-25'));
check('W9 the theoretical derivation itself uses the floor row: 2026-10-11 (2.2857 weeks) → 100 birds × 82 g (week 2), not week 3 (83 g)',
  owner(theoreticalSql(FA, '2026-10-11', '2026-10-11')) === `${TAG} Count day=8.200`, owner(theoreticalSql(FA, '2026-10-11', '2026-10-11')));

// ═══════════════════════════════════════════════════════════════════════════
section('P', 'No per-flock real consumption (structural)');

check('P1 no daily_feed_consumption / per-flock consumption table exists',
  owner(`SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* '(daily_feed|feed_consumption|consumption_per|consumo)' AND table_name NOT IN (${ADR005_VIEWS});`) === '0');
check('P2 no column anywhere in public is a consumption fact (no *consum* / *consumo* column)',
  owner(`SELECT coalesce(string_agg(table_name || '.' || column_name, ','), '') FROM information_schema.columns WHERE table_schema = 'public' AND column_name ~* '(consum|consumo)' AND table_name NOT IN (${ADR005_VIEWS});`) === '');
check('P3 no table combines a flock reference with a feed quantity (no per-flock feed fact)',
  owner(`SELECT coalesce(string_agg(DISTINCT c1.table_name, ','), '') FROM information_schema.columns c1 JOIN information_schema.columns c2
         ON c2.table_schema = c1.table_schema AND c2.table_name = c1.table_name
         WHERE c1.table_schema = 'public' AND c1.column_name = 'flock_id' AND c2.column_name ~* '(_kg|feed_qty|feed_quantity)' AND c1.table_name NOT IN (${ADR005_VIEWS});`) === '');
check('P4 flock_feed_assignment only says which feed type applies: no quantity, kg or consumption column',
  colsOf('flock_feed_assignment') === wantCols.flock_feed_assignment);
check('P5 real consumption inputs carry no flock: counts, manufacturing and movements have no flock / shed column',
  owner(`SELECT count(*) FROM information_schema.columns WHERE table_name IN ('feed_inventory_count','feed_manufacturing','feed_movement') AND column_name ~* '(flock|shed|lote|galpon)';`) === '0');

// ═══════════════════════════════════════════════════════════════════════════
section('E2E', 'Feed end to end');

rpc(assignCall(FX, T_E2E, '2026-01-01', 'ponedoras'));
const eMar = manufacture(A, V_E2E_1, '2026-03-15', 800);
rpcAs(A, countCall(T_E2E, '2026-03-31', 2000));
const eApr = manufacture(A, V_E2E_2, '2026-04-10', 1500);
rpc(movCall(T_E2E, 'EXTERNAL_SALE', 200, '2026-04-12', PEDIDO));
rpc(movCall(T_E2E, 'LOSS', 50, '2026-04-20', null, 'bolsas rotas'));
rpcAs(A, countCall(T_E2E, '2026-04-30', 1800));
check('E2E1 March manufacturing references v1 and April manufacturing references v2 (exact versions retained)',
  mfgRow(eMar.manufacturing_id).startsWith(`${V_E2E_1}|2026-03-15|800.000`) && mfgRow(eApr.manufacturing_id).startsWith(`${V_E2E_2}|2026-04-10|1500.000`));
snap = snapshot();
const eInternal = internal(T_E2E, '2026-03-31', '2026-04-30');
check('E2E2 April consumo interno = 2000 (opening) + 1500 (manufacturing) − 200 (external sale) − 50 (loss) − 1800 (closing) = 1450; March manufacturing excluded',
  eInternal === 1450, eInternal);
const eTheo = owner(theoreticalSql(FX, '2026-04-01', '2026-04-30'));
const eTheoJs = jsTheoretical('2026-04-01', '2026-04-30', 990, () => 'E2E Ponedoras');
check('E2E3 April consumo teórico, flock X = 990 birds × curve(weeks 25–29) = 3175.920 kg attributed to the assigned feed type; equals an independent computation',
  eTheo === eTheoJs && eTheo === `${TAG} E2E Ponedoras=3175.920`, `${eTheo} vs ${eTheoJs}`);
check('E2E4 both numbers exist as derived query results and are not assumed equal (1450 vs 3175.920)', eInternal !== num(eTheo.split('=')[1]));
check('E2E5 the internal figure is an aggregate by feed type (no flock allocation); the theoretical one is per flock and does not feed back into it',
  !/flock/i.test(internalSql(T_E2E, '2026-03-31', '2026-04-30')) && /flock/.test(theoreticalSql(FX, '2026-04-01', '2026-04-30')));
check('E2E6 operator A (assigned to flock X) sees the assignment, the manufacturing and the counts, but not the movements or the costs',
  visible(A, 'flock_feed_assignment', `flock_id = '${FX}'`) === '1' && visible(A, 'feed_manufacturing', `id IN ('${eMar.manufacturing_id}','${eApr.manufacturing_id}')`) === '2'
  && visible(A, 'feed_inventory_count', `feed_type_id = '${T_E2E}'`) === '2' && visible(A, 'feed_movement', `feed_type_id = '${T_E2E}'`) === '0'
  && visible(A, 'feed_formula_line', `formula_version_id = '${V_E2E_2}'`) === '0');
check('E2E7 no stored consumption: both derivations wrote nothing and no consumption table exists', snapshot() === snap
  && owner(`SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* '(consum|consumo)' AND table_name <> 'genetics_consumption_curve' AND table_name NOT IN (${ADR005_VIEWS});`) === '0');

// ═══════════════════════════════════════════════════════════════════════════
section('O', 'No economic effect (whole suite)');

check('O1 across every successful call of the suite: no operation, posting, ledger, purchase, order, collection, production or flock change',
  econ() === econAtStart, `${econAtStart} → ${econ()}`);
} finally {
  cleanup();
}

section('Z', 'Cleanup');
const left = owner(`SELECT (SELECT count(*) FROM feed_type WHERE nombre LIKE '${TAG}%') + (SELECT count(*) FROM feed_ingredient WHERE nombre LIKE '${TAG}%')
  + (SELECT count(*) FROM genetics_consumption_curve WHERE genetics_line LIKE '${TAG}%') + (SELECT count(*) FROM sheds WHERE nombre LIKE '${TAG}%')
  + (SELECT count(*) FROM clients WHERE nombre LIKE '${TAG}%') + (SELECT count(*) FROM feed_manufacturing WHERE idempotency_key LIKE '${KEY_PREFIX}%')
  + (SELECT count(*) FROM perfiles WHERE id = '${OPB}') + (SELECT count(*) FROM information_schema.schemata WHERE schema_name = 'p20_harness')
  + (SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'p20_%');`);
check('Z1 all P20-TEST masters, facts, flocks, client/Pedido, operator B, harness schema and triggers removed', left === '0', left);
const closedLeft = owner(`SELECT count(*) FROM management_period WHERE status = 'CLOSED' AND periodo_fecha IN (${CLOSED_BY_SUITE.map((m) => `'${m}'`).join(',')});`);
check('Z2 periods closed by the suite are OPEN again', closedLeft === '0', closedLeft);

console.log(`\n  ══ FEED RESULT: ${pass} passed, ${fail} failed ══\n`);
if (fail > 0) {
  console.log('  Failures:');
  for (const f of failures) console.log(`    - ${f.label}${f.detail !== undefined ? ` :: ${f.detail}` : ''}`);
  console.log('');
}
process.exit(fail === 0 ? 0 : 1);
