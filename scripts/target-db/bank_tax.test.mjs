#!/usr/bin/env node
/**
 * ADR-011 — BANK TAX TEST SUITE (Phase 27 acceptance fixes, owner D-WALK-7). LOCAL TEST DATABASE ONLY.
 *
 * RPC 46 register_bank_tax, bank_tax_charge and report_bank_tax_period (migration 0062):
 *   perimeter, validation, one negative posting per tax, authoritative relation to the TRANSFER,
 *   idempotency by external_ref, MP account refused, closed period, report, and P&L fail-closed
 *   (no P&L view changes when a bank tax is registered). transfer_between_accounts is unchanged.
 *
 * Fixtures are synthetic, prefixed "ADR011-TEST", removed at start and end.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *     node scripts/target-db/bank_tax.test.mjs
 */

import { spawnSync } from 'node:child_process';
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

const ADMIN_UID = '11111111-1111-1111-1111-111111111111';
const OPER_UID = '22222222-2222-2222-2222-222222222222';
const MISSING_UUID = '99999999-9999-9999-9999-999999999999';
const TAG = 'ADR011-TEST';

let container;
let pass = 0;
let fail = 0;

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
const asRole = (pgRole, claims, sqlText) => raw(`
BEGIN;
SET LOCAL ROLE ${pgRole};
SET LOCAL "request.jwt.claims" = '${JSON.stringify(claims).replace(/'/g, "''")}';
${sqlText}
COMMIT;`);
const asUser = (uid, sqlText) => asRole('authenticated', { sub: uid, role: 'authenticated' }, sqlText);
const ADMIN = (sqlText) => asUser(ADMIN_UID, sqlText);
const OPER = (sqlText) => asUser(OPER_UID, sqlText);
function adminOk(sqlText) {
  const r = ADMIN(sqlText);
  if (!r.ok) throw new Error(`ADMIN SQL failed:\n${sqlText}\n${r.err}`);
  return r.out;
}
const rpc = (call) => JSON.parse(adminOk(`SELECT ${call};`));
const firstErr = (r) => (r.err.split('\n').find((l) => /ERROR/.test(l)) || r.err.split('\n')[0] || '').slice(0, 140);
const denied = (r) => !r.ok && /permission denied/i.test(r.err);
const raised = (r, code) => !r.ok && new RegExp(`ERROR:\\s+${code}`).test(r.err);

function check(label, condition, detail) {
  if (condition) { pass += 1; console.log(`    OK   ${label}`); }
  else { fail += 1; console.log(`    MAL  ${label}${detail !== undefined ? ` :: ${detail}` : ''}`); }
}
function section(n, title) {
  console.log(`\n  ── ${n}. ${title} ${'─'.repeat(Math.max(0, 54 - title.length))}`);
}

// ── guard, container ───────────────────────────────────────────────────────
const target = assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);
container = (dockerRun(['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}']).stdout || '')
  .trim().split('\n').filter(Boolean)[0];
if (!container) { console.error('  no running supabase_db container. Run `supabase start`.'); process.exit(1); }
const mapping = (dockerRun(['port', container, '5432/tcp']).stdout || '').trim();
if (!mapping.includes(`:${target.port}`)) { console.error(`  container mapping ${mapping} does not match guarded port ${target.port}`); process.exit(1); }
console.log(`  container: ${container}`);

const CURRENT_MONTH = owner(`SELECT date_trunc('month', (NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires'))::DATE;`);
const DAY = CURRENT_MONTH;
const CLOSED_MONTH = '2026-03-01';

// ── fixture lifecycle ──────────────────────────────────────────────────────
const TEST_ACCOUNTS = `(SELECT id FROM financial_account WHERE nombre LIKE '${TAG}%')`;
const TEST_OPS = `(SELECT id FROM financial_operation WHERE external_ref LIKE '${TAG}%'
   UNION SELECT financial_operation_id FROM financial_posting WHERE financial_account_id IN ${TEST_ACCOUNTS})`;
