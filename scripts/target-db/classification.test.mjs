#!/usr/bin/env node
/**
 * PHASE 19 — CLASSIFICATION TEST SUITE. LOCAL TEST DATABASE ONLY.
 *
 * Behavioural tests of RPC 25 register_classification over classification and
 * classification_line, reusing the classification_grade master.
 *
 * Role-scoped calls simulate real Supabase sessions with two operator profiles
 * (A, B) and ADMIN. Failure injection uses test-only triggers in schema
 * p19_harness (dropped at the end). The concurrency group runs independent
 * PostgreSQL sessions.
 *
 * Fixtures: every session uses an idempotency_key in the reserved test UUID
 * range d19e0000-0000-4000-8000-xxxxxxxxxxxx, so cleanup is exact. The only
 * master fixture is one extra INACTIVE grade ("P19-TEST …"); the seeded grades
 * are never modified. Operator B is a Phase 19 fixture removed at the end.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *     node scripts/target-db/classification.test.mjs
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
const OPB = '66666666-6666-6666-6666-666666666666';
const INACTIVE_UID = '33333333-3333-3333-3333-333333333333';
const NOPROFILE_UID = '44444444-4444-4444-4444-444444444444';
const MISSING_UUID = '99999999-9999-9999-9999-999999999999';
const TAG = 'P19-TEST';
const KEY_PREFIX = 'd19e0000-0000-4000-8000-';
const TABLES = ['classification', 'classification_line'];
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
async function race(uid, callA, callB, appPrefix, expectWait = true) {
  const pA = session(sessionSql('authenticated', claimsOf(uid), `SELECT ${callA};\nSELECT pg_sleep(2);`), `${appPrefix}-A`);
  const aIn = await waitFor(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = '${appPrefix}-A'
    AND state = 'active' AND query LIKE '%pg_sleep%');`);
  const pB = session(sessionSql('authenticated', claimsOf(uid), `SELECT ${callB};`), `${appPrefix}-B`);
  const bWait = expectWait
    ? await waitFor(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = '${appPrefix}-B' AND wait_event_type = 'Lock');`)
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
const TC = `(SELECT id FROM classification WHERE idempotency_key::TEXT LIKE '${KEY_PREFIX}%')`;
function cleanup() {
  owner(`
DROP SCHEMA IF EXISTS p19_harness CASCADE;
DELETE FROM audit_events WHERE entity_type = 'classification' AND entity_id IN (SELECT id::TEXT FROM ${TC} c);
DELETE FROM classification_line WHERE classification_id IN ${TC};
DELETE FROM classification WHERE id IN ${TC};
DELETE FROM classification_grade WHERE nombre LIKE '${TAG}%';
DELETE FROM audit_events WHERE performed_by = '${OPB}';
DELETE FROM perfiles WHERE id = '${OPB}';
DELETE FROM auth.users WHERE id = '${OPB}';
UPDATE management_period SET status = 'OPEN', closed_at = NULL
 WHERE periodo_fecha IN (${CLOSED_BY_SUITE.map((m) => `'${m}'`).join(',')});`);
}

cleanup();
owner(`
INSERT INTO auth.users (id, is_sso_user, is_anonymous) VALUES
  ('${ADMIN_UID}', false, false), ('${OPA}', false, false), ('${OPB}', false, false),
  ('${INACTIVE_UID}', false, false), ('${NOPROFILE_UID}', false, false)
ON CONFLICT (id) DO NOTHING;
INSERT INTO perfiles (id, email, rol_type, activo) VALUES
  ('${ADMIN_UID}', 'admin@test.local', 'ADMIN', true),
  ('${OPA}', 'operator@test.local', 'OPERATOR', true),
  ('${OPB}', 'operator-p19@test.local', 'OPERATOR', true),
  ('${INACTIVE_UID}', 'inactive@test.local', 'OPERATOR', false)
ON CONFLICT (id) DO NOTHING;`);

// ── helpers ────────────────────────────────────────────────────────────────
let keySeq = 0;
const newKey = () => `${KEY_PREFIX}${String(++keySeq).padStart(12, '0')}`;
const G = {};
for (const g of ['XL', 'N1', 'N2', 'N3', 'Rotos']) G[g] = owner(`SELECT id FROM classification_grade WHERE nombre = '${g}';`);
const q = (v) => (v === null || v === undefined ? 'NULL' : `'${v}'`);
const j = (v) => (v === null || v === undefined ? 'NULL' : `'${JSON.stringify(v)}'::jsonb`);
const L = (grade, quantity) => ({ classification_grade_id: grade, quantity });
const classCall = (key, date, lines, location = null, reason = null) =>
  `register_classification(${q(key)}, ${q(date)}, ${j(lines)}, ${q(location)}, ${q(reason)})`;
const classify = (fn, date, lines, location = null, reason = null) => {
  const key = newKey();
  return { key, ...rpcAs(fn, classCall(key, date, lines, location, reason)) };
};

const sessionRow = (id) => owner(`SELECT idempotency_key || '|' || classification_date || '|' || coalesce(location, '-') || '|' || created_by FROM classification WHERE id = '${id}';`);
const linesOf = (id) => owner(`SELECT string_agg(g.nombre || ':' || l.quantity, ',' ORDER BY g.nombre) FROM classification_line l
  JOIN classification_grade g ON g.id = l.classification_grade_id WHERE l.classification_id = '${id}';`);
const snapshot = () => owner(`SELECT concat_ws('|', (SELECT count(*) FROM classification), (SELECT count(*) FROM classification_line), (SELECT count(*) FROM audit_events));`);
const econ = () => owner(`SELECT concat_ws('|', (SELECT count(*) FROM financial_operation), (SELECT count(*) FROM financial_posting),
  (SELECT count(*) FROM client_ledger), (SELECT count(*) FROM supplier_ledger), (SELECT count(*) FROM purchases), (SELECT count(*) FROM pedidos),
  (SELECT count(*) FROM daily_production), (SELECT count(*) FROM population_events), (SELECT count(*) FROM flocks));`);
const closePeriod = (m) => owner(`UPDATE management_period SET status = 'CLOSED', closed_at = NOW() WHERE periodo_fecha = '${m}';`);
const openPeriod = (m) => owner(`UPDATE management_period SET status = 'OPEN', closed_at = NULL WHERE periodo_fecha = '${m}';`);
const visible = (fn, t, where) => { const x2 = fn(`SELECT count(*) FROM ${t} WHERE ${where};`); return x2.ok ? x2.out : `ERR ${firstErr(x2)}`; };

let r;
let snap;
let x;
const econAtStart = econ();

try {
// ═══════════════════════════════════════════════════════════════════════════
section('A', 'Structure');

const colsOf = (t) => owner(`SELECT string_agg(column_name || ':' || data_type, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_name = '${t}';`);
check('A1 classification columns exactly as frozen + the ADR-012 version chain (idempotency_key is UUID; no flock)',
  colsOf('classification') === 'id:uuid,idempotency_key:uuid,classification_date:date,location:character varying,created_at:timestamp with time zone,created_by:uuid,'
  + 'version_seq:integer,is_current:boolean,supersedes_id:uuid,rectification_reason:text', colsOf('classification'));
check('A2 classification_line columns exactly as frozen + the ADR-012 original entry (quantity stays the canonical egg count)',
  colsOf('classification_line') === 'id:uuid,classification_id:uuid,classification_grade_id:uuid,quantity:integer,created_at:timestamp with time zone,'
  + 'entered_quantity:integer,entered_unit:USER-DEFINED', colsOf('classification_line'));
const cons = owner(`SELECT string_agg(conname || ':' || contype::TEXT, ',' ORDER BY conname) FROM pg_constraint WHERE conrelid IN ('classification'::regclass, 'classification_line'::regclass) AND contype IN ('u','c');`);
check('A3 UNIQUE idempotency_key, UNIQUE (session, grade), CHECK quantity >= 0 + the ADR-012 chain / entry checks — nothing else',
  cons === 'chk_classification_line_entered:c,chk_classification_line_unidad:c,chk_classification_version_chain:c,classification_idempotency_key_key:u,'
  + 'classification_line_classification_id_classification_grade__key:u,classification_line_quantity_check:c,classification_supersedes_id_key:u,classification_version_seq_check:c', cons);
check('A4 idx_classification_date on classification_date', owner(`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_classification_date';`).endsWith('(classification_date)'));
const fks = owner(`SELECT string_agg(x, ',' ORDER BY x) FROM (
  SELECT c.conrelid::regclass || '.' || a.attname || '>' || c.confrelid::regclass || ':' || c.confdeltype::TEXT AS x
    FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
   WHERE c.contype = 'f' AND c.conrelid IN ('classification'::regclass, 'classification_line'::regclass)) s;`);
check('A5 FKs: grade → classification_grade (master, not free text), line → session, created_by → perfiles, rectification → prior version (ADR-012); all RESTRICT',
  fks === 'classification.created_by>perfiles:r,classification.supersedes_id>classification:r,classification_line.classification_grade_id>classification_grade:r,classification_line.classification_id>classification:r', fks);
check('A6 RLS enabled on both tables', owner(`SELECT count(*) FROM pg_class WHERE relname IN ('classification','classification_line') AND relrowsecurity;`) === '2');
const dateUnique = owner(`SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid WHERE c.relname = 'classification' AND i.indisunique
  AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum = ANY(i.indkey) AND a.attname IN ('classification_date','location'));`);
check('A7 NO uniqueness by date or (date, location): multiple sessions per day are possible', dateUnique === '0', dateUnique);
check('A8 no stored session total', owner(`SELECT count(*) FROM information_schema.columns WHERE table_name IN ('classification','classification_line') AND column_name ~* 'total';`) === '0');
check('A9 classification_grade reused (not recreated), seed catalog intact: 7 grades, 6 active (ADR-014 / D-CLS-6: Rotos inactive for new entries)',
  owner(`SELECT count(*) FILTER (WHERE activo) || '|' || string_agg(nombre, ',' ORDER BY nombre) || '|' || string_agg(nombre, ',' ORDER BY nombre) FILTER (WHERE NOT activo) FROM classification_grade WHERE nombre NOT LIKE '${TAG}%';`)
  === '6|Descarte,N1,N2,N3,Rotos,Sucios,XL|Rotos');

// ═══════════════════════════════════════════════════════════════════════════
section('B', 'ADMIN happy path');

let econ0 = econ();
const bKey = newKey();
const b = rpc(classCall(bKey, '2026-05-10', [L(G.XL, 100), L(G.N1, 200), L(G.N2, 50)], 'Clasificadora', 'turno mañana'));
check('B1 returns {classification_id, line_count 3, total_quantity 350}',
  !!b.classification_id && b.line_count === 3 && b.total_quantity === 350 && Object.keys(b).length === 3, JSON.stringify(b));
check('B2 session row: key, date, location, created_by ADMIN', sessionRow(b.classification_id) === `${bKey}|2026-05-10|Clasificadora|${ADMIN_UID}`);
check('B3 lines exactly as supplied, grade by FK', linesOf(b.classification_id) === 'N1:200,N2:50,XL:100', linesOf(b.classification_id));
check('B4 total_quantity is derived: SUM(classification_line.quantity) = 350',
  owner(`SELECT SUM(quantity) FROM classification_line WHERE classification_id = '${b.classification_id}';`) === '350');
check('B5 audit CREATE: classification_date, line_count, reason, actor',
  owner(`SELECT action || '|' || (after_values->>'classification_date') || '|' || (after_values->>'line_count') || '|' || reason || '|' || performed_by
         FROM audit_events WHERE entity_type = 'classification' AND entity_id = '${b.classification_id}';`) === `CREATE|2026-05-10|3|turno mañana|${ADMIN_UID}`);
check('B6 no economic or productive effect (ledgers, money, purchases, orders, production, flocks unchanged)', econ() === econ0);

// ═══════════════════════════════════════════════════════════════════════════
section('C', 'OPERATOR happy path');

const opbAssignments = owner(`SELECT count(*) FROM operator_assignments WHERE operator_id = '${OPB}';`);
const c0 = classify(B, '2026-05-10', [L(G.N1, 4)], 'Mesa 3');
const c1 = classify(A, '2026-05-10', [L(G.XL, 10)], 'Mesa 2');
check('C1 OPERATOR registers a classification; created_by = the real operator', sessionRow(c1.classification_id).endsWith(`|${OPA}`));
check('C0 no flock assignment is required: operator B has no assignment at all and still classifies', opbAssignments === '0' && sessionRow(c0.classification_id).endsWith(`|${OPB}`), opbAssignments);
r = asUser(INACTIVE_UID, `SELECT ${classCall(newKey(), '2026-05-10', [L(G.XL, 1)])};`);
const rNp = asUser(NOPROFILE_UID, `SELECT ${classCall(newKey(), '2026-05-10', [L(G.XL, 1)])};`);
check('C2 inactive / missing profile → USER_NOT_FOUND_OR_INACTIVE', raised(r, 'USER_NOT_FOUND_OR_INACTIVE') && raised(rNp, 'USER_NOT_FOUND_OR_INACTIVE'));

// ═══════════════════════════════════════════════════════════════════════════
section('D', 'Multiple sessions per day');

const dA = classify(ADMIN, '2026-05-11', [L(G.XL, 100), L(G.N1, 200)], 'Clasificadora');
const dB = classify(ADMIN, '2026-05-11', [L(G.XL, 80), L(G.N1, 150)], 'Clasificadora');
check('D1 same date, same location, different keys: both sessions succeed', dA.classification_id !== dB.classification_id && dA.total_quantity === 300 && dB.total_quantity === 230);
check('D2 both persist independently with their own lines',
  owner(`SELECT count(*) FROM classification WHERE classification_date = '2026-05-11' AND location = 'Clasificadora' AND id IN ${TC};`) === '2'
  && linesOf(dA.classification_id) === 'N1:200,XL:100' && linesOf(dB.classification_id) === 'N1:150,XL:80');

// ═══════════════════════════════════════════════════════════════════════════
section('E', 'Locations');

const eNull = classify(ADMIN, '2026-05-12', [L(G.N3, 5)]);
const eM1 = classify(ADMIN, '2026-05-12', [L(G.N3, 6)], 'Mesa 1');
const eM2 = classify(ADMIN, '2026-05-12', [L(G.N3, 7)], 'Mesa 2');
check('E1 location NULL is allowed', sessionRow(eNull.classification_id).includes('|2026-05-12|-|'));
check('E2 the same date across several locations is allowed', !!eM1.classification_id && !!eM2.classification_id);

// ═══════════════════════════════════════════════════════════════════════════
section('F', 'Line validation (atomic rejection)');

const INACTIVE_GRADE = okAs(ADMIN, `INSERT INTO classification_grade (nombre, activo) VALUES ('${TAG} inactiva', false) RETURNING id;`);
snap = snapshot();
for (const [what, key, date, lines, code] of [
  ['NULL line set', newKey(), '2026-05-13', null, 'EMPTY_LINE_SET'],
  ['empty line set', newKey(), '2026-05-13', [], 'EMPTY_LINE_SET'],
  ['non-array line set', newKey(), '2026-05-13', { classification_grade_id: G.XL, quantity: 1 }, 'EMPTY_LINE_SET'],
  ['negative quantity', newKey(), '2026-05-13', [L(G.XL, -1)], 'INVALID_QUANTITY'],
  ['NULL quantity', newKey(), '2026-05-13', [L(G.XL, null)], 'INVALID_QUANTITY'],
  ['nonexistent grade', newKey(), '2026-05-13', [L(MISSING_UUID, 1)], 'GRADE_NOT_FOUND'],
  ['NULL grade', newKey(), '2026-05-13', [L(null, 1)], 'GRADE_NOT_FOUND'],
  ['inactive grade', newKey(), '2026-05-13', [L(INACTIVE_GRADE, 1)], 'GRADE_NOT_FOUND'],
  ['duplicate grade inside one session (quantities NOT merged)', newKey(), '2026-05-13', [L(G.XL, 10), L(G.XL, 20)], 'DUPLICATE_GRADE_IN_SESSION'],
  ['invalid LATER line (first line valid)', newKey(), '2026-05-13', [L(G.XL, 10), L(G.N1, -5)], 'INVALID_QUANTITY'],
  ['classification_date NULL', newKey(), null, [L(G.XL, 1)], 'BUSINESS_DATE_REQUIRED'],
]) {
  r = ADMIN(`SELECT ${classCall(key, date, lines)};`);
  check(`F ${what} → ${code}`, raised(r, code), firstErr(r));
}
r = ADMIN(`SELECT ${classCall(null, '2026-05-13', [L(G.XL, 1)])};`);
check('F NULL idempotency_key → rejected by the frozen NOT NULL column', violates(r, 'idempotency_key'), firstErr(r));
check('F1 every rejection was atomic: no session, no line, no audit', snapshot() === snap);
r = raw(`INSERT INTO classification_line (classification_id, classification_grade_id, quantity, entered_quantity, entered_unit) VALUES ('${b.classification_id}', '${G.XL}', 1, 1, 'UNIDAD');`);
check('F2 physical backstop: UNIQUE(classification_id, classification_grade_id) (even for the owner)',
  violates(r, 'classification_line_classification_id_classification_grade__key'), firstErr(r));
r = raw(`INSERT INTO classification_line (classification_id, classification_grade_id, quantity, entered_quantity, entered_unit) VALUES ('${b.classification_id}', '${G.Rotos}', -1, 0, 'MAPLE');`);
check('F3 physical backstop: quantity >= 0 CHECK', violates(r, 'classification_line_quantity_check'), firstErr(r));

// ═══════════════════════════════════════════════════════════════════════════
section('G', 'Zero quantity');

const g0 = classify(ADMIN, '2026-05-13', [L(G.XL, 0), L(G.N1, 12)]);
check('G1 quantity 0 is accepted (schema and contract say >= 0); total 12', g0.line_count === 2 && g0.total_quantity === 12 && linesOf(g0.classification_id) === 'N1:12,XL:0');

// ═══════════════════════════════════════════════════════════════════════════
section('H', 'Idempotency');

snap = snapshot();
r = ADMIN(`SELECT ${classCall(bKey, '2026-05-10', [L(G.XL, 999)])};`);
check('H1 retry with the same idempotency_key → DUPLICATE_CLASSIFICATION', raised(r, 'DUPLICATE_CLASSIFICATION'), firstErr(r));
check('H2 no second session, no second line set, no second audit', snapshot() === snap
  && owner(`SELECT count(*) FROM classification WHERE idempotency_key = '${bKey}';`) === '1');

// ═══════════════════════════════════════════════════════════════════════════
section('I', 'Period');

closePeriod('2026-03-01');
snap = snapshot();
r = ADMIN(`SELECT ${classCall(newKey(), '2026-03-20', [L(G.XL, 1)])};`);
const rOp = A(`SELECT ${classCall(newKey(), '2026-03-21', [L(G.XL, 1)])};`);
check('I1 CLOSED classification_date → PERIOD_CLOSED (ADMIN and OPERATOR), nothing written',
  raised(r, 'PERIOD_CLOSED') && raised(rOp, 'PERIOD_CLOSED') && snapshot() === snap, firstErr(r));
openPeriod('2026-03-01');
r = ADMIN(`SELECT ${classCall(newKey(), '2027-02-10', [L(G.XL, 1)])};`);
check('I2 date without a management_period → PERIOD_NOT_FOUND', raised(r, 'PERIOD_NOT_FOUND') && snapshot() === snap, firstErr(r));
closePeriod(CURRENT_MONTH);
const iOk = classify(ADMIN, '2026-05-14', [L(G.XL, 3)]);
const iOk2 = classify(ADMIN, '2026-05-14', [L(G.XL, 4)]);
check(`I3 created_at irrelevant: current month ${CURRENT_MONTH} CLOSED, classification_date 2026-05-14 OPEN → accepted (twice the same day)`,
  owner(`SELECT count(*) FROM classification WHERE id IN ('${iOk.classification_id}','${iOk2.classification_id}')
         AND classification_date = '2026-05-14' AND date_trunc('month', created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE = '${CURRENT_MONTH}';`) === '2');
openPeriod(CURRENT_MONTH);

// ═══════════════════════════════════════════════════════════════════════════
section('J', 'RLS / privileges');

const aS = classify(A, '2026-05-15', [L(G.XL, 11), L(G.N1, 22)], 'Mesa A');
const bS = classify(B, '2026-05-15', [L(G.XL, 33)], 'Mesa B');
const aOwn = owner(`SELECT count(*) FROM classification WHERE created_by = '${OPA}' AND id IN ${TC};`);
check('J1 ADMIN sees every session and every line (both operators)',
  visible(ADMIN, 'classification', `id IN ('${aS.classification_id}','${bS.classification_id}')`) === '2'
  && visible(ADMIN, 'classification_line', `classification_id IN ('${aS.classification_id}','${bS.classification_id}')`) === '3');
check('J2 operator A sees exactly its own sessions and their lines',
  visible(A, 'classification', `idempotency_key::TEXT LIKE '${KEY_PREFIX}%'`) === aOwn
  && visible(A, 'classification_line', `classification_id = '${aS.classification_id}'`) === '2');
check('J3 operator A cannot see operator B\'s session or lines', visible(A, 'classification', `id = '${bS.classification_id}'`) === '0'
  && visible(A, 'classification_line', `classification_id = '${bS.classification_id}'`) === '0');
check('J4 operator B symmetric: sees its own, not A\'s, not ADMIN\'s',
  visible(B, 'classification', `id = '${bS.classification_id}'`) === '1' && visible(B, 'classification', `id = '${aS.classification_id}'`) === '0'
  && visible(B, 'classification', `id = '${b.classification_id}'`) === '0' && visible(B, 'classification_line', `classification_id = '${aS.classification_id}'`) === '0');
snap = snapshot();
const direct = [
  A(`INSERT INTO classification (idempotency_key, classification_date) VALUES ('${newKey()}', '2026-05-15');`),
  A(`INSERT INTO classification_line (classification_id, classification_grade_id, quantity) VALUES ('${aS.classification_id}', '${G.N2}', 1);`),
  A(`UPDATE classification_line SET quantity = 1 WHERE classification_id = '${aS.classification_id}';`),
  A(`DELETE FROM classification WHERE id = '${aS.classification_id}';`),
  ADMIN(`INSERT INTO classification (idempotency_key, classification_date) VALUES ('${newKey()}', '2026-05-15');`),
  ADMIN(`UPDATE classification SET location = 'x';`),
  ADMIN(`DELETE FROM classification_line;`),
  ADMIN(`TRUNCATE classification CASCADE;`),
  ADMIN(`TRUNCATE classification_line;`),
];
check('J5 no direct INSERT / UPDATE / DELETE / TRUNCATE for OPERATOR or ADMIN (RPC 25 only)',
  direct.every(denied) && snapshot() === snap, direct.map((d) => (denied(d) ? 'd' : 'OPEN')).join(','));
check('J6 anon: no SELECT and no EXECUTE', [asAnon(`SELECT count(*) FROM classification;`), asAnon(`SELECT count(*) FROM classification_line;`),
  asAnon(`SELECT ${classCall(newKey(), '2026-05-15', [L(G.XL, 1)])};`)].every(denied));
check('J7 service_role: no SELECT and no EXECUTE', [asServiceRole(`SELECT count(*) FROM classification;`), asServiceRole(`SELECT count(*) FROM classification_line;`),
  asServiceRole(`SELECT ${classCall(newKey(), '2026-05-15', [L(G.XL, 1)])};`)].every(denied));
const acl = owner(`SELECT string_agg(relname || '=' || relacl::TEXT, ' ' ORDER BY relname) FROM pg_class WHERE relname IN ('classification','classification_line');`);
check('J8 exact ACLs: authenticated SELECT only', acl === 'classification={postgres=arwdDxtm/postgres,authenticated=r/postgres} classification_line={postgres=arwdDxtm/postgres,authenticated=r/postgres}', acl);
const pols = owner(`SELECT string_agg(tablename || ':' || policyname || ':' || cmd, ',' ORDER BY tablename, policyname) FROM pg_policies WHERE tablename IN ('classification','classification_line');`);
check('J9 policies exactly as frozen: ADMIN SELECT + OPERATOR own SELECT per table, no write policy',
  pols === 'classification:classification_admin_select:SELECT,classification:classification_operator_select:SELECT,'
  + 'classification_line:classification_line_admin_select:SELECT,classification_line:classification_line_operator_select:SELECT', pols);

// ═══════════════════════════════════════════════════════════════════════════
section('K', 'SECURITY DEFINER');

const definers = owner(`SELECT string_agg(proname, ',' ORDER BY proname) FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace;`);
check('K1 SECURITY DEFINER inventory = previous 26 + register_classification + built later-phase RPCs', definers === ALL_DEFINERS, definers);
const hard = owner(`SELECT prosecdef || ':' || (coalesce(proconfig, '{}') @> ARRAY['search_path=public']) || ':' || pg_get_userbyid(proowner) || ':'
  || (proacl IS NOT NULL AND NOT EXISTS (SELECT 1 FROM aclexplode(proacl) a WHERE a.grantee = 0)) || ':' || has_function_privilege('anon', oid, 'EXECUTE')
  || ':' || has_function_privilege('authenticated', oid, 'EXECUTE') || ':' || has_function_privilege('service_role', oid, 'EXECUTE')
  FROM pg_proc WHERE proname = 'register_classification';`);
check('K2 DEFINER, search_path=public, owner postgres, no PUBLIC, anon no, authenticated yes, service_role no', hard === 'true:true:postgres:true:false:true:false', hard);
const args = owner(`SELECT pg_get_function_identity_arguments(oid) FROM pg_proc WHERE proname = 'register_classification';`);
check('K3 exact frozen signature; no actor / role / user / flock parameter',
  args === 'p_idempotency_key uuid, p_classification_date date, p_lines jsonb, p_location character varying, p_reason text'
  && !/(user|actor|role|performed|created_by|uid|flock|shed|production)/i.test(owner(`SELECT array_to_string(proargnames, ',') FROM pg_proc WHERE proname = 'register_classification';`)), args);

// ═══════════════════════════════════════════════════════════════════════════
section('L', 'Atomicity (injected failures)');

owner(`
CREATE SCHEMA p19_harness;
CREATE TABLE p19_harness.fail_on (target TEXT, k TEXT, qty INTEGER);
CREATE FUNCTION p19_harness.line_ins() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM p19_harness.fail_on f JOIN public.classification c ON c.id = NEW.classification_id
              WHERE f.target = 'line' AND f.k = c.idempotency_key::TEXT AND f.qty = NEW.quantity) THEN
    RAISE EXCEPTION 'HARNESS_FAIL_LINE';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION p19_harness.audit_ins() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.entity_type = 'classification' AND EXISTS (SELECT 1 FROM p19_harness.fail_on f JOIN public.classification c ON c.id::TEXT = NEW.entity_id
              WHERE f.target = 'audit' AND f.k = c.idempotency_key::TEXT) THEN
    RAISE EXCEPTION 'HARNESS_FAIL_AUDIT';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER p19_line_ins BEFORE INSERT ON public.classification_line FOR EACH ROW EXECUTE FUNCTION p19_harness.line_ins();
CREATE TRIGGER p19_audit_ins BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION p19_harness.audit_ins();`);
try {
  for (const [what, targetName, qty, lines, code] of [
    ['after the session insert, the FIRST line fails', 'line', 101, [L(G.XL, 101), L(G.N1, 5), L(G.N2, 6)], 'HARNESS_FAIL_LINE'],
    ['after two lines, a LATER line fails', 'line', 303, [L(G.XL, 1), L(G.N1, 2), L(G.N2, 303)], 'HARNESS_FAIL_LINE'],
    ['after all lines, the audit fails', 'audit', null, [L(G.XL, 1), L(G.N1, 2)], 'HARNESS_FAIL_AUDIT'],
  ]) {
    const key = newKey();
    owner(`DELETE FROM p19_harness.fail_on; INSERT INTO p19_harness.fail_on VALUES ('${targetName}', '${key}', ${qty === null ? 'NULL' : qty});`);
    snap = snapshot();
    r = ADMIN(`SELECT ${classCall(key, '2026-05-16', lines)};`);
    check(`L ${what} → full rollback: no session, no line, no audit`,
      raised(r, code) && snapshot() === snap && owner(`SELECT count(*) FROM classification WHERE idempotency_key = '${key}';`) === '0', firstErr(r));
  }
} finally {
  owner(`DROP SCHEMA IF EXISTS p19_harness CASCADE;`);
}
check('L1 harness triggers removed', owner(`SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'p19_%';`) === '0');

// ═══════════════════════════════════════════════════════════════════════════
section('M', 'No flock reference / no invented traceability');

const flockCols = owner(`SELECT coalesce(string_agg(table_name || '.' || column_name, ','), '') FROM information_schema.columns
  WHERE table_name IN ('classification','classification_line') AND column_name ~* '(flock|lote|shed|galpon|production|produccion|origin|source)';`);
check('M1 no flock / shed / production / origin column in classification or classification_line', flockCols === '', flockCols);
const flockFks = owner(`SELECT coalesce(string_agg(conname, ','), '') FROM pg_constraint WHERE contype = 'f'
  AND conrelid IN ('classification'::regclass, 'classification_line'::regclass)
  AND confrelid IN ('flocks'::regclass, 'sheds'::regclass, 'daily_production'::regclass, 'population_events'::regclass);`);
check('M2 no FK from Phase 19 tables to flocks / sheds / daily_production / population_events', flockFks === '', flockFks);
check('M3 no join/allocation table linking classification to flocks or production',
  owner(`SELECT coalesce(string_agg(table_name, ','), '') FROM information_schema.tables WHERE table_schema = 'public'
         AND table_name ~* 'classification' AND table_name NOT IN ('classification','classification_line','classification_grade', ${ADR005_VIEWS});`) === '');
check('M4 no other table references classification (nothing downstream infers origin; the ADR-012 self-reference is the version chain)',
  owner(`SELECT coalesce(string_agg(conrelid::regclass::TEXT, ','), '') FROM pg_constraint WHERE contype = 'f' AND confrelid = 'classification'::regclass
         AND conrelid NOT IN ('classification_line'::regclass, 'classification'::regclass);`) === '');
const mExtra = classify(ADMIN, '2026-05-17', [{ classification_grade_id: G.XL, quantity: 9, flock_id: MISSING_UUID, shed_id: MISSING_UUID }]);
check('M5 an extra "flock_id" inside a line is not a parameter and is stored nowhere (the session carries no origin)',
  mExtra.line_count === 1 && linesOf(mExtra.classification_id) === 'XL:9'
  && owner(`SELECT count(*) FROM information_schema.columns WHERE table_name IN ('classification','classification_line') AND column_name LIKE '%flock%';`) === '0');

// ═══════════════════════════════════════════════════════════════════════════
section('S', 'Concurrency (independent PostgreSQL sessions)');

const raceKey = newKey();
x = await race(OPA, classCall(raceKey, '2026-05-18', [L(G.XL, 5)], 'Mesa R'), classCall(raceKey, '2026-05-18', [L(G.XL, 6)], 'Mesa R'), 'p19-key');
check('S1 same idempotency_key race: B waited, then DUPLICATE_CLASSIFICATION; exactly one session and one line',
  x.aIn && x.bWait && x.ra.ok && raised(x.rb, 'DUPLICATE_CLASSIFICATION')
  && owner(`SELECT count(*) || '|' || (SELECT count(*) FROM classification_line l JOIN classification c ON c.id = l.classification_id WHERE c.idempotency_key = '${raceKey}')
            FROM classification WHERE idempotency_key = '${raceKey}';`) === '1|1', firstErr(x.rb));
const k1 = newKey();
const k2 = newKey();
x = await race(OPA, classCall(k1, '2026-05-19', [L(G.XL, 7)], 'Mesa R'), classCall(k2, '2026-05-19', [L(G.XL, 8)], 'Mesa R'), 'p19-two', false);
check('S2 different keys, same date and location, concurrently: both succeed (no uniqueness by date/location)',
  x.aIn && x.ra.ok && x.rb.ok
  && owner(`SELECT count(*) FROM classification WHERE classification_date = '2026-05-19' AND location = 'Mesa R' AND idempotency_key IN ('${k1}','${k2}');`) === '2',
  `${firstErr(x.ra)} / ${firstErr(x.rb)}`);

// ═══════════════════════════════════════════════════════════════════════════
section('E2E', 'Classification end to end');

const e1 = classify(A, '2026-05-20', [L(G.XL, 100), L(G.N1, 200), L(G.N2, 150), L(G.N3, 50)], 'Mesa 1');
check('E1 operator A, session 1 (Mesa 1): line_count 4, total_quantity 500', e1.line_count === 4 && e1.total_quantity === 500, JSON.stringify(e1));
const e2 = classify(A, '2026-05-20', [L(G.XL, 80), L(G.N1, 120)], 'Mesa 1');
check('E2 session 2, same date and location, different key: an independent session with total 200',
  e2.classification_id !== e1.classification_id && e2.line_count === 2 && e2.total_quantity === 200);
const both = `id IN ('${e1.classification_id}','${e2.classification_id}')`;
check('E3 operator A sees both sessions', visible(A, 'classification', both) === '2');
check('E4 operator B sees neither', visible(B, 'classification', both) === '0'
  && visible(B, 'classification_line', `classification_id IN ('${e1.classification_id}','${e2.classification_id}')`) === '0');
check('E5 ADMIN sees both (6 lines)', visible(ADMIN, 'classification', both) === '2'
  && visible(ADMIN, 'classification_line', `classification_id IN ('${e1.classification_id}','${e2.classification_id}')`) === '6');
check('E6 no flock can be derived or attached: the sessions carry only date, location, author, graded quantities and the ADR-012 version chain',
  owner(`SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_name = 'classification';`)
  === 'id,idempotency_key,classification_date,location,created_at,created_by,version_seq,is_current,supersedes_id,rectification_reason');

// ═══════════════════════════════════════════════════════════════════════════
section('N', 'No economic effect (whole suite)');

check('N1 across every successful call of the suite: no operation, posting, ledger, purchase, order, production or flock change', econ() === econAtStart, `${econAtStart} → ${econ()}`);
} finally {
  cleanup();
}

section('Z', 'Cleanup');
const left = owner(`SELECT (SELECT count(*) FROM classification WHERE idempotency_key::TEXT LIKE '${KEY_PREFIX}%')
  + (SELECT count(*) FROM classification_grade WHERE nombre LIKE '${TAG}%') + (SELECT count(*) FROM perfiles WHERE id = '${OPB}')
  + (SELECT count(*) FROM information_schema.schemata WHERE schema_name = 'p19_harness') + (SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'p19_%');`);
check('Z1 all P19-TEST sessions, the inactive-grade fixture, operator B, harness schema and triggers removed; seed grades untouched',
  left === '0' && owner(`SELECT count(*) FROM classification_grade WHERE activo;`) === '6', left);
const closedLeft = owner(`SELECT count(*) FROM management_period WHERE status = 'CLOSED' AND periodo_fecha IN (${CLOSED_BY_SUITE.map((m) => `'${m}'`).join(',')});`);
check('Z2 periods closed by the suite are OPEN again', closedLeft === '0', closedLeft);

console.log(`\n  ══ CLASSIFICATION RESULT: ${pass} passed, ${fail} failed ══\n`);
if (fail > 0) {
  console.log('  Failures:');
  for (const f of failures) console.log(`    - ${f.label}${f.detail !== undefined ? ` :: ${f.detail}` : ''}`);
  console.log('');
}
process.exit(fail === 0 ? 0 : 1);
