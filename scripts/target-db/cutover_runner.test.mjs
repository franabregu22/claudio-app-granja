#!/usr/bin/env node
/**
 * PHASE 31 Step 1 — S1-1 cutover runner regression (scripts/phase31/migrate-cutover.mjs). LOCAL TEST DATABASE ONLY.
 *
 * Synthetic data only: synthetic legacy extract (no real names), synthetic Auth users (@test.local), synthetic
 * openings. The target is the guarded local stack in LOCAL_CUTOVER_REHEARSAL mode. The suite resets the local
 * stack (guarded `supabase db reset` + apply.mjs) at the start and at the end, like the CT contract.
 *
 * Usage (WSL, official CLI): TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" node scripts/target-db/cutover_runner.test.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { assertSafeDestructiveTarget, assertSafeCliOperation, assertNoProductionCredentials } from '../test-env/guard.mjs';
import { cutoverGateFailures, phase26GateFailures, phase31ContractFailures } from '../phase31/cutover-config.mjs';
import { buildPlan, writePlanFile, CutoverError } from '../phase31/migrate-cutover.mjs';

assertNoProductionCredentials(process.env);
assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);
const REPO = resolve(import.meta.dirname, '..', '..');
const RUNNER = join(REPO, 'scripts', 'phase31', 'migrate-cutover.mjs');
const container = (spawnSync('docker', ['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout || '').trim().split('\n')[0];
if (!container) { console.error('no local supabase_db container'); process.exit(1); }
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
function psql(sql) {
  const r = spawnSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    { encoding: 'utf8', input: sql });
  if (r.status !== 0) throw new Error(r.stderr);
  return (r.stdout || '').trim();
}
let pass = 0; let fail = 0;
const check = (label, cond, detail = '') => { if (cond) { pass++; console.log(`    OK   ${label}`); } else { fail++; console.log(`    MAL  ${label} :: ${String(detail).slice(0, 500)}`); } };
function reset() {
  const args = ['db', 'reset'];
  assertSafeCliOperation(args);
  const r = spawnSync('supabase', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0 || /linked project|remote database/i.test(`${r.stdout}${r.stderr}`)) throw new Error(`guarded reset failed\n${r.stderr}`);
  const a = spawnSync(process.execPath, [join(REPO, 'scripts', 'target-db', 'apply.mjs')], { cwd: REPO, encoding: 'utf8', env: process.env });
  if (a.status !== 0) throw new Error(`apply failed\n${a.stderr}`);
}

// ── synthetic legacy extract (shape of the Phase 26 EXTRACT_SQL) ─────────────
const U = (n) => `c0de0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ADMIN = U(1); const OPER = U(2); const CL1 = U(11); const CL2 = U(12); const CL3 = U(13); const PR1 = U(21);
const FLA = U(31); const FLB = U(32);
const SOURCES26 = ['precios_historial', 'pedidos', 'pedido_lineas', 'pagos', 'pago_en_caja', 'movimientos_caja', 'arqueos_caja', 'cheques', 'comisiones',
  'recuentos_lote', 'mercadopago_raw', 'mercadopago_movements', 'mp_source_record', 'mp_financial_movement', 'mp_movement_source_link',
  'mp_source_link_resolution', 'monthly_reconciliation', 'reconciliation_snapshot', 'import_period_coverage',
  'perfiles', 'clientes', 'productos', 'categorias_finanzas', 'lotes', 'cuentas_caja', 'producciones'];
const src = {
  perfiles: [{ id: ADMIN, rol: 'dueño' }, { id: OPER, rol: 'colaborador' }],
  clientes: [{ id: CL1, nombre: 'S1 Cliente Uno', activo: true }, { id: CL2, nombre: 'S1 Cliente Dos', activo: true }, { id: CL3, nombre: 'S1 Cliente Tres', activo: false }],
  productos: [{ id: PR1, nombre: 'S1 Huevo', categoria: 'huevos', unidad: 'maple', activo: true }],
  categorias_finanzas: [{ id: 901, categoria_tecnica: 'Gasto', subcategoria: 'S1 Alimento', categoria_analisis: 'Operativo', activo: true },
    { id: 902, categoria_tecnica: 'Gasto', subcategoria: 'S1 Luz', categoria_analisis: 'Operativo', activo: true }],
  lotes: [{ id: FLA, galpon: 'S1 Galpón A', fecha_entrada: '2026-01-10', fecha_salida: null, aves: 1000, linea: 'S1', code: 'GA-1', estado: 'Activo' },
    { id: FLB, galpon: 'S1 Galpón B', fecha_entrada: '2026-02-01', fecha_salida: null, aves: 500, linea: 'S1', code: 'GB-1', estado: 'Activo' }],
  mortality: [{ id: 7001, galpon: 'S1 Galpón A', fecha: '2026-09-05', deaths: 3 }, { id: 7002, galpon: 'S1 Galpón B', fecha: '2026-09-06', deaths: 2 }],
  production_rows: 2,
  counts: Object.fromEntries(SOURCES26.map((t) => [t, 0])),
};
const CUT = '2026-10-15T09:00:00-03:00';
const BATCH = 'P31-S1TEST-CUTOVER';
const baseConfig = () => ({
  config_id: 'P31-S1TEST', config_version: 1, mode_allowed: 'CUTOVER', description: 'synthetic regression config (LOCAL_CUTOVER_REHEARSAL)',
  source: { snapshot_id: 'SYNTHETIC', snapshot_dir: '/nonexistent', manifest_sha256: '0'.repeat(64), legacy_copy_container: 'granja-legacy-copy', legacy_copy_database: 'postgres', source_system: 'legacy_supabase' },
  target: { kind: 'LOCAL_CUTOVER_REHEARSAL', expected_host: '127.0.0.1', forbidden_hosts: [], psql_client_container: container, staging_schema: 'phase26_migration' },
  import_batch: BATCH,
  cutover_boundary: { cutover_at: CUT, timezone: 'America/Argentina/Buenos_Aires', evidence_ref: 'SYNTHETIC-S1' },
  clients: { migrate_master: true, opening_balance_method: 'OWNER_VALIDATED', evidence_ref: 'SYNTHETIC-S1',
    opening_balances: { [CL1]: '1500.50', [CL2]: '0.00', [CL3]: '-200.00' }, historical_pedidos_migrated: false, historical_pagos_migrated: false },
  suppliers: { opening_balances: 'NONE', outstanding_obligations: 'NONE', evidence_ref: 'SYNTHETIC-S1' },
  instruments: { open_instruments: 'NONE', excluded_test_rows: [], evidence_ref: 'SYNTHETIC-S1' },
  treasury: { account_map: {}, opening_balance_method: 'OWNER_VALIDATED', evidence_ref: 'SYNTHETIC-S1',
    opening_balances: { BNA: '10000.00', 'Caja chica': '2500.25', 'Mercado Pago': '7300.10', Patagonia: '0' } },
  population: { method: 'P-b', evidence_ref: 'SYNTHETIC-S1', counts: { [FLA]: 990, [FLB]: 498 },
    expected: { [FLA]: { code: 'GA-1', initial: 1000, mortality_events: 1, mortality_total: 3, population: 997 },
      [FLB]: { code: 'GB-1', initial: 500, mortality_events: 1, mortality_total: 2, population: 498 } },
    expected_totals: { mortality_events: 2, mortality_total: 5 } },
  flocks: { owner_overrides: {}, estado_map: { Activo: 'ACTIVE', Retirado: 'RETIRED' } },
  users: { role_map: { 'dueño': 'ADMIN', colaborador: 'OPERATOR' }, email_policy: { mode: 'REAL' },
    operator_assignments: { assignments: [{ operator_id: OPER, flock_id: FLA }, { operator_id: OPER, flock_id: FLB }] } },
  auth: { required_identity_provider: 'email', allowed_extra_user_ids: [], evidence_ref: 'SYNTHETIC-S1' },
  products: { type_by_legacy_categoria: { huevos: 'VENDIBLE' }, unit_map: { maple: 'CARTON' } },
  expense_categories: { migrate_master: true, class_policy: 'OWNER_MAPPED', class_map: { 901: 'DIRECT', 902: 'INDIRECT' }, class_map_evidence_ref: 'SYNTHETIC-S1' },
  evidence_only_sources: SOURCES26.slice(0, 19),
});

const work = mkdtempSync(join(tmpdir(), 'p31-s1-'));
function prepare(cfg, name) {
  const dir = join(work, name);
  spawnSync(process.execPath, ['-e', `require('fs').mkdirSync(${JSON.stringify(dir)}, { recursive: true })`]);
  const text = JSON.stringify(cfg, null, 2);
  writeFileSync(join(dir, 'config.json'), text);
  writePlanFile(dir, sha256(text), cfg, buildPlan(src, cfg), { synthetic: true });
  return dir;
}
const LOCAL_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/postgres';
function runner(cmd, dir, env = {}, extra = []) {
  const r = spawnSync(process.execPath, [RUNNER, cmd, '--config', join(dir, 'config.json'), '--out', dir, ...extra],
    { cwd: REPO, encoding: 'utf8', env: { ...process.env, CUTOVER_TARGET_DB_URL: LOCAL_URL, ...env } });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}` };
}
const authUsers = (emails = {}) => `INSERT INTO auth.users (id, email, is_sso_user, is_anonymous) VALUES
  ('${ADMIN}', '${emails.admin ?? 's1-admin@test.local'}', false, false), ('${OPER}', '${emails.oper ?? 's1-oper@test.local'}', false, false);
INSERT INTO auth.identities (user_id, provider, provider_id, identity_data) VALUES
  ('${ADMIN}', 'email', '${ADMIN}', '{"sub":"${ADMIN}"}'::jsonb), ('${OPER}', 'email', '${OPER}', '{"sub":"${OPER}"}'::jsonb);`;

try {
  console.log('\n  [config contract]');
  const tpl = JSON.parse(readFileSync(join(REPO, 'scripts', 'phase31', 'CUTOVER_CONFIG_TEMPLATE.json'), 'utf8'));
  const reh = JSON.parse(readFileSync(join(REPO, '.planning', 'phase26-evidence', 'MIGRATION_REHEARSAL_CONFIG_V1.json'), 'utf8'));
  check('K1 the committed template is refused (placeholders)', cutoverGateFailures(tpl).some((x) => x.startsWith('REQUIRES_FINAL_CUTOVER_VALUE')), cutoverGateFailures(tpl).length);
  check('K2 the Phase 26 gate list is carried verbatim: 28 refusals on the rehearsal config, plus the Phase 31 contract', phase26GateFailures(reh).length === 28 && phase31ContractFailures(reh).length > 0,
    `${phase26GateFailures(reh).length}/${phase31ContractFailures(reh).length}`);
  check('K3 the synthetic regression config passes every gate', cutoverGateFailures(baseConfig()).length === 0, cutoverGateFailures(baseConfig()).join(' | '));
  const bad = (mut) => { const c = baseConfig(); mut(c); return cutoverGateFailures(c); };
  check('K4 malformed money is refused', bad((c) => { c.clients.opening_balances[CL1] = '1.234'; }).some((x) => /decimal string/.test(x)));
  check('K5 an unknown key is refused', bad((c) => { c.clients.surprise = 1; }).some((x) => /unknown key clients.surprise/.test(x)));
  check('K6 cutover_at without explicit offset is refused (no implicit timezone, no "now")', bad((c) => { c.cutover_boundary.cutover_at = '2026-10-15T09:00:00'; }).some((x) => /cutover_at/.test(x)));
  check('K7 treasury must name exactly the four accounts', bad((c) => { delete c.treasury.opening_balances.Patagonia; }).some((x) => /exactly/.test(x)));
  check('K8 a PRODUCTION_TARGET config with SYNTHETIC evidence is refused', bad((c) => { c.target.kind = 'PRODUCTION_TARGET'; c.target.expected_host = 'db.x.supabase.co'; c.target.forbidden_hosts = ['db.legacy.supabase.co']; })
    .some((x) => /SYNTHETIC/.test(x)));
  let thrown = null;
  try { const c = baseConfig(); delete c.clients.opening_balances[CL2]; buildPlan(src, c); } catch (e) { thrown = e; }
  check('K9 a migrated client without an opening entry stops the plan (no silent zero)', thrown instanceof CutoverError && thrown.code === 'PLAN', thrown?.message);
  thrown = null;
  try { const c = baseConfig(); c.population.expected[FLA].population = 996; buildPlan(src, c); } catch (e) { thrown = e; }
  check('K10 population arithmetic that differs from the owner-accepted expectation stops the plan', thrown?.code === 'ARITHMETIC', thrown?.message);

  console.log('\n  [cutover load on a fresh local target]');
  reset();
  const dir = prepare(baseConfig(), 'ok');
  let r = runner('load', dir);
  check('L1 Auth not restored → AUTH_USER_MISSING, nothing written', !r.ok && /AUTH_USER_MISSING/.test(r.out) && psql('SELECT count(*) FROM perfiles;') === '0', r.out.slice(-400));
  psql(authUsers({ admin: 'legacy-x@example.invalid' }));
  r = runner('load', dir);
  check('L2 a synthetic @example.invalid Auth email is refused', !r.ok && /AUTH_EMAIL_INVALID/.test(r.out) && psql('SELECT count(*) FROM perfiles;') === '0', r.out.slice(-300));
  psql(`UPDATE auth.users SET email = 's1-admin@test.local' WHERE id = '${ADMIN}';
INSERT INTO auth.users (id, email, is_sso_user, is_anonymous) VALUES ('${U(99)}', 's1-extra@test.local', false, false);`);
  r = runner('load', dir);
  check('L3 an unexpected auth user (not planned, not allowed) is refused', !r.ok && /AUTH_UNEXPECTED_USER/.test(r.out), r.out.slice(-300));
  psql(`DELETE FROM auth.users WHERE id = '${U(99)}';
INSERT INTO mp_cutover_boundary (cutover_at, import_batch, evidence_ref) VALUES ('2000-01-01T00:00:00Z', 'LOCAL-TEST-FIXTURE', 'x');`);
  r = runner('load', dir);
  check('L4 a target carrying the local test boundary fixture is refused', !r.ok && /BOUNDARY/.test(r.out), r.out.slice(-300));
  psql('DELETE FROM mp_cutover_boundary;');
  const authBefore = psql('SELECT count(*) FROM auth.users;');
  r = runner('load', dir);
  check('L5 load succeeds with the restored Auth users', r.ok, r.out.slice(-800));
  check('L6 the runner wrote no auth.users row (count unchanged) and every profile email equals its auth.users email',
    psql('SELECT count(*) FROM auth.users;') === authBefore
    && psql(`SELECT count(*) FROM perfiles p JOIN auth.users u ON u.id = p.id AND u.email = p.email;`) === '2'
    && psql(`SELECT count(*) FROM perfiles WHERE email ILIKE '%@example.invalid';`) === '0');
  check('L7 profile UUIDs = auth UUIDs = legacy profile ids', psql('SELECT string_agg(id::text, \',\' ORDER BY id) FROM perfiles;') === [ADMIN, OPER].sort().join(','));
  check('L8 client openings: one OPENING_BALANCE per non-zero client on the cutover date (zero → no row)',
    psql(`SELECT string_agg(cliente_id || '=' || signed_amount || '@' || effective_date, ',' ORDER BY cliente_id) FROM client_ledger;`) === `${CL1}=1500.50@2026-10-15,${CL3}=-200.00@2026-10-15`,
    psql('SELECT string_agg(cliente_id || \'=\' || signed_amount, \',\') FROM client_ledger;'));
  check('L9 treasury openings: one ADJUSTMENT with one posting per non-zero account (Patagonia 0 → none)',
    psql(`SELECT string_agg(a.nombre || '=' || fp.signed_amount, ',' ORDER BY a.nombre) FROM financial_posting fp JOIN financial_account a ON a.id = fp.financial_account_id;`)
      === 'BNA=10000.00,Caja chica=2500.25,Mercado Pago=7300.10');
  check('L10 MP cutover boundary recorded exactly (ADR-017) and audited once',
    psql(`SELECT (cutover_at = '${CUT}'::timestamptz) || '|' || import_batch FROM mp_cutover_boundary;`) === `true|${BATCH}`
    && psql(`SELECT count(*) FROM audit_events WHERE action = 'PHASE31_BOUNDARY';`) === '1');
  check('L11 P-b: mortality history + one COUNT_ADJUSTMENT on the cutover date where the count differs (A: 997 → 990; B: no adjustment)',
    psql(`SELECT string_agg(event_type || ':' || delta || '@' || event_date, ',' ORDER BY event_type, flock_id) FROM population_events;`)
      === 'MORTALITY:-3@2026-09-05,MORTALITY:-2@2026-09-06,COUNT_ADJUSTMENT:-7@2026-10-15',   // enum declaration order
    psql(`SELECT string_agg(event_type || ':' || delta || '@' || event_date, ',' ORDER BY event_type, flock_id) FROM population_events;`));
  r = runner('validate', dir);
  check('L12 validate-cutover.sql C01–C26 all PASS', r.ok && /26 checks, 0 failed/.test(r.out), r.out.slice(-1200));
  const snap = () => psql(`SELECT concat_ws('|', (SELECT count(*) FROM perfiles), (SELECT count(*) FROM client_ledger), (SELECT count(*) FROM financial_posting),
    (SELECT count(*) FROM population_events), (SELECT count(*) FROM audit_events), (SELECT count(*) FROM phase26_migration.lineage), (SELECT count(*) FROM mp_cutover_boundary));`);
  const s1 = snap();
  r = runner('load', dir);
  check('L13 rerun is idempotent: no new row anywhere', r.ok && snap() === s1, `${s1} → ${snap()}`);

  console.log('\n  [Auth rehearsal checks]');
  writeFileSync(join(dir, 'legacy-ids.txt'), `${OPER}\n${ADMIN}\n`);
  r = runner('auth-check', dir, {}, ['--legacy-auth-ids', join(dir, 'legacy-ids.txt')]);
  check('A1 auth-check PASS: identical sorted UUID lists, email identities present, no session rows', r.ok && /id lists are identical \(2\)/.test(r.out) && /PASS/.test(r.out), r.out.slice(-400));
  check('A2 auth-check prints no email, hash or token', !/@test\.local|encrypted_password|\$2[aby]\$/.test(r.out));
  writeFileSync(join(dir, 'legacy-ids2.txt'), `${ADMIN}\n${U(77)}\n`);
  r = runner('auth-check', dir, {}, ['--legacy-auth-ids', join(dir, 'legacy-ids2.txt')]);
  check('A3 a differing legacy id list → AUTH_UUID_MISMATCH', !r.ok && /AUTH_UUID_MISMATCH/.test(r.out), r.out.slice(-300));
  psql(`INSERT INTO auth.sessions (id, user_id) VALUES (gen_random_uuid(), '${ADMIN}');`);
  r = runner('auth-check', dir);
  check('A4 a migrated session row → AUTH_SESSIONS_PRESENT', !r.ok && /AUTH_SESSIONS_PRESENT/.test(r.out), r.out.slice(-300));
  psql('DELETE FROM auth.sessions;');

  console.log('\n  [target guards]');
  r = runner('load', dir, { CUTOVER_TARGET_DB_URL: 'postgresql://postgres:postgres@10.9.9.9:5432/postgres' });
  check('T1 a target host different from config.target.expected_host is refused', !r.ok && /differs from config target.expected_host/.test(r.out), r.out.slice(-200));
  r = runner('load', dir, { CUTOVER_TARGET_DB_URL: '' });
  check('T2 no CUTOVER_TARGET_DB_URL → refused', !r.ok && /CUTOVER_TARGET_DB_URL is not set/.test(r.out));
  check('T3 the URL / password never appears in the runner output', !/postgres:postgres@/.test(r.out));
  const inRepo = spawnSync(process.execPath, [RUNNER, 'gates', '--config', join(REPO, 'scripts', 'phase31', 'CUTOVER_CONFIG_TEMPLATE.json'), '--out', join(REPO, 'tmp-p31')], { cwd: REPO, encoding: 'utf8' });
  check('T4 --config / --out inside the repository are refused', inRepo.status !== 0 && /outside the repository/.test(`${inRepo.stdout}${inRepo.stderr}`));
  const c2 = baseConfig(); c2.import_batch = 'P31-S1TEST-OTHER';
  const dir2 = prepare(c2, 'other');
  r = runner('load', dir2);
  check('T5 a second load with another batch on a used target is refused (TARGET_IN_USE / BOUNDARY)', !r.ok && /TARGET_IN_USE|BOUNDARY/.test(r.out), r.out.slice(-300));
} finally {
  reset();
  rmSync(work, { recursive: true, force: true });
}
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