function cleanup() {
  owner(`
CREATE TEMP TABLE _adr011_ops AS SELECT id FROM ${TEST_OPS} o;
DELETE FROM audit_events WHERE entity_type = 'financial_operation' AND entity_id IN (SELECT id::TEXT FROM _adr011_ops);
DELETE FROM bank_tax_charge WHERE financial_operation_id IN (SELECT id FROM _adr011_ops) OR related_operation_id IN (SELECT id FROM _adr011_ops);
DELETE FROM financial_posting WHERE financial_operation_id IN (SELECT id FROM _adr011_ops);
DELETE FROM financial_operation WHERE id IN (SELECT id FROM _adr011_ops);
DELETE FROM financial_account WHERE nombre LIKE '${TAG}%';
UPDATE management_period SET status = 'OPEN', closed_at = NULL WHERE periodo_fecha = '${CLOSED_MONTH}';`);
}
owner(`
INSERT INTO auth.users (id, is_sso_user, is_anonymous) VALUES ('${ADMIN_UID}', false, false), ('${OPER_UID}', false, false)
ON CONFLICT (id) DO NOTHING;
INSERT INTO perfiles (id, email, rol_type, activo) VALUES
  ('${ADMIN_UID}', 'admin@test.local', 'ADMIN', true), ('${OPER_UID}', 'operator@test.local', 'OPERATOR', true)
ON CONFLICT (id) DO NOTHING;
INSERT INTO management_period (periodo_fecha) VALUES ('${CLOSED_MONTH}'), ('${CURRENT_MONTH}') ON CONFLICT DO NOTHING;`);
cleanup();

const mkAccount = (name, type = 'BANK_ACCOUNT', activo = true) =>
  adminOk(`INSERT INTO financial_account (nombre, account_type, activo) VALUES ('${TAG} ${name}', '${type}', ${activo}) RETURNING id;`);
const q = (v) => (v === null ? 'NULL' : `'${v}'`);
const tax = ({ account, amount = 600, date = DAY, kind = 'DEBITOS_CREDITOS', ref, related = null, reason = null }) =>
  `register_bank_tax(${q(account)}, ${amount === null ? 'NULL' : amount}, ${q(date)}, ${q(kind)}, ${q(ref)}, ${related === null ? 'NULL' : related}, ${q(reason)})`;
const balance = (a) => owner(`SELECT COALESCE(SUM(signed_amount), 0)::NUMERIC(15,2) FROM financial_posting WHERE financial_account_id = '${a}';`);
const opsWithRef = (ref) => owner(`SELECT count(*) FROM financial_operation WHERE external_ref = '${ref}';`);
const pnlSnapshot = () => adminOk(`SELECT md5(COALESCE((SELECT string_agg(t::TEXT, '|' ORDER BY t::TEXT) FROM pnl_summary t), '')
  || COALESCE((SELECT string_agg(t::TEXT, '|' ORDER BY t::TEXT) FROM pnl_line_item t), ''));`);

