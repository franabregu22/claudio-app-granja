/**
 * Phase 27 acceptance fixes — Fiscal + Finance (ADR-015) through the frontend data layer against the guarded LOCAL
 * stack only (127.0.0.1, local demo keys read from the running container):
 *   - report_fiscal_period (ADMIN-only; credit notes reversed; informational difference, no carry-forward);
 *   - a purchase with fiscal data is one backend transaction (RPC 50) and links its document;
 *   - "Retiro de socios" keeps the ADR-004 treatment: the operating result is unchanged.
 *
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" npx vitest run tests/integration/fiscal-finance.test.ts
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertNoProductionCredentials, assertSafeDestructiveTarget } from '../../scripts/test-env/guard.mjs';
import { readTable, TargetDbError } from '../../src/target/db';
import { createPurchaseWithAttachments } from '../../src/target/attachments';
import { listFiscalPeriods, registerFiscalDocument } from '../../src/target/fiscal';
import { createMaster } from '../../src/target/masters';
import { listPnlSummary, registerManagementEvent } from '../../src/target/pnl';

const LOCAL_URL = 'http://127.0.0.1:54321';
assertNoProductionCredentials(process.env);
assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);

function localKeys(): { anon: string; service: string } {
  const c = (spawnSync('docker', ['ps', '--filter', 'name=supabase_edge_runtime', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout || '')
    .trim().split('\n')[0];
  if (!c) throw new Error('local edge-runtime container not running');
  const env = (spawnSync('docker', ['inspect', c, '--format', '{{range .Config.Env}}{{println .}}{{end}}'], { encoding: 'utf8' }).stdout || '')
    .split(/\r?\n/);
  const get = (k: string) => (env.find((l) => l.startsWith(`${k}=`)) ?? '').slice(k.length + 1);
  const keys = { anon: get('SUPABASE_ANON_KEY'), service: get('SUPABASE_SERVICE_ROLE_KEY') };
  for (const [want, jwt] of [['anon', keys.anon], ['service_role', keys.service]] as const) {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString() || '{}');
    if (payload.iss !== 'supabase-demo' || payload.role !== want) throw new Error(`not a local demo ${want} key`);
  }
  return keys;
}
function owner(sql: string): string {
  const c = (spawnSync('docker', ['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout || '').trim().split('\n')[0];
  const r = spawnSync('docker', ['exec', '-i', c, 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    { encoding: 'utf8', input: sql });
  if (r.status !== 0) throw new Error(r.stderr);
  return (r.stdout || '').trim();
}

const keys = localKeys();
const service = createClient(LOCAL_URL, keys.service, { auth: { persistSession: false, autoRefreshToken: false } });
const run = randomUUID().slice(0, 8);
const TAG = `FF-${run}`;
const password = `FF-${randomUUID()}`;
const users: Record<'ADMIN' | 'OPERATOR', { email: string; id?: string; client?: SupabaseClient }> = {
  ADMIN: { email: `ff-admin-${run}@example.invalid` },
  OPERATOR: { email: `ff-operator-${run}@example.invalid` },
};
const admin = () => users.ADMIN.client!;
const operator = () => users.OPERATOR.client!;
const code = (e: unknown) => (e instanceof TargetDbError ? e.code : String(e));
const PERIOD = '2023-05-01';   // a fiscal period used by nothing else
const DAY = '2026-09-16';
const fx = { supplier: '', client: '', category: '', account: '' };

const SUP = `(SELECT id FROM suppliers WHERE nombre LIKE '${TAG}%')`;
const CLI = `(SELECT id FROM clients WHERE nombre LIKE '${TAG}%')`;
const DOCS = `(SELECT id FROM fiscal_document WHERE supplier_id IN ${SUP} OR cliente_id IN ${CLI})`;
const ACC = `(SELECT id FROM financial_account WHERE nombre LIKE '${TAG}%')`;
function cleanup() {
  owner(`
CREATE TEMP TABLE _p AS SELECT id FROM purchases WHERE supplier_id IN ${SUP};
CREATE TEMP TABLE _m AS SELECT id, financial_operation_id FROM management_event WHERE idempotency_key LIKE '${TAG}%';
DELETE FROM purchase_line WHERE purchase_id IN (SELECT id FROM _p);
DELETE FROM purchase_attachment WHERE purchase_id IN (SELECT id FROM _p);
DELETE FROM supplier_ledger WHERE supplier_id IN ${SUP};
DELETE FROM purchases WHERE id IN (SELECT id FROM _p);
DELETE FROM fiscal_document_component WHERE fiscal_document_id IN ${DOCS};
DELETE FROM fiscal_document WHERE id IN ${DOCS};
DELETE FROM management_event WHERE id IN (SELECT id FROM _m);
DELETE FROM financial_posting WHERE financial_operation_id IN (SELECT financial_operation_id FROM _m);
DELETE FROM financial_operation WHERE id IN (SELECT financial_operation_id FROM _m);
DELETE FROM financial_posting WHERE financial_account_id IN ${ACC};
DELETE FROM financial_account WHERE nombre LIKE '${TAG}%';
DELETE FROM suppliers WHERE nombre LIKE '${TAG}%';
DELETE FROM clients WHERE nombre LIKE '${TAG}%';
DELETE FROM expense_category WHERE nombre LIKE '${TAG}%';`);
}

beforeAll(async () => {
  for (const [role, u] of Object.entries(users)) {
    const { data, error } = await service.auth.admin.createUser({ email: u.email, password, email_confirm: true });
    if (error) throw error;
    u.id = data.user!.id;
    owner(`INSERT INTO perfiles (id, email, rol_type, activo) VALUES ('${u.id}', '${u.email}', '${role}', true);`);
    const client = createClient(LOCAL_URL, keys.anon, { auth: { persistSession: false, autoRefreshToken: false } });
    const s = await client.auth.signInWithPassword({ email: u.email, password });
    if (s.error) throw s.error;
    u.client = client;
  }
  fx.supplier = (await createMaster<{ id: string }>(admin(), 'suppliers', { nombre: `${TAG} proveedor` })).id;
  fx.client = (await createMaster<{ id: string }>(admin(), 'clients', { nombre: `${TAG} cliente` })).id;
  fx.category = (await createMaster<{ id: string }>(admin(), 'expense_category', { nombre: `${TAG} insumos`, pnl_cost_class: 'DIRECT' })).id;
  fx.account = (await createMaster<{ id: string }>(admin(), 'financial_account', { nombre: `${TAG} caja`, account_type: 'CASH' })).id;
});

afterAll(async () => {
  cleanup();
  const ids = Object.values(users).map((u) => u.id).filter(Boolean);
  const idList = ids.map((i) => `'${i}'`).join(',');
  if (ids.length) owner(`DELETE FROM audit_events WHERE performed_by IN (${idList});\nDELETE FROM perfiles WHERE id IN (${idList});`);
  for (const u of Object.values(users)) if (u.id) await service.auth.admin.deleteUser(u.id);
});

const iva = (dir: 'DEBITO' | 'CREDITO', base: number, tax: number) => [{ tax_kind: 'IVA' as const, direction: dir, base_amount: base, rate_applied: 21, tax_amount: tax }];

describe('ADR-015 fiscal period report', () => {
  it('debit / credit by period, credit notes reversed, informational difference; ADMIN-only', async () => {
    await registerFiscalDocument(admin(), { type: 'INVOICE_A', direction: 'DEBITO', date: DAY, fiscalPeriod: PERIOD, netAmount: 1000, totalAmount: 1210, components: iva('DEBITO', 1000, 210), clienteId: fx.client });
    await registerFiscalDocument(admin(), { type: 'CREDIT_NOTE', direction: 'DEBITO', date: DAY, fiscalPeriod: PERIOD, netAmount: 100, totalAmount: 121, components: iva('DEBITO', 100, 21), clienteId: fx.client });
    await registerFiscalDocument(admin(), { type: 'INVOICE_A', direction: 'CREDITO', date: DAY, fiscalPeriod: PERIOD, netAmount: 400, totalAmount: 484, components: iva('CREDITO', 400, 84), supplierId: fx.supplier, externalNumber: `${TAG}-1` });
    const row = (await listFiscalPeriods(admin())).find((r) => r.period === PERIOD && r.tax_kind === 'IVA');
    expect(row).toMatchObject({ debit_amount: 189, credit_amount: 84, debit_documents: 2, credit_documents: 1, period_difference: 105 });
    expect(await listFiscalPeriods(operator())).toEqual([]);
  });
});

describe('ADR-015 purchase with fiscal document (RPC 50)', () => {
  it('purchase + document atomically; the purchase links the document; an invalid purchase leaves no document', async () => {
    const r = await createPurchaseWithAttachments(admin(), {
      userId: users.ADMIN.id!, files: [], supplierId: fx.supplier, economicDate: DAY, amountNet: 1210, amountTotal: 1210, categoryId: fx.category,
      nature: 'OPERATING', lines: [], idempotencyKey: `${TAG}-P1`, invoiceNumber: `${TAG}-FC1`,
      fiscal: { documentType: 'INVOICE_A', fiscalPeriod: PERIOD, netAmount: 1000, totalAmount: 1210, components: [{ tax_kind: 'IVA', base_amount: 1000, rate_applied: 21, tax_amount: 210 }] },
    }) as { purchase_id: string; fiscal_document_id: string };
    const [p] = await readTable<{ fiscal_document_id: string; amount_total: number }>(admin(), 'purchases', (q) => q.eq('id', r.purchase_id), 'fiscal_document_id, amount_total');
    expect(p.fiscal_document_id).toBe(r.fiscal_document_id);
    const row = (await listFiscalPeriods(admin())).find((x) => x.period === PERIOD && x.tax_kind === 'IVA');
    expect(row).toMatchObject({ credit_amount: 294, credit_documents: 2 });

    const docsBefore = owner(`SELECT count(*) FROM fiscal_document WHERE supplier_id = '${fx.supplier}';`);
    const bad = await createPurchaseWithAttachments(admin(), {
      userId: users.ADMIN.id!, files: [], supplierId: fx.supplier, economicDate: DAY, amountNet: 1, amountTotal: 1, categoryId: '',
      nature: 'OPERATING', lines: [], idempotencyKey: `${TAG}-P2`, invoiceNumber: `${TAG}-FC2`,
      fiscal: { documentType: 'INVOICE_A', fiscalPeriod: PERIOD, netAmount: 1, totalAmount: 1, components: [] },
    }).catch((e) => e);
    expect(bad).toBeInstanceOf(TargetDbError);
    expect(owner(`SELECT count(*) FROM fiscal_document WHERE supplier_id = '${fx.supplier}';`)).toBe(docsBefore);
  });
});

describe('D-FIN-1 Retiro de socios keeps the ADR-004 treatment', () => {
  it('the operating result is unchanged; only the withdrawals line moves; OPERATOR is refused', async () => {
    const period = `${DAY.slice(0, 7)}-01`;
    const before = (await listPnlSummary(admin(), period, period))[0];
    await registerManagementEvent(admin(), { type: 'RETIRO', effectiveDate: DAY, amount: 777, idempotencyKey: `${TAG}-R1`, reason: 'retiro de socios', accountId: fx.account });
    const after = (await listPnlSummary(admin(), period, period))[0];
    expect(after.resultado_operativo).toBe(before?.resultado_operativo ?? 0);
    expect(after.retiros - (before?.retiros ?? 0)).toBe(-777);
    const denied = await registerManagementEvent(operator(), { type: 'RETIRO', effectiveDate: DAY, amount: 1, idempotencyKey: `${TAG}-R2`, reason: 'x', accountId: fx.account }).catch((e) => e);
    expect(['FORBIDDEN', 'PERMISSION_DENIED']).toContain(code(denied));
  });
});
