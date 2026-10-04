#!/usr/bin/env node
/**
 * Phase 31 migrate-cutover.mjs — PRODUCTION_TARGET project-ref guard. OFFLINE: every refused case stops before any
 * connection (no docker / psql call is reached), and no accepted case exists here (that would need a real target).
 *
 * Usage: node scripts/phase31/migrate-cutover.test.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { cutoverGateFailures } from './cutover-config.mjs';
import { buildPlan, writePlanFile } from './migrate-cutover.mjs';

const REPO = resolve(import.meta.dirname, '..', '..');
const RUNNER = join(REPO, 'scripts', 'phase31', 'migrate-cutover.mjs');
const REF = 'abcdefghijklmnopqrst'; const OTHER = 'zyxwvutsrqponmlkjihg'; const LEGACY = 'legacyrefxxxxxxxxxxx';
let pass = 0; let fail = 0;
const check = (label, cond, detail = '') => { if (cond) { pass++; console.log(`    OK   ${label}`); } else { fail++; console.log(`    MAL  ${label} :: ${String(detail).slice(0, 300)}`); } };

const U = (n) => `c0de0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SOURCES26 = ['precios_historial', 'pedidos', 'pedido_lineas', 'pagos', 'pago_en_caja', 'movimientos_caja', 'arqueos_caja', 'cheques', 'comisiones',
  'recuentos_lote', 'mercadopago_raw', 'mercadopago_movements', 'mp_source_record', 'mp_financial_movement', 'mp_movement_source_link',
  'mp_source_link_resolution', 'monthly_reconciliation', 'reconciliation_snapshot', 'import_period_coverage',
  'perfiles', 'clientes', 'productos', 'categorias_finanzas', 'lotes', 'cuentas_caja', 'producciones'];
const src = { perfiles: [{ id: U(1), rol: 'dueño' }, { id: U(2), rol: 'colaborador' }], clientes: [{ id: U(11), nombre: 'X', activo: true }],
  productos: [{ id: U(21), nombre: 'H', categoria: 'huevos', unidad: 'maple', activo: true }],
  categorias_finanzas: [{ id: 1, categoria_tecnica: 'a', subcategoria: 'b', categoria_analisis: 'c', activo: true }],
  lotes: [{ id: U(31), galpon: 'G', fecha_entrada: '2026-01-01', fecha_salida: null, aves: 10, linea: 'L', code: 'C', estado: 'Activo' }],
  mortality: [], production_rows: 0, counts: Object.fromEntries(SOURCES26.map((t) => [t, 0])) };
const prodConfig = (over = {}) => ({
  config_id: 'P31-T', config_version: 1, mode_allowed: 'CUTOVER', description: 'offline guard test',
  source: { snapshot_id: 'S', snapshot_dir: '/x', manifest_sha256: '0'.repeat(64), legacy_copy_container: 'granja-legacy-copy', legacy_copy_database: 'postgres', source_system: 'legacy_supabase' },
  target: { kind: 'PRODUCTION_TARGET', expected_host: 'aws-0-sa-east-1.pooler.supabase.com', expected_ref: REF,
    forbidden_hosts: ['aws-0-us-east-2.pooler.supabase.com'], forbidden_refs: [LEGACY], psql_client_container: 'no-such-container', staging_schema: 'phase26_migration', ...over },
  import_batch: 'P31-TEST-GUARD',
  cutover_boundary: { cutover_at: '2026-10-04T00:00:00-03:00', timezone: 'America/Argentina/Buenos_Aires', evidence_ref: 'owner record' },
  clients: { migrate_master: true, opening_balance_method: 'OWNER_VALIDATED', evidence_ref: 'e', opening_balances: { [U(11)]: '0.00' }, historical_pedidos_migrated: false, historical_pagos_migrated: false },
  suppliers: { opening_balances: 'NONE', outstanding_obligations: 'NONE', evidence_ref: 'e' }, instruments: { open_instruments: 'NONE', evidence_ref: 'e' },
  treasury: { opening_balance_method: 'OWNER_VALIDATED', evidence_ref: 'e', opening_balances: { BNA: '0', 'Caja chica': '0', 'Mercado Pago': '0', Patagonia: '0' } },
  population: { method: 'P-a', owner_acceptance_ref: 'owner accepted', evidence_ref: 'e',
    expected: { [U(31)]: { code: 'C', initial: 10, mortality_events: 0, mortality_total: 0, population: 10 } }, expected_totals: { mortality_events: 0, mortality_total: 0 } },
  flocks: { owner_overrides: {}, estado_map: { Activo: 'ACTIVE' } },
  users: { role_map: { 'dueño': 'ADMIN', colaborador: 'OPERATOR' }, email_policy: { mode: 'REAL' }, operator_assignments: { assignments: [{ operator_id: U(2), flock_id: U(31) }] } },
  auth: { required_identity_provider: 'email', allowed_extra_user_ids: [], evidence_ref: 'e' },
  products: { type_by_legacy_categoria: { huevos: 'VENDIBLE' }, unit_map: { maple: 'CARTON' } },
  expense_categories: { migrate_master: true, class_policy: 'OWNER_MAPPED', class_map: { 1: 'DIRECT' }, class_map_evidence_ref: 'e' },
  evidence_only_sources: SOURCES26.slice(0, 19),
});

const dir = mkdtempSync(join(tmpdir(), 'p31-refguard-'));
try {
  check('R1 a complete PRODUCTION_TARGET config with expected_ref / forbidden_refs passes the contract', cutoverGateFailures(prodConfig()).length === 0, cutoverGateFailures(prodConfig()).join(' | '));
  check('R2 PRODUCTION_TARGET without target.expected_ref → refused', cutoverGateFailures(prodConfig({ expected_ref: undefined })).some((x) => /expected_ref/.test(x)));
  check('R3 PRODUCTION_TARGET without target.forbidden_refs → refused', cutoverGateFailures(prodConfig({ forbidden_refs: [] })).some((x) => /forbidden_refs/.test(x)));
  const EXC = { open_instruments: 'EXCLUDED_POST_CUTOVER_MANUAL_ENTRY', evidence_ref: 'e', owner_decision_ref: 'd', post_cutover_task: 't', client_opening_balance_basis: 'BEFORE_OPEN_CHEQUES' };
  const insF = (ins) => cutoverGateFailures({ ...prodConfig(), instruments: ins }).filter((x) => /instruments/.test(x));
  check('I1 instruments EXCLUDED_POST_CUTOVER_MANUAL_ENTRY with decision / evidence / task / basis → accepted', insF(EXC).length === 0, insF(EXC).join(' | '));
  check('I2 EXCLUDED without owner_decision_ref → refused', insF({ ...EXC, owner_decision_ref: '' }).length === 1);
  check('I3 EXCLUDED with basis AFTER_OPEN_CHEQUES (double count on manual entry) → refused', insF({ ...EXC, client_opening_balance_basis: 'AFTER_OPEN_CHEQUES' }).length === 1);
  check('I4 any other open_instruments value → refused', insF({ open_instruments: 'SOME', evidence_ref: 'e' }).length === 1);
  check('R4 expected_ref equal to a forbidden (legacy) ref → refused', cutoverGateFailures(prodConfig({ expected_ref: LEGACY })).some((x) => /forbidden \(legacy\) ref/.test(x)));

  const cfg = prodConfig(); const text = JSON.stringify(cfg);
  const out = join(dir, 'case'); mkdirSync(out);
  writeFileSync(join(out, 'config.json'), text);
  writePlanFile(out, createHash('sha256').update(text).digest('hex'), cfg, buildPlan(src, cfg), {});
  const load = (url) => {
    const r = spawnSync(process.execPath, [RUNNER, 'load', '--config', join(out, 'config.json'), '--out', out],
      { encoding: 'utf8', env: { ...process.env, CUTOVER_TARGET_DB_URL: url, PHASE31_CUTOVER_CONFIRM: 'P31-TEST-GUARD' } });
    return `${r.stdout || ''}${r.stderr || ''}`;
  };
  let o = load(`postgresql://postgres.${OTHER}:x@aws-0-sa-east-1.pooler.supabase.com:5432/postgres`);
  check('R5 same pooler host, ANOTHER project ref (pooler user) → refused before any connection', /connection project ref zyxwvutsrqponmlkjihg differs from config target.expected_ref/.test(o), o);
  o = load(`postgresql://postgres.${LEGACY}:x@aws-0-sa-east-1.pooler.supabase.com:5432/postgres`);
  check('R6 the LEGACY ref on the expected pooler host → refused', /differs from config target.expected_ref|LEGACY project ref/.test(o), o);
  o = load('postgresql://postgres:x@aws-0-sa-east-1.pooler.supabase.com:5432/postgres');
  check('R7 pooler connection without a project ref in the user → refused (UNKNOWN ref)', /connection project ref UNKNOWN/.test(o), o);
  o = load(`postgresql://postgres.${REF}:x@aws-0-sa-east-1.pooler.supabase.com:5432/postgres`);
  check('R8 the right ref passes the ref guard and stops only at the next step (no such psql client container here)', /psql client container no-such-container is not running/.test(o), o);
  check('R9 no output contains the connection password', !/:x@/.test(o));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