try {
  const A = mkAccount('Banco A');
  const B = mkAccount('Banco B');
  const INACTIVE = mkAccount('Banco inactivo', 'BANK_ACCOUNT', false);
  const MP = owner(`SELECT id FROM financial_account WHERE nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE' LIMIT 1;`);

  section('A', 'Perimeter');
  const fn = owner(`SELECT p.prosecdef || '|' || has_function_privilege('anon', p.oid, 'EXECUTE') || '|' ||
    has_function_privilege('authenticated', p.oid, 'EXECUTE') || '|' || has_function_privilege('service_role', p.oid, 'EXECUTE')
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'register_bank_tax';`);
  check('A1 register_bank_tax: SECURITY DEFINER, EXECUTE only for authenticated', fn === 'true|false|true|false', fn);
  const tp = owner(`SELECT string_agg(privilege_type, ',' ORDER BY privilege_type) FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'bank_tax_charge' AND grantee = 'authenticated';`);
  check('A2 bank_tax_charge: authenticated has SELECT only (no direct write)', tp === 'SELECT', tp);
  const anonGrants = owner(`SELECT count(*) FROM information_schema.role_table_grants WHERE table_schema = 'public'
    AND table_name IN ('bank_tax_charge', 'report_bank_tax_period') AND grantee IN ('anon', 'service_role');`);
  check('A3 anon / service_role have no grant on bank_tax_charge or report_bank_tax_period', anonGrants === '0', anonGrants);
  let r = OPER(`SELECT ${tax({ account: A, ref: `${TAG}-A4` })};`);
  check('A4 OPERATOR → FORBIDDEN, nothing written', raised(r, 'FORBIDDEN') && opsWithRef(`${TAG}-A4`) === '0', firstErr(r));
  r = ADMIN(`INSERT INTO bank_tax_charge (financial_operation_id, tax_kind, financial_account_id, amount, created_by)
             VALUES (1, 'DEBITOS_CREDITOS', '${A}', 1, '${ADMIN_UID}');`);
  check('A5 direct INSERT into bank_tax_charge is denied', denied(r), firstErr(r));
  const vi = owner(`SELECT reloptions::TEXT FROM pg_class WHERE relname = 'report_bank_tax_period';`);
  check('A6 report_bank_tax_period is security_invoker', /security_invoker=true/.test(vi), vi);

  section('B', 'Validation');
  const T = rpc(`transfer_between_accounts('${A}', '${B}', 100000, '${DAY}', '${TAG}-T1', NULL)`).financial_operation_id;
  const cases = [
    ['B1 amount 0 → INVALID_AMOUNT', tax({ account: A, amount: 0, ref: `${TAG}-B1` }), 'INVALID_AMOUNT'],
    ['B2 negative amount → INVALID_AMOUNT', tax({ account: A, amount: -5, ref: `${TAG}-B2` }), 'INVALID_AMOUNT'],
    ['B3 three decimals → INVALID_AMOUNT', tax({ account: A, amount: 1.005, ref: `${TAG}-B3` }), 'INVALID_AMOUNT'],
    ['B4 tax_kind IVA → INVALID_TAX_KIND', tax({ account: A, kind: 'IVA', ref: `${TAG}-B4` }), 'INVALID_TAX_KIND'],
    ['B5 blank external_ref → EXTERNAL_REF_REQUIRED', tax({ account: A, ref: ' ' }), 'EXTERNAL_REF_REQUIRED'],
    ['B6 missing account → ACCOUNT_NOT_FOUND_OR_INACTIVE', tax({ account: MISSING_UUID, ref: `${TAG}-B6` }), 'ACCOUNT_NOT_FOUND_OR_INACTIVE'],
    ['B7 inactive account → ACCOUNT_NOT_FOUND_OR_INACTIVE', tax({ account: INACTIVE, ref: `${TAG}-B7` }), 'ACCOUNT_NOT_FOUND_OR_INACTIVE'],
    ['B8 Mercado Pago account → MP_ACCOUNT_NOT_ALLOWED', tax({ account: MP, ref: `${TAG}-B8` }), 'MP_ACCOUNT_NOT_ALLOWED'],
    ['B9 missing related operation → RELATED_TRANSFER_NOT_FOUND', tax({ account: A, ref: `${TAG}-B9`, related: 999999999 }), 'RELATED_TRANSFER_NOT_FOUND'],
  ];
  for (const [label, call, code] of cases) {
    const ref = /'(ADR011-TEST-B\d)'/.exec(call)?.[1];
    r = ADMIN(`SELECT ${call};`);
    check(label, raised(r, code) && (!ref || opsWithRef(ref) === '0'), firstErr(r));
  }
  check('B10 Mercado Pago seed account exists (B8 is meaningful)', MP !== '', MP);
  owner(`UPDATE management_period SET status = 'CLOSED', closed_at = NOW() WHERE periodo_fecha = '${CLOSED_MONTH}';`);
  r = ADMIN(`SELECT ${tax({ account: A, date: '2026-03-15', ref: `${TAG}-B11` })};`);
  check('B11 closed period → PERIOD_CLOSED, nothing written', raised(r, 'PERIOD_CLOSED') && opsWithRef(`${TAG}-B11`) === '0', firstErr(r));
  owner(`UPDATE management_period SET status = 'OPEN', closed_at = NULL WHERE periodo_fecha = '${CLOSED_MONTH}';`);
  check('B12 no validation failure moved account A (only the transfer)', balance(A) === '-100000.00', balance(A));

  section('C', 'Registration related to a transfer');
  const pnlBefore = pnlSnapshot();
  const res = rpc(tax({ account: A, amount: 600, ref: `${TAG}-C1`, related: T, reason: 'IDC' }));
  const op = res.financial_operation_id;
  check('C1 returns the operation, replayed = false', !!op && res.replayed === false, JSON.stringify(res));
  const row = owner(`SELECT operation_type || '|' || effective_date || '|' || COALESCE(source_entity_type, '') || '|' || COALESCE(source_entity_id, '')
    FROM financial_operation WHERE id = ${op};`);
  check('C2 one BANK_TAX operation, same date, source = the transfer', row === `BANK_TAX|${DAY}|financial_operation|${T}`, row);
  const posts = owner(`SELECT count(*) || '|' || SUM(signed_amount)::NUMERIC(15,2) || '|' || bool_and(financial_account_id = '${A}')
    FROM financial_posting WHERE financial_operation_id = ${op};`);
  check('C3 exactly one negative posting of 600 on the taxed account', posts === '1|-600.00|true', posts);
  const charge = owner(`SELECT tax_kind || '|' || amount || '|' || related_operation_id || '|' || financial_account_id FROM bank_tax_charge WHERE financial_operation_id = ${op};`);
  check('C4 bank_tax_charge: DEBITOS_CREDITOS, 600, related to the TRANSFER (FK)', charge === `DEBITOS_CREDITOS|600.00|${T}|${A}`, charge);
  check('C5 account A = −100000 − 600', balance(A) === '-100600.00', balance(A));
  const tposts = owner(`SELECT count(*) || '|' || SUM(signed_amount) FROM financial_posting WHERE financial_operation_id = ${T};`);
  check('C6 the TRANSFER is untouched: two postings summing zero', tposts === '2|0.00' || tposts === '2|0', tposts);
  const audit = owner(`SELECT count(*) FROM audit_events WHERE entity_type = 'financial_operation' AND entity_id = '${op}' AND action = 'BANK_TAX';`);
  check('C7 one audit event', audit === '1', audit);
  const onDest = rpc(tax({ account: B, amount: 600, ref: `${TAG}-C8`, related: T }));
  check('C8 the destination side can carry its own related tax', !!onDest.financial_operation_id && balance(B) === '99400.00', balance(B));
  r = ADMIN(`SELECT ${tax({ account: A, ref: `${TAG}-C9`, related: op })};`);
  check('C9 related operation that is not a TRANSFER → RELATED_TRANSFER_NOT_FOUND', raised(r, 'RELATED_TRANSFER_NOT_FOUND'), firstErr(r));
  const standalone = rpc(tax({ account: A, amount: 10, ref: `${TAG}-C10` }));
  const sa = owner(`SELECT (related_operation_id IS NULL) || '|' || (SELECT COALESCE(source_entity_type, 'null') FROM financial_operation WHERE id = ${standalone.financial_operation_id})
    FROM bank_tax_charge WHERE financial_operation_id = ${standalone.financial_operation_id};`);
  check('C10 a tax without related transfer is accepted (relation is optional)', sa === 'true|null', sa);

  section('D', 'Idempotency by external_ref');
  const replay = rpc(tax({ account: A, amount: 600, ref: `${TAG}-C1`, related: T, reason: 'IDC' }));
  check('D1 exact replay returns the original operation, replayed = true', replay.financial_operation_id === op && replay.replayed === true, JSON.stringify(replay));
  check('D2 replay wrote nothing (A unchanged, still one operation)', balance(A) === '-100610.00' && opsWithRef(`${TAG}-C1`) === '1', balance(A));
  r = ADMIN(`SELECT ${tax({ account: A, amount: 700, ref: `${TAG}-C1`, related: T })};`);
  check('D3 same external_ref, different amount → DUPLICATE_BANK_TAX', raised(r, 'DUPLICATE_BANK_TAX'), firstErr(r));
  r = ADMIN(`SELECT ${tax({ account: A, ref: `${TAG}-T1` })};`);
  check('D4 external_ref of the TRANSFER itself → DUPLICATE_BANK_TAX (never a replay)', raised(r, 'DUPLICATE_BANK_TAX'), firstErr(r));

  section('E', 'Report and P&L');
  const rep = adminOk(`SELECT tax_kind || '|' || amount_paid || '|' || charges FROM report_bank_tax_period
    WHERE period = '${CURRENT_MONTH}' AND financial_account_id = '${A}';`);
  check('E1 report_bank_tax_period: A = 610 in 2 charges this month', rep === 'DEBITOS_CREDITOS|610.00|2', rep);
  const cols = owner(`SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_name = 'report_bank_tax_period';`);
  check('E2 report columns: no computability percentage', cols === 'period,tax_kind,financial_account_id,account_name,amount_paid,charges', cols);
  const operRows = OPER(`SELECT count(*) FROM report_bank_tax_period;`);
  check('E3 OPERATOR sees zero report rows and zero charges', operRows.ok && operRows.out === '0'
    && OPER(`SELECT count(*) FROM bank_tax_charge;`).out === '0', operRows.out || firstErr(operRows));
  check('E4 P&L unchanged by BANK_TAX (pnl_summary + pnl_line_item fingerprint identical)', pnlSnapshot() === pnlBefore);
  const pnlRefs = owner(`SELECT count(*) FROM pg_views WHERE schemaname = 'public' AND viewname LIKE 'pnl%'
    AND (definition ILIKE '%bank_tax%' OR definition ILIKE '%financial_operation%' OR definition ILIKE '%financial_posting%');`);
  check('E5 no P&L view reads financial_operation / financial_posting / bank_tax_charge (fail-closed)', pnlRefs === '0', pnlRefs);
  const trDef = owner(`SELECT (prosrc ILIKE '%BANK_TAX%')::TEXT FROM pg_proc WHERE proname = 'transfer_between_accounts';`);
  check('E6 transfer_between_accounts unchanged (no bank tax logic)', trDef === 'false', trDef);
} finally {
  cleanup();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
