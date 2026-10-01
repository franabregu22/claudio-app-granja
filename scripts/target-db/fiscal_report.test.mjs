#!/usr/bin/env node
/**
 * ADR-015 — FISCAL PERIOD REPORT + PURCHASE FISCAL DOCUMENT (Phase 27 acceptance fixes, owner D-FISCAL-1…8).
 * LOCAL TEST DATABASE ONLY.
 *
 *   * report_fiscal_period (ADMIN): loaded tax amounts by period / tax kind / direction; a CREDIT_NOTE reverses its
 *     loaded effect; period_difference = debit − credit is backend-derived and informational; no carry-forward;
 *     the P&L is unchanged.
 *   * RPC 50 register_purchase_with_fiscal_document: purchase + fiscal document atomically (either fails → nothing).
 *
 * Fixtures are prefixed "ADR015-TEST" (fiscal periods 2024-01 / 2024-02, used by nothing else) and removed at start
 * and end.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *     node scripts/target-db/fiscal_report.test.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
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
const TAG = 'ADR015-TEST';
const P1 = '2024-01-01';
const P2 = '2024-02-01';
const DAY = '2026-09-15';

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
const asUser = (uid, sqlText) => raw(`
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '${JSON.stringify({ sub: uid, role: 'authenticated' })}';
${sqlText}
COMMIT;`);
const ADMIN = (sqlText) => asUser(ADMIN_UID, sqlText);
const OPER = (sqlText) => asUser(OPER_UID, sqlText);
const json = (r) => { if (!r.ok) throw new Error(r.err); return JSON.parse(r.out); };
const firstErr = (r) => (r.err.split('\n').find((l) => /ERROR/.test(l)) || r.err.split('\n')[0] || '').slice(0, 160);
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

const SUP = `(SELECT id FROM suppliers WHERE nombre LIKE '${TAG}%')`;
const CLI = `(SELECT id FROM clients WHERE nombre LIKE '${TAG}%')`;
const DOCS = `(SELECT id FROM fiscal_document WHERE supplier_id IN ${SUP} OR cliente_id IN ${CLI})`;
const PUR = `(SELECT id FROM purchases WHERE supplier_id IN ${SUP})`;
function cleanup() {
  owner(`
DELETE FROM audit_events WHERE entity_id IN (SELECT id::TEXT FROM ${DOCS} d UNION SELECT id::TEXT FROM ${PUR} p);
DELETE FROM purchase_attachment WHERE purchase_id IN ${PUR};
DELETE FROM purchase_line WHERE purchase_id IN ${PUR};
DELETE FROM supplier_ledger WHERE supplier_id IN ${SUP};
DELETE FROM purchases WHERE supplier_id IN ${SUP};
DELETE FROM fiscal_document_component WHERE fiscal_document_id IN ${DOCS};
DELETE FROM fiscal_document WHERE id IN ${DOCS};
DELETE FROM suppliers WHERE nombre LIKE '${TAG}%';
DELETE FROM clients WHERE nombre LIKE '${TAG}%';
DELETE FROM expense_category WHERE nombre LIKE '${TAG}%';`);
}
owner(`
INSERT INTO auth.users (id, is_sso_user, is_anonymous) VALUES ('${ADMIN_UID}', false, false), ('${OPER_UID}', false, false)
ON CONFLICT (id) DO NOTHING;
INSERT INTO perfiles (id, email, rol_type, activo) VALUES
  ('${ADMIN_UID}', 'admin@test.local', 'ADMIN', true), ('${OPER_UID}', 'operator@test.local', 'OPERATOR', true)
ON CONFLICT (id) DO NOTHING;
INSERT INTO management_period (periodo_fecha) VALUES ('2026-09-01') ON CONFLICT DO NOTHING;`);
cleanup();

const adminOk = (sqlText) => { const r = ADMIN(sqlText); if (!r.ok) throw new Error(r.err); return r.out; };
const comp = (kind, dir, base, rate, tax) => ({ tax_kind: kind, direction: dir, base_amount: base, rate_applied: rate, tax_amount: tax });
const doc = (type, dir, period, comps, { supplier = null, client = null, net = 1000, total = 1210, num = null } = {}) =>
  ADMIN(`SELECT register_fiscal_document('${type}', '${dir}', '${DAY}', '${period}', ${net}, ${total}, '${JSON.stringify(comps)}'::jsonb,
    ${supplier ? `'${supplier}'` : 'NULL'}, ${client ? `'${client}'` : 'NULL'}, ${num ? `'${num}'` : 'NULL'}, NULL);`);
const report = (period, kind = 'IVA') => adminOk(`SELECT debit_amount || '|' || credit_amount || '|' || debit_documents || '|' || credit_documents || '|' || period_difference
  FROM report_fiscal_period WHERE period = '${period}' AND tax_kind = '${kind}';`);
const pnlSnapshot = () => adminOk(`SELECT md5(COALESCE((SELECT string_agg(t::TEXT, '|' ORDER BY t::TEXT) FROM pnl_summary t), '')
  || COALESCE((SELECT string_agg(t::TEXT, '|' ORDER BY t::TEXT) FROM pnl_line_item t), ''));`);

try {
  const S = adminOk(`INSERT INTO suppliers (nombre) VALUES ('${TAG} proveedor') RETURNING id;`);
  const C = adminOk(`INSERT INTO clients (nombre) VALUES ('${TAG} cliente') RETURNING id;`);
  const CAT = adminOk(`INSERT INTO expense_category (nombre, pnl_cost_class) VALUES ('${TAG} insumos', 'DIRECT') RETURNING id;`);

  section('A', 'report_fiscal_period (D-FISCAL-2 / D-FISCAL-3)');
  const pnlBefore = pnlSnapshot();
  json(doc('INVOICE_A', 'DEBITO', P1, [comp('IVA', 'DEBITO', 1000, 21, 210)], { client: C }));
  check('A1 a sale invoice\'s VAT contributes to debit', report(P1) === '210.00|0|1|0|210.00', report(P1));
  json(doc('INVOICE_A', 'CREDITO', P1, [comp('IVA', 'CREDITO', 500, 21, 105)], { supplier: S, num: '0001-1' }));
  check('A2 a purchase invoice\'s VAT contributes to credit', report(P1) === '210.00|105.00|1|1|105.00', report(P1));
  json(doc('INVOICE_B', 'DEBITO', P1, [comp('IVA', 'DEBITO', 100, 21, 21)], { client: C }));
  check('A3 several documents of the same period aggregate (debit 231, 2 documents)', report(P1) === '231.00|105.00|2|1|126.00', report(P1));
  json(doc('CREDIT_NOTE', 'DEBITO', P1, [comp('IVA', 'DEBITO', 100, 21, 21)], { client: C }));
  check('A4 a customer credit note reduces debit (231 → 210); its stored amount stays positive',
    report(P1) === '210.00|105.00|3|1|105.00'
    && owner(`SELECT c.tax_amount FROM fiscal_document d JOIN fiscal_document_component c ON c.fiscal_document_id = d.id
               WHERE d.document_type = 'CREDIT_NOTE' AND d.cliente_id = '${C}';`) === '21.00', report(P1));
  json(doc('CREDIT_NOTE', 'CREDITO', P1, [comp('IVA', 'CREDITO', 25, 21, 5.25)], { supplier: S, num: 'NC-1' }));
  check('A5 a supplier credit note reduces credit (105 → 99.75)', report(P1) === '210.00|99.75|3|2|110.25', report(P1));
  json(doc('INVOICE_A', 'DEBITO', P2, [comp('IVA', 'DEBITO', 500, 21, 105)], { client: C }));
  check('A6 periods stay separate and nothing is carried forward (P2 difference = its own 105, not 215.25)', report(P2) === '105.00|0|1|0|105.00', report(P2));
  json(doc('INVOICE_A', 'CREDITO', P2, [comp('PERCEPTION', 'CREDITO', 1000, 3, 30), comp('IVA', 'CREDITO', 1000, 21, 210)], { supplier: S, num: '0001-2' }));
  check('A7 other tax kinds are reported on their own row (PERCEPTION credit 30), not mixed into IVA',
    report(P2, 'PERCEPTION') === '0|30.00|0|1|-30.00' && report(P2) === '105.00|210.00|1|1|-105.00', `${report(P2, 'PERCEPTION')} ${report(P2)}`);
  const cols = owner(`SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_name = 'report_fiscal_period';`);
  check('A8 the report exposes loaded totals and the backend-derived difference only (no payable / carry-forward column)',
    cols === 'period,tax_kind,debit_amount,credit_amount,debit_documents,credit_documents,period_difference', cols);
  const operRows = OPER(`SELECT count(*) FROM report_fiscal_period;`);
  check('A9 ADMIN-only: OPERATOR reads zero rows', operRows.ok && operRows.out === '0', operRows.out || firstErr(operRows));
  const grants = owner(`SELECT count(*) FROM information_schema.role_table_grants WHERE table_name = 'report_fiscal_period' AND grantee IN ('anon','service_role');`);
  const opts = owner(`SELECT reloptions::TEXT FROM pg_class WHERE relname = 'report_fiscal_period';`);
  check('A10 security_invoker, no anon / service_role grant', grants === '0' && /security_invoker=true/.test(opts), `${grants} ${opts}`);
  check('A11 fiscal documents do not change the P&L (pnl_summary + pnl_line_item fingerprint identical)', pnlSnapshot() === pnlBefore);

  section('B', 'Purchase with fiscal document — RPC 50 (D-FISCAL-4)');
  const wrap = (as, { type = 'INVOICE_A', comps = [comp('IVA', 'CREDITO', 1000, 21, 210)], cat = CAT, num = 'FC-100', key = `${TAG}-${randomUUID()}`, total = 1210 } = {}) =>
    as(`SELECT register_purchase_with_fiscal_document('${S}', '${DAY}', ${total}, ${total}, ${cat ? `'${cat}'` : 'NULL'}, 'OPERATING', '[]'::jsonb, '[]'::jsonb,
      '${key}', '${type}', '2026-09-01', 1000, ${total}, '${JSON.stringify(comps)}'::jsonb, NULL, NULL, ${num ? `'${num}'` : 'NULL'}, NULL, NULL);`);
  const counts = () => owner(`SELECT (SELECT count(*) FROM purchases WHERE supplier_id = '${S}') || '|' || (SELECT count(*) FROM fiscal_document WHERE supplier_id = '${S}');`);
  const c0 = counts();
  const ok = json(wrap(ADMIN));
  const link = owner(`SELECT p.fiscal_document_id = '${ok.fiscal_document_id}' AND d.direction = 'CREDITO' AND d.supplier_id = '${S}' AND d.document_date = '${DAY}'
    AND d.external_number = 'FC-100' AND p.amount_total = 1210 FROM purchases p JOIN fiscal_document d ON d.id = p.fiscal_document_id WHERE p.id = '${ok.purchase_id}';`);
  check('B1 purchase + fiscal document created together; the purchase references the document (CREDITO, supplier, date, number)', link === 't', link);
  const comps = owner(`SELECT string_agg(tax_kind || ':' || direction || ':' || base_amount || ':' || rate_applied || ':' || tax_amount, ',') FROM fiscal_document_component WHERE fiscal_document_id = '${ok.fiscal_document_id}';`);
  check('B2 components stored exactly as entered', comps === 'IVA:CREDITO:1000.00:21.0000:210.00' || /^IVA:CREDITO:1000\.00:21(\.0+)?:210\.00$/.test(comps), comps);
  const pnlPurchase = adminOk(`SELECT signed_amount FROM pnl_line_item WHERE source_entity_id = '${ok.purchase_id}';`);
  check('B3 the purchase still enters the P&L by amount_total (VAT not subtracted)', Number(pnlPurchase) === -1210, pnlPurchase);
  const c1 = counts();
  let r = wrap(ADMIN, { comps: [comp('XYZ', 'CREDITO', 1, 1, 1)], num: 'FC-101' });
  check('B4 an invalid fiscal component rolls the whole call back (no purchase, no document)', !r.ok && counts() === c1, firstErr(r));
  r = wrap(ADMIN, { cat: null, num: 'FC-102' });
  check('B5 an invalid purchase (no category) rolls back the fiscal document too', raised(r, 'CATEGORY_REQUIRED') && counts() === c1, firstErr(r));
  r = wrap(ADMIN, { type: 'CREDIT_NOTE', num: 'FC-103' });
  check('B6 a credit / debit note cannot document a purchase → INVALID_DOCUMENT_TYPE', raised(r, 'INVALID_DOCUMENT_TYPE') && counts() === c1, firstErr(r));
  r = wrap(ADMIN, { num: 'FC-100' });
  check('B7 a duplicate supplier document number → DUPLICATE_FISCAL_DOCUMENT, nothing written', raised(r, 'DUPLICATE_FISCAL_DOCUMENT') && counts() === c1, firstErr(r));
  r = wrap(OPER, { num: 'FC-104' });
  check('B8 OPERATOR → FORBIDDEN', raised(r, 'FORBIDDEN') && counts() === c1, firstErr(r));
  const plain = json(ADMIN(`SELECT register_purchase('${S}', '${DAY}', 50, 50, '${CAT}', NULL, 'OPERATING', '[]'::jsonb, '[]'::jsonb, '${TAG}-plain', NULL, NULL, NULL, NULL, NULL);`));
  check('B9 a purchase without fiscal data still goes through RPC 13 alone (no document)',
    !!plain.purchase_id && owner(`SELECT fiscal_document_id IS NULL FROM purchases WHERE id = '${plain.purchase_id}';`) === 't');
  const withNoIva = json(wrap(ADMIN, { type: 'INVOICE_C', comps: [], num: 'FC-C1' }));
  check('B10 an invoice with no components (e.g. type C) is accepted; attachments stay optional ([])', !!withNoIva.fiscal_document_id && withNoIva.attachment_count === 0, JSON.stringify(withNoIva));
  check('B11 counts before / after: 3 purchases (2 with document), 2 documents more than before the section',
    counts() === `${Number(c0.split('|')[0]) + 3}|${Number(c0.split('|')[1]) + 2}`, `${c0} → ${counts()}`);
  const fn = owner(`SELECT p.prosecdef || '|' || has_function_privilege('anon', p.oid, 'EXECUTE') || '|' ||
    has_function_privilege('authenticated', p.oid, 'EXECUTE') || '|' || has_function_privilege('service_role', p.oid, 'EXECUTE')
    FROM pg_proc p WHERE p.proname = 'register_purchase_with_fiscal_document';`);
  check('B12 RPC 50: SECURITY DEFINER, EXECUTE only for authenticated', fn === 'true|false|true|false', fn);
} finally {
  cleanup();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
